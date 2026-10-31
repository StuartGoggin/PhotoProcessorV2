use super::*;
struct Fixture {
    root: PathBuf,
    base: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let mut nonce = [0u8; 12];
        getrandom::fill(&mut nonce).unwrap();
        let base = std::env::temp_dir().canonicalize().unwrap();
        let root = base.join(format!("photogogo-ledger-{}", hex::encode(nonce)));
        fs::create_dir_all(root.join("_transfer_manifests")).unwrap();
        Self { root, base }
    }
    fn hash(path: &Path) -> Result<String, String> {
        crate::utils::compute_md5(path).map_err(|e| e.to_string())
    }
    fn ledger(&self) -> Ledger {
        Ledger::open(&self.root, Vec::new(), Self::hash).unwrap()
    }
    fn publish(&self, name: &str, bytes: &[u8]) -> String {
        fs::write(self.root.join(name), bytes).unwrap();
        Self::hash(&self.root.join(name)).unwrap()
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
                .starts_with("photogogo-ledger-")
        {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}
#[test]
fn invalid_hashes_and_escaped_records_are_refused() {
    for path in ["../outside", "C:/secret", "/absolute", "a:stream"] {
        assert!(parse_line(&format!("{}  {path}", "a".repeat(32))).is_none());
    }
    assert!(parse_line("not-a-hash  horse.jpg").is_none());
}
#[test]
fn replacement_failure_preserves_the_entire_previous_index() {
    let f = Fixture::new();
    let master = f.root.join(MASTER);
    fs::write(&master, b"old complete bytes").unwrap();
    assert!(atomic_write_using(&master, b"new bytes", |_, _| Err(
        "injected rename failure".into()
    ))
    .is_err());
    assert_eq!(fs::read(master).unwrap(), b"old complete bytes");
}
#[test]
fn published_but_unconfirmed_intent_survives_finish_and_recovers() {
    let f = Fixture::new();
    let mut ledger = f.ledger();
    let staged = f.root.join("private.partial");
    fs::write(&staged, b"verified content").unwrap();
    let hash = Fixture::hash(&staged).unwrap();
    ledger.intent("horse.jpg", &hash, 16).unwrap();
    let lost_ack: Result<(), String> = (|| {
        super::super::import_safety::rename_new(&staged, &f.root.join("horse.jpg"))
            .map_err(|e| e.to_string())?;
        Err("injected lost acknowledgement after actual no-overwrite publication".into())
    })();
    assert!(lost_ack.is_err());
    assert!(ledger.finish("lost-ack", "partial").is_err());
    assert!(f.root.join(JOURNAL).exists());
    drop(ledger);
    let recovered = f.ledger();
    assert_eq!(recovered.recovered, 1);
    assert_eq!(recovered.entries.get("horse.jpg"), Some(&hash));
    assert!(recovered.outcomes.is_empty());
}
#[test]
fn outcome_unknown_publication_is_reconciled_without_rereading_confirmed_files() {
    let f = Fixture::new();
    let mut ledger = f.ledger();
    let a = f.publish("known.jpg", b"known");
    ledger.intent("known.jpg", &a, 5).unwrap();
    ledger.confirm("known.jpg", &a).unwrap();
    let b = f.publish("unknown.jpg", b"unknown");
    ledger.intent("unknown.jpg", &b, 7).unwrap();
    let mut paths = Vec::new();
    assert_eq!(
        ledger
            .settle_pending(|p| {
                paths.push(p.file_name().unwrap().to_string_lossy().into_owned());
                Fixture::hash(p)
            })
            .unwrap(),
        1
    );
    assert_eq!(paths, vec!["unknown.jpg"]);
    ledger.finish("reconciled", "partial").unwrap();
    assert_eq!(read_entries(&f.root.join(MASTER)).unwrap().len(), 2);
}
#[test]
fn failed_checkpoint_retains_durable_intents_for_retry() {
    let f = Fixture::new();
    let mut ledger = f.ledger();
    let hash = f.publish("horse.jpg", b"content");
    ledger.intent("horse.jpg", &hash, 7).unwrap();
    ledger.confirm("horse.jpg", &hash).unwrap();
    fs::create_dir(f.root.join(MASTER)).unwrap();
    assert!(ledger.checkpoint().is_err());
    assert!(f.root.join(JOURNAL).exists());
    fs::remove_dir(f.root.join(MASTER)).unwrap();
    ledger.checkpoint().unwrap();
    assert!(f.root.join(JOURNAL).exists());
    ledger.finish("retried", "completed").unwrap();
    assert_eq!(
        read_entries(&f.root.join(MASTER)).unwrap().get("horse.jpg"),
        Some(&hash)
    );
}
#[test]
fn repaired_current_job_record_wins_over_stale_cleanup() {
    let f = Fixture::new();
    let mut ledger = f.ledger();
    let hash = f.publish("horse.jpg", b"current");
    ledger.intent("horse.jpg", &hash, 7).unwrap();
    ledger.confirm("horse.jpg", &hash).unwrap();
    ledger.mark_stale("horse.jpg", &hash);
    ledger.finish("repair", "completed").unwrap();
    assert_eq!(
        read_entries(&f.root.join(MASTER)).unwrap().get("horse.jpg"),
        Some(&hash)
    );
}
#[test]
fn reservations_protect_other_selected_natural_names() {
    let f = Fixture::new();
    f.publish("horse.jpg", b"old");
    let mut ledger = Ledger::open(
        &f.root,
        vec!["horse.jpg".into(), "horse_1.jpg".into()],
        Fixture::hash,
    )
    .unwrap();
    assert_eq!(
        ledger.reserve("horse.jpg").unwrap(),
        ("horse_2.jpg".into(), true)
    );
    assert_eq!(
        ledger.reserve("horse_1.jpg").unwrap(),
        ("horse_1.jpg".into(), false)
    );
}
#[test]
fn truncated_last_journal_record_is_retired_before_new_append() {
    let f = Fixture::new();
    let hash = f.publish("horse.jpg", b"old");
    {
        let mut ledger = f.ledger();
        ledger.intent("horse.jpg", &hash, 3).unwrap();
    }
    OpenOptions::new()
        .append(true)
        .open(f.root.join(JOURNAL))
        .unwrap()
        .write_all(b"{unterminated")
        .unwrap();
    {
        let mut ledger = f.ledger();
        assert_eq!(ledger.recovered, 1);
        let next = f.publish("rider.jpg", b"next");
        ledger.intent("rider.jpg", &next, 4).unwrap();
    }
    let recovered = f.ledger();
    assert_eq!(recovered.recovered, 1);
    assert_eq!(recovered.entries.len(), 2);
}
#[test]
fn damaged_complete_journal_line_blocks_without_discarding_evidence() {
    let f = Fixture::new();
    fs::write(f.root.join(JOURNAL), b"{broken}\n").unwrap();
    assert!(Ledger::open(&f.root, Vec::new(), Fixture::hash).is_err());
    assert_eq!(fs::read(f.root.join(JOURNAL)).unwrap(), b"{broken}\n");
}
#[test]
fn missing_or_mismatched_intent_never_changes_user_files() {
    let f = Fixture::new();
    let mut ledger = f.ledger();
    let expected = "a".repeat(32);
    ledger.intent("missing.jpg", &expected, 4).unwrap();
    ledger.intent("existing.jpg", &expected, 5).unwrap();
    f.publish("existing.jpg", b"other");
    drop(ledger);
    let recovered = f.ledger();
    assert_eq!(recovered.recovered, 0);
    assert!(recovered.entries.is_empty());
    assert_eq!(fs::read(f.root.join("existing.jpg")).unwrap(), b"other");
}
#[test]
fn latest_pointer_selects_actual_outcome_not_old_lexicographic_manifests() {
    let f = Fixture::new();
    fs::write(
        f.root.join("_transfer_manifests/zzz-old.md5"),
        format!("{}  old.jpg\n", "a".repeat(32)),
    )
    .unwrap();
    let mut ledger = f.ledger();
    let hash = f.publish("new.jpg", b"new");
    ledger.intent("new.jpg", &hash, 3).unwrap();
    ledger.confirm("new.jpg", &hash).unwrap();
    ledger.finish("new-run", "partial").unwrap();
    let (path, label) = verification_manifest(&f.root, "latest").unwrap();
    assert!(path.ends_with("transfer-new-run.md5"));
    assert!(label.contains("partial"));
    assert_eq!(read_entries(&path).unwrap().len(), 1);
}
#[test]
fn archive_verify_prefers_master_and_latest_refuses_implicit_old_fallback() {
    let f = Fixture::new();
    fs::write(
        f.root.join(MASTER),
        format!("{}  new.jpg\n", "b".repeat(32)),
    )
    .unwrap();
    fs::write(
        f.root.join("_transfer_manifests/zzz-old.md5"),
        format!("{}  old.jpg\n", "a".repeat(32)),
    )
    .unwrap();
    assert!(verification_manifest(&f.root, "archive")
        .unwrap()
        .0
        .ends_with(MASTER));
    assert!(verification_manifest(&f.root, "latest").is_err());
}
#[test]
fn legacy_only_archive_keeps_its_coverage_after_first_new_transfer() {
    let f = Fixture::new();
    let old = f.publish("old.jpg", b"old");
    fs::write(f.root.join("checksums.md5"), format!("{old}  old.jpg\n")).unwrap();
    let mut ledger = f.ledger();
    let new = f.publish("new.jpg", b"new");
    ledger.intent("new.jpg", &new, 3).unwrap();
    ledger.confirm("new.jpg", &new).unwrap();
    ledger.finish("migration", "completed").unwrap();
    let entries = read_entries(&f.root.join(MASTER)).unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries.get("old.jpg"), Some(&old));
    assert_eq!(
        read_entries(&verification_manifest(&f.root, "latest").unwrap().0)
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn invalid_master_rows_and_conflicting_paths_do_not_get_silently_compacted() {
    let f = Fixture::new();
    fs::write(
        f.root.join(MASTER),
        format!(
            "{}  horse.jpg\n{}  horse.jpg\n",
            "a".repeat(32),
            "b".repeat(32)
        ),
    )
    .unwrap();
    assert!(Ledger::open(&f.root, Vec::new(), Fixture::hash).is_err());
    fs::write(f.root.join(MASTER), b"invalid old row\n").unwrap();
    assert!(Ledger::open(&f.root, Vec::new(), Fixture::hash).is_err());
}
#[test]
fn failed_manifest_commit_keeps_recovery_records_and_never_replaces_existing_manifest() {
    let f = Fixture::new();
    let mut ledger = f.ledger();
    let hash = f.publish("horse.jpg", b"content");
    ledger.intent("horse.jpg", &hash, 7).unwrap();
    ledger.confirm("horse.jpg", &hash).unwrap();
    fs::write(
        f.root.join("_transfer_manifests/transfer-conflict.md5"),
        b"prior receipt",
    )
    .unwrap();
    assert!(ledger.finish("conflict", "completed").is_err());
    assert!(f.root.join(JOURNAL).exists());
    assert_eq!(
        fs::read(f.root.join("_transfer_manifests/transfer-conflict.md5")).unwrap(),
        b"prior receipt"
    );
    ledger.finish("fresh", "completed").unwrap();
    assert!(!f.root.join(JOURNAL).exists());
}
