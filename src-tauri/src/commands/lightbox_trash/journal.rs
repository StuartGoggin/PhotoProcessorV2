//! Recover only an incomplete trailing append. Complete invalid records stay blocked.
use super::safety;
use serde::de::DeserializeOwned;
use std::{
    fs::OpenOptions,
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};
pub fn append(root: &Path, name: &str, bytes: &[u8], limit: u64) -> Result<(), String> {
    if ![".photogogo-trash-history.jsonl", ".photogogo-discard.jsonl"].contains(&name) {
        return Err("Unsupported curation journal".into());
    }
    let path = safety::scoped(root, name, false)?;
    #[cfg(windows)]
    let _parent = safety::journal_directory(root)?;
    let mut options = OpenOptions::new();
    options.append(true).create(true).read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x00200000);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Cannot guard curation append")?;
    if safety::id(&file)?.bytes.saturating_add(bytes.len() as u64) > limit {
        return Err("Curation history is full; existing records retained".into());
    }
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Curation append could not be saved; retry before continuing".into())
}
pub fn read<T: DeserializeOwned>(root: &Path, name: &str, limit: u64) -> Result<Vec<u8>, String> {
    if ![".photogogo-trash-history.jsonl", ".photogogo-discard.jsonl"].contains(&name) {
        return Err("Unsupported curation journal".into());
    }
    let path = root.join(name);
    if !path.exists() {
        return Ok(vec![]);
    }
    safety::scoped(root, name, true)?;
    #[cfg(windows)]
    let _parent = safety::journal_directory(root)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x00200000);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| "Cannot guard curation journal for recovery")?;
    let identity = safety::id(&file)?;
    if identity.bytes > limit {
        return Err("Curation journal exceeds its safety limit".into());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|_| "Cannot read curation journal")?;
    if bytes.is_empty() || bytes.ends_with(b"\n") {
        return Ok(bytes);
    }
    let end = bytes.iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
    for line in bytes[..end]
        .split(|&b| b == b'\n')
        .filter(|line| !line.is_empty())
    {
        serde_json::from_slice::<T>(line)
            .map_err(|_| "Complete curation record is invalid; journal retained")?;
    }
    let backup = root.join(format!(
        ".photogogo-trash-interrupted-{}.bin",
        super::plan::new_id()?
    ));
    let mut saved = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(backup)
        .map_err(|_| "Cannot preserve interrupted curation append")?;
    saved
        .write_all(&bytes[end..])
        .and_then(|_| saved.sync_all())
        .map_err(|_| "Cannot preserve interrupted curation append")?;
    if !safety::same(&identity, &safety::id(&file)?) {
        return Err("Curation journal changed during recovery".into());
    }
    file.seek(SeekFrom::Start(end as u64))
        .and_then(|_| file.set_len(end as u64))
        .and_then(|_| file.sync_all())
        .map_err(|_| "Curation journal recovery could not finish")?;
    bytes.truncate(end);
    Ok(bytes)
}
