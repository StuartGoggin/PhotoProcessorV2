//! Standalone tests for the bounded import pipeline and its real file-safety seam.
//! These fixtures contain synthetic bytes only; they never open media or SD cards.
#[path = "../src-tauri/src/commands/import_pipeline.rs"]
mod import_pipeline;
#[path = "../src-tauri/src/commands/import_safety.rs"]
mod import_safety;

use std::{
    cell::RefCell,
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant},
};

const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(5);
// Published Adler-32 example, independent of this implementation. The production
// import chooses MD5; this std-only test checksum exercises the injected seam.
const CONTENT: &[u8] = b"Wikipedia";
const CONTENT_CHECKSUM: &str = "11e60398";

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "photogogo-import-pipeline-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("sources")).unwrap();
        fs::create_dir(path.join("destination")).unwrap();
        Self(path)
    }

    fn source(&self, index: usize) -> PathBuf {
        self.0.join("sources").join(format!("source-{index}.bin"))
    }

    fn destination(&self, index: usize) -> PathBuf {
        self.parent().join(format!("copied-{index}.bin"))
    }

    fn parent(&self) -> PathBuf {
        self.0.join("destination")
    }

    fn sources(&self, count: usize) -> Vec<PathBuf> {
        (0..count)
            .map(|index| {
                let path = self.source(index);
                fs::write(&path, CONTENT).unwrap();
                path
            })
            .collect()
    }

    fn partial_count(&self) -> usize {
        let work = self.parent().join(".photogogo-import");
        if !work.exists() {
            return 0;
        }
        fs::read_dir(work).unwrap().count()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // This exact unique directory was created by this test, not supplied by
        // a caller, and contains only our disposable synthetic fixtures.
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn checksum_bytes(bytes: &[u8]) -> String {
    let mut a = 1u32;
    let mut b = 0u32;
    for byte in bytes {
        a = (a + *byte as u32) % 65_521;
        b = (b + a) % 65_521;
    }
    format!("{:08x}", b << 16 | a)
}

fn checksum(path: &Path) -> Result<String, String> {
    fs::read(path)
        .map(|bytes| checksum_bytes(&bytes))
        .map_err(|error| error.to_string())
}

struct Prepared {
    index: usize,
    staged: import_safety::StagedCopy,
}

struct LivePayload(Arc<AtomicUsize>);

impl Drop for LivePayload {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

struct TrackedPrepared {
    prepared: Prepared,
    _live: LivePayload,
}

#[test]
fn next_source_copy_overlaps_real_destination_verification() {
    let fixture = Fixture::new();
    let sources = fixture.sources(3);
    assert_eq!(checksum_bytes(CONTENT), CONTENT_CHECKSUM);
    let (verification_started, verification_start) = mpsc::channel();
    let verification_start = Mutex::new(verification_start);
    let (copy_overlapped, copy_overlap) = mpsc::channel();
    let errors = RefCell::new(Vec::new());
    let published = RefCell::new(Vec::new());

    import_pipeline::run(
        &[0usize, 1, 2],
        |index| {
            let staged = import_safety::stage_copy(
                &sources[*index],
                &fixture.parent(),
                CONTENT.len() as u64,
                |_| {
                    if *index == 1 {
                        verification_start
                            .lock()
                            .unwrap()
                            .recv_timeout(HANDSHAKE_DEADLINE)
                            .map_err(|_| "destination verification never began".to_string())?;
                        copy_overlapped.send(()).unwrap();
                    }
                    Ok(())
                },
            )
            .unwrap();
            Some(Prepared {
                index: *index,
                staged,
            })
        },
        |mut prepared| {
            let result = prepared
                .staged
                .verify(CONTENT_CHECKSUM, |path| {
                    assert_ne!(path, sources[prepared.index]);
                    if prepared.index == 0 {
                        verification_started.send(()).unwrap();
                        copy_overlap
                            .recv_timeout(HANDSHAKE_DEADLINE)
                            .map_err(|_| "next copy did not overlap verification".to_string())?;
                    }
                    checksum(path)
                })
                .and_then(|()| {
                    prepared
                        .staged
                        .publish(&fixture.destination(prepared.index))
                });
            match result {
                Ok(()) => published.borrow_mut().push(prepared.index),
                Err(error) => errors.borrow_mut().push(error),
            }
        },
    )
    .unwrap();

    assert!(errors.borrow().is_empty(), "{}", errors.borrow().join("; "));
    assert_eq!(*published.borrow(), vec![0, 1, 2]);
    for index in 0..3 {
        assert_eq!(fs::read(&sources[index]).unwrap(), CONTENT);
        assert_eq!(
            checksum(&fixture.destination(index)).unwrap(),
            CONTENT_CHECKSUM
        );
    }
    assert_eq!(fixture.partial_count(), 0);
}

#[test]
fn at_most_two_private_copies_are_in_flight_and_publish_in_source_order() {
    let fixture = Fixture::new();
    let sources = fixture.sources(24);
    let live = Arc::new(AtomicUsize::new(0));
    let peak_live = AtomicUsize::new(0);
    let copying = AtomicUsize::new(0);
    let peak_copying = AtomicUsize::new(0);
    let (second_ready, second_copy_ready) = mpsc::channel();
    let published = RefCell::new(Vec::new());
    let items: Vec<usize> = (0..sources.len()).collect();

    import_pipeline::run(
        &items,
        |index| {
            let count = live.fetch_add(1, Ordering::SeqCst) + 1;
            peak_live.fetch_max(count, Ordering::SeqCst);
            let tracked = LivePayload(live.clone());
            let count = copying.fetch_add(1, Ordering::SeqCst) + 1;
            peak_copying.fetch_max(count, Ordering::SeqCst);
            let staged = import_safety::stage_copy(
                &sources[*index],
                &fixture.parent(),
                CONTENT.len() as u64,
                |_| Ok(()),
            )
            .unwrap();
            copying.fetch_sub(1, Ordering::SeqCst);
            if *index == 1 {
                second_ready.send(()).unwrap();
            }
            Some(TrackedPrepared {
                prepared: Prepared {
                    index: *index,
                    staged,
                },
                _live: tracked,
            })
        },
        |mut item| {
            if item.prepared.index == 0 {
                second_copy_ready
                    .recv_timeout(HANDSHAKE_DEADLINE)
                    .expect("second copy must prepare while first is held");
                assert_eq!(live.load(Ordering::SeqCst), 2);
            }
            item.prepared
                .staged
                .verify(CONTENT_CHECKSUM, checksum)
                .unwrap();
            item.prepared
                .staged
                .publish(&fixture.destination(item.prepared.index))
                .unwrap();
            published.borrow_mut().push(item.prepared.index);
        },
    )
    .unwrap();

    assert_eq!(peak_live.load(Ordering::SeqCst), 2);
    assert_eq!(
        peak_copying.load(Ordering::SeqCst),
        1,
        "only one reader may copy from the source"
    );
    assert_eq!(live.load(Ordering::SeqCst), 0);
    assert_eq!(*published.borrow(), items);
    assert_eq!(fixture.partial_count(), 0);
    for index in 0..sources.len() {
        assert_eq!(fs::read(&sources[index]).unwrap(), CONTENT);
        assert_eq!(
            checksum(&fixture.destination(index)).unwrap(),
            CONTENT_CHECKSUM
        );
    }
}

#[test]
fn corrupt_private_copy_is_not_published_and_later_files_still_complete() {
    let fixture = Fixture::new();
    let sources = fixture.sources(3);
    let published = RefCell::new(Vec::new());
    let rejected = RefCell::new(Vec::new());
    import_pipeline::run(
        &[0usize, 1, 2],
        |index| {
            let staged = import_safety::stage_copy(
                &sources[*index],
                &fixture.parent(),
                CONTENT.len() as u64,
                |_| Ok(()),
            )
            .unwrap();
            if *index == 1 {
                // Same length, different bytes: size-only verification would miss it.
                fs::write(staged.path(), b"Wikimedia").unwrap();
            }
            Some(Prepared {
                index: *index,
                staged,
            })
        },
        |mut prepared| {
            let destination = fixture.destination(prepared.index);
            match prepared.staged.verify(CONTENT_CHECKSUM, checksum) {
                Ok(()) => {
                    prepared.staged.publish(&destination).unwrap();
                    published.borrow_mut().push(prepared.index);
                }
                Err(error) => {
                    assert!(error.contains("checksum verification"));
                    assert!(prepared.staged.publish(&destination).is_err());
                    rejected.borrow_mut().push(prepared.index);
                }
            }
        },
    )
    .unwrap();

    assert_eq!(*published.borrow(), vec![0, 2]);
    assert_eq!(*rejected.borrow(), vec![1]);
    assert!(!fixture.destination(1).exists());
    assert_eq!(fixture.partial_count(), 0);
    for source in sources {
        assert_eq!(fs::read(source).unwrap(), CONTENT);
    }
    for index in [0, 2] {
        assert_eq!(
            checksum(&fixture.destination(index)).unwrap(),
            CONTENT_CHECKSUM
        );
    }
}

#[test]
fn failed_or_cancelled_preparation_leaves_no_partial_and_does_not_publish() {
    let fixture = Fixture::new();
    let sources = fixture.sources(4);
    let preparation_errors = Mutex::new(Vec::new());
    let published = RefCell::new(Vec::new());
    import_pipeline::run(
        &[0usize, 1, 2, 3],
        |index| {
            let size = if *index == 1 {
                100
            } else {
                CONTENT.len() as u64
            };
            match import_safety::stage_copy(&sources[*index], &fixture.parent(), size, |_| {
                if *index == 2 {
                    Err("cancelled during copy".into())
                } else {
                    Ok(())
                }
            }) {
                Ok(staged) => Some(Prepared {
                    index: *index,
                    staged,
                }),
                Err(error) => {
                    preparation_errors.lock().unwrap().push((*index, error));
                    None
                }
            }
        },
        |mut prepared| {
            prepared.staged.verify(CONTENT_CHECKSUM, checksum).unwrap();
            prepared
                .staged
                .publish(&fixture.destination(prepared.index))
                .unwrap();
            published.borrow_mut().push(prepared.index);
        },
    )
    .unwrap();

    assert_eq!(*published.borrow(), vec![0, 3]);
    let errors = preparation_errors.lock().unwrap();
    assert_eq!(errors.len(), 2);
    assert_eq!(errors[0].0, 1);
    assert!(errors[0].1.contains("Source size changed"));
    assert_eq!(errors[1], (2, "cancelled during copy".into()));
    assert!(!fixture.destination(1).exists());
    assert!(!fixture.destination(2).exists());
    assert_eq!(fixture.partial_count(), 0);
    for source in sources {
        assert_eq!(fs::read(source).unwrap(), CONTENT);
    }
}

#[test]
fn caller_cancellation_fence_discards_an_already_prepared_copy_and_stops_reads() {
    let fixture = Fixture::new();
    let sources = fixture.sources(4);
    let cancelled = AtomicBool::new(false);
    let reads_started = AtomicUsize::new(0);
    let (cancellation_reached, cancellation_ready) = mpsc::channel();
    import_pipeline::run(
        &[0usize, 1, 2, 3],
        |index| {
            if cancelled.load(Ordering::SeqCst) {
                return None;
            }
            reads_started.fetch_add(1, Ordering::SeqCst);
            let result = import_safety::stage_copy(
                &sources[*index],
                &fixture.parent(),
                CONTENT.len() as u64,
                |_| {
                    if *index == 1 {
                        cancelled.store(true, Ordering::SeqCst);
                        cancellation_reached.send(()).unwrap();
                        return Err("cancelled".into());
                    }
                    Ok(())
                },
            );
            result.ok().map(|staged| Prepared {
                index: *index,
                staged,
            })
        },
        |prepared| {
            assert_eq!(prepared.index, 0);
            cancellation_ready
                .recv_timeout(HANDSHAKE_DEADLINE)
                .expect("second copy must reach cancellation");
            assert!(cancelled.load(Ordering::SeqCst));
            // Production's finish callback checks its abort flag before verification
            // and publication. Ownership cleanup removes the held private copy.
            drop(prepared);
        },
    )
    .unwrap();

    assert_eq!(reads_started.load(Ordering::SeqCst), 2);
    assert_eq!(fixture.partial_count(), 0);
    for index in 0..sources.len() {
        assert!(!fixture.destination(index).exists());
        assert_eq!(fs::read(&sources[index]).unwrap(), CONTENT);
    }
}

fn run_isolated_probe(name: &str) {
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            name,
            "--ignored",
            "--test-threads=1",
            "--nocapture",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            let output = child.wait_with_output().unwrap();
            panic!(
                "{name} exceeded the deadlock guard: {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{name} failed: {} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains("running 1 test") && stdout.contains("1 passed; 0 failed"),
        "{name} must actually execute exactly one successful probe, not silently match zero tests: {stdout}"
    );
}

#[test]
fn reader_panic_reports_error_and_cleans_owned_partial_without_deadlock() {
    run_isolated_probe("reader_panic_probe");
}

#[test]
#[ignore = "Run only in the bounded child-process probe"]
fn reader_panic_probe() {
    let fixture = Fixture::new();
    let sources = fixture.sources(3);
    let (second_ready, second_copy_ready) = mpsc::channel();
    let result = import_pipeline::run(
        &[0usize, 1, 2],
        |index| {
            let staged = import_safety::stage_copy(
                &sources[*index],
                &fixture.parent(),
                CONTENT.len() as u64,
                |_| Ok(()),
            )
            .unwrap();
            if *index == 1 {
                second_ready.send(()).unwrap();
                panic!("synthetic source-reader failure");
            }
            Some(Prepared {
                index: *index,
                staged,
            })
        },
        |mut prepared| {
            second_copy_ready.recv_timeout(HANDSHAKE_DEADLINE).unwrap();
            assert_eq!(prepared.index, 0);
            prepared.staged.verify(CONTENT_CHECKSUM, checksum).unwrap();
            prepared
                .staged
                .publish(&fixture.destination(prepared.index))
                .unwrap();
        },
    );

    assert!(result.is_err());
    assert!(!result.unwrap_err().is_empty());
    assert_eq!(checksum(&fixture.destination(0)).unwrap(), CONTENT_CHECKSUM);
    assert!(!fixture.destination(1).exists());
    assert!(!fixture.destination(2).exists());
    assert_eq!(fixture.partial_count(), 0);
    for source in sources {
        assert_eq!(fs::read(source).unwrap(), CONTENT);
    }
}

#[test]
fn consumer_panic_disconnects_the_waiting_reader_and_cleans_both_copies() {
    run_isolated_probe("consumer_panic_probe");
}

#[test]
#[ignore = "Run only in the bounded child-process probe"]
fn consumer_panic_probe() {
    let fixture = Fixture::new();
    let sources = fixture.sources(3);
    let (second_ready, second_copy_ready) = mpsc::channel();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        import_pipeline::run(
            &[0usize, 1, 2],
            |index| {
                let staged = import_safety::stage_copy(
                    &sources[*index],
                    &fixture.parent(),
                    CONTENT.len() as u64,
                    |_| Ok(()),
                )
                .unwrap();
                if *index == 1 {
                    second_ready.send(()).unwrap();
                }
                Some(Prepared {
                    index: *index,
                    staged,
                })
            },
            |prepared| {
                assert_eq!(prepared.index, 0);
                second_copy_ready.recv_timeout(HANDSHAKE_DEADLINE).unwrap();
                // The producer now owns a second private copy and is about to wait
                // at the rendezvous. Unwinding must drop the receiver before join.
                panic!("synthetic destination-consumer failure");
            },
        )
        .unwrap();
    }));

    assert!(result.is_err());
    assert_eq!(fixture.partial_count(), 0);
    for index in 0..sources.len() {
        assert!(!fixture.destination(index).exists());
        assert_eq!(fs::read(&sources[index]).unwrap(), CONTENT);
    }
}

