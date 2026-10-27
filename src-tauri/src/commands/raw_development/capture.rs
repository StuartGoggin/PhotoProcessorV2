//! Conservative capture identity for RAW+camera-JPEG navigation. Filename
//! similarity is insufficient after import has renamed captures. Require the
//! same camera serial/model and exact recorded date plus subsecond timestamp.
use super::{manifest, worker};
use crate::commands::{google_photos::catalogue, metadata_tools};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
#[derive(Clone)]
struct Entry {
    bytes: u64,
    modified: u64,
    token: Option<String>,
}
#[derive(Default)]
struct Cache {
    entries: HashMap<PathBuf, Entry>,
    order: VecDeque<PathBuf>,
}
fn cache() -> &'static Mutex<Cache> {
    static C: OnceLock<Mutex<Cache>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Cache::default()))
}
fn normal(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches("//?/")
        .to_lowercase()
}
fn text(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|v| {
        v.as_str()
            .map(str::to_string)
            .or_else(|| v.as_u64().map(|n| n.to_string()))
    })
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
}
fn token(value: &serde_json::Value) -> Option<String> {
    let model = text(value.get("Model"))?;
    let serial = text(
        value
            .get("SerialNumber")
            .or_else(|| value.get("BodySerialNumber")),
    )?;
    let date = text(value.get("DateTimeOriginal"))?;
    let sub = text(value.get("SubSecTimeOriginal"))?;
    if model.len() > 128 || serial.len() > 64 || date.len() > 40 || sub.len() > 16 {
        return None;
    }
    Some(format!("{model}\0{serial}\0{date}\0{sub}"))
}
pub fn pairs(files: &[PathBuf], excluded: &HashSet<usize>) -> Vec<(usize, usize)> {
    if !files.iter().any(|p| super::is_raw(p)) {
        return vec![];
    }
    let candidates: Vec<_> = files
        .iter()
        .enumerate()
        .filter(|(i, p)| {
            !excluded.contains(i)
                && (super::is_raw(p)
                    || p.extension().is_some_and(|e| {
                        e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg")
                    }))
        })
        .filter(|(_, p)| super::reject_link(p).is_ok())
        .collect();
    if !candidates.iter().any(|(_, p)| !super::is_raw(p)) {
        return vec![];
    }
    let mut values = HashMap::<usize, Option<String>>::new();
    let mut missing = vec![];
    {
        let Ok(cache) = cache().lock() else {
            return vec![];
        };
        for &(index, path) in &candidates {
            let Ok(meta) = std::fs::metadata(path) else {
                continue;
            };
            let modified = manifest::modified(path).unwrap_or(0);
            if let Some(hit) = cache
                .entries
                .get(path)
                .filter(|e| e.bytes == meta.len() && e.modified == modified)
            {
                values.insert(index, hit.token.clone());
            } else {
                missing.push((index, path.clone(), meta.len(), modified));
            }
        }
    }
    if !missing.is_empty() {
        let (tool, _) = metadata_tools::resolve("");
        let mut args = vec![
            "-j".into(),
            "-n".into(),
            "-Model".into(),
            "-SerialNumber".into(),
            "-BodySerialNumber".into(),
            "-DateTimeOriginal".into(),
            "-SubSecTimeOriginal".into(),
        ];
        args.extend(missing.iter().map(|(_, p, _, _)| p.as_os_str().to_owned()));
        let Ok(bytes) = metadata_tools::run_limited(&tool, &args, 32 * 1024 * 1024) else {
            return vec![];
        };
        let Ok(rows) = serde_json::from_slice::<Vec<serde_json::Value>>(&bytes) else {
            return vec![];
        };
        if rows.len() > missing.len() {
            return vec![];
        }
        let by_path: HashMap<_, _> = rows
            .into_iter()
            .filter_map(|v| {
                v.get("SourceFile")
                    .and_then(|s| s.as_str())
                    .map(|p| (normal(p), token(&v)))
            })
            .collect();
        let Ok(mut cache) = cache().lock() else {
            return vec![];
        };
        for (index, path, bytes, modified) in missing {
            let value = by_path
                .get(&normal(&path.to_string_lossy()))
                .cloned()
                .unwrap_or(None);
            values.insert(index, value.clone());
            if !cache.entries.contains_key(&path) {
                cache.order.push_back(path.clone());
            }
            cache.entries.insert(
                path,
                Entry {
                    bytes,
                    modified,
                    token: value,
                },
            );
            while cache.entries.len() > 50_000 {
                if let Some(old) = cache.order.pop_front() {
                    cache.entries.remove(&old);
                } else {
                    break;
                }
            }
        }
    }
    let mut groups = HashMap::<String, (Vec<usize>, Vec<usize>)>::new();
    for (index, value) in values {
        if let Some(value) = value {
            let group = groups.entry(value).or_default();
            if super::is_raw(&files[index]) {
                group.0.push(index)
            } else {
                group.1.push(index)
            }
        }
    }
    groups
        .into_values()
        .filter_map(|(raw, jpeg)| {
            if raw.len() == 1 && jpeg.len() == 1 {
                Some((raw[0], jpeg[0]))
            } else {
                None
            }
        })
        .collect()
}
/// A maintenance operation may keep stable rating/trash tags, or move the
/// entire event folder. It cannot strand RAW recipes by moving one member.
pub fn guard_move(source: &Path, target: &Path) -> Result<worker::FolderLease, String> {
    guard_change(source, Some(target))
}
fn protected(m: &manifest::Manifest, source: &Path) -> bool {
    let key = catalogue::curation_key(source);
    m.records.iter().any(|(k, r)| {
        (*k == key
            && (r.recipe.is_some() || r.last_applied_recipe.is_some() || !r.outputs.is_empty()))
            || r.outputs
                .iter()
                .any(|o| catalogue::curation_key(Path::new(&o.file)) == key)
    })
}
fn guard_change(source: &Path, target: Option<&Path>) -> Result<worker::FolderLease, String> {
    let parent = source.parent().ok_or("Photo parent missing")?;
    let started = std::time::Instant::now();
    let lease = loop {
        match worker::FolderLease::acquire(parent) {
            Ok(lease) => break lease,
            Err(error) if started.elapsed() >= std::time::Duration::from_secs(2) => {
                return Err(error)
            }
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
        }
    };
    let m = manifest::load(parent)?;
    if target.is_some_and(|target| {
        source.parent() == target.parent()
            && catalogue::curation_key(source) == catalogue::curation_key(target)
    }) {
        return Ok(lease);
    }
    if protected(&m, source) {
        return Err("This file has saved RAW development recipes or generated versions. Move or rename the entire event folder instead; rating and trash flags remain available.".into());
    }
    Ok(lease)
}
pub fn guard_reprocess(source: &Path) -> Result<worker::FolderLease, String> {
    guard_change(source, None)
}
/// Read each folder once before any in-place import maintenance changes a file.
pub fn preflight_reprocess(files: &[PathBuf]) -> Result<(), String> {
    let mut groups = HashMap::<&Path, Vec<&Path>>::new();
    for source in files {
        groups
            .entry(source.parent().ok_or("Photo parent missing")?)
            .or_default()
            .push(source);
    }
    for (parent, sources) in groups {
        let _lease = worker::FolderLease::acquire(parent)?;
        let m = manifest::load(parent)?;
        if sources.into_iter().any(|source| protected(&m, source)) {
            return Err("Reprocess was stopped before changing any files: this scope contains saved RAW recipes or developed versions. Move/rename the entire event folder instead, or choose a scope without RAW development lineage.".into());
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_proof_requires_serial_subseconds_and_model() {
        assert!(token(
            &serde_json::json!({"Model":"R6m2","DateTimeOriginal":"2026:01:01 12:00:00"})
        )
        .is_none());
        let v = serde_json::json!({"Model":"R6m2","SerialNumber":"123","DateTimeOriginal":"2026:01:01 12:00:00","SubSecTimeOriginal":"012"});
        assert!(token(&v).is_some());
        let mut other = v.clone();
        other["SerialNumber"] = "456".into();
        assert_ne!(token(&v), token(&other));
    }
}
