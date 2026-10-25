//! Structured event descriptions. The folder name is a presentation, never a parser.
use super::naming::{ApplyEventNamingRequest, EventNamingAssignment};
use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

pub(crate) const EVENT_FILE: &str = ".photogogo-event.json";
const MAX_JSON: u64 = 64 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct EventDescription {
    pub event_group: String,
    pub event_type: String,
    pub venue: String,
    pub include_period: bool,
    pub custom_name: Option<String>,
    pub people_tags: Vec<String>,
    pub group_tags: Vec<String>,
    pub general_tags: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SavedEvent {
    pub schema_version: u32,
    pub description: EventDescription,
    pub dates: Vec<String>,
    pub title: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventFavourite {
    pub name: String,
    pub description: EventDescription,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamingChange {
    pub path: String,
    pub date_key: String,
    pub old_name: String,
    pub new_name: String,
    pub replaces_existing: bool,
    pub changed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamingPreview {
    pub request: ApplyEventNamingRequest,
    pub changes: Vec<NamingChange>,
    pub warnings: Vec<String>,
}

fn error_context(error: impl std::fmt::Display) -> String {
    format!("Cannot read event description: {error}")
}
pub(crate) fn reject_link(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    let mut link = meta.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        link |= meta.file_attributes() & 0x400 != 0;
    }
    if link {
        return Err(format!(
            "Linked folders or files are not supported for event naming: {}",
            path.display()
        ));
    }
    Ok(())
}
fn existing_regular_file(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
        Ok(metadata) => {
            reject_link(path)?;
            if !metadata.is_file() {
                return Err(format!("Expected an ordinary file: {}", path.display()));
            }
            Ok(true)
        }
    }
}
pub(crate) fn checked_root(root: &Path) -> Result<PathBuf, String> {
    if !root.is_absolute() {
        return Err("Choose an absolute staging directory.".into());
    }
    for ancestor in root.ancestors() {
        reject_link(ancestor)?;
    }
    if !root.is_dir() {
        return Err("Staging directory is unavailable.".into());
    }
    root.canonicalize().map_err(|e| e.to_string())
}
pub(crate) fn checked_day(root: &Path, path: &Path) -> Result<(PathBuf, String), String> {
    if !path.is_absolute() {
        return Err("Date folder must be an absolute path.".into());
    }
    for ancestor in path.ancestors() {
        reject_link(ancestor)?;
    }
    let resolved = path.canonicalize().map_err(|e| e.to_string())?;
    if !resolved.is_dir() {
        return Err("Selected date folder is not a directory.".into());
    }
    let (year, month, day) = super::naming::is_candidate_day_directory(root, &resolved)
        .ok_or("Choose a year / month / day folder inside this staging directory.")?;
    Ok((resolved, format!("{year:04}-{month:02}-{day:02}")))
}
fn normalize_description(mut description: EventDescription) -> Result<EventDescription, String> {
    for value in [
        &mut description.event_group,
        &mut description.event_type,
        &mut description.venue,
    ] {
        *value = value.trim().into();
        if value.chars().any(char::is_control) || value.len() > 500 {
            return Err("Event fields must be short, single-line descriptions.".into());
        }
    }
    if let Some(custom) = &mut description.custom_name {
        *custom = custom.trim().into();
    }
    if description.custom_name.is_none() && description.event_group.is_empty() {
        return Err("Enter an event group or choose a custom event name.".into());
    }
    for tags in [
        &mut description.people_tags,
        &mut description.group_tags,
        &mut description.general_tags,
    ] {
        if tags.len() > 100 {
            return Err("Use no more than 100 tags per category.".into());
        }
        *tags = tags
            .iter()
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .collect();
        if tags
            .iter()
            .any(|t| t.len() > 160 || t.chars().any(char::is_control))
        {
            return Err("Tags must be short single-line names.".into());
        }
        tags.sort();
        tags.dedup();
    }
    validate_name(&base_name(&description))?;
    Ok(description)
}
pub(crate) fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.encode_utf16().count() > 220
        || name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || name.ends_with(['.', ' '])
        || name == "."
        || name == ".."
    {
        return Err("Use a non-empty name of at most 220 characters without Windows path characters (such as /, \\, : or ?), or a trailing dot or space.".into());
    }
    Ok(())
}
pub(crate) fn base_name(description: &EventDescription) -> String {
    description.custom_name.clone().unwrap_or_else(|| {
        [
            &description.event_group,
            &description.event_type,
            &description.venue,
        ]
        .into_iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" - ")
    })
}
fn period(dates: &[String]) -> Result<String, String> {
    let mut months = Vec::new();
    for date in dates {
        let parsed =
            NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| "Event date is invalid.")?;
        if date != &parsed.format("%Y-%m-%d").to_string() {
            return Err("Use ISO event dates.".into());
        }
        months.push((parsed.year(), parsed.month()));
    }
    months.sort();
    months.dedup();
    let Some((first_year, _)) = months.first() else {
        return Err("Select at least one event date.".into());
    };
    let same_year = months.iter().all(|(year, _)| year == first_year);
    let names = months
        .iter()
        .map(|(year, month)| {
            NaiveDate::from_ymd_opt(*year, *month, 1)
                .unwrap()
                .format(if same_year { "%B" } else { "%B %Y" })
                .to_string()
        })
        .collect::<Vec<_>>()
        .join(" & ");
    Ok(if same_year {
        format!("{names} {first_year}")
    } else {
        names
    })
}
fn saved_event(
    description: EventDescription,
    mut dates: Vec<String>,
) -> Result<SavedEvent, String> {
    let description = normalize_description(description)?;
    if dates.is_empty() || dates.len() > 366 {
        return Err("Select between 1 and 366 date folders for one event.".into());
    }
    dates.sort();
    dates.dedup();
    let suffix = period(&dates)?;
    let base = base_name(&description);
    let title = if description.include_period && description.custom_name.is_none() {
        format!("{base} - {suffix}")
    } else {
        base
    };
    if title.len() > 1000 {
        return Err("The event title is too long. Choose fewer months or a shorter name.".into());
    }
    Ok(SavedEvent {
        schema_version: 1,
        description,
        dates,
        title,
    })
}
#[derive(Debug, Clone)]
pub(crate) struct ReviewedEvent {
    root: PathBuf,
    event: SavedEvent,
    expected_hash: String,
    expected_name: String,
    replace_existing: bool,
}

