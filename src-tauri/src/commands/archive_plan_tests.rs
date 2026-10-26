use super::*;

struct Fixture {
    root: PathBuf,
    stage: PathBuf,
    archive: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let mut random = [0; 12];
        getrandom::fill(&mut random).unwrap();
        let root =
            std::env::temp_dir().join(format!("photogogo-archive-test-{}", hex::encode(random)));
        let stage = root.join("stage");
        let archive = root.join("archive");
        fs::create_dir_all(&stage).unwrap();
        Self {
            root,
            stage,
            archive,
        }
    }
    fn file(&self, relative: &str, bytes: &[u8]) -> PathBuf {
        let path = self.stage.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        path.canonicalize().unwrap()
    }
    fn request(&self) -> Request {
        let all = Rule {
            mode: SelectionMode::All,
            min_stars: 1,
        };
        let selected = Rule {
            mode: SelectionMode::GoogleSelected,
            min_stars: 1,
        };
        Request {
            staging_dir: self.stage.to_string_lossy().into(),
            archive_dir: self.archive.to_string_lossy().into(),
            scope_dir: None,
            rules: Rules {
                originals: all,
                bw: selected.clone(),
                enhanced: selected.clone(),
                crops: selected.clone(),
                crop_bw: selected.clone(),
                crop_enhanced: selected,
            },
            exclude_trash: true,
            include_videos: true,
            include_source_originals: false,
            include_library_metadata: false,
            include_camera_sidecars: true,
        }
    }
    fn selections(&self, directory: &str, names: &[&str]) {
        let entries: serde_json::Map<_, _> = names
            .iter()
            .map(|n| {
                (
                    n.to_string(),
                    serde_json::json!({"selected":true,"favourite":false}),
                )
            })
            .collect();
        self.file(
            &format!("{directory}.photogogo-curation.json"),
            serde_json::to_string(
                &serde_json::json!({"schemaVersion":1,"revision":1,"entries":entries}),
            )
            .unwrap()
            .as_bytes(),
        );
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn selected(plan: &FrozenPlan) -> Vec<String> {
    plan.preview
        .items
        .iter()
        .filter(|i| i.included)
        .map(|i| i.relative_path.clone())
        .collect()
}
fn item<'a>(plan: &'a FrozenPlan, path: &str) -> &'a Item {
    plan.preview
        .items
        .iter()
        .find(|i| i.relative_path == path)
        .unwrap()
}

#[test]
fn exact_version_google_selection_does_not_select_siblings_or_source() {
    let f = Fixture::new();
    f.file("horse.jpg", b"original");
    f.file("horse_BW.jpg", b"bw");
    f.file("horse_improved.jpg", b"colour");
    f.selections("", &["horse_bw.jpg"]);
    let mut request = f.request();
    request.rules.originals.mode = SelectionMode::None;
    let plan = build(request.clone()).unwrap();
    assert_eq!(selected(&plan), ["horse_BW.jpg"]);
    assert!(plan.preview.can_start);
    request.include_source_originals = true;
    assert_eq!(selected(&build(request).unwrap()).len(), 2);
}

#[test]
fn trash_overrides_all_rules_and_source_retention() {
    let f = Fixture::new();
    f.file("horse{trash}.jpg", b"original");
    f.file("horse_BW.jpg", b"bw");
    f.selections("", &["horse_bw.jpg"]);
    let mut request = f.request();
    request.include_source_originals = true;
    let plan = build(request.clone()).unwrap();
    assert!(selected(&plan).is_empty());
    assert!(item(&plan, "horse_BW.jpg").reason.contains("Trashed"));
    request.exclude_trash = false;
    assert_eq!(selected(&build(request).unwrap()).len(), 2);
}

#[test]
fn independent_ratings_include_inherited_source_rating_and_crops() {
    let f = Fixture::new();
    f.file("horse{Like oo}.jpg", b"a");
    f.file("horse_BW.jpg", b"b");
    f.file("horse_crop.jpg", b"c");
    f.file("horse_crop_BW.jpg", b"d");
    f.file("other.jpg", b"e");
    let mut r = f.request();
    r.rules.originals = Rule {
        mode: SelectionMode::Rated,
        min_stars: 3,
    };
    r.rules.bw = Rule {
        mode: SelectionMode::Rated,
        min_stars: 2,
    };
    r.rules.crops.mode = SelectionMode::None;
    r.rules.crop_bw = Rule {
        mode: SelectionMode::Rated,
        min_stars: 2,
    };
    let plan = build(r).unwrap();
    assert_eq!(selected(&plan), ["horse_BW.jpg", "horse_crop_BW.jpg"]);
}

