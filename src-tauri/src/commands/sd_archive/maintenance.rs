use super::{copy, inventory::*, *};

#[cfg(all(test, windows))]
#[path = "maintenance_tests.rs"]
mod tests;

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Card {
    source: String,
    media_id: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Maintenance {
    Upgrade {
        original: Output,
        name: String,
        date: DateEvidence,
        serial: Option<String>,
        card: Option<Card>,
    },
    Remove {
        original: Output,
        replacement: Output,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpgradeReview {
    token: String,
    target_name: String,
    date: DateEvidence,
    file_times: usize,
    file_count: usize,
    folder_times: usize,
    directory_count: usize,
    root_time: bool,
    serial_known: bool,
}

struct Plan {
    job: ArchiveJob,
    at: Instant,
}

fn plans() -> &'static Mutex<HashMap<String, Plan>> {
    static PLANS: OnceLock<Mutex<HashMap<String, Plan>>> = OnceLock::new();
    PLANS.get_or_init(Mutex::default)
}

pub(super) fn selected_folder(repository: &Path, selected: &str) -> Result<(PathBuf, String), String> {
    let selected = root(Path::new(selected))?;
    if selected.parent() != Some(repository) {
        return Err(
            "Choose a completed archive directly inside the configured SD Card Repository.".into(),
        );
    }
    let name = selected
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.starts_with('.'))
        .ok_or("Choose a named completed archive.")?
        .to_owned();
    Ok((selected, name))
}

fn configured_repository(app: &AppHandle) -> Result<PathBuf, String> {
    let config = settings::load_settings(app.clone())?;
    root(Path::new(&config.sd_card_repository))
        .map_err(|_| "Set an accessible SD Card Repository first.".into())
}

pub(super) fn lock_repository(repository: &Path) -> Result<fs::File, String> {
    safety::metadata_lock(repository, ".photogogo-sd-archive-maintenance.lock")
        .map_err(|_| "Another archive maintenance job is using this repository, or the repository cannot lock it. Retry from Jobs.".into())
}

fn known_card(
    directory: &Path,
    tree: &Path,
    manifest: &Manifest,
    digest: &str,
) -> Result<Option<String>, String> {
    if !is_job(&manifest.archive_id)
        || !job_path(directory, &manifest.archive_id)?
            .try_exists()
            .map_err(|e| e.to_string())?
    {
        return Ok(None);
    }
    let job = load(directory, &manifest.archive_id)?;
    if job.mode != "archive"
        || job.status != "completed"
        || job.completed_folder.as_deref().map(Path::new) != Some(tree)
        || job
            .output
            .as_ref()
            .is_none_or(|output| output.digest != digest)
    {
        return Err("This folder differs from its completed Jobs record. Open the original archive from Jobs.".into());
    }
    Ok(job.media_id)
}

fn original_output(name: String, manifest: &Manifest, digest: String) -> Output {
    Output {
        name,
        digest,
        date: manifest.date.clone(),
    }
}

fn new_job(
    repository: &Path,
    folder: &Path,
    manifest: &Manifest,
    mode: &str,
    action: Maintenance,
) -> Result<ArchiveJob, String> {
    Ok(ArchiveJob {
        version: 1,
        id: new_id()?,
        mode: mode.into(),
        source: folder.to_string_lossy().into_owned(),
        media_id: None,
        repository: repository.to_string_lossy().into_owned(),
        card_reference: manifest.card_reference.clone(),
        date_override: None,
        output: None,
        completed_folder: None,
        created_at: Utc::now().to_rfc3339(),
        started_at: None,
        finished_at: None,
        status: "queued".into(),
        files: manifest.file_count,
        summary: Summary {
            mode: mode.into(),
            label: manifest.archive_name.clone(),
            total_bytes: manifest.bytes,
            date: Some(manifest.date.clone()),
            ..Summary::default()
        },
        logs: Vec::new(),
        errors: Vec::new(),
        maintenance: Some(action),
    })
}

fn card_info(repository: &Path, selected: &str, expected: Option<&str>) -> Result<Card, String> {
    validate_volume(selected)?;
    let source = root(Path::new(selected))?;
    let identity = import_devices::resolve(&source)?;
    if expected.is_some_and(|id| id != identity.media_id)
        || super::resolve_repository(&repository.to_string_lossy(), &source, &identity)?
            != repository
    {
        return Err(
            "Insert the original card and select a repository on a different volume.".into(),
        );
    }
    Ok(Card {
        source: selected.into(),
        media_id: identity.media_id.clone(),
    })
}

fn matches_name(old: &str, serial: &str, date: NaiveDate) -> bool {
    let base = format!("SD-{serial}_{date}");
    old == base
        || old.strip_prefix(&format!("{base}-")).is_some_and(|suffix| {
            (2..=3).contains(&suffix.len()) && suffix.bytes().all(|part| part.is_ascii_digit())
        })
}

pub(super) fn review(
    app: &AppHandle,
    folder: &str,
    source: Option<&str>,
) -> Result<UpgradeReview, String> {
    let directory = job_root(app)?;
    let repository = configured_repository(app)?;
    let (tree, old_name) = selected_folder(&repository, folder)?;
    let (manifest, digest) = load_manifest(&tree, &old_name)?;
    let expected = known_card(&directory, &tree, &manifest, &digest)?;
    let card = source
        .map(|source| card_info(&repository, source, expected.as_deref()))
        .transpose()?;
    let card_preview = card
        .as_ref()
        .map(|card| {
            with_card_reader(Some(app), &repository, card, |path| {
                let inventory = scan(path, || false)?;
                if !manifest.matches_card(&inventory) {
                    return Err("The inspected card does not match the saved archive.".into());
                }
                Ok(inventory)
            })
        })
        .transpose()?;
    let serial = expected
        .as_deref()
        .or(card.as_ref().map(|card| card.media_id.as_str()))
        .map(card_reference)
        .or_else(|| {
            (manifest.version >= 2
                && manifest.card_reference.len() == 8
                && manifest
                    .card_reference
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit()))
            .then(|| manifest.card_reference.to_ascii_uppercase())
        });
    let tool =
        super::super::metadata_tools::resolve(&settings::load_settings(app.clone())?.exiftool_dir)
            .0;
    let inventory = manifest.inventory();
    let date =
        capture_date(&tree, &inventory, &tool, || false)?.unwrap_or_else(|| manifest.date.clone());
    let name = match &serial {
        Some(serial) if !matches_name(&old_name, serial, date.date) => {
            copy::archive_name(&repository, &inventory, serial, &date.date.to_string())?
        }
        _ => old_name.clone(),
    };
    let directory_evidence = card_preview.as_ref().unwrap_or(&inventory);
    let folder_times = directory_evidence
        .directory_stamps
        .values()
        .filter(|stamp| stamp.has_recorded_times())
        .count();
    let root_time = directory_evidence
        .root_stamp
        .as_ref()
        .is_some_and(Stamp::has_recorded_times);
    let mut plans = plans()
        .lock()
        .map_err(|_| "Archive review state is unavailable.")?;
    plans.retain(|_, plan| plan.at.elapsed() < Duration::from_secs(900));
    if plans.len() >= 4 {
        if let Some(oldest) = plans
            .iter()
            .min_by_key(|(_, plan)| plan.at)
            .map(|(token, _)| token.clone())
        {
            plans.remove(&oldest);
        }
    }
    let job = new_job(
        &repository,
        &tree,
        &manifest,
        "upgrade",
        Maintenance::Upgrade {
            original: original_output(old_name, &manifest, digest),
            name: name.clone(),
            date: date.clone(),
            serial: serial.clone(),
            card,
        },
    )?;
    let review = UpgradeReview {
        token: job.id.clone(),
        target_name: name,
        date,
        file_times: inventory
            .files
            .values()
            .filter(|stamp| stamp.has_recorded_times())
            .count(),
        file_count: manifest.file_count,
        folder_times,
        directory_count: manifest.directories.len(),
        root_time,
        serial_known: serial.is_some(),
    };
    plans.insert(
        job.id.clone(),
        Plan {
            job,
            at: Instant::now(),
        },
    );
    Ok(review)
}

