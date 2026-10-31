//! Standalone tests of the production archive controller and scheduler.
//! Service curves below are deterministic simulations, not hardware benchmarks.
#[path = "../src-tauri/src/commands/archive_adaptive.rs"]
mod archive_adaptive;

use archive_adaptive::{Controller, Mode, Snapshot, Work};
use std::sync::{atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering}, Condvar, Mutex};
use std::time::{Duration, Instant};

struct Simulation {
    controller: Controller,
    seconds: u64,
    bytes: u64,
    completed: u64,
    limits: Vec<usize>,
}
impl Simulation {
    fn new() -> Self { Self { controller: Controller::new(Mode::Auto, 8), seconds: 0, bytes: 0, completed: 0, limits: Vec::new() } }
    fn window(&mut self, rate: impl Fn(usize) -> u64) {
        self.seconds += 3;
        self.bytes += rate(self.controller.limit()) * 3;
        self.completed += 3;
        if let Some(decision) = self.controller.observe(Duration::from_secs(self.seconds), self.bytes, self.completed, true, false) {
            assert_eq!(decision.limit, self.controller.limit()); assert_ne!(decision.previous, decision.limit); assert!(!decision.reason.is_empty());
        }
        self.limits.push(self.controller.limit());
        assert!((1..=8).contains(&self.controller.limit()));
    }
    fn run(&mut self, windows: usize, rate: impl Fn(usize) -> u64 + Copy) { for _ in 0..windows { self.window(rate); } }
    fn recent_count(&self, expected: usize, windows: usize) -> usize { self.limits.iter().rev().take(windows).filter(|&&limit| limit == expected).count() }
}

// Gross verified service curves. They model different saturation points; the
// controller receives only completions/bytes and does not know the link label.
fn gigabit_like(limit: usize) -> u64 { match limit { 1 => 40_000_000, 2 => 80_000_000, 4 => 112_000_000, _ => 108_000_000 } }
fn ac_wifi_like(limit: usize) -> u64 { match limit { 1 => 18_000_000, 2 => 35_000_000, 4 => 38_500_000, _ => 30_000_000 } }
fn slow_wifi_like(limit: usize) -> u64 { match limit { 1 | 2 => 4_000_000, 4 => 3_800_000, _ => 3_200_000 } }

#[test]
fn auto_learns_a_useful_gigabit_like_limit_without_keeping_a_slower_probe() {
    let mut sim = Simulation::new(); sim.run(90, gigabit_like);
    assert!(sim.limits.contains(&4), "must probe useful headroom: {:?}", sim.limits);
    assert!(sim.recent_count(4, 24) >= 12, "must spend most stable windows near the useful limit: {:?}", sim.limits);
    println!("SIM gigabit-like: useful limit=4, observed limits={:?}", sim.limits);
}

#[test]
fn auto_adapts_to_ac_wifi_like_contention_instead_of_maximising_workers() {
    let mut sim = Simulation::new(); sim.run(90, ac_wifi_like);
    assert!(sim.limits.contains(&4));
    assert!(sim.recent_count(4, 24) >= 12, "must reject sustained contention at eight: {:?}", sim.limits);
    println!("SIM AC-Wi-Fi-like: useful limit=4, observed limits={:?}", sim.limits);
}

#[test]
fn auto_prefers_one_worker_when_slow_link_is_already_saturated() {
    let mut sim = Simulation::new(); sim.run(90, slow_wifi_like);
    assert!(sim.recent_count(1, 24) >= 12, "same throughput should settle at fewer workers: {:?}", sim.limits);
    println!("SIM 54-Mbps-like: plateau limit=1, observed limits={:?}", sim.limits);
}

#[test]
fn auto_recovers_from_a_slower_link_then_reprobes_after_improvement() {
    let mut sim = Simulation::new(); sim.run(60, gigabit_like);
    sim.run(90, slow_wifi_like);
    assert!(sim.recent_count(1, 24) >= 12, "must shed pointless concurrency after deterioration");
    sim.run(90, gigabit_like);
    assert!(sim.recent_count(4, 24) >= 12, "must reprobe after the link improves: {:?}", sim.limits);
    println!("SIM changing conditions: final useful limit=4, total virtual seconds={}", sim.seconds);
}

