use image::{DynamicImage, GrayImage, ImageBuffer, Luma, Rgb, RgbImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::async_runtime;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;
use crate::utils::{
    append_app_log, describe_locking_processes, format_rename_error,
    is_retryable_windows_lock_error, num_cpus, sync_file_metadata_from,
};
use super::naming::{
    apply_event_naming_plan_once, build_event_naming_plans, load_catalog_internal,
    merge_event_naming_request_into_catalog, save_catalog_internal, scan_catalog_from_root,
    ApplyEventNamingRequest,
};
use super::settings::load_settings;
use super::faces;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessProgress {
    pub total: usize,
    pub done: usize,
    pub current_file: String,
    pub phase: String,
    pub speed_mbps: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessResult {
    pub processed: usize,
    pub result_count: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessTask {
    Focus,
    RemoveFocus,
    Enhance,
    RemoveEnhance,
    Bw,
    RemoveBw,
    Stabilize,
    RemoveStabilize,
    ScanArchiveNaming,
    ApplyEventNaming,
    Transfer,
    VerifyChecksums,
    ScanFaces,
    SearchPersonVideos,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessScopeMode {
    EntireStaging,
    FolderRecursive,
    FolderOnly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessJobStatus {
    Queued,
    Running,
    Paused,
    Aborted,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessJob {
    pub id: String,
    pub task: ProcessTask,
    pub staging_dir: String,
    pub scope_dir: String,
    pub scope_mode: ProcessScopeMode,
    pub status: ProcessJobStatus,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub total: usize,
    pub done: usize,
    pub processed: usize,
    pub result_count: usize,
    pub current_file: String,
    pub archive_dir: Option<String>,
    pub conflict_report_path: Option<String>,
    pub current_phase: Option<String>,
    pub speed_mbps: Option<f64>,
    pub transfer_local_processed_count: Option<usize>,
    pub transfer_local_sidecar_hits_count: Option<usize>,
    pub transfer_local_manifest_hits_count: Option<usize>,
    pub transfer_local_hash_computed_count: Option<usize>,
    pub transfer_uploaded_count: Option<usize>,
    pub transfer_deduplicated_count: Option<usize>,
    pub transfer_renamed_count: Option<usize>,
    pub transfer_server_hash_match_count: Option<usize>,
    pub transfer_server_hash_unverified_count: Option<usize>,
    pub transfer_indexed_added_count: Option<usize>,
    pub stabilization_mode: Option<StabilizationMode>,
    pub stabilization_strength: Option<StabilizationStrength>,
    pub preserve_source_bitrate: Option<bool>,
    pub stabilize_max_parallel_jobs_used: Option<usize>,
    pub stabilize_ffmpeg_threads_per_job_used: Option<usize>,
    pub frames_per_second: Option<usize>,
    pub similarity_threshold: Option<f32>,
    pub videos_scanned: Option<usize>,
    pub faces_detected: Option<usize>,
    pub unique_people: Option<usize>,
    pub person_name: Option<String>,
    pub errors: Vec<String>,
    pub logs: Vec<String>,
    pub status_line: String,  // Single line that updates in-place
    pub pause_requested: bool,
    pub abort_requested: bool,
}

fn run_archive_naming_scan_task(
    app: AppHandle,
    archive_root: String,
    scope_dir: Option<String>,
    scope_mode: Option<ProcessScopeMode>,
    job_id: Option<String>,
) -> Result<ProcessResult, String> {
    let scope_mode = scope_mode.unwrap_or(ProcessScopeMode::FolderRecursive);
    let scope = resolve_process_scope(&archive_root, scope_dir, &scope_mode)?;
    let task_label = task_name(&ProcessTask::ScanArchiveNaming);
    let existing_catalog = load_catalog_internal(&app).unwrap_or_default();
    let progress_job_id = job_id.clone();

    if let Some(job_id) = &job_id {
        update_process_job(job_id, |job| {
            job.status = ProcessJobStatus::Running;
            job.started_at = Some(now_string());
            job.current_file = "Starting".to_string();
            job.scope_dir = scope.to_string_lossy().into_owned();
            job.scope_mode = scope_mode.clone();
        });
        append_process_job_log(
            job_id,
            format!(
                "start task={} archive_root='{}' scope='{}' scope_mode={:?}",
                task_label,
                archive_root,
                scope.display(),
                scope_mode
            ),
        );
    }

    let _ = append_app_log(
        &app,
        format!(
            "process_{} start archive_root='{}' scope='{}' scope_mode={:?}",
            task_label,
            archive_root,
            scope.display(),
            scope_mode
        ),
    );

    let mut total_candidates = 0usize;
    let mut last_done = 0usize;
    let discovered_total = 0usize;

    let scan_result = scan_catalog_from_root(existing_catalog, &scope, |index, total, path| {
            if wait_if_process_paused_or_aborted(progress_job_id.as_deref()) {
                return Err("Archive scan aborted".to_string());
            }

            total_candidates = total;
            let current_file = path
                .strip_prefix(&scope)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");

            if let Some(job_id) = &progress_job_id {
                update_process_job(job_id, |job| {
                    job.status = ProcessJobStatus::Running;
                    if job.started_at.is_none() {
                        job.started_at = Some(now_string());
                    }
                    job.total = total;
                    job.done = index;
                    job.processed = index;
                    job.result_count = discovered_total;
                    job.current_file = current_file.clone();
                    job.scope_dir = scope.to_string_lossy().into_owned();
                    job.scope_mode = scope_mode.clone();
                });
            }

            let _ = app.emit(
                "process-progress",
                ProcessProgress {
                    total,
                    done: index,
                    current_file: current_file,
                    phase: task_label.to_string(),
                    speed_mbps: None,
                },
            );

            last_done = index;
            Ok(())
        });

    let (catalog, discovered_directories, scanned_directories) = match scan_result {
        Ok(result) => result,
        Err(err) if err == "Archive scan aborted" => {
            if let Some(job_id) = &job_id {
                update_process_job(job_id, |job| {
                    job.status = ProcessJobStatus::Aborted;
                    job.finished_at = Some(now_string());
                    job.done = last_done;
                    job.processed = last_done;
                    job.current_file = "Aborted".to_string();
                });
                append_process_job_log(job_id, format!("aborted scanned={} matched_named_directories={}", last_done, discovered_total));
            }
            let _ = append_app_log(
                &app,
                format!(
                    "process_{} aborted scanned={} matched_named_directories={} scope_mode={:?}",
                    task_label,
                    last_done,
                    discovered_total,
                    scope_mode
                ),
            );
            return Ok(ProcessResult {
                processed: last_done,
                result_count: discovered_total,
                errors: vec![],
            });
        }
        Err(err) => return Err(err),
    };

    save_catalog_internal(&app, &catalog)?;

    let was_aborted = job_id
        .as_ref()
        .and_then(|id| process_jobs_store().lock().ok().and_then(|jobs| jobs.get(id).map(|j| j.abort_requested)))
        .unwrap_or(false);

    if let Some(job_id) = &job_id {
        let final_current = if scanned_directories == 0 {
            "No candidate day folders found".to_string()
        } else {
            "Done".to_string()
        };
        update_process_job(job_id, |job| {
            job.total = total_candidates;
            job.done = scanned_directories;
            job.processed = scanned_directories;
            job.result_count = discovered_directories;
            job.current_file = final_current.clone();
            job.finished_at = Some(now_string());
            job.status = if was_aborted {
                ProcessJobStatus::Aborted
            } else {
                ProcessJobStatus::Completed
            };
        });

        if scanned_directories == 0 {
            append_process_job_log(job_id, "no day folders found in archive scope");
        } else if was_aborted {
            append_process_job_log(
                job_id,
                format!(
                    "aborted scanned={} matched_named_directories={}",
                    scanned_directories,
                    discovered_directories
                ),
            );
        } else {
            append_process_job_log(
                job_id,
                format!(
                    "complete scanned={} matched_named_directories={}",
                    scanned_directories,
                    discovered_directories
                ),
            );
        }
    }

    let _ = append_app_log(
        &app,
        format!(
            "process_{} complete scanned={} matched_named_directories={} scope_mode={:?}",
            task_label,
            scanned_directories,
            discovered_directories,
            scope_mode
        ),
    );

    if scanned_directories > last_done {
        let _ = app.emit(
            "process-progress",
            ProcessProgress {
                total: scanned_directories,
                done: scanned_directories,
                current_file: "Done".to_string(),
                phase: task_label.to_string(),
                speed_mbps: None,
            },
        );
    }

    Ok(ProcessResult {
        processed: scanned_directories,
        result_count: discovered_directories,
        errors: vec![],
    })
}

pub(crate) fn process_jobs_store() -> &'static Mutex<HashMap<String, ProcessJob>> {
    static STORE: OnceLock<Mutex<HashMap<String, ProcessJob>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn naming_requests_store() -> &'static Mutex<HashMap<String, ApplyEventNamingRequest>> {
    static STORE: OnceLock<Mutex<HashMap<String, ApplyEventNamingRequest>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone)]
struct EnhanceParams {
    contrast_level: f32,
    sharpness_level: f32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StabilizationMode {
    MaxFrame,
    EdgeSafe,
    AggressiveCrop,
}

impl StabilizationMode {
    fn parse(input: &str) -> Option<Self> {
        match input.trim().to_ascii_lowercase().as_str() {
            "maxframe" | "max_frame" | "max-frame" => Some(Self::MaxFrame),
            "edgesafe" | "edge_safe" | "edge-safe" => Some(Self::EdgeSafe),
            "aggressivecrop" | "aggressive_crop" | "aggressive-crop" => Some(Self::AggressiveCrop),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::MaxFrame => "maxFrame",
            Self::EdgeSafe => "edgeSafe",
            Self::AggressiveCrop => "aggressiveCrop",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StabilizationStrength {
    Gentle,
    Balanced,
    Strong,
}

impl StabilizationStrength {
    fn parse(input: &str) -> Option<Self> {
        match input.trim().to_ascii_lowercase().as_str() {
            "gentle" => Some(Self::Gentle),
            "balanced" => Some(Self::Balanced),
            "strong" => Some(Self::Strong),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Gentle => "gentle",
            Self::Balanced => "balanced",
            Self::Strong => "strong",
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct StabilizeParams {
    mode: StabilizationMode,
    strength: StabilizationStrength,
    preserve_source_bitrate: bool,
}

#[derive(Debug, Clone, Copy)]
struct StabilizeLoadPolicy {
    max_parallel_jobs: usize,
    ffmpeg_threads_per_job: usize,
}

fn enhance_params_store() -> &'static Mutex<HashMap<String, EnhanceParams>> {
    static STORE: OnceLock<Mutex<HashMap<String, EnhanceParams>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stabilize_params_store() -> &'static Mutex<HashMap<String, StabilizeParams>> {
    static STORE: OnceLock<Mutex<HashMap<String, StabilizeParams>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn parse_positive_env_usize(name: &str) -> Option<usize> {
    env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|value| *value > 0)
}

fn stabilization_load_policy(app: Option<&AppHandle>) -> StabilizeLoadPolicy {
    let cores = num_cpus().max(1);

    let (settings_parallel, settings_threads) = app
        .and_then(|handle| load_settings(handle.clone()).ok())
        .map(|settings| {
            (
                if settings.stabilize_max_parallel_jobs > 0 {
                    Some(settings.stabilize_max_parallel_jobs)
                } else {
                    None
                },
                if settings.stabilize_ffmpeg_threads_per_job > 0 {
                    Some(settings.stabilize_ffmpeg_threads_per_job)
                } else {
                    None
                },
            )
        })
        .unwrap_or((None, None));

    // Conservative defaults: avoid running many heavy ffmpeg processes in parallel.
    let default_parallel_jobs = if cores >= 12 { 2 } else { 1 };
    let max_parallel_jobs = parse_positive_env_usize("PHOTOGOGO_STABILIZE_MAX_PARALLEL")
        .or(settings_parallel)
        .unwrap_or(default_parallel_jobs)
        .clamp(1, cores);

    // Budget ffmpeg threads to roughly 70% of available cores, then split per parallel job.
    let thread_budget = ((cores * 7) / 10).max(1);
    let default_threads_per_job = (thread_budget / max_parallel_jobs).max(1).min(6);
    let requested_threads = parse_positive_env_usize("PHOTOGOGO_STABILIZE_FFMPEG_THREADS")
        .or(settings_threads)
        .unwrap_or(default_threads_per_job);
    let max_threads_per_job = (cores / max_parallel_jobs).max(1);
    let ffmpeg_threads_per_job = requested_threads.clamp(1, max_threads_per_job);

    StabilizeLoadPolicy {
        max_parallel_jobs,
        ffmpeg_threads_per_job,
    }
}

pub(crate) fn next_process_job_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("process-job-{}", id)
}

pub(crate) fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

pub(crate) fn update_process_job(job_id: &str, mutator: impl FnOnce(&mut ProcessJob)) {
    if let Ok(mut jobs) = process_jobs_store().lock() {
        if let Some(job) = jobs.get_mut(job_id) {
            mutator(job);
        }
    }
}

pub(crate) fn append_process_job_log(job_id: &str, message: impl AsRef<str>) {
    let ts = now_string();
    update_process_job(job_id, |job| {
        job.logs.push(format!("[{}] {}", ts, message.as_ref()));
        // Limit logs to 100 lines to avoid UI slowdown and verbose output
        if job.logs.len() > 100 {
            let to_drop = job.logs.len() - 100;
            job.logs.drain(0..to_drop);
        }
    });
}

/// Update the status line (single line that updates in-place) without adding to logs
pub(crate) fn update_process_status_line(job_id: &str, message: impl AsRef<str>) {
    update_process_job(job_id, |job| {
        job.status_line = message.as_ref().to_string();
    });
}

/// Add an important log entry (phase changes, errors, summaries)
pub(crate) fn append_process_milestone_log(job_id: &str, message: impl AsRef<str>) {
    let ts = now_string();
    update_process_job(job_id, |job| {
        job.logs.push(format!("[{}] {}", ts, message.as_ref()));
        // Keep last 100 milestone entries
        if job.logs.len() > 100 {
            let to_drop = job.logs.len() - 100;
            job.logs.drain(0..to_drop);
        }
        // Clear status line when logging milestone
        job.status_line.clear();
    });
}

pub(crate) fn wait_if_process_paused_or_aborted(job_id: Option<&str>) -> bool {
    let Some(job_id) = job_id else { return false; };

    loop {
        let (pause_requested, abort_requested) = match process_jobs_store().lock() {
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
            update_process_job(job_id, |job| {
                if !matches!(job.status, ProcessJobStatus::Paused) {
                    job.status = ProcessJobStatus::Paused;
                    job.current_file = "Paused".to_string();
                }
            });
            thread::sleep(Duration::from_millis(200));
            continue;
        }

        update_process_job(job_id, |job| {
            if matches!(job.status, ProcessJobStatus::Paused) {
                job.status = ProcessJobStatus::Running;
            }
        });
        return false;
    }
}

pub(crate) fn is_process_abort_requested(job_id: Option<&str>) -> bool {
    let Some(job_id) = job_id else { return false; };
    match process_jobs_store().lock() {
        Ok(jobs) => jobs
            .get(job_id)
            .map(|job| job.abort_requested)
            .unwrap_or(true),
        Err(_) => true,
    }
}

#[tauri::command]
pub fn list_process_jobs() -> Result<Vec<ProcessJob>, String> {
    let jobs = process_jobs_store().lock().map_err(|e| e.to_string())?;
    let mut out: Vec<ProcessJob> = jobs.values().cloned().collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[tauri::command]
pub fn clear_finished_process_jobs() -> Result<usize, String> {
    let mut jobs = process_jobs_store().lock().map_err(|e| e.to_string())?;
    let before = jobs.len();
    jobs.retain(|_, job| !matches!(job.status, ProcessJobStatus::Completed | ProcessJobStatus::Failed | ProcessJobStatus::Aborted));
    Ok(before.saturating_sub(jobs.len()))
}

#[tauri::command]
pub fn pause_process_job(job_id: String) -> Result<bool, String> {
    let mut jobs = process_jobs_store().lock().map_err(|e| e.to_string())?;
    let Some(job) = jobs.get_mut(&job_id) else { return Ok(false); };
    if matches!(job.status, ProcessJobStatus::Completed | ProcessJobStatus::Failed | ProcessJobStatus::Aborted) {
        return Ok(false);
    }
    job.pause_requested = true;
    job.status = ProcessJobStatus::Paused;
    job.current_file = "Paused".to_string();
    job.logs.push(format!("[{}] pause requested", now_string()));
    Ok(true)
}

#[tauri::command]
pub fn resume_process_job(job_id: String) -> Result<bool, String> {
    let mut jobs = process_jobs_store().lock().map_err(|e| e.to_string())?;
    let Some(job) = jobs.get_mut(&job_id) else { return Ok(false); };
    if matches!(job.status, ProcessJobStatus::Completed | ProcessJobStatus::Failed | ProcessJobStatus::Aborted) {
        return Ok(false);
    }
    job.pause_requested = false;
    job.status = ProcessJobStatus::Running;
    job.logs.push(format!("[{}] resume requested", now_string()));
    Ok(true)
}

#[tauri::command]
pub fn abort_process_job(job_id: String) -> Result<bool, String> {
    let mut jobs = process_jobs_store().lock().map_err(|e| e.to_string())?;
    let Some(job) = jobs.get_mut(&job_id) else { return Ok(false); };
    if matches!(job.status, ProcessJobStatus::Completed | ProcessJobStatus::Failed | ProcessJobStatus::Aborted) {
        return Ok(false);
    }
    job.abort_requested = true;
    job.pause_requested = false;
    job.current_file = "Abort requested".to_string();
    job.logs.push(format!("[{}] abort requested", now_string()));
    Ok(true)
}

const SECTION_SIZE: u32 = 200;

fn laplacian_variance(gray: &GrayImage, x0: u32, y0: u32, w: u32, h: u32) -> f64 {
    let x1 = (x0 + w).min(gray.width());
    let y1 = (y0 + h).min(gray.height());
    if x1 <= x0 + 2 || y1 <= y0 + 2 {
        return 0.0;
    }

    let mut values: Vec<f64> = Vec::new();
    for y in (y0 + 1)..(y1 - 1) {
        for x in (x0 + 1)..(x1 - 1) {
            let c = gray.get_pixel(x, y)[0] as f64;
            let n = gray.get_pixel(x, y - 1)[0] as f64;
            let s = gray.get_pixel(x, y + 1)[0] as f64;
            let e = gray.get_pixel(x + 1, y)[0] as f64;
            let w = gray.get_pixel(x - 1, y)[0] as f64;
            let lap = (4.0 * c - n - s - e - w).abs();
            values.push(lap);
        }
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let var = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64;
    var
}

fn sobel_variance(gray: &GrayImage, x0: u32, y0: u32, w: u32, h: u32) -> f64 {
    let x1 = (x0 + w).min(gray.width());
    let y1 = (y0 + h).min(gray.height());
    if x1 <= x0 + 2 || y1 <= y0 + 2 {
        return 0.0;
    }

    let mut mags: Vec<f64> = Vec::new();
    for y in (y0 + 1)..(y1 - 1) {
        for x in (x0 + 1)..(x1 - 1) {
            let tl = gray.get_pixel(x - 1, y - 1)[0] as f64;
            let tm = gray.get_pixel(x, y - 1)[0] as f64;
            let tr = gray.get_pixel(x + 1, y - 1)[0] as f64;
            let ml = gray.get_pixel(x - 1, y)[0] as f64;
            let mr = gray.get_pixel(x + 1, y)[0] as f64;
            let bl = gray.get_pixel(x - 1, y + 1)[0] as f64;
            let bm = gray.get_pixel(x, y + 1)[0] as f64;
            let br = gray.get_pixel(x + 1, y + 1)[0] as f64;
            let gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
            let gy = -tl - 2.0 * tm - tr + bl + 2.0 * bm + br;
            mags.push((gx * gx + gy * gy).sqrt());
        }
    }
    let mean = mags.iter().sum::<f64>() / mags.len() as f64;
    mags.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / mags.len() as f64
}

fn focus_score(img: &DynamicImage) -> (f64, f64, f64) {
    let gray = img.to_luma8();
    let w = gray.width();
    let h = gray.height();

    let mut section_scores: Vec<f64> = Vec::new();

    let mut y0 = 0u32;
    while y0 < h {
        let mut x0 = 0u32;
        while x0 < w {
            let lap = laplacian_variance(&gray, x0, y0, SECTION_SIZE, SECTION_SIZE);
            let sob = sobel_variance(&gray, x0, y0, SECTION_SIZE, SECTION_SIZE);
            // Combine: normalise Laplacian (0-100 scale), sobel provides gradient richness
            let score = (lap.sqrt() * 0.7 + sob.sqrt() * 0.3) / 10.0;
            section_scores.push(score);
            x0 += SECTION_SIZE;
        }
        y0 += SECTION_SIZE;
    }

    if section_scores.is_empty() {
        return (0.0, 0.0, 0.0);
    }

    let max_score = section_scores.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let avg_score = section_scores.iter().sum::<f64>() / section_scores.len() as f64;
    let focus_pct = section_scores.iter().filter(|&&s| s >= 2.0).count() as f64
        / section_scores.len() as f64
        * 100.0;

    (max_score, avg_score, focus_pct)
}

fn is_out_of_focus(max_score: f64, avg_score: f64, focus_pct: f64) -> bool {
    max_score < 4.0 || (focus_pct < 10.0 && avg_score < 3.0)
}

fn mark_blurry_filename(path: &Path, n: u32) -> PathBuf {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let new_name = format!("{}{{Out of Focus {}}}.{}", stem, n, ext);
    path.parent().unwrap_or(Path::new(".")).join(new_name)
}

fn restore_blurry_filename(path: &Path) -> Option<PathBuf> {
    let stem = path.file_stem().and_then(|s| s.to_str())?;
    let marker_start = stem.rfind("{Out of Focus ")?;
    if !stem.ends_with('}') {
        return None;
    }

    let marker_contents = &stem[marker_start + "{Out of Focus ".len()..stem.len() - 1];
    if marker_contents.is_empty() || !marker_contents.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }

    let original_stem = &stem[..marker_start];
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let restored_name = if ext.is_empty() {
        original_stem.to_string()
    } else {
        format!("{}.{}", original_stem, ext)
    };

    Some(path.parent().unwrap_or(Path::new(".")).join(restored_name))
}

fn apply_clahe_luma(gray: &GrayImage) -> GrayImage {
    let w = gray.width();
    let h = gray.height();
    let tile_w = (w / 8).max(1);
    let tile_h = (h / 8).max(1);
    let clip = 3.0f64;

    let tiles_x = (w + tile_w - 1) / tile_w;
    let tiles_y = (h + tile_h - 1) / tile_h;

    // Build CLHEs per tile
    let mut tile_luts: Vec<Vec<u8>> = Vec::new();
    for ty in 0..tiles_y {
        for tx in 0..tiles_x {
            let x0 = tx * tile_w;
            let y0 = ty * tile_h;
            let x1 = (x0 + tile_w).min(w);
            let y1 = (y0 + tile_h).min(h);
            let pixel_count = ((x1 - x0) * (y1 - y0)) as f64;

            let mut hist = [0f64; 256];
            for y in y0..y1 {
                for x in x0..x1 {
                    hist[gray.get_pixel(x, y)[0] as usize] += 1.0;
                }
            }

            // Clip and redistribute
            let clip_limit = clip * pixel_count / 256.0;
            let mut excess = 0.0f64;
            for v in hist.iter_mut() {
                if *v > clip_limit {
                    excess += *v - clip_limit;
                    *v = clip_limit;
                }
            }
            let redist = excess / 256.0;
            for v in hist.iter_mut() {
                *v += redist;
            }

            // CDF -> LUT
            let mut cdf = 0.0f64;
            let mut lut = [0u8; 256];
            for (i, v) in hist.iter().enumerate() {
                cdf += v;
                lut[i] = ((cdf / pixel_count) * 255.0).round().clamp(0.0, 255.0) as u8;
            }
            tile_luts.push(lut.to_vec());
        }
    }

    // Interpolate
    let mut out = GrayImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let pix = gray.get_pixel(x, y)[0];

            let tx_f = (x as f64 + 0.5) / tile_w as f64 - 0.5;
            let ty_f = (y as f64 + 0.5) / tile_h as f64 - 0.5;
            let tx0 = (tx_f.floor() as i64).clamp(0, tiles_x as i64 - 1) as u32;
            let ty0 = (ty_f.floor() as i64).clamp(0, tiles_y as i64 - 1) as u32;
            let tx1 = (tx0 + 1).min(tiles_x - 1);
            let ty1 = (ty0 + 1).min(tiles_y - 1);

            let wx = (tx_f - tx0 as f64).clamp(0.0, 1.0);
            let wy = (ty_f - ty0 as f64).clamp(0.0, 1.0);

            let idx = |txx: u32, tyy: u32| (tyy * tiles_x + txx) as usize;
            let v00 = tile_luts[idx(tx0, ty0)][pix as usize] as f64;
            let v10 = tile_luts[idx(tx1, ty0)][pix as usize] as f64;
            let v01 = tile_luts[idx(tx0, ty1)][pix as usize] as f64;
            let v11 = tile_luts[idx(tx1, ty1)][pix as usize] as f64;

            let interp = v00 * (1.0 - wx) * (1.0 - wy)
                + v10 * wx * (1.0 - wy)
                + v01 * (1.0 - wx) * wy
                + v11 * wx * wy;

            out.put_pixel(x, y, Luma([interp.round().clamp(0.0, 255.0) as u8]));
        }
    }
    out
}

fn unsharp_mask_rgb(img: &RgbImage, radius: f32, amount: f32) -> RgbImage {
    let w = img.width();
    let h = img.height();
    // Simple box blur approximation for speed
    let blur = blur_rgb(img, radius);
    let mut out = RgbImage::new(w, h);
    for (x, y, px) in img.enumerate_pixels() {
        let b = blur.get_pixel(x, y);
        let sharpened: [u8; 3] = [0, 1, 2].map(|c| {
            let orig = px[c] as f32;
            let blurred = b[c] as f32;
            let val = orig + amount * (orig - blurred);
            val.clamp(0.0, 255.0) as u8
        });
        out.put_pixel(x, y, Rgb(sharpened));
    }
    out
}

fn blur_rgb(img: &RgbImage, _radius: f32) -> RgbImage {
    // 3x3 box blur
    let w = img.width();
    let h = img.height();
    let mut out = RgbImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let mut sums = [0u32; 3];
            let mut count = 0u32;
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let nx = x as i32 + dx;
                    let ny = y as i32 + dy;
                    if nx >= 0 && nx < w as i32 && ny >= 0 && ny < h as i32 {
                        let p = img.get_pixel(nx as u32, ny as u32);
                        sums[0] += p[0] as u32;
                        sums[1] += p[1] as u32;
                        sums[2] += p[2] as u32;
                        count += 1;
                    }
                }
            }
            out.put_pixel(
                x,
                y,
                Rgb([(sums[0] / count) as u8, (sums[1] / count) as u8, (sums[2] / count) as u8]),
            );
        }
    }
    out
}

fn unsharp_mask_gray(img: &GrayImage, radius: f32, amount: f32) -> GrayImage {
    let blur = blur_gray(img, radius);
    let mut out = GrayImage::new(img.width(), img.height());
    for (x, y, px) in img.enumerate_pixels() {
        let b = blur.get_pixel(x, y)[0] as f32;
        let orig = px[0] as f32;
        let val = (orig + amount * (orig - b)).clamp(0.0, 255.0) as u8;
        out.put_pixel(x, y, Luma([val]));
    }
    out
}

fn blur_gray(img: &GrayImage, _radius: f32) -> GrayImage {
    let w = img.width();
    let h = img.height();
    let mut out = GrayImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0u32;
            let mut count = 0u32;
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let nx = x as i32 + dx;
                    let ny = y as i32 + dy;
                    if nx >= 0 && nx < w as i32 && ny >= 0 && ny < h as i32 {
                        sum += img.get_pixel(nx as u32, ny as u32)[0] as u32;
                        count += 1;
                    }
                }
            }
            out.put_pixel(x, y, Luma([(sum / count) as u8]));
        }
    }
    out
}

