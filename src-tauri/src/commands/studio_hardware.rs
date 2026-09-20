//! Shared, bounded FFmpeg admission for Video Studio and post-processing.
//!
//! FFmpeg thread counts are hints (some codecs and filters have their own
//! threads), so CPU tokens are paired with a small process and memory limit.
use super::studio_adaptive::{Controller, Observation};
use super::studio_telemetry::{self, HardwareSample};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

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
    next_id: u64,
    waiting: VecDeque<u64>,
    gpu_waiters: usize,
    running: HashMap<u64, RunningWork>,
    controller: Option<Controller>,
    epoch: Option<Instant>,
    admission_note: String,
    fixed_workers: usize,
    completions: u64,
}

/// GPU selection and comparison class come from actual FFmpeg arguments, not
/// translated UI phase names. Motion filenames do not change the workload class.
#[derive(Clone, Debug)]
pub(super) struct Workload {
    profile: u64,
    nvenc: bool,
    render: bool,
    width: u32,
    height: u32,
}

impl Workload {
    pub(super) fn from_args(
        width: u32,
        height: u32,
        args: &[String],
        source_profile: &str,
    ) -> Self {
        let value = |name: &str| {
            args.windows(2)
                .find(|pair| pair[0] == name)
                .map(|pair| pair[1].as_str())
                .unwrap_or("")
        };
        let encoder = value("-c:v");
        let filter = value("-vf");
        let normalized = filter
            .split(',')
            .map(|part| {
                if part.starts_with("vidstabtransform=input=") {
                    part.find(':').map_or("vidstabtransform", |at| &part[at..])
                } else {
                    part
                }
            })
            .collect::<Vec<_>>()
            .join(",");
        let analysis = value("-f") == "null" || filter.contains("vidstabdetect=");
        let normalized = if analysis {
            // result=<filename> is unique per clip, but not a quality setting.
            normalized
                .split(":result=")
                .next()
                .unwrap_or(&normalized)
                .to_string()
        } else {
            normalized
        };
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        (width, height, encoder, normalized, analysis, source_profile).hash(&mut hash);
        Self {
            profile: hash.finish(),
            nvenc: encoder == "h264_nvenc",
            render: !analysis && !encoder.is_empty(),
            width,
            height,
        }
    }
    fn gpu_memory(&self) -> u64 {
        // Conservative additional device allocation allowance per encode. Actual
        // free VRAM is checked too; this is not an assertion about measured RSS.
        (256 * MIB).saturating_add(
            u64::from(self.width)
                .saturating_mul(u64::from(self.height))
                .saturating_mul(48),
        )
    }
}