pub(super) fn queue_upgrade(app: AppHandle, token: &str) -> Result<ProcessJob, String> {
    let plan = plans()
        .lock()
        .map_err(|_| "Archive review state is unavailable.")?
        .remove(token)
        .filter(|plan| plan.at.elapsed() < Duration::from_secs(900))
        .ok_or("Review this archive again before upgrading.")?;
    if Path::new(&plan.job.repository) != configured_repository(&app)? {
        return Err("The repository changed. Review the archive again.".into());
    }
    let directory = job_root(&app)?;
    launch(app, directory, plan.job)
}

pub(super) fn validate_recreation(
    directory: &Path,
    repository: &Path,
    folder: &str,
    media_id: &str,
    inventory: &Inventory,
) -> Result<(), String> {
    let (tree, name) = selected_folder(repository, folder)?;
    let (manifest, digest) = load_manifest(&tree, &name)?;
    if known_card(directory, &tree, &manifest, &digest)?.is_some_and(|saved| saved != media_id)
        || !manifest.matches_card(inventory)
    {
        return Err("The selected card does not match the saved archive. Select the original card and inspect it again.".into());
    }
    Ok(())
}

pub(super) fn queue_remove(
    app: AppHandle,
    folder: &str,
    replacement: &str,
    confirmation: &str,
) -> Result<ProcessJob, String> {
    let directory = job_root(&app)?;
    let repository = configured_repository(&app)?;
    let _lock = lock_repository(&repository)?;
    let (tree, name) = selected_folder(&repository, folder)?;
    let (new_tree, new_name) = selected_folder(&repository, replacement)?;
    if new_tree == tree || confirmation != name {
        return Err("Choose a separate replacement and type the exact old folder name.".into());
    }
    let (old, digest) = load_manifest(&tree, &name)?;
    let (new, new_digest) = load_manifest(&new_tree, &new_name)?;
    known_card(&directory, &tree, &old, &digest)?;
    require_replacement(&old, &new)?;
    let job = new_job(
        &repository,
        &tree,
        &old,
        "remove",
        Maintenance::Remove {
            original: original_output(name, &old, digest),
            replacement: original_output(new_name, &new, new_digest),
        },
    )?;
    drop(_lock);
    launch(app, directory, job)
}

