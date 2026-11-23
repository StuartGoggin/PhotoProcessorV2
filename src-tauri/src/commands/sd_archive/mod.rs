//! Durable card snapshots projected into the shared Jobs tracker.
mod checkpoints;
mod copy;
mod inventory;
pub(crate) mod library;
mod maintenance;
mod metadata;
mod reuse;
#[cfg(test)]
mod tests;

use super::{
    google_photos::store, import_devices, import_sessions, lightbox_trash::safety, process::ProcessJob,
    process_runtime, settings,
};
use chrono::{NaiveDate, Utc};
use inventory::{DateEvidence, Inventory};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

const KIND: process_runtime::Kind = process_runtime::Kind::SdCardArchive;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    token: Option<String>,
    source: String,
    label: String,
    repository: Option<String>,
    card_reference: String,
    files: usize,
    directories: usize,
    total_bytes: u64,
    available_bytes: Option<u64>,
    repository_issue: Option<String>,
    proposed_date: Option<DateEvidence>,
    recovery: Option<Recovery>,
}

#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Recovery {
    job_id: String,
    completed: bool,
}

struct Inspection {
    preview: Preview,
    media_id: String,
    inventory: Inventory,
    at: Instant,
}

fn inspections() -> &'static Mutex<HashMap<String, Inspection>> {
    static PLANS: OnceLock<Mutex<HashMap<String, Inspection>>> = OnceLock::new();
    PLANS.get_or_init(Mutex::default)
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Output {
    name: String,
    digest: String,
    date: DateEvidence,
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadStats {
    reader_queue_wait_ms: u64,
    verification_worker_ms: u64,
    peak_files_in_flight: usize,
    verifier_count: usize,
}

#[derive(Clone, Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub mode: String,
    pub label: String,
    pub phase: String,
    pub total_bytes: u64,
    pub copied_bytes: u64,
    pub verified_bytes: u64,
    pub files_copied: usize,
    pub files_verified: usize,
    #[serde(default)]
    pub files_reused: usize,
    #[serde(default)]
    pub files_repaired: usize,
    pub source_mbps: Option<f64>,
    pub sustained_mbps: Option<f64>,
    pub eta_seconds: Option<f64>,
    pub bottleneck: Option<String>,
    pub archive_folder: Option<String>,
    pub checksum_file: Option<String>,
    date: Option<DateEvidence>,
    pub timestamp_warnings: usize,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub strict_metadata: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reuse_proof: Option<reuse::Proof>,
    pub needs_date: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    verify_card_on_recovery: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArchiveJob {
    version: u8,
    id: String,
    mode: String,
    source: String,
    media_id: Option<String>,
    repository: String,
    card_reference: String,
    date_override: Option<NaiveDate>,
    output: Option<Output>,
    completed_folder: Option<String>,
    created_at: String,
    started_at: Option<String>,
    finished_at: Option<String>,
    status: String,
    files: usize,
    summary: Summary,
    logs: Vec<String>,
    errors: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    maintenance: Option<maintenance::Maintenance>,
}

struct Progress {
    source: PathBuf,
    total_files: usize,
    data: Mutex<Live>,
}

struct Live {
    summary: Summary,
    last_file: String,
    first_read: Option<Instant>,
    last_read: Option<Instant>,
    window_at: Instant,
    bytes_read: u64,
    window_bytes: u64,
    copy_elapsed: Duration,
    stats: ReadStats,
}

impl Progress {
    fn new(job: &ArchiveJob) -> Self {
        let mut summary = job.summary.clone();
        summary.phase = "Scanning".into();
        summary.copied_bytes = 0;
        summary.verified_bytes = 0;
        summary.files_copied = 0;
        summary.files_verified = 0;
        summary.files_reused = 0;
        summary.files_repaired = 0;
        summary.needs_date = false;
        summary.source_mbps = None;
        summary.sustained_mbps = None;
        summary.eta_seconds = None;
        summary.bottleneck = None;
        summary.timestamp_warnings = 0;
        summary.strict_metadata = false;
        if job.mode == reuse::MODE {
            summary.reuse_proof = Some(reuse::Proof::new(&job.card_reference));
        }
        Self {
            source: PathBuf::from(&job.source),
            total_files: job.files,
            data: Mutex::new(Live {
                summary,
                last_file: String::new(),
                first_read: None,
                last_read: None,
                window_at: Instant::now(),
                bytes_read: 0,
                window_bytes: 0,
                copy_elapsed: Duration::ZERO,
                stats: ReadStats::default(),
            }),
        }
    }

    fn update(&self, action: impl FnOnce(&mut Live)) {
        action(&mut self.data.lock().unwrap_or_else(|e| e.into_inner()));
    }

    fn phase(&self, phase: &str) {
        self.update(|data| {
            data.summary.phase = phase.into();
            if phase != "Copying" {
                data.summary.source_mbps = None;
            }
        });
    }

    fn date(&self, date: &DateEvidence) {
        self.update(|data| data.summary.date = Some(date.clone()));
    }

    fn current_file(&self, name: &str) {
        self.update(|data| {
            data.last_file = name.into();
            if data.first_read.is_none() {
                let now = Instant::now();
                data.first_read = Some(now);
                data.window_at = now;
            }
        });
    }

    fn read(&self, bytes: u64) {
        self.update(|data| {
            let at = Instant::now();
            if data.first_read.is_none() {
                data.window_at = at;
            }
            data.first_read.get_or_insert(at);
            data.last_read = Some(at);
            data.bytes_read += bytes;
            data.summary.copied_bytes += bytes;
            data.window_bytes += bytes;
            let seconds = at.duration_since(data.window_at).as_secs_f64();
            if seconds >= 0.75 {
                data.summary.source_mbps = Some(data.window_bytes as f64 / seconds / 1048576.0);
                data.window_at = at;
                data.window_bytes = 0;
            }
        });
    }

    fn copied(&self, name: &str, elapsed: Duration) {
        self.update(|data| {
            data.last_file = name.into();
            data.summary.files_copied += 1;
            data.copy_elapsed += elapsed;
            if data.summary.files_copied == self.total_files {
                data.summary.phase = "Verifying".into();
                data.summary.source_mbps = None;
            }
        });
    }

    fn verified(&self, name: &str, bytes: u64) {
        self.update(|data| {
            data.last_file = name.into();
            data.summary.verified_bytes += bytes;
            data.summary.files_verified += 1;
        });
    }

    fn timestamp_warnings(&self, count: usize) {
        self.update(|data| data.summary.timestamp_warnings += count);
    }

    fn metadata_verified(&self, strict: bool) {
        self.update(|data| data.summary.strict_metadata = strict);
    }

    fn recovered(&self, reused: bool, repaired: bool) {
        self.update(|data| {
            data.summary.files_reused += usize::from(reused);
            data.summary.files_repaired += usize::from(repaired);
        });
    }

    fn stats(&self, stats: ReadStats) {
        self.update(|data| {
            let elapsed_ms = data
                .copy_elapsed
                .as_millis()
                .saturating_add(stats.reader_queue_wait_ms as u128);
            if stats.reader_queue_wait_ms >= 500
                && elapsed_ms > 0
                && stats.reader_queue_wait_ms as u128 * 8 >= elapsed_ms
            {
                data.summary.bottleneck =
                    Some("The card reader spent time waiting for destination verification.".into());
            }
            data.stats = stats;
        });
    }

    fn has_pending_verification(&self) -> bool {
        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        data.summary.files_copied > data.summary.files_verified
    }

    fn snapshot(&self) -> (Summary, String, ReadStats) {
        let data = self.data.lock().unwrap_or_else(|e| e.into_inner());
        let mut summary = data.summary.clone();
        if data
            .last_read
            .is_some_and(|at| at.elapsed() > Duration::from_secs(2))
        {
            summary.source_mbps = None;
            if summary.phase == "Copying" && summary.files_copied > summary.files_verified {
                summary.bottleneck = Some("Destination verification is catching up.".into());
            }
        }
        if let (Some(first), Some(last)) = (data.first_read, data.last_read) {
            let seconds = last.duration_since(first).as_secs_f64();
            if seconds >= 0.75 {
                let rate = data.bytes_read as f64 / seconds;
                summary.sustained_mbps = Some(rate / 1048576.0);
                if summary.phase == "Copying" && summary.source_mbps.is_some() && rate > 0.0 {
                    summary.eta_seconds =
                        Some(summary.total_bytes.saturating_sub(data.bytes_read) as f64 / rate);
                }
            }
        }
        (summary, data.last_file.clone(), data.stats.clone())
    }
}

fn active_progress() -> &'static Mutex<HashMap<String, Arc<Progress>>> {
    static ACTIVE: OnceLock<Mutex<HashMap<String, Arc<Progress>>>> = OnceLock::new();
    ACTIVE.get_or_init(Mutex::default)
}

