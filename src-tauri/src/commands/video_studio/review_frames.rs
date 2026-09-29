//! Disposable local thumbnails only. Never used as render identity or approval.
//! Each call does at most one bounded decode; the caller can reprioritise between frames.
use super::*;
use std::io::{Seek, SeekFrom};
use tauri::Manager;

const MAX_FRAME: u64 = 1024 * 1024;
const CACHE_BUDGET: u64 = 128 * 1024 * 1024;
static WORKER: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewFrame { at: f64, data: Option<String>, cached: bool, deferred: bool, source_key: String }

fn sample_time(duration: f64, count: u32, index: u32) -> Result<f64, String> {
    if !duration.is_finite() || !(0.0..=86400.0).contains(&duration) || duration <= 0.
        || ![4, 8, 12].contains(&count) || index >= count {
        return Err("Invalid review frame range: use 4, 8 or 12 frames and a valid clip duration".into());
    }
    Ok((duration * (index as f64 + 0.5) / count as f64).min((duration - 0.02).max(0.)))
}
fn rendering() -> bool {
    jobs().lock().map(|list| list.values().any(|j| ["running", "queued", "paused"].contains(&j.status.as_str())))
        .unwrap_or(true)
}
// Bounded fingerprint for non-authoritative thumbnails: metadata plus first/middle/last
// 64 KiB. Full source hashing remains mandatory for reusable rendered video elsewhere.
fn identity(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let before = file.metadata().map_err(|e| e.to_string())?;
    let mut hash = Md5::new();
    hash.update(format!("review-v1|{}|{}|{:?}|{:?}", path.display(), before.len(), before.modified(), before.created()));
    for offset in [0, before.len().saturating_sub(65536) / 2, before.len().saturating_sub(65536)] {
        file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
        let mut bytes = vec![0; 65536.min(before.len().saturating_sub(offset)) as usize];
        file.read_exact(&mut bytes).map_err(|e| e.to_string())?;
        hash.update(bytes);
    }
    let after = file.metadata().map_err(|e| e.to_string())?;
    if before.len() != after.len() || before.modified().ok() != after.modified().ok() {
        return Err("Source changed while sampling. Try again when copying has finished.".into());
    }
    Ok(hex::encode(hash.finalize()))
}
fn jpeg(path: &Path) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_FRAME { return Err("Review frame exceeded its size limit".into()); }
    let mut bytes = Vec::new();
    file.take(MAX_FRAME + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_FRAME || !bytes.starts_with(&[0xff, 0xd8]) || !bytes.ends_with(&[0xff, 0xd9]) {
        return Err("Incomplete review frame; refresh to retry".into());
    }
    Ok(bytes)
}
fn owned_name(name: &str) -> bool {
    name.len() == 36 && name.ends_with(".jpg") && name.as_bytes()[..32].iter().all(|b| b.is_ascii_hexdigit())
}
fn owned_temporary(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() > 37 && name.ends_with(".tmp") && bytes[32] == b'-'
        && bytes[..32].iter().all(|b| b.is_ascii_hexdigit())
        && bytes[33..bytes.len()-4].iter().all(|b| b.is_ascii_digit())
}
fn prune(root: &Path, reserve: u64) -> Result<(), String> {
    let mut files = Vec::new(); let mut total = 0;
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name(); let name = name.to_string_lossy();
        if !(owned_name(&name) || owned_temporary(&name)) || !entry.file_type().map_err(|e| e.to_string())?.is_file() { continue; }
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        total += metadata.len(); files.push((metadata.modified().ok(), entry.path(), metadata.len()));
    }
    files.sort_by_key(|entry| entry.0);
    for (_, path, bytes) in files {
        if total + reserve <= CACHE_BUDGET { break; }
        // Exact owned disposable file only, never recursive, never source/output folders.
        fs::remove_file(path).map_err(|e| format!("Could not make room in the review thumbnail cache: {e}"))?;
        total = total.saturating_sub(bytes);
    }
    Ok(())
}
struct Temporary(PathBuf);
impl Drop for Temporary { fn drop(&mut self) { let _ = fs::remove_file(&self.0); } }

