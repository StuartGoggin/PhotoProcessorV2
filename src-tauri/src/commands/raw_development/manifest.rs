use super::{safe_source, RawRecipe};
use crate::commands::google_photos::{catalogue, store};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
};
pub const NAME: &str = ".photogogo-raw.json";
static EDIT: Mutex<()> = Mutex::new(());
static EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub fn snapshot() -> Result<u64, String> {
    let n = EPOCH.load(std::sync::atomic::Ordering::SeqCst);
    if n % 2 != 0 {
        return Err(
            "RAW output publication is in progress. Refresh the catalogue after it finishes."
                .into(),
        );
    }
    Ok(n)
}
pub fn unchanged(n: u64) -> Result<(), String> {
    if EPOCH.load(std::sync::atomic::Ordering::SeqCst) != n {
        return Err(
            "RAW outputs changed during this scan. Refresh before reviewing or transferring."
                .into(),
        );
    }
    Ok(())
}
struct Publishing;
impl Publishing {
    fn begin() -> Self {
        EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self
    }
}
impl Drop for Publishing {
    fn drop(&mut self) {
        EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub source: String,
    pub source_hash: String,
    pub source_bytes: u64,
    pub source_modified: u64,
    pub recipe: Option<RawRecipe>,
    #[serde(default)]
    pub last_applied_recipe: Option<RawRecipe>,
    pub outputs: Vec<Output>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub file: String,
    pub kind: String,
    pub hash: String,
    pub bytes: u64,
    pub recipe_hash: String,
    #[serde(default = "active")]
    pub active: bool,
}
fn active() -> bool {
    true
}
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema_version: u32,
    pub records: BTreeMap<String, Record>,
}
pub fn load(dir: &Path) -> Result<Manifest, String> {
    let Some(bytes) = store::read_bounded(&dir.join(NAME), 16 * 1024 * 1024)? else {
        return Ok(Manifest {
            schema_version: 1,
            ..Default::default()
        });
    };
    let m: Manifest = serde_json::from_slice(&bytes).map_err(|_| {
        "RAW metadata is invalid; preserve it and recover a saved copy before editing."
    })?;
    if m.schema_version != 1 {
        return Err("Unsupported RAW metadata version".into());
    }
    Ok(m)
}
pub fn modified(path: &Path) -> Result<u64, String> {
    Ok(std::fs::metadata(path)
        .map_err(|e| e.to_string())?
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0))
}
pub fn edit(
    path: &Path,
    action: impl FnOnce(&mut Record) -> Result<(), String>,
) -> Result<(), String> {
    let _guard = EDIT.lock().map_err(|_| "RAW metadata lock failed")?;
    let _publication = Publishing::begin();
    let dir = path.parent().ok_or("RAW parent missing")?;
    let _lease = super::worker::FolderLease::acquire(dir)?;
    let mut m = load(dir)?;
    let record = m.records.entry(catalogue::curation_key(path)).or_default();
    record.source = path
        .file_name()
        .ok_or("RAW filename missing")?
        .to_string_lossy()
        .into_owned();
    action(record)?;
    let bytes = serde_json::to_vec_pretty(&m).map_err(|e| e.to_string())?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("This folder's RAW metadata reached its 16 MiB limit. Previous metadata and photos were preserved.".into());
    }
    store::atomic_write(&dir.join(NAME), &bytes)
}
pub fn override_for(path: &Path) -> Result<Option<RawRecipe>, String> {
    Ok(load(path.parent().ok_or("RAW parent missing")?)?
        .records
        .get(&catalogue::curation_key(path))
        .and_then(|r| r.recipe.clone()))
}
pub fn confirm_reuse(path: &Path, source_hash: &str) -> Result<(), String> {
    edit(path, |r| {
        if r.source_hash != source_hash {
            return Err("RAW ownership does not match the verified source".into());
        }
        if super::worker::hash(path)? != source_hash {
            return Err(
                "RAW changed during reuse verification; previous outputs were preserved".into(),
            );
        }
        r.source_bytes = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
        r.source_modified = modified(path)?;
        Ok(())
    })
}
pub fn reusable(
    path: &Path,
    recipe_hash: &str,
    recipe: &RawRecipe,
) -> Result<Option<usize>, String> {
    let dir = path.parent().ok_or("RAW parent missing")?;
    let m = load(dir)?;
    let Some(r) = m.records.get(&catalogue::curation_key(path)) else {
        return Ok(None);
    };
    let wanted: Vec<_> = [(recipe.colour, "developed"), (recipe.bw, "bw")]
        .into_iter()
        .filter(|(on, _)| *on)
        .map(|(_, kind)| kind)
        .collect();
    for kind in &wanted {
        let Some(out) = r
            .outputs
            .iter()
            .find(|o| o.active && o.kind == *kind && o.recipe_hash == recipe_hash)
        else {
            return Ok(None);
        };
        if Path::new(&out.file).components().count() != 1 {
            return Ok(None);
        }
        let p = dir.join(&out.file);
        if !p.is_file() {
            return Ok(None);
        }
        super::reject_link(&p)?;
        if super::worker::hash(&p)? != out.hash {
            return Ok(None);
        }
    }
    Ok(Some(wanted.len()))
}
/// Explicit same-folder ownership only. Rating renames are resolved through the
/// same neutral key as curation; ambiguous or changed sources are never guessed.
pub fn associations(dir: &Path, files: &[PathBuf]) -> Result<Vec<(usize, usize, String)>, String> {
    // Cross-process writers hold this lease through link creation and commit.
    let _lease = if dir.join(NAME).exists() || dir.join(".photogogo-raw.lock").exists() {
        Some(super::worker::FolderLease::acquire(dir)?)
    } else {
        None
    };
    let m = load(dir)?;
    let mut result = vec![];
    if m.records.is_empty() {
        return Ok(result);
    }
    let mut by_key = std::collections::HashMap::<String, Vec<usize>>::new();
    for (index, path) in files.iter().enumerate() {
        by_key
            .entry(catalogue::curation_key(path))
            .or_default()
            .push(index);
    }
    for (key, rec) in m.records {
        let sources: Vec<_> = by_key
            .get(&key)
            .into_iter()
            .flatten()
            .copied()
            .filter(|&i| super::is_raw(&files[i]))
            .collect();
        if sources.len() != 1 {
            if !rec.outputs.is_empty() {
                return Err("RAW output ownership has a missing or ambiguous master. Restore or resolve it before transfer.".into());
            }
            continue;
        }
        let source = sources[0];
        let path = &files[source];
        if rec.source_bytes != std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
            || rec.source_modified != modified(path).unwrap_or(0)
        {
            if !rec.outputs.is_empty() {
                return Err("A RAW master changed after development. Review its saved output lineage before transfer.".into());
            }
            continue;
        }
        for out in rec.outputs {
            if !["developed", "bw"].contains(&out.kind.as_str())
                || Path::new(&out.file).components().count() != 1
            {
                continue;
            }
            let outkey = catalogue::curation_key(Path::new(&out.file));
            let matches: Vec<_> = by_key
                .get(&outkey)
                .into_iter()
                .flatten()
                .copied()
                .filter(|&i| {
                    store::reject_link(&files[i]).is_ok()
                        && std::fs::metadata(&files[i])
                            .map(|m| m.len() == out.bytes)
                            .unwrap_or(false)
                })
                .collect();
            if matches.len() == 1 {
                result.push((
                    matches[0],
                    source,
                    if out.active {
                        out.kind
                    } else {
                        format!("retired:{}", out.kind)
                    },
                ))
            } else if by_key.contains_key(&outkey) {
                return Err("A recorded RAW output changed size or has ambiguous names. Resolve it before transferring or processing; it was not reclassified as an original.".into());
            }
        }
    }
    Ok(result)
}
pub fn exclude_owned_jpegs(files: Vec<PathBuf>) -> Result<Vec<PathBuf>, String> {
    let mut owned = std::collections::HashMap::<PathBuf, std::collections::HashSet<String>>::new();
    for path in &files {
        let dir = path.parent().ok_or("JPEG parent missing")?.to_path_buf();
        if !owned.contains_key(&dir) {
            let m = load(&dir)?;
            let names = m
                .records
                .values()
                .flat_map(|r| r.outputs.iter())
                .filter(|o| Path::new(&o.file).components().count() == 1)
                .map(|o| catalogue::curation_key(Path::new(&o.file)))
                .collect();
            owned.insert(dir, names);
        }
    }
    Ok(files
        .into_iter()
        .filter(|p| !owned[p.parent().unwrap()].contains(&catalogue::curation_key(p)))
        .collect())
}
#[tauri::command]
pub async fn get_raw_recipe(
    staging_dir: String,
    path: String,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move||{
    let source = safe_source(&staging_dir, &path)?;
    let manifest=load(source.parent().ok_or("RAW parent missing")?)?;
    let record=manifest.records.get(&catalogue::curation_key(&source));
    Ok(serde_json::json!({"recipe":record.and_then(|r|r.recipe.as_ref()),"lastAppliedRecipe":record.and_then(|r|r.last_applied_recipe.as_ref())}))
    }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
pub async fn save_raw_recipe(
    staging_dir: String,
    path: String,
    recipe: RawRecipe,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        recipe.validate()?;
        let source = safe_source(&staging_dir, &path)?;
        edit(&source, |r| {
            r.recipe = Some(recipe);
            Ok(())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn clear_raw_recipe(staging_dir: String, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = safe_source(&staging_dir, &path)?;
        edit(&source, |r| {
            r.recipe = None;
            Ok(())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
