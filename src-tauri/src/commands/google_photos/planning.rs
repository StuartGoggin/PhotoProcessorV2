//! Request-scoped, cancellable local inspection. Progress contains counts only;
//! fingerprints never survive their read-lock session or enter browser storage.
use super::{catalogue, metadata, model::*, plan};
use serde::Serialize;
use std::{
    collections::{BTreeMap, HashMap},
    fs::File,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

const MAX_INSPECTIONS: usize = 16;
const MAX_LOCKED_SOURCES: usize = 1024;
const CANCELLED: &str = "Local photo inspection cancelled. No upload plan was saved.";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InspectionProgress {
    inspection_id: String,
    phase: String,
    completed: usize,
    total: usize,
    bytes_read: u64,
    fingerprint_reads: u64,
    reused_fingerprints: u64,
    elapsed_ms: u64,
    cancelled: bool,
}
struct State {
    progress: Mutex<InspectionProgress>,
    cancelled: AtomicBool,
    bytes: AtomicU64,
    reads: AtomicU64,
    reused: AtomicU64,
    started: Instant,
    commit: Mutex<()>,
}
fn inspections() -> &'static Mutex<BTreeMap<String, Arc<State>>> {
    static STORE: OnceLock<Mutex<BTreeMap<String, Arc<State>>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(BTreeMap::new()))
}
fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err("Invalid local inspection reference.".into());
    }
    Ok(())
}
pub(super) struct InspectionRun {
    state: Arc<State>,
}
fn new_state(id: &str) -> Arc<State> {
    Arc::new(State {
        progress: Mutex::new(InspectionProgress {
            inspection_id: id.into(),
            phase: "starting".into(),
            completed: 0,
            total: 0,
            bytes_read: 0,
            fingerprint_reads: 0,
            reused_fingerprints: 0,
            elapsed_ms: 0,
            cancelled: false,
        }),
        cancelled: AtomicBool::new(false),
        bytes: AtomicU64::new(0),
        reads: AtomicU64::new(0),
        reused: AtomicU64::new(0),
        started: Instant::now(),
        commit: Mutex::new(()),
    })
}
fn unacknowledged_cancel(state: &State) -> bool {
    state
        .progress
        .lock()
        .map(|p| p.phase == "cancelled_before_start")
        .unwrap_or(true)
}
fn make_room(store: &mut BTreeMap<String, Arc<State>>) -> Result<(), String> {
    store.retain(|_, s| {
        s.started.elapsed() < Duration::from_secs(300)
            || Arc::strong_count(s) > 1
            || unacknowledged_cancel(s)
    });
    if store.len() >= MAX_INSPECTIONS {
        let oldest = store
            .iter()
            .filter(|(_, s)| Arc::strong_count(s) == 1 && !unacknowledged_cancel(s))
            .max_by_key(|(_, s)| s.started.elapsed())
            .map(|(key, _)| key.clone());
        if let Some(key) = oldest {
            store.remove(&key);
        }
    }
    if store.len() >= MAX_INSPECTIONS {
        return Err("Too many local inspections are active. Let earlier stop requests finish before starting another review.".into());
    }
    Ok(())
}
pub(super) fn begin(id: &str) -> Result<InspectionRun, String> {
    valid_id(id)?;
    let mut store = inspections()
        .lock()
        .map_err(|_| "Local inspection progress is unavailable.")?;
    if let Some(existing) = store.get(id) {
        if unacknowledged_cancel(existing) {
            if let Ok(mut p) = existing.progress.lock() {
                p.phase = "cancelled".into();
            }
            return Err(CANCELLED.into());
        }
        return Err(
            "This local inspection reference was already used. Start a fresh review.".into(),
        );
    }
    make_room(&mut store)?;
    let state = new_state(id);
    store.insert(id.into(), state.clone());
    Ok(InspectionRun { state })
}
pub(super) fn snapshot(id: &str) -> Result<Option<InspectionProgress>, String> {
    valid_id(id)?;
    let state = inspections()
        .lock()
        .map_err(|_| "Local inspection progress is unavailable.")?
        .get(id)
        .cloned();
    state
        .map(|s| {
            let mut result = s
                .progress
                .lock()
                .map_err(|_| "Local inspection progress is unavailable.")?
                .clone();
            result.bytes_read = s.bytes.load(Ordering::Relaxed);
            result.fingerprint_reads = s.reads.load(Ordering::Relaxed);
            result.reused_fingerprints = s.reused.load(Ordering::Relaxed);
            result.elapsed_ms = s.started.elapsed().as_millis().min(u64::MAX as u128) as u64;
            result.cancelled = s.cancelled.load(Ordering::Acquire);
            Ok(result)
        })
        .transpose()
}
pub(super) fn cancel(id: &str) -> Result<bool, String> {
    valid_id(id)?;
    let state = {
        let mut store = inspections()
            .lock()
            .map_err(|_| "Local inspection progress is unavailable.")?;
        if let Some(state) = store.get(id) {
            state.clone()
        } else {
            // Cancellation may beat the queued native worker. Keep this intent
            // until begin acknowledges it; do not expire/evict it into work.
            make_room(&mut store)?;
            let state = new_state(id);
            state.cancelled.store(true, Ordering::Release);
            state
                .progress
                .lock()
                .map_err(|_| "Local inspection progress is unavailable.")?
                .phase = "cancelled_before_start".into();
            store.insert(id.into(), state);
            return Ok(true);
        }
    };
    let _guard = state
        .commit
        .lock()
        .map_err(|_| "Local inspection cancellation is unavailable.")?;
    if state
        .progress
        .lock()
        .map_err(|_| "Local inspection progress is unavailable.")?
        .phase
        == "complete"
    {
        return Ok(false);
    }
    state.cancelled.store(true, Ordering::Release);
    Ok(true)
}
impl InspectionRun {
    pub(super) fn checkpoint(&self) -> Result<(), String> {
        if self.state.cancelled.load(Ordering::Acquire) {
            return Err(CANCELLED.into());
        }
        Ok(())
    }
    fn progress(&self, phase: &str, completed: usize, total: usize) {
        if let Ok(mut p) = self.state.progress.lock() {
            p.phase = phase.into();
            p.completed = completed;
            p.total = total;
        }
    }
    /// Cancellation and final persistence share this gate. A cancellation that
    /// returns true before commit prevents creation of a usable frozen plan.
    pub(super) fn commit<T>(&self, save: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let _guard = self
            .state
            .commit
            .lock()
            .map_err(|_| "Local inspection could not be finalized.")?;
        self.checkpoint()?;
        let result = save()?;
        if let Ok(mut p) = self.state.progress.lock() {
            p.phase = "complete".into();
        }
        Ok(result)
    }
}
impl Drop for InspectionRun {
    fn drop(&mut self) {
        if let Ok(mut p) = self.state.progress.lock() {
            if p.phase != "complete" {
                p.phase = if self.state.cancelled.load(Ordering::Acquire) {
                    "cancelled"
                } else {
                    "stopped"
                }
                .into();
            }
        }
    }
}

