//! Exact, local-only still extraction from explicitly opened original videos.
//! Timestamp indexes are independent of nominal FPS. Pixels are never returned
//! until the decoder's actual presentation timestamps match the requested index.
pub mod photo;

use crate::utils::base64_encode;
use md5::{Digest, Md5};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, MutexGuard, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_CLIPS: usize = 64;
const MAX_FRAMES: usize = 500_000;
const MAX_TOTAL_FRAMES: usize = 2_000_000;
const MAX_PROBE_BYTES: usize = 64 * 1024 * 1024;
const CACHE_BYTES: usize = 64 * 1024 * 1024;
const SESSION_BYTES: usize = 4 * 1024 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotClip {
    pub id: String,
    pub identity: String,
    pub path: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub frame_times_ms: Vec<f64>,
    pub suggested_start: Option<String>,
    pub time_source: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFrame {
    pub index: usize,
    pub at_ms: f64,
    pub data: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFrames {
    pub frames: Vec<SnapshotFrame>,
}

#[derive(Clone, Debug)]
struct FramePoint {
    pts: i64,
    key: bool,
}
#[derive(Clone)]
struct IndexedClip {
    info: SnapshotClip,
    path: PathBuf,
    points: Vec<FramePoint>,
    time_num: i64,
    time_den: i64,
    fast_identity: String,
    // Retaining this Windows deny-write/delete handle prevents an external
    // replacement after indexing, including edits which restore file times.
    _source_lock: Arc<File>,
}
#[derive(Default)]
struct Registry {
    clips: HashMap<String, Arc<IndexedClip>>,
    requests: HashMap<String, Arc<AtomicBool>>,
    cancelled_before_start: VecDeque<String>,
    cache: VecDeque<(String, SnapshotFrame)>,
    cache_bytes: usize,
}
static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
static WORKER: Mutex<()> = Mutex::new(());
// One background indexing job must not stop navigation in already-open clips.
// Each lane launches at most one media child with two decoder threads.
static INDEX_WORKER: Mutex<()> = Mutex::new(());
static NEXT_FILE: AtomicU64 = AtomicU64::new(1);
fn registry() -> Result<MutexGuard<'static, Registry>, String> {
    REGISTRY
        .get_or_init(|| Mutex::new(Registry::default()))
        .lock()
        .map_err(|_| "Video snapshots state is unavailable. Restart the application.".into())
}

struct Request {
    id: String,
    cancelled: Arc<AtomicBool>,
}
impl Request {
    fn new(id: String) -> Result<Self, String> {
        valid_request_id(&id)?;
        let mut state = registry()?;
        if state.requests.contains_key(&id) {
            return Err("Snapshot request ID is already in use.".into());
        }
        if state.requests.len() >= 128 {
            return Err("Too many pending snapshot requests.".into());
        }
        let was_cancelled = state.cancelled_before_start.iter().any(|v| v == &id);
        state.cancelled_before_start.retain(|v| v != &id);
        let cancelled = Arc::new(AtomicBool::new(was_cancelled));
        state.requests.insert(id.clone(), cancelled.clone());
        Ok(Self { id, cancelled })
    }
    fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Relaxed) {
            Err("Snapshot request cancelled.".into())
        } else {
            Ok(())
        }
    }
    fn worker(&self) -> Result<MutexGuard<'static, ()>, String> {
        self.wait_for_worker(&WORKER)
    }
    fn index_worker(&self) -> Result<MutexGuard<'static, ()>, String> {
        self.wait_for_worker(&INDEX_WORKER)
    }
    fn wait_for_worker(
        &self,
        worker: &'static Mutex<()>,
    ) -> Result<MutexGuard<'static, ()>, String> {
        loop {
            self.check()?;
            match worker.try_lock() {
                Ok(guard) => return Ok(guard),
                Err(std::sync::TryLockError::WouldBlock) => {
                    thread::sleep(Duration::from_millis(15))
                }
                Err(_) => return Err("Snapshot worker is unavailable.".into()),
            }
        }
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        if let Ok(mut state) = registry() {
            state.requests.remove(&self.id);
        }
    }
}
fn valid_request_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_:".contains(&c))
    {
        return Err("Invalid snapshot request ID.".into());
    }
    Ok(())
}