#[test]
fn no_completed_large_file_does_not_mean_zero_capacity_or_force_downshift() {
    let mut controller = Controller::new(Mode::Auto, 8);
    for second in 0..1800 {
        assert!(controller.observe(Duration::from_secs(second), 0, 0, true, false).is_none());
        assert_eq!(controller.limit(), 2);
    }
    controller.observe(Duration::from_secs(1803), 10 * 1024 * 1024 * 1024, 2, true, false);
    assert!((1..=8).contains(&controller.limit()));
}

#[test]
fn starvation_tail_and_pause_gaps_cannot_be_mistaken_for_a_saturated_trial() {
    let mut controller = Controller::new(Mode::Auto, 8);
    let mut bytes = 0;
    for second in 0..300 {
        bytes += 30_000_000;
        controller.observe(Duration::from_secs(second), bytes, second, false, false);
        assert_eq!(controller.limit(), 2);
    }
    assert_eq!(controller.limit(), 2);
}

#[test]
fn a_partial_backlog_during_a_probe_discards_the_pre_gap_comparison() {
    let mut controller = Controller::new(Mode::Auto, 8);
    controller.observe(Duration::from_secs(3), 240_000_000, 3, true, false);
    assert_eq!(controller.limit(), 4, "first full window establishes a two-worker baseline and starts a four-worker probe");
    controller.observe(Duration::from_secs(4), 240_000_000, 3, false, false);
    let decision = controller.observe(Duration::from_secs(7), 270_000_000, 6, true, false);
    assert_ne!(controller.limit(), 2, "the pre-gap 80 MB/s baseline cannot reject a different post-gap cohort");
    if let Some(decision) = decision {
        assert_ne!(decision.reason, "Returned to the more efficient worker count");
        assert_ne!(decision.reason, "Reduced workers after verified throughput fell");
    }
}

#[test]
fn auto_failures_back_off_immediately_but_manual_limits_remain_explicit() {
    let mut automatic = Controller::new(Mode::Auto, 8);
    automatic.observe(Duration::from_secs(1), 0, 1, true, true);
    assert_eq!(automatic.limit(), 1);
    let mut manual = Controller::new(Mode::Fixed(4), 8);
    for second in 1..100 { manual.observe(Duration::from_secs(second), 0, second, true, true); }
    assert_eq!(manual.limit(), 4);
    assert_eq!(Controller::new(Mode::Fixed(usize::MAX), 100).limit(), 8);
    assert_eq!(Controller::new(Mode::Fixed(0), 0).limit(), 1);
    assert_eq!(Controller::new(Mode::Auto, 1).limit(), 1);
}

#[test]
fn repeated_observation_at_one_timestamp_cannot_create_false_learning() {
    let mut controller = Controller::new(Mode::Auto, 8);
    controller.observe(Duration::from_secs(10), 0, 0, false, false);
    for count in 0..1000 { controller.observe(Duration::from_secs(10), count * 1_000_000, count, true, false); }
    assert_eq!(controller.limit(), 2);
}

