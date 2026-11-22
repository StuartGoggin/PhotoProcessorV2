//! Read-only source routing identity. Resolve again at admission and before work:
//! Windows disk numbers are runtime identities, not values to persist in jobs.
//! Different volumes/drive letters may share a disk; unknown topology always
//! takes the conservative, exclusive lane. No dependency on video scheduling.

use std::path::Path;

/// One process may hold multiple independent card readers. The shared gate
/// lets a source with unknown topology exclude every known reader safely.
pub(super) fn try_reader_lease(
    app: &tauri::AppHandle,
    identity: &SourceIdentity,
) -> Result<Option<Vec<std::fs::File>>, String> {
    use tauri::Manager;
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?.join("source-reader-locks");
    try_reader_lease_in(&path, identity)
}

fn try_reader_lease_in(dir: &Path, identity: &SourceIdentity) -> Result<Option<Vec<std::fs::File>>, String> {
    use fs2::FileExt;
    use sha2::{Digest, Sha256};

    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let dir = super::lightbox_trash::safety::root(&dir.to_string_lossy())?;
    let known = identity.certain && !identity.lanes.is_empty();
    let mut files = Vec::new();
    let mut lock = |name: &str, exclusive| -> Result<bool, String> {
        let path = dir.join(name);
        super::lightbox_trash::safety::inspect_optional(&path)?;
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.custom_flags(0x00200000);
        }
        let file = options.open(path).map_err(|e| e.to_string())?;
        super::lightbox_trash::safety::id(&file)?;
        let acquired = if exclusive { FileExt::try_lock_exclusive(&file) } else { FileExt::try_lock_shared(&file) };
        match acquired {
            Ok(()) => { files.push(file); Ok(true) }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock || e.raw_os_error() == Some(33) => Ok(false),
            Err(e) => Err(format!("Could not reserve the card reader: {e}")),
        }
    };
    if !lock("reader-gate.lock", !known)? { return Ok(None); }
    if known {
        for lane in &identity.lanes {
            let name = format!("reader-{}.lock", hex::encode(Sha256::digest(lane.as_bytes())));
            if !lock(&name, true)? { return Ok(None); }
        }
    }
    Ok(Some(files))
}

