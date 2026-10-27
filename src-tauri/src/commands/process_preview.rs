//! Non-mutating processing previews. Batch and preview share the recipe and
//! eligibility collectors, but never share the batch runner's mutation sink.
use super::photo_process::{BwParams, load_oriented, render_bw, render_enhanced};
use super::process::{self, ProcessScopeMode, ProcessTask, StabilizationMode, StabilizationStrength};
use image::DynamicImage;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRequest {
    staging_dir: String,
    scope_dir: String,
    scope_mode: ProcessScopeMode,
    task: String,
    path: Option<String>,
    full_resolution: Option<bool>,
    start_seconds: Option<f64>,
    enhance_contrast_level: Option<f32>,
    enhance_sharpness_level: Option<f32>,
    bw_params: Option<BwParams>,
    stabilization_mode: Option<StabilizationMode>,
    stabilization_strength: Option<StabilizationStrength>,
    preserve_source_bitrate: Option<bool>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCandidates { paths: Vec<String>, total: usize, truncated: bool }
#[derive(Debug, Serialize)]
pub struct FocusPreview { max: f64, average: f64, percent: f64, flagged: bool }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    kind: &'static str,
    path: Option<String>,
    original: Option<String>,
    processed: Option<String>,
    width: Option<u32>,
    height: Option<u32>,
    full_resolution: bool,
    focus: Option<FocusPreview>,
    affected: Option<Vec<String>>,
    total: Option<usize>,
    warning: String,
    elapsed_ms: u128,
}

fn task(name: &str) -> Result<ProcessTask, String> {
    match name {
        "focus" => Ok(ProcessTask::Focus), "enhance" => Ok(ProcessTask::Enhance), "bw" => Ok(ProcessTask::Bw),
        "stabilize" => Ok(ProcessTask::Stabilize), "remove_focus" => Ok(ProcessTask::RemoveFocus),
        "remove_enhance" => Ok(ProcessTask::RemoveEnhance), "remove_bw" => Ok(ProcessTask::RemoveBw),
        "remove_stabilize" => Ok(ProcessTask::RemoveStabilize), _ => Err("This task has no Photo Process preview".into()),
    }
}
fn candidates(staging: &str, scope: &str, mode: &ProcessScopeMode, task: &ProcessTask) -> Result<Vec<PathBuf>, String> {
    let directory = process::resolve_process_scope(staging, Some(scope.into()), mode)?;
    let canonical = directory.canonicalize().map_err(|e| e.to_string())?;
    let mut files = process::collect_process_files(task, &directory, !matches!(mode, ProcessScopeMode::FolderOnly))?;
    files.retain(|file| file.canonicalize().map(|path| path.starts_with(&canonical)).unwrap_or(false));
    files.sort();
    Ok(files)
}
#[tauri::command]
pub async fn process_preview_candidates(staging_dir: String, scope_dir: String, scope_mode: ProcessScopeMode, task: String) -> Result<PreviewCandidates, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let files = candidates(&staging_dir, &scope_dir, &scope_mode, &self::task(&task)?)?;
        let total = files.len();
        Ok(PreviewCandidates { paths: files.into_iter().take(1000).map(|p| p.to_string_lossy().into_owned()).collect(), total, truncated: total > 1000 })
    }).await.map_err(|e| e.to_string())?
}

fn jpeg_url(image: &DynamicImage) -> Result<String, String> {
    let bytes = super::photo_process::jpeg_bytes(image)?;
    if bytes.len() > 32 * 1024 * 1024 { return Err("Preview JPEG exceeds its 32 MiB response limit; use a draft preview".into()); }
    Ok(format!("data:image/jpeg;base64,{}", crate::utils::base64_encode(&bytes)))
}

