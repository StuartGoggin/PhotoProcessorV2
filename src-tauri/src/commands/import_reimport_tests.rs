//! Synthetic filesystem regressions for imports after event naming/review.
use super::*;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "photogogo-named-reimport-{}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir_all(path.join("staging")).unwrap();
        Self(path.canonicalize().unwrap())
    }

    fn root(&self) -> PathBuf {
        self.0.join("staging")
    }
    fn day(&self, relative: &str) -> PathBuf {
        let path = self.root().join(relative);
        fs::create_dir_all(&path).unwrap();
        path
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn captured() -> chrono::NaiveDateTime {
    chrono::NaiveDate::from_ymd_opt(2026, 11, 24)
        .unwrap()
        .and_hms_milli_opt(10, 20, 30, 125)
        .unwrap()
}

#[test]
fn reimport_destination_reuses_named_day() {
    let fixture = Fixture::new();
    let event = fixture.day("2026/11/24 - AMGA Champs");
    let destination =
        destination_path(&fixture.root(), &captured(), Path::new("IMG_0001.JPG")).unwrap();
    assert_eq!(destination, event.join("20261124_102030_125.jpg"));
    assert!(!fixture.root().join("2026/11/24").exists());
}

#[test]
fn reimport_duplicate_survives_event_rename_and_missing_sidecar() {
    let fixture = Fixture::new();
    let day = fixture.day("2026/11/24");
    let original = day.join("20261124_102030_125.jpg");
    fs::write(&original, b"unchanged original photo").unwrap();
    fs::write(day.join(".photogogo-event.json"), b"event sentinel").unwrap();
    fs::write(
        day.join(".photogogo-google-photos.json"),
        b"review sentinel",
    )
    .unwrap();
    let hash = compute_md5(&original).unwrap();
    let event = day.with_file_name("24 - AMGA Champs");
    fs::rename(&day, &event).unwrap();
    let duplicate = staging_has_same_content(
        &load_existing_staging_md5_hashes(&fixture.root()),
        &build_staging_size_index(&fixture.root()),
        b"unchanged original photo".len() as u64,
        &hash,
        None,
    )
    .unwrap();
    assert_eq!(duplicate, Some(event.join("20261124_102030_125.jpg")));
    assert_eq!(
        fs::read(event.join(".photogogo-google-photos.json")).unwrap(),
        b"review sentinel"
    );
    assert_eq!(
        fs::read(event.join(".photogogo-event.json")).unwrap(),
        b"event sentinel"
    );
}

#[test]
fn reimport_does_not_trust_stale_md5_after_same_size_content_change() {
    let fixture = Fixture::new();
    let event = fixture.day("2026/11/24 - AMGA Champs");
    let original = event.join("20261124_102030_125.jpg");
    fs::write(&original, b"first photo").unwrap();
    let hash = compute_md5(&original).unwrap();
    fs::write(
        md5_sidecar_path(&original),
        format!("{hash}  20261124_102030_125.jpg\n"),
    )
    .unwrap();
    assert_eq!(
        staging_has_same_content(
            &load_existing_staging_md5_hashes(&fixture.root()),
            &build_staging_size_index(&fixture.root()),
            11,
            &hash,
            None,
        )
        .unwrap(),
        Some(original.clone())
    );
    fs::write(&original, b"other photo").unwrap();
    assert!(staging_has_same_content(
        &load_existing_staging_md5_hashes(&fixture.root()),
        &build_staging_size_index(&fixture.root()),
        11,
        &hash,
        None,
    )
    .unwrap()
    .is_none());
}

#[test]
fn reimport_date_resolution_is_local_and_does_not_guess_numeric_prefixes() {
    let fixture = Fixture::new();
    for relative in [
        "2025/11/24 - Last year",
        "2026/10/24 - Last month",
        "2026/11/23 - Yesterday",
        "2026/11/240 - Other",
        "2026/11/24backup",
        "2026/11/24 - ",
    ] {
        fixture.day(relative);
    }
    let path = destination_path(&fixture.root(), &captured(), Path::new("photo.CR3")).unwrap();
    assert_eq!(
        path,
        fixture.root().join("2026/11/24/20261124_102030_125.cr3")
    );
    // Resolution is read-only; the normal folder is created only by preparation.
    assert!(!path.parent().unwrap().exists());
    prepare_destination_parent(&fixture.root(), path.parent().unwrap()).unwrap();
    assert!(path.parent().unwrap().is_dir());
}

#[test]
fn reimport_uses_existing_unnamed_day_or_missing_month_without_side_effects() {
    let fixture = Fixture::new();
    let path = destination_path(&fixture.root(), &captured(), Path::new("photo.JPG")).unwrap();
    assert!(!fixture.root().join("2026").exists());
    let day = fixture.day("2026/11/24");
    assert_eq!(
        destination_path(&fixture.root(), &captured(), Path::new("photo.JPG")).unwrap(),
        path
    );
    assert_eq!(path.parent().unwrap(), day);
}

#[test]
fn reimport_ambiguous_days_fail_without_choosing_or_touching_existing_files() {
    for names in [
        ["24", "24 - AMGA Champs"],
        ["24 - First event", "24 - Other event"],
    ] {
        let fixture = Fixture::new();
        for name in names {
            let folder = fixture.day(&format!("2026/11/{name}"));
            fs::write(folder.join("review.json"), b"untouched").unwrap();
        }
        let error =
            destination_path(&fixture.root(), &captured(), Path::new("photo.JPG")).unwrap_err();
        assert!(
            error.contains("Multiple staging folders match 2026-11-24"),
            "{error}"
        );
        for name in names {
            let folder = fixture.root().join("2026/11").join(name);
            assert_eq!(fs::read(folder.join("review.json")).unwrap(), b"untouched");
            assert_eq!(fs::read_dir(folder).unwrap().count(), 1);
        }
    }
}

#[test]
fn reimport_preserves_canonical_reviewed_names_in_named_days() {
    let fixture = Fixture::new();
    let event = fixture.day("2026/11/24 - AMGA Champs");
    for name in [
        "20261124_102030_125.jpg",
        "20261124_102030_125_2_tagged.cr3",
    ] {
        let path = event.join(name);
        assert!(is_canonical_staging_name_for_datetime(&path, &captured()));
    }
    assert!(!is_canonical_staging_name_for_datetime(
        &fixture
            .root()
            .join("2026/10/24 - Another event/20261124_102030_125.jpg"),
        &captured(),
    ));
}

#[test]
fn reimport_rejects_regular_files_at_date_directory_components() {
    for relative in ["2026", "2026/11", "2026/11/24 - AMGA Champs"] {
        let fixture = Fixture::new();
        let path = fixture.root().join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"not a folder").unwrap();
        assert!(destination_path(&fixture.root(), &captured(), Path::new("photo.jpg")).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"not a folder");
    }
}

