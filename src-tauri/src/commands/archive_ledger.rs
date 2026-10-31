//! Archive-owned recovery intents and compatible MD5 indexes. Caller holds the
//! cross-process archive lease; a mutex coordinates this job's worker threads.
use super::archive_plan;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

pub(super) const MASTER: &str = "master_hashes.md5";
const JOURNAL: &str = "_transfer_manifests/archive-recovery.jsonl";
const LATEST: &str = "_transfer_manifests/latest-transfer.json";
const MAX_DOCUMENT: u64 = 256 * 1024 * 1024;
fn key(path: &str) -> String {
    if cfg!(windows) {
        path.to_lowercase()
    } else {
        path.to_string()
    }
}
pub(super) fn parse_line(line: &str) -> Option<(String, String)> {
    let (hash, path) = line.split_once("  ")?;
    if hash.len() != 32
        || !hash.bytes().all(|c| c.is_ascii_hexdigit())
        || archive_plan::relative_path(path).is_err()
    {
        return None;
    }
    Some((path.replace('\\', "/"), hash.to_ascii_lowercase()))
}
fn read_limited(path: &Path) -> Result<Vec<u8>, String> {
    let file = File::open(path)
        .map_err(|e| format!("Cannot read archive record '{}': {e}", path.display()))?;
    let mut bytes = Vec::new();
    file.take(MAX_DOCUMENT + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_DOCUMENT {
        return Err(
            "Archive record exceeds the 256 MiB safety limit; no data was discarded.".into(),
        );
    }
    Ok(bytes)
}
fn index(bytes: &[u8]) -> Result<BTreeMap<String, String>, String> {
    let text = std::str::from_utf8(bytes).map_err(|_| "Archive MD5 index is not valid UTF-8.")?;
    let mut entries = BTreeMap::new();
    let mut seen = HashMap::<String, (String, String)>::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let (path,hash)=parse_line(line).ok_or("Archive MD5 index contains an invalid checksum or unsafe path; repair it before transfer.")?;
        if let Some((prior_path, prior_hash)) =
            seen.insert(key(&path), (path.clone(), hash.clone()))
        {
            if prior_hash != hash {
                return Err("Archive MD5 index contains conflicting records for one path.".into());
            }
            entries.remove(&prior_path);
        }
        entries.insert(path, hash);
    }
    Ok(entries)
}
fn encode_index(entries: &BTreeMap<String, String>) -> Result<Vec<u8>, String> {
    let mut size = 0u64;
    for (path, hash) in entries {
        size = size
            .checked_add((path.len() + hash.len() + 3) as u64)
            .ok_or("Archive index size overflow.")?;
        if size > MAX_DOCUMENT {
            return Err("Archive checksum records exceed the supported 256 MiB document limit; prior records were retained.".into());
        }
    }
    let mut out = String::with_capacity(size as usize);
    for (path, hash) in entries {
        out.push_str(&format!("{hash}  {path}\n"));
    }
    Ok(out.into_bytes())
}