fn photo_preview(request: &PreviewRequest, path: &Path, task: &ProcessTask) -> Result<PreviewResult, String> {
    let oriented = load_oriented(path)?;
    let full = request.full_resolution.unwrap_or(false);
    // Focus classification always uses source resolution, just like the job.
    let focus = if matches!(task, ProcessTask::Focus) {
        let (max, average, percent) = process::focus_score(&oriented);
        Some(FocusPreview { max, average, percent, flagged: process::is_out_of_focus(max, average, percent) })
    } else { None };
    let original = if full { oriented } else { oriented.thumbnail(1600,1600) };
    let processed = match task {
        ProcessTask::Bw => {
            let params = request.bw_params.unwrap_or_default(); params.validate()?;
            Some(DynamicImage::ImageLuma8(render_bw(&original, &params)))
        }
        ProcessTask::Enhance => {
            let contrast = request.enhance_contrast_level.unwrap_or(1.0);
            let sharpness = request.enhance_sharpness_level.unwrap_or(0.5);
            if !contrast.is_finite() || !(0.0..=2.0).contains(&contrast) || !sharpness.is_finite() || !(0.0..=1.0).contains(&sharpness) { return Err("Invalid enhancement recipe".into()); }
            Some(DynamicImage::ImageRgb8(render_enhanced(&original, contrast, sharpness)))
        }
        _ => None,
    };
    Ok(PreviewResult { kind: if focus.is_some() { "focus" } else { "image" }, path: Some(path.to_string_lossy().into_owned()),
        original: Some(jpeg_url(&original)?), processed: processed.as_ref().map(jpeg_url).transpose()?,
        width: Some(original.width()), height: Some(original.height()), full_resolution: full,
        focus, affected: None, total: None, elapsed_ms: 0,
        warning: if full { "Full-resolution processing with the queued job's recipe. JPEG preview is display-only; no files were changed.".into() }
            else { "Draft preview: up to 1600 pixels. Detail, local contrast and sharpening can differ at full size; use Full-resolution check before judging fine detail. Focus scores use the original resolution.".into() },
    })
}

