use super::super::archive_plan::{Request, Rule, Rules, SelectionMode};
use super::*;
struct Fixture {
    root: PathBuf,
    base: PathBuf,
    stage: PathBuf,
    archive: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).unwrap();
        let base = std::env::temp_dir().canonicalize().unwrap();
        let root = base.join(format!("photogogo-engine-{}", hex::encode(nonce)));
        let stage = root.join("stage");
        let archive = root.join("archive");
        fs::create_dir_all(&stage).unwrap();
        Self {
            root,
            base,
            stage,
            archive,
        }
    }
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let path = self.stage.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path
    }
    fn plan(&self) -> Arc<FrozenPlan> {
        let all = Rule {
            mode: SelectionMode::All,
            min_stars: 1,
        };
        let request = Request {
            staging_dir: self.stage.to_string_lossy().into_owned(),
            archive_dir: self.archive.to_string_lossy().into_owned(),
            scope_dir: None,
            rules: Rules {
                originals: all.clone(),
                bw: all.clone(),
                enhanced: all.clone(),
                crops: all.clone(),
                crop_bw: all.clone(),
                crop_enhanced: all,
            },
            exclude_trash: true,
            include_videos: true,
            include_source_originals: false,
            include_library_metadata: false,
            include_camera_sidecars: true,
        };
        let preview = archive_plan::preview(request).unwrap();
        Arc::new(
            archive_plan::take(
                &preview.id,
                &self.stage.to_string_lossy(),
                &self.archive.to_string_lossy(),
            )
            .unwrap(),
        )
    }
    fn run(&self, id: &str) -> Outcome {
        run(self.plan(), id, Mode::Auto, || false, |_| {}, |_| {}).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.root.starts_with(&self.base)
            && self
                .root
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("photogogo-engine-")
        {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
#[test]
fn actual_engine_copies_verifies_records_and_repeats_without_copying_again() {
    let f = Fixture::new();
    f.file("2026/10/24/horse.jpg", b"horse bytes");
    f.file("2026/10/24/rider.jpg", b"rider bytes");
    let first = f.run("first");
    assert!(first.errors.is_empty(), "{:?}", first.errors);
    assert_eq!(
        (first.copied, first.verified, first.deduplicated),
        (2, 2, 0)
    );
    let second = f.run("second");
    assert!(second.errors.is_empty(), "{:?}", second.errors);
    assert_eq!(
        (second.copied, second.verified, second.deduplicated),
        (0, 2, 2)
    );
    assert_eq!(
        fs::read(f.stage.join("2026/10/24/horse.jpg")).unwrap(),
        b"horse bytes"
    );
    let checked = verify(&f.archive, "latest", || false, |_| {}, |_| {}).unwrap();
    assert_eq!(checked.verified, 2);
    assert!(checked.errors.is_empty());
}
#[test]
fn batch_duplicates_share_one_publication_without_starving_workers() {
    let f = Fixture::new();
    for n in 0..12 {
        f.file(&format!("image{n:02}.jpg"), b"same source content");
    }
    let result = f.run("duplicates");
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    assert_eq!(result.copied, 1);
    assert_eq!(result.deduplicated, 11);
    assert_eq!(result.verified, 12);
    assert_eq!(
        super::super::archive_ledger::read_entries(&result.manifest.unwrap())
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn concurrent_conflicts_preserve_existing_bytes_and_other_natural_names() {
    let f = Fixture::new();
    f.file("horse.jpg", b"source A");
    f.file("horse_1.jpg", b"source B");
    fs::create_dir_all(&f.archive).unwrap();
    fs::write(f.archive.join("horse.jpg"), b"existing archive").unwrap();
    let result = f.run("conflicts");
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    assert_eq!(result.copied, 2);
    assert_eq!(
        fs::read(f.archive.join("horse.jpg")).unwrap(),
        b"existing archive"
    );
    assert_eq!(
        fs::read(f.archive.join("horse_1.jpg")).unwrap(),
        b"source B"
    );
    assert_eq!(
        fs::read(f.archive.join("horse_2.jpg")).unwrap(),
        b"source A"
    );
}
#[test]
fn ghost_index_row_repaired_by_this_job_is_not_pruned_again() {
    let f = Fixture::new();
    let source = f.file("horse.jpg", b"current bytes");
    let hash = crate::utils::compute_md5(&source).unwrap();
    fs::create_dir_all(&f.archive).unwrap();
    fs::write(
        f.archive.join("master_hashes.md5"),
        format!("{hash}  horse.jpg\n"),
    )
    .unwrap();
    let result = f.run("ghost");
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    assert_eq!(result.copied, 1);
    assert_eq!(
        super::super::archive_ledger::read_entries(&f.archive.join("master_hashes.md5"))
            .unwrap()
            .get("horse.jpg"),
        Some(&hash)
    );
}
#[test]
fn stopped_actual_job_keeps_completed_files_and_scoped_manifest() {
    let f = Fixture::new();
    for n in 0..5 {
        f.file(&format!("image{n}.jpg"), format!("bytes{n}").as_bytes());
    }
    let stop = AtomicBool::new(false);
    let result = run(
        f.plan(),
        "stopped",
        Mode::Fixed(1),
        || stop.load(Ordering::Relaxed),
        |_| {},
        |line| {
            if line.starts_with("ARCHIVE_COPY_VERIFIED:") {
                stop.store(true, Ordering::Relaxed);
            }
        },
    )
    .unwrap();
    assert!(result.aborted);
    assert_eq!(result.copied, 1);
    let (path, label) =
        super::super::archive_ledger::verification_manifest(&f.archive, "latest").unwrap();
    assert!(label.contains("aborted"));
    assert_eq!(
        super::super::archive_ledger::read_entries(&path)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(fs::read_dir(&f.stage).unwrap().count(), 5);
}
#[test]
fn intent_failure_and_abort_during_destination_read_publish_nothing() {
    let f = Fixture::new();
    let source = f.file("horse.jpg", &vec![b'x'; 3 * 1024 * 1024]);
    let plan = f.plan();
    fs::create_dir_all(&f.archive).unwrap();
    let hash = plan.hash_source(&source.canonicalize().unwrap()).unwrap();
    let target = f.archive.join("horse.jpg");
    assert!(plan
        .copy_verified_with_intent(
            &source.canonicalize().unwrap(),
            &target,
            &hash,
            &mut || Ok(()),
            &mut |_, _, _| Err("injected intent failure".into()),
            &|_| {}
        )
        .is_err());
    assert!(!target.exists());
    let stop = AtomicBool::new(false);
    assert!(plan
        .copy_verified_with_intent(
            &source.canonicalize().unwrap(),
            &target,
            &hash,
            &mut || if stop.load(Ordering::Relaxed) {
                Err("aborted".into())
            } else {
                Ok(())
            },
            &mut |_, _, _| Ok(()),
            &|phase| {
                if phase == "verify" {
                    stop.store(true, Ordering::Relaxed);
                }
            }
        )
        .is_err());
    assert!(!target.exists());
    assert_eq!(fs::metadata(source).unwrap().len(), 3 * 1024 * 1024);
}
#[test]
fn explicit_full_verify_detects_damage_without_reporting_it_as_verified() {
    let f = Fixture::new();
    f.file("horse.jpg", b"good");
    let result = f.run("verify-damage");
    assert!(result.errors.is_empty());
    fs::write(f.archive.join("horse.jpg"), b"bad!").unwrap();
    let result = verify(&f.archive, "archive", || false, |_| {}, |_| {}).unwrap();
    assert_eq!(result.verified, 0);
    assert_eq!(result.errors.len(), 1);
}
#[test]
fn archive_lease_prevents_another_transfer_or_verify_snapshot() {
    let f = Fixture::new();
    f.file("horse.jpg", b"good");
    fs::create_dir_all(&f.archive).unwrap();
    let _held = lease(&f.archive).unwrap();
    assert!(run(f.plan(), "locked", Mode::Fixed(1), || false, |_| {}, |_| {}).is_err());
    assert!(verify(&f.archive, "archive", || false, |_| {}, |_| {}).is_err());
}

#[test]
#[ignore = "Opt-in bounded local synthetic IO measurement; never accesses a NAS or user photos"]
fn bounded_local_verified_throughput() {
    for (label, mode) in [
        ("fixed1", Mode::Fixed(1)),
        ("fixed2", Mode::Fixed(2)),
        ("fixed4", Mode::Fixed(4)),
        ("fixed8", Mode::Fixed(8)),
        ("auto", Mode::Auto),
    ] {
        let f = Fixture::new();
        for n in 0..6u8 {
            f.file(&format!("image{n}.jpg"), &vec![n; 4 * 1024 * 1024]);
        }
        let plan = f.plan();
        let selected = plan.preview.summary.included_bytes;
        let before = Instant::now();
        let result = run(plan, label, mode, || false, |_| {}, |_| {}).unwrap();
        let seconds = before.elapsed().as_secs_f64();
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert_eq!(result.copied, 6);
        assert_eq!(result.verified, 6);
        let verified = verify(&f.archive, "archive", || false, |_| {}, |_| {}).unwrap();
        assert!(verified.errors.is_empty());
        assert_eq!(verified.verified, 6);
        println!(
            "ARCHIVE_LOCAL_BENCH {}",
            serde_json::json!({"mode":label,"bytes":selected,"elapsedSeconds":seconds,"verifiedMiBPerSecond":selected as f64/1048576.0/seconds,"scope":"synthetic local files, buffered IO; not a NAS or historical 2.0.44 benchmark"})
        );
    }
}
