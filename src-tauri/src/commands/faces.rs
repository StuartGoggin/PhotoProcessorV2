use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use walkdir::WalkDir;

/// Face embedding vector and metadata
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub struct FaceEmbedding {
    pub person_id: String,
    pub person_name: String,
    pub embedding: Vec<f32>,
    pub source_video: String,
    pub timestamp_ms: u64,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceDatabase {
    pub version: u32,
    pub faces: Vec<FaceEmbedding>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonIdentity {
    pub person_id: String,
    pub person_name: String,
    pub distinct_embeddings: usize,
    pub video_count: usize,
    pub last_seen: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoMatch {
    pub video_path: String,
    pub relative_path: String,
    pub match_count: usize,
    pub timestamps: Vec<u64>,
    pub first_match: u64,
    pub last_match: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPersonResult {
    pub person_identity: PersonIdentity,
    pub matches: Vec<VideoMatch>,
}

/// Configuration for face scanning
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct ScanFacesConfig {
    pub archive_dir: String,
    pub frames_per_second: usize,
    pub similarity_threshold: f32,
}

/// Result from face scanning operation
#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFacesResult {
    pub videos_scanned: usize,
    pub faces_detected: usize,
    pub unique_people: usize,
    pub db_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceScanEnvironmentCheck {
    pub ready: bool,
    pub python_command: Option<String>,
    pub script_path: Option<String>,
    pub details: Vec<String>,
    pub error: Option<String>,
}

impl FaceDatabase {
    pub fn new() -> Self {
        Self {
            version: 1,
            faces: Vec::new(),
            updated_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        }
    }

    pub fn load(db_path: &Path) -> Result<Self, String> {
        if !db_path.exists() {
            return Ok(Self::new());
        }

        let contents = fs::read_to_string(db_path)
            .map_err(|e| format!("Failed to read face database: {}", e))?;
        
        serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse face database: {}", e))
    }

    pub fn save(&self, db_path: &Path) -> Result<(), String> {
        fs::create_dir_all(db_path.parent().unwrap_or_else(|| Path::new(".")))
            .map_err(|e| format!("Failed to create database directory: {}", e))?;

        let contents = serde_json::to_string_pretty(self)
            .map_err(|e| format!("Failed to serialize face database: {}", e))?;

        fs::write(db_path, contents)
            .map_err(|e| format!("Failed to write face database: {}", e))
    }

    pub fn get_people(&self) -> Vec<PersonIdentity> {
        let mut people_map: HashMap<String, (String, HashSet<String>, u64)> = HashMap::new();

        for face in &self.faces {
            let entry = people_map
                .entry(face.person_id.clone())
                .or_insert_with(|| (face.person_name.clone(), HashSet::new(), 0));
            
            entry.1.insert(face.source_video.clone());
            entry.2 = entry.2.max(face.timestamp_ms);
        }

        people_map
            .into_iter()
            .map(|(person_id, (person_name, videos, last_seen_ms))| {
                let pid_copy = person_id.clone();
                PersonIdentity {
                    person_id,
                    person_name,
                    distinct_embeddings: self.faces.iter()
                        .filter(|f| f.person_id == pid_copy)
                        .count(),
                    video_count: videos.len(),
                    last_seen: format_timestamp(last_seen_ms),
                }
            })
            .collect()
    }

    pub fn search_person(&self, person_id: &str, archive_dir: &Path) -> SearchPersonResult {
        let mut video_matches: HashMap<String, Vec<u64>> = HashMap::new();
        let mut person_name = person_id.to_string();

        for face in &self.faces {
            if face.person_id == person_id {
                person_name = face.person_name.clone();
                video_matches
                    .entry(face.source_video.clone())
                    .or_insert_with(Vec::new)
                    .push(face.timestamp_ms);
            }
        }

        let video_count = video_matches.len();
        
        let matches = video_matches
            .into_iter()
            .map(|(video_path, mut timestamps)| {
                timestamps.sort_unstable();
                let first_match = timestamps.first().copied().unwrap_or(0);
                let last_match = timestamps.last().copied().unwrap_or(0);

                let relative_path = PathBuf::from(&video_path)
                    .strip_prefix(archive_dir)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|_| video_path.clone());

                VideoMatch {
                    video_path,
                    relative_path,
                    match_count: timestamps.len(),
                    timestamps,
                    first_match,
                    last_match,
                }
            })
            .collect();

        SearchPersonResult {
            person_identity: PersonIdentity {
                person_id: person_id.to_string(),
                person_name,
                distinct_embeddings: self.faces.iter()
                    .filter(|f| f.person_id == person_id)
                    .count(),
                video_count,
                last_seen: self.faces.iter()
                    .filter(|f| f.person_id == person_id)
                    .map(|f| f.timestamp_ms)
                    .max()
                    .map(format_timestamp)
                    .unwrap_or_default(),
            },
            matches,
        }
    }
}

fn format_timestamp(ms: u64) -> String {
    let secs = ms / 1000;
    let mins = secs / 60;
    let hours = mins / 60;
    let days = hours / 24;

    if days > 0 {
        format!("{}d ago", days)
    } else if hours > 0 {
        format!("{}h ago", hours)
    } else if mins > 0 {
        format!("{}m ago", mins)
    } else {
        format!("{}s ago", secs)
    }
}

/// Collect all video files from archive directory
pub fn collect_video_files(archive_dir: &Path, recursive: bool) -> Vec<PathBuf> {
    let mut videos = Vec::new();
    let video_extensions = ["mp4", "mkv", "avi", "mov", "flv", "wmv", "webm"];

    if recursive {
        for entry in WalkDir::new(archive_dir)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if let Some(ext) = path.extension() {
                let ext_lc = ext.to_string_lossy().to_ascii_lowercase();
                if video_extensions.contains(&ext_lc.as_str()) {
                    videos.push(path.to_path_buf());
                }
            }
        }
    } else {
        if let Ok(dir) = fs::read_dir(archive_dir) {
            for entry in dir.filter_map(|e| e.ok()) {
                let path = entry.path();
                if path.is_file() {
                    if let Some(ext) = path.extension() {
                        let ext_lc = ext.to_string_lossy().to_ascii_lowercase();
                        if video_extensions.contains(&ext_lc.as_str()) {
                            videos.push(path);
                        }
                    }
                }
            }
        }
    }

    videos
}

/// Returns the directory where the managed Python venv for face scanning lives.
/// On Windows: %APPDATA%\PhotoGoGoV2\face_scan_env
pub fn managed_face_env_dir() -> PathBuf {
    if let Some(appdata) = std::env::var_os("APPDATA") {
        return PathBuf::from(appdata)
            .join("PhotoGoGoV2")
            .join("face_scan_env");
    }
    #[cfg(unix)]
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("PhotoGoGoV2")
            .join("face_scan_env");
    }
    PathBuf::from("face_scan_env")
}

/// Returns the Python executable inside the managed venv.
pub fn managed_face_env_python() -> PathBuf {
    let venv = managed_face_env_dir();
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python3")
    }
}