type Fingerprint = (String, u64, u64);
struct LockedSource {
    file: File,
    before: std::fs::Metadata,
    fingerprint: Fingerprint,
}
struct SourceSession<'a> {
    run: &'a InspectionRun,
    locked: HashMap<PathBuf, LockedSource>,
    cache_limit: usize,
}
fn same_identity(before: &std::fs::Metadata, after: &std::fs::Metadata) -> bool {
    let same = before.is_file()
        && after.is_file()
        && before.len() == after.len()
        && before.modified().ok() == after.modified().ok();
    same
}
#[cfg(windows)]
fn file_identity(file: &File) -> Result<(u32, u32, u32), String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err("Cannot verify a photo's file identity.".into());
    }
    Ok((
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
    ))
}
fn matches_current(source: &LockedSource, path: &Path) -> Result<bool, String> {
    let current = plan::open_fingerprint(path)?;
    let metadata = current
        .metadata()
        .map_err(|_| "Cannot recheck a photo.".to_string())?;
    let held = source
        .file
        .metadata()
        .map_err(|_| "Cannot recheck a held photo.".to_string())?;
    let same = same_identity(&source.before, &metadata) && same_identity(&source.before, &held);
    #[cfg(windows)]
    {
        return Ok(same && file_identity(&source.file)? == file_identity(&current)?);
    }
    #[cfg(not(windows))]
    {
        Ok(same)
    }
}
impl<'a> SourceSession<'a> {
    fn new(run: &'a InspectionRun) -> Self {
        Self {
            run,
            locked: HashMap::new(),
            cache_limit: MAX_LOCKED_SOURCES,
        }
    }
    fn fingerprint(&mut self, path: &Path) -> Result<Fingerprint, String> {
        self.run.checkpoint()?;
        super::store::reject_link(path)?;
        let canonical = path
            .canonicalize()
            .map_err(|_| "A photo disappeared during inspection.")?;
        #[cfg(windows)]
        if let Some(existing) = self.locked.get(&canonical) {
            if !matches_current(existing, path)? {
                return Err("A photo changed during inspection. Refresh the plan.".into());
            }
            self.run.state.reused.fetch_add(1, Ordering::Relaxed);
            return Ok(existing.fingerprint.clone());
        }
        let mut file = plan::open_fingerprint(path)?;
        let before = file
            .metadata()
            .map_err(|_| "A photo cannot be inspected.")?;
        self.run.state.reads.fetch_add(1, Ordering::Relaxed);
        let result = plan::fingerprint_reader(&mut file, &|| self.run.checkpoint(), &|bytes| {
            self.run.state.bytes.fetch_add(bytes, Ordering::Relaxed);
        })?;
        #[cfg(windows)]
        if self.locked.len() < self.cache_limit {
            self.locked.insert(
                canonical,
                LockedSource {
                    file,
                    before,
                    fingerprint: result.clone(),
                },
            );
        }
        #[cfg(not(windows))]
        {
            let _ = (canonical, before);
        }
        Ok(result)
    }
    fn validate_current(&self) -> Result<(), String> {
        self.run.checkpoint()?;
        for (path, source) in &self.locked {
            self.run.checkpoint()?;
            super::store::reject_link(path)?;
            if !matches_current(source, path)? {
                return Err("A photo changed during inspection. Refresh the plan.".into());
            }
        }
        Ok(())
    }
}