fn new_id() -> Result<String, String> {
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "Cannot allocate an archive identity.")?;
    Ok(format!("sd_archive_{}", hex::encode(random)))
}

pub(super) fn is_job(id: &str) -> bool {
    id.strip_prefix("sd_archive_")
        .is_some_and(|suffix| suffix.len() == 32 && suffix.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn job_root(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("sd-card-archives");
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    inventory::root(&path)
}

fn job_path(directory: &Path, id: &str) -> Result<PathBuf, String> {
    if !is_job(id) {
        return Err("Invalid SD Card Archive job reference.".into());
    }
    Ok(directory.join(format!("{id}.json")))
}

fn load(directory: &Path, id: &str) -> Result<ArchiveJob, String> {
    let bytes = store::read_bounded(&job_path(directory, id)?, 64 * 1024)?
        .ok_or("Saved archive job was not found.")?;
    let job: ArchiveJob =
        serde_json::from_slice(&bytes).map_err(|_| "Saved archive job is unreadable.")?;
    let mode_matches = matches!(
        (job.mode.as_str(), &job.maintenance),
        ("archive" | "verify" | reuse::MODE, None)
            | ("upgrade", Some(maintenance::Maintenance::Upgrade { .. }))
            | ("remove", Some(maintenance::Maintenance::Remove { .. }))
    );
    if job.version != 1 || job.id != id || !mode_matches {
        return Err("Saved archive job has an unsupported identity.".into());
    }
    Ok(job)
}

fn save(directory: &Path, job: &ArchiveJob) -> Result<(), String> {
    let bytes = serde_json::to_vec(job).map_err(|e| e.to_string())?;
    store::atomic_write(&job_path(directory, &job.id)?, &bytes)
        .map_err(|e| format!("Could not save the SD Card Archive checkpoint: {e}"))
}

fn saved_job_ids(directory: &Path) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    for item in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let item = item.map_err(|error| error.to_string())?;
        if let Some(id) = item.file_name().to_str().and_then(|name| name.strip_suffix(".json")).filter(|id| is_job(id)) {
            ids.push(id.into());
        }
    }
    Ok(ids)
}

