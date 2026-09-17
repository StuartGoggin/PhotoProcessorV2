//! Shared, bounded FFmpeg admission for Video Studio and post-processing.
//!
//! FFmpeg thread counts are hints (some codecs and filters have their own
//! threads), so CPU tokens are paired with a small process and memory limit.
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::Duration;

use super::process::FfmpegCapabilities;

const MIB: u64 = 1024 * 1024;
const MAX_PROCESSES: usize = 4;
const MEMORY_HEADROOM: u64 = 768 * MIB;

/// Assign every long-running native worker immediately after spawn. Windows
/// closes the app's job handle even on a crash, terminating all assigned workers
/// before another app instance can recover the persisted queue.
pub(super) fn supervise_child(child: &mut std::process::Child) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    if let Err(error) = windows_process_job::attach(child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "Could not supervise video worker; child was stopped: {error}"
        ));
    }
    #[cfg(not(target_os = "windows"))]
    let _ = child;
    Ok(())
}

#[cfg(target_os = "windows")]
mod windows_process_job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    struct ProcessJob(HANDLE);
    // SAFETY: the handle remains owned by this wrapper for its entire lifetime;
    // Windows synchronizes concurrent AssignProcessToJobObject calls, and the
    // app-lifetime OnceLock prevents closing it while another thread uses it.
    unsafe impl Send for ProcessJob {}
    unsafe impl Sync for ProcessJob {}

    impl ProcessJob {
        fn create() -> Result<Self, String> {
            // Null security attributes make this handle non-inheritable, so
            // children cannot accidentally keep their supervising job alive.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let job = Self(handle);
            // SAFETY: this C structure contains integer fields only, and zero
            // initializes unused limits before setting the documented flag.
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = unsafe {
                SetInformationJobObject(
                    job.0,
                    JobObjectExtendedLimitInformation,
                    (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&limits) as u32,
                )
            };
            if configured == 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(job)
        }

        fn assign(&self, child: &Child) -> Result<(), String> {
            // SAFETY: Child owns a live process handle during this call, and
            // self owns the configured job handle.
            let assigned = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle()) };
            if assigned == 0 {
                Err(std::io::Error::last_os_error().to_string())
            } else {
                Ok(())
            }
        }
    }

    impl Drop for ProcessJob {
        fn drop(&mut self) {
            // SAFETY: this wrapper uniquely owns the job handle. Closing its
            // last handle activates KILL_ON_JOB_CLOSE for any remaining child.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub(super) fn attach(child: &Child) -> Result<(), String> {
        static JOB: OnceLock<Result<ProcessJob, String>> = OnceLock::new();
        JOB.get_or_init(ProcessJob::create)
            .as_ref()
            .map_err(Clone::clone)?
            .assign(child)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::windows::process::CommandExt;
        use std::process::{Command, Stdio};
        use std::time::{Duration, Instant};

        #[test]
        fn closing_the_supervising_job_terminates_the_child() {
            let job = ProcessJob::create().expect("create supervision job");
            let mut child = Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Start-Sleep -Seconds 30",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(0x08000000)
                .spawn()
                .expect("spawn test worker");
            if let Err(error) = job.assign(&child) {
                let _ = child.kill();
                let _ = child.wait();
                panic!("assign test worker: {error}");
            }
            assert!(child.try_wait().unwrap().is_none());
            drop(job);
            let deadline = Instant::now() + Duration::from_secs(5);
            while Instant::now() < deadline {
                if child.try_wait().unwrap().is_some() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            let _ = child.kill();
            let _ = child.wait();
            panic!("child survived closing its supervising job");
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ResourcePolicy {
    pub(super) workers: usize,
    pub(super) threads: usize,
}

pub(super) fn select_encoder(cap: &FfmpegCapabilities) -> &'static str {
    if cap.has_h264_nvenc {
        "h264_nvenc"
    } else if cap.has_h264_qsv {
        "h264_qsv"
    } else {
        "libx264"
    }
}

pub(super) fn note(cap: &FfmpegCapabilities) -> String {
    match select_encoder(cap) {
        "h264_nvenc" => "NVIDIA NVENC (hardware encoding probe passed)".to_string(),
        "h264_qsv" => format!(
            "Intel Quick Sync (hardware encoding probe passed); NVIDIA unavailable: {}",
            cap.nvenc_probe_error
                .as_deref()
                .unwrap_or("encoder not included in FFmpeg")
        ),
        _ => format!(
            "CPU encoding; NVIDIA unavailable: {}; Intel Quick Sync unavailable: {}",
            cap.nvenc_probe_error
                .as_deref()
                .unwrap_or("encoder not included in FFmpeg"),
            cap.qsv_probe_error
                .as_deref()
                .unwrap_or("encoder not included in FFmpeg")
        ),
    }
}

// Decoder frames, stabilizer reference frames, filter buffers, and encoder
// queues all scale with resolution. This is an admission estimate, not a claim
// to measure per-process RSS. A 4K process reserves approximately 1 GiB.
fn memory_per_process(width: u32, height: u32) -> u64 {
    (512 * MIB).saturating_add(
        u64::from(width.max(1))
            .saturating_mul(u64::from(height.max(1)))
            .saturating_mul(64),
    )
}

fn policy_for(
    cores: usize,
    available_memory: u64,
    width: u32,
    height: u32,
    performance: &str,
) -> ResourcePolicy {
    let cores = cores.max(1);
    let cpu_budget = if performance == "max" {
        cores
    } else {
        cores.saturating_sub((cores / 8).max(1)).max(1)
    };
    let cpu_workers = if performance == "max" {
        (cpu_budget / 4).clamp(1, MAX_PROCESSES)
    } else {
        (cpu_budget / 4).clamp(1, 2)
    };
    let memory_workers =
        available_memory.saturating_sub(MEMORY_HEADROOM) / memory_per_process(width, height);
    let workers = cpu_workers.min(memory_workers.max(1) as usize);
    ResourcePolicy {
        workers,
        threads: (cpu_budget / workers).max(1),
    }
}

pub(super) fn policy(width: u32, height: u32, performance: &str) -> ResourcePolicy {
    policy_for(
        crate::utils::num_cpus(),
        available_memory(),
        width,
        height,
        performance,
    )
}

#[cfg(target_os = "windows")]
fn available_memory() -> u64 {
    #[repr(C)]
    struct MemoryStatus {
        length: u32,
        load: u32,
        total_phys: u64,
        avail_phys: u64,
        total_page_file: u64,
        avail_page_file: u64,
        total_virtual: u64,
        avail_virtual: u64,
        avail_extended_virtual: u64,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
    }
    let mut status = MemoryStatus {
        length: std::mem::size_of::<MemoryStatus>() as u32,
        load: 0,
        total_phys: 0,
        avail_phys: 0,
        total_page_file: 0,
        avail_page_file: 0,
        total_virtual: 0,
        avail_virtual: 0,
        avail_extended_virtual: 0,
    };
    // SAFETY: the correctly sized repr(C) structure remains valid for this call.
    if unsafe { GlobalMemoryStatusEx(&mut status) } != 0 {
        status.avail_phys
    } else {
        4 * 1024 * MIB
    }
}

#[cfg(not(target_os = "windows"))]
fn available_memory() -> u64 {
    // Linux reports memory reusable without swapping. Other platforms use a
    // deliberately conservative fallback rather than unbounded concurrency.
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|content| {
            content.lines().find_map(|line| {
                line.strip_prefix("MemAvailable:")
                    .and_then(|value| value.split_whitespace().next())
                    .and_then(|value| value.parse::<u64>().ok())
                    .map(|kb| kb * 1024)
            })
        })
        .unwrap_or(4 * 1024 * MIB)
}

#[derive(Debug, Default)]
struct Usage {
    processes: usize,
    threads: usize,
    memory: u64,
    memory_budget: u64,
}

fn pool() -> &'static (Mutex<Usage>, Condvar) {
    static POOL: OnceLock<(Mutex<Usage>, Condvar)> = OnceLock::new();
    POOL.get_or_init(|| (Mutex::new(Usage::default()), Condvar::new()))
}

/// Owns the process, CPU and memory reservation until the FFmpeg child exits.
#[derive(Debug)]
pub(super) struct ResourcePermit {
    threads: usize,
    memory: u64,
    resource_pool: &'static (Mutex<Usage>, Condvar),
}

impl ResourcePermit {
    pub(super) fn threads(&self) -> usize {
        self.threads
    }
}

impl Drop for ResourcePermit {
    fn drop(&mut self) {
        let (lock, wake) = self.resource_pool;
        if let Ok(mut usage) = lock.lock() {
            usage.processes = usage.processes.saturating_sub(1);
            usage.threads = usage.threads.saturating_sub(self.threads);
            usage.memory = usage.memory.saturating_sub(self.memory);
            wake.notify_all();
        }
    }
}

/// Waits for capacity in short, cancellable intervals. Callers must acquire
/// before spawning FFmpeg and drop the permit before waiting on a paused job.
pub(super) fn acquire(
    width: u32,
    height: u32,
    performance: &str,
    cancelled: impl FnMut() -> bool,
) -> Result<ResourcePermit, String> {
    let requested = policy(width, height, performance);
    acquire_with_threads(width, height, performance, requested.threads, cancelled)
}

/// Allows an existing post-processing thread setting or a single-clip render
/// to reserve a larger share while remaining within the same global budget.
pub(super) fn acquire_with_threads(
    width: u32,
    height: u32,
    performance: &str,
    requested_threads: usize,
    cancelled: impl FnMut() -> bool,
) -> Result<ResourcePermit, String> {
    acquire_in(
        pool(),
        width,
        height,
        performance,
        requested_threads,
        cancelled,
        available_memory,
    )
}

fn acquire_in(
    resource_pool: &'static (Mutex<Usage>, Condvar),
    width: u32,
    height: u32,
    performance: &str,
    requested_threads: usize,
    mut cancelled: impl FnMut() -> bool,
    memory_available: impl Fn() -> u64,
) -> Result<ResourcePermit, String> {
    let memory = memory_per_process(width, height);
    let cores = crate::utils::num_cpus().max(1);
    let cpu_limit = if performance == "max" {
        cores
    } else {
        cores.saturating_sub((cores / 8).max(1)).max(1)
    };
    let threads = requested_threads.clamp(1, cpu_limit);
    let (lock, wake) = resource_pool;
    loop {
        if cancelled() {
            return Err("Cancelled while waiting for video processing capacity".to_string());
        }
        let available = memory_available();
        let mut usage = lock
            .lock()
            .map_err(|_| "Video resource scheduler lock failed".to_string())?;
        if usage.processes == 0 {
            usage.memory_budget = available.saturating_sub(MEMORY_HEADROOM);
            if memory > usage.memory_budget {
                return Err(format!(
                    "Not enough available RAM for {}x{} video: {} MiB available; approximately {} MiB plus {} MiB headroom required. Close other applications and retry.",
                    width, height, available / MIB, memory / MIB, MEMORY_HEADROOM / MIB
                ));
            }
        }
        if usage.processes < MAX_PROCESSES
            && usage.threads + threads <= cpu_limit
            && usage.memory.saturating_add(memory) <= usage.memory_budget
            && available >= memory.saturating_add(MEMORY_HEADROOM)
        {
            usage.processes += 1;
            usage.threads += threads;
            usage.memory += memory;
            let permit = ResourcePermit {
                threads,
                memory,
                resource_pool,
            };
            // Capacity may have become available after the cancellation check
            // above. Recheck before handing the reservation to a subprocess.
            // Callbacks can lock job state, so never invoke them under this
            // mutex. Dropping a cancelled provisional permit returns capacity.
            drop(usage);
            if cancelled() {
                drop(permit);
                return Err("Cancelled while waiting for video processing capacity".to_string());
            }
            return Ok(permit);
        }
        let _ = wake
            .wait_timeout(usage, Duration::from_millis(200))
            .map_err(|_| "Video resource scheduler wait failed".to_string())?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_and_memory_bounds_hold_across_resolutions() {
        for cores in [1, 2, 4, 8, 16, 22, 64, 128] {
            for memory_gb in [1, 2, 4, 8, 16, 64] {
                for (width, height) in [(640, 480), (1920, 1080), (3840, 2160), (7680, 4320)] {
                    for performance in ["max", "balanced"] {
                        let policy =
                            policy_for(cores, memory_gb * 1024 * MIB, width, height, performance);
                        assert!((1..=MAX_PROCESSES).contains(&policy.workers));
                        assert!(policy.threads > 0);
                        assert!(policy.workers * policy.threads <= cores);
                        if performance == "balanced" && cores > 1 {
                            assert!(policy.workers * policy.threads < cores);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn four_k_reduces_concurrency_when_memory_is_constrained() {
        let hd = policy_for(22, 3 * 1024 * MIB, 1920, 1080, "max");
        let uhd = policy_for(22, 3 * 1024 * MIB, 3840, 2160, "max");
        assert!(uhd.workers < hd.workers);
    }

    #[test]
    fn probes_determine_encoder_preference() {
        let mut cap = FfmpegCapabilities {
            binary: "ffmpeg".into(),
            has_vidstab: true,
            has_deshake: true,
            has_h264_nvenc: false,
            has_h264_qsv: false,
            nvenc_probe_error: None,
            qsv_probe_error: None,
        };
        assert_eq!(select_encoder(&cap), "libx264");
        cap.has_h264_qsv = true;
        assert_eq!(select_encoder(&cap), "h264_qsv");
        cap.has_h264_nvenc = true;
        assert_eq!(select_encoder(&cap), "h264_nvenc");
    }

    #[test]
    fn cancellation_never_reserves_capacity() {
        assert!(acquire(1920, 1080, "max", || true).is_err());
    }

    #[test]
    fn releasing_a_permit_returns_capacity_and_unblocks_cancelled_waiters() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            mpsc, Arc,
        };
        use std::thread;

        // An isolated pool models a running worker without allocating video
        // buffers or depending on how much RAM the test machine currently has.
        let cores = crate::utils::num_cpus().max(1);
        let memory = memory_per_process(1920, 1080);
        let resource_pool: &'static (Mutex<Usage>, Condvar) = Box::leak(Box::new((
            Mutex::new(Usage {
                processes: 1,
                threads: cores,
                memory,
                memory_budget: 16 * 1024 * MIB,
            }),
            Condvar::new(),
        )));
        let held = ResourcePermit {
            threads: cores,
            memory,
            resource_pool,
        };
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = Arc::clone(&cancelled);
        let (waiting_tx, waiting_rx) = mpsc::channel();
        let (continue_tx, continue_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let waiter = thread::spawn(move || {
            let mut checks = 0;
            let result = acquire_in(
                resource_pool,
                1920,
                1080,
                "max",
                1,
                || {
                    assert!(
                        resource_pool.0.try_lock().is_ok(),
                        "cancellation callback ran under scheduler lock"
                    );
                    checks += 1;
                    let was_cancelled = worker_cancelled.load(Ordering::Acquire);
                    if checks == 2 {
                        let _ = waiting_tx.send(());
                        continue_rx
                            .recv_timeout(Duration::from_secs(3))
                            .expect("admission race was not released");
                    }
                    was_cancelled
                },
                || 16 * 1024 * MIB,
            );
            let _ = finished_tx.send(result.map(|_| ()));
        });
        // Force the precise race: the waiter captured false before the lock,
        // then cancellation and capacity release happen before admission.
        waiting_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("waiter never reached a capacity wait");
        cancelled.store(true, Ordering::Release);
        drop(held);
        continue_tx.send(()).unwrap();
        let result = finished_rx
            .recv_timeout(Duration::from_secs(3))
            .expect("cancelled waiter did not wake");
        assert!(result.unwrap_err().contains("Cancelled"));
        waiter.join().unwrap();
        let usage = resource_pool.0.lock().unwrap();
        assert_eq!((usage.processes, usage.threads, usage.memory), (0, 0, 0));
    }
}
