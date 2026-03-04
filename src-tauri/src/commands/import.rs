use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;
use crate::utils::unique_dest;

const SUPPORTED_EXTENSIONS: &[&str] = &[
    "cr3", "jpg", "jpeg", "avi", "mp4", "mkv", "mov", "dng", "mts",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportProgress {
    pub total: usize,
    pub done: usize,
    pub current_file: String,
    pub speed_mbps: f64,
    pub skipped: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportResult {
    pub imported: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
}

fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SUPPORTED_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn extract_exif_date(path: &Path) -> Option<chrono::NaiveDateTime> {
    let file = fs::File::open(path).ok()?;
    let mut bufreader = std::io::BufReader::new(file);
    let exif = exif::Reader::new()
        .read_from_container(&mut bufreader)
        .ok()?;

    let field = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        .or_else(|| exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY))?;

    if let exif::Value::Ascii(ref vec) = field.value {
        let s = std::str::from_utf8(vec.first()?).ok()?;
        chrono::NaiveDateTime::parse_from_str(s, "%Y:%m:%d %H:%M:%S").ok()
    } else {
        None
    }
}

fn file_mtime_as_datetime(path: &Path) -> chrono::NaiveDateTime {
    let mtime = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .unwrap_or_else(SystemTime::now);
    let secs = mtime
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    chrono::DateTime::from_timestamp(secs, 0)
        .unwrap_or_default()
        .naive_local()
}

fn destination_path(
    staging_dir: &Path,
    dt: &chrono::NaiveDateTime,
    src_path: &Path,
) -> PathBuf {
    let date_subdir = staging_dir
        .join(format!("{}", dt.format("%Y")))
        .join(format!("{}", dt.format("%m")))
        .join(format!("{}", dt.format("%d")));
    let stem = format!("{}", dt.format("%Y%m%d_%H%M%S"));
    let ext = src_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    date_subdir.join(format!("{}.{}", stem, ext))
}


#[tauri::command]
pub async fn start_import(
    app: AppHandle,
    source_dir: String,
    staging_dir: String,
) -> Result<ImportResult, String> {
    let source = PathBuf::from(&source_dir);
    let staging = PathBuf::from(&staging_dir);

    if !source.exists() {
        return Err(format!("Source directory does not exist: {}", source_dir));
    }

    // Single-pass directory walk to collect all supported files
    let all_files: Vec<PathBuf> = WalkDir::new(&source)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| is_supported(p))
        .collect();

    let total = all_files.len();
    if total == 0 {
        return Ok(ImportResult {
            imported: 0,
            skipped: 0,
            errors: vec![],
        });
    }

    // Group by parent directory to improve sequential reads on SD card
    let mut by_dir: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    for f in all_files {
        let dir = f.parent().unwrap_or(Path::new("/")).to_path_buf();
        by_dir.entry(dir).or_default().push(f);
    }

    // Flatten back in directory-grouped order
    let ordered_files: Vec<PathBuf> = by_dir.into_values().flatten().collect();

    let done_count = Arc::new(AtomicU64::new(0));
    let skipped_count = Arc::new(AtomicU64::new(0));
    let bytes_copied = Arc::new(AtomicU64::new(0));
    let start_time = Instant::now();
    let errors = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));

    let staging_clone = staging.clone();
    let app_clone = app.clone();
    let done_clone = done_count.clone();
    let skipped_clone = skipped_count.clone();
    let bytes_clone = bytes_copied.clone();
    let errors_clone = errors.clone();

    // Use rayon for parallel file processing (bounded by CPU count, good for I/O too)
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(12)
        .build()
        .map_err(|e| e.to_string())?;

    pool.install(|| {
        ordered_files.par_iter().for_each(|src_path| {
            let dt = extract_exif_date(src_path)
                .unwrap_or_else(|| file_mtime_as_datetime(src_path));

            let base_dest = destination_path(&staging_clone, &dt, src_path);

            // Create destination directory
            if let Some(parent) = base_dest.parent() {
                if let Err(e) = fs::create_dir_all(parent) {
                    errors_clone
                        .lock()
                        .unwrap()
                        .push(format!("{}: {}", src_path.display(), e));
                    return;
                }
            }

            // Check for same-content duplicate by size comparison
            let src_size = fs::metadata(src_path).map(|m| m.len()).unwrap_or(0);
            let dest = unique_dest(base_dest);

            match fs::copy(src_path, &dest) {
                Ok(bytes) => {
                    bytes_clone.fetch_add(bytes, Ordering::Relaxed);
                    let done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;
                    let skipped = skipped_clone.load(Ordering::Relaxed);
                    let elapsed = start_time.elapsed().as_secs_f64();
                    let speed = if elapsed > 0.0 {
                        (bytes_clone.load(Ordering::Relaxed) as f64 / (1024.0 * 1024.0)) / elapsed
                    } else {
                        0.0
                    };
                    let _ = app_clone.emit(
                        "import-progress",
                        ImportProgress {
                            total,
                            done: done as usize,
                            current_file: src_path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("")
                                .to_string(),
                            speed_mbps: speed,
                            skipped: skipped as usize,
                            errors: vec![],
                        },
                    );
                    let _ = src_size; // suppress unused warning
                }
                Err(e) => {
                    errors_clone
                        .lock()
                        .unwrap()
                        .push(format!("{}: {}", src_path.display(), e));
                }
            }
        });
    });

    let final_errors = errors.lock().unwrap().clone();
    let imported = done_count.load(Ordering::Relaxed) as usize;
    let skipped = skipped_count.load(Ordering::Relaxed) as usize;

    Ok(ImportResult {
        imported,
        skipped,
        errors: final_errors,
    })
}

#[tauri::command]
pub fn list_staging_tree(staging_dir: String) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(&staging_dir);
    if !root.exists() {
        return Ok(serde_json::json!([]));
    }
    let tree = build_tree(&root, &root).map_err(|e| e.to_string())?;
    Ok(tree)
}

fn build_tree(path: &Path, root: &Path) -> anyhow::Result<serde_json::Value> {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();
    let rel = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");

    if path.is_dir() {
        let mut children: Vec<serde_json::Value> = vec![];
        let mut entries: Vec<PathBuf> = fs::read_dir(path)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .collect();
        entries.sort();
        for entry in entries {
            children.push(build_tree(&entry, root)?);
        }
        Ok(serde_json::json!({
            "name": name,
            "path": rel,
            "type": "dir",
            "children": children,
        }))
    } else {
        let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        Ok(serde_json::json!({
            "name": name,
            "path": rel,
            "type": "file",
            "size": size,
        }))
    }
}