fn bundled_face_scan_root() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok();
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    let mut candidates = Vec::new();

    if let Some(cwd) = cwd {
        candidates.push(cwd.join("src-tauri").join("resources").join("face-scan"));
        candidates.push(cwd.join("resources").join("face-scan"));
    }

    if let Some(exe_dir) = exe_dir {
        candidates.push(exe_dir.join("resources").join("face-scan"));
        candidates.push(exe_dir.join("face-scan"));
    }

    candidates.into_iter().find(|p| p.exists())
}

fn bundled_python_runtime() -> Option<PathBuf> {
    let root = bundled_face_scan_root()?;
    let python = if cfg!(windows) {
        root.join("python-runtime").join("python.exe")
    } else {
        root.join("python-runtime").join("bin").join("python3")
    };
    if python.exists() {
        Some(python)
    } else {
        None
    }
}

fn bundled_wheelhouse_dir() -> Option<PathBuf> {
    let root = bundled_face_scan_root()?;
    let wheelhouse = root.join("wheelhouse");
    if wheelhouse.exists() {
        Some(wheelhouse)
    } else {
        None
    }
}

fn is_managed_env_ready(python: &Path) -> bool {
    if !python.exists() {
        return false;
    }
    matches!(
        Command::new(python)
            .args(["-c", "import cv2; import deepface; print('ok')"])
            .output(),
        Ok(o) if o.status.success()
    )
}