#[derive(Debug)]
struct RunningWork {
    workload: Workload,
    frames: u64,
    started: Instant,
    at: Instant,
    fresh: Instant,
    rate: Option<f64>,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SchedulerSnapshot {
    pub adaptive: bool,
    pub target_workers: usize,
    pub active_workers: usize,
    pub reserved_threads: usize,
    pub cpu_percent: Option<f64>,
    pub available_memory_bytes: Option<u64>,
    pub gpu_encoder_percent: Option<f64>,
    pub gpu_decoder_percent: Option<f64>,
    pub gpu_compute_percent: Option<f64>,
    pub gpu_memory_free_bytes: Option<u64>,
    pub throughput_fps: Option<f64>,
    pub reason: String,
}

pub(super) fn adaptive_ceiling(performance: &str) -> usize {
    ceiling_for(crate::utils::num_cpus(), performance)
}
fn ceiling_for(cores: usize, performance: &str) -> usize {
    (cores.max(1) / 2).clamp(1, if performance == "max" { 6 } else { 4 })
}

fn reserve_memory(sample: &HardwareSample) -> u64 {
    // A 16 GiB workstation retains 2 GiB; larger machines retain at most 4 GiB.
    sample
        .total_memory_bytes
        .map(|v| (v / 8).clamp(1024 * MIB, 4096 * MIB))
        .unwrap_or(2048 * MIB)
}

fn comparable_rate(usage: &Usage) -> Option<(u64, f64)> {
    if usage.running.is_empty() || usage.running.len() != usage.processes {
        return None;
    }
    let key = usage.running.values().next()?.workload.profile;
    let mut sum = 0.;
    for work in usage.running.values() {
        if work.workload.profile != key || work.fresh.elapsed() > Duration::from_secs(6) {
            return None;
        }
        sum += work.rate?;
    }
    Some((key, sum))
}

fn monitoring_ready(usage: &Usage, sample: &HardwareSample) -> bool {
    let gpu_needed = usage.gpu_waiters > 0 || usage.running.values().any(|w| w.workload.nvenc);
    let gpu = sample.gpu.as_ref();
    sample.cpu_percent.is_some()
        && sample.available_memory_bytes.is_some()
        && (!gpu_needed
            || gpu.is_some_and(|g| g.encoder_percent.is_some() && g.memory_free_bytes.is_some()))
}

fn advance(usage: &mut Usage, sample: &HardwareSample) {
    let rate = comparable_rate(usage);
    let gpu_needed = usage.gpu_waiters > 0 || usage.running.values().any(|w| w.workload.nvenc);
    let gpu = sample.gpu.as_ref();
    let ready = monitoring_ready(usage, sample);
    let memory_pressure = sample
        .available_memory_bytes
        .is_some_and(|m| m < reserve_memory(sample) + 512 * MIB);
    let gpu_pressure = gpu_needed
        && gpu.is_some_and(|g| {
            g.encoder_percent.is_some_and(|v| v > 95.)
                || g.memory_free_bytes.is_some_and(|v| v < 512 * MIB)
        });
    let now = usage
        .epoch
        .get_or_insert_with(Instant::now)
        .elapsed()
        .as_secs();
    if let Some(controller) = &mut usage.controller {
        controller.observe(Observation {
            now,
            cpu: sample.cpu_percent,
            monitoring_ready: ready,
            memory_pressure,
            gpu_pressure,
            active: usage.processes,
            completions: usage.completions,
            waiting: !usage.waiting.is_empty(),
            rate,
        });
    }
}

/// Cached sampling is nonblocking, and is deliberately outside the pool mutex.
pub(super) fn snapshot() -> SchedulerSnapshot {
    let sample = studio_telemetry::sample();
    let Ok(mut usage) = pool().0.lock() else {
        return SchedulerSnapshot::default();
    };
    advance(&mut usage, &sample);
    let gpu = sample.gpu.as_ref();
    let render_rates: Option<Vec<f64>> = usage
        .running
        .values()
        .filter(|w| w.workload.render)
        .map(|w| {
            if w.fresh.elapsed() <= Duration::from_secs(6) {
                w.rate
            } else {
                None
            }
        })
        .collect();
    let throughput_fps = render_rates
        .filter(|v| !v.is_empty())
        .map(|v| v.iter().sum());
    let reason = if !usage.admission_note.is_empty() && !usage.waiting.is_empty() {
        usage.admission_note.clone()
    } else {
        usage
            .controller
            .as_ref()
            .map(|c| c.reason.to_string())
            .unwrap_or_else(|| "Fixed worker/thread limits; adaptive scheduling is off".into())
    };
    SchedulerSnapshot {
        adaptive: usage.controller.is_some(),
        target_workers: usage
            .controller
            .as_ref()
            .map_or(usage.fixed_workers.max(1), |c| c.target),
        active_workers: usage.processes,
        reserved_threads: usage.threads,
        cpu_percent: sample.cpu_percent,
        available_memory_bytes: sample.available_memory_bytes,
        gpu_encoder_percent: gpu.and_then(|g| g.encoder_percent),
        gpu_decoder_percent: gpu.and_then(|g| g.decoder_percent),
        gpu_compute_percent: gpu.and_then(|g| g.compute_percent),
        gpu_memory_free_bytes: gpu.and_then(|g| g.memory_free_bytes),
        throughput_fps,
        reason: if sample.note.is_empty() {
            reason
        } else {
            format!("{reason}. {}", sample.note)
        },
    }
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
    id: Option<u64>,
}

impl ResourcePermit {
    pub(super) fn threads(&self) -> usize {
        self.threads
    }
    pub(super) fn progress_id(&self) -> Option<u64> {
        self.id
    }
}

pub(super) fn report_frames(id: Option<u64>, frames: u64) {
    let Some(id) = id else {
        return;
    };
    let Ok(mut usage) = pool().0.lock() else {
        return;
    };
    if let Some(work) = usage.running.get_mut(&id) {
        let elapsed = work.at.elapsed().as_secs_f64();
        if elapsed >= 1. {
            work.rate = frames
                .checked_sub(work.frames)
                .map(|delta| delta as f64 / elapsed);
            work.frames = frames;
            work.at = Instant::now();
        }
        work.fresh = Instant::now();
    }
}

impl Drop for ResourcePermit {
    fn drop(&mut self) {
        let (lock, wake) = self.resource_pool;
        if let Ok(mut usage) = lock.lock() {
            usage.processes = usage.processes.saturating_sub(1);
            usage.threads = usage.threads.saturating_sub(self.threads);
            usage.memory = usage.memory.saturating_sub(self.memory);
            usage.completions = usage.completions.saturating_add(1);
            if let Some(id) = self.id {
                usage.running.remove(&id);
            }
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
                id: None,
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

/// Adaptive Video Studio admission shares reservations with legacy processing.
/// FIFO waiters are bounded by the clip-worker ceiling, never by clip count.
pub(super) fn acquire_studio(
    width: u32,
    height: u32,
    performance: &str,
    adaptive: bool,
    ready_tasks: impl Fn() -> usize,
    workload: Workload,
    mut cancelled: impl FnMut() -> bool,
) -> Result<ResourcePermit, String> {
    let policy = policy(width, height, performance);
    if !adaptive {
        let threads =
            (policy.workers * policy.threads / policy.workers.min(ready_tasks().max(1))).max(1);
        let mut permit = acquire_with_threads(width, height, performance, threads, &mut cancelled)?;
        let mut usage = pool().0.lock().map_err(|_| "Video scheduler lock failed")?;
        if usage.processes == 1 {
            usage.controller = None;
        }
        usage.fixed_workers = policy.workers;
        usage.next_id += 1;
        let id = usage.next_id;
        usage.running.insert(
            id,
            RunningWork {
                workload,
                frames: 0,
                started: Instant::now(),
                at: Instant::now(),
                fresh: Instant::now(),
                rate: None,
            },
        );
        permit.id = Some(id);
        return Ok(permit);
    }
    acquire_adaptive_in(
        pool(),
        width,
        height,
        performance,
        ready_tasks,
        workload,
        cancelled,
        studio_telemetry::sample,
        crate::utils::num_cpus(),
    )
}

#[allow(clippy::too_many_arguments)]
fn acquire_adaptive_in(
    resource_pool: &'static (Mutex<Usage>, Condvar),
    width: u32,
    height: u32,
    performance: &str,
    ready_tasks: impl Fn() -> usize,
    workload: Workload,
    mut cancelled: impl FnMut() -> bool,
    mut monitor: impl FnMut() -> HardwareSample,
    cores: usize,
) -> Result<ResourcePermit, String> {
    if cancelled() {
        return Err("Cancelled while waiting for video processing capacity".into());
    }
    let memory = memory_per_process(width, height);
    let cores = cores.max(1);
    let initial_sample = monitor();
    let policy = policy_for(
        cores,
        initial_sample
            .available_memory_bytes
            .unwrap_or_else(available_memory),
        width,
        height,
        performance,
    );
    let cpu_budget = if performance == "max" {
        cores
    } else {
        cores.saturating_sub((cores / 8).max(1)).max(1)
    };
    let id = {
        let mut usage = resource_pool
            .0
            .lock()
            .map_err(|_| "Video scheduler lock failed")?;
        if usage.controller.is_none() || (usage.processes == 0 && usage.waiting.is_empty()) {
            usage.controller = Some(Controller::new(
                policy.workers,
                ceiling_for(cores, performance),
                performance == "max",
            ));
            usage.epoch = Some(Instant::now());
        }
        usage.next_id += 1;
        let id = usage.next_id;
        usage.waiting.push_back(id);
        if workload.nvenc {
            usage.gpu_waiters += 1;
        }
        id
    };
    struct Waiter {
        id: u64,
        gpu: bool,
        resource_pool: &'static (Mutex<Usage>, Condvar),
    }
    impl Drop for Waiter {
        fn drop(&mut self) {
            if let Ok(mut usage) = self.resource_pool.0.lock() {
                usage.waiting.retain(|id| *id != self.id);
                if self.gpu {
                    usage.gpu_waiters = usage.gpu_waiters.saturating_sub(1);
                }
                self.resource_pool.1.notify_all();
            }
        }
    }
    let _waiter = Waiter {
        id,
        gpu: workload.nvenc,
        resource_pool,
    };
    loop {
        if cancelled() {
            return Err("Cancelled while waiting for video processing capacity".into());
        }
        let sample = monitor();
        let available = sample
            .available_memory_bytes
            .unwrap_or_else(available_memory);
        let headroom = reserve_memory(&sample);
        let mut usage = resource_pool
            .0
            .lock()
            .map_err(|_| "Video scheduler lock failed")?;
        advance(&mut usage, &sample);
        if usage.processes == 0 {
            usage.memory_budget = available.saturating_sub(headroom);
            if memory > usage.memory_budget {
                return Err(format!("Not enough available RAM: {} MiB available; approximately {} MiB plus {} MiB Windows headroom required", available / MIB, memory / MIB, headroom / MIB));
            }
        }
        let target = usage
            .controller
            .as_ref()
            .map_or(policy.workers, |c| c.target)
            .min(ceiling_for(cores, performance));
        // Restart-safe Studio can submit separate one-clip requests. Their
        // project-local tail counts must not each claim the entire shared CPU.
        let demand = ready_tasks()
            .max(usage.processes + usage.waiting.len())
            .max(1);
        let threads = (cpu_budget / target.min(demand).max(1)).max(1);
        // Thread counts are per-pipeline hints, not CPU usage. Allow one bounded
        // overlap during a trial; existing FFmpeg pools cannot be retuned live.
        // Missing CPU telemetry restores the original strict reservation limit.
        let thread_limit = if monitoring_ready(&usage, &sample) {
            cpu_budget + cpu_budget / 2
        } else {
            cpu_budget
        };
        let cpu_busy = usage.processes > 0
            && sample
                .cpu_percent
                .is_some_and(|v| v > if performance == "max" { 97. } else { 88. });
        let memory_ok = usage.memory.saturating_add(memory) <= usage.memory_budget
            && available >= memory.saturating_add(headroom);
        let gpu_ok = !workload.nvenc
            || sample.gpu.as_ref().is_none_or(|gpu| {
                let pending: u64 = usage
                    .running
                    .values()
                    .filter(|w| w.workload.nvenc && w.started.elapsed() < Duration::from_secs(4))
                    .map(|w| w.workload.gpu_memory())
                    .fold(0_u64, u64::saturating_add);
                gpu.memory_free_bytes.is_none_or(|free| {
                    free >= workload
                        .gpu_memory()
                        .saturating_add(pending)
                        .saturating_add(256 * MIB)
                }) && gpu.encoder_percent.is_none_or(|v| v <= 97.)
            });
        let capacity = usage.processes < target && usage.threads + threads <= thread_limit;
        if usage.waiting.front() == Some(&id) && capacity && memory_ok && gpu_ok && !cpu_busy {
            usage.processes += 1;
            usage.threads += threads;
            usage.memory += memory;
            usage.running.insert(
                id,
                RunningWork {
                    workload: workload.clone(),
                    frames: 0,
                    started: Instant::now(),
                    at: Instant::now(),
                    fresh: Instant::now(),
                    rate: None,
                },
            );
            usage.admission_note.clear();
            let permit = ResourcePermit {
                threads,
                memory,
                resource_pool,
                id: Some(id),
            };
            drop(usage);
            if cancelled() {
                drop(permit);
                return Err("Cancelled while waiting for video processing capacity".into());
            }
            return Ok(permit);
        }
        if usage.waiting.front() == Some(&id) {
            usage.admission_note = if !memory_ok {
                "Waiting for RAM headroom"
            } else if !gpu_ok {
                "Waiting for NVIDIA encoder / VRAM headroom"
            } else if cpu_busy {
                "Waiting for CPU headroom"
            } else {
                ""
            }
            .into();
        }
        let _ = resource_pool
            .1
            .wait_timeout(usage, Duration::from_millis(200))
            .map_err(|_| "Video scheduler wait failed")?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_sample() -> HardwareSample {
        HardwareSample {
            cpu_percent: Some(40.),
            available_memory_bytes: Some(12 * 1024 * MIB),
            total_memory_bytes: Some(16 * 1024 * MIB),
            ..HardwareSample::default()
        }
    }
    fn test_pool() -> &'static (Mutex<Usage>, Condvar) {
        Box::leak(Box::new((Mutex::new(Usage::default()), Condvar::new())))
    }
    fn test_work() -> Workload {
        Workload::from_args(
            1920,
            1080,
            &["-c:v".into(), "libx264".into()],
            "h264-yuv420p-50",
        )
    }

    #[test]
    fn adaptive_admission_releases_permits_and_tail_receives_free_threads() {
        let pool = test_pool();
        let permit = acquire_adaptive_in(
            pool,
            1920,
            1080,
            "max",
            || 6,
            test_work(),
            || false,
            test_sample,
            12,
        )
        .unwrap();
        assert_eq!(permit.threads(), 4);
        assert_eq!(pool.0.lock().unwrap().processes, 1);
        assert!(pool.0.lock().unwrap().waiting.is_empty());
        drop(permit);
        assert_eq!(pool.0.lock().unwrap().threads, 0);
        assert!(pool.0.lock().unwrap().running.is_empty());
        let tail = acquire_adaptive_in(
            pool,
            1920,
            1080,
            "max",
            || 1,
            test_work(),
            || false,
            test_sample,
            12,
        )
        .unwrap();
        assert_eq!(tail.threads(), 12);
    }

    #[test]
    fn separate_one_clip_requests_share_observed_spare_capacity() {
        let pool = test_pool();
        let first = acquire_adaptive_in(
            pool,
            1920,
            1080,
            "max",
            || 1,
            test_work(),
            || false,
            test_sample,
            12,
        )
        .unwrap();
        let mut checks = 0;
        let second = acquire_adaptive_in(
            pool,
            1920,
            1080,
            "max",
            || 1,
            test_work(),
            || {
                checks += 1;
                checks > 4
            },
            test_sample,
            12,
        )
        .expect("a second one-clip request must share the global budget");
        assert_eq!((first.threads(), second.threads()), (12, 6));
        assert_eq!(pool.0.lock().unwrap().processes, 2);
        drop(second);
        drop(first);
        assert_eq!(pool.0.lock().unwrap().threads, 0);
    }

    #[test]
    fn adaptive_cancellation_after_provisional_admission_cleans_fifo_and_resources() {
        let pool = test_pool();
        let mut checks = 0;
        let result = acquire_adaptive_in(
            pool,
            1920,
            1080,
            "max",
            || 6,
            test_work(),
            || {
                assert!(
                    pool.0.try_lock().is_ok(),
                    "callback must run outside scheduler mutex"
                );
                checks += 1;
                checks >= 3
            },
            test_sample,
            12,
        );
        assert!(result.unwrap_err().contains("Cancelled"));
        let usage = pool.0.lock().unwrap();
        assert_eq!((usage.processes, usage.threads, usage.memory), (0, 0, 0));
        assert!(usage.waiting.is_empty());
        assert!(usage.running.is_empty());
    }

    #[test]
    fn adaptive_wait_cancellation_removes_waiter_without_releasing_other_work() {
        let pool = test_pool();
        let held = acquire_adaptive_in(
            pool,
            1920,
            1080,
            "max",
            || 1,
            test_work(),
            || false,
            test_sample,
            12,
        )
        .unwrap();
        let mut checks = 0;
        let result = acquire_adaptive_in(
            pool,
            1920,
            1080,
            "max",
            || 1,
            test_work(),
            || {
                checks += 1;
                checks >= 3
            },
            || HardwareSample {
                cpu_percent: None,
                ..test_sample()
            },
            12,
        );
        assert!(result.is_err());
        let usage = pool.0.lock().unwrap();
        assert_eq!((usage.processes, usage.threads), (1, 12));
        assert!(usage.waiting.is_empty());
        drop(usage);
        drop(held);
    }

    #[test]
    fn nvenc_unknown_counters_disable_adaptive_overlap_and_low_ram_fails_cleanly() {
        let usage = Usage {
            gpu_waiters: 1,
            ..Usage::default()
        };
        assert!(!monitoring_ready(&usage, &test_sample()));
        let pool = test_pool();
        let result = acquire_adaptive_in(
            pool,
            3840,
            2160,
            "max",
            || 6,
            test_work(),
            || false,
            || HardwareSample {
                available_memory_bytes: Some(512 * MIB),
                ..test_sample()
            },
            12,
        );
        assert!(result.unwrap_err().contains("Not enough available RAM"));
        assert!(pool.0.lock().unwrap().waiting.is_empty());
        assert_eq!(pool.0.lock().unwrap().processes, 0);
    }

    #[test]
    fn workloads_distinguish_decode_cost_but_ignore_motion_output_filename() {
        let args = |name: &str| {
            vec![
                "-vf".into(),
                format!("vidstabdetect=accuracy=15:result={name}"),
                "-f".into(),
                "null".into(),
            ]
        };
        let a = Workload::from_args(3840, 2160, &args("one.trf"), "h264-50");
        let b = Workload::from_args(3840, 2160, &args("two.trf"), "h264-50");
        let c = Workload::from_args(3840, 2160, &args("two.trf"), "hevc-60");
        assert_eq!(a.profile, b.profile);
        assert_ne!(a.profile, c.profile);
        assert!(!a.nvenc && !a.render);
        let huge = Workload {
            width: u32::MAX,
            height: u32::MAX,
            ..test_work()
        };
        assert_eq!(huge.gpu_memory(), u64::MAX);
    }

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
                ..Usage::default()
            }),
            Condvar::new(),
        )));
        let held = ResourcePermit {
            threads: cores,
            memory,
            resource_pool,
            id: None,
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
