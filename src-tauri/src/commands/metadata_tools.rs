//! One resolution seam for installed and explicitly selected metadata tools.
use serde::Serialize;
use std::path::{Path, PathBuf};

fn resolve_in(directory: &str, app: Option<&Path>) -> (PathBuf, &'static str) {
    if !directory.trim().is_empty() {
        let base = PathBuf::from(directory.trim());
        return (
            if base.is_file() {
                base
            } else if base.join("exiftool_files/perl.exe").is_file()
                && base.join("exiftool_files/exiftool.pl").is_file()
            {
                base.join("exiftool_files/perl.exe")
            } else {
                base.join(if cfg!(windows) {
                    "exiftool.exe"
                } else {
                    "exiftool"
                })
            },
            "override",
        );
    }
    if let Some(app) = app {
        let source_runtime = app.join("tools/exiftool/exiftool_files/perl.exe");
        if source_runtime.is_file() {
            return (source_runtime, "bundled");
        }
        let bundled = app.join("tools/exiftool/exiftool.exe");
        if bundled.is_file() {
            return (bundled, "bundled");
        }
    }
    (PathBuf::from("exiftool"), "path")
}

pub(super) fn resolve(directory: &str) -> (PathBuf, &'static str) {
    let exe = std::env::current_exe().ok();
    let mut selected = resolve_in(directory, exe.as_deref().and_then(Path::parent));
    // Development and native tests use the same resource tree copied by Tauri.
    // Release applications never search a development checkout.
    #[cfg(debug_assertions)]
    if selected.1 == "path" {
        selected = resolve_in(directory, Some(Path::new(env!("CARGO_MANIFEST_DIR"))));
    }
    if selected.1 == "path" {
        // Preserve explicit PATH compatibility, without Windows' implicit
        // current-directory executable search or relative/empty PATH entries.
        if let Some(path) = std::env::var_os("PATH").and_then(|value| {
            std::env::split_paths(&value)
                .filter(|entry| entry.is_absolute())
                .map(|entry| {
                    entry.join(if cfg!(windows) {
                        "exiftool.exe"
                    } else {
                        "exiftool"
                    })
                })
                .find(|candidate| candidate.is_file())
        }) {
            return (path, "path");
        }
        let missing = exe
            .as_deref()
            .and_then(Path::parent)
            .unwrap_or(Path::new(env!("CARGO_MANIFEST_DIR")))
            .join("tools/exiftool/exiftool_files/perl.exe");
        return (missing, "unavailable");
    }
    if let Ok(path) = std::fs::canonicalize(&selected.0) {
        selected.0 = path;
    }
    selected
}

#[derive(Serialize)]
pub struct MetadataToolStatus {
    ready: bool,
    source: &'static str,
    version: Option<String>,
    path: Option<String>,
    message: String,
}

fn inspect(directory: &str) -> MetadataToolStatus {
    let (path, source) = resolve(directory);
    match run(&path, &["-ver".into()]) {
        Ok(output) => {
            let version = String::from_utf8_lossy(&output).trim().to_string();
            let ready = !version.is_empty() && version.len() <= 32 && version.bytes().all(|b| b.is_ascii_digit() || b == b'.');
            MetadataToolStatus {
                ready, source, version: ready.then_some(version),
                path: Some(path.to_string_lossy().into()),
                message: if ready { "Metadata tool is ready. Original photos remain unchanged during upload preparation." } else { "The selected tool returned an invalid version. Check the ExifTool override or repair the installation." }.into(),
            }
        }
        Err(_) => MetadataToolStatus {
            ready: false, source: if source == "path" { "unavailable" } else { source },
            version: None, path: Some(path.to_string_lossy().into()),
            message: if source == "override" {
                "The custom ExifTool override could not run. Clear it in Settings to use the bundled copy, or select a complete working ExifTool folder."
            } else {
                "ExifTool could not run. Repair the PhotoGoGo installation or select a complete ExifTool folder in Settings. Untouched originals without GPS removal do not require this tool."
            }.into(),
        },
    }
}

pub(super) fn check(directory: &str) -> bool {
    inspect(directory).ready
}

#[cfg(windows)]
struct ToolProcessJob(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
impl ToolProcessJob {
    fn attach(child: &std::process::Child) -> Result<Self, String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::*;
        // The non-inheritable job owns this one invocation, including the
        // portable launcher's Perl child. Closing it also closes inherited pipes.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            return Err("Could not supervise metadata preparation.".into());
        }
        let job = Self(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        };
        if configured == 0
            || unsafe { AssignProcessToJobObject(handle, child.as_raw_handle()) } == 0
        {
            return Err("Could not supervise metadata preparation.".into());
        }
        Ok(job)
    }
}
#[cfg(windows)]
impl Drop for ToolProcessJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[tauri::command]
pub async fn metadata_tool_status(
    app: tauri::AppHandle,
    directory: Option<String>,
) -> Result<MetadataToolStatus, String> {
    let directory = match directory {
        Some(value) => value,
        None => super::settings::load_settings(app)?.exiftool_dir,
    };
    tauri::async_runtime::spawn_blocking(move || inspect(&directory))
        .await
        .map_err(|_| "Metadata check could not complete.".into())
}

