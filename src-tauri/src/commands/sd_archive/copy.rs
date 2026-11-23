use super::{checkpoints, inventory::*, metadata, ArchiveJob, Output, Progress, ReadStats};
use crate::commands::{
    archive_adaptive, google_photos::store, import, import_devices, import_pipeline, import_safety,
    import_scheduler, import_sessions,
};
use chrono::Utc;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Condvar, Mutex,
    },
    time::{Duration, Instant},
};

const MIB: u64 = 1024 * 1024;
const METADATA_RECEIPT: &str = "metadata-verified.txt";

struct Verifiers {
    started: Instant,
    state: Mutex<VerificationState>,
    available: Condvar,
}

struct VerificationState {
    controller: archive_adaptive::Controller,
    active: usize,
    bytes: u64,
    completed: u64,
}

impl Verifiers {
    fn new(maximum: usize) -> Self {
        Self {
            started: Instant::now(),
            state: Mutex::new(VerificationState {
                controller: archive_adaptive::Controller::new(
                    archive_adaptive::Mode::Auto,
                    maximum,
                ),
                active: 0,
                bytes: 0,
                completed: 0,
            }),
            available: Condvar::new(),
        }
    }

    fn begin(&self, stopped: impl Fn() -> bool) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        while state.active >= state.controller.limit() {
            if stopped() {
                return false;
            }
            state = self
                .available
                .wait_timeout(state, Duration::from_millis(100))
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
        if stopped() {
            return false;
        }
        state.active += 1;
        true
    }

    fn end(&self, verified: Option<u64>, buffered: bool) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let saturated = buffered && state.active >= state.controller.limit();
        state.active -= 1;
        state.bytes += verified.unwrap_or(0);
        state.completed += u64::from(verified.is_some());
        let (bytes, completed) = (state.bytes, state.completed);
        state.controller.observe(
            self.started.elapsed(),
            bytes,
            completed,
            saturated,
            verified.is_none(),
        );
        self.available.notify_all();
    }

    fn limit(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .controller
            .limit()
    }
}

pub(super) fn acquire_source(
    source: &Path,
    repository: &Path,
    identity: &import_devices::SourceIdentity,
) -> Result<import_scheduler::Ticket, String> {
    import::import_scheduler().queue(import_scheduler::Request {
        devices: identity.lanes.clone(),
        known: identity.certain,
        staging: import_sessions::scope_key(repository),
        source: import_sessions::scope_key(source),
        exclusive: false,
    })
}

pub(super) fn source_identity(
    source: &Path,
    media_id: &str,
) -> Result<import_devices::SourceIdentity, String> {
    let identity = import_devices::resolve(source)?;
    if identity.media_id != media_id {
        return Err("The selected card was removed or replaced. Reinsert the original card before retrying.".into());
    }
    Ok(identity)
}

