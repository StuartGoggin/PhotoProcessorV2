//! Read-only archive selection. Only an unexpired native preview can admit a
//! transfer; callers never supply a file list or change the reviewed rules.
use super::google_photos::model::{PhotoAsset, PhotoVariant};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, UNIX_EPOCH},
};
use walkdir::WalkDir;

const MAX_ENTRIES: usize = 200_000;
const MAX_DEPTH: usize = 31; // The shared photo catalogue descends at most 32 levels.
const MAX_PREVIEWS: usize = 8;
const PREVIEW_LIFETIME: Duration = Duration::from_secs(20 * 60);

#[cfg(test)]
#[path = "archive_plan_tests.rs"]
mod tests;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectionMode {
    All,
    Rated,
    GoogleSelected,
    None,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub mode: SelectionMode,
    pub min_stars: u8,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rules {
    pub originals: Rule,
    pub bw: Rule,
    pub enhanced: Rule,
    pub crops: Rule,
    pub crop_bw: Rule,
    pub crop_enhanced: Rule,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub staging_dir: String,
    pub archive_dir: String,
    pub scope_dir: Option<String>,
    pub rules: Rules,
    pub exclude_trash: bool,
    pub include_videos: bool,
    pub include_source_originals: bool,
    pub include_library_metadata: bool,
    pub include_camera_sidecars: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub relative_path: String,
    pub kind: String,
    pub bytes: u64,
    pub included: bool,
    pub reason: String,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub kind: String,
    pub included_count: usize,
    pub excluded_count: usize,
    pub included_bytes: u64,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub included_count: usize,
    pub excluded_count: usize,
    pub included_bytes: u64,
    pub groups: Vec<Group>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub id: String,
    pub staging_dir: String,
    pub archive_dir: String,
    pub scope_dir: String,
    pub created_at: String,
    pub can_start: bool,
    pub summary: Summary,
    pub items: Vec<Item>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct Stamp {
    bytes: u64,
    modified: u128,
    created: Option<u128>,
}
#[derive(Clone)]
pub(super) struct FrozenPlan {
    request: Request,
    pub staging: PathBuf,
    pub archive: PathBuf,
    pub files: Vec<PathBuf>,
    stamps: HashMap<PathBuf, Stamp>,
    digest: String,
    pub preview: Preview,
    made_at: Instant,
}
fn previews() -> &'static Mutex<HashMap<String, FrozenPlan>> {
    static STORE: OnceLock<Mutex<HashMap<String, FrozenPlan>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(super) fn reject_link(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| format!("Cannot inspect '{}': {e}", path.display()))?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return Err(format!(
                "A reparse point is outside the safe archive scope: {}",
                path.display()
            ));
        }
    }
    if meta.file_type().is_symlink() {
        return Err(format!(
            "A symbolic link is outside the safe archive scope: {}",
            path.display()
        ));
    }
    Ok(())
}

/// Resolve a missing destination through its existing ancestors without writing.
pub(super) fn resolve(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|p| matches!(p, Component::ParentDir | Component::CurDir))
    {
        return Err("Choose an absolute folder without '.' or '..' components.".into());
    }
    let mut existing = path;
    let mut missing = Vec::new();
    while !existing.try_exists().map_err(|e| e.to_string())? {
        // A dangling link must not be mistaken for an ordinary missing folder.
        if fs::symlink_metadata(existing).is_ok() {
            reject_link(existing)?;
        }
        missing.push(
            existing
                .file_name()
                .ok_or("Cannot resolve archive folder.")?
                .to_owned(),
        );
        existing = existing.parent().ok_or("Cannot resolve archive parent.")?;
    }
    for ancestor in existing.ancestors() {
        reject_link(ancestor)?;
    }
    let mut result = existing.canonicalize().map_err(|e| e.to_string())?;
    for part in missing.into_iter().rev() {
        result.push(part);
    }
    Ok(result)
}