// Event handshakes, not timing speed assertions, prove the whole-file adapter
// admits work on another file while the first waits in destination verification.
#[test]
fn scheduler_overlaps_whole_file_work_and_bounds_live_buffers() {
    let items: Vec<usize> = (0..24).collect();
    let gate = (Mutex::new(0usize), Condvar::new());
    let active = AtomicUsize::new(0); let max_active = AtomicUsize::new(0);
    let completed = Mutex::new(Vec::new()); let snapshots = Mutex::new(Vec::<Snapshot>::new());
    let final_state = archive_adaptive::run(&items, Mode::Fixed(2), 8, || false, |_, &item, _| {
        let live = active.fetch_add(1, Ordering::SeqCst) + 1; max_active.fetch_max(live, Ordering::SeqCst);
        let buffer = vec![0u8; 1024 * 1024];
        if item < 2 {
            let (lock, cv) = &gate; let mut entered = lock.lock().unwrap(); *entered += 1; cv.notify_all();
            let (entered, timeout) = cv.wait_timeout_while(entered, Duration::from_secs(3), |entered| *entered < 2).unwrap();
            assert!(!timeout.timed_out() && *entered == 2, "hash/copy for another file must overlap verification of this one");
        }
        assert_eq!(buffer.len(), 1024 * 1024); completed.lock().unwrap().push(item);
        active.fetch_sub(1, Ordering::SeqCst);
        Work { verified_bytes: if item % 3 == 0 { 5 * 1024 * 1024 * 1024 } else { 4096 }, failed: false }
    }, |snapshot| snapshots.lock().unwrap().push(snapshot));
    assert_eq!(max_active.load(Ordering::SeqCst), 2);
    let mut seen = completed.into_inner().unwrap(); seen.sort_unstable(); assert_eq!(seen, items);
    assert_eq!(final_state.completed, 24); assert!(!final_state.aborted);
    let expected = 8 * 5 * 1024 * 1024 * 1024 + 16 * 4096;
    assert_eq!(final_state.verified_bytes, expected);
    for snapshot in snapshots.into_inner().unwrap() { assert!(snapshot.active <= 2); assert!(snapshot.completed <= 24); assert_eq!(snapshot.limit, 2); assert!(snapshot.decision.is_none()); }
    println!("SCHEDULER: 24 mixed-size items once each, peak live copy buffers=2 MiB; large files represented by counters, not allocated contents");
}

#[test]
fn cancellation_stops_admission_without_abandoning_active_completions() {
    let items: Vec<usize> = (0..50).collect(); let aborted = AtomicBool::new(false);
    let gate = (Mutex::new(0usize), Condvar::new()); let started = AtomicUsize::new(0);
    let final_state = archive_adaptive::run(&items, Mode::Fixed(2), 8, || aborted.load(Ordering::SeqCst), |_, _, _| {
        started.fetch_add(1, Ordering::SeqCst);
        let (lock, cv) = &gate; let mut entered = lock.lock().unwrap(); *entered += 1; cv.notify_all();
        let (entered, timeout) = cv.wait_timeout_while(entered, Duration::from_secs(3), |entered| *entered < 2).unwrap();
        assert!(!timeout.timed_out() && *entered >= 2);
        aborted.store(true, Ordering::SeqCst);
        Work { verified_bytes: 4096, failed: false }
    }, |_| {});
    assert_eq!(started.load(Ordering::SeqCst), 2);
    assert_eq!(final_state.completed, 2); assert_eq!(final_state.verified_bytes, 8192); assert!(final_state.aborted);
}

#[test]
fn scheduler_counts_failures_as_processed_without_inflating_verified_goodput() {
    let good = AtomicU64::new(0);
    let final_state = archive_adaptive::run(&(0..10).collect::<Vec<_>>(), Mode::Fixed(3), 8, || false, |_, &index, _| {
        if index % 2 == 0 { Work { verified_bytes: 0, failed: true } }
        else { good.fetch_add(1000, Ordering::SeqCst); Work { verified_bytes: 1000, failed: false } }
    }, |_| {});
    assert_eq!(final_state.completed, 10); assert_eq!(final_state.verified_bytes, good.load(Ordering::SeqCst)); assert!(!final_state.aborted);
}

#[test]
fn empty_queue_reports_zero_and_does_not_call_work() {
    let final_state = archive_adaptive::run::<usize>(&[], Mode::Auto, 8, || false, |_, _, _| panic!("empty queue executed work"), |_| {});
    assert_eq!(final_state.completed, 0); assert_eq!(final_state.verified_bytes, 0); assert!(!final_state.aborted);
}

#[test]
fn scheduler_clock_excludes_time_spent_blocked_in_a_pause_checkpoint() {
    let calls = AtomicUsize::new(0); let pause_ns = AtomicU64::new(0); let clock = Instant::now();
    let final_state = archive_adaptive::run(&[0usize], Mode::Fixed(1), 1, || {
        if calls.fetch_add(1, Ordering::SeqCst) == 0 {
            let before = Instant::now(); std::thread::sleep(Duration::from_millis(150));
            pause_ns.store(before.elapsed().as_nanos() as u64, Ordering::SeqCst);
        }
        false
    }, |_, _, _| Work { verified_bytes: 1024, failed: false }, |_| {});
    let wall = clock.elapsed(); let paused = Duration::from_nanos(pause_ns.load(Ordering::SeqCst));
    assert!(paused >= Duration::from_millis(100));
    assert!(wall.saturating_sub(final_state.elapsed) >= paused / 2, "paused={paused:?}, wall={wall:?}, active={:?}", final_state.elapsed);
    assert_eq!(final_state.completed, 1);
}

