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
pub fn candidate_paths(files: &[PathBuf], excluded: &HashSet<usize>) -> Vec<PathBuf> {
    let paths: Vec<_> = files
        .iter()
        .enumerate()
        .filter(|(i, p)| {
            !excluded.contains(i)
                && (super::is_raw(p)
                    || p.extension().is_some_and(|e| {
                        e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg")
                    }))
                && super::reject_link(p).is_ok()
        })
        .map(|(_, p)| p.clone())
        .collect();
    if !paths.iter().any(|p| super::is_raw(p)) || !paths.iter().any(|p| !super::is_raw(p)) {
        return vec![];
    }
    paths
}
/// A snapshot distinguishes successful missing tags (None) from failed reads
/// (absent key). Incomplete folders can never become apparently unique pairs.
pub fn read_tokens(files: &[PathBuf]) -> HashMap<PathBuf, Option<String>> {
    fn collect(
        files: &[PathBuf],
        values: &mut HashMap<PathBuf, Option<String>>,
    ) -> Vec<(PathBuf, u64, u64)> {
        let Ok(cache) = cache().lock() else {
            return vec![];
        };
        let mut missing = vec![];
        let mut seen = HashSet::new();
        for path in files {
            if !seen.insert(path) {
                continue;
            }
            let Ok(meta) = std::fs::metadata(path) else {
                continue;
            };
            let Ok(modified) = manifest::modified(path) else {
                continue;
            };
            if let Some(hit) = cache
                .entries
                .get(path)
                .filter(|e| e.bytes == meta.len() && e.modified == modified)
            {
                values.insert(path.clone(), hit.token.clone());
            } else {
                missing.push((path.clone(), meta.len(), modified));
            }
        }
        missing
    }
    let mut values = HashMap::new();
    if collect(files, &mut values).is_empty() {
        return values;
    }
    static LANE: Mutex<()> = Mutex::new(());
    let Ok(_lane) = LANE.lock() else {
        return values;
    };
    // Another caller may have filled these entries while this one waited.
    let missing = collect(files, &mut values);
    let (tool, _) = metadata_tools::resolve("");
    let mut position = 0;
    while position < missing.len() {
        let start = position;
        let mut argument_bytes = 0;
        while position < missing.len() && position - start < 128 {
            let n = missing[position].0.as_os_str().len() + 1;
            if position > start && argument_bytes + n > 64 * 1024 {
                break;
            }
            argument_bytes += n;
            position += 1;
        }
        let batch = &missing[start..position];
        let mut args = vec![
            "-j".into(),
            "-n".into(),
            "-Model".into(),
            "-SerialNumber".into(),
            "-BodySerialNumber".into(),
            "-DateTimeOriginal".into(),
            "-SubSecTimeOriginal".into(),
        ];
        args.extend(batch.iter().map(|(p, _, _)| p.as_os_str().to_owned()));
        let Ok(bytes) = metadata_tools::run_limited(&tool, &args, 4 * 1024 * 1024) else {
            continue;
        };
        let Ok(rows) = serde_json::from_slice::<Vec<serde_json::Value>>(&bytes) else {
            continue;
        };
        if rows.len() > batch.len() {
            continue;
        }
        let mut by_path = HashMap::<String, Vec<serde_json::Value>>::new();
        for row in rows {
            if let Some(path) = row.get("SourceFile").and_then(|v| v.as_str()) {
                by_path.entry(normal(path)).or_default().push(row);
            }
        }
        let Ok(mut cache) = cache().lock() else {
            continue;
        };
        for (path, bytes, modified) in batch {
            let Some(rows) = by_path.get(&normal(&path.to_string_lossy())) else {
                continue;
            };
            if rows.len() != 1 || rows[0].get("Error").is_some() {
                continue;
            }
            if std::fs::metadata(path)
                .map(|m| m.len() != *bytes)
                .unwrap_or(true)
                || manifest::modified(path).ok() != Some(*modified)
            {
                continue;
            }
            let value = token(&rows[0]);
            values.insert(path.clone(), value.clone());
            if !cache.entries.contains_key(path) {
                cache.order.push_back(path.clone());
            }
            cache.entries.insert(
                path.clone(),
                Entry {
                    bytes: *bytes,
                    modified: *modified,
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
    values
}
pub fn pairs_from_tokens(
    files: &[PathBuf],
    excluded: &HashSet<usize>,
    values: &HashMap<PathBuf, Option<String>>,
) -> Vec<(usize, usize)> {
    let candidates = candidate_paths(files, excluded);
    if candidates.iter().any(|p| !values.contains_key(p)) {
        return vec![];
    }
    let mut groups = HashMap::<(PathBuf, String), (Vec<usize>, Vec<usize>)>::new();
    for (index, path) in files.iter().enumerate() {
        if excluded.contains(&index) {
            continue;
        }
        if let Some(Some(token)) = values.get(path) {
            let group = groups
                .entry((
                    path.parent().unwrap_or(Path::new("")).to_path_buf(),
                    token.clone(),
                ))
                .or_default();
            if super::is_raw(path) {
                group.0.push(index)
            } else if path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg"))
            {
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
pub fn pairs(files: &[PathBuf], excluded: &HashSet<usize>) -> Vec<(usize, usize)> {
    let candidates = candidate_paths(files, excluded);
    let values = read_tokens(&candidates);
    pairs_from_tokens(files, excluded, &values)
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
    #[test]
    fn pairs_need_a_complete_unique_same_folder_snapshot() {
        let space = worker::Workspace::new().unwrap();
        std::fs::create_dir(space.0.join("one")).unwrap();
        std::fs::create_dir(space.0.join("two")).unwrap();
        let files: Vec<_> = ["one/a.cr3", "one/b.jpg", "two/c.cr3", "two/d.jpg"]
            .iter()
            .map(|p| space.0.join(p))
            .collect();
        for path in &files {
            std::fs::write(path, b"owned snapshot fixture").unwrap();
        }
        let mut values: HashMap<_, _> = files
            .iter()
            .cloned()
            .map(|p| (p, Some("same capture".into())))
            .collect();
        let mut pairs = pairs_from_tokens(&files, &HashSet::new(), &values);
        pairs.sort();
        assert_eq!(
            pairs,
            vec![(0, 1), (2, 3)],
            "Matching tokens in other folders do not make either capture ambiguous"
        );
        values.remove(&files[1]);
        assert!(
            pairs_from_tokens(&files, &HashSet::new(), &values).is_empty(),
            "An unread row cannot prove uniqueness"
        );
        values.insert(files[1].clone(), None);
        assert_eq!(
            pairs_from_tokens(&files, &HashSet::new(), &values),
            vec![(2, 3)],
            "Successfully absent tags are distinct from failed reads"
        );
        let mut duplicates = files.clone();
        duplicates.push(space.0.join("two/duplicate.cr3"));
        std::fs::write(&duplicates[4], b"owned duplicate fixture").unwrap();
        values.insert(duplicates[4].clone(), Some("same capture".into()));
        assert!(
            pairs_from_tokens(&duplicates, &HashSet::new(), &values).is_empty(),
            "A duplicate anywhere in the complete folder snapshot defeats a unique pair"
        );
    }
}
