use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub source_root: String,
    pub staging_dir: String,
    pub archive_dir: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            source_root: String::new(),
            staging_dir: String::new(),
            archive_dir: String::new(),
        }
    }
}

fn settings_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("settings.json");
    path
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Settings, String> {
    let path = settings_path(&app);
    if !path.exists() {
        return Ok(Settings::default());
    }
    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<(), String> {
    let path = settings_path(&app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let data = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, data).map_err(|e| e.to_string())
}
