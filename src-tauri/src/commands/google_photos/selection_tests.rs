//! Generated local fixtures only; no user media or account access.
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new(files: &[&str]) -> Self {
        let root = std::env::temp_dir().join(format!("photogogo-curation-scope-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        fs::create_dir_all(&root).unwrap();
        for file in files { let path = root.join(file); fs::create_dir_all(path.parent().unwrap()).unwrap(); fs::write(path, b"synthetic photograph").unwrap(); }
        Self(root)
    }
}
impl Drop for Fixture { fn drop(&mut self) { fs::remove_dir_all(&self.0).unwrap(); } }
#[test]
fn targeted_receipts_keep_full_library_identity_for_root_nested_and_crop_versions() {
    let f = Fixture::new(&["root.jpg", "event/shot.jpg", "event/shot_BW.jpg", "event/shot_improved.jpg", "event/shot_crop.jpg", "event/shot_crop_BW.jpg", "event/shot_crop_improved.jpg", "event/nested/other.jpg", "unrelated/other.jpg"]);
    let full = scan(&f.0).unwrap();
    let shallow = scan_selection(&f.0, "event/shot.jpg").unwrap();
    assert_eq!(shallow.assets.len(), 6);
    assert!(shallow.assets.iter().all(|asset| !asset.relative_path.contains("nested")));
    for asset in full.assets {
        let receipt = store::set_selection_targeted(&f.0, &asset.id, &asset.relative_path, Some(true), None).unwrap();
        assert_eq!(receipt.asset_id, asset.id); assert_eq!(receipt.relative_path, asset.relative_path);
        assert!(receipt.selected); assert!(!receipt.favourite); assert!(receipt.revision > 0);
    }
    assert!(scan(&f.0).unwrap().assets.iter().all(|asset| asset.selected));
}
#[test]
fn targeted_partial_writes_preserve_other_flags_and_other_versions() {
    let f = Fixture::new(&["event/shot.jpg", "event/shot_BW.jpg"]);
    let full = scan(&f.0).unwrap(); let asset = &full.assets[0];
    let save = |selected, favourite| store::set_selection_targeted(&f.0, &asset.id, &asset.relative_path, selected, favourite).unwrap();
    assert!(save(Some(true), None).selected);
    let receipt = save(None, Some(true)); assert!(receipt.selected && receipt.favourite);
    let receipt = save(Some(false), None); assert!(!receipt.selected && receipt.favourite);
    let next = scan(&f.0).unwrap(); assert!(!next.assets[1].selected && !next.assets[1].favourite);
    assert_eq!(receipt.revision, 3);
}
#[test]
fn stale_exact_paths_wrong_ids_and_traversal_never_write_flags() {
    let f = Fixture::new(&["event/shot.jpg"]);
    let asset = scan(&f.0).unwrap().assets.remove(0);
    for path in ["../shot.jpg", "/event/shot.jpg", "event/../event/shot.jpg", "event/./shot.jpg", "event//shot.jpg", "C:/event/shot.jpg", "event/shot.jpg:stream", "\\\\server\\share\\shot.jpg"] {
        assert!(store::set_selection_targeted(&f.0, &asset.id, path, Some(true), None).is_err(), "accepted {path}");
    }
    assert!(store::set_selection_targeted(&f.0, "wrong-id", &asset.relative_path, Some(true), None).is_err());
    assert!(store::set_selection_targeted(&f.0, &asset.id, &asset.relative_path, None, None).is_err());
    fs::rename(f.0.join("event/shot.jpg"), f.0.join("event/shot{Like o}.jpg")).unwrap();
    assert!(store::set_selection_targeted(&f.0, &asset.id, &asset.relative_path, Some(true), None).is_err());
    assert!(!f.0.join("event/.photogogo-curation.json").exists());
}
#[test]
fn ambiguous_tagged_versions_are_refused_without_a_curation_write() {
    let f = Fixture::new(&["shot{Like o}.jpg", "shot{Like oo}.jpg"]);
    for asset in scan(&f.0).unwrap().assets {
        assert!(store::set_selection_targeted(&f.0, &asset.id, &asset.relative_path, Some(true), None).is_err());
    }
    assert!(!f.0.join(".photogogo-curation.json").exists());
}
#[test]
fn corrupt_target_metadata_is_preserved_and_unrelated_corruption_is_not_scanned() {
    let f = Fixture::new(&["event/shot.jpg", "unrelated/other.jpg", "event/nested/other.jpg"]);
    let asset = scan(&f.0).unwrap().assets.into_iter().find(|asset| asset.relative_path == "event/shot.jpg").unwrap();
    fs::write(f.0.join("unrelated/.photogogo-curation.json"), b"corrupt unrelated").unwrap();
    fs::write(f.0.join("event/nested/.photogogo-curation.json"), b"corrupt nested").unwrap();
    let shallow = scan_selection(&f.0, &asset.relative_path).unwrap();
    assert_eq!(shallow.assets.len(), 1); assert!(shallow.warnings.is_empty());
    store::set_selection_targeted(&f.0, &asset.id, &asset.relative_path, Some(true), None).unwrap();
    let target = f.0.join("event/.photogogo-curation.json"); fs::write(&target, b"corrupt target").unwrap();
    assert!(store::set_selection_targeted(&f.0, &asset.id, &asset.relative_path, Some(false), None).is_err());
    assert_eq!(fs::read(target).unwrap(), b"corrupt target");
}
#[test]
fn concurrent_targeted_writers_keep_both_version_flags() {
    let f = Fixture::new(&["event/shot.jpg", "event/shot_BW.jpg"]);
    let assets = scan(&f.0).unwrap().assets;
    std::thread::scope(|scope| {
        for asset in assets { let root = &f.0; scope.spawn(move || {
            for _ in 0..5 { store::set_selection_targeted(root, &asset.id, &asset.relative_path, Some(true), Some(true)).unwrap(); }
        }); }
    });
    let after = scan(&f.0).unwrap(); assert_eq!(after.revision, 10);
    assert!(after.assets.iter().all(|asset| asset.selected && asset.favourite));
}
#[cfg(windows)]
#[test]
fn linked_photo_ancestors_cannot_redirect_a_targeted_save() {
    use std::os::windows::process::CommandExt;
    let f = Fixture::new(&[]); let outside = Fixture::new(&["private.jpg"]);
    let link = f.0.join("redirect"); let script = f.0.join("junction.ps1");
    fs::write(&script, "param([string]$Link,[string]$Target)\n$ErrorActionPreference='Stop'\nNew-Item -ItemType Junction -Path $Link -Target $Target | Out-Null\n").unwrap();
    let output = std::process::Command::new("powershell.exe").creation_flags(0x08000000)
        .args(["-NoProfile", "-NonInteractive", "-File"]).arg(&script).arg("-Link").arg(&link).arg("-Target").arg(&outside.0).output().unwrap();
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    struct Link(PathBuf); impl Drop for Link { fn drop(&mut self) { fs::remove_dir(&self.0).unwrap(); } }
    let _link = Link(link.clone());
    assert!(store::set_selection_targeted(&f.0, "not-trusted", "redirect/private.jpg", Some(true), None).is_err());
    assert!(selection_path(&link, "private.jpg").is_err());
    assert!(!outside.0.join(".photogogo-curation.json").exists());
    assert_eq!(fs::read(outside.0.join("private.jpg")).unwrap(), b"synthetic photograph");
}
#[test]
fn targeted_save_fixture_reports_library_vs_folder_work_and_timings() {
    let f = Fixture::new(&["event/shot.jpg", "event/shot_BW.jpg", "event/shot_improved.jpg"]);
    for directory in 0..80 {
        let folder = f.0.join(format!("other-{directory}")); fs::create_dir(&folder).unwrap();
        for photo in 0..10 { fs::write(folder.join(format!("other-{photo}.jpg")), b"synthetic photograph").unwrap(); }
    }
    let full = scan(&f.0).unwrap(); let asset = full.assets.iter().find(|asset| asset.relative_path == "event/shot.jpg").unwrap();
    let shallow = scan_selection(&f.0, &asset.relative_path).unwrap();
    assert_eq!(full.assets.len(), 803); assert_eq!(shallow.assets.len(), 3);
    let mut legacy = Vec::new(); let mut targeted = Vec::new();
    for _ in 0..3 {
        let start = std::time::Instant::now(); store::set_selection(&f.0, &asset.id, Some(false), None).unwrap(); legacy.push(start.elapsed().as_micros());
        let start = std::time::Instant::now(); let receipt = store::set_selection_targeted(&f.0, &asset.id, &asset.relative_path, Some(true), None).unwrap(); targeted.push(start.elapsed().as_micros()); assert!(receipt.selected);
    }
    legacy.sort_unstable(); targeted.sort_unstable();
    eprintln!("CURATION_TIMING fixture_assets=803 target_folder_assets=3 legacy_median_us={} targeted_median_us={} (local fixtures; excludes IPC and cloud-history enrichment)", legacy[1], targeted[1]);
}
