//! Cross-job protocol integration: real admission, staging cohort, streaming copy,
//! content verification and publication. These do not start the Tauri AppHandle
//! import workflow or emulate Windows physical-device discovery.
use super::{import, import_safety, import_scheduler, import_sessions};
use md5::{Digest, Md5};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, Sender},
        Arc,
    },
    time::{Duration, Instant},
};

const TIMEOUT: Duration = Duration::from_secs(10);

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "photogogo-cross-job-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        for name in ["card-a", "card-b", "staging"] {
            fs::create_dir(path.join(name)).unwrap();
        }
        Self(fs::canonicalize(path).unwrap())
    }

    fn source(&self, device: &str, contents: &[u8]) -> PathBuf {
        let path = self.0.join(device).join("photo.jpg");
        fs::write(&path, contents).unwrap();
        path
    }

    fn root(&self) -> PathBuf {
        self.0.join("staging")
    }

    fn request(&self, device: &str) -> import_scheduler::Request {
        import_scheduler::Request {
            devices: vec![device.into()],
            known: true,
            staging: import_sessions::scope_key(&self.root()),
            source: import_sessions::scope_key(&self.0.join(device)),
            exclusive: false,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[derive(Debug)]
struct Outcome {
    path: PathBuf,
    imported: bool,
}

fn file_hash(path: &Path) -> Result<String, String> {
    Ok(hex::encode(Md5::digest(
        fs::read(path).map_err(|error| error.to_string())?,
    )))
}

/// Use the same public protocol as the importer, including its real duplicate
/// and filename helpers. Channels act as a bounded two-party barrier inside the
/// actual source-read callbacks; a failed worker cannot leave its peer hanging.
fn run_job(
    _permit: import_scheduler::Permit,
    session: Arc<import_sessions::Session>,
    source: PathBuf,
    base: PathBuf,
    entered: Sender<PathBuf>,
    release: Receiver<bool>,
) -> Result<Outcome, String> {
    let size = fs::metadata(&source)
        .map_err(|error| error.to_string())?
        .len();
    let parent = base.parent().ok_or("Missing parent")?;
    session.prepare_parent(parent)?;
    let mut digest = Md5::new();
    let mut first_chunk = true;
    let mut staged = import_safety::stage_copy(&source, parent, size, |chunk| {
        digest.update(chunk);
        if first_chunk {
            first_chunk = false;
            entered.send(source.clone()).map_err(|e| e.to_string())?;
            if !release.recv_timeout(TIMEOUT).map_err(|e| e.to_string())? {
                return Err("cancelled by test".into());
            }
        }
        Ok(())
    })?;
    let hash = hex::encode(digest.finalize());
    staged.verify(&hash, file_hash)?;
    let _publication = session.publication.lock().map_err(|e| e.to_string())?;
    if let Some(path) = session.published_duplicate(&hash, size, file_hash)? {
        return Ok(Outcome {
            path,
            imported: false,
        });
    }
    let destination = import::reserve_unique_destination(base, &session.reserved);
    staged.publish(&destination)?;
    session
        .claimed
        .lock()
        .map_err(|e| e.to_string())?
        .insert(hash, destination.clone());
    Ok(Outcome {
        path: destination,
        imported: true,
    })
}

#[test]
fn independent_jobs_copy_together_while_same_source_waits_and_names_do_not_collide() {
    let fixture = Fixture::new();
    let source_a = fixture.source("card-a", b"first photo");
    let source_b = fixture.source("card-b", b"other photo");
    let scheduler = import_scheduler::Scheduler::default();
    let permit_a = scheduler
        .queue(fixture.request("card-a"))
        .unwrap()
        .try_acquire()
        .unwrap()
        .unwrap();
    let mut same_source = scheduler.queue(fixture.request("card-a")).unwrap();
    assert!(same_source.try_acquire().unwrap().is_err());
    // B must bypass the earlier A waiter, not merely run when the queue is empty.
    let permit_b = scheduler
        .queue(fixture.request("card-b"))
        .unwrap()
        .try_acquire()
        .unwrap()
        .unwrap();
    let session_a = import_sessions::try_open(&fixture.root()).unwrap().unwrap();
    let session_b = import_sessions::try_open(&fixture.root()).unwrap().unwrap();
    assert!(Arc::ptr_eq(&session_a, &session_b));
    let (entered, observed) = mpsc::channel();
    let (release_a, wait_a) = mpsc::channel();
    let (release_b, wait_b) = mpsc::channel();
    let base = fixture.root().join("same-name.jpg");
    let (a, b) = std::thread::scope(|scope| {
        let a_entered = entered.clone();
        let a_base = base.clone();
        let a_source = source_a.clone();
        let a =
            scope.spawn(move || run_job(permit_a, session_a, a_source, a_base, a_entered, wait_a));
        let b_source = source_b.clone();
        let b = scope.spawn(move || run_job(permit_b, session_b, b_source, base, entered, wait_b));
        let first = observed.recv_timeout(TIMEOUT).unwrap();
        let second = observed.recv_timeout(TIMEOUT).unwrap();
        assert_ne!(first, second);
        assert_eq!(scheduler.active_sources(), 2);
        assert!(same_source.try_acquire().unwrap().is_err());
        release_a.send(true).unwrap();
        release_b.send(true).unwrap();
        (a.join().unwrap().unwrap(), b.join().unwrap().unwrap())
    });
    assert!(a.imported && b.imported);
    assert_ne!(a.path, b.path);
    assert_eq!(fs::read(a.path).unwrap(), b"first photo");
    assert_eq!(fs::read(b.path).unwrap(), b"other photo");
    assert_eq!(fs::read(source_a).unwrap(), b"first photo");
    assert_eq!(fs::read(source_b).unwrap(), b"other photo");
    assert_eq!(scheduler.active_sources(), 0);
    assert!(same_source.try_acquire().unwrap().is_ok());
}

#[test]
fn same_content_from_two_devices_is_published_exactly_once() {
    let fixture = Fixture::new();
    let source_a = fixture.source("card-a", b"identical photo");
    let source_b = fixture.source("card-b", b"identical photo");
    let scheduler = import_scheduler::Scheduler::default();
    let session = import_sessions::try_open(&fixture.root()).unwrap().unwrap();
    let (entered, observed) = mpsc::channel();
    let (release_a, wait_a) = mpsc::channel();
    let (release_b, wait_b) = mpsc::channel();
    let (a, b) = std::thread::scope(|scope| {
        let permit_a = scheduler
            .queue(fixture.request("card-a"))
            .unwrap()
            .try_acquire()
            .unwrap()
            .unwrap();
        let permit_b = scheduler
            .queue(fixture.request("card-b"))
            .unwrap()
            .try_acquire()
            .unwrap()
            .unwrap();
        let session_a = session.clone();
        let session_b = session.clone();
        let entered_a = entered.clone();
        let base_a = fixture.root().join("a.jpg");
        let base_b = fixture.root().join("b.jpg");
        let a =
            scope.spawn(move || run_job(permit_a, session_a, source_a, base_a, entered_a, wait_a));
        let b =
            scope.spawn(move || run_job(permit_b, session_b, source_b, base_b, entered, wait_b));
        observed.recv_timeout(TIMEOUT).unwrap();
        observed.recv_timeout(TIMEOUT).unwrap();
        release_a.send(true).unwrap();
        release_b.send(true).unwrap();
        (a.join().unwrap().unwrap(), b.join().unwrap().unwrap())
    });
    assert_eq!(usize::from(a.imported) + usize::from(b.imported), 1);
    assert_eq!(a.path, b.path);
    assert_eq!(fs::read(&a.path).unwrap(), b"identical photo");
    let claims = session.claimed.lock().unwrap();
    assert_eq!(claims.len(), 1);
    assert_eq!(claims.values().next(), Some(&a.path));
    let media_count = fs::read_dir(fixture.root())
        .unwrap()
        .filter(|entry| {
            entry
                .as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|extension| extension == "jpg")
        })
        .count();
    assert_eq!(media_count, 1);
    assert_eq!(
        fs::read_dir(fixture.root().join(".photogogo-import"))
            .unwrap()
            .count(),
        0
    );
}

#[test]
fn cancelled_job_does_not_remove_another_active_jobs_partial() {
    let fixture = Fixture::new();
    let source_a = fixture.source("card-a", b"cancelled source");
    let source_b = fixture.source("card-b", b"retained source");
    let scheduler = import_scheduler::Scheduler::default();
    let session = import_sessions::try_open(&fixture.root()).unwrap().unwrap();
    let (entered, observed) = mpsc::channel();
    let (release_a, wait_a) = mpsc::channel();
    let (release_b, wait_b) = mpsc::channel();
    let work = fixture.root().join(".photogogo-import");
    std::thread::scope(|scope| {
        let permit_a = scheduler
            .queue(fixture.request("card-a"))
            .unwrap()
            .try_acquire()
            .unwrap()
            .unwrap();
        let permit_b = scheduler
            .queue(fixture.request("card-b"))
            .unwrap()
            .try_acquire()
            .unwrap()
            .unwrap();
        let session_a = session.clone();
        let session_b = session.clone();
        let entered_a = entered.clone();
        let base_a = fixture.root().join("a.jpg");
        let base_b = fixture.root().join("b.jpg");
        let a =
            scope.spawn(move || run_job(permit_a, session_a, source_a, base_a, entered_a, wait_a));
        let b =
            scope.spawn(move || run_job(permit_b, session_b, source_b, base_b, entered, wait_b));
        observed.recv_timeout(TIMEOUT).unwrap();
        observed.recv_timeout(TIMEOUT).unwrap();
        assert_eq!(fs::read_dir(&work).unwrap().count(), 2);
        release_a.send(false).unwrap();
        assert!(a.join().unwrap().unwrap_err().contains("cancelled"));
        let remaining = fs::read_dir(&work)
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect::<Vec<_>>();
        assert_eq!(remaining.len(), 1);
        assert_eq!(fs::read(&remaining[0]).unwrap(), b"retained source");
        // Another job joining the cohort cannot sweep the live B partial.
        session.prepare_parent(&fixture.root()).unwrap();
        assert!(remaining[0].exists());
        release_b.send(true).unwrap();
        let published = b.join().unwrap().unwrap();
        assert!(published.imported);
        assert_eq!(fs::read(published.path).unwrap(), b"retained source");
    });
    assert_eq!(fs::read_dir(work).unwrap().count(), 0);
    assert_eq!(scheduler.active_sources(), 0);
    assert_eq!(
        fs::read(fixture.0.join("card-a/photo.jpg")).unwrap(),
        b"cancelled source"
    );
}

fn assert_external_lock_state(root: &Path, available: bool) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "commands::import_integration_tests::external_staging_lock_probe",
            "--ignored",
            "--nocapture",
        ])
        .env("PHOTOGOGO_TEST_LOCK_ROOT", root)
        .env(
            "PHOTOGOGO_TEST_LOCK_AVAILABLE",
            if available { "yes" } else { "no" },
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if started.elapsed() >= TIMEOUT {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!("External lock probe timed out: {:?}", output);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "External lock probe failed: {:?}",
        output
    );
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("1 passed"),
        "Probe did not execute: {:?}",
        output
    );
}

