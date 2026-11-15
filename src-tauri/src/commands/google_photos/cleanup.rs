//! Receipt-first cleanup. Uncertain remote mutations remain recoverable.
use super::{
    engine::{self, Job},
    model::*,
    store::GoogleStore,
};
use crate::commands::job_cleanup::{self, Choice, Entry};
use tauri::AppHandle;
fn active(job: &Job, workers: &[String]) -> bool {
    workers.contains(&job.plan.id) || matches!(job.status.as_str(), "queued" | "running")
}
pub(super) fn validate_shape(job: &Job) -> Result<(), String> {
    if job.items.len() != job.plan.items.len() || job.albums.len() != job.plan.albums.len() {
        return Err("Inconsistent saved job retained for inspection".into());
    }
    let mut items = std::collections::HashSet::new();
    let mut albums = std::collections::HashSet::new();
    for album in &job.albums {
        if album.key.is_empty()
            || !albums.insert(&album.key)
            || !job.plan.albums.iter().any(|a| a.key == album.key)
        {
            return Err("Inconsistent album identity retained".into());
        }
    }
    for (i, p) in job.items.iter().enumerate() {
        if p.id.is_empty()
            || p.id != job.plan.items[i].id
            || !items.insert(&p.id)
            || !albums.contains(&job.plan.items[i].album_key)
        {
            return Err("Inconsistent photo identity retained".into());
        }
    }
    Ok(())
}
fn compact(
    store: &GoogleStore,
    job: &Job,
) -> Result<(Vec<LedgerEntry>, Vec<ExistingAlbum>), String> {
    validate_shape(job)?;
    compact_from(
        job,
        store.load("ledger")?.unwrap_or_default(),
        store.load("albums")?.unwrap_or_default(),
    )
}
fn compact_from(
    job: &Job,
    mut receipts: Vec<LedgerEntry>,
    mut albums: Vec<ExistingAlbum>,
) -> Result<(Vec<LedgerEntry>, Vec<ExistingAlbum>), String> {
    validate_shape(job)?;
    if job.items.len() != job.plan.items.len() || job.albums.len() != job.plan.albums.len() {
        return Err("Inconsistent saved job retained for inspection".into());
    }
    let mut ids = std::collections::HashSet::new();

    for album in &job.albums {
        if !ids.insert(album.key.clone()) || !job.plan.albums.iter().any(|a| a.key == album.key) {
            return Err("Inconsistent album identity retained".into());
        }
        if matches!(
            album.state.as_str(),
            "creating" | "creation_outcome_unknown"
        ) {
            return Err("Album creation outcome is unknown. Dismiss this job to retain its recovery evidence.".into());
        }
        if !matches!(
            (album.state.as_str(), album.id.as_deref()),
            ("pending", None) | ("ready", Some(_))
        ) {
            return Err("Unrecognized or inconsistent album checkpoint retained; dismiss to keep recovery evidence.".into());
        }
        if let Some(id) = &album.id {
            if id.is_empty() {
                return Err("Invalid album receipt retained".into());
            }
            if !albums.iter().any(|a| {
                a.account_id == job.plan.account_id && a.key == album.key && a.album_id == *id
            }) {
                albums.push(ExistingAlbum {
                    account_id: job.plan.account_id.clone(),
                    key: album.key.clone(),
                    album_id: id.clone(),
                    title: album.title.clone(),
                });
            }
        }
    }
    ids.clear();
    for (i, p) in job.items.iter().enumerate() {
        let item = &job.plan.items[i];
        if item.id != p.id
            || !ids.insert(item.id.clone())
            || !job.albums.iter().any(|a| a.key == item.album_key)
        {
            return Err("Inconsistent photo identity retained".into());
        }
        if matches!(
            p.state.as_str(),
            "registering" | "registration_outcome_unknown"
        ) {
            return Err("A photo registration outcome is unknown. Dismiss this job to retain its recovery evidence.".into());
        }
        let rejected = engine::rejected_evidence(p);
        if let Some(media) = &p.media {
            if media.id.is_empty() {
                return Err("Incomplete media receipt retained".into());
            }
            if !rejected && !engine::resolved_receipt(p) {
                return Err("An accepted photo still needs verification. Dismiss this job so it can be recovered later.".into());
            }
            let album = job
                .albums
                .iter()
                .find(|a| a.key == item.album_key)
                .ok_or("Album receipt missing")?;
            let prepared = p.prepared.as_ref().map(|p| p.sha256.as_str());
            let existing = receipts.iter().any(|r| {
                r.account_id == job.plan.account_id
                    && r.asset_id == item.id
                    && r.media_item_id == media.id
                    && r.source_sha256 == item.source_sha256
                    && r.original_sha256 == item.original_sha256
                    && r.strip_gps == item.strip_gps
                    && r.metadata_recipe == 1
                    && r.album_key == item.album_key
                    && Some(r.album_id.as_str()) == album.id.as_deref()
                    && prepared.map_or(!r.prepared_sha256.is_empty(), |sha| {
                        r.prepared_sha256 == sha
                    })
            });
            if !existing || rejected {
                let mut receipt = engine::ledger_entry(
                    job,
                    i,
                    matches!(p.state.as_str(), "verified" | "skipped"),
                )?;
                if !rejected && receipt.prepared_sha256.is_empty() {
                    return Err("Incomplete upload fingerprint retained".into());
                }
                receipt.readback_rejected |= rejected;
                if receipt.readback_rejected {
                    receipt.readback_verified = false;
                }
                receipts.push(receipt);
            }
        } else if !matches!(
            p.state.as_str(),
            "pending"
                | "blocked"
                | "failed"
                | "aborted"
                | "preparing"
                | "uploading"
                | "uploaded_bytes"
        ) {
            return Err("An unsupported or unresolved photo checkpoint was retained".into());
        }
    }
    let rejected: std::collections::HashSet<_> = receipts
        .iter()
        .filter(|r| r.readback_rejected)
        .map(|r| (r.account_id.clone(), r.media_item_id.clone()))
        .collect();
    for r in &mut receipts {
        if rejected.contains(&(r.account_id.clone(), r.media_item_id.clone())) {
            r.readback_rejected = true;
            r.readback_verified = false;
        }
    }
    Ok((receipts, albums))
}
pub(crate) fn entries(app: &AppHandle) -> Result<Vec<Entry>, String> {
    let store = super::protected(app)?;
    let workers = crate::commands::process_runtime::active(
        crate::commands::process_runtime::Kind::GooglePhotos,
    )?;
    let mut result = Vec::new();
    // One encrypted-ledger read for the whole preview; each target contributes
    // only its own evidence. Unreadable siblings retain their original files.
    let base = store.load::<Vec<LedgerEntry>>("ledger");
    let saved_albums = store.load::<Vec<ExistingAlbum>>("albums");
    for key in store.keys("job_")? {
        let id = key.strip_prefix("job_").unwrap_or("");
        let job = match store.load::<Job>(&key) {
            Ok(Some(job)) => job,
            _ => {
                result.push(job_cleanup::entry(
                    "google",
                    id,
                    "Unreadable protected Google job",
                    "protected",
                    "",
                    &key,
                    false,
                    false,
                    "Unreadable evidence is retained; it cannot be safely cleaned",
                )?);
                continue;
            }
        };
        let valid = super::validate_id(id).is_ok() && job.plan.id == id;
        let busy = active(&job, &workers);
        let reason = if !valid {
            Some("Unsupported saved identity retained for inspection".into())
        } else if busy {
            Some("Pause/stop this worker and wait for its checkpoint before cleanup".into())
        } else {
            match (&base, &saved_albums) {
                (Ok(ledger), Ok(albums)) => compact_from(
                    &job,
                    ledger.clone().unwrap_or_default(),
                    albums.clone().unwrap_or_default(),
                )
                .err(),
                _ => {
                    Some("Protected receipt ledger is unreadable; job details were retained".into())
                }
            }
        };
        result.push(job_cleanup::entry(
            "google",
            id,
            &format!("Google Photos · {} photos", job.items.len()),
            if job.dismissed {
                "dismissed"
            } else {
                &job.status
            },
            &job.plan.created_at,
            &job,
            reason.is_none(),
            valid && !busy && validate_shape(&job).is_ok(),
            reason.as_deref().unwrap_or(
                "Detailed history can be removed; protected upload receipts are retained",
            ),
        )?);
    }
    for key in store.keys("plan_")? {
        let id = key.strip_prefix("plan_").unwrap_or("");
        if super::validate_id(id).is_err() {
            continue;
        }
        if !matches!(store.load::<Job>(&format!("job_{id}")), Ok(None)) {
            continue;
        }
        match store.load::<super::FrozenPlan>(&key) {
            Ok(Some(frozen)) => {
                let safe = frozen.plan.id == id && old_plan(&frozen.plan.created_at);
                result.push(job_cleanup::entry("google",&format!("plan:{id}"),"Unused Google publish plan","unused_plan",&frozen.plan.created_at,&frozen,safe,false,if safe{"Remove this abandoned local plan; no upload job or receipt is removed"}else{"Recent or inconsistent plan retained; unused plans become eligible after24hours"})?);
            }
            Ok(None) => {}
            Err(_) => result.push(job_cleanup::entry(
                "google",
                &format!("plan:{id}"),
                "Protected unused Google plan",
                "protected",
                "",
                &key,
                false,
                false,
                "Unreadable or redirected saved plan retained for inspection",
            )?),
        }
    }
    Ok(result)
}
fn old_plan(created: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(created)
        .map(|d| d.timestamp() <= chrono::Utc::now().timestamp() - 86400)
        .unwrap_or(false)
}
pub(super) fn apply_store(
    store: &GoogleStore,
    choice: &Choice,
    workers: &[String],
) -> Result<(), String> {
    super::validate_id(&choice.id)?;
    let mut job = super::load_job(store, &choice.id)?;
    job_cleanup::check_revision(&job, &choice.revision)?;
    if active(&job, workers) {
        return Err("Job is active; stop it and refresh cleanup".into());
    }
    if choice.action == "dismiss" {
        validate_shape(&job)?;
        job.dismissed = true;
        job.save(store)?;
        return Ok(());
    }
    if choice.action != "remove" {
        return Err("Unsupported cleanup action".into());
    }
    let (receipts, albums) = compact(store, &job)?;
    // Evidence first. Any crash/retry before detail deletion remains conservative.
    store.save("ledger", &receipts)?;
    store.save("albums", &albums)?;
    let saved: Vec<LedgerEntry> = store
        .load("ledger")?
        .ok_or("Receipt compaction was not durable")?;
    let saved_albums: Vec<ExistingAlbum> = store
        .load("albums")?
        .ok_or("Album compaction was not durable")?;
    if job_cleanup::revision(&saved)? != job_cleanup::revision(&receipts)?
        || job_cleanup::revision(&saved_albums)? != job_cleanup::revision(&albums)?
    {
        return Err("Compacted evidence did not verify; job details retained".into());
    }
    store.remove(&format!("job_{}", choice.id))?;
    Ok(())
}
pub(crate) fn apply(app: &AppHandle, choice: &Choice) -> Result<String, String> {
    let _lease = super::writer_lease(app)?;
    let store = super::protected(app)?;
    if choice.id.starts_with("plan:") {
        remove_plan_store(&store, choice)?;
        return Ok(String::new());
    }
    let workers = crate::commands::process_runtime::active(
        crate::commands::process_runtime::Kind::GooglePhotos,
    )?;
    apply_store(&store, choice, &workers)?;
    super::core_jobs::invalidate();
    if choice.action == "remove" {
        let mut warnings = Vec::new();
        if store.remove(&format!("plan_{}", choice.id)).is_err() {
            warnings.push("Detailed job removed; a saved plan could not be cleaned.");
        }
        let root = super::workspace(app)?;
        let copies = root.join("copies").join(&choice.id);
        if copies.exists() && job_cleanup::remove_owned(&root, &copies).is_err() {
            warnings
                .push("Detailed job removed; protected/redirected upload-copy data was retained.");
        }
        return Ok(warnings.join(" "));
    }
    Ok(String::new())
}

pub(super) fn remove_plan_store(store: &GoogleStore, choice: &Choice) -> Result<(), String> {
    let id = choice
        .id
        .strip_prefix("plan:")
        .ok_or("Invalid saved plan selection")?;
    super::validate_id(id)?;
    if choice.action != "remove" {
        return Err("Unused plans support removal only".into());
    }
    let frozen: super::FrozenPlan = store
        .load(&format!("plan_{id}"))?
        .ok_or("Plan no longer exists; refresh cleanup")?;
    job_cleanup::check_revision(&frozen, &choice.revision)?;
    if frozen.plan.id != id
        || !old_plan(&frozen.plan.created_at)
        || store.load::<Job>(&format!("job_{id}"))?.is_some()
    {
        return Err("Plan is recent or belongs to a saved job; retained".into());
    }
    store.remove(&format!("plan_{id}"))?;
    Ok(())
}
