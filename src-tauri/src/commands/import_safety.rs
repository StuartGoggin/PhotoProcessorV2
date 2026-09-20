//! Verified, restartable file publication. This module deliberately uses only std.
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const COPY_BUFFER_BYTES: usize = 1024 * 1024;

/// A private copy, owned by exactly one import. Dropping it never removes another
/// import's temporary file or a published destination.
#[derive(Debug)]
pub(super) struct StagedCopy {
    path: PathBuf,
    parent: PathBuf,
    bytes: u64,
    verified: Option<fs::File>,
    verified_metadata: Option<fs::Metadata>,
    published: bool,
}

impl StagedCopy {
    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    pub(super) fn bytes(&self) -> u64 {
        self.bytes
    }

    /// Verify the fast destination copy against the hash computed during the
    /// single source read. A failed retry always invalidates prior verification.
    pub(super) fn verify(
        &mut self,
        expected_hash: &str,
        hash: impl Fn(&Path) -> Result<String, String>,
    ) -> Result<(), String> {
        self.verified = None;
        self.verified_metadata = None;
        let mut options = fs::OpenOptions::new();
        options.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Keep destination bytes read-only until publication completes. Allow
            // rename (DELETE sharing), but not any writer, during MoveFileExW.
            options.share_mode(5); // FILE_SHARE_READ | FILE_SHARE_DELETE
        }
        let verified = options.open(&self.path).map_err(|e| e.to_string())?;
        let before = verified.metadata().map_err(|e| e.to_string())?;
        if !before.is_file()
            || before.len() != self.bytes
            || hash(&self.path)? != expected_hash
            || !same_metadata(&before, &verified.metadata().map_err(|e| e.to_string())?)
        {
            return Err("Copied file failed size/checksum verification; source retained".into());
        }
        self.verified = Some(verified);
        self.verified_metadata = Some(before);
        Ok(())
    }

    /// Caller coordinates destination naming and duplicate decisions. Publication
    /// never overwrites an existing file, including one created after verification.
    pub(super) fn publish(&mut self, destination: &Path) -> Result<(), String> {
        if self.verified.is_none() || self.published {
            return Err("Only an unpublished, verified import can be published".into());
        }
        let parent = destination.parent().ok_or("Destination has no parent")?;
        if fs::canonicalize(parent).map_err(|e| e.to_string())? != self.parent {
            return Err("Import must be published into its original destination directory".into());
        }
        let metadata = fs::symlink_metadata(&self.path).map_err(|e| e.to_string())?;
        let verified_metadata = self
            .verified_metadata
            .as_ref()
            .ok_or("Import has not been verified")?;
        if !metadata.is_file()
            || metadata.len() != self.bytes
            || !same_metadata(&metadata, verified_metadata)
        {
            self.verified = None;
            return Err("Verified copy changed before publication; source retained".into());
        }
        publish_new(&self.path, destination).map_err(|e| {
            format!("Could not publish verified file (existing files are never replaced): {e}")
        })?;
        self.published = true;
        self.verified = None;
        Ok(())
    }
}

