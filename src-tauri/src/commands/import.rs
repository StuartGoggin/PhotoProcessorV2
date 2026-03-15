use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::async_runtime;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;
use crate::utils::{append_app_log, compute_md5, num_cpus};
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW, SetFileTime,
    FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_WRITE_ATTRIBUTES, OPEN_EXISTING,
};

#[cfg(target_os = "windows")]
const DRIVE_TYPE_REMOVABLE: u32 = 2;

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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    pub reprocess_existing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceShortcut {
    pub path: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImportJobStatus {
    Queued,
    Running,
    Paused,
    Aborted,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportJob {
    pub id: String,
    pub source_dir: String,
    pub staging_dir: String,
    pub reprocess_existing: bool,
    pub status: ImportJobStatus,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub total: usize,
    pub done: usize,
    pub skipped: usize,
    pub speed_mbps: f64,
    pub current_file: String,
    pub imported: usize,
    pub md5_sidecar_hits: usize,
    pub md5_computed: usize,
    pub errors: Vec<String>,
    pub logs: Vec<String>,
    pub pause_requested: bool,
    pub abort_requested: bool,
}

fn jobs_store() -> &'static Mutex<HashMap<String, ImportJob>> {
    static STORE: OnceLock<Mutex<HashMap<String, ImportJob>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_job_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("import-job-{}", id)
}

fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

#[cfg(target_os = "windows")]
fn list_windows_removable_drives() -> Vec<SourceShortcut> {
    let mut out = Vec::new();
    let mask = unsafe { GetLogicalDrives() };

    for letter_idx in 0..26u32 {
        let bit = 1u32 << letter_idx;
        if (mask & bit) == 0 {
            continue;
        }

        let letter = (b'A' + letter_idx as u8) as char;
        let root = format!("{}:\\", letter);
        let mut root_wide: Vec<u16> = root.encode_utf16().collect();
        root_wide.push(0);

        let drive_type = unsafe { GetDriveTypeW(root_wide.as_ptr()) };
        if drive_type != DRIVE_TYPE_REMOVABLE {
            continue;
        }

        let mut volume_buf = [0u16; 261];
        let ok = unsafe {
            GetVolumeInformationW(
                root_wide.as_ptr(),
                volume_buf.as_mut_ptr(),
                volume_buf.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
            )
        };

        let volume = if ok != 0 {
            let len = volume_buf
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(volume_buf.len());
            String::from_utf16_lossy(&volume_buf[..len]).trim().to_string()
        } else {
            String::new()
        };

        let drive_id = &root[..2];
        let label = if volume.is_empty() {
            format!("SD Card {}", drive_id)
        } else {
            format!("{} ({})", volume, drive_id)
        };

        out.push(SourceShortcut {
            path: root,
            label,
        });
    }

    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

#[cfg(not(target_os = "windows"))]
fn list_windows_removable_drives() -> Vec<SourceShortcut> {
    Vec::new()
}

#[tauri::command]
pub fn list_sd_cards() -> Result<Vec<SourceShortcut>, String> {
    Ok(list_windows_removable_drives())
}

fn update_job(job_id: &str, mutator: impl FnOnce(&mut ImportJob)) {
    if let Ok(mut jobs) = jobs_store().lock() {
        if let Some(job) = jobs.get_mut(job_id) {
            mutator(job);
        }
    }
}

fn append_job_log(job_id: &str, message: impl AsRef<str>) {
    let ts = now_string();
    update_job(job_id, |job| {
        job.logs.push(format!("[{}] {}", ts, message.as_ref()));
        if job.logs.len() > 2000 {
            let to_drop = job.logs.len() - 2000;
            job.logs.drain(0..to_drop);
        }
    });
}

fn wait_if_paused_or_aborted(job_id: Option<&str>) -> bool {
    let Some(job_id) = job_id else { return false; };

    loop {
        let (pause_requested, abort_requested) = match jobs_store().lock() {
            Ok(jobs) => match jobs.get(job_id) {
                Some(job) => (job.pause_requested, job.abort_requested),
                None => return true,
            },
            Err(_) => return true,
        };

        if abort_requested {
            return true;
        }

        if pause_requested {
            update_job(job_id, |job| {
                if !matches!(job.status, ImportJobStatus::Paused) {
                    job.status = ImportJobStatus::Paused;
                    job.current_file = "Paused".to_string();
                }
            });
            thread::sleep(Duration::from_millis(200));
            continue;
        }

        update_job(job_id, |job| {
            if matches!(job.status, ImportJobStatus::Paused) {
                job.status = ImportJobStatus::Running;
            }
        });
        return false;
    }
}

#[tauri::command]
pub fn list_import_jobs() -> Result<Vec<ImportJob>, String> {
    let jobs = jobs_store().lock().map_err(|e| e.to_string())?;
    let mut out: Vec<ImportJob> = jobs.values().cloned().collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[tauri::command]
pub fn clear_finished_import_jobs() -> Result<usize, String> {
    let mut jobs = jobs_store().lock().map_err(|e| e.to_string())?;
    let before = jobs.len();
    jobs.retain(|_, job| !matches!(job.status, ImportJobStatus::Completed | ImportJobStatus::Failed | ImportJobStatus::Aborted));
    Ok(before.saturating_sub(jobs.len()))
}

#[tauri::command]
pub fn pause_import_job(job_id: String) -> Result<bool, String> {
    let mut jobs = jobs_store().lock().map_err(|e| e.to_string())?;
    let Some(job) = jobs.get_mut(&job_id) else { return Ok(false); };
    if matches!(job.status, ImportJobStatus::Completed | ImportJobStatus::Failed | ImportJobStatus::Aborted) {
        return Ok(false);
    }
    job.pause_requested = true;
    job.status = ImportJobStatus::Paused;
    job.current_file = "Paused".to_string();
    job.logs.push(format!("[{}] pause requested", now_string()));
    Ok(true)
}

#[tauri::command]
pub fn resume_import_job(job_id: String) -> Result<bool, String> {
    let mut jobs = jobs_store().lock().map_err(|e| e.to_string())?;
    let Some(job) = jobs.get_mut(&job_id) else { return Ok(false); };
    if matches!(job.status, ImportJobStatus::Completed | ImportJobStatus::Failed | ImportJobStatus::Aborted) {
        return Ok(false);
    }
    job.pause_requested = false;
    job.status = ImportJobStatus::Running;
    job.logs.push(format!("[{}] resume requested", now_string()));
    Ok(true)
}

#[tauri::command]
pub fn abort_import_job(job_id: String) -> Result<bool, String> {
    let mut jobs = jobs_store().lock().map_err(|e| e.to_string())?;
    let Some(job) = jobs.get_mut(&job_id) else { return Ok(false); };
    if matches!(job.status, ImportJobStatus::Completed | ImportJobStatus::Failed | ImportJobStatus::Aborted) {
        return Ok(false);
    }
    job.abort_requested = true;
    job.pause_requested = false;
    job.current_file = "Abort requested".to_string();
    job.logs.push(format!("[{}] abort requested", now_string()));
    Ok(true)
}

fn is_supported(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SUPPORTED_EXTENSIONS.contains(&e.to_lowercase().as_str()))
        .unwrap_or(false)
}

fn extract_exif_date(path: &Path) -> Option<chrono::NaiveDateTime> {
    use chrono::Timelike;

    let file = fs::File::open(path).ok()?;
    let mut bufreader = std::io::BufReader::new(file);
    let exif = exif::Reader::new()
        .read_from_container(&mut bufreader)
        .ok()?;

    let field = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        .or_else(|| exif.get_field(exif::Tag::DateTime, exif::In::PRIMARY))?;

    if let exif::Value::Ascii(ref vec) = field.value {
        let s = std::str::from_utf8(vec.first()?).ok()?;
        let mut dt = chrono::NaiveDateTime::parse_from_str(s, "%Y:%m:%d %H:%M:%S").ok()?;

        let subsec_field = exif
            .get_field(exif::Tag::SubSecTimeOriginal, exif::In::PRIMARY)
            .or_else(|| exif.get_field(exif::Tag::SubSecTime, exif::In::PRIMARY));

        if let Some(subsec_field) = subsec_field {
            if let exif::Value::Ascii(ref subsec_vec) = subsec_field.value {
                if let Some(raw) = subsec_vec.first() {
                    if let Ok(raw_str) = std::str::from_utf8(raw) {
                        let digits: String = raw_str.chars().filter(|c| c.is_ascii_digit()).collect();
                        if !digits.is_empty() {
                            let mut nanos_str = digits;
                            while nanos_str.len() < 9 {
                                nanos_str.push('0');
                            }
                            if let Ok(nanos) = nanos_str[..9].parse::<u32>() {
                                if let Some(with_nanos) = dt.with_nanosecond(nanos) {
                                    dt = with_nanos;
                                }
                            }
                        }
                    }
                }
            }
        }

        Some(dt)
    } else {
        None
    }
}

fn file_created_or_mtime_as_datetime(path: &Path) -> chrono::NaiveDateTime {
    let ts = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok().or_else(|| m.created().ok()))
        .unwrap_or_else(SystemTime::now);

    let local_dt: chrono::DateTime<chrono::Local> = ts.into();
    local_dt.naive_local()
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
    use chrono::Timelike;

    let date_subdir = staging_dir
        .join(format!("{}", dt.format("%Y")))
        .join(format!("{}", dt.format("%m")))
        .join(format!("{}", dt.format("%d")));
    let stem = if dt.nanosecond() > 0 {
        format!("{}_{:03}", dt.format("%Y%m%d_%H%M%S"), dt.nanosecond() / 1_000_000)
    } else {
        format!("{}", dt.format("%Y%m%d_%H%M%S"))
    };
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

fn md5_sidecar_path(file_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.md5", file_path.to_string_lossy()))
}

fn is_valid_md5_hex(value: &str) -> bool {
    value.len() == 32 && value.chars().all(|c| c.is_ascii_hexdigit())
}

fn read_md5_hash_from_sidecar(sidecar_path: &Path, expected_filename: Option<&str>) -> Option<String> {
    let content = fs::read_to_string(sidecar_path).ok()?;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let mut parts = trimmed.split_whitespace();
        let hash = parts.next()?;
        if !is_valid_md5_hex(hash) {
            continue;
        }

        if let Some(expected) = expected_filename {
            if let Some(named) = parts.next() {
                let named_file = Path::new(named)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(named);
                if !named_file.eq_ignore_ascii_case(expected) {
                    continue;
                }
            }
        }

        return Some(hash.to_lowercase());
    }

    None
}

fn read_md5_sidecar_for_file(file_path: &Path) -> Option<String> {
    let expected_filename = file_path.file_name().and_then(|n| n.to_str());
    read_md5_hash_from_sidecar(&md5_sidecar_path(file_path), expected_filename)
}

fn md5_for_file_prefer_sidecar(file_path: &Path) -> Result<(String, bool), String> {
    if let Some(hash) = read_md5_sidecar_for_file(file_path) {
        return Ok((hash, true));
    }

    compute_md5(file_path)
        .map(|hash| (hash, false))
        .map_err(|e| e.to_string())
}

fn write_md5_sidecar(file_path: &Path, md5: &str) -> Result<(), String> {
    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid filename for md5 sidecar".to_string())?;
    let sidecar = md5_sidecar_path(file_path);
    fs::write(sidecar, format!("{}  {}\n", md5, filename)).map_err(|e| e.to_string())
}

fn load_existing_staging_md5_hashes(
    staging_dir: &Path,
) -> HashSet<String> {
    let mut hashes = HashSet::new();

    if !staging_dir.exists() {
        return hashes;
    }

    for entry in WalkDir::new(staging_dir).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let is_md5 = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("md5"))
            .unwrap_or(false);
        if !is_md5 {
            continue;
        }

        let media_path = path.with_extension("");
        if !media_path.exists() {
            continue;
        }

        let expected_filename = media_path.file_name().and_then(|n| n.to_str());
        if let Some(hash) = read_md5_hash_from_sidecar(path, expected_filename) {
            hashes.insert(hash);
        }
    }

    hashes
}