fn find_recovery(
    directory: &Path,
    repository: &Path,
    media_id: &str,
    inventory: &Inventory,
) -> Result<Option<Recovery>, String> {
    let mut draft = None;
    let mut completed = Vec::new();
    let scope = import_sessions::scope_key(repository);
    let total_bytes = inventory.bytes();
    for id in saved_job_ids(directory)? {
        let Ok(job) = load(directory, &id) else { continue };
        if job.mode != "archive" || job.media_id.as_deref() != Some(media_id)
            || import_sessions::scope_key(Path::new(&job.repository)) != scope
            || job.files != inventory.files.len() || job.summary.total_bytes != total_bytes {
            continue;
        }
        if job.status == "completed" {
            if job.completed_folder.is_some() {
                completed.push(job);
            }
        } else {
            let path = copy::work_dir(repository, &id);
            if !path.try_exists().map_err(|error| error.to_string())? { continue; }
            let work = inventory::root(&path)?;
            if copy::load_inventory(&work)?.same_tree(inventory) {
                if draft.is_some() {
                    return Err("More than one draft matches this card. Open Jobs and resume the intended archive.".into());
                }
                draft = Some(Recovery { job_id: id, completed: false });
            }
        }
    }
    if draft.is_some() { return Ok(draft); }
    completed.sort_unstable_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.id.cmp(&a.id)));
    for job in completed {
        let output = job.output.as_ref().ok_or("A matching saved archive has no checksum receipt.")?;
        let path = inventory::relative_path(repository, &output.name, false)?;
        if !path.try_exists().map_err(|error| error.to_string())? { continue; }
        let (manifest, digest) = inventory::load_manifest(&inventory::root(&path)?, &output.name)?;
        if digest != output.digest || manifest.archive_id != job.id {
            return Err("An existing archive's checksum receipt changed. Check it in Jobs before continuing.".into());
        }
        if manifest.matches_card(inventory) {
            return Ok(Some(Recovery { job_id: job.id, completed: true }));
        }
    }
    Ok(None)
}

fn operation_log_entry(job: &ArchiveJob, message: &str) -> String {
    format!(
        "sd_card_archive job_id='{}' mode={} {}",
        job.id,
        job.mode,
        message.replace(['\r', '\n'], " "),
    )
}

fn log_operation(app: &AppHandle, job: &ArchiveJob, message: impl AsRef<str>) {
    if let Err(error) = crate::utils::append_app_log(app, operation_log_entry(job, message.as_ref())) {
        log::warn!("Could not write the operations log for SD Card Archive job {}: {error}", job.id);
    }
}

