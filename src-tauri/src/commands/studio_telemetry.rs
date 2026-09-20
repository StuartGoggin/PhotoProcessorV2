//! Read-only, best-effort telemetry for Video Studio's admission policy.
//!
//! `sample` never performs a driver call. One app-lifetime collector owns the
//! Windows/NVML handles and services a bounded request channel. Samples are
//! cached for two seconds and expire after ten seconds. An unresponsive driver
//! can strand that one background thread, but cannot block the render queue,
//! create additional probing threads, or make an old reading look current.
//!
//! Windows CPU is system-wide busy time (kernel already includes idle), not a
//! count of FFmpeg threads. NVML's encoder, decoder and compute measurements
//! describe different engines. Unsupported counters are None, never zero.
//! Other platforms deliberately return unavailable and use fixed admission.
//!
//! References: Microsoft GetSystemTimes / GlobalMemoryStatusEx / LoadLibraryExW;
//! NVIDIA NVML API Reference, Device Queries and Initialization and Cleanup.
use serde::Serialize;
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);
const MAX_SAMPLE_AGE: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Default, Serialize)]
pub(super) struct HardwareSample {
    pub(super) cpu_percent: Option<f64>,
    pub(super) available_memory_bytes: Option<u64>,
    pub(super) total_memory_bytes: Option<u64>,
    pub(super) gpu: Option<GpuSample>,
    pub(super) note: String,
}

#[derive(Debug, Clone, Default, Serialize)]
pub(super) struct GpuSample {
    pub(super) name: String,
    pub(super) encoder_percent: Option<f64>,
    pub(super) decoder_percent: Option<f64>,
    pub(super) compute_percent: Option<f64>,
    pub(super) memory_free_bytes: Option<u64>,
    pub(super) memory_total_bytes: Option<u64>,
}

fn unavailable(note: impl Into<String>) -> HardwareSample {
    HardwareSample {
        note: note.into(),
        ..HardwareSample::default()
    }
}

#[derive(Default)]
struct Cache {
    value: HardwareSample,
    collected_at: Option<Instant>,
    requested_at: Option<Instant>,
}

impl Cache {
    fn snapshot(&self, now: Instant) -> HardwareSample {
        match self.collected_at {
            Some(at) if now.saturating_duration_since(at) <= MAX_SAMPLE_AGE => self.value.clone(),
            Some(_) => unavailable("Hardware monitoring is stale; using conservative admission"),
            None => unavailable("Hardware monitoring is warming up"),
        }
    }

    fn request_due(&self, now: Instant) -> bool {
        self.requested_at
            .is_none_or(|at| now.saturating_duration_since(at) >= SAMPLE_INTERVAL)
    }
}

struct Collector {
    cache: Arc<Mutex<Cache>>,
    requests: mpsc::SyncSender<()>,
}

impl Collector {
    #[cfg(test)]
    fn start(collect: impl FnMut() -> HardwareSample + Send + 'static) -> Result<Self, String> {
        Self::start_with_factory(move || collect)
    }

    fn start_with_factory<F, C>(factory: F) -> Result<Self, String>
    where
        F: FnOnce() -> C + Send + 'static,
        C: FnMut() -> HardwareSample + 'static,
    {
        let cache = Arc::new(Mutex::new(Cache::default()));
        let worker_cache = Arc::clone(&cache);
        let (requests, receiver) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("studio-hardware-monitor".into())
            .spawn(move || {
                let mut collect = factory();
                // No periodic polling while Video Studio is idle. recv sleeps
                // until requested, and at most one request can wait behind a
                // slow collection. No scheduler lock is accessible here.
                while receiver.recv().is_ok() {
                    let started_at = Instant::now();
                    let value = collect();
                    if let Ok(mut cache) = worker_cache.lock() {
                        cache.value = value;
                        // Include collection time in age; a delayed result is
                        // not incorrectly advertised as a fresh measurement.
                        cache.collected_at = Some(started_at);
                    } else {
                        break;
                    }
                }
            })
            .map_err(|error| format!("Hardware monitor could not start: {error}"))?;
        Ok(Self { cache, requests })
    }

