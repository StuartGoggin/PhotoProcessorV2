//! Capture review journal and reviewed permanent removal, projected into core Jobs.
pub(crate) mod discard;
pub(crate) mod eligibility;
mod history;
mod journal;
mod model;
mod plan;
pub(crate) mod safety;
pub(crate) mod worker;
pub use model::*;

#[tauri::command]
pub async fn preview_lightbox_trash(
    staging_dir: String,
    relative_dir: String,
    recursive: bool,
) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        plan::remember(plan::build(&staging_dir, &relative_dir, recursive)?)
    })
    .await
    .map_err(|_| "Trash inspection did not finish")?
}
#[tauri::command]
pub async fn start_lightbox_trash_job(
    app: tauri::AppHandle,
    preview_id: String,
    acknowledged: bool,
) -> Result<crate::commands::process::ProcessJob, String> {
    tauri::async_runtime::spawn_blocking(move || worker::start(app, &preview_id, acknowledged))
        .await
        .map_err(|_| "Removal job could not be queued")?
}
#[cfg(test)]
mod tests;
#[tauri::command]
pub async fn apply_lightbox_review_action(request: ActionRequest) -> Result<Receipt, String> {
    tauri::async_runtime::spawn_blocking(move || history::apply(request))
        .await
        .map_err(|_| "Review action could not finish")?
}
#[tauri::command]
pub async fn read_lightbox_review_history(
    staging_dir: String,
    relative_dir: String,
    offset: usize,
    limit: usize,
) -> Result<History, String> {
    tauri::async_runtime::spawn_blocking(move || {
        history::read(&staging_dir, &relative_dir, offset, limit)
    })
    .await
    .map_err(|_| "Review history could not be loaded")?
}
#[tauri::command]
pub async fn replay_lightbox_review_action(request: ReplayRequest) -> Result<Receipt, String> {
    tauri::async_runtime::spawn_blocking(move || history::replay(request))
        .await
        .map_err(|_| "Review history could not be replayed")?
}
#[cfg(test)]
pub(crate) fn decision_test_seam(
    root: &std::path::Path,
    name: &str,
    trashed: bool,
    token: &str,
) -> Result<String, String> {
    let stamp = safety::identity(&root.join(name))?.modified;
    history::apply(ActionRequest {
        staging_dir: root.to_string_lossy().into_owned(),
        relative_path: name.into(),
        expected_source_stamp: stamp,
        action_id: token.into(),
        trashed,
    })
    .map(|r| r.relative_path)
}