fn project(job: &ArchiveJob, running: bool) -> Result<ProcessJob, String> {
    let progress = active_progress()
        .lock()
        .map_err(|_| "Archive progress is unavailable.")?
        .get(&job.id)
        .cloned();
    let (summary, file) = progress
        .map(|progress| {
            let (summary, file, _) = progress.snapshot();
            (summary, file)
        })
        .unwrap_or_else(|| (job.summary.clone(), String::new()));
    let interrupted = !running && matches!(job.status.as_str(), "queued" | "running");
    let status = if interrupted {
        "needs_attention"
    } else {
        &job.status
    };
    let phase = if interrupted {
        "Interrupted. Retry to recheck the saved files."
    } else {
        &summary.phase
    };
    serde_json::from_value(serde_json::json!({
        "id":job.id, "task":"sdCardArchive", "stagingDir":job.source, "scopeDir":job.source,
        "scopeMode":"folderRecursive", "status":status, "createdAt":job.created_at, "startedAt":job.started_at,
        "finishedAt":job.finished_at, "total":summary.reuse_proof.as_ref().and_then(|proof| proof.card.as_ref()).map_or(job.files, |side| side.files), "done":summary.files_verified,
        "processed":summary.files_copied, "resultCount":summary.files_verified, "currentFile":file,
        "archiveDir":job.repository, "currentPhase":phase, "speedMbps":summary.source_mbps,
        "statusLine":phase, "pauseRequested":false, "abortRequested":false,
        "errors":job.errors, "logs":job.logs, "canContinue":!summary.needs_date, "sdCardArchive":summary
    })).map_err(|e| format!("Could not display the SD Card Archive job: {e}"))
}

pub(super) fn snapshot(app: &AppHandle) -> Result<(Vec<ProcessJob>, Vec<String>), String> {
    let directory = job_root(app)?;
    let active = process_runtime::active(KIND)?;
    let mut jobs = Vec::new();
    let mut warnings = Vec::new();
    for id in saved_job_ids(&directory)? {
        match load(&directory, &id).and_then(|job| project(&job, active.contains(&id)))
        {
            Ok(job) => jobs.push(job),
            Err(_) => warnings.push("A saved SD Card Archive job could not be read.".into()),
        }
    }
    Ok((jobs, warnings))
}

fn validate_volume(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;
        let bytes = path.as_bytes();
        if bytes.len() != 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || !matches!(bytes[2], b'\\' | b'/')
        {
            return Err("Select the root of the mounted SD card, for example E:\\.".into());
        }
        let wide = Path::new(path)
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        if !matches!(unsafe { GetDriveTypeW(wide.as_ptr()) }, 2 | 3) {
            return Err("The selected source must be a local mounted volume.".into());
        }
        if std::env::var("SystemDrive").is_ok_and(|drive| path[..2].eq_ignore_ascii_case(&drive)) {
            return Err("Choose the mounted card rather than the Windows system drive.".into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err("SD Card Archive currently requires Windows volume identification.".into())
    }
}

fn resolve_repository(
    configured: &str,
    source: &Path,
    identity: &import_devices::SourceIdentity,
) -> Result<PathBuf, String> {
    if configured.trim().is_empty() {
        return Err("Choose an SD Card Repository before starting the archive.".into());
    }
    let repository = inventory::root(Path::new(configured))
        .map_err(|error| format!("Cannot open the SD Card Repository: {error}"))?;
    if repository.starts_with(source)
        || import_devices::resolve(&repository)
            .ok()
            .is_some_and(|target| target.media_id == identity.media_id)
    {
        return Err("Choose a repository on a different volume from the card.".into());
    }
    Ok(repository)
}

fn card_reference(media_id: &str) -> String {
    if cfg!(windows) {
        if let Some((_, serial)) = media_id.rsplit_once(':') {
            if serial.len() == 8 && serial.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return serial.to_ascii_uppercase();
            }
        }
    }
    hex::encode_upper(&Sha256::digest(media_id.as_bytes())[..4])
}

