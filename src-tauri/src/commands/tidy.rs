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
            if p.starts_with(&trash_dir) { return false; }
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.contains("{trash}"))
                .unwrap_or(false)
        })
        .collect();

    let count = trash_files.len();
    // Preflight the entire batch before moving any member out of its portable
    // RAW recipe/ownership folder; recheck each final move under its lease.
    for path in &trash_files {
        let dest = trash_dir.join(path.file_name().unwrap_or_default());
        let _lease = super::raw_development::capture::guard_move(path, &dest)?;
    }
    for path in trash_files {
        let name = path.file_name().unwrap_or_default();
        let dest = unique_dest(trash_dir.join(name));
        let _lease = super::raw_development::capture::guard_move(&path, &dest)?;
        fs::rename(&path, &dest).map_err(|e| format!("{}: {}", path.display(), e))?;
    }

    Ok(count)
}
