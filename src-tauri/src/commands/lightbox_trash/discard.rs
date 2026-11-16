//! Verified content receipts for deliberate local discard; never trust old sidecars.
use super::{model::Member, safety};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path};
const NAME: &str = ".photogogo-discard.jsonl";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    version: u8,
    job: String,
    path: String,
    bytes: u64,
    md5: String,
    sha256: String,
    state: String,
    at: String,
}
#[derive(Default)]
pub struct Index {
    hashes: HashMap<(String, u64), Vec<String>>,
}

pub fn record(root: &Path, job: &str, item: &Member, state: &str) -> Result<(), String> {
    if !item.kind.starts_with("camera_") {
        return Ok(());
    }
    let _lock = safety::metadata_lock(root, ".photogogo-discard.lock")?;
    validated(root)?;
    let path = root.join(NAME);
    safety::inspect_optional(&path)?;
    let receipt = Record {
        version: 1,
        job: job.into(),
        path: item.relative_path.clone(),
        bytes: item.bytes,
        md5: item.md5.clone().ok_or("Discard MD5 was not verified")?,
        sha256: item.sha256.clone().ok_or("Discard SHA was not verified")?,
        state: state.into(),
        at: chrono::Utc::now().to_rfc3339(),
    };
    let mut bytes = serde_json::to_vec(&receipt).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    super::journal::append(root, NAME, &bytes, 64 * 1024 * 1024)
}

pub fn load_index(root: &Path) -> Result<Index, String> {
    let path = root.join(NAME);
    if !path.exists() {
        return Ok(Index::default());
    }
    let _lock = safety::metadata_lock(root, ".photogogo-discard.lock")?;
    validated(root)
}
fn validated(root: &Path) -> Result<Index, String> {
    let bytes = super::journal::read::<Record>(root, NAME, 64 * 1024 * 1024)?;
    let mut result = Index::default();
    for line in bytes.split(|&b| b == b'\n').filter(|b| !b.is_empty()) {
        let value: Record = serde_json::from_slice(line)
            .map_err(|_| "Discard metadata is invalid and was preserved")?;
        if value.version != 1
            || !["intent", "removed", "reconciled"].contains(&value.state.as_str())
            || value.md5.len() != 32
            || value.sha256.len() != 64
            || !value.md5.bytes().all(|b| b.is_ascii_hexdigit())
            || !value.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("Discard receipt identity is invalid".into());
        }
        if ["removed", "reconciled"].contains(&value.state.as_str()) {
            result
                .hashes
                .entry((value.md5, value.bytes))
                .or_default()
                .push(value.sha256);
        }
    }
    Ok(result)
}

impl Index {
    pub fn matches(&self, md5: &str, bytes: u64, verified_copy: &Path) -> Result<bool, String> {
        let Some(expected) = self.hashes.get(&(md5.into(), bytes)) else {
            return Ok(false);
        };
        let mut file = std::fs::File::open(verified_copy).map_err(|e| e.to_string())?;
        let identity = safety::id(&file)?;
        if identity.bytes != bytes {
            return Err("Verified discard candidate changed size".into());
        }
        let (actual_md5, sha) = safety::hash(&mut file)?;
        if actual_md5 != md5 || !safety::same(&identity, &safety::id(&file)?) {
            return Err("Verified discard candidate changed while comparing".into());
        }
        Ok(expected.contains(&sha))
    }
}