fn inspect(app: &AppHandle, selected: &str) -> Result<Preview, String> {
    validate_volume(selected)?;
    let source = inventory::root(Path::new(selected))?;
    let identity = import_devices::resolve(&source)?;
    let repository = settings::load_settings(app.clone())
        .and_then(|config| resolve_repository(&config.sd_card_repository, &source, &identity));
    let scope = repository.as_deref().unwrap_or(&source);
    let mut ticket = copy::acquire_source(&source, scope, &identity)?;
    let _permit = ticket
        .try_acquire()?
        .map_err(|message| message.to_string())?;
    let _reader = import_devices::try_reader_lease(app, &identity)?
        .ok_or("Another PhotoGoGo job is using this card reader.")?;
    let inventory = inventory::scan(&source, || false)?;
    copy::source_identity(&source, &identity.media_id)?;
    let (repository, available_bytes, repository_issue) = match repository.and_then(|path| {
        fs2::available_space(&path)
            .map(|available| (path, available))
            .map_err(|error| format!("Cannot check repository free space: {error}"))
    }) {
        Ok((path, available)) => (Some(path.to_string_lossy().into_owned()), Some(available), None),
        Err(error) => (None, None, Some(error)),
    };
    let card_reference = card_reference(&identity.media_id);
    let recovery = repository.as_deref().map(|path| {
        find_recovery(&job_root(app)?, Path::new(path), &identity.media_id, &inventory)
    }).transpose()?.flatten();
    let preview = Preview {
        token: repository.as_ref().map(|_| new_id()).transpose()?,
        source: source.to_string_lossy().into_owned(),
        label: identity.label,
        repository,
        card_reference,
        files: inventory.files.len(),
        directories: inventory.directories.len(),
        total_bytes: inventory.bytes(),
        available_bytes,
        repository_issue,
        proposed_date: inventory::proposed_date(&inventory),
        recovery,
    };
    let Some(token) = &preview.token else {
        return Ok(preview);
    };
    let mut plans = inspections()
        .lock()
        .map_err(|_| "Card inspection state unavailable.")?;
    plans.retain(|_, plan| plan.at.elapsed() < Duration::from_secs(900));
    if plans.len() >= 4 {
        if let Some(oldest) = plans
            .iter()
            .min_by_key(|(_, plan)| plan.at)
            .map(|(key, _)| key.clone())
        {
            plans.remove(&oldest);
        }
    }
    plans.insert(
        token.clone(),
        Inspection {
            preview: preview.clone(),
            media_id: identity.media_id,
            inventory,
            at: Instant::now(),
        },
    );
    Ok(preview)
}

fn launch(app: AppHandle, directory: PathBuf, mut job: ArchiveJob) -> Result<ProcessJob, String> {
    let worker_lock = safety::metadata_lock(&directory, &format!("{}.worker.lock", job.id))?;
    let worker = process_runtime::register(KIND, &job.id)?;
    job.status = "queued".into();
    job.finished_at = None;
    job.errors.clear();
    job.summary.phase = "Queued".into();
    if job.mode == reuse::MODE {
        job.summary.reuse_proof = Some(reuse::Proof::new(&job.card_reference));
    }
    save(&directory, &job)?;
    let queued = project(&job, true)?;
    log_operation(&app, &job, format!(
        "queued source={:?} repository={:?} files={} bytes={}",
        job.source, job.repository, job.files, job.summary.total_bytes,
    ));
    std::thread::Builder::new().name("photogogo-sd-archive".into()).spawn(move || {
        let _guards = (worker, worker_lock);
        let id = job.id.clone();
        let progress = Arc::new(Progress::new(&job));
        if let Ok(mut map) = active_progress().lock() { map.insert(id.clone(), progress.clone()); }
        let stopped = || process_runtime::stop_state(&id).0;
        job.started_at.get_or_insert_with(|| Utc::now().to_rfc3339());
        job.status = "running".into();
        let result = save(&directory, &job).and_then(|_| {
            log_operation(&app, &job, "started");
            if job.maintenance.is_some() {
                log_operation(&app, &job, format!("starting archive maintenance mode={}", job.mode));
                maintenance::run(&mut job, &progress, Some(&app), &directory, &stopped)
            } else if job.mode == reuse::MODE {
                log_operation(&app, &job, "phase=Comparing inserted card and repository for reuse");
                reuse::run(&app, &mut job, &progress, &stopped)
            } else if job.mode == "verify" {
                if job.media_id.is_some() {
                    log_operation(&app, &job, "phase=Comparing card and archive to saved checksums");
                    copy::reuse_completed(&mut job, &progress, Some(&app), &stopped)
                } else {
                    log_operation(&app, &job, "phase=Verifying");
                    verify_existing(&mut job, &progress, &stopped)
                }
            } else {
                let config = settings::load_settings(app.clone())?;
                let tool = super::metadata_tools::resolve(&config.exiftool_dir).0;
                copy::archive(&mut job, &progress, &tool, Some(&app), &stopped, |state| save(&directory, state))
            }
        });
        let (summary, _, stats) = progress.snapshot();
        job.summary = summary;
        if let Some(proof) = &mut job.summary.reuse_proof {
            proof.stage = reuse::Stage::Report;
        }
        let first_new_log = job.logs.len();
        match result {
            Ok(()) => {
                job.status = "completed".into();
                job.summary.phase = match job.mode.as_str() {
                    "remove" => "Removed",
                    reuse::MODE => "Card and repository matched",
                    _ => "Verified",
                }.into();
                job.summary.date = job.output.as_ref().map(|output| output.date.clone()).or(job.summary.date);
                if let (Some(folder), Some(output)) = (&job.completed_folder, &job.output) {
                    job.summary.archive_folder = Some(folder.clone());
                    job.summary.checksum_file = Some(Path::new(folder).join(inventory::manifest_name(&output.name)).to_string_lossy().into_owned());
                }
                job.logs.push(format!("Verified {} files and {} bytes.", job.summary.files_verified, job.summary.verified_bytes));
            }
            Err(error) if stopped() => {
                let abort = process_runtime::stop_state(&id).1;
                job.status = if abort { "aborted" } else { "paused" }.into();
                job.summary.phase = if abort && job.mode == reuse::MODE { "Reuse check cancelled" } else if abort { "Cancelled. Draft retained" } else { "Paused at a safe checkpoint" }.into();
                job.logs.push(error);
            }
            Err(error) => {
                job.status = "needs_attention".into();
                job.summary.phase = if job.maintenance.is_some() { "Archive maintenance incomplete" } else { "Verification incomplete" }.into();
                job.summary.needs_date = error.starts_with("No reliable capture date");
                job.errors.push(error);
            }
        }
        job.summary.source_mbps = None;
        job.summary.eta_seconds = None;
        job.finished_at = Some(Utc::now().to_rfc3339());
        if job.mode == "archive" || job.mode == "verify" && job.media_id.is_some() {
            let summary = &job.summary;
            job.logs.push(format!("Checksum checkpoints: reused {}, copied {}, repaired {}.", summary.files_reused,
                summary.files_verified.saturating_sub(summary.files_reused + summary.files_repaired), summary.files_repaired));
        }
        if job.mode == "archive" {
            job.logs.push(format!("Reader queue wait {} ms. Verification worker time {} ms. Peak in-flight files {}. Verification workers {}.",
                stats.reader_queue_wait_ms, stats.verification_worker_ms, stats.peak_files_in_flight, stats.verifier_count));
        }
        log_operation(&app, &job, format!("finished status={} phase={:?}", job.status, job.summary.phase));
        for line in &job.logs[first_new_log..] {
            log_operation(&app, &job, line);
        }
        for error in &job.errors {
            log_operation(&app, &job, format!("error: {error}"));
        }
        if job.logs.len() > 32 { job.logs.drain(..job.logs.len() - 32); }
        match save(&directory, &job) {
            Ok(()) if job.mode == "archive" && job.status == "completed" => copy::retire_finished_draft(&job),
            Ok(()) if job.maintenance.is_some() && job.status == "completed" => maintenance::retire(&job),
            Ok(()) => {},
            Err(error) => {
                log::error!("{error}");
                log_operation(&app, &job, format!("checkpoint_error: {error}"));
            }
        }
        if let Ok(mut map) = active_progress().lock() { map.remove(&id); }
    }).map_err(|e| format!("Could not start the archive worker. The saved job can be retried: {e}"))?;
    Ok(queued)
}