/// The old destination is never removed before a replacement is ready.
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    atomic_write_using(path, bytes, replace)
}
fn atomic_write_using(
    path: &Path,
    bytes: &[u8],
    publish: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    if bytes.len() as u64 > MAX_DOCUMENT {
        return Err("Archive record exceeds its readable document limit.".into());
    }
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = path.parent().ok_or("Archive record has no parent.")?;
    archive_plan::reject_link(parent)?;
    if path.exists() {
        archive_plan::reject_link(path)?;
    }
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temp = parent.join(format!(
        ".photogogo-archive-write-{}-{nonce}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    let result = (|| {
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| e.to_string())?;
        drop(file);
        publish(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
fn replace(source: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let a: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let b: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        if unsafe {
            MoveFileExW(
                a.as_ptr(),
                b.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(format!(
                "Cannot replace archive record: {}",
                std::io::Error::last_os_error()
            ));
        }
    }
    #[cfg(not(windows))]
    {
        fs::rename(source, destination)
            .and_then(|_| File::open(destination.parent().unwrap())?.sync_all())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Intent {
    version: u8,
    path: String,
    md5: String,
    bytes: u64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Latest {
    version: u8,
    manifest: String,
    outcome: String,
    files: usize,
}

pub(super) struct Ledger {
    archive: PathBuf,
    entries: BTreeMap<String, String>,
    hashes: HashMap<String, Vec<String>>,
    names: HashMap<String, String>,
    planned: HashSet<String>,
    reserved: HashSet<String>,
    successful: HashSet<String>,
    outcomes: BTreeMap<String, String>,
    pending: BTreeMap<String, (String, u64)>,
    journal: Option<File>,
    journal_bytes: u64,
    poisoned: bool,
    pub recovered: usize,
    pub added_current: usize,
}
impl Ledger {
    pub fn open(
        archive: &Path,
        planned: impl IntoIterator<Item = String>,
        mut hash: impl FnMut(&Path) -> Result<String, String>,
    ) -> Result<Self, String> {
        let master = archive_plan::safe_destination(archive, MASTER)?;
        let entries = match fs::metadata(&master) {
            Ok(_) => index(&read_limited(&master)?)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let legacy = archive_plan::safe_destination(archive, "checksums.md5")?;
                match fs::metadata(&legacy) {
                    Ok(_) => index(&read_limited(&legacy)?)?,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => BTreeMap::new(),
                    Err(e) => return Err(e.to_string()),
                }
            }
            Err(e) => return Err(e.to_string()),
        };
        let mut ledger = Self {
            archive: archive.to_owned(),
            entries,
            hashes: HashMap::new(),
            names: HashMap::new(),
            planned: planned.into_iter().map(|p| key(&p)).collect(),
            reserved: HashSet::new(),
            successful: HashSet::new(),
            outcomes: BTreeMap::new(),
            pending: BTreeMap::new(),
            journal: None,
            journal_bytes: 0,
            poisoned: false,
            recovered: 0,
            added_current: 0,
        };
        ledger.rebuild_hashes();
        let journal = archive_plan::safe_destination(archive, JOURNAL)?;
        let journal_exists = match fs::symlink_metadata(&journal) {
            Ok(_) => true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(format!("Cannot inspect archive recovery journal: {e}")),
        };
        if journal_exists {
            let bytes = read_limited(&journal)?;
            let valid_end = bytes
                .iter()
                .rposition(|b| *b == b'\n')
                .map(|i| i + 1)
                .unwrap_or(0);
            if bytes.len() - valid_end > 65536 {
                return Err(
                    "Archive recovery journal has an oversized incomplete record; it was retained."
                        .into(),
                );
            }
            for line in bytes[..valid_end]
                .split(|b| *b == b'\n')
                .filter(|l| !l.is_empty())
            {
                let mut intent: Intent = serde_json::from_slice(line).map_err(|_| {
                    "Archive recovery journal has a damaged complete record; it has been retained."
                })?;
                let (path, normalized_hash) =
                    parse_line(&format!("{}  {}", intent.md5, intent.path))
                        .ok_or("Archive recovery journal has an invalid checksum or path.")?;
                if intent.version != 1 {
                    return Err("Archive recovery journal has an invalid version.".into());
                }
                intent.path = path;
                intent.md5 = normalized_hash;
                let destination = archive_plan::safe_destination(archive, &intent.path)?;
                match fs::metadata(&destination) {
                    Ok(meta) if meta.is_file() && meta.len() == intent.bytes => {
                        if hash(&destination)? == intent.md5 {
                            ledger.upsert(&intent.path, &intent.md5);
                            ledger.recovered += 1;
                        }
                    }
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => {
                        return Err(format!(
                            "Cannot recover archive file '{}': {e}",
                            destination.display()
                        ))
                    }
                }
            }
            // First durably reconcile recovered records. Only then discard the
            // old journal, including a possible interrupted final-line fragment.
            ledger.checkpoint()?;
            fs::remove_file(&journal).map_err(|e| e.to_string())?;
        }
        Ok(ledger)
    }
    fn rebuild_hashes(&mut self) {
        self.hashes.clear();
        self.names.clear();
        for (path, hash) in &self.entries {
            self.names.insert(key(path), path.clone());
            self.hashes
                .entry(hash.clone())
                .or_default()
                .push(path.clone());
        }
    }
    fn upsert(&mut self, path: &str, hash: &str) {
        let existing = self.names.get(&key(path)).cloned();
        if let Some(old) = existing {
            if let Some(old_hash) = self.entries.remove(&old) {
                if let Some(paths) = self.hashes.get_mut(&old_hash) {
                    paths.retain(|p| p != &old);
                }
            }
        }
        self.names.insert(key(path), path.to_owned());
        self.entries.insert(path.to_owned(), hash.to_owned());
        let paths = self.hashes.entry(hash.to_owned()).or_default();
        if !paths.iter().any(|p| p == path) {
            paths.push(path.to_owned());
        }
    }
    pub fn candidates(&self, hash: &str) -> Vec<String> {
        self.hashes.get(hash).cloned().unwrap_or_default()
    }
    pub fn mark_stale(&mut self, path: &str, expected: &str) -> bool {
        if self.successful.contains(&key(path)) {
            return false;
        }
        if self.entries.get(path).is_some_and(|h| h == expected) {
            self.entries.remove(path);
            self.names.remove(&key(path));
            if let Some(paths) = self.hashes.get_mut(expected) {
                paths.retain(|p| p != path);
            }
            return true;
        }
        false
    }
    pub fn reserve(&mut self, base: &str) -> Result<(String, bool), String> {
        archive_plan::relative_path(base)?;
        let original = Path::new(base);
        let stem = original
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or("Invalid archive filename.")?;
        let extension = original.extension().and_then(|s| s.to_str());
        for suffix in 0..1_000_000usize {
            let name = if suffix == 0 {
                base.to_owned()
            } else {
                let leaf = match extension {
                    Some(ext) => format!("{stem}_{suffix}.{ext}"),
                    None => format!("{stem}_{suffix}"),
                };
                original
                    .parent()
                    .unwrap_or(Path::new(""))
                    .join(leaf)
                    .to_string_lossy()
                    .replace('\\', "/")
            };
            if self.reserved.contains(&key(&name))
                || (suffix > 0 && self.planned.contains(&key(&name)))
            {
                continue;
            }
            let path = archive_plan::safe_destination(&self.archive, &name)?;
            match fs::symlink_metadata(&path) {
                Ok(_) => continue,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
            self.reserved.insert(key(&name));
            return Ok((name, suffix != 0));
        }
        Err("Too many conflicting archive filenames.".into())
    }
    /// Required before publishing; a failed write cannot authorize publication.
    pub fn intent(&mut self, path: &str, hash: &str, bytes: u64) -> Result<(), String> {
        if self.poisoned {
            return Err("Archive journal had a write failure; recover this transfer before publishing more files.".into());
        }
        archive_plan::safe_destination(&self.archive, path)?;
        if parse_line(&format!("{hash}  {path}")).is_none() {
            return Err("Invalid archive publication intent.".into());
        }
        let journal_path = archive_plan::safe_destination(&self.archive, JOURNAL)?;
        let mut line = serde_json::to_vec(&Intent {
            version: 1,
            path: path.to_owned(),
            md5: hash.to_owned(),
            bytes,
        })
        .map_err(|e| e.to_string())?;
        line.push(b'\n');
        if self.journal_bytes + line.len() as u64 > MAX_DOCUMENT {
            return Err(
                "Archive recovery journal is full; finish/recover this transfer before continuing."
                    .into(),
            );
        }
        if self.journal.is_none() {
            match fs::symlink_metadata(&journal_path) {
                Ok(_) => {
                    return Err("An unexpected recovery journal appeared; it was retained.".into())
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.to_string()),
            }
            // Atomic first creation also flushes the parent directory on Unix.
            if let Err(error) = atomic_write(&journal_path, &line) {
                self.poisoned = true;
                return Err(error);
            }
            self.journal = Some(
                OpenOptions::new()
                    .append(true)
                    .open(&journal_path)
                    .map_err(|e| e.to_string())?,
            );
        } else if let Err(error) = self
            .journal
            .as_mut()
            .unwrap()
            .write_all(&line)
            .and_then(|_| self.journal.as_ref().unwrap().sync_all())
        {
            self.poisoned = true;
            return Err(format!(
                "Cannot durably record archive copy; publication refused: {error}"
            ));
        }
        self.pending
            .insert(path.to_owned(), (hash.to_owned(), bytes));
        self.journal_bytes += line.len() as u64;
        Ok(())
    }
    pub fn confirm(&mut self, path: &str, hash: &str) -> Result<(), String> {
        // Publication/dedup already checked and protected the real destination.
        // Recording its outcome must not fail on an extra remote stat after a
        // successful rename, which could otherwise orphan a durable intent.
        if parse_line(&format!("{hash}  {path}")).is_none() {
            return Err("Invalid confirmed archive record.".into());
        }
        if !self.names.contains_key(&key(path)) {
            self.added_current += 1;
        }
        self.upsert(path, hash);
        self.successful.insert(key(path));
        self.outcomes.insert(path.to_owned(), hash.to_owned());
        self.pending.remove(path);
        Ok(())
    }
    /// Only uncertain publications are reread. A lost rename ACK must never
    /// cause its durable intent to be discarded without checking the final file.
    pub fn settle_pending(
        &mut self,
        mut hash: impl FnMut(&Path) -> Result<String, String>,
    ) -> Result<usize, String> {
        let pending: Vec<_> = self
            .pending
            .iter()
            .map(|(p, v)| (p.clone(), v.clone()))
            .collect();
        let mut resolved = 0;
        for (path, (expected, bytes)) in pending {
            let destination = archive_plan::safe_destination(&self.archive, &path)?;
            match fs::metadata(&destination) {
                Ok(meta) if meta.is_file() && meta.len() == bytes => {
                    if hash(&destination)? == expected {
                        self.confirm(&path, &expected)?;
                        resolved += 1;
                    } else {
                        self.pending.remove(&path);
                    }
                }
                Ok(_) => {
                    self.pending.remove(&path);
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    // An unavailable share is not proof that publication failed.
                    fs::read_dir(&self.archive).map_err(|e| {
                        format!("Cannot reconcile uncertain archive publication: {e}")
                    })?;
                    self.pending.remove(&path);
                }
                Err(e) => return Err(format!("Cannot reconcile archive publication: {e}")),
            }
        }
        Ok(resolved)
    }
    pub fn checkpoint(&self) -> Result<(), String> {
        let target = archive_plan::safe_destination(&self.archive, MASTER)?;
        atomic_write(&target, &encode_index(&self.entries)?)
    }
    pub fn finish(&mut self, run_id: &str, outcome: &str) -> Result<PathBuf, String> {
        if run_id.is_empty()
            || run_id.len() > 160
            || !run_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !matches!(outcome, "completed" | "partial" | "aborted")
        {
            return Err("Invalid archive outcome identity.".into());
        }
        if !self.pending.is_empty() {
            return Err("Uncertain publications remain; their recovery intents were retained for the next transfer or verification.".into());
        }
        self.checkpoint()?;
        let relative = format!("_transfer_manifests/transfer-{run_id}.md5");
        let manifest = archive_plan::safe_destination(&self.archive, &relative)?;
        if manifest.exists() {
            return Err("Archive run manifest already exists; it was not replaced.".into());
        }
        atomic_write(&manifest, &encode_index(&self.outcomes)?)?;
        let latest = archive_plan::safe_destination(&self.archive, LATEST)?;
        atomic_write(
            &latest,
            &serde_json::to_vec_pretty(&Latest {
                version: 1,
                manifest: relative,
                outcome: outcome.into(),
                files: self.outcomes.len(),
            })
            .map_err(|e| e.to_string())?,
        )?;
        self.journal = None;
        let journal = archive_plan::safe_destination(&self.archive, JOURNAL)?;
        match fs::remove_file(journal) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!(
                    "Archive records saved, but recovery journal could not be retired: {e}"
                ))
            }
        }
        Ok(manifest)
    }
}

pub(super) fn read_entries(path: &Path) -> Result<BTreeMap<String, String>, String> {
    index(&read_limited(path)?)
}

pub(super) fn verification_manifest(
    archive: &Path,
    scope: &str,
) -> Result<(PathBuf, String), String> {
    match scope {
        "archive" => {
            let master = archive_plan::safe_destination(archive, MASTER)?;
            if master.exists() {
                index(&read_limited(&master)?)?;
                return Ok((master, "whole archive MD5 index".into()));
            }
            let legacy = archive_plan::safe_destination(archive, "checksums.md5")?;
            if legacy.exists() {
                index(&read_limited(&legacy)?)?;
                return Ok((legacy, "legacy archive checksum index".into()));
            }
            Err("No archive MD5 index exists yet. Complete a transfer first.".into())
        }
        "latest" => {
            let pointer = archive_plan::safe_destination(archive, LATEST)?;
            if !pointer.exists() {
                return Err("No explicit latest-transfer record exists yet. Choose Whole archive or complete a new transfer.".into());
            }
            let latest: Latest = serde_json::from_slice(&read_limited(&pointer)?)
                .map_err(|_| "Latest-transfer record is damaged.")?;
            if latest.version != 1
                || !matches!(latest.outcome.as_str(), "completed" | "partial" | "aborted")
                || !latest.manifest.starts_with("_transfer_manifests/transfer-")
                || !latest.manifest.ends_with(".md5")
            {
                return Err("Invalid latest-transfer record.".into());
            }
            let path = archive_plan::safe_destination(archive, &latest.manifest)?;
            let entries = index(&read_limited(&path)?)?;
            if entries.len() != latest.files {
                return Err("Latest-transfer manifest does not match its outcome record.".into());
            }
            Ok((
                path,
                format!(
                    "latest {} transfer ({} confirmed files)",
                    latest.outcome, latest.files
                ),
            ))
        }
        _ => Err("Choose Latest transfer or Whole archive for verification.".into()),
    }
}

#[cfg(test)]
#[path = "archive_ledger_tests.rs"]
mod tests;