fn enhance_rgb_clahe(rgb: &RgbImage) -> RgbImage {
    // Convert to YCbCr-like: enhance Y (luma) channel via CLAHE, keep chroma
    let w = rgb.width();
    let h = rgb.height();
    let mut y_plane: GrayImage = ImageBuffer::new(w, h);
    let mut cb_plane: Vec<f32> = Vec::with_capacity((w * h) as usize);
    let mut cr_plane: Vec<f32> = Vec::with_capacity((w * h) as usize);

    for (x, y, px) in rgb.enumerate_pixels() {
        let r = px[0] as f32;
        let g = px[1] as f32;
        let b = px[2] as f32;
        let luma = 0.299 * r + 0.587 * g + 0.114 * b;
        y_plane.put_pixel(x, y, Luma([luma.clamp(0.0, 255.0) as u8]));
        cb_plane.push(b - luma);
        cr_plane.push(r - luma);
    }

    let enhanced_y = apply_clahe_luma(&y_plane);
    let sharpened_y = unsharp_mask_gray(&enhanced_y, 1.0, 0.5);

    let mut out = RgbImage::new(w, h);
    for (i, (x, y, _px)) in rgb.enumerate_pixels().enumerate() {
        let luma = sharpened_y.get_pixel(x, y)[0] as f32;
        let cb = cb_plane[i];
        let cr = cr_plane[i];
        let r = (luma + cr).clamp(0.0, 255.0) as u8;
        let g = (luma - 0.194 * cb - 0.509 * cr).clamp(0.0, 255.0) as u8;
        let b = (luma + cb).clamp(0.0, 255.0) as u8;
        out.put_pixel(x, y, Rgb([r, g, b]));
    }
    out
}

