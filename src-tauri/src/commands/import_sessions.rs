//! One OS lock per live staging cohort; independent source jobs share publication state.
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard, OnceLock, Weak},
    time::Duration,
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Ready,
    Paused,
    Aborted,
}

pub struct Session {
    _lock: File,
    pub publication: Mutex<()>,
    pub reserved: Arc<Mutex<HashSet<PathBuf>>>,
    pub claimed: Arc<Mutex<HashMap<String, PathBuf>>>,
    prepared_parents: Mutex<HashSet<PathBuf>>,
}

impl Session {
    /// Paused/cancelled waiters never hold the destination publication mutex.
    pub fn acquire_publication(
        &self,
        mut control: impl FnMut() -> Control,
    ) -> Result<Option<MutexGuard<'_, ()>>, String> {
        loop {
            match control() {
                Control::Aborted => return Ok(None),
                Control::Paused => {
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                }
                Control::Ready => {}
            }
            match self.publication.try_lock() {
                Ok(guard) => match control() {
                    Control::Ready => return Ok(Some(guard)),
                    Control::Aborted => return Ok(None),
                    Control::Paused => drop(guard),
                },
                Err(std::sync::TryLockError::WouldBlock) => {}
                Err(_) => return Err("Import publication lock failed".into()),
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// Caller holds publication: an in-flight source is never a completed duplicate.
    pub fn published_duplicate(
        &self,
        hash: &str,
        size: u64,
        hash_file: impl Fn(&Path) -> Result<String, String>,
    ) -> Result<Option<PathBuf>, String> {
        let candidate = self
            .claimed
            .lock()
            .map_err(|_| "Import content registry failed")?
            .get(hash)
            .cloned();
        if let Some(path) = candidate {
            if super::import_safety::matches_content(&path, size, hash, hash_file)? {
                return Ok(Some(path));
            }
            self.claimed
                .lock()
                .map_err(|_| "Import content registry failed")?
                .remove(hash);
        }
        Ok(None)
    }

    pub fn prepare_parent(&self, parent: &Path) -> Result<(), String> {
        let mut prepared = self
            .prepared_parents
            .lock()
            .map_err(|_| "Import cleanup lock failed")?;
        let key = scope_key(&fs::canonicalize(parent).map_err(|e| e.to_string())?);
        if !prepared.contains(&key) {
            // This cohort exclusively owns the OS lock. First use of a parent
            // precedes every staged writer; subsequent jobs never sweep it again.
            super::import_safety::cleanup_abandoned_staged(parent)?;
            prepared.insert(key);
        }
        Ok(())
    }
}

/// Paths passed here must already be canonical, including resolution of junctions.
pub fn scope_key(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        PathBuf::from(path.to_string_lossy().to_lowercase())
    }
    #[cfg(not(windows))]
    {
        path.to_path_buf()
    }
}

pub fn try_open(root: &Path) -> Result<Option<Arc<Session>>, String> {
    static SESSIONS: OnceLock<Mutex<HashMap<PathBuf, Weak<Session>>>> = OnceLock::new();
    let mut sessions = SESSIONS
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Import session lock failed")?;
    sessions.retain(|_, session| session.strong_count() > 0);
    let key = scope_key(root);
    if let Some(session) = sessions.get(&key).and_then(Weak::upgrade) {
        return Ok(Some(session));
    }
    // Never follow a redirected lock file into another location.
    let path = root.join(".photogogo-import.lock");
    if let Ok(metadata) = fs::symlink_metadata(&path) {
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err("Import lock must be a regular file in staging".into());
        }
    }
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| e.to_string())?;
    match fs2::FileExt::try_lock_exclusive(&lock) {
        Ok(()) => {}
        Err(error)
            if error.kind() == std::io::ErrorKind::WouldBlock
                || error.raw_os_error() == Some(33) =>
        {
            return Ok(None)
        }
        Err(error) => return Err(format!("Could not lock staging for import: {error}")),
    }
    let session = Arc::new(Session {
        _lock: lock,
        publication: Mutex::new(()),
        reserved: Default::default(),
        claimed: Default::default(),
        prepared_parents: Default::default(),
    });
    sessions.insert(key, Arc::downgrade(&session));
    Ok(Some(session))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cohort_shares_lock_and_publication_state_until_last_job_finishes() {
        let root = std::env::temp_dir().join(format!(
            "photogogo-session-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let a = try_open(&root).unwrap().unwrap();
        let b = try_open(&root).unwrap().unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        let other = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join(".photogogo-import.lock"))
            .unwrap();
        assert!(fs2::FileExt::try_lock_exclusive(&other).is_err());
        drop(a);
        assert!(fs2::FileExt::try_lock_exclusive(&other).is_err());
        drop(b);
        fs2::FileExt::try_lock_exclusive(&other).unwrap();
        assert!(try_open(&root).unwrap().is_none());
        drop(other);
        assert!(try_open(&root).unwrap().is_some());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn aborted_publication_waiter_does_not_publish_after_lock_releases() {
        let root = std::env::temp_dir().join(format!(
            "photogogo-gate-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        let session = try_open(&root).unwrap().unwrap();
        let guard = session.publication.lock().unwrap();
        let abort = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker_session = session.clone();
        let worker_abort = abort.clone();
        let worker = std::thread::spawn(move || {
            let result = worker_session.acquire_publication(|| {
                let _ = entered_tx.send(());
                if worker_abort.load(std::sync::atomic::Ordering::SeqCst) {
                    Control::Aborted
                } else {
                    Control::Ready
                }
            });
            done_tx.send(result.unwrap().is_none()).unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        abort.store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(done_rx.recv_timeout(Duration::from_secs(2)).unwrap());
        drop(guard);
        worker.join().unwrap();
        drop(session);
        fs::remove_dir_all(root).unwrap();
    }
}
