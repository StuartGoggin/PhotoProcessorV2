//! Hardware-only optional translation backend. Legacy filters never enter here.
use super::*;

fn worker() -> Result<PathBuf, String> {
    #[cfg(not(windows))]
    return Err("GPU Tripod currently requires Windows hardware D3D11. Choose Quality or Fast.".into());
    #[cfg(windows)] {
        let relative = Path::new("tools/gpu-tripod/photogogo-gpu-tripod.exe");
        if let Some(folder) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
            let path = folder.join(relative);
            if path.is_file() { return Ok(path); }
        }
        if cfg!(debug_assertions) || cfg!(test) {
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
            if path.is_file() { return Ok(path); }
        }
        Err("GPU Tripod worker is missing from this installation. Use Quality or Fast; no PATH tool or CPU substitute will be run.".into())
    }
}

pub(super) fn validate_source(info: &Value) -> Result<(), String> {
    let video = info["streams"].as_array().and_then(|s| s.iter().find(|s| s["codec_type"] == "video"))
        .ok_or("GPU Tripod source has no video stream")?;
    let pixel = video["pix_fmt"].as_str().unwrap_or("");
    if video["width"].as_u64().is_some_and(|n| n > 4096) || video["height"].as_u64().is_some_and(|n| n > 4096) {
        return Err("GPU Tripod v1 is bounded to source dimensions up to 4096 pixels per axis; choose an existing method for larger sources.".into());
    }
    if !["yuv420p", "yuvj420p", "nv12"].contains(&pixel) {
        return Err(format!("GPU Tripod v1 supports SDR 8-bit 4:2:0 footage only, not {pixel}. Choose existing Quality/Fast; this experimental path will not silently reduce source precision."));
    }
    for field in ["color_transfer", "color_primaries", "color_space"] {
        if !["", "unknown", "bt709"].contains(&video[field].as_str().unwrap_or("")) {
            return Err(format!("GPU Tripod v1 requires SDR BT.709 footage ({field}={}). HDR/Log colour conversion is not implemented; choose an existing method.", video[field]));
        }
    }
    if !["", "unknown", "progressive"].contains(&video["field_order"].as_str().unwrap_or("")) {
        return Err("GPU Tripod v1 does not support interlaced footage".into());
    }
    Ok(())
}

fn preflight(binary: &Path) -> Result<Value, String> {
    let result = super::super::process::command_output_limited(binary, &["--probe"], 64 * 1024, Duration::from_secs(10))?;
    if !result.status.success() { return Err(format!("GPU Tripod hardware probe failed: {}. Choose Quality or Fast.", String::from_utf8_lossy(&result.stderr))); }
    let info: Value = serde_json::from_slice(&result.stdout).map_err(|e| format!("Invalid GPU Tripod capability receipt: {e}"))?;
    if info["engine"] != stabilization::GPU_TRIPOD_ENGINE || info["hardware"] != true || info["adapter"].as_str().is_none_or(str::is_empty) {
        return Err("GPU Tripod did not prove the requested hardware engine; no fallback was attempted".into());
    }
    Ok(info)
}

struct GpuSlot;
fn gpu_slot() -> &'static Mutex<bool> { static SLOT: OnceLock<Mutex<bool>> = OnceLock::new(); SLOT.get_or_init(|| Mutex::new(false)) }
impl GpuSlot {
    fn try_acquire() -> Result<Option<Self>, String> {
        let mut held = gpu_slot().lock().map_err(|_| "GPU queue lock failed")?;
        if *held { return Ok(None); }
        *held = true; Ok(Some(Self))
    }
}
impl Drop for GpuSlot { fn drop(&mut self) { if let Ok(mut held) = gpu_slot().lock() { *held = false; } } }