fn extract(ff: &Path, path: &Path, at: f64, temporary: &Path) -> Result<Option<Vec<u8>>, String> {
    let output = fs::OpenOptions::new().write(true).create_new(true).open(temporary).map_err(|e| e.to_string())?;
    let mut child = command(ff).args(["-v", "error", "-nostdin", "-threads", "1", "-ss", &at.to_string(), "-i"])
        .arg(path).args(["-an", "-sn", "-dn", "-frames:v", "1", "-vf", "scale=640:640:force_original_aspect_ratio=decrease",
            "-filter_threads", "1", "-threads", "1", "-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe", "-"])
        .stdout(Stdio::from(output)).stderr(Stdio::null()).spawn().map_err(|e| format!("Could not start review-frame decoder: {e}"))?;
    let started = std::time::Instant::now();
    loop {
        let paused = rendering();
        let oversized = fs::metadata(temporary).map(|m| m.len() > MAX_FRAME).unwrap_or(true);
        if paused || oversized || started.elapsed() > Duration::from_secs(30) {
            let _ = child.kill(); let _ = child.wait();
            if paused { return Ok(None); }
            return Err("Review-frame decoder reached its 30-second or 1 MiB limit. Use Refresh frames to retry.".into());
        }
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return jpeg(temporary).map(Some),
            Ok(Some(status)) => return Err(format!("Could not decode review frame at {at:.2}s (FFmpeg {status}). Check the source clip and FFmpeg installation.")),
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(e) => { let _ = child.kill(); let _ = child.wait(); return Err(e.to_string()); }
        }
    }
}
fn frame(root: &Path, source_path: &Path, duration: f64, count: u32, index: u32, refresh: bool, cache_only: bool) -> Result<ReviewFrame, String> {
    let at = sample_time(duration, count, index)?;
    let deferred = || ReviewFrame { at, data: None, cached: false, deferred: true, source_key: String::new() };
    let _worker = match WORKER.try_lock() {
        Ok(worker) => worker,
        Err(std::sync::TryLockError::WouldBlock) => return Ok(deferred()),
        Err(std::sync::TryLockError::Poisoned(_)) => return Err("Review-frame worker stopped unexpectedly. Reopen the app before preparing more frames.".into()),
    };
    fs::create_dir_all(root).map_err(|e| format!("Review cache unavailable: {e}"))?;
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let source_key = identity(source_path)?;
    let key = signature(&[source_key.clone(), format!("{duration}|{count}|{index}")]);
    let cached = root.join(format!("{key}.jpg"));
    if !refresh && fs::symlink_metadata(&cached).map(|m| m.file_type().is_file()).unwrap_or(false) {
        if let Ok(data) = jpeg(&cached) {
            if identity(source_path)? != source_key { return Err("Source changed while reading review frames. Refresh after copying finishes.".into()); }
            return Ok(ReviewFrame { at, data: Some(crate::utils::base64_encode(&data)), cached: true, deferred: false, source_key });
        }
    }
    if cache_only { return Ok(ReviewFrame { at, data: None, cached: false, deferred: false, source_key }); }
    if rendering() { return Ok(deferred()); }
    prune(&root, MAX_FRAME)?;
    let temporary = Temporary(root.join(format!("{key}-{}.tmp", chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default())));
    let ff = detect_ffmpeg_capabilities()?.binary;
    let Some(data) = extract(&ff, source_path, at, &temporary.0)? else { return Ok(deferred()); };
    if identity(source_path)? != source_key { return Err("Source changed while preparing review frames. Refresh after copying finishes.".into()); }
    // Replacing this exact generated cache entry cannot alter footage or render files.
    if cached.exists() { fs::remove_file(&cached).map_err(|e| e.to_string())?; }
    fs::rename(&temporary.0, &cached).map_err(|e| e.to_string())?;
    Ok(ReviewFrame { at, data: Some(crate::utils::base64_encode(&data)), cached: false, deferred: false, source_key })
}