fn build_staging_size_index(staging_dir: &Path) -> HashMap<u64, Vec<PathBuf>> {
    let mut index = HashMap::<u64, Vec<PathBuf>>::new();

    if !staging_dir.exists() {
        return index;
    }

    for entry in WalkDir::new(staging_dir).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path().to_path_buf();
        if !is_supported(&path) {
            continue;
        }

        let size = match fs::metadata(&path).map(|m| m.len()) {
            Ok(v) => v,
            Err(_) => continue,
        };
        index.entry(size).or_default().push(path);
    }

    index
}

fn staging_has_same_content(
    staging_hashes: &HashSet<String>,
    staging_size_index: &HashMap<u64, Vec<PathBuf>>,
    src_size: u64,
    src_md5: &str,
    ignore_path: Option<&Path>,
) -> Result<bool, String> {
    if staging_hashes.contains(src_md5) {
        return Ok(true);
    }

    if let Some(candidates) = staging_size_index.get(&src_size) {
        for candidate in candidates {
            if let Some(ignore) = ignore_path {
                if candidate == ignore {
                    continue;
                }
            }

            let candidate_md5 = match md5_for_file_prefer_sidecar(candidate) {
                Ok((hash, _)) => hash,
                Err(_) => continue,
            };

            if candidate_md5 == src_md5 {
                return Ok(true);
            }
        }
    }

    Ok(false)
}


