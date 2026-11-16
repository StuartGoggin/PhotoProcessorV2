//! Retain the legacy command name without bypassing reviewed capture removal.
#[tauri::command]
pub async fn collect_trash(staging_dir: String) -> Result<usize, String> {
    let _ = staging_dir;
    Err("Open Take out the trash, inspect the exact JPEG + CR3 and generated-file list, and confirm the removal job. Legacy filename-only collection is no longer used.".into())
}