#[test]
fn another_files_hashing_need_not_finish_before_first_copy_and_verification() {
    let items: Vec<usize> = (0..12).collect(); let events = Mutex::new(Vec::<(&str, usize)>::new());
    let final_state = archive_adaptive::run(&items, Mode::Fixed(2), 8, || false, |_, &index, checked| {
        assert!(!checked());
        // The real whole-file adapter's stages are supplied through the same
        // production scheduler seam. No NAS/filesystem speed is simulated here.
        events.lock().unwrap().push(("hash", index));
        events.lock().unwrap().push(("copy", index));
        events.lock().unwrap().push(("verify", index));
        Work { verified_bytes: 8192, failed: false }
    }, |_| {});
    let events = events.into_inner().unwrap();
    let first_copy = events.iter().position(|&(stage, _)| stage == "copy").unwrap();
    let first_verify = events.iter().position(|&(stage, _)| stage == "verify").unwrap();
    let last_hash = events.iter().rposition(|&(stage, _)| stage == "hash").unwrap();
    assert!(first_copy < last_hash && first_verify < last_hash, "a whole-batch hash barrier reappeared: {events:?}");
    for index in items {
        let position = |stage| events.iter().position(|&(event, item)| event == stage && item == index).unwrap();
        assert!(position("hash") < position("copy") && position("copy") < position("verify"));
    }
    assert_eq!(final_state.completed, 12);
}

#[test]
fn per_chunk_abort_checkpoint_marks_run_aborted_before_further_admission() {
    let abort = AtomicBool::new(false); let started = AtomicUsize::new(0);
    let final_state = archive_adaptive::run(&(0..32).collect::<Vec<_>>(), Mode::Fixed(1), 8, || abort.load(Ordering::SeqCst), |_, _, checked| {
        started.fetch_add(1, Ordering::SeqCst); abort.store(true, Ordering::SeqCst);
        assert!(checked(), "work must receive the scheduler's cancellation-aware checkpoint");
        Work { verified_bytes: 0, failed: true }
    }, |_| {});
    assert_eq!(started.load(Ordering::SeqCst), 1); assert_eq!(final_state.completed, 1);
    assert_eq!(final_state.verified_bytes, 0); assert!(final_state.aborted);
}

#[test]
fn per_chunk_pause_checkpoint_is_excluded_from_controller_and_snapshot_clock() {
    let pause = AtomicBool::new(false); let pause_ns = AtomicU64::new(0); let clock = Instant::now();
    let final_state = archive_adaptive::run(&[0usize], Mode::Fixed(1), 1, || {
        if pause.swap(false, Ordering::SeqCst) {
            let before = Instant::now(); std::thread::sleep(Duration::from_millis(150));
            pause_ns.store(before.elapsed().as_nanos() as u64, Ordering::SeqCst);
        }
        false
    }, |_, _, checked| { pause.store(true, Ordering::SeqCst); assert!(!checked()); Work { verified_bytes: 1024, failed: false } }, |_| {});
    let wall = clock.elapsed(); let paused = Duration::from_nanos(pause_ns.load(Ordering::SeqCst));
    assert!(paused >= Duration::from_millis(100));
    assert!(wall.saturating_sub(final_state.elapsed) >= paused / 2, "per-chunk paused={paused:?}, wall={wall:?}, active={:?}", final_state.elapsed);
}

#[test]
fn a_panicking_adapter_cannot_strand_workers_waiting_for_capacity() {
    let result = std::panic::catch_unwind(|| {
        archive_adaptive::run(&(0..32).collect::<Vec<_>>(), Mode::Fixed(1), 8, || false, |_, _, _| -> Work { panic!("synthetic adapter failure") }, |_| {});
    });
    assert!(result.is_err(), "adapter panic must be propagated instead of reported as success");
}
