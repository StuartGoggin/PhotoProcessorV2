use super::{
    super::{google_photos::store, lightbox_trash::safety, metadata_tools},
    metadata,
};
use chrono::{Local, NaiveDate, NaiveDateTime};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    fs::{self, File, FileTimes, Metadata, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

pub(super) const DOCUMENT_LIMIT: u64 = 128 * 1024 * 1024;
const ENTRY_LIMIT: usize = 200_000;
type EntryMap = BTreeMap<String, Stamp>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Time {
    seconds: u64,
    nanos: u32,
}

impl Time {
    fn from(time: SystemTime) -> Option<Self> {
        let duration = time.duration_since(UNIX_EPOCH).ok()?;
        Some(Self {
            seconds: duration.as_secs(),
            nanos: duration.subsec_nanos(),
        })
    }

    fn system(self) -> Option<SystemTime> {
        if self.nanos >= 1_000_000_000 {
            return None;
        }
        UNIX_EPOCH.checked_add(std::time::Duration::new(self.seconds, self.nanos))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Stamp {
    pub bytes: u64,
    modified: Option<Time>,
    created: Option<Time>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    accessed: Option<Time>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    attributes: Option<u32>,
}

impl Stamp {
    pub(super) fn read(meta: &Metadata) -> Self {
        Self {
            bytes: meta.len(),
            modified: meta.modified().ok().and_then(Time::from),
            created: meta.created().ok().and_then(Time::from),
            accessed: meta.accessed().ok().and_then(Time::from),
            attributes: metadata::flags(meta),
        }
    }

    pub(super) fn has_recorded_times(&self) -> bool {
        self.modified.is_some() || self.created.is_some()
    }

    pub(super) fn has_attributes(&self) -> bool {
        self.attributes.is_some()
    }

    pub(super) fn with_access_time(mut self, original: &Self) -> Self {
        self.accessed = original.accessed;
        self
    }

    pub(super) fn same_file(&self, other: &Self) -> bool {
        self.bytes == other.bytes
            && self.modified == other.modified
            && self.created == other.created
    }

    pub(super) fn set_times(&self, file: &File) -> bool {
        let mut times = FileTimes::new();
        if let Some(time) = self.modified.and_then(Time::system) {
            times = times.set_modified(time);
        }
        #[cfg(windows)]
        if let Some(time) = self.created.and_then(Time::system) {
            use std::os::windows::fs::FileTimesExt;
            times = times.set_created(time);
        }
        file.set_times(times).is_ok()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Inventory {
    pub files: EntryMap,
    pub directories: BTreeSet<String>,
    pub directory_stamps: EntryMap,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_stamp: Option<Stamp>,
}

impl Inventory {
    pub fn bytes(&self) -> u64 {
        self.files.values().map(|stamp| stamp.bytes).sum()
    }

    pub fn same_tree(&self, other: &Self) -> bool {
        self.directories == other.directories && same_files(&self.files, &other.files)
    }

    pub(super) fn strict(&self) -> bool {
        self.root_stamp
            .as_ref()
            .is_some_and(|stamp| stamp.attributes.is_some())
    }

    fn entries(&self) -> impl Iterator<Item = (&str, &Stamp, bool)> {
        self.files
            .iter()
            .map(|(name, stamp)| (name.as_str(), stamp, false))
            .chain(
                self.directory_stamps
                    .iter()
                    .rev()
                    .map(|(name, stamp)| (name.as_str(), stamp, true)),
            )
            .chain(self.root_stamp.iter().map(|stamp| ("", stamp, true)))
    }

    pub(super) fn verify_source_metadata(&self, current: &Self) -> Result<(), String> {
        if !self.strict() {
            return Ok(());
        }
        for (relative, expected, directory) in self.entries() {
            let actual = if relative.is_empty() {
                current.root_stamp.as_ref()
            } else if directory {
                current.directory_stamps.get(relative)
            } else {
                current.files.get(relative)
            }
            .ok_or_else(|| format!("Card entry disappeared: {}", entry_label(relative)))?;
            verify_stamp(
                expected,
                actual,
                &format!("card {}", entry_label(relative)),
                true,
                false,
            )?;
        }
        Ok(())
    }

    pub(super) fn check_source_fields(&self) -> Result<(), String> {
        if !self.strict() {
            return Ok(());
        }
        for (relative, stamp, _) in self.entries() {
            validate_flags(stamp, entry_label(relative))?;
        }
        Ok(())
    }

    pub(super) fn check_streams(
        &self,
        tree: &Path,
        stopped: &impl Fn() -> bool,
    ) -> Result<(), String> {
        if !self.strict() || !metadata::may_have_named_streams(tree) {
            return Ok(());
        }
        for (relative, _, directory) in self.entries() {
            if stopped() {
                return Err("Stopped at a safe checkpoint.".into());
            }
            metadata::reject_named_stream(
                &entry_path(tree, relative, directory)?,
                entry_label(relative),
            )?;
        }
        Ok(())
    }

    pub(super) fn check_published_metadata(
        &self,
        tree: &Path,
        stopped: &impl Fn() -> bool,
    ) -> Result<(), String> {
        for (relative, expected, directory) in self.entries() {
            if stopped() {
                return Err("Stopped at a safe checkpoint.".into());
            }
            let path = entry_path(tree, relative, directory)?;
            let label = entry_label(relative);
            let current = metadata::read_current(&path)
                .map_err(|error| format!("Cannot read back {label}: {error}"))?;
            if (directory && !current.is_dir()) || (!directory && !current.is_file()) {
                return Err(format!("Archive entry type changed at {label}"));
            }
            verify_stamp(expected, &Stamp::read(&current), label, true, true)?;
        }
        Ok(())
    }
}

fn entry_label(relative: &str) -> &str {
    if relative.is_empty() {
        "root folder"
    } else {
        relative
    }
}

fn entry_path(tree: &Path, relative: &str, directory: bool) -> Result<PathBuf, String> {
    if relative.is_empty() {
        Ok(tree.to_path_buf())
    } else {
        relative_path(tree, relative, !directory)
    }
}

fn validate_flags(stamp: &Stamp, label: &str) -> Result<u32, String> {
    let flags = stamp
        .attributes
        .ok_or_else(|| format!("Card attributes are unavailable at {label}"))?;
    if !metadata::supported_flags(flags) {
        return Err(format!(
            "Unsupported card attributes at {label}: {}",
            metadata::describe_flags(flags)
        ));
    }
    Ok(flags)
}

fn describe_time(value: Option<Time>) -> String {
    value
        .and_then(|time| {
            chrono::DateTime::<chrono::Utc>::from_timestamp(
                time.seconds.try_into().ok()?,
                time.nanos,
            )
        })
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
        .unwrap_or_else(|| "unavailable".into())
}

fn describe_attributes(flags: Option<u32>) -> String {
    flags
        .map(metadata::describe_flags)
        .unwrap_or_else(|| "unavailable".into())
}

fn verify_stamp(
    expected: &Stamp,
    actual: &Stamp,
    label: &str,
    strict: bool,
    check_accessed: bool,
) -> Result<(), String> {
    for (field, want, got) in [
        ("creation time", expected.created, actual.created),
        ("modification time", expected.modified, actual.modified),
        (
            "last-access time",
            expected.accessed.filter(|_| check_accessed),
            actual.accessed,
        ),
    ] {
        if want.is_some() && want != got {
            return Err(format!(
                "Archive timestamp mismatch at {label}, {field}: expected {}, observed {}",
                describe_time(want),
                describe_time(got)
            ));
        }
    }
    if strict && expected.attributes != actual.attributes {
        return Err(format!(
            "Archive attributes mismatch at {label}: expected {}, observed {}",
            describe_attributes(expected.attributes),
            describe_attributes(actual.attributes)
        ));
    }
    Ok(())
}

pub(super) fn same_files(left: &EntryMap, right: &EntryMap) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .all(|((name, stamp), (other_name, other_stamp))| {
                name == other_name && stamp.same_file(other_stamp)
            })
}

pub(super) fn root(path: &Path) -> Result<PathBuf, String> {
    safety::root(path.to_str().ok_or("Folder path is not valid Unicode.")?)
}

pub(super) fn relative_path(path: &Path, relative: &str, exists: bool) -> Result<PathBuf, String> {
    if !valid_relative(relative) {
        return Err("Invalid archive relative path.".into());
    }
    safety::scoped(path, relative, exists)
}

fn valid_relative(relative: &str) -> bool {
    !relative.is_empty()
        && relative.split('/').all(|part| {
            !part.is_empty() && part != "." && part != ".." && !part.contains(['\\', ':', '\0'])
        })
}

pub(super) fn scan(base: &Path, mut stopped: impl FnMut() -> bool) -> Result<Inventory, String> {
    let mut result = Inventory {
        files: BTreeMap::new(),
        directories: BTreeSet::new(),
        directory_stamps: BTreeMap::new(),
        root_stamp: Some(Stamp::read(
            &metadata::read_current(base)
                .map_err(|e| format!("Cannot inspect archive root: {e}"))?,
        )),
    };
    let mut seen = BTreeSet::new();
    let mut total_bytes = 0u64;
    for entry in walkdir::WalkDir::new(base).min_depth(1).follow_links(false) {
        if stopped() {
            return Err("Stopped at a safe checkpoint.".into());
        }
        let entry = entry.map_err(|e| format!("Cannot inspect every entry in this volume: {e}"))?;
        let path = entry.path();
        let native = path
            .strip_prefix(base)
            .map_err(|_| "Archive entry is outside its root.")?;
        let Some(relative) = native.to_str() else {
            return Err(
                "A source filename cannot be represented faithfully in the archive.".into(),
            );
        };
        let relative = if cfg!(windows) {
            relative.replace('\\', "/")
        } else {
            relative.into()
        };
        let metadata = entry
            .metadata()
            .map_err(|e| format!("Cannot inspect {relative}: {e}"))?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err(format!(
                    "Redirected entry cannot be archived faithfully: {relative}"
                ));
            }
        }
        let folded = if cfg!(windows) {
            relative.to_lowercase()
        } else {
            relative.clone()
        };
        if !valid_relative(&relative) || !seen.insert(folded) || seen.len() > ENTRY_LIMIT {
            return Err(format!(
                "Archive inventory has an invalid, ambiguous or excessive entry: {relative}"
            ));
        }
        if metadata.is_dir() && entry.file_type().is_dir() {
            let current = super::metadata::read_current(path)
                .map_err(|e| format!("Cannot read directory metadata for {relative}: {e}"))?;
            result
                .directory_stamps
                .insert(relative.clone(), Stamp::read(&current));
            result.directories.insert(relative);
        } else if metadata.is_file() && entry.file_type().is_file() {
            total_bytes = total_bytes
                .checked_add(metadata.len())
                .ok_or("Card size exceeds archive limits.")?;
            result.files.insert(relative, Stamp::read(&metadata));
        } else {
            return Err(format!("Unsupported entry type: {relative}"));
        }
    }
    Ok(result)
}

pub(super) fn guarded_read(path: &Path) -> Result<File, String> {
    store::reject_link(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x00200000 | 0x08000000);
    }
    let file = options
        .open(path)
        .map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    safety::id(&file)?;
    Ok(file)
}

pub(super) fn hash_file(path: &Path, stopped: impl FnMut() -> bool) -> Result<String, String> {
    hash_file_with_progress(path, stopped, |_| {})
}

pub(super) fn hash_file_with_progress(
    path: &Path,
    mut stopped: impl FnMut() -> bool,
    mut read: impl FnMut(u64),
) -> Result<String, String> {
    let mut file = guarded_read(path)?;
    let before = safety::id(&file)?;
    let mut buffer = vec![0; 1024 * 1024];
    let mut hash = Sha256::new();
    let mut bytes = 0;
    loop {
        if stopped() {
            return Err("Stopped at a safe checkpoint.".into());
        }
        let count = file
            .read(&mut buffer)
            .map_err(|e| format!("Cannot verify {}: {e}", path.display()))?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        hash.update(&buffer[..count]);
        read(count as u64);
    }
    if bytes != before.bytes || !safety::same(&before, &safety::id(&file)?) {
        return Err(format!(
            "File changed during verification: {}",
            path.display()
        ));
    }
    Ok(hex::encode(hash.finalize()))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DateEvidence {
    pub date: NaiveDate,
    pub basis: String,
    pub file: Option<String>,
}

fn plausible(date: NaiveDate) -> bool {
    date >= NaiveDate::from_ymd_opt(1980, 1, 2).unwrap() && date <= Local::now().date_naive()
}

pub(super) fn proposed_date(inventory: &Inventory) -> Option<DateEvidence> {
    let candidate = inventory
        .files
        .iter()
        .filter(|(name, _)| is_media(name))
        .filter_map(|(name, stamp)| Some((!is_photo(name), modification_date(stamp)?, name)))
        .min()?;
    Some(DateEvidence {
        date: candidate.1,
        basis: "File modification time".into(),
        file: Some(candidate.2.clone()),
    })
}

fn modification_date(stamp: &Stamp) -> Option<NaiveDate> {
    let date = chrono::DateTime::<Local>::from(stamp.modified?.system()?).date_naive();
    plausible(date).then_some(date)
}

fn has_extension(name: &str, extensions: &[&str]) -> bool {
    Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            extensions
                .iter()
                .any(|value| ext.eq_ignore_ascii_case(value))
        })
}

