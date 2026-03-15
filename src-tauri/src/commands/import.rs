use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;
use crate::utils::compute_md5;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, SetFileTime, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, FILE_WRITE_ATTRIBUTES, OPEN_EXISTING,
};

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

fn file_created_or_mtime_as_datetime(path: &Path) -> chrono::NaiveDateTime {
    let ts = fs::metadata(path)
        .ok()
        .and_then(|m| m.created().ok().or_else(|| m.modified().ok()))
        .unwrap_or_else(SystemTime::now);

    let secs = ts
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    chrono::DateTime::from_timestamp(secs, 0)
        .unwrap_or_default()
        .naive_local()
}

fn capture_datetime(path: &Path) -> chrono::NaiveDateTime {
    extract_exif_date(path).unwrap_or_else(|| file_created_or_mtime_as_datetime(path))
}

fn naive_datetime_to_system_time(dt: &chrono::NaiveDateTime) -> SystemTime {
    use chrono::{Local, TimeZone, Utc};

    let local_dt = Local
        .from_local_datetime(dt)
        .single()
        .or_else(|| Local.from_local_datetime(dt).earliest())
        .or_else(|| Local.from_local_datetime(dt).latest())
        .unwrap_or_else(Local::now);

    let utc_dt = local_dt.with_timezone(&Utc);
    let secs = utc_dt.timestamp();
    let nanos = utc_dt.timestamp_subsec_nanos();

    if secs >= 0 {
        UNIX_EPOCH + Duration::from_secs(secs as u64) + Duration::from_nanos(nanos as u64)
    } else {
        let abs_secs = (-secs) as u64;
        let base = UNIX_EPOCH - Duration::from_secs(abs_secs);
        if nanos > 0 {
            base - Duration::from_nanos(nanos as u64)
        } else {
            base
        }
    }
}

#[cfg(target_os = "windows")]
fn set_file_times(path: &Path, dt: &chrono::NaiveDateTime) -> Result<(), String> {
    let system_time = naive_datetime_to_system_time(dt);
    let duration = system_time
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?;

    let windows_epoch_offset_secs = 11_644_473_600u64;
    let intervals_100ns = (duration.as_secs() + windows_epoch_offset_secs) * 10_000_000
        + (duration.subsec_nanos() as u64 / 100);

    let file_time = FILETIME {
        dwLowDateTime: intervals_100ns as u32,
        dwHighDateTime: (intervals_100ns >> 32) as u32,
    };

    let mut wide_path: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide_path.push(0);

    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            FILE_WRITE_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().to_string());
    }

    let ok = unsafe { SetFileTime(handle, &file_time, &file_time, &file_time) };
    let close_result = unsafe { CloseHandle(handle) };

    if close_result == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }

    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }

    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn set_file_times(_path: &Path, _dt: &chrono::NaiveDateTime) -> Result<(), String> {
    Ok(())
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

fn with_collision_suffix(base: &Path, suffix: u32) -> PathBuf {
    let stem = base
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let ext = base
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let dir = base.parent().unwrap_or(Path::new("."));

    if ext.is_empty() {
        dir.join(format!("{}_{}", stem, suffix))
    } else {
        dir.join(format!("{}_{}.{}", stem, suffix, ext))
    }
}

fn reserve_unique_destination(base: PathBuf, reserved: &Arc<Mutex<HashSet<PathBuf>>>) -> PathBuf {
    let mut suffix = 0u32;

    loop {
        let candidate = if suffix == 0 {
            base.clone()
        } else {
            with_collision_suffix(&base, suffix)
        };

        let mut guard = reserved.lock().unwrap();
        let already_reserved = guard.contains(&candidate);
        let already_exists = candidate.exists();

        if !already_reserved && !already_exists {
            guard.insert(candidate.clone());
            return candidate;
        }

        drop(guard);
        suffix += 1;
    }
}

fn destination_has_same_content(
    date_dir: &Path,
    src_size: u64,
    src_md5: &str,
) -> Result<bool, String> {
    if !date_dir.exists() {
        return Ok(false);
    }

    let entries = fs::read_dir(date_dir).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };

        let candidate = entry.path();
        if !candidate.is_file() {
            continue;
        }

        let candidate_size = match fs::metadata(&candidate).map(|m| m.len()) {
            Ok(size) => size,
            Err(_) => continue,
        };

        if candidate_size != src_size {
            continue;
        }

        let candidate_md5 = match compute_md5(&candidate) {
            Ok(hash) => hash,
            Err(_) => continue,
        };

        if candidate_md5 == src_md5 {
            return Ok(true);
        }
    }

    Ok(false)
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
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let reserved_destinations = Arc::new(Mutex::new(HashSet::<PathBuf>::new()));
    let claimed_content_hashes = Arc::new(Mutex::new(HashSet::<String>::new()));

    let staging_clone = staging.clone();
    let app_clone = app.clone();
    let done_clone = done_count.clone();
    let skipped_clone = skipped_count.clone();
    let bytes_clone = bytes_copied.clone();
    let errors_clone = errors.clone();
    let reserved_clone = reserved_destinations.clone();
    let claimed_hashes_clone = claimed_content_hashes.clone();

    // Use rayon for parallel file processing (bounded by CPU count, good for I/O too)
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(12)
        .build()
        .map_err(|e| e.to_string())?;

    pool.install(|| {
        ordered_files.par_iter().for_each(|src_path| {
            let dt = capture_datetime(src_path);

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

            let src_size = match fs::metadata(src_path).map(|m| m.len()) {
                Ok(size) => size,
                Err(e) => {
                    errors_clone
                        .lock()
                        .unwrap()
                        .push(format!("{}: {}", src_path.display(), e));
                    return;
                }
            };

            let src_md5 = match compute_md5(src_path) {
                Ok(hash) => hash,
                Err(e) => {
                    errors_clone
                        .lock()
                        .unwrap()
                        .push(format!("{}: failed to hash file: {}", src_path.display(), e));
                    return;
                }
            };

            {
                let mut claimed = claimed_hashes_clone.lock().unwrap();
                if claimed.contains(&src_md5) {
                    skipped_clone.fetch_add(1, Ordering::Relaxed);
                    return;
                }
                claimed.insert(src_md5.clone());
            }

            let date_dir = match base_dest.parent() {
                Some(parent) => parent,
                None => {
                    let mut claimed = claimed_hashes_clone.lock().unwrap();
                    claimed.remove(&src_md5);
                    errors_clone
                        .lock()
                        .unwrap()
                        .push(format!("{}: invalid destination path", src_path.display()));
                    return;
                }
            };

            match destination_has_same_content(date_dir, src_size, &src_md5) {
                Ok(true) => {
                    skipped_clone.fetch_add(1, Ordering::Relaxed);
                    return;
                }
                Ok(false) => {}
                Err(e) => {
                    let mut claimed = claimed_hashes_clone.lock().unwrap();
                    claimed.remove(&src_md5);
                    errors_clone
                        .lock()
                        .unwrap()
                        .push(format!("{}: failed duplicate check: {}", src_path.display(), e));
                    return;
                }
            }

            let dest = reserve_unique_destination(base_dest, &reserved_clone);

            match fs::copy(src_path, &dest) {
                Ok(bytes) => {
                    if let Err(e) = set_file_times(&dest, &dt) {
                        errors_clone
                            .lock()
                            .unwrap()
                            .push(format!("{}: failed to set file timestamps: {}", dest.display(), e));
                    }

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
                }
                Err(e) => {
                    let mut claimed = claimed_hashes_clone.lock().unwrap();
                    claimed.remove(&src_md5);
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