fn probe_python_version(python: &Path) -> Option<(u32, u32)> {
    let output = Command::new(python)
        .args([
            "-c",
            "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}')",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut parts = text.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    let minor = parts.next()?.parse::<u32>().ok()?;
    Some((major, minor))
}

fn is_supported_face_scan_python_version(major: u32, minor: u32) -> bool {
    major == 3 && (8..=11).contains(&minor)
}

fn face_scan_packages() -> Vec<&'static str> {
    vec![
        "deepface==0.0.95",
        "opencv-python==4.10.0.84",
        "tensorflow-cpu==2.15.1",
        "tf-keras==2.15.0",
    ]
}

fn common_python_install_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();

    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        roots.push(PathBuf::from(local_app_data));
    }
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        roots.push(PathBuf::from(program_files));
    }
    if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
        roots.push(PathBuf::from(program_files_x86));
    }

    for root in roots {
        out.push(root.join("Programs").join("Python").join("Python311").join("python.exe"));
        out.push(root.join("Programs").join("Python").join("Python310").join("python.exe"));
        out.push(root.join("Programs").join("Python").join("Python39").join("python.exe"));
        out.push(root.join("Programs").join("Python").join("Python38").join("python.exe"));

        out.push(root.join("Python").join("pythoncore-3.11-64").join("python.exe"));
        out.push(root.join("Python").join("pythoncore-3.10-64").join("python.exe"));
        out.push(root.join("Python").join("pythoncore-3.9-64").join("python.exe"));
        out.push(root.join("Python").join("pythoncore-3.8-64").join("python.exe"));
    }

    out.push(PathBuf::from("C:\\Python311\\python.exe"));
    out.push(PathBuf::from("C:\\Python310\\python.exe"));
    out.push(PathBuf::from("C:\\Python39\\python.exe"));
    out.push(PathBuf::from("C:\\Python38\\python.exe"));

    out
}

fn find_system_python() -> Result<PathBuf, String> {
    let mut attempts: Vec<String> = Vec::new();

    let candidates: &[(&str, &[&str])] = &[
        ("py", &["-3.11"]),
        ("py", &["-3.10"]),
        ("py", &["-3.9"]),
        ("py", &["-3.8"]),
        ("py", &["-3"]),
        ("python3", &[]),
        ("python", &[]),
    ];
    for (cmd, prefix_args) in candidates {
        let mut command = Command::new(cmd);
        for arg in *prefix_args {
            command.arg(arg);
        }
        command.arg("-c").arg("import sys; print(sys.executable)");
        match command.output() {
            Ok(output) if output.status.success() => {
                let exe = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if exe.is_empty() {
                    attempts.push(format!("{} {} -> empty executable", cmd, prefix_args.join(" ")));
                    continue;
                }
                let exe_path = PathBuf::from(exe);
                if let Some((major, minor)) = probe_python_version(&exe_path) {
                    if is_supported_face_scan_python_version(major, minor) {
                        return Ok(exe_path);
                    }
                    attempts.push(format!("{} {} -> unsupported {}.{}", cmd, prefix_args.join(" "), major, minor));
                } else {
                    attempts.push(format!("{} {} -> failed to probe version", cmd, prefix_args.join(" ")));
                }
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
                attempts.push(format!("{} {} -> status {} {}", cmd, prefix_args.join(" "), output.status, stderr));
            }
            Err(err) => {
                attempts.push(format!("{} {} -> not runnable: {}", cmd, prefix_args.join(" "), err));
            }
        }
    }

    for candidate in common_python_install_paths() {
        if !candidate.exists() {
            continue;
        }
        if let Some((major, minor)) = probe_python_version(&candidate) {
            if is_supported_face_scan_python_version(major, minor) {
                return Ok(candidate);
            }
            attempts.push(format!("{} -> unsupported {}.{}", candidate.display(), major, minor));
        } else {
            attempts.push(format!("{} -> failed to probe version", candidate.display()));
        }
    }

    let diagnostics = if attempts.is_empty() {
        "No interpreter probes succeeded".to_string()
    } else {
        attempts.join(" | ")
    };

    Err(format!(
        "No supported Python interpreter found. Face scan requires Python 3.8-3.11. Probe diagnostics: {}",
        diagnostics
    ))
}