fn collect_jpgs(dir: &Path, recursive: bool) -> Vec<PathBuf> {
    let walker = if recursive {
        WalkDir::new(dir)
    } else {
        WalkDir::new(dir).max_depth(1)
    };

    walker
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .map(|e| {
                    let el = e.to_lowercase();
                    el == "jpg" || el == "jpeg"
                })
                .unwrap_or(false)
        })
        .filter(|p| {
            // Skip already-processed files
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            !name.contains("_improved") && !name.contains("_BW") && !name.contains("{Out of Focus")
        })
        .collect()
}

fn collect_focus_marked_jpgs(dir: &Path, recursive: bool) -> Vec<PathBuf> {
    let walker = if recursive {
        WalkDir::new(dir)
    } else {
        WalkDir::new(dir).max_depth(1)
    };

    walker
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .map(|e| {
                    let el = e.to_lowercase();
                    el == "jpg" || el == "jpeg"
                })
                .unwrap_or(false)
        })
        .filter(|p| restore_blurry_filename(p).is_some())
        .collect()
}

fn collect_named_outputs(dir: &Path, recursive: bool, suffix: &str, extension: &str) -> Vec<PathBuf> {
    let walker = if recursive {
        WalkDir::new(dir)
    } else {
        WalkDir::new(dir).max_depth(1)
    };

    walker
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            let ext_matches = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case(extension))
                .unwrap_or(false);
            let stem_matches = p
                .file_stem()
                .and_then(|s| s.to_str())
                .map(|stem| stem.ends_with(suffix))
                .unwrap_or(false);
            ext_matches && stem_matches
        })
        .collect()
}

fn collect_mp4s(dir: &Path, recursive: bool) -> Vec<PathBuf> {
    let walker = if recursive {
        WalkDir::new(dir)
    } else {
        WalkDir::new(dir).max_depth(1)
    };

    walker
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("mp4"))
                .unwrap_or(false)
        })
        .filter(|p| {
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            !name.contains("_stabilized")
        })
        .collect()
}

fn collect_process_files(task: &ProcessTask, dir: &Path, recursive: bool) -> Vec<PathBuf> {
    match task {
        ProcessTask::Focus | ProcessTask::Enhance | ProcessTask::Bw => collect_jpgs(dir, recursive),
        ProcessTask::RemoveFocus => collect_focus_marked_jpgs(dir, recursive),
        ProcessTask::RemoveEnhance => collect_named_outputs(dir, recursive, "_improved", "jpg"),
        ProcessTask::RemoveBw => collect_named_outputs(dir, recursive, "_BW", "jpg"),
        ProcessTask::Stabilize => collect_mp4s(dir, recursive),
        ProcessTask::RemoveStabilize => collect_named_outputs(dir, recursive, "_stabilized", "mp4"),
        ProcessTask::ScanArchiveNaming | ProcessTask::ApplyEventNaming => vec![],
        ProcessTask::Transfer | ProcessTask::VerifyChecksums => vec![],
        ProcessTask::ScanFaces | ProcessTask::SearchPersonVideos => vec![],
    }
}

#[derive(Debug, Clone)]
struct FfmpegCapabilities {
    binary: PathBuf,
    has_vidstab: bool,
    has_h264_nvenc: bool,
    nvenc_probe_error: Option<String>,
}

fn ffmpeg_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = env::var_os("PHOTOGOGO_FFMPEG") {
        candidates.push(PathBuf::from(path));
    }

    if let Ok(current_exe) = env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join("ffmpeg.exe"));
            candidates.push(parent.join("tools").join("ffmpeg").join("bin").join("ffmpeg.exe"));
        }
    }

    candidates.push(PathBuf::from("ffmpeg"));
    candidates
}

fn command_output(binary: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    Command::new(binary)
        .args(args)
        .output()
        .map_err(|e| e.to_string())
}

fn probe_h264_nvenc(binary: &Path) -> Result<(), String> {
    let probe_root = env::temp_dir().join(format!(
        "photogogo_nvenc_probe_{}_{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    let output_path = probe_root.join("probe.mp4");
    fs::create_dir_all(&probe_root).map_err(|e| e.to_string())?;

    let output = Command::new(binary)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=size=16x16:rate=1:color=black",
            "-frames:v",
            "1",
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p7",
            "-cq",
            "18",
            "-b:v",
            "0",
            "-an",
            "-y",
        ])
        .arg(&output_path)
        .output()
        .map_err(|e| e.to_string())?;

    let _ = fs::remove_file(&output_path);
    let _ = fs::remove_dir_all(&probe_root);

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        Err(stderr)
    } else if !stdout.is_empty() {
        Err(stdout)
    } else {
        Err(format!("NVENC probe failed with status {}", output.status))
    }
}

fn detect_ffmpeg_capabilities() -> Result<FfmpegCapabilities, String> {
    let mut last_error = None;

    for candidate in ffmpeg_candidates() {
        match command_output(&candidate, &["-hide_banner", "-version"]) {
            Ok(version) if version.status.success() => {
                let filters = command_output(&candidate, &["-hide_banner", "-filters"])?;
                let filters_stdout = String::from_utf8_lossy(&filters.stdout).to_lowercase();
                let filters_stderr = String::from_utf8_lossy(&filters.stderr).to_lowercase();
                let filter_blob = format!("{}\n{}", filters_stdout, filters_stderr);

                let encoders = command_output(&candidate, &["-hide_banner", "-encoders"])?;
                let encoders_stdout = String::from_utf8_lossy(&encoders.stdout).to_lowercase();
                let encoders_stderr = String::from_utf8_lossy(&encoders.stderr).to_lowercase();
                let encoder_blob = format!("{}\n{}", encoders_stdout, encoders_stderr);
                let nvenc_listed = encoder_blob.contains("h264_nvenc");
                let nvenc_probe = if nvenc_listed {
                    probe_h264_nvenc(&candidate).err()
                } else {
                    None
                };

                return Ok(FfmpegCapabilities {
                    binary: candidate,
                    has_vidstab: filter_blob.contains("vidstabdetect") && filter_blob.contains("vidstabtransform"),
                    has_h264_nvenc: nvenc_listed && nvenc_probe.is_none(),
                    nvenc_probe_error: nvenc_probe,
                });
            }
            Ok(version) => {
                last_error = Some(String::from_utf8_lossy(&version.stderr).trim().to_string());
            }
            Err(err) => {
                last_error = Some(err);
            }
        }
    }

    Err(format!(
        "FFmpeg was not found. Install FFmpeg with the vid.stab filters and place ffmpeg.exe on PATH, or set PHOTOGOGO_FFMPEG to the executable path.{}",
        last_error
            .filter(|s| !s.is_empty())
            .map(|s| format!(" Last probe error: {}", s))
            .unwrap_or_default()
    ))
}