pub(super) fn relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.contains([':', '\0', '\n', '\r']) {
        return Err("Invalid archive relative path.".into());
    }
    let normalized = value.replace('\\', "/");
    if normalized.split('/').any(|part| {
        let stem = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                && stem.len() == 4
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    }) {
        return Err("Unsafe archive relative path.".into());
    }
    let path = PathBuf::from(normalized);
    if path
        .components()
        .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err("Archive paths must stay below the selected archive folder.".into());
    }
    Ok(path)
}

pub(super) fn safe_destination(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let joined = root.join(relative_path(relative)?);
    let resolved = resolve(&joined)?;
    if !resolved.starts_with(root) || resolved == root {
        return Err("Archive destination escaped the selected folder.".into());
    }
    Ok(resolved)
}

fn stamp(path: &Path) -> Result<Stamp, String> {
    reject_link(path)?;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("An archive source is no longer a regular file. Refresh the preview.".into());
    }
    Ok(Stamp {
        bytes: meta.len(),
        modified: meta
            .modified()
            .map_err(|e| e.to_string())?
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos(),
        created: meta
            .created()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|t| t.as_nanos()),
    })
}
fn name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase()
}
fn extension(path: &Path) -> String {
    path.extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase()
}
fn normalized(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
fn photo(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "jpg"
            | "jpeg"
            | "png"
            | "cr3"
            | "dng"
            | "avif"
            | "bmp"
            | "gif"
            | "heic"
            | "ico"
            | "tif"
            | "tiff"
            | "webp"
            | "cr2"
            | "nef"
            | "arw"
            | "raf"
            | "orf"
            | "rw2"
    )
}
fn video(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "mp4" | "mov" | "mkv" | "avi" | "mts" | "m2ts" | "m4v" | "mpg" | "mpeg" | "webm"
    )
}
fn library_metadata(path: &Path) -> bool {
    let n = name(path);
    matches!(
        n.as_str(),
        ".photogogo-curation.json"
              | ".photogogo-raw.json"
            | ".photogogo-event.json"
            | ".photogogo.staging-tags.json"
            | ".faces_db.json"
    ) || n.ends_with(".photogogo-crop.json")
        || n.ends_with(".snapshot.json")
        || (n.starts_with("import-job-") && n.ends_with(".manifest.jsonl"))
}
fn internal(path: &Path, scope: &Path) -> bool {
    let relative = path.strip_prefix(scope).unwrap_or(path);
    // This also excludes media-looking files in backup/cache/work folders.
    relative.components().any(|c| {
        let n = c.as_os_str().to_string_lossy().to_ascii_lowercase();
        n.starts_with(".photogogo") || n == "_transfer_manifests" || n.ends_with(".partial")
    }) || {
        let n = name(path);
        n.contains(".pgg.")
            || n.ends_with(".pgg")
            || n.contains(".pgg-")
            || n.ends_with(".partial.json")
            || n == "checksums.md5"
            || n == "master_hashes.md5"
            || n.ends_with(".md5")
            || n.ends_with(".hash")
            || n.ends_with(".log")
    }
}
fn possible_derivative(path: &Path) -> bool {
    let s = super::google_photos::archive_untag(
        &path.file_stem().unwrap_or_default().to_string_lossy(),
    )
    .to_ascii_lowercase();
    s.ends_with("_bw") || s.ends_with("_improved") || s.ends_with("_crop")
}
fn rule<'a>(rules: &'a Rules, variant: PhotoVariant) -> (&'static str, &'a Rule) {
    match variant {
        PhotoVariant::Original => ("originals", &rules.originals),
        PhotoVariant::Bw => ("bw", &rules.bw),
        PhotoVariant::Enhanced => ("enhanced", &rules.enhanced),
        PhotoVariant::Crop => ("crops", &rules.crops),
        PhotoVariant::CropBw => ("crop_bw", &rules.crop_bw),
        PhotoVariant::CropEnhanced => ("crop_enhanced", &rules.crop_enhanced),
    }
}
fn decision(request: &Request, asset: &PhotoAsset) -> (String, bool, String) {
    let (kind, rule) = rule(&request.rules, asset.variant);
    let (included, reason) = if request.exclude_trash && asset.trashed {
        (false, "Trashed photo or original")
    } else if !asset.warnings.is_empty()
        || (asset.variant == PhotoVariant::Original && possible_derivative(Path::new(&asset.path)))
    {
        (
            false,
            "Unresolved original/version relationship; review in Lightbox",
        )
    } else {
        match rule.mode {
            SelectionMode::All => (true, "All versions of this type"),
            SelectionMode::None => (false, "Version type excluded"),
            SelectionMode::GoogleSelected if asset.selected => {
                (true, "Marked for Google Photos in Lightbox")
            }
            SelectionMode::GoogleSelected => (false, "Not marked for Google Photos"),
            SelectionMode::Rated if asset.stars >= rule.min_stars => {
                (true, "Meets minimum Lightbox rating")
            }
            SelectionMode::Rated => (false, "Below minimum Lightbox rating"),
        }
    };
    (kind.into(), included, reason.into())
}

