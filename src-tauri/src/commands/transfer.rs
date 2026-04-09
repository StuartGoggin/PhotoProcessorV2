use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use crate::utils::{compute_md5, num_cpus};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

use crate::commands::process::{
    append_process_job_log, next_process_job_id, now_string, process_jobs_store,
    update_process_job, wait_if_process_paused_or_aborted, ProcessJob, ProcessJobStatus,
    ProcessProgress, ProcessScopeMode, ProcessTask,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferResult {
    pub copied: usize,
    pub verified: usize,
    pub deduplicated: usize,
    pub renamed: usize,
    pub errors: Vec<String>,
}

const LEGACY_CHECKSUM_FILE_NAME: &str = "checksums.md5";
const TRANSFER_MANIFEST_DIR_NAME: &str = "_transfer_manifests";
const MASTER_HASH_TABLE_FILE: &str = "master_hashes.md5";
const MASTER_HASH_FLUSH_EVERY_COPIES: u64 = 250;

#[derive(Debug, Clone)]
struct FileTransferInfo {
    source_path: PathBuf,
    local_hash: String,
    destination_path: PathBuf,
    status: FileTransferStatus,
}

#[derive(Debug, Clone)]
enum FileTransferStatus {
    ToTransfer,
    Deduplicated,
    Renamed,
}

/// Server-side hash table for efficient lookups
#[derive(Debug)]
struct ServerHashTable {
    hash_to_paths: HashMap<String, Vec<String>>, // hash -> list of relative paths
    path_to_hash: HashMap<String, String>,        // relative path -> hash
}

impl ServerHashTable {
    fn new() -> Self {
        ServerHashTable {
            hash_to_paths: HashMap::new(),
            path_to_hash: HashMap::new(),
        }
    }

    fn load_from_file(path: &Path) -> Result<Self, String> {
        let mut table = ServerHashTable::new();
        if !path.exists() {
            return Ok(table);
        }

        let content = fs::read_to_string(path).map_err(|e| e.to_string())?;
        for line in content.lines() {
            if let Some((rel_path, hash)) = parse_checksum_line(line) {
                table
                    .hash_to_paths
                    .entry(hash.clone())
                    .or_insert_with(Vec::new)
                    .push(rel_path.clone());
                table.path_to_hash.insert(rel_path, hash);
            }
        }
        Ok(table)
    }

    fn hash_exists(&self, hash: &str) -> bool {
        self.hash_to_paths.contains_key(hash)
    }

    fn get_paths_for_hash(&self, hash: &str) -> Option<&[String]> {
        self.hash_to_paths.get(hash).map(|v| v.as_slice())
    }

}

fn should_log_progress(done: usize, total: usize) -> bool {
    total <= 20 || done <= 3 || done == total || done % 25 == 0
}

/// Update status line (progress indicator that replaces on each update)
/// Only logs milestone events (first/last/every 50 files) to console
fn update_transfer_status_line(
    job_id: Option<&str>,
    phase: &str,
    done: usize,
    total: usize,
    current_file: &str,
    speed_mbps: Option<f64>,
) {
    if let Some(job_id) = job_id {
        let speed_suffix = speed_mbps
            .map(|speed| format!(" [{:.1} MB/s]", speed))
            .unwrap_or_default();
        let status = if current_file.is_empty() {
            format!("{}: {}/{}{}", phase, done, total, speed_suffix)
        } else {
            format!("{}: {}/{} - {}{}", phase, done, total, current_file, speed_suffix)
        };
        
        use crate::commands::process::update_process_status_line;
        update_process_status_line(job_id, status);
    }

    // Only add to logs for milestone events
    if !should_log_progress(done, total) {
        return;
    }

    if let Some(job_id) = job_id {
        use crate::commands::process::append_process_milestone_log;
        let speed_suffix = speed_mbps
            .map(|speed| format!(" speed={:.1} MB/s", speed))
            .unwrap_or_default();
        append_process_milestone_log(
            job_id,
            format!(
                "{} progress {}/{} file='{}'{}",
                phase, done, total, current_file, speed_suffix
            ),
        );
    }
}

fn is_transfer_manifest_path(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == TRANSFER_MANIFEST_DIR_NAME)
}

fn should_skip_transfer_file(path: &Path) -> bool {
    // Skip by filename
    let skip_by_name = path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name == LEGACY_CHECKSUM_FILE_NAME || name == MASTER_HASH_TABLE_FILE)
        .unwrap_or(false);
    
    // Skip by extension (.hash, .md5, and .log files)
    let skip_by_extension = path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            ext.eq_ignore_ascii_case("hash")
                || ext.eq_ignore_ascii_case("md5")
                || ext.eq_ignore_ascii_case("log")
        })
        .unwrap_or(false);
    
    skip_by_name || skip_by_extension || is_transfer_manifest_path(path)
}

fn transfer_manifest_dir(archive: &Path) -> PathBuf {
    archive.join(TRANSFER_MANIFEST_DIR_NAME)
}

fn sanitize_job_id(job_id: Option<&str>) -> String {
    job_id
        .unwrap_or("manual")
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '_' })
        .collect()
}

fn build_transfer_output_path(
    archive: &Path,
    prefix: &str,
    extension: &str,
    job_id: Option<&str>,
) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let sanitized_job_id = sanitize_job_id(job_id);

    Ok(transfer_manifest_dir(archive).join(format!(
        "{}-{:020}-{}.{}",
        prefix, timestamp, sanitized_job_id, extension
    )))
}

fn build_transfer_verification_report_path(archive: &Path, job_id: Option<&str>) -> Result<PathBuf, String> {
    build_transfer_output_path(archive, "transfer-verification", "txt", job_id)
}

fn latest_transfer_manifest_path(archive: &Path) -> Result<Option<PathBuf>, String> {
    let manifest_dir = transfer_manifest_dir(archive);
    if !manifest_dir.exists() {
        return Ok(None);
    }

    let mut manifests = fs::read_dir(&manifest_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .map(|ext| ext.eq_ignore_ascii_case("md5"))
                    .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    manifests.sort();
    Ok(manifests.pop())
}

fn resolve_master_hash_table_path(archive: &Path) -> PathBuf {
    archive.join(MASTER_HASH_TABLE_FILE)
}

fn resolve_checksum_manifest_path(archive: &Path) -> Result<PathBuf, String> {
    // For backward compatibility, try to find transfer manifests or master hash table
    if let Some(manifest_path) = latest_transfer_manifest_path(archive).ok().flatten() {
        return Ok(manifest_path);
    }

    let master_path = resolve_master_hash_table_path(archive);
    if master_path.exists() {
        return Ok(master_path);
    }

    let legacy_path = archive.join(LEGACY_CHECKSUM_FILE_NAME);
    if legacy_path.exists() {
        return Ok(legacy_path);
    }

    Err(format!(
        "No checksum manifest found in '{}' and no legacy '{}' found in '{}'",
        transfer_manifest_dir(archive).display(),
        LEGACY_CHECKSUM_FILE_NAME,
        archive.display()
    ))
}

fn parse_checksum_line(line: &str) -> Option<(String, String)> {
    let parts: Vec<&str> = line.splitn(2, "  ").collect();
    if parts.len() != 2 {
        return None;
    }

    let hash = parts[0].trim();
    let relative_path = parts[1].trim();
    if hash.is_empty() || relative_path.is_empty() {
        return None;
    }

    Some((relative_path.to_string(), hash.to_string()))
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LocalHashSource {
    Sidecar,
    Manifest,
    Computed,
}

impl LocalHashSource {
    fn as_str(self) -> &'static str {
        match self {
            LocalHashSource::Sidecar => "sidecar",
            LocalHashSource::Manifest => "manifest",
            LocalHashSource::Computed => "computed",
        }
    }
}

#[derive(Debug, Clone, Default)]
struct LocalMd5Index {
    hashes_by_media_path: HashMap<PathBuf, String>,
    sidecar_file_count: usize,
    manifest_file_count: usize,
    manifest_entry_count: usize,
}

fn load_local_md5_index(root: &Path) -> LocalMd5Index {
    let mut index = LocalMd5Index::default();
    if !root.exists() {
        return index;
    }

    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
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
        if media_path.exists() {
            let expected_filename = media_path.file_name().and_then(|n| n.to_str());
            if let Some(hash) = read_md5_hash_from_sidecar(path, expected_filename) {
                index.sidecar_file_count += 1;
                index
                    .hashes_by_media_path
                    .entry(media_path)
                    .or_insert(hash);
                continue;
            }
        }

        let content = match fs::read_to_string(path) {
            Ok(content) => content,
            Err(_) => continue,
        };

        let mut entries_added = 0usize;
        for line in content.lines() {
            let Some((relative_path, hash)) = parse_checksum_line(line) else {
                continue;
            };

            let media_path = path
                .parent()
                .map(|parent| parent.join(&relative_path))
                .unwrap_or_else(|| PathBuf::from(&relative_path));
            if !media_path.exists() {
                continue;
            }

            index
                .hashes_by_media_path
                .entry(media_path)
                .or_insert(hash);
            entries_added += 1;
        }

        if entries_added > 0 {
            index.manifest_file_count += 1;
            index.manifest_entry_count += entries_added;
        }
    }

    index
}

