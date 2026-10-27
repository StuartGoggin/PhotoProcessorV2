//! Immutable CR3 masters, fast camera previews and separately validated RAW
//! development. Durable media lineage lives with staging, scratch data does not.
pub mod capture;
pub mod manifest;
pub mod recipe;
pub mod worker;
use super::{
    google_photos::store,
    process::{self, ProcessJobStatus, ProcessResult, ProcessScopeMode},
};
pub use recipe::RawRecipe;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Instant,
};
static WORKER: Mutex<()> = Mutex::new(());
pub fn requests() -> &'static Mutex<HashMap<String, Request>> {
    static S: OnceLock<Mutex<HashMap<String, Request>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn is_raw(p: &Path) -> bool {
    p.extension().is_some_and(|e| e.eq_ignore_ascii_case("cr3"))
}
pub fn reject_link(path: &Path) -> Result<(), String> {
    store::reject_link(path)
}
pub fn safe_source(root: &str, path: &str) -> Result<PathBuf, String> {
    let root = Path::new(root);
    reject_link(root)?;
    let root = root
        .canonicalize()
        .map_err(|_| "Staging folder is unavailable")?;
    let candidate = Path::new(path);
    let candidate = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    let mut cur = Some(candidate.as_path());
    while let Some(p) = cur {
        reject_link(p)?;
        if p == root {
            break;
        }
        cur = p.parent();
    }
    let p = candidate
        .canonicalize()
        .map_err(|_| "RAW file is unavailable")?;
    if !p.starts_with(&root) || !p.is_file() || !is_raw(&p) {
        return Err("Choose an original CR3 inside the staging folder".into());
    }
    let n = std::fs::metadata(&p).map_err(|e| e.to_string())?.len();
    if n == 0 || n > 512 * 1024 * 1024 {
        return Err("RAW file exceeds its 512 MiB admission limit or is empty".into());
    }
    Ok(p)
}
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub staging_dir: String,
    pub scope_dir: String,
    pub scope_mode: ProcessScopeMode,
    #[serde(default = "all")]
    pub selection: String,
    #[serde(default)]
    pub min_rating: u8,
    #[serde(default)]
    pub selected_paths: Vec<String>,
    #[serde(default)]
    pub recipe: RawRecipe,
    #[serde(default)]
    pub use_photo_overrides: bool,
}
fn all() -> String {
    "all".into()
}
pub(crate) fn annotate_tree(children: &mut [serde_json::Value], dir: &Path, root: &Path) {
    let mut paths = Vec::new();
    let mut child_indices = Vec::new();
    for (index, node) in children.iter().enumerate() {
        if node["type"] == "file" {
            if let Some(p) = node["path"].as_str() {
                paths.push(root.join(p));
                child_indices.push(index);
            }
        }
    }
    let associations = match manifest::associations(dir, &paths) {
        Ok(a) => a,
        Err(message) => {
            for node in children.iter_mut() {
                node["rawWarning"] = message.clone().into()
            }
            return;
        }
    };
    let excluded: HashSet<usize> = associations.iter().map(|(index, _, _)| *index).collect();
    for (index, source, kind) in associations {
        let node = &mut children[child_indices[index]];
        node["rawSource"] = paths[source]
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/")
            .into();
        node["rawKind"] = if kind.starts_with("retired:") {
            "retired".into()
        } else {
            kind.into()
        };
    }
    if !capture::candidate_paths(&paths, &excluded).is_empty() {
        for index in &child_indices {
            children[*index]["captureMetadataPending"] = true.into();
        }
    }
}
pub(crate) fn enrich_folder(children: &mut [serde_json::Value], root: &Path) -> bool {
    let indices: Vec<_> = children
        .iter()
        .enumerate()
        .filter(|(_, n)| n["type"] == "file")
        .map(|(i, _)| i)
        .collect();
    let paths: Vec<_> = indices
        .iter()
        .map(|&i| root.join(children[i]["path"].as_str().unwrap_or("")))
        .collect();
    let excluded: HashSet<_> = indices
        .iter()
        .enumerate()
        .filter(|(_, i)| {
            children[**i]["rawSource"].is_string()
                || children[**i]["rawKind"].is_string()
                || children[**i]["rawWarning"].is_string()
        })
        .map(|(i, _)| i)
        .collect();
    let candidates = capture::candidate_paths(&paths, &excluded);
    let tokens = capture::read_tokens(&candidates);
    let complete = candidates.iter().all(|p| tokens.contains_key(p));
    for (raw, jpeg) in capture::pairs_from_tokens(&paths, &excluded, &tokens) {
        children[indices[raw]]["cameraJpeg"] = paths[jpeg]
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/")
            .into();
    }
    if complete {
        for i in indices {
            children[i]
                .as_object_mut()
                .map(|o| o.remove("captureMetadataPending"));
        }
    }
    complete
}
impl Request {
    pub fn files(&self) -> Result<Vec<PathBuf>, String> {
        self.recipe.validate()?;
        if !["all", "nonTrash", "minRating", "selected"].contains(&self.selection.as_str())
            || self.min_rating > 3
        {
            return Err("Invalid RAW batch selection".into());
        }
        let scope = process::resolve_process_scope(
            &self.staging_dir,
            Some(self.scope_dir.clone()),
            &self.scope_mode,
        )?
        .canonicalize()
        .map_err(|_| "RAW scope unavailable")?;
        let root = Path::new(&self.staging_dir)
            .canonicalize()
            .map_err(|_| "RAW root unavailable")?;
        if !scope.starts_with(&root) {
            return Err("RAW scope must be inside staging".into());
        }
        reject_link(&scope)?;
        let selected: HashSet<_> = self
            .selected_paths
            .iter()
            .map(|p| safe_source(&self.staging_dir, p))
            .collect::<Result<_, _>>()?;
        let mut result = vec![];
        let max_depth = if matches!(self.scope_mode, ProcessScopeMode::FolderOnly) {
            1
        } else {
            32
        };
        let mut seen = 0;
        let mut walker = walkdir::WalkDir::new(&scope)
            .follow_links(false)
            .max_depth(if max_depth == 1 { 1 } else { max_depth + 1 })
            .into_iter();
        while let Some(e) = walker.next() {
            seen += 1;
            if seen > 200_000 {
                return Err("Choose a smaller RAW scope (200,000 entry limit)".into());
            }
            let e = e.map_err(|_| "Cannot enumerate RAW scope")?;
            if e.depth() > max_depth {
                return Err("RAW scope exceeds 32 folders in depth; choose a narrower scope so no images are silently omitted".into());
            }
            if e.depth() > 0 && reject_link(e.path()).is_err() {
                return Err("RAW scope contains a symbolic link or reparse point. Choose an ordinary media folder before processing.".into());
            }
            if e.depth() > 0 && e.file_name().to_string_lossy().starts_with(".photogogo") {
                if e.file_type().is_dir() {
                    walker.skip_current_dir()
                }
                continue;
            }
            if !e.file_type().is_file() || !is_raw(e.path()) {
                continue;
            }
            let p = safe_source(&self.staging_dir, &e.path().to_string_lossy())?;
            let name = p.file_name().unwrap().to_string_lossy().to_lowercase();
            let rating = (1..=3)
                .rev()
                .find(|&n| name.contains(&format!("{{like {}}}", "o".repeat(n))))
                .unwrap_or(0);
            if self.selection != "all" && name.contains("{trash}") {
                continue;
            }
            if self.selection == "minRating" && rating < usize::from(self.min_rating) {
                continue;
            }
            if self.selection == "selected" && !selected.contains(&p) {
                continue;
            }
            result.push(p);
            if result.len() > 50_000 {
                return Err("Choose a smaller RAW batch (50,000 image limit)".into());
            }
        }
        result.sort();
        Ok(result)
    }
}
#[tauri::command]
pub async fn raw_development_candidates(request: Request) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move||{let paths=request.files()?;let total=paths.len();let available=worker::runtime().is_ok();Ok(serde_json::json!({"paths":paths.into_iter().take(1000).map(|p|p.to_string_lossy().into_owned()).collect::<Vec<_>>(),"total":total,"truncated":total>1000,"runtime":{"available":available,"version":"RawTherapee 5.13 / recipe 1","message":if available{"Bundled RAW developer found. Full integrity verification runs before preview or export; originals remain unchanged."}else{"Bundled RAW developer is missing. Repair the installation."}}}))}).await.map_err(|e|e.to_string())?
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRequest {
    #[serde(flatten)]
    pub scope: Request,
    pub path: String,
    #[serde(default)]
    pub full_resolution: bool,
    #[serde(default)]
    pub preview_variant: Option<String>,
}
pub fn image_url(image: &image::DynamicImage) -> Result<String, String> {
    let b = super::photo_process::jpeg_bytes(image)?;
    if b.len() > 32 * 1024 * 1024 {
        return Err("RAW display exceeds its 32 MiB response limit".into());
    }
    Ok(format!(
        "data:image/jpeg;base64,{}",
        crate::utils::base64_encode(&b)
    ))
}
fn histogram(image: &image::DynamicImage) -> serde_json::Value {
    let image = image.thumbnail(512, 512).to_rgb8();
    let mut r = vec![0u64; 256];
    let mut g = r.clone();
    let mut b = r.clone();
    let (mut shadow, mut light) = (0u64, 0u64);
    for p in image.pixels() {
        r[p[0] as usize] += 1;
        g[p[1] as usize] += 1;
        b[p[2] as usize] += 1;
        if p.0.iter().all(|&x| x <= 2) {
            shadow += 1
        }
        if p.0.iter().any(|&x| x >= 253) {
            light += 1
        }
    }
    let n = f64::from(image.width()) * f64::from(image.height());
    serde_json::json!({"red":r,"green":g,"blue":b,"shadowPercent":shadow as f64*100./n,"highlightPercent":light as f64*100./n})
}
#[tauri::command]
pub async fn raw_development_preview(request: PreviewRequest) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move||{
    let _guard=WORKER.try_lock().map_err(|_|"RAW developer is busy. Wait for its current preview or job to finish.")?;
    let source=safe_source(&request.scope.staging_dir,&request.path)?;if !request.scope.files()?.contains(&source){return Err("Preview is outside the chosen RAW scope".into())}
    let start=Instant::now();let before=worker::hash(&source)?;let original=worker::camera_preview(&source).ok().map(|(image,_,_)|{let image=if request.full_resolution{image}else{image.thumbnail(1600,1600)};let(w,h)=(image.width(),image.height());(image,w,h)});let space=worker::Workspace::new()?;
    let bw=match request.preview_variant.as_deref(){Some("bw")=>true,Some("colour")=>false,None=>!request.scope.recipe.colour,_=>return Err("Unknown RAW preview branch".into())};
    let out=worker::execute(&source,&request.scope.recipe,bw,!request.full_resolution,&space,None)?;
    let processed=super::photo_process::load_oriented(&out)?;
    if worker::hash(&source)?!=before{return Err("Source changed while previewing. Refresh before continuing.".into())}
    Ok(serde_json::json!({"path":source,"original":original.as_ref().map(|o|image_url(&o.0)).transpose()?,"processed":image_url(&processed)?,"width":processed.width(),"height":processed.height(),"originalWidth":original.as_ref().map(|o|o.1),"originalHeight":original.as_ref().map(|o|o.2),"fullResolution":request.full_resolution,"elapsedMs":start.elapsed().as_millis(),"histogram":histogram(&processed),"sourceLabel":if original.is_some(){"Embedded camera preview (reference rendering)"}else{"No embedded reference; full RAW was decoded"},"warning":"Display-only comparison: camera rendering can differ from RAW. Histogram/clipping describes this sRGB display, not sensor recoverability. Final export always decodes the RAW at full size; original bytes are unchanged."}))
}).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn start_raw_development_job(
    app: tauri::AppHandle,
    request: Request,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        request.files()?;
        worker::runtime_identity()?;
        if !super::process_runtime::active(super::process_runtime::Kind::PhotoProcess)?.is_empty() {
            return Err(
                "Wait for the current Photo Process job before queuing RAW development".into(),
            );
        }
        process::start_process_job(
            app,
            request.staging_dir.clone(),
            Some(request.scope_dir.clone()),
            Some(request.scope_mode.clone()),
            "raw_develop".into(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(request),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
pub fn run(app: tauri::AppHandle, id: &str) -> Result<ProcessResult, String> {
    let wait_started = Instant::now();
    let _guard = loop {
        if wait_started.elapsed() > std::time::Duration::from_secs(330) {
            return Err(
                "RAW developer remained busy for over five minutes; requeue after it finishes"
                    .into(),
            );
        }
        if process::is_process_abort_requested(Some(id)) {
            return Err("RAW job cancelled while waiting for its developer".into());
        }
        if let Ok(g) = WORKER.try_lock() {
            break g;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    };
    let request = requests()
        .lock()
        .map_err(|_| "RAW queue lock failed")?
        .get(id)
        .cloned()
        .ok_or("RAW job recipe missing")?;
    let files = request.files()?;
    let total = files.len();
    let mut processed = 0;
    let mut count = 0;
    let mut errors = vec![];
    process::update_process_job(id, |j| {
        j.status = ProcessJobStatus::Running;
        j.started_at = Some(process::now_string());
        j.total = total;
        j.current_phase = Some("RAW development".into());
    });
    process::append_process_job_log(id,"RawTherapee 5.13 / recipe 1. Full RAW decode; sRGB output, max 8 CPU threads, one worker. Pause at image boundary; Abort stops active decode. Requeue safely reuses verified output names.");
    for source in files {
        if process::wait_if_process_paused_or_aborted(Some(id)) {
            break;
        }
        let started = Instant::now();
        process::update_process_job(id, |j| {
            j.current_file = source.file_name().unwrap().to_string_lossy().into_owned()
        });
        let result = (|| {
            let recipe = if request.use_photo_overrides {
                manifest::override_for(&source)?.unwrap_or_else(|| request.recipe.clone())
            } else {
                request.recipe.clone()
            };
            recipe.validate()?;
            let meta = worker::source_metadata(&source)?;
            let hash = worker::hash(&source)?;
            let recipe_hash = hex::encode(Sha256::digest(
                format!(
                    "{}-recipe1\0{hash}\0{}",
                    format!(
                        "{}:{}:{}",
                        worker::runtime_identity()?,
                        recipe.pp3(false, false)?,
                        recipe.pp3(true, false)?
                    ),
                    serde_json::to_string(&recipe).map_err(|e| e.to_string())?
                )
                .as_bytes(),
            ));
            if let Some(count) = manifest::reusable(&source, &recipe_hash, &recipe)? {
                manifest::confirm_reuse(&source, &hash)?;
                process::append_process_job_log(
                    id,
                    "Reused unchanged, checksum-verified RAW outputs",
                );
                return Ok(count);
            }
            let space = worker::Workspace::new()?;
            let mut outputs = vec![];
            for (enabled, bw, kind) in
                [(recipe.colour, false, "developed"), (recipe.bw, true, "bw")]
            {
                if !enabled {
                    continue;
                }
                let out = worker::execute(&source, &recipe, bw, false, &space, Some(id))?;
                worker::final_metadata(&source, &out, recipe.keep_gps)?;
                let output_meta = worker::metadata(&out)?;
                let w = output_meta
                    .get("ImageWidth")
                    .and_then(|v| v.as_u64())
                    .ok_or("Output width missing")?;
                let h = output_meta
                    .get("ImageHeight")
                    .and_then(|v| v.as_u64())
                    .ok_or("Output height missing")?;
                if w == 0
                    || h == 0
                    || w * h > 100_000_000
                    || output_meta.get("Orientation").and_then(|v| v.as_u64()) != Some(1)
                    || output_meta.get("ProfileDescription").is_none()
                {
                    return Err(
                        "RAW output failed resolution, orientation or colour-profile validation"
                            .into(),
                    );
                }
                worker::validate_full_dimensions(&meta, w, h)?;
                if meta.get("DateTimeOriginal").is_some()
                    && meta.get("DateTimeOriginal") != output_meta.get("DateTimeOriginal")
                {
                    return Err("RAW capture time was not retained; no output published".into());
                }
                outputs.push((out, kind.into()));
            }
            if process::is_process_abort_requested(Some(id)) {
                return Err("RAW job aborted before publication".into());
            }
            worker::publish(&source, &outputs, &recipe, &hash, &recipe_hash).map(|o| o.len())
        })();
        match result {
            Ok(n) => {
                count += n;
                processed += 1
            }
            Err(e) => {
                errors.push(format!(
                    "{}: {e}",
                    source.file_name().unwrap().to_string_lossy()
                ));
                process::append_process_job_log(id, errors.last().unwrap());
            }
        }
        process::append_process_job_log(
            id,
            format!(
                "image finished in {} ms; processed={processed} outputs={count}",
                started.elapsed().as_millis()
            ),
        );
        process::update_process_job(id, |j| {
            j.done += 1;
            j.processed = processed;
            j.result_count = count;
        });
    }
    let aborted = process::is_process_abort_requested(Some(id));
    process::update_process_job(id, |j| {
        j.status = if aborted {
            ProcessJobStatus::Aborted
        } else if errors.is_empty() {
            ProcessJobStatus::Completed
        } else {
            ProcessJobStatus::Failed
        };
        j.errors = errors.clone();
        j.finished_at = Some(process::now_string());
        j.current_file = "Done".into();
    });
    let _ = app;
    Ok(ProcessResult {
        processed,
        result_count: count,
        errors,
    })
}
#[cfg(test)]
mod tests;
