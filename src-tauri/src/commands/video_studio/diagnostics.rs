use super::*;
use std::io::{Seek, SeekFrom};

pub(super) fn create_log(id: &str) -> Result<String, String> {
    let folder = recovery::log_root().join(id);
    fs::create_dir_all(&folder).map_err(|e| format!("Cannot create job log: {e}"))?;
    let path = folder.join("job.log");
    fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}
pub(super) fn append(path: &str, line: &str) {
    if path.is_empty() { return; }
    if let Err(error) = fs::OpenOptions::new().append(true).create(true).open(path)
        .and_then(|mut file| writeln!(file, "{line}")) {
        log::error!("Cannot append Studio job log {path}: {error}");
    }
}
fn tail(path: &Path, limit: u64) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(limit))).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(limit).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
#[tauri::command]
pub async fn studio_read_job_log(id: String) -> Result<String, String> {
    let job = jobs().lock().map_err(|e| e.to_string())?.get(&id).cloned().ok_or("Unknown job")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut text = format!("Job {} | {} | {}\nCreated: {}\nStarted: {}\nFinished: {}\nHeartbeat: {}\nLast encoder progress: {}\nProcess: {} {:?}\nError: {}\n\n", job.id, job.name, job.status, job.created_at, job.started_at, job.finished_at, job.heartbeat_at, job.progress_at, job.process_name, job.process_id, job.error.as_deref().unwrap_or("none"));
        if job.log_path.is_empty() {
            text.push_str("Legacy attempt: detailed process logs were not recorded by that app version.\n");
            text.push_str(&job.logs.join("\n"));
            return Ok(text);
        }
        text.push_str(&tail(Path::new(&job.log_path), 64 * 1024)?);
        let folder = Path::new(&job.log_path).parent().ok_or("Invalid log folder")?;
        let mut files: Vec<_> = fs::read_dir(folder).map_err(|e| e.to_string())?.filter_map(Result::ok)
            .map(|e| e.path()).filter(|p| p.file_name().and_then(|s| s.to_str()).map(|s| s.ends_with(".txt")).unwrap_or(false)).collect();
        files.sort();
        for path in files.iter().rev().take(6) {
            text.push_str(&format!("\n\n--- {} (tail) ---\n", path.file_name().unwrap().to_string_lossy()));
            text.push_str(&tail(path, 16 * 1024)?);
        }
        Ok(text)
    }).await.map_err(|e| e.to_string())?
}

