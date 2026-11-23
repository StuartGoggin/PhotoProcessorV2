use super::{inventory::*, *};

pub(super) const MODE: &str = "verifyReuse";

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

pub(super) fn queue(app: AppHandle, source: &str, folder: &str) -> Result<ProcessJob, String> {
    let (card, identity) = selected_source(source)?;
    let config = settings::load_settings(app.clone())?;
    let repository = resolve_repository(&config.sd_card_repository, &card, &identity)?;
    let (tree, name) = maintenance::selected_folder(&repository, folder)?;
    let (receipt, digest) = strict_archive(&tree, &name)?;
    let id = new_id()?;
    let job = ArchiveJob {
        version: 1,
        id,
        mode: MODE.into(),
        source: source.into(),
        media_id: Some(identity.media_id.clone()),
        repository: repository.to_string_lossy().into_owned(),
        card_reference: card_reference(&identity.media_id),
        date_override: None,
        output: Some(Output {
            name,
            digest,
            date: receipt.date.clone(),
        }),
        completed_folder: None,
        created_at: Utc::now().to_rfc3339(),
        started_at: None,
        finished_at: None,
        status: "queued".into(),
        files: receipt.file_count,
        summary: Summary {
            mode: MODE.into(),
            label: identity.label,
            total_bytes: receipt.bytes,
            date: Some(receipt.date),
            ..Summary::default()
        },
        logs: Vec::new(),
        errors: Vec::new(),
        maintenance: None,
    };
    launch(app.clone(), job_root(&app)?, job)
}

pub(super) fn run(
    app: &AppHandle,
    job: &mut ArchiveJob,
    progress: &Progress,
    stopped: &impl Fn() -> bool,
) -> Result<(), String> {
    let (source, identity) = selected_source(&job.source)?;
    if job.media_id.as_deref() != Some(&identity.media_id) {
        return Err("The selected card was removed or replaced. Start a new reuse check.".into());
    }
    let config = settings::load_settings(app.clone())?;
    let repository = resolve_repository(&config.sd_card_repository, &source, &identity)?;
    if repository != Path::new(&job.repository) {
        return Err("The configured SD Card Repository changed. Start a new reuse check.".into());
    }
    let output = job
        .output
        .as_ref()
        .ok_or("The saved reuse check has no checksum receipt.")?;
    let tree = root(&relative_path(&repository, &output.name, true)?)?;
    if tree.parent() != Some(repository.as_path()) {
        return Err("The selected archive moved outside its repository.".into());
    }
    progress.phase("Waiting for the card reader");
    let _reader = copy::wait_for_reader(&source, &repository, &identity, Some(app), stopped)?;
    let _repository = maintenance::lock_repository(&repository)?;
    let (_, mounted) = selected_source(&job.source)?;
    if mounted != identity {
        return Err("The selected card changed while waiting for its reader.".into());
    }
    verify_pair(&source, &tree, output, progress, stopped)?;
    let (mounted_path, mounted) = selected_source(&job.source)?;
    if mounted_path != source || mounted != identity {
        return Err("The selected card changed during verification.".into());
    }
    job.completed_folder = Some(tree.to_string_lossy().into_owned());
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

    progress.phase("Checking card checksums");
    let found = verify_contents(
        source,
        &manifest,
        &[],
        |name, _| progress.current_file(name),
        stopped,
    )
    .map_err(|error| format!("Source card: {error}"))?;
    manifest.inventory().verify_source_metadata(&found)?;
    found.check_streams(source, stopped)?;

    progress.phase("Checking repository copy");
    verify(
        tree,
        &output.name,
        Some(&digest),
        |name, bytes| progress.verified(name, bytes),
        stopped,
    )?;
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
