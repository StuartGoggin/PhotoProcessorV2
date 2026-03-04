//! Commands for the Tidy Up page (trash collection).

use crate::utils::unique_dest;
use std::fs;
use std::path::PathBuf;
use walkdir::WalkDir;

/// Move all files containing `{trash}` in their name into a `Trash/` subdirectory.
/// Returns the number of files moved.
#[tauri::command]
pub async fn collect_trash(staging_dir: String) -> Result<usize, String> {
    let root = PathBuf::from(&staging_dir);
    if !root.exists() {
        return Err(format!("Staging dir does not exist: {}", staging_dir));
    }

    let trash_dir = root.join("Trash");
    fs::create_dir_all(&trash_dir).map_err(|e| e.to_string())?;

    let trash_files: Vec<PathBuf> = WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.contains("{trash}"))
                .unwrap_or(false)
        })
        .collect();

    let count = trash_files.len();
    for path in trash_files {
        let name = path.file_name().unwrap_or_default();
        let dest = unique_dest(trash_dir.join(name));
        fs::rename(&path, &dest).map_err(|e| format!("{}: {}", path.display(), e))?;
    }

    Ok(count)
}
