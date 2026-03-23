//! Shared utility functions used across command modules.

use chrono::Local;
use md5::{Digest, Md5};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;
#[cfg(target_os = "windows")]
use std::os::windows::ffi::OsStrExt;
#[cfg(target_os = "windows")]
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
#[cfg(target_os = "windows")]
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetFileAttributesW, SetFileAttributesW, SetFileTime, FILE_ATTRIBUTE_HIDDEN,
    FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    FILE_WRITE_ATTRIBUTES, OPEN_EXISTING,
};
#[cfg(target_os = "windows")]
use windows_sys::Win32::System::RestartManager::{
    RmEndSession, RmGetList, RmRegisterResources, RmStartSession, RM_PROCESS_INFO,
    CCH_RM_MAX_APP_NAME, CCH_RM_MAX_SVC_NAME, CCH_RM_SESSION_KEY,
};

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

pub fn rename_path_with_retry(source: &Path, target: &Path) -> Result<(), String> {
    const MAX_ATTEMPTS: usize = 8;
    const BASE_DELAY_MS: u64 = 120;

    let mut last_error: Option<std::io::Error> = None;

    for attempt in 0..MAX_ATTEMPTS {
        match fs::rename(source, target) {
            Ok(_) => return Ok(()),
            Err(err) => {
                let should_retry = matches!(err.kind(), std::io::ErrorKind::PermissionDenied)
                    || err.raw_os_error() == Some(5)
                    || err.raw_os_error() == Some(32);

                last_error = Some(err);

                if !should_retry || attempt + 1 == MAX_ATTEMPTS {
                    break;
                }

                let delay = BASE_DELAY_MS * (attempt as u64 + 1);
                thread::sleep(Duration::from_millis(delay));
            }
        }
    }

    let err = last_error.unwrap_or_else(|| std::io::Error::other("rename failed"));
    let mut message = format!(
        "Failed to rename '{}' to '{}': {}",
        source.display(),
        target.display(),
        err
    );

    #[cfg(target_os = "windows")]
    {
        if matches!(err.kind(), std::io::ErrorKind::PermissionDenied)
            || err.raw_os_error() == Some(5)
            || err.raw_os_error() == Some(32)
        {
            message.push_str(" A file explorer window, terminal working directory, preview pane, or another process is likely holding the source or target folder open.");
        }
    }

    Err(message)
}

pub fn is_retryable_windows_lock_error(err: &std::io::Error) -> bool {
    matches!(err.kind(), std::io::ErrorKind::PermissionDenied)
        || err.raw_os_error() == Some(5)
        || err.raw_os_error() == Some(32)
}

pub fn format_rename_error(source: &Path, target: &Path, err: &std::io::Error) -> String {
    let mut message = format!(
        "Failed to rename '{}' to '{}': {}",
        source.display(),
        target.display(),
        err
    );

    #[cfg(target_os = "windows")]
    {
        if is_retryable_windows_lock_error(err) {
            message.push_str(" A file explorer window, terminal working directory, preview pane, or another process is likely holding the source or target folder open.");
        }
    }

    message
}

#[cfg(target_os = "windows")]
fn widestring_to_string(buffer: &[u16]) -> String {
    let end = buffer.iter().position(|value| *value == 0).unwrap_or(buffer.len());
    String::from_utf16_lossy(&buffer[..end]).trim().to_string()
}

