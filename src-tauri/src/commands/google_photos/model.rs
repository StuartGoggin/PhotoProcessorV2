//! Local curation and frozen publishing contracts. Secrets never belong in these
//! frontend-facing models; the engine stores its credentials separately.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum PhotoVariant {
    Original,
    Bw,
    Enhanced,
    Crop,
    CropBw,
    CropEnhanced,
}

/// Acknowledges only durable local curation, without rescanning the library or
/// disclosing/reloading account state and cloud history.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionReceipt {
    pub asset_id: String,
    pub relative_path: String,
    pub selected: bool,
    pub favourite: bool,
    pub revision: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoAsset {
    pub id: String,
    pub relative_path: String,
    pub path: String,
    pub family_id: String,
    pub variant: PhotoVariant,
    pub bytes: u64,
    pub modified_ms: u64,
    pub selected: bool,
    pub favourite: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upload_status: Option<String>,
    pub stars: u8,
    pub trashed: bool,
    pub event_name: String,
    pub event_date: Option<String>,
    pub original_path: String,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalogue {
    pub root: String,
    pub revision: u64,
    pub assets: Vec<PhotoAsset>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SelectionMode {
    #[default]
    Checked,
    PreferredColour,
    Originals,
    Variants,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum AlbumMode {
    #[default]
    New,
    Continue,
}

fn exclude_trash() -> bool {
    true
}
fn group_events() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRequest {
    pub root: String,
    #[serde(default)]
    pub scope_dir: Option<String>,
    #[serde(default)]
    pub mode: SelectionMode,
    #[serde(default)]
    pub variants: Vec<PhotoVariant>,
    #[serde(default)]
    pub min_stars: u8,
    #[serde(default)]
    pub favourites_only: bool,
    #[serde(default = "exclude_trash")]
    pub exclude_trash: bool,
    #[serde(default)]
    pub strip_gps: bool,
    #[serde(default)]
    pub album_mode: AlbumMode,
    #[serde(default)]
    pub album_title: Option<String>,
    #[serde(default)]
    pub event_name: Option<String>,
    #[serde(default)]
    pub event_date: Option<String>,
    #[serde(default = "group_events")]
    pub group_by_event_day: bool,
}
impl Default for PlanRequest {
    fn default() -> Self {
        Self {
            root: String::new(),
            scope_dir: None,
            mode: SelectionMode::Checked,
            variants: vec![],
            min_stars: 0,
            favourites_only: false,
            exclude_trash: true,
            strip_gps: false,
            album_mode: AlbumMode::New,
            album_title: None,
            event_name: None,
            event_date: None,
            group_by_event_day: true,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanItemStatus {
    Ready,
    AlreadyUploaded,
    Changed,
    Unsupported,
    Missing,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    pub id: String,
    pub relative_path: String,
    pub variant: PhotoVariant,
    pub bytes: u64,
    pub status: PlanItemStatus,
    pub warnings: Vec<String>,
    pub path: String,
    pub original_path: String,
    pub source_sha256: String,
    pub original_sha256: String,
    pub modified_ms: u64,
    pub event_name: String,
    pub event_date: Option<String>,
    pub album_key: String,
    pub strip_gps: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanAlbum {
    pub key: String,
    pub title: String,
    pub date: Option<String>,
    pub album_id: Option<String>,
    pub item_ids: Vec<String>,
    pub cover_item_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanPreview {
    pub id: String,
    pub account_id: String,
    pub account_email: String,
    pub root: String,
    pub created_at: String,
    pub items: Vec<PlanItem>,
    pub albums: Vec<PlanAlbum>,
    pub warnings: Vec<String>,
    pub total_bytes: u64,
}

/// Engine-provided, already-decrypted account-specific receipt. Metadata policy
/// is part of the identity: stripping GPS must not accidentally reuse a prior
/// location-bearing upload.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub account_id: String,
    pub asset_id: String,
    pub source_sha256: String,
    #[serde(default)]
    pub original_sha256: String,
    #[serde(default)]
    pub metadata_recipe: u32,
    #[serde(default)]
    pub prepared_sha256: String,
    pub strip_gps: bool,
    pub album_key: String,
    pub album_id: String,
    pub media_item_id: String,
    /// Older ledger entries were written only after successful read-back.
    #[serde(default = "previous_receipts_were_verified")]
    pub readback_verified: bool,
    #[serde(default)]
    pub readback_rejected: bool,
}
fn previous_receipts_were_verified() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingAlbum {
    pub account_id: String,
    pub key: String,
    pub album_id: String,
    pub title: String,
}

#[derive(Debug, Clone, Default)]
pub struct PlanContext {
    pub id: String,
    pub account_id: String,
    pub account_email: String,
    pub ledger: Vec<LedgerEntry>,
    pub albums: Vec<ExistingAlbum>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_request_never_includes_trash_or_overrides_curation() {
        let request: PlanRequest = serde_json::from_str(r#"{"root":"C:/photos"}"#).unwrap();
        assert!(request.exclude_trash && request.group_by_event_day);
        assert_eq!(request.mode, SelectionMode::Checked);
        assert!(PlanRequest::default().exclude_trash);
    }
    #[test]
    fn public_variant_and_status_wire_names_are_stable() {
        assert_eq!(
            serde_json::to_string(&PhotoVariant::CropBw).unwrap(),
            "\"crop_bw\""
        );
        assert_eq!(
            serde_json::to_string(&SelectionMode::PreferredColour).unwrap(),
            "\"preferred_colour\""
        );
        assert_eq!(
            serde_json::to_string(&PlanItemStatus::AlreadyUploaded).unwrap(),
            "\"already_uploaded\""
        );
    }
}
