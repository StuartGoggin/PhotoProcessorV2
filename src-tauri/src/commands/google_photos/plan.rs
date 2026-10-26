//! Pure publishing decisions plus bounded, streamed source fingerprints. No API
//! mutation occurs while preparing a reviewable, frozen plan.
use super::{catalogue, model::*, store};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::Read,
    path::{Component, Path, PathBuf},
    time::UNIX_EPOCH,
};

const MAX_PHOTO_BYTES: u64 = 200_000_000;
const MAX_ALBUM_ITEMS: usize = 20_000;

pub fn source_fingerprint(path: &Path) -> Result<(String, u64, u64), String> {
    store::reject_link(path)?;
    let mut file = File::open(path).map_err(|_| "The photo could not be opened.")?;
    let before = file
        .metadata()
        .map_err(|_| "The photo could not be inspected.")?;
    if !before.is_file() || before.len() == 0 || before.len() > MAX_PHOTO_BYTES {
        return Err("The photo is empty or exceeds Google's 200 MB upload limit.".into());
    }
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 256 * 1024];
    let mut bytes = 0u64;
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "The photo could not be read completely.")?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > MAX_PHOTO_BYTES {
            return Err("The photo grew beyond the upload safety limit.".into());
        }
        hash.update(&buffer[..count]);
    }
    let after = file
        .metadata()
        .map_err(|_| "The photo could not be rechecked.")?;
    if bytes != before.len()
        || after.len() != before.len()
        || after.modified().ok() != before.modified().ok()
    {
        return Err(
            "The photo changed while its upload fingerprint was being prepared. Refresh the plan."
                .into(),
        );
    }
    let modified_ms = before
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|t| t.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0);
    Ok((hex::encode(hash.finalize()), bytes, modified_ms))
}

fn valid_date(date: &str) -> bool {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .is_ok_and(|d| d.format("%Y-%m-%d").to_string() == date)
}
fn text(value: &str, name: &str, limit: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.encode_utf16().count() > limit
        || value.chars().any(char::is_control)
    {
        return Err(format!(
            "{name} must contain 1–{limit} characters without control characters."
        ));
    }
    Ok(value.into())
}
fn relative_scope(root: &Path, scope: Option<&str>) -> Result<PathBuf, String> {
    let Some(scope) = scope.filter(|s| !s.trim().is_empty()) else {
        return Ok(root.to_path_buf());
    };
    let path = Path::new(scope);
    if !path.is_absolute()
        && path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Photo scope must be a folder inside the selected root.".into());
    }
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    store::reject_link(&path)?;
    let scope = path
        .canonicalize()
        .map_err(|_| "The chosen photo scope no longer exists.")?;
    if !scope.is_dir() || !scope.starts_with(root) {
        return Err("Photo scope must be a folder inside the selected root.".into());
    }
    Ok(scope)
}
fn allowed(path: &Path) -> bool {
    matches!(
        path.extension()
            .unwrap_or_default()
            .to_string_lossy()
            .to_ascii_lowercase()
            .as_str(),
        "jpg" | "jpeg" | "png" | "avif" | "bmp" | "gif" | "heic" | "ico" | "tif" | "tiff" | "webp"
    )
}
fn rank(variant: PhotoVariant) -> u8 {
    match variant {
        PhotoVariant::CropEnhanced => 0,
        PhotoVariant::Crop => 1,
        PhotoVariant::Enhanced => 2,
        PhotoVariant::Original => 3,
        _ => 9,
    }
}

