use super::*;
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct RenderRequest {
    pub project: Project,
    pub staging_dir: String,
    pub preview: bool,
    pub preview_start: Option<f64>,
    pub preview_length: Option<f64>,
    #[serde(default = "project_kind")]
    pub kind: String,
    #[serde(default)]
    pub clip_id: Option<String>,
    #[serde(default)]
    pub assemble_only: bool,
}
fn project_kind() -> String { "project".into() }
#[derive(Serialize, Deserialize)]
struct Checkpoint {
    job: StudioJob,
    request: RenderRequest,
}
static STORE: OnceLock<PathBuf> = OnceLock::new();
static LIFECYCLE: Mutex<()> = Mutex::new(());
static INSTANCE_LOCK: OnceLock<fs::File> = OnceLock::new();
static ACTIVE: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
fn active() -> &'static Mutex<std::collections::HashSet<String>> {
    ACTIVE.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}
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
    fs::create_dir_all(app.path().app_config_dir().map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let lock = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true)
        .open(app.path().app_config_dir().map_err(|e| e.to_string())?.join("video-studio-queue.lock")).map_err(|e| e.to_string())?;
    fs2::FileExt::try_lock_exclusive(&lock).map_err(|_| "Another PhotoGoGo instance owns the Studio queue. Close it before opening this instance.")?;
    INSTANCE_LOCK.set(lock).map_err(|_| "Studio queue already initialized")?;
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
    migrate_legacy_queue(&app.path().app_config_dir().map_err(|e| e.to_string())?.join("video-studio-queue.json"))?;
    Ok(())
}
fn migrate_legacy_queue(path: &Path) -> Result<(), String> {
    if !path.exists() { return Ok(()); }
    #[derive(Deserialize)]
    struct Legacy { version: u32, jobs: Vec<StudioJob>, requests: HashMap<String, RenderRequest> }
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > 25_000_000 { return Err("Legacy Studio queue exceeds recovery size limit; file preserved".into()); }
    let snapshot: Legacy = serde_json::from_reader(file).map_err(|e| format!("Legacy Studio queue was preserved but could not be read: {e}"))?;
    if snapshot.version != 1 { return Err("Unsupported legacy Studio queue version; file preserved".into()); }
    for mut job in snapshot.jobs {
        if job.id.is_empty() || !job.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return Err("Invalid legacy job ID; queue preserved".into()); }
        if jobs().lock().map_err(|e| e.to_string())?.contains_key(&job.id) { continue; }
        let Some(mut request) = snapshot.requests.get(&job.id).cloned() else { continue; };
        request.kind = if request.preview { "preview" } else { "project" }.into();
        job.kind = request.kind.clone(); job.width = request.project.width; job.height = request.project.height;
        job.fps = request.project.fps; job.bitrate_mbps = effective_bitrate(&request.project);
        job.targets = request.project.clips.iter().filter(|c| c.include).map(|c| ClipTarget { clip_id: c.id.clone(), source_path: c.path.clone(), revision: c.revision }).collect();
        recover_status(&mut job);
        requests().lock().map_err(|e| e.to_string())?.insert(job.id.clone(), request);
        persist(&job)?;
        jobs().lock().map_err(|e| e.to_string())?.insert(job.id.clone(), job);
    }
    let archive = path.with_file_name(format!("video-studio-queue.migrated-{}.json", chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()));
    fs::rename(path, archive).map_err(|e| e.to_string())
}
fn recover_status(job: &mut StudioJob) {
    job.process_id = None;
    job.process_ids.clear(); job.active_tasks.clear(); job.started_ms = None;
    job.recoverable = ["queued", "running", "paused", "failed", "cancelled", "interrupted"].contains(&job.status.as_str());
    if ["queued", "running", "paused"].contains(&job.status.as_str()) {
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
    retry_job(&id, false)
}
pub(super) fn retry_job(id: &str, cpu: bool) -> Result<String, String> {
    let mut request = requests().lock().map_err(|e| e.to_string())?.get(id).cloned().ok_or("Saved render request unavailable")?;
    if cpu { request.project.encoder_preference = "cpu".into(); }
    {
        let store = jobs().lock().map_err(|e| e.to_string())?;
        let job = store.get(id).ok_or("Unknown job")?;
        if !["interrupted", "failed", "cancelled"].contains(&job.status.as_str()) {
            return Err("Only interrupted, failed or cancelled jobs can be retried".into());
        }
    }
    let new_id = enqueue(request)?;
    update(&new_id, |job| { job.retry_of = Some(id.to_string()); job.logs.push(format!("Retry of saved attempt {id}")); });
    update(&id, |job| { job.status = "retried".into(); job.retried_as = Some(new_id.clone()); job.phase = format!("Continued as {new_id}"); });
    Ok(new_id)
}

pub(super) fn reorder(id: &str, direction: &str) -> Result<(), String> {
    let _gate = LIFECYCLE.try_lock().map_err(|_| "Studio queue is being updated")?;
    let mut store = jobs().lock().map_err(|e| e.to_string())?;
    if store.get(id).map(|j| j.status.as_str()) != Some("queued") { return Err("Only queued jobs can be reordered".into()); }
    let mut ordered: Vec<_> = store.values().filter(|j| j.status == "queued").map(|j| (j.queue_position.unwrap_or(usize::MAX), j.id.clone())).collect();
    ordered.sort();
    let index = ordered.iter().position(|(_, key)| key == id).ok_or("Job not queued")?;
    let other = if direction == "up" { index.saturating_sub(1) } else { (index + 1).min(ordered.len() - 1) };
    ordered.swap(index, other);
    for (index, (_, key)) in ordered.iter().enumerate() {
        let job = store.get_mut(key).unwrap(); job.queue_position = Some(index + 1); persist(job)?;
    }
    Ok(())
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
    if saved_requests.len() >= 100 { return Err("Studio has 100 saved jobs. Use Clear all Studio renders before adding more work; exported media will be kept.".into()); }
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
        queue_position: Some(store.values().filter_map(|j| j.queue_position).max().unwrap_or(0) + 1),
        recoverable: true,
        created_at, log_path, logs: vec![first_log],
        id: id.clone(), name, status: "queued".into(), phase: "Waiting in render queue".into(),
        kind: request.kind.clone(), clip_id: request.clip_id.clone(),
        width: if request.preview { 1280 } else { p.width }, height: if request.preview { 720 } else { p.height },
        fps: p.fps, bitrate_mbps: effective_bitrate(p), duration: project_timeline_seconds(p),
        targets: if request.kind == "music" { vec![] } else { p.clips.iter().filter(|c| c.include).map(|c| ClipTarget { clip_id: c.id.clone(), source_path: c.path.clone(), revision: c.revision }).collect() },
        sequence: if !request.preview && matches!(request.kind.as_str(), "project" | "assembly") { Some(sequence::recipe(p)) } else { None },
        music_request_id: if request.kind == "music" { p.music.request_id.clone() } else { String::new() },
        ..StudioJob::default()
    };
    saved_requests.insert(id.clone(), request.clone());
    drop(saved_requests);
    if let Err(error) = persist(&job) { requests().lock().map_err(|e| e.to_string())?.remove(&id); return Err(format!("Could not save render request; job was not started: {error}")); }
    store.insert(id.clone(), job);
    drop(store);
    let worker_id = id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            loop {
                checkpoint(&worker_id)?;
                {
                    let mut admitted = active().lock().map_err(|e| e.to_string())?;
                    let mut store = jobs().lock().map_err(|e| e.to_string())?;
                    let position = store.get(&worker_id).and_then(|j| j.queue_position).unwrap_or(usize::MAX);
                    let earlier = store.values().any(|j| j.status == "queued" && !j.cancelled && !j.paused
                        && (j.queue_position.unwrap_or(usize::MAX), &j.id) < (position, &worker_id));
                    let running = admitted.iter().filter(|id| store.get(*id).map(|j| !j.paused).unwrap_or(false)).count();
                    if !earlier && running < 2 {
                        admitted.insert(worker_id.clone());
                        if let Some(job) = store.get_mut(&worker_id) { job.status = "running".into(); job.queue_position = None; }
                        break;
                    }
                }
                thread::sleep(Duration::from_millis(200));
            }
            update(&worker_id, |j| { j.status = "running".into(); j.started_ms = Some(chrono::Utc::now().timestamp_millis()); j.started_at = chrono::Utc::now().to_rfc3339(); });
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| execute(request, &worker_id)))
                .unwrap_or_else(|_| Err("Render worker panicked. See the saved job log and retry this request.".into()))
        })();
        update(&worker_id, |job| {
            if let Some(start) = job.started_ms.take() { job.elapsed_seconds = (chrono::Utc::now().timestamp_millis() - start).max(0) as f64 / 1000.; }
            job.queue_position = None; job.paused = false; job.active_tasks.clear(); job.eta_seconds = None;
            job.finished_at = chrono::Utc::now().to_rfc3339(); job.process_id = None; match result {
            Ok(path) => { job.logs.push(format!("Completed output: {path}")); job.status = "completed".into(); job.phase = "Verified and ready".into(); job.progress = 100.; job.output = Some(path); }
            Err(error) => { job.logs.push(format!("ERROR: {error}")); job.status = if job.cancelled { "cancelled" } else { "failed" }.into(); job.error = Some(error); }
        }});
        if let Ok(mut admitted) = active().lock() { admitted.remove(&worker_id); }
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
            if ["queued", "running", "paused"].contains(&job.status.as_str()) { job.cancelled = true; job.paused = false; }
        }
        store.keys().cloned().collect()
    };
    for id in &ids { update(id, |job| job.logs.push("Clear all renders requested: stop active work before removing history".into())); }
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    loop {
        let live = jobs().lock().map_err(|e| e.to_string())?.values().any(|job| ["queued", "running", "paused"].contains(&job.status.as_str()) || !job.process_ids.is_empty() || job.process_id.is_some());
        if !live && active().lock().map_err(|e| e.to_string())?.is_empty() { break; }
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
        clip.stabilization.clone(), clip.stabilization_method.clone(), serde_json::to_string(&clip.custom_stabilization).map_err(|e| e.to_string())?, clip.framing.clone(), serde_json::to_string(&clip.replays).map_err(|e| e.to_string())?]))
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
fn prepare_clip(format: &Project, mut clip: Clip, request: &RenderRequest, id: &str, ff: &Path) -> Result<Clip, String> {
    checkpoint(id)?;
    let key = clip_signature(format, &clip, &request.staging_dir)?;
    let mut candidates = Vec::new();
    if let Some(rendered) = &clip.rendered { candidates.push(rendered.clone()); }
    for job in jobs().lock().map_err(|e| e.to_string())?.values() {
        candidates.extend(job.artifacts.iter().filter(|a| a.rendered.signature == key).map(|a| a.rendered.clone()));
    }
    let cached = candidates.into_iter().find(|r| r.signature == key && r.bitrate_mbps == effective_bitrate(format)
        && !r.checksum.is_empty() && compute_md5(Path::new(&r.path)).ok().as_ref() == Some(&r.checksum)
        && rendered_clip_is_valid(ff, Path::new(&r.path), format, r.duration));
    let mut rendered = if let Some(rendered) = cached {
        update(id, |job| { job.cache_hits += 1; job.logs.push(format!("Reused verified clip: {}", clip.chapter)); });
        rendered
    } else {
        if request.assemble_only { return Err(format!("{} needs rendering. Use Create complete video to prepare it automatically.", clip.chapter)); }
        let mut single = format.clone();
        single.clips = vec![clip.clone()];
        single.title.clear(); single.subtitle.clear(); single.title_seconds = 0.; single.music.enabled = false;
        let path = render(single, request.staging_dir.clone(), false, None, None, "clip", false, id)?;
        ClipRender {
            checksum: compute_md5(Path::new(&path)).map_err(|e| e.to_string())?,
            duration: duration(&inspect(ff, Path::new(&path))?)?, path,
            width: format.width, height: format.height, fps: format.fps, bitrate_mbps: effective_bitrate(format),
            revision: clip.revision, signature: key, rendered_at: chrono::Utc::now().to_rfc3339(),
        }
    };
    rendered.revision = clip.revision;
    let artifact = ClipArtifact { clip_id: clip.id.clone(), source_path: clip.path.clone(), rendered: rendered.clone() };
    clip.rendered = Some(rendered);
    update(id, |job| { job.artifacts.retain(|a| a.clip_id != artifact.clip_id); job.artifacts.push(artifact); job.prepared_count += 1; job.progress = 85. * job.prepared_count as f64 / job.preparing_total.max(1) as f64; });
    Ok(clip)
}
fn execute(request: RenderRequest, id: &str) -> Result<String, String> {
    let mut p = request.project.clone();
    if request.kind == "music" { return super::soundtrack::render_soundtrack(&p, id); }
    if request.preview {
        p.music.enabled = false;
        return render(p, request.staging_dir, true, request.preview_start, request.preview_length, "preview", false, id);
    }
    let ff = detect_ffmpeg_capabilities()?.binary;
    p.clips.retain(|clip| clip.include);
    // All nested one-clip renders share the outstanding preparation count;
    // otherwise every child sees one clip and reserves a whole CPU budget.
    p.remaining_clips = Some(Arc::new(AtomicUsize::new(p.clips.len())));
    let policy = studio_hardware::policy(p.width, p.height, &p.performance);
    update(id, |job| { job.preparing_total = p.clips.len(); job.prepared_count = 0; job.worker_error = None; });
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<Result<Clip, String>>>> = Mutex::new(vec![None; p.clips.len()]);
    thread::scope(|scope| {
        let mut workers = Vec::new();
        let ceiling = if p.adaptive_scheduling { studio_hardware::adaptive_ceiling(&p.performance) } else { policy.workers };
        for _ in 0..ceiling.min(p.clips.len()) {
            workers.push(scope.spawn(|| loop {
                let index = next.fetch_add(1, Ordering::Relaxed);
                if index >= p.clips.len() { break; }
                let result = prepare_clip(&p, p.clips[index].clone(), &request, id, &ff);
                if let Err(error) = &result { update(id, |j| { if j.worker_error.is_none() { j.worker_error = Some(error.clone()); } }); }
                results.lock().unwrap()[index] = Some(result);
                p.remaining_clips.as_ref().unwrap().fetch_sub(1, Ordering::Relaxed);
            }));
        }
        for worker in workers { if worker.join().is_err() { update(id, |j| j.worker_error = Some("Clip worker panicked".into())); } }
    });
    update(id, |j| { j.preparing_total = 0; });
    if let Some(error) = jobs().lock().map_err(|e| e.to_string())?.get(id).and_then(|j| j.worker_error.clone()) { return Err(error); }
    p.clips = results.into_inner().map_err(|e| e.to_string())?.into_iter()
        .map(|result| result.ok_or("Clip worker did not return a result")?).collect::<Result<Vec<_>, String>>()?;
    if request.kind == "clip" { return Ok(p.clips[0].rendered.as_ref().unwrap().path.clone()); }
    sequence::verify_prepared(&request.project, &p)?;
    update(id, |job| { job.logs.push(format!("Saved sequence verified: {} prepared clips in requested order", p.clips.len())); });
    update(id, |job| { job.progress_base = 85.; job.progress_scale = 0.15; job.work_progress.clear(); job.work_weights.clear(); });
    render(p, request.staging_dir, false, None, None, "assembly", true, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn project_opening_and_sequence_do_not_invalidate_reusable_clip_identity() {
        let root = std::env::temp_dir().join(format!("studio-identity-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("source.mp4"), b"source identity fixture").unwrap();
        let mut p = super::super::tests::project(&root);
        let root_string = root.to_string_lossy();
        let original = clip_signature(&p, &p.clips[0], &root_string).unwrap();
        let mut second = p.clips[0].clone(); second.id = "second".into(); second.chapter = "Second".into();
        p.clips.push(second);
        p.clips.reverse();
        p.title = "A different final title".into(); p.subtitle = "Final subtitle".into();
        p.title_seconds = 15.; p.opening_title_mode = "overlay".into();
        assert_eq!(clip_signature(&p, &p.clips[1], &root_string).unwrap(), original);
        assert!((project_timeline_seconds(&p) - 7.2).abs() < 0.00001);
        p.opening_title_mode = "none".into();
        assert_eq!(clip_signature(&p, &p.clips[1], &root_string).unwrap(), original);
        p.clips[1].title = "New per-clip text".into();
        assert_ne!(clip_signature(&p, &p.clips[1], &root_string).unwrap(), original);
        p.opening_title_mode = "invalid".into(); assert!(validate(&p).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires FFmpeg; verifies synthetic opening overlay, clean clip reuse, reordering and delivery timings"]
    fn opening_overlay_delivery_smoke() {
        let ff = detect_ffmpeg_capabilities().unwrap().binary;
        let root = std::env::var_os("PHOTOGOGO_STUDIO_TEST_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
            .join(format!("studio-opening-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir_all(&root).unwrap();
        for (filename, colour) in [("source.mp4", "black"), ("second.mp4", "blue")] {
            let generated = command(&ff).args(["-v", "error", "-f", "lavfi", "-i", &format!("color=c={colour}:size=320x180:rate=30"), "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac"]).arg(root.join(filename)).output().unwrap();
            assert!(generated.status.success(), "{}", String::from_utf8_lossy(&generated.stderr));
        }
        let mut p = super::super::tests::project(&root);
        p.fps = 30; p.encoder_preference = "cpu".into(); p.adaptive_scheduling = false;
        p.opening_title_mode = "overlay".into(); p.title_seconds = 30.;
        p.title = "Final title 100%: Rider's = #1".into(); p.subtitle = "Opening only".into();
        p.clips[0].stabilization = "off".into(); p.clips[0].title.clear();
        p.clips[0].replays[0].start = 0.2; p.clips[0].replays[0].end = 0.6;
        let mut second = p.clips[0].clone(); second.id = "two".into(); second.chapter = "Second = #video".into(); second.path = root.join("second.mp4").to_string_lossy().into_owned();
        p.clips.push(second);
        let id = format!("opening-smoke-{}", std::process::id());
        jobs().lock().unwrap().insert(id.clone(), StudioJob { id: id.clone(), kind: "project".into(), status: "running".into(), ..StudioJob::default() });
        let mut request = RenderRequest { project: p.clone(), staging_dir: root.to_string_lossy().into_owned(), preview: false, preview_start: None, preview_length: None, kind: "project".into(), clip_id: None, assemble_only: false };
        let output = execute(request.clone(), &id).unwrap();
        let info = inspect(&ff, Path::new(&output)).unwrap();
        assert_eq!(delivery::frame_count(&info).unwrap(), 168);
        assert_eq!(info["chapters"].as_array().unwrap().len(), 4);
        let manifest: Value = serde_json::from_slice(&fs::read(Path::new(&output).parent().unwrap().join("delivery.json")).unwrap()).unwrap();
        assert_eq!(manifest["manifest"]["chapters"][2]["startFrame"], 84);
        assert_eq!(manifest["sequence"], sequence::recipe(&request.project));
        assert_eq!(manifest["sequenceVerification"]["planned"][0]["clipId"], "one");
        assert_eq!(manifest["sequenceVerification"]["assembled"][1]["clipId"], "two");
        assert_eq!(manifest["sequenceVerification"]["assembled"].as_array().unwrap().len(), 2);
        let description = fs::read_to_string(Path::new(&output).parent().unwrap().join("youtube-description.txt")).unwrap();
        assert!(description.contains("00:02 Second = #video"));
        fn bright_pixels(ff: &Path, path: &Path, second: &str) -> usize {
            let frame = command(ff).args(["-v", "error", "-ss", second, "-i"]).arg(path)
                .args(["-frames:v", "1", "-vf", "crop=1150:240:20:230", "-pix_fmt", "gray", "-f", "rawvideo", "pipe:1"]).output().unwrap();
            assert!(frame.status.success());
            frame.stdout.into_iter().filter(|value| *value > 210).count()
        }
        let saved = jobs().lock().unwrap()[&id].artifacts.clone();
        let first_clean = &saved.iter().find(|a| a.clip_id == "one").unwrap().rendered.path;
        assert_eq!(bright_pixels(&ff, Path::new(first_clean), "0.5"), 0, "Project title leaked into reusable clip");
        assert!(bright_pixels(&ff, Path::new(&output), "0.5") > 1000, "Opening overlay missing");
        assert_eq!(bright_pixels(&ff, Path::new(&output), "2.2"), 0, "Opening title must stop before the first replay");
        assert_eq!(bright_pixels(&ff, Path::new(&output), "3.2"), 0, "Opening title leaked onto second clip");
        request.project.clips.reverse(); request.project.title = "Changed after reordering".into(); request.assemble_only = true;
        let reordered = execute(request.clone(), &id).unwrap();
        let reordered_info = inspect(&ff, Path::new(&reordered)).unwrap();
        let reordered_manifest: Value = serde_json::from_slice(&fs::read(Path::new(&reordered).parent().unwrap().join("delivery.json")).unwrap()).unwrap();
        assert_eq!(reordered_manifest["sequenceVerification"]["planned"][0]["clipId"], "two");
        assert_eq!(reordered_manifest["sequenceVerification"]["assembled"][0]["clipId"], "two");
        assert_eq!(reordered_info["chapters"][0]["tags"]["title"], "Second = #video");
        assert_eq!(reordered_info["chapters"][2]["tags"]["title"], p.clips[0].chapter);
        assert!(bright_pixels(&ff, Path::new(&reordered), "0.5") > 1000);
        for artifact in &jobs().lock().unwrap()[&id].artifacts {
            assert_eq!(artifact.rendered.path, saved.iter().find(|old| old.clip_id == artifact.clip_id).unwrap().rendered.path);
        }
        request.project.opening_title_mode = "card".into(); request.project.title_seconds = 0.5;
        let card = execute(request.clone(), &id).unwrap();
        let card_info = inspect(&ff, Path::new(&card)).unwrap();
        assert_eq!(delivery::frame_count(&card_info).unwrap(), 183);
        assert_eq!(card_info["chapters"][0]["tags"]["title"], "Opening title");
        update(&id, |j| { j.cancelled = true; j.status = "cancelled".into(); });
        assert!(execute(request, &id).is_err());
        assert_eq!(jobs().lock().unwrap()[&id].status, "cancelled");
        jobs().lock().unwrap().remove(&id);
        println!("Verified opening overlay, untouched reusable clips, sequence edits and frame-based publishing metadata: {}", root.display());
    }

    #[test]
    fn queue_reordering_preserves_jobs_and_rejects_active_changes() {
        for (id, position) in [("order-first", 1), ("order-second", 2)] {
            jobs().lock().unwrap().insert(id.into(), StudioJob { id: id.into(), status: "queued".into(), queue_position: Some(position), ..StudioJob::default() });
        }
        reorder("order-second", "up").unwrap();
        assert_eq!(jobs().lock().unwrap()["order-second"].queue_position, Some(1));
        reorder("order-second", "down").unwrap();
        assert_eq!(jobs().lock().unwrap()["order-second"].queue_position, Some(2));
        update("order-first", |job| job.status = "running".into());
        assert!(reorder("order-first", "down").is_err());
        jobs().lock().unwrap().remove("order-first"); jobs().lock().unwrap().remove("order-second");
    }
    #[test]
    #[ignore = "isolated process: sets global checkpoint store"]
    fn clear_jobs_smoke() {
        let root = std::env::temp_dir().join(format!("studio-clear-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir(&root).unwrap();
        STORE.set(root.clone()).unwrap();
        fs::write(root.join("source.mp4"), b"keep source").unwrap();
        let legacy = root.join("video-studio-queue.json");
        let legacy_request = json!({"project": super::super::tests::project(&root), "staging_dir":root.to_string_lossy(), "preview":false, "preview_start":null, "preview_length":null});
        fs::write(&legacy, serde_json::to_vec(&json!({"version":1,"order":["legacy-job"],"jobs":[{"id":"legacy-job","status":"running"}],"requests":{"legacy-job":legacy_request}})).unwrap()).unwrap();
        migrate_legacy_queue(&legacy).unwrap();
        assert!(!legacy.exists());
        assert_eq!(jobs().lock().unwrap()["legacy-job"].status, "interrupted");
        assert_eq!(requests().lock().unwrap()["legacy-job"].kind, "project");
        assert!(root.join("legacy-job.json").exists());
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
        assert_eq!(result.cleared, 5);
        assert!(jobs().lock().unwrap().is_empty());
        assert_ne!(generation(), before);
        assert_eq!(fs::read_to_string(root.join("render-generation.txt")).unwrap(), generation());
        for id in ["active", "done", "waiting", "failed", "legacy-job"] {
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
            stabilization: "off".into(), stabilization_method: quality_method(), custom_stabilization: CustomStabilization::default(), framing: "edgeSafe".into(), reviewed: true, notes: String::new(), replays: vec![Replay { id: "recap".into(), start: 0.2, end: 0.6, speed: 0.5, caption: "Replay".into(), enabled: true }], rendered: None, revision: 0 };
        let p = Project { version: 1, name: "Recovery test".into(), team: String::new(), title: "Opening".into(), subtitle: String::new(), title_seconds: 0.5, opening_title_mode: "card".into(),
            output_dir: root.to_string_lossy().into_owned(), width: 1280, height: 720, fps: 30, clips: vec![clip.clone()], music: BackgroundMusic::default(), assemble_rendered_clips: true, bitrate_mbps: 2,
            default_stabilization: off_preset(), default_stabilization_method: quality_method(), default_custom_stabilization: CustomStabilization::default(), performance: max_performance(), encoder_preference: auto_encoder(),
            adaptive_scheduling: true, remaining_clips: None, source_profile: String::new() };
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
        let mut parallel = request.clone(); parallel.kind = "project".into(); parallel.clip_id = None;
        let mut second = clip.clone(); second.id = "second-clip".into(); second.chapter = "Second".into(); second.title = "Second title".into();
        parallel.project.clips[0].title = "First new title".into();
        parallel.project.clips.push(second);
        let full = execute(parallel, id).unwrap();
        let full_info = inspect(&ff, Path::new(&full)).unwrap();
        assert!(cached_output_matches(&full_info, &p, 4.1));
        assert_eq!(full_info["chapters"][1]["tags"]["title"], "One");
        assert_eq!(full_info["chapters"][3]["tags"]["title"], "Second");
        assert_eq!(jobs().lock().unwrap()[id].artifacts.len(), 2);
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
