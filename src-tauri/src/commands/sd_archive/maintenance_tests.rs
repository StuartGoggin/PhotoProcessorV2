use super::{
    super::tests::{set_fixture_attributes, Fixture},
    *,
};

fn completed_archive(fixture: &Fixture) -> ArchiveJob {
    let mut job = fixture.job();
    let progress = Progress::new(&job);
    fixture.run(&mut job, || false, &progress).unwrap();
    job.status = "completed".into();
    save(&fixture.0, &job).unwrap();
    job
}

fn legacy_archive(fixture: &Fixture) -> (ArchiveJob, Manifest) {
    let mut archive = completed_archive(fixture);
    let normal = PathBuf::from(archive.completed_folder.as_ref().unwrap());
    let mut manifest = checked_manifest(&normal, archive.output.as_ref().unwrap()).unwrap();
    let legacy_name = "2026-11-23_SD-TEST-1234567890-00";
    let folder = fixture.repository().join(legacy_name);
    fs::remove_file(normal.join(manifest_name(&manifest.archive_name))).unwrap();
    fs::rename(&normal, &folder).unwrap();
    manifest.archive_name = legacy_name.into();
    manifest.version = 1;
    manifest.directory_stamps.clear();
    manifest.root_stamp = None;
    let digest = save_receipt(&folder.join(manifest_name(legacy_name)), &manifest).unwrap();
    archive.completed_folder = Some(folder.to_string_lossy().into_owned());
    archive.output = Some(original_output(legacy_name.into(), &manifest, digest));
    save(&fixture.0, &archive).unwrap();
    (archive, manifest)
}

#[test]
fn upgrade_repairs_legacy_times_reuses_file_identity_and_resumes_after_manifest_written() {
    let fixture = Fixture::new();
    fixture.put("DCIM/photo.jpg", b"recorded photo");
    let (legacy, manifest) = legacy_archive(&fixture);
    let old = PathBuf::from(legacy.completed_folder.as_ref().unwrap());
    let photo = old.join("DCIM/photo.jpg");
    fs::OpenOptions::new()
        .write(true)
        .open(&photo)
        .unwrap()
        .set_times(
            fs::FileTimes::new()
                .set_modified(std::time::SystemTime::now() - Duration::from_secs(600)),
        )
        .unwrap();
    let identity = safety::identity(&photo).unwrap().file_id;
    let name = "SD-12345678_2026-11-23";
    let mut job = new_job(
        &fixture.repository(),
        &old,
        &manifest,
        "upgrade",
        Maintenance::Upgrade {
            original: legacy.output.unwrap(),
            name: name.into(),
            date: manifest.date.clone(),
            serial: Some("12345678".into()),
            card: None,
        },
    )
    .unwrap();
    let progress = Progress::new(&job);
    let stopped = || progress.snapshot().0.phase == "Restoring timestamps";
    assert!(run(&mut job, &progress, None, &fixture.0, &stopped)
        .unwrap_err()
        .contains("Stopped"));
    assert!(!old.exists());
    assert!(!fixture.repository().join(name).exists());
    job = load(&fixture.0, &job.id).unwrap();
    let progress = Progress::new(&job);
    run(&mut job, &progress, None, &fixture.0, &|| false).unwrap();
    let folder = fixture.repository().join(name);
    let output = job.output.unwrap();
    let upgraded = verify(&folder, name, Some(&output.digest), |_, _| {}, || false).unwrap();
    assert_eq!(upgraded.version, 3);
    assert!(upgraded.directory_stamps.is_empty());
    assert!(upgraded.root_stamp.is_none());
    assert_eq!(
        safety::identity(&folder.join("DCIM/photo.jpg"))
            .unwrap()
            .file_id,
        identity
    );
    assert_eq!(
        fs::read(folder.join("DCIM/photo.jpg")).unwrap(),
        b"recorded photo"
    );
    let history = load(&fixture.0, &legacy.id).unwrap();
    assert_eq!(history.completed_folder, job.completed_folder);
    assert_eq!(history.output.unwrap().digest, output.digest);
}

#[test]
fn removal_requires_verified_replacement_and_preserves_unlisted_files() {
    let fixture = Fixture::new();
    fixture.put("DCIM/photo.jpg", b"recorded photo");
    let old = completed_archive(&fixture);
    let fresh = completed_archive(&fixture);
    let old_folder = PathBuf::from(old.completed_folder.as_ref().unwrap());
    let fresh_folder = PathBuf::from(fresh.completed_folder.as_ref().unwrap());
    let old_output = old.output.unwrap();
    let new_output = fresh.output.unwrap();
    let manifest = checked_manifest(&old_folder, &old_output).unwrap();
    let mut job = new_job(
        &fixture.repository(),
        &old_folder,
        &manifest,
        "remove",
        Maintenance::Remove {
            original: old_output,
            replacement: new_output,
        },
    )
    .unwrap();
    fs::write(old_folder.join("unlisted.txt"), b"keep").unwrap();
    let progress = Progress::new(&job);
    assert!(run(&mut job, &progress, None, &fixture.0, &|| false)
        .unwrap_err()
        .contains("new entries"));
    assert_eq!(fs::read(old_folder.join("unlisted.txt")).unwrap(), b"keep");
    fs::remove_file(old_folder.join("unlisted.txt")).unwrap();
    let photo = fresh_folder.join("DCIM/photo.jpg");
    fs::write(&photo, b"damaged photo!").unwrap();
    let progress = Progress::new(&job);
    assert!(run(&mut job, &progress, None, &fixture.0, &|| false)
        .unwrap_err()
        .contains("checksum mismatch"));
    assert_eq!(
        fs::read(old_folder.join("DCIM/photo.jpg")).unwrap(),
        b"recorded photo"
    );
    fs::write(&photo, b"recorded photo").unwrap();
    assert!(manifest.files["DCIM/photo.jpg"]
        .stamp
        .set_times(&fs::OpenOptions::new().write(true).open(&photo).unwrap()));
    let progress = Progress::new(&job);
    let stopped = || progress.snapshot().0.phase == "Removing old archive";
    assert!(run(&mut job, &progress, None, &fixture.0, &stopped)
        .unwrap_err()
        .contains("Stopped"));
    let progress = Progress::new(&job);
    run(&mut job, &progress, None, &fixture.0, &|| false).unwrap();
    assert!(!old_folder.exists());
    assert_eq!(fs::read(&photo).unwrap(), b"recorded photo");
    let saved = load(&fixture.0, &old.id).unwrap();
    assert!(saved.completed_folder.is_none());
    assert!(saved.summary.archive_folder.is_none());
}

