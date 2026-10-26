//! Adapter into the existing Process job interface. Protected Job remains the
//! only authoritative upload state; cached ProcessJobs are read-only views.
use super::{diagnostics, engine::Job, oauth, protected, workspace, writer_lease};
use crate::commands::{
    process::{ProcessJob, ProcessJobStatus, ProcessScopeMode, ProcessTask},
    process_runtime::{self, Kind},
};
use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::AppHandle;

struct Cache {
    root: PathBuf,
    at: Option<Instant>,
    jobs: Vec<ProcessJob>,
    warnings: Vec<String>,
}
fn cache() -> &'static Mutex<Option<Cache>> {
    static CACHE: OnceLock<Mutex<Option<Cache>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}
pub(super) fn invalidate() {
    if let Ok(mut cache) = cache().lock() {
        if let Some(cache) = cache.as_mut() {
            cache.at = None;
        }
    }
}
pub(super) fn history_eligible(job: &Job) -> bool {
    matches!(job.status.as_str(), "completed" | "completed_with_warnings")
        && job.errors.is_empty()
        && job.items.iter().all(super::engine::resolved_receipt)
        && job
            .albums
            .iter()
            .all(|album| album.state != "creation_outcome_unknown")
}
pub(super) fn project(job: &Job, account_id: Option<&str>) -> ProcessJob {
    let mut summary = job.summary();
    let status = match job.status.as_str() {
        "queued" => ProcessJobStatus::Queued,
        "running" => ProcessJobStatus::Running,
        "paused" => ProcessJobStatus::Paused,
        "aborted" | "cancelled" => ProcessJobStatus::Aborted,
        "completed" if history_eligible(job) => ProcessJobStatus::Completed,
        "completed_with_warnings" if history_eligible(job) => {
            ProcessJobStatus::CompletedWithWarnings
        }
        "failed" => ProcessJobStatus::Failed,
        _ => ProcessJobStatus::NeedsAttention,
    };
    let blocked = if account_id != Some(job.plan.account_id.as_str()) {
        Some("Reconnect the original Google account and unchanged OAuth client before continuing this job.".into())
    } else if job.retry_after > chrono::Utc::now().timestamp() {
        Some("Google rate limit: wait before retrying this saved job.".into())
    } else {
        None
    };
    let errors = if !job.errors.is_empty() || summary.failed > 0 {
        vec!["Google Photos needs attention. Open the sanitized job diagnostics for the per-photo status and recovery guidance.".into()]
    } else {
        vec![]
    };
    // Do not promote arbitrary error text into the generic job log/export.
    summary.errors = errors.clone();
    let phase = match job.status.as_str() {
        "paused" => "Paused at a safe checkpoint".into(),
        "aborted" | "cancelled" => "Stopped; registered receipts retained".into(),
        "needs_attention" => "Verification or upload needs attention".into(),
        "completed_with_warnings" => "Completed with verification warnings".into(),
        _ => diagnostics::phase(job),
    };
    ProcessJob {
        id: job.plan.id.clone(),
        task: ProcessTask::GooglePhotos,
        staging_dir: job.plan.root.clone(),
        scope_dir: job.plan.root.clone(),
        scope_mode: ProcessScopeMode::FolderRecursive,
        status,
        created_at: job.plan.created_at.clone(),
        started_at: job.started_at.clone(),
        finished_at: job.finished_at.clone(),
        total: summary.total,
        done: summary.done,
        processed: summary.done,
        result_count: summary.uploaded,
        current_file: summary.current_file.clone(),
        current_phase: Some(phase.clone()),
        status_line: phase,
        archive_dir: None,
        conflict_report_path: None,
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
        face_frames_scanned: None,
        face_frames_total_estimate: None,
        face_videos_in_flight: None,
        face_worker_progress: None,
        videos_scanned: None,
        faces_detected: None,
        unique_people: None,
        person_name: None,
        errors,
        logs: diagnostics::report(job)
            .lines()
            .map(str::to_owned)
            .collect(),
        pause_requested: false,
        abort_requested: false,
        google_photos: Some(summary),
        can_continue: Some(blocked.is_none()),
        control_blocked_reason: blocked,
        persistence_error: None,
    }
}