#[cfg(target_os = "windows")]
pub fn describe_locking_processes(paths: &[&Path]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(vec![]);
    }

    let mut session_handle = 0u32;
    let mut session_key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
    let start_result = unsafe { RmStartSession(&mut session_handle, 0, session_key.as_mut_ptr()) };
    if start_result != 0 {
        return Err(format!("Restart Manager session start failed: {}", start_result));
    }

    struct SessionGuard(u32);
    impl Drop for SessionGuard {
        fn drop(&mut self) {
            unsafe {
                RmEndSession(self.0);
            }
        }
    }
    let _guard = SessionGuard(session_handle);

    let wide_paths: Vec<Vec<u16>> = paths
        .iter()
        .map(|path| {
            let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
            wide.push(0);
            wide
        })
        .collect();
    let path_ptrs: Vec<*const u16> = wide_paths.iter().map(|path| path.as_ptr()).collect();

    let register_result = unsafe {
        RmRegisterResources(
            session_handle,
            path_ptrs.len() as u32,
            path_ptrs.as_ptr(),
            0,
            std::ptr::null(),
            0,
            std::ptr::null(),
        )
    };
    if register_result != 0 {
        return Err(format!("Restart Manager resource registration failed: {}", register_result));
    }

    let mut proc_info_needed = 0u32;
    let mut proc_info_count = 0u32;
    let mut reboot_reasons = 0u32;

    let first_result = unsafe {
        RmGetList(
            session_handle,
            &mut proc_info_needed,
            &mut proc_info_count,
            std::ptr::null_mut(),
            &mut reboot_reasons,
        )
    };

    const ERROR_MORE_DATA: u32 = 234;
    if first_result != ERROR_MORE_DATA && first_result != 0 {
        return Err(format!("Restart Manager query failed: {}", first_result));
    }

    if proc_info_needed == 0 {
        return Ok(vec![]);
    }

    let mut processes = vec![unsafe { std::mem::zeroed::<RM_PROCESS_INFO>() }; proc_info_needed as usize];
    proc_info_count = proc_info_needed;

    let second_result = unsafe {
        RmGetList(
            session_handle,
            &mut proc_info_needed,
            &mut proc_info_count,
            processes.as_mut_ptr(),
            &mut reboot_reasons,
        )
    };
    if second_result != 0 {
        return Err(format!("Restart Manager process read failed: {}", second_result));
    }

    let mut descriptions = Vec::new();
    for info in processes.into_iter().take(proc_info_count as usize) {
        let app_name = widestring_to_string(&info.strAppName[..CCH_RM_MAX_APP_NAME as usize + 1]);
        let service_name = widestring_to_string(&info.strServiceShortName[..CCH_RM_MAX_SVC_NAME as usize + 1]);
        let label = if !app_name.is_empty() {
            app_name
        } else if !service_name.is_empty() {
            service_name
        } else {
            "Unknown process".to_string()
        };
        descriptions.push(format!("{} (PID {})", label, info.Process.dwProcessId));
    }

    descriptions.sort();
    descriptions.dedup();
    Ok(descriptions)
}

#[cfg(not(target_os = "windows"))]
pub fn describe_locking_processes(_paths: &[&Path]) -> Result<Vec<String>, String> {
    Ok(vec![])
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

pub fn append_log_line(path: &Path, line: impl AsRef<str>) -> Result<(), String> {
    let _guard = log_write_guard().lock().map_err(|e| e.to_string())?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    use std::io::Write;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;

    file.write_all(line.as_ref().as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| e.to_string())
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

#[cfg(target_os = "windows")]
fn system_time_to_filetime(system_time: std::time::SystemTime) -> Result<FILETIME, String> {
    let duration = system_time
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;

    let windows_epoch_offset_secs = 11_644_473_600u64;
    let intervals_100ns = (duration.as_secs() + windows_epoch_offset_secs) * 10_000_000
        + (duration.subsec_nanos() as u64 / 100);

    Ok(FILETIME {
        dwLowDateTime: intervals_100ns as u32,
        dwHighDateTime: (intervals_100ns >> 32) as u32,
    })
}

#[cfg(target_os = "windows")]
fn set_file_times_from_system_times(
    path: &Path,
    created: std::time::SystemTime,
    accessed: std::time::SystemTime,
    modified: std::time::SystemTime,
) -> Result<(), String> {
    let created_ft = system_time_to_filetime(created)?;
    let accessed_ft = system_time_to_filetime(accessed)?;
    let modified_ft = system_time_to_filetime(modified)?;

    let mut wide_path: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide_path.push(0);

    let handle = unsafe {
        CreateFileW(
            wide_path.as_ptr(),
            FILE_WRITE_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null_mut(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };

    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error().to_string());
    }

    let ok = unsafe { SetFileTime(handle, &created_ft, &accessed_ft, &modified_ft) };
    let close_result = unsafe { CloseHandle(handle) };

    if close_result == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }

    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }

    Ok(())
}

#[cfg(target_os = "windows")]
fn hide_file(path: &Path) -> Result<(), String> {
    let mut wide_path: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide_path.push(0);

    let attrs = unsafe { GetFileAttributesW(wide_path.as_ptr()) };
    if attrs == u32::MAX {
        return Err(std::io::Error::last_os_error().to_string());
    }

    let ok = unsafe { SetFileAttributesW(wide_path.as_ptr(), attrs | FILE_ATTRIBUTE_HIDDEN) };
    if ok == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }

    Ok(())
}

pub fn sync_file_metadata_from(source: &Path, target: &Path, hide_target: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let metadata = fs::metadata(source).map_err(|e| e.to_string())?;
        let created = metadata.created().unwrap_or_else(|_| std::time::SystemTime::now());
        let accessed = metadata.accessed().unwrap_or(created);
        let modified = metadata.modified().unwrap_or(created);

        set_file_times_from_system_times(target, created, accessed, modified)?;

        if hide_target {
            hide_file(target)?;
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (source, target, hide_target);
    }

    Ok(())
}