fn md5_for_file_prefer_local_index(
    file_path: &Path,
    local_md5_index: &LocalMd5Index,
) -> Result<(String, LocalHashSource), String> {
    if let Some(hash) = read_md5_sidecar_for_file(file_path) {
        return Ok((hash, LocalHashSource::Sidecar));
    }

    if let Some(hash) = local_md5_index.hashes_by_media_path.get(file_path) {
        return Ok((hash.clone(), LocalHashSource::Manifest));
    }

    compute_md5(file_path)
        .map(|hash| (hash, LocalHashSource::Computed))
        .map_err(|e| e.to_string())
}

/// Atomically updates master hash table by writing to temp file and moving
fn atomic_update_master_hash_table(
    archive: &Path,
    new_entries: &[(String, String)], // (rel_path, hash)
) -> Result<usize, String> {
    let master_path = resolve_master_hash_table_path(archive);
    
    // Load existing table
    let mut all_entries = HashMap::<String, String>::new();
    if master_path.exists() {
        let content = fs::read_to_string(&master_path).map_err(|e| e.to_string())?;
        for line in content.lines() {
            if let Some((rel_path, hash)) = parse_checksum_line(line) {
                all_entries.insert(rel_path, hash);
            }
        }
    }
    
    // Track how many were newly added
    let mut added_count = 0;
    for (rel_path, hash) in new_entries {
        if !all_entries.contains_key(rel_path) {
            added_count += 1;
        }
        all_entries.insert(rel_path.clone(), hash.clone());
    }
    
    // Write to temp file first
    let temp_path = master_path.with_extension("md5.tmp");
    let mut sorted_entries: Vec<_> = all_entries.into_iter().collect();
    sorted_entries.sort_by(|a, b| a.0.cmp(&b.0));
    
    let content = sorted_entries
        .iter()
        .map(|(path, hash)| format!("{}  {}", hash, path))
        .collect::<Vec<_>>()
        .join("\n");
    
    fs::write(&temp_path, content).map_err(|e| e.to_string())?;
    
    // Atomic move
    #[cfg(target_os = "windows")]
    {
        // On Windows, std::fs::rename cannot overwrite an existing file.
        // Remove existing target first so the replacement actually applies.
        if master_path.exists() {
            fs::remove_file(&master_path).map_err(|e| {
                format!(
                    "Failed to replace existing master hash table '{}': {}",
                    master_path.display(),
                    e
                )
            })?;
        }
        fs::rename(&temp_path, &master_path).map_err(|e| e.to_string())?;
    }
    
    #[cfg(not(target_os = "windows"))]
    {
        // On Unix, create_dir_all + rename is atomic
        fs::rename(&temp_path, &master_path).map_err(|e| e.to_string())?;
    }
    
    Ok(added_count)
}

    fn atomic_reconcile_master_hash_table(
        archive: &Path,
        upserts: &[(String, String)],     // (rel_path, hash)
        remove_paths: &[String],
    ) -> Result<(usize, usize), String> {
        let master_path = resolve_master_hash_table_path(archive);

        let mut all_entries = HashMap::<String, String>::new();
        if master_path.exists() {
            let content = fs::read_to_string(&master_path).map_err(|e| e.to_string())?;
            for line in content.lines() {
                if let Some((rel_path, hash)) = parse_checksum_line(line) {
                    all_entries.insert(rel_path, hash);
                }
            }
        }

        let mut removed_count = 0usize;
        for rel_path in remove_paths {
            if all_entries.remove(rel_path).is_some() {
                removed_count += 1;
            }
        }

        let mut added_count = 0usize;
        for (rel_path, hash) in upserts {
            if !all_entries.contains_key(rel_path) {
                added_count += 1;
            }
            all_entries.insert(rel_path.clone(), hash.clone());
        }

        let temp_path = master_path.with_extension("md5.tmp");
        let mut sorted_entries: Vec<_> = all_entries.into_iter().collect();
        sorted_entries.sort_by(|a, b| a.0.cmp(&b.0));

        let content = sorted_entries
            .iter()
            .map(|(path, hash)| format!("{}  {}", hash, path))
            .collect::<Vec<_>>()
            .join("\n");

        fs::write(&temp_path, content).map_err(|e| e.to_string())?;

        #[cfg(target_os = "windows")]
        {
            if master_path.exists() {
                fs::remove_file(&master_path).map_err(|e| {
                    format!(
                        "Failed to replace existing master hash table '{}': {}",
                        master_path.display(),
                        e
                    )
                })?;
            }
            fs::rename(&temp_path, &master_path).map_err(|e| e.to_string())?;
        }

        #[cfg(not(target_os = "windows"))]
        {
            fs::rename(&temp_path, &master_path).map_err(|e| e.to_string())?;
        }

        Ok((added_count, removed_count))
    }

fn collect_all_files(dir: &Path) -> Vec<PathBuf> {
    WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|path| !should_skip_transfer_file(path))
        .collect()
}

fn get_unique_destination(base: &PathBuf) -> PathBuf {
    if !base.exists() {
        return base.clone();
    }
    
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
    
    let mut i = 1u32;
    loop {
        let candidate = if ext.is_empty() {
            dir.join(format!("{}_{}", stem, i))
        } else {
            dir.join(format!("{}_{}.{}", stem, i, ext))
        };
        if !candidate.exists() {
            return candidate;
        }
        i += 1;
    }
}