fn ffprobe_candidates_for_ffmpeg(ffmpeg_binary: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(parent) = ffmpeg_binary.parent() {
        candidates.push(parent.join("ffprobe.exe"));
        candidates.push(parent.join("ffprobe"));
    }

    if let Some(file_name) = ffmpeg_binary.file_name().and_then(|name| name.to_str()) {
        if file_name.eq_ignore_ascii_case("ffmpeg.exe") {
            candidates.push(ffmpeg_binary.with_file_name("ffprobe.exe"));
        } else if file_name == "ffmpeg" {
            candidates.push(ffmpeg_binary.with_file_name("ffprobe"));
        }
    }

    candidates.push(PathBuf::from("ffprobe"));
    candidates
}

fn probe_video_bitrate_bps(ffmpeg_binary: &Path, input_path: &Path) -> Option<u64> {
    for ffprobe_binary in ffprobe_candidates_for_ffmpeg(ffmpeg_binary) {
        let output = Command::new(&ffprobe_binary)
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=bit_rate:format=bit_rate",
                "-of",
                "default=nokey=1:noprint_wrappers=1",
            ])
            .arg(input_path)
            .output();

        let Ok(output) = output else { continue; };
        if !output.status.success() {
            continue;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let value = line.trim();
            if value.is_empty() || value.eq_ignore_ascii_case("n/a") {
                continue;
            }
            if let Ok(parsed) = value.parse::<u64>() {
                if parsed > 0 {
                    return Some(parsed);
                }
            }
        }
    }

    None
}

fn run_ffmpeg_command(
    binary: &Path,
    args: &[String],
    job_id: Option<&str>,
    working_dir: Option<&Path>,
) -> Result<(), String> {
    let mut command = Command::new(binary);
    command.args(args);

    if let Some(dir) = working_dir {
        command.current_dir(dir);
    }

    let mut child = command
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;

    let stderr_reader = child.stderr.take().map(|mut stderr| {
        thread::spawn(move || {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text);
            text
        })
    });

    loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            let stderr_text = stderr_reader
                .map(|handle| handle.join().unwrap_or_default())
                .unwrap_or_default();

            if status.success() {
                return Ok(());
            }

            let message = stderr_text.trim();
            return Err(if message.is_empty() {
                format!("FFmpeg exited with status {}", status)
            } else {
                format!("FFmpeg exited with status {}: {}", status, message)
            });
        }

        if is_process_abort_requested(job_id) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stderr_reader.map(|handle| handle.join());
            return Err("Process job aborted while FFmpeg was running".to_string());
        }

        thread::sleep(Duration::from_millis(200));
    }
}

fn stabilize_mp4(
    app: &AppHandle,
    path: &Path,
    capabilities: &FfmpegCapabilities,
    job_id: Option<&str>,
    stabilization_mode: StabilizationMode,
    stabilization_strength: StabilizationStrength,
    preserve_source_bitrate: bool,
    ffmpeg_threads: usize,
) -> anyhow::Result<()> {
    if !capabilities.has_vidstab {
        return Err(anyhow::anyhow!(
            "FFmpeg is installed, but this build does not include vid.stab (vidstabdetect/vidstabtransform)."
        ));
    }

    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("video");
    let out_path = path
        .parent()
        .unwrap_or(Path::new("."))
        .join(format!("{}_stabilized.mp4", stem));
    let replaced_existing = out_path.exists();
    let temp_root = env::temp_dir();
    let temp_tag = format!(
        "photogogo_vidstab_{}_{}_{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis(),
        done_hash(path)
    );
    let work_dir = temp_root.join(&temp_tag);
    fs::create_dir_all(&work_dir)?;
    let transform_file_name = format!("{}.trf", temp_tag);
    let transform_path = work_dir.join(&transform_file_name);

    let source_video_bitrate_bps = probe_video_bitrate_bps(&capabilities.binary, path);
    let target_video_bitrate_bps = if preserve_source_bitrate {
        source_video_bitrate_bps.filter(|bps| *bps >= 200_000)
    } else {
        None
    };
    let maxrate_bps = target_video_bitrate_bps.map(|bps| bps.saturating_mul(115) / 100);
    let bufsize_bps = target_video_bitrate_bps.map(|bps| bps.saturating_mul(2));

    let (detect_stepsize, detect_shakiness, detect_accuracy, transform_smoothing) =
        match stabilization_strength {
            StabilizationStrength::Gentle => (8, 3, 10, 18),
            StabilizationStrength::Balanced => (6, 4, 15, 30),
            StabilizationStrength::Strong => (4, 6, 15, 48),
        };

    let detect_filter = format!(
        "vidstabdetect=stepsize={}:shakiness={}:accuracy={}:mincontrast=0.25:result={}",
        detect_stepsize,
        detect_shakiness,
        detect_accuracy,
        transform_file_name
    );
    let (zoom, optzoom, zoomspeed) = match stabilization_mode {
        StabilizationMode::MaxFrame => (0.0_f32, 0, 0.0_f32),
        StabilizationMode::EdgeSafe => (4.0_f32, 2, 0.25_f32),
        StabilizationMode::AggressiveCrop => (8.0_f32, 2, 0.4_f32),
    };
    let transform_filter = format!(
        "vidstabtransform=input={}:smoothing={}:zoom={:.2}:optzoom={}:zoomspeed={:.2}:relative=1:crop=black:interpol=bicubic,unsharp=5:5:0.6:3:3:0.0",
        transform_file_name,
        transform_smoothing,
        zoom,
        optzoom,
        zoomspeed
    );

    let quality_mode = if preserve_source_bitrate {
        "preserve_source_bitrate"
    } else {
        "quality_priority"
    };

    let base_cq = "18";
    let base_crf = "18";

    let detect_args = vec![
        "-hide_banner".to_string(),
        "-y".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-threads".to_string(),
        ffmpeg_threads.to_string(),
        "-i".to_string(),
        path.to_string_lossy().into_owned(),
        "-vf".to_string(),
        detect_filter,
        "-an".to_string(),
        "-f".to_string(),
        "null".to_string(),
        "-".to_string(),
    ];

    let video_encoder = if capabilities.has_h264_nvenc { "h264_nvenc" } else { "libx264" };
    let mut transform_args = vec![
        "-hide_banner".to_string(),
        "-y".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-threads".to_string(),
        ffmpeg_threads.to_string(),
        "-i".to_string(),
        path.to_string_lossy().into_owned(),
        "-vf".to_string(),
        transform_filter,
        "-map_metadata".to_string(),
        "0".to_string(),
        "-movflags".to_string(),
        "+use_metadata_tags".to_string(),
        "-c:v".to_string(),
        video_encoder.to_string(),
    ];

    if capabilities.has_h264_nvenc {
        transform_args.extend([
            "-preset".to_string(),
            "p7".to_string(),
            "-tune".to_string(),
            "hq".to_string(),
        ]);

        if preserve_source_bitrate {
            if let Some(target_bitrate_bps) = target_video_bitrate_bps {
                // Use a strict rate-control path to better preserve source bitrate.
                transform_args.extend([
                    "-rc".to_string(),
                    "cbr_hq".to_string(),
                    "-b:v".to_string(),
                    target_bitrate_bps.to_string(),
                    "-minrate".to_string(),
                    target_bitrate_bps.to_string(),
                    "-maxrate".to_string(),
                    target_bitrate_bps.to_string(),
                    "-bufsize".to_string(),
                    target_bitrate_bps.saturating_mul(2).to_string(),
                ]);
            } else {
                transform_args.extend([
                    "-rc".to_string(),
                    "vbr".to_string(),
                    "-cq".to_string(),
                    base_cq.to_string(),
                    "-spatial-aq".to_string(),
                    "1".to_string(),
                    "-aq-strength".to_string(),
                    "8".to_string(),
                    "-b:v".to_string(),
                    "0".to_string(),
                ]);
            }
        } else {
            transform_args.extend([
                "-rc".to_string(),
                "vbr".to_string(),
                "-cq".to_string(),
                base_cq.to_string(),
                "-spatial-aq".to_string(),
                "1".to_string(),
                "-aq-strength".to_string(),
                "8".to_string(),
            ]);

            if let (Some(target_bitrate_bps), Some(maxrate_bps), Some(bufsize_bps)) =
                (target_video_bitrate_bps, maxrate_bps, bufsize_bps)
            {
                transform_args.extend([
                    "-b:v".to_string(),
                    target_bitrate_bps.to_string(),
                    "-maxrate".to_string(),
                    maxrate_bps.to_string(),
                    "-bufsize".to_string(),
                    bufsize_bps.to_string(),
                ]);
            } else {
                transform_args.extend(["-b:v".to_string(), "0".to_string()]);
            }
        }
    } else {
        transform_args.extend([
            "-preset".to_string(),
            "slow".to_string(),
        ]);

        if preserve_source_bitrate {
            if let Some(target_bitrate_bps) = target_video_bitrate_bps {
                // Avoid CRF when bitrate preservation is requested.
                transform_args.extend([
                    "-b:v".to_string(),
                    target_bitrate_bps.to_string(),
                    "-minrate".to_string(),
                    target_bitrate_bps.to_string(),
                    "-maxrate".to_string(),
                    target_bitrate_bps.to_string(),
                    "-bufsize".to_string(),
                    target_bitrate_bps.saturating_mul(2).to_string(),
                    "-x264-params".to_string(),
                    "nal-hrd=cbr".to_string(),
                ]);
            } else {
                transform_args.extend([
                    "-crf".to_string(),
                    base_crf.to_string(),
                ]);
            }
        } else {
            transform_args.extend([
                "-crf".to_string(),
                base_crf.to_string(),
            ]);

            if let (Some(target_bitrate_bps), Some(maxrate_bps), Some(bufsize_bps)) =
                (target_video_bitrate_bps, maxrate_bps, bufsize_bps)
            {
                transform_args.extend([
                    "-b:v".to_string(),
                    target_bitrate_bps.to_string(),
                    "-maxrate".to_string(),
                    maxrate_bps.to_string(),
                    "-bufsize".to_string(),
                    bufsize_bps.to_string(),
                ]);
            }
        }
    }

    let bitrate_policy = if let (Some(target_bitrate_bps), Some(maxrate_bps), Some(bufsize_bps)) =
        (target_video_bitrate_bps, maxrate_bps, bufsize_bps)
    {
        format!(
            "quality_mode={} source_bitrate={}bps target_bitrate={}bps maxrate={}bps bufsize={}bps",
            quality_mode,
            source_video_bitrate_bps.unwrap_or(target_bitrate_bps),
            target_bitrate_bps,
            maxrate_bps,
            bufsize_bps
        )
    } else {
        format!(
            "quality_mode={} source_bitrate={} target_bitrate=encoder_quality",
            quality_mode,
            source_video_bitrate_bps
                .map(|bps| format!("{}bps", bps))
                .unwrap_or_else(|| "unknown".to_string())
        )
    };

    transform_args.extend([
        "-pix_fmt".to_string(),
        "yuv420p".to_string(),
        "-c:a".to_string(),
        "copy".to_string(),
        out_path.to_string_lossy().into_owned(),
    ]);

    let _ = append_app_log(
        app,
        format!(
            "process_stabilize analyse source='{}' transform='{}'",
            path.display(),
            transform_path.display()
        ),
    );
    if let Some(job_id) = job_id {
        append_process_job_log(
            job_id,
            format!(
                "stabilize analyse '{}' using {} work_dir='{}' mode={} strength={} preserve_source_bitrate={} ffmpeg_threads={} {}",
                path.display(),
                capabilities.binary.display(),
                work_dir.display(),
                stabilization_mode.as_str(),
                stabilization_strength.as_str(),
                preserve_source_bitrate,
                ffmpeg_threads,
                &bitrate_policy
            ),
        );
    }

    run_ffmpeg_command(&capabilities.binary, &detect_args, job_id, Some(&work_dir))
        .map_err(anyhow::Error::msg)?;

    if let Some(reason) = &capabilities.nvenc_probe_error {
        let _ = append_app_log(
            app,
            format!(
                "process_stabilize nvenc_unavailable source='{}' reason='{}'",
                path.display(),
                reason
            ),
        );
    }

    let _ = append_app_log(
        app,
        format!(
            "process_stabilize encode source='{}' output='{}' encoder={} gpu={} mode={} strength={} preserve_source_bitrate={} ffmpeg_threads={} {}",
            path.display(),
            out_path.display(),
            video_encoder,
            capabilities.has_h264_nvenc,
            stabilization_mode.as_str(),
            stabilization_strength.as_str(),
            preserve_source_bitrate,
            ffmpeg_threads,
            &bitrate_policy
        ),
    );
    if let Some(job_id) = job_id {
        append_process_job_log(
            job_id,
            format!(
                "stabilize encode '{}' -> '{}' encoder={} gpu={} mode={} strength={} preserve_source_bitrate={} ffmpeg_threads={} {}",
                path.display(),
                out_path.display(),
                video_encoder,
                capabilities.has_h264_nvenc,
                stabilization_mode.as_str(),
                stabilization_strength.as_str(),
                preserve_source_bitrate,
                ffmpeg_threads,
                &bitrate_policy
            ),
        );
    }

    let result = run_ffmpeg_command(&capabilities.binary, &transform_args, job_id, Some(&work_dir));
    let _ = fs::remove_file(&transform_path);
    let _ = fs::remove_dir_all(&work_dir);
    result.map_err(anyhow::Error::msg)?;

    sync_file_metadata_from(path, &out_path, false).map_err(anyhow::Error::msg)?;

    let _ = append_app_log(
        app,
        format!(
            "process_stabilize wrote='{}' replaced_existing={} encoder={} gpu={}",
            out_path.display(),
            replaced_existing,
            video_encoder,
            capabilities.has_h264_nvenc
        ),
    );
    if let Some(job_id) = job_id {
        append_process_job_log(
            job_id,
            format!(
                "stabilized '{}' -> '{}' (replaced_existing={} encoder={} gpu={} mode={} strength={} preserve_source_bitrate={})",
                path.display(),
                out_path.display(),
                replaced_existing,
                video_encoder,
                capabilities.has_h264_nvenc,
                stabilization_mode.as_str(),
                stabilization_strength.as_str(),
                preserve_source_bitrate
            ),
        );
    }

    Ok(())
}

