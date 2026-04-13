//! Commands for file-level operations used by the Review page.

use crate::utils::{base64_encode, rename_path_with_retry};
use chrono::{DateTime, Local, NaiveDateTime, TimeZone};
use exif::{In, Tag};
use image::codecs::jpeg::JpegEncoder;
use image::ImageReader;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::fs::File;
use std::fs::Metadata;
use std::hash::{Hash, Hasher};
use std::io::BufReader;
use std::io::Cursor;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use std::time::UNIX_EPOCH;
use walkdir::WalkDir;

const TIMELINE_CACHE_VERSION: u32 = 1;
const TIMELINE_CACHE_FILE: &str = ".photogogo.timeline-cache.json";
const IMPORT_PREWARM_CYCLES: usize = 24;
const IMPORT_PREWARM_INTERVAL_SECS: u64 = 20;

static ACTIVE_IMPORT_PREWARM_WORKERS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineCacheEntry {
    relative_path: String,
    kind: String,
    size: u64,
    modified_ms: i64,
    timestamp_ms: i64,
    end_timestamp_ms: i64,
    duration_ms: Option<i64>,
    timestamp_source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineCacheFile {
    version: u32,
    entries: Vec<TimelineCacheEntry>,
}

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

fn timeline_cache_path(staging_root: &std::path::Path) -> PathBuf {
    staging_root.join(TIMELINE_CACHE_FILE)
}

fn load_timeline_cache(staging_root: &std::path::Path) -> HashMap<String, TimelineCacheEntry> {
    let path = timeline_cache_path(staging_root);
    if !path.exists() {
        return HashMap::new();
    }

    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(_) => return HashMap::new(),
    };
    let parsed = match serde_json::from_str::<TimelineCacheFile>(&raw) {
        Ok(parsed) => parsed,
        Err(_) => return HashMap::new(),
    };
    if parsed.version != TIMELINE_CACHE_VERSION {
        return HashMap::new();
    }

    parsed
        .entries
        .into_iter()
        .map(|entry| (entry.relative_path.clone(), entry))
        .collect::<HashMap<_, _>>()
}

fn save_timeline_cache(staging_root: &std::path::Path, entries: &HashMap<String, TimelineCacheEntry>) -> Result<(), String> {
    let path = timeline_cache_path(staging_root);
    let mut cache_entries = entries.values().cloned().collect::<Vec<_>>();
    cache_entries.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));

    let payload = TimelineCacheFile {
        version: TIMELINE_CACHE_VERSION,
        entries: cache_entries,
    };
    let raw = serde_json::to_string_pretty(&payload).map_err(|error| error.to_string())?;
    fs::write(path, raw).map_err(|error| error.to_string())
}

fn modified_ms_from_metadata(metadata: &Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
}

fn active_import_prewarm_workers() -> &'static Mutex<HashSet<String>> {
    ACTIVE_IMPORT_PREWARM_WORKERS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn thumb_cache_root(staging_dir: Option<&str>) -> PathBuf {
    if let Some(staging_dir) = staging_dir {
        let root = PathBuf::from(staging_dir);
        return root.join(".photogogo").join("thumb-cache");
    }

    std::env::temp_dir().join("photogogo").join("thumb-cache")
}

fn build_thumb_cache_file_path_with_ext(
    cache_root: &Path,
    path: &Path,
    kind: &str,
    max_width: u32,
    max_height: u32,
    quality: u8,
    extension: &str,
) -> PathBuf {
    let metadata = fs::metadata(path).ok();
    let size = metadata.as_ref().map(|meta| meta.len()).unwrap_or(0);
    let modified_ms = metadata
        .as_ref()
        .and_then(modified_ms_from_metadata)
        .unwrap_or_default();

    let mut hasher = DefaultHasher::new();
    path.to_string_lossy().hash(&mut hasher);
    kind.hash(&mut hasher);
    max_width.hash(&mut hasher);
    max_height.hash(&mut hasher);
    quality.hash(&mut hasher);
    size.hash(&mut hasher);
    modified_ms.hash(&mut hasher);

    cache_root.join(format!("{:016x}.{}", hasher.finish(), extension))
}

