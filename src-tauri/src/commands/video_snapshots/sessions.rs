//! Per-account session metadata, never media. All mutations use opaque IDs,
//! a cross-process lock and compare-and-swap revisions. Portable files are
//! imported by copying their JSON; this store never writes their original path.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::Manager;

const MAX_JSON: usize = 2 * 1024 * 1024;
const MAX_RECORD: usize = 4 * MAX_JSON;
const MAX_SESSIONS: usize = 2000;
const MAX_REVISION: u64 = 9_007_199_254_740_990;
static SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    schema_version: u32,
    id: String,
    name: String,
    revision: u64,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
    json: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    id: String,
    name: String,
    revision: u64,
    created_at: String,
    updated_at: String,
    deleted_at: Option<String>,
    source_count: usize,
    photo_count: usize,
    recovered: bool,
}
#[derive(Serialize)]
pub struct SessionDocument {
    #[serde(flatten)]
    summary: SessionSummary,
    json: String,
}
#[derive(Serialize)]
pub struct SessionList {
    sessions: Vec<SessionSummary>,
    warnings: Vec<String>,
}

fn string<'a>(v: &'a Value, max: usize, empty: bool) -> Result<&'a str, String> {
    let s = v.as_str().ok_or("Session text has an invalid type.")?;
    if s.encode_utf16().count() > max
        || (!empty && s.trim().is_empty())
        || s.chars().any(char::is_control)
    {
        return Err("Session text is empty, too long or contains control characters.".into());
    }
    Ok(s)
}
fn absolute(v: &Value, empty: bool) -> Result<&str, String> {
    let p = string(v, 32767, empty)?;
    if (empty && p.is_empty())
        || p.starts_with('/')
        || p.starts_with("\\\\")
        || (p.as_bytes().get(1) == Some(&b':')
            && p.as_bytes().first().is_some_and(u8::is_ascii_alphabetic)
            && matches!(p.as_bytes().get(2), Some(b'\\' | b'/')))
    {
        return Ok(p);
    }
    Err("Session paths must be absolute local paths.".into())
}
fn path_key(p: &str) -> String {
    let p = p.replace('/', "\\").to_lowercase();
    if let Some(unc) = p.strip_prefix("\\\\?\\unc\\") {
        format!("\\\\{unc}")
    } else {
        p.strip_prefix("\\\\?\\").unwrap_or(&p).to_string()
    }
}
fn integer(v: &Value, max: u64) -> Result<u64, String> {
    v.as_u64()
        .filter(|n| *n <= max)
        .ok_or("Session number is outside its supported range.".into())
}
fn decimal(v: &Value, min: f64, max: f64) -> Result<f64, String> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= min && *n <= max)
        .ok_or("Session adjustment is outside its supported range.".into())
}
fn recipe(v: &Value) -> Result<(), String> {
    decimal(&v["brightness"], -0.5, 0.5)?;
    decimal(&v["contrast"], -50.0, 50.0)?;
    decimal(&v["sharpness"], 0.0, 2.0)?;
    let c = v.get("crop").ok_or("Missing session crop.")?;
    if !c.is_null() {
        let x = decimal(&c["x"], 0.0, 1.0)?;
        let y = decimal(&c["y"], 0.0, 1.0)?;
        let w = decimal(&c["width"], 0.01, 1.0)?;
        let h = decimal(&c["height"], 0.01, 1.0)?;
        if x + w > 1.000001 || y + h > 1.000001 {
            return Err("Session crop extends outside the photo.".into());
        }
    }
    Ok(())
}

