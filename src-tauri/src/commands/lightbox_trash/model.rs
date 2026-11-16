use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionRequest {
    pub staging_dir: String,
    pub relative_path: String,
    pub expected_source_stamp: String,
    pub action_id: String,
    pub trashed: bool,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReplayRequest {
    pub staging_dir: String,
    pub direction: String,
    pub action_id: String,
    pub expected_revision: Option<u64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub capture_path: String,
    pub label: String,
    pub before_trashed: bool,
    pub after_trashed: bool,
    pub before_reviewed: bool,
    pub after_reviewed: bool,
    pub outcome: String,
    pub can_undo: bool,
    pub can_redo: bool,
    pub created_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rename {
    pub old_path: String,
    pub new_path: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reviewed {
    pub root: String,
    pub relative_path: String,
    pub key: String,
    pub source_stamp: String,
    pub reviewed: bool,
    pub revision: u64,
    pub explicit: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub can_undo: bool,
    pub can_redo: bool,
    pub action_id: String,
    pub revision: u64,
    pub relative_path: String,
    pub renamed: Vec<Rename>,
    pub trashed: bool,
    pub reviewed: bool,
    pub source_stamp: String,
    pub entry: HistoryEntry,
    pub review: Reviewed,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    pub revision: u64,
    pub entries: Vec<HistoryEntry>,
    pub can_undo: bool,
    pub can_redo: bool,
    pub total: usize,
    pub next_offset: Option<usize>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub bytes: u64,
    pub modified: String,
    pub file_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Member {
    pub relative_path: String,
    pub capture_path: String,
    pub kind: String,
    pub bytes: u64,
    pub included: bool,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity: Option<Identity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub md5: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preview {
    pub folder_membership: std::collections::BTreeMap<String, Vec<String>>,
    pub review_revision: u64,
    pub id: String,
    pub staging_dir: String,
    pub relative_dir: String,
    pub recursive: bool,
    pub can_start: bool,
    pub items: Vec<Member>,
    pub capture_count: usize,
    pub file_count: usize,
    pub total_bytes: u64,
    pub warnings: Vec<String>,
}
