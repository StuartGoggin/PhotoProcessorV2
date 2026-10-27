use super::{manifest, RawRecipe};
use crate::commands::{metadata_tools, process};
use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub struct FolderLease(fs::File);
impl FolderLease {
    pub fn acquire(dir: &Path) -> Result<Self, String> {
        let path = dir.join(".photogogo-raw.lock");
        if path.exists() {
            super::reject_link(&path)?
        }
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.try_lock_exclusive().map_err(|_| {
            "This folder has another active RAW metadata operation; retry after it finishes."
        })?;
        Ok(Self(file))
    }
}
impl Drop for FolderLease {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}
pub struct Workspace(pub PathBuf);
impl Workspace {
    pub fn new() -> Result<Self, String> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "photogogo-raw-{}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_millis(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        fs::create_dir(&p).map_err(|e| e.to_string())?;
        fs::create_dir(p.join("settings")).map_err(|e| e.to_string())?;
        fs::create_dir(p.join("cache")).map_err(|e| e.to_string())?;
        let profiles = p.join("settings/profiles");
        fs::create_dir(&profiles).map_err(|e| e.to_string())?;
        fs::write(
            profiles.join("Neutral.pp3"),
            "[Version]\nAppVersion=5.13\nVersion=353\n",
        )
        .map_err(|e| e.to_string())?;
        let directory = profiles.to_string_lossy().replace('\\', "/");
        fs::write(p.join("settings/options"),format!("[General]\nMultiUser=true\n[Profiles]\nDirectory={directory}\nRawDefault=Neutral\nImgDefault=Neutral\nUseBundledProfiles=false\nCustomProfileBuilder=\n[Metadata]\nXMPSynchronization=none\n")).map_err(|e|e.to_string())?;
        Ok(Self(p))
    }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
