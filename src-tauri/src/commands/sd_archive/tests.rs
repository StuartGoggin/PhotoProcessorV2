use super::*;
use std::io::Write;

pub(super) struct Fixture(pub(super) PathBuf);
impl Fixture {
    pub(super) fn new() -> Self {
        let path = std::env::temp_dir().join(format!("photogogo-test-{}", new_id().unwrap()));
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("source")).unwrap();
        fs::create_dir(path.join("repository")).unwrap();
        Self(inventory::root(&path).unwrap())
    }
    pub(super) fn source(&self) -> PathBuf {
        self.0.join("source")
    }
    pub(super) fn repository(&self) -> PathBuf {
        self.0.join("repository")
    }
    pub(super) fn put(&self, name: &str, bytes: &[u8]) {
        let path = self.source().join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    pub(super) fn job(&self) -> ArchiveJob {
        let source = self.source();
        let inventory = inventory::scan(&source, || false).unwrap();
        let id = new_id().unwrap();
        copy::initialize(&self.repository(), &id, &inventory).unwrap();
        ArchiveJob {
            version: 1,
            id,
            mode: "archive".into(),
            source: source.to_string_lossy().into_owned(),
            media_id: Some(import_devices::resolve(&source).unwrap().media_id),
            repository: self.repository().to_string_lossy().into_owned(),
            card_reference: "TEST".into(),
            date_override: Some(NaiveDate::from_ymd_opt(2026, 11, 23).unwrap()),
            output: None,
            completed_folder: None,
            created_at: Utc::now().to_rfc3339(),
            started_at: None,
            finished_at: None,
            status: "queued".into(),
            files: inventory.files.len(),
            summary: Summary {
                mode: "archive".into(),
                total_bytes: inventory.bytes(),
                ..Summary::default()
            },
            logs: vec![],
            errors: vec![],
            maintenance: None,
        }
    }
    pub(super) fn run(
        &self,
        job: &mut ArchiveJob,
        stopped: impl Fn() -> bool + Sync,
        progress: &Progress,
    ) -> Result<(), String> {
        copy::archive(
            job,
            progress,
            &self.0.join("unused.exe"),
            None,
            &stopped,
            |state| save(&self.0, state),
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        assert!(self
            .0
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("photogogo-test-sd_archive_"));
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn operations_log_correlates_archive_and_verify_events_without_inserting_lines() {
    let fixture = Fixture::new();
    let mut job = fixture.job();
    assert_eq!(
        operation_log_entry(&job, "phase=Copying"),
        format!(
            "sd_card_archive job_id='{}' mode=archive phase=Copying",
            job.id
        ),
    );
    job.mode = "verify".into();
    assert_eq!(
        operation_log_entry(&job, "error: file unavailable\nRead failed"),
        format!(
            "sd_card_archive job_id='{}' mode=verify error: file unavailable Read failed",
            job.id
        ),
    );
}

#[test]
#[cfg(windows)]
fn archives_full_tree_and_verifies_after_card_removal() {
    let fixture = Fixture::new();
    fixture.put("DCIM/100CANON/équipe.JPG", b"image");
    fixture.put("DCIM/101CANON/équipe.JPG", b"second capture");
    fixture.put(".hidden", b"camera data");
    fixture.put("unknown.xmp", b"notes");
    fixture.put("checksums.md5", b"source checksum kept");
    fs::create_dir_all(fixture.source().join("empty/another")).unwrap();
    let original = inventory::scan(&fixture.source(), || false).unwrap();
    let mut job = fixture.job();
    let progress = Progress::new(&job);
    fixture.run(&mut job, || false, &progress).unwrap();
    assert!(inventory::scan(&fixture.source(), || false)
        .unwrap()
        .same_tree(&original));
    assert_eq!(
        fs::read(fixture.source().join(".hidden")).unwrap(),
        b"camera data"
    );
    assert_eq!(progress.snapshot().0.files_verified, 5);
    let archive = PathBuf::from(job.completed_folder.as_ref().unwrap());
    let output = job.output.as_ref().unwrap();
    fs::rename(fixture.source(), fixture.0.join("card-removed")).unwrap();
    let receipt = inventory::verify(
        &archive,
        &output.name,
        Some(&output.digest),
        |_, _| {},
        || false,
    )
    .unwrap();
    assert_eq!(receipt.directories, original.directories);
    assert!(archive.join("empty/another").is_dir());
    assert_eq!(
        fs::read(archive.join("checksums.md5")).unwrap(),
        b"source checksum kept"
    );
    assert_eq!(
        fs::read(archive.join("DCIM/101CANON/équipe.JPG")).unwrap(),
        b"second capture"
    );
    // Power loss after the atomic rename but before saving Completed.
    let mut interrupted = load(&fixture.0, &job.id).unwrap();
    assert!(interrupted.completed_folder.is_none());
    let progress = Progress::new(&interrupted);
    fixture.run(&mut interrupted, || false, &progress).unwrap();
    assert_eq!(interrupted.completed_folder, job.completed_folder);
    fs::write(archive.join(".hidden"), b"altered!!!!").unwrap();
    assert!(inventory::verify(
        &archive,
        &output.name,
        Some(&output.digest),
        |_, _| {},
        || false
    )
    .unwrap_err()
    .contains("checksum mismatch"));
}

#[test]
#[cfg(windows)]
fn stopped_archive_resumes_and_repairs_only_a_proven_draft_file() {
    let fixture = Fixture::new();
    for n in 0..5 {
        fixture.put(&format!("DCIM/file-{n}.cr3"), b"original");
    }
    let mut job = fixture.job();
    let progress = Progress::new(&job);
    let stopped = fixture
        .run(
            &mut job,
            || progress.snapshot().0.files_verified >= 1,
            &progress,
        )
        .unwrap_err();
    assert!(
        stopped.contains("Stopped at a safe checkpoint"),
        "{stopped}"
    );
    assert!(job.completed_folder.is_none());
    let first = copy::work_dir(&fixture.repository(), &job.id).join("card/DCIM/file-0.cr3");
    assert!(first.is_file());
    fs::write(&first, b"tampered").unwrap();
    let restart = Progress::new(&job);
    fixture.run(&mut job, || false, &restart).unwrap();
    assert_eq!(restart.snapshot().0.files_verified, 5);
    assert_eq!(restart.snapshot().0.files_repaired, 1);
    let draft = copy::work_dir(&fixture.repository(), &job.id);
    let damaged = fs::read_dir(draft.join("damaged"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap();
    assert_eq!(fs::read(damaged.path()).unwrap(), b"tampered");
    let path = Path::new(job.completed_folder.as_ref().unwrap()).join("DCIM/file-0.cr3");
    assert_eq!(fs::read(path).unwrap(), b"original");
}

#[test]
#[cfg(windows)]
fn archived_child_exits_at_checkpoint() {
    let Some(folder) = std::env::var_os("PHOTOGOGO_TEST_SD_CRASH_FOLDER") else {
        return;
    };
    let fixture = Fixture(PathBuf::from(folder));
    let id = saved_job_ids(&fixture.0).unwrap().pop().unwrap();
    let mut job = load(&fixture.0, &id).unwrap();
    let progress = Progress::new(&job);
    let _ = fixture.run(
        &mut job,
        || {
            if progress.snapshot().0.files_verified >= 2 {
                // No destructors, status save, or orderly cancellation run.
                std::process::exit(73);
            }
            false
        },
        &progress,
    );
    panic!("Failed to reach the forced-exit checkpoint");
}

#[test]
#[cfg(windows)]
fn forced_exit_reuses_verified_bytes_from_an_old_job_and_handles_a_torn_receipt() {
    let fixture = Fixture::new();
    for n in 0..5 {
        fixture.put(&format!("DCIM/{n}.jpg"), b"photo");
    }
    let job = fixture.job();
    save(&fixture.0, &job).unwrap();
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "commands::sd_archive::tests::archived_child_exits_at_checkpoint",
        ])
        .env("PHOTOGOGO_TEST_SD_CRASH_FOLDER", &fixture.0)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(73));
    let work = copy::work_dir(&fixture.repository(), &job.id);
    let journal = work.join(checkpoints::FILE_NAME);
    fs::OpenOptions::new()
        .append(true)
        .open(&journal)
        .unwrap()
        .write_all(b"[\"torn")
        .unwrap();
    // Missing data must be copied even when it still has a saved checksum.
    fs::remove_file(work.join("card/DCIM/0.jpg")).unwrap();
    let inventory = inventory::scan(&fixture.source(), || false).unwrap();
    let recovered = find_recovery(
        &fixture.0,
        &fixture.repository(),
        job.media_id.as_deref().unwrap(),
        &inventory,
    )
    .unwrap()
    .unwrap();
    assert_eq!(recovered.job_id, job.id);
    assert!(!recovered.completed);
    let mut job = load(&fixture.0, &recovered.job_id).unwrap();
    let progress = Progress::new(&job);
    fixture.run(&mut job, || false, &progress).unwrap();
    let summary = progress.snapshot().0;
    assert_eq!(summary.files_verified, 5);
    assert!((1..5).contains(&summary.files_reused));
}

#[test]
#[cfg(windows)]
fn checksum_detects_changed_card_bytes_with_the_same_inventory() {
    let fixture = Fixture::new();
    fixture.put("DCIM/a.jpg", b"camera");
    fixture.put("DCIM/b.jpg", b"camera");
    let mut job = fixture.job();
    let progress = Progress::new(&job);
    fixture
        .run(
            &mut job,
            || progress.snapshot().0.files_verified >= 1,
            &progress,
        )
        .unwrap_err();
    let work = copy::work_dir(&fixture.repository(), &job.id);
    let before = copy::load_inventory(&work).unwrap();
    let path = fixture.source().join("DCIM/a.jpg");
    fs::write(&path, b"change").unwrap();
    assert!(before.files["DCIM/a.jpg"]
        .set_times(&fs::OpenOptions::new().write(true).open(&path).unwrap()));
    assert!(before.same_tree(&inventory::scan(&fixture.source(), || false).unwrap()));
    let progress = Progress::new(&job);
    let result = fixture.run(&mut job, || false, &progress).unwrap_err();
    assert!(result.contains("Card checksum changed"), "{result}");
    assert_eq!(fs::read(work.join("card/DCIM/a.jpg")).unwrap(), b"camera");
    assert!(job.completed_folder.is_none());
}

#[test]
#[cfg(windows)]
fn matching_completed_archive_is_reverified_without_creating_a_snapshot() {
    let fixture = Fixture::new();
    fixture.put("DCIM/a.jpg", b"original");
    let mut job = fixture.job();
    let progress = Progress::new(&job);
    fixture.run(&mut job, || false, &progress).unwrap();
    job.status = "completed".into();
    save(&fixture.0, &job).unwrap();
    copy::retire_finished_draft(&job);
    let inventory = inventory::scan(&fixture.source(), || false).unwrap();
    let recovery = find_recovery(
        &fixture.0,
        &fixture.repository(),
        job.media_id.as_deref().unwrap(),
        &inventory,
    )
    .unwrap()
    .unwrap();
    assert!(recovery.completed);
    assert_eq!(job.id, recovery.job_id);
    let mut verify = load(&fixture.0, &job.id).unwrap();
    verify.completed_folder = None;
    let progress = Progress::new(&verify);
    copy::reuse_completed(&mut verify, &progress, None, &|| false).unwrap();
    assert_eq!(job.completed_folder, verify.completed_folder);
    assert_eq!(fs::read_dir(fixture.repository()).unwrap().count(), 1);
    assert_eq!(progress.snapshot().0.files_reused, 1);
    let file = Path::new(job.completed_folder.as_ref().unwrap()).join("DCIM/a.jpg");
    fs::write(&file, b"tampered").unwrap();
    assert!(
        copy::reuse_completed(&mut verify, &Progress::new(&job), None, &|| false)
            .unwrap_err()
            .contains("checksum mismatch")
    );
    assert_eq!(fs::read(file).unwrap(), b"tampered");
}

#[test]
#[cfg(windows)]
fn reinspecting_a_published_but_unsaved_job_compares_the_card_to_its_manifest() {
    let fixture = Fixture::new();
    fixture.put("DCIM/a.jpg", b"original");
    let mut job = fixture.job();
    let progress = Progress::new(&job);
    fixture.run(&mut job, || false, &progress).unwrap();
    let mut saved = load(&fixture.0, &job.id).unwrap();
    assert!(saved.completed_folder.is_none());
    saved.summary.verify_card_on_recovery = true;
    let before = inventory::scan(&fixture.source(), || false).unwrap();
    let path = fixture.source().join("DCIM/a.jpg");
    fs::write(&path, b"modified").unwrap();
    assert!(before.files["DCIM/a.jpg"]
        .set_times(&fs::OpenOptions::new().write(true).open(&path).unwrap()));
    assert!(before.same_tree(&inventory::scan(&fixture.source(), || false).unwrap()));
    let progress = Progress::new(&saved);
    let error = fixture.run(&mut saved, || false, &progress).unwrap_err();
    assert!(error.contains("card checksum differs"), "{error}");
    assert_eq!(
        fs::read(Path::new(job.completed_folder.as_ref().unwrap()).join("DCIM/a.jpg")).unwrap(),
        b"original"
    );
}

#[test]
#[cfg(windows)]
fn refuses_changed_volume_or_tree_without_creating_a_verified_folder() {
    let fixture = Fixture::new();
    fixture.put("DCIM/a.jpg", b"1");
    let mut replaced = fixture.job();
    replaced.media_id = Some("other-card".into());
    let progress = Progress::new(&replaced);
    assert!(fixture
        .run(&mut replaced, || false, &progress)
        .unwrap_err()
        .contains("removed or replaced"));
    let mut changed = fixture.job();
    fixture.put("DCIM/b.jpg", b"2");
    let progress = Progress::new(&changed);
    assert!(fixture
        .run(&mut changed, || false, &progress)
        .unwrap_err()
        .contains("inventory changed"));
    assert!(fs::read_dir(fixture.repository())
        .unwrap()
        .all(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".incomplete")));
}

#[test]
#[cfg(windows)]
fn repeated_runs_use_distinct_names_and_failed_destination_is_not_published() {
    let fixture = Fixture::new();
    fixture.put("a.jpg", b"camera");
    let mut one = fixture.job();
    let first_progress = Progress::new(&one);
    fixture.run(&mut one, || false, &first_progress).unwrap();
    let mut two = fixture.job();
    let second_progress = Progress::new(&two);
    let work = copy::work_dir(&fixture.repository(), &two.id);
    fs::write(work.join("scratch"), b"blocked").unwrap();
    assert!(fixture.run(&mut two, || false, &second_progress).is_err());
    assert!(two.completed_folder.is_none());
    fs::remove_file(work.join("scratch")).unwrap();
    fixture.run(&mut two, || false, &second_progress).unwrap();
    assert_eq!(one.output.as_ref().unwrap().name, "SD-TEST_2026-11-23");
    assert_eq!(two.output.as_ref().unwrap().name, "SD-TEST_2026-11-23-02");
    assert_ne!(one.completed_folder, two.completed_folder);
    assert_eq!(
        fs::read(Path::new(one.completed_folder.as_ref().unwrap()).join("a.jpg")).unwrap(),
        b"camera"
    );
}

#[test]
#[cfg(windows)]
fn last_second_destination_collision_preserves_the_existing_folder() {
    let fixture = Fixture::new();
    fixture.put("DCIM/photo.jpg", b"original");
    let mut job = fixture.job();
    let progress = Progress::new(&job);
    let result = copy::archive(
        &mut job,
        &progress,
        &fixture.0.join("unused.exe"),
        None,
        &|| false,
        |prepared| {
            let name = &prepared.output.as_ref().unwrap().name;
            let destination = fixture.repository().join(name);
            fs::create_dir(&destination).unwrap();
            fs::write(destination.join("existing.txt"), b"keep").unwrap();
            Ok(())
        },
    );
    assert!(result.unwrap_err().contains("without replacing an archive"));
    assert!(job.completed_folder.is_none());
    let destination = fixture.repository().join(&job.output.unwrap().name);
    assert_eq!(fs::read(destination.join("existing.txt")).unwrap(), b"keep");
    assert!(!destination.join("DCIM").exists());
}

#[test]
#[cfg(windows)]
fn file_times_are_used_when_metadata_has_no_capture_date() {
    let fixture = Fixture::new();
    fixture.put("new.jpg", b"no media metadata");
    fixture.put("old.cr3", b"no media metadata");
    fixture.put("older.mov", b"an earlier video");
    let stamp = "2025-01-01T12:00:00Z"
        .parse::<chrono::DateTime<Utc>>()
        .unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(fixture.source().join("old.cr3"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(stamp.into()))
        .unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(fixture.source().join("older.mov"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified((stamp - chrono::Days::new(2)).into()))
        .unwrap();
    let mut job = fixture.job();
    job.date_override = None;
    let progress = Progress::new(&job);
    fixture.run(&mut job, || false, &progress).unwrap();
    let output = job.output.unwrap();
    assert_eq!(output.date.basis, "File modification time");
    assert_eq!(output.date.file.as_deref(), Some("old.cr3"));
    let expected_date = stamp.with_timezone(&chrono::Local).date_naive().to_string();
    assert_eq!(output.name, format!("SD-TEST_{expected_date}"));
}

#[cfg(windows)]
pub(super) fn set_fixture_attributes(path: &Path, flags: u32) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::SetFileAttributesW;

    let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    assert_ne!(unsafe { SetFileAttributesW(name.as_ptr(), flags) }, 0);
}

#[test]
#[cfg(windows)]
fn strict_archive_proves_flags_and_detects_metadata_only_changes() {
    use std::os::windows::fs::MetadataExt;

    let fixture = Fixture::new();
    fixture.put("DCIM/photo.jpg", b"original");
    fs::create_dir(fixture.source().join("empty")).unwrap();
    set_fixture_attributes(&fixture.source().join("DCIM/photo.jpg"), 0x2 | 0x4);
    set_fixture_attributes(&fixture.source().join("empty"), 0x2);
    let mut job = fixture.job();
    let progress = Progress::new(&job);
    fixture.run(&mut job, || false, &progress).unwrap();
    let tree = PathBuf::from(job.completed_folder.unwrap());
    let photo = tree.join("DCIM/photo.jpg");
    assert_eq!(fs::metadata(&photo).unwrap().file_attributes() & 0x27, 0x6);
    assert_eq!(
        fs::metadata(tree.join("empty")).unwrap().file_attributes() & 0x2,
        0x2
    );
    let output = job.output.unwrap();
    let manifest = inventory::verify(
        &tree,
        &output.name,
        Some(&output.digest),
        |_, _| {},
        || false,
    )
    .unwrap();
    assert_eq!(manifest.version, 4);
    set_fixture_attributes(&photo, 0x80);
    assert_eq!(fs::read(&photo).unwrap(), b"original");
    let error = inventory::verify(
        &tree,
        &output.name,
        Some(&output.digest),
        |_, _| {},
        || false,
    )
    .unwrap_err();
    assert!(
        error.contains("DCIM/photo.jpg")
            && error.contains("attributes")
            && error.contains("expected")
            && error.contains("observed"),
        "{error}"
    );
}

#[test]
#[cfg(windows)]
fn strict_archive_refuses_unsupported_named_stream() {
    let fixture = Fixture::new();
    fixture.put("photo.jpg", b"primary data");
    fs::write(fixture.source().join("photo.jpg:extra"), b"additional data").unwrap();
    let mut job = fixture.job();
    let progress = Progress::new(&job);
    let error = fixture.run(&mut job, || false, &progress).unwrap_err();
    assert!(
        error.contains("photo.jpg") && error.contains("named data stream"),
        "{error}"
    );
    assert!(job.completed_folder.is_none());
}

#[test]
#[cfg(windows)]
fn strict_archive_checks_last_access_at_publication_and_resumes_unfinished_readback() {
    let fixture = Fixture::new();
    fixture.put("photo.jpg", b"original");
    let access = std::time::UNIX_EPOCH + Duration::from_secs(1_650_000_000);
    let set_access = |path: &Path, time| {
        fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_accessed(time))
            .unwrap();
    };
    set_access(&fixture.source().join("photo.jpg"), access);
    let mut job = fixture.job();
    let progress = Progress::new(&job);
    fixture.run(&mut job, || false, &progress).unwrap();
    let finished = PathBuf::from(job.completed_folder.as_ref().unwrap());
    let output = job.output.as_ref().unwrap();
    let manifest = inventory::load_manifest(&finished, &output.name).unwrap().0;
    set_access(
        &finished.join("photo.jpg"),
        access + Duration::from_secs(600),
    );
    let error = manifest
        .inventory()
        .check_published_metadata(&finished, &|| false)
        .unwrap_err();
    assert!(
        error.contains("photo.jpg")
            && error.contains("last-access time")
            && error.contains("expected")
            && error.contains("observed"),
        "{error}"
    );
    inventory::verify(
        &finished,
        &output.name,
        Some(&output.digest),
        |_, _| {},
        || false,
    )
    .unwrap();
    let marker = copy::work_dir(&fixture.repository(), &job.id).join("metadata-verified.txt");
    fs::remove_file(&marker).unwrap();
    job.completed_folder = None;
    let progress = Progress::new(&job);
    fixture.run(&mut job, || false, &progress).unwrap();
    assert_eq!(progress.snapshot().0.files_reused, 1);
    assert!(progress.snapshot().0.strict_metadata);
    let output = job.output.as_ref().unwrap();
    assert_eq!(fs::read_to_string(marker).unwrap(), output.digest);
}

#[test]
#[cfg(windows)]
fn preserves_file_folder_and_root_times_and_detects_timestamp_drift() {
    use std::os::windows::fs::{FileTimesExt, OpenOptionsExt};

    let fixture = Fixture::new();
    fixture.put("DCIM/photo.jpg", b"original photo bytes");
    fs::create_dir(fixture.source().join("empty")).unwrap();
    let created = std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    let modified = created + Duration::from_secs(37);
    let accessed = modified + Duration::from_secs(41);
    for relative in ["DCIM/photo.jpg", "DCIM", "empty", ""] {
        let handle = fs::OpenOptions::new()
            .access_mode(0x100)
            .custom_flags(0x02000000)
            .open(fixture.source().join(relative))
            .unwrap();
        handle
            .set_times(
                fs::FileTimes::new()
                    .set_created(created)
                    .set_modified(modified)
                    .set_accessed(accessed),
            )
            .unwrap();
    }
    let mut job = fixture.job();
    let progress = Progress::new(&job);
    fixture.run(&mut job, || false, &progress).unwrap();
    let tree = PathBuf::from(job.completed_folder.unwrap());
    for relative in ["DCIM/photo.jpg", "DCIM", "empty", ""] {
        let metadata = fs::metadata(tree.join(relative)).unwrap();
        assert_eq!(metadata.created().unwrap(), created, "{relative}");
        assert_eq!(metadata.modified().unwrap(), modified, "{relative}");
    }
    let output = job.output.unwrap();
    inventory::verify(
        &tree,
        &output.name,
        Some(&output.digest),
        |_, _| {},
        || false,
    )
    .unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(tree.join("DCIM/photo.jpg"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified + Duration::from_secs(1)))
        .unwrap();
    let error = inventory::verify(
        &tree,
        &output.name,
        Some(&output.digest),
        |_, _| {},
        || false,
    )
    .unwrap_err();
    assert!(
        error.contains("timestamp mismatch") && error.contains("DCIM/photo.jpg"),
        "{error}"
    );
}

#[test]
fn empty_metadata_has_no_guessed_capture_date_and_saved_jobs_project_to_core() {
    let fixture = Fixture::new();
    fixture.put("manual.txt", b"no camera metadata");
    assert!(
        inventory::proposed_date(&inventory::scan(&fixture.source(), || false).unwrap()).is_none()
    );
    let job = fixture.job();
    let result = serde_json::to_value(project(&job, false).unwrap()).unwrap();
    assert_eq!(result["task"], "sdCardArchive");
    assert_eq!(result["status"], "needs_attention");
    assert_eq!(result["sdCardArchive"]["verifiedBytes"], 0);
}

#[test]
fn legacy_manifest_still_verifies_with_its_original_name() {
    let fixture = Fixture::new();
    let name = "2026-11-23_SD-ABCD-1234567890-00";
    let tree = fixture.repository().join(name);
    fs::create_dir(&tree).unwrap();
    fs::write(tree.join("photo.jpg"), b"old").unwrap();
    let receipt = serde_json::json!({
        "version": 1, "archiveName": name, "archiveId": "old-job", "cardReference": "ABCD",
        "date": {"date": "2026-11-23", "basis": "Embedded capture time", "file": "photo.jpg"},
        "verifiedAt": "2026-11-23T00:00:00Z", "bytes": 3, "fileCount": 1, "directories": [],
        "files": {
            "photo.jpg": {
                "stamp": {"bytes": 3, "modified": null, "created": null},
                "sha256": hex::encode(Sha256::digest(b"old"))
            }
        }
    });
    fs::write(
        tree.join(inventory::manifest_name(name)),
        serde_json::to_vec(&receipt).unwrap(),
    )
    .unwrap();
    assert_eq!(
        inventory::verify(&tree, name, None, |_, _| {}, || false)
            .unwrap()
            .version,
        1
    );
}

#[test]
#[cfg(windows)]
#[ignore = "Requires the bundled metadata tool"]
fn earliest_embedded_photo_date_controls_the_archive_name() {
    use crate::commands::metadata_tools;

    let fixture = Fixture::new();
    let tool = Path::new(env!("CARGO_MANIFEST_DIR")).join("tools/exiftool/exiftool_files/perl.exe");
    assert!(tool.is_file(), "Missing managed metadata tool");
    for (file, date) in [
        ("first.jpg", "2024:01:31 11:22:33"),
        ("second.jpg", "2024:02:01 00:00:01"),
    ] {
        let path = fixture.source().join(file);
        image::RgbImage::new(8, 8).save(&path).unwrap();
        metadata_tools::run_limited(
            &tool,
            &[
                "-overwrite_original".into(),
                format!("-DateTimeOriginal={date}").into(),
                path.into_os_string(),
            ],
            1024 * 1024,
        )
        .unwrap();
    }
    let mut job = fixture.job();
    job.date_override = None;
    let progress = Progress::new(&job);
    copy::archive(&mut job, &progress, &tool, None, &|| false, |_| Ok(())).unwrap();
    let output = job.output.unwrap();
    assert_eq!(output.name, "SD-TEST_2024-01-31");
    assert_eq!(output.date.file.as_deref(), Some("first.jpg"));
    assert_eq!(output.date.basis, "Embedded capture time");
}

#[test]
#[cfg(windows)]
#[ignore = "Opt-in straight-copy and verified-copy comparison on synthetic local storage"]
fn archive_throughput_fixture() {
    for (label, files, chunks) in [("large", 2, 64), ("mixed", 256, 0)] {
        let fixture = Fixture::new();
        let data = vec![0x95; 1024 * 1024];
        for index in 0..files {
            let mut output =
                fs::File::create(fixture.source().join(format!("frame-{index:03}.mp4"))).unwrap();
            let file_chunks = if chunks == 0 && index % 32 == 0 {
                2
            } else {
                chunks
            };
            if file_chunks == 0 {
                output.write_all(&data[..8192]).unwrap();
            }
            for _ in 0..file_chunks {
                output.write_all(&data).unwrap();
            }
            output.sync_all().unwrap();
        }
        let tree = inventory::scan(&fixture.source(), || false).unwrap();
        let baseline = fixture.repository().join("baseline");
        fs::create_dir(&baseline).unwrap();
        let start = Instant::now();
        for name in tree.files.keys() {
            let dest = baseline.join(name);
            fs::copy(fixture.source().join(name), &dest).unwrap();
            fs::OpenOptions::new()
                .write(true)
                .open(dest)
                .unwrap()
                .sync_all()
                .unwrap();
        }
        let baseline_secs = start.elapsed().as_secs_f64();
        let mut job = fixture.job();
        let progress = Progress::new(&job);
        let start = Instant::now();
        fixture.run(&mut job, || false, &progress).unwrap();
        let elapsed = start.elapsed().as_secs_f64();
        let (summary, _, stats) = progress.snapshot();
        let mibs = tree.bytes() as f64 / 1048576.0;
        println!("SD_ARCHIVE_FIXTURE {label} files={files} bytes={} baseline_mib_s={:.2} verified_mib_s={:.2} source_mib_s={:?} queue_wait_ms={} verify_worker_ms={} workers={}",
            tree.bytes(), mibs / baseline_secs, mibs / elapsed, summary.sustained_mbps,
            stats.reader_queue_wait_ms, stats.verification_worker_ms, stats.verifier_count);
        assert_eq!(summary.verified_bytes, tree.bytes());
    }
}

#[cfg(windows)]
#[test]
fn reuse_verification_checks_both_copies_and_rejects_new_card_files() {
    let fixture = Fixture::new();
    fixture.put("DCIM/photo.jpg", b"original picture");
    fs::create_dir(fixture.source().join("EMPTY")).unwrap();
    let mut job = fixture.job();
    let progress = Progress::new(&job);
    fixture.run(&mut job, || false, &progress).unwrap();

    let source = fixture.source();
    let folder = PathBuf::from(job.completed_folder.take().unwrap());
    let output = job.output.as_ref().unwrap();
    let check = || reuse::verify_pair(&source, &folder, output, &Progress::new(&job), &|| false);
    check().unwrap();


    // Restore the modification time, leaving a same-size content change.
    let path = folder.join("DCIM/photo.jpg");
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    fs::write(&path, b"corrupt picture!").unwrap();
    fs::OpenOptions::new().write(true).open(&path).unwrap()
        .set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
    assert!(check().unwrap_err().contains("checksum mismatch"));
    fixture.put("DCIM/unarchived.jpg", b"another photo");
    assert!(check().unwrap_err().contains("added, moved or removed"));
    fs::remove_file(source.join("DCIM/unarchived.jpg")).unwrap();
    assert_eq!(fs::read(source.join("DCIM/photo.jpg")).unwrap(), b"original picture");
}