#[tauri::command]
pub fn start_transfer(
    app: AppHandle,
    staging_dir: String,
    archive_dir: String,
) -> Result<String, String> {
    let staging = PathBuf::from(&staging_dir);
    let archive = PathBuf::from(&archive_dir);

    if !staging.exists() {
        return Err(format!("Staging dir does not exist: {}", staging_dir));
    }

    let job_id = next_process_job_id();
    let job = ProcessJob {
        id: job_id.clone(),
        task: ProcessTask::Transfer,
        staging_dir: staging_dir.clone(),
        scope_dir: staging_dir.clone(),
        scope_mode: ProcessScopeMode::FolderRecursive,
        archive_dir: Some(archive_dir.clone()),
        speed_mbps: None,
        status: ProcessJobStatus::Queued,
        created_at: now_string(),
        started_at: None,
        finished_at: None,
        total: 0,
        done: 0,
        processed: 0,
        result_count: 0,
        current_file: "Queued".to_string(),
        stabilization_mode: None,
        stabilization_strength: None,
        preserve_source_bitrate: None,
        stabilize_max_parallel_jobs_used: None,
        stabilize_ffmpeg_threads_per_job_used: None,
        conflict_report_path: None,
        current_phase: None,
        transfer_local_processed_count: Some(0),
        transfer_local_sidecar_hits_count: Some(0),
        transfer_local_manifest_hits_count: Some(0),
        transfer_local_hash_computed_count: Some(0),
        transfer_uploaded_count: Some(0),
        transfer_deduplicated_count: Some(0),
        transfer_renamed_count: Some(0),
        transfer_server_hash_match_count: Some(0),
        transfer_server_hash_unverified_count: Some(0),
        transfer_indexed_added_count: Some(0),
        errors: vec![],
        logs: vec![format!("[{}] queued transfer", now_string())],
        status_line: String::new(),
        pause_requested: false,
        abort_requested: false,
    };

    {
        let mut jobs = process_jobs_store().lock().map_err(|e| e.to_string())?;
        jobs.insert(job_id.clone(), job);
    }

    let app_clone = app.clone();
    let app_for_status = app.clone();
    let job_id_for_task = job_id.clone();
    let job_id_for_status = job_id.clone();

    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            run_transfer_task(app_clone, staging, archive, Some(job_id_for_task))
        }).await;

        match result {
            Ok(Ok(_)) => {}
            Ok(Err(err)) => {
                update_process_job(&job_id_for_status, |job| {
                    job.status = ProcessJobStatus::Failed;
                    job.finished_at = Some(now_string());
                    job.current_file = "Failed".to_string();
                    job.errors.push(err.clone());
                });
                append_process_job_log(&job_id_for_status, format!("failed before processing: {}", err));
                let _ = crate::utils::append_app_log(&app_for_status, format!("process_transfer failed job_id='{}' error='{}'", job_id_for_status, err));
            }
            Err(join_err) => {
                let err = format!("Process background task failed: {}", join_err);
                update_process_job(&job_id_for_status, |job| {
                    job.status = ProcessJobStatus::Failed;
                    job.finished_at = Some(now_string());
                    job.current_file = "Failed".to_string();
                    job.errors.push(err.clone());
                });
                append_process_job_log(&job_id_for_status, err.clone());
                let _ = crate::utils::append_app_log(&app_for_status, format!("process_transfer join_failed job_id='{}' error='{}'", job_id_for_status, err));
            }
        }
    });

    Ok(job_id)
}

#[tauri::command]
pub fn verify_checksums(
    app: AppHandle,
    archive_dir: String,
) -> Result<String, String> {
    let archive = PathBuf::from(&archive_dir);
    let checksum_path = resolve_checksum_manifest_path(&archive)?;

    let job_id = next_process_job_id();
    let job = ProcessJob {
        id: job_id.clone(),
        task: ProcessTask::VerifyChecksums,
        staging_dir: archive_dir.clone(), // Set archive as staging to render properly
        scope_dir: archive_dir.clone(),
        scope_mode: ProcessScopeMode::FolderRecursive,
        archive_dir: Some(archive_dir.clone()),
        speed_mbps: None,
        status: ProcessJobStatus::Queued,
        created_at: now_string(),
        started_at: None,
        finished_at: None,
        total: 0,
        done: 0,
        processed: 0,
        result_count: 0,
        current_file: "Queued".to_string(),
        stabilization_mode: None,
        stabilization_strength: None,
        preserve_source_bitrate: None,
        stabilize_max_parallel_jobs_used: None,
        stabilize_ffmpeg_threads_per_job_used: None,
        conflict_report_path: None,
        current_phase: None,
        transfer_local_processed_count: None,
        transfer_local_sidecar_hits_count: None,
        transfer_local_manifest_hits_count: None,
        transfer_local_hash_computed_count: None,
        transfer_uploaded_count: None,
        transfer_deduplicated_count: None,
        transfer_renamed_count: None,
        transfer_server_hash_match_count: None,
        transfer_server_hash_unverified_count: None,
        transfer_indexed_added_count: None,
        errors: vec![],
        logs: vec![format!("[{}] queued verify checksums", now_string())],
        status_line: String::new(),
        pause_requested: false,
        abort_requested: false,
    };

    {
        let mut jobs = process_jobs_store().lock().map_err(|e| e.to_string())?;
        jobs.insert(job_id.clone(), job);
    }

    let app_clone = app.clone();
    let app_for_status = app.clone();
    let job_id_for_task = job_id.clone();
    let job_id_for_status = job_id.clone();
    let archive_clone = archive_dir.clone();
    let checksum_path_clone = checksum_path.clone();

    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            run_verify_task(app_clone, archive_clone, checksum_path_clone, Some(job_id_for_task))
        }).await;

        match result {
            Ok(Ok(_)) => {}
            Ok(Err(err)) => {
                update_process_job(&job_id_for_status, |job| {
                    job.status = ProcessJobStatus::Failed;
                    job.finished_at = Some(now_string());
                    job.current_file = "Failed".to_string();
                    job.errors.push(err.clone());
                });
                append_process_job_log(&job_id_for_status, format!("failed before processing: {}", err));
                let _ = crate::utils::append_app_log(&app_for_status, format!("process_verify failed job_id='{}' error='{}'", job_id_for_status, err));
            }
            Err(join_err) => {
                let err = format!("Process background task failed: {}", join_err);
                update_process_job(&job_id_for_status, |job| {
                    job.status = ProcessJobStatus::Failed;
                    job.finished_at = Some(now_string());
                    job.current_file = "Failed".to_string();
                    job.errors.push(err.clone());
                });
                append_process_job_log(&job_id_for_status, err.clone());
                let _ = crate::utils::append_app_log(&app_for_status, format!("process_verify join_failed job_id='{}' error='{}'", job_id_for_status, err));
            }
        }
    });

    Ok(job_id)
}