fn local_path(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty()
        || raw.len() > 32_000
        || raw.contains("://")
        || raw.chars().any(char::is_control)
    {
        return Err("Choose a regular local file, not a network URL.".into());
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("An absolute local file path is required.".into());
    }
    #[cfg(windows)]
    if (raw.starts_with("\\\\") && !raw.starts_with("\\\\?\\")) || raw.starts_with("\\\\?\\UNC\\") {
        return Err("Copy the original video to a local drive before opening it.".into());
    }
    Ok(path)
}
fn video_path(raw: &str) -> Result<PathBuf, String> {
    let path = local_path(raw)?;
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["mp4", "mov", "mkv", "mts", "m2ts", "avi", "mxf", "webm"].contains(&ext.as_str()) {
        return Err("Choose an original MP4, MOV, MKV, MTS, M2TS, AVI, MXF or WebM video.".into());
    }
    let path = fs::canonicalize(path)
        .map_err(|e| format!("Cannot open the selected original video: {e}"))?;
    if !path.is_file() {
        return Err("The original video is not a regular file.".into());
    }
    Ok(path)
}
fn system_nanos(value: std::io::Result<SystemTime>) -> u128 {
    value
        .ok()
        .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
        .map(|v| v.as_nanos())
        .unwrap_or(0)
}
/// Hold a read-only, deny-write/delete handle during decoding on Windows. The
/// content samples also catch common copied/replaced-file cases across sessions.
fn source_guard(path: &Path) -> Result<(File, String), String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1); // FILE_SHARE_READ only; never change source bytes.
    }
    let mut file = options
        .open(path)
        .map_err(|e| format!("The original video is unavailable or being changed: {e}"))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() == 0 {
        return Err("The original video is empty or not a regular file.".into());
    }
    let mut hash = Md5::new();
    hash.update(meta.len().to_le_bytes());
    hash.update(system_nanos(meta.modified()).to_le_bytes());
    hash.update(system_nanos(meta.created()).to_le_bytes());
    let mut sample = vec![0u8; (meta.len().min(65_536)) as usize];
    file.read_exact(&mut sample).map_err(|e| e.to_string())?;
    hash.update(&sample);
    if meta.len() > 65_536 {
        file.seek(SeekFrom::End(-65_536))
            .map_err(|e| e.to_string())?;
        file.read_exact(&mut sample).map_err(|e| e.to_string())?;
        hash.update(&sample);
    }
    Ok((file, hex::encode(hash.finalize())))
}
fn content_identity(file: &mut File, request: &Request) -> Result<String, String> {
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let started = Instant::now();
    let mut hash = Md5::new();
    let mut bytes = vec![0u8; 1024 * 1024];
    loop {
        request.check()?;
        if started.elapsed() > Duration::from_secs(300) {
            return Err("Source integrity verification exceeded five minutes. Copy the original to a faster local drive and try again.".into());
        }
        let count = file
            .read(&mut bytes)
            .map_err(|e| format!("Could not verify the original video: {e}"))?;
        if count == 0 {
            break;
        }
        hash.update(&bytes[..count]);
    }
    Ok(format!("md5:{}", hex::encode(hash.finalize())))
}
fn recheck(clip: &IndexedClip) -> Result<File, String> {
    let (guard, identity) = source_guard(&clip.path)?;
    if identity != clip.fast_identity {
        return Err("This source video has changed. Remove it and add the current original again before extracting photographs.".into());
    }
    Ok(guard)
}

