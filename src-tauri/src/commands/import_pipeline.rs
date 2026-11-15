//! Bounded source read-ahead and independent destination processing.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Instant;
#[derive(Debug, Default)]
pub(super) struct Stats {
    pub source_wait_ms: u64,
    pub destination_ms: u64,
    pub peak_files: usize,
    pub peak_bytes: u64,
}
#[derive(Default)]
struct Usage {
    files: usize,
    bytes: u64,
    peak_files: usize,
    peak_bytes: u64,
}
struct Budget {
    usage: Mutex<Usage>,
    ready: Condvar,
    max_files: usize,
    max_bytes: u64,
    wait: AtomicU64,
}
struct Permit {
    budget: Arc<Budget>,
    bytes: u64,
}
impl Budget {
    fn acquire(self: &Arc<Self>, bytes: u64) -> Permit {
        let clock = Instant::now();
        let mut usage = self.usage.lock().unwrap_or_else(|e| e.into_inner());
        while usage.files >= self.max_files
            || (usage.files > 0 && usage.bytes.saturating_add(bytes) > self.max_bytes)
        {
            usage = self.ready.wait(usage).unwrap_or_else(|e| e.into_inner());
        }
        self.wait.fetch_add(
            clock.elapsed().as_millis().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
        usage.files += 1;
        usage.bytes = usage.bytes.saturating_add(bytes);
        usage.peak_files = usage.peak_files.max(usage.files);
        usage.peak_bytes = usage.peak_bytes.max(usage.bytes);
        Permit {
            budget: self.clone(),
            bytes,
        }
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        let mut usage = self.budget.usage.lock().unwrap_or_else(|e| e.into_inner());
        usage.files -= 1;
        usage.bytes = usage.bytes.saturating_sub(self.bytes);
        self.budget.ready.notify_all();
    }
}
/// Compatibility seam for serial consumers; one queued file absorbs short stalls.
pub(super) fn run<T: Sync, P: Send>(
    items: &[T],
    prepare: impl Fn(&T) -> Option<P> + Sync,
    finish: impl Fn(P),
) -> Result<(), String> {
    std::thread::scope(|scope| {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let prepare = &prepare;
        let reader = scope.spawn(move || {
            for item in items {
                if let Some(p) = prepare(item) {
                    if tx.send(p).is_err() {
                        break;
                    }
                }
            }
        });
        for p in rx {
            finish(p);
        }
        reader
            .join()
            .map_err(|_| "Import source reader failed; unpublished copies were cleaned up".into())
    })
}
/// Reserve before copying, so both queued files and files currently being copied
/// or verified count toward the limits. An oversize file runs alone.
pub(super) fn run_weighted<T: Sync, P: Send>(
    items: &[T],
    weight: impl Fn(&T) -> u64 + Sync,
    prepare: impl Fn(&T, u64) -> Option<P> + Sync,
    finish: impl Fn(P) + Sync,
    max_files: usize,
    max_bytes: u64,
    workers: usize,
) -> Result<Stats, String> {
    if max_files == 0 || max_bytes == 0 || workers == 0 || workers > 2 {
        return Err("Invalid bounded import configuration".into());
    }
    let budget = Arc::new(Budget {
        usage: Mutex::new(Usage::default()),
        ready: Condvar::new(),
        max_files,
        max_bytes,
        wait: AtomicU64::new(0),
    });
    let destination_ms = AtomicU64::new(0);
    std::thread::scope(|scope| {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        let receiver = Arc::new(Mutex::new(rx));
        let b = budget.clone();
        let weight = &weight;
        let prepare = &prepare;
        let reader = scope.spawn(move || {
            for item in items {
                let reserved = weight(item);
                let permit = b.acquire(reserved);
                if let Some(p) = prepare(item, reserved) {
                    let handoff = Instant::now();
                    let sent = tx.send((p, permit));
                    b.wait.fetch_add(
                        handoff.elapsed().as_millis().min(u64::MAX as u128) as u64,
                        Ordering::Relaxed,
                    );
                    if sent.is_err() {
                        break;
                    }
                }
            }
        });
        let mut consumers = Vec::new();
        for _ in 0..workers {
            let rx = receiver.clone();
            let finish = &finish;
            let time = &destination_ms;
            consumers.push(scope.spawn(move || loop {
                let next = rx.lock().unwrap_or_else(|e| e.into_inner()).recv();
                let Ok((p, _permit)) = next else { break };
                let clock = Instant::now();
                finish(p);
                time.fetch_add(
                    clock.elapsed().as_millis().min(u64::MAX as u128) as u64,
                    Ordering::Relaxed,
                );
            }));
        }
        // No main-thread receiver owner may keep the channel alive after panic.
        drop(receiver);
        let failed = consumers
            .into_iter()
            .map(|w| w.join().is_err())
            .fold(false, |a, b| a | b);
        let read_failed = reader.join().is_err();
        if failed || read_failed {
            return Err("Import pipeline worker failed; unpublished copies were cleaned up".into());
        }
        let usage = budget
            .usage
            .lock()
            .map_err(|_| "Import accounting failed")?;
        Ok(Stats {
            source_wait_ms: budget.wait.load(Ordering::Relaxed),
            destination_ms: destination_ms.load(Ordering::Relaxed),
            peak_files: usage.peak_files,
            peak_bytes: usage.peak_bytes,
        })
    })
}

#[cfg(test)]
mod read_ahead_tests {
    use super::*;
    #[test]
    fn source_reads_ahead_of_destination_pause_without_unbounded_backlog() {
        let (tx, rx) = std::sync::mpsc::channel();
        let seen = std::sync::atomic::AtomicUsize::new(0);
        run(
            &[0, 1, 2, 3, 4],
            |item| {
                seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if *item == 2 {
                    tx.send(()).unwrap();
                }
                Some(*item)
            },
            |item| {
                if item == 0 {
                    assert!(
                        rx.recv_timeout(std::time::Duration::from_millis(250))
                            .is_ok(),
                        "source should read third file while first destination is paused"
                    );
                    assert!(
                        seen.load(std::sync::atomic::Ordering::SeqCst) <= 4,
                        "lookahead must stay bounded"
                    );
                }
            },
        )
        .unwrap();
    }
}

#[cfg(test)]
mod weighted_tests {
    use super::*;
    #[test]
    fn bounded_weighted_pipeline_honours_bytes_and_oversize_exclusivity() {
        let live = std::sync::atomic::AtomicUsize::new(0);
        let peak = std::sync::atomic::AtomicUsize::new(0);
        let sizes = [4u64, 4, 20, 4, 4];
        let stats = run_weighted(
            &sizes,
            |s| *s,
            |s, _reserved| {
                let n = live.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(n, Ordering::SeqCst);
                if *s > 8 {
                    assert_eq!(n, 1, "oversize source must run alone");
                }
                Some(*s)
            },
            |s| {
                std::thread::sleep(std::time::Duration::from_millis(5));
                if s > 8 {
                    assert_eq!(live.load(Ordering::SeqCst), 1);
                }
                live.fetch_sub(1, Ordering::SeqCst);
            },
            4,
            8,
            2,
        )
        .unwrap();
        assert!(stats.peak_files <= 2);
        assert_eq!(stats.peak_bytes, 20);
        assert!(peak.load(Ordering::SeqCst) <= 2);
        assert_eq!(live.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn parallel_destination_pipeline_reduces_measured_reader_backpressure() {
        let inputs = vec![1u64; 16];
        let source = || std::thread::sleep(std::time::Duration::from_millis(4));
        let destination = || std::thread::sleep(std::time::Duration::from_millis(20));
        let start = Instant::now();
        run_weighted(
            &inputs,
            |s| *s,
            |s, _reserved| {
                source();
                Some(*s)
            },
            |_| destination(),
            4,
            64,
            1,
        )
        .unwrap();
        let baseline = start.elapsed();
        let start = Instant::now();
        let improved = run_weighted(
            &inputs,
            |s| *s,
            |s, _reserved| {
                source();
                Some(*s)
            },
            |_| destination(),
            4,
            64,
            2,
        )
        .unwrap();
        let elapsed = start.elapsed();
        eprintln!("synthetic import pipeline: one destination {:?}; two destinations {:?}; source_wait_ms={}; peak_files={} peak_bytes={}",baseline,elapsed,improved.source_wait_ms,improved.peak_files,improved.peak_bytes);
        assert!(
            improved.source_wait_ms > 0,
            "source backpressure must include handoff waiting, not only budget acquisition"
        );
        assert!(
            elapsed < baseline,
            "parallel destination work must improve this controlled source-idle workload"
        );
        assert!(improved.peak_files <= 4 && improved.peak_bytes <= 64);
    }
}