fn run_transfer_task(
    app: AppHandle,
    staging: PathBuf,
    archive: PathBuf,
    job_id: Option<String>,
) -> Result<TransferResult, String> {
    fs::create_dir_all(&archive).map_err(|e| e.to_string())?;

    let files = collect_all_files(&staging);
    let local_md5_index = Arc::new(load_local_md5_index(&staging));
    let mut overall_errors = Vec::new();
    let total_files = files.len();

    let staging_canonical = staging.canonicalize().unwrap_or_else(|_| staging.clone());
    let archive_canonical = archive.canonicalize().unwrap_or_else(|_| archive.clone());
    
    if let Some(ref jid) = job_id {
        update_process_job(jid, |job| {
            job.status = ProcessJobStatus::Running;
            job.started_at = Some(now_string());
            job.current_file = "Loading server hash table".to_string();
            job.conflict_report_path = None;
            job.current_phase = Some("load_server_hashes".to_string());
            job.total = total_files;
            job.transfer_local_processed_count = Some(0);
            job.transfer_local_sidecar_hits_count = Some(0);
            job.transfer_local_manifest_hits_count = Some(0);
            job.transfer_local_hash_computed_count = Some(0);
            job.transfer_uploaded_count = Some(0);
            job.transfer_deduplicated_count = Some(0);
            job.transfer_renamed_count = Some(0);
            job.transfer_server_hash_match_count = Some(0);
            job.transfer_server_hash_unverified_count = Some(0);
            job.transfer_indexed_added_count = Some(0);
        });
        append_process_job_log(jid, format!("TRANSFER_START: staging_dir=[absolute='{}'] archive_dir=[absolute='{}']", staging_canonical.display(), archive_canonical.display()));
        append_process_job_log(
            jid,
            format!(
                "local hash sources: sidecar_files={} manifest_files={} manifest_entries={} fallback_compute_pending={}",
                local_md5_index.sidecar_file_count,
                local_md5_index.manifest_file_count,
                local_md5_index.manifest_entry_count,
                total_files.saturating_sub(local_md5_index.hashes_by_media_path.len())
            ),
        );
        if files.is_empty() {
            append_process_job_log(jid, "no transferable files found in staging directory");
        }
    }
    let _ = crate::utils::append_app_log(&app, format!("process_transfer start staging='{}' archive='{}'", staging.display(), archive.display()));

    // PHASE 1: Load server hash table
    let master_hash_path = resolve_master_hash_table_path(&archive);
    let master_hash_path_canonical = master_hash_path.canonicalize().unwrap_or_else(|_| master_hash_path.clone());
    let server_hash_table = match ServerHashTable::load_from_file(&master_hash_path) {
        Ok(table) => {
            if let Some(ref jid) = job_id {
                append_process_job_log(jid, format!("PHASE1_LOAD_HASH_TABLE: loaded server hash table from path=[absolute='{}']", master_hash_path_canonical.display()));
            }
            table
        }
        Err(e) => {
            let msg = format!("PHASE1_LOAD_HASH_TABLE_ERROR: Failed to load server hash table from path=[absolute='{}'], error=[{}]", master_hash_path_canonical.display(), e);
            overall_errors.push(msg.clone());
            if let Some(ref jid) = job_id {
                append_process_job_log(jid, &msg);
            }
            ServerHashTable::new()
        }
    };

    // PHASE 2: Compute MD5 hashes for all staging files
    if let Some(ref jid) = job_id {
        update_process_job(jid, |job| {
            job.current_file = "Computing local hashes".to_string();
            job.current_phase = Some("compute_local_hashes".to_string());
            job.done = 0;
            job.total = total_files;
        });
        append_process_job_log(jid, format!("computing local hashes for {} files", total_files));
    }

    let done_count = Arc::new(AtomicU64::new(0));
    let sidecar_hits_count = Arc::new(AtomicU64::new(0));
    let manifest_hits_count = Arc::new(AtomicU64::new(0));
    let computed_hashes_count = Arc::new(AtomicU64::new(0));
    let compute_errors = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let file_hashes = Arc::new(std::sync::Mutex::new(HashMap::<PathBuf, String>::new()));

    let app_clone = app.clone();
    let job_id_clone = job_id.clone();
    let done_clone = done_count.clone();
    let sidecar_hits_clone = sidecar_hits_count.clone();
    let manifest_hits_clone = manifest_hits_count.clone();
    let computed_hashes_clone = computed_hashes_count.clone();
    let compute_errors_clone = compute_errors.clone();
    let file_hashes_clone = file_hashes.clone();
    let local_md5_index_clone = local_md5_index.clone();

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(num_cpus())
        .build()
        .map_err(|e| e.to_string())?;

    pool.install(|| {
        files.par_iter().for_each(|src| {
            if wait_if_process_paused_or_aborted(job_id_clone.as_deref()) {
                return;
            }

            let file_name_str = src.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();

            match md5_for_file_prefer_local_index(src, local_md5_index_clone.as_ref()) {
                Ok((hash, source)) => {
                    file_hashes_clone.lock().unwrap().insert(src.clone(), hash);
                    let done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;
                    let sidecar_hits = if matches!(source, LocalHashSource::Sidecar) {
                        sidecar_hits_clone.fetch_add(1, Ordering::Relaxed) + 1
                    } else {
                        sidecar_hits_clone.load(Ordering::Relaxed)
                    };
                    let manifest_hits = if matches!(source, LocalHashSource::Manifest) {
                        manifest_hits_clone.fetch_add(1, Ordering::Relaxed) + 1
                    } else {
                        manifest_hits_clone.load(Ordering::Relaxed)
                    };
                    let computed_hashes = if matches!(source, LocalHashSource::Computed) {
                        computed_hashes_clone.fetch_add(1, Ordering::Relaxed) + 1
                    } else {
                        computed_hashes_clone.load(Ordering::Relaxed)
                    };

                    if let Some(ref jid) = job_id_clone {
                        append_process_job_log(
                            jid,
                            format!(
                                "  local-hash source={} file='{}'",
                                source.as_str(),
                                file_name_str
                            ),
                        );
                        update_process_job(jid, |job| {
                            job.done = done as usize;
                            job.transfer_local_processed_count = Some(done as usize);
                            job.transfer_local_sidecar_hits_count = Some(sidecar_hits as usize);
                            job.transfer_local_manifest_hits_count = Some(manifest_hits as usize);
                            job.transfer_local_hash_computed_count = Some(computed_hashes as usize);
                            job.current_file = file_name_str.clone();
                        });
                    }

                    update_transfer_status_line(
                        job_id_clone.as_deref(),
                        "hash",
                        done as usize,
                        total_files,
                        &file_name_str,
                        None,
                    );

                    let _ = app_clone.emit(
                        "process-progress",
                        ProcessProgress {
                            total: total_files,
                            done: done as usize,
                            current_file: file_name_str,
                            phase: "compute_local_hashes".to_string(),
                            speed_mbps: None,
                        },
                    );
                }
                Err(e) => {
                    let msg = format!("Failed to compute hash for {}: {}", src.display(), e);
                    compute_errors_clone.lock().unwrap().push(msg.clone());
                    if let Some(ref jid) = job_id_clone {
                        append_process_job_log(jid, &msg);
                    }
                }
            }
        });
    });

    overall_errors.extend(compute_errors.lock().unwrap().clone());
    if let Some(ref jid) = job_id {
        update_process_job(jid, |job| {
            job.transfer_local_sidecar_hits_count = Some(sidecar_hits_count.load(Ordering::Relaxed) as usize);
            job.transfer_local_manifest_hits_count = Some(manifest_hits_count.load(Ordering::Relaxed) as usize);
            job.transfer_local_hash_computed_count = Some(computed_hashes_count.load(Ordering::Relaxed) as usize);
        });
        append_process_job_log(
            jid,
            format!(
                "local hash acquisition complete: sidecar_hits={} manifest_hits={} computed={}",
                sidecar_hits_count.load(Ordering::Relaxed),
                manifest_hits_count.load(Ordering::Relaxed),
                computed_hashes_count.load(Ordering::Relaxed)
            ),
        );
    }
    let file_hashes_map = file_hashes.lock().unwrap().clone();

    // PHASE 3: Verify against server and plan transfers
    if let Some(ref jid) = job_id {
        update_process_job(jid, |job| {
            job.current_file = "Verifying against server".to_string();
            job.current_phase = Some("verify_server".to_string());
            job.done = 0;
            job.total = total_files;
        });
        append_process_job_log(jid, "verifying files against server hash table");
    }

    let transfer_plan = Arc::new(std::sync::Mutex::new(Vec::<FileTransferInfo>::new()));
    let hash_backfill_entries = Arc::new(std::sync::Mutex::new(Vec::<(String, String)>::new()));
    let verification_report = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let verify_errors = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let stale_hash_paths = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let verify_done = Arc::new(AtomicU64::new(0));
    let deduplicated_counter = Arc::new(AtomicU64::new(0));
    let renamed_counter = Arc::new(AtomicU64::new(0));
    let hash_match_counter = Arc::new(AtomicU64::new(0));
    let unverified_counter = Arc::new(AtomicU64::new(0));

    let app_verify = app.clone();
    let job_id_verify = job_id.clone();
    let staging_verify = staging.clone();
    let archive_verify = archive.clone();
    let hash_backfill_entries_verify = hash_backfill_entries.clone();
    let stale_hash_paths_verify = stale_hash_paths.clone();

    pool.install(|| {
        files.par_iter().for_each(|src| {
            if wait_if_process_paused_or_aborted(job_id_verify.as_deref()) {
                return;
            }

            let file_name = src.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            let rel_path = src
                .strip_prefix(&staging_verify)
                .map(|p| p.to_string_lossy().replace('\\', "/").to_string())
                .unwrap_or_else(|_| file_name.clone());

            let local_hash = match file_hashes_map.get(src) {
                Some(hash) => hash.clone(),
                None => {
                    if let Some(ref jid) = job_id_verify {
                        append_process_job_log(jid, format!("  skipped (no hash): {}", rel_path));
                    }
                    let done = verify_done.fetch_add(1, Ordering::Relaxed) + 1;
                    if let Some(ref jid) = job_id_verify {
                        if done <= 3 || done % 25 == 0 || done as usize == total_files {
                            update_process_job(jid, |job| {
                                job.done = done as usize;
                                job.current_file = file_name.clone();
                            });
                        }
                    }
                    return;
                }
            };

            if let Some(ref jid) = job_id_verify {
                append_process_job_log(jid, format!("  checking: {} [{}]", rel_path, &local_hash[..8]));
            }

            // STEP 1: Check hash table match and verify server-side file
            let mut resolved = false;
            if server_hash_table.hash_exists(&local_hash) {
                let hash_matches = hash_match_counter.fetch_add(1, Ordering::Relaxed) + 1;
                let server_paths = server_hash_table.get_paths_for_hash(&local_hash).unwrap_or(&[]);

                if let Some(ref jid) = job_id_verify {
                    append_process_job_log(
                        jid,
                        format!(
                            "    step1 hash-match: found {} server path(s) with hash {}",
                            server_paths.len(),
                            &local_hash[..8]
                        ),
                    );
                    if hash_matches <= 3 || hash_matches % 25 == 0 {
                        update_process_job(jid, |job| {
                            job.transfer_server_hash_match_count = Some(hash_matches as usize);
                        });
                    }
                }

                for server_path in server_paths {
                    let server_file_path = archive_verify.join(server_path);
                    if !server_file_path.exists() {
                        stale_hash_paths_verify.lock().unwrap().push(server_path.clone());
                        if let Some(ref jid) = job_id_verify {
                            append_process_job_log(
                                jid,
                                format!(
                                    "    step1 ghost: hash table references '{}' but file not present on server",
                                    server_path
                                ),
                            );
                        }
                        continue;
                    }

                    match compute_md5(&server_file_path) {
                        Ok(server_hash) if server_hash == local_hash => {
                            let dedup = deduplicated_counter.fetch_add(1, Ordering::Relaxed) + 1;
                            verification_report.lock().unwrap().push(format!(
                                "DEDUPLICATED: {} (same content already at {})",
                                rel_path, server_path
                            ));
                            transfer_plan.lock().unwrap().push(FileTransferInfo {
                                source_path: src.clone(),
                                local_hash: local_hash.clone(),
                                destination_path: server_file_path,
                                status: FileTransferStatus::Deduplicated,
                            });
                            if let Some(ref jid) = job_id_verify {
                                append_process_job_log(
                                    jid,
                                    format!(
                                        "    step1 verified: server file OK at '{}' -> DEDUPLICATED",
                                        server_path
                                    ),
                                );
                                if dedup <= 3 || dedup % 25 == 0 {
                                    update_process_job(jid, |job| {
                                        job.transfer_deduplicated_count = Some(dedup as usize);
                                    });
                                }
                            }
                            resolved = true;
                            break;
                        }
                        Ok(actual_hash) => {
                            stale_hash_paths_verify.lock().unwrap().push(server_path.clone());
                            verification_report.lock().unwrap().push(format!(
                                "HASH_MISMATCH: {} has hash {} but table shows {}",
                                server_path, actual_hash, local_hash
                            ));
                            if let Some(ref jid) = job_id_verify {
                                append_process_job_log(
                                    jid,
                                    format!(
                                        "    step1 corrupt: server file '{}' has hash {} but table shows {}",
                                        server_path,
                                        &actual_hash[..8],
                                        &local_hash[..8]
                                    ),
                                );
                            }
                        }
                        Err(e) => {
                            stale_hash_paths_verify.lock().unwrap().push(server_path.clone());
                            verification_report.lock().unwrap().push(format!(
                                "VERIFY_ERROR: Could not verify {}: {}",
                                server_path, e
                            ));
                            if let Some(ref jid) = job_id_verify {
                                append_process_job_log(
                                    jid,
                                    format!(
                                        "    step1 verify-error: could not hash server file '{}': {}",
                                        server_path, e
                                    ),
                                );
                            }
                        }
                    }
                }

                if !resolved {
                    let unverified = unverified_counter.fetch_add(1, Ordering::Relaxed) + 1;
                    verify_errors.lock().unwrap().push(format!(
                        "Hash {} exists in table but server file could not be verified for {}",
                        local_hash, rel_path
                    ));
                    if let Some(ref jid) = job_id_verify {
                        append_process_job_log(
                            jid,
                            format!(
                                "    step1 unverified: hash {} in table but no server file confirmed, continuing to step 2",
                                &local_hash[..8]
                            ),
                        );
                        if unverified <= 3 || unverified % 25 == 0 {
                            update_process_job(jid, |job| {
                                job.transfer_server_hash_unverified_count = Some(unverified as usize);
                            });
                        }
                    }
                }
            } else if let Some(ref jid) = job_id_verify {
                append_process_job_log(
                    jid,
                    format!(
                        "    step1 no-hash-match: hash {} not in server table",
                        &local_hash[..8]
                    ),
                );
            }

            // STEP 2: Destination conflict / transfer planning
            if !resolved {
                let dest_base = archive_verify.join(&rel_path);
                if dest_base.exists() {
                    if let Some(ref jid) = job_id_verify {
                        append_process_job_log(
                            jid,
                            format!(
                                "    step2 name-conflict: destination path already exists: '{}'",
                                rel_path
                            ),
                        );
                    }

                    match compute_md5(&dest_base) {
                        Ok(existing_hash) if existing_hash == local_hash => {
                            let dedup = deduplicated_counter.fetch_add(1, Ordering::Relaxed) + 1;
                            hash_backfill_entries_verify
                                .lock()
                                .unwrap()
                                .push((rel_path.clone(), existing_hash.clone()));
                            transfer_plan.lock().unwrap().push(FileTransferInfo {
                                source_path: src.clone(),
                                local_hash: local_hash.clone(),
                                destination_path: dest_base,
                                status: FileTransferStatus::Deduplicated,
                            });
                            if let Some(ref jid) = job_id_verify {
                                append_process_job_log(
                                    jid,
                                    format!(
                                        "    step2 same-content: destination '{}' already exists with matching hash '{}' -> DEDUPLICATED",
                                        rel_path,
                                        &local_hash[..8]
                                    ),
                                );
                                append_process_job_log(
                                    jid,
                                    format!(
                                        "    step2 backfill-queued: path='{}' hash='{}' added to backfill queue (will be written to server hash table in phase 5)",
                                        rel_path,
                                        &local_hash[..8]
                                    ),
                                );
                                if dedup <= 3 || dedup % 25 == 0 {
                                    update_process_job(jid, |job| {
                                        job.transfer_deduplicated_count = Some(dedup as usize);
                                    });
                                }
                            }
                        }
                        Ok(existing_hash) => {
                            let final_dest = get_unique_destination(&dest_base);
                            let new_rel_path = final_dest
                                .strip_prefix(&archive_verify)
                                .map(|p| p.to_string_lossy().replace('\\', "/").to_string())
                                .unwrap_or_else(|_| rel_path.clone());
                            let renamed = renamed_counter.fetch_add(1, Ordering::Relaxed) + 1;
                            verification_report.lock().unwrap().push(format!(
                                "RENAMED: {} -> {} (different content at destination)",
                                rel_path, new_rel_path
                            ));
                            transfer_plan.lock().unwrap().push(FileTransferInfo {
                                source_path: src.clone(),
                                local_hash: local_hash.clone(),
                                destination_path: final_dest,
                                status: FileTransferStatus::Renamed,
                            });
                            if let Some(ref jid) = job_id_verify {
                                append_process_job_log(
                                    jid,
                                    format!(
                                        "    step2 renamed: different content (local={} server={}) -> '{}'",
                                        &local_hash[..8],
                                        &existing_hash[..8],
                                        new_rel_path
                                    ),
                                );
                                if renamed <= 3 || renamed % 25 == 0 {
                                    update_process_job(jid, |job| {
                                        job.transfer_renamed_count = Some(renamed as usize);
                                    });
                                }
                            }
                        }
                        Err(_) => {
                            let final_dest = get_unique_destination(&dest_base);
                            let new_rel_path = final_dest
                                .strip_prefix(&archive_verify)
                                .map(|p| p.to_string_lossy().replace('\\', "/").to_string())
                                .unwrap_or_else(|_| rel_path.clone());
                            let renamed = renamed_counter.fetch_add(1, Ordering::Relaxed) + 1;
                            transfer_plan.lock().unwrap().push(FileTransferInfo {
                                source_path: src.clone(),
                                local_hash: local_hash.clone(),
                                destination_path: final_dest,
                                status: FileTransferStatus::Renamed,
                            });
                            if let Some(ref jid) = job_id_verify {
                                append_process_job_log(
                                    jid,
                                    format!(
                                        "    step2 hash-failed: cannot hash existing destination, renaming to '{}'",
                                        new_rel_path
                                    ),
                                );
                                if renamed <= 3 || renamed % 25 == 0 {
                                    update_process_job(jid, |job| {
                                        job.transfer_renamed_count = Some(renamed as usize);
                                    });
                                }
                            }
                        }
                    }
                } else {
                    transfer_plan.lock().unwrap().push(FileTransferInfo {
                        source_path: src.clone(),
                        local_hash: local_hash.clone(),
                        destination_path: dest_base,
                        status: FileTransferStatus::ToTransfer,
                    });
                    if let Some(ref jid) = job_id_verify {
                        append_process_job_log(
                            jid,
                            format!("    step2 clear: destination '{}' is free -> QUEUED", rel_path),
                        );
                    }
                }
            }

            let done = verify_done.fetch_add(1, Ordering::Relaxed) + 1;
            if let Some(ref jid) = job_id_verify {
                if done <= 3 || done % 25 == 0 || done as usize == total_files {
                    update_process_job(jid, |job| {
                        job.done = done as usize;
                        job.current_file = file_name.clone();
                        job.transfer_server_hash_match_count = Some(hash_match_counter.load(Ordering::Relaxed) as usize);
                        job.transfer_server_hash_unverified_count = Some(unverified_counter.load(Ordering::Relaxed) as usize);
                        job.transfer_deduplicated_count = Some(deduplicated_counter.load(Ordering::Relaxed) as usize);
                        job.transfer_renamed_count = Some(renamed_counter.load(Ordering::Relaxed) as usize);
                    });
                }
            }

            update_transfer_status_line(
                job_id_verify.as_deref(),
                "verify",
                done as usize,
                total_files,
                &file_name,
                None,
            );

            let _ = app_verify.emit(
                "process-progress",
                ProcessProgress {
                    total: total_files,
                    done: done as usize,
                    current_file: file_name,
                    phase: "verify_server".to_string(),
                    speed_mbps: None,
                },
            );
        });
    });

    overall_errors.extend(verify_errors.lock().unwrap().clone());
    let transfer_plan = transfer_plan.lock().unwrap().clone();
    let hash_backfill_entries = hash_backfill_entries.lock().unwrap().clone();
    let stale_hash_paths = stale_hash_paths.lock().unwrap().clone();
    let deduplicated_count = deduplicated_counter.load(Ordering::Relaxed) as usize;
    let renamed_count = renamed_counter.load(Ordering::Relaxed) as usize;
    let verification_report = verification_report.lock().unwrap().clone();

    let to_transfer_count = transfer_plan.iter().filter(|f| matches!(f.status, FileTransferStatus::ToTransfer)).count();

    if let Some(ref jid) = job_id {
        append_process_job_log(
            jid,
            format!(
                "verification complete: to_transfer={} deduplicated={} renamed={} hash_backfill_pending={}",
                to_transfer_count, deduplicated_count, renamed_count, hash_backfill_entries.len()
            ),
        );
    }

    // Write verification report
    if !verification_report.is_empty() {
        if let Ok(verification_report_path) = build_transfer_verification_report_path(&archive, job_id.as_deref()) {
            if let Some(parent) = verification_report_path.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let report_content = verification_report.join("\n");
            let report_bytes = report_content.len();
            match fs::write(&verification_report_path, report_content) {
                Ok(_) => {
                    if let Some(ref jid) = job_id {
                        let report_path_canonical = verification_report_path.canonicalize().unwrap_or_else(|_| verification_report_path.clone());
                        append_process_job_log(jid, format!("VERIFICATION_REPORT_WRITTEN: file=[absolute='{}'] entries={} size_bytes={}", report_path_canonical.display(), verification_report.len(), report_bytes));
                    }
                }
                Err(e) => {
                    if let Some(ref jid) = job_id {
                        let report_path_canonical = verification_report_path.canonicalize().unwrap_or_else(|_| verification_report_path.clone());
                        append_process_job_log(jid, format!("VERIFICATION_REPORT_ERROR: file=[absolute='{}'] error=[{}]", report_path_canonical.display(), e));
                    }
                }
            }
        }
    }

    // PHASE 4: Copy files that need to be transferred
    if let Some(ref jid) = job_id {
        update_process_job(jid, |job| {
            job.current_file = "Copying files".to_string();
            job.current_phase = Some("transfer_copy".to_string());
            job.done = 0;
            job.total = to_transfer_count;
        });
        if to_transfer_count > 0 {
            append_process_job_log(jid, format!("starting copy phase for {} files", to_transfer_count));
        }
    }

    let bytes_copied = Arc::new(AtomicU64::new(0));
    let copy_errors = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let copied_files = Arc::new(std::sync::Mutex::new(Vec::<(String, String)>::new())); // (rel_path, hash)
    let pending_hash_updates = Arc::new(std::sync::Mutex::new(Vec::<(String, String)>::new()));
    let index_flush_lock = Arc::new(std::sync::Mutex::new(()));
    let indexed_added_total = Arc::new(AtomicU64::new(0));
    let start_time = std::time::Instant::now();

    let app_clone = app.clone();
    let archive_for_copy = archive.clone();
    let job_id_clone = job_id.clone();
    let copy_done_count = Arc::new(AtomicU64::new(0));
    let copy_done_clone = copy_done_count.clone();
    let bytes_clone = bytes_copied.clone();
    let copy_errors_clone = copy_errors.clone();
    let copied_files_clone = copied_files.clone();
    let pending_hash_updates_clone = pending_hash_updates.clone();
    let index_flush_lock_clone = index_flush_lock.clone();
    let indexed_added_total_clone = indexed_added_total.clone();

    let pool2 = rayon::ThreadPoolBuilder::new()
        .num_threads(num_cpus())
        .build()
        .map_err(|e| e.to_string())?;

    pool2.install(|| {
        transfer_plan.par_iter().for_each(|file_info| {
            if wait_if_process_paused_or_aborted(job_id_clone.as_deref()) {
                return;
            }

            if !matches!(file_info.status, FileTransferStatus::ToTransfer) {
                return; // Skip non-transfer files
            }

            let file_name_str = file_info.source_path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            // Create destination directory
            if let Some(parent) = file_info.destination_path.parent() {
                if let Err(e) = fs::create_dir_all(parent) {
                    let parent_canonical = parent.canonicalize().unwrap_or_else(|_| parent.to_path_buf());
                    let msg = format!("DIRECTORY_CREATE_ERROR: path=[absolute='{}'] error=[{}]", parent_canonical.display(), e);
                    copy_errors_clone.lock().unwrap().push(msg.clone());
                    if let Some(ref jid) = job_id_clone {
                        append_process_job_log(jid, &msg);
                    }
                    return;
                }
            }

            // Copy file
            match fs::copy(&file_info.source_path, &file_info.destination_path) {
                Ok(bytes) => {
                    bytes_clone.fetch_add(bytes, Ordering::Relaxed);
                    let rel_dest_path = file_info
                        .destination_path
                        .strip_prefix(&archive_for_copy)
                        .map(|p| p.to_string_lossy().replace('\\', "/").to_string())
                        .unwrap_or_else(|_| file_name_str.clone());
                    copied_files_clone
                        .lock()
                        .unwrap()
                        .push((rel_dest_path.clone(), file_info.local_hash.clone()));
                    pending_hash_updates_clone
                        .lock()
                        .unwrap()
                        .push((rel_dest_path.clone(), file_info.local_hash.clone()));

                    let done = copy_done_clone.fetch_add(1, Ordering::Relaxed) + 1;
                    
                    if let Some(ref jid) = job_id_clone {
                        append_process_job_log(
                            jid,
                            format!(
                                "FILE_COPIED: source=[absolute='{}'] destination=[absolute='{}'] rel_path='{}' hash='{}' size_bytes={}",
                                file_info.source_path.display(),
                                file_info.destination_path.display(),
                                rel_dest_path,
                                &file_info.local_hash[..8],
                                bytes
                            ),
                        );
                    }
                    let elapsed = start_time.elapsed().as_secs_f64();
                    let speed = if elapsed > 0.0 {
                        (bytes_clone.load(Ordering::Relaxed) as f64 / (1024.0 * 1024.0)) / elapsed
                    } else {
                        0.0
                    };

                    if let Some(ref jid) = job_id_clone {
                        update_process_job(jid, |job| {
                            job.done = done as usize;
                            job.processed = done as usize;
                            job.speed_mbps = Some(speed);
                            job.current_file = file_name_str.clone();
                            job.transfer_uploaded_count = Some(done as usize);
                        });
                    }

                    update_transfer_status_line(
                        job_id_clone.as_deref(),
                        "copy",
                        done as usize,
                        to_transfer_count,
                        &file_name_str,
                        Some(speed),
                    );

                    let _ = app_clone.emit(
                        "process-progress",
                        ProcessProgress {
                            total: to_transfer_count,
                            done: done as usize,
                            current_file: file_name_str,
                            phase: "transfer_copy".to_string(),
                            speed_mbps: Some(speed),
                        },
                    );

                    if done % MASTER_HASH_FLUSH_EVERY_COPIES == 0 {
                        let _flush_guard = index_flush_lock_clone.lock().unwrap();
                        let batch = {
                            let mut pending = pending_hash_updates_clone.lock().unwrap();
                            std::mem::take(&mut *pending)
                        };

                        if !batch.is_empty() {
                            let batch_desc = batch.iter()
                                .map(|(path, hash)| format!("{}[{}]", path, &hash[..8]))
                                .collect::<Vec<_>>()
                                .join(", ");
                            let master_hash_path_for_log = resolve_master_hash_table_path(&archive_for_copy);
                            let master_hash_path_canonical_for_log = master_hash_path_for_log.canonicalize().unwrap_or_else(|_| master_hash_path_for_log.clone());
                            
                            match atomic_update_master_hash_table(&archive_for_copy, &batch) {
                                Ok(added_count) => {
                                    let total_added = indexed_added_total_clone
                                        .fetch_add(added_count as u64, Ordering::Relaxed)
                                        + added_count as u64;
                                    if let Some(ref jid) = job_id_clone {
                                        update_process_job(jid, |job| {
                                            job.transfer_indexed_added_count = Some(total_added as usize);
                                        });
                                        append_process_job_log(
                                            jid,
                                            format!(
                                                "HASH_TABLE_UPDATE_INCREMENTAL: file=[absolute='{}'] batch_size={} entries_added={} cumulative_entries={} entries=[{}]",
                                                master_hash_path_canonical_for_log.display(),
                                                batch.len(),
                                                added_count,
                                                total_added,
                                                batch_desc
                                            ),
                                        );
                                    }
                                }
                                Err(e) => {
                                    let msg = format!(
                                        "HASH_TABLE_UPDATE_ERROR: file=[absolute='{}'] after_copied={} error=[{}]",
                                        master_hash_path_canonical_for_log.display(),
                                        done,
                                        e
                                    );
                                    copy_errors_clone.lock().unwrap().push(msg.clone());
                                    if let Some(ref jid) = job_id_clone {
                                        append_process_job_log(jid, &msg);
                                    }
                                }
                            }
                        }
                    }
                }
                Err(e) => {
                    let msg = format!("FILE_COPY_ERROR: source=[absolute='{}'] destination=[absolute='{}'] error=[{}]", file_info.source_path.display(), file_info.destination_path.display(), e);
                    copy_errors_clone.lock().unwrap().push(msg.clone());
                    if let Some(ref jid) = job_id_clone {
                        append_process_job_log(jid, &msg);
                    }
                }
            }
        });
    });

    {
        let _flush_guard = index_flush_lock.lock().unwrap();
        let remaining_batch = {
            let mut pending = pending_hash_updates.lock().unwrap();
            std::mem::take(&mut *pending)
        };

        if !remaining_batch.is_empty() {
            let remaining_batch_desc = remaining_batch.iter()
                .map(|(path, hash)| format!("{}[{}]", path, &hash[..8]))
                .collect::<Vec<_>>()
                .join(", ");
            let master_hash_path_final = resolve_master_hash_table_path(&archive);
            let master_hash_path_canonical_final = master_hash_path_final.canonicalize().unwrap_or_else(|_| master_hash_path_final.clone());
            
            match atomic_update_master_hash_table(&archive, &remaining_batch) {
                Ok(added_count) => {
                    let total_added = indexed_added_total
                        .fetch_add(added_count as u64, Ordering::Relaxed)
                        + added_count as u64;
                    if let Some(ref jid) = job_id {
                        update_process_job(jid, |job| {
                            job.transfer_indexed_added_count = Some(total_added as usize);
                        });
                        append_process_job_log(
                            jid,
                            format!(
                                "HASH_TABLE_UPDATE_FINAL: file=[absolute='{}'] batch_size={} entries_added={} cumulative_entries={} entries=[{}]",
                                master_hash_path_canonical_final.display(),
                                remaining_batch.len(),
                                added_count,
                                total_added,
                                remaining_batch_desc
                            ),
                        );
                    }
                }
                Err(e) => {
                    let msg = format!("HASH_TABLE_UPDATE_FINAL_ERROR: file=[absolute='{}'] error=[{}]", master_hash_path_canonical_final.display(), e);
                    overall_errors.push(msg.clone());
                    if let Some(ref jid) = job_id {
                        append_process_job_log(jid, &msg);
                    }
                }
            }
        }
    }

    overall_errors.extend(copy_errors.lock().unwrap().clone());
    let copied_files_final = copied_files.lock().unwrap().clone();
    let copied = copied_files_final.len();

    let was_aborted = job_id
        .as_ref()
        .and_then(|id| process_jobs_store().lock().ok().and_then(|jobs| jobs.get(id).map(|j| j.abort_requested)))
        .unwrap_or(false);

    if was_aborted {
        if let Some(ref jid) = job_id {
            update_process_job(jid, |job| {
                job.status = ProcessJobStatus::Aborted;
                job.finished_at = Some(now_string());
                job.current_file = "Aborted".to_string();
            });
            append_process_job_log(jid, format!("aborted during copy phase: copied={}", copied));
        }
        return Ok(TransferResult {
            copied,
            verified: 0,
            deduplicated: deduplicated_count,
            renamed: renamed_count,
            errors: overall_errors,
        });
    }

    // PHASE 5: Update master hash table atomically
    if let Some(ref jid) = job_id {
        update_process_job(jid, |job| {
            job.current_file = "Updating master hash table".to_string();
            job.current_phase = Some("update_master_hashes".to_string());
            job.done = to_transfer_count;
        });
        append_process_job_log(jid, "updating master hash table");
    }

    let mut backfill_added_count = 0usize;

    let mut deduped_stale_paths = HashSet::<String>::new();
    for path in stale_hash_paths {
        deduped_stale_paths.insert(path);
    }
    let stale_hash_paths = deduped_stale_paths.into_iter().collect::<Vec<_>>();

    if !hash_backfill_entries.is_empty() || !stale_hash_paths.is_empty() {
        let backfill_hash_path = resolve_master_hash_table_path(&archive);
        let backfill_hash_path_canonical = backfill_hash_path.canonicalize().unwrap_or_else(|_| backfill_hash_path.clone());
        let mut stale_paths_by_hash = BTreeMap::<String, Vec<String>>::new();
        for path in &stale_hash_paths {
            let hash = server_hash_table
                .path_to_hash
                .get(path)
                .cloned()
                .unwrap_or_else(|| "unknown".to_string());
            stale_paths_by_hash
                .entry(hash)
                .or_default()
                .push(path.clone());
        }
        
        if let Some(ref jid) = job_id {
            for (path, hash) in &hash_backfill_entries {
                append_process_job_log(
                    jid,
                    format!(
                        "HASH_TABLE_BACKFILL_QUEUED: path='{}' hash='{}' -> will be written to [absolute='{}']",
                        path,
                        &hash[..8],
                        backfill_hash_path_canonical.display()
                    ),
                );
            }
            if !stale_hash_paths.is_empty() {
                append_process_job_log(
                    jid,
                    format!(
                        "HASH_TABLE_STALE_SUMMARY: unique_hashes={} stale_paths={} target=[absolute='{}']",
                        stale_paths_by_hash.len(),
                        stale_hash_paths.len(),
                        backfill_hash_path_canonical.display()
                    ),
                );
                for (hash, paths) in &stale_paths_by_hash {
                    let sample = paths
                        .iter()
                        .take(3)
                        .cloned()
                        .collect::<Vec<_>>()
                        .join(", ");
                    append_process_job_log(
                        jid,
                        format!(
                            "HASH_TABLE_STALE_BY_HASH: hash='{}' stale_paths={} sample_paths=[{}]",
                            &hash[..hash.len().min(8)],
                            paths.len(),
                            sample
                        ),
                    );
                }
            }
        }
        
        match atomic_reconcile_master_hash_table(&archive, &hash_backfill_entries, &stale_hash_paths) {
            Ok((added_count, removed_count)) => {
                backfill_added_count = added_count;
                let total_added = indexed_added_total.load(Ordering::Relaxed) as usize + backfill_added_count;
                if let Some(ref jid) = job_id {
                    update_process_job(jid, |job| {
                        job.transfer_indexed_added_count = Some(total_added);
                    });
                    append_process_job_log(
                        jid,
                        format!(
                            "HASH_TABLE_RECONCILED: file=[absolute='{}'] backfill_entries={} entries_added={} stale_entries_removed={} cumulative_total={}",
                            backfill_hash_path_canonical.display(),
                            hash_backfill_entries.len(),
                            added_count,
                            removed_count,
                            total_added
                        ),
                    );
                }
            }
            Err(e) => {
                let msg = format!(
                    "HASH_TABLE_BACKFILL_ERROR: file=[absolute='{}'] error=[{}]",
                    backfill_hash_path_canonical.display(),
                    e
                );
                overall_errors.push(msg.clone());
                if let Some(ref jid) = job_id {
                    append_process_job_log(jid, &msg);
                }
            }
        }
    } else if let Some(ref jid) = job_id {
        append_process_job_log(jid, "HASH_TABLE_RECONCILE_SKIPPED: no backfill entries and no stale paths to remove");
    }

    if let Some(ref jid) = job_id {
        let total_added = indexed_added_total.load(Ordering::Relaxed) as usize + backfill_added_count;
        update_process_job(jid, |job| {
            job.transfer_indexed_added_count = Some(total_added);
        });
    }

    let failed = !overall_errors.is_empty();
    if let Some(ref jid) = job_id {
        update_process_job(jid, |job| {
            job.status = if failed { ProcessJobStatus::Failed } else { ProcessJobStatus::Completed };
            job.finished_at = Some(now_string());
            job.current_file = "Done".to_string();
            job.current_phase = Some("done".to_string());
            job.errors = overall_errors.clone();
            job.result_count = copied;
        });
        append_process_job_log(
            jid,
            format!(
                "complete: copied={} deduplicated={} renamed={} errors={}",
                copied,
                deduplicated_count,
                renamed_count,
                overall_errors.len()
            ),
        );
    }

    let _ = crate::utils::append_app_log(
        &app,
        format!(
            "process_transfer complete: copied={} deduplicated={} renamed={} errors={}",
            copied,
            deduplicated_count,
            renamed_count,
            overall_errors.len()
        ),
    );

    Ok(TransferResult {
        copied,
        verified: copied,
        deduplicated: deduplicated_count,
        renamed: renamed_count,
        errors: overall_errors,
    })
}