fn import_photo(
    fixture: &Fixture,
    source: &Path,
    session: &super::super::import_sessions::Session,
) -> Result<(PathBuf, bool), String> {
    let base = destination_path(&fixture.root(), &captured(), source)?;
    let parent = base.parent().unwrap();
    prepare_destination_parent(&fixture.root(), parent)?;
    session.prepare_parent(parent)?;
    let size = fs::metadata(source).unwrap().len();
    let mut digest = Md5::new();
    let mut staged = super::super::import_safety::stage_copy(source, parent, size, |chunk| {
        digest.update(chunk);
        Ok(())
    })?;
    let hash = hex::encode(digest.finalize());
    staged.verify(&hash, |path| {
        compute_md5(path).map_err(|error| error.to_string())
    })?;
    let existing = staging_has_same_content(
        &load_existing_staging_md5_hashes(&fixture.root()),
        &build_staging_size_index(&fixture.root()),
        size,
        &hash,
        None,
    )?;
    let _guard = session.publication.lock().unwrap();
    if let Some(path) = session.published_duplicate(&hash, size, |path| {
        compute_md5(path).map_err(|error| error.to_string())
    })? {
        return Ok((path, false));
    }
    if let Some(path) = existing {
        assert!(super::super::import_safety::matches_content(
            &path,
            size,
            &hash,
            |path| { compute_md5(path).map_err(|error| error.to_string()) }
        )?);
        return Ok((path, false));
    }
    let destination = reserve_unique_destination(base, &session.reserved);
    let _reservation = DestinationReservation(destination.clone(), session.reserved.clone());
    staged.publish(&destination)?;
    session
        .claimed
        .lock()
        .unwrap()
        .insert(hash, destination.clone());
    Ok((destination, true))
}