fn done_hash(path: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn resolve_process_scope(staging_dir: &str, scope_dir: Option<String>, scope_mode: &ProcessScopeMode) -> Result<PathBuf, String> {
    let staging_root = PathBuf::from(staging_dir);
    let scope = match scope_mode {
        ProcessScopeMode::EntireStaging => staging_root.clone(),
        ProcessScopeMode::FolderRecursive | ProcessScopeMode::FolderOnly => scope_dir
            .map(PathBuf::from)
            .unwrap_or_else(|| staging_root.clone()),
    };

    if !scope.exists() {
        return Err(format!("Process scope does not exist: {}", scope.display()));
    }

    let staging_canon = fs::canonicalize(&staging_root).map_err(|e| e.to_string())?;
    let scope_canon = fs::canonicalize(&scope).map_err(|e| e.to_string())?;

    if !scope_canon.starts_with(&staging_canon) {
        return Err(format!(
            "Process scope '{}' must be inside staging dir '{}'",
            scope.display(),
            staging_dir
        ));
    }

    Ok(scope)
}

#[tauri::command]
pub async fn run_focus_detection(
    app: AppHandle,
    staging_dir: String,
    scope_dir: Option<String>,
    scope_mode: Option<ProcessScopeMode>,
) -> Result<ProcessResult, String> {
    async_runtime::spawn_blocking(move || run_process_task(app, staging_dir, scope_dir, scope_mode, ProcessTask::Focus, None))
        .await
        .map_err(|e| format!("Process background task failed: {}", e))?
}

#[tauri::command]
pub async fn run_enhancement(
    app: AppHandle,
    staging_dir: String,
    scope_dir: Option<String>,
    scope_mode: Option<ProcessScopeMode>,
) -> Result<ProcessResult, String> {
    async_runtime::spawn_blocking(move || run_process_task(app, staging_dir, scope_dir, scope_mode, ProcessTask::Enhance, None))
        .await
        .map_err(|e| format!("Process background task failed: {}", e))?
}

#[tauri::command]
pub async fn run_bw_conversion(
    app: AppHandle,
    staging_dir: String,
    scope_dir: Option<String>,
    scope_mode: Option<ProcessScopeMode>,
) -> Result<ProcessResult, String> {
    async_runtime::spawn_blocking(move || run_process_task(app, staging_dir, scope_dir, scope_mode, ProcessTask::Bw, None))
        .await
        .map_err(|e| format!("Process background task failed: {}", e))?
}

#[tauri::command]
pub async fn run_video_stabilization(
    app: AppHandle,
    staging_dir: String,
    scope_dir: Option<String>,
    scope_mode: Option<ProcessScopeMode>,
) -> Result<ProcessResult, String> {
    async_runtime::spawn_blocking(move || run_process_task(app, staging_dir, scope_dir, scope_mode, ProcessTask::Stabilize, None))
        .await
        .map_err(|e| format!("Process background task failed: {}", e))?
}

fn task_name(task: &ProcessTask) -> &'static str {
    match task {
        ProcessTask::Focus => "focus",
        ProcessTask::RemoveFocus => "remove_focus",
        ProcessTask::Enhance => "enhance",
        ProcessTask::RemoveEnhance => "remove_enhance",
        ProcessTask::Bw => "bw",
        ProcessTask::RemoveBw => "remove_bw",
        ProcessTask::Stabilize => "stabilize",
        ProcessTask::RemoveStabilize => "remove_stabilize",
        ProcessTask::ScanArchiveNaming => "scan_archive_naming",
        ProcessTask::ApplyEventNaming => "apply_event_naming",
        ProcessTask::Transfer => "transfer",
        ProcessTask::VerifyChecksums => "verify_checksums",
        ProcessTask::ScanFaces => "scan_faces",
        ProcessTask::SearchPersonVideos => "search_person_videos",
    }
}

fn task_result_label(task: &ProcessTask) -> &'static str {
    match task {
        ProcessTask::Focus => "flagged",
        ProcessTask::RemoveFocus => "restored",
        ProcessTask::Enhance => "enhanced",
        ProcessTask::RemoveEnhance => "removed",
        ProcessTask::Bw => "converted",
        ProcessTask::RemoveBw => "removed",
        ProcessTask::Stabilize => "stabilized",
        ProcessTask::RemoveStabilize => "removed",
        ProcessTask::ScanArchiveNaming => "matched",
        ProcessTask::ApplyEventNaming => "renamed",
        ProcessTask::Transfer => "transferred",
        ProcessTask::VerifyChecksums => "verified",
        ProcessTask::ScanFaces => "faces_detected",
        ProcessTask::SearchPersonVideos => "videos_found",
    }
}

fn run_event_naming_task(
    app: AppHandle,
    staging_dir: String,
    request: ApplyEventNamingRequest,
    job_id: Option<String>,
) -> Result<ProcessResult, String> {
    let plans = build_event_naming_plans(&request)?;
    let total = plans.len();
    let task_label = task_name(&ProcessTask::ApplyEventNaming);
    let mut processed_count = 0usize;
    let mut renamed_count = 0usize;

    if let Some(job_id) = &job_id {
        update_process_job(job_id, |job| {
            job.status = ProcessJobStatus::Running;
            job.started_at = Some(now_string());
            job.current_file = "Starting".to_string();
            job.total = total;
            job.scope_dir = staging_dir.clone();
            job.scope_mode = ProcessScopeMode::FolderOnly;
        });
        append_process_job_log(
            job_id,
            format!(
                "start task={} selected_directories={} staging='{}'",
                task_label,
                total,
                staging_dir
            ),
        );
    }

    let _ = append_app_log(
        &app,
        format!(
            "process_{} start staging='{}' selected_directories={}",
            task_label,
            staging_dir,
            total
        ),
    );

    if total == 0 {
        return Err("No directories selected".to_string());
    }

    for (index, plan) in plans.iter().enumerate() {
        if wait_if_process_paused_or_aborted(job_id.as_deref()) {
            if let Some(job_id) = &job_id {
                update_process_job(job_id, |job| {
                    job.status = ProcessJobStatus::Aborted;
                    job.finished_at = Some(now_string());
                    job.done = processed_count;
                    job.processed = processed_count;
                    job.result_count = renamed_count;
                    job.current_file = "Aborted".to_string();
                });
                append_process_job_log(
                    job_id,
                    format!("aborted processed={} renamed={}", processed_count, renamed_count),
                );
            }
            let _ = append_app_log(
                &app,
                format!(
                    "process_{} aborted processed={} renamed={}",
                    task_label,
                    processed_count,
                    renamed_count,
                ),
            );
            return Ok(ProcessResult {
                processed: processed_count,
                result_count: renamed_count,
                errors: vec![],
            });
        }

        let current_file = format!("{} -> {}", plan.old_name, plan.new_name);
        if let Some(job_id) = &job_id {
            update_process_job(job_id, |job| {
                job.current_file = current_file.clone();
                job.done = index;
                job.processed = processed_count;
                job.result_count = renamed_count;
            });
        }

        let renamed = loop {
            match apply_event_naming_plan_once(plan) {
                Ok(result) => break result,
                Err(err) if is_retryable_windows_lock_error(&err) => {
                    let lock_targets: Vec<&Path> = vec![
                        plan.old_path.as_path(),
                        plan.old_path.parent().unwrap_or(plan.old_path.as_path()),
                    ];
                    let lockers = describe_locking_processes(&lock_targets).unwrap_or_default();
                    let locker_summary = if lockers.is_empty() {
                        "no locking process identified".to_string()
                    } else {
                        lockers.join(", ")
                    };
                    let error_message = format_rename_error(&plan.old_path, &plan.new_path, &err);

                    if let Some(job_id) = &job_id {
                        append_process_job_log(
                            job_id,
                            format!(
                                "rename blocked '{}' -> '{}' ; lockers: {} ; retrying in 60 seconds",
                                plan.old_path.display(),
                                plan.new_path.display(),
                                locker_summary
                            ),
                        );
                        update_process_job(job_id, |job| {
                            job.current_file = format!("Locked: {}", plan.old_name);
                        });
                    }

                    let _ = append_app_log(
                        &app,
                        format!(
                            "process_{} locked '{}' -> '{}' lockers={} message='{}'",
                            task_label,
                            plan.old_path.display(),
                            plan.new_path.display(),
                            locker_summary,
                            error_message
                        ),
                    );

                    for remaining in (1..=60).rev() {
                        if wait_if_process_paused_or_aborted(job_id.as_deref()) {
                            if let Some(job_id) = &job_id {
                                update_process_job(job_id, |job| {
                                    job.status = ProcessJobStatus::Aborted;
                                    job.finished_at = Some(now_string());
                                    job.done = processed_count;
                                    job.processed = processed_count;
                                    job.result_count = renamed_count;
                                    job.current_file = "Aborted".to_string();
                                });
                                append_process_job_log(
                                    job_id,
                                    format!("aborted processed={} renamed={}", processed_count, renamed_count),
                                );
                            }
                            return Ok(ProcessResult {
                                processed: processed_count,
                                result_count: renamed_count,
                                errors: vec![],
                            });
                        }

                        if let Some(job_id) = &job_id {
                            update_process_job(job_id, |job| {
                                job.current_file = format!("Locked: {} (retry in {}s)", plan.old_name, remaining);
                            });
                        }
                        thread::sleep(Duration::from_secs(1));
                    }
                }
                Err(err) => {
                    return Err(format_rename_error(&plan.old_path, &plan.new_path, &err));
                }
            }
        };
        processed_count += 1;
        if renamed.old_path != renamed.new_path {
            renamed_count += 1;
        }

        if let Some(job_id) = &job_id {
            if renamed.old_path == renamed.new_path {
                append_process_job_log(job_id, format!("unchanged '{}'", renamed.old_path));
            } else {
                append_process_job_log(job_id, format!("renamed '{}' -> '{}'", renamed.old_path, renamed.new_path));
            }

            update_process_job(job_id, |job| {
                job.done = index + 1;
                job.processed = processed_count;
                job.result_count = renamed_count;
                job.current_file = renamed.new_name.clone();
            });
        }

        let _ = app.emit(
            "process-progress",
            ProcessProgress {
                total,
                done: index + 1,
                current_file: renamed.new_name.clone(),
                phase: task_label.to_string(),
                speed_mbps: None,
            },
        );
    }

    let catalog = merge_event_naming_request_into_catalog(&app, &request)?;
    let _ = catalog;

    if let Some(job_id) = &job_id {
        update_process_job(job_id, |job| {
            job.status = ProcessJobStatus::Completed;
            job.finished_at = Some(now_string());
            job.done = processed_count;
            job.processed = processed_count;
            job.result_count = renamed_count;
            job.current_file = "Done".to_string();
        });
        append_process_job_log(
            job_id,
            format!("complete processed={} renamed={}", processed_count, renamed_count),
        );
    }

    let _ = append_app_log(
        &app,
        format!(
            "process_{} complete processed={} renamed={}",
            task_label,
            processed_count,
            renamed_count,
        ),
    );

    Ok(ProcessResult {
        processed: processed_count,
        result_count: renamed_count,
        errors: vec![],
    })
}