fn run_verify_task(
    app: AppHandle,
    archive_dir: String,
    checksum_path: PathBuf,
    job_id: Option<String>,
) -> Result<TransferResult, String> {
    let archive = PathBuf::from(&archive_dir);
    let content = fs::read_to_string(&checksum_path).map_err(|e| e.to_string())?;
    let entries: Vec<(String, PathBuf)> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(2, "  ").collect();
            if parts.len() == 2 {
                Some((
                    parts[0].to_string(),
                    archive.join(parts[1].trim()),
                ))
            } else {
                None
            }
        })
        .collect();

    let total = entries.len();

    if let Some(ref jid) = job_id {
        update_process_job(jid, |job| {
            job.status = ProcessJobStatus::Running;
            job.started_at = Some(now_string());
            job.current_file = "Starting verify".to_string();
            job.current_phase = Some("verify_checksums".to_string());
            job.total = total;
        });
        append_process_job_log(
            jid,
            format!(
                "start verify checksums archive='{}' manifest='{}' entries={}",
                archive.display(),
                checksum_path.display(),
                total
            ),
        );
        if total == 0 {
            append_process_job_log(jid, "verify manifest contains no checksum entries");
        }
    }
    let _ = crate::utils::append_app_log(
        &app,
        format!(
            "process_verify start archive='{}' manifest='{}' entries={}",
            archive.display(),
            checksum_path.display(),
            total
        ),
    );

    let done_count = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));

    let app_clone = app.clone();
    let job_id_clone = job_id.clone();
    let done_clone = done_count.clone();
    let errors_clone = errors.clone();

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(num_cpus())
        .build()
        .map_err(|e| e.to_string())?;

    pool.install(|| {
        entries.par_iter().for_each(|(expected_hash, path)| {
            if wait_if_process_paused_or_aborted(job_id_clone.as_deref()) {
                return;
            }

            let file_name_str = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();

            let result = (|| -> anyhow::Result<()> {
                if !path.exists() {
                    anyhow::bail!("File not found: {}", path.display());
                }
                let actual_hash = compute_md5(path)?;
                if actual_hash != *expected_hash {
                    anyhow::bail!(
                        "Hash mismatch for {}: expected {} got {}",
                        path.display(),
                        expected_hash,
                        actual_hash
                    );
                }
                Ok(())
            })();

            if let Err(e) = result {
                let msg = e.to_string();
                errors_clone.lock().unwrap().push(msg.clone());
                if let Some(ref jid) = job_id_clone {
                    append_process_job_log(jid, format!("verify error: {}", msg));
                }
            }

            let done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;

            if let Some(ref jid) = job_id_clone {
                update_process_job(jid, |job| {
                    job.done = done as usize;
                    job.processed = done as usize;
                    job.current_file = file_name_str.clone();
                });
            }

            update_transfer_status_line(
                job_id_clone.as_deref(),
                "verify",
                done as usize,
                total,
                &file_name_str,
                None,
            );

            let _ = app_clone.emit(
                "process-progress",
                ProcessProgress {
                    total,
                    done: done as usize,
                    current_file: file_name_str,
                    phase: "verify_checksums".to_string(),
                    speed_mbps: None,
                },
            );
        });
    });

    let verified = done_count.load(Ordering::Relaxed) as usize;
    let final_errors = errors.lock().unwrap().clone();
    
    let was_aborted = job_id
        .as_ref()
        .and_then(|id| process_jobs_store().lock().ok().and_then(|jobs| jobs.get(id).map(|j| j.abort_requested)))
        .unwrap_or(false);

    if let Some(ref jid) = job_id {
        update_process_job(jid, |job| {
            job.status = if was_aborted { ProcessJobStatus::Aborted } else if !final_errors.is_empty() { ProcessJobStatus::Failed } else { ProcessJobStatus::Completed };
            job.finished_at = Some(now_string());
            job.current_file = "Done".to_string();
            job.current_phase = Some("done".to_string());
            job.errors = final_errors.clone();
            job.result_count = verified;
        });
        append_process_job_log(jid, format!("complete verified={} errors={}", verified, final_errors.len()));
    }
    let _ = crate::utils::append_app_log(&app, format!("process_verify complete verified={} errors={}", verified, final_errors.len()));

    Ok(TransferResult {
        copied: 0,
        verified,
        deduplicated: 0,
        renamed: 0,
        errors: final_errors,
    })
}

