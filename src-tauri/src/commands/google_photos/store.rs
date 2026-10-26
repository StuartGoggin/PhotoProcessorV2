//! A portable local-curation sidecar is deliberately separate from encrypted
//! Google documents. No account information is ever written beside photographs.
use super::model::Catalogue;
use fs2::FileExt;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const MAX_DOCUMENT: u64 = 30 * 1024 * 1024;
const MAX_SEALED: u64 = 32 * 1024 * 1024;
const MAX_CURATION: u64 = 2 * 1024 * 1024;
const CURATION_FILE: &str = ".photogogo-curation.json";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

pub trait Sealer: Send + Sync {
    fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String>;
    fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String>;
}

pub struct GoogleStore {
    directory: PathBuf,
    sealer: Arc<dyn Sealer>,
}
impl GoogleStore {
    pub fn new(directory: PathBuf, sealer: Arc<dyn Sealer>) -> Result<Self, String> {
        fs::create_dir_all(&directory)
            .map_err(|_| "Cannot create the protected Google Photos store.")?;
        reject_link(&directory)?;
        let directory = directory
            .canonicalize()
            .map_err(|_| "Cannot resolve the protected Google Photos store.")?;
        Ok(Self { directory, sealer })
    }
    fn path(&self, key: &str) -> Result<PathBuf, String> {
        validate_key(key, false)?;
        Ok(self.directory.join(format!("{key}.sealed")))
    }
    pub fn load<T: DeserializeOwned>(&self, key: &str) -> Result<Option<T>, String> {
        let path = self.path(key)?;
        let _lock = lock(&self.directory.join(format!("{key}.lock")))?;
        let Some(sealed) = read_bounded(&path, MAX_SEALED)? else {
            return Ok(None);
        };
        let plain = self.sealer.open(&sealed)?;
        if plain.len() as u64 > MAX_DOCUMENT {
            return Err("Protected Google Photos document exceeds its safety limit.".into());
        }
        serde_json::from_slice(&plain).map(Some).map_err(|_| {
            "Protected Google Photos document is invalid; it was not overwritten.".into()
        })
    }
    pub fn save<T: Serialize>(&self, key: &str, value: &T) -> Result<(), String> {
        let path = self.path(key)?;
        let _lock = lock(&self.directory.join(format!("{key}.lock")))?;
        let plain = serde_json::to_vec(value)
            .map_err(|_| "Cannot encode the protected Google Photos document.")?;
        if plain.len() as u64 > MAX_DOCUMENT {
            return Err("Protected Google Photos document exceeds its safety limit.".into());
        }
        let sealed = self.sealer.seal(&plain)?;
        if sealed.len() as u64 > MAX_SEALED {
            return Err("Encrypted Google Photos document exceeds its safety limit.".into());
        }
        atomic_write(&path, &sealed)
    }
    pub fn remove(&self, key: &str) -> Result<(), String> {
        let path = self.path(key)?;
        let _lock = lock(&self.directory.join(format!("{key}.lock")))?;
        if path.exists() {
            reject_link(&path)?;
            fs::remove_file(path)
                .map_err(|_| "Cannot remove the protected Google Photos document.")?;
        }
        Ok(())
    }
    pub fn keys(&self, prefix: &str) -> Result<Vec<String>, String> {
        validate_key(prefix, true)?;
        let mut keys = Vec::new();
        for entry in fs::read_dir(&self.directory)
            .map_err(|_| "Cannot list protected Google Photos jobs.")?
        {
            let entry = entry.map_err(|_| "Cannot list a protected Google Photos job.")?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(key) = name.strip_suffix(".sealed") {
                if key.starts_with(prefix) && validate_key(key, false).is_ok() {
                    reject_link(&entry.path())?;
                    keys.push(key.to_string());
                }
            }
        }
        keys.sort();
        Ok(keys)
    }
}

fn validate_key(key: &str, allow_empty: bool) -> Result<(), String> {
    if (!allow_empty && key.is_empty())
        || key.len() > 120
        || key == "."
        || key == ".."
        || !key
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
    {
        return Err("Invalid Google Photos document identifier.".into());
    }
    Ok(())
}

pub(crate) fn reject_link(path: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "Cannot inspect a Google Photos workspace path.")?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(
                "Symbolic links and reparse points are not allowed in Google Photos workspaces."
                    .into(),
            );
        }
    }
    if metadata.file_type().is_symlink() {
        return Err("Symbolic links are not allowed in Google Photos workspaces.".into());
    }
    Ok(())
}

pub(crate) fn read_bounded(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, String> {
    if !path
        .try_exists()
        .map_err(|_| "Cannot inspect a Google Photos document.")?
    {
        return Ok(None);
    }
    reject_link(path)?;
    let file = File::open(path).map_err(|_| "Cannot read a Google Photos document.")?;
    if file
        .metadata()
        .map_err(|_| "Cannot inspect a Google Photos document.")?
        .len()
        > limit
    {
        return Err("Google Photos document exceeds its safety limit.".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read a Google Photos document.")?;
    if bytes.len() as u64 > limit {
        return Err("Google Photos document exceeds its safety limit.".into());
    }
    Ok(Some(bytes))
}

fn lock(path: &Path) -> Result<File, String> {
    if path.exists() {
        reject_link(path)?;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| "Cannot lock the Google Photos store.")?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(file),
            Err(error)
                if error.kind() == std::io::ErrorKind::WouldBlock && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(15))
            }
            Err(_) => {
                return Err("Google Photos state is busy in another process; try again.".into())
            }
        }
    }
}

