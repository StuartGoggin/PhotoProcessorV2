use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    pub errors: Vec<String>,
}

const LEGACY_CHECKSUM_FILE_NAME: &str = "checksums.md5";
const TRANSFER_MANIFEST_DIR_NAME: &str = "_transfer_manifests";

#[derive(Debug, Clone)]
struct MasterManifestConflict {
    relative_path: String,
    existing_hash: String,
    incoming_hash: String,
}

fn should_log_progress(done: usize, total: usize) -> bool {
    total <= 20 || done <= 3 || done == total || done % 25 == 0
}

fn append_transfer_progress_log(
    job_id: Option<&str>,
    phase: &str,
    done: usize,
    total: usize,
    current_file: &str,
    speed_mbps: Option<f64>,
) {
    if !should_log_progress(done, total) {
        return;
    }

    if let Some(job_id) = job_id {
        let speed_suffix = speed_mbps
            .map(|speed| format!(" speed={:.1} MB/s", speed))
            .unwrap_or_default();
        append_process_job_log(
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
    path.file_name()
        .and_then(|name| name.to_str())
        .map(|name| name == LEGACY_CHECKSUM_FILE_NAME)
        .unwrap_or(false)
        || is_transfer_manifest_path(path)
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

fn build_transfer_manifest_path(archive: &Path, job_id: Option<&str>) -> Result<PathBuf, String> {
    build_transfer_output_path(archive, "transfer", "md5", job_id)
}

fn build_transfer_conflict_report_path(archive: &Path, job_id: Option<&str>) -> Result<PathBuf, String> {
    build_transfer_output_path(archive, "transfer-conflicts", "txt", job_id)
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

fn resolve_checksum_manifest_path(archive: &Path) -> Result<PathBuf, String> {
    if let Some(manifest_path) = latest_transfer_manifest_path(archive)? {
        return Ok(manifest_path);
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

fn update_master_checksum_manifest(
    archive: &Path,
    checksum_lines: &[String],
) -> Result<(PathBuf, usize, usize, Vec<MasterManifestConflict>), String> {
    let manifest_path = archive.join(LEGACY_CHECKSUM_FILE_NAME);
    let mut existing_content = String::new();
    let mut existing_paths = std::collections::HashSet::<String>::new();
    let mut existing_hashes = HashMap::<String, String>::new();
    let mut skipped_invalid_existing_lines = 0usize;

    if manifest_path.exists() {
        existing_content = fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
        for line in existing_content.lines().filter(|line| !line.trim().is_empty()) {
            if let Some((relative_path, hash)) = parse_checksum_line(line) {
                existing_paths.insert(relative_path.clone());
                existing_hashes.insert(relative_path, hash);
            } else {
                skipped_invalid_existing_lines += 1;
            }
        }
    }

    let mut appended_entries = Vec::new();
    let mut added_entries = 0usize;
    let mut conflicts = Vec::new();
    for checksum_line in checksum_lines {
        if let Some((relative_path, incoming_hash)) = parse_checksum_line(checksum_line) {
            if existing_paths.insert(relative_path) {
                appended_entries.push(checksum_line.clone());
                added_entries += 1;
            } else {
                conflicts.push(MasterManifestConflict {
                    relative_path: checksum_line
                        .splitn(2, "  ")
                        .nth(1)
                        .unwrap_or_default()
                        .trim()
                        .to_string(),
                    existing_hash: existing_hashes
                        .get(
                            checksum_line
                                .splitn(2, "  ")
                                .nth(1)
                                .unwrap_or_default()
                                .trim(),
                        )
                        .cloned()
                        .unwrap_or_default(),
                    incoming_hash,
                });
            }
        }
    }

    if !appended_entries.is_empty() {
        if !existing_content.is_empty() && !existing_content.ends_with('\n') && !existing_content.ends_with('\r') {
            existing_content.push('\n');
        }
        existing_content.push_str(&appended_entries.join("\n"));
        fs::write(&manifest_path, existing_content).map_err(|e| e.to_string())?;
    }

    Ok((
        manifest_path,
        added_entries,
        skipped_invalid_existing_lines,
        conflicts,
    ))
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
        errors: vec![],
        logs: vec![format!("[{}] queued transfer", now_string())],
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
        errors: vec![],
        logs: vec![format!("[{}] queued verify checksums", now_string())],
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
    let mut overall_errors = Vec::new();

    if let Some(ref jid) = job_id {
        update_process_job(jid, |job| {
            job.status = ProcessJobStatus::Running;
            job.started_at = Some(now_string());
            job.current_file = "Starting copy".to_string();
            job.conflict_report_path = None;
            job.current_phase = Some("transfer_copy".to_string());
            // Setup a progress bar that scales to 2N (copy phase + MD5 phase)
            job.total = files.len() * 2; 
        });
        append_process_job_log(jid, format!("start transfer staging='{}' archive='{}'", staging.display(), archive.display()));
        if files.is_empty() {
            append_process_job_log(jid, "no transferable files found in staging directory");
        }
    }
    let _ = crate::utils::append_app_log(&app, format!("process_transfer start staging='{}' archive='{}'", staging.display(), archive.display()));

    let done_count = Arc::new(AtomicU64::new(0));
    let bytes_copied = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let copied_files = Arc::new(std::sync::Mutex::new(Vec::<PathBuf>::new()));
    let start_time = std::time::Instant::now();

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(8)
        .build()
        .map_err(|e| e.to_string())?;

    let app_clone = app.clone();
    let job_id_clone = job_id.clone();
    let done_clone = done_count.clone();
    let bytes_clone = bytes_copied.clone();
    let errors_clone = errors.clone();
    let copied_files_clone = copied_files.clone();

    pool.install(|| {
        files.par_iter().for_each(|src| {
            if wait_if_process_paused_or_aborted(job_id_clone.as_deref()) {
                return;
            }

            let rel = src.strip_prefix(&staging).unwrap_or(src);
            let dest = archive.join(rel);

            let result = (|| -> anyhow::Result<u64> {
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent)?;
                }
                let bytes = fs::copy(src, &dest)?;
                Ok(bytes)
            })();

            let file_name_str = src.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();

            match result {
                Ok(bytes) => {
                    copied_files_clone.lock().unwrap().push(dest.clone());
                    bytes_clone.fetch_add(bytes, Ordering::Relaxed);
                    let done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;
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
                        });
                    }

                    append_transfer_progress_log(
                        job_id_clone.as_deref(),
                        "copy",
                        done as usize,
                        files.len(),
                        &file_name_str,
                        Some(speed),
                    );

                    let _ = app_clone.emit(
                        "process-progress",
                        ProcessProgress {
                            total: files.len() * 2,
                            done: done as usize,
                            current_file: file_name_str,
                            phase: "transfer_copy".to_string(),
                            speed_mbps: Some(speed),
                        },
                    );
                }
                Err(e) => {
                    let msg = format!("{}: {}", src.display(), e);
                    errors_clone.lock().unwrap().push(msg.clone());
                    if let Some(ref jid) = job_id_clone {
                        append_process_job_log(jid, format!("copy error: {}", msg));
                    }
                }
            }
        });
    });

    let copied_destinations = copied_files.lock().unwrap().clone();
    let copied = copied_destinations.len();
    overall_errors.extend(errors.lock().unwrap().clone());

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
            append_process_job_log(jid, format!("aborted copied={}", copied));
        }
        return Ok(TransferResult { copied, verified: 0, errors: overall_errors });
    }

    // Manifest phase: hash only the files copied by this transfer and store them separately.
    
    if let Some(ref jid) = job_id {
        update_process_job(jid, |job| {
            job.total = copied + copied_destinations.len();
            job.current_file = "Starting checksums".to_string();
            job.current_phase = Some("transfer_md5".to_string());
            job.speed_mbps = None;
        });
        append_process_job_log(
            jid,
            format!(
                "starting per-transfer checksum generation phase copied_files={}",
                copied_destinations.len()
            ),
        );
        if copied_destinations.is_empty() {
            append_process_job_log(jid, "checksum phase has no copied files to hash");
        }
    }

    let md5_errors = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let checksums = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let md5_errors_clone = md5_errors.clone();
    let checksums_clone = checksums.clone();

    let pool2 = rayon::ThreadPoolBuilder::new()
        .num_threads(crate::utils::num_cpus())
        .build()
        .map_err(|e| e.to_string())?;

    pool2.install(|| {
        copied_destinations.par_iter().for_each(|path| {
            if wait_if_process_paused_or_aborted(job_id_clone.as_deref()) {
                return;
            }

            let file_name_str = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();

            match compute_md5(path) {
                Ok(hash) => {
                    let rel = path
                        .strip_prefix(&archive)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .replace('\\', "/");
                    checksums_clone.lock().unwrap().push(format!("{}  {}", hash, rel));
                    
                    let done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;

                    if let Some(ref jid) = job_id_clone {
                        update_process_job(jid, |job| {
                            job.done = done as usize;
                            job.processed = done as usize;
                            job.current_file = file_name_str.clone();
                        });
                    }

                    append_transfer_progress_log(
                        job_id_clone.as_deref(),
                        "checksum",
                        done as usize - copied,
                        copied_destinations.len(),
                        &file_name_str,
                        None,
                    );

                    let _ = app_clone.emit(
                        "process-progress",
                        ProcessProgress {
                            total: copied + copied_destinations.len(),
                            done: done as usize,
                            current_file: file_name_str,
                            phase: "transfer_md5".to_string(),
                            speed_mbps: None,
                        },
                    );
                }
                Err(e) => {
                    let msg = format!("{}: {}", path.display(), e);
                    md5_errors_clone.lock().unwrap().push(msg.clone());
                    if let Some(ref jid) = job_id_clone {
                        append_process_job_log(jid, format!("md5 error: {}", msg));
                    }
                }
            }
        });
    });

    overall_errors.extend(md5_errors.lock().unwrap().clone());
    let verified = checksums.lock().unwrap().len();

    let was_aborted_2 = job_id
        .as_ref()
        .and_then(|id| process_jobs_store().lock().ok().and_then(|jobs| jobs.get(id).map(|j| j.abort_requested)))
        .unwrap_or(false);

    if was_aborted_2 {
        if let Some(ref jid) = job_id {
            update_process_job(jid, |job| {
                job.status = ProcessJobStatus::Aborted;
                job.finished_at = Some(now_string());
                job.current_file = "Aborted".to_string();
            });
            append_process_job_log(jid, format!("aborted after md5 phase verified={}", verified));
        }
        return Ok(TransferResult { copied, verified, errors: overall_errors });
    }

    if let Some(ref jid) = job_id {
        update_process_job(jid, |job| {
            job.current_file = "Writing transfer manifest".to_string();
            job.current_phase = Some("transfer_manifest".to_string());
        });
    }

    // Write per-transfer checksum manifest.
    let mut all_checksums = checksums.lock().unwrap().clone();
    all_checksums.sort();
    let checksum_path = build_transfer_manifest_path(&archive, job_id.as_deref())?;
    if let Some(parent) = checksum_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Err(e) = fs::write(&checksum_path, all_checksums.join("\n")) {
        let err_msg = format!("Failed to write checksums: {}", e);
        overall_errors.push(err_msg.clone());
        if let Some(ref jid) = job_id {
            append_process_job_log(jid, err_msg);
        }
    } else if let Some(ref jid) = job_id {
        append_process_job_log(
            jid,
            format!("wrote transfer manifest '{}'", checksum_path.display()),
        );
    }

    if let Some(ref jid) = job_id {
        update_process_job(jid, |job| {
            job.current_file = "Updating master manifest".to_string();
            job.current_phase = Some("transfer_master_manifest".to_string());
        });
    }

    match update_master_checksum_manifest(&archive, &all_checksums) {
        Ok((master_manifest_path, added_entries, skipped_invalid_existing_lines, conflicts)) => {
            let conflict_count = conflicts.len();
            let mut conflict_report_path = None;

            if !conflicts.is_empty() {
                match build_transfer_conflict_report_path(&archive, job_id.as_deref()) {
                    Ok(report_path) => {
                        if let Some(parent) = report_path.parent() {
                            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                        }

                        let mut report_lines = vec![
                            format!("Transfer job: {}", job_id.as_deref().unwrap_or("manual")),
                            format!("Archive: {}", archive.display()),
                            format!("Master manifest: {}", master_manifest_path.display()),
                            format!("Duplicate path collisions: {}", conflict_count),
                            String::new(),
                        ];

                        report_lines.extend(conflicts.iter().map(|conflict| {
                            format!(
                                "path={} existing_hash={} incoming_hash={}",
                                conflict.relative_path, conflict.existing_hash, conflict.incoming_hash
                            )
                        }));

                        match fs::write(&report_path, report_lines.join("\n")) {
                            Ok(_) => {
                                if let Some(ref jid) = job_id {
                                    update_process_job(jid, |job| {
                                        job.conflict_report_path = Some(report_path.display().to_string());
                                    });
                                }
                                conflict_report_path = Some(report_path);
                            }
                            Err(e) => {
                                let err_msg = format!("Failed to write duplicate collision report: {}", e);
                                overall_errors.push(err_msg.clone());
                                if let Some(ref jid) = job_id {
                                    append_process_job_log(jid, err_msg);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let err_msg = format!("Failed to build duplicate collision report path: {}", e);
                        overall_errors.push(err_msg.clone());
                        if let Some(ref jid) = job_id {
                            append_process_job_log(jid, err_msg);
                        }
                    }
                }
            }

            if let Some(ref jid) = job_id {
                append_process_job_log(
                    jid,
                    format!(
                        "updated master manifest '{}' entries_appended={} duplicate_path_collisions={} skipped_invalid_existing_lines={}",
                        master_manifest_path.display(),
                        added_entries,
                        conflict_count,
                        skipped_invalid_existing_lines
                    ),
                );

                if !conflicts.is_empty() {
                    let preview_paths = conflicts
                        .iter()
                        .take(5)
                        .map(|conflict| conflict.relative_path.as_str())
                        .collect::<Vec<_>>()
                        .join(", ");
                    append_process_job_log(
                        jid,
                        format!(
                            "duplicate path collisions detected: {}{}",
                            preview_paths,
                            if conflict_count > 5 { " ..." } else { "" }
                        ),
                    );

                    if let Some(report_path) = conflict_report_path {
                        append_process_job_log(
                            jid,
                            format!("wrote duplicate collision report '{}'", report_path.display()),
                        );
                    }
                }
            }
        }
        Err(e) => {
            let err_msg = format!("Failed to update master checksums: {}", e);
            overall_errors.push(err_msg.clone());
            if let Some(ref jid) = job_id {
                append_process_job_log(jid, err_msg);
            }
        }
    }

    let failed = !overall_errors.is_empty();
    if let Some(ref jid) = job_id {
        update_process_job(jid, |job| {
            job.status = if failed { ProcessJobStatus::Failed } else { ProcessJobStatus::Completed };
            job.finished_at = Some(now_string());
            job.current_file = "Done".to_string();
            job.current_phase = Some("done".to_string());
            job.errors = overall_errors.clone();
            job.result_count = verified;
        });
        append_process_job_log(jid, format!("complete copied={} verified={} errors={}", copied, verified, overall_errors.len()));
    }

    let _ = crate::utils::append_app_log(&app, format!("process_transfer complete copied={} verified={} errors={}", copied, verified, overall_errors.len()));

    Ok(TransferResult {
        copied,
        verified,
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

            append_transfer_progress_log(
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
        errors: final_errors,
    })
}