    fn sample(&self) -> HardwareSample {
        let now = Instant::now();
        let Ok(mut cache) = self.cache.try_lock() else {
            return unavailable("Hardware monitoring is temporarily unavailable");
        };
        let value = cache.snapshot(now);
        if cache.request_due(now) {
            cache.requested_at = Some(now);
            if matches!(
                self.requests.try_send(()),
                Err(mpsc::TrySendError::Disconnected(_))
            ) {
                return unavailable("Hardware monitor stopped; using conservative admission");
            }
        }
        value
    }
}

/// Nonblocking cached interface. Call outside the global admission mutex.
/// Startup and the first CPU interval legitimately have unavailable counters.
pub(super) fn sample() -> HardwareSample {
    static COLLECTOR: OnceLock<Result<Collector, String>> = OnceLock::new();
    match COLLECTOR.get_or_init(|| {
        // Construct platform state on its owning thread: neither native handles
        // nor function pointers need an unsafe Send/Sync implementation.
        Collector::start_with_factory(|| {
            let mut platform = Platform::new();
            move || platform.collect()
        })
    }) {
        Ok(collector) => collector.sample(),
        Err(note) => unavailable(note.clone()),
    }
}

#[derive(Clone, Copy)]
struct CpuTicks {
    idle: u64,
    kernel: u64,
    user: u64,
}

fn percentage(value: f64) -> Option<f64> {
    (value.is_finite() && (0.0..=100.0).contains(&value)).then_some(value)
}

fn cpu_delta(previous: CpuTicks, current: CpuTicks) -> Option<f64> {
    let idle = current.idle.checked_sub(previous.idle)?;
    let kernel = current.kernel.checked_sub(previous.kernel)?;
    let user = current.user.checked_sub(previous.user)?;
    let total = kernel.checked_add(user)?;
    let busy = total.checked_sub(idle)?;
    if total == 0 {
        return None;
    }
    percentage(busy as f64 * 100.0 / total as f64)
}

fn cpu_interval(
    previous: Option<(Instant, CpuTicks)>,
    current: CpuTicks,
    now: Instant,
) -> Option<f64> {
    let (at, previous) = previous?;
    // The collector sleeps while idle. Do not present an average across hours
    // without rendering as current CPU headroom when the next queue starts.
    if now.saturating_duration_since(at) > MAX_SAMPLE_AGE {
        return None;
    }
    cpu_delta(previous, current)
}

fn memory_values(free: u64, total: u64) -> (Option<u64>, Option<u64>) {
    if total > 0 && free <= total {
        (Some(free), Some(total))
    } else {
        (None, None)
    }
}

#[cfg(target_os = "windows")]
use windows::Platform;

#[cfg(not(target_os = "windows"))]
struct Platform;

#[cfg(not(target_os = "windows"))]
impl Platform {
    fn new() -> Self {
        Self
    }

    fn collect(&mut self) -> HardwareSample {
        unavailable("Adaptive hardware monitoring is available on Windows only")
    }
}

#[cfg(target_os = "windows")]
mod windows {
    use super::{cpu_interval, memory_values, percentage, CpuTicks, GpuSample, HardwareSample};
    use std::ffi::{c_char, c_void, OsString};
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use std::path::PathBuf;
    use std::ptr;
    use std::time::Instant;

    #[repr(C)]
    #[derive(Default)]
    struct FileTime {
        low: u32,
        high: u32,
    }

    impl FileTime {
        fn ticks(&self) -> u64 {
            u64::from(self.low) | (u64::from(self.high) << 32)
        }
    }

