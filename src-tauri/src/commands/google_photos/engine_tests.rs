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
        self.job = self.store.load("job_test-job").unwrap().unwrap();
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
    fn verify(&mut self, ids: &[String]) -> Result<Vec<Media>, String> {
        self.verifies += 1;
        if self.fail_verify_once {
            self.fail_verify_once = false;
            return Err("Simulated read-back interruption".into());
        }
        ids.iter()
            .map(|id| {
                self.registered
                    .get(id)
                    .cloned()
                    .ok_or_else(|| "Unknown fake media ID".into())
            })
            .collect()
    }
    fn cover(&mut self, _album: &str, _media: &str) -> Result<(), String> {
        self.covers += 1;
        Ok(())
    }
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
    assert!(fixture.drive(&mut api, &stop).is_err());
    fixture.reload();
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
