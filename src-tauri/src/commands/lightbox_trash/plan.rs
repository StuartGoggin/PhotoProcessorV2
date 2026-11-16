//! Frozen, fingerprinted candidate inventory. Ambiguity protects the family.
use super::{model::*, safety};
use crate::commands::{
    google_photos::{
        catalogue,
        model::{Catalogue, PhotoVariant},
    },
    raw_development::manifest,
};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};
struct Frozen {
    at: Instant,
    plan: Preview,
}
fn previews() -> &'static Mutex<HashMap<String, Frozen>> {
    static P: OnceLock<Mutex<HashMap<String, Frozen>>> = OnceLock::new();
    P.get_or_init(Default::default)
}
pub fn new_id() -> Result<String, String> {
    let mut b = [0u8; 24];
    getrandom::fill(&mut b).map_err(|_| "Cannot create safe job identity")?;
    Ok(format!("trash_{}", hex::encode(b)))
}
pub fn build(root_text: &str, dir: &str, recursive: bool) -> Result<Preview, String> {
    let root = safety::root(root_text)?;
    let revision = super::history::revision(&root)?;
    let membership = snapshot_scope(&root, dir, recursive)?;
    let scope = if dir.is_empty() {
        root.clone()
    } else {
        safety::scoped(&root, dir, false)?
    };
    if !scope.is_dir() {
        return Err("Choose a photo folder".into());
    }
    let cat = catalogue::scan_for_removal(&root, &scope, recursive)?;
    let mut preview = build_with_membership(root_text, dir, recursive, cat, membership)?;
    preview.review_revision = revision;
    Ok(preview)
}
pub(crate) fn build_from_catalogue(
    text: &str,
    dir: &str,
    recursive: bool,
    cat: Catalogue,
) -> Result<Preview, String> {
    let root = safety::root(text)?;
    let membership = snapshot_scope(&root, dir, recursive)?;
    build_with_membership(text, dir, recursive, cat, membership)
}
fn build_with_membership(
    text: &str,
    dir: &str,
    recursive: bool,
    cat: Catalogue,
    membership: std::collections::BTreeMap<String, Vec<String>>,
) -> Result<Preview, String> {
    let root = safety::root(text)?;
    let scope = if dir.is_empty() {
        root.clone()
    } else {
        safety::scoped(&root, dir, false)?
    };
    let groups: HashSet<_> = cat
        .assets
        .iter()
        .filter(|a| a.trashed && a.variant == PhotoVariant::Original)
        .map(|a| a.family_id.clone())
        .collect();
    let mut items = vec![];
    let mut warnings = cat.warnings.clone();
    let (mut bad, protected_candidates) = protect_ambiguous_crops(&cat, &groups, &root)?;
    let mut crop_proofs = HashMap::new();
    let mut ownership = HashMap::new();
    let mut seen = HashSet::new();
    for a in cat.assets.iter().filter(|a| groups.contains(&a.family_id)) {
        let p = safety::scoped(&root, &a.relative_path, true)?;
        if !p.starts_with(&scope) || (!recursive && p.parent() != Some(scope.as_path())) {
            return Err("Removal candidate escaped the reviewed folder".into());
        }
        let capture = safety::relative(&root, Path::new(&a.original_path))?;
        if ownership
            .insert(a.relative_path.to_lowercase(), a.family_id.clone())
            .is_some()
        {
            bad.insert(capture.clone());
        }
        let generated = a.variant != PhotoVariant::Original;
        let raw = p
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("cr3") || e.eq_ignore_ascii_case("dng"));
        let suspicious = a.warnings.iter().any(|w| !w.is_empty());
        let possible = p
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase();
        let orphan = !generated
            && (possible.ends_with("_bw")
                || possible.ends_with("_improved")
                || possible.ends_with("_crop"));
        if suspicious || orphan {
            bad.insert(capture.clone());
        }
        let mut media = safety::MediaFile::open(&root, &a.relative_path, false)?;
        let id = safety::id(&media.file)?;
        let (md5, sha) = safety::hash(&mut media.file)?;
        if !safety::same(&id, &safety::id(&media.file)?) {
            return Err("A candidate changed while inspecting Trash; refresh the preview".into());
        }
        let m = manifest::load(p.parent().ok_or("Photo parent missing")?)?;
        for record in m.records.values() {
            for o in &record.outputs {
                if catalogue::curation_key(Path::new(&o.file)) == catalogue::curation_key(&p)
                    && o.hash != sha
                {
                    bad.insert(capture.clone());
                    warnings.push("A developed RAW output differs from its ownership fingerprint; its capture is protected.".into());
                }
            }
        }
        if matches!(
            a.variant,
            PhotoVariant::Crop | PhotoVariant::CropBw | PhotoVariant::CropEnhanced
        ) {
            let proof = crop_proofs.entry(a.family_id.clone()).or_insert_with(|| {
                let sources = cat
                    .assets
                    .iter()
                    .filter(|source| {
                        source.family_id == a.family_id
                            && source.variant == PhotoVariant::Original
                            && Path::new(&source.path).extension().is_some_and(|e| {
                                e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg")
                            })
                    })
                    .collect::<Vec<_>>();
                if sources.len() != 1 {
                    return Err("Crop source is ambiguous".to_string());
                }
                crate::commands::lightbox_crop::removal_ownership(text, &sources[0].relative_path)
            });
            if !proof.as_ref().is_ok_and(|paths| paths.contains(&p)) {
                bad.insert(capture.clone());
                warnings.push("A crop is missing valid source/output ownership fingerprints; its camera originals are protected.".into());
            }
        }
        items.push(Member {
            relative_path: a.relative_path.clone(),
            capture_path: capture.clone(),
            kind: if raw {
                "camera_raw"
            } else if generated {
                "generated"
            } else {
                "camera_jpeg"
            }
            .into(),
            bytes: id.bytes,
            included: !suspicious && !orphan,
            reason: if suspicious || orphan {
                "Ambiguous or orphan source/derivative; review manually"
            } else {
                "Trashed capture and exact associated file"
            }
            .into(),
            identity: Some(id),
            sha256: Some(sha),
            md5: Some(md5),
        });
        seen.insert(a.relative_path.to_lowercase());
    }
    // Checksum and crop recipe sidecars have exact single-media ownership. They
    // never confer authority over an original or another same-stem capture.
    let mut sidecars = vec![];
    for item in &items {
        let path = safety::scoped(&root, &item.relative_path, true)?;
        let folder = path.parent().ok_or("Photo parent missing")?;
        let media_key = catalogue::curation_key(&path);
        for entry in std::fs::read_dir(folder).map_err(|e| e.to_string())? {
            let side = entry.map_err(|e| e.to_string())?.path();
            let n = side.file_name().unwrap_or_default().to_string_lossy();
            let owned_md5 = n
                .strip_suffix(".md5")
                .is_some_and(|base| catalogue::curation_key(Path::new(base)) == media_key);
            let owned_crop =
                side == path.with_extension("photogogo-crop.json") && item.kind == "generated";
            if !owned_md5 && !owned_crop {
                continue;
            }
            let rel = safety::relative(&root, &side)?;
            if !seen.insert(rel.to_lowercase()) {
                continue;
            }
            let mut f = safety::MediaFile::open(&root, &rel, false)?;
            let id = safety::id(&f.file)?;
            let (md5, sha) = safety::hash(&mut f.file)?;
            sidecars.push(Member {
                relative_path: rel,
                capture_path: item.capture_path.clone(),
                kind: "sidecar".into(),
                bytes: id.bytes,
                included: true,
                reason: "Exact per-file sidecar".into(),
                identity: Some(id),
                sha256: Some(sha),
                md5: Some(md5),
            });
        }
    }
    items.extend(sidecars);
    items.extend(protected_candidates);
    for i in &mut items {
        if bad.contains(&i.capture_path) {
            i.included = false;
            i.reason =
                "Capture protected because source/derivative ownership is ambiguous or changed"
                    .into();
        }
    }
    items.sort_by(|a, b| {
        a.capture_path
            .cmp(&b.capture_path)
            .then_with(|| rank(&a.kind).cmp(&rank(&b.kind)))
            .then_with(|| a.relative_path.cmp(&b.relative_path))
    });
    let capture_count = items
        .iter()
        .filter(|i| i.included)
        .map(|i| &i.capture_path)
        .collect::<HashSet<_>>()
        .len();
    let file_count = items.iter().filter(|i| i.included).count();
    let total_bytes = items.iter().filter(|i| i.included).map(|i| i.bytes).sum();
    if file_count == 0 {
        warnings.push("No safely removable trashed captures in this folder.".into())
    }
    Ok(Preview {
        folder_membership: membership,
        review_revision: super::history::revision(&root)?,
        id: new_id()?,
        staging_dir: text.into(),
        relative_dir: dir.into(),
        recursive,
        can_start: file_count > 0,
        items,
        capture_count,
        file_count,
        total_bytes,
        warnings,
    })
}