fn run_import(
    app: AppHandle,
    source_dir: String,
    staging_dir: String,
    opts: ImportOptions,
    job_id: Option<String>,
) -> Result<ImportResult, String> {
    let staging = PathBuf::from(&staging_dir);
    let source = if opts.reprocess_existing {
        staging.clone()
    } else {
        PathBuf::from(&source_dir)
    };

    if !source.exists() {
        return Err(format!("Source directory does not exist: {}", source_dir));
    }

    let mode = if opts.reprocess_existing { "reprocess" } else { "import" };
    let _ = append_app_log(
        &app,
        format!(
            "start_{} source='{}' staging='{}'",
            mode,
            source.display(),
            staging.display()
        ),
    );

    if let Some(job_id) = &job_id {
        update_job(job_id, |job| {
            job.status = ImportJobStatus::Running;
            job.started_at = Some(now_string());
            job.current_file = "Starting".to_string();
        });
        append_job_log(job_id, format!(
            "start {} source='{}' staging='{}'",
            mode,
            source.display(),
            staging.display()
        ));
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
    if let Some(job_id) = &job_id {
        update_job(job_id, |job| {
            job.total = total;
        });
    }
    if total == 0 {
        let _ = append_app_log(&app, format!("{}: no supported files found", mode));

        if let Some(job_id) = &job_id {
            update_job(job_id, |job| {
                job.status = ImportJobStatus::Completed;
                job.finished_at = Some(now_string());
                job.total = 0;
                job.done = 0;
                job.skipped = 0;
                job.imported = 0;
                job.errors.clear();
            });
            append_job_log(job_id, "no supported files found");
        }

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

    let staging_existing_hashes = Arc::new(load_existing_staging_md5_hashes(&staging));
    let staging_size_index = Arc::new(build_staging_size_index(&staging));

    let _ = append_app_log(
        &app,
        format!(
            "{} dedupe_index md5_hashes={} size_buckets={}",
            mode,
            staging_existing_hashes.len(),
            staging_size_index.len()
        ),
    );

    let done_count = Arc::new(AtomicU64::new(0));
    let imported_count = Arc::new(AtomicU64::new(0));
    let skipped_count = Arc::new(AtomicU64::new(0));
    let md5_sidecar_hits = Arc::new(AtomicU64::new(0));
    let md5_computed = Arc::new(AtomicU64::new(0));
    let bytes_copied = Arc::new(AtomicU64::new(0));
    let start_time = Instant::now();
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));
    let reserved_destinations = Arc::new(Mutex::new(HashSet::<PathBuf>::new()));
    let claimed_content_hashes = Arc::new(Mutex::new(HashSet::<String>::new()));

    let staging_clone = staging.clone();
    let app_clone = app.clone();
    let done_clone = done_count.clone();
    let imported_clone = imported_count.clone();
    let skipped_clone = skipped_count.clone();
    let md5_sidecar_clone = md5_sidecar_hits.clone();
    let md5_computed_clone = md5_computed.clone();
    let bytes_clone = bytes_copied.clone();
    let errors_clone = errors.clone();
    let reserved_clone = reserved_destinations.clone();
    let claimed_hashes_clone = claimed_content_hashes.clone();
    let existing_hashes_clone = staging_existing_hashes.clone();
    let size_index_clone = staging_size_index.clone();
    let job_id_clone = job_id.clone();

    // Use rayon for parallel file processing (bounded by CPU count, good for I/O too)
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads((num_cpus() * 2).max(4))
        .build()
        .map_err(|e| e.to_string())?;

    pool.install(|| {
        ordered_files.par_iter().for_each(|src_path| {
            if wait_if_paused_or_aborted(job_id_clone.as_deref()) {
                return;
            }

            let dt = capture_datetime(src_path);

            let base_dest = destination_path(&staging_clone, &dt, src_path);

            // Create destination directory
            if let Some(parent) = base_dest.parent() {
                if let Err(e) = fs::create_dir_all(parent) {
                    errors_clone
                        .lock()
                        .unwrap()
                        .push(format!("{}: {}", src_path.display(), e));
                    done_clone.fetch_add(1, Ordering::Relaxed);
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
                    done_clone.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            };

            let (src_md5, used_sidecar) = match md5_for_file_prefer_sidecar(src_path) {
                Ok(v) => v,
                Err(e) => {
                    errors_clone
                        .lock()
                        .unwrap()
                        .push(format!("{}: failed to hash file: {}", src_path.display(), e));
                    done_clone.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            };

            if used_sidecar {
                md5_sidecar_clone.fetch_add(1, Ordering::Relaxed);
                let _ = append_app_log(
                    &app_clone,
                    format!("{} sidecar_md5 source='{}'", mode, src_path.display()),
                );
            } else {
                md5_computed_clone.fetch_add(1, Ordering::Relaxed);
            }

            if let Some(job_id) = &job_id_clone {
                update_job(job_id, |job| {
                    job.md5_sidecar_hits = md5_sidecar_clone.load(Ordering::Relaxed) as usize;
                    job.md5_computed = md5_computed_clone.load(Ordering::Relaxed) as usize;
                });
            }

            {
                let mut claimed = claimed_hashes_clone.lock().unwrap();
                if claimed.contains(&src_md5) {
                    bytes_clone.fetch_add(src_size, Ordering::Relaxed);
                    skipped_clone.fetch_add(1, Ordering::Relaxed);
                    let done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;
                    if let Some(job_id) = &job_id_clone {
                        let skipped = skipped_clone.load(Ordering::Relaxed);
                        let elapsed = start_time.elapsed().as_secs_f64();
                        let speed = if elapsed > 0.0 {
                            (bytes_clone.load(Ordering::Relaxed) as f64 / (1024.0 * 1024.0)) / elapsed
                        } else {
                            0.0
                        };
                        update_job(job_id, |job| {
                            job.done = done as usize;
                            job.skipped = skipped as usize;
                            job.speed_mbps = speed;
                            job.current_file = src_path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("")
                                .to_string();
                        });
                    }
                    return;
                }
                claimed.insert(src_md5.clone());
            }

            if base_dest.parent().is_none() {
                    let mut claimed = claimed_hashes_clone.lock().unwrap();
                    claimed.remove(&src_md5);
                    errors_clone
                        .lock()
                        .unwrap()
                        .push(format!("{}: invalid destination path", src_path.display()));
                    done_clone.fetch_add(1, Ordering::Relaxed);
                    return;
            }

            match staging_has_same_content(&existing_hashes_clone, &size_index_clone, src_size, &src_md5, Some(src_path)) {
                Ok(true) => {
                    bytes_clone.fetch_add(src_size, Ordering::Relaxed);
                    skipped_clone.fetch_add(1, Ordering::Relaxed);
                    let done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;
                    let skipped = skipped_clone.load(Ordering::Relaxed);
                    let elapsed = start_time.elapsed().as_secs_f64();
                    let speed = if elapsed > 0.0 {
                        (bytes_clone.load(Ordering::Relaxed) as f64 / (1024.0 * 1024.0)) / elapsed
                    } else {
                        0.0
                    };
                    let _ = append_app_log(
                        &app_clone,
                        format!(
                            "{} duplicate_skip source='{}' md5={} size={}",
                            mode,
                            src_path.display(),
                            src_md5,
                            src_size
                        ),
                    );
                    if let Err(e) = write_md5_sidecar(src_path, &src_md5) {
                        errors_clone
                            .lock()
                            .unwrap()
                            .push(format!("{}: failed to write md5 sidecar: {}", src_path.display(), e));
                    }
                    if let Some(job_id) = &job_id_clone {
                        append_job_log(job_id, format!(
                            "duplicate skip '{}' (md5={})",
                            src_path.display(),
                            src_md5
                        ));
                        update_job(job_id, |job| {
                            job.done = done as usize;
                            job.skipped = skipped as usize;
                            job.speed_mbps = speed;
                            job.current_file = src_path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("")
                                .to_string();
                        });
                    }
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
                    done_clone.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            }

            let dest = if opts.reprocess_existing && *src_path == base_dest {
                base_dest
            } else {
                reserve_unique_destination(base_dest, &reserved_clone)
            };

            if opts.reprocess_existing && *src_path == dest {
                if let Err(e) = set_file_times(src_path, &dt) {
                    errors_clone
                        .lock()
                        .unwrap()
                        .push(format!("{}: failed to set file timestamps: {}", src_path.display(), e));
                }
                if let Err(e) = write_md5_sidecar(src_path, &src_md5) {
                    errors_clone
                        .lock()
                        .unwrap()
                        .push(format!("{}: failed to write md5 sidecar: {}", src_path.display(), e));
                }

                let _ = append_app_log(
                    &app_clone,
                    format!(
                        "reprocess touch_only file='{}' md5={} target_name='{}'",
                        src_path.display(),
                        src_md5,
                        dest.file_name().and_then(|n| n.to_str()).unwrap_or("")
                    ),
                );
                if let Some(job_id) = &job_id_clone {
                    append_job_log(job_id, format!(
                        "touch '{}' (already correct name)",
                        src_path.display()
                    ));
                }

                bytes_clone.fetch_add(src_size, Ordering::Relaxed);
                imported_clone.fetch_add(1, Ordering::Relaxed);
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
                if let Some(job_id) = &job_id_clone {
                    update_job(job_id, |job| {
                        job.done = done as usize;
                        job.skipped = skipped as usize;
                        job.speed_mbps = speed;
                        job.current_file = src_path
                            .file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("")
                            .to_string();
                    });
                }
                return;
            }

            if opts.reprocess_existing {
                match fs::rename(src_path, &dest) {
                    Ok(_) => {
                        if let Err(e) = set_file_times(&dest, &dt) {
                            errors_clone
                                .lock()
                                .unwrap()
                                .push(format!("{}: failed to set file timestamps: {}", dest.display(), e));
                        }
                        if let Err(e) = write_md5_sidecar(&dest, &src_md5) {
                            errors_clone
                                .lock()
                                .unwrap()
                                .push(format!("{}: failed to write md5 sidecar: {}", dest.display(), e));
                        }

                        let src_sidecar = md5_sidecar_path(src_path);
                        let dest_sidecar = md5_sidecar_path(&dest);
                        if src_sidecar.exists() && src_sidecar != dest_sidecar {
                            let _ = fs::rename(src_sidecar, dest_sidecar);
                        }

                        let _ = append_app_log(
                            &app_clone,
                            format!(
                                "reprocess renamed from='{}' to='{}' md5={}",
                                src_path.display(),
                                dest.display(),
                                src_md5
                            ),
                        );
                        if let Some(job_id) = &job_id_clone {
                            append_job_log(job_id, format!(
                                "rename '{}' -> '{}'",
                                src_path.display(),
                                dest.display()
                            ));
                        }

                        bytes_clone.fetch_add(src_size, Ordering::Relaxed);
                        imported_clone.fetch_add(1, Ordering::Relaxed);
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

                        if let Some(job_id) = &job_id_clone {
                            update_job(job_id, |job| {
                                job.done = done as usize;
                                job.skipped = skipped as usize;
                                job.speed_mbps = speed;
                                job.current_file = src_path
                                    .file_name()
                                    .and_then(|n| n.to_str())
                                    .unwrap_or("")
                                    .to_string();
                            });
                        }
                    }
                    Err(e) => {
                        let mut claimed = claimed_hashes_clone.lock().unwrap();
                        claimed.remove(&src_md5);
                        done_clone.fetch_add(1, Ordering::Relaxed);
                        errors_clone
                            .lock()
                            .unwrap()
                            .push(format!("{}: {}", src_path.display(), e));
                    }
                }
                return;
            }

            match fs::copy(src_path, &dest) {
                Ok(bytes) => {
                    if let Err(e) = set_file_times(&dest, &dt) {
                        errors_clone
                            .lock()
                            .unwrap()
                            .push(format!("{}: failed to set file timestamps: {}", dest.display(), e));
                    }

                    if let Err(e) = write_md5_sidecar(&dest, &src_md5) {
                        errors_clone
                            .lock()
                            .unwrap()
                            .push(format!("{}: failed to write md5 sidecar: {}", dest.display(), e));
                    }

                    let _ = append_app_log(
                        &app_clone,
                        format!(
                            "import copied from='{}' to='{}' bytes={} md5={}",
                            src_path.display(),
                            dest.display(),
                            bytes,
                            src_md5
                        ),
                    );
                    if let Some(job_id) = &job_id_clone {
                        append_job_log(job_id, format!(
                            "copy '{}' -> '{}' ({} bytes)",
                            src_path.display(),
                            dest.display(),
                            bytes
                        ));
                    }

                    bytes_clone.fetch_add(bytes, Ordering::Relaxed);
                    imported_clone.fetch_add(1, Ordering::Relaxed);
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

                    if let Some(job_id) = &job_id_clone {
                        let done_now = done_clone.load(Ordering::Relaxed) as usize;
                        let skipped_now = skipped_clone.load(Ordering::Relaxed) as usize;
                        let elapsed = start_time.elapsed().as_secs_f64();
                        let speed_now = if elapsed > 0.0 {
                            (bytes_clone.load(Ordering::Relaxed) as f64 / (1024.0 * 1024.0)) / elapsed
                        } else {
                            0.0
                        };
                        update_job(job_id, |job| {
                            job.done = done_now;
                            job.skipped = skipped_now;
                            job.speed_mbps = speed_now;
                            job.current_file = src_path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("")
                                .to_string();
                        });
                    }
                }
                Err(e) => {
                    let mut claimed = claimed_hashes_clone.lock().unwrap();
                    claimed.remove(&src_md5);
                    let done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;
                    let _ = append_app_log(
                        &app_clone,
                        format!(
                            "{} error source='{}' message='{}'",
                            mode,
                            src_path.display(),
                            e
                        ),
                    );
                    if let Some(job_id) = &job_id_clone {
                        append_job_log(job_id, format!(
                            "error '{}' => {}",
                            src_path.display(),
                            e
                        ));
                    }

                    if let Some(job_id) = &job_id_clone {
                        let done_now = done as usize;
                        let skipped_now = skipped_clone.load(Ordering::Relaxed) as usize;
                        let elapsed = start_time.elapsed().as_secs_f64();
                        let speed_now = if elapsed > 0.0 {
                            (bytes_clone.load(Ordering::Relaxed) as f64 / (1024.0 * 1024.0)) / elapsed
                        } else {
                            0.0
                        };
                        update_job(job_id, |job| {
                            job.done = done_now;
                            job.skipped = skipped_now;
                            job.speed_mbps = speed_now;
                            job.current_file = src_path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("")
                                .to_string();
                        });
                    }
                    errors_clone
                        .lock()
                        .unwrap()
                        .push(format!("{}: {}", src_path.display(), e));

                    if let Some(job_id) = &job_id_clone {
                        update_job(job_id, |job| {
                            job.current_file = src_path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("")
                                .to_string();
                        });
                    }
                }
            }
        });
    });

    let final_errors = errors.lock().unwrap().clone();
    let imported = imported_count.load(Ordering::Relaxed) as usize;
    let processed = done_count.load(Ordering::Relaxed) as usize;
    let skipped = skipped_count.load(Ordering::Relaxed) as usize;
    let md5_sidecar_total = md5_sidecar_hits.load(Ordering::Relaxed) as usize;
    let md5_computed_total = md5_computed.load(Ordering::Relaxed) as usize;
    let was_aborted = job_id
        .as_ref()
        .and_then(|id| jobs_store().lock().ok().and_then(|jobs| jobs.get(id).map(|j| j.abort_requested)))
        .unwrap_or(false);

    let mode = if opts.reprocess_existing { "reprocess" } else { "import" };
    let _ = append_app_log(
        &app,
        format!(
            "{} complete imported={} skipped={} errors={}",
            mode,
            imported,
            skipped,
            final_errors.len()
        ),
    );

    if let Some(job_id) = &job_id {
        let failed = !final_errors.is_empty();
        update_job(job_id, |job| {
            job.status = if was_aborted {
                ImportJobStatus::Aborted
            } else if failed {
                ImportJobStatus::Failed
            } else {
                ImportJobStatus::Completed
            };
            job.finished_at = Some(now_string());
            job.imported = imported;
            job.skipped = skipped;
            job.done = processed;
            job.md5_sidecar_hits = md5_sidecar_total;
            job.md5_computed = md5_computed_total;
            job.errors = final_errors.clone();
            job.current_file = "Done".to_string();
        });

        if was_aborted {
            append_job_log(job_id, format!(
                "aborted imported={} skipped={} errors={} md5_sidecar_hits={} md5_computed={}",
                imported,
                skipped,
                final_errors.len(),
                md5_sidecar_total,
                md5_computed_total
            ));
        } else {
            append_job_log(job_id, format!(
                "complete imported={} skipped={} errors={} md5_sidecar_hits={} md5_computed={}",
                imported,
                skipped,
                final_errors.len(),
                md5_sidecar_total,
                md5_computed_total
            ));
        }
    }

    Ok(ImportResult {
        imported,
        skipped,
        errors: final_errors,
    })
}

#[tauri::command]
pub async fn start_import(
    app: AppHandle,
    source_dir: String,
    staging_dir: String,
    options: Option<ImportOptions>,
) -> Result<ImportResult, String> {
    let opts = options.unwrap_or_default();

    async_runtime::spawn_blocking(move || run_import(app, source_dir, staging_dir, opts, None))
        .await
        .map_err(|e| format!("Import background task failed: {}", e))?
}

#[tauri::command]
pub fn start_import_job(
    app: AppHandle,
    source_dir: String,
    staging_dir: String,
    options: Option<ImportOptions>,
) -> Result<String, String> {
    let opts = options.unwrap_or_default();
    let job_id = next_job_id();

    let job = ImportJob {
        id: job_id.clone(),
        source_dir: source_dir.clone(),
        staging_dir: staging_dir.clone(),
        reprocess_existing: opts.reprocess_existing,
        status: ImportJobStatus::Queued,
        created_at: now_string(),
        started_at: None,
        finished_at: None,
        total: 0,
        done: 0,
        skipped: 0,
        speed_mbps: 0.0,
        current_file: "Queued".to_string(),
        imported: 0,
        md5_sidecar_hits: 0,
        md5_computed: 0,
        errors: vec![],
        logs: vec![format!("[{}] queued", now_string())],
        pause_requested: false,
        abort_requested: false,
    };

    {
        let mut jobs = jobs_store().lock().map_err(|e| e.to_string())?;
        jobs.insert(job_id.clone(), job);
    }

    let app_for_task = app.clone();
    let job_id_for_task = job_id.clone();
    async_runtime::spawn(async move {
        let _ = async_runtime::spawn_blocking(move || {
            run_import(
                app_for_task,
                source_dir,
                staging_dir,
                opts,
                Some(job_id_for_task),
            )
        })
        .await;
    });

    Ok(job_id)
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