fn roots(request: &Request) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let stage = resolve(Path::new(&request.staging_dir))?;
    let archive = resolve(Path::new(&request.archive_dir))?;
    if !stage.is_dir() {
        return Err("Choose an existing staging folder.".into());
    }
    if archive.exists() && !archive.is_dir() {
        return Err("Archive destination must be a folder.".into());
    }
    if stage.starts_with(&archive) || archive.starts_with(&stage) {
        return Err(
            "Staging and archive folders must be separate and cannot contain one another.".into(),
        );
    }
    let scope = match request
        .scope_dir
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        Some(value) => resolve(Path::new(value))?,
        None => stage.clone(),
    };
    if !scope.is_dir() || !scope.starts_with(&stage) {
        return Err("Choose an existing event or folder inside staging.".into());
    }
    if scope.strip_prefix(&stage).unwrap().components().any(|c| {
        let n = c.as_os_str().to_string_lossy().to_ascii_lowercase();
        n.starts_with(".photogogo") || n == "_transfer_manifests" || n.ends_with(".partial")
    }) {
        return Err(
            "Choose a media folder, not a PhotoGoGo cache, backup or working folder.".into(),
        );
    }
    Ok((stage, archive, scope))
}

fn build(request: Request) -> Result<FrozenPlan, String> {
    let raw_epoch=super::raw_development::manifest::snapshot()?;
    for r in [
        &request.rules.originals,
        &request.rules.bw,
        &request.rules.enhanced,
        &request.rules.crops,
        &request.rules.crop_bw,
        &request.rules.crop_enhanced,
    ] {
        if !(1..=3).contains(&r.min_stars) {
            return Err("Minimum archive rating must be between 1 and 3 stars.".into());
        }
    }
    let (staging, archive, scope) = roots(&request)?;
    let mut inventory = BTreeMap::new();
    for (count, entry) in WalkDir::new(&scope)
        .follow_links(false)
        .into_iter()
        .enumerate()
    {
        if count >= MAX_ENTRIES {
            return Err(
                "Archive scope exceeds 200,000 entries. Choose a smaller event folder.".into(),
            );
        }
        let entry = entry.map_err(|e| format!("Archive preview is incomplete: {e}"))?;
        if entry.depth() > MAX_DEPTH {
            return Err("Archive scope is too deeply nested. Choose a smaller folder.".into());
        }
        reject_link(entry.path())?;
        if entry.file_type().is_file() {
            let path = entry.path().to_path_buf();
            inventory.insert(path.clone(), stamp(&path)?);
        }
    }
    let catalogue = super::google_photos::scan_archive_photos(&scope)?;
    let mut warnings = catalogue.warnings.clone();
    let incomplete = warnings
        .iter()
        .any(|w| !w.starts_with("Older or ambiguous duplicate generated"));
    if incomplete {
        warnings.push("Library metadata could not be read completely. Repair the reported issue and refresh before archiving.".into());
    }
    let assets: HashMap<PathBuf, &PhotoAsset> = catalogue
        .assets
        .iter()
        .map(|a| (PathBuf::from(&a.path), a))
        .collect();
    let mut items = Vec::with_capacity(inventory.len());
    let mut by_path = HashMap::new();
    for (path, st) in &inventory {
        let (kind, included, reason) = if library_metadata(path)
            && !path
                .strip_prefix(&scope)
                .unwrap()
                .parent()
                .is_some_and(|p| internal(p, &scope))
        {
            (
                "library_metadata".into(),
                request.include_library_metadata,
                if request.include_library_metadata {
                    "Library metadata backup enabled"
                } else {
                    "PhotoGoGo library metadata excluded"
                }
                .into(),
            )
        } else if internal(path, &scope) {
            (
                "app_working_files".into(),
                false,
                "PhotoGoGo cache, preview, log, checksum or temporary file".into(),
            )
        } else if let Some(asset) = assets.get(path) {
            decision(&request, asset)
        } else if photo(path) {
            (
                "unresolved".into(),
                false,
                "Not uniquely classified by the Lightbox catalogue; review before archiving".into(),
            )
        } else if video(path) {
            let trash = name(path).contains("{trash}");
            (
                "videos".into(),
                request.include_videos && !(request.exclude_trash && trash),
                if request.exclude_trash && trash {
                    "Trashed video"
                } else if request.include_videos {
                    "Videos included"
                } else {
                    "Videos excluded"
                }
                .into(),
            )
        } else {
            (
                "other".into(),
                false,
                "Unrecognised file; not selected as media or a paired sidecar".into(),
            )
        };
        by_path.insert(path.clone(), items.len());
        items.push(Item {
            relative_path: normalized(path.strip_prefix(&staging).map_err(|e| e.to_string())?),
            kind,
            bytes: st.bytes,
            included,
            reason,
        });
    }
    if request.include_source_originals {
        let owners: HashSet<PathBuf> = assets
            .iter()
            .filter(|(p, a)| items[by_path[*p]].included && a.variant != PhotoVariant::Original)
            .map(|(_, a)| PathBuf::from(&a.original_path))
            .collect();
        for owner in owners {
            if let (Some(&index), Some(asset)) = (by_path.get(&owner), assets.get(&owner)) {
                if !(request.exclude_trash && asset.trashed) && asset.warnings.is_empty() {
                    items[index].included = true;
                    items[index].reason = "Source original retained for a selected version".into();
                }
            }
        }
    }
    // User/camera sidecars follow the exact selected media basename or stem.
    // Never globally discard JSON/XMP, or guess between several source stems.
    if request.include_camera_sidecars {
        let mut media_keys: HashMap<(PathBuf, String), Vec<PathBuf>> = HashMap::new();
        for path in inventory
            .keys()
            .filter(|p| (photo(p) || video(p)) && !internal(p, &scope))
        {
            let parent = path.parent().unwrap().to_path_buf();
            let keys: HashSet<_> = [
                name(path),
                path.file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_ascii_lowercase(),
            ]
            .into_iter()
            .map(|s| super::google_photos::archive_untag(&s).to_ascii_lowercase())
            .collect();
            for key in keys {
                media_keys
                    .entry((parent.clone(), key))
                    .or_default()
                    .push(path.clone());
            }
        }
        for path in inventory.keys() {
            let index = by_path[path];
            if items[index].kind != "other"
                || !matches!(
                    extension(path).as_str(),
                    "xmp" | "aae" | "json" | "dop" | "pp3" | "thm"
                )
            {
                continue;
            }
            let base = super::google_photos::archive_untag(
                &path.file_stem().unwrap_or_default().to_string_lossy(),
            )
            .to_ascii_lowercase();
            let candidates = media_keys.get(&(path.parent().unwrap().to_path_buf(), base));
            items[index].kind = "camera_sidecars".into();
            items[index].included =
                candidates.is_some_and(|paths| paths.iter().any(|p| items[by_path[p]].included));
            items[index].reason = if candidates.is_none() {
                "No matching media for sidecar"
            } else if items[index].included {
                "Sidecar accompanies selected media"
            } else {
                "Matching media excluded"
            }
            .into();
        }
    }
    let mut summary = Summary::default();
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    for item in &items {
        let group = groups.entry(item.kind.clone()).or_insert_with(|| Group {
            kind: item.kind.clone(),
            ..Group::default()
        });
        if item.included {
            summary.included_count += 1;
            summary.included_bytes += item.bytes;
            group.included_count += 1;
            group.included_bytes += item.bytes;
        } else {
            summary.excluded_count += 1;
            group.excluded_count += 1;
        }
    }
    summary.groups = groups.into_values().collect();
    let files = inventory
        .keys()
        .filter(|p| items[by_path[*p]].included)
        .cloned()
        .collect::<Vec<_>>();
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(&request).map_err(|e| e.to_string())?);
    // Decisions, identities and curation bytes, including excluded metadata,
    // invalidate a preview. Rapidly changing operational logs are irrelevant.
    for (path, st) in &inventory {
        if items[by_path[path]].kind == "app_working_files" {
            continue;
        }
        hasher.update(normalized(path));
        hasher.update(serde_json::to_vec(st).map_err(|e| e.to_string())?);
        if name(path).starts_with(".photogogo") && library_metadata(path) {
            if st.bytes > 16 * 1024 * 1024 {
                return Err("Library metadata is too large to validate safely.".into());
            }
            hasher.update(fs::read(path).map_err(|e| e.to_string())?);
        }
    }
    let reviewed_items: Vec<_> = items
        .iter()
        .filter(|item| item.kind != "app_working_files")
        .collect();
    hasher.update(serde_json::to_vec(&reviewed_items).map_err(|e| e.to_string())?);
    let digest = hex::encode(hasher.finalize());
    let preview = Preview {
        id: String::new(),
        staging_dir: staging.to_string_lossy().into_owned(),
        archive_dir: archive.to_string_lossy().into_owned(),
        scope_dir: scope.to_string_lossy().into_owned(),
        created_at: chrono::Local::now().to_rfc3339(),
        can_start: !incomplete && !files.is_empty(),
        summary,
        items,
        warnings,
    };
    super::raw_development::manifest::unchanged(raw_epoch)?;
    Ok(FrozenPlan {
        request,
        staging,
        archive,
        files,
        stamps: inventory.into_iter().collect(),
        digest,
        preview,
        made_at: Instant::now(),
    })
}