#[test]
#[ignore = "Subprocess probe; launched by cohort_cleanup_runs_once_and_external_lock_lives_until_last_job"]
fn external_staging_lock_probe() {
    let root =
        PathBuf::from(std::env::var_os("PHOTOGOGO_TEST_LOCK_ROOT").expect("Probe root required"));
    let expected = std::env::var("PHOTOGOGO_TEST_LOCK_AVAILABLE").unwrap() == "yes";
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join(".photogogo-import.lock"))
        .unwrap();
    assert_eq!(fs2::FileExt::try_lock_exclusive(&file).is_ok(), expected);
}

#[test]
fn cohort_cleanup_runs_once_and_external_lock_lives_until_last_job() {
    let fixture = Fixture::new();
    let source = fixture.source("card-a", b"active bytes");
    let work = fixture.root().join(".photogogo-import");
    fs::create_dir(&work).unwrap();
    let orphan = work.join("stream-111-222-333.partial");
    fs::write(&orphan, "old crashed job").unwrap();
    let a = import_sessions::try_open(&fixture.root()).unwrap().unwrap();
    a.prepare_parent(&fixture.root()).unwrap();
    assert!(!orphan.exists());
    let staged = import_safety::stage_copy(&source, &fixture.root(), 12, |_| Ok(())).unwrap();
    let partial = staged.path().to_path_buf();
    let b = import_sessions::try_open(&fixture.root()).unwrap().unwrap();
    assert!(Arc::ptr_eq(&a, &b));
    b.prepare_parent(&fixture.root()).unwrap();
    assert!(partial.exists());
    assert_external_lock_state(&fixture.root(), false);
    drop(a);
    assert_external_lock_state(&fixture.root(), false);
    assert!(partial.exists());
    drop(staged);
    assert!(!partial.exists());
    drop(b);
    assert_external_lock_state(&fixture.root(), true);
}