#[allow(clippy::too_many_arguments)]
pub(super) fn render_base(ff: &Path, p: &Project, c: &Clip, info: &Value, encoder: &str,
    offset: f64, seconds: f64, output: &Path, work: &Path, id: &str) -> Result<(), String> {
    validate_source(info)?;
    if !ff.is_absolute() || !ff.is_file() {
        return Err("GPU Tripod requires an exact installed/bundled FFmpeg executable path. A bare PATH name is not accepted by this experimental worker; choose Quality/Fast or repair the bundled media tools.".into());
    }
    let binary = worker()?;
    loop {
    let key = work.to_string_lossy().into_owned();
    let source_video = info["streams"].as_array().and_then(|s| s.iter().find(|s| s["codec_type"] == "video"));
    let reserve_width = p.width.max(source_video.and_then(|v| v["width"].as_u64()).unwrap_or(3840) as u32);
    let reserve_height = p.height.max(source_video.and_then(|v| v["height"].as_u64()).unwrap_or(2160) as u32);
    let (permit, _gpu) = loop {
        checkpoint(id)?;
        match studio_hardware::acquire_tripod(reserve_width, reserve_height, &p.performance,
            || stopped_or_paused(id), |note| update(id, |j| record_memory_wait(j, &key, note))) {
            Ok(permit) => {
                // Never retain a GPU reservation while paused or waiting for
                // RAM/process capacity. A queued paused job must not starve a
                // runnable sibling. Do not block acquiring the second resource.
                if stopped_or_paused(id) { drop(permit); continue; }
                if let Some(gpu) = GpuSlot::try_acquire()? { break (permit, gpu); }
                drop(permit);thread::sleep(Duration::from_millis(100));
            },
            Err(error) => { if jobs().lock().ok().and_then(|s| s.get(id).map(|j| j.paused && !j.cancelled && j.worker_error.is_none())).unwrap_or(false) { continue; } return Err(error); }
        }
    };
    let capability = preflight(&binary)?;
    // Decoder and encoder coexist. Split the reservation rather than giving
    // each child the entire logical CPU allowance; GPU kernel scheduling is serial.
    let threads = (permit.threads() / 2).max(1).min(64);
    let audio = info["streams"].as_array().is_some_and(|s| s.iter().any(|s| s["codec_type"] == "audio"));
    let phase = format!("{}: GPU Tripod base", c.chapter);
    let args = vec!["--render".into(), "--ffmpeg".into(), ff.to_string_lossy().into_owned(),
        "--source".into(), c.path.clone(), "--output".into(), output.to_string_lossy().into_owned(),
        "--width".into(), p.width.to_string(), "--height".into(), p.height.to_string(), "--fps".into(), p.fps.to_string(),
        "--encoder".into(), encoder.into(), "--threads".into(), threads.to_string(), "--bitrate".into(), effective_bitrate(p).to_string(),
        "--seconds".into(), seconds.to_string(), "--offset".into(), offset.to_string(),
        "--crop".into(), if c.framing == "aggressiveCrop" { "0.06" } else { "0.04" }.into(),
        "--preset".into(), c.stabilization.clone(), "--audio".into(), if audio { "yes" } else { "no" }.into()];
    update(id, |j| {
        j.status = "running".into();j.threads_per_worker = permit.threads();
        j.logs.push(format!("GPU Tripod hardware: {}; global XY only, zero added roll, fixed per-edge crop. CPU decode/upload/readback; no mesh/NVOF or global sharpening. One GPU pipeline, three reserved process slots; {threads} threads per FFmpeg child. Conservative fixed admission for this new workload.", capability["adapter"]));
        j.active_tasks.push(ActiveTask { key: key.clone(), phase: phase.clone(), threads: permit.threads(), ..ActiveTask::default() });
    });
    struct Active<'a> { id: &'a str, key: String }
    impl Drop for Active<'_> { fn drop(&mut self) { update(self.id, |j| { j.active_tasks.retain(|t| t.key != self.key);if j.paused && j.active_tasks.is_empty() { j.status = "paused".into(); } }); } }
    let _active = Active { id, key: key.clone() };
    record_progress(id, &key, &phase, 0., None, None);
    match diagnostics::run_admitted_process(&binary, &args, work, id, &phase, Some((seconds, 0., 65.)), None, permit.progress_id()) {
        Err(error) if error == diagnostics::RETRY_ADMISSION => continue,
        result => result?,
    }
    // The existing publication stage separately probes duration/streams/checksum;
    // a successful subprocess alone cannot promote a partial output to cache.
    record_progress(id, &key, &phase, 65., None, None);
    return Ok(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn precision_and_colour_are_rejected_before_gpu_work() {
        for pixel in ["yuv420p10le", "yuv422p10le", "yuv444p", ""] {
            assert!(validate_source(&json!({"streams":[{"codec_type":"video","pix_fmt":pixel}]})).is_err());
        }
        assert!(validate_source(&json!({"streams":[{"codec_type":"video","pix_fmt":"yuvj420p","color_transfer":"bt709"}]})).is_ok());
        assert!(validate_source(&json!({"streams":[{"codec_type":"video","pix_fmt":"yuv420p","color_transfer":"smpte2084"}]})).is_err());
        assert!(validate_source(&json!({"streams":[{"codec_type":"video","pix_fmt":"yuv420p","width":7680,"height":4320}]})).is_err());
    }

    #[test]
    fn admitted_pause_returns_before_launch_and_releases_gpu_scope() {
        let id = "gpu-tripod-prelaunch-pause";
        jobs().lock().unwrap().insert(id.into(), StudioJob { paused: true, ..StudioJob::default() });
        let slot = GpuSlot::try_acquire().unwrap().unwrap();
        let start = std::time::Instant::now();
        let result = diagnostics::run_admitted_process(Path::new("must-not-launch.exe"), &[], Path::new("."), id, "test", None, None, None);
        assert_eq!(result.unwrap_err(), diagnostics::RETRY_ADMISSION);
        assert!(start.elapsed() < Duration::from_secs(1));
        drop(slot);
        assert!(GpuSlot::try_acquire().unwrap().is_some(), "Paused job retained the GPU slot");
        jobs().lock().unwrap().remove(id);
    }

    #[test]
    #[ignore = "bounded native GPU render/preview/cache smoke; needs hardware D3D11 and bundled worker"]
    fn gpu_tripod_render_cache_smoke() {
        let ff = detect_ffmpeg_capabilities().unwrap().binary;
        preflight(&worker().unwrap()).unwrap();
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("test-output")
            .join(format!("studio-gpu-smoke-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("source.mp4");
        let generated = command(&ff).args(["-v", "error", "-nostdin", "-n", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=25",
            "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "0.64", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-threads", "2"])
            .arg(&source).output().unwrap();
        assert!(generated.status.success(), "{}", String::from_utf8_lossy(&generated.stderr));
        let source_hash = compute_md5(&source).unwrap();
        let mut p = super::super::tests::project(&root);
        p.width = 1280; p.height = 720; p.fps = 25; p.bitrate_mbps = 4;
        p.title.clear(); p.title_seconds = 0.; p.encoder_preference = "cpu".into();p.performance = "balanced".into();p.adaptive_scheduling = false;
        p.clips[0].path = source.to_string_lossy().into_owned(); p.clips[0].duration = 0.64;
        p.clips[0].title.clear();p.clips[0].title_seconds = 0.;p.clips[0].replays.clear();
        p.clips[0].stabilization = "balanced".into();p.clips[0].stabilization_method = "gpuTripod".into();p.clips[0].framing = "edgeSafe".into();
        let saved = serde_json::to_value(&p).unwrap();let mut p: Project = serde_json::from_value(saved).unwrap();
        validate(&p).unwrap();
        let id = "gpu-tripod-cache-smoke";
        jobs().lock().unwrap().insert(id.into(), StudioJob { id: id.into(), status: "running".into(), ..StudioJob::default() });
        let output = render(p.clone(), root.to_string_lossy().into_owned(), false, None, None, "clip", false, id).unwrap();
        verify_output(&inspect(&ff, Path::new(&output)).unwrap(), &p, 0.64).unwrap();
        let before = jobs().lock().unwrap()[id].logs.iter().filter(|line| line.contains("GPU Tripod hardware:")).count();
        p.title = "New opening".into();p.title_seconds = 0.04;
        render(p.clone(), root.to_string_lossy().into_owned(), false, None, None, "project", false, id).unwrap();
        let job = jobs().lock().unwrap()[id].clone();
        assert_eq!(job.logs.iter().filter(|line| line.contains("GPU Tripod hardware:")).count(), before, "Opening changes must reuse the stabilized base");
        assert!(job.logs.iter().any(|line| line.contains("Reused base fragment")));
        p.title.clear();p.title_seconds = 0.;
        let preview = render(p.clone(), root.to_string_lossy().into_owned(), true, Some(0.08), Some(0.32), "preview", false, id).unwrap();
        let mut format = p.clone();format.width = 1280;format.height = 720;
        verify_output(&inspect(&ff, Path::new(&preview)).unwrap(), &format, 0.32).unwrap();
        assert_eq!(compute_md5(&source).unwrap(), source_hash, "Original synthetic source changed");
        assert!(Path::new(&output).is_file());
        println!("PASS: saved-project round-trip, native render and audio, finishing base reuse, bounded preview. Outputs: {}", root.display());
        jobs().lock().unwrap().remove(id);
    }
}