pub fn preview(request: Request) -> Result<Preview, String> {
    let mut plan = build(request)?;
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|_| "Cannot create archive preview identity.")?;
    plan.preview.id = hex::encode(bytes);
    let result = plan.preview.clone();
    let mut store = previews()
        .lock()
        .map_err(|_| "Archive previews unavailable.")?;
    store.retain(|_, p| p.made_at.elapsed() < PREVIEW_LIFETIME);
    while store.len() >= MAX_PREVIEWS
        || store.values().map(|p| p.preview.items.len()).sum::<usize>() + plan.preview.items.len()
            > MAX_ENTRIES
    {
        if let Some(oldest) = store
            .iter()
            .min_by_key(|(_, p)| p.made_at)
            .map(|(id, _)| id.clone())
        {
            store.remove(&oldest);
        } else {
            break;
        }
    }
    store.insert(result.id.clone(), plan);
    Ok(result)
}

pub(super) fn take(id: &str, staging: &str, archive: &str) -> Result<FrozenPlan, String> {
    let plan = previews()
        .lock()
        .map_err(|_| "Archive previews unavailable.")?
        .remove(id)
        .ok_or("Preview the archive selection again before queuing.")?;
    if plan.made_at.elapsed() >= PREVIEW_LIFETIME
        || !plan.preview.can_start
        || resolve(Path::new(staging))? != plan.staging
        || resolve(Path::new(archive))? != plan.archive
    {
        return Err("Archive preview expired or destination changed. Refresh the preview.".into());
    }
    plan.revalidate()?;
    Ok(plan)
}