#[tauri::command]
pub async fn studio_review_frame(app: tauri::AppHandle, staging_dir: String, path: String, duration: f64,
    count: u32, index: u32, refresh: bool, cache_only: bool) -> Result<ReviewFrame, String> {
    sample_time(duration, count, index)?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("studio-review-frames-v1");
    tauri::async_runtime::spawn_blocking(move || {
        let path = source(Path::new(&staging_dir), &path)?;
        frame(&cache, &path, duration, count, index, refresh, cache_only)
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "bounded synthetic JPEG extraction/cache/pause smoke; requires local FFmpeg"]
    fn studio_review_frames_smoke() {
        let ff = detect_ffmpeg_capabilities().unwrap().binary;
        let root = std::env::var_os("PHOTOGOGO_STUDIO_TEST_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
            .join(format!("studio-review-smoke-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir_all(&root).unwrap(); let input = root.join("source.mp4"); let cache = root.join("cache");
        let generated = command(&ff).args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=10:d=2",
            "-threads", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p"]).arg(&input).output().unwrap();
        assert!(generated.status.success(), "{}", String::from_utf8_lossy(&generated.stderr));
        let original = compute_md5(&input).unwrap();
        for index in 0..4 {
            let first = frame(&cache, &input, 2., 4, index, false, false).unwrap();
            assert!(!first.cached && !first.deferred && first.data.is_some());
            let reopened = frame(&cache, &input, 2., 4, index, false, false).unwrap();
            assert!(reopened.cached); assert_eq!(reopened.data, first.data);
        }
        jobs().lock().unwrap().insert("frame-pause-test".into(), StudioJob { status: "running".into(), ..StudioJob::default() });
        let paused = frame(&cache, &input, 2., 4, 0, true, false).unwrap();
        jobs().lock().unwrap().remove("frame-pause-test");
        assert!(paused.deferred && paused.data.is_none());
        let refreshed = frame(&cache, &input, 2., 4, 0, true, false).unwrap(); assert!(!refreshed.cached);
        assert_eq!(compute_md5(&input).unwrap(), original, "Source footage must be unchanged");
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 4, "No abandoned scratch files");
        println!("PASS: four real JPEGs generated, reopened from cache, paused for rendering, refreshed; source unchanged. {}", root.display());
    }
    #[test]
    fn studio_review_frame_ranges_are_bounded() {
        assert_eq!(sample_time(16., 8, 0).unwrap(), 1.);
        assert_eq!(sample_time(16., 8, 7).unwrap(), 15.);
        for n in [0, 1, 100] { assert!(sample_time(16., n, 0).is_err()); }
        for d in [0., -1., f64::NAN, f64::INFINITY, 86401.] { assert!(sample_time(d, 8, 0).is_err()); }
        assert!(sample_time(1., 8, 8).is_err());
        assert_eq!(sample_time(0.01, 4, 0).unwrap(), 0.);
        assert!(owned_name("0123456789abcdef0123456789abcdef.jpg"));
        for name in ["source.mp4", "../../../source.jpg", "some-other-cache.jpg"] { assert!(!owned_name(name)); }
        assert!(!owned_name(&format!("{}é.jpg", "a".repeat(30))));
        assert!(!owned_temporary(&format!("{}é-1.tmp", "a".repeat(31))));
    }
    #[test]
    fn studio_review_cache_reopens_and_tracks_source_changes() {
        let root = std::env::temp_dir().join(format!("studio-review-test-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir_all(&root).unwrap(); let source_path = root.join("source.mp4");
        fs::write(&source_path, b"original footage").unwrap(); let first = identity(&source_path).unwrap();
        let key = signature(&[first.clone(), "16|8|0".into()]);
        fs::write(root.join(format!("{key}.jpg")), [0xff,0xd8,0xff,0xd9]).unwrap();
        let result = frame(&root, &source_path, 16., 8, 0, false, true).unwrap();
        assert!(result.cached); assert!(result.data.is_some());
        let stamp = fs::metadata(&source_path).unwrap().modified().unwrap();
        fs::write(&source_path, b"modified footage").unwrap();
        fs::File::options().write(true).open(&source_path).unwrap().set_times(fs::FileTimes::new().set_modified(stamp)).unwrap();
        assert_ne!(identity(&source_path).unwrap(), first);
        assert_eq!(fs::read(&source_path).unwrap(), b"modified footage");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn studio_review_cache_prunes_only_owned_files() {
        let root = std::env::temp_dir().join(format!("studio-review-prune-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir_all(&root).unwrap(); fs::write(root.join("source.mp4"), b"keep").unwrap();
        let owned = root.join("0123456789abcdef0123456789abcdef.jpg");
        fs::File::create(&owned).unwrap().set_len(CACHE_BUDGET).unwrap();
        assert!(jpeg(&owned).is_err()); prune(&root, MAX_FRAME).unwrap();
        assert!(!owned.exists()); assert_eq!(fs::read(root.join("source.mp4")).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }
}
