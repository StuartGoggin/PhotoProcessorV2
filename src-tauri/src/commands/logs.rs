use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::utils::{app_log_path, clear_app_log, read_app_log};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogFileResponse {
    pub path: String,
    pub contents: String,
}

#[tauri::command]
pub fn read_log_file(app: AppHandle) -> Result<LogFileResponse, String> {
    Ok(LogFileResponse {
        path: app_log_path(&app).to_string_lossy().to_string(),
        contents: read_app_log(&app)?,
    })
}

#[tauri::command]
pub fn clear_log_file(app: AppHandle) -> Result<(), String> {
    clear_app_log(&app)
}