fn verify_existing(
    job: &mut ArchiveJob,
    progress: &Progress,
    stopped: &impl Fn() -> bool,
) -> Result<(), String> {
    let path = inventory::root(Path::new(&job.source))?;
    let output = job
        .output
        .as_ref()
        .ok_or("Verification has no saved checksum receipt.")?;
    progress.phase("Verifying");
    let receipt = inventory::verify(
        &path,
        &output.name,
        Some(&output.digest),
        |name, bytes| progress.verified(name, bytes),
        stopped,
    )?;
    progress.metadata_verified(receipt.version == metadata::STRICT_VERSION);
    job.completed_folder = Some(path.to_string_lossy().into_owned());
    Ok(())
}

fn start(
    app: AppHandle,
    token: &str,
    date_override: Option<NaiveDate>,
    new_snapshot: bool,
    replace_folder: Option<&str>,
) -> Result<ProcessJob, String> {
    let plan = inspections()
        .lock()
        .map_err(|_| "Card inspection is unavailable.")?
        .remove(token)
        .filter(|inspection| inspection.at.elapsed() < Duration::from_secs(900))
        .ok_or("Inspect the card again before starting the archive.")?;
    let preview = plan.preview;
    let saved_repository = preview.repository.ok_or("Inspect the card with a valid SD Card Repository first.")?;
    let repository = inventory::root(Path::new(&saved_repository))?;
    let config = settings::load_settings(app.clone())?;
    if repository != inventory::root(Path::new(&config.sd_card_repository))? {
        return Err("The SD Card Repository changed. Inspect the card again.".into());
    }
    copy::source_identity(Path::new(&preview.source), &plan.media_id)?;
    let directory = job_root(&app)?;
    let _start_lock = safety::metadata_lock(&directory, "archive-start.lock")
        .map_err(|_| "Another archive is being started. Try again shortly.")?;
    if let Some(folder) = replace_folder {
        let _maintenance_lock = maintenance::lock_repository(&repository)?;
        maintenance::validate_recreation(&directory, &repository, folder, &plan.media_id, &plan.inventory)?;
    }
    let new_snapshot = new_snapshot || replace_folder.is_some();
    let recovery = find_recovery(&directory, &repository, &plan.media_id, &plan.inventory)?;
    if recovery != preview.recovery {
        return Err("A matching archive changed since inspection. Inspect the card again.".into());
    }
    if let Some(recovery) = recovery {
        // Exclude a still-running worker even across app instances. The start
        // lock also serializes with Resume from the Jobs page.
        let _worker = safety::metadata_lock(&directory, &format!("{}.worker.lock", recovery.job_id))
            .map_err(|_| "This card already has an active archive. Open it in Jobs.")?;
        let mut existing = load(&directory, &recovery.job_id)?;
        if (existing.status == "completed") != recovery.completed {
            return Err("The saved archive changed. Inspect the card again.".into());
        }
        if !new_snapshot {
            if recovery.completed {
                existing.id = new_id()?;
                existing.mode = "verify".into();
                existing.summary.mode = "verify".into();
                existing.summary.archive_folder = None;
                existing.summary.checksum_file = None;
                existing.completed_folder = None;
                existing.created_at = Utc::now().to_rfc3339();
                existing.started_at = None;
                existing.logs.clear();
            } else if existing.output.is_none() {
                existing.date_override = date_override.or(existing.date_override);
            }
            if existing.summary.needs_date && existing.date_override.is_none() {
                return Err("Enter an archive date before resuming this archive.".into());
            }
            existing.source = preview.source;
            existing.summary.label = preview.label;
            existing.summary.verify_card_on_recovery = true;
            drop(_worker);
            return launch(app, directory, existing);
        }
    }
    let free = fs2::available_space(&repository).map_err(|e| e.to_string())?;
    if free <= preview.total_bytes {
        return Err("The repository has insufficient free space for the complete card.".into());
    }
    let id = new_id()?;
    copy::initialize(&repository, &id, &plan.inventory)?;
    let job = ArchiveJob {
        version: 1,
        id,
        mode: "archive".into(),
        source: preview.source,
        media_id: Some(plan.media_id),
        repository: saved_repository,
        card_reference: preview.card_reference,
        date_override,
        output: None,
        completed_folder: None,
        created_at: Utc::now().to_rfc3339(),
        started_at: None,
        finished_at: None,
        status: "queued".into(),
        files: preview.files,
        summary: Summary {
            mode: "archive".into(),
            label: preview.label,
            phase: "Queued".into(),
            total_bytes: preview.total_bytes,
            date: preview.proposed_date,
            ..Summary::default()
        },
        logs: Vec::new(),
        errors: Vec::new(),
        maintenance: None,
    };
    launch(app, directory, job)
}