struct ToolOutput {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}
fn bounded_read(
    mut pipe: impl Read,
    max: usize,
    exceeded: Arc<AtomicBool>,
) -> std::io::Result<Vec<u8>> {
    let mut data = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let count = pipe.read(&mut chunk)?;
        if count == 0 {
            return Ok(data);
        }
        let keep = count.min(max.saturating_sub(data.len()));
        data.extend_from_slice(&chunk[..keep]);
        if keep != count {
            exceeded.store(true, Ordering::Relaxed);
        }
    }
}
fn run_tool(
    probe: bool,
    args: &[String],
    request: &Request,
    max_bytes: usize,
    timeout: Duration,
) -> Result<ToolOutput, String> {
    request.check()?;
    let candidates = if probe {
        super::media_tools::ffprobe_candidates()
    } else {
        super::media_tools::ffmpeg_candidates()
    };
    let mut child = None;
    let mut missing = String::new();
    for binary in candidates {
        let mut command = Command::new(&binary);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        match command.spawn() {
            Ok(process) => {
                child = Some(process);
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => missing = e.to_string(),
            Err(e) => return Err(format!("Could not start the packaged media tool: {e}")),
        }
    }
    let mut child =
        child.ok_or_else(|| format!("The packaged media tool is missing: {missing}"))?;
    let exceeded = Arc::new(AtomicBool::new(false));
    let stdout = child.stdout.take().expect("piped child stdout");
    let stderr = child.stderr.take().expect("piped child stderr");
    let out_flag = exceeded.clone();
    let err_flag = exceeded.clone();
    let out_reader = thread::spawn(move || bounded_read(stdout, max_bytes, out_flag));
    let err_reader = thread::spawn(move || bounded_read(stderr, 2 * 1024 * 1024, err_flag));
    let started = Instant::now();
    let mut failure = None;
    let status = loop {
        if request.cancelled.load(Ordering::Relaxed) {
            failure = Some("Snapshot request cancelled.".to_string());
        } else if exceeded.load(Ordering::Relaxed) {
            failure = Some("Snapshot media output exceeded its safe memory limit.".to_string());
        } else if started.elapsed() > timeout {
            failure = Some(
                "Snapshot media operation timed out. Try a shorter original clip.".to_string(),
            );
        }
        if failure.is_some() {
            let _ = child.kill();
            break child
                .wait()
                .map_err(|e| format!("Could not finish the cancelled media process: {e}"));
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => thread::sleep(Duration::from_millis(15)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(e.to_string());
            }
        }
    };
    let stdout = out_reader
        .join()
        .map_err(|_| "Snapshot output reader failed.".to_string())?
        .map_err(|e| e.to_string())?;
    let stderr = err_reader
        .join()
        .map_err(|_| "Snapshot log reader failed.".to_string())?
        .map_err(|e| e.to_string())?;
    if let Some(error) = failure {
        return Err(error);
    }
    request.check()?;
    if exceeded.load(Ordering::Relaxed) {
        return Err("Snapshot media output exceeded its safe memory limit.".into());
    }
    if !status?.success() {
        return Err(format!(
            "The original video could not be decoded: {}",
            String::from_utf8_lossy(&stderr)
                .chars()
                .rev()
                .take(1800)
                .collect::<String>()
                .chars()
                .rev()
                .collect::<String>()
        ));
    }
    Ok(ToolOutput { stdout, stderr })
}
fn input_args() -> Vec<String> {
    [
        "-protocol_whitelist",
        "file,pipe",
        "-format_whitelist",
        "mov,matroska,webm,mpegts,avi,mxf",
    ]
    .iter()
    .map(|v| v.to_string())
    .collect()
}
fn parse_time_base(raw: &str) -> Result<(i64, i64), String> {
    let parts: Vec<_> = raw.split('/').collect();
    let num = parts
        .first()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let den = parts
        .get(1)
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    if parts.len() != 2 || num <= 0 || den <= 0 || num > 1_000_000_000 || den > 1_000_000_000 {
        Err("The source has no usable presentation time base.".into())
    } else {
        Ok((num, den))
    }
}
fn parse_points(output: &[u8], packets: bool) -> Result<Vec<FramePoint>, String> {
    let text = std::str::from_utf8(output)
        .map_err(|_| "The video timestamp index is not valid text.".to_string())?;
    let mut result = Vec::new();
    for line in text.lines().filter(|v| !v.trim().is_empty()) {
        let fields: HashMap<_, _> = line.split('|').filter_map(|v| v.split_once('=')).collect();
        let pts = if packets {
            fields.get("pts")
        } else {
            fields
                .get("best_effort_timestamp")
                .or_else(|| fields.get("pts"))
        };
        // ffprobe may emit separate empty side-data lines. Ignore only records
        // which do not identify a frame/packet at all.
        if pts.is_none() && !fields.contains_key("key_frame") && !fields.contains_key("flags") {
            continue;
        }
        let pts = pts
            .and_then(|v| v.parse::<i64>().ok())
            .ok_or("A source frame has no usable presentation timestamp.")?;
        if pts.unsigned_abs() > (1u64 << 50) {
            return Err("The source presentation timestamp is outside supported bounds.".into());
        }
        let key = if packets {
            fields
                .get("flags")
                .map(|v| v.contains('K'))
                .unwrap_or(false)
        } else {
            fields.get("key_frame") == Some(&"1")
        };
        result.push(FramePoint { pts, key });
        if result.len() > MAX_FRAMES {
            return Err("This clip exceeds the 500,000-frame snapshot limit. Split it into shorter original clips.".into());
        }
    }
    if packets {
        result.sort_by_key(|v| v.pts);
    }
    if result.is_empty() || result.windows(2).any(|v| v[0].pts >= v[1].pts) {
        return Err("The video has missing, duplicate or non-increasing presentation timestamps; exact-frame extraction is unavailable.".into());
    }
    Ok(result)
}
fn probe_points(path: &Path, packets: bool, request: &Request) -> Result<Vec<FramePoint>, String> {
    let mut args = vec!["-v".into(), "error".into()];
    args.extend(input_args());
    args.extend([
        "-threads".into(),
        "2".into(),
        "-select_streams".into(),
        "v:0".into(),
        if packets {
            "-show_packets".into()
        } else {
            "-show_frames".into()
        },
        "-show_entries".into(),
        if packets {
            "packet=pts,flags".into()
        } else {
            "frame=best_effort_timestamp,pts,key_frame".into()
        },
        "-of".into(),
        "compact=p=0:nk=0".into(),
        path.to_string_lossy().into_owned(),
    ]);
    parse_points(
        &run_tool(
            true,
            &args,
            request,
            MAX_PROBE_BYTES,
            Duration::from_secs(300),
        )?
        .stdout,
        packets,
    )
}
fn decoded_pts(stderr: &[u8]) -> Result<Vec<i64>, String> {
    let mut result = Vec::new();
    for line in String::from_utf8_lossy(stderr)
        .lines()
        .filter(|line| line.contains("showinfo") && line.contains(" n:"))
    {
        if let Some((_, value)) = line.split_once(" pts:") {
            result.push(
                value
                    .trim_start()
                    .split_whitespace()
                    .next()
                    .and_then(|v| v.parse().ok())
                    .ok_or("Cannot verify the decoded frame timestamp.")?,
            );
        }
    }
    Ok(result)
}
fn png_frames(bytes: &[u8]) -> Result<Vec<Vec<u8>>, String> {
    let mut start = 0;
    let mut images = Vec::new();
    while start < bytes.len() {
        if bytes.get(start..start + 8) != Some(PNG_SIGNATURE) {
            return Err("The decoder returned an invalid image stream.".into());
        }
        let mut cursor = start + 8;
        loop {
            let size_bytes: [u8; 4] = bytes
                .get(cursor..cursor + 4)
                .ok_or("Incomplete extracted image.")?
                .try_into()
                .map_err(|_| "Invalid extracted image.")?;
            let size = u32::from_be_bytes(size_bytes) as usize;
            let end = cursor
                .checked_add(12)
                .and_then(|v| v.checked_add(size))
                .ok_or("Invalid extracted image size.")?;
            if end > bytes.len() {
                return Err("Incomplete extracted image.".into());
            }
            let is_end = bytes.get(cursor + 4..cursor + 8) == Some(b"IEND");
            cursor = end;
            if is_end {
                images.push(bytes[start..end].to_vec());
                start = end;
                break;
            }
        }
        if images.len() > 12 {
            return Err("The decoder returned too many snapshot frames.".into());
        }
    }
    Ok(images)
}
fn extract(
    clip: &IndexedClip,
    start: usize,
    count: usize,
    scaled: bool,
    request: &Request,
) -> Result<Vec<Vec<u8>>, String> {
    request.check()?;
    let end = start
        .checked_add(count)
        .filter(|v| count > 0 && count <= 12 && *v <= clip.points.len())
        .ok_or("The requested frame range is outside this clip.")?;
    let _source = recheck(clip)?;
    let key = clip.points[..=start]
        .iter()
        .rposition(|v| v.key)
        .unwrap_or(0);
    let seek_seconds = clip.points[key].pts as f64 * clip.time_num as f64 / clip.time_den as f64;
    let first = clip.points[start].pts;
    let last = clip.points[end - 1].pts;
    // Autorotation happens before this filter; normalise non-square camera
    // pixels without discarding either decoded dimension.
    let mut filter = format!("select='between(pts,{first},{last})',showinfo,scale=w='ceil(max(iw,iw*sar))':h='ceil(max(ih,ih/sar))',setsar=1");
    if scaled {
        filter.push_str(",scale=960:540:force_original_aspect_ratio=decrease:flags=bilinear");
    }
    filter.push_str(",format=rgb24");
    let mut args: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "info", "-copyts"]
        .iter()
        .map(|v| v.to_string())
        .collect();
    args.extend(input_args());
    args.extend([
        "-seek_timestamp".into(),
        "1".into(),
        "-ss".into(),
        format!("{seek_seconds:.9}"),
        "-noaccurate_seek".into(),
        "-threads".into(),
        "2".into(),
        "-i".into(),
        clip.path.to_string_lossy().into_owned(),
        "-map".into(),
        "0:v:0".into(),
        "-an".into(),
        "-sn".into(),
        "-dn".into(),
        "-vf".into(),
        filter,
        "-frames:v".into(),
        count.to_string(),
        "-fps_mode".into(),
        "passthrough".into(),
        "-threads".into(),
        "2".into(),
        "-c:v".into(),
        "png".into(),
        "-f".into(),
        "image2pipe".into(),
        "pipe:1".into(),
    ]);
    let output = run_tool(
        false,
        &args,
        request,
        if scaled {
            32 * 1024 * 1024
        } else {
            128 * 1024 * 1024
        },
        Duration::from_secs(120),
    )?;
    let actual = decoded_pts(&output.stderr)?;
    let expected: Vec<_> = clip.points[start..end].iter().map(|v| v.pts).collect();
    if actual != expected {
        return Err("The decoder did not return the exact indexed frame. No photograph was saved; re-open this original clip.".into());
    }
    let images = png_frames(&output.stdout)?;
    if images.len() != count {
        return Err(
            "The exact frame could not be decoded completely. No photograph was saved.".into(),
        );
    }
    recheck(clip)?;
    Ok(images)
}

