use super::{
    archive_adaptive::Mode,
    archive_plan::{self, FrozenPlan},
    archive_transfer,
};
use crate::commands::process::{
    append_process_job_log, append_process_milestone_log, next_process_job_id, now_string,
    process_jobs_store, update_process_job, wait_if_process_paused_or_aborted, ProcessJob,
    ProcessJobStatus, ProcessProgress, ProcessScopeMode, ProcessTask,
};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferResult {
    pub copied: usize,
    pub verified: usize,
    pub deduplicated: usize,
    pub renamed: usize,
    pub errors: Vec<String>,
}

#[tauri::command]
pub async fn preview_archive_transfer(
    request: archive_plan::Request,
) -> Result<archive_plan::Preview, String> {
    tauri::async_runtime::spawn_blocking(move || archive_plan::preview(request))
        .await
        .map_err(|_| "Archive preview task failed.".to_string())?
}

#[tauri::command]
pub async fn start_transfer(
    app: AppHandle,
    staging_dir: String,
    archive_dir: String,
    preview_id: Option<String>,
    concurrency: Option<usize>,
) -> Result<String, String> {
    let mode = match concurrency {
        None => Mode::Auto,
        Some(n) if (1..=8).contains(&n) => Mode::Fixed(n),
        _ => return Err("Archive worker limit must be between 1 and 8, or Auto.".into()),
    };
    let id = preview_id.ok_or("Preview the archive selection before queuing a transfer.")?;
    let (stage_for_plan, archive_for_plan) = (staging_dir.clone(), archive_dir.clone());
    let plan = tauri::async_runtime::spawn_blocking(move || {
        archive_plan::take(&id, &stage_for_plan, &archive_for_plan)
    })
    .await
    .map_err(|_| "Archive preview validation failed.".to_string())??;

    let job_id = next_process_job_id();
    let managed =
        super::process_runtime::register(super::process_runtime::Kind::PhotoProcess, &job_id)?;
    let job = ProcessJob {
        id: job_id.clone(),
        task: ProcessTask::Transfer,
        staging_dir: staging_dir.clone(),
        scope_dir: plan.preview.scope_dir.clone(),
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
        google_photos: None,
        can_continue: None,
        control_blocked_reason: None,
        persistence_error: None,
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
            let _managed = managed;
            run_transfer_task(app_clone, Arc::new(plan), Some(job_id_for_task), mode)
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
                append_process_job_log(
                    &job_id_for_status,
                    format!("failed before processing: {}", err),
                );
                let _ = crate::utils::append_app_log(
                    &app_for_status,
                    format!(
                        "process_transfer failed job_id='{}' error='{}'",
                        job_id_for_status, err
                    ),
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
                let _ = crate::utils::append_app_log(
                    &app_for_status,
                    format!(
                        "process_transfer join_failed job_id='{}' error='{}'",
                        job_id_for_status, err
                    ),
                );
            }
        }
    });

    Ok(job_id)
}

#[tauri::command]
pub fn verify_checksums(
    app: AppHandle,
    archive_dir: String,
    verification_scope: Option<String>,
) -> Result<String, String> {
    let archive = archive_plan::resolve(Path::new(&archive_dir))?;
    let scope = verification_scope.unwrap_or_else(|| "archive".into());
    if !matches!(scope.as_str(), "archive" | "latest") {
        return Err("Choose Latest transfer or Whole archive.".into());
    }
    let _ = archive;

    let job_id = next_process_job_id();
    let managed =
        super::process_runtime::register(super::process_runtime::Kind::PhotoProcess, &job_id)?;
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
        google_photos: None,
        can_continue: None,
        control_blocked_reason: None,
        persistence_error: None,
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
    let verification_scope_clone = scope.clone();

    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            let _managed = managed;
            run_verify_task(
                app_clone,
                archive_clone,
                verification_scope_clone,
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
                append_process_job_log(
                    &job_id_for_status,
                    format!("failed before processing: {}", err),
                );
                let _ = crate::utils::append_app_log(
                    &app_for_status,
                    format!(
                        "process_verify failed job_id='{}' error='{}'",
                        job_id_for_status, err
                    ),
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
                let _ = crate::utils::append_app_log(
                    &app_for_status,
                    format!(
                        "process_verify join_failed job_id='{}' error='{}'",
                        job_id_for_status, err
                    ),
                );
            }
        }
    });

    Ok(job_id)
}