pub(crate) fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    if target.exists() {
        reject_link(target)?;
    }
    let directory = target
        .parent()
        .ok_or("Google Photos document has no parent directory.")?;
    reject_link(directory)?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = directory.join(format!(
        ".photogogo-write-{}-{sequence}.tmp",
        std::process::id()
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|_| "Cannot stage a Google Photos document.")?;
    let result = (|| {
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "Cannot save a Google Photos document.")?;
        drop(file);
        #[cfg(windows)]
        {
            use std::os::windows::ffi::OsStrExt;
            use windows_sys::Win32::Storage::FileSystem::{
                MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
            };
            let source: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
            let destination: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
            if unsafe {
                MoveFileExW(
                    source.as_ptr(),
                    destination.as_ptr(),
                    MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
                )
            } == 0
            {
                return Err("Cannot atomically publish a Google Photos document.".into());
            }
        }
        #[cfg(not(windows))]
        {
            fs::rename(&temp, target)
                .map_err(|_| "Cannot atomically publish a Google Photos document.")?;
            File::open(directory)
                .and_then(|f| f.sync_all())
                .map_err(|_| "Cannot flush a Google Photos document directory.")?;
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CurationFlag {
    pub selected: bool,
    pub favourite: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Curation {
    pub schema_version: u32,
    pub revision: u64,
    pub entries: BTreeMap<String, CurationFlag>,
}
impl Default for Curation {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            entries: BTreeMap::new(),
        }
    }
}

pub(crate) fn load_curation(directory: &Path) -> Result<Curation, String> {
    let Some(bytes) = read_bounded(&directory.join(CURATION_FILE), MAX_CURATION)? else {
        return Ok(Curation::default());
    };
    let value: Curation = serde_json::from_slice(&bytes)
        .map_err(|_| "Local photo curation is invalid; selections were not overwritten.")?;
    if value.schema_version != 1 || value.entries.len() > 20_000 {
        return Err("Local photo curation uses an unsupported version or size.".into());
    }
    Ok(value)
}

pub fn set_selection(
    root: &Path,
    asset_id: &str,
    selected: Option<bool>,
    favourite: Option<bool>,
) -> Result<Catalogue, String> {
    let catalogue = super::catalogue::scan(root)?;
    let asset = catalogue
        .assets
        .iter()
        .find(|asset| asset.id == asset_id)
        .ok_or(
            "The photo is no longer present. Refresh the Lightbox before changing its selection.",
        )?;
    if asset
        .warnings
        .iter()
        .any(|warning| warning.starts_with("Multiple rating-tagged"))
    {
        return Err(
            "Resolve the duplicate rating-tagged photo names before selecting this version.".into(),
        );
    }
    let path = Path::new(&asset.path);
    let directory = path
        .parent()
        .ok_or("The selected photo has no parent directory.")?;
    let _lock = lock(&directory.join(".photogogo-curation.lock"))?;
    let mut curation = load_curation(directory)?;
    let key = super::catalogue::curation_key(path);
    let value = curation.entries.entry(key).or_default();
    if let Some(selected) = selected {
        value.selected = selected;
    }
    if let Some(favourite) = favourite {
        value.favourite = favourite;
    }
    curation.revision = curation
        .revision
        .checked_add(1)
        .ok_or("Local curation revision exceeded its safety limit.")?;
    if curation.entries.len() > 20_000 {
        return Err(
            "The folder has too many curated photos; split it into smaller event folders.".into(),
        );
    }
    let bytes =
        serde_json::to_vec_pretty(&curation).map_err(|_| "Cannot encode local photo curation.")?;
    if bytes.len() as u64 > MAX_CURATION {
        return Err("Local photo curation exceeds its safety limit.".into());
    }
    atomic_write(&directory.join(CURATION_FILE), &bytes)?;
    drop(_lock);
    super::catalogue::scan(root)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TestSeal;
    impl Sealer for TestSeal {
        fn seal(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
            Ok(std::iter::once(0xa7)
                .chain(plain.iter().map(|b| b ^ 0x55))
                .collect())
        }
        fn open(&self, sealed: &[u8]) -> Result<Vec<u8>, String> {
            if sealed.first() != Some(&0xa7) {
                return Err("Test authentication failed".into());
            }
            Ok(sealed[1..].iter().map(|b| b ^ 0x55).collect())
        }
    }
    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "photogogo-google-store-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }
    #[test]
    fn protected_documents_roundtrip_replace_and_remove() {
        let directory = directory();
        let store = GoogleStore::new(directory.clone(), Arc::new(TestSeal)).unwrap();
        store.save("job-123", &vec!["private-google-id"]).unwrap();
        assert!(
            !String::from_utf8_lossy(&fs::read(directory.join("job-123.sealed")).unwrap())
                .contains("private-google-id")
        );
        store.save("job-123", &vec!["replacement"]).unwrap();
        assert_eq!(
            store.load::<Vec<String>>("job-123").unwrap().unwrap(),
            vec!["replacement"]
        );
        assert_eq!(store.keys("job-").unwrap(), vec!["job-123"]);
        store.remove("job-123").unwrap();
        assert!(store.load::<Vec<String>>("job-123").unwrap().is_none());
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn store_rejects_path_traversal_and_invalid_ciphertext() {
        let directory = directory();
        let store = GoogleStore::new(directory.clone(), Arc::new(TestSeal)).unwrap();
        assert!(store.save("../escape", &true).is_err());
        assert!(store.keys("..\\").is_err());
        atomic_write(&directory.join("job-bad.sealed"), b"plaintext").unwrap();
        assert!(store.load::<bool>("job-bad").is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