fn open_impl(path: String, request: &Request) -> Result<SnapshotClip, String> {
    let path = video_path(&path)?;
    // A cached open in this process already owns the deny-write source handle.
    if let Some(clip) = registry()?.clips.values().find(|v| v.path == path).cloned() {
        recheck(&clip)?;
        request.check()?;
        return Ok(clip.info.clone());
    }
    let (mut source, fast_identity) = source_guard(&path)?;
    let identity = content_identity(&mut source, request)?;
    let id = format!(
        "clip-{:x}",
        Md5::digest(format!("{}\0{identity}", path.to_string_lossy()).as_bytes())
    );
    {
        let state = registry()?;
        if let Some(clip) = state.clips.get(&id) {
            return Ok(clip.info.clone());
        }
        if state.clips.len() >= MAX_CLIPS {
            return Err("A snapshot workspace can hold up to 64 original clips. Remove a clip before adding more.".into());
        }
    }
    let mut args = vec!["-v".into(), "error".into()];
    args.extend(input_args());
    args.extend([
        "-select_streams".into(),
        "v:0".into(),
        "-show_streams".into(),
        "-show_format".into(),
        "-of".into(),
        "json".into(),
        path.to_string_lossy().into_owned(),
    ]);
    let metadata: Value = serde_json::from_slice(
        &run_tool(true, &args, request, 1024 * 1024, Duration::from_secs(30))?.stdout,
    )
    .map_err(|e| format!("Cannot read video metadata: {e}"))?;
    let stream = metadata["streams"]
        .as_array()
        .and_then(|v| v.first())
        .ok_or("The file has no decodable video stream.")?;
    if stream["disposition"]["attached_pic"].as_i64() == Some(1) {
        return Err("This file contains a cover image, not an original video stream.".into());
    }
    let mut width = stream["width"].as_u64().unwrap_or(0) as u32;
    let mut height = stream["height"].as_u64().unwrap_or(0) as u32;
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 32_000_000
    {
        return Err(
            "This video's frame dimensions exceed the supported 32-megapixel snapshot limit."
                .into(),
        );
    }
    if let Some(sar) = stream["sample_aspect_ratio"]
        .as_str()
        .filter(|s| *s != "N/A" && *s != "0:1")
    {
        let (num, den) = parse_time_base(&sar.replace(':', "/"))?;
        if num > den {
            width = (width as f64 * num as f64 / den as f64).ceil() as u32;
        } else {
            height = (height as f64 * den as f64 / num as f64).ceil() as u32;
        }
        if width > 8192 || height > 8192 || u64::from(width) * u64::from(height) > 32_000_000 {
            return Err(
                "The video's display dimensions exceed the supported snapshot limit.".into(),
            );
        }
    }
    let rotation = stream["side_data_list"]
        .as_array()
        .and_then(|v| v.iter().find_map(|v| v["rotation"].as_i64()))
        .or_else(|| {
            stream["tags"]["rotate"]
                .as_str()
                .and_then(|v| v.parse::<i64>().ok())
        })
        .unwrap_or(0);
    if rotation.rem_euclid(180) == 90 {
        std::mem::swap(&mut width, &mut height);
    }
    let (time_num, time_den) = parse_time_base(stream["time_base"].as_str().unwrap_or(""))?;
    let shoot_tag = stream["tags"]["creation_time"]
        .as_str()
        .or_else(|| metadata["format"]["tags"]["creation_time"].as_str());
    let suggested_start = shoot_tag
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .map(|v| v.to_rfc3339());
    let mut warnings = vec!["Confirm the camera shooting start time before saving photographs; copied-file dates are not used.".into(),
        "The original stays read-only while it is open here. Remove it from this workspace before moving, editing or deleting it.".into()];
    if stream["color_transfer"]
        .as_str()
        .map(|v| ["smpte2084", "arib-std-b67"].contains(&v))
        .unwrap_or(false)
    {
        return Err("This original is tagged as PQ/HLG HDR. Convert a copy to SDR before using Video snapshots; the original will not be changed.".into());
    }
    if stream["color_transfer"]
        .as_str()
        .map(|v| ["unknown", "unspecified"].contains(&v))
        .unwrap_or(true)
    {
        warnings.push("This video's colour transfer is unspecified. Camera-log/HDR footage needs an SDR-converted copy; review colours before saving.".into());
    }
    let mut clip = IndexedClip {
        info: SnapshotClip {
            id: id.clone(),
            identity,
            path: path.to_string_lossy().into_owned(),
            name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            width,
            height,
            frame_times_ms: Vec::new(),
            time_source: if suggested_start.is_some() {
                "Camera metadata (confirm)".into()
            } else {
                "Needs confirmation".into()
            },
            suggested_start,
            warnings,
        },
        path,
        points: Vec::new(),
        time_num,
        time_den,
        fast_identity,
        _source_lock: Arc::new(source),
    };
    let count = stream["nb_frames"]
        .as_str()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    let quick_allowed = metadata["format"]["format_name"]
        .as_str()
        .map(|v| v.split(',').any(|v| v == "mov"))
        .unwrap_or(false)
        && ["h264", "hevc"].contains(&stream["codec_name"].as_str().unwrap_or(""))
        && stream["field_order"].as_str() == Some("progressive")
        && count > 0
        && count <= MAX_FRAMES;
    let mut quick_verified = false;
    if quick_allowed {
        if let Ok(points) = probe_points(&clip.path, true, request) {
            if points.len() == count {
                clip.points = points;
                quick_verified = extract(&clip, 0, 1, true, request).is_ok()
                    && extract(&clip, count - 1, 1, true, request).is_ok();
            }
        }
        request.check()?;
    }
    if !quick_verified {
        clip.points = probe_points(&clip.path, false, request)?;
        clip.info
            .warnings
            .push("This source required a full frame-timestamp scan for accurate browsing.".into());
    }
    let origin = clip.points[0].pts;
    let duration_us =
        (clip.points.last().unwrap().pts as i128 - origin as i128) * time_num as i128 * 1_000_000
            / time_den as i128;
    if duration_us > i64::MAX as i128 {
        return Err("The source timestamp duration exceeds supported bounds.".into());
    }
    clip.info.frame_times_ms = clip
        .points
        .iter()
        .map(|v| {
            (v.pts as i128 - origin as i128) as f64 * time_num as f64 * 1000.0 / time_den as f64
        })
        .collect();
    recheck(&clip)?;
    request.check()?;
    let mut state = registry()?;
    let existing: usize = state.clips.values().map(|v| v.points.len()).sum();
    if state.clips.len() >= MAX_CLIPS || existing + clip.points.len() > MAX_TOTAL_FRAMES {
        return Err("The snapshot workspace has reached its clip/frame limit. Remove some clips before adding more.".into());
    }
    let info = clip.info.clone();
    state.clips.insert(id, Arc::new(clip));
    Ok(info)
}
fn get_clip(id: &str) -> Result<Arc<IndexedClip>, String> {
    registry()?
        .clips
        .get(id)
        .cloned()
        .ok_or_else(|| "This original video is no longer open. Add it again.".into())
}
fn jpeg_data(png: &[u8]) -> Result<String, String> {
    let image = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 82)
        .encode_image(&image)
        .map_err(|e| e.to_string())?;
    Ok(format!("data:image/jpeg;base64,{}", base64_encode(&bytes)))
}
fn frames_impl(
    id: String,
    start: usize,
    count: usize,
    request: &Request,
) -> Result<SnapshotFrames, String> {
    let clip = get_clip(&id)?;
    let _guard = recheck(&clip)?;
    let end = start
        .checked_add(count)
        .filter(|v| count > 0 && count <= 12 && *v <= clip.points.len())
        .ok_or("Choose between 1 and 12 frames within the original clip.")?;
    let cached: Vec<_> = {
        let state = registry()?;
        (start..end)
            .filter_map(|index| {
                state
                    .cache
                    .iter()
                    .find(|(c, f)| c == &id && f.index == index)
                    .map(|(_, f)| f.clone())
            })
            .collect()
    };
    if cached.len() == count {
        request.check()?;
        return Ok(SnapshotFrames { frames: cached });
    }
    let images = extract(&clip, start, count, true, request)?;
    let frames: Vec<_> = images
        .iter()
        .enumerate()
        .map(|(offset, bytes)| {
            Ok(SnapshotFrame {
                index: start + offset,
                at_ms: clip.info.frame_times_ms[start + offset],
                data: jpeg_data(bytes)?,
            })
        })
        .collect::<Result<_, String>>()?;
    request.check()?;
    let mut state = registry()?;
    for frame in &frames {
        if state
            .cache
            .iter()
            .any(|(c, f)| c == &id && f.index == frame.index)
        {
            continue;
        }
        while state.cache_bytes + frame.data.len() > CACHE_BYTES {
            if let Some((_, old)) = state.cache.pop_front() {
                state.cache_bytes -= old.data.len();
            } else {
                break;
            }
        }
        state.cache_bytes += frame.data.len();
        state.cache.push_back((id.clone(), frame.clone()));
    }
    Ok(SnapshotFrames { frames })
}

