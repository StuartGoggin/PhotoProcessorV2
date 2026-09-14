//! Verified, restartable file publication. This module deliberately uses only std.
use std::{fs, path::Path};

/// Verify media bytes rather than trusting a cached checksum sidecar.
pub(super) fn matches_content(
    path: &Path,
    size: u64,
    expected_hash: &str,
    hash: impl Fn(&Path) -> Result<String, String>,
) -> Result<bool, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };
    if !metadata.is_file() || metadata.len() != size {
        return Ok(false);
    }
    Ok(hash(path)? == expected_hash)
}

#[cfg(windows)]
fn publish_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // WRITE_THROUGH, deliberately without REPLACE_EXISTING. Same-volume publication.
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 8) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn publish_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::hard_link(source, destination)?;
    fs::remove_file(source)
}

/// Caller must hold the staging import lock for the entire operation.
/// A crash leaves only a .partial file, which the next attempt replaces.
pub(super) fn verified_copy(
    source: &Path,
    destination: &Path,
    expected_size: u64,
    expected_hash: &str,
    hash: impl Fn(&Path) -> Result<String, String>,
) -> Result<u64, String> {
    let parent = destination.parent().ok_or("Destination has no parent")?;
    let work = parent.join(".photogogo-import");
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    // Reject redirected work directories; cleanup must stay in our staging directory.
    if fs::symlink_metadata(&work)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
        || fs::canonicalize(&work).map_err(|e| e.to_string())?
            != fs::canonicalize(parent)
                .map_err(|e| e.to_string())?
                .join(".photogogo-import")
    {
        return Err("Import work directory must not redirect outside its parent".into());
    }
    let name = destination
        .file_name()
        .ok_or("Missing destination filename")?;
    let mut partial_name = name.to_os_string();
    partial_name.push(".partial");
    let partial = work.join(partial_name);
    if partial.exists() {
        fs::remove_file(&partial).map_err(|e| e.to_string())?;
    }
    struct Cleanup(std::path::PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let _cleanup = Cleanup(partial.clone());
    let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&partial)
        .map_err(|e| e.to_string())?;
    let bytes = std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
    output.sync_all().map_err(|e| e.to_string())?;
    drop(output);
    if bytes != expected_size || hash(&partial)? != expected_hash {
        return Err("Copied file failed size/checksum verification; source retained".into());
    }
    publish_new(&partial, destination).map_err(|e| {
        format!("Could not publish verified file (existing files are never replaced): {e}")
    })?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "photogogo-import-test-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn hash(path: &Path) -> Result<String, String> {
        fs::read_to_string(path).map_err(|e| e.to_string())
    }
    #[test]
    fn duplicate_detection_uses_bytes_without_sidecars() {
        let f = Fixture::new();
        let dst = f.0.join("renamed.mp4");
        fs::write(&dst, "complete").unwrap();
        assert!(matches_content(&dst, 8, "complete", hash).unwrap());
        fs::write(f.0.join("renamed.mp4.md5"), "complete").unwrap();
        fs::write(&dst, "modified").unwrap();
        assert!(!matches_content(&dst, 8, "complete", hash).unwrap());
        assert!(matches_content(&dst, 8, "complete", |_| Err("unreadable".into())).is_err());
    }
    #[test]
    fn destination_created_during_verification_is_preserved() {
        let f = Fixture::new();
        let src = f.0.join("source.mp4");
        let dst = f.0.join("video.mp4");
        fs::write(&src, "complete").unwrap();
        assert!(verified_copy(&src, &dst, 8, "complete", |p| {
            fs::write(&dst, "other writer").unwrap();
            hash(p)
        })
        .is_err());
        assert_eq!(fs::read_to_string(dst).unwrap(), "other writer");
    }
    #[test]
    fn successful_copy_preserves_source() {
        let f = Fixture::new();
        let src = f.0.join("source.mp4");
        let dst = f.0.join("video.mp4");
        fs::write(&src, "complete").unwrap();
        assert_eq!(verified_copy(&src, &dst, 8, "complete", hash).unwrap(), 8);
        assert_eq!(fs::read(&src).unwrap(), fs::read(&dst).unwrap());
    }
    #[test]
    fn failed_verification_publishes_nothing() {
        let f = Fixture::new();
        let src = f.0.join("source.mp4");
        let dst = f.0.join("video.mp4");
        fs::write(&src, "wrong").unwrap();
        assert!(verified_copy(&src, &dst, 5, "expected", hash).is_err());
        assert!(!dst.exists());
        assert!(!f.0.join(".photogogo-import/video.mp4.partial").exists());
        assert!(verified_copy(&src, &dst, 100, "wrong", hash).is_err());
        assert!(!dst.exists());
    }
    #[test]
    fn restart_recovers_orphan_without_suffix() {
        let f = Fixture::new();
        let src = f.0.join("source.mp4");
        let dst = f.0.join("video.mp4");
        fs::write(&src, "complete").unwrap();
        fs::create_dir(f.0.join(".photogogo-import")).unwrap();
        fs::write(
            f.0.join(".photogogo-import/video.mp4.partial"),
            "incomplete",
        )
        .unwrap();
        verified_copy(&src, &dst, 8, "complete", hash).unwrap();
        assert_eq!(fs::read_to_string(dst).unwrap(), "complete");
    }
    #[test]
    fn existing_destination_is_never_overwritten() {
        let f = Fixture::new();
        let src = f.0.join("source.mp4");
        let dst = f.0.join("video.mp4");
        fs::write(&src, "complete").unwrap();
        fs::write(&dst, "keep me").unwrap();
        assert!(verified_copy(&src, &dst, 8, "complete", hash).is_err());
        assert_eq!(fs::read_to_string(dst).unwrap(), "keep me");
    }
}