fn run_process_task(
    app: AppHandle,
    staging_dir: String,
    scope_dir: Option<String>,
    scope_mode: Option<ProcessScopeMode>,
    task: ProcessTask,
    job_id: Option<String>,
) -> Result<ProcessResult, String> {
    if matches!(task, ProcessTask::ScanArchiveNaming) {
        return run_archive_naming_scan_task(app, staging_dir, scope_dir, scope_mode, job_id);
    }

    if matches!(task, ProcessTask::ApplyEventNaming) {
        let request = job_id
            .as_ref()
            .and_then(|id| naming_requests_store().lock().ok().and_then(|store| store.get(id).cloned()))
            .ok_or_else(|| "Missing apply-event-naming request parameters for queued job".to_string())?;
        return run_event_naming_task(app, staging_dir, request, job_id);
    }

    if matches!(task, ProcessTask::ScanFaces) {
        return run_scan_faces_task(app, staging_dir, scope_dir, scope_mode, job_id);
    }

    if matches!(task, ProcessTask::SearchPersonVideos) {
        return run_search_person_videos_task(app, staging_dir, scope_dir, scope_mode, job_id);
    }

    let scope_mode = scope_mode.unwrap_or(ProcessScopeMode::FolderRecursive);
    let scope = resolve_process_scope(&staging_dir, scope_dir.clone(), &scope_mode)?;
    let recursive = !matches!(scope_mode, ProcessScopeMode::FolderOnly);
    let files = collect_process_files(&task, &scope, recursive);
    let total = files.len();
    let done_count = Arc::new(AtomicU64::new(0));
    let result_count = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));

    let task_label = task_name(&task);
    let _ = append_app_log(&app, format!("process_{} start staging='{}' scope='{}' scope_mode={:?}", task_label, staging_dir, scope.display(), scope_mode));

    if let Some(job_id) = &job_id {
        update_process_job(job_id, |job| {
            job.status = ProcessJobStatus::Running;
            job.started_at = Some(now_string());
            job.current_file = "Starting".to_string();
            job.total = total;
            job.scope_dir = scope.to_string_lossy().into_owned();
            job.scope_mode = scope_mode.clone();
        });
        append_process_job_log(job_id, format!("start task={} staging='{}' scope='{}' scope_mode={:?}", task_label, staging_dir, scope.display(), scope_mode));
    }

    if total == 0 {
        if let Some(job_id) = &job_id {
            update_process_job(job_id, |job| {
                job.status = ProcessJobStatus::Completed;
                job.finished_at = Some(now_string());
                job.current_file = "Done".to_string();
            });
            append_process_job_log(job_id, "no supported files found for this task");
        }
        let _ = append_app_log(&app, format!("process_{} no files scope='{}' scope_mode={:?}", task_label, scope.display(), scope_mode));
        return Ok(ProcessResult { processed: 0, result_count: 0, errors: vec![] });
    }

    let ffmpeg_capabilities = match task {
        ProcessTask::Stabilize => {
            let capabilities = detect_ffmpeg_capabilities()?;
            if !capabilities.has_vidstab {
                return Err("FFmpeg is installed, but this build does not include the vid.stab filters required for stabilization.".to_string());
            }
            let encoder = if capabilities.has_h264_nvenc { "h264_nvenc" } else { "libx264" };
            let _ = append_app_log(
                &app,
                format!(
                    "process_stabilize capability binary='{}' vidstab={} encoder={} gpu={} nvenc_probe_error={}",
                    capabilities.binary.display(),
                    capabilities.has_vidstab,
                    encoder,
                    capabilities.has_h264_nvenc,
                    capabilities.nvenc_probe_error.as_deref().unwrap_or("none")
                ),
            );
            if let Some(job_id) = &job_id {
                append_process_job_log(
                    job_id,
                    format!(
                        "ffmpeg='{}' vidstab={} encoder={} gpu={} nvenc_probe_error={}",
                        capabilities.binary.display(),
                        capabilities.has_vidstab,
                        encoder,
                        capabilities.has_h264_nvenc,
                        capabilities.nvenc_probe_error.as_deref().unwrap_or("none")
                    ),
                );
                if let Some(reason) = &capabilities.nvenc_probe_error {
                    append_process_job_log(
                        job_id,
                        format!("NVENC unavailable on this machine; falling back to libx264. reason={}", reason),
                    );
                }
            }
            Some(capabilities)
        }
        _ => None,
    };

    let stabilization_params = if matches!(task, ProcessTask::Stabilize) {
        let params = job_id
            .as_deref()
            .and_then(|id| {
                stabilize_params_store()
                    .lock()
                    .ok()
                    .and_then(|store| store.get(id).copied())
            })
            .unwrap_or(StabilizeParams {
                mode: StabilizationMode::EdgeSafe,
                strength: StabilizationStrength::Balanced,
                preserve_source_bitrate: true,
            });

        if let Some(job_id) = &job_id {
            append_process_job_log(
                job_id,
                format!(
                    "stabilization params mode={} strength={} preserve_source_bitrate={}",
                    params.mode.as_str(),
                    params.strength.as_str(),
                    params.preserve_source_bitrate
                ),
            );
        }

        Some(params)
    } else {
        None
    };

    let stabilize_load_policy = if matches!(task, ProcessTask::Stabilize) {
        let policy = stabilization_load_policy(Some(&app));
        let cores = num_cpus().max(1);

        let _ = append_app_log(
            &app,
            format!(
                "process_stabilize load_policy cores={} max_parallel_jobs={} ffmpeg_threads_per_job={}",
                cores,
                policy.max_parallel_jobs,
                policy.ffmpeg_threads_per_job
            ),
        );

        if let Some(job_id) = &job_id {
            append_process_job_log(
                job_id,
                format!(
                    "load policy: cores={} parallel_jobs={} ffmpeg_threads_per_job={} (source: settings or auto; env override via PHOTOGOGO_STABILIZE_MAX_PARALLEL / PHOTOGOGO_STABILIZE_FFMPEG_THREADS)",
                    cores,
                    policy.max_parallel_jobs,
                    policy.ffmpeg_threads_per_job
                ),
            );
            update_process_job(job_id, |job| {
                job.stabilize_max_parallel_jobs_used = Some(policy.max_parallel_jobs);
                job.stabilize_ffmpeg_threads_per_job_used = Some(policy.ffmpeg_threads_per_job);
            });
        }

        Some(policy)
    } else {
        None
    };

    let app_clone = app.clone();
    let done_clone = done_count.clone();
    let result_clone = result_count.clone();
    let errors_clone = errors.clone();
    let task_clone = task.clone();
    let job_id_clone = job_id.clone();
    let ffmpeg_clone = ffmpeg_capabilities.clone();

    let worker_threads = if matches!(task, ProcessTask::Stabilize) {
        stabilize_load_policy
            .map(|policy| policy.max_parallel_jobs)
            .unwrap_or(1)
    } else {
        (num_cpus() * 2).max(4)
    };

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(worker_threads)
        .build()
        .map_err(|e| e.to_string())?;

    pool.install(|| {
        files.par_iter().for_each(|path| {
            if wait_if_process_paused_or_aborted(job_id_clone.as_deref()) {
                return;
            }

            let result = (|| -> anyhow::Result<()> {
                match task_clone {
                    ProcessTask::Focus => {
                        let img = image::open(path)?;
                        let (max_score, avg_score, focus_pct) = focus_score(&img);
                        if is_out_of_focus(max_score, avg_score, focus_pct) {
                            let n = ((10.0 - max_score).round() as u32).clamp(1, 10);
                            let new_path = mark_blurry_filename(path, n);
                            fs::rename(path, &new_path)?;
                            result_clone.fetch_add(1, Ordering::Relaxed);
                            let _ = append_app_log(&app_clone, format!("process_focus marked_blurry from='{}' to='{}'", path.display(), new_path.display()));
                            if let Some(job_id) = &job_id_clone {
                                append_process_job_log(job_id, format!("marked blurry '{}' -> '{}'", path.display(), new_path.display()));
                            }
                        }
                    }
                    ProcessTask::RemoveFocus => {
                        let restored_path = restore_blurry_filename(path)
                            .ok_or_else(|| anyhow::anyhow!("File name does not contain a removable out-of-focus marker"))?;
                        if restored_path.exists() {
                            return Err(anyhow::anyhow!(
                                "Cannot restore '{}' because '{}' already exists",
                                path.display(),
                                restored_path.display()
                            ));
                        }
                        fs::rename(path, &restored_path)?;
                        result_clone.fetch_add(1, Ordering::Relaxed);
                        let _ = append_app_log(&app_clone, format!("process_remove_focus restored='{}' to='{}'", path.display(), restored_path.display()));
                        if let Some(job_id) = &job_id_clone {
                            append_process_job_log(job_id, format!("restored focus marker '{}' -> '{}'", path.display(), restored_path.display()));
                        }
                    }
                    ProcessTask::Enhance => {
                        let img = image::open(path)?.into_rgb8();
                        let enhanced = enhance_rgb_clahe(&img);
                        
                        // Retrieve enhancement parameters from job ID, or use defaults
                        let params = if let Some(job_id) = &job_id_clone {
                            if let Ok(params_store) = enhance_params_store().lock() {
                                params_store.get(job_id).cloned()
                            } else {
                                None
                            }
                        } else {
                            None
                        };
                        
                        let contrast_level = params.as_ref().map(|p| p.contrast_level).unwrap_or(1.0);
                        let sharpness_level = params.as_ref().map(|p| p.sharpness_level).unwrap_or(0.5);
                        let sharpened = unsharp_mask_rgb(&enhanced, contrast_level, sharpness_level);
                        
                        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                        let out_path = path.parent().unwrap_or(Path::new(".")).join(format!("{}_improved.jpg", stem));
                        let replaced_existing = out_path.exists();
                        sharpened.save(&out_path)?;
                        sync_file_metadata_from(path, &out_path, false).map_err(anyhow::Error::msg)?;
                        result_clone.fetch_add(1, Ordering::Relaxed);
                        let _ = append_app_log(&app_clone, format!("process_enhance wrote='{}' replaced_existing={} contrast={:.2} sharpness={:.2}", out_path.display(), replaced_existing, contrast_level, sharpness_level));
                        if let Some(job_id) = &job_id_clone {
                            append_process_job_log(job_id, format!("enhanced '{}' -> '{}' (contrast={:.2}x sharpness={:.2})", path.display(), out_path.display(), contrast_level, sharpness_level));
                        }
                    }
                    ProcessTask::RemoveEnhance => {
                        fs::remove_file(path)?;
                        result_clone.fetch_add(1, Ordering::Relaxed);
                        let _ = append_app_log(&app_clone, format!("process_remove_enhance removed='{}'", path.display()));
                        if let Some(job_id) = &job_id_clone {
                            append_process_job_log(job_id, format!("removed enhance output '{}'", path.display()));
                        }
                    }
                    ProcessTask::Bw => {
                        let img = image::open(path)?.into_luma8();
                        let clahe = apply_clahe_luma(&img);
                        let sharpened = unsharp_mask_gray(&clahe, 1.0, 0.6);
                        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                        let out_path = path.parent().unwrap_or(Path::new(".")).join(format!("{}_BW.jpg", stem));
                        let replaced_existing = out_path.exists();
                        sharpened.save(&out_path)?;
                        sync_file_metadata_from(path, &out_path, false).map_err(anyhow::Error::msg)?;
                        result_clone.fetch_add(1, Ordering::Relaxed);
                        let _ = append_app_log(&app_clone, format!("process_bw wrote='{}' replaced_existing={}", out_path.display(), replaced_existing));
                        if let Some(job_id) = &job_id_clone {
                            append_process_job_log(job_id, format!("bw '{}' -> '{}' (replaced_existing={})", path.display(), out_path.display(), replaced_existing));
                        }
                    }
                    ProcessTask::RemoveBw => {
                        fs::remove_file(path)?;
                        result_clone.fetch_add(1, Ordering::Relaxed);
                        let _ = append_app_log(&app_clone, format!("process_remove_bw removed='{}'", path.display()));
                        if let Some(job_id) = &job_id_clone {
                            append_process_job_log(job_id, format!("removed bw output '{}'", path.display()));
                        }
                    }
                    ProcessTask::Stabilize => {
                        let capabilities = ffmpeg_clone
                            .as_ref()
                            .ok_or_else(|| anyhow::anyhow!("FFmpeg capability probe was not initialised"))?;
                        let params = stabilization_params.unwrap_or(StabilizeParams {
                            mode: StabilizationMode::EdgeSafe,
                            strength: StabilizationStrength::Balanced,
                            preserve_source_bitrate: true,
                        });
                        let ffmpeg_threads = stabilize_load_policy
                            .map(|policy| policy.ffmpeg_threads_per_job)
                            .unwrap_or(2);
                        stabilize_mp4(
                            &app_clone,
                            path,
                            capabilities,
                            job_id_clone.as_deref(),
                            params.mode,
                            params.strength,
                            params.preserve_source_bitrate,
                            ffmpeg_threads,
                        )?;
                        result_clone.fetch_add(1, Ordering::Relaxed);
                    }
                    ProcessTask::RemoveStabilize => {
                        fs::remove_file(path)?;
                        result_clone.fetch_add(1, Ordering::Relaxed);
                        let _ = append_app_log(&app_clone, format!("process_remove_stabilize removed='{}'", path.display()));
                        if let Some(job_id) = &job_id_clone {
                            append_process_job_log(job_id, format!("removed stabilized output '{}'", path.display()));
                        }
                    }
                    ProcessTask::ScanArchiveNaming => {}
                    ProcessTask::ApplyEventNaming => {}
                    ProcessTask::Transfer | ProcessTask::VerifyChecksums => {}
                    ProcessTask::ScanFaces | ProcessTask::SearchPersonVideos => {}
                }
                Ok(())
            })();

            if let Err(e) = result {
                errors_clone.lock().unwrap().push(format!("{}: {}", path.display(), e));
                let _ = append_app_log(&app_clone, format!("process_{} error file='{}' message='{}'", task_name(&task_clone), path.display(), e));
                if let Some(job_id) = &job_id_clone {
                    append_process_job_log(job_id, format!("error '{}' => {}", path.display(), e));
                }
            }

            let done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;
            let current_file = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            let _ = app_clone.emit(
                "process-progress",
                ProcessProgress {
                    total,
                    done: done as usize,
                    current_file: current_file.clone(),
                    phase: task_name(&task_clone).to_string(),
                    speed_mbps: None,
                },
            );

            if let Some(job_id) = &job_id_clone {
                update_process_job(job_id, |job| {
                    job.done = done as usize;
                    job.processed = done as usize;
                    job.result_count = result_clone.load(Ordering::Relaxed) as usize;
                    job.current_file = current_file.clone();
                });
            }
        });
    });

    let final_errors = errors.lock().unwrap().clone();
    let processed = done_count.load(Ordering::Relaxed) as usize;
    let result_total = result_count.load(Ordering::Relaxed) as usize;
    let was_aborted = job_id
        .as_ref()
        .and_then(|id| process_jobs_store().lock().ok().and_then(|jobs| jobs.get(id).map(|j| j.abort_requested)))
        .unwrap_or(false);

    let _ = append_app_log(&app, format!("process_{} complete processed={} {}={} errors={} scope_mode={:?}", task_label, processed, task_result_label(&task), result_total, final_errors.len(), scope_mode));

    if let Some(job_id) = &job_id {
        let failed = !final_errors.is_empty();
        update_process_job(job_id, |job| {
            job.status = if was_aborted {
                ProcessJobStatus::Aborted
            } else if failed {
                ProcessJobStatus::Failed
            } else {
                ProcessJobStatus::Completed
            };
            job.finished_at = Some(now_string());
            job.done = processed;
            job.processed = processed;
            job.result_count = result_total;
            job.errors = final_errors.clone();
            job.current_file = "Done".to_string();
        });

        if was_aborted {
            append_process_job_log(job_id, format!("aborted processed={} {}={} errors={}", processed, task_result_label(&task), result_total, final_errors.len()));
        } else {
            append_process_job_log(job_id, format!("complete processed={} {}={} errors={}", processed, task_result_label(&task), result_total, final_errors.len()));
        }
    }

    Ok(ProcessResult {
        processed,
        result_count: result_total,
        errors: final_errors,
    })
}

