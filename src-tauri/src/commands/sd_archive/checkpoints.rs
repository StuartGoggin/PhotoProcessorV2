use super::inventory::{is_sha256, Inventory, DOCUMENT_LIMIT};
use crate::commands::google_photos::store;
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::Path,
};

pub(super) const FILE_NAME: &str = "verified-files.jsonl";

/// One synced checksum per verified file. Each complete line is recoverable
/// independently, including when the process stops before publishing the file.
pub(super) struct Checkpoints {
    file: File,
    pub hashes: BTreeMap<String, String>,
    length: u64,
    failed: bool,
}

impl Checkpoints {
    pub(super) fn open(work: &Path, inventory: &Inventory) -> Result<Self, String> {
        let path = work.join(FILE_NAME);
        crate::commands::lightbox_trash::safety::inspect_optional(&path)?;
        let bytes = store::read_bounded(&path, DOCUMENT_LIMIT)?.unwrap_or_default();
        let mut lines = bytes.split(|byte| *byte == b'\n');
        // An interrupted append may leave a suffix without its newline. The
        // corresponding file, if present, will be verified from both copies.
        let tail = lines.next_back().unwrap_or_default();
        let length = (bytes.len() - tail.len()) as u64;
        let mut hashes = BTreeMap::new();
        for line in lines {
            let (name, digest): (String, String) = serde_json::from_slice(line)
                .map_err(|_| "The saved archive checksum journal is unreadable.")?;
            if !inventory.files.contains_key(&name)
                || !is_sha256(&digest)
                || hashes.insert(name, digest).is_some()
            {
                return Err("The saved checksum journal does not match the card inventory.".into());
            }
        }
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).write(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            options.share_mode(0).custom_flags(0x00200000);
        }
        let mut file = options.open(&path).map_err(journal_error)?;
        crate::commands::lightbox_trash::safety::id(&file)?;
        if file.metadata().map_err(journal_error)?.len() != bytes.len() as u64 {
            return Err("The saved checksum journal changed during recovery.".into());
        }
        if !tail.is_empty() {
            file.set_len(length).map_err(journal_error)?;
        }
        file.seek(SeekFrom::End(0)).map_err(journal_error)?;
        Ok(Self {
            file,
            hashes,
            length,
            failed: false,
        })
    }

    pub(super) fn record(&mut self, name: &str, hash: &str) -> Result<(), String> {
        if self.failed {
            return Err("Saving the archive checksum journal failed. Retry this archive.".into());
        }
        if let Some(expected) = self.hashes.get(name) {
            return if expected == hash {
                Ok(())
            } else {
                Err("The saved file checksum changed.".into())
            };
        }
        let mut line = serde_json::to_vec(&(name, hash)).map_err(|error| error.to_string())?;
        line.push(b'\n');
        let length = self.length + line.len() as u64;
        if length > DOCUMENT_LIMIT {
            return Err("Archive checksum journal exceeds the supported size.".into());
        }
        if let Err(error) = self
            .file
            .write_all(&line)
            .and_then(|_| self.file.sync_data())
        {
            self.failed = true;
            return Err(journal_error(error));
        }
        self.length = length;
        self.hashes.insert(name.into(), hash.into());
        Ok(())
    }
}

fn journal_error(error: std::io::Error) -> String {
    format!("Could not save the archive checksum journal: {error}")
}