fn queue_verify(
    app: AppHandle,
    folder: Option<String>,
    archive_job_id: Option<String>,
) -> Result<ProcessJob, String> {
    let directory = job_root(&app)?;
    let previous = archive_job_id
        .as_deref()
        .map(|id| load(&directory, id))
        .transpose()?;
    let path = if let Some(job) = &previous {
        inventory::root(Path::new(
            job.completed_folder
                .as_deref()
                .ok_or("Choose a completed archive.")?,
        ))?
    } else {
        inventory::root(Path::new(
            folder.as_deref().ok_or("Choose an archive folder.")?,
        ))?
    };
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("Choose a named archive folder.")?;
    let (manifest, digest) = inventory::load_manifest(&path, name)?;
    if previous
        .as_ref()
        .and_then(|job| job.output.as_ref())
        .is_some_and(|output| output.digest != digest)
    {
        return Err("The archive checksum file changed since publication.".into());
    }
    let job = ArchiveJob {
        version: 1,
        id: new_id()?,
        mode: "verify".into(),
        source: path.to_string_lossy().into_owned(),
        media_id: None,
        repository: path
            .parent()
            .unwrap_or(&path)
            .to_string_lossy()
            .into_owned(),
        card_reference: manifest.card_reference,
        date_override: None,
        output: Some(Output {
            name: name.into(),
            digest,
            date: manifest.date.clone(),
        }),
        completed_folder: None,
        created_at: Utc::now().to_rfc3339(),
        started_at: None,
        finished_at: None,
        status: "queued".into(),
        files: manifest.file_count,
        summary: Summary {
            mode: "verify".into(),
            label: name.into(),
            phase: "Queued".into(),
            total_bytes: manifest.bytes,
            date: Some(manifest.date),
            ..Summary::default()
        },
        logs: vec![],
        errors: vec![],
        maintenance: None,
    };
    launch(app, directory, job)
}