impl Drop for StagedCopy {
    fn drop(&mut self) {
        self.verified = None;
        if !self.published {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn same_metadata(before: &fs::Metadata, after: &fs::Metadata) -> bool {
    before.len() == after.len()
        && before.modified().ok() == after.modified().ok()
        && before.created().ok() == after.created().ok()
}

fn work_directory(parent: &Path) -> Result<PathBuf, String> {
    let work = parent.join(".photogogo-import");
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    // Reject redirected work directories; cleanup must stay in our own directory.
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
    Ok(work)
}

/// Remove crash leftovers only during creation of an empty import session, after
/// its caller has acquired the exclusive OS staging lock and established that no
/// in-process staged copies are alive. Never call this while a session is active.
/// Legacy partials and anything not matching our private stream format are kept.
pub(super) fn cleanup_abandoned_staged(parent: &Path) -> Result<usize, String> {
    let work = work_directory(parent)?;
    let mut removed = 0;
    for entry in fs::read_dir(work).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(numbers) = name
            .strip_prefix("stream-")
            .and_then(|s| s.strip_suffix(".partial"))
        else {
            continue;
        };
        let parts: Vec<&str> = numbers.split('-').collect();
        if parts.len() != 3
            || !parts
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
        {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if metadata.is_file() && !metadata.file_type().is_symlink() {
            fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
            removed += 1;
        }
    }
    Ok(removed)
}

/// Read the source exactly once using bounded memory. The observer receives each
/// copied chunk for streaming hashing/progress/cancellation, without rereading the
/// source. The caller must hold the OS staging-session lock; this function never
/// sweeps orphan files because other concurrent imports may own them.
pub(super) fn stage_copy(
    source: &Path,
    parent: &Path,
    expected_size: u64,
    mut observe: impl FnMut(&[u8]) -> Result<(), String>,
) -> Result<StagedCopy, String> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let work = work_directory(parent)?;
    let parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // A removable card cannot be written or replaced while its bytes are read.
        options.share_mode(1); // FILE_SHARE_READ
    }
    let mut input = options.open(source).map_err(|e| e.to_string())?;
    let before = input.metadata().map_err(|e| e.to_string())?;
    if !before.is_file() || before.len() != expected_size {
        return Err("Source size changed before copying; source retained".into());
    }
    let (partial, mut output) = loop {
        let name = format!(
            "stream-{}-{}-{}.partial",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let path = work.join(name);
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => break (path, file),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.to_string()),
        }
    };
    let mut staged = StagedCopy {
        path: partial,
        parent,
        bytes: 0,
        verified: None,
        verified_metadata: None,
        published: false,
    };
    let mut buffer = vec![0; COPY_BUFFER_BYTES];
    loop {
        let count = input.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        staged.bytes = staged
            .bytes
            .checked_add(count as u64)
            .ok_or("Source is too large")?;
        if staged.bytes > expected_size {
            return Err("Source size changed while copying; source retained".into());
        }
        output
            .write_all(&buffer[..count])
            .map_err(|e| e.to_string())?;
        observe(&buffer[..count])?;
    }
    let after = input.metadata().map_err(|e| e.to_string())?;
    if staged.bytes != expected_size
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return Err("Source changed while copying; source retained".into());
    }
    output.sync_all().map_err(|e| e.to_string())?;
    drop(output);
    Ok(staged)
}

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
    #[test]
    fn streaming_copy_verifies_destination_and_preserves_source() {
        let f = Fixture::new();
        let src = f.0.join("source.mp4");
        let dst = f.0.join("video.mp4");
        fs::write(&src, "complete").unwrap();
        let mut observed = Vec::new();
        let mut staged = stage_copy(&src, &f.0, 8, |chunk| {
            observed.extend_from_slice(chunk);
            Ok(())
        })
        .unwrap();
        assert_eq!(observed, b"complete");
        assert_eq!(staged.bytes(), 8);
        let partial = staged.path().to_path_buf();
        assert!(!dst.exists());
        staged.verify("complete", hash).unwrap();
        staged.publish(&dst).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), b"complete");
        assert_eq!(fs::read(&src).unwrap(), b"complete");
        assert!(!partial.exists());
        drop(staged);
        assert!(dst.exists());
    }
    #[test]
    fn verified_copy_cannot_publish_changed_destination_bytes() {
        let f = Fixture::new();
        let src = f.0.join("source.mp4");
        let dst = f.0.join("video.mp4");
        fs::write(&src, "complete").unwrap();
        let mut staged = stage_copy(&src, &f.0, 8, |_| Ok(())).unwrap();
        staged.verify("complete", hash).unwrap();
        // Windows should deny changes while verification is held. On other
        // platforms publication must at least reject changed metadata.
        if fs::write(staged.path(), "changed bytes").is_ok() {
            assert!(staged.publish(&dst).is_err());
            assert!(!dst.exists());
        } else {
            staged.publish(&dst).unwrap();
            assert_eq!(fs::read(dst).unwrap(), b"complete");
        }
    }
    #[test]
    fn exclusive_session_cleanup_only_removes_owned_stream_orphans() {
        let f = Fixture::new();
        let work = f.0.join(".photogogo-import");
        fs::create_dir(&work).unwrap();
        let orphan = work.join("stream-123-456-789.partial");
        fs::write(&orphan, "abandoned").unwrap();
        let keep = [
            "notes.txt",
            "photo.jpg.partial",
            "stream-owner-456-789.partial",
            "stream-123-456.partial",
            "stream-123-456-789-000.partial",
        ];
        for name in keep {
            fs::write(work.join(name), "keep").unwrap();
        }
        let directory = work.join("stream-999-888-777.partial");
        fs::create_dir(&directory).unwrap();
        assert_eq!(cleanup_abandoned_staged(&f.0).unwrap(), 1);
        assert!(!orphan.exists());
        for name in keep {
            assert!(work.join(name).exists());
        }
        assert!(directory.is_dir());
    }
    #[test]
    fn concurrent_same_named_sources_have_independent_cleanup() {
        let f = Fixture::new();
        let a = f.0.join("card-a");
        let b = f.0.join("card-b");
        fs::create_dir(&a).unwrap();
        fs::create_dir(&b).unwrap();
        fs::write(a.join("photo.jpg"), "first").unwrap();
        fs::write(b.join("photo.jpg"), "second").unwrap();
        let barrier = std::sync::Barrier::new(2);
        let (first, mut second) = std::thread::scope(|scope| {
            let one = scope.spawn(|| {
                stage_copy(&a.join("photo.jpg"), &f.0, 5, |_| {
                    barrier.wait();
                    Ok(())
                })
                .unwrap()
            });
            let two = scope.spawn(|| {
                stage_copy(&b.join("photo.jpg"), &f.0, 6, |_| {
                    barrier.wait();
                    Ok(())
                })
                .unwrap()
            });
            (one.join().unwrap(), two.join().unwrap())
        });
        assert_ne!(first.path(), second.path());
        let first_path = first.path().to_path_buf();
        let second_path = second.path().to_path_buf();
        drop(first);
        assert!(!first_path.exists());
        assert!(second_path.exists());
        second.verify("second", hash).unwrap();
        second.publish(&f.0.join("photo.jpg")).unwrap();
        assert_eq!(fs::read(f.0.join("photo.jpg")).unwrap(), b"second");
        assert!(a.join("photo.jpg").exists());
        assert!(b.join("photo.jpg").exists());
    }
    #[test]
    fn streaming_verification_and_cancellation_fail_closed() {
        let f = Fixture::new();
        let src = f.0.join("source.mp4");
        let dst = f.0.join("video.mp4");
        fs::write(&src, "complete").unwrap();
        let mut staged = stage_copy(&src, &f.0, 8, |_| Ok(())).unwrap();
        assert!(staged.publish(&dst).is_err());
        assert!(staged.verify("wrong hash", hash).is_err());
        assert!(staged.publish(&dst).is_err());
        staged.verify("complete", hash).unwrap();
        assert!(staged
            .verify("complete", |_| Err("read failed".into()))
            .is_err());
        assert!(staged.publish(&dst).is_err());
        let partial = staged.path().to_path_buf();
        drop(staged);
        assert!(!partial.exists());
        assert!(!dst.exists());
        assert!(stage_copy(&src, &f.0, 8, |_| Err("cancelled".into())).is_err());
        assert_eq!(
            fs::read_dir(f.0.join(".photogogo-import")).unwrap().count(),
            0
        );
        assert_eq!(fs::read(src).unwrap(), b"complete");
    }
    #[test]
    fn staged_publication_never_overwrites_a_racing_destination() {
        let f = Fixture::new();
        let src = f.0.join("source.mp4");
        let dst = f.0.join("video.mp4");
        fs::write(&src, "complete").unwrap();
        let mut staged = stage_copy(&src, &f.0, 8, |_| Ok(())).unwrap();
        staged.verify("complete", hash).unwrap();
        fs::write(&dst, "other import").unwrap();
        assert!(staged.publish(&dst).is_err());
        assert_eq!(fs::read(&dst).unwrap(), b"other import");
        // The verified private bytes are still usable with a different safe name.
        staged.publish(&f.0.join("video-2.mp4")).unwrap();
        assert_eq!(fs::read(f.0.join("video-2.mp4")).unwrap(), b"complete");
    }
    #[test]
    fn wrong_source_size_is_rejected_without_retaining_a_partial() {
        let f = Fixture::new();
        let src = f.0.join("source.mp4");
        fs::write(&src, "complete").unwrap();
        assert!(stage_copy(&src, &f.0, 7, |_| Ok(())).is_err());
        assert!(stage_copy(&src, &f.0, 9, |_| Ok(())).is_err());
        assert_eq!(
            fs::read_dir(f.0.join(".photogogo-import")).unwrap().count(),
            0
        );
        assert_eq!(fs::read(src).unwrap(), b"complete");
    }
    #[test]
    fn source_mutation_is_denied_or_detected_during_single_read() {
        let f = Fixture::new();
        let src = f.0.join("source.mp4");
        fs::write(&src, vec![b'x'; 3 * COPY_BUFFER_BYTES]).unwrap();
        let mut attempted = false;
        let mut changed = false;
        let result = stage_copy(&src, &f.0, (3 * COPY_BUFFER_BYTES) as u64, |_| {
            if !attempted {
                attempted = true;
                changed = fs::write(&src, "truncated").is_ok();
            }
            Ok(())
        });
        assert!(attempted);
        if changed {
            assert!(result.is_err());
        } else {
            assert_eq!(result.unwrap().bytes(), (3 * COPY_BUFFER_BYTES) as u64);
        }
        assert!(src.exists());
    }
    #[test]
    fn observer_sees_each_source_byte_once_and_verification_reads_the_destination() {
        let f = Fixture::new();
        let src = f.0.join("source.mp4");
        let content = vec![b'a'; 2 * 1024 * 1024 + 17];
        fs::write(&src, &content).unwrap();
        let mut observed_bytes = 0;
        let mut largest_chunk = 0;
        let mut staged = stage_copy(&src, &f.0, content.len() as u64, |chunk| {
            observed_bytes += chunk.len();
            largest_chunk = largest_chunk.max(chunk.len());
            assert!(chunk.iter().all(|&b| b == b'a'));
            Ok(())
        })
        .unwrap();
        assert_eq!(observed_bytes, 2 * 1024 * 1024 + 17);
        assert!(largest_chunk <= 1024 * 1024);
        staged
            .verify("matches", |path| {
                assert_ne!(path, src);
                assert!(path.starts_with(f.0.join(".photogogo-import")));
                assert_eq!(fs::read(path).unwrap(), content);
                Ok("matches".into())
            })
            .unwrap();
    }
    #[test]
    fn verified_staging_cannot_publish_outside_its_original_directory() {
        let f = Fixture::new();
        let src = f.0.join("source.mp4");
        let outside = f.0.join("other");
        fs::create_dir(&outside).unwrap();
        fs::write(&src, "complete").unwrap();
        let mut staged = stage_copy(&src, &f.0, 8, |_| Ok(())).unwrap();
        staged.verify("complete", hash).unwrap();
        assert!(staged.publish(&outside.join("video.mp4")).is_err());
        assert!(!outside.join("video.mp4").exists());
    }
    #[test]
    fn a_file_cannot_masquerade_as_the_private_work_directory() {
        let f = Fixture::new();
        let src = f.0.join("source.mp4");
        let blocker = f.0.join(".photogogo-import");
        fs::write(&src, "complete").unwrap();
        fs::write(&blocker, "keep").unwrap();
        assert!(stage_copy(&src, &f.0, 8, |_| Ok(())).is_err());
        assert!(cleanup_abandoned_staged(&f.0).is_err());
        assert_eq!(fs::read(blocker).unwrap(), b"keep");
        assert_eq!(fs::read(src).unwrap(), b"complete");
    }
    #[cfg(unix)]
    #[test]
    fn redirected_work_directory_is_rejected_without_touching_target() {
        let f = Fixture::new();
        let src = f.0.join("source.mp4");
        let redirected = f.0.join("other");
        fs::create_dir(&redirected).unwrap();
        let retained = redirected.join("stream-123-456-789.partial");
        fs::write(&retained, "keep").unwrap();
        std::os::unix::fs::symlink(&redirected, f.0.join(".photogogo-import")).unwrap();
        fs::write(&src, "complete").unwrap();
        assert!(stage_copy(&src, &f.0, 8, |_| Ok(())).is_err());
        assert!(cleanup_abandoned_staged(&f.0).is_err());
        assert_eq!(fs::read(retained).unwrap(), b"keep");
    }
    #[test]
    fn an_empty_source_can_be_verified_without_observer_bytes() {
        let f = Fixture::new();
        let src = f.0.join("empty.mp4");
        let dst = f.0.join("copied.mp4");
        fs::write(&src, "").unwrap();
        let mut staged = stage_copy(&src, &f.0, 0, |_| panic!("no empty chunks")).unwrap();
        staged.verify("", hash).unwrap();
        staged.publish(&dst).unwrap();
        assert_eq!(fs::metadata(dst).unwrap().len(), 0);
        assert!(src.exists());
    }
}
