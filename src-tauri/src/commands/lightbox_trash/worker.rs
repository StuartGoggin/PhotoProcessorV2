//! Durable removal state projected into existing core Jobs.
use super::{discard, history, model::*, plan, safety};
use crate::commands::{
    google_photos::{
        store::{self, GoogleStore},
        LocalUserVault,
    },
    process::ProcessJob,
    process_runtime::{self, Kind},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{AppHandle, Manager};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemovalJob {
    version: u8,
    id: String,
    created_at: String,
    started_at: Option<String>,
    finished_at: Option<String>,
    status: String,
    plan: Preview,
    states: Vec<String>,
    removed_bytes: u64,
    errors: Vec<String>,
    logs: Vec<String>,
}
impl RemovalJob {
    fn new(plan: Preview) -> Self {
        Self {
            version: 1,
            id: plan.id.clone(),
            created_at: chrono::Utc::now().to_rfc3339(),
            started_at: None,
            finished_at: None,
            status: "queued".into(),
            states: plan
                .items
                .iter()
                .map(|i| if i.included { "pending" } else { "protected" }.into())
                .collect(),
            removed_bytes: 0,
            errors: vec![],
            logs: vec![
                "Reviewed permanent removal queued; listed JPEG and CR3 originals are included."
                    .into(),
            ],
            plan,
        }
    }
    fn save(&self, store: &GoogleStore) -> Result<(), String> {
        store.save(&self.id, self)
    }
    fn log(&mut self, text: String) {
        self.logs.push(text);
        if self.logs.len() > 200 {
            self.logs.remove(0);
        }
    }
}
pub fn is_job(id: &str) -> bool {
    id.strip_prefix("trash_")
        .is_some_and(|s| s.len() == 48 && s.bytes().all(|b| b.is_ascii_hexdigit()))
}
fn validate(j: &RemovalJob) -> Result<(), String> {
    if j.version != 1
        || !is_job(&j.id)
        || j.id != j.plan.id
        || j.states.len() != j.plan.items.len()
        || j.plan.items.len() > 100_000
    {
        return Err("Saved removal job is invalid; preserve its evidence".into());
    }
    let root = safety::root(&j.plan.staging_dir)?;
    let mut seen = HashSet::new();
    for i in &j.plan.items {
        safety::scoped(&root, &i.relative_path, false)?;
        safety::scoped(&root, &i.capture_path, false)?;
        if !["camera_jpeg", "camera_raw", "generated", "sidecar"].contains(&i.kind.as_str())
            || !seen.insert(i.relative_path.to_lowercase())
        {
            return Err("Saved removal membership is invalid".into());
        }
        if i.included
            && (i.identity.is_none()
                || i.sha256.as_ref().is_none_or(|s| s.len() != 64)
                || i.md5.as_ref().is_none_or(|s| s.len() != 32))
        {
            return Err("Saved removal fingerprint is incomplete".into());
        }
    }
    Ok(())
}
fn workspace(app: &AppHandle) -> Result<PathBuf, String> {
    let p = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("trash-jobs-v1");
    fs::create_dir_all(&p).map_err(|e| e.to_string())?;
    store::reject_link(&p)?;
    p.canonicalize().map_err(|e| e.to_string())
}
fn protected(app: &AppHandle) -> Result<GoogleStore, String> {
    GoogleStore::new(workspace(app)?.join("protected"), Arc::new(LocalUserVault))
}
fn load(store: &GoogleStore, id: &str) -> Result<RemovalJob, String> {
    if !is_job(id) {
        return Err("Invalid removal job reference".into());
    }
    let j = store.load(id)?.ok_or("Saved removal job is unavailable")?;
    validate(&j)?;
    Ok(j)
}
fn project(j: &RemovalJob, active: bool) -> Result<ProcessJob, String> {
    let status = if ["running", "queued"].contains(&j.status.as_str()) && !active {
        "needs_attention"
    } else {
        &j.status
    };
    let done = j
        .states
        .iter()
        .filter(|s| {
            ["removed", "absent", "reconciled", "protected", "failed"].contains(&s.as_str())
        })
        .count();
    let removed = j.states.iter().filter(|s| s.as_str() == "removed").count();
    let attention = j
        .states
        .iter()
        .filter(|s| ["protected", "failed"].contains(&s.as_str()))
        .count();
    let phase = format!(
        "{removed} removed · {attention} protected/failed · {} confirmed file bytes removed",
        j.removed_bytes
    );
    let mut p:ProcessJob=serde_json::from_value(serde_json::json!({"id":j.id,"task":"takeOutTrash","stagingDir":j.plan.staging_dir,
 "scopeDir":if j.plan.relative_dir.is_empty(){j.plan.staging_dir.clone()}else{Path::new(&j.plan.staging_dir).join(&j.plan.relative_dir).to_string_lossy().into_owned()},
 "scopeMode":if j.plan.recursive{"folderRecursive"}else{"folderOnly"},"status":status,"createdAt":j.created_at,"startedAt":j.started_at,"finishedAt":j.finished_at,
 "total":j.states.len(),"done":done,"processed":done,"resultCount":removed,"currentFile":"","currentPhase":phase,"statusLine":phase,"errors":j.errors,"logs":j.logs,"pauseRequested":false,"abortRequested":false,"canContinue":true})).map_err(|e|e.to_string())?;
    if status == "needs_attention" {
        p.control_blocked_reason = Some(
            "Review saved removal diagnostics, then Retry only the originally approved files."
                .into(),
        )
    }
    Ok(p)
}
fn protect_group(
    store: &GoogleStore,
    j: &mut RemovalJob,
    indices: &[usize],
    reason: String,
) -> Result<(), String> {
    for &n in indices {
        if !["removed", "reconciled", "intent"].contains(&j.states[n].as_str()) {
            j.states[n] = "protected".into()
        }
    }
    j.errors.push(reason);
    j.save(store)
}
fn membership_unchanged(root: &Path, folder: &Path, j: &RemovalJob) -> Result<bool, String> {
    let key = folder
        .strip_prefix(root)
        .map_err(|_| "Removal folder outside staging")?
        .to_string_lossy()
        .replace('\\', "/");
    let mut expected = j
        .plan
        .folder_membership
        .get(&key)
        .ok_or("Removal membership evidence missing; create a fresh preview")?
        .clone();
    for (item, state) in j.plan.items.iter().zip(&j.states) {
        if ["removed", "reconciled"].contains(&state.as_str())
            && Path::new(&item.relative_path).parent() == Some(Path::new(&key))
        {
            if let Some(name) = Path::new(&item.relative_path).file_name() {
                expected.retain(|n| n != &name.to_string_lossy());
            }
        }
    }
    Ok(expected == plan::folder_membership(folder)?)
}
fn execute(
    store: &GoogleStore,
    j: &mut RemovalJob,
    stop: &dyn Fn(usize) -> (bool, bool),
) -> Result<(), String> {
    validate(j)?;
    let root = safety::root(&j.plan.staging_dir)?;
    // A corrupt discard ledger must stop before even a derivative is removed.
    discard::load_index(&root)?;
    j.status = "running".into();
    j.started_at
        .get_or_insert_with(|| chrono::Utc::now().to_rfc3339());
    j.save(store)?;
    let captures = j
        .plan
        .items
        .iter()
        .filter(|i| i.included)
        .map(|i| i.capture_path.clone())
        .collect::<BTreeSet<_>>();
    let mut boundaries = 0;
    for capture in captures {
        let (stopping, abort) = stop(boundaries);
        if stopping {
            j.status = if abort { "aborted" } else { "paused" }.into();
            j.save(store)?;
            return Ok(());
        }
        let indices = (0..j.plan.items.len())
            .filter(|&n| j.plan.items[n].included && j.plan.items[n].capture_path == capture)
            .collect::<Vec<_>>();
        if indices
            .iter()
            .all(|&n| ["removed", "absent", "reconciled"].contains(&j.states[n].as_str()))
        {
            continue;
        }
        let path = safety::scoped(&root, &capture, false)?;
        let folder = path.parent().ok_or("Capture parent missing")?;
        let access = safety::Access::acquire(folder, true);
        let raw_lease = if access.is_ok() {
            Some(crate::commands::raw_development::worker::FolderLease::acquire(folder))
        } else {
            None
        };
        let admitted = access.is_ok() && raw_lease.as_ref().is_some_and(Result::is_ok);
        let originals = indices
            .iter()
            .copied()
            .filter(|&n| j.plan.items[n].kind.starts_with("camera_"))
            .collect::<Vec<_>>();
        let identities = originals
            .iter()
            .filter_map(|&n| j.plan.items[n].identity.clone())
            .collect::<Vec<_>>();
        if admitted {
            // Settle a saved unlink intent before checking siblings. Losing this
            // fact on a later protected sibling would make recovery impossible.
            for &n in &indices {
                if j.states[n] == "intent"
                    && !safety::scoped(&root, &j.plan.items[n].relative_path, false)?.exists()
                {
                    discard::record(&root, &j.id, &j.plan.items[n], "reconciled")?;
                    j.states[n] = "reconciled".into();
                    j.save(store)?;
                }
            }
            if indices
                .iter()
                .any(|&n| ["removed", "reconciled"].contains(&j.states[n].as_str()))
            {
                let targets = history::removal_begin(&root, &identities)?;
                history::removal_end(&root, targets, true)?;
            }
        }
        if history::restored_since(&root, &identities, j.plan.review_revision)? {
            protect_group(store, j, &indices, format!("Protected {capture}: review decision changed after the removal preview. Create a fresh preview."))?;
            continue;
        }
        let partial = indices
            .iter()
            .any(|&n| ["removed", "reconciled", "intent"].contains(&j.states[n].as_str()));
        let marked = originals.iter().any(|&n| {
            j.plan.items[n]
                .relative_path
                .to_lowercase()
                .contains("{trash}")
                && safety::scoped(&root, &j.plan.items[n].relative_path, false)
                    .is_ok_and(|p| p.is_file())
        });
        if !admitted || (!marked && !partial) || !membership_unchanged(&root, folder, j)? {
            protect_group(
                store,
                j,
                &indices,
                format!(
                    "Protected {capture}: restored, missing, in use, or folder membership changed. Camera originals retained; create a fresh preview if files changed."
                ),
            )?;
            continue;
        }
        // Pin every remaining member before the first removal; all hashes are from these handles.
        let mut handles = vec![];
        let mut failure = None;
        for &n in &indices {
            if ["removed", "reconciled", "absent"].contains(&j.states[n].as_str()) {
                continue;
            }
            let item = &j.plan.items[n];
            let p = safety::scoped(&root, &item.relative_path, false)?;
            if !p.exists() {
                if j.states[n] == "intent" {
                    handles.push((n, None));
                    continue;
                }
                failure = Some(format!("{} disappeared after review", item.relative_path));
                break;
            }
            let held =
                safety::MediaFile::open(&root, &item.relative_path, true).and_then(|mut h| {
                    let identity = safety::id(&h.file)?;
                    let (md5, sha) = safety::hash(&mut h.file)?;
                    if !item
                        .identity
                        .as_ref()
                        .is_some_and(|id| safety::same(id, &identity))
                        || item.md5.as_deref() != Some(&md5)
                        || item.sha256.as_deref() != Some(&sha)
                    {
                        return Err("Fingerprint changed after the approved preview".into());
                    }
                    Ok(h)
                });
            match held {
                Ok(h) => handles.push((n, Some(h))),
                Err(e) => {
                    failure = Some(format!("{}: {e}", item.relative_path));
                    break;
                }
            }
        }
        if let Some(error) = failure {
            drop(handles);
            protect_group(store, j, &indices, error)?;
            continue;
        }
        let identities = originals
            .iter()
            .filter_map(|&n| j.plan.items[n].identity.clone())
            .collect::<Vec<_>>();
        let targets = history::removal_begin(&root, &identities)?;
        let mut any_removed = indices
            .iter()
            .any(|&n| ["removed", "reconciled"].contains(&j.states[n].as_str()));
        for (n, held) in handles {
            let (stopping, abort) = stop(boundaries);
            if stopping {
                history::removal_end(&root, targets.clone(), any_removed)?;
                j.status = if abort { "aborted" } else { "paused" }.into();
                j.save(store)?;
                return Ok(());
            }
            let item = j.plan.items[n].clone();
            if item.kind.starts_with("camera_") && !membership_unchanged(&root, folder, j)? {
                protect_group(store,j,&indices,"Folder changed during removal; remaining originals retained. Create a fresh preview.".into())?;
                break;
            }
            if held.is_none() {
                discard::record(&root, &j.id, &item, "reconciled")?;
                j.states[n] = "reconciled".into();
                any_removed = true;
                j.log(format!(
                    "Reconciled absent after saved intent: {}; removed-byte count unchanged",
                    item.relative_path
                ));
                j.save(store)?;
                boundaries += 1;
                continue;
            }
            j.states[n] = "intent".into();
            j.save(store)?;
            discard::record(&root, &j.id, &item, "intent")?;
            match held.unwrap().remove() {
                Ok(()) => {
                    discard::record(&root, &j.id, &item, "removed")?;
                    j.states[n] = "removed".into();
                    j.removed_bytes = j.removed_bytes.saturating_add(item.bytes);
                    any_removed = true;
                    j.log(format!(
                        "Removed {} ({} file bytes)",
                        item.relative_path, item.bytes
                    ));
                    j.save(store)?;
                }
                Err(e) => {
                    j.states[n] = "failed".into();
                    j.errors.push(format!(
                        "{}: {e}; remaining camera originals retained",
                        item.relative_path
                    ));
                    j.save(store)?;
                    break;
                }
            }
            boundaries += 1;
        }
        history::removal_end(&root, targets, any_removed)?;
    }
    j.status = if j.states.iter().zip(&j.plan.items).any(|(s, i)| {
        i.included && ["protected", "failed", "intent", "pending"].contains(&s.as_str())
    }) {
        "needs_attention"
    } else {
        if j.plan.items.iter().any(|i| !i.included) {
            "completed_with_warnings"
        } else {
            "completed"
        }
    }
    .into();
    j.finished_at = Some(chrono::Utc::now().to_rfc3339());
    j.save(store)
}
pub fn snapshot(app: &AppHandle) -> Result<(Vec<ProcessJob>, Vec<String>), String> {
    let store = protected(app)?;
    let active = process_runtime::active(Kind::TakeOutTrash)?;
    let mut jobs = vec![];
    let mut warnings = vec![];
    for id in store.keys("trash_")? {
        match load(&store,&id).and_then(|j|project(&j,active.contains(&id))){Ok(j)=>jobs.push(j),Err(_)=>warnings.push("A saved removal job could not be read; journal and discard evidence were retained.".into())}
    }
    Ok((jobs, warnings))
}
fn spawn(app: AppHandle, mut job: RemovalJob) -> Result<(), String> {
    let dir = workspace(&app)?;
    let worker = safety::metadata_lock(&dir, "worker.lock")?;
    let root = safety::root(&job.plan.staging_dir)?;
    let imports = crate::commands::import_sessions::exclusive_maintenance(&root)?;
    let uploads = crate::commands::google_photos::event_naming_lease(&app)?;
    let lease = process_runtime::register(Kind::TakeOutTrash, &job.id)?;
    let store = protected(&app)?;
    job.status = "queued".into();
    job.save(&store)?;
    let id = job.id.clone();
    std::thread::Builder::new()
        .name("photogogo-take-out-trash".into())
        .spawn(move || {
            let _guards = (worker, imports, uploads, lease);
            if let Err(error) = execute(&store, &mut job, &|_| process_runtime::stop_state(&id)) {
                job.status = "needs_attention".into();
                job.errors.push(error);
                let _ = job.save(&store);
            }
        })
        .map_err(|_| "Removal worker could not start; saved job retained")?;
    Ok(())
}
pub fn start(app: AppHandle, id: &str, acknowledged: bool) -> Result<ProcessJob, String> {
    if !acknowledged {
        return Err("Review and confirm permanent JPEG + CR3 removal first".into());
    }
    let plan = plan::take(id)?;
    if !plan.can_start {
        return Err("No safely removable capture selected".into());
    }
    let job = RemovalJob::new(plan);
    job.save(&protected(&app)?)?;
    if let Err(error) = spawn(app.clone(), job.clone()) {
        let mut saved = load(&protected(&app)?, &job.id)?;
        saved.status = "needs_attention".into();
        saved.errors.push(format!(
            "Could not start: {error}. No new removal was admitted."
        ));
        saved.save(&protected(&app)?)?;
        return project(&saved, false);
    }
    project(&job, true)
}
pub fn control(app: AppHandle, id: &str, action: &str) -> Result<bool, String> {
    let store = protected(&app)?;
    let mut job = load(&store, id)?;
    if ["pause", "abort"].contains(&action) {
        if process_runtime::request_stop(id, action == "abort")? {
            return Ok(true);
        }
        job.status = if action == "abort" {
            "aborted"
        } else {
            "paused"
        }
        .into();
        job.save(&store)?;
        return Ok(true);
    }
    if ["resume", "retry"].contains(&action) {
        if process_runtime::active(Kind::TakeOutTrash)?.contains(&id.to_string()) {
            return Err("This removal job is already active".into());
        }
        job.errors.clear();
        for state in &mut job.states {
            if ["protected", "failed"].contains(&state.as_str()) {
                *state = "pending".into()
            }
        }
        spawn(app, job)?;
        return Ok(true);
    }
    Err("Unsupported removal job action".into())
}
pub fn diagnostics(app: &AppHandle, id: &str) -> Result<String, String> {
    let j = load(&protected(app)?, id)?;
    Ok(format!(
        "Take out the trash {}\nStatus: {}\nConfirmed removed file bytes: {}\n{}\n{}",
        j.id,
        j.status,
        j.removed_bytes,
        j.plan
            .items
            .iter()
            .zip(&j.states)
            .map(|(i, s)| format!("{s}: {} ({})", i.relative_path, i.kind))
            .collect::<Vec<_>>()
            .join("\n"),
        j.errors.join("\n")
    ))
}
fn cleanable(j: &RemovalJob, active: bool) -> bool {
    crate::commands::job_cleanup::terminal(&j.status)
        && !active
        && !j.states.iter().any(|s| s == "intent")
}
pub(crate) fn cleanup_entries(
    app: &AppHandle,
) -> Result<Vec<crate::commands::job_cleanup::Entry>, String> {
    let store = protected(app)?;
    let active = process_runtime::active(Kind::TakeOutTrash)?;
    store.keys("trash_")?.into_iter().map(|id|{let j=load(&store,&id)?;let safe=cleanable(&j,active.contains(&id));
        crate::commands::job_cleanup::entry("trash",&id,"Take out the trash",&j.status,&j.created_at,&j,safe,false,if safe{"Remove job details only; review history and verified discard receipts remain in staging"}else{"Active work or an unresolved file-removal intent protects this job; Retry recovery first"})}).collect()
}
pub(crate) fn cleanup_apply(
    app: &AppHandle,
    c: &crate::commands::job_cleanup::Choice,
) -> Result<String, String> {
    if c.action != "remove" {
        return Err("Removal history supports removing finished details only".into());
    }
    let _worker = safety::metadata_lock(&workspace(app)?, "worker.lock")?;
    let store = protected(app)?;
    let j = load(&store, &c.id)?;
    crate::commands::job_cleanup::check_revision(&j, &c.revision)?;
    if !cleanable(
        &j,
        process_runtime::active(Kind::TakeOutTrash)?.contains(&j.id),
    ) {
        return Err("Removal work or unresolved intent is protected".into());
    }
    let root = safety::root(&j.plan.staging_dir)?;
    let captures = j
        .plan
        .items
        .iter()
        .filter(|i| i.included)
        .map(|i| i.capture_path.clone())
        .collect::<BTreeSet<_>>();
    for capture in captures {
        let path = safety::scoped(&root, &capture, false)?;
        let _access =
            safety::Access::acquire(path.parent().ok_or("Capture parent missing")?, true)?;
        let members = j
            .plan
            .items
            .iter()
            .zip(&j.states)
            .filter(|(i, _)| i.capture_path == capture)
            .collect::<Vec<_>>();
        let ids = members
            .iter()
            .filter(|(i, _)| i.kind.starts_with("camera_"))
            .filter_map(|(i, _)| i.identity.clone())
            .collect::<Vec<_>>();
        let targets = history::removal_begin(&root, &ids)?;
        history::removal_end(
            &root,
            targets,
            members
                .iter()
                .any(|(_, s)| ["removed", "reconciled"].contains(&s.as_str())),
        )?;
    }
    store.remove(&j.id)?;
    Ok(String::new())
}
pub(crate) fn clear_finished(app: &AppHandle) -> Result<usize, String> {
    let entries = cleanup_entries(app)?;
    let mut count = 0;
    for e in entries.into_iter().filter(|e| {
        e.can_remove && ["completed", "completed_with_warnings"].contains(&e.status.as_str())
    }) {
        cleanup_apply(
            app,
            &crate::commands::job_cleanup::Choice {
                kind: e.kind,
                id: e.id,
                revision: e.revision,
                action: "remove".into(),
            },
        )?;
        count += 1;
    }
    Ok(count)
}
#[cfg(test)]
pub(crate) fn delete_test_seam(root: &Path, name: &str) -> Result<(), String> {
    let root = safety::root(&root.to_string_lossy())?;
    safety::MediaFile::open(&root, name, true)?.remove()
}
#[cfg(test)]
mod recovery_tests {
    use super::*;
    struct Plain;
    impl store::Sealer for Plain {
        fn seal(&self, b: &[u8]) -> Result<Vec<u8>, String> {
            Ok(b.to_vec())
        }
        fn open(&self, b: &[u8]) -> Result<Vec<u8>, String> {
            Ok(b.to_vec())
        }
    }
    struct Work(PathBuf);
    impl Work {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "photogogo-trash-worker-{}",
                plan::new_id().unwrap()
            ));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn job(&self) -> RemovalJob {
            fs::write(self.0.join("a{trash}.jpg"), b"original").unwrap();
            fs::write(self.0.join("a_BW.jpg"), b"derivative").unwrap();
            RemovalJob::new(plan::build(&self.0.to_string_lossy(), "", false).unwrap())
        }
        fn store(&self) -> GoogleStore {
            GoogleStore::new(self.0.join("jobs"), Arc::new(Plain)).unwrap()
        }
    }
    impl Drop for Work {
        fn drop(&mut self) {
            assert!(self
                .0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("photogogo-trash-worker-"));
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn durable_projection_survives_restart_and_cancel_resume() {
        let f = Work::new();
        let mut j = f.job();
        let store = f.store();
        j.save(&store).unwrap();
        let projected = project(&load(&store, &j.id).unwrap(), false).unwrap();
        let v = serde_json::to_value(projected).unwrap();
        assert_eq!(v["task"], "takeOutTrash");
        assert_eq!(v["status"], "needs_attention");
        execute(&store, &mut j, &|n| (n >= 1, false)).unwrap();
        assert_eq!(j.status, "paused");
        let mut resumed = load(&store, &j.id).unwrap();
        execute(&store, &mut resumed, &|_| (false, false)).unwrap();
        assert_eq!(resumed.status, "completed");
        assert!(!f.0.join("a{trash}.jpg").exists());
        assert!(cleanable(&resumed, false));
    }
    #[test]
    fn interrupted_unlink_then_changed_sibling_retains_reconciled_intent() {
        let f = Work::new();
        let mut j = f.job();
        let store = f.store();
        let n = j
            .plan
            .items
            .iter()
            .position(|i| i.kind == "generated")
            .unwrap();
        j.states[n] = "intent".into();
        j.save(&store).unwrap();
        fs::remove_file(f.0.join(&j.plan.items[n].relative_path)).unwrap();
        fs::write(f.0.join("a{trash}.jpg"), b"changed original").unwrap();
        execute(&store, &mut j, &|_| (false, false)).unwrap();
        assert_eq!(j.states[n], "reconciled");
        assert_eq!(j.removed_bytes, 0);
        assert_eq!(j.status, "needs_attention");
        let mut again = load(&store, &j.id).unwrap();
        execute(&store, &mut again, &|_| (false, false)).unwrap();
        assert_eq!(again.states[n], "reconciled");
        assert!(f.0.join("a{trash}.jpg").exists());
        assert!(cleanable(&again, false));
    }
    #[test]
    fn failed_intent_persistence_stops_before_any_unlink() {
        struct Failing;
        impl store::Sealer for Failing {
            fn seal(&self, b: &[u8]) -> Result<Vec<u8>, String> {
                let v: serde_json::Value = serde_json::from_slice(b).unwrap();
                if v["states"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|v| v == "intent")
                {
                    Err("synthetic disk full at intent".into())
                } else {
                    Ok(b.to_vec())
                }
            }
            fn open(&self, b: &[u8]) -> Result<Vec<u8>, String> {
                Ok(b.to_vec())
            }
        }
        let f = Work::new();
        let mut j = f.job();
        let store = GoogleStore::new(f.0.join("jobs"), Arc::new(Failing)).unwrap();
        assert!(execute(&store, &mut j, &|_| (false, false)).is_err());
        assert!(f.0.join("a{trash}.jpg").exists());
        assert!(f.0.join("a_BW.jpg").exists());
        assert_eq!(j.removed_bytes, 0);
    }
}
#[cfg(test)]
pub(crate) fn run_synthetic(
    plan: Preview,
    stop_after: Option<usize>,
) -> Result<Vec<String>, String> {
    struct Plain;
    impl store::Sealer for Plain {
        fn seal(&self, b: &[u8]) -> Result<Vec<u8>, String> {
            Ok(b.to_vec())
        }
        fn open(&self, b: &[u8]) -> Result<Vec<u8>, String> {
            Ok(b.to_vec())
        }
    }
    let root = safety::root(&plan.staging_dir)?;
    let store = GoogleStore::new(root.join(".synthetic-removal-jobs"), Arc::new(Plain))?;
    let mut j = RemovalJob::new(plan);
    j.save(&store)?;
    execute(&store, &mut j, &|n| {
        (stop_after.is_some_and(|value| n >= value), false)
    })?;
    Ok(load(&store, &j.id)?.states)
}
