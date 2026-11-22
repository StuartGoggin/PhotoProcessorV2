use super::*;
use std::io::Write;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("photogogo-test-{}", new_id().unwrap()));
        fs::create_dir(&path).unwrap();
        fs::create_dir(path.join("source")).unwrap();
        fs::create_dir(path.join("repository")).unwrap();
        Self(inventory::root(&path).unwrap())
    }
    fn source(&self) -> PathBuf {
        self.0.join("source")
    }
    fn repository(&self) -> PathBuf {
        self.0.join("repository")
    }
    fn put(&self, name: &str, bytes: &[u8]) {
        let path = self.source().join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
    }
    fn job(&self) -> ArchiveJob {
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
        }
    }
    fn run(
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
fn stopped_archive_resumes_and_changed_checkpoint_never_publishes() {
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
    assert!(fixture
        .run(&mut job, || false, &restart)
        .unwrap_err()
        .contains("differs from the card"));
    fs::write(first, b"original").unwrap();
    let restart = Progress::new(&job);
    fixture.run(&mut job, || false, &restart).unwrap();
    assert_eq!(restart.snapshot().0.files_verified, 5);
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
    let stamp = "2025-01-01T12:00:00Z"
        .parse::<chrono::DateTime<Utc>>()
        .unwrap();
    fs::OpenOptions::new()
        .write(true)
        .open(fixture.source().join("old.cr3"))
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(stamp.into()))
        .unwrap();
    let mut job = fixture.job();
    job.date_override = None;
    let progress = Progress::new(&job);
    fixture.run(&mut job, || false, &progress).unwrap();
    let output = job.output.unwrap();
    assert_eq!(output.date.basis, "File modification time");
    assert_eq!(output.date.file.as_deref(), Some("old.cr3"));
    let expected_date = stamp.with_timezone(&chrono::Local).date_naive().to_string();
    assert!(output.name.starts_with(&expected_date));
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