pub(super) fn wait_for_reader(
    source: &Path,
    repository: &Path,
    identity: &import_devices::SourceIdentity,
    app: Option<&tauri::AppHandle>,
    stopped: &impl Fn() -> bool,
) -> Result<(import_scheduler::Permit, Vec<fs::File>), String> {
    let mut ticket = acquire_source(source, repository, identity)?;
    loop {
        if stopped() {
            return Err("Stopped at a safe checkpoint.".into());
        }
        if let Ok(permit) = ticket.try_acquire()? {
            let lease = match app {
                Some(app) => import_devices::try_reader_lease(app, identity)?,
                None => Some(Vec::new()),
            };
            if let Some(lease) = lease {
                return Ok((permit, lease));
            }
            drop(permit);
            ticket = acquire_source(source, repository, identity)?;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

pub(super) fn reuse_completed(
    job: &mut ArchiveJob,
    progress: &Progress,
    app: Option<&tauri::AppHandle>,
    stopped: &impl Fn() -> bool,
) -> Result<(), String> {
    let source = root(Path::new(&job.source))?;
    let repository = root(Path::new(&job.repository))?;
    let media_id = job
        .media_id
        .as_deref()
        .ok_or("Saved card identity is missing.")?;
    let output = job
        .output
        .as_ref()
        .ok_or("The saved archive has no checksum receipt.")?;
    let target = root(&relative_path(&repository, &output.name, false)?)?;
    let identity = source_identity(&source, media_id)?;
    progress.phase("Waiting for the card reader");
    let _reader = wait_for_reader(&source, &repository, &identity, app, stopped)?;
    progress.phase("Checking card checksums");
    let (manifest, digest) = load_manifest(&target, &output.name)?;
    if digest != output.digest || (job.mode == "archive" && manifest.archive_id != job.id) {
        return Err("The saved archive's checksum file changed since publication.".into());
    }
    let inventory = scan(&source, stopped)?;
    if !manifest.matches_card(&inventory) {
        return Err("The card inventory changed. Inspect it again for a new snapshot.".into());
    }
    for (name, receipt) in &manifest.files {
        progress.current_file(name);
        let path = relative_path(&source, name, true)?;
        if hash_file(&path, stopped)? != receipt.sha256 {
            return Err(format!("The card checksum differs from the saved archive: {name}. Inspect the card and choose a new snapshot if the change is intentional."));
        }
    }
    progress.phase("Verifying");
    verify(
        &target,
        &output.name,
        Some(&output.digest),
        |name, bytes| {
            progress.recovered(true, false);
            progress.verified(name, bytes);
        },
        stopped,
    )?;
    ensure_source_unchanged(&source, media_id, &inventory, stopped)?;
    if manifest.version == metadata::STRICT_VERSION {
        inventory.check_streams(&source, stopped)?;
    }
    progress.metadata_verified(manifest.version == metadata::STRICT_VERSION);
    job.completed_folder = Some(target.to_string_lossy().into_owned());
    Ok(())
}

pub(super) fn work_dir(repository: &Path, id: &str) -> PathBuf {
    repository.join(format!(".photogogo-{id}.incomplete"))
}

pub(super) fn initialize(repository: &Path, id: &str, inventory: &Inventory) -> Result<(), String> {
    let work = work_dir(repository, id);
    fs::create_dir(&work).map_err(|e| format!("Cannot create private archive work folder: {e}"))?;
    let bytes = serde_json::to_vec(inventory).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > DOCUMENT_LIMIT {
        return Err("Card inventory exceeds the supported size.".into());
    }
    store::atomic_write(&work.join("inventory.json"), &bytes)
}

pub(super) fn load_inventory(work: &Path) -> Result<Inventory, String> {
    let bytes = store::read_bounded(&work.join("inventory.json"), DOCUMENT_LIMIT)?
        .ok_or("The saved card inventory is missing.")?;
    serde_json::from_slice(&bytes).map_err(|_| "The saved card inventory is unreadable.".into())
}

fn ensure_source_unchanged(
    source: &Path,
    media_id: &str,
    expected: &Inventory,
    stopped: &impl Fn() -> bool,
) -> Result<(), String> {
    source_identity(source, media_id)?;
    let current = scan(source, stopped)?;
    if !current.same_tree(expected) {
        return Err(
            "The card inventory changed. Inspect the card again before starting a new archive."
                .into(),
        );
    }
    expected.verify_source_metadata(&current)?;
    source_identity(source, media_id)?;
    Ok(())
}

fn clear_work(work: &Path) {
    // Only empty job-owned directories are removed. The saved inventory is small
    // and remains available as recovery evidence if cleanup is interrupted.
    let _ = fs::remove_dir(work.join("scratch").join(".photogogo-import"));
    let _ = fs::remove_dir(work.join("scratch"));
}

pub(super) fn retire_finished_draft(job: &ArchiveJob) {
    let Ok(repository) = root(Path::new(&job.repository)) else {
        return;
    };
    let Ok(work) = root(&work_dir(&repository, &job.id)) else {
        return;
    };
    if work.join("card").exists() {
        return;
    }
    clear_work(&work);
    for name in ["inventory.json", checkpoints::FILE_NAME, METADATA_RECEIPT] {
        let path = work.join(name);
        if store::reject_link(&path).is_ok() && path.is_file() {
            let _ = fs::remove_file(path);
        }
    }
    let _ = fs::remove_dir(work);
}

struct Prepared {
    name: String,
    stamp: Stamp,
    hash: String,
    staged: Option<import_safety::StagedCopy>,
    checkpointed: bool,
}

fn stage_source(
    path: &Path,
    scratch: &Path,
    bytes: u64,
    stopped: &impl Fn() -> bool,
    mut read: impl FnMut(u64),
) -> Result<(String, import_safety::StagedCopy), String> {
    let mut hash = Sha256::new();
    let staged = import_safety::stage_copy(path, scratch, bytes, |chunk| {
        if stopped() {
            return Err("Stopped at a safe checkpoint.".into());
        }
        hash.update(chunk);
        read(chunk.len() as u64);
        Ok(())
    })?;
    Ok((hex::encode(hash.finalize()), staged))
}

fn prepare(
    source: &Path,
    tree: &Path,
    scratch: &Path,
    name: &str,
    expected: &Stamp,
    checksum: Option<&str>,
    progress: &Progress,
    stopped: &impl Fn() -> bool,
) -> Result<Prepared, String> {
    let start = Instant::now();
    progress.current_file(name);
    let path = relative_path(source, name, true)?;
    let guard = guarded_read(&path)?;
    let metadata = guard.metadata().map_err(|e| e.to_string())?;
    if expected.has_attributes() {
        super::metadata::require_independent_file(&guard)
            .map_err(|error| format!("Unsupported card file {name}: {error}"))?;
    }
    if !Stamp::read(&metadata).same_file(expected) {
        return Err(format!("Card file changed since inspection: {name}"));
    }
    let existing = relative_path(tree, name, false)?;
    let (hash, staged) = if existing.try_exists().map_err(|e| e.to_string())? {
        // A published work file is a durable checkpoint. Reread its source
        // bytes after restart, including on filesystems with coarse timestamps.
        let hash = hash_file_with_progress(&path, stopped, |bytes| progress.read(bytes))?;
        (hash, None)
    } else {
        let (hash, staged) = stage_source(&path, scratch, expected.bytes, stopped, |bytes| {
            progress.read(bytes)
        })?;
        (hash, Some(staged))
    };
    if checksum.is_some_and(|expected| expected != hash) {
        return Err(format!("Card checksum changed since this archive was started: {name}. Start a new snapshot if the changes are intentional."));
    }
    if !Stamp::read(&guard.metadata().map_err(|e| e.to_string())?).same_file(expected) {
        return Err(format!("Card file changed during copy: {name}"));
    }
    progress.copied(name, start.elapsed());
    Ok(Prepared {
        name: name.into(),
        stamp: expected.clone(),
        hash,
        staged,
        checkpointed: checksum.is_some(),
    })
}

fn finish(
    prepared: Prepared,
    tree: &Path,
    work: &Path,
    journal: &Mutex<checkpoints::Checkpoints>,
    progress: &Progress,
    stopped: &impl Fn() -> bool,
) -> Result<(String, FileReceipt, Stamp), String> {
    let Prepared {
        name,
        stamp,
        hash,
        mut staged,
        checkpointed,
    } = prepared;
    let destination = relative_path(tree, &name, false)?;
    let reused = staged.is_none();
    let repaired = reused && hash_file(&destination, stopped)? != hash;
    if repaired {
        if !checkpointed {
            return Err(format!("A saved checkpoint differs from the card and has no recorded checksum: {name}. Keep the card and start a fresh archive."));
        }
        let path = relative_path(&progress.source, &name, true)?;
        let guard = guarded_read(&path)?;
        let (fresh_hash, repair) =
            stage_source(&path, &work.join("scratch"), stamp.bytes, stopped, |_| {})?;
        if fresh_hash != hash
            || !Stamp::read(&guard.metadata().map_err(|e| e.to_string())?).same_file(&stamp)
        {
            return Err(format!(
                "Card file changed while repairing the saved copy: {name}"
            ));
        }
        staged = Some(repair);
    }
    if let Some(mut staged) = staged {
        staged
            .verify(&hash, |path| hash_file(path, stopped))
            .map_err(|e| format!("Destination verification failed for {name}: {e}"))?;
        // Pin the intended bytes before the no-replace publication. Recovery
        // can then safely recopy a missing file or diagnose a damaged copy.
        journal
            .lock()
            .map_err(|_| "Checksum journal is unavailable.")?
            .record(&name, &hash)?;
        if repaired {
            let damaged = work.join("damaged");
            ensure_dir(&damaged)?;
            let preserved = damaged.join(super::new_id()?);
            import_safety::rename_new(&destination, &preserved)
                .map_err(|e| format!("Could not preserve the damaged draft file {name}: {e}"))?;
        }
        staged.publish_archive(&destination, work)?;
    } else {
        journal
            .lock()
            .map_err(|_| "Checksum journal is unavailable.")?
            .record(&name, &hash)?;
    }
    let destination_stamp =
        Stamp::read(&fs::symlink_metadata(&destination).map_err(|e| e.to_string())?);
    if destination_stamp.bytes != stamp.bytes {
        return Err(format!("Verified size changed for {name}"));
    }
    progress.recovered(reused && !repaired, repaired);
    progress.verified(&name, stamp.bytes);
    Ok((
        name,
        FileReceipt {
            stamp,
            sha256: hash,
        },
        destination_stamp,
    ))
}

fn record_archive(
    tree: &Path,
    work: &Path,
    inventory: &Inventory,
    progress: &Progress,
    separated: bool,
    stopped: &(impl Fn() -> bool + Sync),
) -> Result<(BTreeMap<String, FileReceipt>, BTreeMap<String, Stamp>), String> {
    let scratch = work.join("scratch");
    ensure_dir(&scratch)?;
    import_safety::cleanup_abandoned_staged(&scratch)?;
    let checkpoints = checkpoints::Checkpoints::open(work, inventory)?;
    let known_hashes = checkpoints.hashes.clone();
    let journal = Mutex::new(checkpoints);
    for name in &inventory.directories {
        ensure_dir(&relative_path(tree, name, false)?)?;
    }
    let source = progress.source.as_path();
    let work_failed = AtomicBool::new(false);
    let results = Mutex::new(BTreeMap::new());
    let error = Mutex::new(None);
    let record_error = |message| {
        work_failed.store(true, Ordering::Relaxed);
        let mut error = error.lock().unwrap_or_else(|lock| lock.into_inner());
        if error.is_none() {
            *error = Some(message);
        }
    };
    let entries = inventory.files.iter().collect::<Vec<_>>();
    // Keep two files available for overlap even when a video exceeds the
    // normal byte window. The bound is on I/O in flight, not file size in RAM.
    let window = if separated { 512 * MIB } else { 128 * MIB };
    let maximum_verifiers = if separated { 2 } else { 1 };
    let verifiers = Verifiers::new(maximum_verifiers);
    let stats = import_pipeline::run_weighted(
        &entries,
        |(_, stamp)| stamp.bytes.min(window / 2),
        |(name, stamp), _| {
            if stopped() || work_failed.load(Ordering::Relaxed) {
                return None;
            }
            let checksum = known_hashes.get(*name).map(String::as_str);
            match prepare(
                source, tree, &scratch, name, stamp, checksum, progress, stopped,
            ) {
                Ok(item) => Some(item),
                Err(message) => {
                    record_error(message);
                    None
                }
            }
        },
        |item| {
            if !verifiers.begin(|| stopped() || work_failed.load(Ordering::Relaxed)) {
                return;
            }
            let result = finish(item, tree, work, &journal, progress, stopped);
            let verified = result
                .as_ref()
                .ok()
                .map(|(_, receipt, _)| receipt.stamp.bytes);
            verifiers.end(verified, progress.has_pending_verification());
            match result {
                Ok((name, receipt, stamp)) => {
                    results
                        .lock()
                        .unwrap_or_else(|lock| lock.into_inner())
                        .insert(name, (receipt, stamp));
                }
                Err(message) => record_error(message),
            }
        },
        if separated { 4 } else { 2 },
        window,
        maximum_verifiers,
    )?;
    progress.stats(ReadStats {
        reader_queue_wait_ms: stats.source_wait_ms,
        verification_worker_ms: stats.destination_ms,
        peak_files_in_flight: stats.peak_files,
        verifier_count: verifiers.limit(),
    });
    if let Some(message) = error
        .into_inner()
        .map_err(|_| "Archive error state unavailable.")?
    {
        return Err(message);
    }
    let records = results
        .into_inner()
        .map_err(|_| "Archive checkpoint state unavailable.")?;
    if stopped() || records.len() != inventory.files.len() {
        return Err("Stopped at a safe checkpoint.".into());
    }
    Ok(records
        .into_iter()
        .map(|(name, (receipt, stamp))| ((name.clone(), receipt), (name, stamp)))
        .unzip())
}

pub(super) fn archive(
    job: &mut ArchiveJob,
    progress: &Progress,
    tool: &Path,
    app: Option<&tauri::AppHandle>,
    stopped: &(impl Fn() -> bool + Sync),
    mut save: impl FnMut(&ArchiveJob) -> Result<(), String>,
) -> Result<(), String> {
    let set_phase = |phase: &str| {
        progress.phase(phase);
        if let Some(app) = app {
            super::log_operation(app, job, format!("phase={phase:?}"));
        }
    };
    let repository = root(Path::new(&job.repository))?;
    let work = root(&work_dir(&repository, &job.id))?;
    let tree = work.join("card");
    if let Some(output) = &job.output {
        let published = relative_path(&repository, &output.name, false)?;
        if published.exists() && !tree.exists() {
            let published = root(&published)?;
            let (receipt, digest) = load_manifest(&published, &output.name)?;
            if receipt.archive_id != job.id || digest != output.digest {
                return Err(
                    "Published archive belongs to another job or its manifest changed.".into(),
                );
            }
            let metadata_verified = store::read_bounded(&work.join(METADATA_RECEIPT), 64)?
                .is_some_and(|bytes| bytes == output.digest.as_bytes());
            if receipt.version == metadata::STRICT_VERSION && !metadata_verified {
                // A crash between rename and metadata read-back can leave the
                // directory visible before it is verified. Resume in private.
                publish_directory(&published, &tree)?;
            } else if job.summary.verify_card_on_recovery {
                set_phase("Checking card checksums");
                return reuse_completed(job, progress, app, stopped);
            } else {
                set_phase("Verifying");
                verify(
                    &published,
                    &output.name,
                    Some(&output.digest),
                    |p, b| progress.verified(p, b),
                    stopped,
                )?;
                progress.metadata_verified(receipt.version == metadata::STRICT_VERSION);
                job.completed_folder = Some(published.to_string_lossy().into_owned());
                return Ok(());
            }
        }
    }
    let source = root(Path::new(&job.source))?;
    let media_id = job
        .media_id
        .as_deref()
        .ok_or("Saved card identity is missing.")?;
    let identity = source_identity(&source, media_id)?;
    set_phase("Waiting for the card reader");
    let _reader = wait_for_reader(&source, &repository, &identity, app, stopped)?;
    set_phase("Scanning");
    let inventory = load_inventory(&work)?;
    inventory.check_source_fields()?;
    ensure_source_unchanged(&source, media_id, &inventory, stopped)?;
    inventory.check_streams(&source, stopped)?;
    ensure_dir(&tree)?;
    let tree = root(&tree)?;
    let network = repository.to_string_lossy().starts_with(r"\\?\UNC\");
    let separated = network
        || import_devices::resolve(&repository)
            .ok()
            .is_some_and(|target| !identity.conflicts(&target));
    set_phase("Copying");
    let (receipts, stamps) =
        record_archive(&tree, &work, &inventory, progress, separated, stopped)?;
    set_phase("Verifying");
    let date = if let Some(output) = &job.output {
        output.date.clone()
    } else if let Some(date) = job.date_override {
        DateEvidence {
            date,
            basis: "Date entered by you".into(),
            file: None,
        }
    } else {
        capture_date(&tree, &inventory, tool, stopped)?
            .ok_or("No reliable capture date was found. Enter an archive date and resume.")?
    };
    progress.date(&date);
    if stopped() {
        return Err("Stopped at a safe checkpoint.".into());
    }
    if let Some(output) = &job.output {
        let name = manifest_name(&output.name);
        if relative_path(&tree, &name, false)?
            .try_exists()
            .map_err(|e| e.to_string())?
        {
            let (manifest, digest) = load_manifest(&tree, &output.name)?;
            if digest != output.digest
                || manifest.files != receipts
                || manifest.directories != inventory.directories
            {
                return Err("Prepared archive no longer matches its verified receipt.".into());
            }
        }
    }
    let output = match &job.output {
        Some(saved) => saved.clone(),
        None => {
            let name = archive_name(
                &repository,
                &inventory,
                &job.card_reference,
                &date.date.to_string(),
            )?;
            let manifest = Manifest {
                version: if inventory.strict() {
                    metadata::STRICT_VERSION
                } else {
                    2
                },
                archive_name: name.clone(),
                archive_id: job.id.clone(),
                card_reference: job.card_reference.clone(),
                date: date.clone(),
                verified_at: Utc::now().to_rfc3339(),
                bytes: inventory.bytes(),
                file_count: receipts.len(),
                directories: inventory.directories.clone(),
                files: receipts,
                directory_stamps: inventory.directory_stamps.clone(),
                root_stamp: inventory.root_stamp.clone(),
            };
            let bytes = serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?;
            if bytes.len() as u64 > DOCUMENT_LIMIT {
                return Err("Checksum manifest exceeds the supported size.".into());
            }
            let output = Output {
                name,
                digest: hex::encode(Sha256::digest(&bytes)),
                date,
            };
            store::atomic_write(&work.join("manifest.json"), &bytes)?;
            job.output = Some(output.clone());
            save(job)?;
            output
        }
    };
    let manifest_path = relative_path(&tree, &manifest_name(&output.name), false)?;
    if !manifest_path.exists() {
        import_safety::rename_new(&work.join("manifest.json"), &manifest_path)
            .map_err(|e| format!("Cannot write the archive checksum file: {e}"))?;
    }
    let (manifest, digest) = load_manifest(&tree, &output.name)?;
    if digest != output.digest {
        return Err("Saved checksum file does not match its verification receipt.".into());
    }
    ensure_source_unchanged(&source, media_id, &inventory, stopped)?;
    inventory.check_streams(&source, stopped)?;
    let mut current = scan(&tree, stopped)?;
    current.files.remove(&manifest_name(&output.name));
    if !same_files(&current.files, &stamps) || current.directories != inventory.directories {
        return Err("Files or folders changed in the draft archive during verification.".into());
    }
    if load_manifest(&tree, &output.name)?.1 != output.digest {
        return Err("The checksum file changed while the archive was being finalized.".into());
    }
    // Apply dates after byte verification, capture-date reads and the manifest
    // write. This also repairs metadata on reused draft files without recopying.
    let strict = manifest.version == metadata::STRICT_VERSION;
    if strict {
        progress.phase("Verifying metadata");
        if let Some(app) = app {
            super::log_operation(app, job, "phase=Verifying metadata");
        }
        inventory.check_streams(&tree, stopped)?;
    }
    progress.timestamp_warnings(preserve_times(&tree, &inventory, stopped, strict)?);
    let published = relative_path(&repository, &output.name, false)?;
    if stopped() {
        return Err("Stopped at a safe checkpoint.".into());
    }
    publish_directory(&tree, &published)?;
    if strict {
        let verified = inventory
            .check_published_metadata(&published, stopped)
            .and_then(|_| {
                store::atomic_write(&work.join(METADATA_RECEIPT), output.digest.as_bytes())
            });
        if let Err(error) = verified {
            publish_directory(&published, &tree).map_err(|move_error| {
                format!("{error}. The published folder needs retry in Jobs: {move_error}")
            })?;
            return Err(error);
        }
    }
    progress.metadata_verified(strict);
    clear_work(&work);
    job.completed_folder = Some(published.to_string_lossy().into_owned());
    Ok(())
}

pub(super) fn archive_name(
    repository: &Path,
    inventory: &Inventory,
    card: &str,
    date: &str,
) -> Result<String, String> {
    if !(1..=16).contains(&card.len()) || !card.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Err("Invalid archive card ID.".into());
    }
    let base = format!("SD-{card}_{date}");
    for serial in 1..=100 {
        let name = if serial == 1 {
            base.clone()
        } else {
            format!("{base}-{serial:02}")
        };
        let manifest = manifest_name(&name);
        let overlaps = inventory
            .files
            .keys()
            .chain(&inventory.directories)
            .any(|entry| {
                entry
                    .split('/')
                    .next()
                    .is_some_and(|first| first.eq_ignore_ascii_case(&manifest))
            });
        if !overlaps
            && !repository
                .join(&name)
                .try_exists()
                .map_err(|e| e.to_string())?
        {
            return Ok(name);
        }
    }
    Err("Could not reserve a unique archive name.".into())
}

#[cfg(windows)]
pub(super) fn publish_directory(work: &Path, final_path: &Path) -> Result<(), String> {
    import_safety::rename_new(work, final_path).map_err(|e| {
        format!("Could not publish the verified folder without replacing an archive: {e}")
    })
}

#[cfg(not(windows))]
pub(super) fn publish_directory(_: &Path, _: &Path) -> Result<(), String> {
    Err("This build does not support safe directory publication on this platform.".into())
}
