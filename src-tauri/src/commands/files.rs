//! Commands for file-level operations used by the Review page.

use crate::utils::{base64_encode, rename_path_with_retry};
use chrono::{DateTime, Local, NaiveDateTime, TimeZone};
use exif::{In, Tag};
use std::fs;
use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;
use std::process::Command;
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMediaItem {
    pub relative_path: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub timestamp_ms: i64,
    pub end_timestamp_ms: i64,
    pub duration_ms: Option<i64>,
    pub timestamp_source: String,
}

fn is_timeline_image(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png" | "cr3" | "dng"))
        .unwrap_or(false)
}

fn is_timeline_video(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| matches!(ext.to_ascii_lowercase().as_str(), "avi" | "mp4" | "mkv" | "mov" | "mts"))
        .unwrap_or(false)
}

fn file_modified_ms(path: &std::path::Path) -> Option<i64> {
    fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

fn parse_exif_datetime(value: &str) -> Option<i64> {
    let cleaned = value.split('\0').next()?.trim();
    let naive = NaiveDateTime::parse_from_str(cleaned, "%Y:%m:%d %H:%M:%S").ok()?;
    let local_time = Local
        .from_local_datetime(&naive)
        .earliest()
        .or_else(|| Local.from_local_datetime(&naive).latest())?;
    Some(local_time.timestamp_millis())
}

fn image_capture_timestamp_ms(path: &std::path::Path) -> Option<i64> {
    let file = File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let exif = exif::Reader::new().read_from_container(&mut reader).ok()?;

    for tag in [Tag::DateTimeOriginal, Tag::DateTimeDigitized, Tag::DateTime] {
        let field = exif.get_field(tag, In::PRIMARY)?;
        if let exif::Value::Ascii(parts) = &field.value {
            for part in parts {
                if let Ok(text) = std::str::from_utf8(part) {
                    if let Some(timestamp_ms) = parse_exif_datetime(text) {
                        return Some(timestamp_ms);
                    }
                }
            }
        }
    }

    None
}

fn ffprobe_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = std::env::var_os("PHOTOGOGO_FFMPEG") {
        let ffmpeg_path = PathBuf::from(path);
        if let Some(parent) = ffmpeg_path.parent() {
            candidates.push(parent.join("ffprobe.exe"));
            candidates.push(parent.join("ffprobe"));
        }
        if let Some(file_name) = ffmpeg_path.file_name().and_then(|value| value.to_str()) {
            if file_name.eq_ignore_ascii_case("ffmpeg.exe") {
                candidates.push(ffmpeg_path.with_file_name("ffprobe.exe"));
            } else if file_name.eq_ignore_ascii_case("ffmpeg") {
                candidates.push(ffmpeg_path.with_file_name("ffprobe"));
            }
        }
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join("ffprobe.exe"));
            candidates.push(parent.join("tools").join("ffmpeg").join("bin").join("ffprobe.exe"));
        }
    }

    candidates.push(PathBuf::from("ffprobe"));
    candidates
}

fn parse_ffprobe_creation_time(value: &str) -> Option<i64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }

    DateTime::parse_from_rfc3339(trimmed)
        .map(|timestamp| timestamp.timestamp_millis())
        .ok()
        .or_else(|| {
            NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S")
                .ok()
                .and_then(|naive| Local.from_local_datetime(&naive).earliest().map(|value| value.timestamp_millis()))
        })
}

fn probe_video_timeline_metadata(path: &std::path::Path) -> (Option<i64>, Option<i64>) {
    for ffprobe_binary in ffprobe_candidates() {
        let output = Command::new(&ffprobe_binary)
            .args([
                "-v",
                "error",
                "-print_format",
                "json",
                "-show_entries",
                "format=duration:format_tags=creation_time:stream_tags=creation_time",
            ])
            .arg(path)
            .output();

        let Ok(output) = output else { continue; };
        if !output.status.success() {
            continue;
        }

        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
            continue;
        };

        let duration_ms = value
            .get("format")
            .and_then(|format| format.get("duration"))
            .and_then(|duration| duration.as_str().and_then(|text| text.parse::<f64>().ok()).or_else(|| duration.as_f64()))
            .map(|seconds| (seconds * 1000.0).round() as i64)
            .filter(|duration| *duration > 0);

        let format_creation = value
            .get("format")
            .and_then(|format| format.get("tags"))
            .and_then(|tags| tags.get("creation_time"))
            .and_then(|creation| creation.as_str())
            .and_then(parse_ffprobe_creation_time);

        let stream_creation = value
            .get("streams")
            .and_then(|streams| streams.as_array())
            .and_then(|streams| {
                streams.iter().find_map(|stream| {
                    stream
                        .get("tags")
                        .and_then(|tags| tags.get("creation_time"))
                        .and_then(|creation| creation.as_str())
                        .and_then(parse_ffprobe_creation_time)
                })
            });

        return (format_creation.or(stream_creation), duration_ms);
    }

    (None, None)
}

#[tauri::command]
pub fn load_staging_timeline(staging_dir: String, relative_dir: String) -> Result<Vec<TimelineMediaItem>, String> {
    let root = PathBuf::from(&staging_dir);
    let target = if relative_dir.trim().is_empty() {
        root.clone()
    } else {
        root.join(relative_dir.replace('/', std::path::MAIN_SEPARATOR_STR))
    };

    if !target.exists() {
        return Ok(vec![]);
    }

    let mut items = Vec::<TimelineMediaItem>::new();
    for entry in WalkDir::new(&target).into_iter().filter_map(|entry| entry.ok()).filter(|entry| entry.file_type().is_file()) {
        let path = entry.path();
        let kind = if is_timeline_video(path) {
            "video"
        } else if is_timeline_image(path) {
            "image"
        } else {
            continue;
        };

        let relative_path = path
            .strip_prefix(&root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let size = fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);

        let (timestamp_ms, duration_ms, timestamp_source) = if kind == "video" {
            let (video_timestamp, video_duration) = probe_video_timeline_metadata(path);
            if let Some(timestamp_ms) = video_timestamp.or_else(|| file_modified_ms(path)) {
                (
                    timestamp_ms,
                    video_duration,
                    if video_timestamp.is_some() { "ffprobe" } else { "filesystem" }.to_string(),
                )
            } else {
                continue;
            }
        } else {
            let image_timestamp = image_capture_timestamp_ms(path);
            if let Some(timestamp_ms) = image_timestamp.or_else(|| file_modified_ms(path)) {
            (
                timestamp_ms,
                None,
                    if image_timestamp.is_some() { "exif" } else { "filesystem" }.to_string(),
            )
            } else {
                continue;
            }
        };

        let end_timestamp_ms = duration_ms
            .map(|duration| timestamp_ms.saturating_add(duration))
            .unwrap_or(timestamp_ms);

        items.push(TimelineMediaItem {
            relative_path,
            name: path.file_name().and_then(|value| value.to_str()).unwrap_or_default().to_string(),
            kind: kind.to_string(),
            size,
            timestamp_ms,
            end_timestamp_ms,
            duration_ms,
            timestamp_source,
        });
    }

    items.sort_by(|left, right| {
        left.timestamp_ms
            .cmp(&right.timestamp_ms)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });

    Ok(items)
}

/// Rename a file in-place, returning the new absolute path.
#[tauri::command]
pub async fn rename_file(old_path: String, new_name: String) -> Result<String, String> {
    let old = PathBuf::from(&old_path);
    let parent = old.parent().ok_or("No parent directory")?;
    let new = parent.join(&new_name);
    rename_path_with_retry(&old, &new)?;
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
