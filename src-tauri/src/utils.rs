//! Shared utility functions used across command modules.

use chrono::Local;
use md5::{Digest, Md5};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::AppHandle;
use tauri::Manager;

/// Returns the number of logical CPUs available, falling back to 4.
pub fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}

/// Computes the MD5 hash of a file, returning it as a hex string.
pub fn compute_md5(path: &Path) -> anyhow::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Md5::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Encodes raw bytes as a Base64 string (standard alphabet, padded).
pub fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 0x3F) as usize] as char);
        out.push(TABLE[((n >> 12) & 0x3F) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((n >> 6) & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(n & 0x3F) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Returns a destination path that does not already exist.
/// If `base` is free, returns it as-is. Otherwise appends `_1`, `_2`, etc.
pub fn unique_dest(base: PathBuf) -> PathBuf {
    if !base.exists() {
        return base;
    }
    let stem = base
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let ext = base
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let dir = base.parent().unwrap_or(Path::new("."));
    let mut i = 1u32;
    loop {
        let candidate = if ext.is_empty() {
            dir.join(format!("{}_{}", stem, i))
        } else {
            dir.join(format!("{}_{}.{}", stem, i, ext))
        };
        if !candidate.exists() {
            return candidate;
        }
        i += 1;
    }
}

fn log_write_guard() -> &'static Mutex<()> {
    static GUARD: OnceLock<Mutex<()>> = OnceLock::new();
    GUARD.get_or_init(|| Mutex::new(()))
}

pub fn app_log_path(app: &AppHandle) -> PathBuf {
    let mut path = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    path.push("operations.log");
    path
}

pub fn append_app_log(app: &AppHandle, message: impl AsRef<str>) -> Result<(), String> {
    let _guard = log_write_guard().lock().map_err(|e| e.to_string())?;

    let path = app_log_path(app);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let ts = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{}] {}\n", ts, message.as_ref());

    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

pub fn read_app_log(app: &AppHandle) -> Result<String, String> {
    let path = app_log_path(app);
    if !path.exists() {
        return Ok(String::new());
    }
    fs::read_to_string(path).map_err(|e| e.to_string())
}

pub fn clear_app_log(app: &AppHandle) -> Result<(), String> {
    let _guard = log_write_guard().lock().map_err(|e| e.to_string())?;
    let path = app_log_path(app);
    if !path.exists() {
        return Ok(());
    }
    fs::write(path, "").map_err(|e| e.to_string())
}