#[test]
fn raw_originals_and_videos_have_independent_controls() {
    let f = Fixture::new();
    for name in [
        "a.cr3", "b.dng", "c.nef", "d.arw", "e.cr2", "f.raf", "g.orf", "h.rw2",
    ] {
        f.file(name, b"raw");
    }
    f.file("movie.mov", b"video");
    let mut r = f.request();
    r.include_videos = false;
    let plan = build(r).unwrap();
    assert_eq!(selected(&plan).len(), 8);
    assert!(!item(&plan, "movie.mov").included);
}

#[test]
fn metadata_and_media_looking_caches_are_excluded_but_genuine_sidecars_follow_media() {
    let f = Fixture::new();
    f.file("horse{Like oo}.jpg", b"photo");
    f.file("horse.xmp", b"user metadata");
    f.file("horse.jpg.json", b"camera");
    f.selections("", &[]);
    f.file(".photogogo-event.json", b"{}");
    f.file("horse.photogogo-crop.json", b"recipe");
    f.file("horse.snapshot.json", b"provenance");
    f.file(".photogogo/thumb-cache/a.jpg", b"cache");
    f.file(".photogogo-metadata-backups/date/horse.jpg", b"backup");
    f.file(".photogogo-video-studio-cache/a.mp4", b"cache");
    f.file("horse.jpg.pgg.video-hover-preview.1.mp4", b"preview");
    f.file("import-job-1.log", b"log");
    f.file("custom.json", b"unrelated");
    let r = f.request();
    let plan = build(r.clone()).unwrap();
    assert_eq!(
        selected(&plan),
        ["horse.jpg.json", "horse.xmp", "horse{Like oo}.jpg"]
    );
    let mut with_metadata = r;
    with_metadata.include_library_metadata = true;
    let plan = build(with_metadata).unwrap();
    assert!(item(&plan, ".photogogo-curation.json").included);
    assert!(item(&plan, "horse.photogogo-crop.json").included);
    assert!(!item(&plan, ".photogogo-metadata-backups/date/horse.jpg").included);
    assert!(!item(&plan, "custom.json").included);
}

#[test]
fn excluded_media_does_not_drag_in_its_camera_sidecar() {
    let f = Fixture::new();
    f.file("horse.jpg", b"a");
    f.file("horse.xmp", b"xmp");
    let mut r = f.request();
    r.rules.originals.mode = SelectionMode::None;
    let plan = build(r).unwrap();
    assert!(selected(&plan).is_empty());
    assert!(!plan.preview.can_start);
}

#[test]
fn scope_is_contained_and_cannot_bypass_internal_folder_exclusions() {
    let f = Fixture::new();
    f.file("event/a.jpg", b"a");
    f.file("other/b.jpg", b"b");
    let mut r = f.request();
    r.scope_dir = Some(f.stage.join("event").to_string_lossy().into());
    assert_eq!(selected(&build(r.clone()).unwrap()), ["event/a.jpg"]);
    r.scope_dir = Some(f.root.to_string_lossy().into());
    assert!(build(r.clone()).is_err());
    f.file(".photogogo-metadata-backups/date/backup.jpg", b"a");
    r.scope_dir = Some(
        f.stage
            .join(".photogogo-metadata-backups/date")
            .to_string_lossy()
            .into(),
    );
    assert!(build(r).is_err());
}

#[test]
fn preview_does_not_create_archive_and_tokens_are_single_use_and_bound_to_destination() {
    let f = Fixture::new();
    f.file("horse.jpg", b"a");
    let request = f.request();
    let p = preview(request.clone()).unwrap();
    assert!(!f.archive.exists());
    assert!(take(&p.id, &request.staging_dir, &request.archive_dir).is_ok());
    assert!(take(&p.id, &request.staging_dir, &request.archive_dir).is_err());
    let p = preview(request.clone()).unwrap();
    assert!(take(
        &p.id,
        &request.staging_dir,
        &f.root.join("other").to_string_lossy()
    )
    .is_err());
}

