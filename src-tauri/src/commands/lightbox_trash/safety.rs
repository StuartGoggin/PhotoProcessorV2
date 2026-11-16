//! Exact scoped paths and owned handle guards; never recursively delete media.
use super::model::Identity;
use crate::commands::{google_photos::store, lightbox_review};
use fs2::FileExt;
use md5::Md5;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
};
pub fn root(value: &str) -> Result<PathBuf, String> {
    let p = Path::new(value);
    if !p.is_absolute() {
        return Err("Choose an absolute staging folder.".into());
    }
    for ancestor in p.ancestors() {
        if ancestor.exists() {
            store::reject_link(ancestor)?
        }
    }
    let p = p
        .canonicalize()
        .map_err(|_| "Staging folder is unavailable")?;
    if !p.is_dir() {
        return Err("Choose a staging folder".into());
    }
    Ok(p)
}
pub fn inspect_optional(path: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => store::reject_link(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Cannot inspect the exact media path".into()),
    }
}
pub fn relative(root: &Path, path: &Path) -> Result<String, String> {
    // Check the named leaf and all ancestors BEFORE canonicalization can erase
    // a symlink's ownership evidence. Canonicalization then handles 8.3 aliases.
    for ancestor in path.ancestors() {
        inspect_optional(ancestor)?;
    }
    let actual = if path.exists() {
        path.canonicalize().map_err(|_| "Cannot resolve photo")?
    } else {
        path.to_path_buf()
    };
    let relative = actual
        .strip_prefix(root)
        .map_err(|_| "Photo is outside staging")?
        .to_string_lossy()
        .replace('\\', "/");
    scoped(root, &relative, false)?;
    Ok(relative)
}
pub fn scoped(root: &Path, value: &str, exists: bool) -> Result<PathBuf, String> {
    let normal = value.replace('\\', "/");
    if normal.is_empty() || normal.len() > 32000 || normal.contains(':') {
        return Err("Choose an exact photo in staging".into());
    }
    let mut p = root.to_path_buf();
    for c in Path::new(&normal).components() {
        if !matches!(c, Component::Normal(_)) {
            return Err("Photo path must stay within staging".into());
        }
        p.push(c);
        inspect_optional(&p)?;
    }
    if exists && !p.is_file() {
        return Err("Photo is no longer available; refresh before retrying".into());
    }
    Ok(p)
}
pub fn id(file: &File) -> Result<Identity, String> {
    let m = file.metadata().map_err(|e| e.to_string())?;
    if !m.is_file() {
        return Err("Only regular photo files are allowed".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return Err("Redirected file handle is protected".into());
        }
    }
    #[cfg(windows)]
    let file_id = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
            return Err("Cannot verify photo identity".into());
        }
        format!(
            "{}:{}:{}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        )
    };
    #[cfg(unix)]
    let file_id = {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}", m.dev(), m.ino())
    };
    #[cfg(not(any(windows, unix)))]
    let file_id = String::new();
    Ok(Identity {
        bytes: m.len(),
        modified: lightbox_review::source_stamp(&m).ok_or("Photo timestamp unavailable")?,
        file_id,
    })
}
pub fn same(a: &Identity, b: &Identity) -> bool {
    a.bytes == b.bytes && a.modified == b.modified && a.file_id == b.file_id
}
pub fn identity(path: &Path) -> Result<Identity, String> {
    store::reject_link(path)?;
    id(&File::open(path).map_err(|e| e.to_string())?)
}
pub fn hash(file: &mut File) -> Result<(String, String), String> {
    let mut md5 = Md5::new();
    let mut sha = Sha256::new();
    let mut b = [0u8; 256 * 1024];
    loop {
        let n = file.read(&mut b).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        md5.update(&b[..n]);
        sha.update(&b[..n]);
    }
    Ok((hex::encode(md5.finalize()), hex::encode(sha.finalize())))
}
pub struct Access(File);
impl Access {
    pub fn acquire(folder: &Path, write: bool) -> Result<Self, String> {
        let p = folder.join(".photogogo-capture-access.lock");
        inspect_optional(&p)?;
        let f = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(p)
            .map_err(|e| e.to_string())?;
        let result = if write {
            f.try_lock_exclusive()
        } else {
            FileExt::try_lock_shared(&f)
        };
        result.map_err(|_| {
            "This photo folder is in use. Retry after its current operation finishes."
        })?;
        Ok(Self(f))
    }
}
impl Drop for Access {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}
#[cfg(windows)]
fn directory(path: &Path, metadata_publication: bool) -> Result<File, String> {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    let f = OpenOptions::new()
        .read(true)
        .share_mode(if metadata_publication { 3 } else { 1 })
        .custom_flags(0x02000000 | 0x00200000)
        .open(path)
        .map_err(|_| "Cannot protect photo directory against replacement")?;
    let m = f.metadata().map_err(|e| e.to_string())?;
    if !m.is_dir() || m.file_attributes() & 0x400 != 0 {
        return Err("Redirected media directory is protected".into());
    }
    Ok(f)
}
#[cfg(windows)]
pub(super) fn journal_directory(root: &Path) -> Result<File, String> {
    directory(root, false)
}
pub struct MediaFile {
    pub file: File,
    #[allow(dead_code)]
    parents: Vec<File>,
    #[allow(dead_code)]
    path: PathBuf,
}
impl MediaFile {
    pub fn open(root: &Path, relative: &str, remove: bool) -> Result<Self, String> {
        Self::open_mode(root, relative, remove, false)
    }
    pub fn for_metadata(root: &Path, relative: &str) -> Result<Self, String> {
        Self::open_mode(root, relative, false, true)
    }
    fn open_mode(
        root: &Path,
        relative: &str,
        remove: bool,
        metadata_publication: bool,
    ) -> Result<Self, String> {
        let path = scoped(root, relative, true)?;
        #[cfg(windows)]
        let parents = {
            let mut v = vec![directory(root, metadata_publication)?];
            let parent = path.parent().ok_or("Photo parent missing")?;
            let mut p = root.to_path_buf();
            for c in parent
                .strip_prefix(root)
                .map_err(|_| "Photo outside staging")?
                .components()
            {
                p.push(c);
                v.push(directory(&p, metadata_publication)?)
            }
            v
        };
        #[cfg(not(windows))]
        let parents = vec![];
        let mut opts = OpenOptions::new();
        opts.read(true);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            opts.share_mode(1).custom_flags(0x00200000);
            if remove {
                opts.access_mode(0x80000000 | 0x00010000);
            }
        }
        #[cfg(not(windows))]
        if remove {
            return Err("Permanent media removal requires Windows guarded handles".into());
        }
        let file = opts
            .open(&path)
            .map_err(|_| "Photo is locked or cannot be safely opened")?;
        store::reject_link(&path)?;
        let _ = id(&file)?;
        let held = Self {
            file,
            parents,
            path,
        };
        held.validate_held()?;
        Ok(held)
    }
    pub fn validate_held(&self) -> Result<(), String> {
        #[cfg(windows)]
        {
            use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
            use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
            for parent in &self.parents {
                let m = parent
                    .metadata()
                    .map_err(|_| "Cannot inspect held photo directory")?;
                if !m.is_dir() || m.file_attributes() & 0x400 != 0 {
                    return Err("A held photo directory became redirected".into());
                }
            }
            let mut path = vec![0u16; 32768];
            let length = unsafe {
                GetFinalPathNameByHandleW(
                    self.file.as_raw_handle() as _,
                    path.as_mut_ptr(),
                    path.len() as u32,
                    0,
                )
            } as usize;
            if length == 0 || length >= path.len() {
                return Err("Cannot prove the held photo's final path".into());
            }
            let final_path =
                String::from_utf16(&path[..length]).map_err(|_| "Photo handle path is invalid")?;
            if !final_path.eq_ignore_ascii_case(&self.path.to_string_lossy()) {
                return Err("Photo handle resolved outside its exact intended path".into());
            }
        }
        Ok(())
    }
    pub fn remove(self) -> Result<(), String> {
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Storage::FileSystem::{
                FileDispositionInfo, SetFileInformationByHandle, FILE_DISPOSITION_INFO,
            };
            let info = FILE_DISPOSITION_INFO { DeleteFile: 1 };
            if unsafe {
                SetFileInformationByHandle(
                    self.file.as_raw_handle() as _,
                    FileDispositionInfo,
                    &info as *const _ as _,
                    std::mem::size_of_val(&info) as u32,
                )
            } == 0
            {
                return Err("Windows retained the locked photo; it was not removed".into());
            }
            drop(self);
            Ok(())
        }
        #[cfg(not(windows))]
        {
            Err("Permanent media removal is unavailable on this platform".into())
        }
    }
}
pub fn metadata_lock(root: &Path, name: &str) -> Result<File, String> {
    let p = root.join(name);
    if p.exists() {
        store::reject_link(&p)?
    }
    let f = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(p)
        .map_err(|e| e.to_string())?;
    f.try_lock_exclusive()
        .map_err(|_| "Photo decisions are being saved in another window; retry shortly")?;
    Ok(f)
}
