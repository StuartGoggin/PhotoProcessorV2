use crate::utils::compute_md5;
use super::settings::load_settings;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StagingTagEntry {
    pub relative_path: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub group_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StagingTagGroup {
    pub id: String,
    pub label: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StagingTagsState {
    pub version: u32,
    #[serde(default)]
    pub entries: Vec<StagingTagEntry>,
    #[serde(default)]
    pub groups: Vec<StagingTagGroup>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetadataTagWriteResult {
    pub dry_run: bool,
    pub planned: usize,
    pub updated: usize,
    pub verified: usize,
    pub verification_failed: usize,
    pub skipped_unsupported: usize,
    pub skipped_no_tags: usize,
    pub failed: usize,
    pub errors: Vec<String>,
    pub backup_dir: Option<String>,
    pub md5_report_path: Option<String>,
    pub exiftool_version: String,
}

fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn tags_file_path(staging_dir: &Path) -> PathBuf {
    staging_dir.join(".photogogo.staging-tags.json")
}

fn normalize_list(values: &[String]) -> Vec<String> {
    let mut seen = HashSet::<String>::new();
    let mut out = Vec::<String>::new();

    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }

        let key = trimmed.to_ascii_lowercase();
        if seen.insert(key) {
            out.push(trimmed.to_string());
        }
    }

    out.sort_by(|a, b| a.to_ascii_lowercase().cmp(&b.to_ascii_lowercase()));
    out
}

fn normalize_state(mut state: StagingTagsState) -> StagingTagsState {
    state.version = 1;

    for entry in &mut state.entries {
        entry.relative_path = entry.relative_path.replace('\\', "/").trim_start_matches('/').to_string();
        entry.tags = normalize_list(&entry.tags);
        entry.group_ids = normalize_list(&entry.group_ids);
    }

    state.entries.retain(|entry| !entry.relative_path.is_empty() && (!entry.tags.is_empty() || !entry.group_ids.is_empty()));
    state.entries.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));

    state.groups.retain(|group| !group.id.trim().is_empty());
    state.groups.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    state
}

fn load_state(staging_dir: &Path) -> Result<StagingTagsState, String> {
    let file_path = tags_file_path(staging_dir);
    if !file_path.exists() {
        return Ok(StagingTagsState {
            version: 1,
            entries: vec![],
            groups: vec![],
        });
    }

    let raw = fs::read_to_string(file_path).map_err(|e| e.to_string())?;
    let parsed = serde_json::from_str::<StagingTagsState>(&raw).map_err(|e| e.to_string())?;
    Ok(normalize_state(parsed))
}

fn save_state(staging_dir: &Path, state: &StagingTagsState) -> Result<StagingTagsState, String> {
    if !staging_dir.exists() {
        return Err(format!("Staging directory does not exist: {}", staging_dir.display()));
    }

    let normalized = normalize_state(state.clone());
    let raw = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    fs::write(tags_file_path(staging_dir), raw).map_err(|e| e.to_string())?;
    Ok(normalized)
}

fn is_metadata_writable_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            ext.eq_ignore_ascii_case("jpg")
                || ext.eq_ignore_ascii_case("jpeg")
                || ext.eq_ignore_ascii_case("mp4")
        })
        .unwrap_or(false)
}

fn resolve_exiftool_program(exiftool_dir: &str) -> PathBuf {
    let trimmed = exiftool_dir.trim();
    if trimmed.is_empty() {
        return PathBuf::from("exiftool");
    }

    let base = PathBuf::from(trimmed);
    #[cfg(target_os = "windows")]
    {
        let exe = base.join("exiftool.exe");
        if exe.exists() {
            return exe;
        }
    }

    let plain = base.join("exiftool");
    if plain.exists() {
        return plain;
    }

    PathBuf::from("exiftool")
}

fn detect_exiftool_version(exiftool_program: &Path) -> Result<String, String> {
    let output = Command::new(exiftool_program)
        .arg("-ver")
        .output()
        .map_err(|e| format!("Failed to execute exiftool: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "exiftool command failed".to_string()
        } else {
            format!("exiftool failed: {}", stderr)
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn write_tags_with_exiftool(exiftool_program: &Path, path: &Path, tags: &[String]) -> Result<(), String> {
    let mut cmd = Command::new(exiftool_program);
    cmd.arg("-overwrite_original")
        .arg("-P")
        .arg("-XMP-dc:Subject=");

    for tag in tags {
        cmd.arg(format!("-XMP-dc:Subject+={}", tag));
    }

    let is_mp4 = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("mp4"))
        .unwrap_or(false);

    if is_mp4 {
        cmd.arg(format!("-Keys:Keywords={}", tags.join(", ")));
    }

    cmd.arg(path.as_os_str());

    let output = cmd.output().map_err(|e| format!("Failed to execute exiftool: {}", e))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let message = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "Unknown exiftool error".to_string()
        };
        Err(message)
    }
}