#[test]
fn added_removed_changed_and_selection_modified_files_require_a_fresh_preview() {
    let f = Fixture::new();
    let source = f.file("horse.jpg", b"a");
    let plan = build(f.request()).unwrap();
    f.file("new.jpg", b"b");
    assert!(plan.revalidate().is_err());
    fs::remove_file(f.stage.join("new.jpg")).unwrap();
    let plan = build(f.request()).unwrap();
    fs::write(&source, b"a larger file").unwrap();
    assert!(plan.revalidate().is_err());
    let plan = build(f.request()).unwrap();
    fs::remove_file(&source).unwrap();
    assert!(plan.revalidate().is_err());
    f.file("horse.jpg", b"a");
    let plan = build(f.request()).unwrap();
    f.selections("", &["horse.jpg"]);
    assert!(plan.revalidate().is_err());
}

#[test]
fn operational_log_growth_and_new_cache_files_do_not_invalidate_selection() {
    let f = Fixture::new();
    f.file("horse.jpg", b"a");
    f.file("import-job-1.log", b"small");
    let plan = build(f.request()).unwrap();
    f.file("import-job-1.log", b"more progress");
    f.file(".photogogo/thumb-cache/a.jpg", b"new cache");
    f.file(".photogogo-metadata-backups/date/a.jpg", b"backup");
    f.file(
        ".photogogo-metadata-backups/date/.photogogo-curation.json",
        b"{damaged old metadata",
    );
    plan.revalidate().unwrap();
}

#[test]
fn corrupt_curation_and_orphan_versions_are_never_silently_archived_as_originals() {
    let f = Fixture::new();
    f.file("a.jpg", b"a");
    f.file("orphan_BW.jpg", b"b");
    let plan = build(f.request()).unwrap();
    assert!(!item(&plan, "orphan_BW.jpg").included);
    f.file(".photogogo-curation.json", b"{broken");
    let plan = build(f.request()).unwrap();
    assert!(!plan.preview.can_start);
    assert!(!plan.preview.warnings.is_empty());
}

#[test]
fn fresh_hashes_ignore_stale_sidecars_and_copies_are_verified_without_overwrite() {
    let f = Fixture::new();
    let source = f.file("horse.jpg", b"current bytes");
    f.file(
        "horse.jpg.md5",
        b"00000000000000000000000000000000  horse.jpg",
    );
    let plan = build(f.request()).unwrap();
    let hash = plan.hash_source(&source).unwrap();
    assert_ne!(hash, "00000000000000000000000000000000");
    fs::create_dir_all(&plan.archive).unwrap();
    let destination = plan.archive.join("horse.jpg");
    fs::write(&destination, b"existing archive bytes").unwrap();
    assert!(plan
        .copy_verified(&source, &destination, &hash, || Ok(()))
        .is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"existing archive bytes");
    let renamed = plan.archive.join("horse_1.jpg");
    assert_eq!(
        plan.copy_verified(&source, &renamed, &hash, || Ok(()))
            .unwrap(),
        13
    );
    assert_eq!(crate::utils::compute_md5(&renamed).unwrap(), hash);
    assert_eq!(fs::read(&source).unwrap(), b"current bytes");
}

#[test]
fn source_mutation_and_abort_publish_nothing() {
    let f = Fixture::new();
    let source = f.file("horse.jpg", b"original");
    let plan = build(f.request()).unwrap();
    let hash = plan.hash_source(&source).unwrap();
    fs::create_dir_all(&plan.archive).unwrap();
    let dst = plan.archive.join("horse.jpg");
    assert!(plan
        .copy_verified(&source, &dst, &hash, || Err("aborted".into()))
        .is_err());
    assert!(!dst.exists());
    fs::write(&source, b"changed after preview").unwrap();
    assert!(plan.copy_verified(&source, &dst, &hash, || Ok(())).is_err());
    assert!(!dst.exists());
}