#[cfg(test)]
#[test]
fn reader_leases_exclude_the_same_physical_lane_and_unknown_sources() {
    let mut nonce = [0u8; 12];
    getrandom::fill(&mut nonce).unwrap();
    let path = std::env::temp_dir().join(format!("photogogo-reader-lock-test-{}", hex::encode(nonce)));
    std::fs::create_dir(&path).unwrap();
    let source = |lane: &str| SourceIdentity {
        lanes: vec![lane.into()], media_id: lane.into(), label: lane.into(), certain: !lane.is_empty(),
    };
    let first = try_reader_lease_in(&path, &source("disk:1")).unwrap().unwrap();
    let other = try_reader_lease_in(&path, &source("disk:2")).unwrap().unwrap();
    assert!(try_reader_lease_in(&path, &source("disk:1")).unwrap().is_none());
    assert!(try_reader_lease_in(&path, &source("")).unwrap().is_none());
    drop((first, other));
    let unknown = try_reader_lease_in(&path, &source("")).unwrap().unwrap();
    assert!(try_reader_lease_in(&path, &source("disk:1")).unwrap().is_none());
    drop(unknown);
    for entry in std::fs::read_dir(&path).unwrap().flatten() {
        let _ = std::fs::remove_file(entry.path());
    }
    let _ = std::fs::remove_dir(path);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SourceIdentity {
    /// Sorted, deduplicated Windows disk keys; empty when topology is unknown.
    pub lanes: Vec<String>,
    /// Mounted volume GUID + filesystem serial (Unix filesystem device number),
    /// separate from its reader/disk.
    /// Fallback identities are best effort and are never evidence of isolation.
    pub media_id: String,
    pub label: String,
    pub certain: bool,
}

impl SourceIdentity {
    pub fn conflicts(&self, other: &Self) -> bool {
        !self.certain
            || !other.certain
            || self.lanes.is_empty()
            || other.lanes.is_empty()
            || self.lanes.iter().any(|lane| other.lanes.contains(lane))
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSource {
    path: String,
    label: String,
    kind: &'static str,
    capacity_bytes: Option<u64>,
}

pub(super) fn archive_sources() -> Result<Vec<ArchiveSource>, String> {
    #[cfg(windows)]
    { windows::archive_sources() }
    #[cfg(not(windows))]
    { Ok(Vec::new()) }
}

/// Resolves the existing target (including junctions), never just its drive
/// letter. A missing/inaccessible source is an error; unsupported topology is
/// a valid but conservative identity. Does not enumerate or read source files.
/// Calls may block on the OS/storage driver, so invoke on an import worker.
pub fn resolve(path: &Path) -> Result<SourceIdentity, String> {
    #[cfg(windows)]
    {
        windows::resolve(path)
    }
    #[cfg(not(windows))]
    {
        let canonical = std::fs::canonicalize(path)
            .map_err(|e| format!("Import source is unavailable: {e}"))?;
        // A filesystem identity, not a file/directory identity: callers validate
        // each child against the selected source root. Unix st_dev does not prove
        // separate physical disks (partitions/RAID), so admission remains serial.
        #[cfg(unix)]
        let media_id = {
            use std::os::unix::fs::MetadataExt;
            let metadata = std::fs::metadata(&canonical)
                .map_err(|e| format!("Import source is unavailable: {e}"))?;
            format!("unix-volume:{}", metadata.dev())
        };
        // Other platforms have no mounted-media proof; do not invent independence
        // or make a directory's identity differ from all of its children.
        #[cfg(not(unix))]
        let media_id = {
            let _ = canonical;
            "unknown-volume".to_string()
        };
        Ok(SourceIdentity {
            lanes: Vec::new(),
            media_id,
            label: "Source device (conservative routing)".into(),
            certain: false,
        })
    }
}

#[cfg(windows)]
mod windows {
    use super::{ArchiveSource, SourceIdentity};
    use std::{ffi::c_void, mem, os::windows::ffi::OsStrExt, path::Path, ptr};
    use windows_sys::Win32::Storage::FileSystem::{BusTypeMmc, BusTypeSd, BusTypeUsb, GetDriveTypeW, GetLogicalDrives};

    // FILE_ANY_ACCESS metadata queries; no GENERIC_READ/WRITE or disk mutation.
    // https://learn.microsoft.com/windows/win32/api/winioctl/ni-winioctl-ioctl_volume_get_volume_disk_extents
    // https://learn.microsoft.com/windows/win32/api/winioctl/ni-winioctl-ioctl_storage_get_device_number
    const IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS: u32 = 0x0056_0000;
    const IOCTL_STORAGE_GET_DEVICE_NUMBER: u32 = 0x002d_1080;
    const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x002d_1400;
    const FILE_DEVICE_DISK: u32 = 7;
    const FILE_SHARE_ALL: u32 = 1 | 2 | 4;
    const OPEN_EXISTING: u32 = 3;
    const MAX_EXTENTS: usize = 256;
    const MAX_PATH_UNITS: usize = 32_768;
    type Handle = *mut c_void;

    #[link(name = "kernel32")]
    extern "system" {
        fn GetVolumePathNameW(path: *const u16, root: *mut u16, len: u32) -> i32;
        fn GetVolumeNameForVolumeMountPointW(root: *const u16, name: *mut u16, len: u32) -> i32;
        fn GetVolumeInformationW(
            root: *const u16,
            label: *mut u16,
            label_len: u32,
            serial: *mut u32,
            component_len: *mut u32,
            flags: *mut u32,
            filesystem: *mut u16,
            filesystem_len: u32,
        ) -> i32;
        fn CreateFileW(
            path: *const u16,
            access: u32,
            share: u32,
            security: *const c_void,
            disposition: u32,
            flags: u32,
            template: Handle,
        ) -> Handle;
        fn DeviceIoControl(
            handle: Handle,
            code: u32,
            input: *const c_void,
            input_len: u32,
            output: *mut c_void,
            output_len: u32,
            returned: *mut u32,
            overlapped: *mut c_void,
        ) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
        fn GetThreadErrorMode() -> u32;
        fn SetThreadErrorMode(mode: u32, previous: *mut u32) -> i32;
    }

    struct VolumeHandle(Handle);
    impl Drop for VolumeHandle {
        fn drop(&mut self) {
            // SAFETY: only successfully opened, owned handles enter this type.
            unsafe { CloseHandle(self.0) };
        }
    }

    // A removed card must return an error, never display an insert-media dialog.
    // The guard affects only this synchronous worker and restores its old mode.
    struct ErrorMode(u32);
    impl ErrorMode {
        fn enter() -> Result<Self, String> {
            // SAFETY: thread-local API; no caller memory is retained by Windows.
            unsafe {
                let old = GetThreadErrorMode();
                if SetThreadErrorMode(old | 1, ptr::null_mut()) == 0 {
                    return Err(last_error("Cannot suppress removed-media dialogs"));
                }
                Ok(Self(old))
            }
        }
    }
    impl Drop for ErrorMode {
        fn drop(&mut self) {
            unsafe { SetThreadErrorMode(self.0, ptr::null_mut()) };
        }
    }

    #[derive(Clone, Copy, Default)]
    #[repr(C)]
    struct DiskExtent {
        disk_number: u32,
        starting_offset: i64,
        extent_length: i64,
    }

    #[repr(C)]
    struct VolumeExtents {
        count: u32,
        extents: [DiskExtent; MAX_EXTENTS],
    }

    #[derive(Default)]
    #[repr(C)]
    struct StorageDeviceNumber {
        device_type: u32,
        device_number: u32,
        partition_number: u32,
    }

    fn last_error(context: &str) -> String {
        format!("{context}: {}", std::io::Error::last_os_error())
    }

    fn wide(value: &std::ffi::OsStr) -> Result<Vec<u16>, String> {
        let mut value: Vec<u16> = value.encode_wide().collect();
        if value.contains(&0) || value.len() >= MAX_PATH_UNITS {
            return Err("Import source path is invalid or too long".into());
        }
        value.push(0);
        Ok(value)
    }

    fn text(buffer: &[u16]) -> String {
        let end = buffer.iter().position(|&v| v == 0).unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..end])
    }

    fn volume_guid(root: &[u16]) -> Option<String> {
        let mut guid = [0u16; 64];
        // SAFETY: root is NUL-terminated and guid is writable for the given size.
        let ok = unsafe {
            GetVolumeNameForVolumeMountPointW(root.as_ptr(), guid.as_mut_ptr(), guid.len() as u32)
        };
        (ok != 0).then(|| text(&guid).to_ascii_lowercase())
    }

    fn volume_info(root: &[u16]) -> Result<(u32, String), String> {
        let mut label = [0u16; 261];
        let mut serial = 0;
        // SAFETY: buffers are sized, optional unused outputs are null, root is
        // NUL-terminated. This queries metadata only and does not open files.
        let ok = unsafe {
            GetVolumeInformationW(
                root.as_ptr(),
                label.as_mut_ptr(),
                label.len() as u32,
                &mut serial,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                0,
            )
        };
        if ok == 0 {
            return Err(last_error("Import source volume is unavailable"));
        }
        Ok((serial, text(&label)))
    }

    fn open_device(path: &str) -> Option<VolumeHandle> {
        let path = wide(std::ffi::OsStr::new(path)).ok()?;
        // Zero access permits metadata queries without requesting data access.
        let raw = unsafe {
            CreateFileW(
                path.as_ptr(),
                0,
                FILE_SHARE_ALL,
                ptr::null(),
                OPEN_EXISTING,
                0,
                ptr::null_mut(),
            )
        };
        (!raw.is_null() && raw as isize != -1).then(|| VolumeHandle(raw))
    }

    fn lanes(guid: &str) -> Vec<String> {
        // CreateFile on a volume must omit its trailing slash.
        let Some(handle) = open_device(guid.trim_end_matches('\\')) else {
            return Vec::new();
        };
        let mut extents = VolumeExtents {
            count: 0,
            extents: [DiskExtent::default(); MAX_EXTENTS],
        };
        let mut returned = 0;
        // SAFETY: repr(C) mirrors VOLUME_DISK_EXTENTS; output has bounded storage
        // for 256 extents. Never trust a driver-supplied count or short response.
        let ok = unsafe {
            DeviceIoControl(
                handle.0,
                IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS,
                ptr::null(),
                0,
                &mut extents as *mut _ as *mut c_void,
                mem::size_of::<VolumeExtents>() as u32,
                &mut returned,
                ptr::null_mut(),
            )
        };
        if ok != 0 {
            return extent_lanes(&extents, returned);
        }
        let error = std::io::Error::last_os_error().raw_os_error();
        // A partial/oversized multi-disk answer must NOT fall back to one disk.
        // Only unsupported query errors permit the older device-number query.
        if !matches!(error, Some(1 | 50 | 87)) || extents.count > 0 {
            return Vec::new();
        }
        let mut device = StorageDeviceNumber::default();
        let ok = unsafe {
            DeviceIoControl(
                handle.0,
                IOCTL_STORAGE_GET_DEVICE_NUMBER,
                ptr::null(),
                0,
                &mut device as *mut _ as *mut c_void,
                mem::size_of::<StorageDeviceNumber>() as u32,
                &mut returned,
                ptr::null_mut(),
            )
        };
        if ok != 0
            && returned as usize >= mem::size_of::<StorageDeviceNumber>()
            && device.device_type == FILE_DEVICE_DISK
            && device.device_number != u32::MAX
        {
            vec![format!("disk:{}", device.device_number)]
        } else {
            Vec::new()
        }
    }

    fn extent_lanes(extents: &VolumeExtents, returned: u32) -> Vec<String> {
        let count = extents.count as usize;
        if count == 0 || count > MAX_EXTENTS {
            return Vec::new();
        }
        let required =
            mem::offset_of!(VolumeExtents, extents) + count * mem::size_of::<DiskExtent>();
        if (returned as usize) < required {
            return Vec::new();
        }
        let mut lanes = Vec::with_capacity(count);
        for extent in &extents.extents[..count] {
            if extent.disk_number == u32::MAX
                || extent.extent_length <= 0
                || extent.starting_offset < 0
            {
                return Vec::new();
            }
            lanes.push(format!("disk:{}", extent.disk_number));
        }
        lanes.sort_unstable();
        lanes.dedup();
        lanes
    }

    fn storage_bus(device: &str) -> Option<u32> {
        let handle = open_device(device)?;
        // STORAGE_PROPERTY_QUERY for StorageDeviceProperty and PropertyStandardQuery.
        let query = [0u32; 3];
        // Aligned storage for STORAGE_DEVICE_DESCRIPTOR. The fixed header's BusType
        // is at byte 28. We do not read any variable-length device identifiers.
        let mut descriptor = [0u32; 256];
        let mut returned = 0;
        let ok = unsafe {
            DeviceIoControl(
                handle.0, IOCTL_STORAGE_QUERY_PROPERTY, query.as_ptr().cast(),
                mem::size_of_val(&query) as u32, descriptor.as_mut_ptr().cast(),
                mem::size_of_val(&descriptor) as u32, &mut returned, ptr::null_mut(),
            )
        };
        (ok != 0 && returned >= 36 && descriptor[0] >= 36 && descriptor[1] >= 36)
            .then_some(descriptor[7])
            .filter(|&bus| bus != 0)
    }

    fn archive_source_kind(removable: bool, bus: Option<u32>) -> Option<&'static str> {
        if bus == Some(BusTypeSd as u32) {
            return Some("sd");
        }
        removable.then(|| match bus {
            Some(bus) if bus == BusTypeUsb as u32 => "usb",
            Some(bus) if bus == BusTypeMmc as u32 => "mmc",
            _ => "removable",
        })
    }

    pub(super) fn archive_sources() -> Result<Vec<ArchiveSource>, String> {
        let _error_mode = ErrorMode::enter()?;
        let mask = unsafe { GetLogicalDrives() };
        if mask == 0 {
            return Err(last_error("Cannot list mounted drives"));
        }
        let system_drive = std::env::var("SystemDrive").unwrap_or_default();
        let mut sources = Vec::new();
        for index in 0..26 {
            if mask & (1 << index) == 0 {
                continue;
            }
            let drive = format!("{}:", char::from(b'A' + index));
            if drive.eq_ignore_ascii_case(&system_drive) {
                continue;
            }
            let path = format!("{drive}\\");
            let wide_root = wide(std::ffi::OsStr::new(&path))?;
            let drive_type = unsafe { GetDriveTypeW(wide_root.as_ptr()) };
            if !matches!(drive_type, 2 | 3) {
                continue;
            }
            // Unmounted reader slots have no usable volume information.
            let Ok(identity) = resolve(Path::new(&path)) else { continue };
            let bus = match identity.lanes.as_slice() {
                [lane] => lane.strip_prefix("disk:").and_then(|number| storage_bus(&format!(r"\\.\PhysicalDrive{number}"))),
                _ => None,
            }.or_else(|| storage_bus(&format!(r"\\.\{drive}")));
            let Some(kind) = archive_source_kind(drive_type == 2, bus) else { continue };
            let capacity_bytes = fs2::total_space(Path::new(&path)).ok();
            sources.push(ArchiveSource { path, label: identity.label, kind, capacity_bytes });
        }
        sources.sort_by_key(|source| source.kind != "sd");
        Ok(sources)
    }

    pub(super) fn resolve(path: &Path) -> Result<SourceIdentity, String> {
        let _error_mode = ErrorMode::enter()?;
        let canonical = std::fs::canonicalize(path)
            .map_err(|e| format!("Import source is unavailable: {e}"))?;
        let source = wide(canonical.as_os_str())?;
        let mut root = vec![0u16; MAX_PATH_UNITS];
        let ok =
            unsafe { GetVolumePathNameW(source.as_ptr(), root.as_mut_ptr(), root.len() as u32) };
        if ok == 0 {
            return Err(last_error("Cannot resolve import source volume"));
        }
        let root_text = text(&root);
        let guid = volume_guid(&root);
        let (serial, volume_label) = volume_info(&root)?;
        let lanes = guid.as_deref().map(lanes).unwrap_or_default();

        // Catch removal/replacement during the metadata queries. Callers must
        // still revalidate at admission/between files; this is not a media lock.
        let after = std::fs::canonicalize(path)
            .map_err(|e| format!("Import source became unavailable: {e}"))?;
        let (after_serial, _) = volume_info(&root)?;
        if canonical != after || serial != after_serial || guid != volume_guid(&root) {
            return Err("Import source media changed while identifying its device".into());
        }
        let display_root = root_text.trim_start_matches("\\\\?\\");
        let label = if volume_label.is_empty() {
            display_root.to_string()
        } else {
            format!("{display_root} ({volume_label})")
        };
        Ok(SourceIdentity {
            certain: !lanes.is_empty(),
            lanes,
            media_id: format!(
                "{}:{serial:08x}",
                guid.unwrap_or_else(|| root_text.to_ascii_lowercase())
            ),
            label,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn only_an_sd_bus_confirms_an_sd_card() {
            assert_eq!(archive_source_kind(false, Some(BusTypeSd as u32)), Some("sd"));
            assert_eq!(archive_source_kind(true, Some(BusTypeUsb as u32)), Some("usb"));
            assert_eq!(archive_source_kind(true, Some(BusTypeMmc as u32)), Some("mmc"));
            assert_eq!(archive_source_kind(true, None), Some("removable"));
            assert_eq!(archive_source_kind(false, Some(BusTypeMmc as u32)), None);
            assert_eq!(archive_source_kind(false, None), None);
        }

        #[test]
        fn extents_share_physical_disks_and_reject_partial_or_unbounded_data() {
            let mut value = VolumeExtents {
                count: 3,
                extents: [DiskExtent::default(); MAX_EXTENTS],
            };
            for (i, disk) in [2, 0, 2].iter().enumerate() {
                value.extents[i] = DiskExtent {
                    disk_number: *disk,
                    starting_offset: 0,
                    extent_length: 4096,
                };
            }
            let bytes =
                (mem::offset_of!(VolumeExtents, extents) + 3 * mem::size_of::<DiskExtent>()) as u32;
            assert_eq!(extent_lanes(&value, bytes), vec!["disk:0", "disk:2"]);
            assert!(extent_lanes(&value, bytes - 1).is_empty());
            value.count = u32::MAX;
            assert!(extent_lanes(&value, u32::MAX).is_empty());
            value.count = 0;
            assert!(extent_lanes(&value, bytes).is_empty());
            value.count = 1;
            value.extents[0].extent_length = -1;
            assert!(extent_lanes(&value, bytes).is_empty());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(lanes: &[&str], media: &str) -> SourceIdentity {
        SourceIdentity {
            lanes: lanes.iter().map(|lane| lane.to_string()).collect(),
            media_id: media.into(),
            label: media.into(),
            certain: true,
        }
    }

    #[test]
    fn different_cards_can_overlap_but_partitions_on_one_disk_cannot() {
        let a = source(&["disk:1"], "volume-a");
        let a_partition = source(&["disk:1"], "volume-a-other-partition");
        let b = source(&["disk:2"], "volume-b");
        assert!(a.conflicts(&a_partition));
        assert!(!a.conflicts(&b));
        assert!(!b.conflicts(&a));
    }

    #[test]
    fn every_extent_of_spanned_volume_is_reserved() {
        let multi = source(&["disk:1", "disk:2"], "span");
        assert!(multi.conflicts(&source(&["disk:2"], "card")));
        assert!(!multi.conflicts(&source(&["disk:3"], "card")));
    }

    #[test]
    fn unknown_and_empty_identities_are_exclusive_in_both_directions() {
        let known = source(&["disk:1"], "known");
        let mut unknown = source(&["disk:2"], "unknown");
        unknown.certain = false;
        let empty = source(&[], "empty");
        for unresolved in [&unknown, &empty] {
            assert!(unresolved.conflicts(&known));
            assert!(known.conflicts(unresolved));
        }
    }

    #[test]
    fn replacing_card_changes_media_but_keeps_reader_reserved() {
        let old = source(&["disk:4"], "guid:11111111");
        let new = source(&["disk:4"], "guid:22222222");
        assert_ne!(old.media_id, new.media_id);
        assert!(old.conflicts(&new));
    }

    #[test]
    fn missing_source_fails_instead_of_inventing_device() {
        let missing = std::env::current_dir().unwrap().join(format!(
            ".missing-import-device-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        assert!(resolve(&missing).is_err());
    }

    #[test]
    fn readonly_local_resolution_is_repeatable_and_folders_share_identity() {
        let current = std::env::current_dir().unwrap();
        let first = resolve(&current).unwrap();
        let again = resolve(&current).unwrap();
        assert_eq!(first, again);
        assert!(!first.media_id.is_empty());
        assert!(!first.label.is_empty());
        let child = std::env::current_exe().unwrap();
        let file = resolve(&child).unwrap();
        let parent = resolve(child.parent().unwrap()).unwrap();
        assert!(file.conflicts(&parent));
        assert_eq!(file.media_id, parent.media_id);
        eprintln!("Read-only local import source resolution: {first:?}");
    }

    #[cfg(not(windows))]
    #[test]
    fn fallback_routes_serially_without_rejecting_every_source_child() {
        let file = std::env::current_exe().unwrap();
        let parent = resolve(file.parent().unwrap()).unwrap();
        let child = resolve(&file).unwrap();
        assert_eq!(parent.media_id, child.media_id);
        assert_eq!(parent.lanes, child.lanes);
        assert!(!parent.certain);
        assert!(!child.certain);
        assert!(parent.conflicts(&child));
        #[cfg(unix)]
        assert!(parent.media_id.starts_with("unix-volume:"));
    }
}