fn build_thumb_cache_file_path(
    cache_root: &Path,
    path: &Path,
    kind: &str,
    max_width: u32,
    max_height: u32,
    quality: u8,
) -> PathBuf {
    build_thumb_cache_file_path_with_ext(
        cache_root,
        path,
        kind,
        max_width,
        max_height,
        quality,
        "jpg",
    )
}

fn read_cached_thumb(path: &Path) -> Option<Vec<u8>> {
    if !path.exists() {
        return None;
    }
    fs::read(path).ok()
}

fn write_cached_thumb(path: &Path, data: &[u8]) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(path, data);
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

fn ffmpeg_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(path) = std::env::var_os("PHOTOGOGO_FFMPEG") {
        candidates.push(PathBuf::from(path));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join("ffmpeg.exe"));
            candidates.push(parent.join("tools").join("ffmpeg").join("bin").join("ffmpeg.exe"));
        }
    }

    candidates.push(PathBuf::from("ffmpeg"));
    candidates
}

fn render_video_thumbnail(path: &std::path::Path, max_width: u32, max_height: u32) -> Result<Vec<u8>, String> {
    let mut last_error = String::new();

    for ffmpeg_binary in ffmpeg_candidates() {
        let scale_filter = format!("scale={}:{}:force_original_aspect_ratio=decrease", max_width, max_height);
        let output = Command::new(&ffmpeg_binary)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                "00:00:01",
                "-i",
            ])
            .arg(path)
            .args([
                "-frames:v",
                "1",
                "-vf",
                &scale_filter,
                "-f",
                "image2pipe",
                "-vcodec",
                "mjpeg",
                "-q:v",
                "5",
                "-",
            ])
            .output();

        let Ok(output) = output else { continue; };
        if output.status.success() && !output.stdout.is_empty() {
            return Ok(output.stdout);
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !stderr.is_empty() {
            last_error = stderr;
        }
    }

    if last_error.is_empty() {
        Err("Unable to extract video thumbnail with ffmpeg".to_string())
    } else {
        Err(last_error)
    }
}