#[test]
fn root_overlap_and_untrusted_checksum_paths_are_rejected() {
    let f = Fixture::new();
    f.file("a.jpg", b"a");
    let mut r = f.request();
    r.archive_dir = r.staging_dir.clone();
    assert!(build(r.clone()).is_err());
    r.archive_dir = f.stage.join("nested/missing").to_string_lossy().into();
    assert!(build(r.clone()).is_err());
    r.archive_dir = f.root.to_string_lossy().into();
    assert!(build(r).is_err());
    for path in [
        "../escape.jpg",
        "/absolute.jpg",
        "C:\\secret.jpg",
        "a:stream",
        "a/../b",
        "a\\..\\b",
        "a\nname",
        "a//b",
        "NUL.jpg",
        "event/COM1",
        "event/LPT9.txt",
        "event/CON",
        "event/horse.jpg.",
    ] {
        assert!(relative_path(path).is_err(), "{path}");
    }
    assert_eq!(
        relative_path("event/horse.jpg").unwrap(),
        Path::new("event").join("horse.jpg")
    );
}

#[test]
fn depth_limit_refuses_an_incomplete_preview() {
    let f = Fixture::new();
    let mut path = PathBuf::new();
    for _ in 0..33 {
        path.push("d");
    }
    f.file(&format!("{}/a.jpg", normalized(&path)), b"a");
    assert!(build(f.request()).is_err());
}

#[test]
fn expired_preview_and_invalid_rating_are_refused() {
    let f = Fixture::new();
    f.file("horse.jpg", b"a");
    let mut r = f.request();
    r.rules.originals.min_stars = 0;
    assert!(build(r.clone()).is_err());
    r.rules.originals.min_stars = 4;
    assert!(build(r.clone()).is_err());
    r.rules.originals.min_stars = 1;
    let p = preview(r.clone()).unwrap();
    previews().lock().unwrap().get_mut(&p.id).unwrap().made_at =
        Instant::now() - PREVIEW_LIFETIME - Duration::from_secs(1);
    assert!(take(&p.id, &r.staging_dir, &r.archive_dir).is_err());
}

#[test]
fn archive_selection_receipt_is_explicit_about_review_and_never_overwrites() {
    let f = Fixture::new();
    f.file("horse.jpg", b"a");
    let plan = build(f.request()).unwrap();
    fs::create_dir_all(&plan.archive).unwrap();
    let receipt = plan.archive.join("selection.json");
    plan.write_receipt(&receipt).unwrap();
    let bytes = fs::read(&receipt).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(value["state"], "reviewed_selection");
    assert_eq!(value["preview"]["summary"]["includedCount"], 1);
    assert!(plan.write_receipt(&receipt).is_err());
    assert_eq!(fs::read(&receipt).unwrap(), bytes);
    assert!(plan.write_receipt(&f.root.join("escaped.json")).is_err());
}

#[cfg(windows)]
#[test]
fn junction_ancestors_cannot_redirect_inventory_or_archive_publication() {
    let f = Fixture::new();
    f.file("horse.jpg", b"a");
    let plan = build(f.request()).unwrap();
    fs::create_dir_all(&plan.archive).unwrap();
    let outside = f.root.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("private.jpg"), b"private").unwrap();
    let link = plan.archive.join("redirect");
    let script = f.root.join("make-test-junction.ps1");
    fs::write(&script,"param([string]$Link,[string]$Target)\n$ErrorActionPreference='Stop'\nNew-Item -ItemType Junction -Path $Link -Target $Target | Out-Null\n").unwrap();
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-File"])
        .arg(&script)
        .arg("-Link")
        .arg(&link)
        .arg("-Target")
        .arg(&outside)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // Remove only the test junction, before the fixture's ordinary tree cleanup.
    struct Link(PathBuf);
    impl Drop for Link {
        fn drop(&mut self) {
            let _ = fs::remove_dir(&self.0);
        }
    }
    let _link_guard = Link(link.clone());
    assert!(safe_destination(&plan.archive, "redirect/private.jpg").is_err());
    let mut r = f.request();
    r.staging_dir = plan.archive.to_string_lossy().into();
    r.archive_dir = f.root.join("another-archive").to_string_lossy().into();
    assert!(build(r).is_err());
    assert_eq!(fs::read(outside.join("private.jpg")).unwrap(), b"private");
}