#[test]
fn a_destination_created_after_verification_is_not_overwritten_by_the_pipeline() {
    let fixture = Fixture::new();
    let sources = fixture.sources(3);
    let published = RefCell::new(Vec::new());
    let collisions = RefCell::new(Vec::new());
    import_pipeline::run(
        &[0usize, 1, 2],
        |index| {
            let staged = import_safety::stage_copy(
                &sources[*index],
                &fixture.parent(),
                CONTENT.len() as u64,
                |_| Ok(()),
            )
            .unwrap();
            Some(Prepared {
                index: *index,
                staged,
            })
        },
        |mut prepared| {
            prepared.staged.verify(CONTENT_CHECKSUM, checksum).unwrap();
            let destination = fixture.destination(prepared.index);
            if prepared.index == 1 {
                fs::write(&destination, b"keep this unrelated file").unwrap();
            }
            match prepared.staged.publish(&destination) {
                Ok(()) => published.borrow_mut().push(prepared.index),
                Err(error) => {
                    assert!(error.contains("existing files are never replaced"));
                    collisions.borrow_mut().push(prepared.index);
                }
            }
        },
    )
    .unwrap();

    assert_eq!(*published.borrow(), vec![0, 2]);
    assert_eq!(*collisions.borrow(), vec![1]);
    assert_eq!(
        fs::read(fixture.destination(1)).unwrap(),
        b"keep this unrelated file"
    );
    assert_eq!(fixture.partial_count(), 0);
    for source in sources {
        assert_eq!(fs::read(source).unwrap(), CONTENT);
    }
}