/// Creates and provisions the managed face-scan venv.
/// If the venv is already ready, returns immediately with a message.
pub fn install_face_scan_deps() -> Result<String, String> {
    let venv_dir = managed_face_env_dir();
    let venv_python = managed_face_env_python();

    if is_managed_env_ready(&venv_python) {
        return Ok(format!(
            "Dependencies already installed at {}",
            venv_dir.display()
        ));
    }

    let source_python = if let Some(bundled_python) = bundled_python_runtime() {
        bundled_python
    } else {
        find_system_python()?
    };

    if let Some((major, minor)) = probe_python_version(&source_python) {
        if !is_supported_face_scan_python_version(major, minor) {
            return Err(format!(
                "Unsupported Python version {}.{} for face scan setup. Use bundled runtime or Python 3.8-3.11.",
                major,
                minor
            ));
        }
    }

    let create_output = Command::new(&source_python)
        .args(["-m", "venv"])
        .arg(&venv_dir)
        .output()
        .map_err(|e| format!("Failed to run 'python -m venv': {}", e))?;

    if !create_output.status.success() {
        let stderr = String::from_utf8_lossy(&create_output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&create_output.stdout).trim().to_string();
        return Err(format!(
            "Failed to create virtual environment: {}{}",
            stderr,
            if stdout.is_empty() { String::new() } else { format!(" / {}", stdout) }
        ));
    }

    // Ensure pip exists in the new environment before install attempts.
    let _ = Command::new(&venv_python)
        .args(["-m", "ensurepip", "--upgrade"])
        .output();

    let wheelhouse = bundled_wheelhouse_dir();
    let mut install_args: Vec<String> = vec![
        "-m".to_string(),
        "pip".to_string(),
        "install".to_string(),
        "--upgrade".to_string(),
    ];

    if let Some(dir) = &wheelhouse {
        install_args.push("--no-index".to_string());
        install_args.push("--find-links".to_string());
        install_args.push(dir.to_string_lossy().into_owned());
    }

    for pkg in face_scan_packages() {
        install_args.push(pkg.to_string());
    }

    let install_output = Command::new(&venv_python)
        .args(&install_args)
        .output()
        .map_err(|e| format!("Failed to run pip install: {}", e))?;

    let install_output = if !install_output.status.success() && wheelhouse.is_some() {
        // Fallback to online install if the local wheelhouse is incomplete.
        Command::new(&venv_python)
            .args([
                "-m",
                "pip",
                "install",
                "--upgrade",
                "deepface==0.0.95",
                "opencv-python==4.10.0.84",
                "tensorflow-cpu==2.15.1",
                "tf-keras==2.15.0",
            ])
            .output()
            .map_err(|e| format!("Failed to run fallback pip install: {}", e))?
    } else {
        install_output
    };

    if !install_output.status.success() {
        let stderr = String::from_utf8_lossy(&install_output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&install_output.stdout).trim().to_string();
        // Remove the incomplete venv so a retry starts fresh.
        let _ = fs::remove_dir_all(&venv_dir);
        return Err(format!(
            "pip install failed: {}{}",
            stderr,
            if stdout.is_empty() { String::new() } else { format!(" / {}", stdout) }
        ));
    }

    if !is_managed_env_ready(&venv_python) {
        return Err(
            "Packages appear installed but the import check failed. Try again or check pip output.".to_string()
        );
    }

    let source_label = if bundled_python_runtime().is_some() {
        "bundled Python runtime"
    } else {
        "system Python runtime"
    };

    let wheelhouse_label = if let Some(dir) = bundled_wheelhouse_dir() {
        format!("wheelhouse={}", dir.display())
    } else {
        "wheelhouse=none".to_string()
    };

    Ok(format!(
        "Face scan dependencies installed successfully at {} (source={} {})",
        venv_dir.display(),
        source_label,
        wheelhouse_label
    ))
}

