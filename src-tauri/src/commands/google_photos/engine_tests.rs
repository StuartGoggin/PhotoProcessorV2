//! Protocol contract tests: deterministic fake service, synthetic photographs,
//! temporary sealed store. These tests never connect to Google or user media.
use super::*;
use crate::commands::google_photos::{
    catalogue, model, plan,
    store::Sealer,
    transport::{Offset, Registration},
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{atomic::AtomicU64, Arc},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

#[test]
fn core_jobs_project_one_authoritative_upload_with_safe_counts_and_log() {
    let mut fixture = Fixture::core(4);
    let mut api = FakeGoogle { verify_error_on_call: Some((3, ReadbackError::ItemRejected("Google media read-back failed: INVALID_ARGUMENT (code 3). bearer fixture-secret private@example.test".into()))), ..Default::default() };
    let error = fixture
        .drive(&mut api, &AtomicBool::new(false))
        .unwrap_err();
    finish_error(&fixture.store, &mut fixture.job, error, false).unwrap();
    let row = super::super::core_jobs::project(&fixture.job, Some(&fixture.job.plan.account_id));
    assert_eq!(row.id, fixture.job.plan.id);
    assert!(matches!(
        row.task,
        crate::commands::process::ProcessTask::GooglePhotos
    ));
    assert!(matches!(
        row.status,
        crate::commands::process::ProcessJobStatus::NeedsAttention
    ));
    assert_eq!(row.can_continue, Some(true));
    assert_eq!(row.result_count, 3);
    let details = row.google_photos.as_ref().unwrap();
    assert_eq!(
        (
            details.accepted,
            details.uploaded,
            details.awaiting_verification
        ),
        (4, 3, 1)
    );
    assert!(row.logs.join("\n").contains("INVALID_ARGUMENT (code 3)"));
    let wire = serde_json::to_string(&row).unwrap();
    for secret in [
        "fixture-secret",
        "private@example.test",
        "test-session",
        "media-token",
    ] {
        assert!(!wire.contains(secret));
    }
    assert!(wire.contains("\"task\":\"googlePhotos\""));
    assert!(wire.contains("\"status\":\"needs_attention\""));
    assert!(
        !crate::commands::process::process_jobs_store()
            .lock()
            .unwrap()
            .contains_key(&row.id),
        "a durable upload must never be mirrored into a second mutable core state"
    );
}

#[test]
fn core_jobs_history_archives_only_resolved_jobs_and_keeps_receipts_and_ledger() {
    let mut fixture = Fixture::core(1);
    fixture
        .drive(&mut FakeGoogle::default(), &AtomicBool::new(false))
        .unwrap();
    let ledger = fixture
        .store
        .load::<Vec<LedgerEntry>>("ledger")
        .unwrap()
        .unwrap();
    let receipt = fixture.job.items[0].media.as_ref().unwrap().id.clone();
    assert_eq!(
        super::super::core_jobs::archive_store(&fixture.store).unwrap(),
        1
    );
    fixture.reload();
    assert!(fixture.job.history_hidden);
    assert_eq!(fixture.job.items[0].media.as_ref().unwrap().id, receipt);
    assert_eq!(
        serde_json::to_string(
            &fixture
                .store
                .load::<Vec<LedgerEntry>>("ledger")
                .unwrap()
                .unwrap()
        )
        .unwrap(),
        serde_json::to_string(&ledger).unwrap()
    );
    assert!(
        super::super::core_jobs::stored_jobs(&fixture.store, None, &[], true)
            .unwrap()
            .is_empty()
    );
    // Even an older hidden record must reappear if a receipt needs attention.
    fixture.job.items[0].state = "registered".into();
    fixture.job.save(&fixture.store).unwrap();
    let rows = super::super::core_jobs::stored_jobs(&fixture.store, None, &[], true).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(matches!(
        rows[0].status,
        crate::commands::process::ProcessJobStatus::NeedsAttention
    ));
    assert_eq!(rows[0].google_photos.as_ref().unwrap().accepted, 1);
}

#[test]
fn core_jobs_pending_stopped_failed_and_uncertain_uploads_cannot_be_hidden() {
    let mut fixture = Fixture::core(1);
    fixture
        .drive(&mut FakeGoogle::default(), &AtomicBool::new(false))
        .unwrap();
    let finished = fixture.job.clone();
    for state in [
        "running",
        "paused",
        "aborted",
        "needs_attention",
        "completed_with_errors",
        "failed",
    ] {
        fixture.job = finished.clone();
        fixture.job.status = state.into();
        fixture.job.save(&fixture.store).unwrap();
        assert_eq!(
            super::super::core_jobs::archive_store(&fixture.store).unwrap(),
            0,
            "{state}"
        );
        assert!(
            !fixture
                .store
                .load::<Job>(&format!("job_{}", fixture.job.plan.id))
                .unwrap()
                .unwrap()
                .history_hidden
        );
    }
    fixture.job = finished;
    fixture.job.albums[0].state = "creation_outcome_unknown".into();
    assert!(!super::super::core_jobs::history_eligible(&fixture.job));
    fixture.job.albums[0].state = "ready".into();
    fixture.job.items[0].state = "blocked".into();
    assert!(!super::super::core_jobs::history_eligible(&fixture.job));
}

#[test]
fn core_jobs_account_backoff_and_stale_state_disable_continuation() {
    let fixture = Fixture::core(1);
    let account = fixture.job.plan.account_id.clone();
    assert_eq!(
        super::super::core_jobs::project(&fixture.job, None).can_continue,
        Some(false)
    );
    assert_eq!(
        super::super::core_jobs::project(&fixture.job, Some("other-client-account")).can_continue,
        Some(false)
    );
    let mut delayed = fixture.job.clone();
    delayed.retry_after = chrono::Utc::now().timestamp() + 30;
    assert_eq!(
        super::super::core_jobs::project(&delayed, Some(&account)).can_continue,
        Some(false)
    );
    let valid = super::super::core_jobs::project(&fixture.job, Some(&account));
    assert_eq!(valid.can_continue, Some(true));
    let stale = super::super::core_jobs::stale_jobs(vec![valid], "Saved state unavailable");
    assert_eq!(stale[0].id, fixture.job.plan.id);
    assert_eq!(stale[0].can_continue, Some(false));
    assert!(stale[0].persistence_error.is_some());
    fixture
        .store
        .save(
            &format!("job_{}", fixture.job.plan.id),
            &vec!["invalid document shape"],
        )
        .unwrap();
    assert!(
        super::super::core_jobs::stored_jobs(&fixture.store, Some(&account), &[], true).is_err()
    );
    assert!(super::super::core_jobs::archive_store(&fixture.store).is_err());
}

#[test]
fn core_jobs_restart_recovery_respects_other_process_lease_and_old_saves() {
    let mut fixture = Fixture::core(1);
    for state in ["queued", "running"] {
        fixture.job.status = state.into();
        fixture.job.save(&fixture.store).unwrap();
        let rows = super::super::core_jobs::stored_jobs(&fixture.store, None, &[], false).unwrap();
        assert!(!matches!(
            rows[0].status,
            crate::commands::process::ProcessJobStatus::Paused
        ));
        let rows = super::super::core_jobs::stored_jobs(&fixture.store, None, &[], true).unwrap();
        assert!(matches!(
            rows[0].status,
            crate::commands::process::ProcessJobStatus::Paused
        ));
    }
    let mut legacy = serde_json::to_value(&fixture.job).unwrap();
    for field in ["history_hidden", "started_at", "finished_at"] {
        legacy.as_object_mut().unwrap().remove(field);
    }
    let old: Job = serde_json::from_value(legacy).unwrap();
    assert!(!old.history_hidden);
    assert!(old.started_at.is_none() && old.finished_at.is_none());
    assert_eq!(old.plan.id, fixture.job.plan.id);
}

#[test]
fn core_jobs_order_mixed_local_and_cloud_times_chronologically() {
    let fixture = Fixture::core(1);
    let mut older = super::super::core_jobs::project(&fixture.job, None);
    older.id = "old-google".into();
    older.created_at = "2026-01-01T00:00:00Z".into();
    let mut newer = older.clone();
    newer.id = "new-local".into();
    let local_time = chrono::DateTime::parse_from_rfc3339("2026-01-01T01:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Local);
    newer.created_at = local_time.format("%Y-%m-%d %H:%M:%S%.3f").to_string();
    let mut jobs = vec![older, newer];
    crate::commands::process_jobs::sort_jobs(&mut jobs);
    assert_eq!(jobs[0].id, "new-local");
}

#[test]
fn core_jobs_reject_foreign_id_namespaces_without_resetting_saved_records() {
    let fixture = Fixture::new(1);
    fixture.job.save(&fixture.store).unwrap();
    assert!(super::super::core_jobs::stored_jobs(&fixture.store, None, &[], true).is_err());
    assert!(super::super::core_jobs::archive_store(&fixture.store).is_err());
    assert!(fixture.store.load::<Job>("job_test-job").unwrap().is_some());
    assert!(!crate::commands::google_photos::is_job_id("process-job-1"));
    assert!(crate::commands::google_photos::is_job_id(&"G".repeat(43)));
}
struct TestSealer;
impl Sealer for TestSealer {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        Ok(std::iter::once(0xa7)
            .chain(plain.iter().map(|byte| byte ^ 0x55))
            .collect())
    }
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
        if sealed.first() != Some(&0xa7) {
            return Err("Invalid test seal".into());
        }
        Ok(sealed[1..].iter().map(|byte| byte ^ 0x55).collect())
    }
}

