//! Commands for file-level operations used by the Review page.

use crate::utils::base64_encode;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

/// Rename a file in-place, returning the new absolute path.
#[tauri::command]
pub async fn rename_file(old_path: String, new_name: String) -> Result<String, String> {
    let old = PathBuf::from(&old_path);
    let parent = old.parent().ok_or("No parent directory")?;
    let new = parent.join(&new_name);
    fs::rename(&old, &new).map_err(|e| e.to_string())?;
    Ok(new.to_string_lossy().into_owned())
}

/// Read a file and return its contents as a Base64-encoded string.
#[tauri::command]
pub fn read_image_base64(path: String) -> Result<String, String> {
    let data = fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64_encode(&data))
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", target.display()));
    }

    #[cfg(target_os = "windows")]
    {
        let status = if target.is_file() {
            Command::new("explorer")
                .args(["/select,", &path])
                .status()
                .map_err(|e| e.to_string())?
        } else {
            Command::new("explorer")
                .arg(&path)
                .status()
                .map_err(|e| e.to_string())?
        };

        if status.success() {
            Ok(())
        } else {
            Err(format!("Explorer failed for path: {}", target.display()))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Reveal in Explorer is only implemented on Windows".to_string())
    }
}
