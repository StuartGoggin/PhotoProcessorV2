//! The same complete transfer interface is used by core Jobs and filesystem tests.
use super::{
    archive_adaptive::{self, Decision, Mode, Work},
    archive_ledger::Ledger,
    archive_plan::{self, FrozenPlan},
};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};

pub(super) struct Outcome {
    pub copied: usize,
    pub verified: usize,
    pub deduplicated: usize,
    pub renamed: usize,
    pub errors: Vec<String>,
    pub aborted: bool,
    pub manifest: Option<PathBuf>,
}
pub(super) struct Progress {
    pub done: usize,
    pub total: usize,
    pub copied: usize,
    pub deduplicated: usize,
    pub renamed: usize,
    pub hashed: usize,
    pub indexed: usize,
    pub verified_bytes: u64,
    pub copied_bytes: u64,
    pub total_bytes: u64,
    pub workers: usize,
    pub active: usize,
    pub hashing: usize,
    pub checking: usize,
    pub copying: usize,
    pub verifying: usize,
    pub elapsed: Duration,
    pub current_file: String,
    pub decision: Option<Decision>,
}
#[derive(Default)]
struct Stats {
    done: AtomicUsize,
    copied: AtomicUsize,
    dedup: AtomicUsize,
    renamed: AtomicUsize,
    hashed: AtomicUsize,
    indexed: AtomicUsize,
    verified: AtomicU64,
    copied_bytes: AtomicU64,
    hashing: AtomicUsize,
    checking: AtomicUsize,
    copying: AtomicUsize,
    verifying: AtomicUsize,
    active: AtomicUsize,
    workers: AtomicUsize,
    hash_ms: AtomicU64,
    check_ms: AtomicU64,
    copy_ms: AtomicU64,
    verify_ms: AtomicU64,
    record_ms: AtomicU64,
    paused_ns: AtomicU64,
    fatal: AtomicBool,
    errors: Mutex<Vec<String>>,
    current: Mutex<String>,
}
struct Stage<'a> {
    stats: &'a Stats,
    phase: &'static str,
    started: Instant,
}
impl<'a> Stage<'a> {
    fn new(stats: &'a Stats, phase: &'static str) -> Self {
        let value = Self {
            stats,
            phase,
            started: Instant::now(),
        };
        value.count().fetch_add(1, Ordering::Relaxed);
        value
    }
    fn count(&self) -> &AtomicUsize {
        match self.phase {
            "hash" => &self.stats.hashing,
            "check" => &self.stats.checking,
            "copy" => &self.stats.copying,
            _ => &self.stats.verifying,
        }
    }
}
impl Drop for Stage<'_> {
    fn drop(&mut self) {
        self.count().fetch_sub(1, Ordering::Relaxed);
        let total = match self.phase {
            "hash" => &self.stats.hash_ms,
            "check" => &self.stats.check_ms,
            "copy" => &self.stats.copy_ms,
            "verify" => &self.stats.verify_ms,
            _ => &self.stats.record_ms,
        };
        total.fetch_add(self.started.elapsed().as_millis() as u64, Ordering::Relaxed);
    }
}
struct Claim<'a> {
    hash: String,
    claims: &'a Mutex<HashSet<String>>,
    changed: &'a Condvar,
}
impl Drop for Claim<'_> {
    fn drop(&mut self) {
        self.claims
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.hash);
        self.changed.notify_all();
    }
}

pub(super) fn lease(archive: &Path) -> Result<File, String> {
    let path = archive_plan::safe_destination(archive, ".photogogo-archive.lock")?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| e.to_string())?;
    fs2::FileExt::try_lock_exclusive(&file).map_err(|_| {
        "Another transfer or verification is using this archive. Wait for it to finish.".to_string()
    })?;
    Ok(file)
}

