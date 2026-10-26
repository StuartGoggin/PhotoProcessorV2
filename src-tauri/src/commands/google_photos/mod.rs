//! Google Photos publishing is an additive export, not a cloud-library sync.
//! Only this module owns cloud credentials, immutable plans and resumable jobs.
mod catalogue;
mod diagnostics;
pub(crate) mod engine;
mod core_jobs;
pub(crate) use core_jobs::{snapshot as job_snapshot, archive_finished as archive_finished_jobs};
mod metadata;
pub mod model;
mod oauth;
mod plan;
mod store;
mod transport;
pub(crate) use transport::Album as CoreAlbum;
mod vault;

use engine::{AlbumEdit, Job, JobSummary};
use model::*;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager};
use transport::{Album, GoogleApi, LiveGoogle};

static ACCOUNT_GATE: Mutex<()> = Mutex::new(());
static CONNECTING: AtomicBool = AtomicBool::new(false);
fn workspace(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|_| "Application configuration folder is unavailable.")?
        .join("google-photos-v1");
    fs::create_dir_all(&path).map_err(|_| "Cannot create Google Photos application data.")?;
    store::reject_link(&path)?;
    path.canonicalize()
        .map_err(|_| "Cannot resolve protected Google Photos workspace.".into())
}
fn protected(app: &AppHandle) -> Result<store::GoogleStore, String> {
    store::GoogleStore::new(
        workspace(app)?.join("protected"),
        Arc::new(vault::UserVault),
    )
}
/// Held over complete read-modify-write operations AND all account mutations.
/// OS lock lifetime prevents a second PhotoGoGo process from starting a writer.
fn writer_lease(app: &AppHandle) -> Result<File, String> {
    use fs2::FileExt;
    let path = workspace(app)?.join("worker.lock");
    if path.exists() {
        store::reject_link(&path)?;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| "Cannot acquire Google Photos worker lease.")?;
    file.try_lock_exclusive().map_err(|_| "Google Photos is busy signing in or running a job. Pause it and wait for its safe checkpoint before changing accounts or plans.")?;
    Ok(file)
}
/// Naming moves local source paths. Reuse the upload lease without reading any
/// account or credential data, so an active uploader cannot race those moves.
pub(crate) fn event_naming_lease(app: &AppHandle) -> Result<File, String> {
    writer_lease(app).map_err(|_| "Google Photos is busy. Wait for its current operation to finish before renaming media folders.".into())
}
fn validate_id(id: &str) -> Result<(), String> {
    if id.len() != 43
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        Err("Invalid Google Photos plan/job identifier.".into())
    } else {
        Ok(())
    }
}
pub(crate) fn is_job_id(id: &str) -> bool { validate_id(id).is_ok() }
fn load_job(store: &store::GoogleStore, id: &str) -> Result<Job, String> {
    validate_id(id)?;
    store
        .load(&format!("job_{id}"))?
        .ok_or("Upload job was not found.".into())
}
fn same_account(store: &store::GoogleStore, id: &str) -> Result<(), String> {
    if oauth::account(store)?.is_none_or(|a| a.id != id) {
        Err("This job belongs to a different Google account/OAuth client. Reconnect its original account before continuing.".into())
    } else {
        Ok(())
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    configured: bool,
    client_id_hint: Option<String>,
    account: Option<oauth::Account>,
    connecting: bool,
}
#[tauri::command]
pub fn google_photos_status(app: AppHandle) -> Result<Status, String> {
    let store = protected(&app)?;
    let config: Option<oauth::ClientConfig> = store.load("oauth_config")?;
    Ok(Status {
        configured: config.is_some(),
        client_id_hint: config
            .map(|c| format!("{}…", c.client_id.chars().take(12).collect::<String>())),
        account: oauth::account(&store)?,
        connecting: CONNECTING.load(Ordering::Relaxed),
    })
}
#[tauri::command]
pub async fn google_photos_configure(app: AppHandle, config_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = ACCOUNT_GATE
            .try_lock()
            .map_err(|_| "Google sign-in is already in progress.")?;
        let _lease = writer_lease(&app)?;
        let result = oauth::import_config(&protected(&app)?, Path::new(&config_path));
        core_jobs::invalidate();
        result
    })
    .await
    .map_err(|_| "OAuth configuration task failed.")?
}
#[tauri::command]
pub async fn google_photos_connect(app: AppHandle) -> Result<oauth::Account, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = ACCOUNT_GATE
            .try_lock()
            .map_err(|_| "Google sign-in is already in progress.")?;
        let _lease = writer_lease(&app)?;
        CONNECTING.store(true, Ordering::Relaxed);
        struct Reset;
        impl Drop for Reset {
            fn drop(&mut self) {
                CONNECTING.store(false, Ordering::Relaxed);
                core_jobs::invalidate();
            }
        }
        let _reset = Reset;
        oauth::connect(&protected(&app)?)
    })
    .await
    .map_err(|_| "Google sign-in task failed safely; reconnect to retry.")?
}
#[tauri::command]
pub async fn google_photos_disconnect(app: AppHandle, revoke: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _gate = ACCOUNT_GATE
            .try_lock()
            .map_err(|_| "Wait for sign-in to finish before disconnecting.")?;
        let _lease = writer_lease(&app)?;
        let result = oauth::disconnect(&protected(&app)?, revoke);
        core_jobs::invalidate();
        result
    })
    .await
    .map_err(|_| "Google disconnect task failed.")?
}
#[tauri::command]
pub async fn google_photos_catalogue(app: AppHandle, root: String) -> Result<Catalogue, String> {
    tauri::async_runtime::spawn_blocking(move || {
        enrich_history(&app, catalogue::scan(Path::new(&root))?)
    })
    .await
    .map_err(|_| "Photo catalogue task failed.")?
}
#[tauri::command]
pub async fn google_photos_set_selection(
    app: AppHandle,
    root: String,
    asset_id: String,
    selected: bool,
    favourite: Option<bool>,
) -> Result<Catalogue, String> {
    tauri::async_runtime::spawn_blocking(move || {
        enrich_history(
            &app,
            store::set_selection(Path::new(&root), &asset_id, selected, favourite)?,
        )
    })
    .await
    .map_err(|_| "Photo curation task failed.")?
}
fn enrich_history(app: &AppHandle, mut catalogue: Catalogue) -> Result<Catalogue, String> {
    let history = (|| {
        let store = protected(app)?;
        let account = oauth::account(&store)?;
        let ledger: Vec<LedgerEntry> = engine::effective_ledger(&store)?;
        Ok::<_, String>((account, ledger))
    })();
    match history {
        Ok((Some(account), ledger)) => {
            let uploaded: std::collections::HashSet<_> = ledger.iter().filter(|r| r.account_id == account.id).map(|r| r.asset_id.as_str()).collect();
            for asset in &mut catalogue.assets { if uploaded.contains(asset.id.as_str()) { asset.upload_status = Some("uploaded_previously".into()); } }
        }
        Err(_) => catalogue.warnings.push("Google upload history is unavailable; local curation remains usable. Reconnect or inspect the protected store error on Transfer. No cloud history was reset.".into()),
        _ => {}
    }
    Ok(catalogue)
}
#[derive(Clone, Serialize, Deserialize)]
struct FrozenPlan {
    plan: PlanPreview,
    original_hashes: Vec<(String, String)>,
}
#[tauri::command]
pub async fn google_photos_plan(
    app: AppHandle,
    request: PlanRequest,
) -> Result<PlanPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = writer_lease(&app)?; let store = protected(&app)?;
        let account = oauth::account(&store)?.ok_or("Connect the intended Google account before preparing an upload plan.")?;
        let catalogue = catalogue::scan(Path::new(&request.root))?;
        let context = PlanContext { id: oauth::random_id()?, account_id: account.id, account_email: account.email, ledger: engine::effective_ledger(&store)?, albums: store.load("albums")?.unwrap_or_default() };
        let mut result = plan::build(&catalogue, &request, &context)?;
        let settings = super::settings::load_settings(app.clone())?;
        let tool_available = if result.items.iter().any(|i| metadata::needs_tool(i)) { metadata::check_tool(&settings.exiftool_dir) } else { true };
        let mut originals = std::collections::BTreeMap::new();
        for item in &mut result.items {
            if !matches!(item.status, PlanItemStatus::Ready | PlanItemStatus::Changed) { continue; }
            let ext = Path::new(&item.path).extension().and_then(|x| x.to_str()).unwrap_or("").to_ascii_lowercase();
            if !matches!(ext.as_str(), "jpg" | "jpeg" | "png") || (metadata::needs_tool(item) && ext == "png") { item.status = PlanItemStatus::Unsupported; item.warnings.push("This release validates full-resolution JPEG and unmodified PNG uploads. Metadata/GPS-safe copies require JPEG; no silent format conversion is performed.".into()); continue; }
            if metadata::needs_tool(item) && !tool_available { item.status = PlanItemStatus::Blocked; item.warnings.push("Check the metadata tool in Settings. Clear a broken custom override to use bundled ExifTool, or repair the installation. It is needed to restore capture-date/colour metadata or remove GPS in an upload-only copy; your original is never modified.".into()); continue; }
            if let Err(error) = metadata::validate_item(item) { item.status = PlanItemStatus::Blocked; item.warnings.push(error); continue; }
            let origin = Path::new(&item.original_path);
            match metadata::hash_file(origin) { Ok(hash) if hash == item.original_sha256 => { originals.insert(item.original_path.clone(), hash); }, Ok(_) => { item.status = PlanItemStatus::Blocked; item.warnings.push("The original metadata lineage changed during planning. Refresh and review a fresh plan.".into()); continue; }, Err(error) => { item.status = PlanItemStatus::Blocked; item.warnings.push(format!("Original metadata lineage cannot be verified: {error}")); continue; } }
            if metadata::capture_date(Path::new(&item.path)).or_else(|| metadata::capture_date(origin)).is_none() { item.warnings.push("No embedded capture time could be verified. Google may use the upload time. The event date names the album only; it does not change the photo's capture time.".into()); }
        }
        result.total_bytes = result.items.iter().filter(|i| matches!(i.status, PlanItemStatus::Ready | PlanItemStatus::Changed)).map(|i| i.bytes).sum();
        if result.items.iter().any(|i| matches!(i.status, PlanItemStatus::Unsupported | PlanItemStatus::Blocked)) { result.warnings.push("Blocked/unsupported versions will be excluded, not uploaded at reduced quality. Review all warnings and the final counts.".into()); }
        store.save(&format!("plan_{}", result.id), &FrozenPlan { plan: result.clone(), original_hashes: originals.into_iter().collect() })?;
        Ok(result)
    }).await.map_err(|_| "Upload planning task failed; no Google writes occurred.")?
}
fn spawn_worker(app: AppHandle, mut job: Job, lease: File) -> Result<(), String> {
    let managed = super::process_runtime::register(super::process_runtime::Kind::GooglePhotos, &job.plan.id)?;
    let control = managed.control.clone();
    job.status = "queued".into();
    job.finished_at = None;
    job.save(&protected(&app)?)?;
    let job_id = job.plan.id.clone();
    let app_for_failure = app.clone();
    core_jobs::invalidate();
    let result = std::thread::Builder::new()
        .name("google-photos-export".into())
        .spawn(move || {
            let _lease = lease;
            let _managed = managed;
            struct Clear;
            impl Drop for Clear {
                fn drop(&mut self) {
                    core_jobs::invalidate();
                }
            }
            let _clear = Clear;
            let result = (|| {
                let store = protected(&app)?;
                job.status = "running".into();
                if job.started_at.is_none() { job.started_at = Some(chrono::Utc::now().to_rfc3339()); }
                job.save(&store)?;
                if control.stop.load(Ordering::Relaxed) {
                    engine::finish_error(&store, &mut job, "Stopped before further account or upload work.".into(), true)?;
                    if control.abort.load(Ordering::Relaxed) { job.status = "aborted".into(); job.finished_at = Some(chrono::Utc::now().to_rfc3339()); job.save(&store)?; }
                    return Ok::<(), String>(());
                }
                diagnostics::note(&mut job, diagnostics::Stage::Account, None, diagnostics::Outcome::Started, None);
                job.save(&store)?;
                same_account(&store, &job.plan.account_id)?;
                let _ = oauth::access_token(&store, &job.plan.account_id)?;
                let account_id = job.plan.account_id.clone();
                let mut api = LiveGoogle {
                    store: &store,
                    account_id: &account_id,
                };
                let settings = super::settings::load_settings(app.clone())?;
                let path = workspace(&app)?.join("copies").join(&job.plan.id);
                if let Err(error) = engine::drive(
                    &store,
                    &mut job,
                    &mut api,
                    &path,
                    &settings.exiftool_dir,
                    &control.stop,
                ) {
                    engine::finish_error(&store, &mut job, error, control.stop.load(Ordering::Relaxed))?;
                }
                if control.abort.load(Ordering::Relaxed) && job.status == "paused" {
                    job.status = "aborted".into();
                    job.finished_at = Some(chrono::Utc::now().to_rfc3339());
                    job.save(&store)?;
                }
                Ok::<(), String>(())
            })();
            if let Err(error) = result {
                if let Ok(store) = protected(&app) {
                    let _ = engine::finish_error(&store, &mut job, error, false);
                }
            }
        });
    if result.is_err() {
        // A failed spawn drops the moved OS lease before returning. Reacquire
        // admission before touching state another process may already resume.
        if let Ok(_lease) = writer_lease(&app_for_failure) {
            if let Ok(store) = protected(&app_for_failure) {
                if let Ok(mut saved) = load_job(&store, &job_id) {
                    if matches!(saved.status.as_str(), "queued" | "running") { saved.recover(); let _ = saved.save(&store); }
                }
            }
        }
        core_jobs::invalidate();
        return Err("Could not start upload worker. The job remains saved and recoverable through the core Jobs tracker.".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn google_photos_start(
    app: AppHandle,
    plan_id: String,
    albums: Vec<AlbumEdit>,
    acknowledge_warnings: bool,
) -> Result<JobSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_id(&plan_id)?; let lease = writer_lease(&app)?; let store = protected(&app)?;
        if store.load::<Job>(&format!("job_{plan_id}"))?.is_some() { return Err("This plan already has a durable upload job. Resume that job instead of publishing it twice.".into()); }
        let frozen: FrozenPlan = store.load(&format!("plan_{plan_id}"))?.ok_or("Upload plan is unavailable. Prepare a new review.")?;
        same_account(&store, &frozen.plan.account_id)?;
        if !acknowledge_warnings { return Err("Review the exact account, album names, photo versions, storage/privacy choices and warnings before publishing.".into()); }
        if !frozen.plan.items.iter().any(|i| matches!(i.status, PlanItemStatus::Ready | PlanItemStatus::Changed | PlanItemStatus::AlreadyUploaded)) { return Err("There are no uploadable photos in this plan. Resolve its blocked items first.".into()); }
        let ledger: Vec<LedgerEntry> = engine::effective_ledger(&store)?;
        let mut job = Job::new(frozen.plan, albums, frozen.original_hashes, &ledger)?; job.status = "queued".into(); job.save(&store)?; let summary = job.summary(); spawn_worker(app, job, lease)?; Ok(summary)
    }).await.map_err(|_| "Could not start Google upload task.")?
}
#[tauri::command]
pub fn google_photos_list_jobs(app: AppHandle) -> Result<Vec<JobSummary>, String> {
    // Compatibility only: one snapshot provider, no second tracker or poller.
    let (jobs, warnings) = core_jobs::snapshot(&app);
    if !warnings.is_empty() { return Err(warnings.join(" ")); }
    Ok(jobs.into_iter().filter_map(|job| job.google_photos).collect())
}
#[tauri::command]
pub async fn google_photos_job_diagnostics(app: AppHandle, job_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let store = protected(&app)?;
        let job = load_job(&store, &job_id)?;
        Ok(diagnostics::report(&job))
    }).await.map_err(|_| "Could not read the saved Google Photos diagnostics. No upload was started.")?
}
#[tauri::command]
pub async fn google_photos_control(
    app: AppHandle,
    job_id: String,
    action: String,
) -> Result<(), String> {
    validate_id(&job_id)?;
    core_jobs::invalidate();
    if matches!(action.as_str(), "pause" | "abort") {
        if !super::process_runtime::request_stop(&job_id, action == "abort")? {
            let _lease = writer_lease(&app).map_err(|_| "This upload runs in another PhotoGoGo process. Stop it in the window where it was started.")?;
            let store = protected(&app)?;
            let mut job = load_job(&store, &job_id)?;
            job.recover();
            if !matches!(job.status.as_str(), "completed" | "completed_with_errors" | "completed_with_warnings") {
                job.status = if action == "abort" { "aborted" } else { "paused" }.into();
                job.save(&store)?;
            }
        }
        core_jobs::invalidate();
        return Ok(());
    }
    if !matches!(action.as_str(), "resume" | "retry") {
        return Err("Choose pause, resume or retry.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let lease = writer_lease(&app)?;
        let store = protected(&app)?;
        let mut job = load_job(&store, &job_id)?;
        same_account(&store, &job.plan.account_id)?;
        job.recover();
        if job.history_hidden && core_jobs::history_eligible(&job) { return Err("Restore this upload to History before explicitly rechecking.".into()); }
        if job.status == "completed" {
            return Err(
                "This job already completed; create a new plan for changed or additional photos."
                    .into(),
            );
        }
        if job.retry_after > chrono::Utc::now().timestamp() {
            return Err("Google rate limit: wait at least 30 seconds before retrying.".into());
        }
        spawn_worker(app, job, lease)
    })
    .await
    .map_err(|_| "Could not resume Google upload task.")?
}