fn is_photo(name: &str) -> bool {
    has_extension(
        name,
        &[
            "jpg", "jpeg", "heic", "heif", "hif", "png", "tiff", "tif", "cr2", "cr3", "nef", "nrw",
            "arw", "dng", "raf", "orf", "rw2", "pef",
        ],
    )
}

fn is_media(name: &str) -> bool {
    is_photo(name)
        || has_extension(
            name,
            &["mp4", "mov", "mts", "m2ts", "mxf", "avi", "mkv", "mpg"],
        )
}

pub(super) fn capture_date(
    tree: &Path,
    inventory: &Inventory,
    tool: &Path,
    mut stopped: impl FnMut() -> bool,
) -> Result<Option<DateEvidence>, String> {
    let mut candidates = inventory
        .files
        .keys()
        .filter(|name| is_media(name))
        .peekable();
    let mut earliest = None::<(bool, NaiveDate, bool, String)>;
    while candidates.peek().is_some() {
        if stopped() {
            return Err("Stopped at a safe checkpoint.".into());
        }
        let mut args: Vec<OsString> = ["-j", "-DateTimeOriginal", "-CreationDate", "-CreateDate"]
            .into_iter()
            .map(Into::into)
            .collect();
        let mut batch = BTreeMap::new();
        let mut units = 0;
        while let Some(relative) = candidates.peek() {
            let path = relative_path(tree, relative, true)?;
            let limit = path.as_os_str().len() + 1;
            if !batch.is_empty() && (units + limit > 10_000 || batch.len() == 96) {
                break;
            }
            units += limit;
            batch.insert(normal_path(&path.to_string_lossy()), (*relative).clone());
            args.push(path.as_os_str().to_owned());
            candidates.next();
        }
        let rows = metadata_tools::run_limited(tool, &args, 2 * 1024 * 1024)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<serde_json::Value>>(&bytes).ok());
        let mut embedded = BTreeMap::new();
        for row in rows.into_iter().flatten() {
            let Some(file) = row["SourceFile"]
                .as_str()
                .and_then(|p| batch.get(&normal_path(p)))
            else {
                continue;
            };
            let date = ["DateTimeOriginal", "CreationDate", "CreateDate"]
                .into_iter()
                .find_map(|key| {
                    let time = row[key].as_str()?.get(..19)?;
                    let date = NaiveDateTime::parse_from_str(time, "%Y:%m:%d %H:%M:%S")
                        .ok()?
                        .date();
                    plausible(date).then_some(date)
                });
            if let Some(date) = date {
                embedded.insert(file.clone(), date);
            }
        }
        for file in batch.values() {
            let date = embedded
                .get(file)
                .map(|date| (*date, false))
                .or_else(|| modification_date(&inventory.files[file]).map(|date| (date, true)));
            if let Some((date, fallback)) = date {
                let candidate = (!is_photo(file), date, fallback, file.clone());
                if earliest.as_ref().is_none_or(|old| &candidate < old) {
                    earliest = Some(candidate);
                }
            }
        }
    }
    Ok(earliest.map(|(_, date, fallback, file)| DateEvidence {
        date,
        basis: if fallback {
            "File modification time"
        } else {
            "Embedded capture time"
        }
        .into(),
        file: Some(file),
    }))
}