pub fn build(
    catalogue: &Catalogue,
    request: &PlanRequest,
    context: &PlanContext,
) -> Result<PlanPreview, String> {
    if context.id.is_empty() || context.account_id.is_empty() || context.account_email.is_empty() {
        return Err("Connect the intended Google account before preparing an upload plan.".into());
    }
    if request.min_stars > 3 {
        return Err("The minimum rating must be between 0 and 3 stars.".into());
    }
    let root = Path::new(&catalogue.root)
        .canonicalize()
        .map_err(|_| "The photo root is no longer available.")?;
    let request_root = Path::new(&request.root)
        .canonicalize()
        .map_err(|_| "The photo root is no longer available.")?;
    if request_root != root {
        return Err(
            "The photo catalogue belongs to a different root. Refresh it before publishing.".into(),
        );
    }
    let scope = relative_scope(&root, request.scope_dir.as_deref())?;
    let event_override = request
        .event_name
        .as_deref()
        .map(|s| text(s, "Event name", 240))
        .transpose()?;
    let date_override = request
        .event_date
        .as_deref()
        .map(|date| {
            if valid_date(date) {
                Ok(date.to_string())
            } else {
                Err("Event date must be a real calendar date in YYYY-MM-DD format.".to_string())
            }
        })
        .transpose()?;
    let title_override = request
        .album_title
        .as_deref()
        .filter(|title| !title.trim().is_empty())
        .map(|s| text(s, "Album title", 500))
        .transpose()?;
    if request.mode == SelectionMode::Variants && request.variants.is_empty() {
        return Err("Choose at least one version type for the upload override.".into());
    }
    let eligible: Vec<&PhotoAsset> = catalogue
        .assets
        .iter()
        .filter(|asset| {
            Path::new(&asset.path).starts_with(&scope)
                && (!request.exclude_trash || !asset.trashed)
                && asset.stars >= request.min_stars
                && (!request.favourites_only || asset.favourite)
        })
        .collect();
    let mut chosen = match request.mode {
        SelectionMode::Checked => eligible
            .into_iter()
            .filter(|asset| asset.selected)
            .collect::<Vec<_>>(),
        SelectionMode::Originals => eligible
            .into_iter()
            .filter(|asset| asset.variant == PhotoVariant::Original)
            .collect(),
        SelectionMode::Variants => eligible
            .into_iter()
            .filter(|asset| request.variants.contains(&asset.variant))
            .collect(),
        SelectionMode::PreferredColour => {
            let mut families = BTreeMap::<String, Vec<&PhotoAsset>>::new();
            for asset in eligible.into_iter().filter(|asset| rank(asset.variant) < 9) {
                families
                    .entry(asset.family_id.clone())
                    .or_default()
                    .push(asset);
            }
            families
                .into_values()
                .filter_map(|mut assets| {
                    assets.sort_by_key(|asset| rank(asset.variant));
                    assets.into_iter().next()
                })
                .collect()
        }
    };
    chosen.sort_by(|a, b| {
        a.relative_path
            .to_lowercase()
            .cmp(&b.relative_path.to_lowercase())
    });
    if chosen.is_empty() {
        return Err("No photos match this selection. Check Lightbox versions or change the upload override and filters.".into());
    }
    let mut items = Vec::new();
    let mut albums = BTreeMap::<String, PlanAlbum>::new();
    let mut warnings = catalogue.warnings.clone();
    if request.album_mode == AlbumMode::Continue {
        warnings.push("Continuing an album preserves its existing Google Photos sharing settings. Photos you add may be visible to people it is already shared with; check the target album before publishing.".into());
    }
    let distinct_events: HashSet<_> = chosen
        .iter()
        .map(|asset| (&asset.event_name, &asset.event_date))
        .collect();
    let multi_event = distinct_events.len() > 1;
    let mut original_hashes = HashMap::<PathBuf, String>::new();
    for asset in chosen {
        let event_name = event_override
            .clone()
            .unwrap_or_else(|| asset.event_name.clone());
        let event_date = date_override.clone().or_else(|| asset.event_date.clone());
        let group = if request.group_by_event_day {
            format!(
                "{event_name}\0{}",
                event_date.as_deref().unwrap_or("undated")
            )
        } else {
            "single-selection".into()
        };
        let album_key =
            catalogue::digest(format!("{}\0{group}", catalogue.root.to_lowercase()).as_bytes());
        let default_title =
            if !request.group_by_event_day && multi_event && event_override.is_none() {
                "PhotoGoGo selection".to_string()
            } else {
                event_name.clone()
            };
        let base = title_override.clone().unwrap_or(default_title);
        let title = if request.group_by_event_day && multi_event && title_override.is_some() {
            format!(
                "{base} — {event_name}{}",
                event_date
                    .as_ref()
                    .map(|d| format!(" — {d}"))
                    .unwrap_or_default()
            )
        } else if let Some(date) = &event_date {
            format!("{base} — {date}")
        } else {
            base
        };
        let title = text(&title, "Album title", 500)?;
        let prior_album = if request.album_mode == AlbumMode::Continue {
            context
                .albums
                .iter()
                .find(|album| album.account_id == context.account_id && album.key == album_key)
        } else {
            None
        };
        let title = if request.album_title.is_none()
            && request.event_name.is_none()
            && request.event_date.is_none()
        {
            prior_album.map(|a| a.title.clone()).unwrap_or(title)
        } else {
            title
        };
        let album = albums
            .entry(album_key.clone())
            .or_insert_with(|| PlanAlbum {
                key: album_key.clone(),
                title,
                date: event_date.clone(),
                album_id: prior_album.map(|a| a.album_id.clone()),
                item_ids: Vec::new(),
                cover_item_id: None,
            });
        if album.item_ids.len() >= MAX_ALBUM_ITEMS {
            return Err("Google Photos albums are limited to 20,000 items. Split this scope into event/day albums.".into());
        }
        album.item_ids.push(asset.id.clone());
        let mut item_warnings = asset.warnings.clone();
        let mut status = PlanItemStatus::Ready;
        let mut source_sha256 = String::new();
        let mut original_sha256 = String::new();
        let mut bytes = asset.bytes;
        let mut modified_ms = asset.modified_ms;
        let path = Path::new(&asset.path);
        if !allowed(path) {
            status = PlanItemStatus::Unsupported;
            item_warnings.push("This RAW type is not included in the validated upload formats. Choose its full-resolution JPEG version; no automatic conversion is performed.".into());
        } else if asset.bytes > MAX_PHOTO_BYTES || asset.bytes == 0 {
            status = PlanItemStatus::Unsupported;
            item_warnings.push("The photo is empty or larger than Google's 200 MB limit.".into());
        } else if asset
            .warnings
            .iter()
            .any(|warning| warning.starts_with("Multiple rating-tagged"))
        {
            status = PlanItemStatus::Blocked;
        } else {
            match path.canonicalize() {
                Err(_) => {
                    status = PlanItemStatus::Missing;
                    item_warnings.push("The photo is no longer available.".into());
                }
                Ok(canonical) if !canonical.starts_with(&root) => {
                    status = PlanItemStatus::Blocked;
                    item_warnings.push("The photo resolves outside the selected root.".into());
                }
                Ok(_) => match source_fingerprint(path) {
                    Ok((sha256, length, modified)) => {
                        source_sha256 = sha256;
                        bytes = length;
                        modified_ms = modified;
                        if length != asset.bytes || modified != asset.modified_ms {
                            status = PlanItemStatus::Blocked;
                            item_warnings.push("This photo changed after discovery. Refresh the catalogue and prepare the plan again.".into());
                        }
                    }
                    Err(message) => {
                        status = PlanItemStatus::Blocked;
                        item_warnings.push(message);
                    }
                },
            }
        }
        if matches!(status, PlanItemStatus::Ready) {
            let original = Path::new(&asset.original_path);
            match original.canonicalize() {
                Err(_) => {
                    status = PlanItemStatus::Blocked;
                    item_warnings.push("The metadata original is missing. Restore or relink it before publishing this version.".into());
                }
                Ok(canonical) if !canonical.starts_with(&root) => {
                    status = PlanItemStatus::Blocked;
                    item_warnings.push(
                        "The metadata original resolves outside the selected root. Upload refused."
                            .into(),
                    );
                }
                Ok(canonical) => {
                    if let Some(hash) = original_hashes.get(&canonical) {
                        original_sha256 = hash.clone();
                    } else if canonical
                        == path.canonicalize().map_err(|_| {
                            "The upload source disappeared while preparing its metadata lineage."
                        })?
                    {
                        original_sha256 = source_sha256.clone();
                        original_hashes.insert(canonical, original_sha256.clone());
                    } else {
                        match source_fingerprint(original) {
                            Ok((hash, _, _)) => {
                                original_sha256 = hash;
                                original_hashes.insert(canonical, original_sha256.clone());
                            }
                            Err(message) => {
                                status = PlanItemStatus::Blocked;
                                item_warnings.push(format!(
                                    "The metadata original could not be frozen: {message}"
                                ));
                            }
                        }
                    }
                }
            }
        }
        if matches!(status, PlanItemStatus::Ready) {
            let receipts: Vec<_> = context
                .ledger
                .iter()
                .filter(|entry| {
                    entry.account_id == context.account_id
                        && entry.asset_id == asset.id
                        && entry.album_key == album_key
                })
                .collect();
            if let Some(album_id) = &album.album_id {
                if let Some(receipt) = receipts.iter().find(|entry| {
                    !entry.readback_rejected
                        && &entry.album_id == album_id
                        && entry.source_sha256 == source_sha256
                        && entry.original_sha256 == original_sha256
                        && entry.metadata_recipe == 1
                        && entry.strip_gps == request.strip_gps
                }) {
                    status = PlanItemStatus::AlreadyUploaded;
                    if !receipt.readback_verified {
                        item_warnings.push("Previously accepted by Google; additional read-back was unavailable. The saved receipt is reused, not marked read-back verified.".into());
                    }
                } else if !receipts.is_empty() {
                    status = PlanItemStatus::Changed;
                    item_warnings.push("The local version, original metadata, metadata recipe or privacy policy differs from a previous upload. It will be added as a new Google Photos item, not replace the old image.".into());
                }
            }
        }
        if event_date.is_none() {
            item_warnings.push("No event shooting date was found in the folder name. Confirm the album date; the photo's embedded capture metadata remains authoritative.".into());
        }
        if asset.variant != PhotoVariant::Original {
            item_warnings.push("Generated photo: capture date and compatible colour metadata must be restored from its original in a private upload copy before publishing.".into());
        }
        items.push(PlanItem {
            id: asset.id.clone(),
            relative_path: asset.relative_path.clone(),
            variant: asset.variant,
            bytes,
            status,
            warnings: item_warnings,
            path: asset.path.clone(),
            original_path: asset.original_path.clone(),
            source_sha256,
            original_sha256,
            modified_ms,
            event_name,
            event_date,
            album_key,
            strip_gps: request.strip_gps,
        });
    }
    if request.album_mode == AlbumMode::Continue
        && albums.values().any(|album| album.album_id.is_none())
    {
        warnings.push("No previously app-created album was found for some event groups; those groups will create new albums.".into());
    }
    if items.iter().any(|item| {
        matches!(
            item.status,
            PlanItemStatus::Blocked | PlanItemStatus::Missing | PlanItemStatus::Unsupported
        )
    }) {
        warnings.push("Unavailable, unsupported or blocked photos will not be uploaded. Review each affected item before starting.".into());
    }
    let total_bytes = items
        .iter()
        .filter(|item| matches!(item.status, PlanItemStatus::Ready | PlanItemStatus::Changed))
        .try_fold(0u64, |total, item| total.checked_add(item.bytes))
        .ok_or("The upload size exceeds the supported range.")?;
    if total_bytes > 25_000_000 {
        warnings.push("Uploads use full-resolution original quality and count against your Google account storage. Confirm that enough storage is available in Google Photos.".into());
    }
    warnings.sort();
    warnings.dedup();
    Ok(PlanPreview {
        id: context.id.clone(),
        account_id: context.account_id.clone(),
        account_email: context.account_email.clone(),
        root: catalogue.root.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        items,
        albums: albums.into_values().collect(),
        warnings,
        total_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn fixture() -> (PathBuf, Catalogue, PlanRequest, PlanContext) {
        let root = std::env::temp_dir().join(format!(
            "pgg-google-plan-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        for file in [
            "shot.jpg",
            "shot_BW.jpg",
            "shot_improved.jpg",
            "shot_crop.jpg",
            "shot_crop_improved.jpg",
            "discard{trash}.jpg",
        ] {
            fs::write(root.join(file), file.as_bytes()).unwrap();
        }
        let catalogue = catalogue::scan(&root).unwrap();
        let request = PlanRequest {
            root: catalogue.root.clone(),
            mode: SelectionMode::PreferredColour,
            ..Default::default()
        };
        let context = PlanContext {
            id: "plan-test".into(),
            account_id: "account-A".into(),
            account_email: "test@example.test".into(),
            ..Default::default()
        };
        (root, catalogue, request, context)
    }
    #[test]
    fn preferred_colour_chooses_crop_enhanced_and_excludes_trash() {
        let (root, catalogue, request, context) = fixture();
        let plan = build(&catalogue, &request, &context).unwrap();
        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].variant, PhotoVariant::CropEnhanced);
        assert_eq!(plan.items[0].source_sha256.len(), 64);
        assert!(plan.items[0].original_path.ends_with("shot.jpg"));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn overrides_do_not_change_lightbox_flags() {
        let (root, catalogue, request, context) = fixture();
        assert!(catalogue.assets.iter().all(|a| !a.selected));
        build(&catalogue, &request, &context).unwrap();
        assert!(catalogue::scan(&root)
            .unwrap()
            .assets
            .iter()
            .all(|a| !a.selected));
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn ledger_requires_account_album_and_privacy_policy_match() {
        let (root, catalogue, mut request, mut context) = fixture();
        let first = build(&catalogue, &request, &context).unwrap();
        let item = &first.items[0];
        context.albums.push(ExistingAlbum {
            account_id: context.account_id.clone(),
            key: item.album_key.clone(),
            album_id: "album-A".into(),
            title: "Event".into(),
        });
        context.ledger.push(LedgerEntry {
            account_id: context.account_id.clone(),
            asset_id: item.id.clone(),
            source_sha256: item.source_sha256.clone(),
            original_sha256: item.original_sha256.clone(),
            metadata_recipe: 1,
            prepared_sha256: item.source_sha256.clone(),
            strip_gps: false,
            album_key: item.album_key.clone(),
            album_id: "album-A".into(),
            media_item_id: "media-A".into(),
            readback_verified: true,
            readback_rejected: false,
        });
        request.album_mode = AlbumMode::Continue;
        assert_eq!(
            build(&catalogue, &request, &context).unwrap().items[0].status,
            PlanItemStatus::AlreadyUploaded
        );
        request.strip_gps = true;
        assert_eq!(
            build(&catalogue, &request, &context).unwrap().items[0].status,
            PlanItemStatus::Changed
        );
        request.strip_gps = false;
        context.account_id = "account-B".into();
        assert_eq!(
            build(&catalogue, &request, &context).unwrap().items[0].status,
            PlanItemStatus::Ready
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn new_album_never_skips_previous_album_media() {
        let (root, catalogue, request, mut context) = fixture();
        let first = build(&catalogue, &request, &context).unwrap();
        let item = &first.items[0];
        context.ledger.push(LedgerEntry {
            account_id: context.account_id.clone(),
            asset_id: item.id.clone(),
            source_sha256: item.source_sha256.clone(),
            original_sha256: item.original_sha256.clone(),
            metadata_recipe: 1,
            prepared_sha256: item.source_sha256.clone(),
            strip_gps: false,
            album_key: item.album_key.clone(),
            album_id: "old".into(),
            media_item_id: "media".into(),
            readback_verified: true,
            readback_rejected: false,
        });
        let plan = build(&catalogue, &request, &context).unwrap();
        assert_eq!(plan.items[0].status, PlanItemStatus::Ready);
        assert!(plan.albums[0].album_id.is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn changed_after_scan_is_blocked_not_silently_frozen() {
        let (root, catalogue, request, context) = fixture();
        fs::write(root.join("shot_crop_improved.jpg"), b"changed bytes").unwrap();
        assert_eq!(
            build(&catalogue, &request, &context).unwrap().items[0].status,
            PlanItemStatus::Blocked
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn scope_escape_and_invalid_dates_are_rejected() {
        let (root, catalogue, mut request, context) = fixture();
        request.scope_dir = Some("../".into());
        assert!(build(&catalogue, &request, &context).is_err());
        request.scope_dir = None;
        request.event_date = Some("2026-02-30".into());
        assert!(build(&catalogue, &request, &context).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn checked_mode_preserves_independent_version_selections() {
        let (root, mut catalogue, mut request, context) = fixture();
        let bw = catalogue
            .assets
            .iter()
            .position(|a| a.variant == PhotoVariant::Bw)
            .unwrap();
        catalogue.assets[bw].selected = true;
        request.mode = SelectionMode::Checked;
        let plan = build(&catalogue, &request, &context).unwrap();
        assert_eq!(plan.items.len(), 1);
        assert_eq!(plan.items[0].variant, PhotoVariant::Bw);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn unchanged_derivative_with_changed_metadata_original_is_not_skipped() {
        let (root, catalogue, mut request, mut context) = fixture();
        let before = build(&catalogue, &request, &context).unwrap();
        let item = &before.items[0];
        context.albums.push(ExistingAlbum {
            account_id: context.account_id.clone(),
            key: item.album_key.clone(),
            album_id: "album-A".into(),
            title: "Event".into(),
        });
        context.ledger.push(LedgerEntry {
            account_id: context.account_id.clone(),
            asset_id: item.id.clone(),
            source_sha256: item.source_sha256.clone(),
            original_sha256: item.original_sha256.clone(),
            metadata_recipe: 1,
            prepared_sha256: item.source_sha256.clone(),
            strip_gps: false,
            album_key: item.album_key.clone(),
            album_id: "album-A".into(),
            media_item_id: "media-A".into(),
            readback_verified: true,
            readback_rejected: false,
        });
        request.album_mode = AlbumMode::Continue;
        assert_eq!(
            build(&catalogue, &request, &context).unwrap().items[0].status,
            PlanItemStatus::AlreadyUploaded
        );
        fs::write(
            root.join("shot.jpg"),
            b"original with corrected capture metadata",
        )
        .unwrap();
        let fresh = catalogue::scan(&root).unwrap();
        let after = build(&fresh, &request, &context).unwrap();
        assert_eq!(after.items[0].source_sha256, item.source_sha256);
        assert_ne!(after.items[0].original_sha256, item.original_sha256);
        assert_eq!(after.items[0].status, PlanItemStatus::Changed);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn legacy_receipt_without_metadata_recipe_cannot_silently_skip_upload() {
        let (root, catalogue, mut request, mut context) = fixture();
        let first = build(&catalogue, &request, &context).unwrap();
        let item = &first.items[0];
        context.albums.push(ExistingAlbum {
            account_id: context.account_id.clone(),
            key: item.album_key.clone(),
            album_id: "album-A".into(),
            title: "Event".into(),
        });
        let old: LedgerEntry = serde_json::from_value(serde_json::json!({"accountId":context.account_id,"assetId":item.id,"sourceSha256":item.source_sha256,"stripGps":false,"albumKey":item.album_key,"albumId":"album-A","mediaItemId":"old-media"})).unwrap();
        assert!(old.original_sha256.is_empty() && old.prepared_sha256.is_empty());
        assert_eq!(old.metadata_recipe, 0);
        context.ledger.push(old);
        request.album_mode = AlbumMode::Continue;
        assert_eq!(
            build(&catalogue, &request, &context).unwrap().items[0].status,
            PlanItemStatus::Changed
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn missing_or_outside_metadata_original_blocks_unchanged_derivative() {
        let (root, catalogue, request, context) = fixture();
        fs::remove_file(root.join("shot.jpg")).unwrap();
        assert_eq!(
            build(&catalogue, &request, &context).unwrap().items[0].status,
            PlanItemStatus::Blocked
        );
        let mut forged = catalogue.clone();
        for asset in &mut forged.assets {
            asset.original_path = std::env::temp_dir().to_string_lossy().into_owned();
        }
        assert_eq!(
            build(&forged, &request, &context).unwrap().items[0].status,
            PlanItemStatus::Blocked
        );
        fs::remove_dir_all(root).unwrap();
    }
}
