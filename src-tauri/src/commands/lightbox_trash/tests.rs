use super::*;
#[test]
fn new_derivative_after_preview_protects_remaining_original() {
    let f = Fixture::new();
    f.file("a{trash}.jpg", b"original");
    let p = plan::build_from_catalogue(
        &f.text(),
        "",
        false,
        cat(&f, &[("a{trash}.jpg", "a", "a{trash}.jpg")]),
    )
    .unwrap();
    f.file("a_BW.jpg", b"new output");
    let states = worker::run_synthetic(p, None).unwrap();
    assert!(states.iter().all(|s| s == "protected"));
    assert!(f.0.join("a{trash}.jpg").exists());
    assert!(f.0.join("a_BW.jpg").exists());
}
#[test]
fn corrupt_discard_ledger_stops_before_any_capture_member_is_removed() {
    let f = Fixture::new();
    f.file("a{trash}.jpg", b"camera");
    f.file("a_BW.jpg", b"generated");
    let p = plan::build_from_catalogue(
        &f.text(),
        "",
        false,
        cat(
            &f,
            &[
                ("a{trash}.jpg", "a", "a{trash}.jpg"),
                ("a_BW.jpg", "a", "a{trash}.jpg"),
            ],
        ),
    )
    .unwrap();
    f.file(".photogogo-discard.jsonl", b"garbage\n");
    assert!(worker::run_synthetic(p.clone(), None).is_err());
    assert!(f.0.join("a_BW.jpg").exists());
    assert!(f.0.join("a{trash}.jpg").exists());
    let bad = serde_json::json!({"version":9,"job":"trash","path":"a.jpg","bytes":6,"md5":"0".repeat(32),"sha256":"0".repeat(64),"state":"removed","at":"today"});
    let mut b = serde_json::to_vec(&bad).unwrap();
    b.push(b'\n');
    f.file(".photogogo-discard.jsonl", &b);
    assert!(worker::run_synthetic(p, None).is_err());
    assert_eq!(
        std::fs::read(f.0.join(".photogogo-discard.jsonl")).unwrap(),
        b
    );
}
#[test]
fn warm_history_detects_external_prefix_edits() {
    let f = Fixture::new();
    f.file("a.jpg", b"camera");
    f.act("a.jpg", true, "a");
    assert_eq!(history::read(&f.text(), "", 0, 50).unwrap().total, 1);
    let path = f.0.join(".photogogo-trash-history.jsonl");
    let mut b = std::fs::read(&path).unwrap();
    b[1] = b'!';
    std::fs::write(&path, &b).unwrap();
    assert!(history::read(&f.text(), "", 0, 50).is_err());
    assert!(f.0.join("a{trash}.jpg").exists());
}
#[test]
fn trash_decision_is_durable_and_idempotent() {
    let root = std::env::temp_dir().join(format!("photogogo-trash-red-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("photo.jpg"), b"synthetic original").unwrap();
    let result = decision_test_seam(&root, "photo.jpg", true, "red-token");
    assert!(
        result.is_ok(),
        "Trash decision must save and return the current exact path: {result:?}"
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn unicode_expansion_before_trash_has_no_byte_offset_panic() {
    let f = Fixture::new();
    f.file("İ{TrAsH}.jpg", b"one");
    let r = f.act("İ{TrAsH}.jpg", false, "unicode");
    assert!(!r.trashed);
    assert!(f.0.join("İ.jpg").exists());
}
#[test]
fn recovered_receipt_revision_fences_immediate_undo() {
    let f = Fixture::new();
    f.file("a.jpg", b"one");
    f.act("a.jpg", true, "a");
    let path = f.0.join(".photogogo-trash-history.jsonl");
    let b = std::fs::read(&path).unwrap();
    let end = b.iter().position(|&b| b == b'\n').unwrap() + 1;
    std::fs::write(&path, &b[..end]).unwrap();
    let r = history::apply(ActionRequest {
        staging_dir: f.text(),
        relative_path: "a.jpg".into(),
        expected_source_stamp: "retry".into(),
        action_id: "a".into(),
        trashed: true,
    })
    .unwrap();
    assert_eq!(
        r.revision,
        history::read(&f.text(), "", 0, 50).unwrap().revision
    );
    history::replay(ReplayRequest {
        staging_dir: f.text(),
        direction: "undo".into(),
        action_id: "u".into(),
        expected_revision: Some(r.revision),
    })
    .unwrap();
    assert!(f.0.join("a.jpg").exists());
}
#[test]
fn interrupted_append_is_preserved_and_history_can_recover() {
    use std::io::Write;
    let f = Fixture::new();
    f.file("a.jpg", b"one");
    f.act("a.jpg", true, "a");
    let p = f.0.join(".photogogo-trash-history.jsonl");
    std::fs::OpenOptions::new()
        .append(true)
        .open(&p)
        .unwrap()
        .write_all(b"{\"partial\":")
        .unwrap();
    let h = history::read(&f.text(), "", 0, 50).unwrap();
    assert_eq!(h.total, 1);
    assert!(h.warnings.is_empty());
    let backups = std::fs::read_dir(&f.0)
        .unwrap()
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with(".photogogo-trash-interrupted-")
        })
        .collect::<Vec<_>>();
    assert_eq!(backups.len(), 1);
    assert_eq!(std::fs::read(backups[0].path()).unwrap(), b"{\"partial\":");
}
#[test]
fn complete_corrupt_record_is_never_truncated() {
    let f = Fixture::new();
    f.file("a.jpg", b"one");
    let p = f.0.join(".photogogo-trash-history.jsonl");
    let bytes = b"{\"unknown\":true}\n{\"partial\":";
    std::fs::write(&p, bytes).unwrap();
    assert!(history::read(&f.text(), "", 0, 50).is_err());
    assert_eq!(std::fs::read(p).unwrap(), bytes);
}
#[test]
fn restore_then_retrash_invalidates_frozen_removal_approval() {
    let f = Fixture::new();
    f.file("a.jpg", b"one");
    f.act("a.jpg", true, "a");
    let p = plan::build_from_catalogue(
        &f.text(),
        "",
        false,
        cat(&f, &[("a{trash}.jpg", "a", "a{trash}.jpg")]),
    )
    .unwrap();
    f.act("a{trash}.jpg", false, "restore");
    f.act("a.jpg", true, "new-trash");
    let states = worker::run_synthetic(p, None).unwrap();
    assert!(states.iter().all(|s| s == "protected"));
    assert!(f.0.join("a{trash}.jpg").exists());
}
#[test]
fn undo_receipt_does_not_offer_blocked_earlier_action() {
    let f = Fixture::new();
    f.file("a.jpg", b"a");
    f.file("b.jpg", b"b");
    f.act("a.jpg", true, "a");
    let id = safety::identity(&f.0.join("a{trash}.jpg")).unwrap();
    history::removal_begin(&safety::root(&f.text()).unwrap(), &[id]).unwrap();
    f.act("b.jpg", true, "b");
    let receipt = f.replay("undo", "undo-b").unwrap();
    assert!(!receipt.can_undo);
    assert!(!history::read(&f.text(), "", 0, 50).unwrap().can_undo);
}
#[test]
fn shared_reader_protects_capture_from_removal() {
    let f = Fixture::new();
    f.file("a{trash}.jpg", b"one");
    let p = plan::build_from_catalogue(
        &f.text(),
        "",
        false,
        cat(&f, &[("a{trash}.jpg", "a", "a{trash}.jpg")]),
    )
    .unwrap();
    let _reader = safety::Access::acquire(&f.0, false).unwrap();
    assert!(worker::run_synthetic(p, None)
        .unwrap()
        .iter()
        .all(|s| s == "protected"));
    assert!(f.0.join("a{trash}.jpg").exists());
}
#[test]
#[ignore = "Explicit 725-decision native throughput run; use the native runner -Ignored with this test filter"]
fn native_culling_725_decisions_preserves_order_and_reports_latency() {
    let f = Fixture::new();
    let mut times = vec![];
    let start = std::time::Instant::now();
    for i in 0..725 {
        let name = format!("frame-{i:04}.jpg");
        f.file(&name, b"synthetic capture");
        let at = std::time::Instant::now();
        let r = f.act(&name, true, &format!("native-bench-{i}"));
        assert_eq!(r.relative_path, format!("frame-{i:04}{{trash}}.jpg"));
        times.push(at.elapsed().as_secs_f64() * 1000.0);
    }
    let history = history::read(&f.text(), "", 0, 100).unwrap();
    assert_eq!(history.total, 725);
    assert!(history.can_undo);
    times.sort_by(f64::total_cmp);
    eprintln!(
        "NATIVE_CULLING_725 total_s={:.3} p50_ms={:.3} p95_ms={:.3} p99_ms={:.3} max_ms={:.3}",
        start.elapsed().as_secs_f64(),
        times[362],
        times[688],
        times[717],
        times[724]
    );
}

#[test]
fn trashed_original_and_its_crop_are_not_processing_inputs() {
    let f = Fixture::new();
    f.file("a{trash}.jpg", b"original");
    f.file("a_crop.jpg", b"crop");
    assert!(!eligibility::eligible(&f.0.join("a{trash}.jpg")).unwrap());
    assert!(!eligibility::eligible(&f.0.join("a_crop.jpg")).unwrap());
}

#[test]
fn real_catalogue_ambiguous_crop_bundle_protects_camera_original() {
    let f = Fixture::new();
    for n in ["a{trash}.jpg", "a_crop.jpg", "a{Like o}_crop.jpg"] {
        f.file(n, n.as_bytes());
    }
    let p = plan::build(&f.text(), "", false).unwrap();
    assert!(!p.can_start);
    assert!(p.items.iter().all(|i| !i.included));
}

#[test]
fn changed_crop_receipt_protects_entire_capture() {
    use md5::{Digest, Md5};
    let f = Fixture::new();
    f.file("a{trash}.jpg", b"source");
    f.file("a_crop.jpg", b"changed crop");
    let fingerprint = |b: &[u8]| hex::encode(Md5::digest(b));
    let receipt = serde_json::json!({"version":1,"sourceFingerprint":fingerprint(b"source"),"crop":{"x":0.0,"y":0.0,"width":1.0,"height":1.0},"cropFingerprint":fingerprint(b"prior crop"),"bwFingerprint":null,"enhancedFingerprint":null,"bwParams":crate::commands::photo_process::BwParams::default(),"enhanceContrastLevel":1.0,"enhanceSharpnessLevel":0.5});
    f.file(
        "a_crop.photogogo-crop.json",
        &serde_json::to_vec(&receipt).unwrap(),
    );
    let p = plan::build(&f.text(), "", false).unwrap();
    assert!(!p.can_start);
    assert!(p.items.iter().all(|i| !i.included));
}

#[test]
fn cancelled_removal_keeps_remaining_originals_and_durable_states() {
    let f = Fixture::new();
    for n in ["a{trash}.jpg", "a.cr3", "a_BW.jpg"] {
        f.file(n, n.as_bytes());
    }
    let p = plan::build_from_catalogue(
        &f.text(),
        "",
        false,
        cat(
            &f,
            &[
                ("a{trash}.jpg", "a", "a.cr3"),
                ("a.cr3", "a", "a.cr3"),
                ("a_BW.jpg", "a", "a.cr3"),
            ],
        ),
    )
    .unwrap();
    let states = worker::run_synthetic(p, Some(1)).unwrap();
    assert_eq!(states.iter().filter(|s| s.as_str() == "removed").count(), 1);
    assert!(f.0.join("a{trash}.jpg").exists());
    assert!(f.0.join("a.cr3").exists());
}

#[test]
fn discard_match_requires_verified_content_and_sha_not_just_name_or_size() {
    let f = Fixture::new();
    f.file("a{trash}.jpg", b"one");
    let p = plan::build_from_catalogue(
        &f.text(),
        "",
        false,
        cat(&f, &[("a{trash}.jpg", "a", "a{trash}.jpg")]),
    )
    .unwrap();
    let item = p.items[0].clone();
    discard::record(&safety::root(&f.text()).unwrap(), &p.id, &item, "removed").unwrap();
    let index = discard::load_index(&f.0).unwrap();
    assert!(index
        .matches(item.md5.as_ref().unwrap(), 3, &f.0.join("a{trash}.jpg"))
        .unwrap());
    f.file("same-name.jpg", b"two");
    assert!(index
        .matches(item.md5.as_ref().unwrap(), 3, &f.0.join("same-name.jpg"))
        .is_err());
}

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "photogogo-trash-fixture-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn file(&self, n: &str, b: &[u8]) {
        std::fs::write(self.0.join(n), b).unwrap()
    }
    fn text(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
    fn act(&self, n: &str, value: bool, id: &str) -> Receipt {
        history::apply(ActionRequest {
            staging_dir: self.text(),
            relative_path: n.into(),
            expected_source_stamp: safety::identity(&self.0.join(n)).unwrap().modified,
            action_id: id.into(),
            trashed: value,
        })
        .unwrap()
    }
    fn replay(&self, direction: &str, id: &str) -> Result<Receipt, String> {
        history::replay(ReplayRequest {
            staging_dir: self.text(),
            direction: direction.into(),
            action_id: id.into(),
            expected_revision: None,
        })
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        assert!(self
            .0
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("photogogo-trash-fixture-"));
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
#[test]
fn undo_redo_restores_original_review_absence_and_retains_full_history() {
    let f = Fixture::new();
    f.file("a.jpg", b"one");
    let a = f.act("a.jpg", true, "action");
    assert!(a.trashed && a.reviewed);
    let h = history::read(&f.text(), "", 0, 50).unwrap();
    assert!(h.can_undo && !h.can_redo);
    let u = f.replay("undo", "undo").unwrap();
    assert!(!u.trashed && !u.review.explicit);
    assert!(f.0.join("a.jpg").exists());
    let r = f.replay("redo", "redo").unwrap();
    assert!(r.trashed);
    let h = history::read(&f.text(), "", 0, 50).unwrap();
    assert_eq!(h.total, 1);
    assert!(h.can_undo);
}
#[test]
fn retry_action_token_is_idempotent_after_rename() {
    let f = Fixture::new();
    f.file("a.jpg", b"one");
    let r = f.act("a.jpg", true, "same");
    let again = history::apply(ActionRequest {
        staging_dir: f.text(),
        relative_path: "a.jpg".into(),
        expected_source_stamp: "old".into(),
        action_id: "same".into(),
        trashed: true,
    })
    .unwrap();
    assert_eq!(r.revision, again.revision);
    assert_eq!(history::read(&f.text(), "", 0, 50).unwrap().total, 1);
}
#[test]
fn new_decision_discards_redo_branch_but_keeps_audit() {
    let f = Fixture::new();
    f.file("a.jpg", b"a");
    f.file("b.jpg", b"b");
    f.act("a.jpg", true, "a");
    f.replay("undo", "u").unwrap();
    f.act("b.jpg", true, "b");
    let h = history::read(&f.text(), "", 0, 50).unwrap();
    assert!(!h.can_redo);
    assert_eq!(h.total, 2);
}
#[test]
fn replaced_original_cannot_receive_old_undo() {
    let f = Fixture::new();
    f.file("a.jpg", b"a");
    f.act("a.jpg", true, "a");
    std::fs::remove_file(f.0.join("a{trash}.jpg")).unwrap();
    f.file("a{trash}.jpg", b"other");
    assert!(f.replay("undo", "u").is_err());
    assert_eq!(std::fs::read(f.0.join("a{trash}.jpg")).unwrap(), b"other");
}
#[test]
fn interrupted_completion_is_reconciled_without_second_rename() {
    let f = Fixture::new();
    f.file("a.jpg", b"one");
    f.act("a.jpg", true, "a");
    let p = f.0.join(".photogogo-trash-history.jsonl");
    let bytes = std::fs::read(&p).unwrap();
    let end = bytes.iter().position(|b| *b == b'\n').unwrap() + 1;
    std::fs::write(&p, &bytes[..end]).unwrap();
    let h = history::read(&f.text(), "", 0, 50).unwrap();
    assert!(h.warnings.is_empty());
    assert_eq!(h.total, 1);
    f.replay("undo", "u").unwrap();
    assert!(f.0.join("a.jpg").exists());
}
#[test]
fn review_override_change_blocks_replay_and_preserves_later_choice() {
    let f = Fixture::new();
    f.file("a.jpg", b"one");
    let a = f.act("a.jpg", true, "a");
    crate::commands::lightbox_review::replace_entry(
        &f.text(),
        &a.relative_path,
        &safety::identity(&f.0.join(&a.relative_path)).unwrap(),
        &crate::commands::lightbox_review::load(&f.0)
            .unwrap()
            .entries
            .get("a.jpg")
            .cloned(),
        Some(crate::commands::lightbox_review::ReviewEntry {
            reviewed: false,
            source_stamp: a.source_stamp,
        }),
    )
    .unwrap();
    assert!(f.replay("undo", "u").is_err());
    assert!(f.0.join("a{trash}.jpg").exists());
}
#[test]
fn permanent_removal_boundary_keeps_history_but_blocks_undo() {
    let f = Fixture::new();
    f.file("a.jpg", b"one");
    f.act("a.jpg", true, "a");
    history::purged(
        &safety::root(&f.text()).unwrap(),
        vec!["a{trash}.jpg".into()],
    )
    .unwrap();
    let h = history::read(&f.text(), "", 0, 50).unwrap();
    assert!(!h.can_undo);
    assert_eq!(h.entries[0].outcome, "permanently_removed");
}
fn cat(
    root: &Fixture,
    names: &[(&str, &str, &str)],
) -> crate::commands::google_photos::model::Catalogue {
    use crate::commands::google_photos::model::*;
    Catalogue {
        root: root.text(),
        revision: 0,
        warnings: vec![],
        assets: names
            .iter()
            .enumerate()
            .map(|(i, (name, family, original))| PhotoAsset {
                id: format!("id{i}"),
                relative_path: (*name).into(),
                path: root.0.join(name).to_string_lossy().into_owned(),
                family_id: (*family).into(),
                variant: if name.ends_with("_BW.jpg") {
                    PhotoVariant::Bw
                } else {
                    PhotoVariant::Original
                },
                bytes: std::fs::metadata(root.0.join(name)).unwrap().len(),
                modified_ms: 0,
                selected: false,
                favourite: false,
                upload_status: None,
                stars: 0,
                trashed: true,
                event_name: String::new(),
                event_date: None,
                original_path: root.0.join(original).to_string_lossy().into_owned(),
                warnings: vec![],
            })
            .collect(),
    }
}
#[test]
fn exact_capture_inventory_contains_jpeg_raw_and_owned_derivative() {
    let f = Fixture::new();
    for name in ["a{trash}.jpg", "a.cr3", "a_BW.jpg"] {
        f.file(name, name.as_bytes())
    }
    let p = plan::build_from_catalogue(
        &f.text(),
        "",
        false,
        cat(
            &f,
            &[
                ("a{trash}.jpg", "a", "a.cr3"),
                ("a.cr3", "a", "a.cr3"),
                ("a_BW.jpg", "a", "a.cr3"),
            ],
        ),
    )
    .unwrap();
    assert_eq!(p.file_count, 3);
    assert_eq!(p.capture_count, 1);
    assert!(p.items.iter().any(|i| i.kind == "camera_raw"));
}
#[test]
fn guarded_removal_unlinks_only_the_exact_owned_handle() {
    let f = Fixture::new();
    f.file("remove.jpg", b"remove");
    f.file("keep.jpg", b"keep");
    worker::delete_test_seam(&f.0, "remove.jpg").unwrap();
    assert!(!f.0.join("remove.jpg").exists());
    assert_eq!(std::fs::read(f.0.join("keep.jpg")).unwrap(), b"keep");
}

#[test]
fn durable_executor_removes_approved_members_and_preserves_other_capture() {
    let f = Fixture::new();
    for n in ["a{trash}.jpg", "a.cr3", "a_BW.jpg", "keep.jpg"] {
        f.file(n, n.as_bytes())
    }
    let p = plan::build_from_catalogue(
        &f.text(),
        "",
        false,
        cat(
            &f,
            &[
                ("a{trash}.jpg", "a", "a.cr3"),
                ("a.cr3", "a", "a.cr3"),
                ("a_BW.jpg", "a", "a.cr3"),
            ],
        ),
    )
    .unwrap();
    let states = worker::run_synthetic(p, None).unwrap();
    assert!(states.iter().all(|s| s == "removed"));
    assert!(!f.0.join("a.cr3").exists());
    assert!(!f.0.join("a_BW.jpg").exists());
    assert_eq!(std::fs::read(f.0.join("keep.jpg")).unwrap(), b"keep.jpg");
}
#[test]
fn changed_derivative_protects_remaining_camera_originals() {
    let f = Fixture::new();
    for n in ["a{trash}.jpg", "a_BW.jpg"] {
        f.file(n, n.as_bytes())
    }
    let p = plan::build_from_catalogue(
        &f.text(),
        "",
        false,
        cat(
            &f,
            &[
                ("a{trash}.jpg", "a", "a{trash}.jpg"),
                ("a_BW.jpg", "a", "a{trash}.jpg"),
            ],
        ),
    )
    .unwrap();
    f.file("a_BW.jpg", b"different");
    let states = worker::run_synthetic(p, None).unwrap();
    assert!(states.iter().all(|s| s == "protected"));
    assert!(f.0.join("a{trash}.jpg").exists());
}

#[test]
fn purged_capture_does_not_block_other_photos_history() {
    let f = Fixture::new();
    f.file("a.jpg", b"a");
    f.file("b.jpg", b"b");
    f.act("a.jpg", true, "a");
    f.act("b.jpg", true, "b");
    history::purged(
        &safety::root(&f.text()).unwrap(),
        vec!["b{trash}.jpg".into()],
    )
    .unwrap();
    let h = history::read(&f.text(), "", 0, 50).unwrap();
    assert!(
        h.can_undo,
        "A must remain undoable after B is permanently removed"
    );
    f.replay("undo", "ua").unwrap();
    assert!(f.0.join("a.jpg").exists());
}
#[test]
fn same_name_new_file_does_not_inherit_old_permanent_history_boundary() {
    let f = Fixture::new();
    f.file("a.jpg", b"old");
    f.act("a.jpg", true, "old");
    history::purged(
        &safety::root(&f.text()).unwrap(),
        vec!["a{trash}.jpg".into()],
    )
    .unwrap();
    std::fs::remove_file(f.0.join("a{trash}.jpg")).unwrap();
    f.file("a.jpg", b"new bytes");
    f.act("a.jpg", true, "new");
    assert!(history::read(&f.text(), "", 0, 50).unwrap().can_undo);
    f.replay("undo", "undo-new").unwrap();
}
#[test]
fn derivative_only_trash_cannot_authorize_original_deletion() {
    let f = Fixture::new();
    f.file("a.jpg", b"keep");
    f.file("a_BW{trash}.jpg", b"reject-version");
    let mut c = cat(
        &f,
        &[("a.jpg", "a", "a.jpg"), ("a_BW{trash}.jpg", "a", "a.jpg")],
    );
    c.assets[0].trashed = false;
    c.assets[1].variant = crate::commands::google_photos::model::PhotoVariant::Bw;
    let p = plan::build_from_catalogue(&f.text(), "", false, c).unwrap();
    assert!(!p.can_start);
    assert!(p.items.iter().all(|i| !i.included));
}
