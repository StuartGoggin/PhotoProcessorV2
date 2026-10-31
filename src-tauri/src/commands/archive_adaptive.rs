//! Bounded whole-file scheduling. Only independently verified outcomes drive Auto.
use std::{
    sync::{Condvar, Mutex},
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    Auto,
    Fixed(usize),
}
#[derive(Clone, Copy, Debug)]
pub(super) struct Decision {
    pub previous: usize,
    pub limit: usize,
    pub reason: &'static str,
}
#[derive(Clone, Copy)]
struct Probe {
    from: usize,
    rate: f64,
    up: bool,
}
pub(super) struct Controller {
    mode: Mode,
    max: usize,
    limit: usize,
    since: Duration,
    bytes: u64,
    completed: u64,
    baseline: Option<f64>,
    probe: Option<Probe>,
    cooldown: u8,
    probe_up: bool,
}
impl Controller {
    pub fn new(mode: Mode, max_workers: usize) -> Self {
        let max = max_workers.clamp(1, 8);
        Self {
            mode,
            max,
            limit: match mode {
                Mode::Auto => 2.min(max),
                Mode::Fixed(n) => n.clamp(1, max),
            },
            since: Duration::ZERO,
            bytes: 0,
            completed: 0,
            baseline: None,
            probe: None,
            cooldown: 0,
            probe_up: true,
        }
    }
    pub fn limit(&self) -> usize {
        self.limit
    }
    pub fn reset_window(&mut self, now: Duration, bytes: u64, completed: u64) {
        self.baseline = None;
        self.probe = None;
        self.cooldown = 0;
        self.advance(now, bytes, completed);
    }
    fn advance(&mut self, now: Duration, bytes: u64, completed: u64) {
        self.since = now;
        self.bytes = bytes;
        self.completed = completed;
    }
    pub fn observe(
        &mut self,
        now: Duration,
        verified_bytes: u64,
        completed: u64,
        saturated: bool,
        failed: bool,
    ) -> Option<Decision> {
        if matches!(self.mode, Mode::Fixed(_)) {
            return None;
        }
        let previous = self.limit;
        if failed {
            self.limit = (self.limit / 2).max(1);
            self.baseline = None;
            self.probe = None;
            self.cooldown = 3;
            self.advance(now, verified_bytes, completed);
            return (previous != self.limit).then_some(Decision {
                previous,
                limit: self.limit,
                reason: "Backed off after a failed file",
            });
        }
        if !saturated {
            self.reset_window(now, verified_bytes, completed);
            return None;
        }
        let elapsed = now.saturating_sub(self.since).as_secs_f64();
        if elapsed < 2.0
            || completed.saturating_sub(self.completed) < 2
            || verified_bytes <= self.bytes
        {
            return None;
        }
        let rate = (verified_bytes - self.bytes) as f64 / elapsed;
        self.advance(now, verified_bytes, completed);
        if let Some(probe) = self.probe.take() {
            let accepted = if probe.up {
                rate > probe.rate * 1.08
            } else {
                rate >= probe.rate * 0.95
            };
            if accepted {
                self.baseline = Some(rate);
                self.probe_up = true;
            } else {
                self.limit = probe.from;
                self.baseline = Some(probe.rate);
                self.probe_up = !probe.up;
            }
            self.cooldown = 3;
            return (previous != self.limit).then_some(Decision {
                previous,
                limit: self.limit,
                reason: "Returned to the more efficient worker count",
            });
        }
        if let Some(baseline) = self.baseline {
            if rate < baseline * 0.75 && self.limit > 1 {
                self.limit = (self.limit / 2).max(1);
                self.baseline = None;
                self.cooldown = 2;
                return Some(Decision {
                    previous,
                    limit: self.limit,
                    reason: "Reduced workers after verified throughput fell",
                });
            }
            self.baseline = Some(baseline * 0.6 + rate * 0.4);
        } else {
            self.baseline = Some(rate);
        }
        if self.cooldown > 0 {
            self.cooldown -= 1;
            return None;
        }
        let up = self.probe_up && self.limit < self.max;
        let next = if up {
            (self.limit * 2).min(self.max)
        } else {
            (self.limit / 2).max(1)
        };
        if next == self.limit {
            self.probe_up = true;
            return None;
        }
        self.probe = Some(Probe {
            from: self.limit,
            rate,
            up,
        });
        self.limit = next;
        Some(Decision {
            previous,
            limit: next,
            reason: if up {
                "Testing whether more workers improve verified throughput"
            } else {
                "Testing whether fewer workers retain throughput"
            },
        })
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct Work {
    pub verified_bytes: u64,
    pub failed: bool,
}
#[derive(Clone, Copy, Debug)]
pub(super) struct Snapshot {
    pub limit: usize,
    pub active: usize,
    pub completed: u64,
    pub verified_bytes: u64,
    pub elapsed: Duration,
    pub decision: Option<Decision>,
    pub aborted: bool,
    pub paused: Duration,
}
struct State {
    next: usize,
    active: usize,
    completed: u64,
    bytes: u64,
    aborted: bool,
    paused: Duration,
    pause_end: Duration,
    controller: Controller,
}

/// Workers hold only one file's small IO buffers; the queue contains indices.
/// A lower target drains current work rather than interrupting a valid copy.
pub(super) fn run<T: Sync>(
    items: &[T],
    mode: Mode,
    max_workers: usize,
    checkpoint: impl Fn() -> bool + Sync,
    work: impl Fn(usize, &T, &dyn Fn() -> bool) -> Work + Sync,
    report: impl Fn(Snapshot) + Sync,
) -> Snapshot {
    let started = Instant::now();
    let changed = Condvar::new();
    let state = Mutex::new(State {
        next: 0,
        active: 0,
        completed: 0,
        bytes: 0,
        aborted: false,
        paused: Duration::ZERO,
        pause_end: Duration::ZERO,
        controller: Controller::new(mode, max_workers),
    });
    let snapshot = |s: &State, decision| Snapshot {
        limit: s.controller.limit(),
        active: s.active,
        completed: s.completed,
        verified_bytes: s.bytes,
        elapsed: started.elapsed().saturating_sub(s.paused),
        decision,
        aborted: s.aborted,
        paused: s.paused,
    };
    let checked = || {
        let before = Instant::now();
        let stop = checkpoint();
        if stop || before.elapsed() > Duration::from_millis(100) {
            let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
            if stop {
                s.aborted = true;
            }
            if before.elapsed() > Duration::from_millis(100) {
                let end = started.elapsed();
                let begin = before.duration_since(started).max(s.pause_end);
                s.paused += end.saturating_sub(begin);
                s.pause_end = s.pause_end.max(end);
            }
            let (bytes, completed) = (s.bytes, s.completed);
            let now = started.elapsed().saturating_sub(s.paused);
            s.controller.reset_window(now, bytes, completed);
            let current = snapshot(&s, None);
            drop(s);
            changed.notify_all();
            report(current);
        }
        stop
    };
    std::thread::scope(|scope| {
        for _ in 0..max_workers.clamp(1, 8).min(items.len()) {
            let (state, changed, checked, work, report, snapshot) =
                (&state, &changed, &checked, &work, &report, &snapshot);
            scope.spawn(move || loop {
                if checked() {
                    break;
                }
                let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
                if s.aborted || s.next == items.len() {
                    break;
                }
                if s.active >= s.controller.limit() {
                    drop(
                        changed
                            .wait_timeout(s, Duration::from_millis(100))
                            .unwrap_or_else(|e| e.into_inner()),
                    );
                    continue;
                }
                let index = s.next;
                s.next += 1;
                s.active += 1;
                drop(s);
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    work(index, &items[index], checked)
                }));
                let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
                s.active -= 1;
                let outcome = match outcome {
                    Ok(value) => value,
                    Err(panic) => {
                        s.aborted = true;
                        changed.notify_all();
                        drop(s);
                        std::panic::resume_unwind(panic)
                    }
                };
                let saturated = s.active + 1 >= s.controller.limit() && s.next < items.len();
                s.completed += 1;
                s.bytes = s.bytes.saturating_add(outcome.verified_bytes);
                let (bytes, completed) = (s.bytes, s.completed);
                let now = started.elapsed().saturating_sub(s.paused);
                let decision =
                    s.controller
                        .observe(now, bytes, completed, saturated, outcome.failed);
                let current = snapshot(&s, decision);
                drop(s);
                changed.notify_all();
                report(current);
            });
        }
    });
    let final_snapshot = snapshot(&state.lock().unwrap_or_else(|e| e.into_inner()), None);
    final_snapshot
}
