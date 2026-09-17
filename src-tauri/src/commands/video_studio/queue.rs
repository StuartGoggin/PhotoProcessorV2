//! Durable recipes, explicit recovery and deterministic queue ordering.
use super::*;
use std::collections::HashSet;
use tauri::Manager;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Request {
    pub project: Project,
    pub staging_dir: String,
    pub preview: bool,
    pub preview_start: Option<f64>,
    pub preview_length: Option<f64>,
}
#[derive(Serialize, Deserialize)]
struct Snapshot {
    version: u32,
    order: Vec<String>,
    requests: HashMap<String, Request>,
    jobs: Vec<StudioJob>,
}
#[derive(Default)]
struct State {
    path: Option<PathBuf>,
    requests: HashMap<String, Request>,
    order: Vec<String>,
    active: HashSet<String>,
    startup_error: Option<String>,
    _lock: Option<fs::File>,
}
fn queue_state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}

fn recover(job: &mut StudioJob) {
    job.active_tasks.clear();
    job.started_ms = None;
    job.eta_seconds = None;
    if ["running", "queued", "paused"].contains(&job.status.as_str()) {
        job.status = "interrupted".into();
        job.paused = true;
        job.recoverable = true;
        job.phase = "App closed before completion. Resume to reuse verified fragments.".into();
    }
}

pub fn init_queue(app: &tauri::AppHandle) {
    let result = (|| -> Result<(), String> {
        let mut state = queue_state().lock().map_err(|e| e.to_string())?;
        if state.path.is_some() {
            return Ok(());
        }
        let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.join("video-studio-queue.lock"))
            .map_err(|e| e.to_string())?;
        fs2::FileExt::try_lock_exclusive(&lock).map_err(|_| {
            "Another app instance owns the Video Studio queue. Close it before queuing work."
                .to_string()
        })?;
        state._lock = Some(lock);
        let path = dir.join("video-studio-queue.json");
        if path.exists() {
            let file = fs::File::open(&path).map_err(|e| e.to_string())?;
            if file.metadata().map_err(|e| e.to_string())?.len() > 25_000_000 {
                return Err(
                    "Video Studio queue file exceeds the recovery limit; the file was preserved."
                        .into(),
                );
            }
            let snapshot: Snapshot = serde_json::from_reader(file).map_err(|e| {
                format!(
                    "Cannot recover {}: {e}. The file was preserved.",
                    path.display()
                )
            })?;
            if snapshot.version != 1 {
                return Err("Unsupported saved render queue".into());
            }
            state.order = snapshot.order;
            state.requests = snapshot.requests;
            let mut store = jobs().lock().map_err(|e| e.to_string())?;
            for mut job in snapshot.jobs {
                recover(&mut job);
                store.insert(job.id.clone(), job);
            }
        }
        state.path = Some(path);
        positions(&state);
        Ok(())
    })();
    if let Err(error) = result {
        if let Ok(mut state) = queue_state().lock() {
            state.startup_error = Some(error.clone());
        }
        if let Ok(mut store) = jobs().lock() {
            store.insert(
                "queue-recovery".into(),
                StudioJob {
                    id: "queue-recovery".into(),
                    name: "Queue recovery needs attention".into(),
                    status: "failed".into(),
                    error: Some(error.clone()),
                    persistence_error: Some(error),
                    ..StudioJob::default()
                },
            );
        }
    }
}

fn positions(state: &State) {
    if let Ok(mut store) = jobs().lock() {
        for job in store.values_mut() {
            job.queue_position = None;
        }
        for (index, id) in state.order.iter().enumerate() {
            if let Some(job) = store.get_mut(id) {
                job.queue_position = Some(index + 1);
            }
        }
    }
}