fn backup_file(staging_dir: &Path, absolute_path: &Path, relative_path: &str, backup_dir: &Path) -> Result<(), String> {
    let _ = staging_dir;
    let backup_path = backup_dir.join(relative_path);
    if let Some(parent) = backup_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(absolute_path, backup_path).map_err(|e| e.to_string())?;
    Ok(())
}

fn read_tags_with_exiftool(exiftool_program: &Path, path: &Path) -> Result<Vec<String>, String> {
    let output = Command::new(exiftool_program)
        .arg("-j")
        .arg("-XMP-dc:Subject")
        .arg("-Keys:Keywords")
        .arg(path.as_os_str())
        .output()
        .map_err(|e| format!("Failed to execute exiftool: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "Failed reading metadata with exiftool".to_string()
        } else {
            stderr
        });
    }

    let value: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let Some(first) = value.as_array().and_then(|items| items.first()) else {
        return Ok(vec![]);
    };

    let mut tags = Vec::<String>::new();
    for field_name in ["XMP:Subject", "Keys:Keywords", "Subject", "Keywords"] {
        if let Some(field) = first.get(field_name) {
            match field {
                serde_json::Value::String(text) => {
                    tags.extend(text.split(',').map(|part| part.trim().to_string()).filter(|part| !part.is_empty()));
                }
                serde_json::Value::Array(items) => {
                    for item in items {
                        if let Some(text) = item.as_str() {
                            let trimmed = text.trim();
                            if !trimmed.is_empty() {
                                tags.push(trimmed.to_string());
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }

    Ok(normalize_list(&tags))
}

fn verify_written_tags(exiftool_program: &Path, path: &Path, expected_tags: &[String]) -> Result<bool, String> {
    let actual_tags = read_tags_with_exiftool(exiftool_program, path)?;
    let actual_lookup = actual_tags
        .into_iter()
        .map(|tag| tag.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    Ok(expected_tags.iter().all(|tag| actual_lookup.contains(&tag.to_ascii_lowercase())))
}

fn build_md5_report_path(staging_dir: &Path) -> PathBuf {
    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    staging_dir
        .join(".photogogo-metadata-rehash")
        .join(format!("metadata-rehash-{}.md5", timestamp))
}

fn write_md5_report(staging_dir: &Path, entries: &[(String, String)]) -> Result<Option<String>, String> {
    if entries.is_empty() {
        return Ok(None);
    }

    let report_path = build_md5_report_path(staging_dir);
    if let Some(parent) = report_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut lines = Vec::<String>::new();
    for (relative_path, md5) in entries {
        lines.push(format!("{} *{}", md5, relative_path.replace('\\', "/")));
    }

    fs::write(&report_path, lines.join("\n")).map_err(|e| e.to_string())?;
    Ok(Some(report_path.to_string_lossy().to_string()))
}

#[tauri::command]
pub fn load_staging_tags(staging_dir: String) -> Result<StagingTagsState, String> {
    let root = PathBuf::from(staging_dir);
    load_state(&root)
}

#[tauri::command]
pub fn apply_staging_tags(
    staging_dir: String,
    relative_paths: Vec<String>,
    tags: Vec<String>,
    create_group: bool,
    group_label: Option<String>,
) -> Result<StagingTagsState, String> {
    let root = PathBuf::from(staging_dir);
    let mut state = load_state(&root)?;

    let clean_paths = normalize_list(&relative_paths)
        .into_iter()
        .map(|value| value.replace('\\', "/").trim_start_matches('/').to_string())
        .collect::<Vec<_>>();
    if clean_paths.is_empty() {
        return Ok(state);
    }

    let clean_tags = normalize_list(&tags);
    let maybe_group_id = if create_group {
        let id = format!("grp-{}", chrono::Utc::now().timestamp_millis());
        let label = group_label
            .unwrap_or_default()
            .trim()
            .to_string();
        state.groups.push(StagingTagGroup {
            id: id.clone(),
            label: if label.is_empty() { format!("Group {}", state.groups.len() + 1) } else { label },
            created_at: now_string(),
        });
        Some(id)
    } else {
        None
    };

    for relative_path in clean_paths {
        if let Some(existing) = state.entries.iter_mut().find(|entry| entry.relative_path == relative_path) {
            if !clean_tags.is_empty() {
                let mut merged_tags = existing.tags.clone();
                merged_tags.extend(clean_tags.clone());
                existing.tags = normalize_list(&merged_tags);
            }

            if let Some(group_id) = maybe_group_id.clone() {
                if !existing.group_ids.iter().any(|id| id == &group_id) {
                    existing.group_ids.push(group_id);
                    existing.group_ids = normalize_list(&existing.group_ids);
                }
            }
        } else {
            let mut entry = StagingTagEntry {
                relative_path,
                tags: clean_tags.clone(),
                group_ids: vec![],
            };

            if let Some(group_id) = maybe_group_id.clone() {
                entry.group_ids.push(group_id);
            }

            state.entries.push(entry);
        }
    }

    save_state(&root, &state)
}

/// Replaces the tags for a single file entirely. Passing an empty `tags` vec
/// removes the file's tag list (but preserves any group membership).
#[tauri::command]
pub fn set_file_staging_tags(
    staging_dir: String,
    relative_path: String,
    tags: Vec<String>,
) -> Result<StagingTagsState, String> {
    let root = PathBuf::from(staging_dir);
    let mut state = load_state(&root)?;

    let clean_path = relative_path
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string();
    let clean_tags = normalize_list(&tags);

    if let Some(existing) = state.entries.iter_mut().find(|e| e.relative_path == clean_path) {
        existing.tags = clean_tags;
    } else if !clean_tags.is_empty() {
        state.entries.push(StagingTagEntry {
            relative_path: clean_path,
            tags: clean_tags,
            group_ids: vec![],
        });
    }

    save_state(&root, &state)
}

#[tauri::command]
pub fn write_staging_tags_to_metadata(
    app: AppHandle,
    staging_dir: String,
    relative_paths: Vec<String>,
    additional_tags: Vec<String>,
    backup_original: bool,
    dry_run: bool,
    verify_after_write: bool,
    generate_md5_report: bool,
) -> Result<MetadataTagWriteResult, String> {
    let root = PathBuf::from(&staging_dir);
    if !root.exists() {
        return Err(format!("Staging directory does not exist: {}", root.display()));
    }

    let exiftool_dir = load_settings(app)
        .map(|settings| settings.exiftool_dir)
        .unwrap_or_default();
    let exiftool_program = resolve_exiftool_program(&exiftool_dir);
    let exiftool_version = detect_exiftool_version(&exiftool_program)?;
    let state = load_state(&root)?;
    let extra_tags = normalize_list(&additional_tags);

    let clean_paths = normalize_list(&relative_paths)
        .into_iter()
        .map(|value| value.replace('\\', "/").trim_start_matches('/').to_string())
        .collect::<Vec<_>>();

    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S").to_string();
    let backup_dir = root.join(".photogogo-metadata-backups").join(timestamp);
    let mut backup_dir_used = false;

    let mut result = MetadataTagWriteResult {
        dry_run,
        exiftool_version,
        ..MetadataTagWriteResult::default()
    };
    let mut md5_entries = Vec::<(String, String)>::new();

    for relative_path in clean_paths {
        let absolute_path = root.join(relative_path.replace('/', "\\"));
        if !absolute_path.exists() {
            result.failed += 1;
            result.errors.push(format!("Missing file: {}", absolute_path.display()));
            continue;
        }

        if !is_metadata_writable_extension(&absolute_path) {
            result.skipped_unsupported += 1;
            continue;
        }

        let state_tags = state
            .entries
            .iter()
            .find(|entry| entry.relative_path == relative_path)
            .map(|entry| entry.tags.clone())
            .unwrap_or_default();

        let mut merged_tags = state_tags;
        merged_tags.extend(extra_tags.clone());
        let merged_tags = normalize_list(&merged_tags);

        if merged_tags.is_empty() {
            result.skipped_no_tags += 1;
            continue;
        }

        result.planned += 1;

        if dry_run {
            continue;
        }

        if backup_original {
            if let Err(err) = backup_file(&root, &absolute_path, &relative_path, &backup_dir) {
                result.failed += 1;
                result
                    .errors
                    .push(format!("Backup failed for {}: {}", relative_path, err));
                continue;
            }
            backup_dir_used = true;
        }

        match write_tags_with_exiftool(&exiftool_program, &absolute_path, &merged_tags) {
            Ok(_) => {
                result.updated += 1;

                if verify_after_write {
                    match verify_written_tags(&exiftool_program, &absolute_path, &merged_tags) {
                        Ok(true) => result.verified += 1,
                        Ok(false) => {
                            result.verification_failed += 1;
                            result.errors.push(format!("Verification failed for {}", relative_path));
                        }
                        Err(err) => {
                            result.verification_failed += 1;
                            result.errors.push(format!("Verification error for {}: {}", relative_path, err));
                        }
                    }
                }

                if generate_md5_report {
                    match compute_md5(&absolute_path) {
                        Ok(md5) => md5_entries.push((relative_path.clone(), md5)),
                        Err(err) => result.errors.push(format!("MD5 failed for {}: {}", relative_path, err)),
                    }
                }
            }
            Err(err) => {
                result.failed += 1;
                result
                    .errors
                    .push(format!("Metadata write failed for {}: {}", relative_path, err));
            }
        }
    }

    if backup_dir_used {
        result.backup_dir = Some(backup_dir.to_string_lossy().to_string());
    }

    if !dry_run && generate_md5_report {
        result.md5_report_path = write_md5_report(&root, &md5_entries)?;
    }

    Ok(result)
}