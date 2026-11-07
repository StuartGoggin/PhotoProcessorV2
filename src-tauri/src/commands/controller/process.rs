//! Only the exact AJAZZ controller executable in this Windows session may stop.
//! The queried and terminated process share one held handle (no PID-reuse gap).
pub(super) fn permitted_image(path: &str) -> bool {
    path.rsplit(['\\', '/'])
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("Stream Dock AJAZZ.exe"))
}

#[cfg(windows)]
pub(super) fn stop_vendor() -> Result<usize, String> {
    scan(true)
}
#[cfg(windows)]
pub(super) fn vendor_running() -> Result<bool, String> {
    scan(false).map(|n| n > 0)
}
#[cfg(windows)]
fn scan(terminate: bool) -> Result<usize, String> {
    use std::{
        mem::{size_of, zeroed},
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            RemoteDesktop::ProcessIdToSessionId,
            Threading::{
                GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, TerminateProcess,
                WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
                PROCESS_TERMINATE,
            },
        },
    };
    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    unsafe {
        let mut current_session = 0;
        if ProcessIdToSessionId(GetCurrentProcessId(), &mut current_session) == 0 {
            return Err("Cannot identify this Windows session; AJAZZ was left running.".into());
        }
        let snapshot = Handle(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
        if snapshot.0 == INVALID_HANDLE_VALUE {
            return Err("Cannot inspect the AJAZZ process; no application was stopped.".into());
        }
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut present = Process32FirstW(snapshot.0, &mut entry);
        let mut count = 0;
        while present != 0 {
            let length = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..length]);
            if permitted_image(&name) {
                let mut session = 0;
                if ProcessIdToSessionId(entry.th32ProcessID, &mut session) != 0
                    && session == current_session
                {
                    let handle = Handle(OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION
                            | if terminate {
                                PROCESS_TERMINATE | PROCESS_SYNCHRONIZE
                            } else {
                                0
                            },
                        0,
                        entry.th32ProcessID,
                    ));
                    if handle.0 == ptr::null_mut() {
                        return Err("AJAZZ is running but cannot be stopped. Close Stream Dock AJAZZ manually, then Retry controller.".into());
                    }
                    // Repeat after holding the handle so PID reuse cannot cross sessions.
                    if ProcessIdToSessionId(entry.th32ProcessID, &mut session) == 0
                        || session != current_session
                    {
                        present = Process32NextW(snapshot.0, &mut entry);
                        continue;
                    }
                    let mut image = vec![0u16; 32768];
                    let mut size = image.len() as u32;
                    if QueryFullProcessImageNameW(handle.0, 0, image.as_mut_ptr(), &mut size) == 0
                        || !permitted_image(&String::from_utf16_lossy(&image[..size as usize]))
                    {
                        return Err(
                            "Could not verify the AJAZZ executable; it was left untouched.".into(),
                        );
                    }
                    if !terminate {
                        return Ok(1);
                    }
                    if TerminateProcess(handle.0, 0) == 0
                        || WaitForSingleObject(handle.0, 2000) != WAIT_OBJECT_0
                    {
                        return Err("AJAZZ did not stop within two seconds; controller takeover was cancelled. Close it manually and Retry.".into());
                    }
                    count += 1;
                    if count >= 8 {
                        return Err("Stopped eight verified AJAZZ processes; unexpected repeated controller instances need manual inspection.".into());
                    }
                }
            }
            present = Process32NextW(snapshot.0, &mut entry);
        }
        Ok(count)
    }
}
#[cfg(not(windows))]
pub(super) fn stop_vendor() -> Result<usize, String> {
    Ok(0)
}
#[cfg(not(windows))]
pub(super) fn vendor_running() -> Result<bool, String> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_exact_vendor_controller_names_are_allowed() {
        assert!(permitted_image(
            r"C:\Program Files\AJAZZ\Stream Dock AJAZZ.exe"
        ));
        assert!(permitted_image(r"D:\Apps\stream dock ajazz.EXE"));
        for value in [
            "AJAZZ.exe",
            "StreamDock.exe",
            "Not Stream Dock AJAZZ.exe",
            "Stream Dock AJAZZ.exe.bak",
            "photogogo-v2.exe",
            "cmd.exe",
            "Stream Deck.exe",
        ] {
            assert!(!permitted_image(value), "{value}");
        }
    }
}