#[tauri::command]
pub fn check_face_scan_environment() -> Result<faces::FaceScanEnvironmentCheck, String> {
    Ok(faces::check_scan_environment())
}

#[tauri::command]
pub fn start_process_job(
    app: AppHandle,
    staging_dir: String,
    scope_dir: Option<String>,
    scope_mode: Option<ProcessScopeMode>,
    task: String,
    enhance_contrast_level: Option<f32>,
    enhance_sharpness_level: Option<f32>,
    stabilization_mode: Option<String>,
    stabilization_strength: Option<String>,
    preserve_source_bitrate: Option<bool>,
    frames_per_second: Option<usize>,
    similarity_threshold: Option<f32>,
    person_name: Option<String>,
) -> Result<String, String> {
    let task_enum = match task.to_lowercase().as_str() {
        "focus" => ProcessTask::Focus,
        "remove_focus" => ProcessTask::RemoveFocus,
        "enhance" => ProcessTask::Enhance,
        "remove_enhance" => ProcessTask::RemoveEnhance,
        "bw" => ProcessTask::Bw,
        "remove_bw" => ProcessTask::RemoveBw,
        "stabilize" => ProcessTask::Stabilize,
        "remove_stabilize" => ProcessTask::RemoveStabilize,
        "scan_archive_naming" => ProcessTask::ScanArchiveNaming,
        "scan_faces" => ProcessTask::ScanFaces,
        "search_person_videos" => ProcessTask::SearchPersonVideos,
        "transfer" | "verify_checksums" => return Err("Use start_transfer or verify_checksums commands directly".to_string()),
        _ => return Err(format!("Unknown process task: {}", task)),
    };

    let parsed_stabilization_mode = match stabilization_mode.as_deref() {
        Some(raw) => Some(
            StabilizationMode::parse(raw)
                .ok_or_else(|| format!("Unknown stabilization mode: {}", raw))?,
        ),
        None => None,
    };

    let parsed_stabilization_strength = match stabilization_strength.as_deref() {
        Some(raw) => Some(
            StabilizationStrength::parse(raw)
                .ok_or_else(|| format!("Unknown stabilization strength: {}", raw))?,
        ),
        None => None,
    };

    if !matches!(task_enum, ProcessTask::Stabilize)
        && (parsed_stabilization_mode.is_some()
            || parsed_stabilization_strength.is_some()
            || preserve_source_bitrate.is_some())
    {
        return Err("stabilization options are only supported for the stabilize task".to_string());
    }

    let queued_stabilization_mode = if matches!(task_enum, ProcessTask::Stabilize) {
        Some(parsed_stabilization_mode.unwrap_or(StabilizationMode::EdgeSafe))
    } else {
        None
    };

    let queued_stabilization_strength = if matches!(task_enum, ProcessTask::Stabilize) {
        Some(parsed_stabilization_strength.unwrap_or(StabilizationStrength::Balanced))
    } else {
        None
    };

    let queued_preserve_source_bitrate = if matches!(task_enum, ProcessTask::Stabilize) {
        Some(preserve_source_bitrate.unwrap_or(true))
    } else {
        None
    };

    let job_id = next_process_job_id();
    let job = ProcessJob {
        id: job_id.clone(),
        task: task_enum.clone(),
        staging_dir: staging_dir.clone(),
        scope_dir: scope_dir.clone().unwrap_or_else(|| staging_dir.clone()),
        scope_mode: scope_mode.clone().unwrap_or(ProcessScopeMode::FolderRecursive),
        status: ProcessJobStatus::Queued,
        created_at: now_string(),
        started_at: None,
        finished_at: None,
        total: 0,
        done: 0,
        processed: 0,
        result_count: 0,
        current_file: "Queued".to_string(),
        archive_dir: None,
        conflict_report_path: None,
        current_phase: None,
        speed_mbps: None,
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
        stabilization_mode: queued_stabilization_mode,
        stabilization_strength: queued_stabilization_strength,
        preserve_source_bitrate: queued_preserve_source_bitrate,
        stabilize_max_parallel_jobs_used: None,
        stabilize_ffmpeg_threads_per_job_used: None,
        frames_per_second,
        similarity_threshold,
        videos_scanned: None,
        faces_detected: None,
        unique_people: None,
        person_name,
        errors: vec![],
        logs: vec![format!("[{}] queued", now_string())],
        status_line: String::new(),
        pause_requested: false,
        abort_requested: false,
    };

    {
        let mut jobs = process_jobs_store().lock().map_err(|e| e.to_string())?;
        jobs.insert(job_id.clone(), job);
    }

    // Store enhancement parameters if provided
    if enhance_contrast_level.is_some() || enhance_sharpness_level.is_some() {
        let params = EnhanceParams {
            contrast_level: enhance_contrast_level.unwrap_or(1.0),
            sharpness_level: enhance_sharpness_level.unwrap_or(0.5),
        };
        if let Ok(mut params_store) = enhance_params_store().lock() {
            params_store.insert(job_id.clone(), params);
        }
    }

    if matches!(task_enum, ProcessTask::Stabilize) {
        let mode = queued_stabilization_mode.unwrap_or(StabilizationMode::EdgeSafe);
        let strength = queued_stabilization_strength.unwrap_or(StabilizationStrength::Balanced);
        let preserve = queued_preserve_source_bitrate.unwrap_or(true);
        if let Ok(mut params_store) = stabilize_params_store().lock() {
            params_store.insert(
                job_id.clone(),
                StabilizeParams {
                    mode,
                    strength,
                    preserve_source_bitrate: preserve,
                },
            );
        }
        append_process_job_log(
            &job_id,
            format!(
                "queued stabilization mode={} strength={} preserve_source_bitrate={}",
                mode.as_str(),
                strength.as_str(),
                preserve
            ),
        );
    }

    let app_for_task = app.clone();
    let job_id_for_task = job_id.clone();
    let job_id_for_status = job_id.clone();
    let task_for_worker = task_enum.clone();
    let task_for_status = task_enum.clone();
    let app_for_status = app.clone();
    async_runtime::spawn(async move {
        let result = async_runtime::spawn_blocking(move || {
            run_process_task(app_for_task, staging_dir, scope_dir, scope_mode, task_for_worker, Some(job_id_for_task))
        })
        .await;

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
                let _ = append_app_log(&app_for_status, format!("process_{} failed job_id='{}' error='{}'", task_name(&task_for_status), job_id_for_status, err));
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
                let _ = append_app_log(&app_for_status, format!("process_{} join_failed job_id='{}' error='{}'", task_name(&task_for_status), job_id_for_status, err));
            }
        }

        if let Ok(mut enhance_store) = enhance_params_store().lock() {
            enhance_store.remove(&job_id_for_status);
        }
        if let Ok(mut stabilize_store) = stabilize_params_store().lock() {
            stabilize_store.remove(&job_id_for_status);
        }
    });

    Ok(job_id)
}

