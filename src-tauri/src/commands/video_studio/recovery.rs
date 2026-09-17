use super::*;
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct RenderRequest {
    pub project: Project,
    pub staging_dir: String,
    pub preview: bool,
    pub preview_start: Option<f64>,
    pub preview_length: Option<f64>,
    pub kind: String,
    pub clip_id: Option<String>,
    pub assemble_only: bool,
}
#[derive(Serialize, Deserialize)]
struct Checkpoint {
    job: StudioJob,
    request: RenderRequest,
}
static STORE: OnceLock<PathBuf> = OnceLock::new();
static LIFECYCLE: Mutex<()> = Mutex::new(());
static GENERATION: OnceLock<Mutex<String>> = OnceLock::new();
pub(super) fn generation() -> String {
    GENERATION.get_or_init(|| Mutex::new("0".into())).lock().map(|g| g.clone()).unwrap_or_else(|_| "0".into())
}
pub(super) fn log_root() -> PathBuf {
    STORE.get().cloned().unwrap_or_else(|| std::env::temp_dir().join("photogogo-studio-test-jobs")).join("logs")
}
static REQUESTS: OnceLock<Mutex<HashMap<String, RenderRequest>>> = OnceLock::new();
fn requests() -> &'static Mutex<HashMap<String, RenderRequest>> {
    REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn init_studio_recovery(app: &tauri::AppHandle) -> Result<(), String> {
    let folder = app.path().app_data_dir().map_err(|e| e.to_string())?.join("studio-jobs");
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let generation = fs::read_to_string(folder.join("render-generation.txt")).unwrap_or_else(|_| "0".into());
    if generation.trim().is_empty() || !generation.trim().bytes().all(|b| b.is_ascii_digit()) {
        return Err("Invalid Studio render generation file".into());
    }
    *GENERATION.get_or_init(|| Mutex::new("0".into())).lock().map_err(|e| e.to_string())? = generation.trim().into();
    for entry in fs::read_dir(&folder).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
        match fs::read(&path).ok().and_then(|raw| serde_json::from_slice::<Checkpoint>(&raw).ok()) {
            Some(mut saved) => {
                recover_status(&mut saved.job);
                requests().lock().map_err(|e| e.to_string())?.insert(saved.job.id.clone(), saved.request);
                jobs().lock().map_err(|e| e.to_string())?.insert(saved.job.id.clone(), saved.job);
            }
            None => log::warn!("Could not read Studio recovery record {}", path.display()),
        }
    }
    STORE.set(folder).map_err(|_| "Studio recovery already initialized".to_string())?;
    Ok(())
}
fn recover_status(job: &mut StudioJob) {
    job.process_id = None;
    if ["queued", "running"].contains(&job.status.as_str()) {
        job.status = "interrupted".into();
        job.phase = "App closed before completion. Resume to reuse verified clips.".into();
        job.paused = false;
        job.cancelled = false;
    }
}
pub(super) fn persist(job: &StudioJob) -> Result<(), String> {
    let Some(folder) = STORE.get() else { return Ok(()); };
    let request = requests().lock().map_err(|e| e.to_string())?.get(&job.id).cloned();
    let Some(request) = request else { return Ok(()); };
    let path = folder.join(format!("{}.json", job.id));
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec(&Checkpoint { job: job.clone(), request }).map_err(|e| e.to_string())?;
    let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(temporary, path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn studio_retry_job(id: String) -> Result<String, String> {
    let request = requests().lock().map_err(|e| e.to_string())?.get(&id).cloned().ok_or("Saved render request unavailable")?;
    {
        let store = jobs().lock().map_err(|e| e.to_string())?;
        let job = store.get(&id).ok_or("Unknown job")?;
        if !["interrupted", "failed", "cancelled"].contains(&job.status.as_str()) {
            return Err("Only interrupted, failed or cancelled jobs can be retried".into());
        }
    }
    let new_id = enqueue(request)?;
    update(&new_id, |job| { job.retry_of = Some(id.clone()); job.logs.push(format!("Retry of saved attempt {id}")); });
    update(&id, |job| { job.status = "retried".into(); job.retried_as = Some(new_id.clone()); job.phase = format!("Continued as {new_id}"); });
    Ok(new_id)
}

pub(super) fn enqueue(request: RenderRequest) -> Result<String, String> {
    let _gate = LIFECYCLE.try_lock().map_err(|_| "Studio queue is being updated or cleared. Please try again shortly.")?;
    validate(&request.project)?;
    if !Path::new(&request.project.output_dir).is_dir() { return Err("Choose an existing output folder".into()); }
    if !request.project.clips.iter().any(|clip| clip.include) { return Err("Include at least one clip".into()); }
    if !request.preview && request.kind != "music" && request.project.clips.iter().any(|clip| clip.include && !clip.reviewed) {
        return Err("Review every included clip before rendering".into());
    }
    if request.project.music.enabled && !request.preview && request.kind != "music" { music_audio_source(&request.project.music.audio_path)?; }
    let mut store = jobs().lock().map_err(|e| e.to_string())?;
    let mut saved_requests = requests().lock().map_err(|e| e.to_string())?;
    let identity = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    for (id, existing) in saved_requests.iter() {
        if store.get(id).map(|job| ["queued", "running"].contains(&job.status.as_str())).unwrap_or(false)
            && serde_json::to_vec(existing).ok().as_ref() == Some(&identity) { return Ok(id.clone()); }
    }
    let id = format!("{}-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default(), std::process::id());
    let p = &request.project;
    let name = if request.kind == "clip" { p.clips.iter().find(|c| c.include).map(|c| c.chapter.clone()).unwrap_or_else(|| p.name.clone()) } else { p.name.clone() };
    let log_path = diagnostics::create_log(&id)?;
    let created_at = chrono::Utc::now().to_rfc3339();
    let first_log = format!("{created_at} Queued {} job {id}; app {}; {}x{} {} fps, {} Mbps; destination {}", request.kind, env!("CARGO_PKG_VERSION"), p.width, p.height, p.fps, effective_bitrate(p), p.output_dir);
    diagnostics::append(&log_path, &first_log);
    let job = StudioJob {
        created_at, log_path, logs: vec![first_log],
        id: id.clone(), name, status: "queued".into(), phase: "Waiting in render queue".into(),
        kind: request.kind.clone(), clip_id: request.clip_id.clone(),
        width: if request.preview { 1280 } else { p.width }, height: if request.preview { 720 } else { p.height },
        fps: p.fps, bitrate_mbps: effective_bitrate(p), duration: project_timeline_seconds(p),
        targets: if request.kind == "music" { vec![] } else { p.clips.iter().filter(|c| c.include).map(|c| ClipTarget { clip_id: c.id.clone(), source_path: c.path.clone(), revision: c.revision }).collect() },
        music_request_id: if request.kind == "music" { p.music.request_id.clone() } else { String::new() },
        ..StudioJob::default()
    };
    saved_requests.insert(id.clone(), request.clone());
    drop(saved_requests);
    persist(&job)?;
    store.insert(id.clone(), job);
    drop(store);
    let worker_id = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        static RENDER_LOCK: Mutex<()> = Mutex::new(());
        let result = (|| {
            let _guard = loop {
                checkpoint(&worker_id)?;
                let earlier = jobs().lock().map_err(|e| e.to_string())?.values().any(|j|
                    j.id < worker_id && j.status == "queued" && !j.cancelled && !j.paused);
                if !earlier {
                    match RENDER_LOCK.try_lock() {
                        Ok(guard) => break guard,
                        Err(std::sync::TryLockError::Poisoned(_)) => return Err("Render queue lock failed".into()),
                        Err(_) => {},
                    }
                }
                thread::sleep(Duration::from_millis(200));
            };
            update(&worker_id, |j| { j.status = "running".into(); j.started_at = chrono::Utc::now().to_rfc3339(); });
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| execute(request, &worker_id)))
                .unwrap_or_else(|_| Err("Render worker panicked. See the saved job log and retry this request.".into()))
        })();
        update(&worker_id, |job| { job.finished_at = chrono::Utc::now().to_rfc3339(); job.process_id = None; match result {
            Ok(path) => { job.logs.push(format!("Completed output: {path}")); job.status = "completed".into(); job.phase = "Verified and ready".into(); job.progress = 100.; job.output = Some(path); }
            Err(error) => { job.logs.push(format!("ERROR: {error}")); job.status = if job.cancelled { "cancelled" } else { "failed" }.into(); job.error = Some(error); }
        }});
    });
    Ok(id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearResult { cleared: usize, archive_path: String }

#[tauri::command]
pub async fn studio_clear_jobs() -> Result<ClearResult, String> {
    tauri::async_runtime::spawn_blocking(clear_jobs).await.map_err(|e| e.to_string())?
}

fn clear_jobs() -> Result<ClearResult, String> {
    let _gate = LIFECYCLE.try_lock().map_err(|_| "Another Studio queue update is in progress. Try again shortly.")?;
    let folder = STORE.get().ok_or("Studio job storage is unavailable")?;
    let ids: Vec<String> = {
        let mut store = jobs().lock().map_err(|e| e.to_string())?;
        for job in store.values_mut() {
            if ["queued", "running"].contains(&job.status.as_str()) { job.cancelled = true; job.paused = false; }
        }
        store.keys().cloned().collect()
    };
    for id in &ids { update(id, |job| job.logs.push("Clear all renders requested: stop active work before removing history".into())); }
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let active = jobs().lock().map_err(|e| e.to_string())?.values().any(|job| ["queued", "running"].contains(&job.status.as_str()) || job.process_id.is_some());
        if !active { break; }
        if std::time::Instant::now() >= deadline {
            return Err("Cancellation requested, but a worker has not stopped yet. No job history was removed. Wait for the current file check to finish, then clear again; restart the app if it remains stuck.".into());
        }
        thread::sleep(Duration::from_millis(100));
    }
    // A new cache generation prevents reuse even when an old saved project
    // still references exported clips. Existing media/cache files stay intact.
    let next = chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default().to_string();
    let pending = folder.join("render-generation.tmp");
    fs::write(&pending, &next).map_err(|e| e.to_string())?;
    fs::rename(&pending, folder.join("render-generation.txt")).map_err(|e| e.to_string())?;
    *GENERATION.get_or_init(|| Mutex::new("0".into())).lock().map_err(|e| e.to_string())? = next.clone();
    let archive = folder.join("cleared-history").join(&next);
    fs::create_dir_all(&archive).map_err(|e| e.to_string())?;
    let mut moved: Vec<(PathBuf, PathBuf)> = Vec::new();
    for id in &ids {
        if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return Err("Invalid job identifier; history was retained for inspection".into());
        }
    }
    for id in &ids {
        let source = folder.join(format!("{id}.json"));
        let destination = archive.join(format!("{id}.json"));
        if source.exists() {
            if let Err(error) = fs::rename(&source, &destination) {
                let mut rollback_errors = Vec::new();
                for (from, to) in moved.iter().rev() { if let Err(e) = fs::rename(to, from) { rollback_errors.push(e.to_string()); } }
                return Err(format!("Could not archive job history: {error}. Jobs remain visible; rollback errors: {rollback_errors:?}"));
            }
            moved.push((source, destination));
        }
    }
    // All workers have acknowledged cancellation and completed their final
    // checkpoint. No producer can recreate a cleared record after this point.
    let mut store = jobs().lock().map_err(|e| e.to_string())?;
    let mut saved = requests().lock().map_err(|e| e.to_string())?;
    for id in &ids { store.remove(id); saved.remove(id); }
    Ok(ClearResult { cleared: ids.len(), archive_path: archive.to_string_lossy().into_owned() })
}