// Regular files avoid waiting forever for pipe-reader joins when an encoder
// exits but a descendant still holds an inherited stdout/stderr handle.
pub(super) fn run_process(binary: &Path, args: &[String], dir: &Path, id: &str,
    phase: &str, progress: Option<(f64, f64, f64)>, timeout: Option<Duration>) -> Result<(), String> {
    checkpoint(id)?;
    let existing = jobs().lock().map_err(|e| e.to_string())?.get(id).map(|j| j.log_path.clone()).unwrap_or_default();
    let log_path = if existing.is_empty() { create_log(id)? } else { existing };
    let folder = Path::new(&log_path).parent().ok_or("Missing log folder")?;
    let stamp = chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default();
    let stdout_path = folder.join(format!("{stamp}-stdout.txt"));
    let stderr_path = folder.join(format!("{stamp}-stderr.txt"));
    let stdout = fs::File::create(&stdout_path).map_err(|e| e.to_string())?;
    let stderr = fs::File::create(&stderr_path).map_err(|e| e.to_string())?;
    update(id, |job| {
        job.log_path = log_path.clone(); job.phase = phase.into(); job.process_id = None;
        job.progress_at.clear(); job.heartbeat_at = chrono::Utc::now().to_rfc3339();
        job.process_name = binary.file_name().unwrap_or_default().to_string_lossy().into_owned();
        job.logs.push(format!("Launching {:?}; args={args:?}; working directory={}; stdout={}; stderr={}", binary, dir.display(), stdout_path.display(), stderr_path.display()));
    });
    let mut child = command(binary).args(args).current_dir(dir).stdout(Stdio::from(stdout)).stderr(Stdio::from(stderr))
        .spawn().map_err(|e| format!("{phase}: could not launch {}: {e}", binary.display()))?;
    let pid = child.id();
    update(id, |job| { job.process_id = Some(pid); job.logs.push(format!("Process started: PID {pid}")); });
    let started = std::time::Instant::now();
    let mut heartbeat = std::time::Instant::now();
    let mut report = std::time::Instant::now();
    let mut last_progress = String::new();
    let result = loop {
        let cancelled = jobs().lock().map(|s| s.get(id).map(|j| j.cancelled).unwrap_or(true)).unwrap_or(true);
        if cancelled || timeout.map(|limit| started.elapsed() >= limit).unwrap_or(false) {
            let _ = child.kill(); let _ = child.wait();
            break Err(if cancelled { "Cancelled".to_string() } else { "Process timed out".to_string() });
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                update(id, |job| job.logs.push(format!("PID {pid} exited: {status}; elapsed {:.1}s", started.elapsed().as_secs_f64())));
                break if status.success() { Ok(()) } else { Err(format!("Process failed: {status}")) };
            }
            Err(error) => { let _ = child.kill(); let _ = child.wait(); break Err(error.to_string()); }
            Ok(None) => {},
        }
        if heartbeat.elapsed() >= Duration::from_secs(5) {
            let text = tail(&stdout_path, 8192).unwrap_or_default();
            let value = text.lines().rev().find_map(|line| line.strip_prefix("out_time_us=")).unwrap_or("").to_string();
            let changed = !value.is_empty() && value != last_progress;
            update(id, |job| {
                job.heartbeat_at = chrono::Utc::now().to_rfc3339();
                if changed { job.progress_at = job.heartbeat_at.clone(); }
                if let (Some((seconds, base, span)), Ok(us)) = (progress, value.parse::<f64>()) {
                    let step = (base + span * (us / 1_000_000. / seconds.max(0.01)).clamp(0., 1.)).min(99.);
                    job.progress = job.progress_base + step * if job.progress_scale > 0. { job.progress_scale } else { 1. };
                }
                if report.elapsed() >= Duration::from_secs(30) {
                    let summary: Vec<_> = text.lines().rev().filter(|line| ["frame=", "fps=", "out_time=", "speed="].iter().any(|key| line.starts_with(key))).take(4).collect();
                    job.logs.push(format!("PID {pid} alive; elapsed {:.0}s; {}", started.elapsed().as_secs_f64(), summary.join("; ")));
                }
            });
            last_progress = value;
            if report.elapsed() >= Duration::from_secs(30) { report = std::time::Instant::now(); }
            heartbeat = std::time::Instant::now();
        }
        thread::sleep(Duration::from_millis(200));
    };
    update(id, |job| { job.process_id = None; job.heartbeat_at = chrono::Utc::now().to_rfc3339(); job.phase = format!("{phase}: process exited; checking result"); });
    result.map_err(|error| format!("{phase}: {error}\n{}\nDetailed log: {log_path}", tail(&stderr_path, 8192).unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn log_tail_is_bounded_and_legacy_jobs_can_be_read() {
        let id = format!("log-test-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap());
        let path = create_log(&id).unwrap();
        append(&path, "0123456789");
        assert!(tail(Path::new(&path), 4).unwrap().len() <= 4);
    }
    #[test]
    #[cfg(windows)]
    fn process_exit_is_logged_without_waiting_for_pipe_readers() {
        let id = format!("exit-log-test-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap());
        jobs().lock().unwrap().insert(id.clone(), StudioJob { id: id.clone(), status: "running".into(), ..StudioJob::default() });
        let root = std::env::temp_dir();
        let args = vec!["/D".into(), "/C".into(), "echo diagnostic-stdout & echo diagnostic-stderr 1>&2 & exit /b 7".into()];
        let result = run_process(Path::new("C:/Windows/System32/cmd.exe"), &args, &root, &id, "Test process", None, Some(Duration::from_secs(10)));
        assert!(result.unwrap_err().contains("diagnostic-stderr"));
        let job = jobs().lock().unwrap().get(&id).unwrap().clone();
        assert!(job.process_id.is_none());
        assert!(job.logs.iter().any(|line| line.contains("exited")));
        assert!(tail(Path::new(&job.log_path), 65536).unwrap().contains("PID"));
    }
}