pub(crate) async fn job_albums(app: AppHandle, job_id: String) -> Result<Vec<Album>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = writer_lease(&app)?;
        let store = protected(&app)?;
        let job = load_job(&store, &job_id)?;
        same_account(&store, &job.plan.account_id)?;
        LiveGoogle { store: &store, account_id: &job.plan.account_id }.list_albums()
    }).await.map_err(|_| "Could not list this job's recovery albums.")?
}
#[tauri::command]
pub async fn google_photos_albums(app: AppHandle) -> Result<Vec<Album>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = writer_lease(&app)?;
        let store = protected(&app)?;
        let account =
            oauth::account(&store)?.ok_or("Connect the original Google account first.")?;
        LiveGoogle {
            store: &store,
            account_id: &account.id,
        }
        .list_albums()
    })
    .await
    .map_err(|_| "Could not list recovery albums.")?
}
#[tauri::command]
pub async fn google_photos_reconcile(
    app: AppHandle,
    job_id: String,
    album_key: String,
    album_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = writer_lease(&app)?;
        let store = protected(&app)?;
        let mut job = load_job(&store, &job_id)?;
        same_account(&store, &job.plan.account_id)?;
        job.recover();
        let index = job
            .albums
            .iter()
            .position(|a| a.key == album_key && a.state == "creation_outcome_unknown")
            .ok_or("Only an uncertain album-creation outcome can be reconciled here.")?;
        let mut api = LiveGoogle {
            store: &store,
            account_id: &job.plan.account_id,
        };
        let album = api
            .list_albums()?
            .into_iter()
            .find(|a| a.id == album_id)
            .ok_or("Choose an actual app-created album belonging to this Google account/client.")?;
        job.albums[index].id = Some(album.id);
        job.albums[index].title = album.title;
        job.albums[index].product_url = album.product_url;
        job.albums[index].state = "ready".into();
        job.status = "paused".into();
        job.errors.clear();
        job.save(&store)?;
        let result = engine::save_album_mapping(&store, &job, index);
        core_jobs::invalidate();
        result
    })
    .await
    .map_err(|_| "Album reconciliation task failed.")?
}
#[tauri::command]
pub fn google_photos_open_album(
    app: AppHandle,
    job_id: String,
    album_key: String,
) -> Result<(), String> {
    let store = protected(&app)?;
    let job = load_job(&store, &job_id)?;
    same_account(&store, &job.plan.account_id)?;
    let album = job
        .albums
        .iter()
        .find(|a| a.key == album_key && a.id.is_some())
        .ok_or("A confirmed album link is not available yet.")?;
    oauth::open_url(&album.product_url)
}
#[tauri::command]
pub async fn google_photos_thumbnail(
    app: AppHandle,
    plan_id: String,
    item_id: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_id(&plan_id)?;
        let store = protected(&app)?;
        let frozen: FrozenPlan = store
            .load(&format!("plan_{plan_id}"))?
            .ok_or("Photo plan is no longer available.")?;
        let item = frozen
            .plan
            .items
            .iter()
            .find(|i| i.id == item_id)
            .ok_or("Photo is not in this plan.")?;
        let path = Path::new(&item.path);
        store::reject_link(path)?;
        if !path
            .canonicalize()
            .map_err(|_| "Preview source is unavailable.")?
            .starts_with(Path::new(&frozen.plan.root))
        {
            return Err("Preview source is outside its reviewed root.".into());
        }
        let dimensions = image::ImageReader::open(path)
            .map_err(|_| "Cannot open photo preview.")?
            .with_guessed_format()
            .map_err(|_| "Cannot identify photo.")?
            .into_dimensions()
            .map_err(|_| "Invalid photo dimensions.")?;
        if u64::from(dimensions.0) * u64::from(dimensions.1) > 100_000_000
            || fs::metadata(path)
                .map_err(|_| "Preview source disappeared.")?
                .len()
                > 200_000_000
        {
            return Err("Photo exceeds preview safety limits.".into());
        }
        let photo = super::photo_process::load_oriented(path)?.thumbnail(480, 320);
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 80)
            .encode_image(&photo)
            .map_err(|_| "Could not encode preview thumbnail.")?;
        Ok(crate::utils::base64_encode(&bytes))
    })
    .await
    .map_err(|_| "Photo thumbnail task failed.")?
}

pub(crate) async fn restore_history(app: AppHandle, job_id: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || { validate_id(&job_id)?; let _lease=writer_lease(&app)?; let store=protected(&app)?; let result=core_jobs::restore_store(&store, &job_id); core_jobs::invalidate(); result }).await.map_err(|_| "Could not restore saved history visibility.")?
}
