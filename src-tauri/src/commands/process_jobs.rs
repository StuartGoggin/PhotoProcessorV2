//! Shared job-management interface for local processing and durable executors.
use super::{
    google_photos,
    process::{process_jobs_store, ProcessJob},
};
use chrono::TimeZone;
use serde::Serialize;
use tauri::AppHandle;

#[derive(Serialize)]
pub struct Snapshot {
    pub jobs: Vec<ProcessJob>,
    pub warnings: Vec<String>,
}
pub(crate) fn snapshot(app: &AppHandle) -> Result<Snapshot, String> {
    // Never hold the local task mutex across protected-store/account work.
    let mut jobs: Vec<_> = {
        process_jobs_store()
            .lock()
            .map_err(|_| "Core Photo Process job state is unavailable.")?
            .values()
            .cloned()
            .collect()
    };
    let (cloud, warnings) = google_photos::job_snapshot(app);
    jobs.extend(cloud);
    sort_jobs(&mut jobs);
    Ok(Snapshot { jobs, warnings })
}
fn created_epoch(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|date| date.timestamp_millis())
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S%.f")
                .ok()
                .and_then(|date| chrono::Local.from_local_datetime(&date).earliest())
                .map(|date| date.timestamp_millis())
        })
        .unwrap_or(0)
}
pub(crate) fn sort_jobs(jobs: &mut [ProcessJob]) {
    jobs.sort_by(|a, b| {
        created_epoch(&b.created_at)
            .cmp(&created_epoch(&a.created_at))
            .then_with(|| b.id.cmp(&a.id))
    });
}
#[tauri::command]
pub async fn process_jobs_snapshot(app: AppHandle) -> Result<Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || snapshot(&app))
        .await
        .map_err(|_| "Could not refresh the core job tracker.")?
}
#[tauri::command]
pub async fn retry_process_job(app: AppHandle, job_id: String) -> Result<bool, String> {
    if !google_photos::is_job_id(&job_id) {
        return Err("Review and start a fresh Photo Process job for this task. This saved-job retry is for durable upload recovery.".into());
    }
    google_photos::google_photos_control(app, job_id, "retry".into()).await?;
    Ok(true)
}
#[tauri::command]
pub async fn process_job_diagnostics(app: AppHandle, job_id: String) -> Result<String, String> {
    if google_photos::is_job_id(&job_id) {
        return google_photos::google_photos_job_diagnostics(app, job_id).await;
    }
    let jobs = process_jobs_store()
        .lock()
        .map_err(|_| "Core job log is unavailable.")?;
    Ok(jobs
        .get(&job_id)
        .ok_or("Job was not found.")?
        .logs
        .join("\n"))
}
#[tauri::command]
pub async fn process_job_albums(
    app: AppHandle,
    job_id: String,
) -> Result<Vec<google_photos::CoreAlbum>, String> {
    google_photos::job_albums(app, job_id).await
}
#[tauri::command]
pub fn process_job_open_album(
    app: AppHandle,
    job_id: String,
    album_key: String,
) -> Result<(), String> {
    google_photos::google_photos_open_album(app, job_id, album_key)
}
#[tauri::command]
pub async fn process_job_reconcile_album(
    app: AppHandle,
    job_id: String,
    album_key: String,
    album_id: String,
) -> Result<(), String> {
    google_photos::google_photos_reconcile(app, job_id, album_key, album_id).await
}

#[tauri::command]
pub async fn restore_process_job_history(app: AppHandle, job_id: String) -> Result<bool, String> {
    if !google_photos::is_job_id(&job_id) {
        return Err("Only saved Google Photos history can be restored.".into());
    }
    google_photos::restore_history(app, job_id).await
}
