use std::{
    fs::{File, Metadata},
    path::Path,
};

pub(super) const STRICT_VERSION: u8 = 4;
const ORDINARY_FLAGS: u32 = 0x01 | 0x02 | 0x04 | 0x20;

#[cfg(windows)]
pub(super) fn read_current(path: &Path) -> std::io::Result<Metadata> {
    use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
    };
    OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?
        .metadata()
}

#[cfg(not(windows))]
pub(super) fn read_current(path: &Path) -> std::io::Result<Metadata> {
    std::fs::symlink_metadata(path)
}

pub(super) fn supported_flags(flags: u32) -> bool {
    flags & !ORDINARY_FLAGS == 0
}

pub(super) fn describe_flags(flags: u32) -> String {
    let names: Vec<_> = [
        (0x01, "Read-only"),
        (0x02, "Hidden"),
        (0x04, "System"),
        (0x20, "Archive"),
    ]
    .into_iter()
    .filter_map(|(flag, name)| (flags & flag != 0).then_some(name))
    .collect();
    if flags == 0 {
        "none (0x00000000)".into()
    } else if names.is_empty() {
        format!("0x{flags:08X}")
    } else {
        format!("{} (0x{flags:08X})", names.join(", "))
    }
}

#[cfg(windows)]
pub(super) fn flags(metadata: &Metadata) -> Option<u32> {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL,
    };
    // These two bits describe the entry type and the absence of other flags.
    Some(metadata.file_attributes() & !(FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_NORMAL))
}

#[cfg(not(windows))]
pub(super) fn flags(_: &Metadata) -> Option<u32> {
    None
}

#[cfg(windows)]
pub(super) fn write_flags(file: &File, flags: u32) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileBasicInfo, SetFileInformationByHandle, FILE_ATTRIBUTE_NORMAL, FILE_BASIC_INFO,
    };
    let info = FILE_BASIC_INFO {
        CreationTime: 0,
        LastAccessTime: 0,
        LastWriteTime: 0,
        ChangeTime: 0,
        FileAttributes: if flags == 0 {
            FILE_ATTRIBUTE_NORMAL
        } else {
            flags
        },
    };
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle() as _,
            FileBasicInfo,
            &info as *const _ as _,
            std::mem::size_of_val(&info) as u32,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(super) fn write_flags(_: &File, _: u32) -> std::io::Result<()> {
    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
}

#[cfg(windows)]
pub(super) fn remove_readonly(file: &File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        FileDispositionInfoEx, SetFileInformationByHandle, FILE_DISPOSITION_FLAG_DELETE,
        FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE, FILE_DISPOSITION_INFO_EX,
    };
    let info = FILE_DISPOSITION_INFO_EX {
        Flags: FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
    };
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle() as _,
            FileDispositionInfoEx,
            &info as *const _ as _,
            std::mem::size_of_val(&info) as u32,
        )
    } == 0
    {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
pub(super) fn remove_readonly(_: &File) -> std::io::Result<()> {
    Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
}

#[cfg(windows)]
pub(super) fn require_independent_file(file: &File) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(format!(
            "could not read the file link count: {}",
            std::io::Error::last_os_error()
        ));
    }
    if info.nNumberOfLinks != 1 {
        return Err(format!(
            "expected a single independent file link, observed {}",
            info.nNumberOfLinks
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
pub(super) fn require_independent_file(_: &File) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
pub(super) fn may_have_named_streams(tree: &Path) -> bool {
    use std::{
        fs::OpenOptions,
        os::windows::{fs::OpenOptionsExt, io::AsRawHandle},
    };
    use windows_sys::Win32::Storage::FileSystem::{
        GetVolumeInformationByHandleW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    };
    let Ok(root) = OpenOptions::new()
        .access_mode(0x80)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(tree)
    else {
        return true;
    };
    let mut flags = 0;
    let success = unsafe {
        GetVolumeInformationByHandleW(
            root.as_raw_handle() as _,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut flags,
            std::ptr::null_mut(),
            0,
        )
    };
    success == 0 || flags & 0x00040000 != 0 // FILE_NAMED_STREAMS
}

#[cfg(not(windows))]
pub(super) fn may_have_named_streams(_: &Path) -> bool {
    false
}

#[cfg(windows)]
pub(super) fn reject_named_stream(path: &Path, label: &str) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::{
        Foundation::{ERROR_HANDLE_EOF, ERROR_INVALID_PARAMETER, INVALID_HANDLE_VALUE},
        Storage::FileSystem::{
            FindClose, FindFirstStreamW, FindNextStreamW, FindStreamInfoStandard,
            WIN32_FIND_STREAM_DATA,
        },
    };
    let encoded: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut data: WIN32_FIND_STREAM_DATA = unsafe { std::mem::zeroed() };
    let handle = unsafe {
        FindFirstStreamW(
            encoded.as_ptr(),
            FindStreamInfoStandard,
            &mut data as *mut _ as _,
            0,
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = std::io::Error::last_os_error();
        return match error.raw_os_error().map(|value| value as u32) {
            Some(ERROR_HANDLE_EOF | ERROR_INVALID_PARAMETER) => Ok(()),
            _ => Err(format!(
                "Could not check named data streams for {label}: {error}"
            )),
        };
    }
    let end = data
        .cStreamName
        .iter()
        .position(|part| *part == 0)
        .unwrap_or(data.cStreamName.len());
    let first = String::from_utf16_lossy(&data.cStreamName[..end]);
    let result = if first != "::$DATA"
        || unsafe { FindNextStreamW(handle, &mut data as *mut _ as _) } != 0
    {
        Err(format!("Unsupported named data stream at {label}. A complete file-and-folder copy cannot be verified."))
    } else {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error().map(|value| value as u32) == Some(ERROR_HANDLE_EOF) {
            Ok(())
        } else {
            Err(format!(
                "Could not finish checking named data streams for {label}: {error}"
            ))
        }
    };
    unsafe { FindClose(handle) };
    result
}

#[cfg(not(windows))]
pub(super) fn reject_named_stream(_: &Path, _: &str) -> Result<(), String> {
    Ok(())
}
