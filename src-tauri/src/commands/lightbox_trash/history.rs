//! Append-only intents/results. Preserve exact source and Reviewed guards.
use super::{model::*, safety};
use crate::commands::{
    files,
    google_photos::{catalogue::curation_key, store},
    lightbox_review::{self, ReviewEntry},
    raw_development::capture,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
const JOURNAL: &str = ".photogogo-trash-history.jsonl";
static LANE: Mutex<()> = Mutex::new(());
fn rejected(error: impl std::fmt::Display) -> String {
    format!("[Review rejected before acceptance] {error}")
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Operation {
    token: String,
    kind: String,
    target: Option<String>,
    root: String,
    canonical_old: String,
    canonical_new: String,
    anchor_old: String,
    anchor_new: String,
    canonical_id: Identity,
    anchor_id: Identity,
    before_review: Option<ReviewEntry>,
    after_review: Option<ReviewEntry>,
    before_trashed: bool,
    after_trashed: bool,
    before_reviewed: bool,
    after_reviewed: bool,
    created_at: String,
}
#[derive(Serialize, Deserialize)]
#[serde(tag = "event", deny_unknown_fields)]
enum Event {
    Intent {
        op: Operation,
    },
    Done {
        token: String,
        receipt: Receipt,
    },
    Purged {
        identities: Vec<Identity>,
    },
    Removal {
        targets: Vec<String>,
        finished: bool,
        removed: bool,
    },
}
#[derive(Clone, Default)]
struct State {
    revision: u64,
    pending: HashMap<String, Operation>,
    receipts: HashMap<String, Receipt>,
    actions: Vec<(Operation, Receipt)>,
    operations: Vec<(Operation, Receipt)>,
    timeline: Vec<usize>,
    cursor: usize,
    purged: HashSet<String>,
    blocked: HashSet<String>,
}
// One bounded warm journal. Compare its exact prefix on every read; an external
// edit, truncation or restored project forces a full parse, never a stale decision.
static WARM: Mutex<Option<(PathBuf, Vec<u8>, Arc<State>)>> = Mutex::new(None);
fn prune_removed(s: &mut State) {
    let old = std::mem::take(&mut s.timeline);
    let cursor = s.cursor;
    s.cursor = 0;
    for (position, index) in old.into_iter().enumerate() {
        if !s.purged.contains(&s.actions[index].0.token) {
            s.timeline.push(index);
            if position < cursor {
                s.cursor += 1;
            }
        }
    }
}
fn load(root: &Path) -> Result<Arc<State>, String> {
    let p = root.join(JOURNAL);
    if !p.exists() {
        return Ok(Arc::default());
    }
    store::reject_link(&p)?;
    let bytes = super::journal::read::<Event>(root, JOURNAL, 128 * 1024 * 1024)?;
    let mut warm = WARM
        .lock()
        .map_err(|_| "Review history cache unavailable")?;
    let (mut shared, offset) = warm
        .take()
        .filter(|(path, prior, _)| path == root && bytes.starts_with(prior))
        .map(|(_, prior, state)| (state, prior.len()))
        .unwrap_or_default();
    if offset == bytes.len() {
        *warm = Some((root.to_path_buf(), bytes, shared.clone()));
        return Ok(shared);
    }
    let s = Arc::make_mut(&mut shared);
    for line in bytes[offset..]
        .split(|&b| b == b'\n')
        .filter(|b| !b.is_empty())
    {
        let event: Event = serde_json::from_slice(line)
            .map_err(|_| "Review history is invalid and was preserved. File removal is blocked.")?;
        s.revision += 1;
        match event {
            Event::Intent { op } => {
                if op.token.len() > 128
                    || s.pending.contains_key(&op.token)
                    || s.receipts.contains_key(&op.token)
                {
                    return Err("Duplicate review operation in journal; preserve history".into());
                }
                s.pending.insert(op.token.clone(), op);
            }
            Event::Done { token, receipt } => {
                let op = s
                    .pending
                    .remove(&token)
                    .ok_or("Review result has no saved intent")?;
                s.operations.push((op.clone(), receipt.clone()));
                match op.kind.as_str() {
                    "apply" => {
                        s.timeline.truncate(s.cursor);
                        s.timeline.push(s.actions.len());
                        s.cursor += 1;
                        s.actions.push((op, receipt.clone()));
                    }
                    "undo" => {
                        if s.cursor == 0 {
                            return Err("Invalid Undo history".into());
                        }
                        let i = s.timeline[s.cursor - 1];
                        if op.target.as_deref() != Some(s.actions[i].0.token.as_str()) {
                            return Err("Undo identity changed".into());
                        }
                        s.cursor -= 1;
                    }
                    "redo" => {
                        if s.cursor >= s.timeline.len() {
                            return Err("Invalid Redo history".into());
                        }
                        let i = s.timeline[s.cursor];
                        if op.target.as_deref() != Some(s.actions[i].0.token.as_str()) {
                            return Err("Redo identity changed".into());
                        }
                        s.cursor += 1;
                    }
                    _ => return Err("Unknown review action".into()),
                }
                s.receipts.insert(token, receipt);
            }
            Event::Purged { identities } => {
                for (op, _) in &s.actions {
                    if identities.iter().any(|id| {
                        safety::same(id, &op.canonical_id) || safety::same(id, &op.anchor_id)
                    }) {
                        s.purged.insert(op.token.clone());
                    }
                }
                prune_removed(s);
            }
            Event::Removal {
                targets,
                finished,
                removed,
            } => {
                for id in targets {
                    if finished {
                        s.blocked.remove(&id);
                        if removed {
                            s.purged.insert(id);
                        }
                    } else {
                        s.blocked.insert(id);
                    }
                }
                prune_removed(s);
            }
        }
    }
    if bytes.len() <= 16 * 1024 * 1024 {
        *warm = Some((root.to_path_buf(), bytes, shared.clone()));
    } else {
        *warm = None;
    }
    Ok(shared)
}
fn append(root: &Path, event: &Event) -> Result<(), String> {
    let p = root.join(JOURNAL);
    if p.exists() {
        store::reject_link(&p)?;
        if fs::metadata(&p).map_err(|e| e.to_string())?.len() > 128 * 1024 * 1024 {
            return Err("Review history is full; existing history was retained".into());
        }
    }
    let mut b = serde_json::to_vec(event).map_err(|e| e.to_string())?;
    b.push(b'\n');
    super::journal::append(root, JOURNAL, &b, 128 * 1024 * 1024)
}
fn token(v: &str) -> Result<(), String> {
    if v.is_empty() || v.len() > 128 || v.chars().any(|c| c.is_control()) {
        return Err("Invalid review action reference".into());
    }
    Ok(())
}
fn trashed(p: &Path) -> bool {
    p.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase()
        .contains("{trash}")
}
fn renamed(p: &Path, value: bool) -> Result<PathBuf, String> {
    let mut n = p
        .file_name()
        .ok_or("Photo name missing")?
        .to_string_lossy()
        .into_owned();
    while let Some(at) = n.to_ascii_lowercase().find("{trash}") {
        n.replace_range(at..at + 7, "");
    }
    let n = if value {
        let (b, e) = n.rsplit_once('.').ok_or("Photo extension missing")?;
        format!("{b}{{trash}}.{e}")
    } else {
        n
    };
    Ok(p.with_file_name(n))
}
fn locate(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let p = safety::scoped(root, relative, false)?;
    if p.is_file() {
        return Ok(p);
    }
    let parent = p.parent().ok_or("Photo parent missing")?;
    let wanted = curation_key(&p);
    let matches = fs::read_dir(parent)
        .map_err(|_| "Photo folder unavailable")?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|q| curation_key(q) == wanted)
        .collect::<Vec<_>>();
    if matches.len() != 1 {
        return Err("Original is missing or ambiguous. Refresh history.".into());
    }
    safety::scoped(root, &safety::relative(root, &matches[0])?, true)
}
fn legacy_reviewed(folder: &Path, path: &Path, anchor: &Path) -> bool {
    let n = anchor.file_name().unwrap_or_default().to_string_lossy();
    if trashed(anchor) || n.contains("{Like o") {
        return true;
    }
    store::load_curation(folder).ok().is_some_and(|c| {
        [curation_key(path), curation_key(anchor)]
            .iter()
            .any(|k| c.entries.get(k).is_some_and(|v| v.selected || v.favourite))
    })
}
fn prepare(
    root: &Path,
    text: &str,
    relative: &str,
    stamp: &str,
    desired: bool,
    id: &str,
    kind: &str,
    target: Option<&Operation>,
) -> Result<Operation, String> {
    let canonical = locate(root, relative)?;
    let canonical_id = safety::identity(&canonical)?;
    if !canonical.extension().is_some_and(|e| {
        ["jpg", "jpeg", "png", "cr3", "dng"]
            .iter()
            .any(|v| e.eq_ignore_ascii_case(v))
    }) {
        return Err("Choose an original photo in Lightbox".into());
    }
    if !stamp.is_empty() && canonical_id.modified != stamp {
        return Err("This original changed. Refresh before saving its Trash decision.".into());
    }
    if let Some(old) = target {
        if !safety::same(&canonical_id, &old.canonical_id) {
            return Err("This original was replaced; replay is blocked.".into());
        }
    }
    let folder = canonical.parent().ok_or("Photo parent missing")?;
    let anchors = capture::review_anchors(folder)?;
    if !crate::commands::raw_development::is_raw(&canonical)
        && anchors.values().any(|jpeg| jpeg == &canonical)
    {
        return Err(
            "Capture membership changed. Refresh to review its paired JPEG and CR3 together."
                .into(),
        );
    }
    let anchor = anchors.get(&canonical).unwrap_or(&canonical).clone();
    let anchor_id = safety::identity(&anchor)?;
    if let Some(old) = target {
        if !safety::same(&anchor_id, &old.anchor_id) {
            return Err("Camera JPEG changed; replay is blocked.".into());
        }
    }
    let k = curation_key(&canonical);
    let count = fs::read_dir(folder)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| curation_key(&e.path()) == k)
        .count();
    if count != 1 {
        return Err("Several originals share this identity; resolve the duplicate first.".into());
    }
    let before_review = lightbox_review::load(folder)?.entries.get(&k).cloned();
    // Retain stale prior metadata in the journal, but never apply an old physical
    // file's Reviewed override to a newly imported capture at the same name.
    if let Some(old) = target {
        let expected = if kind == "undo" {
            old.after_review.clone()
        } else {
            old.before_review
                .clone()
                .filter(|entry| entry.source_stamp == canonical_id.modified)
        };
        if before_review != expected {
            return Err("A later Reviewed decision was preserved; refresh history.".into());
        }
    }
    let before_reviewed = before_review
        .as_ref()
        .filter(|entry| entry.source_stamp == canonical_id.modified)
        .map(|e| e.reviewed)
        .unwrap_or_else(|| legacy_reviewed(folder, &canonical, &anchor));
    let after_review = if let Some(old) = target {
        if kind == "undo" {
            old.before_review
                .clone()
                .filter(|entry| entry.source_stamp == canonical_id.modified)
        } else {
            old.after_review.clone()
        }
    } else {
        Some(ReviewEntry {
            reviewed: true,
            source_stamp: canonical_id.modified.clone(),
        })
    };
    let anchor_new = renamed(&anchor, desired)?;
    let canonical_new = if canonical == anchor {
        anchor_new.clone()
    } else {
        canonical.clone()
    };
    let after_reviewed = after_review
        .as_ref()
        .map(|e| e.reviewed)
        .unwrap_or_else(|| {
            if desired {
                true
            } else {
                legacy_reviewed(folder, &canonical, &anchor_new)
            }
        });
    Ok(Operation {
        token: id.into(),
        kind: kind.into(),
        target: target.map(|o| o.token.clone()),
        root: text.into(),
        canonical_old: safety::relative(root, &canonical)?,
        canonical_new: safety::relative(root, &canonical_new)?,
        anchor_old: safety::relative(root, &anchor)?,
        anchor_new: safety::relative(root, &anchor_new)?,
        canonical_id,
        anchor_id,
        before_review,
        after_review,
        before_trashed: trashed(&anchor),
        after_trashed: desired,
        before_reviewed,
        after_reviewed,
        created_at: chrono::Utc::now().to_rfc3339(),
    })
}
fn finish(root: &Path, op: &Operation, _revision: u64) -> Result<Receipt, String> {
    if safety::root(&op.root)? != root {
        return Err("Saved review root differs from this library; recovery is blocked".into());
    }
    let canonical_before = locate(root, &op.canonical_old)?;
    if !safety::same(&safety::identity(&canonical_before)?, &op.canonical_id) {
        return Err("Original identity changed before replay; no photo was renamed".into());
    }
    let before = safety::scoped(root, &op.anchor_old, false)?;
    let after = safety::scoped(root, &op.anchor_new, false)?;
    let actual = if before == after || before.exists() {
        if before != after && after.exists() {
            return Err(
                "Trash name conflicts with another file. Both originals were preserved.".into(),
            );
        }
        &before
    } else {
        &after
    };
    if !safety::same(&safety::identity(actual)?, &op.anchor_id) {
        return Err("Photo changed during the saved decision; recovery is blocked.".into());
    }
    if before != after && actual == &before {
        files::rename_review_file(
            &before,
            after
                .file_name()
                .ok_or("Photo name missing")?
                .to_str()
                .ok_or("Invalid photo name")?,
        )?;
    }
    let canonical = safety::scoped(root, &op.canonical_new, true)?;
    if !safety::same(&safety::identity(&canonical)?, &op.canonical_id) {
        return Err("Original changed while saving; history was preserved.".into());
    }
    let current = lightbox_review::load(canonical.parent().ok_or("Photo parent missing")?)?
        .entries
        .get(&curation_key(&canonical))
        .cloned();
    if current != op.before_review && current != op.after_review {
        return Err(
            "A later Reviewed decision was preserved; resolve the history conflict.".into(),
        );
    }
    let review = lightbox_review::replace_entry(
        &op.root,
        &op.canonical_new,
        &op.canonical_id,
        &op.before_review,
        op.after_review.clone(),
    )?;
    let entry = HistoryEntry {
        id: op.target.clone().unwrap_or_else(|| op.token.clone()),
        capture_path: op.canonical_new.clone(),
        label: canonical
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        before_trashed: op.before_trashed,
        after_trashed: op.after_trashed,
        before_reviewed: op.before_reviewed,
        after_reviewed: op.after_reviewed,
        outcome: "saved".into(),
        can_undo: op.kind != "undo",
        can_redo: op.kind == "undo",
        created_at: op.created_at.clone(),
    };
    let state = load(root)?;
    let next_cursor = match op.kind.as_str() {
        "undo" => state.cursor.saturating_sub(1),
        "redo" => state.cursor + 1,
        _ => state.cursor + 1,
    };
    let next_len = if op.kind == "apply" {
        next_cursor
    } else {
        state.timeline.len()
    };
    let available = |cursor: usize| {
        state.timeline.get(cursor).is_some_and(|&i| {
            let token = &state.actions[i].0.token;
            !state.purged.contains(token) && !state.blocked.contains(token)
        })
    };
    let receipt = Receipt {
        can_undo: next_cursor > 0 && (op.kind == "apply" || available(next_cursor - 1)),
        can_redo: next_cursor < next_len && available(next_cursor),
        action_id: op.token.clone(),
        revision: state.revision + 1,
        relative_path: op.canonical_new.clone(),
        renamed: if before != after {
            vec![Rename {
                old_path: op.anchor_old.clone(),
                new_path: op.anchor_new.clone(),
            }]
        } else {
            vec![]
        },
        trashed: op.after_trashed,
        reviewed: op.after_reviewed,
        source_stamp: op.canonical_id.modified.clone(),
        entry,
        review: Reviewed {
            root: review.root,
            relative_path: review.relative_path,
            key: review.key,
            source_stamp: review.source_stamp,
            reviewed: op.after_reviewed,
            revision: review.revision,
            explicit: op.after_review.is_some(),
        },
    };
    drop(state);
    append(
        root,
        &Event::Done {
            token: op.token.clone(),
            receipt: receipt.clone(),
        },
    )?;
    Ok(receipt)
}
fn recover(root: &Path, s: &State) -> Result<(), String> {
    let mut pending = s.pending.values().collect::<Vec<_>>();
    pending.sort_by_key(|o| &o.created_at);
    for op in pending {
        let p = safety::scoped(root, &op.anchor_old, false)?;
        let _access = safety::Access::acquire(p.parent().ok_or("Photo parent missing")?, true)?;
        finish(root, op, s.revision + 1)?;
    }
    Ok(())
}
pub fn apply(r: ActionRequest) -> Result<Receipt, String> {
    token(&r.action_id)?;
    if r.expected_source_stamp.is_empty() {
        return Err(rejected(
            "Refresh the photo before changing its review decision",
        ));
    }
    let root = safety::root(&r.staging_dir)?;
    let _naming = crate::commands::naming_workflow::naming_lease(&root)?;
    let _lane = LANE.lock().map_err(|_| "Review lock failed")?;
    let _lock = safety::metadata_lock(&root, ".photogogo-trash-history.lock")?;
    let mut s = load(&root)?;
    if let Some(v) = s.receipts.get(&r.action_id) {
        return Ok(v.clone());
    }
    recover(&root, &s)?;
    s = load(&root)?;
    if let Some(v) = s.receipts.get(&r.action_id) {
        return Ok(v.clone());
    }
    let p = locate(&root, &r.relative_path).map_err(rejected)?;
    let _access = safety::Access::acquire(p.parent().ok_or("Photo parent missing")?, true)
        .map_err(rejected)?;
    let op = prepare(
        &root,
        &r.staging_dir,
        &r.relative_path,
        &r.expected_source_stamp,
        r.trashed,
        &r.action_id,
        "apply",
        None,
    )
    .map_err(rejected)?;
    drop(s);
    append(&root, &Event::Intent { op: op.clone() })?;
    finish(&root, &op, 0).map_err(|e| format!("Committing Trash: {e}"))
}
pub fn replay(r: ReplayRequest) -> Result<Receipt, String> {
    token(&r.action_id)?;
    let root = safety::root(&r.staging_dir)?;
    let _naming = crate::commands::naming_workflow::naming_lease(&root)?;
    let _lane = LANE.lock().map_err(|_| "Review lock failed")?;
    let _lock = safety::metadata_lock(&root, ".photogogo-trash-history.lock")?;
    let mut s = load(&root)?;
    if let Some(v) = s.receipts.get(&r.action_id) {
        return Ok(v.clone());
    }
    recover(&root, &s)?;
    s = load(&root)?;
    if let Some(receipt) = s.receipts.get(&r.action_id) {
        return Ok(receipt.clone());
    }
    if r.expected_revision.is_some_and(|v| v != s.revision) {
        return Err(rejected("History changed; refresh before Undo/Redo."));
    }
    let i = match r.direction.as_str() {
        "undo" if s.cursor > 0 => s.timeline[s.cursor - 1],
        "redo" if s.cursor < s.timeline.len() => s.timeline[s.cursor],
        _ => return Err(rejected("No matching review action is available")),
    };
    let original = &s.actions[i].0;
    if s.purged.contains(&original.token) || s.blocked.contains(&original.token) {
        return Err(rejected("This capture is removed or protected by its removal job; Undo cannot restore deleted bytes."));
    }
    let p = locate(&root, &original.canonical_old).map_err(rejected)?;
    let _access = safety::Access::acquire(p.parent().ok_or("Photo parent missing")?, true)
        .map_err(rejected)?;
    let desired = if r.direction == "undo" {
        original.before_trashed
    } else {
        original.after_trashed
    };
    let op = prepare(
        &root,
        &r.staging_dir,
        &safety::relative(&root, &p)?,
        "",
        desired,
        &r.action_id,
        &r.direction,
        Some(original),
    )
    .map_err(rejected)?;
    append(&root, &Event::Intent { op: op.clone() })?;
    finish(&root, &op, s.revision + 1)
}
pub fn read(text: &str, dir: &str, offset: usize, limit: usize) -> Result<History, String> {
    let root = safety::root(text)?;
    let _naming = crate::commands::naming_workflow::naming_lease(&root)?;
    if !dir.is_empty() && !safety::scoped(&root, dir, false)?.is_dir() {
        return Err("Choose a review folder in staging".into());
    }
    let _lane = LANE.lock().map_err(|_| "Review lock failed")?;
    let _lock = safety::metadata_lock(&root, ".photogogo-trash-history.lock")?;
    let mut s = load(&root)?;
    let mut warnings = vec![];
    if let Err(e) = recover(&root, &s) {
        warnings.push(e)
    } else {
        s = load(&root)?
    }
    let undo = if s.cursor > 0 {
        Some(s.timeline[s.cursor - 1])
    } else {
        None
    };
    let redo = s.timeline.get(s.cursor).copied();
    let prefix = format!("{}/", dir.trim_matches('/').to_lowercase());
    let all = s
        .actions
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, (_, r))| dir.is_empty() || r.relative_path.to_lowercase().starts_with(&prefix))
        .map(|(i, (op, r))| {
            let mut e = r.entry.clone();
            let deleted = s.purged.contains(&op.token);
            if deleted {
                e.outcome = "permanently_removed".into()
            }
            e.can_undo = Some(i) == undo
                && !deleted
                && !s.blocked.contains(&op.token)
                && warnings.is_empty();
            e.can_redo = Some(i) == redo
                && !deleted
                && !s.blocked.contains(&op.token)
                && warnings.is_empty();
            if s.blocked.contains(&op.token) {
                e.outcome = "blocked".into();
            }
            e
        })
        .collect::<Vec<_>>();
    let total = all.len();
    let n = limit.clamp(1, 100);
    Ok(History {
        revision: s.revision,
        entries: all.into_iter().skip(offset).take(n).collect(),
        can_undo: undo.is_some_and(|i| {
            !s.purged.contains(&s.actions[i].0.token) && !s.blocked.contains(&s.actions[i].0.token)
        }) && warnings.is_empty(),
        can_redo: redo.is_some_and(|i| {
            !s.purged.contains(&s.actions[i].0.token) && !s.blocked.contains(&s.actions[i].0.token)
        }) && warnings.is_empty(),
        total,
        next_offset: (offset + n < total).then_some(offset + n),
        warnings,
    })
}
pub fn purged(root: &Path, paths: Vec<String>) -> Result<(), String> {
    let identities = paths
        .iter()
        .map(|p| safety::identity(&safety::scoped(root, p, true)?))
        .collect::<Result<Vec<_>, String>>()?;
    let _lane = LANE.lock().map_err(|_| "Review lock failed")?;
    let _lock = safety::metadata_lock(root, ".photogogo-trash-history.lock")?;
    let s = load(root)?;
    if !s.pending.is_empty() {
        return Err("Recover pending review decisions before removal".into());
    }
    append(root, &Event::Purged { identities })
}
pub fn removal_begin(root: &Path, ids: &[Identity]) -> Result<Vec<String>, String> {
    let _lane = LANE.lock().map_err(|_| "Review lock failed")?;
    let _lock = safety::metadata_lock(root, ".photogogo-trash-history.lock")?;
    let s = load(root)?;
    if !s.pending.is_empty() {
        return Err("Recover pending review decisions before removal".into());
    }
    let targets = s
        .actions
        .iter()
        .filter(|(op, _)| {
            ids.iter()
                .any(|id| safety::same(id, &op.canonical_id) || safety::same(id, &op.anchor_id))
        })
        .map(|(op, _)| op.token.clone())
        .collect::<Vec<_>>();
    append(
        root,
        &Event::Removal {
            targets: targets.clone(),
            finished: false,
            removed: false,
        },
    )?;
    Ok(targets)
}
pub fn revision(root: &Path) -> Result<u64, String> {
    let _lane = LANE.lock().map_err(|_| "Review lock failed")?;
    let _lock = safety::metadata_lock(root, ".photogogo-trash-history.lock")?;
    let state = load(root)?;
    if !state.pending.is_empty() {
        return Err("Let pending review decisions finish before inspecting removal".into());
    }
    Ok(state.revision)
}
pub fn restored_since(root: &Path, identities: &[Identity], revision: u64) -> Result<bool, String> {
    let _lane = LANE.lock().map_err(|_| "Review lock failed")?;
    let _lock = safety::metadata_lock(root, ".photogogo-trash-history.lock")?;
    let state = load(root)?;
    if !state.pending.is_empty() {
        return Err("Pending review recovery protects this capture from removal".into());
    }
    Ok(state.operations.iter().any(|(op, receipt)| {
        receipt.revision > revision
            && !receipt.trashed
            && identities
                .iter()
                .any(|id| safety::same(id, &op.canonical_id) || safety::same(id, &op.anchor_id))
    }))
}
pub fn removal_end(root: &Path, targets: Vec<String>, removed: bool) -> Result<(), String> {
    let _lane = LANE.lock().map_err(|_| "Review lock failed")?;
    let _lock = safety::metadata_lock(root, ".photogogo-trash-history.lock")?;
    append(
        root,
        &Event::Removal {
            targets,
            finished: true,
            removed,
        },
    )
}