fn require_replacement(original: &Manifest, replacement: &Manifest) -> Result<(), String> {
    if replacement.version < 2
        || replacement.archive_id == original.archive_id
        || !original.same_contents(replacement)
    {
        return Err("The replacement must be a separate, freshly verified archive of the same files and folders.".into());
    }
    if original.version == super::metadata::STRICT_VERSION {
        if replacement.version != super::metadata::STRICT_VERSION {
            return Err("Recreate this archive with strict metadata verification before removing the old copy.".into());
        }
        original
            .inventory()
            .verify_source_metadata(&replacement.inventory())?;
    }
    Ok(())
}

fn checked_manifest(tree: &Path, output: &Output) -> Result<Manifest, String> {
    let (manifest, digest) = load_manifest(tree, &output.name)?;
    if digest != output.digest {
        return Err("The archive checksum manifest changed. Review the archive again.".into());
    }
    Ok(manifest)
}

fn with_card_reader<T>(
    app: Option<&AppHandle>,
    repository: &Path,
    card: &Card,
    inspect: impl FnOnce(&Path) -> Result<T, String>,
) -> Result<T, String> {
    let source = root(Path::new(&card.source))?;
    let identity = copy::source_identity(&source, &card.media_id)?;
    let mut ticket = copy::acquire_source(&source, repository, &identity)?;
    let _permit = ticket.try_acquire()?.map_err(|e| e.to_string())?;
    let _lease = app
        .map(|app| {
            import_devices::try_reader_lease(app, &identity)
                .and_then(|lease| lease.ok_or("Another job is using this card reader.".into()))
        })
        .transpose()?;
    let result = inspect(&source)?;
    copy::source_identity(&source, &card.media_id)?;
    Ok(result)
}