fn render_video_hover_preview(
    path: &std::path::Path,
    max_width: u32,
    max_height: u32,
    seconds: f32,
) -> Result<Vec<u8>, String> {
    let mut last_error = String::new();
    let clip_seconds = seconds.clamp(0.8, 4.0);

    for ffmpeg_binary in ffmpeg_candidates() {
        let scale_filter = format!(
            "fps=15,scale={}:{}:force_original_aspect_ratio=decrease",
            max_width, max_height
        );
        let output = Command::new(&ffmpeg_binary)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-ss",
                "00:00:00.5",
                "-i",
            ])
            .arg(path)
            .args([
                "-an",
                "-t",
                &format!("{:.2}", clip_seconds),
                "-vf",
                &scale_filter,
                "-movflags",
                "frag_keyframe+empty_moov",
                "-c:v",
                "mpeg4",
                "-q:v",
                "6",
                "-f",
                "mp4",
                "-",
            ])
            .output();

        let Ok(output) = output else { continue; };
        if output.status.success() && !output.stdout.is_empty() {
            return Ok(output.stdout);
        }

        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !stderr.is_empty() {
            last_error = stderr;
        }
    }

    if last_error.is_empty() {
        Err("Unable to render video hover preview with ffmpeg".to_string())
    } else {
        Err(last_error)
    }
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
pub fn load_staging_timeline(staging_dir: String, relative_dir: String, fast_mode: Option<bool>) -> Result<Vec<TimelineMediaItem>, String> {
    let fast_mode = fast_mode.unwrap_or(false);
    let root = PathBuf::from(&staging_dir);
    let target = if relative_dir.trim().is_empty() {
        root.clone()
    } else {
        root.join(relative_dir.replace('/', std::path::MAIN_SEPARATOR_STR))
    };

    if !target.exists() {
        return Ok(vec![]);
    }

    let normalized_relative_dir = relative_dir
        .replace('\\', "/")
        .trim_matches('/')
        .to_string();

    let mut cache = load_timeline_cache(&root);
    let mut seen_paths = HashSet::<String>::new();
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
        seen_paths.insert(relative_path.clone());

        let Ok(metadata) = fs::metadata(path) else { continue; };
        let size = metadata.len();
        let modified_ms = modified_ms_from_metadata(&metadata)
            .or_else(|| file_modified_ms(path))
            .unwrap_or_default();

        if let Some(cached) = cache.get(&relative_path) {
            if cached.kind == kind && cached.size == size && cached.modified_ms == modified_ms {
                items.push(TimelineMediaItem {
                    relative_path: cached.relative_path.clone(),
                    name: path.file_name().and_then(|value| value.to_str()).unwrap_or_default().to_string(),
                    kind: cached.kind.clone(),
                    size: cached.size,
                    timestamp_ms: cached.timestamp_ms,
                    end_timestamp_ms: cached.end_timestamp_ms,
                    duration_ms: cached.duration_ms,
                    timestamp_source: cached.timestamp_source.clone(),
                });
                continue;
            }
        }

        let (timestamp_ms, duration_ms, timestamp_source) = if kind == "video" {
            if fast_mode {
                if let Some(timestamp_ms) = file_modified_ms(path) {
                    (timestamp_ms, None, "filesystem-fast".to_string())
                } else {
                    continue;
                }
            } else {
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

        if !fast_mode {
            cache.insert(
                relative_path.clone(),
                TimelineCacheEntry {
                    relative_path: relative_path.clone(),
                    kind: kind.to_string(),
                    size,
                    modified_ms,
                    timestamp_ms,
                    end_timestamp_ms,
                    duration_ms,
                    timestamp_source: timestamp_source.clone(),
                },
            );
        }

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

    cache.retain(|relative_path, _| {
        if normalized_relative_dir.is_empty() {
            return seen_paths.contains(relative_path);
        }

        let in_scope = relative_path == &normalized_relative_dir
            || relative_path
                .strip_prefix(&format!("{}/", normalized_relative_dir))
                .is_some();
        if !in_scope {
            return true;
        }

        seen_paths.contains(relative_path)
    });

    if !fast_mode {
        let _ = save_timeline_cache(&root, &cache);
    }

    items.sort_by(|left, right| {
        left.timestamp_ms
            .cmp(&right.timestamp_ms)
            .then_with(|| left.relative_path.cmp(&right.relative_path))
    });

    Ok(items)
}

#[tauri::command]
pub fn prewarm_staging_timeline_cache(staging_dir: String) -> Result<usize, String> {
    let items = load_staging_timeline(staging_dir, String::new(), Some(false))?;
    Ok(items.len())
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
pub fn read_image_thumbnail_base64(
    path: String,
    max_width: Option<u32>,
    max_height: Option<u32>,
    quality: Option<u8>,
    staging_dir: Option<String>,
) -> Result<String, String> {
    let width = max_width.unwrap_or(220).clamp(32, 1200);
    let height = max_height.unwrap_or(160).clamp(32, 1200);
    let jpeg_quality = quality.unwrap_or(72).clamp(25, 95);

    let cache_root = thumb_cache_root(staging_dir.as_deref());
    let cache_file = build_thumb_cache_file_path(
        &cache_root,
        Path::new(&path),
        "image",
        width,
        height,
        jpeg_quality,
    );
    if let Some(cached) = read_cached_thumb(&cache_file) {
        return Ok(base64_encode(&cached));
    }

    let decoded = ImageReader::open(&path)
        .map_err(|error| error.to_string())?
        .decode()
        .map_err(|error| error.to_string())?;
    let thumbnail = decoded.thumbnail(width, height);

    let mut encoded = Cursor::new(Vec::<u8>::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut encoded, jpeg_quality);
    encoder
        .encode_image(&thumbnail)
        .map_err(|error| error.to_string())?;
    write_cached_thumb(&cache_file, encoded.get_ref());
    Ok(base64_encode(encoded.get_ref()))
}

#[tauri::command]
pub fn read_video_thumbnail_base64(
    path: String,
    max_width: Option<u32>,
    max_height: Option<u32>,
    staging_dir: Option<String>,
) -> Result<String, String> {
    let width = max_width.unwrap_or(220).clamp(32, 1200);
    let height = max_height.unwrap_or(160).clamp(32, 1200);

    let cache_root = thumb_cache_root(staging_dir.as_deref());
    let cache_file = build_thumb_cache_file_path(
        &cache_root,
        Path::new(&path),
        "video",
        width,
        height,
        72,
    );
    if let Some(cached) = read_cached_thumb(&cache_file) {
        return Ok(base64_encode(&cached));
    }

    let data = render_video_thumbnail(std::path::Path::new(&path), width, height)?;
    write_cached_thumb(&cache_file, &data);
    Ok(base64_encode(&data))
}

#[tauri::command]
pub fn read_video_hover_preview_base64(
    path: String,
    max_width: Option<u32>,
    max_height: Option<u32>,
    seconds: Option<f32>,
    staging_dir: Option<String>,
) -> Result<String, String> {
    let width = max_width.unwrap_or(480).clamp(120, 1280);
    let height = max_height.unwrap_or(270).clamp(68, 720);
    let clip_seconds = seconds.unwrap_or(2.2).clamp(0.8, 4.0);
    let cache_quality = (clip_seconds * 10.0).round().clamp(0.0, 255.0) as u8;

    let cache_root = thumb_cache_root(staging_dir.as_deref());
    let cache_file = build_thumb_cache_file_path_with_ext(
        &cache_root,
        Path::new(&path),
        "video-hover-preview",
        width,
        height,
        cache_quality,
        "mp4",
    );
    if let Some(cached) = read_cached_thumb(&cache_file) {
        return Ok(base64_encode(&cached));
    }

    let data = render_video_hover_preview(Path::new(&path), width, height, clip_seconds)?;
    write_cached_thumb(&cache_file, &data);
    Ok(base64_encode(&data))
}

#[tauri::command]
pub fn prewarm_staging_timeline_thumbnails(
    staging_dir: String,
    relative_dir: String,
    max_width: Option<u32>,
    max_height: Option<u32>,
    max_items: Option<usize>,
) -> Result<usize, String> {
    let width = max_width.unwrap_or(220).clamp(32, 1200);
    let height = max_height.unwrap_or(160).clamp(32, 1200);
    let limit = max_items.unwrap_or(180).clamp(1, 5_000);

    let items = load_staging_timeline(staging_dir.clone(), relative_dir, Some(false))?;
    let mut warmed = 0usize;
    let root = PathBuf::from(&staging_dir);

    for item in items.into_iter().take(limit) {
        let absolute_path = root.join(item.relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        let path_text = absolute_path.to_string_lossy().to_string();

        let result = if item.kind == "video" {
            read_video_thumbnail_base64(path_text, Some(width), Some(height), Some(staging_dir.clone()))
        } else {
            read_image_thumbnail_base64(path_text, Some(width), Some(height), Some(68), Some(staging_dir.clone()))
        };

        if result.is_ok() {
            warmed += 1;
        }
    }

    Ok(warmed)
}

#[tauri::command]
pub fn start_import_prewarm_worker(staging_dir: String) -> Result<bool, String> {
    let normalized = staging_dir.trim().to_string();
    if normalized.is_empty() {
        return Err("staging_dir is required".to_string());
    }

    let workers = active_import_prewarm_workers();
    {
        let mut guard = workers.lock().map_err(|_| "prewarm lock poisoned".to_string())?;
        if guard.contains(&normalized) {
            return Ok(false);
        }
        guard.insert(normalized.clone());
    }

    std::thread::spawn(move || {
        for _ in 0..IMPORT_PREWARM_CYCLES {
            let _ = prewarm_staging_timeline_cache(normalized.clone());
            let _ = prewarm_staging_timeline_thumbnails(
                normalized.clone(),
                String::new(),
                Some(220),
                Some(140),
                Some(160),
            );
            std::thread::sleep(Duration::from_secs(IMPORT_PREWARM_INTERVAL_SECS));
        }

        if let Ok(mut guard) = active_import_prewarm_workers().lock() {
            guard.remove(&normalized);
        }
    });

    Ok(true)
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

#[tauri::command]
pub fn open_in_default_app(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("Path does not exist: {}", target.display()));
    }

    #[cfg(target_os = "windows")]
    {
        let status = Command::new("cmd")
            .args(["/C", "start", "", &path])
            .status()
            .map_err(|e| e.to_string())?;

        if status.success() {
            Ok(())
        } else {
            Err(format!("Failed to open in default app: {}", target.display()))
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err("Open in default app is only implemented on Windows".to_string())
    }
}