/// Validate before writing and again before trusting disk metadata. References
/// may be unavailable; validation deliberately does not open videos or exports.
fn validate_payload(json: &str) -> Result<(usize, usize), String> {
    if json.len() > MAX_JSON {
        return Err("Session exceeds the 2 MiB limit.".into());
    }
    let root: Value = serde_json::from_str(json).map_err(|_| "Session JSON is invalid.")?;
    if root["kind"] != "photogogo-video-snapshots" || root["version"] != 1 {
        return Err("Unsupported Video Snapshots session.".into());
    }
    let sources = root["sources"]
        .as_array()
        .ok_or("Missing session videos.")?;
    let photos = root["selections"]
        .as_array()
        .ok_or("Missing session photo selections.")?;
    if sources.len() > 64 || photos.len() > 200 {
        return Err("A session supports 64 videos and 200 photos.".into());
    }
    let mut paths = HashSet::new();
    let mut identities = HashSet::new();
    for s in sources {
        let path = absolute(&s["path"], false)?;
        if !paths.insert(path_key(path)) {
            return Err("Duplicate video in session.".into());
        }
        let identity = string(&s["identity"], 512, false)?;
        identities.insert((path.to_string(), identity.to_string()));
        let start = string(&s["shootingStart"], 40, true)?;
        let confirmed = s["timeConfirmed"]
            .as_bool()
            .ok_or("Invalid time confirmation.")?;
        if confirmed && chrono::DateTime::parse_from_rfc3339(start).is_err() {
            return Err("Confirmed shooting time must include a valid date and UTC offset.".into());
        }
        integer(&s["position"], 10_000_000)?;
    }
    if let Some(pending) = root.get("pendingPaths") {
        for p in pending.as_array().ok_or("Invalid pending videos.")? {
            if !paths.insert(path_key(absolute(p, false)?)) {
                return Err("Duplicate pending video in session.".into());
            }
        }
    }
    if paths.len() > 64 {
        return Err("A session supports up to 64 videos, including pending videos.".into());
    }
    let mut selections = HashSet::new();
    for p in photos {
        let source = absolute(&p["sourcePath"], false)?;
        let identity = string(&p["identity"], 512, false)?;
        if !identities.contains(&(source.to_string(), identity.to_string())) {
            return Err("Photo references a video outside this session.".into());
        }
        let index = integer(&p["index"], 10_000_000)?;
        if !selections.insert((path_key(source), index)) {
            return Err("Duplicate photo in session.".into());
        }
        string(&p["personName"], 120, true)?;
        recipe(&p["recipe"])?;
        if let Some(e) = p.get("exported").filter(|v| !v.is_null()) {
            absolute(&e["path"], false)?;
            absolute(&e["provenancePath"], false)?;
            let improved = e.get("enhancedPath").ok_or("Invalid export history.")?;
            if !improved.is_null() {
                absolute(improved, false)?;
            }
            if chrono::DateTime::parse_from_rfc3339(string(&e["capturedAt"], 64, false)?).is_err()
                || integer(&e["width"], 100_000)? == 0
                || integer(&e["height"], 100_000)? == 0
            {
                return Err("Invalid export dimensions or capture time.".into());
            }
        }
        if let Some(destination) = p.get("exportedDestination") {
            absolute(destination, true)?;
        }
    }
    if let Some(w) = root.get("workspace") {
        if !w.is_object() {
            return Err("Invalid session workspace.".into());
        }
        string(&w["personName"], 120, true)?;
        absolute(&w["destination"], true)?;
        absolute(&w["selectedSourcePath"], true)?;
    }
    Ok((paths.len(), photos.len()))
}
fn valid_id(id: &str) -> Result<(), String> {
    if !(8..=100).contains(&id.len())
        || !id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err("Invalid session identifier.".into());
    }
    Ok(())
}
fn valid_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.encode_utf16().count() > 120 || name.chars().any(char::is_control) {
        return Err("Choose a session name of 1–120 characters.".into());
    }
    Ok(name.into())
}
fn regular(path: &Path, directory: bool) -> Result<(), String> {
    let meta =
        fs::symlink_metadata(path).map_err(|e| format!("Cannot access session storage: {e}"))?;
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    };
    #[cfg(not(windows))]
    let linked = meta.file_type().is_symlink();
    if linked || (directory && !meta.is_dir()) || (!directory && !meta.is_file()) {
        return Err("Session storage must not be a link, junction or unexpected file type.".into());
    }
    Ok(())
}
fn existing_regular(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            regular(path, false)?;
            Ok(true)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("Cannot inspect session file: {e}")),
    }
}
fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    regular(path, false)?;
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take((MAX_RECORD + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_RECORD {
        return Err("Saved session record is too large.".into());
    }
    Ok(bytes)
}
fn read_record(path: &Path, id: &str) -> Result<Record, String> {
    let r: Record = serde_json::from_slice(&read_bounded(path)?)
        .map_err(|_| "Saved session record is damaged or unsupported.")?;
    if r.schema_version != 1 || r.id != id || r.revision == 0 || r.revision > MAX_REVISION {
        return Err("Saved session identity or revision is invalid.".into());
    }
    valid_id(&r.id)?;
    valid_name(&r.name)?;
    validate_payload(&r.json)?;
    for date in [&r.created_at, &r.updated_at]
        .into_iter()
        .chain(r.deleted_at.iter())
    {
        chrono::DateTime::parse_from_rfc3339(date).map_err(|_| "Saved session date is invalid.")?;
    }
    Ok(r)
}
fn document(r: Record, recovered: bool) -> Result<SessionDocument, String> {
    let (source_count, photo_count) = validate_payload(&r.json)?;
    Ok(SessionDocument {
        summary: SessionSummary {
            id: r.id,
            name: r.name,
            revision: r.revision,
            created_at: r.created_at,
            updated_at: r.updated_at,
            deleted_at: r.deleted_at,
            source_count,
            photo_count,
            recovered,
        },
        json: r.json,
    })
}
struct Store {
    root: PathBuf,
    _lock: File,
}
impl Store {
    fn open(root: PathBuf) -> Result<Self, String> {
        if !root.exists() {
            fs::create_dir_all(&root).map_err(|e| format!("Cannot create session library: {e}"))?;
        }
        regular(&root, true)?;
        let root = fs::canonicalize(&root).map_err(|e| e.to_string())?;
        let lock_path = root.join("library.lock");
        existing_regular(&lock_path)?;
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(3);
        }
        let lock = options
            .open(&lock_path)
            .map_err(|e| format!("Cannot open session library lock: {e}"))?;
        fs2::FileExt::try_lock_exclusive(&lock)
            .map_err(|_| "The session library is busy in another operation. Retry saving.")?;
        regular(&root, true)?;
        regular(&lock_path, false)?;
        Ok(Self { root, _lock: lock })
    }
    fn paths(&self, id: &str) -> Result<(PathBuf, PathBuf), String> {
        valid_id(id)?;
        Ok((
            self.root.join(format!("{id}.json")),
            self.root.join(format!("{id}.backup.json")),
        ))
    }
    fn read(&self, id: &str) -> Result<(Record, bool), String> {
        let (current, backup) = self.paths(id)?;
        // Link/permission failures are not treated as corruption to bypass.
        existing_regular(&current)?;
        existing_regular(&backup)?;
        match read_record(&current, id) {
            Ok(r) => Ok((r, false)),
            Err(primary) => match read_record(&backup, id) {
                Ok(r) => Ok((r, true)),
                Err(_) => Err(primary),
            },
        }
    }
    fn list(&self) -> Result<SessionList, String> {
        let mut ids = HashSet::new();
        let mut warnings = Vec::new();
        for entry in
            fs::read_dir(&self.root).map_err(|e| format!("Cannot list saved sessions: {e}"))?
        {
            let entry = entry.map_err(|e| format!("Cannot inspect session library: {e}"))?;
            let name = entry.file_name().to_string_lossy().to_string();
            let id = name
                .strip_suffix(".backup.json")
                .or_else(|| name.strip_suffix(".json"));
            if let Some(id) = id {
                if valid_id(id).is_ok() {
                    ids.insert(id.to_string());
                } else {
                    warnings.push(
                        "An unrecognised session-library filename was left untouched.".into(),
                    );
                }
            }
            if ids.len() > MAX_SESSIONS {
                return Err("Session library exceeds 2,000 records. Files were preserved.".into());
            }
        }
        let mut sessions = Vec::new();
        for id in ids {
            match self
                .read(&id)
                .and_then(|(r, recovered)| document(r, recovered))
            {
                Ok(doc) => {
                    if doc.summary.recovered {
                        warnings.push(format!("{}: using the last-good backup. Duplicate it to save a recovered copy.", doc.summary.name));
                    }
                    sessions.push(doc.summary);
                }
                Err(e) => warnings.push(format!(
                    "Session {id} could not be read; its files were preserved. {e}"
                )),
            }
        }
        sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
        Ok(SessionList { sessions, warnings })
    }
    fn current(&self, id: &str, expected: Option<u64>) -> Result<Record, String> {
        let (r, recovered) = self.read(id)?;
        if recovered {
            return Err("Recovered from the last-good backup. Duplicate this session to save a recovered copy; the damaged original remains untouched.".into());
        }
        if expected != Some(r.revision) {
            return Err("This session changed in another operation. Your unsaved changes are retained; reopen or save a separate copy.".into());
        }
        if r.revision == MAX_REVISION {
            return Err(
                "This session has reached its revision limit. Save a separate copy to continue."
                    .into(),
            );
        }
        Ok(r)
    }
    fn put(
        &self,
        id: Option<String>,
        expected: Option<u64>,
        name: String,
        json: String,
    ) -> Result<SessionDocument, String> {
        let name = valid_name(&name)?;
        validate_payload(&json)?;
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let (r, previous) = if let Some(id) = id {
            let old = self.current(&id, expected)?;
            if old.deleted_at.is_some() {
                return Err(
                    "This session is in Recently deleted. Restore it before editing.".into(),
                );
            }
            let mut r = old.clone();
            r.name = name;
            r.json = json;
            r.revision += 1;
            r.updated_at = now;
            (r, Some(old))
        } else {
            if expected.is_some() {
                return Err("New sessions cannot supply an existing revision.".into());
            }
            if self.list()?.sessions.len() >= MAX_SESSIONS {
                return Err("Session library is full; existing sessions were preserved.".into());
            }
            let id = format!(
                "session-{}-{}-{}",
                chrono::Utc::now()
                    .timestamp_nanos_opt()
                    .ok_or("Cannot create session ID.")?,
                std::process::id(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            );
            (
                Record {
                    schema_version: 1,
                    id,
                    name,
                    revision: 1,
                    created_at: now.clone(),
                    updated_at: now,
                    deleted_at: None,
                    json,
                },
                None,
            )
        };
        self.publish(&r, previous.as_ref())?;
        document(r, false)
    }
    fn set_deleted(
        &self,
        id: String,
        expected: u64,
        deleted: bool,
    ) -> Result<SessionDocument, String> {
        let old = self.current(&id, Some(expected))?;
        let mut r = old.clone();
        r.revision += 1;
        r.updated_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        r.deleted_at = if deleted {
            Some(r.updated_at.clone())
        } else {
            None
        };
        // Only the managed metadata flag changes. Never follow source/export paths.
        self.publish(&r, Some(&old))?;
        document(r, false)
    }
    fn publish(&self, r: &Record, previous: Option<&Record>) -> Result<(), String> {
        let (current, backup) = self.paths(&r.id)?;
        if previous.is_none() && (existing_regular(&current)? || existing_regular(&backup)?) {
            return Err("Session ID already exists.".into());
        }
        if let Some(old) = previous {
            atomic_write(
                &backup,
                &serde_json::to_vec(old).map_err(|e| e.to_string())?,
                true,
            )?;
        }
        atomic_write(
            &current,
            &serde_json::to_vec(r).map_err(|e| e.to_string())?,
            previous.is_some(),
        )?;
        // Read-back is part of success, not merely a successful rename.
        let saved = read_record(&current, &r.id)?;
        if saved.revision != r.revision
            || saved.json != r.json
            || saved.name != r.name
            || saved.deleted_at != r.deleted_at
        {
            return Err("Session save read-back did not match. Retry or save a copy.".into());
        }
        Ok(())
    }
}
fn atomic_write(target: &Path, bytes: &[u8], replace: bool) -> Result<(), String> {
    if bytes.len() > MAX_RECORD {
        return Err("Session record exceeds its storage limit.".into());
    }
    let parent = target.parent().ok_or("Session storage has no parent.")?;
    regular(parent, true)?;
    if existing_regular(target)? && !replace {
        return Err("Session target already exists.".into());
    }
    let temp = parent.join(format!(
        ".session-{}-{}.tmp",
        std::process::id(),
        SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| format!("Cannot prepare session save: {e}"))?;
    let result = (|| {
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("Cannot finish session save: {e}"))?;
        drop(file);
        regular(parent, true)?;
        existing_regular(target)?;
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            let a: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
            let b: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
            let flags = MOVEFILE_WRITE_THROUGH
                | if replace {
                    MOVEFILE_REPLACE_EXISTING
                } else {
                    0
                };
            if unsafe { MoveFileExW(a.as_ptr(), b.as_ptr(), flags) } == 0 {
                return Err(format!(
                    "Cannot publish session save: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
        #[cfg(not(windows))]
        {
            if replace {
                fs::rename(&temp, target).map_err(|e| e.to_string())?;
            } else {
                fs::hard_link(&temp, target).map_err(|e| e.to_string())?;
                fs::remove_file(&temp).map_err(|e| e.to_string())?;
            }
            File::open(parent)
                .and_then(|f| f.sync_all())
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    // Remove only our exact private temporary bytes. No directory cleanup.
    if result.is_err() && read_bounded(&temp).is_ok_and(|actual| actual == bytes) {
        let _ = fs::remove_file(&temp);
    }
    result
}
fn store(app: &tauri::AppHandle) -> Result<Store, String> {
    Store::open(
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("video-snapshot-sessions"),
    )
}
#[tauri::command]
pub async fn snapshot_sessions_list(app: tauri::AppHandle) -> Result<SessionList, String> {
    tauri::async_runtime::spawn_blocking(move || store(&app)?.list())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn snapshot_session_get(
    app: tauri::AppHandle,
    id: String,
) -> Result<SessionDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (r, recovered) = store(&app)?.read(&id)?;
        document(r, recovered)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn snapshot_session_put(
    app: tauri::AppHandle,
    id: Option<String>,
    expected_revision: Option<u64>,
    name: String,
    json: String,
) -> Result<SessionDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        store(&app)?.put(id, expected_revision, name, json)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn snapshot_session_set_deleted(
    app: tauri::AppHandle,
    id: String,
    expected_revision: u64,
    deleted: bool,
) -> Result<SessionDocument, String> {
    tauri::async_runtime::spawn_blocking(move || {
        store(&app)?.set_deleted(id, expected_revision, deleted)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TestRoot(PathBuf);
    impl TestRoot {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "photogogo-session-tests-{}-{}-{}",
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap(),
                SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn store(&self) -> Store {
            Store::open(self.0.join("library")).unwrap()
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            if self
                .0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("photogogo-session-tests-")
            {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
    }
    fn payload() -> String {
        serde_json::json!({"kind":"photogogo-video-snapshots","version":1,
            "sources":[{"path":"C:\\missing-video.mp4","identity":"identity","shootingStart":"draft","timeConfirmed":false,"position":4}],
            "selections":[{"sourcePath":"C:\\missing-video.mp4","identity":"identity","index":4,"personName":"Rider","recipe":{"brightness":0,"contrast":0,"sharpness":0,"crop":null}}],
            "workspace":{"personName":"Rider","destination":"D:\\Photos","selectedSourcePath":"C:\\missing-video.mp4"}, "pendingPaths":["D:\\not-indexed.mp4"]}).to_string()
    }
    #[test]
    fn sessions_create_update_restart_and_revision_conflicts() {
        let root = TestRoot::new();
        let doc = root
            .store()
            .put(None, None, "First session".into(), payload())
            .unwrap();
        assert_eq!(doc.summary.source_count, 2);
        assert_eq!(doc.summary.photo_count, 1);
        let store = root.store();
        let next = store
            .put(
                Some(doc.summary.id.clone()),
                Some(1),
                "Renamed".into(),
                payload(),
            )
            .unwrap();
        assert_eq!(next.summary.revision, 2);
        assert!(store
            .put(
                Some(doc.summary.id.clone()),
                Some(1),
                "Stale".into(),
                payload()
            )
            .is_err());
        assert_eq!(store.read(&doc.summary.id).unwrap().0.name, "Renamed");
        drop(store);
        assert_eq!(root.store().list().unwrap().sessions[0].revision, 2);
    }
    #[test]
    fn sessions_delete_restore_never_follow_media_paths_or_resurrect_stale_saves() {
        let root = TestRoot::new();
        let store = root.store();
        let sentinel = root.0.join("original.mp4");
        fs::write(&sentinel, b"original sentinel").unwrap();
        let mut data: Value = serde_json::from_str(&payload()).unwrap();
        data["sources"][0]["path"] = Value::String(sentinel.to_string_lossy().into_owned());
        data["selections"][0]["sourcePath"] = data["sources"][0]["path"].clone();
        let doc = store
            .put(None, None, "Delete me".into(), data.to_string())
            .unwrap();
        let trashed = store.set_deleted(doc.summary.id.clone(), 1, true).unwrap();
        assert!(trashed.summary.deleted_at.is_some());
        assert!(store
            .put(
                Some(doc.summary.id.clone()),
                Some(1),
                "Late save".into(),
                payload()
            )
            .is_err());
        assert!(store
            .put(
                Some(doc.summary.id.clone()),
                Some(2),
                "Undelete via save".into(),
                payload()
            )
            .is_err());
        assert!(store.set_deleted(doc.summary.id.clone(), 1, false).is_err());
        let restored = store.set_deleted(doc.summary.id, 2, false).unwrap();
        assert!(restored.summary.deleted_at.is_none());
        assert_eq!(restored.json, data.to_string());
        assert_eq!(fs::read(sentinel).unwrap(), b"original sentinel");
    }
    #[test]
    fn sessions_backup_recovery_is_visible_readonly_and_duplicable() {
        let root = TestRoot::new();
        let store = root.store();
        let doc = store
            .put(None, None, "Recover me".into(), payload())
            .unwrap();
        store
            .put(
                Some(doc.summary.id.clone()),
                Some(1),
                "Latest".into(),
                payload(),
            )
            .unwrap();
        let (primary, backup) = store.paths(&doc.summary.id).unwrap();
        let backup_bytes = fs::read(&backup).unwrap();
        fs::write(&primary, b"damaged").unwrap();
        let list = store.list().unwrap();
        assert_eq!(list.warnings.len(), 1);
        assert!(list.sessions[0].recovered);
        let (recovered, is_recovered) = store.read(&doc.summary.id).unwrap();
        assert!(is_recovered);
        assert!(store
            .put(
                Some(doc.summary.id.clone()),
                Some(1),
                "Overwrite damaged".into(),
                payload()
            )
            .is_err());
        assert!(store.set_deleted(doc.summary.id, 1, true).is_err());
        let copy = store
            .put(None, None, "Recovered copy".into(), recovered.json)
            .unwrap();
        assert!(!copy.summary.recovered);
        assert_eq!(fs::read(primary).unwrap(), b"damaged");
        assert_eq!(fs::read(backup).unwrap(), backup_bytes);
    }
    #[test]
    fn sessions_fail_closed_for_invalid_ids_payloads_and_corrupt_records() {
        let root = TestRoot::new();
        let store = root.store();
        for id in [
            "../video",
            "..\\video",
            "C:\\video",
            "session/escape",
            "SESSION-UPPER",
        ] {
            assert!(store.paths(id).is_err());
        }
        assert!(store.put(None, None, "".into(), payload()).is_err());
        let mut bad: Value = serde_json::from_str(&payload()).unwrap();
        bad["selections"][0]["recipe"]["brightness"] = Value::from(50);
        assert!(store
            .put(None, None, "Bad".into(), bad.to_string())
            .is_err());
        let mut bad: Value = serde_json::from_str(&payload()).unwrap();
        bad["sources"][0]["timeConfirmed"] = Value::Bool(true);
        assert!(validate_payload(&bad.to_string()).is_err());
        fs::write(store.root.join("session-damaged.json"), b"not-json").unwrap();
        let listed = store.list().unwrap();
        assert!(listed.sessions.is_empty());
        assert_eq!(listed.warnings.len(), 1);
        assert!(store.root.join("session-damaged.json").exists());
    }
    #[test]
    fn sessions_failed_backup_write_preserves_current_and_crossprocess_lock_is_exclusive() {
        let root = TestRoot::new();
        let store = root.store();
        assert!(Store::open(store.root.clone()).is_err());
        let doc = store.put(None, None, "Keep me".into(), payload()).unwrap();
        let (current, backup) = store.paths(&doc.summary.id).unwrap();
        let bytes = fs::read(&current).unwrap();
        fs::create_dir(&backup).unwrap();
        assert!(store
            .put(
                Some(doc.summary.id),
                Some(1),
                "Cannot save".into(),
                payload()
            )
            .is_err());
        assert_eq!(fs::read(current).unwrap(), bytes);
    }
    #[test]
    fn sessions_duplicate_and_portable_contents_are_independent() {
        let root = TestRoot::new();
        let store = root.store();
        let file = root.0.join("portable.json");
        fs::write(&file, payload()).unwrap();
        let original = store
            .put(
                None,
                None,
                "Imported".into(),
                fs::read_to_string(&file).unwrap(),
            )
            .unwrap();
        let copy = store
            .put(None, None, "Duplicate".into(), original.json)
            .unwrap();
        assert_ne!(copy.summary.id, original.summary.id);
        store.set_deleted(copy.summary.id, 1, true).unwrap();
        assert!(store
            .read(&original.summary.id)
            .unwrap()
            .0
            .deleted_at
            .is_none());
        assert_eq!(fs::read_to_string(file).unwrap(), payload());
    }
    #[test]
    fn sessions_unicode_limits_match_frontend_and_revision_exhaustion_preserves_record() {
        let root = TestRoot::new();
        let store = root.store();
        let mut data: Value = serde_json::from_str(&payload()).unwrap();
        let label = "馬".repeat(120);
        data["selections"][0]["personName"] = Value::String(label.clone());
        let doc = store
            .put(None, None, label.clone(), data.to_string())
            .unwrap();
        assert_eq!(
            store.read(&doc.summary.id).unwrap().0.json,
            data.to_string()
        );
        data["selections"][0]["personName"] = Value::String("馬".repeat(121));
        assert!(validate_payload(&data.to_string()).is_err());
        let (mut record, _) = store.read(&doc.summary.id).unwrap();
        record.revision = MAX_REVISION;
        let (primary, _) = store.paths(&doc.summary.id).unwrap();
        let bytes = serde_json::to_vec(&record).unwrap();
        fs::write(&primary, &bytes).unwrap();
        assert!(store
            .set_deleted(doc.summary.id.clone(), MAX_REVISION, true)
            .is_err());
        assert!(store
            .put(Some(doc.summary.id), Some(MAX_REVISION), label, payload())
            .is_err());
        assert_eq!(fs::read(primary).unwrap(), bytes);
    }
    #[cfg(windows)]
    #[test]
    fn sessions_reject_junction_library_without_touching_target() {
        use std::os::windows::process::CommandExt;
        let root = TestRoot::new();
        let external = root.0.join("external");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("keep.txt"), b"keep").unwrap();
        let junction = root.0.join("linked");
        let status = std::process::Command::new("cmd")
            .args(["/d", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&external)
            .creation_flags(0x08000000)
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(Store::open(junction.clone()).is_err());
        fs::remove_dir(junction).unwrap();
        assert_eq!(fs::read(external.join("keep.txt")).unwrap(), b"keep");
    }
}
