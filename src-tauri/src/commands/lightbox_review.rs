//! Portable capture review decisions. Independent of the strict Google curation schema.
use super::google_photos::{catalogue::curation_key, store};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, Metadata, OpenOptions},
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

const FILE: &str = ".photogogo-review.json";
const LIMIT: u64 = 8 * 1024 * 1024;
const MAX_ENTRIES: usize = 50_000;
const MAX_REVISION: u64 = 9_007_199_254_740_990;

/// Opaque across IPC: nanoseconds are larger than JavaScript's safe integer range.
pub(crate) fn source_stamp(metadata: &Metadata) -> Option<String> {
    Some(format!(
        "{}:{}",
        metadata.len(),
        metadata
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos()
    ))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewEntry {
    pub reviewed: bool,
    pub source_stamp: String,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewDocument {
    pub schema_version: u32,
    pub revision: u64,
    #[serde(deserialize_with = "unique_entries")]
    pub entries: BTreeMap<String, ReviewEntry>,
}
impl Default for ReviewDocument {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            entries: BTreeMap::new(),
        }
    }
}
fn unique_entries<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<BTreeMap<String, ReviewEntry>, D::Error> {
    struct Entries;
    impl<'de> serde::de::Visitor<'de> for Entries {
        type Value = BTreeMap<String, ReviewEntry>;
        fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
            f.write_str("unique review entries")
        }
        fn visit_map<M: serde::de::MapAccess<'de>>(
            self,
            mut map: M,
        ) -> Result<Self::Value, M::Error> {
            let mut entries = BTreeMap::new();
            while let Some((key, value)) = map.next_entry::<String, ReviewEntry>()? {
                if entries.len() >= MAX_ENTRIES || entries.insert(key, value).is_some() {
                    return Err(serde::de::Error::custom(
                        "duplicate or excessive review entries",
                    ));
                }
            }
            Ok(entries)
        }
    }
    d.deserialize_map(Entries)
}
fn inspect_optional(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => store::reject_link(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Cannot inspect the review history path.".into()),
    }
}
fn load(folder: &Path) -> Result<ReviewDocument, String> {
    inspect_optional(&folder.join(FILE))?;
    let Some(bytes) = store::read_bounded(&folder.join(FILE), LIMIT)? else {
        return Ok(ReviewDocument::default());
    };
    let value: ReviewDocument = serde_json::from_slice(&bytes).map_err(|_| {
        "Review history is invalid and was not overwritten. Other photo decisions remain available."
    })?;
    if value.schema_version != 1
        || value.revision > MAX_REVISION
        || value.entries.len() > MAX_ENTRIES
        || value.entries.iter().any(|(key, value)| {
            key.is_empty()
                || key.contains(['/', '\\', ':'])
                || key == "."
                || key == ".."
                || value.source_stamp.len() > 100
        })
    {
        return Err("Review history uses an unsupported version or invalid entries; it was not overwritten.".into());
    }
    Ok(value)
}
fn resolve(root: &str, relative: &str, directory: bool) -> Result<PathBuf, String> {
    let raw = Path::new(root);
    store::reject_link(raw)?;
    let base = raw
        .canonicalize()
        .map_err(|_| "Staging directory is unavailable.")?;
    if !base.is_dir() {
        return Err("Choose an existing staging directory.".into());
    }
    let normalized = relative.replace('\\', "/");
    let mut target = base.clone();
    for component in Path::new(&normalized).components() {
        let Component::Normal(part) = component else {
            return Err("Review path must stay within staging.".into());
        };
        target.push(part);
        store::reject_link(&target)?;
    }
    let canonical = target
        .canonicalize()
        .map_err(|_| "The review source is unavailable; refresh the folder.")?;
    if !canonical.starts_with(&base)
        || (directory && !canonical.is_dir())
        || (!directory && !canonical.is_file())
    {
        return Err("Invalid review source or folder.".into());
    }
    if !directory
        && !canonical.extension().is_some_and(|e| {
            ["jpg", "jpeg", "png", "cr3", "dng"]
                .iter()
                .any(|s| e.eq_ignore_ascii_case(s))
        })
    {
        return Err("Choose an original photo in Lightbox.".into());
    }
    Ok(canonical)
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewRequest {
    pub root: String,
    pub relative_path: String,
    pub source_stamp: String,
    pub reviewed: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewReceipt {
    pub root: String,
    pub relative_path: String,
    pub key: String,
    pub source_stamp: String,
    pub reviewed: bool,
    pub revision: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderFacts {
    pub review: Option<ReviewDocument>,
    pub selections: Option<BTreeMap<String, store::CurationFlag>>,
    pub review_warning: Option<String>,
    pub selection_warning: Option<String>,
}
fn save(request: ReviewRequest) -> Result<ReviewReceipt, String> {
    let path = resolve(&request.root, &request.relative_path, false)?;
    let folder = path.parent().ok_or("Photo folder is unavailable.")?;
    let key = curation_key(&path);
    // Never transfer a neutral-name decision between two colliding physical originals.
    let aliases = fs::read_dir(folder)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|entry| curation_key(&entry.path()) == key)
        .count();
    if aliases != 1 {
        return Err("Several photos have the same review identity. Resolve the duplicate before marking reviewed.".into());
    }
    let stamp = source_stamp(&fs::metadata(&path).map_err(|e| e.to_string())?)
        .ok_or("Photo timestamp is unavailable; refresh before saving.")?;
    if stamp != request.source_stamp {
        return Err("This original changed. Refresh before saving its review status.".into());
    }
    let lock_path = folder.join(".photogogo-review.json.lock");
    inspect_optional(&lock_path)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|e| e.to_string())?;
    lock.try_lock_exclusive()
        .map_err(|_| "Review history is busy in another window. Try again.")?;
    let mut document = load(folder)?;
    let entry = ReviewEntry {
        reviewed: request.reviewed,
        source_stamp: stamp.clone(),
    };
    if document.entries.get(&key) != Some(&entry) {
        if !document.entries.contains_key(&key) && document.entries.len() >= MAX_ENTRIES {
            return Err("Review history is full for this folder.".into());
        }
        document.revision = document
            .revision
            .checked_add(1)
            .filter(|r| *r <= MAX_REVISION)
            .ok_or("Review revision cannot advance.")?;
        document.entries.insert(key.clone(), entry);
        let bytes = serde_json::to_vec_pretty(&document).map_err(|e| e.to_string())?;
        if bytes.len() as u64 > LIMIT {
            return Err("Review history is too large for this folder.".into());
        }
        if source_stamp(&fs::metadata(&path).map_err(|e| e.to_string())?).as_deref() != Some(&stamp)
        {
            return Err("The original changed while saving. Refresh and try again.".into());
        }
        store::atomic_write(&folder.join(FILE), &bytes)?;
    }
    Ok(ReviewReceipt {
        root: request.root,
        relative_path: request.relative_path.replace('\\', "/"),
        key,
        source_stamp: stamp,
        reviewed: request.reviewed,
        revision: document.revision,
    })
}

#[tauri::command]
pub async fn lightbox_review_catalogue(
    root: String,
    relative_folder: String,
) -> Result<FolderFacts, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = resolve(&root, &relative_folder, true)?;
        let (review, review_warning) = match load(&folder) {
            Ok(value) => (Some(value), None),
            Err(error) => (None, Some(error)),
        };
        let (selections, selection_warning) = match store::load_curation(&folder) {
            Ok(value) => (Some(value.entries), None),
            Err(error) => (None, Some(error)),
        };
        Ok(FolderFacts {
            review,
            selections,
            review_warning,
            selection_warning,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn lightbox_review_set(request: ReviewRequest) -> Result<ReviewReceipt, String> {
    tauri::async_runtime::spawn_blocking(move || save(request))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "photogogo-review-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            fs::write(path.join("original.jpg"), b"unchanged original bytes").unwrap();
            Self(path)
        }
        fn request(&self, reviewed: bool) -> ReviewRequest {
            ReviewRequest {
                root: self.0.to_string_lossy().into(),
                relative_path: "original.jpg".into(),
                source_stamp: source_stamp(&fs::metadata(self.0.join("original.jpg")).unwrap())
                    .unwrap(),
                reviewed,
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            assert!(self.0.parent().unwrap() == std::env::temp_dir());
            assert!(self
                .0
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("photogogo-review-"));
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn missing_history_is_read_only() {
        let f = Fixture::new();
        assert!(load(&f.0).unwrap().entries.is_empty());
        assert!(!f.0.join(FILE).exists());
    }
    #[test]
    fn decision_is_explicit_durable_and_does_not_modify_media() {
        let f = Fixture::new();
        let original = fs::read(f.0.join("original.jpg")).unwrap();
        let receipt = save(f.request(true)).unwrap();
        assert!(receipt.reviewed);
        assert_eq!(load(&f.0).unwrap().entries["original.jpg"].reviewed, true);
        let again = save(f.request(true)).unwrap();
        assert_eq!(again.revision, receipt.revision);
        assert!(!save(f.request(false)).unwrap().reviewed);
        assert_eq!(original, fs::read(f.0.join("original.jpg")).unwrap());
    }
    #[test]
    fn stale_stamp_and_escape_cannot_write_review() {
        let f = Fixture::new();
        let mut request = f.request(true);
        request.source_stamp = "stale".into();
        assert!(save(request).is_err());
        let mut request = f.request(true);
        request.relative_path = "../original.jpg".into();
        assert!(save(request).is_err());
        assert!(!f.0.join(FILE).exists());
    }
    #[test]
    fn corrupt_and_future_history_are_preserved() {
        let f = Fixture::new();
        for bytes in [b"broken".as_slice(),br#"{"schemaVersion":2,"revision":0,"entries":{}}"#.as_slice(),br#"{"schemaVersion":1,"revision":0,"entries":{"a.jpg":{"reviewed":true,"sourceStamp":"1"},"a.jpg":{"reviewed":false,"sourceStamp":"2"}}}"#.as_slice()]{fs::write(f.0.join(FILE),bytes).unwrap();assert!(save(f.request(true)).is_err());assert_eq!(fs::read(f.0.join(FILE)).unwrap(),bytes);}
    }
    #[test]
    fn tag_rename_retains_stamp_but_replacement_does_not() {
        let f = Fixture::new();
        let receipt = save(f.request(true)).unwrap();
        fs::rename(f.0.join("original.jpg"), f.0.join("original{Like oo}.jpg")).unwrap();
        let mut request = f.request_for("original{Like oo}.jpg");
        assert_eq!(request.source_stamp, receipt.source_stamp);
        assert_eq!(save(request).unwrap().revision, receipt.revision);
        fs::write(
            f.0.join("original{Like oo}.jpg"),
            b"replacement of different size",
        )
        .unwrap();
        request = f.request_for("original{Like oo}.jpg");
        request.source_stamp = receipt.source_stamp;
        assert!(save(request).is_err());
    }
    #[test]
    fn ambiguous_neutral_names_are_not_guessed() {
        let f = Fixture::new();
        fs::write(f.0.join("original{Like o}.jpg"), b"another").unwrap();
        assert!(save(f.request(true)).is_err());
        assert!(!f.0.join(FILE).exists());
    }
    #[test]
    fn event_folder_rename_keeps_portable_decision() {
        let f = Fixture::new();
        let day = f.0.join("09");
        fs::create_dir(&day).unwrap();
        fs::rename(f.0.join("original.jpg"), day.join("original.jpg")).unwrap();
        let first = save(f.request_for("09/original.jpg")).unwrap();
        fs::rename(&day, f.0.join("09 - Arena event")).unwrap();
        let renamed = save(f.request_for("09 - Arena event/original.jpg")).unwrap();
        assert_eq!(first.source_stamp, renamed.source_stamp);
        assert_eq!(first.revision, renamed.revision);
        assert!(load(&f.0.join("09 - Arena event")).unwrap().entries["original.jpg"].reviewed);
    }
    #[test]
    fn review_never_rewrites_strict_google_curation_and_lock_failure_is_retryable() {
        let f = Fixture::new();
        let curation = f.0.join(".photogogo-curation.json");
        let bytes = br#"{"schemaVersion":1,"revision":7,"entries":{"original.jpg":{"selected":true,"favourite":false}}}"#;
        fs::write(&curation, bytes).unwrap();
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(f.0.join(".photogogo-review.json.lock"))
            .unwrap();
        lock.try_lock_exclusive().unwrap();
        assert!(save(f.request(true)).is_err());
        assert!(!f.0.join(FILE).exists());
        drop(lock);
        assert!(save(f.request(true)).unwrap().reviewed);
        assert_eq!(fs::read(curation).unwrap(), bytes);
    }
    #[test]
    fn dangling_links_cannot_create_external_targets() {
        let outside = Fixture::new();
        let target = outside.0.join("must-not-exist");
        for name in [FILE, ".photogogo-review.json.lock"] {
            let f = Fixture::new();
            let link = f.0.join(name);
            #[cfg(windows)]
            let created = std::os::windows::fs::symlink_file(&target, &link);
            #[cfg(unix)]
            let created = std::os::unix::fs::symlink(&target, &link);
            if let Err(error) = created {
                // Windows requires Developer Mode or symlink privilege.
                if error.kind() == std::io::ErrorKind::PermissionDenied {
                    eprintln!("Symlink fixture unavailable: {error}");
                    return;
                }
                panic!("Cannot create symlink fixture: {error}");
            }
            assert!(save(f.request(true)).is_err());
            assert!(!target.exists());
            if name == FILE {
                assert!(load(&f.0).is_err());
            }
            fs::remove_file(link).unwrap();
        }
    }
    impl Fixture {
        fn request_for(&self, path: &str) -> ReviewRequest {
            ReviewRequest {
                root: self.0.to_string_lossy().into(),
                relative_path: path.into(),
                source_stamp: source_stamp(&fs::metadata(self.0.join(path)).unwrap()).unwrap(),
                reviewed: true,
            }
        }
    }
}