pub(super) fn preserve_times(
    tree: &Path,
    inventory: &Inventory,
    stopped: &impl Fn() -> bool,
    strict: bool,
) -> Result<usize, String> {
    let mut warnings = 0;
    for (relative, stamp, directory) in inventory.entries() {
        if stopped() {
            return Err("Stopped at a safe checkpoint.".into());
        }
        let path = entry_path(tree, relative, directory)?;
        warnings += preserve_entry_metadata(&path, stamp, directory, strict)?;
    }
    Ok(warnings)
}

fn preserve_entry_metadata(
    path: &Path,
    stamp: &Stamp,
    directory: bool,
    strict: bool,
) -> Result<usize, String> {
    let context = |cause: &str| {
        format!(
            "Repository could not preserve metadata for {}: {cause}",
            path.display()
        )
    };
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options
            .access_mode(0x180)
            .share_mode(1)
            .custom_flags(0x02000000 | 0x00200000);
    }
    let file = options.open(path).map_err(|e| context(&e.to_string()))?;
    let current = file.metadata().map_err(|e| context(&e.to_string()))?;
    if (directory && !current.is_dir()) || (!directory && !current.is_file()) {
        return Err(context("the entry type changed"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if current.file_attributes() & 0x400 != 0 {
            return Err(context("the entry was redirected"));
        }
    }
    if !directory {
        metadata::require_independent_file(&file).map_err(|e| context(&e))?;
    }
    let label = path.to_string_lossy();
    if strict {
        let expected = validate_flags(stamp, &label)?;
        let observed = metadata::flags(&current);
        if observed != Some(expected) {
            metadata::write_flags(&file, expected).map_err(|e| format!(
                "Repository could not preserve attributes at {label}: expected {}, observed {} ({e})",
                metadata::describe_flags(expected), describe_attributes(observed)
            ))?;
        }
    }
    let wrote_dates = stamp.set_times(&file);
    let accessed = stamp.accessed.and_then(Time::system);
    let wrote_access =
        accessed.is_none_or(|time| file.set_times(FileTimes::new().set_accessed(time)).is_ok());
    let actual = Stamp::read(&file.metadata().map_err(|e| context(&e.to_string()))?);
    verify_stamp(stamp, &actual, &label, strict, strict)?;
    if !strict && !wrote_dates {
        return Err(context("creation or modification time could not be set"));
    }
    Ok(usize::from(
        !strict && accessed.is_some() && (!wrote_access || stamp.accessed != actual.accessed),
    ))
}

fn normal_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim_start_matches("//?/")
        .to_ascii_lowercase()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FileReceipt {
    pub stamp: Stamp,
    pub sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Manifest {
    pub version: u8,
    pub archive_name: String,
    pub archive_id: String,
    pub card_reference: String,
    pub date: DateEvidence,
    pub verified_at: String,
    pub bytes: u64,
    pub file_count: usize,
    pub directories: BTreeSet<String>,
    pub files: BTreeMap<String, FileReceipt>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub directory_stamps: EntryMap,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub root_stamp: Option<Stamp>,
}

impl Manifest {
    pub(super) fn inventory(&self) -> Inventory {
        Inventory {
            files: self
                .files
                .iter()
                .map(|(name, receipt)| (name.clone(), receipt.stamp.clone()))
                .collect(),
            directories: self.directories.clone(),
            directory_stamps: self.directory_stamps.clone(),
            root_stamp: self.root_stamp.clone(),
        }
    }

    pub(super) fn same_contents(&self, other: &Self) -> bool {
        self.directories == other.directories
            && self.file_count == other.file_count
            && self.files.iter().zip(&other.files).all(
                |((name, file), (other_name, other_file))| {
                    name == other_name
                        && file.stamp.bytes == other_file.stamp.bytes
                        && file.sha256 == other_file.sha256
                },
            )
    }

    pub(super) fn matches_card(&self, inventory: &Inventory) -> bool {
        self.directories == inventory.directories
            && self.files.len() == inventory.files.len()
            && self
                .files
                .iter()
                .zip(&inventory.files)
                .all(|((name, receipt), (source, stamp))| {
                    name == source && receipt.stamp.same_file(stamp)
                })
            && (self.version != metadata::STRICT_VERSION
                || self.inventory().verify_source_metadata(inventory).is_ok())
    }
}

pub(super) fn manifest_name(folder: &str) -> String {
    format!("{folder}.checksums.json")
}

pub(super) fn load_manifest(
    tree: &Path,
    expected_name: &str,
) -> Result<(Manifest, String), String> {
    let path = relative_path(tree, &manifest_name(expected_name), true)?;
    let bytes =
        store::read_bounded(&path, DOCUMENT_LIMIT)?.ok_or("Archive checksum file is missing.")?;
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Archive checksum file is invalid: {e}"))?;
    let total = manifest
        .files
        .values()
        .try_fold(0u64, |sum, file| sum.checked_add(file.stamp.bytes));
    if !matches!(manifest.version, 1..=metadata::STRICT_VERSION)
        || manifest.archive_name != expected_name
        || manifest.file_count != manifest.files.len()
        || total != Some(manifest.bytes)
        || manifest
            .files
            .len()
            .saturating_add(manifest.directories.len())
            > ENTRY_LIMIT
        || manifest
            .files
            .iter()
            .any(|(path, r)| !valid_relative(path) || !is_sha256(&r.sha256))
        || manifest
            .directories
            .iter()
            .any(|path| !valid_relative(path))
        || (matches!(manifest.version, 2 | metadata::STRICT_VERSION)
            && !manifest.directory_stamps.keys().eq(&manifest.directories))
        || (manifest.version == 3
            && manifest
                .directory_stamps
                .keys()
                .any(|name| !manifest.directories.contains(name)))
    {
        return Err("Archive checksum file has unsupported or inconsistent values.".into());
    }
    if manifest.version == metadata::STRICT_VERSION {
        let root = manifest
            .root_stamp
            .as_ref()
            .ok_or("Strict archive root metadata is missing.")?;
        validate_flags(root, "root folder")?;
        for (name, stamp) in manifest
            .files
            .iter()
            .map(|(name, receipt)| (name, &receipt.stamp))
            .chain(&manifest.directory_stamps)
        {
            validate_flags(stamp, name)?;
        }
    }
    Ok((manifest, hex::encode(Sha256::digest(bytes))))
}

pub(super) fn verify(
    tree: &Path,
    archivename: &str,
    expected_digest: Option<&str>,
    progress: impl FnMut(&str, u64),
    stopped: impl Fn() -> bool,
) -> Result<Manifest, String> {
    let (manifest, digest) = load_manifest(tree, archivename)?;
    if expected_digest.is_some_and(|expected| expected != digest) {
        return Err("This archive's checksum file changed since publication.".into());
    }
    let name = manifest_name(archivename);
    let final_inventory = verify_contents(tree, &manifest, &[&name], progress, &stopped)?;
    if load_manifest(tree, archivename)?.1 != digest {
        return Err("Archive checksum file changed while it was being verified.".into());
    }
    if manifest.version == metadata::STRICT_VERSION {
        final_inventory.check_streams(tree, &stopped)?;
    }
    if manifest.version >= 2 {
        verify_times(&manifest, &final_inventory)?;
    }
    Ok(manifest)
}

pub(super) fn verify_contents(
    tree: &Path,
    manifest: &Manifest,
    receipt_names: &[&str],
    mut progress: impl FnMut(&str, u64),
    stopped: &impl Fn() -> bool,
) -> Result<Inventory, String> {
    let contents = || {
        let mut result = scan(tree, stopped)?;
        for name in receipt_names {
            result.files.remove(*name);
        }
        Ok::<_, String>(result)
    };
    let found = contents()?;
    if found.directories != manifest.directories || !found.files.keys().eq(manifest.files.keys()) {
        return Err("An archive file or folder has been added, moved or removed.".into());
    }
    for (name, file) in &manifest.files {
        let path = relative_path(tree, name, true)?;
        if found.files[name].bytes != file.stamp.bytes || hash_file(&path, stopped)? != file.sha256
        {
            return Err(format!("Archive checksum mismatch: {name}"));
        }
        progress(name, file.stamp.bytes);
    }
    let final_inventory = contents()?;
    if !final_inventory.same_tree(&found) {
        return Err("Archive changed while it was being verified.".into());
    }
    Ok(final_inventory)
}

pub(super) fn verify_times(manifest: &Manifest, final_inventory: &Inventory) -> Result<(), String> {
    let strict = manifest.version == metadata::STRICT_VERSION;
    for (name, expected) in manifest
        .files
        .iter()
        .map(|(name, receipt)| (name, &receipt.stamp))
        .chain(&manifest.directory_stamps)
    {
        let actual = final_inventory
            .files
            .get(name)
            .or_else(|| final_inventory.directory_stamps.get(name))
            .ok_or_else(|| format!("Archive metadata is missing: {name}"))?;
        verify_stamp(expected, actual, name, strict, false)?;
    }
    if let Some(expected) = &manifest.root_stamp {
        let actual = final_inventory
            .root_stamp
            .as_ref()
            .ok_or("Archive root metadata is missing.")?;
        verify_stamp(expected, actual, "root folder", strict, false)?;
    }
    Ok(())
}

pub(super) fn is_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn ensure_dir(path: &Path) -> Result<(), String> {
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            store::reject_link(path)?;
            if path.is_dir() {
                Ok(())
            } else {
                Err(format!("Expected a directory: {}", path.display()))
            }
        }
        Err(error) => Err(format!("Cannot create {}: {error}", path.display())),
    }
}