fn persist(state: &State) -> Result<(), String> {
    let Some(path) = &state.path else {
        return Err("Video Studio queue storage is not initialised".into());
    };
    let mut snapshot = Snapshot {
        version: 1,
        order: state.order.clone(),
        requests: state.requests.clone(),
        jobs: jobs()
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .cloned()
            .collect(),
    };
    for job in &mut snapshot.jobs {
        if let Some(start) = job.started_ms {
            job.elapsed_seconds =
                (chrono::Utc::now().timestamp_millis() - start).max(0) as f64 / 1000.;
        }
    }
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(&snapshot).map_err(|e| e.to_string())?;
    if bytes.len() > 25_000_000 {
        return Err("Queue recovery data exceeds 25 MB; reduce project notes/history before adding more work. The previous snapshot was preserved.".into());
    }
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn save_or_report(state: &State) {
    let error = persist(state).err();
    if let Ok(mut store) = jobs().lock() {
        for job in store.values_mut() {
            job.persistence_error = error.clone();
        }
    }
}

fn enqueue_locked(state: &mut State, request: Request) -> Result<String, String> {
    if let Some(error) = &state.startup_error {
        return Err(error.clone());
    }
    validate(&request.project)?;
    if state.requests.len() >= 100 {
        // Keep pending/recoverable recipes; only retire the oldest completed history.
        let oldest = jobs()
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .filter(|j| {
                ["completed", "cancelled", "failed"].contains(&j.status.as_str())
                    && !state.active.contains(&j.id)
            })
            .map(|j| j.id.clone())
            .min();
        if let Some(id) = oldest {
            state.requests.remove(&id);
            jobs().lock().map_err(|e| e.to_string())?.remove(&id);
        } else {
            return Err(
                "Render queue is full (100 recipes). Finish or cancel queued work first.".into(),
            );
        }
    }
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let id = format!(
        "{}-{}-{}",
        chrono::Utc::now().timestamp_millis(),
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    );
    jobs().lock().map_err(|e| e.to_string())?.insert(
        id.clone(),
        StudioJob {
            id: id.clone(),
            name: request.project.name.clone(),
            status: "queued".into(),
            phase: "Queued".into(),
            recoverable: true,
            ..StudioJob::default()
        },
    );
    state.requests.insert(id.clone(), request);
    state.order.push(id.clone());
    positions(state);
    if let Err(error) = persist(state) {
        state.order.retain(|entry| entry != &id);
        state.requests.remove(&id);
        jobs().lock().map_err(|e| e.to_string())?.remove(&id);
        positions(state);
        return Err(format!(
            "Could not save render recipe; job was not started: {error}"
        ));
    }
    Ok(id)
}

pub(super) fn enqueue(request: Request) -> Result<String, String> {
    let mut state = queue_state().lock().map_err(|e| e.to_string())?;
    let id = enqueue_locked(&mut state, request)?;
    drop(state);
    schedule();
    Ok(id)
}

pub(super) fn control(id: &str, action: &str) -> Result<(), String> {
    let mut state = queue_state().lock().map_err(|e| e.to_string())?;
    control_locked(&mut state, id, action)?;
    drop(state);
    schedule();
    Ok(())
}

fn control_locked(state: &mut State, id: &str, action: &str) -> Result<(), String> {
    let job = jobs()
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned()
        .ok_or("Unknown job")?;
    if matches!(action, "retry" | "retryCpu") || (action == "resume" && job.status == "interrupted")
    {
        if !["failed", "cancelled", "interrupted"].contains(&job.status.as_str())
            || state.active.contains(id)
        {
            return Err("Only finished or interrupted work can be retried".into());
        }
        let mut request = state
            .requests
            .get(id)
            .cloned()
            .ok_or("No saved recipe for this job")?;
        if action == "retryCpu" {
            request.project.encoder_preference = "cpu".into();
        }
        enqueue_locked(state, request)?;
        state.order.retain(|entry| entry != id);
        update(id, |j| {
            j.recoverable = false;
            j.paused = false;
            j.phase = "Retried as a new queue entry".into();
        });
    } else {
        if !["running", "queued", "paused", "interrupted"].contains(&job.status.as_str()) {
            return Err("Job is already finished".into());
        }
        match action {
            "pause" => update(id, |j| {
                j.paused = true;
            }),
            "resume" => update(id, |j| {
                j.paused = false;
                if j.status == "paused" {
                    j.status = "running".into();
                }
            }),
            "cancel" => {
                update(id, |j| {
                    j.cancelled = true;
                    j.paused = false;
                    if !state.active.contains(id) {
                        j.status = "cancelled".into();
                        j.phase = "Cancelled".into();
                    }
                });
                state.order.retain(|entry| entry != id);
            }
            "up" | "down" => {
                if job.status != "queued" {
                    return Err("Only queued work can be reordered".into());
                }
                let pos = state
                    .order
                    .iter()
                    .position(|entry| entry == id)
                    .ok_or("Job is not queued")?;
                let other = if action == "up" {
                    pos.saturating_sub(1)
                } else {
                    (pos + 1).min(state.order.len() - 1)
                };
                state.order.swap(pos, other);
            }
            _ => return Err("Unknown queue action".into()),
        }
    }
    positions(state);
    save_or_report(state);
    Ok(())
}

fn schedule() {
    let Ok(mut state) = queue_state().lock() else {
        return;
    };
    let mut launch = Vec::new();
    {
        let Ok(mut store) = jobs().lock() else {
            return;
        };
        let mut running = state
            .active
            .iter()
            .filter(|id| store.get(*id).map(|j| !j.paused).unwrap_or(false))
            .count();
        for id in state.order.clone() {
            if running >= 2 {
                break;
            }
            let Some(job) = store.get_mut(&id) else {
                continue;
            };
            if job.status != "queued" || job.paused || job.cancelled {
                continue;
            }
            let Some(request) = state.requests.get(&id).cloned() else {
                continue;
            };
            job.status = "running".into();
            job.started_ms = Some(chrono::Utc::now().timestamp_millis());
            job.queue_position = None;
            state.active.insert(id.clone());
            state.order.retain(|entry| entry != &id);
            launch.push((id, request));
            running += 1;
        }
    }
    positions(&state);
    save_or_report(&state);
    drop(state);
    for (id, request) in launch {
        thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                render(
                    request.project,
                    request.staging_dir,
                    request.preview,
                    request.preview_start,
                    request.preview_length,
                    &id,
                )
            }))
            .unwrap_or_else(|_| {
                Err("Render worker stopped unexpectedly; verified fragments are retained.".into())
            });
            update(&id, |job| {
                if let Some(start) = job.started_ms.take() {
                    job.elapsed_seconds =
                        (chrono::Utc::now().timestamp_millis() - start).max(0) as f64 / 1000.;
                }
                job.active_tasks.clear();
                job.eta_seconds = None;
                job.paused = false;
                match result {
                    Ok(output) => {
                        job.output = Some(output);
                        job.status = "completed".into();
                        job.phase = "Verified".into();
                        job.progress = 100.;
                        job.recoverable = false;
                    }
                    Err(error) => {
                        job.status = if job.cancelled { "cancelled" } else { "failed" }.into();
                        job.error = Some(error);
                    }
                }
            });
            if let Ok(mut state) = queue_state().lock() {
                state.active.remove(&id);
                save_or_report(&state);
            }
            schedule();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recipes_are_durable_ordered_and_explicitly_retried() {
        let root = std::env::temp_dir().join(format!(
            "studio-queue-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("queue.json");
        let mut state = State {
            path: Some(path.clone()),
            ..State::default()
        };
        let request = Request {
            project: super::super::tests::project(&root),
            staging_dir: root.to_string_lossy().into_owned(),
            preview: false,
            preview_start: None,
            preview_length: None,
        };
        let first = enqueue_locked(&mut state, request.clone()).unwrap();
        let second = enqueue_locked(&mut state, request.clone()).unwrap();
        control_locked(&mut state, &second, "up").unwrap();
        assert_eq!(state.order, vec![second.clone(), first.clone()]);
        control_locked(&mut state, &second, "pause").unwrap();
        assert!(jobs().lock().unwrap()[&second].paused);
        control_locked(&mut state, &second, "resume").unwrap();
        assert!(!jobs().lock().unwrap()[&second].paused);
        control_locked(&mut state, &first, "cancel").unwrap();
        assert_eq!(jobs().lock().unwrap()[&first].status, "cancelled");
        assert_eq!(state.order, vec![second.clone()]);
        control_locked(&mut state, &first, "retryCpu").unwrap();
        let retry = state.order.last().unwrap().clone();
        assert_ne!(retry, first);
        assert_eq!(state.requests[&retry].project.encoder_preference, "cpu");
        assert!(!jobs().lock().unwrap()[&first].recoverable);
        // Read an actual overwritten Windows snapshot, not merely the in-memory state.
        let mut saved: Snapshot = serde_json::from_reader(fs::File::open(&path).unwrap()).unwrap();
        assert_eq!(saved.order, state.order);
        assert_eq!(saved.requests.len(), 3);
        for job in &mut saved.jobs {
            recover(job);
        }
        assert_eq!(
            saved.jobs.iter().find(|j| j.id == retry).unwrap().status,
            "interrupted"
        );
        assert!(!path.with_extension("json.tmp").exists());
        let mut unavailable = State::default();
        assert!(enqueue_locked(&mut unavailable, request)
            .unwrap_err()
            .contains("job was not started"));
        assert!(unavailable.requests.is_empty() && unavailable.order.is_empty());
        for id in state.requests.keys() {
            jobs().lock().unwrap().remove(id);
        }
        fs::remove_file(path).unwrap();
        fs::remove_dir(root).unwrap();
    }
    #[test]
    fn recovery_never_automatically_restarts_work() {
        for status in ["queued", "running", "paused"] {
            let mut job = StudioJob {
                status: status.into(),
                ..StudioJob::default()
            };
            recover(&mut job);
            assert_eq!(job.status, "interrupted");
            assert!(job.paused && job.recoverable);
        }
        let mut completed = StudioJob {
            status: "completed".into(),
            output: Some("kept.mp4".into()),
            ..StudioJob::default()
        };
        recover(&mut completed);
        assert_eq!(completed.status, "completed");
        assert_eq!(completed.output.as_deref(), Some("kept.mp4"));
    }
}
