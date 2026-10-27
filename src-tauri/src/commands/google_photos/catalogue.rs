//! Read-only, bounded photo discovery with the same conservative source/variant
//! relationships as the Lightbox. Suffixes alone never prove ownership.
use super::{
    model::{Catalogue, PhotoAsset, PhotoVariant},
    store,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use walkdir::WalkDir;

const MAX_ASSETS: usize = 50_000;
const MAX_ENTRIES: usize = 200_000;

pub(crate) fn digest(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}
pub(crate) fn normalized(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
fn stem(path: &Path) -> String {
    path.file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}
fn extension(path: &Path) -> String {
    path.extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase()
}
fn jpeg(path: &Path) -> bool {
    matches!(extension(path).as_str(), "jpg" | "jpeg")
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
    )
}

fn recognized_tag(tag: &str) -> bool {
    let lower = tag.to_ascii_lowercase();
    lower == "trash"
        || lower
            .strip_prefix("like ")
            .is_some_and(|s| (1..=3).contains(&s.len()) && s.bytes().all(|b| b == b'o'))
        || lower
            .strip_prefix("out of focus ")
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}
pub(crate) fn untag(name: &str) -> String {
    let mut output = String::new();
    let mut remaining = name;
    while let Some(start) = remaining.find('{') {
        output.push_str(&remaining[..start]);
        let tail = &remaining[start + 1..];
        let Some(end) = tail.find('}') else {
            output.push_str(&remaining[start..]);
            return output;
        };
        if !recognized_tag(&tail[..end]) {
            output.push_str(&remaining[start..start + end + 2]);
        }
        remaining = &tail[end + 1..];
    }
    output.push_str(remaining);
    output
}
pub(crate) fn curation_key(path: &Path) -> String {
    format!("{}.{}", untag(&stem(path)).to_lowercase(), extension(path))
}
fn stars(path: &Path) -> u8 {
    let lower = stem(path).to_ascii_lowercase();
    for count in (1..=3).rev() {
        if lower.contains(&format!("{{like {}}}", "o".repeat(count))) {
            return count as u8;
        }
    }
    0
}
fn trashed(path: &Path) -> bool {
    stem(path).to_ascii_lowercase().contains("{trash}")
}
fn remove_variant(raw: &str, suffix: &str) -> Option<String> {
    // The current process can put rating tags before or after its suffix.
    let mut end = raw.len();
    while raw[..end].ends_with('}') {
        let Some(start) = raw[..end].rfind('{') else {
            break;
        };
        if !recognized_tag(&raw[start + 1..end - 1]) {
            break;
        }
        end = start;
    }
    if raw[..end].to_ascii_lowercase().ends_with(suffix) {
        return Some(format!("{}{}", &raw[..end - suffix.len()], &raw[end..]));
    }
    None
}

fn unique_source(
    files: &[PathBuf],
    child: usize,
    base: &str,
    raw_base: &str,
    candidates: impl Iterator<Item = usize>,
) -> Option<usize> {
    let candidates: Vec<usize> = candidates
        .filter(|&index| index != child && untag(&stem(&files[index])).eq_ignore_ascii_case(base))
        .collect();
    let exact: Vec<usize> = candidates
        .iter()
        .copied()
        .filter(|&index| stem(&files[index]).eq_ignore_ascii_case(raw_base))
        .collect();
    let exact_jpegs: Vec<usize> = exact
        .iter()
        .copied()
        .filter(|&index| jpeg(&files[index]))
        .collect();
    if exact_jpegs.len() == 1 {
        return Some(exact_jpegs[0]);
    }
    if exact_jpegs.len() > 1 {
        return None;
    }
    // Rating a JPEG can make an untagged same-stem RAW look like the only
    // exact-name match. Generated comparisons still belong to the unique JPEG
    // used by Photo Process, not that untouched RAW sibling.
    let jpegs: Vec<usize> = candidates
        .iter()
        .copied()
        .filter(|&index| jpeg(&files[index]))
        .collect();
    if jpegs.len() == 1 {
        return Some(jpegs[0]);
    }
    if jpegs.len() > 1 {
        return None;
    }
    let sources = if exact.is_empty() { candidates } else { exact };
    if sources.len() == 1 {
        Some(sources[0])
    } else {
        None
    }
}

fn event(path: &Path) -> (String, Option<String>) {
    let names: Vec<String> = path
        .components()
        .map(|p| p.as_os_str().to_string_lossy().into_owned())
        .collect();
    for triple in names.windows(3).rev() {
        let Some(year) = triple[0]
            .parse::<i32>()
            .ok()
            .filter(|n| (1900..=2200).contains(n))
        else {
            continue;
        };
        let Some(month) = triple[1].parse::<u32>().ok() else {
            continue;
        };
        let digits: String = triple[2]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if digits.len() > 2 {
            continue;
        }
        let Some(day) = digits.parse::<u32>().ok() else {
            continue;
        };
        if chrono::NaiveDate::from_ymd_opt(year, month, day).is_none() {
            continue;
        }
        let title = triple[2]
            .strip_prefix(&digits)
            .unwrap_or("")
            .trim_start_matches([' ', '-', '_'])
            .trim();
        return (
            if title.is_empty() {
                "Untitled event".into()
            } else {
                title.to_string()
            },
            Some(format!("{year:04}-{month:02}-{day:02}")),
        );
    }
    (
        path.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        None,
    )
}

pub fn scan(root: &Path) -> Result<Catalogue, String> {
    scan_with_types(root, false)
}

// Archive selection also preserves camera RAW formats that cannot be uploaded
// through Google Photos. Family/rating/curation semantics remain shared.
pub(crate) fn scan_for_archive(root: &Path) -> Result<Catalogue, String> {
    scan_with_types(root, true)
}

fn scan_with_types(root: &Path, archive: bool) -> Result<Catalogue, String> {
    scan_scope(root, archive, None)
}

/// Resolve a single frontend-relative photo without accepting traversal, links
/// or a path outside the original library root. No directory tree is scanned.
pub(crate) fn selection_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    if !root.is_absolute() || !root.is_dir() {
        return Err("Choose an existing absolute photo folder.".into());
    }
    store::reject_link(root)?;
    let root = root.canonicalize().map_err(|_| "Cannot resolve the photo folder.")?;
    let relative = relative_path.replace('\\', "/");
    if relative.is_empty() || relative.len() > 32_768 || relative.contains(':')
        || relative.split('/').any(|part| part.is_empty() || part == "." || part == "..")
        || relative.split('/').count() > 32
    {
        return Err("Invalid relative photo path; refresh the Lightbox.".into());
    }
    let mut path = root.clone();
    for part in relative.split('/') {
        path.push(part);
        store::reject_link(&path)?;
    }
    let path = path.canonicalize().map_err(|_| "The photo is no longer present; refresh the Lightbox.")?;
    if !path.starts_with(&root) || !path.is_file() || !photo(&path) {
        return Err("The selected photo is outside the library or unavailable.".into());
    }
    Ok(path)
}