pub fn ensure_face_scan_environment_ready() -> Result<PathBuf, String> {
    let managed_python = managed_face_env_python();
    if is_managed_env_ready(&managed_python) {
        return Ok(managed_python);
    }

    install_face_scan_deps()?;

    let managed_python = managed_face_env_python();
    if is_managed_env_ready(&managed_python) {
        Ok(managed_python)
    } else {
        Err(format!(
            "Managed face scan environment did not validate after installation: {}",
            managed_python.display()
        ))
    }
}

/// Call Python script to detect faces in videos using deepface
#[allow(dead_code)]
pub fn detect_faces_in_video(
    video_path: &Path,
    frames_per_second: usize,
    similarity_threshold: f32,
) -> Result<Vec<(String, Vec<f32>, u64, f32)>, String> {
    let (faces, _stats) = detect_faces_in_video_with_progress(
        video_path,
        frames_per_second,
        similarity_threshold,
        None,
        None::<fn(usize, usize)>,
    )?;
    Ok(faces)
}

/// Scan a video for faces with optional per-frame progress callbacks.
///
/// `python_exe`: when `Some`, use this pre-verified executable directly and skip
/// all env checks and fallback candidates. Pass the path returned by
/// `ensure_face_scan_environment_ready()` which was resolved once before the
/// parallel scan loop to avoid N concurrent env-check subprocesses on Windows.
pub fn detect_faces_in_video_with_progress<F>(
    video_path: &Path,
    frames_per_second: usize,
    _similarity_threshold: f32,
    python_exe: Option<PathBuf>,
    mut progress_callback: Option<F>,
) -> Result<(Vec<(String, Vec<f32>, u64, f32)>, FaceScanProgressStats), String>
where
    F: FnMut(usize, usize),
{
    let script_path = resolve_scan_script_path()?;
    let fps = frames_per_second.max(1).to_string();

    // When a pre-verified executable is provided (i.e., from the parallel scan
    // loop), use it exclusively. This avoids spawning N concurrent
    // ensure_face_scan_environment_ready() subprocesses inside Rayon threads
    // which can interfere with each other on Windows and cause fallthrough to
    // system Python (which has no cv2).
    let mut python_candidates: Vec<(OsString, Vec<OsString>)> = Vec::new();
    if let Some(verified_exe) = python_exe {
        python_candidates.push((verified_exe.into_os_string(), vec![]));
    } else {
        if let Ok(managed_python) = ensure_face_scan_environment_ready() {
            python_candidates.push((managed_python.into_os_string(), vec![]));
        }
        if let Some(bundled_python) = bundled_python_runtime() {
            python_candidates.push((bundled_python.into_os_string(), vec![]));
        }
        for (cmd, args) in &[
            ("py", vec!["-3.11"]),
            ("py", vec!["-3.10"]),
            ("py", vec!["-3.9"]),
            ("py", vec!["-3.8"]),
            ("py", vec!["-3"]),
            ("python3", vec![]),
            ("python", vec![]),
        ] {
            python_candidates.push((
                OsString::from(cmd),
                args.iter().map(OsString::from).collect(),
            ));
        }
    }

    let mut last_error = String::new();

    for (cmd, prefix_args) in &python_candidates {
        let mut command = Command::new(cmd);
        for arg in prefix_args {
            command.arg(arg);
        }
        command
            .arg(&script_path)
            .arg("--video")
            .arg(video_path)
            .arg("--fps")
            .arg(&fps);

        command.stdout(Stdio::piped()).stderr(Stdio::piped());

        match command.spawn() {
            Ok(mut child) => {
                let stdout = match child.stdout.take() {
                    Some(s) => s,
                    None => {
                        last_error = format!("{} did not provide stdout pipe", cmd.to_string_lossy());
                        continue;
                    }
                };
                let stderr = child.stderr.take();

                let stderr_reader = thread::spawn(move || -> String {
                    if let Some(mut err_stream) = stderr {
                        let mut stderr_text = String::new();
                        let _ = err_stream.read_to_string(&mut stderr_text);
                        stderr_text
                    } else {
                        String::new()
                    }
                });

                let mut full_stdout = String::new();
                let mut result_payload: Option<String> = None;
                let mut latest_sampled_done = 0usize;
                let mut latest_sampled_total = 0usize;

                for line_result in BufReader::new(stdout).lines() {
                    let line = match line_result {
                        Ok(line) => line,
                        Err(_read_err) => break,
                    };

                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        full_stdout.push_str(trimmed);
                        full_stdout.push('\n');
                    }

                    if let Some(payload) = trimmed.strip_prefix("PG_PROGRESS ") {
                        if let Ok(progress) = serde_json::from_str::<PythonProgressOutput>(payload) {
                            latest_sampled_done = progress.sampled_done;
                            latest_sampled_total = progress.sampled_total;
                            if let Some(callback) = progress_callback.as_mut() {
                                callback(progress.sampled_done, progress.sampled_total);
                            }
                        }
                        continue;
                    }

                    if let Some(payload) = trimmed.strip_prefix("PG_RESULT ") {
                        result_payload = Some(payload.to_string());
                    }
                }

                let status = match child.wait() {
                    Ok(status) => status,
                    Err(wait_err) => {
                        last_error = format!(
                            "{} failed waiting for process: {}",
                            cmd.to_string_lossy(),
                            wait_err
                        );
                        continue;
                    }
                };

                let stderr_text = stderr_reader.join().unwrap_or_default();

                if !status.success() {
                    last_error = format!(
                        "{} exited with status {}. stderr='{}' stdout='{}'",
                        cmd.to_string_lossy(),
                        status,
                        stderr_text.trim(),
                        full_stdout.trim()
                    );
                    continue;
                }

                let parsed: PythonScanOutput = if let Some(payload) = result_payload {
                    serde_json::from_str(&payload).map_err(|e| {
                        format!(
                            "Failed to parse {} result payload: {}. Payload: {}",
                            cmd.to_string_lossy(),
                            e,
                            payload.chars().take(300).collect::<String>()
                        )
                    })?
                } else {
                    parse_python_scan_output(&full_stdout).map_err(|e| {
                        format!(
                            "Failed to parse {} JSON output: {}. Raw stdout (first 300 chars): {}",
                            cmd.to_string_lossy(),
                            e,
                            full_stdout.chars().take(300).collect::<String>()
                        )
                    })?
                };

                let faces = parsed
                    .faces
                    .into_iter()
                    .map(|f| (String::new(), f.embedding, f.timestamp_ms, f.confidence))
                    .collect();

                let stats = FaceScanProgressStats {
                    sampled_done: parsed.sampled_done.max(latest_sampled_done),
                    sampled_total: parsed.sampled_total.max(latest_sampled_total),
                };

                if let Some(callback) = progress_callback.as_mut() {
                    callback(stats.sampled_done, stats.sampled_total);
                }

                return Ok((faces, stats));
            }
            Err(e) => {
                last_error = format!("failed to run {}: {}", cmd.to_string_lossy(), e);
            }
        }
    }

    Err(format!(
        "Unable to run face scan Python worker. Last error: {}",
        last_error
    ))
}