// The native side recomputes the presentation and checks the reviewed snapshot.
// A stale preview can never silently authorise a different rename.
pub(crate) fn reviewed_event(
    root: &str,
    assignment: &EventNamingAssignment,
) -> Result<ReviewedEvent, String> {
    let event = assignment
        .event
        .as_ref()
        .ok_or("Review every selected event before applying.")?;
    if *event != saved_event(event.description.clone(), event.dates.clone())? {
        return Err("Event details have changed. Review the proposed names again.".into());
    }
    let reviewed = ReviewedEvent {
        root: checked_root(Path::new(root))?,
        event: event.clone(),
        expected_hash: assignment
            .expected_event_hash
            .clone()
            .ok_or("Missing event review. Review changes again.")?,
        expected_name: assignment
            .expected_name
            .clone()
            .ok_or("Missing folder review. Review changes again.")?,
        replace_existing: assignment.replace_existing,
    };
    verify_review(
        &reviewed,
        Path::new(&assignment.directory),
        assignment
            .target_name
            .as_deref()
            .ok_or("Missing reviewed folder name.")?,
    )?;
    Ok(reviewed)
}

fn verify_review(reviewed: &ReviewedEvent, path: &Path, new_name: &str) -> Result<(), String> {
    let root = checked_root(&reviewed.root)?;
    let (_, date) = checked_day(&root, path)?;
    if !reviewed.event.dates.contains(&date) {
        return Err("The selected date is not part of this reviewed event.".into());
    }
    let expected_target = format!(
        "{} - {}",
        &date[8..],
        base_name(&reviewed.event.description)
    );
    validate_name(new_name)?;
    if expected_target != new_name
        || path.file_name().and_then(|n| n.to_str()) != Some(&reviewed.expected_name)
    {
        return Err("Folder name changed since review. Refresh the dates and review again.".into());
    }
    let (previous, hash) = read_event(path)?;
    if hash != reviewed.expected_hash {
        return Err(
            "Event details changed since review. Refresh the dates and review again.".into(),
        );
    }
    let changed = reviewed.expected_name != new_name || previous.as_ref() != Some(&reviewed.event);
    if changed
        && (reviewed.expected_name != date[8..] || previous.is_some())
        && !reviewed.replace_existing
    {
        return Err("Confirm replacement of this existing event in the review screen.".into());
    }
    let target = path.parent().ok_or("Folder has no parent.")?.join(new_name);
    if target != path && target.try_exists().map_err(|e| e.to_string())? {
        return Err(format!(
            "Target folder already exists: {new_name}. Review the dates again."
        ));
    }
    Ok(())
}

fn temporary_file(parent: &Path, bytes: &[u8]) -> io::Result<PathBuf> {
    let mut nonce = [0_u8; 12];
    getrandom::fill(&mut nonce).map_err(|e| io::Error::other(e.to_string()))?;
    let temp = parent.join(format!(".photogogo-event-{}.tmp", hex::encode(nonce)));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()
    })();
    drop(file);
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    Ok(temp)
}