pub(crate) fn scan_selection(root: &Path, relative_path: &str) -> Result<Catalogue, String> {
    let path = selection_path(root, relative_path)?;
    scan_scope(root, false, path.parent())
}

fn scan_scope(root: &Path, archive: bool, directory: Option<&Path>) -> Result<Catalogue, String> {
    let raw_epoch=super::super::raw_development::manifest::snapshot()?;
    if !root.is_absolute() || !root.is_dir() {
        return Err("Choose an existing absolute photo folder.".into());
    }
    store::reject_link(root)?;
    let root = root
        .canonicalize()
        .map_err(|_| "Cannot resolve the photo folder.")?;
    let mut folders: BTreeMap<PathBuf, Vec<PathBuf>> = BTreeMap::new();
    let mut warnings = Vec::new();
    let mut count = 0usize;
    let mut photo_count = 0usize;
    let scope = directory.unwrap_or(&root);
    if !scope.starts_with(&root) { return Err("Photo folder is outside the library.".into()); }
    store::reject_link(scope)?;
    let mut walker = WalkDir::new(scope)
        .follow_links(false)
        .max_depth(if directory.is_some() { 1 } else { 32 })
        .into_iter();
    while let Some(entry) = walker.next() {
        count += 1;
        if count > MAX_ENTRIES {
            return Err(
                "This photo scope exceeds the 200,000-entry scan limit; choose an event folder."
                    .into(),
            );
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                warnings.push("A folder could not be read; its photos are not included.".into());
                continue;
            }
        };
        if archive && entry.depth() > 0 && entry.file_type().is_dir() {
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if name.starts_with(".photogogo") || name == "_transfer_manifests" || name.ends_with(".partial") {
                walker.skip_current_dir();
                continue;
            }
        }
        if entry.file_type().is_symlink() || store::reject_link(entry.path()).is_err() {
            if entry.file_type().is_dir() {
                walker.skip_current_dir();
            }
            warnings
                .push("A symbolic link or reparse point was excluded from the photo scope.".into());
            continue;
        }
        let archive_raw = archive && matches!(extension(entry.path()).as_str(), "cr2"|"nef"|"arw"|"raf"|"orf"|"rw2");
        if !entry.file_type().is_file() || !(photo(entry.path()) || archive_raw) {
            continue;
        }
        if store::reject_link(entry.path()).is_err() {
            warnings.push("A reparse-point photo was excluded from the photo scope.".into());
            continue;
        }
        let path = entry
            .path()
            .canonicalize()
            .map_err(|_| "A photo disappeared during discovery; refresh the catalogue.")?;
        if !path.starts_with(&root) {
            return Err("A photo resolved outside the selected folder.".into());
        }
        photo_count += 1;
        if photo_count > MAX_ASSETS {
            return Err(
                "This photo scope exceeds 50,000 images; choose a smaller event folder.".into(),
            );
        }
        folders
            .entry(path.parent().unwrap().to_path_buf())
            .or_default()
            .push(path);
    }
    let mut assets = Vec::new();
    let mut revision = 0u64;
    for (directory, mut files) in folders {
        files.sort_by_key(|path| {
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_lowercase()
        });
        let curation = match store::load_curation(&directory) {
            Ok(value) => value,
            Err(message) => {
                warnings.push(message);
                continue;
            }
        };
        revision = revision.wrapping_add(curation.revision);
        let mut associations: HashMap<usize, (usize, PhotoVariant)> = HashMap::new();
        for (index, path) in files.iter().enumerate().filter(|(_, p)| jpeg(p)) {
            let clean = untag(&stem(path));
            for (suffix, variant) in [
                ("_bw", PhotoVariant::Bw),
                ("_improved", PhotoVariant::Enhanced),
            ] {
                let Some(base) = clean
                    .to_ascii_lowercase()
                    .strip_suffix(suffix)
                    .map(ToOwned::to_owned)
                else {
                    continue;
                };
                let raw_base = remove_variant(&stem(path), suffix).unwrap_or_default();
                if let Some(source) = unique_source(&files, index, &base, &raw_base, 0..files.len())
                {
                    associations.insert(index, (source, variant));
                }
            }
        }
        // The Lightbox gives an exact tagged-source variant precedence over old
        // untagged output names. Do not publish both stale and current versions.
        let owned_raw=super::super::raw_development::manifest::associations(&directory,&files)?;
        let retired_raw:HashSet<usize>=owned_raw.iter().filter(|(_,_,kind)|kind.starts_with("retired:")).map(|(index,_,_)|*index).collect();
        let owned_raw_indices:HashSet<usize>=owned_raw.iter().map(|(index,_,_)|*index).collect();
        for(index,source,kind)in &owned_raw{
            if kind.starts_with("retired:")&&!archive{continue}
            associations.insert(*index,(*source,if kind.ends_with("bw"){PhotoVariant::Bw}else{PhotoVariant::Enhanced}));
        }
        let mut comparison_groups = BTreeMap::<(usize, PhotoVariant), Vec<usize>>::new();
        for (&index, &(source, variant)) in &associations {
            if owned_raw_indices.contains(&index){continue}
            comparison_groups
                .entry((source, variant))
                .or_default()
                .push(index);
        }
        let mut suppressed = HashSet::new();
        for ((source, variant), children) in comparison_groups {
            if children.len() <= 1 {
                continue;
            }
            let suffix = if variant == PhotoVariant::Bw {
                "_bw"
            } else {
                "_improved"
            };
            let exact: Vec<_> = children
                .iter()
                .copied()
                .filter(|&index| {
                    remove_variant(&stem(&files[index]), suffix)
                        .is_some_and(|base| base.eq_ignore_ascii_case(&stem(&files[source])))
                })
                .collect();
            let preferred = if exact.is_empty() { &children } else { &exact };
            for &index in &children {
                if preferred.len() != 1 || preferred[0] != index {
                    suppressed.insert(index);
                }
            }
            warnings.push("Older or ambiguous duplicate generated versions were excluded, matching the Lightbox's current comparison selection.".into());
        }
        let entries: Vec<usize> = (0..files.len())
            .filter(|index| !associations.contains_key(index))
            .collect();
        let mut crops = HashMap::<usize, usize>::new();
        let mut crop_groups = HashMap::<usize, Vec<usize>>::new();
        for &index in &entries {
            if !jpeg(&files[index]) {
                continue;
            }
            let clean = untag(&stem(&files[index])).to_ascii_lowercase();
            let Some(base) = clean
                .strip_suffix("_crop")
                .filter(|base| !base.ends_with("_crop"))
            else {
                continue;
            };
            let raw_base = remove_variant(&stem(&files[index]), "_crop").unwrap_or_default();
            let candidates: Vec<usize> = entries
                .iter()
                .copied()
                .filter(|&i| jpeg(&files[i]))
                .collect();
            if let Some(owner) =
                unique_source(&files, index, base, &raw_base, candidates.into_iter())
            {
                crop_groups.entry(owner).or_default().push(index);
            }
        }
        for (owner, children) in crop_groups {
            if children.len() == 1 {
                crops.insert(children[0], owner);
            }
        }
        // One capture rating/trash state follows the RAW Lightbox entry. Upload
        // flags stay keyed to the exact physical version, never to its family.
        let pair_excluded: HashSet<usize> = associations.keys().chain(crops.keys()).copied().collect();
        let camera_raw: HashMap<usize,usize> = super::super::raw_development::capture::pairs(&files,&pair_excluded)
            .into_iter().map(|(raw,jpeg)|(jpeg,raw)).collect();
        let mut duplicate_keys = HashMap::<String, usize>::new();
        for (index, path) in files.iter().enumerate() {
            if retired_raw.contains(&index)&&!archive{continue}
            if suppressed.contains(&index) {
                continue;
            }
            *duplicate_keys.entry(curation_key(path)).or_default() += 1;
        }
        let (event_name, event_date) = event(&directory);
        for (index, path) in files.iter().enumerate() {
            if retired_raw.contains(&index)&&!archive{continue}
            if suppressed.contains(&index) {
                continue;
            }
            let (source, mut variant) = associations
                .get(&index)
                .copied()
                .unwrap_or((index, PhotoVariant::Original));
            let owner = crops.get(&source).copied().unwrap_or(source);
            let owner = camera_raw.get(&owner).copied().unwrap_or(owner);
            if crops.contains_key(&source) {
                variant = match variant {
                    PhotoVariant::Original => PhotoVariant::Crop,
                    PhotoVariant::Bw => PhotoVariant::CropBw,
                    PhotoVariant::Enhanced => PhotoVariant::CropEnhanced,
                    other => other,
                };
            }
            let relative = path
                .strip_prefix(&root)
                .map_err(|_| "A photo is outside the selected folder.")?;
            let parent = relative.parent().unwrap_or_else(|| Path::new(""));
            let neutral_key = curation_key(path);
            let ambiguous = duplicate_keys.get(&neutral_key).copied().unwrap_or(0) > 1;
            let stable_name = if ambiguous {
                path.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase()
            } else {
                neutral_key.clone()
            };
            let id = digest(
                format!(
                    "{}\0{}\0{stable_name}",
                    normalized(&root).to_lowercase(),
                    normalized(parent).to_lowercase()
                )
                .as_bytes(),
            );
            let family_id = digest(
                format!(
                    "{}\0{}\0{}",
                    normalized(&root).to_lowercase(),
                    normalized(parent).to_lowercase(),
                    curation_key(&files[owner])
                )
                .as_bytes(),
            );
            let flags = if ambiguous {
                None
            } else {
                curation.entries.get(&neutral_key)
            };
            let metadata = fs::metadata(path)
                .map_err(|_| "A photo disappeared during discovery; refresh the catalogue.")?;
            let modified_ms = metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|time| time.as_millis().min(u64::MAX as u128) as u64)
                .unwrap_or(0);
            let mut asset_warnings = Vec::new();
            if ambiguous {
                asset_warnings.push("Multiple rating-tagged names identify the same local version. Resolve the ambiguity before selecting this photo.".into());
            }
            if source == index
                && (untag(&stem(path)).to_ascii_lowercase().ends_with("_bw")
                    || untag(&stem(path))
                        .to_ascii_lowercase()
                        .ends_with("_improved"))
            {
                asset_warnings.push(
                    "No unique original was found; this orphan is treated as an independent photo."
                        .into(),
                );
            }
            assets.push(PhotoAsset {
                id,
                relative_path: normalized(relative),
                path: path.to_string_lossy().into_owned(),
                family_id,
                variant,
                bytes: metadata.len(),
                modified_ms,
                selected: flags.is_some_and(|flag| flag.selected),
                favourite: flags.is_some_and(|flag| flag.favourite),
                upload_status: None,
                stars: stars(path).max(stars(&files[owner])),
                trashed: trashed(path) || trashed(&files[owner]),
                event_name: event_name.clone(),
                event_date: event_date.clone(),
                original_path: files[owner].to_string_lossy().into_owned(),
                warnings: asset_warnings,
            });
        }
    }
    assets.sort_by(|a, b| {
        a.relative_path
            .to_lowercase()
            .cmp(&b.relative_path.to_lowercase())
    });
    let mut seen = HashSet::new();
    if assets.iter().any(|asset| !seen.insert(asset.id.clone())) {
        return Err("Ambiguous photo identifiers were found; narrow the folder scope.".into());
    }
    warnings.sort();
    warnings.dedup();
    super::super::raw_development::manifest::unchanged(raw_epoch)?;
    Ok(Catalogue {
        root: root.to_string_lossy().into_owned(),
        revision,
        assets,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    pub(super) fn fixture(files: &[&str]) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "pgg-google-catalogue-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        for file in files {
            let path = root.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"read-only image fixture").unwrap();
        }
        root
    }
    #[test]
    fn six_versions_and_raw_pair_keep_correct_lineage() {
        let root = fixture(&[
            "shot{Like oo}.JPEG",
            "shot.CR3",
            "shot_BW.jpg",
            "shot_improved.jpg",
            "shot_crop.jpg",
            "shot_crop_BW.jpg",
            "shot_crop_improved.jpg",
        ]);
        let catalogue = scan(&root).unwrap();
        assert_eq!(catalogue.assets.len(), 7);
        let crop_bw = catalogue
            .assets
            .iter()
            .find(|a| a.variant == PhotoVariant::CropBw)
            .unwrap();
        assert!(crop_bw.original_path.ends_with("shot{Like oo}.JPEG"));
        assert_eq!(crop_bw.stars, 2);
        let family = &crop_bw.family_id;
        assert_eq!(
            catalogue
                .assets
                .iter()
                .filter(|a| &a.family_id == family)
                .count(),
            6
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn curation_survives_rating_rename_and_generated_replacement() {
        let root = fixture(&["shot.jpg", "shot_BW.jpg"]);
        let first = scan(&root).unwrap();
        let bw = first
            .assets
            .iter()
            .find(|a| a.variant == PhotoVariant::Bw)
            .unwrap();
        store::set_selection(&root, &bw.id, Some(true), Some(true)).unwrap();
        fs::rename(root.join("shot_BW.jpg"), root.join("shot_BW{Like o}.jpg")).unwrap();
        fs::write(
            root.join("shot_BW{Like o}.jpg"),
            b"regenerated full resolution bytes",
        )
        .unwrap();
        let next = scan(&root).unwrap();
        let selected = next
            .assets
            .iter()
            .find(|a| a.variant == PhotoVariant::Bw)
            .unwrap();
        assert_eq!(selected.id, bw.id);
        assert!(selected.selected && selected.favourite);
        assert_eq!(selected.bytes, 33);
        assert!(
            !next
                .assets
                .iter()
                .find(|a| a.variant == PhotoVariant::Original)
                .unwrap()
                .selected
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn partial_curation_changes_preserve_the_other_flag() {
        let root = fixture(&["shot.jpg"]);
        let initial = scan(&root).unwrap();
        let id = &initial.assets[0].id;
        store::set_selection(&root, id, Some(true), None).unwrap();
        let favourite_only = store::set_selection(&root, id, None, Some(true)).unwrap();
        assert!(favourite_only.assets[0].selected && favourite_only.assets[0].favourite);
        let selection_only = store::set_selection(&root, id, Some(false), None).unwrap();
        assert!(!selection_only.assets[0].selected && selection_only.assets[0].favourite);
        let favourite_off = store::set_selection(&root, id, None, Some(false)).unwrap();
        assert!(!favourite_off.assets[0].selected && !favourite_off.assets[0].favourite);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn folder_move_keeps_portable_curation_but_not_cloud_identity() {
        let root = fixture(&["old/shot.jpg"]);
        let before = scan(&root).unwrap();
        store::set_selection(&root, &before.assets[0].id, Some(true), None).unwrap();
        fs::rename(root.join("old"), root.join("new")).unwrap();
        let after = scan(&root).unwrap();
        assert!(after.assets[0].selected);
        assert_ne!(before.assets[0].id, after.assets[0].id);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn ambiguous_ratings_never_share_a_selection() {
        let root = fixture(&["shot{Like o}.jpg", "shot{Like oo}.jpg", "shot_BW.jpg"]);
        let catalogue = scan(&root).unwrap();
        assert_eq!(
            catalogue
                .assets
                .iter()
                .filter(|a| a.variant == PhotoVariant::Original)
                .count(),
            3
        );
        assert!(catalogue
            .assets
            .iter()
            .filter(|a| a.relative_path.starts_with("shot{Like"))
            .all(|a| !a.warnings.is_empty()));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn calendar_date_comes_from_event_folder_not_filesystem_time() {
        let root = fixture(&["2026/10/25 - Championships - Sydney/horse.jpg"]);
        let catalogue = scan(&root).unwrap();
        assert_eq!(
            catalogue.assets[0].event_date.as_deref(),
            Some("2026-10-25")
        );
        assert_eq!(catalogue.assets[0].event_name, "Championships - Sydney");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unknown_brace_tags_are_preserved_in_identity() {
        assert_eq!(
            untag("horse{Like oo}{private-tag}{trash}"),
            "horse{private-tag}"
        );
        assert_eq!(untag("horse{Like oooo}"), "horse{Like oooo}");
    }
    #[test]
    fn exact_source_variant_wins_over_old_untagged_output() {
        let root = fixture(&[
            "shot{Like o}.jpg",
            "shot_BW.jpg",
            "shot{Like o}_BW.jpg",
            "shot_improved.jpg",
            "shot{Like o}_improved.jpg",
        ]);
        let catalogue = scan(&root).unwrap();
        assert_eq!(catalogue.assets.len(), 3);
        assert!(catalogue
            .assets
            .iter()
            .find(|asset| asset.variant == PhotoVariant::Bw)
            .unwrap()
            .path
            .ends_with("shot{Like o}_BW.jpg"));
        assert!(catalogue
            .assets
            .iter()
            .find(|asset| asset.variant == PhotoVariant::Enhanced)
            .unwrap()
            .path
            .ends_with("shot{Like o}_improved.jpg"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn corrupt_curation_is_not_overwritten_or_silently_reselected() {
        let root = fixture(&["shot.jpg"]);
        let first = scan(&root).unwrap();
        fs::write(
            root.join(".photogogo-curation.json"),
            b"corrupt, preserve this",
        )
        .unwrap();
        assert!(store::set_selection(&root, &first.assets[0].id, Some(true), None).is_err());
        assert_eq!(
            fs::read(root.join(".photogogo-curation.json")).unwrap(),
            b"corrupt, preserve this"
        );
        let catalogue = scan(&root).unwrap();
        assert!(catalogue.assets.is_empty());
        assert!(!catalogue.warnings.is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
#[path = "selection_tests.rs"]
mod selection_tests;