#[test]
fn maintenance_rejects_unrelated_folder_replacement_and_card_inventory() {
    let fixture = Fixture::new();
    fixture.put("DCIM/photo.jpg", b"original");
    let old = completed_archive(&fixture);
    let tree = PathBuf::from(old.completed_folder.as_ref().unwrap());
    let receipt = checked_manifest(&tree, old.output.as_ref().unwrap()).unwrap();
    assert!(selected_folder(&fixture.repository(), &fixture.source().to_string_lossy()).is_err());
    assert!(selected_folder(&fixture.repository(), &tree.join("DCIM").to_string_lossy()).is_err());
    assert!(require_replacement(&receipt, &receipt).is_err());
    fixture.put("DCIM/new.jpg", b"added");
    let after = scan(&fixture.source(), || false).unwrap();
    assert!(validate_recreation(
        &fixture.0,
        &fixture.repository(),
        &tree.to_string_lossy(),
        old.media_id.as_deref().unwrap(),
        &after
    )
    .is_err());
    let mut different = receipt.clone();
    different.archive_id = new_id().unwrap();
    different.files.get_mut("DCIM/photo.jpg").unwrap().sha256 = "01".repeat(32);
    assert!(require_replacement(&receipt, &different).is_err());
}

#[test]
fn verified_recreation_can_remove_a_read_only_old_file() {
    let fixture = Fixture::new();
    fixture.put("photo.jpg", b"archived read-only");
    let source = fixture.source().join("photo.jpg");
    set_fixture_attributes(&source, 0x01);
    let old = completed_archive(&fixture);
    let replacement = completed_archive(&fixture);
    let from = PathBuf::from(old.completed_folder.as_ref().unwrap());
    let target = PathBuf::from(replacement.completed_folder.as_ref().unwrap());
    assert!(fs::metadata(from.join("photo.jpg"))
        .unwrap()
        .permissions()
        .readonly());
    let output = old.output.unwrap();
    let receipt = checked_manifest(&from, &output).unwrap();
    let mut job = new_job(
        &fixture.repository(),
        &from,
        &receipt,
        "remove",
        Maintenance::Remove {
            original: output,
            replacement: replacement.output.unwrap(),
        },
    )
    .unwrap();
    let progress = Progress::new(&job);
    let result = run(&mut job, &progress, None, &fixture.0, &|| false);
    set_fixture_attributes(&source, 0x80);
    let copy = target.join("photo.jpg");
    let replacement_readonly = fs::metadata(&copy).unwrap().permissions().readonly();
    set_fixture_attributes(&copy, 0x80);
    result.unwrap();
    assert!(!from.exists());
    assert!(replacement_readonly);
    assert_eq!(fs::read(copy).unwrap(), b"archived read-only");
}

#[test]
fn matching_card_supplies_folder_and_root_times_when_the_archive_name_is_reused() {
    let fixture = Fixture::new();
    fixture.put("DCIM/photo.jpg", b"recorded photo");
    fs::create_dir(fixture.source().join("empty")).unwrap();
    let (old, manifest) = legacy_archive(&fixture);
    let old_folder = PathBuf::from(old.completed_folder.as_ref().unwrap());
    let output = old.output.unwrap();
    let original_name = output.name.clone();
    let card = Card {
        source: fixture.source().to_string_lossy().into_owned(),
        media_id: old.media_id.unwrap(),
    };
    let source = scan(&fixture.source(), || false).unwrap();
    let mut job = new_job(
        &fixture.repository(),
        &old_folder,
        &manifest,
        "upgrade",
        Maintenance::Upgrade {
            original: output,
            name: original_name.clone(),
            date: manifest.date.clone(),
            serial: None,
            card: Some(card),
        },
    )
    .unwrap();
    let progress = Progress::new(&job);
    run(&mut job, &progress, None, &fixture.0, &|| false).unwrap();
    let upgraded = verify(
        &old_folder,
        &original_name,
        Some(&job.output.unwrap().digest),
        |_, _| {},
        || false,
    )
    .unwrap();
    assert!(same_files(
        &upgraded.directory_stamps,
        &source.directory_stamps
    ));
    assert!(upgraded
        .root_stamp
        .unwrap()
        .same_file(&source.root_stamp.unwrap()));
    assert_eq!(
        fs::read(old_folder.join("DCIM/photo.jpg")).unwrap(),
        b"recorded photo"
    );
}