fn read(app: &AppHandle) -> Result<Vec<ProcessJob>, String> {
    let store = protected(app)?;
    let active = process_runtime::active(Kind::GooglePhotos)?;
    // A different process may own the OS lease: it must not be called interrupted.
    let idle = if active.is_empty() {
        writer_lease(app).ok()
    } else {
        None
    };
    let account = oauth::account(&store).ok().flatten();
    stored_jobs(
        &store,
        account.as_ref().map(|a| a.id.as_str()),
        &active,
        idle.is_some(),
    )
}
pub(super) fn stored_jobs(
    store: &super::store::GoogleStore,
    account_id: Option<&str>,
    active: &[String],
    can_recover: bool,
) -> Result<Vec<ProcessJob>, String> {
    let mut out = Vec::new();
    for key in store.keys("job_")? {
        if let Some(mut job) = store.load::<Job>(&key)? {
            super::validate_id(&job.plan.id)?;
            if key != format!("job_{}", job.plan.id) {
                return Err(
                    "Google Photos saved-job identity is inconsistent; no record was reset.".into(),
                );
            }
            if !active.contains(&job.plan.id) && can_recover {
                job.recover();
            }
            if job.history_hidden && history_eligible(&job) {
                continue;
            }
            let mut row = project(&job, account_id);
            let (stop, abort) = process_runtime::stop_state(&job.plan.id);
            row.pause_requested = stop && !abort;
            row.abort_requested = abort;
            if stop && matches!(job.status.as_str(), "queued" | "running") {
                row.current_phase =
                    Some("Stop requested; finishing a safe upload checkpoint".into());
                row.status_line = "Stop requested; finishing a safe upload checkpoint".into();
            }
            out.push(row);
        }
    }
    Ok(out)
}
pub(super) fn stale_jobs(mut jobs: Vec<ProcessJob>, warning: &str) -> Vec<ProcessJob> {
    for job in &mut jobs {
        job.can_continue = Some(false);
        job.control_blocked_reason = Some(warning.into());
        job.persistence_error = Some(warning.into());
    }
    jobs
}
pub(crate) fn snapshot(app: &AppHandle) -> (Vec<ProcessJob>, Vec<String>) {
    let root = match workspace(app) {
        Ok(root) => root,
        Err(_) => return (vec![], vec!["Google Photos saved jobs are unavailable. Local Photo Process jobs remain available; no cloud records were reset.".into()]),
    };
    let mut cache = match cache().lock() {
        Ok(cache) => cache,
        Err(_) => {
            return (
                vec![],
                vec![
                    "Google Photos job snapshot is unavailable. No saved records were changed."
                        .into(),
                ],
            )
        }
    };
    if let Some(cached) = cache.as_ref().filter(|cached| {
        cached.root == root
            && cached
                .at
                .is_some_and(|at| at.elapsed() < Duration::from_millis(2500))
    }) {
        return (cached.jobs.clone(), cached.warnings.clone());
    }
    let (jobs, warnings) = match read(app) {
        Ok(jobs) => (jobs, vec![]),
        Err(_) => {
            let warning = "Google Photos saved-job refresh failed; showing the last known state with continuation and album actions disabled. Safe stop requests remain available for active jobs. Local Photo Process jobs remain available. No cloud records were reset.".to_string();
            let jobs = cache
                .as_ref()
                .filter(|cached| cached.root == root)
                .map(|cached| cached.jobs.clone())
                .unwrap_or_default();
            (stale_jobs(jobs, &warning), vec![warning])
        }
    };
    *cache = Some(Cache {
        root,
        at: Some(Instant::now()),
        jobs: jobs.clone(),
        warnings: warnings.clone(),
    });
    (jobs, warnings)
}
pub(crate) fn archive_finished(app: &AppHandle) -> Result<usize, String> {
    let Ok(_lease) = writer_lease(app) else {
        return Ok(0);
    };
    let store = protected(app)?;
    let result = archive_store(&store);
    invalidate();
    result
}
pub(super) fn archive_store(store: &super::store::GoogleStore) -> Result<usize, String> {
    let mut count = 0;
    for key in store.keys("job_")? {
        if let Some(mut job) = store.load::<Job>(&key)? {
            super::validate_id(&job.plan.id)?;
            if key != format!("job_{}", job.plan.id) {
                return Err(
                    "Google Photos saved-job identity is inconsistent; history was not reset."
                        .into(),
                );
            }
            job.recover();
            if !job.history_hidden && history_eligible(&job) {
                job.history_hidden = true;
                job.save(store)?;
                count += 1;
            }
        }
    }
    Ok(count)
}