pub(super) struct InspectedPlan {
    pub(super) plan: PlanPreview,
    pub(super) original_hashes: Vec<(String, String)>,
    // Keep Windows write/rename-denying handles alive until the caller saves
    // FrozenPlan. No byte buffers or reusable cross-request cache are retained.
    _locked: HashMap<PathBuf, LockedSource>,
}
pub(super) fn inspect(
    request: &PlanRequest,
    context: &PlanContext,
    tool_dir: &str,
    run: &InspectionRun,
) -> Result<InspectedPlan, String> {
    run.checkpoint()?;
    run.progress("discovering", 0, 0);
    let catalogue = catalogue::scan_for_plan(
        Path::new(&request.root),
        request.scope_dir.as_deref(),
        &|| run.checkpoint(),
        &|count| run.progress("discovering", count, 0),
    )?;
    let mut sources = SourceSession::new(run);
    let mut result = plan::build_with(
        &catalogue,
        request,
        context,
        &mut |path| sources.fingerprint(path),
        &|| run.checkpoint(),
        &|done, total| run.progress("fingerprinting", done, total),
    )?;
    run.checkpoint()?;
    run.progress("checking", 0, result.items.len());
    let tool_available = if result.items.iter().any(metadata::needs_tool) {
        metadata::check_tool(tool_dir)
    } else {
        true
    };
    let mut originals = BTreeMap::new();
    let mut original_dates = HashMap::<PathBuf, Option<String>>::new();
    let total = result.items.len();
    for (index, item) in result.items.iter_mut().enumerate() {
        run.checkpoint()?;
        if matches!(item.status, PlanItemStatus::Ready | PlanItemStatus::Changed) {
            let ext = Path::new(&item.path)
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            let blocked = if !matches!(ext.as_str(), "jpg" | "jpeg" | "png")
                || (metadata::needs_tool(item) && ext == "png")
            {
                item.status = PlanItemStatus::Unsupported;
                Some("This release validates full-resolution JPEG and unmodified PNG uploads. Metadata/GPS-safe copies require JPEG; no silent format conversion is performed.".to_string())
            } else if metadata::needs_tool(item) && !tool_available {
                Some("Check the metadata tool in Settings. Clear a broken custom override to use bundled ExifTool, or repair the installation. It is needed to restore capture-date/colour metadata or remove GPS in an upload-only copy; your original is never modified.".to_string())
            } else {
                metadata::validate_item(item).err()
            };
            if let Some(error) = blocked {
                if item.status != PlanItemStatus::Unsupported {
                    item.status = PlanItemStatus::Blocked;
                }
                item.warnings.push(error);
            } else {
                let origin = Path::new(&item.original_path);
                let canonical = origin
                    .canonicalize()
                    .map_err(|_| "The original metadata lineage is unavailable.")?;
                // Only SourceSession may reuse a digest: it retains the exact
                // Windows file guard. Exhausted budgets/non-Windows reread.
                let checked = sources.fingerprint(origin).map(|(hash, _, _)| hash);
                match &checked {
                    Ok(hash) if *hash == item.original_sha256 => {
                        originals.insert(item.original_path.clone(), hash.clone());
                    }
                    Ok(_) => {
                        item.status = PlanItemStatus::Blocked;
                        item.warnings.push("The original metadata lineage changed during planning. Refresh and review a fresh plan.".into());
                    }
                    Err(error) => {
                        item.status = PlanItemStatus::Blocked;
                        item.warnings.push(format!(
                            "Original metadata lineage cannot be verified: {error}"
                        ));
                    }
                }
                if metadata::capture_date(Path::new(&item.path))
                    .or_else(|| {
                        if sources.locked.contains_key(&canonical) {
                            original_dates
                                .entry(canonical)
                                .or_insert_with(|| metadata::capture_date(origin))
                                .clone()
                        } else {
                            metadata::capture_date(origin)
                        }
                    })
                    .is_none()
                {
                    item.warnings.push("No embedded capture time could be verified. Google may use the upload time. The event date names the album only; it does not change the photo's capture time.".into());
                }
            }
        }
        run.progress("checking", index + 1, total);
    }
    sources.validate_current()?;
    result.total_bytes = result
        .items
        .iter()
        .filter(|i| matches!(i.status, PlanItemStatus::Ready | PlanItemStatus::Changed))
        .map(|i| i.bytes)
        .sum();
    if result.items.iter().any(|i| {
        matches!(
            i.status,
            PlanItemStatus::Unsupported | PlanItemStatus::Blocked
        )
    }) {
        result.warnings.push("Blocked/unsupported versions will be excluded, not uploaded at reduced quality. Review all warnings and the final counts.".into());
    }
    run.checkpoint()?;
    Ok(InspectedPlan {
        plan: result,
        original_hashes: originals.into_iter().collect(),
        _locked: sources.locked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, sync::atomic::AtomicUsize};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn id() -> String {
        format!(
            "inspection-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        )
    }
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(id());
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
        fn jpeg(&self, name: &str, padded: usize) {
            let path = self.0.join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            let mut bytes = Vec::new();
            image::codecs::jpeg::JpegEncoder::new(&mut bytes)
                .encode_image(&image::DynamicImage::ImageRgb8(image::RgbImage::new(
                    40, 60,
                )))
                .unwrap();
            bytes.resize(bytes.len().max(padded), 0);
            fs::write(path, bytes).unwrap();
        }
        fn request(&self) -> PlanRequest {
            PlanRequest {
                root: self.0.to_string_lossy().into_owned(),
                mode: SelectionMode::Originals,
                ..Default::default()
            }
        }
        fn context() -> PlanContext {
            PlanContext {
                id: "P".repeat(43),
                account_id: "synthetic-account".into(),
                account_email: "test@example.test".into(),
                ..Default::default()
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn cancellation_before_native_worker_begins_is_not_lost() {
        let key = id();
        assert!(
            cancel(&key).unwrap(),
            "A dispatched but not-yet-started inspection must accept its stop intent"
        );
        assert!(begin(&key).err().unwrap().contains("cancelled"));
        assert!(snapshot(&key).unwrap().unwrap().cancelled);
    }
    #[test]
    fn cancellation_is_a_barrier_before_frozen_plan_persistence() {
        let key = id();
        let run = begin(&key).unwrap();
        let saved = AtomicBool::new(false);
        assert!(cancel(&key).unwrap());
        let error = run
            .commit(|| {
                saved.store(true, Ordering::Relaxed);
                Ok(())
            })
            .unwrap_err();
        assert!(error.contains("cancelled"));
        assert!(!saved.load(Ordering::Relaxed));
        assert!(run.checkpoint().is_err());
        assert!(snapshot(&key).unwrap().unwrap().cancelled);
    }
    #[test]
    fn completed_commit_refuses_a_late_cancel_and_ids_never_replace_active_work() {
        let key = id();
        let run = begin(&key).unwrap();
        assert!(begin(&key).is_err());
        run.commit(|| Ok(())).unwrap();
        assert!(!cancel(&key).unwrap());
        assert_eq!(snapshot(&key).unwrap().unwrap().phase, "complete");
        assert!(begin("../private-path").is_err());
        assert!(snapshot("bad/reference").is_err());
    }
    #[test]
    fn scoped_discovery_is_recursive_and_keeps_full_library_identity() {
        let fixture = Fixture::new();
        fixture.jpeg("selected/nested/one.jpg", 0);
        fixture.jpeg("outside/two.jpg", 0);
        let mut visited = 0usize;
        let count = std::cell::Cell::new(0);
        let scoped =
            catalogue::scan_for_plan(&fixture.0, Some("selected"), &|| Ok(()), &|n| count.set(n))
                .unwrap();
        visited += count.get();
        let full = catalogue::scan(&fixture.0).unwrap();
        assert_eq!(scoped.assets.len(), 1);
        assert_eq!(scoped.assets[0].relative_path, "selected/nested/one.jpg");
        let matching = full
            .assets
            .iter()
            .find(|a| a.relative_path == scoped.assets[0].relative_path)
            .unwrap();
        assert_eq!(matching.id, scoped.assets[0].id);
        assert_eq!(matching.original_path, scoped.assets[0].original_path);
        assert_eq!(scoped.root, full.root);
        assert!(
            visited <= 4,
            "An unrelated event subtree must not be walked"
        );
        assert!(
            catalogue::scan_for_plan(&fixture.0, Some("../outside"), &|| Ok(()), &|_| {}).is_err()
        );
    }
    #[test]
    fn scan_and_hash_are_cancellable_without_finished_plan() {
        let fixture = Fixture::new();
        fixture.jpeg("one.jpg", 1024 * 1024);
        let key = id();
        let run = begin(&key).unwrap();
        let checks = AtomicUsize::new(0);
        let error = catalogue::scan_for_plan(
            &fixture.0,
            None,
            &|| {
                if checks.fetch_add(1, Ordering::Relaxed) > 0 {
                    return Err("synthetic stop".into());
                }
                Ok(())
            },
            &|_| {},
        )
        .unwrap_err();
        assert_eq!(error, "synthetic stop");
        let mut file = plan::open_fingerprint(&fixture.0.join("one.jpg")).unwrap();
        let chunks = AtomicUsize::new(0);
        let error = plan::fingerprint_reader(
            &mut file,
            &|| {
                if chunks.load(Ordering::Relaxed) > 0 {
                    return Err("synthetic hash stop".into());
                }
                Ok(())
            },
            &|_| {
                chunks.fetch_add(1, Ordering::Relaxed);
            },
        )
        .unwrap_err();
        assert_eq!(error, "synthetic hash stop");
        assert_eq!(chunks.load(Ordering::Relaxed), 1);
        assert_eq!(snapshot(&key).unwrap().unwrap().fingerprint_reads, 0);
        assert!(cancel(&key).unwrap());
        assert!(inspect(&fixture.request(), &Fixture::context(), "", &run).is_err());
    }
    #[cfg(windows)]
    #[test]
    fn fingerprint_reuse_holds_exact_source_identity_until_frozen_save() {
        let fixture = Fixture::new();
        fixture.jpeg("one.jpg", 0);
        let path = fixture.0.join("one.jpg");
        let key = id();
        let run = begin(&key).unwrap();
        let mut session = SourceSession::new(&run);
        let first = session.fingerprint(&path).unwrap();
        let second = session.fingerprint(&path).unwrap();
        assert_eq!(first, second);
        assert!(
            fs::write(&path, b"replacement").is_err(),
            "Guarded bytes cannot be changed before freeze"
        );
        assert!(
            fs::rename(&path, fixture.0.join("renamed.jpg")).is_err(),
            "Guarded path cannot be replaced before freeze"
        );
        session.validate_current().unwrap();
        assert_eq!(snapshot(&key).unwrap().unwrap().fingerprint_reads, 1);
        assert_eq!(snapshot(&key).unwrap().unwrap().reused_fingerprints, 1);
        drop(session);
        assert!(fs::write(&path, b"replacement").is_ok());
        let mut next = SourceSession::new(&run);
        assert_ne!(
            first.0,
            next.fingerprint(&path).unwrap().0,
            "New sessions never reuse old digests"
        );
    }
    #[test]
    fn exhausted_guard_budget_rereads_changed_original_bytes() {
        let fixture = Fixture::new();
        fixture.jpeg("one.jpg", 0);
        let path = fixture.0.join("one.jpg");
        let key = id();
        let run = begin(&key).unwrap();
        let mut session = SourceSession::new(&run);
        session.cache_limit = 0; // Exercise the production exhausted-budget branch.
        let first = session.fingerprint(&path).unwrap();
        assert!(session.locked.is_empty());
        fs::write(&path, b"changed original bytes").unwrap();
        let second = session.fingerprint(&path).unwrap();
        assert_ne!(first.0, second.0);
        let progress = snapshot(&key).unwrap().unwrap();
        assert_eq!(progress.fingerprint_reads, 2);
        assert_eq!(progress.reused_fingerprints, 0);
    }
    #[cfg(windows)]
    #[test]
    fn inspection_benchmark_halves_repeated_fingerprint_bytes_for_originals() {
        let fixture = Fixture::new();
        for name in ["one.jpg", "two.jpg", "three.jpg"] {
            fixture.jpeg(name, 1024 * 1024);
        }
        let request = fixture.request();
        let context = Fixture::context();
        let catalogue = catalogue::scan(&fixture.0).unwrap();
        let before = Instant::now();
        let legacy = plan::build(&catalogue, &request, &context).unwrap();
        for item in &legacy.items {
            assert_eq!(
                metadata::hash_file(Path::new(&item.original_path)).unwrap(),
                item.original_sha256
            );
        }
        let legacy_ms = before.elapsed().as_secs_f64() * 1000.;
        let key = id();
        let run = begin(&key).unwrap();
        let before = Instant::now();
        let inspected = inspect(&request, &context, "", &run).unwrap();
        let new_ms = before.elapsed().as_secs_f64() * 1000.;
        let progress = snapshot(&key).unwrap().unwrap();
        assert_eq!(progress.fingerprint_reads, 3);
        assert_eq!(progress.bytes_read, 3 * 1024 * 1024);
        assert_eq!(progress.reused_fingerprints, 3);
        assert_eq!(inspected.plan.items.len(), legacy.items.len());
        assert_eq!(inspected.plan.total_bytes, legacy.total_bytes);
        for (old, new) in legacy.items.iter().zip(&inspected.plan.items) {
            assert_eq!(old.id, new.id);
            assert_eq!(old.source_sha256, new.source_sha256);
            assert_eq!(old.original_sha256, new.original_sha256);
            assert_eq!(old.status, new.status);
        }
        assert_eq!(inspected.original_hashes.len(), 3);
        println!("INSPECTION_BENCHMARK {{\"photos\":3,\"legacyFingerprintBytes\":6291456,\"newFingerprintBytes\":{},\"legacyMs\":{:.3},\"newMs\":{:.3},\"scope\":\"synthetic warm-cache local payload hashing; not target-PC disk throughput\"}}",progress.bytes_read,legacy_ms,new_ms);
    }
}