    #[repr(C)]
    #[derive(Default)]
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
        fn GetSystemTimes(idle: *mut FileTime, kernel: *mut FileTime, user: *mut FileTime) -> i32;
        fn GetActiveProcessorGroupCount() -> u16;
        fn GlobalMemoryStatusEx(status: *mut MemoryStatus) -> i32;
        fn GetSystemDirectoryW(buffer: *mut u16, size: u32) -> u32;
        fn LoadLibraryExW(path: *const u16, file: *mut c_void, flags: u32) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const u8) -> *mut c_void;
        fn FreeLibrary(module: *mut c_void) -> i32;
    }

    #[link(name = "shell32")]
    extern "system" {
        fn SHGetFolderPathW(
            window: *mut c_void,
            folder: i32,
            token: *mut c_void,
            flags: u32,
            path: *mut u16,
        ) -> i32;
    }

    pub(super) struct Platform {
        previous_cpu: Option<(Instant, CpuTicks)>,
        nvml: Option<Result<Nvml, String>>,
    }

    impl Platform {
        pub(super) fn new() -> Self {
            Self {
                previous_cpu: None,
                nvml: None,
            }
        }

        pub(super) fn collect(&mut self) -> HardwareSample {
            let mut notes = Vec::new();
            let mut idle = FileTime::default();
            let mut kernel = FileTime::default();
            let mut user = FileTime::default();
            // SAFETY: the output structures remain valid during the call.
            // GetSystemTimes covers only one group on >64-processor machines;
            // do not misrepresent that partial reading as system-wide load.
            let cpu_percent = if unsafe { GetActiveProcessorGroupCount() } != 1 {
                self.previous_cpu = None;
                notes.push("CPU monitoring unavailable across processor groups".into());
                None
            } else if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } != 0 {
                let current = CpuTicks {
                    idle: idle.ticks(),
                    kernel: kernel.ticks(),
                    user: user.ticks(),
                };
                let now = Instant::now();
                let value = cpu_interval(self.previous_cpu, current, now);
                self.previous_cpu = Some((now, current));
                if value.is_none() {
                    notes.push("CPU monitoring is warming up".into());
                }
                value
            } else {
                self.previous_cpu = None;
                notes.push("Windows CPU monitoring unavailable".into());
                None
            };
            let mut memory = MemoryStatus {
                length: std::mem::size_of::<MemoryStatus>() as u32,
                ..MemoryStatus::default()
            };
            // SAFETY: repr(C) matches MEMORYSTATUSEX and length is initialized.
            let (available_memory_bytes, total_memory_bytes) =
                if unsafe { GlobalMemoryStatusEx(&mut memory) } != 0 {
                    memory_values(memory.avail_phys, memory.total_phys)
                } else {
                    (None, None)
                };
            if available_memory_bytes.is_none() {
                notes.push("Windows memory monitoring unavailable".into());
            }
            let gpu = match self.nvml.get_or_insert_with(Nvml::new) {
                Ok(nvml) => match nvml.sample() {
                    Ok(gpu) => {
                        if gpu.encoder_percent.is_none() {
                            notes.push("NVIDIA encoder counter unavailable".into());
                        }
                        Some(gpu)
                    }
                    Err(note) => {
                        notes.push(note);
                        None
                    }
                },
                Err(note) => {
                    notes.push(note.clone());
                    None
                }
            };
            HardwareSample {
                cpu_percent,
                available_memory_bytes,
                total_memory_bytes,
                gpu,
                note: notes.join("; "),
            }
        }
    }

    /// Owns the loaded image until every NVML function pointer is finished.
    /// Only constructed, called and dropped on the collector thread.
    struct Library(*mut c_void);

    impl Library {
        fn open() -> Result<Self, String> {
            let mut candidates = Vec::with_capacity(2);
            let mut system_dir = [0u16; 32768];
            // SAFETY: writable UTF-16 buffer with matching capacity.
            let length =
                unsafe { GetSystemDirectoryW(system_dir.as_mut_ptr(), system_dir.len() as u32) }
                    as usize;
            if length > 0 && length < system_dir.len() {
                candidates.push(
                    PathBuf::from(OsString::from_wide(&system_dir[..length])).join("nvml.dll"),
                );
            }
            let mut program_files = [0u16; 260];
            // CSIDL_PROGRAM_FILES / SHGFP_TYPE_CURRENT. On this x64 application
            // the Windows known folder is the native Program Files directory.
            // Do not trust PATH, working directory or environment overrides.
            if unsafe {
                SHGetFolderPathW(
                    ptr::null_mut(),
                    0x26,
                    ptr::null_mut(),
                    0,
                    program_files.as_mut_ptr(),
                )
            } == 0
            {
                if let Some(length) = program_files.iter().position(|&ch| ch == 0) {
                    if length > 0 {
                        candidates.push(
                            PathBuf::from(OsString::from_wide(&program_files[..length]))
                                .join("NVIDIA Corporation")
                                .join("NVSMI")
                                .join("nvml.dll"),
                        );
                    }
                }
            }
            for path in candidates {
                if !path.is_absolute() {
                    continue;
                }
                let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
                // LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32:
                // dependencies also cannot be substituted via the current dir.
                let handle =
                    unsafe { LoadLibraryExW(path.as_ptr(), ptr::null_mut(), 0x100 | 0x800) };
                if !handle.is_null() {
                    return Ok(Self(handle));
                }
            }
            Err("NVIDIA monitoring unavailable (NVML driver library not found)".into())
        }

        fn symbol(&self, name: &'static [u8]) -> Option<*mut c_void> {
            debug_assert_eq!(name.last(), Some(&0));
            // SAFETY: all names are static nul-terminated ASCII and self owns
            // a live library handle throughout every use of its exports.
            let address = unsafe { GetProcAddress(self.0, name.as_ptr()) };
            (!address.is_null()).then_some(address)
        }
    }

    impl Drop for Library {
        fn drop(&mut self) {
            // SAFETY: uniquely owned handle, released after NVML shutdown.
            unsafe { FreeLibrary(self.0) };
        }
    }

    type Device = *mut c_void;
    type Init = unsafe extern "C" fn() -> i32;
    type Count = unsafe extern "C" fn(*mut u32) -> i32;
    type Handle = unsafe extern "C" fn(u32, *mut Device) -> i32;
    type Name = unsafe extern "C" fn(Device, *mut c_char, u32) -> i32;
    type Engine = unsafe extern "C" fn(Device, *mut u32, *mut u32) -> i32;
    type Utilization = unsafe extern "C" fn(Device, *mut NvmlUtilization) -> i32;
    type Memory = unsafe extern "C" fn(Device, *mut NvmlMemory) -> i32;

    #[repr(C)]
    #[derive(Default)]
    struct NvmlUtilization {
        gpu: u32,
        memory: u32,
    }

    #[repr(C)]
    #[derive(Default)]
    struct NvmlMemory {
        total: u64,
        free: u64,
        used: u64,
    }

    macro_rules! symbol {
        ($library:expr, $name:literal, $signature:ty) => {
            $library
                .symbol(concat!($name, "\0").as_bytes())
                .map(|address| {
                    // SAFETY: named documented NVML export has exactly this C ABI;
                    // the owning Library outlives its function pointers.
                    unsafe { std::mem::transmute::<*mut c_void, $signature>(address) }
                })
        };
    }

    struct Nvml {
        _library: Library,
        shutdown: Init,
        count: Count,
        handle: Handle,
        name: Option<Name>,
        encoder: Option<Engine>,
        decoder: Option<Engine>,
        utilization: Option<Utilization>,
        memory: Option<Memory>,
    }

    impl Nvml {
        fn new() -> Result<Self, String> {
            let library = Library::open()?;
            let missing = || "NVIDIA monitoring unavailable (NVML exports missing)".to_string();
            let init = symbol!(library, "nvmlInit_v2", Init).ok_or_else(missing)?;
            let shutdown = symbol!(library, "nvmlShutdown", Init).ok_or_else(missing)?;
            let count = symbol!(library, "nvmlDeviceGetCount_v2", Count).ok_or_else(missing)?;
            let handle =
                symbol!(library, "nvmlDeviceGetHandleByIndex_v2", Handle).ok_or_else(missing)?;
            let name = symbol!(library, "nvmlDeviceGetName", Name);
            let encoder = symbol!(library, "nvmlDeviceGetEncoderUtilization", Engine);
            let decoder = symbol!(library, "nvmlDeviceGetDecoderUtilization", Engine);
            let utilization = symbol!(library, "nvmlDeviceGetUtilizationRates", Utilization);
            let memory = symbol!(library, "nvmlDeviceGetMemoryInfo", Memory);
            // SAFETY: documented C ABI, no input pointers, library stays owned.
            let status = unsafe { init() };
            if status != 0 {
                return Err(format!(
                    "NVIDIA monitoring unavailable (NVML init status {status})"
                ));
            }
            Ok(Self {
                _library: library,
                shutdown,
                count,
                handle,
                name,
                encoder,
                decoder,
                utilization,
                memory,
            })
        }

        fn sample(&self) -> Result<GpuSample, String> {
            let mut count = 0;
            // SAFETY: NVML successfully initialized; output pointers are valid.
            if unsafe { (self.count)(&mut count) } != 0 || count == 0 {
                return Err("NVIDIA monitoring unavailable (no accessible device)".into());
            }
            if count != 1 {
                // The renderer does not explicitly bind an NVML UUID. Choosing
                // index 0 or aggregating unrelated GPUs could claim headroom on
                // the wrong device, so do not use GPU load for admission here.
                return Err(
                    "NVIDIA monitoring unavailable for automatic multi-GPU selection".into(),
                );
            }
            let mut device = ptr::null_mut();
            if unsafe { (self.handle)(0, &mut device) } != 0 || device.is_null() {
                return Err("NVIDIA monitoring unavailable (device inaccessible)".into());
            }
            let mut gpu = GpuSample {
                name: "NVIDIA GPU".into(),
                ..GpuSample::default()
            };
            if let Some(query) = self.name {
                let mut buffer = [0u8; 128];
                if unsafe { query(device, buffer.as_mut_ptr().cast(), buffer.len() as u32) } == 0 {
                    if let Some(end) = buffer.iter().position(|&value| value == 0) {
                        let name = String::from_utf8_lossy(&buffer[..end]).trim().to_string();
                        if !name.is_empty() {
                            gpu.name = name;
                        }
                    }
                }
            }
            gpu.encoder_percent = self.engine(self.encoder, device);
            gpu.decoder_percent = self.engine(self.decoder, device);
            if let Some(query) = self.utilization {
                let mut utilization = NvmlUtilization::default();
                if unsafe { query(device, &mut utilization) } == 0 {
                    gpu.compute_percent = percentage(f64::from(utilization.gpu));
                }
            }
            if let Some(query) = self.memory {
                let mut memory = NvmlMemory::default();
                if unsafe { query(device, &mut memory) } == 0 {
                    (gpu.memory_free_bytes, gpu.memory_total_bytes) =
                        memory_values(memory.free, memory.total);
                }
            }
            Ok(gpu)
        }

        fn engine(&self, query: Option<Engine>, device: Device) -> Option<f64> {
            let mut value = 0;
            let mut period = 0;
            // Missing function and every non-success status remain unknown.
            if unsafe { query?(device, &mut value, &mut period) } == 0 {
                percentage(f64::from(value))
            } else {
                None
            }
        }
    }

    impl Drop for Nvml {
        fn drop(&mut self) {
            // SAFETY: successful init is paired once; called before Library is
            // unloaded, on the same owning thread, after all queries finish.
            unsafe { (self.shutdown)() };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_delta_includes_idle_only_once() {
        let before = CpuTicks {
            idle: 100,
            kernel: 200,
            user: 300,
        };
        let after = CpuTicks {
            idle: 150,
            kernel: 300,
            user: 400,
        };
        assert_eq!(cpu_delta(before, after), Some(75.0));
        assert_eq!(cpu_delta(before, before), None);
        assert_eq!(cpu_delta(after, before), None);
    }

    #[test]
    fn cpu_delta_rejects_impossible_or_overflowed_counters() {
        let zero = CpuTicks {
            idle: 0,
            kernel: 0,
            user: 0,
        };
        assert_eq!(
            cpu_delta(
                zero,
                CpuTicks {
                    idle: 11,
                    kernel: 10,
                    user: 0
                }
            ),
            None
        );
        assert_eq!(
            cpu_delta(
                zero,
                CpuTicks {
                    idle: 0,
                    kernel: u64::MAX,
                    user: 1
                }
            ),
            None
        );
        assert_eq!(
            cpu_delta(
                zero,
                CpuTicks {
                    idle: 0,
                    kernel: 1,
                    user: 0
                }
            ),
            Some(100.0)
        );
        assert_eq!(
            cpu_delta(
                zero,
                CpuTicks {
                    idle: 1,
                    kernel: 1,
                    user: 0
                }
            ),
            Some(0.0)
        );
    }

    #[test]
    fn first_and_stale_cpu_intervals_are_unknown() {
        let now = Instant::now();
        let before = CpuTicks {
            idle: 100,
            kernel: 200,
            user: 300,
        };
        let after = CpuTicks {
            idle: 150,
            kernel: 300,
            user: 400,
        };
        assert_eq!(cpu_interval(None, after, now), None);
        assert_eq!(
            cpu_interval(Some((now, before)), after, now + SAMPLE_INTERVAL),
            Some(75.0)
        );
        assert_eq!(
            cpu_interval(
                Some((now, before)),
                after,
                now + MAX_SAMPLE_AGE + Duration::from_secs(1)
            ),
            None
        );
    }

    #[test]
    fn counters_never_turn_unsupported_values_into_zero() {
        for invalid in [-1.0, 101.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(percentage(invalid), None);
        }
        assert_eq!(percentage(0.0), Some(0.0));
        assert_eq!(percentage(100.0), Some(100.0));
        assert_eq!(memory_values(0, 16), (Some(0), Some(16)));
        assert_eq!(memory_values(17, 16), (None, None));
        assert_eq!(memory_values(0, 0), (None, None));
    }

    #[test]
    fn cache_expires_all_counters_and_rate_limits_requests() {
        let now = Instant::now();
        let mut cache = Cache::default();
        assert!(cache.request_due(now));
        assert_eq!(cache.snapshot(now).cpu_percent, None);
        cache.requested_at = Some(now);
        cache.collected_at = Some(now);
        cache.value.cpu_percent = Some(40.0);
        cache.value.available_memory_bytes = Some(4096);
        cache.value.gpu = Some(GpuSample {
            encoder_percent: Some(70.0),
            ..GpuSample::default()
        });
        assert!(!cache.request_due(now + Duration::from_secs(1)));
        assert!(cache.request_due(now + SAMPLE_INTERVAL));
        assert_eq!(
            cache.snapshot(now + SAMPLE_INTERVAL).cpu_percent,
            Some(40.0)
        );
        let stale = cache.snapshot(now + MAX_SAMPLE_AGE + Duration::from_millis(1));
        assert_eq!(stale.cpu_percent, None);
        assert_eq!(stale.available_memory_bytes, None);
        assert!(stale.gpu.is_none());
        assert!(stale.note.contains("stale"));
    }

    #[test]
    fn blocked_collector_does_not_block_sample_or_grow_request_queue() {
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let collector = Collector::start(move || {
            let _ = started_tx.send(());
            let _ = release_rx.recv();
            HardwareSample {
                cpu_percent: Some(42.0),
                ..HardwareSample::default()
            }
        })
        .unwrap();
        assert_eq!(collector.sample().cpu_percent, None);
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(collector.sample().cpu_percent, None);
        assert!(collector.requests.try_send(()).is_ok());
        assert!(matches!(
            collector.requests.try_send(()),
            Err(mpsc::TrySendError::Full(_))
        ));
        // Disconnecting release also releases a possible second queued probe.
        drop(release_tx);
    }

    #[test]
    fn inaccessible_cache_is_a_nonblocking_unknown_sample() {
        let collector = Collector::start(HardwareSample::default).unwrap();
        let _guard = collector.cache.lock().unwrap();
        let sample = collector.sample();
        assert!(sample.cpu_percent.is_none());
        assert!(sample.note.contains("unavailable"));
    }

    #[test]
    fn default_serialization_preserves_unknown_counters() {
        let value = serde_json::to_value(HardwareSample::default()).unwrap();
        assert!(value["cpu_percent"].is_null());
        assert!(value["gpu"].is_null());
    }
}