struct Fixture {
    directory: PathBuf,
    photos: PathBuf,
    workspace: PathBuf,
    store: GoogleStore,
    job: Job,
    source_bytes: Vec<Vec<u8>>,
}
impl Fixture {
    fn core(count: usize) -> Self {
        let mut fixture = Self::new(count);
        fixture.job.plan.id = "G".repeat(43);
        fixture
    }
    fn new(count: usize) -> Self {
        let directory = std::env::temp_dir().join(format!(
            "pgg-google-engine-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let photos = directory.join("photos");
        let workspace = directory.join("private-job");
        fs::create_dir_all(&photos).unwrap();
        let mut source_bytes = Vec::new();
        for index in 0..count {
            let pixels = image::RgbImage::from_fn(40, 60, |x, y| {
                image::Rgb([
                    ((x * 3 + index as u32) % 255) as u8,
                    ((y * 4) % 255) as u8,
                    ((x + y) % 255) as u8,
                ])
            });
            let mut jpeg = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 97)
                .encode_image(&image::DynamicImage::ImageRgb8(pixels))
                .unwrap();
            fs::write(photos.join(format!("horse-{index}.jpg")), &jpeg).unwrap();
            source_bytes.push(jpeg);
        }
        let catalogue = catalogue::scan(&photos).unwrap();
        let request = model::PlanRequest {
            root: catalogue.root.clone(),
            mode: SelectionMode::Originals,
            ..Default::default()
        };
        let context = model::PlanContext {
            id: "test-job".into(),
            account_id: "client-A-account-A".into(),
            account_email: "test@example.test".into(),
            ..Default::default()
        };
        let plan = plan::build(&catalogue, &request, &context).unwrap();
        let edits = plan
            .albums
            .iter()
            .map(|album| AlbumEdit {
                key: album.key.clone(),
                title: album.title.clone(),
                cover_item_id: None,
            })
            .collect();
        let original_hashes = plan
            .items
            .iter()
            .map(|item| (item.original_path.clone(), item.source_sha256.clone()))
            .collect();
        let job = Job::new(plan, edits, original_hashes, &[]).unwrap();
        let store = GoogleStore::new(directory.join("protected"), Arc::new(TestSealer)).unwrap();
        Self {
            directory,
            photos,
            workspace,
            store,
            job,
            source_bytes,
        }
    }
    fn reload(&mut self) {
        self.job = self
            .store
            .load(&format!("job_{}", self.job.plan.id))
            .unwrap()
            .unwrap();
    }
    fn drive(&mut self, api: &mut FakeGoogle, stop: &AtomicBool) -> Result<(), String> {
        drive(&self.store, &mut self.job, api, &self.workspace, "", stop)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

#[derive(Default)]
struct FakeGoogle {
    albums_created: usize,
    begins: usize,
    queries: usize,
    chunk_offsets: Vec<u64>,
    registrations: usize,
    verifies: usize,
    covers: usize,
    title_updates: Vec<(String, String)>,
    sessions: HashMap<String, Vec<u8>>,
    tokens: HashMap<String, String>,
    registered: HashMap<String, Media>,
    lose_album_response: bool,
    partial_registration_once: bool,
    fail_verify_once: bool,
    verify_error_once: Option<String>,
    verify_error_on_call: Option<(usize, ReadbackError)>,
    pause_after_verify: Option<(usize, Arc<AtomicBool>)>,
    begin_granularity: Option<u64>,
    query_error_once: Option<String>,
    pause_after_first_chunk: Option<Arc<AtomicBool>>,
}
impl FakeGoogle {
    fn media_for(token: &str) -> Media {
        Media {
            id: format!("media-{token}"),
            product_url: format!("https://photos.google.com/lr/photo/{token}"),
            width: 40,
            height: 60,
            creation_time: None,
        }
    }
}
impl GoogleApi for FakeGoogle {
    fn update_title(&mut self, id: &str, title: &str) -> Result<Album, String> {
        self.title_updates.push((id.into(), title.into()));
        Ok(Album {
            id: id.into(),
            title: title.into(),
            product_url: "https://photos.google.com/lr/album/test".into(),
        })
    }
    fn create_album(&mut self, title: &str) -> Result<Album, String> {
        self.albums_created += 1;
        if self.lose_album_response {
            self.lose_album_response = false;
            return Err("Simulated lost album response".into());
        }
        Ok(Album {
            id: format!("album-{}", self.albums_created),
            title: title.into(),
            product_url: "https://photos.google.com/lr/album/test".into(),
        })
    }
    fn list_albums(&mut self) -> Result<Vec<Album>, String> {
        Ok(vec![])
    }
    fn begin(&mut self, _name: &str, _mime: &str, _size: u64) -> Result<Session, String> {
        self.begins += 1;
        let url = format!("test-session-{}", self.begins);
        self.sessions.insert(url.clone(), Vec::new());
        Ok(Session {
            url,
            granularity: self.begin_granularity.unwrap_or(4),
            started_at: chrono::Utc::now().timestamp(),
        })
    }
    fn query(&mut self, session: &Session) -> Result<Offset, String> {
        self.queries += 1;
        if let Some(error) = self.query_error_once.take() {
            return Err(error);
        }
        Ok(Offset {
            received: self.sessions.get(&session.url).unwrap().len() as u64,
            token: self.tokens.get(&session.url).cloned(),
        })
    }
    fn chunk(
        &mut self,
        session: &Session,
        offset: u64,
        bytes: Vec<u8>,
        final_chunk: bool,
    ) -> Result<Offset, String> {
        self.chunk_offsets.push(offset);
        let accumulated = self.sessions.get_mut(&session.url).unwrap();
        assert_eq!(
            offset,
            accumulated.len() as u64,
            "resume must seek to server-confirmed offset"
        );
        accumulated.extend_from_slice(&bytes);
        let received = accumulated.len() as u64;
        let token = if final_chunk {
            let value = format!("token-{}", session.url);
            self.tokens.insert(session.url.clone(), value.clone());
            Some(value)
        } else {
            None
        };
        if let Some(stop) = self.pause_after_first_chunk.take() {
            stop.store(true, Ordering::Relaxed);
        }
        Ok(Offset { received, token })
    }
    fn register(
        &mut self,
        _album: &str,
        items: &[(String, String)],
    ) -> Result<Vec<Registration>, String> {
        self.registrations += 1;
        let partial = self.partial_registration_once;
        self.partial_registration_once = false;
        Ok(items
            .iter()
            .enumerate()
            .map(|(index, (token, _))| {
                if partial && index > 0 {
                    return Registration {
                        token: token.clone(),
                        result: Err("Simulated per-item registration failure".into()),
                    };
                }
                let value = Self::media_for(token);
                self.registered.insert(value.id.clone(), value.clone());
                Registration {
                    token: token.clone(),
                    result: Ok(value),
                }
            })
            .collect())
    }
    fn verify(&mut self, ids: &[String]) -> Result<Vec<Media>, ReadbackError> {
        self.verifies += 1;
        if self
            .pause_after_verify
            .as_ref()
            .is_some_and(|(call, _)| *call == self.verifies)
        {
            self.pause_after_verify
                .take()
                .unwrap()
                .1
                .store(true, Ordering::Relaxed);
        }
        if self
            .verify_error_on_call
            .as_ref()
            .is_some_and(|(call, _)| *call == self.verifies)
        {
            return Err(self.verify_error_on_call.take().unwrap().1);
        }
        if let Some(error) = self.verify_error_once.take() {
            return Err(error.into());
        }
        if self.fail_verify_once {
            self.fail_verify_once = false;
            return Err("Simulated read-back interruption".into());
        }
        ids.iter()
            .map(|id| {
                self.registered
                    .get(id)
                    .cloned()
                    .ok_or_else(|| ReadbackError::RequestFailed("Unknown fake media ID".into()))
            })
            .collect()
    }
    fn cover(&mut self, _album: &str, _media: &str) -> Result<(), String> {
        self.covers += 1;
        Ok(())
    }
}

#[test]
fn rejected_third_readback_still_verifies_fourth_and_resumes_without_uploading_again() {
    let mut fixture = Fixture::new(4);
    let stop = AtomicBool::new(false);
    let mut api = FakeGoogle {
        verify_error_on_call: Some((
            3,
            ReadbackError::ItemRejected(
                "Google media read-back failed: INVALID_ARGUMENT (code 3).".into(),
            ),
        )),
        ..Default::default()
    };
    let error = fixture.drive(&mut api, &stop).unwrap_err();
    finish_error(&fixture.store, &mut fixture.job, error, false).unwrap();
    fixture.reload();
    assert_eq!(fixture.job.status, "needs_attention");
    assert!(fixture.job.items.iter().all(|item| item.media.is_some()));
    assert_eq!(fixture.job.items[2].state, "registered");
    assert!(fixture.job.items[2].error.is_some());
    assert_eq!(
        fixture.job.items[3].state, "verified",
        "one rejected read-back must not prevent verification of a healthy registered sibling"
    );
    assert_eq!(api.verifies, 4);
    let summary = fixture.job.summary();
    assert_eq!(
        (
            summary.accepted,
            summary.uploaded,
            summary.awaiting_verification,
            summary.verification_needs_attention
        ),
        (4, 3, 1, 1)
    );
    let report = diagnostics::report(&fixture.job);
    assert_eq!(
        report
            .lines()
            .filter(|line| line.contains("Read back registered media | Failed | photo 3"))
            .count(),
        1
    );
    assert!(!report.lines().any(|line| line.contains("Failed | photo 4")));
    let receipts: Vec<_> = fixture
        .job
        .items
        .iter()
        .map(|item| item.media.as_ref().unwrap().id.clone())
        .collect();
    // Saved-ID recovery must not depend on an original media drive staying online.
    fs::rename(&fixture.photos, fixture.directory.join("offline-photos")).unwrap();
    fixture.drive(&mut api, &stop).unwrap();
    fixture.reload();
    assert_eq!(fixture.job.status, "completed");
    assert!(fixture
        .job
        .items
        .iter()
        .all(|item| item.state == "verified" && item.error.is_none()));
    assert_eq!(
        fixture
            .job
            .items
            .iter()
            .map(|item| item.media.as_ref().unwrap().id.clone())
            .collect::<Vec<_>>(),
        receipts
    );
    assert_eq!(api.albums_created, 1);
    assert_eq!(api.registrations, 1);
    assert_eq!(api.begins, 4);
    assert_eq!(api.verifies, 5);
}

#[test]
fn persistent_item_rejection_retains_receipts_and_never_reuploads_on_retry() {
    let mut fixture = Fixture::new(4);
    let stop = AtomicBool::new(false);
    let mut api = FakeGoogle {
        verify_error_on_call: Some((
            3,
            ReadbackError::ItemRejected(
                "Google media read-back failed: INVALID_ARGUMENT (code 3).".into(),
            ),
        )),
        ..Default::default()
    };
    for attempt in 0..3 {
        if attempt > 0 {
            api.verify_error_on_call = Some((
                api.verifies + 1,
                ReadbackError::ItemRejected(
                    "Google media read-back failed: INVALID_ARGUMENT (code 3).".into(),
                ),
            ));
        }
        let error = fixture.drive(&mut api, &stop).unwrap_err();
        finish_error(&fixture.store, &mut fixture.job, error, false).unwrap();
        fixture.reload();
        assert_eq!(fixture.job.status, "needs_attention");
        assert_eq!(fixture.job.summary().uploaded, 3);
        assert_eq!(fixture.job.summary().accepted, 4);
        assert_eq!(fixture.job.summary().verification_needs_attention, 1);
        assert_eq!(api.begins, 4);
        assert_eq!(api.registrations, 1);
        assert_eq!(api.albums_created, 1);
        assert_eq!(
            fixture
                .store
                .load::<Vec<LedgerEntry>>("ledger")
                .unwrap()
                .unwrap()
                .len(),
            3
        );
        assert_eq!(fixture.workspace.read_dir().unwrap().count(), 1);
    }
    assert_eq!(
        api.verifies, 6,
        "only the rejected saved ID is retried, once per attempt"
    );
}

#[test]
fn request_auth_quota_and_network_errors_stop_readback_without_losing_receipts() {
    for error in [
        "Google media read-back failed (HTTP 400; INVALID_ARGUMENT).",
        "Google media read-back failed: PERMISSION_DENIED (code 7).",
        "Google media read-back failed: UNAUTHENTICATED (code 16).",
        "Google media read-back failed (HTTP 429).",
        "Google media read-back failed: RESOURCE_EXHAUSTED (code 8).",
        "Could not verify Google media: transport interrupted.",
    ] {
        let mut fixture = Fixture::new(4);
        let stop = AtomicBool::new(false);
        let mut api = FakeGoogle {
            verify_error_on_call: Some((3, ReadbackError::RequestFailed(error.into()))),
            ..Default::default()
        };
        let returned = fixture.drive(&mut api, &stop).unwrap_err();
        finish_error(&fixture.store, &mut fixture.job, returned, false).unwrap();
        fixture.reload();
        assert_eq!(
            api.verifies, 3,
            "global failure must stop additional requests: {error}"
        );
        assert_eq!(fixture.job.summary().accepted, 4);
        assert_eq!(fixture.job.summary().uploaded, 2);
        assert_eq!(fixture.job.items[3].state, "registered");
        assert!(fixture.job.items.iter().all(|item| item.media.is_some()));
        if error.contains("429") || error.contains("code 8") {
            assert!(fixture.job.retry_after >= chrono::Utc::now().timestamp() + 29);
        }
    }
}

#[test]
fn completed_legacy_job_with_unverified_receipt_recovers_to_attention() {
    let mut fixture = Fixture::new(1);
    fixture.job.items[0].media = Some(FakeGoogle::media_for("legacy"));
    fixture.job.items[0].state = "registered".into();
    fixture.job.status = "completed".into();
    fixture.job.recover();
    assert_eq!(fixture.job.status, "needs_attention");
    assert_eq!(fixture.job.summary().accepted, 1);
    assert_eq!(fixture.job.summary().uploaded, 0);
}

#[test]
fn byte_progress_uses_actual_prepared_size_instead_of_original_estimate() {
    let mut fixture = Fixture::new(1);
    let stop = AtomicBool::new(false);
    fixture.drive(&mut FakeGoogle::default(), &stop).unwrap();
    fixture.job.plan.items[0].bytes -= 9;
    fixture.job.plan.total_bytes -= 9;
    let summary = fixture.job.summary();
    assert_eq!(summary.bytes_done, summary.total_bytes);
    assert_eq!(
        summary.total_bytes,
        fixture.job.items[0].prepared.as_ref().unwrap().bytes
    );
    fixture.job.items[0].state = "skipped".into();
    assert_eq!(fixture.job.summary().total_bytes, 0);
    fixture.job.items[0].state = "blocked".into();
    assert_eq!(fixture.job.summary().total_bytes, 0);
}

#[test]
fn rejected_saved_id_does_not_block_later_album_receipt_verification() {
    let mut fixture = Fixture::new(4);
    let stop = AtomicBool::new(false);
    let mut api = FakeGoogle::default();
    fixture.drive(&mut api, &stop).unwrap();
    let mut other = fixture.job.albums[0].clone();
    other.key = "other-album".into();
    other.id = Some("other-album-id".into());
    fixture.job.plan.items[3].album_key = other.key.clone();
    fixture.job.albums.push(other);
    fixture.job.items[2].state = "registered".into();
    fixture.job.items[3].state = "registered".into();
    api.verify_error_on_call = Some((
        5,
        ReadbackError::ItemRejected(
            "Google media read-back failed: INVALID_ARGUMENT (code 3).".into(),
        ),
    ));
    let error = fixture.drive(&mut api, &stop).unwrap_err();
    finish_error(&fixture.store, &mut fixture.job, error, false).unwrap();
    assert_eq!(api.verifies, 6);
    assert_eq!(fixture.job.items[2].state, "registered");
    assert_eq!(fixture.job.items[3].state, "verified");
    assert_eq!(api.albums_created, 1);
    assert_eq!(api.registrations, 1);
    assert_eq!(api.begins, 4);
}

#[test]
fn pausing_during_readback_stops_before_next_photo_and_preserves_receipts() {
    let mut fixture = Fixture::new(4);
    let stop = Arc::new(AtomicBool::new(false));
    let mut api = FakeGoogle {
        pause_after_verify: Some((2, stop.clone())),
        ..Default::default()
    };
    let error = fixture.drive(&mut api, &stop).unwrap_err();
    finish_error(&fixture.store, &mut fixture.job, error, true).unwrap();
    fixture.reload();
    assert_eq!(fixture.job.status, "paused");
    assert_eq!(api.verifies, 2);
    assert_eq!(fixture.job.summary().accepted, 4);
    assert_eq!(fixture.job.summary().uploaded, 2);
    stop.store(false, Ordering::Relaxed);
    fixture.drive(&mut api, &stop).unwrap();
    assert_eq!(fixture.job.status, "completed");
    assert_eq!(api.begins, 4);
    assert_eq!(api.registrations, 1);
}

#[test]
fn full_resolution_original_upload_is_byte_identical_and_receipted_after_readback() {
    let mut fixture = Fixture::new(1);
    let stop = AtomicBool::new(false);
    let mut api = FakeGoogle::default();
    fixture.job.albums[0].cover_item_id = Some(fixture.job.items[0].id.clone());
    fixture.drive(&mut api, &stop).unwrap();
    fixture.reload();
    assert_eq!(fixture.job.status, "completed");
    assert_eq!(fixture.job.items[0].state, "verified");
    assert_eq!(
        api.sessions.values().next().unwrap(),
        &fixture.source_bytes[0]
    );
    assert_eq!(api.covers, 1);
    let receipts: Vec<LedgerEntry> = fixture.store.load("ledger").unwrap().unwrap();
    assert_eq!(receipts.len(), 1);
    assert_eq!(receipts[0].account_id, "client-A-account-A");
    assert_eq!(
        receipts[0].source_sha256,
        fixture.job.plan.items[0].source_sha256
    );
    assert_eq!(
        fs::read(fixture.photos.join("horse-0.jpg")).unwrap(),
        fixture.source_bytes[0]
    );
    assert!(
        fixture.workspace.read_dir().unwrap().next().is_none(),
        "verified temporary upload copies must be removed"
    );
}

#[test]
fn lost_album_creation_and_restart_never_create_duplicate_album() {
    let mut fixture = Fixture::new(1);
    let stop = AtomicBool::new(false);
    let mut api = FakeGoogle {
        lose_album_response: true,
        ..Default::default()
    };
    assert!(fixture.drive(&mut api, &stop).is_err());
    fixture.reload();
    assert_eq!(fixture.job.albums[0].state, "creation_outcome_unknown");
    assert!(fixture.drive(&mut api, &stop).is_err());
    assert_eq!(api.albums_created, 1);
    assert_eq!(api.begins, 0);
}

#[test]
fn partial_registration_success_is_durable_and_retry_only_registers_failed_item() {
    let mut fixture = Fixture::new(2);
    let stop = AtomicBool::new(false);
    let mut api = FakeGoogle {
        partial_registration_once: true,
        ..Default::default()
    };
    let error = fixture.drive(&mut api, &stop).unwrap_err();
    finish_error(&fixture.store, &mut fixture.job, error, false).unwrap();
    fixture.reload();
    let report = diagnostics::report(&fixture.job);
    assert!(
        !report
            .lines()
            .any(|line| line.contains("Read back registered media | Failed")),
        "A registration failure must not be attributed to a successfully verified sibling photo"
    );
    let last_failure = report
        .lines()
        .rev()
        .find(|line| line.contains("| Failed"))
        .unwrap();
    assert!(last_failure.contains("Register uploaded media") && last_failure.contains("photo 2"));
    assert_eq!(fixture.job.items[0].state, "verified");
    assert_eq!(fixture.job.items[1].state, "failed");
    let first_media = fixture.job.items[0].media.as_ref().unwrap().id.clone();
    let begins = api.begins;
    fixture.drive(&mut api, &stop).unwrap();
    fixture.reload();
    assert_eq!(fixture.job.status, "completed");
    assert_eq!(fixture.job.items[0].media.as_ref().unwrap().id, first_media);
    assert_eq!(api.registrations, 2);
    assert_eq!(api.begins, begins);
    assert_eq!(api.registered.len(), 2);
    let receipts: Vec<LedgerEntry> = fixture.store.load("ledger").unwrap().unwrap();
    assert_eq!(receipts.len(), 2);
}

#[test]
fn registered_media_resumes_readback_without_new_registration_or_upload() {
    let mut fixture = Fixture::new(1);
    let stop = AtomicBool::new(false);
    let mut api = FakeGoogle {
        fail_verify_once: true,
        ..Default::default()
    };
    assert!(fixture.drive(&mut api, &stop).is_err());
    fixture.reload();
    assert_eq!(fixture.job.items[0].state, "registered");
    fixture.drive(&mut api, &stop).unwrap();
    fixture.reload();
    assert_eq!(fixture.job.items[0].state, "verified");
    assert_eq!(api.registrations, 1);
    assert_eq!(api.begins, 1);
    assert_eq!(api.verifies, 2);
    assert!(
        fixture.workspace.read_dir().unwrap().next().is_none(),
        "read-back recovery must also remove its verified upload copy"
    );
}

#[test]
fn failed_readback_saves_per_photo_diagnostics_and_retry_never_reuploads() {
    let mut fixture = Fixture::new(1);
    let stop = AtomicBool::new(false);
    let mut api = FakeGoogle {
        verify_error_once: Some("Google media read-back failed: PERMISSION_DENIED (code 7). private@example.test bearer fixture-secret https://invalid.test/private?token=fixture".into()),
        ..Default::default()
    };
    let error = fixture.drive(&mut api, &stop).unwrap_err();
    finish_error(&fixture.store, &mut fixture.job, error, false).unwrap();
    fixture.reload();
    assert_eq!(fixture.job.status, "needs_attention");
    assert_eq!(fixture.job.items[0].state, "registered");
    assert!(fixture.job.items[0].error.is_some());
    assert_eq!(fixture.job.summary().failed, 1);
    assert_eq!(fixture.job.summary().uploaded, 0);
    let report = diagnostics::report(&fixture.job);
    for expected in [
        "Read back registered media",
        "PERMISSION_DENIED (code 7)",
        "photo 1",
        "registered receipt saved",
        "not confirmation of upload success",
    ] {
        assert!(report.contains(expected), "Missing {expected} in report");
    }
    for private in [
        "private@example",
        "fixture-secret",
        "invalid.test",
        "token=fixture",
        "test-session",
        "media-token",
        "horse-0",
        "client-A-account",
        fixture.photos.to_str().unwrap(),
    ] {
        assert!(
            !report.contains(private),
            "Private data in diagnostic export"
        );
    }
    assert!(fixture
        .store
        .load::<Vec<LedgerEntry>>("ledger")
        .unwrap()
        .is_none());
    let receipt = fixture.job.items[0].media.as_ref().unwrap().id.clone();
    fixture.drive(&mut api, &stop).unwrap();
    fixture.reload();
    assert_eq!(fixture.job.items[0].state, "verified");
    assert_eq!(fixture.job.items[0].media.as_ref().unwrap().id, receipt);
    assert_eq!(api.begins, 1);
    assert_eq!(api.registrations, 1);
    assert_eq!(api.verifies, 2);
    assert!(fixture.job.items[0].error.is_none());
    assert_eq!(fixture.job.summary().failed, 0);
}

#[test]
fn old_jobs_load_without_diagnostics_and_new_history_is_bounded() {
    let fixture = Fixture::new(1);
    let mut value = serde_json::to_value(&fixture.job).unwrap();
    value.as_object_mut().unwrap().remove("diagnostics");
    let mut old: Job = serde_json::from_value(value).unwrap();
    assert!(old.diagnostics.is_empty());
    assert!(diagnostics::report(&old).contains("earlier job has no checkpoint history"));
    for _ in 0..600 {
        diagnostics::note(
            &mut old,
            Stage::VerifyMedia,
            Some(0),
            Outcome::Failed,
            Some("Google read-back failed: NOT_FOUND (code 5)."),
        );
    }
    assert_eq!(old.diagnostics.len(), 256);
    assert!(diagnostics::report(&old).len() < 128 * 1024);
    let mut limited = old;
    finish_error(
        &fixture.store,
        &mut limited,
        "Google read-back failed: RESOURCE_EXHAUSTED (code 8).".into(),
        false,
    )
    .unwrap();
    assert!(limited.retry_after >= chrono::Utc::now().timestamp() + 29);
}

#[test]
fn pause_restart_and_resume_query_confirmed_offset_without_rereading_uploaded_prefix() {
    let mut fixture = Fixture::new(1);
    // JPEG decoders permit trailing data. This bounded synthetic file forces a
    // second upload chunk without generating a huge decoded photograph.
    let mut original = fixture.source_bytes[0].clone();
    original.resize(9 * 1024 * 1024 + 17, 0x5a);
    fs::write(fixture.photos.join("horse-0.jpg"), &original).unwrap();
    let source_hash = metadata::hash_file(&fixture.photos.join("horse-0.jpg")).unwrap();
    fixture.job.plan.items[0].source_sha256 = source_hash.clone();
    fixture.job.plan.items[0].original_sha256 = source_hash.clone();
    fixture.job.plan.items[0].bytes = original.len() as u64;
    fixture.job.plan.total_bytes = original.len() as u64;
    fixture.job.original_hashes[0].1 = source_hash;
    let stop = Arc::new(AtomicBool::new(false));
    let mut api = FakeGoogle {
        pause_after_first_chunk: Some(stop.clone()),
        ..Default::default()
    };
    assert!(fixture.drive(&mut api, &stop).is_err());
    fixture.reload();
    assert_eq!(fixture.job.items[0].offset, 8 * 1024 * 1024);
    stop.store(false, Ordering::Relaxed);
    fixture.drive(&mut api, &stop).unwrap();
    assert_eq!(api.begins, 1);
    assert_eq!(api.queries, 1);
    assert_eq!(api.chunk_offsets, vec![0, 8 * 1024 * 1024]);
    assert_eq!(api.sessions.values().next().unwrap(), &original);
}

#[test]
fn stale_source_is_rejected_before_any_external_album_or_media_mutation() {
    let mut fixture = Fixture::new(1);
    let stop = AtomicBool::new(false);
    let mut api = FakeGoogle::default();
    fs::write(
        fixture.photos.join("horse-0.jpg"),
        b"changed source after review",
    )
    .unwrap();
    assert!(fixture.drive(&mut api, &stop).is_err());
    assert_eq!(api.begins, 0);
    assert_eq!(api.registrations, 0);
    assert_eq!(
        api.albums_created, 0,
        "validate source before creating a remote album"
    );
}

#[test]
fn foreign_account_receipt_cannot_mark_a_photo_skipped() {
    let fixture = Fixture::new(1);
    let mut plan = fixture.job.plan.clone();
    let item = &plan.items[0];
    let receipt = LedgerEntry {
        account_id: "client-B-account-A".into(),
        asset_id: item.id.clone(),
        source_sha256: item.source_sha256.clone(),
        original_sha256: item.original_sha256.clone(),
        metadata_recipe: 1,
        prepared_sha256: String::new(),
        strip_gps: false,
        album_key: item.album_key.clone(),
        album_id: "foreign-album".into(),
        media_item_id: "foreign-media".into(),
    };
    plan.items[0].status = PlanItemStatus::AlreadyUploaded;
    plan.albums[0].album_id = Some("foreign-album".into());
    let edits = plan
        .albums
        .iter()
        .map(|album| AlbumEdit {
            key: album.key.clone(),
            title: album.title.clone(),
            cover_item_id: None,
        })
        .collect();
    let job = Job::new(plan, edits, vec![], &[receipt]).unwrap();
    assert_eq!(job.items[0].state, "blocked");
    assert!(job.items[0].media.is_none());
}

#[test]
fn original_preparation_without_exiftool_preserves_every_encoded_byte() {
    let fixture = Fixture::new(1);
    fs::create_dir_all(&fixture.workspace).unwrap();
    let target = fixture.workspace.join("copy.jpg");
    let prepared = metadata::prepare(
        &fixture.job.plan.items[0],
        &target,
        "nonexistent-test-exiftool",
    )
    .unwrap();
    assert_eq!(prepared.width, 40);
    assert_eq!(prepared.height, 60);
    assert_eq!(fs::read(&target).unwrap(), fixture.source_bytes[0]);
    assert_eq!(prepared.sha256, fixture.job.plan.items[0].source_sha256);
}

#[test]
fn failed_metadata_preparation_does_not_leave_a_sensitive_partial_upload_copy() {
    let fixture = Fixture::new(1);
    fs::create_dir_all(&fixture.workspace).unwrap();
    let target = fixture.workspace.join("partial.jpg");
    let mut item = fixture.job.plan.items[0].clone();
    item.strip_gps = true;
    assert!(metadata::prepare(
        &item,
        &target,
        fixture.directory.join("no-such-tool").to_str().unwrap()
    )
    .is_err());
    assert!(
        !target.exists(),
        "failed preparation must remove its private copy, not the source"
    );
    assert_eq!(
        fs::read(fixture.photos.join("horse-0.jpg")).unwrap(),
        fixture.source_bytes[0]
    );
}

fn stage_reviewed_copy(fixture: &mut Fixture) -> Prepared {
    fs::create_dir_all(&fixture.workspace).unwrap();
    let prepared = metadata::prepare(
        &fixture.job.plan.items[0],
        &fixture.workspace.join("0.jpg"),
        "",
    )
    .unwrap();
    fixture.job.items[0].prepared = Some(prepared.clone());
    fixture.job.items[0].state = "uploading".into();
    fixture.job.albums[0].id = Some("confirmed-album".into());
    fixture.job.albums[0].state = "ready".into();
    fixture.job.albums[0].title_done = true;
    fixture.job.albums[0].product_url = "https://photos.google.com/lr/album/confirmed".into();
    prepared
}

#[test]
fn lost_prepared_copy_is_recreated_byte_identically_without_recreating_album() {
    let mut fixture = Fixture::new(1);
    let prepared = stage_reviewed_copy(&mut fixture);
    let mut api = FakeGoogle::default();
    fixture.job.items[0].session = Some(
        api.begin("horse.jpg", &prepared.mime, prepared.bytes)
            .unwrap(),
    );
    fixture.job.items[0].token = Some("old-token-must-not-be-reused".into());
    fixture.job.items[0].token_at = chrono::Utc::now().timestamp();
    fixture.job.items[0].offset = prepared.bytes;
    fs::remove_file(&prepared.path).unwrap();
    fixture.job.save(&fixture.store).unwrap();
    fixture.reload();
    fixture.drive(&mut api, &AtomicBool::new(false)).unwrap();
    fixture.reload();
    assert_eq!(fixture.job.status, "completed");
    assert_eq!(fixture.job.items[0].state, "verified");
    assert_eq!(
        fixture.job.items[0].prepared.as_ref().unwrap().sha256,
        prepared.sha256
    );
    assert_eq!(api.albums_created, 0);
    assert_eq!(api.begins, 2);
    assert_eq!(api.queries, 0);
    assert_eq!(
        api.sessions.get("test-session-2").unwrap(),
        &fixture.source_bytes[0]
    );
    assert!(!Path::new(&prepared.path).exists());
}

#[test]
fn failed_lost_copy_recreation_never_forgets_the_original_prepared_fingerprint() {
    let mut fixture = Fixture::new(1);
    let mut prepared = stage_reviewed_copy(&mut fixture);
    // Simulate a previously prepared metadata layout that cannot be reproduced
    // byte-for-byte by the current tool. Retry may not silently accept new bytes.
    prepared.sha256 = "0".repeat(64);
    fixture.job.items[0].prepared = Some(prepared.clone());
    fs::remove_file(&prepared.path).unwrap();
    fixture.job.save(&fixture.store).unwrap();
    let mut api = FakeGoogle::default();
    for _ in 0..2 {
        fixture.reload();
        assert!(fixture.drive(&mut api, &AtomicBool::new(false)).is_err());
        fixture.reload();
        assert_eq!(
            fixture.job.items[0]
                .prepared
                .as_ref()
                .map(|copy| copy.sha256.as_str()),
            Some(prepared.sha256.as_str()),
            "failed recovery must retain its immutable fingerprint on disk"
        );
    }
    assert_eq!(api.albums_created, 0);
    assert_eq!(api.begins, 0);
    assert_eq!(api.registrations, 0);
}

#[test]
fn zero_granularity_is_a_recoverable_error_not_a_division_panic() {
    let mut fixture = Fixture::new(1);
    let mut api = FakeGoogle {
        begin_granularity: Some(0),
        ..Default::default()
    };
    let error = fixture
        .drive(&mut api, &AtomicBool::new(false))
        .unwrap_err();
    assert!(error.contains("granularity"));
    assert!(api.chunk_offsets.is_empty());
    assert_eq!(api.registrations, 0);
}

#[test]
fn confirmed_album_repairs_missing_mapping_after_restart() {
    let mut fixture = Fixture::new(1);
    stage_reviewed_copy(&mut fixture);
    fixture.job.save(&fixture.store).unwrap();
    fixture.reload();
    assert!(fixture
        .store
        .load::<Vec<ExistingAlbum>>("albums")
        .unwrap()
        .is_none());
    let mut api = FakeGoogle::default();
    fixture.drive(&mut api, &AtomicBool::new(false)).unwrap();
    let mapping: Vec<ExistingAlbum> = fixture.store.load("albums").unwrap().unwrap();
    assert_eq!(mapping.len(), 1);
    assert_eq!(mapping[0].album_id, "confirmed-album");
    assert_eq!(mapping[0].account_id, fixture.job.plan.account_id);
    assert_eq!(api.albums_created, 0);
}

#[test]
fn continued_album_updates_title_and_hydrates_confirmed_product_url() {
    let mut fixture = Fixture::new(1);
    fixture.job.albums[0].id = Some("continued-album".into());
    fixture.job.albums[0].state = "ready".into();
    fixture.job.albums[0].title = "Edited horse event — 2026-10-25".into();
    assert!(fixture.job.albums[0].product_url.is_empty());
    assert!(!fixture.job.albums[0].title_done);
    let mut api = FakeGoogle::default();
    fixture.drive(&mut api, &AtomicBool::new(false)).unwrap();
    fixture.reload();
    assert_eq!(api.albums_created, 0);
    assert_eq!(
        api.title_updates,
        vec![(
            "continued-album".into(),
            fixture.job.albums[0].title.clone()
        )]
    );
    assert_eq!(
        fixture.job.albums[0].product_url,
        "https://photos.google.com/lr/album/test"
    );
    assert!(fixture.job.albums[0].title_done);
    let mapping: Vec<ExistingAlbum> = fixture.store.load("albums").unwrap().unwrap();
    assert_eq!(mapping[0].title, fixture.job.albums[0].title);
}

#[test]
fn known_expired_query_resets_only_byte_session_and_reuses_confirmed_album() {
    let mut fixture = Fixture::new(1);
    let prepared = stage_reviewed_copy(&mut fixture);
    let mut api = FakeGoogle { query_error_once: Some("Upload session is cancelled or expired. Start a fresh byte session using the exact same prepared file.".into()), ..Default::default() };
    fixture.job.items[0].session = Some(
        api.begin("horse.jpg", &prepared.mime, prepared.bytes)
            .unwrap(),
    );
    fixture.job.save(&fixture.store).unwrap();
    fixture.reload();
    fixture.drive(&mut api, &AtomicBool::new(false)).unwrap();
    fixture.reload();
    assert_eq!(api.queries, 1);
    assert_eq!(api.begins, 2);
    assert_eq!(api.albums_created, 0);
    assert_eq!(api.registrations, 1);
    assert_eq!(fixture.job.albums[0].id.as_deref(), Some("confirmed-album"));
    assert_eq!(
        fixture.job.items[0].prepared.as_ref().unwrap().sha256,
        prepared.sha256
    );
    assert_eq!(
        api.sessions.get("test-session-2").unwrap(),
        &fixture.source_bytes[0]
    );
}