fn checked_card(
    app: Option<&AppHandle>,
    repository: &Path,
    card: &Card,
    manifest: &Manifest,
    stopped: &impl Fn() -> bool,
) -> Result<Inventory, String> {
    with_card_reader(app, repository, card, |source| {
        let inventory = scan(source, stopped)?;
        if !manifest.matches_card(&inventory) {
            return Err("The original card no longer matches the archive inventory.".into());
        }
        let after = verify_contents(source, manifest, &[], |_, _| {}, stopped)?;
        if !inventory.same_tree(&after) {
            return Err("The card changed during verification. Inspect it again.".into());
        }
        Ok(inventory)
    })
}

fn save_receipt(path: &Path, receipt: &Manifest) -> Result<String, String> {
    let bytes = serde_json::to_vec_pretty(receipt).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > DOCUMENT_LIMIT {
        return Err("The archive checksum manifest exceeds the supported size.".into());
    }
    store::atomic_write(path, &bytes)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn read_saved(path: &Path, output: &Output) -> Result<(Manifest, Vec<u8>), String> {
    store::reject_link(path)?;
    let bytes = store::read_bounded(path, DOCUMENT_LIMIT)?
        .ok_or("The saved maintenance receipt is missing.")?;
    if hex::encode(Sha256::digest(&bytes)) != output.digest {
        return Err("The saved maintenance receipt changed.".into());
    }
    let manifest =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid maintenance receipt: {e}"))?;
    Ok((manifest, bytes))
}

fn progress_verified(progress: &Progress, name: &str, bytes: u64) {
    progress.recovered(true, false);
    progress.verified(name, bytes);
}

fn copy_access_times(receipt: &mut Manifest, source: Inventory) {
    receipt.directory_stamps = source.directory_stamps;
    receipt.root_stamp = source.root_stamp;
    for (name, file) in &mut receipt.files {
        file.stamp = file.stamp.clone().with_access_time(&source.files[name]);
    }
}

fn update_history(
    directory: &Path,
    current: &str,
    from: &Path,
    old: &Output,
    new: Option<(&Path, &Output)>,
) -> Result<(), String> {
    for id in saved_job_ids(directory)? {
        if id == current {
            continue;
        }
        let Ok(record) = load(directory, &id) else {
            continue;
        };
        let refers = |record: &ArchiveJob| {
            record.status == "completed"
                && record.completed_folder.as_deref().map(Path::new) == Some(from)
                && record
                    .output
                    .as_ref()
                    .is_some_and(|output| output.digest == old.digest)
        };
        if !refers(&record) {
            continue;
        }
        let _guard = safety::metadata_lock(directory, &format!("{id}.worker.lock"))?;
        let mut record = load(directory, &id)?;
        if !refers(&record) {
            continue;
        }
        if let Some((target, output)) = new {
            let path = target.to_string_lossy().into_owned();
            record.completed_folder = Some(path.clone());
            record.output = Some(output.clone());
            record.summary.archive_folder = Some(path);
            record.summary.checksum_file = Some(
                target
                    .join(manifest_name(&output.name))
                    .to_string_lossy()
                    .into_owned(),
            );
            record.summary.date = Some(output.date.clone());
            record
                .logs
                .push(format!("Archive upgraded in place to {}.", output.name));
        } else {
            record.completed_folder = None;
            record.summary.archive_folder = None;
            record.summary.checksum_file = None;
            record.summary.phase = "Removed after verified recreation".into();
            record
                .logs
                .push("Archive folder removed after verifying a separate replacement.".into());
        }
        save(directory, &record)?;
    }
    Ok(())
}

fn prepare_upgrade(
    job: &mut ArchiveJob,
    progress: &Progress,
    app: Option<&AppHandle>,
    directory: &Path,
    repository: &Path,
    work: &Path,
    original: &Output,
    name: &str,
    date: &DateEvidence,
    serial: Option<&str>,
    card: Option<&Card>,
    stopped: &impl Fn() -> bool,
) -> Result<(Output, Manifest, Inventory), String> {
    let tree = relative_path(repository, &original.name, false)?;
    let mut manifest = checked_manifest(&root(&tree)?, original)?;
    progress.phase("Verifying");
    let verified = verify_contents(
        &tree,
        &manifest,
        &[&manifest_name(&original.name)],
        |name, bytes| progress_verified(progress, name, bytes),
        stopped,
    )?;
    if let Some(card) = card {
        progress.phase("Checking card checksums");
        let inventory = checked_card(app, repository, card, &manifest, stopped)?;
        copy_access_times(&mut manifest, inventory);
    }
    checked_manifest(&tree, original)?;
    manifest.version = manifest.version.max(3);
    manifest.archive_name = name.into();
    manifest.date = date.clone();
    manifest.verified_at = Utc::now().to_rfc3339();
    if let Some(serial) = serial {
        manifest.card_reference = serial.into();
    }
    let output = Output {
        name: name.into(),
        date: date.clone(),
        digest: save_receipt(&work.join("upgrade.json"), &manifest)?,
    };
    job.card_reference = manifest.card_reference.clone();
    job.output = Some(output.clone());
    save(directory, job)?;
    Ok((output, manifest, verified))
}

fn install_receipt(
    tree: &Path,
    original: &Output,
    output: &Output,
    bytes: &[u8],
) -> Result<(), String> {
    let old_path = relative_path(tree, &manifest_name(&original.name), false)?;
    let new_path = relative_path(tree, &manifest_name(&output.name), false)?;
    if new_path.try_exists().map_err(|e| e.to_string())? {
        let (_, digest) = load_manifest(tree, &output.name)?;
        if digest != output.digest {
            if old_path != new_path || digest != original.digest {
                return Err(
                    "The intended checksum filename is occupied. No file was replaced.".into(),
                );
            }
            store::atomic_write(&new_path, bytes)?;
        }
    } else {
        checked_manifest(tree, original)?;
        store::atomic_write(&new_path, bytes)?;
    }
    if old_path != new_path && old_path.try_exists().map_err(|e| e.to_string())? {
        checked_manifest(tree, original)?;
        fs::remove_file(&old_path)
            .map_err(|e| format!("Cannot retire the old checksum manifest: {e}"))?;
    }
    checked_manifest(tree, output)?;
    Ok(())
}

fn remove_old_tree(
    tree: &Path,
    receipt: &Manifest,
    original: &Output,
    stopped: &impl Fn() -> bool,
) -> Result<(), String> {
    let found = scan(tree, stopped)?;
    if receipt.version == super::metadata::STRICT_VERSION {
        found.check_streams(tree, stopped)?;
    }
    let receipt_name = manifest_name(&original.name);
    if found
        .files
        .keys()
        .any(|name| name != &receipt_name && !receipt.files.contains_key(name))
        || !found.directories.is_subset(&receipt.directories)
    {
        return Err(
            "The old folder contains entries outside its saved manifest. They were retained."
                .into(),
        );
    }
    for name in found.files.keys().filter(|name| *name != &receipt_name) {
        if stopped() {
            return Err("Stopped during old archive removal. The replacement is verified.".into());
        }
        let file = safety::MediaFile::open(tree, name, true)?;
        let current = file.file.metadata().map_err(|error| error.to_string())?;
        if !Stamp::read(&current).same_file(&found.files[name]) {
            return Err(format!(
                "The old archive file changed during removal: {name}"
            ));
        }
        if current.permissions().readonly() {
            super::metadata::remove_readonly(&file.file).map_err(|error| {
                format!("Could not remove read-only archive file {name}: {error}")
            })?;
        } else {
            file.remove()?;
        }
    }
    for name in found.directories.iter().rev() {
        if stopped() {
            return Err("Stopped during old archive removal. The replacement is verified.".into());
        }
        fs::remove_dir(relative_path(tree, name, false)?)
            .map_err(|e| format!("Could not remove old empty folder {name}: {e}"))?;
    }
    if found.files.contains_key(&receipt_name) {
        if stopped() {
            return Err("Stopped during old archive removal. The replacement is verified.".into());
        }
        checked_manifest(tree, original)?;
        safety::MediaFile::open(tree, &receipt_name, true)?.remove()?;
    }
    fs::remove_dir(tree).map_err(|e| format!("Could not remove the old archive folder: {e}"))
}

pub(super) fn run(
    job: &mut ArchiveJob,
    progress: &Progress,
    app: Option<&AppHandle>,
    directory: &Path,
    stopped: &impl Fn() -> bool,
) -> Result<(), String> {
    let action = job
        .maintenance
        .clone()
        .ok_or("The saved archive action is missing.")?;
    let repository = root(Path::new(&job.repository))?;
    let _lock = lock_repository(&repository)?;
    let work = copy::work_dir(&repository, &job.id);
    ensure_dir(&work)?;
    let work = root(&work)?;
    let draft = relative_path(&work, "card", false)?;
    match action {
        Maintenance::Upgrade {
            original,
            name,
            date,
            serial,
            card,
        } => {
            let from = relative_path(&repository, &original.name, false)?;
            let to = relative_path(&repository, &name, false)?;
            let (output, manifest, verified) = if let Some(output) = &job.output {
                (
                    output.clone(),
                    read_saved(&work.join("upgrade.json"), output)?.0,
                    None,
                )
            } else {
                if draft.exists() || (from != to && to.exists()) {
                    return Err("The intended archive name changed or is occupied. Review the archive again.".into());
                }
                let (output, manifest, verified) = prepare_upgrade(
                    job,
                    progress,
                    app,
                    directory,
                    &repository,
                    &work,
                    &original,
                    &name,
                    &date,
                    serial.as_deref(),
                    card.as_ref(),
                    stopped,
                )?;
                (output, manifest, Some(verified))
            };
            let published = !draft.exists() && checked_manifest(&to, &output).is_ok();
            if published {
                verify(
                    &to,
                    &output.name,
                    Some(&output.digest),
                    |name, bytes| progress_verified(progress, name, bytes),
                    stopped,
                )?;
            } else {
                if !draft.exists() {
                    checked_manifest(&from, &original)?;
                    if from != to && to.try_exists().map_err(|e| e.to_string())? {
                        return Err("The new archive name is already taken. The original folder was retained.".into());
                    }
                    if stopped() {
                        return Err("Stopped before moving the archive.".into());
                    }
                    copy::publish_directory(&from, &draft)?;
                }
                let draft = root(&draft)?;
                let old_name = manifest_name(&original.name);
                let new_name = manifest_name(&output.name);
                let (old_ok, new_ok) = (
                    checked_manifest(&draft, &original).is_ok(),
                    checked_manifest(&draft, &output).is_ok(),
                );
                if !old_ok && !new_ok {
                    return Err(
                        "The saved archive draft is missing its expected checksum manifest.".into(),
                    );
                }
                if let Some(verified) = verified {
                    let mut moved = scan(&draft, stopped)?;
                    moved.files.remove(&old_name);
                    if !moved.same_tree(&verified) {
                        return Err("The archive changed after verification. Its files were retained for retry.".into());
                    }
                } else {
                    progress.phase("Verifying");
                    let names = if old_ok && new_ok {
                        vec![old_name.as_str(), new_name.as_str()]
                    } else if old_ok {
                        vec![old_name.as_str()]
                    } else {
                        vec![new_name.as_str()]
                    };
                    verify_contents(
                        &draft,
                        &manifest,
                        &names,
                        |name, bytes| progress_verified(progress, name, bytes),
                        stopped,
                    )?;
                }
                let (_, bytes) = read_saved(&work.join("upgrade.json"), &output)?;
                install_receipt(&draft, &original, &output, &bytes)?;
                progress.phase("Restoring timestamps");
                progress.timestamp_warnings(preserve_times(
                    &draft,
                    &manifest.inventory(),
                    stopped,
                    manifest.version == super::metadata::STRICT_VERSION,
                )?);
                if stopped() {
                    return Err("Stopped before publishing the upgraded archive.".into());
                }
                copy::publish_directory(&draft, &to)?;
                if manifest.version == super::metadata::STRICT_VERSION {
                    manifest
                        .inventory()
                        .check_published_metadata(&to, stopped)?;
                } else {
                    verify_times(&manifest, &scan(&to, stopped)?)?;
                }
            }
            progress.metadata_verified(manifest.version == super::metadata::STRICT_VERSION);
            update_history(directory, &job.id, &from, &original, Some((&to, &output)))?;
            job.completed_folder = Some(to.to_string_lossy().into_owned());
        }
        Maintenance::Remove {
            original,
            replacement,
        } => {
            let from = relative_path(&repository, &original.name, false)?;
            let to = relative_path(&repository, &replacement.name, false)?;
            if from == to {
                return Err("An archive cannot be its own replacement.".into());
            }
            let saved = work.join("remove.json");
            if !saved.exists() {
                let receipt = checked_manifest(&from, &original)?;
                let path = relative_path(&from, &manifest_name(&original.name), true)?;
                let bytes = store::read_bounded(&path, DOCUMENT_LIMIT)?
                    .ok_or("The original checksum file disappeared.")?;
                if hex::encode(Sha256::digest(&bytes)) != original.digest {
                    return Err("The old checksum manifest changed.".into());
                }
                let found = scan(&from, stopped)?;
                if !found.directories.is_subset(&receipt.directories)
                    || found.files.keys().any(|name| {
                        name != &manifest_name(&original.name) && !receipt.files.contains_key(name)
                    })
                {
                    return Err("The old folder contains new entries and was retained.".into());
                }
                store::atomic_write(&saved, &bytes)?;
            }
            let (receipt, _) = read_saved(&saved, &original)?;
            progress.phase("Verifying");
            let fresh = verify(
                &root(&to)?,
                &replacement.name,
                Some(&replacement.digest),
                |name, bytes| progress_verified(progress, name, bytes),
                stopped,
            )?;
            require_replacement(&receipt, &fresh)?;
            if !draft.exists() && from.try_exists().map_err(|e| e.to_string())? {
                checked_manifest(&from, &original)?;
                if stopped() {
                    return Err("Stopped before removing the old archive.".into());
                }
                copy::publish_directory(&from, &draft)?;
            }
            if draft.exists() {
                let draft = root(&draft)?;
                progress.phase("Removing old archive");
                remove_old_tree(&draft, &receipt, &original, stopped)?;
            }
            update_history(directory, &job.id, &from, &original, None)?;
        }
    }
    Ok(())
}

pub(super) fn retire(job: &ArchiveJob) {
    let Ok(repository) = root(Path::new(&job.repository)) else {
        return;
    };
    let Ok(work) = root(&copy::work_dir(&repository, &job.id)) else {
        return;
    };
    if work.join("card").exists() {
        return;
    }
    for name in ["upgrade.json", "remove.json"] {
        if let Ok(path) = relative_path(&work, name, true) {
            let _ = fs::remove_file(path);
        }
    }
    let _ = fs::remove_dir(work);
}