impl FrozenPlan {
    pub(super) fn write_receipt(&self, path: &Path) -> Result<(), String> {
        use std::io::Write;
        let relative = path
            .strip_prefix(&self.archive)
            .map_err(|_| "Selection receipt escaped its archive.")?;
        safe_destination(&self.archive, &normalized(relative))?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        let receipt = serde_json::json!({"schemaVersion":1,"state":"reviewed_selection", "rules": &self.request, "preview": &self.preview});
        serde_json::to_writer_pretty(&mut file, &receipt).map_err(|e| e.to_string())?;
        file.write_all(b"\n").map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())
    }
    pub(super) fn policy_description(&self) -> Result<String, String> {
        // The compact request is a durable selection receipt in the standard
        // job log. It contains local policy only, never credentials or sessions.
        serde_json::to_string(&self.request).map_err(|e| e.to_string())
    }
    /// Legacy sidecars have no trustworthy freshness identity. Fresh hashes stop
    /// a modified source being deduplicated against its previously archived bytes.
    pub(super) fn hash_source(&self, path: &Path) -> Result<String, String> {
        self.check_source(path)?;
        let hash = crate::utils::compute_md5(path).map_err(|e| e.to_string())?;
        self.check_source(path)?;
        Ok(hash)
    }
    pub(super) fn copy_verified(
        &self,
        source: &Path,
        destination: &Path,
        expected_hash: &str,
        mut checkpoint: impl FnMut() -> Result<(), String>,
    ) -> Result<u64, String> {
        use md5::Md5;
        let bytes = self.check_source(source)?;
        let relative = destination
            .strip_prefix(&self.archive)
            .map_err(|_| "Archive destination is outside its root.")?;
        safe_destination(&self.archive, &normalized(relative))?;
        let mut hasher = Md5::new();
        let mut staged = super::import_safety::stage_copy(
            source,
            destination.parent().ok_or("Missing archive parent.")?,
            bytes,
            |chunk| {
                checkpoint()?;
                hasher.update(chunk);
                Ok(())
            },
        )?;
        if hex::encode(hasher.finalize()) != expected_hash {
            return Err(
                "Source bytes changed after archive hashing; no new file published.".into(),
            );
        }
        self.check_source(source)?;
        staged.verify(expected_hash, |p| {
            crate::utils::compute_md5(p).map_err(|e| e.to_string())
        })?;
        checkpoint()?;
        safe_destination(&self.archive, &normalized(relative))?;
        staged.publish(destination)?;
        Ok(bytes)
    }
    pub(super) fn revalidate(&self) -> Result<(), String> {
        let current = build(self.request.clone())?;
        if current.digest != self.digest || !current.preview.can_start {
            return Err("Files, ratings or selections changed after the preview. Refresh the archive preview.".into());
        }
        Ok(())
    }
    pub(super) fn check_source(&self, path: &Path) -> Result<u64, String> {
        for ancestor in path
            .ancestors()
            .take_while(|p| p.starts_with(&self.staging))
        {
            reject_link(ancestor)?;
        }
        let expected = self
            .stamps
            .get(path)
            .ok_or("File is absent from the reviewed archive plan.")?;
        if stamp(path)? != *expected {
            return Err(format!(
                "Archive source changed after preview: {}. Refresh before retrying.",
                path.display()
            ));
        }
        Ok(expected.bytes)
    }
}