pub(super) fn run(
    plan: Arc<FrozenPlan>,
    run_id: &str,
    mode: Mode,
    checkpoint: impl Fn() -> bool + Sync,
    report: impl Fn(&Progress) + Sync,
    log: impl Fn(String) + Sync,
) -> Result<Outcome, String> {
    let began = Instant::now();
    plan.revalidate()?;
    fs::create_dir_all(&plan.archive).map_err(|e| e.to_string())?;
    archive_plan::reject_link(&plan.archive)?;
    let _lease = lease(&plan.archive)?;
    let manifests = archive_plan::safe_destination(&plan.archive, "_transfer_manifests")?;
    fs::create_dir_all(&manifests).map_err(|e| e.to_string())?;
    archive_plan::reject_link(&manifests)?;
    let receipt = archive_plan::safe_destination(
        &plan.archive,
        &format!("_transfer_manifests/archive-selection-{run_id}.json"),
    )?;
    plan.write_receipt(&receipt)?;
    let planned = plan.files.iter().map(|p| {
        p.strip_prefix(&plan.staging)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/")
    });
    let ledger = Mutex::new(Ledger::open(&plan.archive, planned, |p| {
        archive_plan::protected_hash(p, &checkpoint).map(|h| h.hash)
    })?);
    let recovered = ledger
        .lock()
        .map_err(|_| "Archive ledger lock failed.")?
        .recovered;
    log(format!(
        "ARCHIVE_RECOVERY: recovered={recovered}; current selection files={} bytes={}",
        plan.files.len(),
        plan.preview.summary.included_bytes
    ));
    let stats = Stats::default();
    stats.workers.store(
        match mode {
            Mode::Auto => 2,
            Mode::Fixed(n) => n,
        },
        Ordering::Relaxed,
    );
    let claims = Mutex::new(HashSet::<String>::new());
    let changed = Condvar::new();
    let emission = Mutex::new((Instant::now() - Duration::from_secs(1), 0u64));
    let setup = began.elapsed();
    let emit = |snapshot: Option<archive_adaptive::Snapshot>, force: bool| {
        let mut gate = emission.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(s) = snapshot {
            if s.completed < gate.1 {
                return;
            }
            gate.1 = s.completed;
            stats.workers.store(s.limit, Ordering::Relaxed);
            stats.paused_ns.store(
                s.paused.as_nanos().min(u64::MAX as u128) as u64,
                Ordering::Relaxed,
            );
        }
        let decision = snapshot.and_then(|s| s.decision);
        if !force && decision.is_none() && gate.0.elapsed() < Duration::from_millis(500) {
            return;
        }
        gate.0 = Instant::now();
        let elapsed = snapshot.map(|s| s.elapsed + setup).unwrap_or_else(|| {
            began.elapsed().saturating_sub(Duration::from_nanos(
                stats.paused_ns.load(Ordering::Relaxed),
            ))
        });
        report(&Progress {
            done: stats.done.load(Ordering::Relaxed),
            total: plan.files.len(),
            copied: stats.copied.load(Ordering::Relaxed),
            deduplicated: stats.dedup.load(Ordering::Relaxed),
            renamed: stats.renamed.load(Ordering::Relaxed),
            hashed: stats.hashed.load(Ordering::Relaxed),
            indexed: stats.indexed.load(Ordering::Relaxed),
            verified_bytes: stats.verified.load(Ordering::Relaxed),
            copied_bytes: stats.copied_bytes.load(Ordering::Relaxed),
            total_bytes: plan.preview.summary.included_bytes,
            workers: stats.workers.load(Ordering::Relaxed),
            active: stats.active.load(Ordering::Relaxed),
            hashing: stats.hashing.load(Ordering::Relaxed),
            checking: stats.checking.load(Ordering::Relaxed),
            copying: stats.copying.load(Ordering::Relaxed),
            verifying: stats.verifying.load(Ordering::Relaxed),
            elapsed,
            current_file: stats
                .current
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            decision,
        });
    };
    emit(None, true);
    let snapshot = archive_adaptive::run(
        &plan.files,
        mode,
        8,
        || stats.fatal.load(Ordering::Relaxed) || checkpoint(),
        |_, source, checked| {
            stats.active.fetch_add(1, Ordering::Relaxed);
            let relative = source
                .strip_prefix(&plan.staging)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            *stats.current.lock().unwrap_or_else(|e| e.into_inner()) = source
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            let result = (|| -> Result<u64, String> {
                plan.check_source(source)?;
                let hash_stage = Stage::new(&stats, "hash");
                // Retain the source read handle through dedup/copy so a Windows
                // writer cannot change bytes after the fresh checksum.
                let source_hash = archive_plan::protected_hash(source, &|| {
                    emit(None, false);
                    checked()
                })?;
                plan.check_source(source)?;
                stats.hashed.fetch_add(1, Ordering::Relaxed);
                drop(hash_stage);
                let _claim = loop {
                    if checked() {
                        return Err("Archive stopped before duplicate checks.".into());
                    }
                    let mut pending = claims
                        .lock()
                        .map_err(|_| "Archive duplicate coordination failed.")?;
                    if pending.insert(source_hash.hash.clone()) {
                        break Claim {
                            hash: source_hash.hash.clone(),
                            claims: &claims,
                            changed: &changed,
                        };
                    }
                    drop(
                        changed
                            .wait_timeout(pending, Duration::from_millis(100))
                            .map_err(|_| "Archive duplicate coordination failed.")?,
                    );
                };
                let check_stage = Stage::new(&stats, "check");
                let mut candidates = ledger
                    .lock()
                    .map_err(|_| "Archive ledger unavailable.")?
                    .candidates(&source_hash.hash);
                if !candidates.iter().any(|p| p == &relative) {
                    candidates.push(relative.clone());
                }
                for candidate in candidates {
                    if checked() {
                        return Err("Archive stopped during duplicate checks.".into());
                    }
                    let destination = archive_plan::safe_destination(&plan.archive, &candidate)?;
                    match fs::metadata(&destination) {
                        Ok(meta) if meta.is_file() && meta.len() == source_hash.bytes => {}
                        Ok(_) => continue,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                        Err(e) => {
                            log(format!("ARCHIVE_CANDIDATE_WARNING: '{candidate}' is inaccessible ({e}); its index row was retained."));
                            continue;
                        }
                    }
                    match archive_plan::protected_hash(&destination, checked) {
                        Ok(existing) if existing.hash == source_hash.hash => {
                            plan.check_source(source)?;
                            let mut ledger =
                                ledger.lock().map_err(|_| "Archive ledger unavailable.")?;
                            if let Err(error) =
                                ledger.intent(&candidate, &existing.hash, existing.bytes)
                            {
                                stats.fatal.store(true, Ordering::Relaxed);
                                return Err(error);
                            }
                            ledger.confirm(&candidate, &existing.hash)?;
                            stats.indexed.store(ledger.added_current, Ordering::Relaxed);
                            stats.dedup.fetch_add(1, Ordering::Relaxed);
                            log(format!("ARCHIVE_DEDUP_VERIFIED: '{relative}' already confirmed at '{candidate}'"));
                            return Ok(source_hash.bytes);
                        }
                        Ok(_) => {
                            let stale = ledger
                                .lock()
                                .map_err(|_| "Archive ledger unavailable.")?
                                .mark_stale(&candidate, &source_hash.hash);
                            if stale {
                                log(format!("ARCHIVE_INDEX_MISMATCH: '{candidate}' differs from its recorded MD5; the stale row was removed. The existing file was preserved; other destinations are checked before creating a safely named copy."));
                            }
                        }
                        Err(error) => {
                            if checked() {
                                return Err(error);
                            }
                            log(format!("ARCHIVE_CANDIDATE_WARNING: cannot verify '{candidate}'; existing index retained: {error}"));
                        }
                    }
                }
                drop(check_stage);
                let (destination_relative, renamed) = ledger
                    .lock()
                    .map_err(|_| "Archive ledger unavailable.")?
                    .reserve(&relative)?;
                let destination =
                    archive_plan::safe_destination(&plan.archive, &destination_relative)?;
                fs::create_dir_all(destination.parent().ok_or("Missing archive parent.")?)
                    .map_err(|e| e.to_string())?;
                archive_plan::safe_destination(&plan.archive, &destination_relative)?;
                let phase = std::cell::RefCell::new(None::<Stage<'_>>);
                let bytes = plan.copy_verified_with_intent(
                    source,
                    &destination,
                    &source_hash.hash,
                    &mut || {
                        emit(None, false);
                        if checked() {
                            Err("Archive stopped before publication.".into())
                        } else {
                            Ok(())
                        }
                    },
                    &mut |_, hash, bytes| {
                        let result = ledger
                            .lock()
                            .map_err(|_| "Archive ledger unavailable.")?
                            .intent(&destination_relative, hash, bytes);
                        if result.is_err() {
                            stats.fatal.store(true, Ordering::Relaxed);
                        }
                        result
                    },
                    &|name| {
                        phase.borrow_mut().take();
                        *phase.borrow_mut() = Some(Stage::new(
                            &stats,
                            match name {
                                "copy" => "copy",
                                "verify" => "verify",
                                _ => "record",
                            },
                        ));
                        emit(None, false);
                    },
                )?;
                drop(phase);
                {
                    let mut record = ledger.lock().map_err(|_| "Archive ledger unavailable.")?;
                    record.confirm(&destination_relative, &source_hash.hash)?;
                    stats.indexed.store(record.added_current, Ordering::Relaxed);
                }
                stats.copied.fetch_add(1, Ordering::Relaxed);
                stats.copied_bytes.fetch_add(bytes, Ordering::Relaxed);
                if renamed {
                    stats.renamed.fetch_add(1, Ordering::Relaxed);
                }
                log(format!(
                    "ARCHIVE_COPY_VERIFIED: '{relative}' -> '{destination_relative}' bytes={bytes}"
                ));
                let completed =
                    stats.copied.load(Ordering::Relaxed) + stats.dedup.load(Ordering::Relaxed);
                if completed % 250 == 0 {
                    if let Err(error) = ledger
                        .lock()
                        .map_err(|_| "Archive ledger unavailable.")?
                        .checkpoint()
                    {
                        stats.fatal.store(true, Ordering::Relaxed);
                        return Err(format!(
                            "Archive checkpoint failed; recovery intents retained: {error}"
                        ));
                    }
                }
                Ok(bytes)
            })();
            stats.active.fetch_sub(1, Ordering::Relaxed);
            stats.done.fetch_add(1, Ordering::Relaxed);
            match result {
                Ok(bytes) => {
                    stats.verified.fetch_add(bytes, Ordering::Relaxed);
                    Work {
                        verified_bytes: bytes,
                        failed: false,
                    }
                }
                Err(error) => {
                    let stopped = checkpoint();
                    if !stopped {
                        log(format!("ARCHIVE_FILE_ERROR: '{relative}': {error}"));
                        stats
                            .errors
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .push(format!("{relative}: {error}"));
                    }
                    Work {
                        verified_bytes: 0,
                        failed: !stopped,
                    }
                }
            }
        },
        |snapshot| {
            if let Some(d) = snapshot.decision {
                log(format!(
                    "ARCHIVE_AUTO: workers {} -> {}: {}",
                    d.previous, d.limit, d.reason
                ));
            }
            emit(Some(snapshot), false);
        },
    );
    let aborted = checkpoint();
    let mut errors = stats
        .errors
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    if !aborted {
        match ledger
            .lock()
            .map_err(|_| "Archive ledger unavailable.")?
            .settle_pending(|p| archive_plan::protected_hash(p, &checkpoint).map(|h| h.hash))
        {
            Ok(count) if count > 0 => log(format!(
                "ARCHIVE_PUBLICATION_RECONCILED: {count} outcome-unknown final files confirmed"
            )),
            Ok(_) => {}
            Err(error) => errors.push(format!(
                "Uncertain publication recovery is pending: {error}"
            )),
        }
    }
    let outcome = if aborted {
        "aborted"
    } else if !errors.is_empty() || stats.fatal.load(Ordering::Relaxed) {
        "partial"
    } else {
        "completed"
    };
    let manifest = match ledger
        .lock()
        .map_err(|_| "Archive ledger unavailable.")?
        .finish(run_id, outcome)
    {
        Ok(path) => Some(path),
        Err(error) => {
            errors.push(format!(
                "Archive records could not be finalized; recovery intents retained: {error}"
            ));
            None
        }
    };
    emit(Some(snapshot), true);
    log(format!("ARCHIVE_TIMING: source_hash_ms={} duplicate_check_ms={} copy_ms={} destination_verify_ms={} record_ms={} elapsed_ms={} copied_bytes={} verified_useful_bytes={} active_at_end={} (stage times sum worker activity, not wall time)",stats.hash_ms.load(Ordering::Relaxed),stats.check_ms.load(Ordering::Relaxed),stats.copy_ms.load(Ordering::Relaxed),stats.verify_ms.load(Ordering::Relaxed),stats.record_ms.load(Ordering::Relaxed),began.elapsed().as_millis(),stats.copied_bytes.load(Ordering::Relaxed),snapshot.verified_bytes,snapshot.active));
    Ok(Outcome {
        copied: stats.copied.load(Ordering::Relaxed),
        verified: stats.copied.load(Ordering::Relaxed) + stats.dedup.load(Ordering::Relaxed),
        deduplicated: stats.dedup.load(Ordering::Relaxed),
        renamed: stats.renamed.load(Ordering::Relaxed),
        errors,
        aborted,
        manifest,
    })
}

pub(super) fn verify(
    archive: &Path,
    scope: &str,
    checkpoint: impl Fn() -> bool + Sync,
    report: impl Fn(&Progress) + Sync,
    log: impl Fn(String) + Sync,
) -> Result<Outcome, String> {
    let began = Instant::now();
    let archive = archive_plan::resolve(archive)?;
    archive_plan::reject_link(&archive)?;
    let _lease = lease(&archive)?;
    let recovered = Ledger::open(&archive, Vec::new(), |p| {
        archive_plan::protected_hash(p, &checkpoint).map(|h| h.hash)
    })?
    .recovered;
    let (manifest, description) = super::archive_ledger::verification_manifest(&archive, scope)?;
    let entries: Vec<_> = super::archive_ledger::read_entries(&manifest)?
        .into_iter()
        .collect();
    log(format!(
        "ARCHIVE_VERIFY_SCOPE: {description}; recovered={recovered}; files={}; manifest='{}'",
        entries.len(),
        manifest.display()
    ));
    let done = AtomicUsize::new(0);
    let passed = AtomicUsize::new(0);
    let bytes = AtomicU64::new(0);
    let errors = Mutex::new(Vec::<String>::new());
    let current = Mutex::new(String::new());
    let active = AtomicUsize::new(0);
    let report_lock = Mutex::new(0u64);
    let setup = began.elapsed();
    let emit = |s: archive_adaptive::Snapshot| {
        let mut last = report_lock.lock().unwrap_or_else(|e| e.into_inner());
        if s.completed < *last {
            return;
        }
        *last = s.completed;
        report(&Progress {
            done: done.load(Ordering::Relaxed),
            total: entries.len(),
            copied: 0,
            deduplicated: 0,
            renamed: 0,
            hashed: passed.load(Ordering::Relaxed),
            indexed: 0,
            verified_bytes: bytes.load(Ordering::Relaxed),
            copied_bytes: 0,
            total_bytes: 0,
            workers: s.limit,
            active: active.load(Ordering::Relaxed),
            hashing: 0,
            checking: 0,
            copying: 0,
            verifying: active.load(Ordering::Relaxed),
            elapsed: s.elapsed + setup,
            current_file: current.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            decision: s.decision,
        });
    };
    let snapshot = archive_adaptive::run(
        &entries,
        Mode::Auto,
        8,
        &checkpoint,
        |_, (relative, expected), checked| {
            active.fetch_add(1, Ordering::Relaxed);
            *current.lock().unwrap_or_else(|e| e.into_inner()) = relative.clone();
            let result = (|| {
                let path = archive_plan::safe_destination(&archive, relative)?;
                let actual = archive_plan::protected_hash(&path, checked)?;
                if actual.hash != *expected {
                    return Err(format!("Checksum mismatch for '{relative}'"));
                }
                Ok(actual.bytes)
            })();
            active.fetch_sub(1, Ordering::Relaxed);
            done.fetch_add(1, Ordering::Relaxed);
            match result {
                Ok(count) => {
                    passed.fetch_add(1, Ordering::Relaxed);
                    bytes.fetch_add(count, Ordering::Relaxed);
                    Work {
                        verified_bytes: count,
                        failed: false,
                    }
                }
                Err(error) => {
                    let stopped = checkpoint();
                    if !stopped {
                        log(format!("ARCHIVE_VERIFY_ERROR: {error}"));
                        errors.lock().unwrap_or_else(|e| e.into_inner()).push(error);
                    }
                    Work {
                        verified_bytes: 0,
                        failed: !stopped,
                    }
                }
            }
        },
        &emit,
    );
    emit(snapshot);
    Ok(Outcome {
        copied: 0,
        verified: passed.load(Ordering::Relaxed),
        deduplicated: 0,
        renamed: 0,
        errors: errors.into_inner().unwrap_or_else(|e| e.into_inner()),
        aborted: snapshot.aborted,
        manifest: Some(manifest),
    })
}

#[cfg(test)]
#[path = "archive_transfer_tests.rs"]
mod tests;