fn show_progress(
    app: &AppHandle,
    job_id: Option<&str>,
    p: &archive_transfer::Progress,
    phase: &str,
    mode: &str,
) {
    let seconds = p.elapsed.as_secs_f64().max(0.001);
    let copied_rate = p.copied_bytes as f64 / 1048576.0 / seconds;
    let verified_rate = p.verified_bytes as f64 / 1048576.0 / seconds;
    if let Some(id) = job_id {
        update_process_job(id, |job| {
            job.current_phase = Some(phase.into());
            job.total = p.total;
            job.done = p.done;
            job.processed = if phase.starts_with("verify_") {
                p.done
            } else {
                p.copied
            };
            job.result_count = if phase.starts_with("verify_") {
                p.hashed
            } else {
                p.copied + p.deduplicated
            };
            job.speed_mbps = Some(copied_rate);
            job.current_file = p.current_file.clone();
            job.transfer_local_processed_count = Some(p.hashed);
            job.transfer_local_hash_computed_count = Some(p.hashed);
            job.transfer_uploaded_count = Some(p.copied);
            job.transfer_deduplicated_count = Some(p.deduplicated);
            job.transfer_renamed_count = Some(p.renamed);
            job.transfer_indexed_added_count = Some(p.indexed);
            job.status_line=format!("{mode} · {} worker limit / {} active · {} hashing, {} checking, {} copying, {} verifying · {:.1} MiB/s verified · {:.1} MiB/s copied · {:.1}/{:.1} MiB selected bytes verified",p.workers,p.active,p.hashing,p.checking,p.copying,p.verifying,verified_rate,copied_rate,p.verified_bytes as f64/1048576.0,p.total_bytes as f64/1048576.0);
            if let Some(decision) = p.decision {
                job.status_line.push_str(&format!(" · {}", decision.reason));
            }
        });
    }
    let _ = app.emit(
        "process-progress",
        ProcessProgress {
            total: p.total,
            done: p.done,
            current_file: p.current_file.clone(),
            phase: phase.into(),
            speed_mbps: Some(copied_rate),
        },
    );
}
fn run_transfer_task(
    app: AppHandle,
    plan: Arc<FrozenPlan>,
    job_id: Option<String>,
    mode: Mode,
) -> Result<TransferResult, String> {
    let mode_label = match mode {
        Mode::Auto => "Auto",
        Mode::Fixed(_) => "Fixed",
    };
    if let Some(id) = job_id.as_deref() {
        update_process_job(id, |job| {
            job.status = ProcessJobStatus::Running;
            job.started_at = Some(now_string());
            job.current_phase = Some("archive_recovery".into());
            job.current_file = "Validating archive records".into();
        });
        append_process_job_log(
            id,
            format!(
                "ARCHIVE_START: mode={mode_label}; {}",
                plan.policy_description()?
            ),
        );
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let run_id = format!(
        "{nonce:032}-{}",
        job_id
            .as_deref()
            .unwrap_or("manual")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect::<String>()
    );
    let outcome = archive_transfer::run(
        plan,
        &run_id,
        mode,
        || wait_if_process_paused_or_aborted(job_id.as_deref()),
        |p| show_progress(&app, job_id.as_deref(), p, "archive_pipeline", mode_label),
        |message| {
            if let Some(id) = job_id.as_deref() {
                if message.starts_with("ARCHIVE_AUTO:") {
                    append_process_milestone_log(id, message);
                } else {
                    append_process_job_log(id, message);
                }
            }
        },
    )?;
    if let Some(id) = job_id.as_deref() {
        update_process_job(id, |job| {
            job.status = if outcome.aborted {
                ProcessJobStatus::Aborted
            } else if !outcome.errors.is_empty() {
                ProcessJobStatus::Failed
            } else {
                ProcessJobStatus::Completed
            };
            job.finished_at = Some(now_string());
            job.current_phase = Some("done".into());
            job.current_file = if outcome.aborted {
                "Stopped".into()
            } else {
                "Done".into()
            };
            job.processed = outcome.copied;
            job.result_count = outcome.verified;
            job.errors = outcome.errors.clone();
        });
        append_process_job_log(id,format!("ARCHIVE_OUTCOME: copied={} deduplicated={} verified={} renamed={} errors={} manifest='{}'",outcome.copied,outcome.deduplicated,outcome.verified,outcome.renamed,outcome.errors.len(),outcome.manifest.as_ref().map(|p|p.display().to_string()).unwrap_or_default()));
    }
    Ok(TransferResult {
        copied: outcome.copied,
        verified: outcome.verified,
        deduplicated: outcome.deduplicated,
        renamed: outcome.renamed,
        errors: outcome.errors,
    })
}
fn run_verify_task(
    app: AppHandle,
    archive_dir: String,
    scope: String,
    job_id: Option<String>,
) -> Result<TransferResult, String> {
    if let Some(id) = job_id.as_deref() {
        update_process_job(id, |job| {
            job.status = ProcessJobStatus::Running;
            job.started_at = Some(now_string());
            job.current_phase = Some(format!("verify_checksums_{scope}"));
            job.current_file = "Opening explicit verification scope".into();
        });
    }
    let outcome = archive_transfer::verify(
        Path::new(&archive_dir),
        &scope,
        || wait_if_process_paused_or_aborted(job_id.as_deref()),
        |p| {
            show_progress(
                &app,
                job_id.as_deref(),
                p,
                &format!("verify_checksums_{scope}"),
                "Verify Auto",
            )
        },
        |message| {
            if let Some(id) = job_id.as_deref() {
                append_process_job_log(id, message);
            }
        },
    )?;
    if let Some(id) = job_id.as_deref() {
        update_process_job(id, |job| {
            job.status = if !outcome.errors.is_empty() {
                ProcessJobStatus::Failed
            } else if outcome.aborted {
                ProcessJobStatus::Aborted
            } else {
                ProcessJobStatus::Completed
            };
            job.finished_at = Some(now_string());
            job.result_count = outcome.verified;
            job.errors = outcome.errors.clone();
            job.current_file = "Done".into();
        });
        append_process_job_log(
            id,
            format!(
                "ARCHIVE_VERIFY_OUTCOME: verified={} errors={} scope={scope}",
                outcome.verified,
                outcome.errors.len()
            ),
        );
    }
    Ok(TransferResult {
        copied: 0,
        verified: outcome.verified,
        deduplicated: 0,
        renamed: 0,
        errors: outcome.errors,
    })
}