#[tauri::command]
pub fn start_event_naming_job(
    app: AppHandle,
    staging_dir: String,
    request: ApplyEventNamingRequest,
) -> Result<String, String> {
    let job_id = next_process_job_id();
    let selected_count = if request.assignments.is_empty() {
        request.directories.len()
    } else {
        request.assignments.len()
    };

    let job = ProcessJob {
        id: job_id.clone(),
        task: ProcessTask::ApplyEventNaming,
        staging_dir: staging_dir.clone(),
        scope_dir: staging_dir.clone(),
        scope_mode: ProcessScopeMode::FolderOnly,
        status: ProcessJobStatus::Queued,
        created_at: now_string(),
        started_at: None,
        finished_at: None,
        total: selected_count,
        done: 0,
        processed: 0,
        result_count: 0,
        current_file: "Queued".to_string(),
        archive_dir: None,
        conflict_report_path: None,
        current_phase: None,
        speed_mbps: None,
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
        stabilization_mode: None,
        stabilization_strength: None,
        preserve_source_bitrate: None,
        stabilize_max_parallel_jobs_used: None,
        stabilize_ffmpeg_threads_per_job_used: None,
        frames_per_second: None,
        similarity_threshold: None,
        videos_scanned: None,
        faces_detected: None,
        unique_people: None,
        person_name: None,
        errors: vec![],
        logs: vec![format!("[{}] queued apply_event_naming selected_directories={}", now_string(), selected_count)],
        status_line: String::new(),
        pause_requested: false,
        abort_requested: false,
    };

    {
        let mut jobs = process_jobs_store().lock().map_err(|e| e.to_string())?;
        jobs.insert(job_id.clone(), job);
    }

    {
        let mut requests = naming_requests_store().lock().map_err(|e| e.to_string())?;
        requests.insert(job_id.clone(), request);
    }

    let app_for_task = app.clone();
    let app_for_status = app.clone();
    let job_id_for_task = job_id.clone();
    let job_id_for_status = job_id.clone();
    let staging_dir_for_task = staging_dir.clone();

    async_runtime::spawn(async move {
        let result = async_runtime::spawn_blocking(move || {
            run_process_task(
                app_for_task,
                staging_dir_for_task,
                Some(staging_dir.clone()),
                Some(ProcessScopeMode::FolderOnly),
                ProcessTask::ApplyEventNaming,
                Some(job_id_for_task),
            )
        })
        .await;

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
                let _ = append_app_log(
                    &app_for_status,
                    format!("process_apply_event_naming failed job_id='{}' error='{}'", job_id_for_status, err),
                );
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
                let _ = append_app_log(
                    &app_for_status,
                    format!("process_apply_event_naming join_failed job_id='{}' error='{}'", job_id_for_status, err),
                );
            }
        }

        if let Ok(mut requests) = naming_requests_store().lock() {
            requests.remove(&job_id_for_status);
        }
    });

    Ok(job_id)
}

/// Scan videos in archive directory for faces and build face database
fn run_scan_faces_task(
    app: AppHandle,
    archive_dir: String,
    scope_dir: Option<String>,
    scope_mode: Option<ProcessScopeMode>,
    job_id: Option<String>,
) -> Result<ProcessResult, String> {
    let task_label = "scan_faces";
    let archive_path = PathBuf::from(&archive_dir);

    if !archive_path.exists() {
        return Err(format!("Archive directory does not exist: {}", archive_dir));
    }

    let scope_mode = scope_mode.unwrap_or(ProcessScopeMode::FolderRecursive);
    let scope = resolve_process_scope(&archive_dir, scope_dir, &scope_mode)?;
    let recursive = !matches!(scope_mode, ProcessScopeMode::FolderOnly);

    if let Some(job_id) = &job_id {
        update_process_job(job_id, |job| {
            job.status = ProcessJobStatus::Running;
            job.started_at = Some(now_string());
            job.current_phase = Some("Collecting videos".to_string());
            job.scope_dir = scope.to_string_lossy().into_owned();
            job.scope_mode = scope_mode.clone();
        });
    }

    let _ = append_app_log(
        &app,
        format!(
            "process_{} start archive='{}' scope='{}' scope_mode={:?} collecting videos",
            task_label,
            archive_dir,
            scope.display(),
            scope_mode
        ),
    );

    // Get frames_per_second and similarity_threshold from job if available
    let frames_per_second = job_id.as_ref()
        .and_then(|id| process_jobs_store().lock().ok()
            .and_then(|store| store.get(id).and_then(|job| job.frames_per_second)))
        .unwrap_or(1);

    let similarity_threshold = job_id.as_ref()
        .and_then(|id| process_jobs_store().lock().ok()
            .and_then(|store| store.get(id).and_then(|job| job.similarity_threshold)))
        .unwrap_or(0.6);

    if let Some(job_id) = &job_id {
        append_process_job_log(
            job_id,
            format!(
                "scan config scope='{}' mode={:?} fps={} similarity_threshold={:.2}",
                scope.display(),
                scope_mode,
                frames_per_second,
                similarity_threshold
            ),
        );
    }

    // Get list of videos
    let videos = faces::collect_video_files(&scope, recursive);
    let total_videos = videos.len();

    if let Some(job_id) = &job_id {
        append_process_job_log(job_id, format!("found {} video(s) to scan", total_videos));
    }

    if total_videos == 0 {
        let empty_msg = format!("No videos found in selected scope: {}", scope.display());
        if let Some(job_id) = &job_id {
            update_process_job(job_id, |job| {
                job.status = ProcessJobStatus::Completed;
                job.finished_at = Some(now_string());
                job.current_file = "Done".to_string();
                job.videos_scanned = Some(0);
                job.faces_detected = Some(0);
                job.unique_people = Some(0);
                job.errors.push(empty_msg.clone());
            });
            append_process_job_log(job_id, empty_msg.clone());
        }
        return Ok(ProcessResult {
            processed: 0,
            result_count: 0,
            errors: vec![empty_msg],
        });
    }

    let mut face_db = faces::FaceDatabase::load(&archive_path.join(".faces_db.json"))
        .unwrap_or_else(|_| faces::FaceDatabase::new());

    let mut total_faces = 0;
    let unique_people: usize;

    for (idx, video_path) in videos.iter().enumerate() {
        if let Some(job_id) = &job_id {
            if is_process_abort_requested(Some(job_id)) {
                update_process_job(job_id, |job| {
                    job.status = ProcessJobStatus::Aborted;
                    job.finished_at = Some(now_string());
                });
                return Err("Face scanning aborted".to_string());
            }

            let rel_path = video_path
                .strip_prefix(&archive_path)
                .unwrap_or(video_path)
                .to_string_lossy();

            update_process_job(job_id, |job| {
                job.total = total_videos;
                job.done = idx + 1;
                job.processed = idx + 1;
                job.current_file = rel_path.to_string();
                job.current_phase = Some(format!("Scanning video {}/{}", idx + 1, total_videos));
            });

            if idx == 0 || (idx + 1) % 25 == 0 || (idx + 1) == total_videos {
                append_process_job_log(
                    job_id,
                    format!(
                        "progress {}/{} current='{}' faces_detected_so_far={}",
                        idx + 1,
                        total_videos,
                        rel_path,
                        total_faces
                    ),
                );
            }
        }

        // Call Python deepface worker and persist detections.
        match faces::detect_faces_in_video(video_path, frames_per_second, similarity_threshold) {
            Ok(face_results) => {
                total_faces += face_results.len();
                let source_video = video_path.to_string_lossy().to_string();

                for (_person_id, embedding, timestamp_ms, confidence) in face_results {
                    if embedding.is_empty() {
                        continue;
                    }

                    let person_id = faces::assign_person_id(&face_db, &embedding, similarity_threshold);
                    let person_name = person_id.clone();
                    face_db.faces.push(faces::FaceEmbedding {
                        person_id,
                        person_name,
                        embedding,
                        source_video: source_video.clone(),
                        timestamp_ms,
                        confidence,
                    });
                }
            }
            Err(err) => {
                if let Some(job_id) = &job_id {
                    append_process_job_log(job_id, format!("face detector error on '{}': {}", video_path.display(), err));
                }
                return Err(format!("Face detection failed for '{}': {}", video_path.display(), err));
            }
        }
    }

    // Save updated database
    let db_path = archive_path.join(".faces_db.json");
    face_db.save(&db_path)
        .map_err(|e| format!("Failed to save face database: {}", e))?;

    unique_people = face_db.get_people().len();

    if let Some(job_id) = &job_id {
        update_process_job(job_id, |job| {
            job.status = ProcessJobStatus::Completed;
            job.finished_at = Some(now_string());
            job.current_file = "Done".to_string();
            job.current_phase = Some("Scan complete".to_string());
            job.videos_scanned = Some(total_videos);
            job.faces_detected = Some(total_faces);
            job.unique_people = Some(unique_people);
        });
        append_process_job_log(
            job_id,
            format!(
                "completed: {} videos scanned, {} faces detected, {} unique people",
                total_videos, total_faces, unique_people
            ),
        );
    }

    let _ = append_app_log(
        &app,
        format!(
            "process_{} completed videos={} faces={} people={}",
            task_label, total_videos, total_faces, unique_people
        ),
    );

    Ok(ProcessResult {
        processed: total_videos,
        result_count: total_faces,
        errors: vec![],
    })
}

/// Search for videos containing a specific person
fn run_search_person_videos_task(
    app: AppHandle,
    archive_dir: String,
    scope_dir: Option<String>,
    scope_mode: Option<ProcessScopeMode>,
    job_id: Option<String>,
) -> Result<ProcessResult, String> {
    let task_label = "search_person_videos";
    let archive_path = PathBuf::from(&archive_dir);
    let db_path = archive_path.join(".faces_db.json");
    let scope_mode = scope_mode.unwrap_or(ProcessScopeMode::FolderRecursive);
    let scope = resolve_process_scope(&archive_dir, scope_dir, &scope_mode)?;

    // Load face database
    let face_db = faces::FaceDatabase::load(&db_path)
        .map_err(|e| format!("Failed to load face database: {}", e))?;

    // Get person_name from job
    let person_name = job_id.as_ref()
        .and_then(|id| process_jobs_store().lock().ok()
            .and_then(|store| store.get(id).and_then(|job| job.person_name.clone())))
        .ok_or_else(|| "Missing person name for search".to_string())?;

    // Find matching person in database
    let people = face_db.get_people();
    let person = people.iter()
        .find(|p| p.person_name.eq_ignore_ascii_case(&person_name))
        .ok_or_else(|| format!("Person '{}' not found in database", person_name))?;

    // Search for videos matching this person
    let mut search_result = face_db.search_person(&person.person_id, &archive_path);
    search_result.matches.retain(|m| {
        let path = PathBuf::from(&m.video_path);
        if matches!(scope_mode, ProcessScopeMode::FolderOnly) {
            path.parent() == Some(scope.as_path())
        } else {
            path.starts_with(&scope)
        }
    });
    let match_count = search_result.matches.len();

    if let Some(job_id) = &job_id {
        update_process_job(job_id, |job| {
            job.status = ProcessJobStatus::Completed;
            job.finished_at = Some(now_string());
            job.current_file = "Done".to_string();
            job.current_phase = Some("Search complete".to_string());
            job.result_count = match_count;
            job.scope_dir = scope.to_string_lossy().into_owned();
            job.scope_mode = scope_mode.clone();
        });
        append_process_job_log(
            job_id,
            format!(
                "found {} videos with '{}' in scope '{}' mode={:?}",
                match_count,
                person_name,
                scope.display(),
                scope_mode
            ),
        );
    }

    let _ = append_app_log(
        &app,
        format!(
            "process_{} completed: found {} videos with '{}' in scope '{}' mode={:?}",
            task_label,
            match_count,
            person_name,
            scope.display(),
            scope_mode
        ),
    );

    Ok(ProcessResult {
        processed: 1,
        result_count: match_count,
        errors: vec![],
    })
}
