use super::{inventory::*, *};

pub(super) const MODE: &str = "verifyReuse";

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Stage {
    Lookup,
    Compare,
    Report,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Side {
    pub(super) files: usize,
    bytes: u64,
    folders: usize,
    checked_files: usize,
    checked_bytes: u64,
}

impl Side {
    fn observe(tree: &Inventory) -> Self {
        Self {
            files: tree.files.len(),
            bytes: tree.bytes(),
            folders: tree.directories.len(),
            checked_files: 0,
            checked_bytes: 0,
        }
    }

    fn checked(&mut self, bytes: u64) {
        self.checked_files += 1;
        self.checked_bytes += bytes;
    }

    fn complete(&self) -> bool {
        self.files > 0 && self.files == self.checked_files && self.bytes == self.checked_bytes
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proof {
    pub(super) stage: Stage,
    card_id: String,
    archives_searched: usize,
    candidates: usize,
    unreadable: usize,
    pub(super) card: Option<Side>,
    archive: Option<Side>,
    archive_folder: Option<String>,
    checksum_file: Option<String>,
    manifest_sha256: Option<String>,
    checked_at: Option<String>,
}

impl Proof {
    pub(super) fn new(card_id: &str) -> Self {
        Self {
            stage: Stage::Lookup,
            card_id: card_id.into(),
            archives_searched: 0,
            candidates: 0,
            unreadable: 0,
            card: None,
            archive: None,
            archive_folder: None,
            checksum_file: None,
            manifest_sha256: None,
            checked_at: None,
        }
    }

    fn complete(&self) -> bool {
        self.card
            .as_ref()
            .zip(self.archive.as_ref())
            .is_some_and(|(card, archive)| {
                card.complete()
                    && archive.complete()
                    && card.files == archive.files
                    && card.bytes == archive.bytes
                    && card.folders == archive.folders
            })
    }
}

fn update_proof(progress: &Progress, action: impl FnOnce(&mut Proof)) {
    progress.update(|live| {
        if let Some(proof) = &mut live.summary.reuse_proof {
            action(proof);
        }
    });
}

fn strict_archive(tree: &Path, name: &str) -> Result<(Manifest, String), String> {
    let (manifest, digest) = load_manifest(tree, name)?;
    if manifest.version != metadata::STRICT_VERSION {
        return Err("This archive predates full metadata verification. Create a new archive of this card before preparing it for reuse.".into());
    }
    if manifest.file_count == 0 {
        return Err("The selected archive contains no files to verify.".into());
    }
    Ok((manifest, digest))
}

fn selected_source(path: &str) -> Result<(PathBuf, import_devices::SourceIdentity), String> {
    validate_volume(path)?;
    if !import_devices::archive_sources()?
        .iter()
        .any(|card| card.path.eq_ignore_ascii_case(path))
    {
        return Err("Select a detected source card before checking it for reuse.".into());
    }
    let source = root(Path::new(path))?;
    let identity = import_devices::resolve(&source)?;
    if !identity.certain || identity.lanes.len() != 1 {
        return Err(
            "Windows could not identify the exact card volume. Reinsert it or try another reader."
                .into(),
        );
    }
    Ok((source, identity))
}

pub(super) fn queue(
    app: AppHandle,
    source: &str,
    folder: Option<&str>,
) -> Result<ProcessJob, String> {
    let (card, identity) = selected_source(source)?;
    let config = settings::load_settings(app.clone())?;
    let repository = resolve_repository(&config.sd_card_repository, &card, &identity)?;
    let card_id = card_reference(&identity.media_id);
    // Keep accepting saved or older clients that selected a specific archive.
    let output = folder
        .map(|folder| {
            let (tree, name) = maintenance::selected_folder(&repository, folder)?;
            let (receipt, digest) = strict_archive(&tree, &name)?;
            if !receipt.card_reference.eq_ignore_ascii_case(&card_id) {
                return Err("The selected archive belongs to a different card ID.".into());
            }
            Ok::<_, String>(Output {
                name,
                digest,
                date: receipt.date,
            })
        })
        .transpose()?;
    let directory = job_root(&app)?;
    let job = ArchiveJob {
        version: 1,
        id: new_id()?,
        mode: MODE.into(),
        source: source.into(),
        media_id: Some(identity.media_id.clone()),
        repository: repository.to_string_lossy().into_owned(),
        card_reference: card_id.clone(),
        date_override: None,
        output,
        completed_folder: None,
        created_at: Utc::now().to_rfc3339(),
        started_at: None,
        finished_at: None,
        status: "queued".into(),
        files: 0,
        summary: Summary {
            mode: MODE.into(),
            label: identity.label,
            reuse_proof: Some(Proof::new(&card_id)),
            ..Summary::default()
        },
        logs: Vec::new(),
        errors: Vec::new(),
        maintenance: None,
    };
    launch(app, directory, job)
}

fn check_context(
    app: &AppHandle,
    job: &ArchiveJob,
) -> Result<(PathBuf, import_devices::SourceIdentity, PathBuf), String> {
    let (source, identity) = selected_source(&job.source)?;
    if job.media_id.as_deref() != Some(&identity.media_id) {
        return Err("The selected card was removed or replaced. Start a new reuse check.".into());
    }
    let config = settings::load_settings(app.clone())?;
    let repository = resolve_repository(&config.sd_card_repository, &source, &identity)?;
    if repository != Path::new(&job.repository) {
        return Err("The configured SD Card Repository changed. Start a new reuse check.".into());
    }
    Ok((source, identity, repository))
}

pub(super) fn run(
    app: &AppHandle,
    job: &mut ArchiveJob,
    progress: &Progress,
    stopped: &impl Fn() -> bool,
) -> Result<(), String> {
    let (source, identity, repository) = check_context(app, job)?;
    progress.phase("Waiting for the card reader");
    let _reader = copy::wait_for_reader(&source, &repository, &identity, Some(app), stopped)?;
    let _repository = maintenance::lock_repository(&repository)?;
    let (mounted_path, mounted, _) = check_context(app, job)?;
    if mounted_path != source || mounted != identity {
        return Err("The selected card changed while waiting for its reader.".into());
    }
    let (tree, output) = find_and_verify(
        &source,
        &repository,
        &job.card_reference,
        job.output.as_ref(),
        progress,
        stopped,
    )?;
    let (mounted_path, mounted, _) = check_context(app, job)?;
    if stopped() || mounted_path != source || mounted != identity {
        return Err("The check stopped or the selected card changed during verification.".into());
    }
    if !progress
        .snapshot()
        .0
        .reuse_proof
        .is_some_and(|proof| proof.complete())
    {
        return Err(
            "The comparison finished without a complete proof. Start a new reuse check.".into(),
        );
    }
    update_proof(progress, |proof| {
        if proof.complete() {
            proof.checked_at = Some(Utc::now().to_rfc3339());
        }
    });
    job.output = Some(output);
    job.completed_folder = Some(tree.to_string_lossy().into_owned());
    Ok(())
}

fn candidates(
    repository: &Path,
    card_id: &str,
    progress: &Progress,
    stopped: &impl Fn() -> bool,
) -> Result<Vec<Output>, String> {
    progress.phase("Looking for matching archives");
    let shelf = library::list_shelf(repository)?;
    update_proof(progress, |proof| proof.unreadable = shelf.skipped);
    let mut ready = Vec::new();
    let mut same_id = 0;
    for book in shelf.books {
        if stopped() {
            return Err("Stopped before comparing the card.".into());
        }
        let result = published_folder(repository, &book.name)
            .and_then(|folder| load_manifest(&folder, &book.name));
        update_proof(progress, |proof| proof.archives_searched += 1);
        match result {
            Ok((manifest, digest)) if manifest.card_reference.eq_ignore_ascii_case(card_id) => {
                same_id += 1;
                update_proof(progress, |proof| proof.candidates = same_id);
                if manifest.version == metadata::STRICT_VERSION && manifest.file_count > 0 {
                    let completed =
                        chrono::DateTime::parse_from_rfc3339(&manifest.verified_at).ok();
                    ready.push((
                        completed,
                        Output {
                            name: book.name,
                            digest,
                            date: manifest.date,
                        },
                    ));
                }
            }
            Err(_) => update_proof(progress, |proof| proof.unreadable += 1),
            _ => {}
        }
    }
    if ready.is_empty() {
        return Err(if same_id == 0 {
            format!("No readable archive for card {card_id} was found in the repository.")
        } else {
            format!("The archives for card {card_id} lack a complete strict checksum record. Create a fresh archive and try again.")
        });
    }
    ready.sort_by(|(left, a), (right, b)| right.cmp(left).then_with(|| b.name.cmp(&a.name)));
    Ok(ready.into_iter().map(|(_, output)| output).collect())
}

fn find_and_verify(
    source: &Path,
    repository: &Path,
    card_id: &str,
    selected: Option<&Output>,
    progress: &Progress,
    stopped: &impl Fn() -> bool,
) -> Result<(PathBuf, Output), String> {
    #[cfg(windows)]
    let card_changes = windows::TreeWatch::open(source)?;
    let choices = match selected {
        Some(output) => {
            update_proof(progress, |proof| {
                proof.archives_searched = 1;
                proof.candidates = 1;
            });
            vec![output.clone()]
        }
        None => candidates(repository, card_id, progress, stopped)?,
    };
    let mut last_error = None;
    for output in choices {
        if stopped() {
            return Err("Stopped before comparing another archive.".into());
        }
        #[cfg(windows)]
        card_changes.unchanged("source card")?;
        let tree = match published_folder(repository, &output.name) {
            Ok(tree) => tree,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        match verify_pair(source, &tree, &output, progress, stopped) {
            Ok(()) => {
                #[cfg(windows)]
                card_changes.unchanged("source card")?;
                return Ok((tree, output));
            }
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| "No archive fully matched the inserted card.".into()))
}

pub(super) fn confirm_manual(app: &AppHandle, job_id: &str) -> Result<(), String> {
    let job = load(&job_root(app)?, job_id)?;
    if job.status != "completed"
        || job.mode != MODE
        || !job.summary.strict_metadata
        || !job
            .summary
            .reuse_proof
            .as_ref()
            .is_some_and(|proof| proof.checked_at.is_some() && proof.complete())
    {
        return Err("Run a fresh reuse check and wait for a complete proof.".into());
    }
    let (source, identity, repository) = check_context(app, &job)?;
    let _reader = import_devices::try_reader_lease(app, &identity)?
        .ok_or("The card reader is busy. Finish its current work and run a fresh check.")?;
    let output = job
        .output
        .as_ref()
        .ok_or("The saved archive receipt is missing.")?;
    let tree = published_folder(&repository, &output.name)?;
    let _lock = maintenance::lock_repository(&repository)?;
    #[cfg(windows)]
    let card_changes = windows::TreeWatch::open(&source)?;
    #[cfg(windows)]
    let archive_changes = windows::TreeWatch::open(&tree)?;
    let (manifest, digest) = strict_archive(&tree, &output.name)?;
    let stopped = || false;
    let card = scan(&source, stopped)?;
    let contents = payload_inventory(&tree, &[&manifest_name(&output.name)], &stopped)?;
    if digest != output.digest || !manifest.matches_card(&card) || !manifest.matches_card(&contents)
    {
        return Err("The card or repository changed since verification. Close this report and run a new check.".into());
    }
    #[cfg(windows)]
    {
        card_changes.unchanged("source card")?;
        archive_changes.unchanged("repository copy")?;
    }
    let (mounted_path, mounted, _) = check_context(app, &job)?;
    if mounted_path != source || mounted != identity {
        return Err("The selected card was removed or replaced. Run a new check.".into());
    }
    Ok(())
}

#[cfg(windows)]
pub(super) fn verify_pair(
    source: &Path,
    tree: &Path,
    output: &Output,
    progress: &Progress,
    stopped: &impl Fn() -> bool,
) -> Result<(), String> {
    let card_changes = windows::TreeWatch::open(source)?;
    let archive_changes = windows::TreeWatch::open(tree)?;
    let (manifest, digest) = strict_archive(tree, &output.name)?;
    if digest != output.digest {
        return Err(
            "The selected archive's checksum file changed. Start a new reuse check.".into(),
        );
    }

    progress.update(|live| {
        live.summary.files_verified = 0;
        live.summary.verified_bytes = 0;
        live.last_file.clear();
        if let Some(proof) = &mut live.summary.reuse_proof {
            proof.stage = Stage::Compare;
            proof.card = None;
            proof.archive = None;
            proof.archive_folder = Some(tree.to_string_lossy().into_owned());
            proof.checksum_file = Some(
                tree.join(manifest_name(&output.name))
                    .to_string_lossy()
                    .into_owned(),
            );
            proof.manifest_sha256 = Some(digest.clone());
        }
    });
    progress.phase("Counting files on both copies");
    let receipt_name = manifest_name(&output.name);
    let card_inventory = scan(source, stopped).map_err(|error| format!("Source card: {error}"))?;
    progress.update(|live| {
        live.summary.total_bytes = card_inventory.bytes();
        if let Some(proof) = &mut live.summary.reuse_proof {
            proof.card = Some(Side::observe(&card_inventory));
        }
    });
    let archive_inventory = payload_inventory(tree, &[&receipt_name], stopped)
        .map_err(|error| format!("Repository copy: {error}"))?;
    update_proof(progress, |proof| {
        proof.archive = Some(Side::observe(&archive_inventory))
    });

    progress.phase("Checking card checksums");
    let found = verify_inventory(
        source,
        &manifest,
        &[],
        &card_inventory,
        |name, bytes| {
            progress.current_file(name);
            update_proof(progress, |proof| {
                if let Some(side) = &mut proof.card {
                    side.checked(bytes);
                }
            });
        },
        stopped,
    )
    .map_err(|error| format!("Source card: {error}"))?;
    manifest.inventory().verify_source_metadata(&found)?;
    found.check_streams(source, stopped)?;

    progress.phase("Checking repository copy");
    let found = verify_inventory(
        tree,
        &manifest,
        &[&receipt_name],
        &archive_inventory,
        |name, bytes| {
            progress.verified(name, bytes);
            update_proof(progress, |proof| {
                if let Some(side) = &mut proof.archive {
                    side.checked(bytes);
                }
            });
        },
        stopped,
    )
    .map_err(|error| format!("Repository copy: {error}"))?;
    found.check_streams(tree, stopped)?;
    verify_times(&manifest, &found)?;
    if hash_file(&relative_path(tree, &receipt_name, true)?, stopped)? != digest {
        return Err("The archive checksum file changed during verification.".into());
    }
    card_changes.unchanged("source card")?;
    archive_changes.unchanged("repository copy")?;
    if stopped() {
        return Err("Stopped at a safe checkpoint.".into());
    }
    progress.metadata_verified(true);
    Ok(())
}

#[cfg(not(windows))]
fn verify_pair(
    _: &Path,
    _: &Path,
    _: &Output,
    _: &Progress,
    _: &impl Fn() -> bool,
) -> Result<(), String> {
    Err("Safe card reuse checks require Windows volume identification.".into())
}

#[cfg(windows)]
mod windows {
    use std::{
        fs::{File, OpenOptions},
        os::windows::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
        path::Path,
    };
    use windows_sys::Win32::{
        Foundation::{HANDLE, INVALID_HANDLE_VALUE, WAIT_TIMEOUT},
        Storage::FileSystem::{
            FindCloseChangeNotification, FindFirstChangeNotificationW, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_NOTIFY_CHANGE_ATTRIBUTES,
            FILE_NOTIFY_CHANGE_CREATION, FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME,
            FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SECURITY, FILE_NOTIFY_CHANGE_SIZE,
            FILE_READ_ATTRIBUTES, FILE_SHARE_READ, FILE_SHARE_WRITE,
        },
        System::Threading::WaitForSingleObject,
    };

    pub(super) struct TreeWatch {
        handle: HANDLE,
        _root: File,
    }

    impl TreeWatch {
        pub(super) fn open(path: &Path) -> Result<Self, String> {
            // Retain the exact directory through the check and deny replacing
            // its name. Changes anywhere inside the tree signal the watcher.
            let root = OpenOptions::new()
                .access_mode(FILE_READ_ATTRIBUTES)
                .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)
                .map_err(|error| {
                    format!("Cannot hold {} for verification: {error}", path.display())
                })?;
            let metadata = root
                .metadata()
                .map_err(|error| format!("Cannot identify {}: {error}", path.display()))?;
            if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
                return Err(format!(
                    "Expected a regular directory at {}.",
                    path.display()
                ));
            }
            let path_wide: Vec<_> = path.as_os_str().encode_wide().chain(Some(0)).collect();
            let flags = FILE_NOTIFY_CHANGE_FILE_NAME
                | FILE_NOTIFY_CHANGE_DIR_NAME
                | FILE_NOTIFY_CHANGE_ATTRIBUTES
                | FILE_NOTIFY_CHANGE_SIZE
                | FILE_NOTIFY_CHANGE_LAST_WRITE
                | FILE_NOTIFY_CHANGE_CREATION
                | FILE_NOTIFY_CHANGE_SECURITY;
            // SAFETY: path is NUL-terminated; the returned handle is owned.
            let handle = unsafe { FindFirstChangeNotificationW(path_wide.as_ptr(), 1, flags) };
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return Err(format!(
                    "Cannot monitor {} during verification: {}",
                    path.display(),
                    std::io::Error::last_os_error()
                ));
            }
            Ok(Self {
                handle,
                _root: root,
            })
        }

        pub(super) fn unchanged(&self, side: &str) -> Result<(), String> {
            // Only the unsignalled state is acceptable. Errors also fail closed.
            if unsafe { WaitForSingleObject(self.handle, 0) } != WAIT_TIMEOUT {
                return Err(format!(
                    "The {side} changed or could no longer be monitored during the reuse check."
                ));
            }
            Ok(())
        }
    }

    impl Drop for TreeWatch {
        fn drop(&mut self) {
            // SAFETY: this owns a successful change-notification handle.
            unsafe { FindCloseChangeNotification(self.handle) };
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::super::tests::Fixture;
    use super::*;

    #[test]
    fn reuse_checks_older_match_and_reports_observed_counts_and_blockers() {
        let fixture = Fixture::new();
        fixture.put("DCIM/photo.jpg", b"original picture");
        let mut original = fixture.job();
        let copy_progress = Progress::new(&original);
        fixture
            .run(&mut original, || false, &copy_progress)
            .unwrap();
        let mut newer = fixture.job();
        let copy_progress = Progress::new(&newer);
        fixture.run(&mut newer, || false, &copy_progress).unwrap();
        let newer_folder = PathBuf::from(newer.completed_folder.take().unwrap());
        fs::write(newer_folder.join("DCIM/photo.jpg"), b"damaged").unwrap();

        original.mode = MODE.into();
        original.summary.mode = MODE.into();
        let progress = Progress::new(&original);
        let (matched, _) = find_and_verify(
            &fixture.source(),
            &fixture.repository(),
            &original.card_reference,
            None,
            &progress,
            &|| false,
        )
        .unwrap();
        assert_eq!(
            matched,
            PathBuf::from(original.completed_folder.as_ref().unwrap())
        );
        let proof = progress.snapshot().0.reuse_proof.unwrap();
        assert_eq!(proof.archives_searched, 2);
        assert_eq!(proof.candidates, 2);
        for side in [
            proof.card.as_ref().unwrap(),
            proof.archive.as_ref().unwrap(),
        ] {
            assert_eq!(side.files, 1);
            assert_eq!(side.folders, 1);
            assert_eq!(side.bytes, 16);
        }
        assert!(proof.complete());

        fixture.put("DCIM/unarchived.jpg", b"extra file");
        let progress = Progress::new(&original);
        // A fresh write may still have a pending Windows notification. The
        // automatic search must stop on either a notification or a mismatch.
        assert!(find_and_verify(
            &fixture.source(),
            &fixture.repository(),
            &original.card_reference,
            None,
            &progress,
            &|| false
        )
        .is_err());

        // Test the report on a specific candidate: it counts both live trees
        // before comparing names and makes the extra relative path visible.
        let progress = Progress::new(&original);
        let failure = verify_pair(
            &fixture.source(),
            &matched,
            original.output.as_ref().unwrap(),
            &progress,
            &|| false,
        )
        .unwrap_err();
        assert!(failure.contains("DCIM/unarchived.jpg"), "{failure}");
        let proof = progress.snapshot().0.reuse_proof.unwrap();
        assert!(!proof.complete());
        assert_eq!(proof.card.unwrap().files, 2);
        assert_eq!(proof.archive.unwrap().files, 1);
        let progress = Progress::new(&original);
        assert!(find_and_verify(
            &fixture.source(),
            &fixture.repository(),
            "DIFFERENT",
            None,
            &progress,
            &|| false
        )
        .err()
        .expect("the reuse check must fail")
        .contains("No readable archive"));
    }
}