// Windows' no-replace move is also used for directories, avoiding check-then-overwrite.
fn publish_file(source: &Path, target: &Path, replace: bool) -> io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from = source
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let to = target
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>();
        let flags = MOVEFILE_WRITE_THROUGH
            | if replace {
                MOVEFILE_REPLACE_EXISTING
            } else {
                0
            };
        if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), flags) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        if replace {
            fs::rename(source, target)
        } else if source.is_file() {
            fs::hard_link(source, target)?;
            fs::remove_file(source)
        } else {
            if target.try_exists()? {
                return Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "Target folder exists.",
                ));
            }
            fs::rename(source, target)
        }
    }
}

pub(crate) fn apply_reviewed_event(
    reviewed: &ReviewedEvent,
    old_path: &Path,
    new_path: &Path,
) -> io::Result<()> {
    apply_with_publisher(reviewed, old_path, new_path, publish_file)
}

fn apply_with_publisher(
    reviewed: &ReviewedEvent,
    old_path: &Path,
    new_path: &Path,
    publish: impl FnOnce(&Path, &Path, bool) -> io::Result<()>,
) -> io::Result<()> {
    let name = new_path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| io::Error::other("Invalid event folder name."))?;
    verify_review(reviewed, old_path, name).map_err(io::Error::other)?;
    let bytes = serde_json::to_vec_pretty(&reviewed.event).map_err(io::Error::other)?;
    if bytes.len() as u64 > MAX_JSON {
        return Err(io::Error::other(
            "Event description exceeds its storage limit.",
        ));
    }
    let temp = temporary_file(old_path, &bytes)?;
    if let Err(error) = verify_review(reviewed, old_path, name) {
        let _ = fs::remove_file(&temp);
        return Err(io::Error::other(error));
    }
    let moved = old_path != new_path;
    if moved {
        if let Err(error) = publish_file(old_path, new_path, false) {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
    }
    let moved_temp = new_path.join(temp.file_name().unwrap());
    let target = new_path.join(EVENT_FILE);
    let result = (|| {
        let (_, hash) = read_event(new_path).map_err(io::Error::other)?;
        if hash != reviewed.expected_hash {
            return Err(io::Error::other("Event details changed during naming."));
        }
        publish(&moved_temp, &target, reviewed.expected_hash != "absent")
    })();
    if let Err(error) = result {
        if moved {
            if let Err(rollback) = publish_file(new_path, old_path, false) {
                let _ = fs::remove_file(&moved_temp);
                return Err(io::Error::other(format!("Event description was not saved: {error}. Folder rollback failed: {rollback}. Your files are at {}. Refresh before retrying.", new_path.display())));
            }
        }
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    let (saved, _) = read_event(new_path).map_err(|e| {
        io::Error::other(format!(
            "Folder is now at {} but event verification failed: {e}",
            new_path.display()
        ))
    })?;
    if saved.as_ref() != Some(&reviewed.event) {
        return Err(io::Error::other(format!(
            "Folder is now at {} but saved event details differ. Refresh before retrying.",
            new_path.display()
        )));
    }
    Ok(())
}

pub(crate) fn check_request_root(
    staging_dir: &str,
    request: &ApplyEventNamingRequest,
) -> Result<PathBuf, String> {
    let root = checked_root(Path::new(staging_dir))?;
    if let Some(reviewed) = &request.reviewed_root {
        if checked_root(Path::new(reviewed))? != root {
            return Err("The staging directory changed. Review the event names again.".into());
        }
    }
    for directory in request
        .directories
        .iter()
        .chain(request.assignments.iter().map(|a| &a.directory))
    {
        checked_day(&root, Path::new(directory))?;
    }
    Ok(root)
}

pub(crate) fn naming_lease(root: &Path) -> Result<fs::File, String> {
    use fs2::FileExt;
    let path = root.join(".photogogo-naming.lock");
    existing_regular_file(&path)?;
    let lease = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    lease.try_lock_exclusive().map_err(|_| {
        "Another naming operation is using this staging directory. Wait for it to finish."
    })?;
    Ok(lease)
}

/// Stored separately from the legacy archive-scan catalogue. A scan must never
/// replace a favourite library with a stale pre-scan catalogue snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventLibrary {
    pub schema_version: u32,
    pub favourites: Vec<EventFavourite>,
    pub recent_events: Vec<EventDescription>,
}
impl Default for EventLibrary {
    fn default() -> Self {
        Self {
            schema_version: 1,
            favourites: vec![],
            recent_events: vec![],
        }
    }
}
fn library_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let root = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    Ok(checked_root(&root)?.join("event-naming-library-v1.json"))
}
fn load_library(path: &Path) -> Result<EventLibrary, String> {
    if !existing_regular_file(path)? {
        return Ok(EventLibrary::default());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_JSON + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_JSON {
        return Err("Event favourites exceed their storage limit.".into());
    }
    let library: EventLibrary = serde_json::from_slice(&bytes).map_err(|e| {
        format!("Cannot read event favourites; the existing library was preserved: {e}")
    })?;
    if library.schema_version != 1
        || library.favourites.len() > 100
        || library.recent_events.len() > 20
    {
        return Err("Unsupported event favourites library. Existing data was preserved.".into());
    }
    let mut names = HashSet::new();
    for favourite in &library.favourites {
        validate_favourite(favourite)?;
        if !names.insert(favourite.name.to_lowercase()) {
            return Err(
                "Duplicate favourite names in the saved library. Existing data was preserved."
                    .into(),
            );
        }
    }
    for description in &library.recent_events {
        normalize_description(description.clone())?;
    }
    Ok(library)
}
fn validate_favourite(favourite: &EventFavourite) -> Result<(), String> {
    if favourite.name.trim().is_empty()
        || favourite.name.len() > 160
        || favourite.name.chars().any(char::is_control)
    {
        return Err("Enter a short, single-line favourite name.".into());
    }
    normalize_description(favourite.description.clone())?;
    Ok(())
}
fn update_library(
    path: &Path,
    update: impl FnOnce(&mut EventLibrary) -> Result<(), String>,
) -> Result<EventLibrary, String> {
    use fs2::FileExt;
    let parent = path.parent().ok_or("Event library has no parent.")?;
    checked_root(parent)?;
    let lock_path = path.with_extension("lock");
    existing_regular_file(&lock_path)?;
    let lease = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(lock_path)
        .map_err(|e| e.to_string())?;
    lease
        .try_lock_exclusive()
        .map_err(|_| "Event favourites are being updated in another window. Try again.")?;
    let mut library = load_library(path)?;
    update(&mut library)?;
    if library.favourites.len() > 100 {
        return Err(
            "The library can hold up to 100 favourites. Remove an unused favourite first.".into(),
        );
    }
    let bytes = serde_json::to_vec_pretty(&library).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_JSON {
        return Err("The event library is full. Remove an unused favourite first.".into());
    }
    let temp = temporary_file(parent, &bytes).map_err(|e| e.to_string())?;
    let result = publish_file(&temp, path, true);
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(format!("Could not save event favourites: {error}"));
    }
    load_library(path)
}
fn save_favourite(
    path: &Path,
    mut favourite: EventFavourite,
    replace_existing: bool,
) -> Result<EventLibrary, String> {
    favourite.name = favourite.name.trim().into();
    favourite.description = normalize_description(favourite.description)?;
    validate_favourite(&favourite)?;
    update_library(path, |library| {
        if let Some(existing) = library
            .favourites
            .iter_mut()
            .find(|f| f.name.eq_ignore_ascii_case(&favourite.name))
        {
            if !replace_existing {
                return Err(
                    "A favourite with this name already exists. Confirm replacement before saving."
                        .into(),
                );
            }
            *existing = favourite;
        } else {
            library.favourites.push(favourite);
        }
        library.favourites.sort_by_key(|f| f.name.to_lowercase());
        Ok(())
    })
}
#[tauri::command]
pub fn load_event_naming_library(app: tauri::AppHandle) -> Result<EventLibrary, String> {
    load_library(&library_path(&app)?)
}
#[tauri::command]
pub fn save_event_naming_favourite(
    app: tauri::AppHandle,
    favourite: EventFavourite,
    replace_existing: bool,
) -> Result<EventLibrary, String> {
    save_favourite(&library_path(&app)?, favourite, replace_existing)
}
#[tauri::command]
pub fn remove_event_naming_favourite(
    app: tauri::AppHandle,
    name: String,
) -> Result<EventLibrary, String> {
    update_library(&library_path(&app)?, |library| {
        library
            .favourites
            .retain(|f| !f.name.eq_ignore_ascii_case(name.trim()));
        Ok(())
    })
}
pub(crate) fn remember_event(
    app: &tauri::AppHandle,
    description: &EventDescription,
) -> Result<(), String> {
    update_library(&library_path(app)?, |library| {
        library.recent_events.retain(|d| d != description);
        library.recent_events.insert(0, description.clone());
        library.recent_events.truncate(20);
        Ok(())
    })?;
    Ok(())
}