pub(super) fn run(tool: &Path, args: &[std::ffi::OsString]) -> Result<Vec<u8>, String> {
    use std::{
        io::{Read, Write},
        process::{Command, Stdio},
        time::{Duration, Instant},
    };
    if !tool.is_file() {
        return Err("The selected metadata executable is missing. Check its override or repair the installation.".into());
    }
    // No alternate interpreter is considered for a missing selected entry point.
    let mut input = Vec::new();
    for argument in args {
        let value = argument
            .to_str()
            .ok_or("Metadata paths must be valid Unicode.")?;
        if value.contains(['\r', '\n', '\0']) {
            return Err("Metadata arguments cannot contain line breaks or nulls.".into());
        }
        input.extend_from_slice(value.as_bytes());
        input.push(b'\n');
    }
    let source_entry = tool
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("perl.exe"));
    if source_entry
        && tool.parent().is_none_or(|parent| {
            !parent.join("exiftool.pl").is_file() || !parent.join("run-exiftool.pl").is_file()
        })
    {
        return Err(
            "The managed metadata script is missing. Repair the PhotoGoGo installation.".into(),
        );
    }
    let runtime = tool.parent().map(|parent| {
        if tool
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("perl.exe"))
            && parent.join("exiftool.pl").is_file()
        {
            parent.to_path_buf()
        } else {
            parent.join("exiftool_files")
        }
    });
    let portable = runtime
        .as_deref()
        .filter(|dir| dir.join("perl.exe").is_file() && dir.join("exiftool.pl").is_file());
    // The upstream ANSI launcher cannot find Perl under a non-ACP installation
    // path. Use its unchanged interpreter/script with relative ASCII module
    // paths; CreateProcessW/current_dir preserve the Unicode installation path.
    let mut command = if let Some(runtime) = portable {
        let mut command = Command::new(runtime.join("perl.exe"));
        command.current_dir(runtime).args([
            "-Ilib",
            if source_entry {
                "run-exiftool.pl"
            } else {
                "exiftool.pl"
            },
        ]);
        command
    } else {
        Command::new(tool)
    };
    command
        .args(["-config", "", "-charset", "filename=UTF8", "-@", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    for (key, _) in std::env::vars_os().filter(|(key, _)| {
        key.to_str()
            .is_some_and(|name| name.to_ascii_uppercase().starts_with("PERL"))
    }) {
        command.env_remove(key);
    }
    for key in ["LC_ALL", "LC_CTYPE", "LANG"] {
        command.env(key, "C");
    }
    if portable.is_none() && tool.is_absolute() {
        if let Some(parent) = tool.parent() {
            command.current_dir(parent);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|_| "ExifTool could not start. Check the metadata tool in Settings.")?;
    #[cfg(windows)]
    let job = match ToolProcessJob::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let mut stdin = child.stdin.take().ok_or("Metadata input unavailable.")?;
    let stdout = child.stdout.take().ok_or("Metadata output unavailable.")?;
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    // Drain concurrently; a full pipe must not turn a bounded result into a hang.
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(65537).read_to_end(&mut bytes);
        (result, bytes)
    });
    let deadline = Instant::now() + Duration::from_secs(20);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    #[cfg(windows)]
    drop(job);
    let written = writer.join().map_err(|_| "Metadata writer failed.")?;
    let (read, output) = reader.join().map_err(|_| "Metadata reader failed.")?;
    if status.is_none() {
        return Err(
            "Metadata preparation timed out. Check the operation result before retrying.".into(),
        );
    }
    written.map_err(|_| "Could not send metadata arguments.")?;
    read.map_err(|_| "Could not read metadata result.")?;
    if output.len() > 65536 {
        return Err("Metadata response exceeds its safety limit.".into());
    }
    if !status.unwrap().success() {
        return Err("ExifTool could not complete the metadata operation.".into());
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn installed_runtime_is_selected_without_path_or_settings() {
        let root = std::env::temp_dir().join(format!("pgg-tool-layout-{}", std::process::id()));
        let bundled = root.join("tools/exiftool/exiftool_files/perl.exe");
        std::fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        std::fs::write(&bundled, b"test layout only").unwrap();
        std::fs::write(
            bundled.parent().unwrap().join("exiftool.pl"),
            b"test layout only",
        )
        .unwrap();
        std::fs::write(
            root.join("tools/exiftool/exiftool.exe"),
            b"obsolete launcher must not win",
        )
        .unwrap();
        let selected = resolve_in("", Some(&root));
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(selected, (bundled, "bundled"));
    }
    #[test]
    fn explicit_broken_override_does_not_fall_back_to_a_different_tool() {
        let selected = resolve_in("missing-custom-folder", Some(Path::new("app")));
        assert_eq!(
            selected,
            (
                PathBuf::from("missing-custom-folder/exiftool.exe"),
                "override"
            )
        );
    }
}
