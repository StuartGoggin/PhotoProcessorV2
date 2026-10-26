//! Durable write-ahead job engine. One process/account worker lease is held by
//! the caller throughout drive(); every external mutation has saved intent.
use super::{
    diagnostics::{self, Outcome, Stage},
    metadata::{self, Prepared},
    model::*,
    store::GoogleStore,
    transport::{Album, GoogleApi, Media, ReadbackError, Session},
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Serialize, Deserialize, Default)]
pub struct ItemProgress {
    pub id: String,
    pub state: String,
    pub prepared: Option<Prepared>,
    pub session: Option<Session>,
    pub offset: u64,
    pub token: Option<String>,
    pub token_at: i64,
    pub media: Option<Media>,
    pub error: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct AlbumProgress {
    pub key: String,
    pub title: String,
    pub id: Option<String>,
    pub product_url: String,
    pub state: String,
    pub cover_item_id: Option<String>,
    pub cover_done: bool,
    #[serde(default)]
    pub title_done: bool,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Job {
    pub plan: PlanPreview,
    pub status: String,
    pub items: Vec<ItemProgress>,
    pub albums: Vec<AlbumProgress>,
    pub errors: Vec<String>,
    pub retry_after: i64,
    pub original_hashes: Vec<(String, String)>,
    #[serde(default)]
    pub diagnostics: Vec<diagnostics::Event>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumEdit {
    pub key: String,
    pub title: String,
    pub cover_item_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobAlbum {
    key: String,
    title: String,
    product_url: String,
    state: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSummary {
    pub id: String,
    pub status: String,
    pub account_id: String,
    pub account_email: String,
    pub created_at: String,
    pub done: usize,
    pub total: usize,
    pub uploaded: usize,
    pub accepted: usize,
    pub awaiting_verification: usize,
    pub verification_needs_attention: usize,
    pub skipped: usize,
    pub failed: usize,
    pub bytes_done: u64,
    pub total_bytes: u64,
    pub current_file: String,
    pub albums: Vec<JobAlbum>,
    pub errors: Vec<String>,
}
impl Job {
    pub fn new(
        plan: PlanPreview,
        edits: Vec<AlbumEdit>,
        original_hashes: Vec<(String, String)>,
        ledger: &[LedgerEntry],
    ) -> Result<Self, String> {
        if edits.len() != plan.albums.len() {
            return Err("Review every target album before starting.".into());
        }
        let mut seen = std::collections::HashSet::new();
        let mut albums = Vec::new();
        for edit in edits {
            let album = plan
                .albums
                .iter()
                .find(|album| album.key == edit.key)
                .ok_or("The album review does not match this plan.")?;
            if !seen.insert(edit.key.clone())
                || edit.title.trim().is_empty()
                || edit.title.chars().any(char::is_control)
                || edit.title.chars().count() > 500
            {
                return Err(
                    "Album names must be unique review entries with 1–500 printable characters."
                        .into(),
                );
            }
            if let Some(cover) = &edit.cover_item_id {
                if !album.item_ids.contains(cover)
                    || !plan.items.iter().any(|item| {
                        &item.id == cover
                            && matches!(
                                item.status,
                                PlanItemStatus::Ready
                                    | PlanItemStatus::Changed
                                    | PlanItemStatus::AlreadyUploaded
                            )
                    })
                {
                    return Err("Album cover must be an uploadable photo in that album.".into());
                }
            }
            albums.push(AlbumProgress {
                key: edit.key,
                title: edit.title.trim().into(),
                id: album.album_id.clone(),
                product_url: String::new(),
                state: if album.album_id.is_some() {
                    "ready"
                } else {
                    "pending"
                }
                .into(),
                cover_item_id: edit.cover_item_id,
                cover_done: false,
                title_done: false,
            });
        }
        let items = plan
            .items
            .iter()
            .map(|item| {
                let receipt = ledger.iter().find(|r| {
                    r.account_id == plan.account_id
                        && r.asset_id == item.id
                        && r.source_sha256 == item.source_sha256
                        && r.original_sha256 == item.original_sha256
                        && r.metadata_recipe == 1
                        && r.strip_gps == item.strip_gps
                        && plan.albums.iter().any(|a| {
                            a.key == r.album_key && a.album_id.as_ref() == Some(&r.album_id)
                        })
                });
                let state = match item.status {
                    PlanItemStatus::AlreadyUploaded if receipt.is_some() => "skipped",
                    PlanItemStatus::Ready | PlanItemStatus::Changed => "pending",
                    _ => "blocked",
                };
                ItemProgress {
                    id: item.id.clone(),
                    state: state.into(),
                    media: receipt.map(|r| Media {
                        id: r.media_item_id.clone(),
                        product_url: String::new(),
                        width: 0,
                        height: 0,
                        creation_time: None,
                    }),
                    ..Default::default()
                }
            })
            .collect();
        Ok(Self {
            plan,
            status: "paused".into(),
            items,
            albums,
            errors: Vec::new(),
            retry_after: 0,
            original_hashes,
            diagnostics: Vec::new(),
        })
    }
    pub fn summary(&self) -> JobSummary {
        let uploaded = self.items.iter().filter(|p| p.state == "verified").count();
        let skipped = self.items.iter().filter(|p| p.state == "skipped").count();
        let accepted = self
            .items
            .iter()
            .filter(|p| p.media.is_some() && p.state != "skipped")
            .count();
        let awaiting_verification = self
            .items
            .iter()
            .filter(|p| p.media.is_some() && !matches!(p.state.as_str(), "verified" | "skipped"))
            .count();
        let verification_needs_attention = self
            .items
            .iter()
            .filter(|p| {
                p.media.is_some()
                    && !matches!(p.state.as_str(), "verified" | "skipped")
                    && p.error.is_some()
            })
            .count();
        let failed = self
            .items
            .iter()
            .filter(|p| {
                p.state == "failed"
                    || p.state == "blocked"
                    || (p.error.is_some() && p.state != "verified" && p.state != "skipped")
            })
            .count();
        JobSummary {
            id: self.plan.id.clone(),
            status: self.status.clone(),
            account_id: self.plan.account_id.clone(),
            account_email: self.plan.account_email.clone(),
            created_at: self.plan.created_at.clone(),
            done: uploaded + skipped + failed,
            total: self.items.len(),
            uploaded,
            accepted,
            awaiting_verification,
            verification_needs_attention,
            skipped,
            failed,
            bytes_done: self
                .items
                .iter()
                .map(|p| {
                    if p.state == "verified" {
                        p.prepared.as_ref().map(|v| v.bytes).unwrap_or(p.offset)
                    } else {
                        p.offset
                    }
                })
                .sum(),
            total_bytes: self
                .items
                .iter()
                .zip(&self.plan.items)
                .map(|(progress, item)| {
                    if matches!(progress.state.as_str(), "skipped" | "blocked") {
                        0
                    } else {
                        progress
                            .prepared
                            .as_ref()
                            .map(|v| v.bytes)
                            .unwrap_or(item.bytes)
                    }
                })
                .sum(),
            current_file: self
                .items
                .iter()
                .find(|p| {
                    matches!(
                        p.state.as_str(),
                        "preparing" | "uploading" | "registering" | "registered"
                    )
                })
                .and_then(|p| self.plan.items.iter().find(|i| i.id == p.id))
                .map(|i| i.relative_path.clone())
                .unwrap_or_default(),
            albums: self
                .albums
                .iter()
                .map(|a| JobAlbum {
                    key: a.key.clone(),
                    title: a.title.clone(),
                    product_url: a.product_url.clone(),
                    state: a.state.clone(),
                })
                .collect(),
            errors: self.errors.clone(),
        }
    }
    pub fn save(&self, store: &GoogleStore) -> Result<(), String> {
        store.save(&format!("job_{}", self.plan.id), self)
    }
    pub fn recover(&mut self) {
        if self.status == "running" {
            self.status = "paused".into();
        }
        if matches!(self.status.as_str(), "completed" | "completed_with_errors")
            && self
                .items
                .iter()
                .any(|p| p.media.is_some() && !matches!(p.state.as_str(), "verified" | "skipped"))
        {
            self.status = "needs_attention".into();
        }
        for album in &mut self.albums {
            if album.state == "creating" {
                album.state = "creation_outcome_unknown".into();
                self.status = "needs_attention".into();
            }
        }
    }
}
fn stop_requested(stop: &AtomicBool) -> Result<(), String> {
    if stop.load(Ordering::Relaxed) {
        Err("Paused at a safe upload checkpoint. Resume to continue.".into())
    } else {
        Ok(())
    }
}
fn scope(item: &PlanItem, root: &Path) -> Result<(), String> {
    for value in [&item.path, &item.original_path] {
        let path = Path::new(value);
        super::store::reject_link(path)?;
        let canonical = path
            .canonicalize()
            .map_err(|_| "An upload source is missing.")?;
        if !canonical.starts_with(root) {
            return Err(
                "An upload source now resolves outside the reviewed folder. Upload refused.".into(),
            );
        }
    }
    Ok(())
}
fn remember(store: &GoogleStore, job: &Job, index: usize) -> Result<(), String> {
    let item = &job.plan.items[index];
    let p = &job.items[index];
    let album = job
        .albums
        .iter()
        .find(|a| a.key == item.album_key)
        .ok_or("Job album is missing.")?;
    let media = p.media.as_ref().ok_or("Google media receipt is missing.")?;
    let mut entries: Vec<LedgerEntry> = store.load("ledger")?.unwrap_or_default();
    if !entries.iter().any(|r| {
        r.account_id == job.plan.account_id
            && r.asset_id == item.id
            && r.album_id == album.id.as_deref().unwrap_or("")
            && r.source_sha256 == item.source_sha256
            && r.original_sha256 == item.original_sha256
            && r.metadata_recipe == 1
            && r.strip_gps == item.strip_gps
    }) {
        entries.push(LedgerEntry {
            account_id: job.plan.account_id.clone(),
            asset_id: item.id.clone(),
            source_sha256: item.source_sha256.clone(),
            original_sha256: item.original_sha256.clone(),
            metadata_recipe: 1,
            prepared_sha256: p
                .prepared
                .as_ref()
                .map(|p| p.sha256.clone())
                .unwrap_or_default(),
            strip_gps: item.strip_gps,
            album_key: item.album_key.clone(),
            album_id: album.id.clone().ok_or("Album receipt is missing.")?,
            media_item_id: media.id.clone(),
        });
        store.save("ledger", &entries)?;
    }
    Ok(())
}
fn verify_item(
    store: &GoogleStore,
    job: &mut Job,
    index: usize,
    api: &mut dyn GoogleApi,
) -> Result<(), ReadbackError> {
    let id = job.items[index]
        .media
        .as_ref()
        .ok_or("Missing media registration receipt.")?
        .id
        .clone();
    diagnostics::note(job, Stage::VerifyMedia, Some(index), Outcome::Started, None);
    job.save(store)?;
    let verified = api.verify(std::slice::from_ref(&id)).and_then(|results| {
        let result = results
        .into_iter()
        .find(|m| m.id == id)
        .ok_or("Google did not confirm the registered media ID.")?;
        if let Some(prepared) = &job.items[index].prepared {
        // Google reports display dimensions; portrait EXIF may swap raw pixels.
        if !((result.width == prepared.width as u64 && result.height == prepared.height as u64)
            || (result.width == prepared.height as u64 && result.height == prepared.width as u64))
        {
            return Err(ReadbackError::ItemRejected("Google's reported photo dimensions differ from the full-resolution upload. Needs review; not marked successful.".into()));
        }
        }
        Ok(result)
    });
    let result = match verified {
        Ok(result) => result,
        Err(error) => {
            // Keep the registered receipt and checkpoint. Retry must verify the
            // same ID, never turn a read-back failure into another byte upload.
            job.items[index].error = Some(error.to_string());
            diagnostics::note(
                job,
                Stage::VerifyMedia,
                Some(index),
                Outcome::Failed,
                Some(&error.to_string()),
            );
            job.save(store)?;
            return Err(error);
        }
    };
    job.items[index].media = Some(result);
    job.items[index].state = "verified".into();
    job.items[index].error = None;
    diagnostics::note(
        job,
        Stage::VerifyMedia,
        Some(index),
        Outcome::Succeeded,
        None,
    );
    job.save(store)?;
    remember(store, job, index)?;
    // Only copies whose exact prepared bytes are no longer needed for recovery
    // are removed, and only inside the current job workspace.
    Ok(())
}
fn verify_receipts(
    store: &GoogleStore,
    job: &mut Job,
    indices: &[usize],
    api: &mut dyn GoogleApi,
    workspace: &Path,
    stop: &AtomicBool,
) -> Result<(), String> {
    for &index in indices {
        if job.items[index].media.is_none() || job.items[index].state == "skipped" {
            continue;
        }
        stop_requested(stop)?;
        if job.items[index].state == "verified" {
            remember(store, job, index)?;
            cleanup_copy(job, index, workspace)?;
            continue;
        }
        match verify_item(store, job, index, api) {
            Ok(()) => cleanup_copy(job, index, workspace)?,
            Err(ReadbackError::ItemRejected(error)) => {
                if !job.errors.contains(&error) {
                    job.errors.push(error);
                }
                job.save(store)?;
            }
            Err(ReadbackError::RequestFailed(error)) => return Err(error),
        }
    }
    let remaining = job
        .items
        .iter()
        .filter(|p| p.media.is_some() && !matches!(p.state.as_str(), "verified" | "skipped"))
        .count();
    if remaining > 0 {
        let error = format!("Google accepted these photos, but {remaining} registered photo(s) still need verification. Review the existing album and use Resume/Retry on this saved job; its media receipts are retained and will not be uploaded again.");
        // Aggregation belongs to the job, never to the last healthy sibling.
        diagnostics::note(job, Stage::Job, None, Outcome::Failed, Some(&error));
        job.save(store)?;
        return Err(error);
    }
    Ok(())
}
fn upload_item(
    store: &GoogleStore,
    job: &mut Job,
    index: usize,
    api: &mut dyn GoogleApi,
    workspace: &Path,
    exiftool: &str,
    stop: &AtomicBool,
) -> Result<(), String> {
    if job.items[index].media.is_some() {
        return Err("This photo already has a Google registration receipt. Resume must verify its saved ID, never upload or register it again.".into());
    }
    let item = job.plan.items[index].clone();
    let root = Path::new(&job.plan.root)
        .canonicalize()
        .map_err(|_| "Photo root is unavailable.")?;
    scope(&item, &root)?;
    if let Some((_, expected)) = job
        .original_hashes
        .iter()
        .find(|(path, _)| path == &item.original_path)
    {
        if &metadata::hash_file(Path::new(&item.original_path))? != expected {
            return Err("The metadata original changed after review. Prepare a fresh plan before uploading.".into());
        }
    }
    if job.items[index].prepared.is_none() {
        stop_requested(stop)?;
        job.items[index].state = "preparing".into();
        diagnostics::note(job, Stage::Prepare, Some(index), Outcome::Started, None);
        job.save(store)?;
        let extension = Path::new(&item.path)
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("jpg")
            .to_ascii_lowercase();
        let target = workspace.join(format!("{index}.{extension}"));
        // A crash during preparation can leave only this engine-owned partial
        // copy. Never overwrite a different/user-selected destination.
        if target.exists() {
            super::store::reject_link(&target)?;
            fs::remove_file(&target).map_err(|_| "Cannot recover an interrupted upload copy.")?;
        }
        let prepared = metadata::prepare(&item, &target, exiftool)?;
        if let Some((_, expected)) = job
            .original_hashes
            .iter()
            .find(|(path, _)| path == &item.original_path)
        {
            if &metadata::hash_file(Path::new(&item.original_path))? != expected {
                let _ = fs::remove_file(&target);
                return Err(
                    "Original metadata changed during upload preparation. Create a fresh plan."
                        .into(),
                );
            }
        }
        job.items[index].prepared = Some(prepared);
        job.save(store)?;
    }
    let prepared = job.items[index]
        .prepared
        .clone()
        .ok_or("Prepared upload missing.")?;
    let path = Path::new(&prepared.path);
    if path.parent() != Some(workspace) {
        return Err("Saved upload copy is outside this job's workspace.".into());
    }
    if !path.exists() {
        let expected = prepared.sha256.clone();
        // Keep the old prepared SHA durable until replacement is proven equal.
        // A failed attempt must never erase the immutable retry identity.
        let replacement = metadata::prepare(&item, path, exiftool)?;
        if replacement.sha256 != expected {
            let _ = fs::remove_file(path);
            return Err("Recreated upload metadata differs from the immutable prepared bytes. Create a fresh reviewed plan rather than silently changing the upload.".into());
        }
        job.items[index].prepared = Some(replacement);
        job.items[index].session = None;
        job.items[index].token = None;
        job.items[index].offset = 0;
        job.save(store)?;
    }
    super::store::reject_link(path)?;
    if metadata::hash_file(path)? != prepared.sha256 {
        return Err("Prepared upload bytes changed. Upload refused; create a fresh plan.".into());
    }
    if job.items[index].token.is_some()
        && job.items[index].token_at + 23 * 3600 > chrono::Utc::now().timestamp()
    {
        return Ok(());
    }
    if job.items[index].token.is_some() {
        job.items[index].session = None;
        job.items[index].offset = 0;
    }
    job.items[index].token = None;
    if job.items[index]
        .session
        .as_ref()
        .is_some_and(|s| s.started_at + 6 * 86400 < chrono::Utc::now().timestamp())
    {
        job.items[index].session = None;
    }
    stop_requested(stop)?;
    diagnostics::note(job, Stage::UploadBytes, Some(index), Outcome::Started, None);
    job.save(store)?;
    if job.items[index].session.is_none() {
        let name = Path::new(&item.path)
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("Invalid photo filename.")?;
        job.items[index].session = Some(api.begin(name, &prepared.mime, prepared.bytes)?);
        job.items[index].offset = 0;
        job.save(store)?;
    } else {
        let session = job.items[index].session.as_ref().unwrap();
        let progress = match api.query(session) {
            Ok(progress) => Some(progress),
            Err(error) if error.contains("Start a fresh byte session") => {
                job.items[index].session = None;
                job.items[index].offset = 0;
                job.items[index].token = None;
                job.save(store)?;
                None
            }
            Err(error) => return Err(error),
        };
        if let Some(progress) = progress {
            if progress.received > prepared.bytes {
                return Err("Google upload progress exceeds the prepared file size.".into());
            }
            job.items[index].offset = progress.received;
            if let Some(token) = progress.token {
                if progress.received != prepared.bytes {
                    return Err(
                        "Google finalized an incomplete byte range. The photo was not registered."
                            .into(),
                    );
                }
                job.items[index].token = Some(token);
                job.items[index].token_at = chrono::Utc::now().timestamp();
                job.save(store)?;
                return Ok(());
            }
            job.save(store)?;
        }
    }
    if job.items[index].session.is_none() {
        stop_requested(stop)?;
        let name = Path::new(&item.path)
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("Invalid photo filename.")?;
        job.items[index].session = Some(api.begin(name, &prepared.mime, prepared.bytes)?);
        job.items[index].offset = 0;
        job.save(store)?;
    }
    let session = job.items[index].session.clone().unwrap();
    if session.granularity == 0 || session.granularity > 32 * 1024 * 1024 {
        return Err("Saved resumable chunk granularity is invalid. Upload refused.".into());
    }
    let chunk_size = ((8 * 1024 * 1024_u64 / session.granularity).max(1) * session.granularity)
        .min(32 * 1024 * 1024);
    let mut file = File::open(path).map_err(|_| "Upload copy disappeared.")?;
    loop {
        stop_requested(stop)?;
        let offset = job.items[index].offset;
        if offset > prepared.bytes {
            return Err("Google returned an unsupported resumable offset.".into());
        }
        let amount = (prepared.bytes - offset).min(chunk_size) as usize;
        file.seek(SeekFrom::Start(offset))
            .map_err(|_| "Could not seek upload copy.")?;
        let mut bytes = vec![0; amount];
        file.read_exact(&mut bytes)
            .map_err(|_| "Could not read complete upload chunk.")?;
        let final_chunk = offset + amount as u64 == prepared.bytes;
        job.items[index].state = "uploading".into();
        job.save(store)?;
        let progress = api.chunk(&session, offset, bytes, final_chunk)?;
        if progress.received != offset + amount as u64 {
            return Err(
                "Google returned unexpected upload progress. Query will reconcile it on resume."
                    .into(),
            );
        }
        job.items[index].offset = progress.received;
        if let Some(token) = progress.token {
            if progress.received != prepared.bytes {
                return Err(
                    "Google finalized an incomplete byte range. The photo was not registered."
                        .into(),
                );
            }
            job.items[index].token = Some(token);
            job.items[index].token_at = chrono::Utc::now().timestamp();
            job.items[index].state = "uploaded_bytes".into();
            diagnostics::note(
                job,
                Stage::UploadBytes,
                Some(index),
                Outcome::Succeeded,
                None,
            );
            job.save(store)?;
            return Ok(());
        }
        job.save(store)?;
        if final_chunk {
            return Err("Google did not finalize this photo. Resume will query the session; no upload success was assumed.".into());
        }
    }
}
pub fn drive(
    store: &GoogleStore,
    job: &mut Job,
    api: &mut dyn GoogleApi,
    workspace: &Path,
    exiftool: &str,
    stop: &AtomicBool,
) -> Result<(), String> {
    if job.retry_after > chrono::Utc::now().timestamp() {
        return Err(
            "Google asked us to wait before retrying. Retry in at least 30 seconds.".into(),
        );
    }
    fs::create_dir_all(workspace).map_err(|_| "Cannot create bounded upload workspace.")?;
    super::store::reject_link(workspace)?;
    job.recover();
    if job
        .albums
        .iter()
        .any(|a| a.state == "creation_outcome_unknown")
    {
        return Err("An album creation outcome is unknown. Choose the actual app-created album in recovery before resuming; no duplicate album will be created.".into());
    }
    job.status = "running".into();
    job.errors.clear();
    job.save(store)?;
    // Retry every saved ID across albums before source access or new writes.
    let registered: Vec<_> = (0..job.items.len())
        .filter(|i| job.items[*i].media.is_some())
        .collect();
    verify_receipts(store, job, &registered, api, workspace, stop)?;
    diagnostics::note(job, Stage::Preflight, None, Outcome::Started, None);
    job.save(store)?;
    // Recheck immutable local evidence before the FIRST external write, not
    // after creating an album that may otherwise end up empty.
    let root = if job.items.iter().any(|p| {
        p.media.is_none() && !matches!(p.state.as_str(), "verified" | "skipped" | "blocked")
    }) {
        Some(
            Path::new(&job.plan.root)
                .canonicalize()
                .map_err(|_| "The reviewed photo folder is unavailable.")?,
        )
    } else {
        None
    };
    if job.plan.items.iter().enumerate().any(|(i, item)| {
        !matches!(
            job.items[i].state.as_str(),
            "verified" | "skipped" | "blocked"
        ) && job.items[i].media.is_none()
            && metadata::needs_tool(item)
    }) && !metadata::check_tool(exiftool)
    {
        return Err("ExifTool is unavailable. Configure it before resuming metadata/GPS preparation; no album was created.".into());
    }
    for (index, item) in job.plan.items.iter().enumerate() {
        if matches!(
            job.items[index].state.as_str(),
            "verified" | "skipped" | "blocked"
        ) || job.items[index].media.is_some()
        {
            continue;
        }
        stop_requested(stop)?;
        scope(
            item,
            root.as_deref()
                .ok_or("The reviewed photo folder is unavailable.")?,
        )?;
        metadata::validate_item(item)?;
        if metadata::hash_file(Path::new(&item.path))? != item.source_sha256 {
            return Err("Photo changed since this plan was reviewed. Create a fresh plan; no changed bytes were uploaded.".into());
        }
        if let Some((_, expected)) = job
            .original_hashes
            .iter()
            .find(|(path, _)| path == &item.original_path)
        {
            if &metadata::hash_file(Path::new(&item.original_path))? != expected {
                return Err(
                    "Original metadata lineage changed after review. Prepare a fresh plan.".into(),
                );
            }
        }
    }
    for album_index in 0..job.albums.len() {
        stop_requested(stop)?;
        let key = job.albums[album_index].key.clone();
        let indices: Vec<usize> = job
            .plan
            .items
            .iter()
            .enumerate()
            .filter(|(_, item)| item.album_key == key)
            .map(|(i, _)| i)
            .collect();
        let has_work = indices.iter().any(|i| {
            !matches!(
                job.items[*i].state.as_str(),
                "skipped" | "verified" | "blocked"
            )
        });
        if job.albums[album_index].id.is_none() && has_work {
            job.albums[album_index].state = "creating".into();
            diagnostics::note(job, Stage::CreateAlbum, None, Outcome::Started, None);
            job.save(store)?;
            match api.create_album(&job.albums[album_index].title) {
                Ok(Album {
                    id, product_url, ..
                }) => {
                    job.albums[album_index].id = Some(id);
                    job.albums[album_index].product_url = product_url;
                    job.albums[album_index].state = "ready".into();
                    job.albums[album_index].title_done = true;
                    diagnostics::note(job, Stage::CreateAlbum, None, Outcome::Succeeded, None);
                    job.save(store)?;
                    save_album_mapping(store, job, album_index)?;
                }
                Err(error) => {
                    let rejected = ["HTTP 400", "HTTP 401", "HTTP 403", "HTTP 429"]
                        .iter()
                        .any(|code| error.contains(code));
                    job.albums[album_index].state = if rejected {
                        "pending"
                    } else {
                        "creation_outcome_unknown"
                    }
                    .into();
                    job.save(store)?;
                    return Err(error);
                }
            }
        }
        if !has_work && job.albums[album_index].id.is_none() {
            continue;
        }
        let album_id = job.albums[album_index]
            .id
            .clone()
            .ok_or("Job album is unavailable.")?;
        if !job.albums[album_index].title_done || job.albums[album_index].product_url.is_empty() {
            stop_requested(stop)?;
            diagnostics::note(job, Stage::AlbumDetails, None, Outcome::Started, None);
            job.save(store)?;
            let confirmed = api.update_title(&album_id, &job.albums[album_index].title)?;
            job.albums[album_index].product_url = confirmed.product_url;
            job.albums[album_index].title_done = true;
            diagnostics::note(job, Stage::AlbumDetails, None, Outcome::Succeeded, None);
            job.save(store)?;
        }
        save_album_mapping(store, job, album_index)?;
        // Resume successful registrations by read-back, not by adding media again.
        for index in &indices {
            if job.items[*index].state == "verified" {
                remember(store, job, *index)?;
            }
        }
        let pending: Vec<_> = indices
            .iter()
            .copied()
            .filter(|i| {
                job.items[*i].media.is_none()
                    && !matches!(
                        job.items[*i].state.as_str(),
                        "verified" | "skipped" | "blocked"
                    )
            })
            .collect();
        // Eight files bounds prepared-copy disk use (<=1.6GB worst case) and
        // amortizes media registration without competing readers on originals.
        for batch in pending.chunks(8) {
            for index in batch {
                stop_requested(stop)?;
                if let Err(error) = upload_item(store, job, *index, api, workspace, exiftool, stop)
                {
                    job.items[*index].error = Some(error.clone());
                    job.save(store)?;
                    return Err(error);
                }
            }
            stop_requested(stop)?;
            let payload: Vec<_> = batch
                .iter()
                .map(|i| {
                    (
                        job.items[*i].token.clone().unwrap_or_default(),
                        Path::new(&job.plan.items[*i].path)
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned(),
                    )
                })
                .collect();
            for index in batch {
                job.items[*index].state = "registering".into();
            }
            diagnostics::note(job, Stage::RegisterMedia, None, Outcome::Started, None);
            job.save(store)?;
            let results = api.register(&album_id, &payload)?;
            let mut failure = None;
            for index in batch {
                let token = job.items[*index].token.as_deref().unwrap_or("");
                let matching: Vec<_> = results.iter().filter(|r| r.token == token).collect();
                if matching.len() != 1 {
                    job.items[*index].error = Some("Google registration result is missing/ambiguous. Retry safely reuses these exact prepared bytes.".into());
                    failure = job.items[*index].error.clone().map(|error| (*index, error));
                } else {
                    match &matching[0].result {
                        Ok(media) => {
                            job.items[*index].media = Some(media.clone());
                            job.items[*index].state = "registered".into();
                            job.items[*index].error = None;
                            diagnostics::note(
                                job,
                                Stage::RegisterMedia,
                                Some(*index),
                                Outcome::Succeeded,
                                None,
                            );
                        }
                        Err(error) => {
                            job.items[*index].state = "failed".into();
                            job.items[*index].error = Some(error.clone());
                            failure = Some((*index, error.clone()));
                            diagnostics::note(
                                job,
                                Stage::RegisterMedia,
                                Some(*index),
                                Outcome::Failed,
                                Some(error),
                            );
                        }
                    }
                }
                job.save(store)?;
            }
            verify_receipts(store, job, batch, api, workspace, stop)?;
            if let Some((index, error)) = failure {
                // Successful siblings were verified after registration. Restore
                // the actual failure context before the outer job error handler
                // logs it; otherwise the healthy sibling would be blamed.
                diagnostics::note(
                    job,
                    Stage::RegisterMedia,
                    Some(index),
                    Outcome::Failed,
                    Some(&error),
                );
                job.save(store)?;
                return Err(error);
            }
        }
        if !job.albums[album_index].cover_done {
            if let Some(cover) = &job.albums[album_index].cover_item_id {
                let index = job
                    .items
                    .iter()
                    .position(|i| &i.id == cover)
                    .ok_or("Selected cover is missing.")?;
                let media = job.items[index]
                    .media
                    .as_ref()
                    .ok_or("Selected cover was not successfully uploaded.")?;
                stop_requested(stop)?;
                let media_id = media.id.clone();
                diagnostics::note(job, Stage::AlbumCover, Some(index), Outcome::Started, None);
                job.save(store)?;
                api.cover(&album_id, &media_id)?;
            }
            job.albums[album_index].cover_done = true;
            diagnostics::note(job, Stage::AlbumCover, None, Outcome::Succeeded, None);
            job.save(store)?;
        }
    }
    complete(store, job)
}
fn complete(store: &GoogleStore, job: &mut Job) -> Result<(), String> {
    if job
        .items
        .iter()
        .any(|p| p.media.is_some() && !matches!(p.state.as_str(), "verified" | "skipped"))
    {
        return Err("Registered Google photos still need verification. Resume the saved job; no registered photo will be uploaded again.".into());
    }
    job.status = if job
        .items
        .iter()
        .any(|i| i.state == "blocked" || i.state == "failed")
    {
        "completed_with_errors"
    } else {
        "completed"
    }
    .into();
    diagnostics::note(job, Stage::Job, None, Outcome::Succeeded, None);
    job.save(store)
}
fn cleanup_copy(job: &Job, index: usize, workspace: &Path) -> Result<(), String> {
    if let Some(prepared) = &job.items[index].prepared {
        let path = Path::new(&prepared.path);
        if path.parent() == Some(workspace) && path.is_file() {
            super::store::reject_link(path)?;
            fs::remove_file(path).map_err(|_| {
                "Uploaded photo was verified, but its owned temporary copy could not be removed."
            })?;
        }
    }
    Ok(())
}
pub fn save_album_mapping(store: &GoogleStore, job: &Job, index: usize) -> Result<(), String> {
    let album = &job.albums[index];
    let mut albums: Vec<ExistingAlbum> = store.load("albums")?.unwrap_or_default();
    albums.retain(|a| !(a.account_id == job.plan.account_id && a.key == album.key));
    albums.push(ExistingAlbum {
        account_id: job.plan.account_id.clone(),
        key: album.key.clone(),
        album_id: album.id.clone().ok_or("Album not yet created.")?,
        title: album.title.clone(),
    });
    store.save("albums", &albums)
}
pub fn finish_error(
    store: &GoogleStore,
    job: &mut Job,
    error: String,
    stopped: bool,
) -> Result<(), String> {
    job.status = if stopped { "paused" } else { "needs_attention" }.into();
    diagnostics::finish(job, &error, stopped);
    if diagnostics::rate_limited(&error) {
        job.retry_after = chrono::Utc::now().timestamp() + 30;
    }
    if !stopped && !job.errors.contains(&error) {
        job.errors.push(error);
    }
    job.save(store)
}

#[cfg(test)]
#[path = "engine_tests.rs"]
mod tests;