fn overlaps(root: &Path, other: &str) -> bool {
    Path::new(other)
        .canonicalize()
        .map(|path| path.starts_with(root) || root.starts_with(path))
        .unwrap_or(true)
}
pub(crate) fn ensure_jobs_idle(root: &Path, own_job: Option<&str>) -> Result<(), String> {
    use super::{
        import::{list_import_jobs, ImportJobStatus},
        process::{list_process_jobs, ProcessJobStatus},
    };
    for job in list_import_jobs()? {
        if matches!(
            job.status,
            ImportJobStatus::Queued | ImportJobStatus::Running | ImportJobStatus::Paused
        ) && (overlaps(root, &job.staging_dir) || overlaps(root, &job.source_dir))
        {
            return Err("An import is using these folders. Finish or stop it in Jobs, then review event names again.".into());
        }
    }
    for job in list_process_jobs()? {
        if Some(job.id.as_str()) != own_job
            && matches!(
                job.status,
                ProcessJobStatus::Queued | ProcessJobStatus::Running | ProcessJobStatus::Paused
            )
            && (overlaps(root, &job.staging_dir) || overlaps(root, &job.scope_dir))
        {
            return Err("A processing or transfer job is using these folders. Finish or stop it in Jobs, then review event names again.".into());
        }
    }
    if super::video_studio::studio_list_jobs()
        .iter()
        .any(|j| ["queued", "running", "paused"].contains(&j.status.as_str()))
    {
        return Err(
            "Video Studio has an active job. Finish or stop it before renaming media folders."
                .into(),
        );
    }
    Ok(())
}
pub(crate) fn read_event(path: &Path) -> Result<(Option<SavedEvent>, String), String> {
    let file = path.join(EVENT_FILE);
    match fs::symlink_metadata(&file) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((None, "absent".into())),
        Err(e) => return Err(error_context(e)),
        Ok(meta) if !meta.is_file() || meta.len() > MAX_JSON => {
            return Err("Event description is not a regular file or exceeds its size limit.".into())
        }
        _ => {}
    }
    reject_link(&file)?;
    let mut bytes = Vec::new();
    fs::File::open(file)
        .map_err(error_context)?
        .take(MAX_JSON + 1)
        .read_to_end(&mut bytes)
        .map_err(error_context)?;
    if bytes.len() as u64 > MAX_JSON {
        return Err("Event description exceeds its size limit.".into());
    }
    let event: SavedEvent = serde_json::from_slice(&bytes).map_err(error_context)?;
    if event.schema_version != 1
        || event != saved_event(event.description.clone(), event.dates.clone())?
    {
        return Err("Event description has an unsupported version or inconsistent fields. Its folder has not been changed.".into());
    }
    Ok((Some(event), hex::encode(Sha256::digest(&bytes))))
}