#[tauri::command]
pub async fn snapshot_open(path: String, request_id: String) -> Result<SnapshotClip, String> {
    let request = Request::new(request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _worker = request.index_worker()?;
        open_impl(path, &request)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn snapshot_frames(
    clip_id: String,
    start: usize,
    count: usize,
    request_id: String,
) -> Result<SnapshotFrames, String> {
    let request = Request::new(request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _worker = request.worker()?;
        frames_impl(clip_id, start, count, &request)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn snapshot_photo_preview(
    clip_id: String,
    index: usize,
    recipe: photo::PhotoRecipe,
    request_id: String,
) -> Result<String, String> {
    let request = Request::new(request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _worker = request.worker()?;
        let clip = get_clip(&clip_id)?;
        let png = extract(&clip, index, 1, false, &request)?.remove(0);
        let jpeg = photo::preview(&png, &recipe)?;
        request.check()?;
        recheck(&clip)?;
        Ok(format!("data:image/jpeg;base64,{}", base64_encode(&jpeg)))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn snapshot_export(
    clip_id: String,
    index: usize,
    shooting_start: String,
    person_name: String,
    destination: String,
    recipe: photo::PhotoRecipe,
    request_id: String,
) -> Result<photo::PhotoExport, String> {
    let request = Request::new(request_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _worker = request.worker()?;
        let clip = get_clip(&clip_id)?;
        let _source = recheck(&clip)?;
        let png = extract(&clip, index, 1, false, &request)?.remove(0);
        let pts = clip.points[index].pts;
        let elapsed = i64::try_from((pts as i128 - clip.points[0].pts as i128) * clip.time_num as i128 * 1_000_000 / clip.time_den as i128)
            .map_err(|_| "The selected frame capture offset exceeds supported bounds.".to_string())?;
        let provenance = json!({"sourcePath": clip.info.path, "sourceIdentity": clip.info.identity, "sourceFrameIndex": index,
            "sourcePts": pts, "sourceTimeBase": format!("{}/{}", clip.time_num, clip.time_den), "timestampOriginPts": clip.points[0].pts});
        photo::export(&png, &local_path(&destination)?, &shooting_start, elapsed, &person_name, &recipe, &provenance,
            || { request.check()?; recheck(&clip).map(|_| ()) })
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn snapshot_cancel(request_id: String) -> Result<(), String> {
    valid_request_id(&request_id)?;
    let mut state = registry()?;
    if let Some(flag) = state.requests.get(&request_id) {
        flag.store(true, Ordering::Relaxed);
    } else if !state.cancelled_before_start.contains(&request_id) {
        if state.cancelled_before_start.len() >= 128 {
            state.cancelled_before_start.pop_front();
        }
        state.cancelled_before_start.push_back(request_id);
    }
    Ok(())
}
#[tauri::command]
pub fn snapshot_forget(clip_ids: Vec<String>) -> Result<(), String> {
    if clip_ids.len() > MAX_CLIPS {
        return Err("Too many clip IDs.".into());
    }
    let mut state = registry()?;
    for id in &clip_ids {
        state.clips.remove(id);
    }
    state.cache.retain(|(id, _)| !clip_ids.contains(id));
    state.cache_bytes = state.cache.iter().map(|(_, f)| f.data.len()).sum();
    Ok(())
}

fn valid_session(contents: &str) -> Result<(), String> {
    if contents.len() > SESSION_BYTES {
        return Err("Snapshot session exceeds the 4 MiB limit.".into());
    }
    let value: Value =
        serde_json::from_str(contents).map_err(|e| format!("Invalid snapshot session: {e}"))?;
    if value["kind"].as_str() != Some("photogogo-video-snapshots")
        || value["version"].as_u64() != Some(1)
    {
        return Err("This file is not a supported Video snapshots session.".into());
    }
    let sources = value["sources"]
        .as_array()
        .ok_or("Snapshot session is missing its original clips.")?;
    let selections = value["selections"]
        .as_array()
        .ok_or("Snapshot session is missing its snapshot selections.")?;
    if sources.len() > MAX_CLIPS || selections.len() > 10_000 {
        return Err("Snapshot session exceeds supported item limits.".into());
    }
    Ok(())
}
fn session_path(raw: &str) -> Result<PathBuf, String> {
    let path = local_path(raw)?;
    if path
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| !v.eq_ignore_ascii_case("json"))
        .unwrap_or(true)
    {
        return Err("Save Video snapshots sessions as a .json file.".into());
    }
    let parent = fs::canonicalize(path.parent().ok_or("Choose a session folder.")?)
        .map_err(|e| e.to_string())?;
    let target = parent.join(path.file_name().ok_or("Choose a session filename.")?);
    if let Ok(meta) = fs::symlink_metadata(&target) {
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(
                "The session destination must be a regular file, not a link or folder.".into(),
            );
        }
    }
    Ok(target)
}
fn read_session(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("Cannot read the snapshot session: {e}"))?;
    let mut data = String::new();
    file.take((SESSION_BYTES + 1) as u64)
        .read_to_string(&mut data)
        .map_err(|e| e.to_string())?;
    valid_session(&data)?;
    Ok(data)
}
fn publish_new_session(source: &Path, target: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};
        let a: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), MOVEFILE_WRITE_THROUGH) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        fs::hard_link(source, target).map_err(|e| e.to_string())?;
        fs::remove_file(source).map_err(|e| e.to_string())
    }
}
#[tauri::command]
pub fn snapshot_save_session(path: String, json: String) -> Result<(), String> {
    valid_session(&json)?;
    let path = session_path(&path)?;
    // Session snapshots use Save As. An atomic no-replace publication avoids
    // both overwrite races and accidental replacement of unrelated JSON files.
    if path.exists() {
        return Err("That session filename already exists. Choose a new filename to preserve the previous snapshot.".into());
    }
    let temp = path.with_file_name(format!(
        ".snapshot-session-{}-{}.tmp",
        std::process::id(),
        NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut created = false;
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        created = true;
        file.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        publish_new_session(&temp, &path)
    })();
    if result.is_err() && created && temp.is_file() {
        let _ = fs::remove_file(&temp);
    }
    result
}
#[tauri::command]
pub fn snapshot_load_session(path: String) -> Result<String, String> {
    read_session(&session_path(&path)?)
}

#[cfg(test)]
mod tests;