fn parse_python_scan_output(stdout: &str) -> Result<PythonScanOutput, String> {
    // Fast path: pure JSON output.
    if let Ok(parsed) = serde_json::from_str::<PythonScanOutput>(stdout.trim()) {
        return Ok(parsed);
    }

    // Fallback: libraries may print logs to stdout; parse the last valid JSON line.
    for line in stdout.lines().rev() {
        let candidate = line.trim();
        if candidate.is_empty() {
            continue;
        }
        if !(candidate.starts_with('{') && candidate.ends_with('}')) {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<PythonScanOutput>(candidate) {
            return Ok(parsed);
        }
    }

    Err("No valid JSON object found in Python stdout".to_string())
}

#[derive(Debug, Deserialize)]
struct PythonFaceDetection {
    embedding: Vec<f32>,
    timestamp_ms: u64,
    confidence: f32,
}

#[derive(Debug, Deserialize)]
struct PythonScanOutput {
    faces: Vec<PythonFaceDetection>,
    #[serde(default)]
    sampled_done: usize,
    #[serde(default)]
    sampled_total: usize,
}

#[derive(Debug, Deserialize)]
struct PythonProgressOutput {
    sampled_done: usize,
    sampled_total: usize,
}

#[derive(Debug, Clone, Copy)]
pub struct FaceScanProgressStats {
    pub sampled_done: usize,
    pub sampled_total: usize,
}

fn resolve_scan_script_path() -> Result<PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|e| format!("Failed to get current dir: {}", e))?;
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()));

    let mut candidates = vec![
        cwd.join("src-tauri").join("scripts").join("face_scan.py"),
        cwd.join("scripts").join("face_scan.py"),
    ];
    if let Some(dir) = exe_dir {
        candidates.push(dir.join("scripts").join("face_scan.py"));
        candidates.push(dir.join("resources").join("scripts").join("face_scan.py"));
    }

    if let Some(root) = bundled_face_scan_root() {
        candidates.push(root.join("scripts").join("face_scan.py"));
    }

    candidates
        .into_iter()
        .find(|p| p.exists())
        .ok_or_else(|| "face_scan.py script not found (checked src-tauri/scripts and scripts)".to_string())
}