#[tauri::command]
pub fn preview_event_naming(
    staging_dir: String,
    directories: Vec<String>,
    description: EventDescription,
) -> Result<NamingPreview, String> {
    let root = checked_root(Path::new(&staging_dir))?;
    if directories.is_empty() || directories.len() > 366 {
        return Err("Select between 1 and 366 date folders.".into());
    }
    let mut selected = Vec::new();
    let mut seen = HashSet::new();
    for directory in directories {
        let (path, date) = checked_day(&root, Path::new(&directory))?;
        if !seen.insert(path.to_string_lossy().to_lowercase()) {
            return Err("The same date folder was selected more than once.".into());
        }
        selected.push((path, date));
    }
    selected.sort_by(|a, b| a.1.cmp(&b.1));
    let event = saved_event(
        description,
        selected.iter().map(|(_, d)| d.clone()).collect(),
    )?;
    let mut assignments = Vec::new();
    let mut changes = Vec::new();
    let mut targets = HashSet::new();
    for (path, date) in selected {
        let old_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("Folder name is not valid text.")?
            .to_string();
        let new_name = format!("{} - {}", &date[8..], base_name(&event.description));
        validate_name(&new_name)?;
        let target = path.parent().unwrap().join(&new_name);
        if !targets.insert(target.to_string_lossy().to_lowercase()) {
            return Err("Two selected folders would receive the same name.".into());
        }
        if target != path && target.exists() {
            return Err(format!(
                "Target folder already exists: {new_name}. No folders were changed."
            ));
        }
        let (previous, hash) = read_event(&path)?;
        let changed = old_name != new_name || previous.as_ref() != Some(&event);
        changes.push(NamingChange {
            path: path.to_string_lossy().into(),
            date_key: date.clone(),
            replaces_existing: changed && (old_name != date[8..] || previous.is_some()),
            old_name: old_name.clone(),
            new_name: new_name.clone(),
            changed,
        });
        assignments.push(EventNamingAssignment {
            directory: path.to_string_lossy().into(),
            event_type: event.description.event_type.clone(),
            location: event.description.venue.clone(),
            source: Some("manual".into()),
            target_name: Some(new_name),
            people_tags: event.description.people_tags.clone(),
            group_tags: event.description.group_tags.clone(),
            general_tags: event.description.general_tags.clone(),
            event: Some(event.clone()),
            expected_name: Some(old_name),
            expected_event_hash: Some(hash),
            replace_existing: false,
        });
    }
    Ok(NamingPreview {
        request: ApplyEventNamingRequest { directories: vec![], event_type: String::new(), location: String::new(), people_tags: vec![], group_tags: vec![], general_tags: vec![], assignments, reviewed_root: Some(root.to_string_lossy().into()) },
        changes,
        warnings: vec!["Renaming changes folder paths. Saved Video Studio projects or snapshot sessions may need relinking, and saved upload plans may need rebuilding. Finish imports, processing and transfers before applying; do not start new jobs until naming finishes.".into()],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let mut nonce = [0_u8; 12];
            getrandom::fill(&mut nonce).unwrap();
            let root =
                std::env::temp_dir().join(format!("photogogo-event-test-{}", hex::encode(nonce)));
            fs::create_dir_all(root.join("2026/10/24")).unwrap();
            Self(root)
        }
        fn preview(&self) -> NamingPreview {
            preview_event_naming(
                self.0.to_string_lossy().into(),
                vec![self.0.join("2026/10/24").to_string_lossy().into()],
                EventDescription {
                    event_group: "Mounted Games Victoria".into(),
                    event_type: "Teams".into(),
                    venue: "Ayr Hill".into(),
                    include_period: true,
                    ..Default::default()
                },
            )
            .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn naming_preview_groups_dates_without_touching_media() {
        let fixture = Fixture::new();
        let root = &fixture.0;
        let a = root.join("2026/10/24");
        let b = root.join("2026/10/25");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let description = EventDescription {
            event_group: "Mounted Games Victoria".into(),
            event_type: "Teams".into(),
            venue: "Ayr Hill".into(),
            include_period: true,
            ..Default::default()
        };
        let preview = preview_event_naming(
            root.to_string_lossy().into(),
            vec![a.to_string_lossy().into(), b.to_string_lossy().into()],
            description,
        )
        .unwrap();
        assert_eq!(preview.changes.len(), 2);
        assert_eq!(
            preview.changes[0].new_name,
            "24 - Mounted Games Victoria - Teams - Ayr Hill"
        );
        assert!(
            a.exists() && b.exists(),
            "Preview must not rename any folder"
        );
    }
    #[test]
    fn naming_apply_reopens_structure_and_preserves_original_bytes() {
        let fixture = Fixture::new();
        let source = fixture.0.join("2026/10/24");
        fs::write(source.join("original.jpg"), b"untouched original bytes").unwrap();
        let preview = fixture.preview();
        let plans = super::super::naming::build_event_naming_plans(&preview.request).unwrap();
        let renamed = super::super::naming::apply_event_naming_plan_once(&plans[0]).unwrap();
        let target = Path::new(&renamed.new_path);
        assert_eq!(
            fs::read(target.join("original.jpg")).unwrap(),
            b"untouched original bytes"
        );
        let rows =
            super::super::naming::list_event_day_directories(fixture.0.to_string_lossy().into())
                .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].event.as_ref().unwrap().title,
            "Mounted Games Victoria - Teams - Ayr Hill - October 2026"
        );
        assert_eq!(rows[0].event, preview.request.assignments[0].event);
    }
    #[test]
    fn naming_rejects_stale_review_and_requires_replacement_consent() {
        let fixture = Fixture::new();
        let preview = fixture.preview();
        let plans = super::super::naming::build_event_naming_plans(&preview.request).unwrap();
        super::super::naming::apply_event_naming_plan_once(&plans[0]).unwrap();
        let renamed = &plans[0].new_path;
        let mut description = preview.request.assignments[0]
            .event
            .as_ref()
            .unwrap()
            .description
            .clone();
        description.event_type = "Pairs".into();
        let mut replacement = preview_event_naming(
            fixture.0.to_string_lossy().into(),
            vec![renamed.to_string_lossy().into()],
            description,
        )
        .unwrap();
        assert!(replacement.changes[0].replaces_existing);
        assert!(
            super::super::naming::build_event_naming_plans(&replacement.request)
                .unwrap_err()
                .contains("Confirm replacement")
        );
        replacement.request.assignments[0].replace_existing = true;
        let reviewed =
            super::super::naming::build_event_naming_plans(&replacement.request).unwrap();
        let mut changed = read_event(renamed).unwrap().0.unwrap();
        changed
            .description
            .people_tags
            .push("Updated elsewhere".into());
        fs::write(
            renamed.join(EVENT_FILE),
            serde_json::to_vec(&changed).unwrap(),
        )
        .unwrap();
        assert!(
            super::super::naming::apply_event_naming_plan_once(&reviewed[0])
                .unwrap_err()
                .to_string()
                .contains("changed since review")
        );
        assert!(renamed.exists());
        assert!(!reviewed[0].new_path.exists());
    }
    #[test]
    fn naming_rejects_outside_paths_bad_dates_collisions_and_forged_target() {
        let fixture = Fixture::new();
        let other = Fixture::new();
        let description = fixture.preview().request.assignments[0]
            .event
            .as_ref()
            .unwrap()
            .description
            .clone();
        assert!(preview_event_naming(
            fixture.0.to_string_lossy().into(),
            vec![other.0.join("2026/10/24").to_string_lossy().into()],
            description.clone()
        )
        .is_err());
        fs::create_dir_all(fixture.0.join("2026/02/30")).unwrap();
        assert!(preview_event_naming(
            fixture.0.to_string_lossy().into(),
            vec![fixture.0.join("2026/02/30").to_string_lossy().into()],
            description
        )
        .is_err());
        let mut preview = fixture.preview();
        preview.request.assignments[0].target_name = Some("../outside".into());
        assert!(super::super::naming::build_event_naming_plans(&preview.request).is_err());
        let preview = fixture.preview();
        let plans = super::super::naming::build_event_naming_plans(&preview.request).unwrap();
        fs::create_dir_all(&plans[0].new_path).unwrap();
        fs::write(plans[0].new_path.join("keep.txt"), b"unrelated target").unwrap();
        assert!(super::super::naming::apply_event_naming_plan_once(&plans[0]).is_err());
        assert!(plans[0].old_path.exists());
        assert_eq!(
            fs::read(plans[0].new_path.join("keep.txt")).unwrap(),
            b"unrelated target"
        );
    }
    #[test]
    fn naming_failed_metadata_publish_restores_folder_and_leaves_media_untouched() {
        let fixture = Fixture::new();
        let preview = fixture.preview();
        let plans = super::super::naming::build_event_naming_plans(&preview.request).unwrap();
        let plan = &plans[0];
        fs::write(plan.old_path.join("original.jpg"), b"original").unwrap();
        let error = apply_with_publisher(
            plan.reviewed.as_ref().unwrap(),
            &plan.old_path,
            &plan.new_path,
            |_, _, _| Err(io::Error::other("simulated storage failure")),
        )
        .unwrap_err();
        assert!(error.to_string().contains("simulated storage failure"));
        assert!(plan.old_path.exists() && !plan.new_path.exists());
        assert_eq!(
            fs::read(plan.old_path.join("original.jpg")).unwrap(),
            b"original"
        );
        assert_eq!(fs::read_dir(&plan.old_path).unwrap().count(), 1);
    }
    #[test]
    fn naming_favourites_persist_without_dates_and_protect_existing_text() {
        let fixture = Fixture::new();
        let path = fixture.0.join("library.json");
        let description = fixture.preview().request.assignments[0]
            .event
            .as_ref()
            .unwrap()
            .description
            .clone();
        let favourite = EventFavourite {
            name: "MGV teams".into(),
            description: description.clone(),
        };
        save_favourite(&path, favourite.clone(), false).unwrap();
        assert_eq!(
            load_library(&path).unwrap().favourites[0].description,
            description
        );
        let before = fs::read(&path).unwrap();
        let mut changed = favourite.clone();
        changed.description.event_type = "Pairs".into();
        assert!(save_favourite(&path, changed.clone(), false).is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(
            save_favourite(&path, changed, true).unwrap().favourites[0]
                .description
                .event_type,
            "Pairs"
        );
        assert!(!String::from_utf8(fs::read(&path).unwrap())
            .unwrap()
            .contains("2026"));
        fs::write(&path, b"{corrupt}").unwrap();
        assert!(save_favourite(&path, favourite, true).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"{corrupt}");
    }
    #[test]
    fn naming_noop_metadata_only_edit_and_year_boundary_are_consistent() {
        let fixture = Fixture::new();
        let preview = fixture.preview();
        let plans = super::super::naming::build_event_naming_plans(&preview.request).unwrap();
        let plan = &plans[0];
        super::super::naming::apply_event_naming_plan_once(plan).unwrap();
        let description = preview.request.assignments[0]
            .event
            .as_ref()
            .unwrap()
            .description
            .clone();
        let same = preview_event_naming(
            fixture.0.to_string_lossy().into(),
            vec![plan.new_path.to_string_lossy().into()],
            description.clone(),
        )
        .unwrap();
        assert!(!same.changes[0].changed && !same.changes[0].replaces_existing);
        let mut metadata = description;
        metadata.people_tags.push("Rider".into());
        let mut updated = preview_event_naming(
            fixture.0.to_string_lossy().into(),
            vec![plan.new_path.to_string_lossy().into()],
            metadata,
        )
        .unwrap();
        assert_eq!(updated.changes[0].old_name, updated.changes[0].new_name);
        assert!(updated.changes[0].changed && updated.changes[0].replaces_existing);
        updated.request.assignments[0].replace_existing = true;
        let update = super::super::naming::build_event_naming_plans(&updated.request).unwrap();
        super::super::naming::apply_event_naming_plan_once(&update[0]).unwrap();
        assert_eq!(
            read_event(&plan.new_path)
                .unwrap()
                .0
                .unwrap()
                .description
                .people_tags,
            vec!["Rider"]
        );
        assert_eq!(
            period(&["2026-12-31".into(), "2027-01-01".into()]).unwrap(),
            "December 2026 & January 2027"
        );
        assert_eq!(
            period(&["2026-10-01".into(), "2026-12-01".into()]).unwrap(),
            "October & December 2026"
        );
    }
    #[test]
    fn naming_archive_lookup_rejects_ambiguous_dates_and_keeps_legacy_wording() {
        let fixture = Fixture::new();
        let month = fixture.0.join("2026/10");
        let named = month.join("24 - PoloX - Sale - Spring Carnival");
        fs::create_dir(&named).unwrap();
        let found = super::super::naming::matching_archive_day_directory(&fixture.0, 2026, 10, 24)
            .unwrap()
            .unwrap();
        assert_eq!(
            found.file_name().unwrap(),
            "24 - PoloX - Sale - Spring Carnival"
        );
        fs::create_dir(month.join("24 - A different event")).unwrap();
        assert!(
            super::super::naming::matching_archive_day_directory(&fixture.0, 2026, 10, 24)
                .unwrap_err()
                .contains("More than one")
        );
    }
    #[test]
    fn naming_old_requests_still_decode_and_targets_cannot_escape_a_folder() {
        let fixture = Fixture::new();
        let request: ApplyEventNamingRequest = serde_json::from_value(serde_json::json!({
            "directories":[fixture.0.join("2026/10/24").to_string_lossy()],
            "eventType":"Rally","location":"Monbulk"
        }))
        .unwrap();
        let plans = super::super::naming::build_event_naming_plans(&request).unwrap();
        assert_eq!(plans[0].new_name, "24 - Rally - Monbulk");
        assert!(plans[0].reviewed.is_none());
        let mut request = fixture.preview().request;
        request.reviewed_root = None;
        request.assignments[0].event = None;
        request.assignments[0].target_name = Some("../outside".into());
        assert!(super::super::naming::build_event_naming_plans(&request).is_err());
    }
    #[test]
    fn naming_corrupt_sidecars_and_parallel_writers_fail_without_changing_folders() {
        let fixture = Fixture::new();
        let first = naming_lease(&fixture.0).unwrap();
        assert!(naming_lease(&fixture.0).is_err());
        drop(first);
        let _second = naming_lease(&fixture.0).unwrap();
        let path = fixture.0.join("2026/10/24");
        fs::write(path.join(EVENT_FILE), b"{incomplete").unwrap();
        let rows =
            super::super::naming::list_event_day_directories(fixture.0.to_string_lossy().into())
                .unwrap();
        assert!(rows[0].warning.as_deref().unwrap().contains("Cannot read"));
        let description = EventDescription {
            event_group: "Rally".into(),
            ..Default::default()
        };
        assert!(preview_event_naming(
            fixture.0.to_string_lossy().into(),
            vec![path.to_string_lossy().into()],
            description
        )
        .is_err());
        assert_eq!(fs::read(path.join(EVENT_FILE)).unwrap(), b"{incomplete");
    }
    #[cfg(windows)]
    #[test]
    fn naming_rejects_linked_date_folders() {
        let fixture = Fixture::new();
        let other = Fixture::new();
        // A junction can be created without enabling Developer Mode.
        let link = fixture.0.join("2026/10/25");
        use std::os::windows::process::CommandExt;
        let output = std::process::Command::new("cmd.exe")
            .args(["/d", "/c"])
            .raw_arg(format!(
                "mklink /J \"{}\" \"{}\"",
                link.display(),
                other.0.join("2026/10/24").display()
            ))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "Junction fixture failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let result = checked_day(&fixture.0.canonicalize().unwrap(), &link);
        fs::remove_dir(&link).unwrap();
        assert!(result.unwrap_err().contains("Linked folders"));
    }
}