fn protected_member(
    asset: &crate::commands::google_photos::model::PhotoAsset,
    capture: String,
    reason: &str,
) -> Member {
    Member {
        relative_path: asset.relative_path.clone(),
        capture_path: capture,
        kind: "generated".into(),
        bytes: asset.bytes,
        included: false,
        reason: reason.into(),
        identity: None,
        sha256: None,
        md5: None,
    }
}

/// A possible crop relationship grants protection, never delete ownership.
fn protect_ambiguous_crops(
    cat: &Catalogue,
    groups: &HashSet<String>,
    root: &Path,
) -> Result<(HashSet<String>, Vec<Member>), String> {
    let mut bad = HashSet::new();
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();
    for asset in &cat.assets {
        if asset.trashed
            && asset.variant != PhotoVariant::Original
            && !groups.contains(&asset.family_id)
        {
            let capture = safety::relative(root, Path::new(&asset.original_path))?;
            seen.insert(asset.relative_path.clone());
            candidates.push(protected_member(
                asset,
                capture,
                "Only this generated version is tagged Trash; the camera original is not rejected",
            ));
        }
        if asset.variant != PhotoVariant::Original {
            continue;
        }
        let neutral = catalogue::curation_key(Path::new(&asset.relative_path));
        let stem = neutral.rsplit_once('.').map(|(s, _)| s).unwrap_or(&neutral);
        let Some(base) = stem.strip_suffix("_crop") else {
            continue;
        };
        for original in cat
            .assets
            .iter()
            .filter(|o| o.variant == PhotoVariant::Original && groups.contains(&o.family_id))
        {
            if Path::new(&asset.relative_path).parent()
                != Path::new(&original.relative_path).parent()
            {
                continue;
            }
            let key = catalogue::curation_key(Path::new(&original.relative_path));
            if key.rsplit_once('.').map(|(s, _)| s) != Some(base) {
                continue;
            }
            let capture = safety::relative(root, Path::new(&original.original_path))?;
            bad.insert(capture.clone());
            for child in cat.assets.iter().filter(|a| a.family_id == asset.family_id) {
                if seen.insert(child.relative_path.clone()) {
                    candidates.push(protected_member(
                        child,
                        capture.clone(),
                        "Ambiguous possible crop bundle; its possible camera original is protected",
                    ));
                }
            }
        }
    }
    Ok((bad, candidates))
}
pub(super) fn folder_membership(folder: &Path) -> Result<Vec<String>, String> {
    let mut names = vec![];
    for entry in
        std::fs::read_dir(folder).map_err(|_| "Cannot inspect removal folder membership")?
    {
        let entry = entry.map_err(|_| "Cannot inspect removal folder entry")?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.to_ascii_lowercase().starts_with(".photogogo") {
            continue;
        }
        if !entry
            .file_type()
            .map_err(|_| "Cannot inspect removal entry type")?
            .is_dir()
        {
            names.push(name);
        }
        if names.len() > 100_000 {
            return Err("Choose a smaller folder before removal".into());
        }
    }
    names.sort();
    Ok(names)
}
fn snapshot_scope(
    root: &Path,
    dir: &str,
    recursive: bool,
) -> Result<std::collections::BTreeMap<String, Vec<String>>, String> {
    let scope = if dir.is_empty() {
        root.to_path_buf()
    } else {
        safety::scoped(root, dir, false)?
    };
    let mut folders = std::collections::BTreeMap::new();
    let mut seen = 0;
    for entry in walkdir::WalkDir::new(&scope)
        .follow_links(false)
        .max_depth(if recursive { 33 } else { 1 })
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || !e
                    .file_name()
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .starts_with(".photogogo")
        })
    {
        let entry = entry.map_err(|_| "Cannot freeze removal folder membership")?;
        seen += 1;
        if seen > 200_000 {
            return Err("Choose a smaller removal scope (200,000 entries)".into());
        }
        if entry.file_type().is_dir() {
            if entry.depth() > 32 {
                return Err("Choose a narrower removal scope".into());
            }
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| "Removal folder outside staging")?
                .to_string_lossy()
                .replace('\\', "/");
            folders.insert(relative, folder_membership(entry.path())?);
            if !recursive {
                break;
            }
        }
        if folders.len() > 4096 {
            return Err("Choose a smaller removal scope".into());
        }
    }
    Ok(folders)
}
fn rank(kind: &str) -> u8 {
    match kind {
        "sidecar" => 0,
        "generated" => 1,
        "camera_jpeg" => 2,
        _ => 3,
    }
}
pub fn remember(plan: Preview) -> Result<Preview, String> {
    let mut p = previews()
        .lock()
        .map_err(|_| "Removal preview lock failed")?;
    p.retain(|_, v| v.at.elapsed() < Duration::from_secs(20 * 60));
    if p.len() >= 8 {
        if let Some(oldest) = p.iter().min_by_key(|(_, v)| v.at).map(|(k, _)| k.clone()) {
            p.remove(&oldest);
        }
    }
    p.insert(
        plan.id.clone(),
        Frozen {
            at: Instant::now(),
            plan: plan.clone(),
        },
    );
    Ok(plan)
}
pub fn take(id: &str) -> Result<Preview, String> {
    let mut p = previews()
        .lock()
        .map_err(|_| "Removal preview lock failed")?;
    let f = p
        .remove(id)
        .ok_or("Removal preview expired or was already used. Inspect Trash again.")?;
    if f.at.elapsed() > Duration::from_secs(20 * 60) {
        return Err("Removal preview expired; inspect again".into());
    }
    Ok(f.plan)
}