struct TempPreview(PathBuf);
impl TempPreview {
    fn new() -> Result<Self, String> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!("photogogo-process-preview-{}-{}-{}", std::process::id(), chrono::Utc::now().timestamp_millis(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        std::fs::create_dir(&directory).map_err(|e| e.to_string())?;
        Ok(Self(directory))
    }
}
impl Drop for TempPreview { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

fn run_video(binary: &Path, directory: &Path, args: &[String]) -> Result<(), String> {
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let result = process::command_output_limited_in(binary, &refs, 1024 * 1024, Duration::from_secs(90), Some(directory))?;
    if !result.status.success() { return Err(format!("Video preview failed: {}", String::from_utf8_lossy(&result.stderr))); }
    Ok(())
}
fn video_preview(request: &PreviewRequest, path: &Path) -> Result<PreviewResult, String> {
    // A preview must not silently compete with active imports/renders.
    if super::import::imports_have_pending_work()
        || super::video_studio::studio_list_jobs().iter().any(|job| matches!(job.status.as_str(), "running" | "paused" | "queued"))
        || process::process_jobs_store().lock().map_err(|e| e.to_string())?.values().any(|job| matches!(job.status, process::ProcessJobStatus::Queued | process::ProcessJobStatus::Running | process::ProcessJobStatus::Paused)) {
        return Err("Wait for active import/processing work to finish before generating a video preview".into());
    }
    let start = request.start_seconds.unwrap_or(0.0);
    if !start.is_finite() || !(0.0..=86400.0).contains(&start) { return Err("Preview start must be between 0 and 86400 seconds".into()); }
    let capabilities = process::detect_ffmpeg_capabilities()?;
    if !capabilities.has_vidstab { return Err("The selected FFmpeg does not provide vid.stab".into()); }
    let work = TempPreview::new()?;
    let mode = request.stabilization_mode.unwrap_or(StabilizationMode::EdgeSafe);
    let strength = request.stabilization_strength.unwrap_or(StabilizationStrength::Balanced);
    let (detect, transform) = process::stabilization_filters(mode, strength, "motion.trf");
    let source = work.0.join("original.mp4");
    let output = work.0.join("processed.mp4");
    let mut extract = vec!["-hide_banner".into(), "-nostdin".into(), "-loglevel".into(), "error".into(), "-ss".into(), start.to_string(), "-i".into(), path.to_string_lossy().into_owned()];
    extract.extend(["-t", "5", "-vf", "scale=w='min(iw,1280)':h='min(ih,720)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30", "-threads", "2", "-filter_threads", "2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-maxrate", "8M", "-bufsize", "16M", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart"].map(String::from));
    extract.push(source.to_string_lossy().into_owned()); run_video(&capabilities.binary, &work.0, &extract)?;
    let common: Vec<String> = ["-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "2", "-filter_threads", "2", "-i", "original.mp4", "-vf"].map(String::from).into();
    let mut analyse = common.clone(); analyse.push(detect); analyse.extend(["-an", "-f", "null", "-"].map(String::from)); run_video(&capabilities.binary, &work.0, &analyse)?;
    let mut render = common; render.push(transform);
    render.extend(["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-maxrate", "8M", "-bufsize", "16M", "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart"].map(String::from));
    render.push(output.to_string_lossy().into_owned()); run_video(&capabilities.binary, &work.0, &render)?;
    let read = |file: &Path| -> Result<String, String> {
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(file).map_err(|e| e.to_string())?.take(16 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        if bytes.len() > 16 * 1024 * 1024 { return Err("Video preview exceeded its 16 MiB response limit".into()); }
        Ok(format!("data:video/mp4;base64,{}", crate::utils::base64_encode(&bytes)))
    };
    Ok(PreviewResult { kind: "video", path: Some(path.to_string_lossy().into_owned()), original: Some(read(&source)?), processed: Some(read(&output)?), width: None, height: None, full_resolution: false, focus: None, affected: None, total: None, elapsed_ms: 0,
        warning: format!("Up to 5 seconds from {start:.2}s, at most 720p/30fps, muted. Same stabilisation filters/settings; short-clip motion context, bitrate and encoder differ from the final full-resolution render. Final bitrate policy: {}. No original/output files changed.", if request.preserve_source_bitrate.unwrap_or(true) { "preserve source" } else { "encoder quality" }) })
}

fn preview(request: PreviewRequest) -> Result<PreviewResult, String> {
    let began = Instant::now(); let selected_task = task(&request.task)?;
    let files = candidates(&request.staging_dir, &request.scope_dir, &request.scope_mode, &selected_task)?;
    if request.task.starts_with("remove_") {
        let total = files.len();
        return Ok(PreviewResult { kind: "cleanup", path: None, original: None, processed: None, width: None, height: None, full_resolution: false, focus: None,
            affected: Some(files.into_iter().take(2000).map(|file| file.to_string_lossy().into_owned()).collect()), total: Some(total), elapsed_ms: began.elapsed().as_millis(),
            warning: if matches!(selected_task, ProcessTask::RemoveFocus) { "Dry run only: these focus-marked files would be renamed to remove the flag; an existing destination will block a rename. No changes made.".into() } else { "Dry run only: these generated files would be deleted if you deliberately queue this cleanup. No changes made. List limited to 2000 entries.".into() } });
    }
    let path = PathBuf::from(request.path.as_deref().ok_or("Choose an eligible original first")?);
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    let eligible = files.iter().any(|file| file.canonicalize().map(|candidate| candidate == canonical).unwrap_or(false));
    if !eligible { return Err("Preview source must be an eligible original in the current processing scope".into()); }
    let mut result = if matches!(selected_task, ProcessTask::Stabilize) { video_preview(&request, &canonical)? }
        else { photo_preview(&request, &canonical, &selected_task)? };
    result.elapsed_ms = began.elapsed().as_millis(); Ok(result)
}

#[tauri::command]
pub async fn process_preview(request: PreviewRequest) -> Result<PreviewResult, String> {
    static LIMIT: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = LIMIT.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1))).clone().try_acquire_owned().map_err(|_| "Another Photo Process preview is still running; retry when it finishes")?;
    tauri::async_runtime::spawn_blocking(move || { let _permit = permit; preview(request) }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(root: &Path, task: &str, path: Option<&Path>) -> PreviewRequest {
        serde_json::from_value(serde_json::json!({ "stagingDir": root, "scopeDir": root, "scopeMode": "folderRecursive", "task": task, "path": path, "fullResolution": true })).unwrap()
    }
    fn fixture(directory: &Path, name: &str) -> PathBuf {
        let path = directory.join(name);
        image::RgbImage::from_fn(90,130,|x,y| image::Rgb([(x*2) as u8,(y*2) as u8,100])).save(&path).unwrap(); path
    }
    #[test]
    fn preview_full_size_uses_shared_recipe_and_never_mutates_original_or_siblings() {
        let work = TempPreview::new().unwrap(); let path = fixture(&work.0,"original.jpg");
        let bytes = std::fs::read(&path).unwrap();
        let mut req = request(&work.0,"bw",Some(&path)); req.bw_params = Some(BwParams::default());
        let result = preview(req).unwrap();
        assert_eq!((result.width,result.height),(Some(90),Some(130)));
        assert!(result.full_resolution);
        let image = load_oriented(&path).unwrap();
        let expected_output = work.0.join("original_BW.jpg");
        super::super::photo_process::save_generated(&expected_output,&DynamicImage::ImageLuma8(render_bw(&image,&BwParams::default()))).unwrap();
        assert_eq!(result.processed,Some(format!("data:image/jpeg;base64,{}",crate::utils::base64_encode(&std::fs::read(&expected_output).unwrap()))));
        std::fs::remove_file(expected_output).unwrap();
        let mut req = request(&work.0,"enhance",Some(&path)); req.enhance_contrast_level = Some(0.0); req.enhance_sharpness_level = Some(0.0);
        let result = preview(req).unwrap(); assert_eq!(result.original,result.processed);
        let focus = preview(request(&work.0,"focus",Some(&path))).unwrap(); assert!(focus.focus.is_some());
        assert_eq!(std::fs::read(&path).unwrap(),bytes); assert_eq!(std::fs::read_dir(&work.0).unwrap().count(),1);
    }
    #[test]
    fn preview_and_job_share_original_eligibility_and_canonical_scope() {
        let work = TempPreview::new().unwrap(); let original = fixture(&work.0,"one.jpeg");
        let generated = fixture(&work.0,"one_IMPROVED.JPG"); fixture(&work.0,"one_bw.jpg"); fixture(&work.0,"real_BW_rider.jpg");
        let paths = candidates(work.0.to_str().unwrap(),work.0.to_str().unwrap(),&ProcessScopeMode::FolderOnly,&ProcessTask::Bw).unwrap();
        assert_eq!(paths.len(),2); assert!(paths.contains(&original)); assert!(!paths.contains(&generated));
        assert!(preview(request(&work.0,"bw",Some(&generated))).is_err());
        let outside = TempPreview::new().unwrap(); let external = fixture(&outside.0,"external.jpg");
        assert!(preview(request(&work.0,"bw",Some(&external))).is_err());
        let nested = work.0.join("nested"); std::fs::create_dir(&nested).unwrap(); let child = fixture(&nested,"nested.jpg");
        let mut req = request(&work.0,"bw",Some(&child)); req.scope_mode = ProcessScopeMode::FolderOnly;
        assert!(preview(req).is_err()); assert!(preview(request(&work.0,"bw",Some(&child))).is_ok());
        let mut req = request(&work.0,"bw",Some(&original)); req.scope_dir = outside.0.to_string_lossy().into_owned();
        assert!(preview(req).is_err());
    }
    #[test]
    fn every_cleanup_preview_is_a_read_only_snapshot() {
        let work = TempPreview::new().unwrap(); fixture(&work.0,"source.jpg");
        let paths = ["source_improved.jpg","source_BW.jpg","source{Out of Focus 3}.jpg","source_stabilized.mp4"];
        for name in paths { std::fs::write(work.0.join(name),name.as_bytes()).unwrap(); }
        for task in ["remove_focus","remove_enhance","remove_bw","remove_stabilize"] {
            let result = preview(request(&work.0,task,None)).unwrap(); assert_eq!(result.kind,"cleanup"); assert_eq!(result.total,Some(1));
        }
        for name in paths { assert_eq!(std::fs::read(work.0.join(name)).unwrap(),name.as_bytes()); }
        assert_eq!(std::fs::read_dir(&work.0).unwrap().count(),5);
    }
    #[test]
    fn preview_refuses_unknown_tasks_invalid_recipes_and_missing_samples() {
        let work = TempPreview::new().unwrap(); let path = fixture(&work.0,"source.jpg");
        assert!(preview(request(&work.0,"transfer",Some(&path))).is_err());
        assert!(preview(request(&work.0,"bw",None)).is_err());
        let mut req = request(&work.0,"bw",Some(&path)); req.bw_params = Some(BwParams { sharpness: 5.0, ..BwParams::default() });
        assert!(preview(req).is_err());
    }
    #[test]
    #[ignore = "Bounded synthetic 2-second FFmpeg preview; no user media"]
    fn process_preview_video_smoke() {
        let work = TempPreview::new().unwrap(); let source = work.0.join("source.mp4");
        let caps = process::detect_ffmpeg_capabilities().unwrap();
        run_video(&caps.binary,&work.0,&["-hide_banner","-nostdin","-loglevel","error","-f","lavfi","-i","testsrc2=size=352x198:rate=30","-t","2","-threads","2","-c:v","libx264","-pix_fmt","yuv420p","source.mp4"].map(String::from)).unwrap();
        let before = std::fs::read(&source).unwrap(); let result = preview(request(&work.0,"stabilize",Some(&source))).unwrap();
        assert_eq!(result.kind,"video"); assert!(result.original.unwrap().starts_with("data:video/mp4;base64,")); assert!(result.processed.unwrap().len() > 1000);
        assert_eq!(std::fs::read(&source).unwrap(),before); assert!(!work.0.join("source_stabilized.mp4").exists());
        assert_eq!(std::fs::read_dir(&work.0).unwrap().count(),1);
    }
}