#[test]
fn completed_content_claims_are_revalidated_and_read_errors_are_not_duplicates() {
    let fixture = Fixture::new();
    let session = import_sessions::try_open(&fixture.root()).unwrap().unwrap();
    let destination = fixture.root().join("complete.jpg");
    fs::write(&destination, b"first photo").unwrap();
    let hash = file_hash(&destination).unwrap();
    let _publication = session.publication.lock().unwrap();
    session
        .claimed
        .lock()
        .unwrap()
        .insert(hash.clone(), destination.clone());
    assert_eq!(
        session.published_duplicate(&hash, 11, file_hash).unwrap(),
        Some(destination.clone())
    );
    // A live file with a stale claim is not trusted merely because it exists.
    fs::write(&destination, b"other photo").unwrap();
    assert_eq!(
        session.published_duplicate(&hash, 11, file_hash).unwrap(),
        None
    );
    assert!(session.claimed.lock().unwrap().is_empty());
    session
        .claimed
        .lock()
        .unwrap()
        .insert(hash.clone(), destination.clone());
    fs::remove_file(&destination).unwrap();
    assert_eq!(
        session.published_duplicate(&hash, 11, file_hash).unwrap(),
        None
    );
    assert!(session.claimed.lock().unwrap().is_empty());
    fs::write(&destination, b"first photo").unwrap();
    session
        .claimed
        .lock()
        .unwrap()
        .insert(hash.clone(), destination.clone());
    assert!(session
        .published_duplicate(&hash, 11, |_| Err("destination read failed".into()))
        .is_err());
    assert_eq!(fs::read(destination).unwrap(), b"first photo");
}