pub(super) fn control(app: AppHandle, id: &str, action: &str) -> Result<bool, String> {
    let directory = job_root(&app)?;
    let mut job = load(&directory, id)?;
    if job.status == "completed" {
        return Ok(false);
    }
    match action {
        "pause" | "abort" => {
            log_operation(&app, &job, format!("{action} requested"));
            if !process_runtime::request_stop(id, action == "abort")? {
                let _lock = safety::metadata_lock(&directory, &format!("{id}.worker.lock"))?;
                job = load(&directory, id)?;
                if job.status == "completed" {
                    return Ok(false);
                }
                job.status = if action == "abort" {
                    "aborted"
                } else {
                    "paused"
                }
                .into();
                save(&directory, &job)?;
                log_operation(&app, &job, format!("status={}", job.status));
            }
        }
        "resume" | "retry" => {
            let _start_lock = safety::metadata_lock(&directory, "archive-start.lock")
                .map_err(|_| "Another archive is being started. Try again shortly.")?;
            job = load(&directory, id)?;
            if job.status == "completed" { return Ok(false); }
            if job.summary.needs_date && job.date_override.is_none() {
                return Err("Enter an archive date before retrying this job.".into());
            }
            log_operation(&app, &job, format!("{action} requested"));
            launch(app, directory, job)?;
        }
        _ => return Err("Unsupported archive job action.".into()),
    }
    Ok(true)
}

pub(super) fn diagnostics(app: &AppHandle, id: &str) -> Result<String, String> {
    let job = load(&job_root(app)?, id)?;
    Ok(job
        .logs
        .iter()
        .chain(&job.errors)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n"))
}

async fn blocking<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(job)
        .await
        .map_err(|_| "The SD Card Archive operation did not finish.")?
}

#[tauri::command]
pub async fn list_sd_archive_sources() -> Result<Vec<import_devices::ArchiveSource>, String> {
    blocking(import_devices::archive_sources).await
}

#[tauri::command]
pub async fn scan_sd_card_archive(app: AppHandle, source: String) -> Result<Preview, String> {
    blocking(move || inspect(&app, &source)).await
}

#[tauri::command]
pub async fn start_sd_card_archive(
    app: AppHandle,
    token: String,
    date_override: Option<NaiveDate>,
    new_snapshot: Option<bool>,
    replace_folder: Option<String>,
) -> Result<ProcessJob, String> {
    blocking(move || start(app, &token, date_override, new_snapshot.unwrap_or(false), replace_folder.as_deref())).await
}

#[tauri::command]
pub async fn review_sd_archive_upgrade(
    app: AppHandle,
    folder: String,
    source: Option<String>,
) -> Result<maintenance::UpgradeReview, String> {
    blocking(move || maintenance::review(&app, &folder, source.as_deref())).await
}

#[tauri::command]
pub async fn start_sd_archive_upgrade(app: AppHandle, token: String) -> Result<ProcessJob, String> {
    blocking(move || maintenance::queue_upgrade(app, &token)).await
}

#[tauri::command]
pub async fn remove_sd_archive_after_recreation(
    app: AppHandle,
    folder: String,
    replacement: String,
    confirmation: String,
) -> Result<ProcessJob, String> {
    blocking(move || maintenance::queue_remove(app, &folder, &replacement, &confirmation)).await
}

#[tauri::command]
pub async fn verify_sd_card_archive(
    app: AppHandle,
    folder: Option<String>,
    archive_job_id: Option<String>,
) -> Result<ProcessJob, String> {
    blocking(move || queue_verify(app, folder, archive_job_id)).await
}

#[tauri::command]
pub async fn verify_sd_card_for_reuse(
    app: AppHandle,
    source: String,
    folder: Option<String>,
) -> Result<ProcessJob, String> {
    blocking(move || reuse::queue(app, &source, folder.as_deref())).await
}

#[tauri::command]
pub async fn confirm_sd_card_reuse(app: AppHandle, job_id: String) -> Result<(), String> {
    blocking(move || reuse::confirm_manual(&app, &job_id)).await
}

#[tauri::command]
pub async fn set_sd_card_archive_date(
    app: AppHandle,
    job_id: String,
    date: NaiveDate,
) -> Result<(), String> {
    blocking(move || {
        let directory = job_root(&app)?;
        if !is_job(&job_id) {
            return Err("Invalid SD Card Archive job reference.".into());
        }
        let _lock = safety::metadata_lock(&directory, &format!("{job_id}.worker.lock"))?;
        let mut job = load(&directory, &job_id)?;
        if job.mode != "archive" || job.status != "needs_attention" || !job.summary.needs_date {
            return Err("This job is not waiting for a date.".into());
        }
        job.date_override = Some(date);
        job.summary.needs_date = false;
        save(&directory, &job)
    })
    .await
}