pub fn check_scan_environment() -> FaceScanEnvironmentCheck {
    let script_path = resolve_scan_script_path();
    let mut details: Vec<String> = Vec::new();

    let script_path = match script_path {
        Ok(path) => {
            details.push(format!("Found scan script: {}", path.display()));
            Some(path)
        }
        Err(err) => {
            return FaceScanEnvironmentCheck {
                ready: false,
                python_command: None,
                script_path: None,
                details,
                error: Some(err),
            };
        }
    };

    // Build candidate list: managed venv first, then system pythons.
    let managed_python = managed_face_env_python();
    let mut python_candidates: Vec<(OsString, Vec<OsString>)> = Vec::new();
    if managed_python.exists() {
        python_candidates.push((managed_python.clone().into_os_string(), vec![]));
        details.push(format!("Managed face env Python found: {}", managed_python.display()));
    } else {
        details.push(format!("Managed face env Python not found yet: {}", managed_python.display()));
    }

    if let Some(bundled_python) = bundled_python_runtime() {
        details.push(format!("Bundled Python runtime found: {}", bundled_python.display()));
        python_candidates.push((bundled_python.into_os_string(), vec![]));
    } else {
        details.push("Bundled Python runtime not found (face-scan/python-runtime)".to_string());
    }

    if let Some(wheelhouse) = bundled_wheelhouse_dir() {
        details.push(format!("Bundled wheelhouse found: {}", wheelhouse.display()));
    } else {
        details.push("Bundled wheelhouse not found (face-scan/wheelhouse)".to_string());
    }

    if let Some((major, minor)) = probe_python_version(&managed_python) {
        details.push(format!("Managed env Python version: {}.{}", major, minor));
    }

    for (cmd, args) in &[
        ("py", vec!["-3.11"]),
        ("py", vec!["-3.10"]),
        ("py", vec!["-3.9"]),
        ("py", vec!["-3.8"]),
        ("py", vec!["-3"]),
        ("python3", vec![]),
        ("python", vec![]),
    ] {
        python_candidates.push((
            OsString::from(cmd),
            args.iter().map(OsString::from).collect(),
        ));
    }

    let mut selected_python: Option<String> = None;
    let mut last_err = String::new();

    for (cmd, prefix_args) in &python_candidates {
        let mut command = Command::new(cmd);
        for arg in prefix_args {
            command.arg(arg);
        }
        command.arg("-c").arg("import cv2; import deepface; print('ok')");

        match command.output() {
            Ok(output) => {
                if output.status.success() {
                    selected_python = Some(cmd.to_string_lossy().to_string());
                    details.push(format!("Python/deps check passed with '{}'", cmd.to_string_lossy()));
                    break;
                }

                last_err = format!(
                    "{} failed (status={}): {}",
                    cmd.to_string_lossy(),
                    output.status,
                    String::from_utf8_lossy(&output.stderr).trim()
                );
            }
            Err(err) => {
                last_err = format!("{} not runnable: {}", cmd.to_string_lossy(), err);
            }
        }
    }

    if let Some(cmd) = selected_python {
        FaceScanEnvironmentCheck {
            ready: true,
            python_command: Some(cmd),
            script_path: script_path.map(|p| p.to_string_lossy().to_string()),
            details,
            error: None,
        }
    } else {
        FaceScanEnvironmentCheck {
            ready: false,
            python_command: None,
            script_path: script_path.map(|p| p.to_string_lossy().to_string()),
            details,
            error: Some(format!(
                "Python face scan environment is not ready. Click 'Install Dependencies' to set up automatically, or manually: pip install deepface opencv-python. Last error: {}",
                last_err
            )),
        }
    }
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || b.is_empty() || a.len() != b.len() {
        return 0.0;
    }

    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;

    for i in 0..a.len() {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }

    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom <= f32::EPSILON {
        0.0
    } else {
        dot / denom
    }
}

pub fn assign_person_id(face_db: &FaceDatabase, embedding: &[f32], similarity_threshold: f32) -> String {
    let mut best_id: Option<String> = None;
    let mut best_score = -1.0f32;

    for existing in &face_db.faces {
        if existing.embedding.len() != embedding.len() {
            continue;
        }
        let score = cosine_similarity(&existing.embedding, embedding);
        if score > best_score {
            best_score = score;
            best_id = Some(existing.person_id.clone());
        }
    }

    if let Some(id) = best_id {
        if best_score >= similarity_threshold {
            return id;
        }
    }

    generate_person_id(embedding)
}

/// Generate a unique person ID from face embeddings
#[allow(dead_code)]
pub fn generate_person_id(embedding: &[f32]) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    
    let mut hasher = DefaultHasher::new();
    for val in embedding {
        val.to_bits().hash(&mut hasher);
    }
    format!("person_{:x}", hasher.finish())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_face_database_new() {
        let db = FaceDatabase::new();
        assert_eq!(db.version, 1);
        assert!(db.faces.is_empty());
    }
}