pub fn hash(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut b = [0; 256 * 1024];
    loop {
        let n = f.read(&mut b).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(hex::encode(h.finalize()))
}
pub fn runtime() -> Result<PathBuf, String> {
    let root = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    let mut paths: Vec<PathBuf> = root
        .into_iter()
        .map(|r| r.join("tools/rawtherapee/rawtherapee-cli.exe"))
        .collect();
    #[cfg(any(debug_assertions, test))]
    paths.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/rawtherapee/rawtherapee-cli.exe"));
    paths.into_iter().find(|p|p.is_file()).ok_or("Bundled RAW developer is missing. Repair the PhotoGoGo installation; no external editor is required.".into())
}
/// Verify the packaged worker/data closure once per process. Its digest also
/// invalidates render reuse after an engine or camera/profile update.
pub fn runtime_identity() -> Result<String, String> {
    static ID: std::sync::OnceLock<Result<String, String>> = std::sync::OnceLock::new();
    ID.get_or_init(|| {
        #[derive(serde::Deserialize)]
        struct Item {
            path: String,
            bytes: u64,
            sha256: String,
        }
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Manifest {
            schema_version: u32,
            version: String,
            files: Vec<Item>,
        }
        let binary = runtime()?;
        let root = binary.parent().ok_or("RAW runtime root missing")?;
        let manifest = root.join("runtime-manifest.json");
        let length = fs::metadata(&manifest)
            .map_err(|_| "RAW runtime manifest is missing; repair the installation")?
            .len();
        if length > 2 * 1024 * 1024 {
            return Err("RAW runtime manifest exceeds its integrity limit".into());
        }
        let bytes = fs::read(&manifest).map_err(|e| e.to_string())?;
        let m: Manifest =
            serde_json::from_slice(&bytes).map_err(|_| "RAW runtime manifest is invalid")?;
        if m.schema_version != 1
            || m.version != "5.13"
            || m.files.is_empty()
            || m.files.len() > 5000
        {
            return Err("Unsupported RAW runtime manifest".into());
        }
        let mut names = std::collections::HashSet::new();
        for f in &m.files {
            if !names.insert(f.path.to_lowercase()) {
                return Err("Duplicate RAW runtime resource".into());
            }
        }
        for name in [
            "rawtherapee-cli.exe",
            "options",
            "camconst.json",
            "iccprofiles/output/rtv4_srgb.icc",
        ] {
            if !names.contains(name) {
                return Err("Required RAW runtime resource is not declared".into());
            }
        }
        for f in m.files {
            let rel = Path::new(&f.path);
            if rel
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
            {
                return Err("Invalid RAW runtime resource path".into());
            }
            let p = root.join(rel);
            super::reject_link(&p)?;
            if fs::metadata(&p)
                .map_err(|_| "A RAW runtime resource is missing")?
                .len()
                != f.bytes
                || hash(&p)? != f.sha256
            {
                return Err(format!(
                    "RAW runtime resource changed: {}. Repair the installation.",
                    f.path
                ));
            }
        }
        Ok(hex::encode(Sha256::digest(&bytes)))
    })
    .clone()
}
pub fn metadata(source: &Path) -> Result<serde_json::Value, String> {
    let (tool, _) = metadata_tools::resolve("");
    let mut args = vec!["-j".into(), "-n".into()];
    for tag in [
        "-Model",
        "-FileType",
        "-SensorWidth",
        "-SensorHeight",
        "-Quality",
        "-CanonImageType",
        "-BitsPerSample",
        "-ImageWidth",
        "-ImageHeight",
        "-ExifImageWidth",
        "-ExifImageHeight",
        "-Orientation",
        "-RawBurstImageCount",
        "-RawBurstImageNum",
        "-RawBurstModeRoll",
        "-ProfileDescription",
        "-DateTimeOriginal",
    ] {
        args.push(tag.into())
    }
    args.push(source.as_os_str().to_owned());
    let bytes = metadata_tools::run(&tool, &args)?;
    let values: Vec<serde_json::Value> =
        serde_json::from_slice(&bytes).map_err(|_| "Could not read RAW metadata")?;
    let value = values.into_iter().next().ok_or("RAW metadata was empty")?;
    if value.get("Error").is_some() {
        return Err("RAW metadata could not be decoded".into());
    }
    if value
        .get("RawBurstImageCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
        > 1
        || value
            .get("RawBurstModeRoll")
            .and_then(|v| v.as_u64())
            .unwrap_or(0)
            > 0
    {
        return Err("This CR3 is a RAW burst roll containing multiple frames. Extract individual RAW images before development; a roll preview is not a complete import.".into());
    }
    Ok(value)
}
pub fn camera_preview(source: &Path) -> Result<(image::DynamicImage, u32, u32), String> {
    let meta = source_metadata(source)?;
    let (tool, _) = metadata_tools::resolve("");
    for tag in ["-JpgFromRaw", "-PreviewImage"] {
        let bytes = metadata_tools::run_limited(
            &tool,
            &["-b".into(), tag.into(), source.as_os_str().to_owned()],
            32 * 1024 * 1024,
        )?;
        if bytes.is_empty() {
            continue;
        }
        let reader = image::ImageReader::new(std::io::Cursor::new(&bytes))
            .with_guessed_format()
            .map_err(|e| e.to_string())?;
        let (w, h) = reader.into_dimensions().map_err(|e| e.to_string())?;
        if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 100_000_000 {
            return Err("Camera preview exceeds the pixel safety limit".into());
        }
        let mut image = image::load_from_memory(&bytes).map_err(|e| e.to_string())?;
        if let Some(o) = meta
            .get("Orientation")
            .and_then(|v| v.as_u64())
            .and_then(|v| image::metadata::Orientation::from_exif(v as u8))
        {
            image.apply_orientation(o)
        }
        let (w, h) = (image.width(), image.height());
        return Ok((image, w, h));
    }
    Err(
        "No usable embedded camera preview. Use RAW Development to decode the full original."
            .into(),
    )
}
pub fn source_metadata(source: &Path) -> Result<serde_json::Value, String> {
    let meta = metadata(source)?;
    if meta.get("FileType").and_then(|v| v.as_str()) != Some("CR3") {
        return Err(
            "This file is not a decoded Canon CR3 container. A renamed JPEG is not a RAW original."
                .into(),
        );
    }
    expected_dimensions(&meta)?;
    Ok(meta)
}
pub fn expected_dimensions(meta: &serde_json::Value) -> Result<(u64, u64), String> {
    let w = meta
        .get("ExifImageWidth")
        .or_else(|| meta.get("ImageWidth"))
        .and_then(|v| v.as_u64())
        .ok_or(
            "Full RAW dimensions are unavailable; this capture mode cannot yet be safely exported",
        )?;
    let h = meta
        .get("ExifImageHeight")
        .or_else(|| meta.get("ImageHeight"))
        .and_then(|v| v.as_u64())
        .ok_or(
            "Full RAW dimensions are unavailable; this capture mode cannot yet be safely exported",
        )?;
    if w < 512 || h < 512 || w * h > 100_000_000 {
        return Err("Recorded RAW dimensions exceed the safe full-resolution range".into());
    }
    Ok(
        if matches!(
            meta.get("Orientation").and_then(|v| v.as_u64()),
            Some(5..=8)
        ) {
            (h, w)
        } else {
            (w, h)
        },
    )
}
/// Camera JPEG framing can omit a narrow strip of valid RAW sensor pixels.
/// Never resize to make these agree. Accept only a small, sensor-bounded margin
/// from the full, resize-disabled decoder; large/aspect-mode differences stop.
pub fn validate_full_dimensions(meta: &serde_json::Value, w: u64, h: u64) -> Result<(), String> {
    let (cw, ch) = expected_dimensions(meta)?;
    if (w, h) == (cw, ch) {
        return Ok(());
    }
    let sw = meta
        .get("SensorWidth")
        .and_then(|v| v.as_u64())
        .ok_or("RAW decoder size differs from camera framing and sensor bounds are unavailable")?;
    let sh = meta
        .get("SensorHeight")
        .and_then(|v| v.as_u64())
        .ok_or("RAW sensor height unavailable")?;
    let (sw, sh) = if matches!(
        meta.get("Orientation").and_then(|v| v.as_u64()),
        Some(5..=8)
    ) {
        (sh, sw)
    } else {
        (sw, sh)
    };
    if w < cw || h < ch || w > cw + 64 || h > ch + 64 || w > sw || h > sh {
        return Err(format!("RAW output {w}×{h} is inconsistent with camera framing {cw}×{ch} and sensor bounds {sw}×{sh}; no file published"));
    }
    Ok(())
}
pub fn execute(
    source: &Path,
    recipe: &RawRecipe,
    bw: bool,
    preview: bool,
    space: &Workspace,
    job: Option<&str>,
) -> Result<PathBuf, String> {
    // Every caller, including preview, must pass RAW-container/mode admission.
    // Optional embedded-reference extraction must never swallow this check.
    source_metadata(source)?;
    runtime_identity()?;
    let binary = runtime()?;
    let dir = binary.parent().ok_or("RAW runtime folder missing")?;
    let pp3 = space.0.join(if bw { "bw.pp3" } else { "colour.pp3" });
    fs::write(&pp3, recipe.pp3(bw, preview)?).map_err(|e| e.to_string())?;
    let ext = if !preview && recipe.output == "tiff16" {
        "tif"
    } else {
        "jpg"
    };
    let out = space
        .0
        .join(format!("{}.{ext}", if bw { "bw" } else { "colour" }));
    let mut cmd = Command::new(&binary);
    cmd.current_dir(dir)
        .env("RT_SETTINGS", space.0.join("settings"))
        .env("RT_CACHE", space.0.join("cache"))
        .env(
            "OMP_NUM_THREADS",
            crate::utils::num_cpus().clamp(1, 8).to_string(),
        )
        .env("OMP_THREAD_LIMIT", "8")
        .args(["-q", "-a", "-o"])
        .arg(&out)
        .arg("-p")
        .arg(&pp3);
    if ext == "tif" {
        cmd.args(["-t", "-b16"]);
    } else {
        cmd.args(["-j95", "-js3"]);
    }
    cmd.arg("-c")
        .arg(source)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("RAW developer could not start: {e}"))?;
    fn drain(mut input: impl Read) -> Vec<u8> {
        let mut result = vec![];
        let mut buffer = [0; 8192];
        loop {
            match input.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let take = n.min(64 * 1024 - result.len());
                    result.extend_from_slice(&buffer[..take]);
                }
            }
        }
        result
    }
    let stdout = child.stdout.take().ok_or("RAW stdout missing")?;
    let stderr = child.stderr.take().ok_or("RAW stderr missing")?;
    let output = std::thread::spawn(move || drain(stdout));
    let error = std::thread::spawn(move || drain(stderr));
    #[cfg(windows)]
    let _tree = match metadata_tools::ToolProcessJob::attach_bounded(
        &child,
        Some(4 * 1024 * 1024 * 1024),
    ) {
        Ok(j) => j,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };
    let start = Instant::now();
    if let Some(id) = job {
        process::append_process_job_log(id,format!("RAW decoder started pid={} (one worker, at most 8 threads, 4 GiB memory, 300 s limit)",child.id()));
    }
    loop {
        if process::is_process_abort_requested(job) || start.elapsed() > Duration::from_secs(300) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("RAW development cancelled or exceeded its five-minute limit; existing files were retained.".into());
        }
        match child.try_wait() {
            Ok(Some(s)) => {
                let errors = error.join().unwrap_or_default();
                let outputs = output.join().unwrap_or_default();
                let diagnostic = format!(
                    "{} {}",
                    String::from_utf8_lossy(&errors),
                    String::from_utf8_lossy(&outputs)
                )
                .chars()
                .take(1600)
                .collect::<String>();
                if !s.success() {
                    return Err(format!("RAW developer failed ({s}): {diagnostic}. The source and previous outputs were retained."));
                }
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(75)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
    }
    if !out.is_file() || fs::metadata(&out).map_err(|e| e.to_string())?.len() > 256 * 1024 * 1024 {
        return Err("RAW output is missing or exceeds the 256 MiB limit".into());
    }
    Ok(out)
}
pub fn final_metadata(source: &Path, out: &Path, keep_gps: bool) -> Result<(), String> {
    let (tool, _) = metadata_tools::resolve("");
    let mut args = vec![
        "-overwrite_original".into(),
        "-EXIF:all=".into(),
        "-IPTC:all=".into(),
        "-XMP:all=".into(),
        "-Comment=".into(),
        "-TagsFromFile".into(),
        source.as_os_str().to_owned(),
    ];
    for tag in [
        "-DateTimeOriginal",
        "-CreateDate",
        "-SubSecTimeOriginal",
        "-OffsetTimeOriginal",
        "-Make",
        "-Model",
        "-LensModel",
        "-LensInfo",
        "-FNumber",
        "-ExposureTime",
        "-ISO",
        "-FocalLength",
        "-Artist",
        "-Copyright",
        "-ImageDescription",
    ] {
        args.push(tag.into())
    }
    if keep_gps {
        args.push("-GPS:all".into())
    } else {
        args.push("-GPS:all=".into())
    }
    args.extend(["-Orientation#=1".into(), out.as_os_str().to_owned()]);
    metadata_tools::run(&tool, &args)?;
    Ok(())
}
/// Stage in the destination filesystem, then atomically create a new name with
/// a hard link. Never use replace-existing rename on a user photo.
pub fn publish(
    source: &Path,
    outputs: &[(PathBuf, String)],
    recipe: &RawRecipe,
    source_hash: &str,
    recipe_hash: &str,
) -> Result<Vec<manifest::Output>, String> {
    let dir = source.parent().ok_or("RAW parent missing")?;
    let stem = source.file_stem().unwrap().to_string_lossy();
    let stem: String = stem.chars().take(90).collect();
    let mut published = vec![];
    let mut created = vec![];
    let result = manifest::edit(source, |rec| {
        if hash(source)? != source_hash {
            return Err("RAW changed during conversion; no output was published".into());
        }
        for (path, kind) in outputs {
            let ext = path.extension().unwrap().to_string_lossy();
            let name = format!("{stem}_raw-{kind}-{}.{ext}", &recipe_hash[..12]);
            let target = dir.join(&name);
            let digest = hash(path)?;
            let bytes = fs::metadata(path).map_err(|e| e.to_string())?.len();
            if target.exists() {
                let owned = rec
                    .outputs
                    .iter()
                    .any(|o| o.file == name && o.hash == digest && o.recipe_hash == recipe_hash);
                super::reject_link(&target)?;
                if !owned || hash(&target)? != digest {
                    return Err("A RAW output name already exists and cannot be safely reused. Both files were preserved.".into());
                }
            } else {
                let temp = dir.join(format!(
                    ".photogogo-raw-{}-{}-{}.partial",
                    std::process::id(),
                    chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0),
                    kind
                ));
                let mut f = fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temp)
                    .map_err(|e| e.to_string())?;
                let staged = (|| {
                    let mut input = fs::File::open(path).map_err(|e| e.to_string())?;
                    std::io::copy(&mut input, &mut f).map_err(|e| e.to_string())?;
                    f.flush().map_err(|e| e.to_string())?;
                    f.sync_all().map_err(|e| e.to_string())?;
                    drop(f);
                    fs::hard_link(&temp, &target).map_err(|e| {
                        format!("Could not atomically publish RAW output on this filesystem: {e}")
                    })
                })();
                let _ = fs::remove_file(&temp);
                staged?;
                created.push(target);
            }
            published.push(manifest::Output {
                file: name,
                kind: kind.clone(),
                hash: digest,
                bytes,
                recipe_hash: recipe_hash.into(),
                active: true,
            });
        }
        rec.source_hash = source_hash.into();
        rec.source_bytes = fs::metadata(source).map_err(|e| e.to_string())?.len();
        rec.source_modified = manifest::modified(source)?;
        for old in &mut rec.outputs {
            old.active = false
        }
        rec.outputs
            .retain(|old| !published.iter().any(|new| new.file == old.file));
        rec.outputs.extend(published.clone());
        if rec.outputs.len() > 1000 {
            return Err("This RAW has too many saved generations; archive older generations before continuing".into());
        }
        rec.last_applied_recipe = Some(recipe.clone());
        Ok(())
    });
    if result.is_err() {
        for path in created {
            let _ = fs::remove_file(path);
        }
    }
    result?;
    Ok(published)
}