// Revision is a UI hint. Content and source hashes are the authority for reuse.
fn clip_signature(p: &Project, clip: &Clip, root: &str) -> Result<String, String> {
    let path = source(Path::new(root), &clip.path)?;
    Ok(signature(&[source_signature(&path)?, format_key(p), clip.title.clone(), clip.title_seconds.to_string(),
        clip.stabilization.clone(), clip.framing.clone(), serde_json::to_string(&clip.replays).map_err(|e| e.to_string())?]))
}
pub(super) fn verify_clip(ff: &Path, p: &Project, clip: &Clip, rendered: &ClipRender, root: &str) -> Result<(), String> {
    if rendered.signature.is_empty() || rendered.signature != clip_signature(p, clip, root)?
        || rendered.width != p.width || rendered.height != p.height || rendered.fps != p.fps
        || rendered.bitrate_mbps != effective_bitrate(p)
        || rendered.checksum.is_empty() || compute_md5(Path::new(&rendered.path)).ok().as_ref() != Some(&rendered.checksum)
        || !rendered_clip_is_valid(ff, Path::new(&rendered.path), p, rendered.duration) {
        return Err(format!("{} needs rendering again: edits, source, format or output changed", clip.chapter));
    }
    Ok(())
}
fn execute(request: RenderRequest, id: &str) -> Result<String, String> {
    let mut p = request.project;
    if request.kind == "music" { return super::soundtrack::render_soundtrack(&p, id); }
    if request.preview {
        p.music.enabled = false;
        return render(p, request.staging_dir, true, request.preview_start, request.preview_length, "preview", false, id);
    }
    let ff = detect_ffmpeg_capabilities()?.binary;
    p.clips.retain(|clip| clip.include);
    let format = p.clone();
    for (index, clip) in p.clips.iter_mut().enumerate() {
        checkpoint(id)?;
        update(id, |job| job.phase = format!("Clip {} of {}: checking {}", index + 1, format.clips.len(), clip.chapter));
        let key = clip_signature(&format, clip, &request.staging_dir)?;
        let mut candidates = Vec::new();
        if let Some(rendered) = &clip.rendered { candidates.push(rendered.clone()); }
        for job in jobs().lock().map_err(|e| e.to_string())?.values() {
            candidates.extend(job.artifacts.iter().filter(|a| a.rendered.signature == key).map(|a| a.rendered.clone()));
        }
        let cached = candidates.into_iter().find(|r| r.signature == key && r.bitrate_mbps == effective_bitrate(&format)
            && !r.checksum.is_empty() && compute_md5(Path::new(&r.path)).ok().as_ref() == Some(&r.checksum)
            && rendered_clip_is_valid(&ff, Path::new(&r.path), &format, r.duration));
        let mut rendered = if let Some(rendered) = cached {
            update(id, |job| job.logs.push(format!("Reused verified clip: {}", clip.chapter)));
            rendered
        } else {
            if request.assemble_only { return Err(format!("{} needs rendering. Use Create complete video to prepare it automatically.", clip.chapter)); }
            update(id, |job| { job.progress_base = 85. * index as f64 / format.clips.len() as f64; job.progress_scale = 0.85 / format.clips.len() as f64; });
            let mut single = format.clone();
            single.clips = vec![clip.clone()];
            single.title.clear(); single.subtitle.clear(); single.title_seconds = 0.; single.music.enabled = false;
            let path = render(single, request.staging_dir.clone(), false, None, None, "clip", false, id)?;
            ClipRender {
                checksum: compute_md5(Path::new(&path)).map_err(|e| e.to_string())?,
                duration: duration(&inspect(&ff, Path::new(&path))?)?, path,
                width: format.width, height: format.height, fps: format.fps, bitrate_mbps: effective_bitrate(&format),
                revision: clip.revision, signature: key, rendered_at: chrono::Utc::now().to_rfc3339(),
            }
        };
        rendered.revision = clip.revision;
        let artifact = ClipArtifact { clip_id: clip.id.clone(), source_path: clip.path.clone(), rendered: rendered.clone() };
        clip.rendered = Some(rendered);
        update(id, |job| { job.artifacts.push(artifact); job.progress = 85. * (index + 1) as f64 / format.clips.len() as f64; });
    }
    if request.kind == "clip" { return Ok(p.clips[0].rendered.as_ref().unwrap().path.clone()); }
    update(id, |job| { job.progress_base = 85.; job.progress_scale = 0.15; });
    render(p, request.staging_dir, false, None, None, "assembly", true, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "isolated process: sets global checkpoint store"]
    fn clear_jobs_smoke() {
        let root = std::env::temp_dir().join(format!("studio-clear-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir(&root).unwrap();
        STORE.set(root.clone()).unwrap();
        fs::write(root.join("source.mp4"), b"keep source").unwrap();
        let before = generation();
        for (id, status) in [("active", "running"), ("done", "completed"), ("waiting", "queued"), ("failed", "failed")] {
            jobs().lock().unwrap().insert(id.into(), StudioJob { id: id.into(), status: status.into(), paused: true, ..StudioJob::default() });
            fs::write(root.join(format!("{id}.json")), b"saved checkpoint").unwrap();
        }
        let worker = thread::spawn(|| {
            loop {
                if jobs().lock().unwrap().get("active").unwrap().cancelled { break; }
                thread::sleep(Duration::from_millis(10));
            }
            for id in ["active", "waiting"] {
                assert!(checkpoint(id).is_err());
                update(id, |j| j.status = "cancelled".into());
            }
        });
        let result = clear_jobs().unwrap();
        worker.join().unwrap();
        assert_eq!(result.cleared, 4);
        assert!(jobs().lock().unwrap().is_empty());
        assert_ne!(generation(), before);
        assert_eq!(fs::read_to_string(root.join("render-generation.txt")).unwrap(), generation());
        for id in ["active", "done", "waiting", "failed"] {
            assert!(!root.join(format!("{id}.json")).exists());
            assert!(Path::new(&result.archive_path).join(format!("{id}.json")).exists());
        }
        assert_eq!(fs::read(root.join("source.mp4")).unwrap(), b"keep source");
        assert_eq!(clear_jobs().unwrap().cleared, 0);
    }
    #[test]
    #[ignore = "renders synthetic clips, exercises on-disk recovery, requires FFmpeg"]
    fn restart_assembly_smoke() {
        let ff = detect_ffmpeg_capabilities().unwrap().binary;
        let root = std::env::temp_dir().join(format!("studio-recovery-{}", chrono::Utc::now().timestamp_millis()));
        fs::create_dir(&root).unwrap();
        let checkpoints = root.join("checkpoints"); fs::create_dir(&checkpoints).unwrap();
        STORE.set(checkpoints.clone()).unwrap();
        let source = root.join("source.mp4");
        let generated = command(&ff).args(["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p"]).arg(&source).output().unwrap();
        assert!(generated.status.success(), "{}", String::from_utf8_lossy(&generated.stderr));
        let clip = Clip { id: "recovery-clip".into(), path: source.to_string_lossy().into_owned(), duration: 1., include: true, chapter: "One".into(), title: "Practice".into(), title_seconds: 0.5,
            stabilization: "off".into(), framing: "edgeSafe".into(), reviewed: true, notes: String::new(), replays: vec![Replay { id: "recap".into(), start: 0.2, end: 0.6, speed: 0.5, caption: "Replay".into(), enabled: true }], rendered: None, revision: 0 };
        let p = Project { version: 1, name: "Recovery test".into(), team: String::new(), title: "Opening".into(), subtitle: String::new(), title_seconds: 0.5,
            output_dir: root.to_string_lossy().into_owned(), width: 1280, height: 720, fps: 30, clips: vec![clip.clone()], music: BackgroundMusic::default(), assemble_rendered_clips: true, bitrate_mbps: 2 };
        let request = RenderRequest { project: p.clone(), staging_dir: root.to_string_lossy().into_owned(), preview: false, preview_start: None, preview_length: None, kind: "clip".into(), clip_id: Some(clip.id.clone()), assemble_only: false };
        let id = "recovery-test";
        requests().lock().unwrap().insert(id.into(), request.clone());
        jobs().lock().unwrap().insert(id.into(), StudioJob { id: id.into(), status: "running".into(), ..StudioJob::default() });
        let first = execute(request.clone(), id).unwrap();
        // Simulate process loss: discard memory and reload the actual saved checkpoint.
        let mut saved: Checkpoint = serde_json::from_slice(&fs::read(checkpoints.join(format!("{id}.json"))).unwrap()).unwrap();
        recover_status(&mut saved.job);
        assert_eq!(saved.job.status, "interrupted");
        assert_eq!(saved.job.artifacts.len(), 1);
        jobs().lock().unwrap().clear(); requests().lock().unwrap().clear();
        jobs().lock().unwrap().insert(id.into(), saved.job);
        requests().lock().unwrap().insert(id.into(), saved.request);
        let mut assembly = request.clone(); assembly.kind = "project".into(); assembly.clip_id = None;
        let output = execute(assembly.clone(), id).unwrap();
        let info = inspect(&ff, Path::new(&output)).unwrap();
        assert!(cached_output_matches(&info, &p, 2.3));
        let current = jobs().lock().unwrap().get(id).unwrap().clone();
        assert_eq!(current.artifacts.last().unwrap().rendered.path, first);
        assert!(current.logs.iter().any(|line| line.contains("Reused verified clip")));
        // Wrong FPS, bitrate and edited titles cannot reuse a completed asset.
        let rendered = &current.artifacts[0].rendered;
        let mut changed = p.clone(); changed.fps = 25;
        assert!(verify_clip(&ff, &changed, &clip, rendered, &request.staging_dir).is_err());
        changed = p.clone(); changed.bitrate_mbps = 5;
        assert!(verify_clip(&ff, &changed, &clip, rendered, &request.staging_dir).is_err());
        let mut edited = clip.clone(); edited.title = "Different title".into();
        assert!(verify_clip(&ff, &p, &edited, rendered, &request.staging_dir).is_err());
        // Exercise final music mux without re-encoding clip video.
        let audio = root.join("music.wav");
        let tone = command(&ff).args(["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=48000", "-t", "1"]).arg(&audio).output().unwrap();
        assert!(tone.status.success());
        assembly.project.music.enabled = true; assembly.project.music.audio_path = audio.to_string_lossy().into_owned();
        let mixed = execute(assembly, id).unwrap();
        assert!(cached_output_matches(&inspect(&ff, Path::new(&mixed)).unwrap(), &p, 2.3));
        println!("Verified recovery, clip format, assembly and music outputs: {}", root.display());
    }
    #[test]
    fn recovery_never_claims_interrupted_work_completed() {
        let mut job = StudioJob { status: "running".into(), paused: true, ..StudioJob::default() };
        recover_status(&mut job);
        assert_eq!(job.status, "interrupted"); assert!(!job.paused);
        job.status = "completed".into(); recover_status(&mut job); assert_eq!(job.status, "completed");
    }
}
