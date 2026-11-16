//! One cleanup interface; executors retain ownership of their safety evidence.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub status: String,
    pub created_at: String,
    pub revision: String,
    pub can_remove: bool,
    pub can_dismiss: bool,
    pub reason: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Choice {
    pub kind: String,
    pub id: String,
    pub revision: String,
    pub action: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub entries: Vec<Entry>,
    pub warnings: Vec<String>,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultSummary {
    pub removed: usize,
    pub dismissed: usize,
    pub protected: usize,
    pub failed: usize,
    pub messages: Vec<String>,
}
pub(crate) fn revision(value: &impl Serialize) -> Result<String, String> {
    Ok(hex::encode(Sha256::digest(
        serde_json::to_vec(value).map_err(|_| "Job cannot be inspected")?,
    )))
}
pub(crate) fn entry(
    kind: &str,
    id: &str,
    title: &str,
    status: &str,
    created: &str,
    value: &impl Serialize,
    can_remove: bool,
    can_dismiss: bool,
    reason: &str,
) -> Result<Entry, String> {
    Ok(Entry {
        kind: kind.into(),
        id: id.into(),
        title: title.into(),
        status: status.into(),
        created_at: created.into(),
        revision: revision(value)?,
        can_remove,
        can_dismiss,
        reason: reason.into(),
    })
}
pub(crate) fn check_revision(value: &impl Serialize, expected: &str) -> Result<(), String> {
    if revision(value)? != expected {
        Err("This job changed after review. Refresh the cleanup preview.".into())
    } else {
        Ok(())
    }
}
pub(crate) fn terminal(status: &str) -> bool {
    matches!(
        status,
        "completed"
            | "completed_with_warnings"
            | "failed"
            | "aborted"
            | "cancelled"
            | "interrupted"
            | "retried"
            | "needs_attention"
    )
}
/// Validate every component before descending. Never follow a reparse/link entry
/// or derive an app-owned deletion path from a saved media/prepared path.
pub(crate) fn remove_owned(root: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    use std::{fs, path::Component};
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "Cleanup target is outside application job data")?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("Unsafe cleanup target".into());
    }
    super::google_photos::store::reject_link(root)?;
    #[cfg(windows)]
    fn guard_dir(path: &std::path::Path) -> Result<std::fs::File, String> {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        let file = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(1)
            .custom_flags(0x02000000 | 0x00200000)
            .open(path)
            .map_err(|_| "Cannot lock owned job directory for safe cleanup")?;
        let meta = file
            .metadata()
            .map_err(|_| "Cannot inspect owned job directory")?;
        if !meta.is_dir() || meta.file_attributes() & 0x400 != 0 {
            return Err("Redirected job directory retained".into());
        }
        Ok(file)
    }
    #[cfg(windows)]
    let mut parents = vec![guard_dir(root)?];
    let mut current = root.to_path_buf();
    for part in relative.components() {
        current.push(part);
        if !current.exists() {
            return Ok(());
        }
        super::google_photos::store::reject_link(&current)?;
        #[cfg(windows)]
        if current != target && current.is_dir() {
            parents.push(guard_dir(&current)?);
        }
    }
    fn remove(path: &std::path::Path) -> Result<(), String> {
        let meta = std::fs::symlink_metadata(path).map_err(|_| "Cannot inspect owned job data")?;
        super::google_photos::store::reject_link(path)?;
        if meta.is_dir() {
            #[cfg(not(windows))]
            {
                return Err(
                    "Safe recursive job cleanup requires the Windows directory guard".into(),
                );
            }
            #[cfg(windows)]
            {
                let guard = guard_dir(path)?;
                for child in std::fs::read_dir(path).map_err(|_| "Cannot list owned job data")? {
                    remove(&child.map_err(|_| "Cannot inspect owned job data")?.path())?;
                }
                drop(guard);
                std::fs::remove_dir(path).map_err(|_| "Cannot remove owned job directory".into())
            }
        } else if meta.is_file() {
            std::fs::remove_file(path).map_err(|_| "Cannot remove owned job file".into())
        } else {
            Err("Unsupported job-data entry retained".into())
        }
    }
    // Parent paths have been validated inside the fixed application data root.
    let _ = fs::metadata(root).map_err(|_| "Application job data is unavailable")?;
    remove(target)
}
fn collect(app: &AppHandle) -> Result<Preview, String> {
    let mut entries = super::import::cleanup_entries()?;
    entries.extend(super::process::cleanup_entries()?);
    entries.extend(super::video_studio::cleanup_entries()?);
    let mut warnings = Vec::new();
    match super::lightbox_trash::worker::cleanup_entries(app){Ok(mut trash)=>entries.append(&mut trash),Err(_)=>warnings.push("Saved removal jobs could not be inspected; their evidence remains protected.".into())}
    match super::google_photos::cleanup_entries(&app){Ok(mut cloud)=>entries.append(&mut cloud),Err(_)=>warnings.push("Google saved jobs could not be inspected. Those records remain protected; other job types are available.".into())}
    entries.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(Preview { entries, warnings })
}
#[tauri::command]
pub async fn job_cleanup_preview(app: AppHandle) -> Result<Preview, String> {
    tauri::async_runtime::spawn_blocking(move || collect(&app))
        .await
        .map_err(|_| "Job cleanup preview failed")?
}
#[tauri::command]
pub async fn job_cleanup_apply(
    app: AppHandle,
    choices: Vec<Choice>,
    acknowledged: bool,
) -> Result<ResultSummary, String> {
    if !acknowledged || choices.is_empty() || choices.len() > 1000 {
        return Err("Review and confirm 1 to 1000 selected jobs.".into());
    }
    let mut seen = std::collections::HashSet::new();
    for c in &choices {
        if c.id.len() > 160
            || c.revision.len() != 64
            || !matches!(c.action.as_str(), "remove" | "dismiss")
            || !seen.insert((c.kind.clone(), c.id.clone()))
        {
            return Err("Invalid or repeated cleanup choice".into());
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        static GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _gate = GATE
            .try_lock()
            .map_err(|_| "Another cleanup is in progress")?;
        let mut result = ResultSummary::default();
        let fresh = collect(&app)?;
        for c in choices {
            let eligible = fresh
                .entries
                .iter()
                .find(|e| e.kind == c.kind && e.id == c.id);
            if !eligible.is_some_and(|e| {
                e.revision == c.revision
                    && if c.action == "remove" {
                        e.can_remove
                    } else {
                        e.can_dismiss
                    }
            }) {
                result.protected += 1;
                result.messages.push(format!(
                    "{} job was protected or changed after review; refresh the cleanup preview.",
                    c.kind
                ));
                continue;
            }
            let outcome = match c.kind.as_str() {
                "google" => super::google_photos::cleanup_apply(&app, &c),
                "trash" => super::lightbox_trash::worker::cleanup_apply(&app, &c),
                "import" => super::import::cleanup_apply(&c),
                "process" => super::process::cleanup_apply(&c),
                "studio" => super::video_studio::cleanup_apply(&c),
                _ => Err("Unsupported job type retained".into()),
            };
            match outcome {
                Ok(note) => {
                    if c.action == "dismiss" {
                        result.dismissed += 1
                    } else {
                        result.removed += 1
                    }
                    if !note.is_empty() {
                        result.messages.push(note)
                    }
                }
                Err(error) => {
                    result.failed += 1;
                    result.messages.push(format!("{} job: {}", c.kind, error));
                }
            }
        }
        Ok(result)
    })
    .await
    .map_err(|_| "Job cleanup failed; refresh the preview before retrying")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cleanup_owned_directory_never_removes_root_or_outside_file() {
        let base = std::env::temp_dir().join(format!(
            "photogogo-cleanup-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap()
        ));
        let root = base.join("owned");
        std::fs::create_dir_all(root.join("job/nested")).unwrap();
        std::fs::write(root.join("job/nested/log"), b"log").unwrap();
        let original = base.join("original.jpg");
        std::fs::write(&original, b"original").unwrap();
        assert!(remove_owned(&root, &original).is_err());
        assert!(remove_owned(&root, &root).is_err());
        remove_owned(&root, &root.join("job")).unwrap();
        assert_eq!(std::fs::read(&original).unwrap(), b"original");
        assert!(root.exists());
        std::fs::remove_dir_all(base).unwrap();
    }
}