#[test]
fn reimport_real_copy_skips_reviewed_raw_jpeg_pair_and_preserves_different_contents() {
    let fixture = Fixture::new();
    let event = fixture.day("2026/11/24 - AMGA Champs");
    fs::write(event.join("review.json"), b"reviewed selections").unwrap();
    let session = super::super::import_sessions::try_open(&fixture.root())
        .unwrap()
        .unwrap();
    for (name, contents) in [("photo.CR3", b"RAW photo A"), ("photo.JPG", b"JPG photo A")] {
        let source = fixture.0.join(name);
        fs::write(&source, contents).unwrap();
        let (first, imported) = import_photo(&fixture, &source, &session).unwrap();
        assert!(imported);
        // Simulate a restart: no shared content registry or MD5 sidecar.
        session.claimed.lock().unwrap().clear();
        let (again, imported) = import_photo(&fixture, &source, &session).unwrap();
        assert!(!imported);
        assert_eq!(first, again);
        assert_eq!(fs::read(&source).unwrap(), contents);
        assert_eq!(fs::read(&first).unwrap(), contents);
        let mut changed_contents = contents.to_vec();
        *changed_contents.last_mut().unwrap() = b'B'; // same size, same timestamp/name
        fs::write(&source, &changed_contents).unwrap();
        let (changed, imported) = import_photo(&fixture, &source, &session).unwrap();
        assert!(imported);
        assert_ne!(changed, first);
        assert_eq!(changed.parent(), Some(event.as_path()));
        assert_eq!(fs::read(&first).unwrap(), contents);
        assert_eq!(fs::read(&changed).unwrap(), changed_contents);
        assert_eq!(fs::read(&source).unwrap(), changed_contents);
    }
    assert!(!fixture.root().join("2026/11/24").exists());
    assert_eq!(
        fs::read(event.join("review.json")).unwrap(),
        b"reviewed selections"
    );
    assert_eq!(
        fs::read_dir(event.join(".photogogo-import"))
            .unwrap()
            .count(),
        0
    );
    drop(session);
}

#[test]
fn reimport_same_contents_elsewhere_in_staging_are_skipped_globally() {
    let fixture = Fixture::new();
    fixture.day("2026/11/24 - AMGA Champs");
    let other = fixture
        .day("2026/10/03 - Other event")
        .join("different-name.JPG");
    fs::write(&other, b"photo contents").unwrap();
    let source = fixture.0.join("photo.JPG");
    fs::write(&source, b"photo contents").unwrap();
    let session = super::super::import_sessions::try_open(&fixture.root())
        .unwrap()
        .unwrap();
    let (destination, imported) = import_photo(&fixture, &source, &session).unwrap();
    assert!(!imported);
    assert_eq!(destination, other);
    assert!(!fixture.root().join("2026/11/24").exists());
}

#[test]
fn reimport_concurrent_jobs_share_named_day_without_clobbering() {
    let fixture = Fixture::new();
    let event = fixture.day("2026/11/24 - AMGA Champs");
    let session = super::super::import_sessions::try_open(&fixture.root())
        .unwrap()
        .unwrap();
    let sources = [b"photo A", b"photo A", b"photo B"]
        .into_iter()
        .enumerate()
        .map(|(i, data)| {
            let source = fixture.0.join(format!("card-{i}.jpg"));
            fs::write(&source, data).unwrap();
            source
        })
        .collect::<Vec<_>>();
    let outcomes = std::thread::scope(|scope| {
        let handles = sources
            .iter()
            .map(|source| {
                let fixture = &fixture;
                let session = &session;
                scope.spawn(move || import_photo(fixture, source, session).unwrap())
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert_eq!(outcomes.iter().filter(|(_, imported)| *imported).count(), 2);
    assert_eq!(outcomes[0].0, outcomes[1].0);
    assert_ne!(outcomes[0].0, outcomes[2].0);
    for (source, (path, _)) in sources.iter().zip(outcomes) {
        assert_eq!(fs::read(source).unwrap(), fs::read(path).unwrap());
    }
    assert!(!fixture.root().join("2026/11/24").exists());
    assert_eq!(
        fs::read_dir(event.join(".photogogo-import"))
            .unwrap()
            .count(),
        0
    );
}

#[cfg(windows)]
#[test]
fn reimport_rejects_junctions_at_every_date_level_and_before_preparation() {
    use std::os::windows::process::CommandExt;
    for relative in ["2026", "2026/11", "2026/11/24 - AMGA Champs"] {
        let fixture = Fixture::new();
        let outside = fixture.0.join("outside");
        fs::create_dir(&outside).unwrap();
        let link = fixture.root().join(relative);
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&link)
            .arg(&outside)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(destination_path(&fixture.root(), &captured(), Path::new("photo.jpg")).is_err());
        let parent = fixture.root().join("2026/11/24 - AMGA Champs");
        assert!(prepare_destination_parent(&fixture.root(), &parent).is_err());
        assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
    }
}

#[cfg(windows)]
#[test]
fn reimport_rechecks_destination_after_resolution_before_creating_work_files() {
    use std::os::windows::process::CommandExt;
    let fixture = Fixture::new();
    let path = destination_path(&fixture.root(), &captured(), Path::new("photo.jpg")).unwrap();
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent.parent().unwrap()).unwrap();
    let outside = fixture.0.join("outside");
    fs::create_dir(&outside).unwrap();
    let output = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(parent)
        .arg(&outside)
        .creation_flags(0x08000000)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(prepare_destination_parent(&fixture.root(), parent).is_err());
    assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
}
