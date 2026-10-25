//! Selected-photo cropping. The source is read-only; four fixed sibling paths
//! form a recoverable generated bundle, never a folder-wide processing job.
use super::photo_process::{jpeg_bytes, render_bw, render_enhanced, BwParams};
use image::{DynamicImage, ImageDecoder, ImageReader};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
};

pub(super) static PHOTO_EDIT_GATE: Mutex<()> = Mutex::new(());
static EDITING: AtomicBool = AtomicBool::new(false);
pub(super) fn is_editing() -> bool {
    EDITING.load(Ordering::SeqCst)
}
pub(super) struct EditLease;
impl EditLease {
    pub(super) fn begin() -> Result<Self, String> {
        let _gate = PHOTO_EDIT_GATE.lock().map_err(|e| e.to_string())?;
        if is_editing() {
            return Err("Another crop operation is still running".into());
        }
        if super::import::imports_have_pending_work()
            || super::process::process_jobs_store()
                .lock()
                .map_err(|e| e.to_string())?
                .values()
                .any(|j| {
                    matches!(
                        j.status,
                        super::process::ProcessJobStatus::Queued
                            | super::process::ProcessJobStatus::Running
                            | super::process::ProcessJobStatus::Paused
                    )
                })
        {
            return Err("Let import and Photo Process jobs finish before cropping. No jobs have been stopped.".into());
        }
        EDITING.store(true, Ordering::SeqCst);
        Ok(Self)
    }
}
impl Drop for EditLease {
    fn drop(&mut self) {
        EDITING.store(false, Ordering::SeqCst);
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct CropRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl CropRect {
    fn pixels(self, w: u32, h: u32) -> Result<(u32, u32, u32, u32), String> {
        if [self.x, self.y, self.width, self.height]
            .iter()
            .any(|v| !v.is_finite())
            || self.x < 0.0
            || self.y < 0.0
            || self.width <= 0.0
            || self.height <= 0.0
            || self.x + self.width > 1.0 + 1e-9
            || self.y + self.height > 1.0 + 1e-9
        {
            return Err("Crop must be a finite rectangle inside the image".into());
        }
        let x = (self.x * w as f64).floor() as u32;
        let y = (self.y * h as f64).floor() as u32;
        let right = ((self.x + self.width) * w as f64).ceil().min(w as f64) as u32;
        let bottom = ((self.y + self.height) * h as f64).ceil().min(h as f64) as u32;
        let width = right.saturating_sub(x);
        let height = bottom.saturating_sub(y);
        if width < 16 || height < 16 {
            return Err("Crop must retain at least 16 × 16 pixels".into());
        }
        Ok((x, y, width, height))
    }
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropRequest {
    staging_dir: String,
    path: String,
    source_fingerprint: String,
    crop: CropRect,
    regenerate_bw: bool,
    regenerate_enhanced: bool,
    bw_params: BwParams,
    enhance_contrast_level: f32,
    enhance_sharpness_level: f32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CropInfo {
    width: u32,
    height: u32,
    source_fingerprint: String,
    original: String,
    crop: Option<CropRect>,
    has_crop: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CropResult {
    crop_path: String,
    width: u32,
    height: u32,
    outputs: Vec<String>,
    errors: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    version: u32,
    source_fingerprint: String,
    crop: CropRect,
    crop_fingerprint: String,
    bw_fingerprint: Option<String>,
    enhanced_fingerprint: Option<String>,
    bw_params: BwParams,
    enhance_contrast_level: f32,
    enhance_sharpness_level: f32,
}
// Fingerprints detect stale inputs/accidental edits. Receipts are not an
// authentication mechanism and never supply destination paths.
fn fingerprint(bytes: &[u8]) -> String {
    hex::encode(Md5::digest(bytes))
}
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("Photo/receipt exceeds its read safety limit".into());
    }
    Ok(bytes)
}
fn decode(bytes: &[u8]) -> Result<DynamicImage, String> {
    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    if reader.format() != Some(image::ImageFormat::Jpeg) {
        return Err("Cropping currently supports JPEG originals only".into());
    }
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let (w, h) = decoder.dimensions();
    if w == 0 || h == 0 || u64::from(w) * u64::from(h) > 100_000_000 {
        return Err("Photo exceeds the 100 megapixel safety limit".into());
    }
    let orientation = decoder.orientation().map_err(|e| e.to_string())?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    image.apply_orientation(orientation);
    Ok(image)
}
fn untag(stem: &str) -> String {
    let mut name = stem.to_string();
    let mut offset = 0;
    while let Some(start) = name[offset..].find('{').map(|i| offset + i) {
        let Some(end) = name[start..].find('}').map(|i| start + i + 1) else {
            break;
        };
        let tag = name[start..end].to_ascii_lowercase();
        let known = matches!(
            tag.as_str(),
            "{like o}" | "{like oo}" | "{like ooo}" | "{trash}"
        ) || tag
            .strip_prefix("{out of focus ")
            .and_then(|s| s.strip_suffix('}'))
            .map(|s| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()))
            .unwrap_or(false);
        if known {
            name.replace_range(start..end, "");
            offset = start;
        } else {
            offset = end;
        }
        if offset >= name.len() {
            break;
        }
    }
    name
}
struct Family {
    source: PathBuf,
    paths: [PathBuf; 4],
    prefix: String,
}
fn family(staging: &str, selected: &str) -> Result<Family, String> {
    let root = Path::new(staging)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let raw = Path::new(selected);
    let source = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        root.join(raw)
    }
    .canonicalize()
    .map_err(|e| e.to_string())?;
    if !source.starts_with(&root) || !source.is_file() {
        return Err("Select a photo inside the configured staging folder".into());
    }
    let ext = source.extension().and_then(|s| s.to_str()).unwrap_or("");
    if !matches!(ext.to_ascii_lowercase().as_str(), "jpg" | "jpeg") {
        return Err("Cropping currently supports JPEG originals only".into());
    }
    let stem = untag(
        source
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or("Unsupported photo name")?,
    );
    if ["_crop", "_bw", "_improved"]
        .iter()
        .any(|s| stem.to_ascii_lowercase().ends_with(s))
    {
        return Err("Select the original photo, not a generated version, to crop".into());
    }
    let parent = source.parent().ok_or("Photo has no parent folder")?;
    let matching = fs::read_dir(parent)
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .filter(|e| {
            let p = e.path();
            matches!(
                p.extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .as_str(),
                "jpg" | "jpeg"
            ) && untag(p.file_stem().and_then(|s| s.to_str()).unwrap_or(""))
                .eq_ignore_ascii_case(&stem)
        })
        .count();
    if matching != 1 {
        return Err(
            "More than one JPEG has this original name; resolve the ambiguity before cropping"
                .into(),
        );
    }
    let names = [
        format!("{stem}_crop.jpg"),
        format!("{stem}_crop_BW.jpg"),
        format!("{stem}_crop_improved.jpg"),
        format!("{stem}_crop.photogogo-crop.json"),
    ];
    // Case-only duplicates are ambiguous on portable/removable filesystems.
    for name in &names {
        if fs::read_dir(parent)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().eq_ignore_ascii_case(name))
            .count()
            > 1
        {
            return Err("Case-ambiguous crop output names; no files changed".into());
        }
    }
    Ok(Family {
        paths: names.map(|name| parent.join(name)),
        prefix: format!(
            ".photogogo-crop-{}-",
            fingerprint(stem.to_lowercase().as_bytes())
        ),
        source,
    })
}
fn file_fingerprint(path: &Path, limit: u64) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
        Ok(m) if !m.is_file() || m.file_type().is_symlink() => Err(format!(
            "Not a regular managed crop file: {}",
            path.display()
        )),
        Ok(_) => Ok(Some(fingerprint(&read_bounded(path, limit)?))),
    }
}
fn receipt(f: &Family) -> Result<Option<Receipt>, String> {
    if file_fingerprint(&f.paths[3], 64 * 1024)?.is_none() {
        return Ok(None);
    }
    let r: Receipt = serde_json::from_slice(&read_bounded(&f.paths[3], 64 * 1024)?)
        .map_err(|_| "Crop receipt is invalid; no existing files will be overwritten")?;
    if r.version != 1 {
        return Err("Unsupported crop receipt version".into());
    }
    r.bw_params.validate()?;
    Ok(Some(r))
}
fn owned(f: &Family, r: Option<&Receipt>) -> Result<Vec<Option<String>>, String> {
    let mut old = Vec::new();
    for (i, path) in f.paths.iter().enumerate() {
        let actual = file_fingerprint(path, if i == 3 { 64 * 1024 } else { 64 * 1024 * 1024 })?;
        if actual.is_some() {
            let expected = r.and_then(|r| match i {
                0 => Some(r.crop_fingerprint.clone()),
                1 => r.bw_fingerprint.clone(),
                2 => r.enhanced_fingerprint.clone(),
                _ => actual.clone(),
            });
            if expected.is_none() || actual != expected {
                return Err(format!("Existing crop file is unrecognized or has changed outside this workflow: {}. No files changed.",path.display()));
            }
        }
        old.push(actual);
    }
    Ok(old)
}

#[derive(Deserialize, Serialize)]
struct Journal {
    old: Vec<Option<String>>,
    new: Vec<Option<String>>,
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut out = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    out.write_all(bytes)
        .and_then(|_| out.sync_all())
        .map_err(|e| e.to_string())
}
#[cfg(windows)]
fn move_new(a: &Path, b: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    let a: Vec<u16> = a.as_os_str().encode_wide().chain(Some(0)).collect();
    let b: Vec<u16> = b.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { windows_sys::Win32::Storage::FileSystem::MoveFileExW(a.as_ptr(), b.as_ptr(), 8) }
        == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}
#[cfg(not(windows))]
fn move_new(a: &Path, b: &Path) -> Result<(), String> {
    fs::hard_link(a, b)
        .and_then(|_| fs::remove_file(a))
        .map_err(|e| e.to_string())
}
fn recover_one(f: &Family, dir: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(dir).map_err(|e| e.to_string())?;
    if !meta.is_dir() || meta.file_type().is_symlink() || dir.parent() != f.source.parent() {
        return Err("Unsafe crop recovery directory".into());
    }
    if !dir.join("journal.json").exists() {
        return Err(format!(
            "Incomplete crop staging folder retained for inspection: {}",
            dir.display()
        ));
    }
    let j: Journal = serde_json::from_slice(&read_bounded(&dir.join("journal.json"), 64 * 1024)?)
        .map_err(|e| e.to_string())?;
    if j.old.len() != 4
        || j.new.len() != 4
        || j.old
            .iter()
            .chain(&j.new)
            .flatten()
            .any(|s| s.len() != 32 || !s.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("Invalid crop recovery journal".into());
    }
    if !dir.join("committed").exists() {
        // Validate everything before removing/restoring any generated file.
        for i in 0..4 {
            let current = file_fingerprint(&f.paths[i], 64 * 1024 * 1024)?;
            if current.is_some() && current != j.old[i] && current != j.new[i] {
                return Err(format!("Crop recovery found an externally changed file; recovery copies retained in {}",dir.display()));
            }
            let backup = file_fingerprint(&dir.join(format!("{i}.old")), 64 * 1024 * 1024)?;
            if backup.is_some() && backup != j.old[i] {
                return Err("Crop recovery backup changed; retained for inspection".into());
            }
            if j.old[i].is_some() && current != j.old[i] && backup.is_none() {
                return Err("Missing crop recovery backup; no recovery files removed".into());
            }
        }
        for i in (0..4).rev() {
            let backup = dir.join(format!("{i}.old"));
            let current = file_fingerprint(&f.paths[i], 64 * 1024 * 1024)?;
            if current != j.old[i] && current.is_some() {
                fs::remove_file(&f.paths[i]).map_err(|e| e.to_string())?;
            }
            if backup.exists() {
                if f.paths[i].exists() {
                    fs::remove_file(&backup).map_err(|e| e.to_string())?;
                } else {
                    move_new(&backup, &f.paths[i])?;
                }
            } else if j.old[i].is_some() && !f.paths[i].exists() {
                return Err(format!("Missing recovery copy; retained {}", dir.display()));
            }
        }
    } else {
        for i in 0..4 {
            if file_fingerprint(&f.paths[i], 64 * 1024 * 1024)? != j.new[i] {
                return Err(format!(
                    "Completed crop files changed; recovery copies retained in {}",
                    dir.display()
                ));
            }
            let backup = file_fingerprint(&dir.join(format!("{i}.old")), 64 * 1024 * 1024)?;
            if backup.is_some() && backup != j.old[i] {
                return Err("Completed crop backup changed; retained for inspection".into());
            }
        }
    }
    fs::remove_dir_all(dir).map_err(|e| e.to_string())
}
fn recover(f: &Family) -> Result<(), String> {
    for item in fs::read_dir(f.source.parent().unwrap()).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        let name = item.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(&f.prefix) && name.ends_with(".txn") {
            recover_one(f, &item.path())?;
        }
    }
    Ok(())
}
fn publish(
    f: &Family,
    old: Vec<Option<String>>,
    payloads: Vec<Option<Vec<u8>>>,
) -> Result<(), String> {
    for (i, bytes) in payloads.iter().enumerate() {
        let limit = if i == 3 { 64 * 1024 } else { 64 * 1024 * 1024 };
        if bytes.as_ref().map(|b| b.len() > limit).unwrap_or(false) {
            return Err(
                "Encoded crop/output exceeds its recovery safety limit; no files changed".into(),
            );
        }
    }
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = f.source.parent().unwrap().join(format!(
        "{}{}-{}-{}.txn",
        f.prefix,
        std::process::id(),
        chrono::Utc::now().timestamp_millis(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&dir).map_err(|e| e.to_string())?;
    let j = Journal {
        old,
        new: payloads
            .iter()
            .map(|p| p.as_deref().map(fingerprint))
            .collect(),
    };
    let result: Result<(), String> = (|| {
        for (i, bytes) in payloads.iter().enumerate() {
            if let Some(bytes) = bytes {
                write_new(&dir.join(format!("{i}.new")), bytes)?;
                if i < 3 {
                    crate::utils::sync_file_metadata_from(
                        &f.source,
                        &dir.join(format!("{i}.new")),
                        false,
                    )?;
                }
            }
        }
        write_new(
            &dir.join("journal.json"),
            &serde_json::to_vec(&j).map_err(|e| e.to_string())?,
        )?;
        for i in 0..4 {
            if file_fingerprint(&f.paths[i], 64 * 1024 * 1024)? != j.old[i] {
                return Err("Crop output changed during save; retry after refreshing".into());
            }
            if j.old[i].is_some() {
                let backup = dir.join(format!("{i}.old"));
                move_new(&f.paths[i], &backup)?;
                if file_fingerprint(&backup, 64 * 1024 * 1024)? != j.old[i] {
                    return Err(
                        "Crop backup changed during publication; recovery copies retained".into(),
                    );
                }
            }
            if j.new[i].is_some() {
                move_new(&dir.join(format!("{i}.new")), &f.paths[i])?;
            }
        }
        for i in 0..4 {
            if file_fingerprint(&f.paths[i], 64 * 1024 * 1024)? != j.new[i] {
                return Err("Published crop verification failed".into());
            }
        }
        write_new(&dir.join("committed"), b"1")?;
        Ok(())
    })();
    if let Err(error) = result {
        let recovery = if dir.join("journal.json").exists() {
            recover_one(f, &dir)
        } else {
            fs::remove_dir_all(&dir).map_err(|e| e.to_string())
        };
        return Err(match recovery {Ok(())=>format!("Crop save failed; previous versions restored. Original untouched: {error}"),Err(rollback)=>format!("Crop save failed: {error}. Recovery copies retained in {}: {rollback}. Original untouched.",dir.display())});
    }
    // A failure to clear reproducible backups is not a failed image publication.
    let _ = recover_one(f, &dir);
    Ok(())
}
fn inspect(staging: &str, path: &str) -> Result<CropInfo, String> {
    let f = family(staging, path)?;
    recover(&f)?;
    let bytes = read_bounded(&f.source, 64 * 1024 * 1024)?;
    let image = decode(&bytes)?;
    let hash = fingerprint(&bytes);
    let r = receipt(&f)?;
    owned(&f, r.as_ref())?;
    let original = format!(
        "data:image/jpeg;base64,{}",
        crate::utils::base64_encode(&jpeg_bytes(&image.thumbnail(2000, 2000))?)
    );
    Ok(CropInfo {
        width: image.width(),
        height: image.height(),
        source_fingerprint: hash.clone(),
        original,
        crop: r
            .as_ref()
            .filter(|r| r.source_fingerprint == hash)
            .map(|r| r.crop),
        has_crop: f.paths[0].is_file(),
    })
}
fn apply(request: CropRequest) -> Result<CropResult, String> {
    request.bw_params.validate()?;
    if !request.enhance_contrast_level.is_finite()
        || !(0.0..=2.0).contains(&request.enhance_contrast_level)
        || !request.enhance_sharpness_level.is_finite()
        || !(0.0..=1.0).contains(&request.enhance_sharpness_level)
    {
        return Err("Invalid enhancement settings".into());
    }
    let f = family(&request.staging_dir, &request.path)?;
    recover(&f)?;
    let mut source_options = fs::OpenOptions::new();
    source_options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        source_options.share_mode(1);
    }
    // Keep the source readable but deny Windows writers/renames throughout save.
    let _source_lease = source_options
        .open(&f.source)
        .map_err(|e| format!("Original is busy; no crop saved: {e}"))?;
    let bytes = read_bounded(&f.source, 64 * 1024 * 1024)?;
    if fingerprint(&bytes) != request.source_fingerprint {
        return Err("Original changed since the crop editor opened. Refresh before cropping; no files changed.".into());
    }
    let image = decode(&bytes)?;
    let (x, y, w, h) = request.crop.pixels(image.width(), image.height())?;
    let previous = receipt(&f)?;
    let old = owned(&f, previous.as_ref())?;
    let crop_bytes = jpeg_bytes(&image.crop_imm(x, y, w, h))?;
    // Decode the actual cropped JPEG so regeneration matches later batch jobs.
    let cropped = decode(&crop_bytes)?;
    let bw = if request.regenerate_bw {
        Some(jpeg_bytes(&DynamicImage::ImageLuma8(render_bw(
            &cropped,
            &request.bw_params,
        )))?)
    } else {
        None
    };
    let enhanced = if request.regenerate_enhanced {
        Some(jpeg_bytes(&DynamicImage::ImageRgb8(render_enhanced(
            &cropped,
            request.enhance_contrast_level,
            request.enhance_sharpness_level,
        )))?)
    } else {
        None
    };
    let r = Receipt {
        version: 1,
        source_fingerprint: request.source_fingerprint.clone(),
        crop: request.crop,
        crop_fingerprint: fingerprint(&crop_bytes),
        bw_fingerprint: bw.as_deref().map(fingerprint),
        enhanced_fingerprint: enhanced.as_deref().map(fingerprint),
        bw_params: request.bw_params,
        enhance_contrast_level: request.enhance_contrast_level,
        enhance_sharpness_level: request.enhance_sharpness_level,
    };
    if file_fingerprint(&f.source, 64 * 1024 * 1024)?.as_deref()
        != Some(&request.source_fingerprint)
    {
        return Err("Original changed during crop processing. No crop was published.".into());
    }
    let outputs = [true, bw.is_some(), enhanced.is_some()]
        .iter()
        .enumerate()
        .filter(|(_, yes)| **yes)
        .map(|(i, _)| f.paths[i].to_string_lossy().into_owned())
        .collect();
    publish(
        &f,
        old,
        vec![
            Some(crop_bytes),
            bw,
            enhanced,
            Some(serde_json::to_vec_pretty(&r).map_err(|e| e.to_string())?),
        ],
    )?;
    Ok(CropResult {
        crop_path: f.paths[0].to_string_lossy().into_owned(),
        width: w,
        height: h,
        outputs,
        errors: vec![],
    })
}

/// Batch Photo Process can deliberately regenerate an owned crop comparison.
/// Update only that known sibling's fingerprint, never infer ownership by suffix.
pub(super) fn record_processed(
    path: &Path,
    bw: Option<BwParams>,
    contrast: Option<f32>,
    sharpness: Option<f32>,
) -> Result<(), String> {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    if !stem.to_ascii_lowercase().ends_with("_crop") {
        return Ok(());
    }
    let sidecar = path.with_extension("photogogo-crop.json");
    if !sidecar.is_file() {
        return Ok(());
    }
    if file_fingerprint(&sidecar, 64 * 1024)?.is_none() {
        return Ok(());
    }
    let mut r: Receipt = serde_json::from_slice(&read_bounded(&sidecar, 64 * 1024)?)
        .map_err(|e| format!("Crop output saved but its receipt is invalid: {e}"))?;
    if r.version != 1
        || file_fingerprint(path, 64 * 1024 * 1024)?.as_deref() != Some(&r.crop_fingerprint)
    {
        return Err("Crop changed while processing; receipt not updated".into());
    }
    let original = read_bounded(&sidecar, 64 * 1024)?;
    if let Some(params) = bw {
        r.bw_fingerprint = file_fingerprint(
            &path.with_file_name(format!("{stem}_BW.jpg")),
            64 * 1024 * 1024,
        )?;
        r.bw_params = params;
    }
    if let (Some(c), Some(s)) = (contrast, sharpness) {
        r.enhanced_fingerprint = file_fingerprint(
            &path.with_file_name(format!("{stem}_improved.jpg")),
            64 * 1024 * 1024,
        )?;
        r.enhance_contrast_level = c;
        r.enhance_sharpness_level = s;
    }
    // File jobs for the two recipes can finish concurrently: serialize the
    // receipt read-modify-write at the caller seam, below.
    let bytes = serde_json::to_vec_pretty(&r).map_err(|e| e.to_string())?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let temporary = sidecar.with_extension(format!(
        "{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    write_new(&temporary, &bytes)?;
    if read_bounded(&sidecar, 64 * 1024)? != original {
        let _ = fs::remove_file(&temporary);
        return Err("Crop receipt changed; output saved, refresh before re-cropping".into());
    }
    let result = fs::rename(&temporary, &sidecar).map_err(|e| e.to_string());
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[tauri::command]
pub async fn lightbox_crop_info(staging_dir: String, path: String) -> Result<CropInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = EditLease::begin()?;
        inspect(&staging_dir, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn lightbox_apply_crop(
    app: tauri::AppHandle,
    request: CropRequest,
) -> Result<CropResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = EditLease::begin()?;
        let result = apply(request);
        let _ = crate::utils::append_app_log(
            &app,
            match &result {
                Ok(r) => format!(
                    "lightbox_crop completed size={}x{} outputs={} original_untouched=true",
                    r.width,
                    r.height,
                    r.outputs.len()
                ),
                Err(e) => format!("lightbox_crop failed original_untouched=true error={e}"),
            },
        );
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Work(PathBuf);
    impl Work {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let p = std::env::temp_dir().join(format!(
                "pgg-crop-test-{}-{}-{}",
                std::process::id(),
                chrono::Utc::now().timestamp_millis(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&p).unwrap();
            Self(p)
        }
        fn photo(&self, name: &str) -> PathBuf {
            let p = self.0.join(name);
            image::RgbImage::from_fn(120, 80, |x, y| {
                image::Rgb([(x * 2) as u8, (y * 3) as u8, ((x + y) % 255) as u8])
            })
            .save(&p)
            .unwrap();
            p
        }
    }
    impl Drop for Work {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn request(w: &Work, path: &Path) -> CropRequest {
        CropRequest {
            staging_dir: w.0.to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            source_fingerprint: fingerprint(&fs::read(path).unwrap()),
            crop: CropRect {
                x: 0.1,
                y: 0.1,
                width: 0.8,
                height: 0.8,
            },
            regenerate_bw: true,
            regenerate_enhanced: true,
            bw_params: BwParams::default(),
            enhance_contrast_level: 1.0,
            enhance_sharpness_level: 0.5,
        }
    }
    #[test]
    fn crop_success_retains_files_and_source_and_recrops_from_original() {
        let w = Work::new();
        let p = w.photo("photo.jpg");
        let original = fs::read(&p).unwrap();
        w.photo("photo_BW.jpg");
        let prior_bw = fs::read(w.0.join("photo_BW.jpg")).unwrap();
        let first = apply(request(&w, &p)).unwrap();
        assert!(
            Path::new(&first.crop_path).is_file(),
            "Successful crop must remain published"
        );
        assert_eq!(first.outputs.len(), 3);
        assert_eq!(fs::read(&p).unwrap(), original);
        assert_eq!(fs::read(w.0.join("photo_BW.jpg")).unwrap(), prior_bw);
        let mut next = request(&w, &p);
        next.crop = CropRect {
            x: 0.25,
            y: 0.0,
            width: 0.5,
            height: 1.0,
        };
        let crop = next.crop;
        let second = apply(next).unwrap();
        assert_eq!((second.width, second.height), (60, 80));
        assert_eq!(
            fs::read(second.crop_path).unwrap(),
            jpeg_bytes(&decode(&original).unwrap().crop_imm(30, 0, 60, 80)).unwrap()
        );
        assert_eq!(fs::read(p).unwrap(), original);
        let info = inspect(w.0.to_str().unwrap(), "photo.jpg").unwrap();
        assert!(info.has_crop);
        assert_eq!(info.crop.unwrap().x, crop.x);
    }
    #[test]
    fn crop_bounds_and_stale_source_are_rejected_without_outputs() {
        let w = Work::new();
        let p = w.photo("photo.jpg");
        for crop in [
            CropRect {
                x: f64::NAN,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            CropRect {
                x: -0.1,
                y: 0.0,
                width: 0.5,
                height: 1.0,
            },
            CropRect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 1.0,
            },
            CropRect {
                x: 0.7,
                y: 0.0,
                width: 0.5,
                height: 1.0,
            },
            CropRect {
                x: 0.0,
                y: 0.0,
                width: 0.01,
                height: 1.0,
            },
        ] {
            let mut req = request(&w, &p);
            req.crop = crop;
            assert!(apply(req).is_err());
        }
        let mut req = request(&w, &p);
        req.source_fingerprint = "old".into();
        assert!(apply(req).unwrap_err().contains("changed"));
        assert_eq!(fs::read_dir(&w.0).unwrap().count(), 1);
    }
    #[test]
    fn crop_foreign_or_edited_versions_are_never_replaced() {
        let w = Work::new();
        let p = w.photo("photo.jpg");
        let out = w.photo("photo_crop.jpg");
        let bytes = fs::read(&out).unwrap();
        assert!(apply(request(&w, &p)).is_err());
        assert_eq!(fs::read(&out).unwrap(), bytes);
        fs::remove_file(out).unwrap();
        apply(request(&w, &p)).unwrap();
        fs::write(w.0.join("photo_crop_BW.jpg"), b"edited by user").unwrap();
        assert!(apply(request(&w, &p)).is_err());
        assert_eq!(
            fs::read(w.0.join("photo_crop_BW.jpg")).unwrap(),
            b"edited by user"
        );
    }
    #[test]
    fn crop_scope_type_collision_and_chains_are_refused() {
        let w = Work::new();
        let p = w.photo("photo.jpeg");
        let outside = Work::new();
        let other = outside.photo("outside.jpg");
        let mut req = request(&w, &p);
        req.path = other.to_string_lossy().into_owned();
        assert!(apply(req).is_err());
        assert!(family(
            w.0.to_str().unwrap(),
            w.photo("orphan_crop.jpg").to_str().unwrap()
        )
        .is_err());
        w.photo("photo.jpg");
        assert!(apply(request(&w, &p)).is_err());
        let png = w.0.join("false.jpg");
        image::RgbImage::new(60, 60)
            .save_with_format(&png, image::ImageFormat::Png)
            .unwrap();
        assert!(apply(request(&w, &png)).is_err());
    }
    #[test]
    fn crop_tags_remain_associated_and_unchecked_old_crop_versions_are_cleared() {
        let w = Work::new();
        let p = w.photo("photo.jpg");
        apply(request(&w, &p)).unwrap();
        let renamed = w.0.join("photo{Like oo}.jpg");
        fs::rename(p, &renamed).unwrap();
        assert!(
            inspect(w.0.to_str().unwrap(), renamed.to_str().unwrap())
                .unwrap()
                .has_crop
        );
        let mut req = request(&w, &renamed);
        req.regenerate_bw = false;
        req.regenerate_enhanced = false;
        apply(req).unwrap();
        assert!(w.0.join("photo_crop.jpg").is_file());
        assert!(!w.0.join("photo_crop_BW.jpg").exists());
        assert!(!w.0.join("photo_crop_improved.jpg").exists());
    }
    #[test]
    fn crop_processing_matches_actual_crop_jpeg_and_batch_receipt_remains_valid() {
        let w = Work::new();
        let p = w.photo("photo.jpg");
        apply(request(&w, &p)).unwrap();
        let crop = w.0.join("photo_crop.jpg");
        let image = decode(&fs::read(&crop).unwrap()).unwrap();
        assert_eq!(
            fs::read(w.0.join("photo_crop_BW.jpg")).unwrap(),
            jpeg_bytes(&DynamicImage::ImageLuma8(render_bw(
                &image,
                &BwParams::default()
            )))
            .unwrap()
        );
        let params = BwParams {
            sharpness: 0.0,
            curve_strength: 0.0,
            ..BwParams::default()
        };
        let output = w.0.join("photo_crop_BW.jpg");
        fs::write(
            &output,
            jpeg_bytes(&DynamicImage::ImageLuma8(render_bw(&image, &params))).unwrap(),
        )
        .unwrap();
        record_processed(&crop, Some(params), None, None).unwrap();
        assert!(inspect(w.0.to_str().unwrap(), p.to_str().unwrap()).is_ok());
    }
    #[test]
    fn crop_recovers_interrupted_publication_without_losing_previous_outputs() {
        let w = Work::new();
        let p = w.photo("photo.jpg");
        apply(request(&w, &p)).unwrap();
        let f = family(w.0.to_str().unwrap(), p.to_str().unwrap()).unwrap();
        let old = owned(&f, receipt(&f).unwrap().as_ref()).unwrap();
        let before = fs::read(&f.paths[0]).unwrap();
        let dir = w.0.join(format!("{}interrupted.txn", f.prefix));
        fs::create_dir(&dir).unwrap();
        let mut new = old.clone();
        new[0] = Some(fingerprint(b"partial new crop"));
        let j = Journal { old, new };
        write_new(&dir.join("journal.json"), &serde_json::to_vec(&j).unwrap()).unwrap();
        move_new(&f.paths[0], &dir.join("0.old")).unwrap();
        write_new(&f.paths[0], b"partial new crop").unwrap();
        recover(&f).unwrap();
        assert_eq!(fs::read(&f.paths[0]).unwrap(), before);
        assert!(!dir.exists());
    }
    #[test]
    fn crop_recovery_does_not_delete_unknown_or_missing_backup_bytes() {
        let w = Work::new();
        let p = w.photo("photo.jpg");
        let f = family(w.0.to_str().unwrap(), p.to_str().unwrap()).unwrap();
        let dir = w.0.join(format!("{}interrupted.txn", f.prefix));
        fs::create_dir(&dir).unwrap();
        let j = Journal {
            old: vec![Some(fingerprint(b"missing old")), None, None, None],
            new: vec![Some(fingerprint(b"new")), None, None, None],
        };
        write_new(&dir.join("journal.json"), &serde_json::to_vec(&j).unwrap()).unwrap();
        write_new(&f.paths[0], b"new").unwrap();
        assert!(recover(&f).is_err());
        assert_eq!(fs::read(&f.paths[0]).unwrap(), b"new");
        assert!(dir.exists());
    }
    #[test]
    fn crop_all_eight_exif_orientations_use_display_coordinates() {
        let w = Work::new();
        let p = w.photo("photo.jpg");
        let jpeg = fs::read(&p).unwrap();
        for orientation in 1u16..=8 {
            let mut tiff = b"II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
            tiff.extend(orientation.to_le_bytes());
            tiff.extend([0; 6]);
            let mut bytes = jpeg[..2].to_vec();
            bytes.extend([0xff, 0xe1]);
            bytes.extend(((tiff.len() + 8) as u16).to_be_bytes());
            bytes.extend(b"Exif\0\0");
            bytes.extend(tiff);
            bytes.extend(&jpeg[2..]);
            fs::write(&p, &bytes).unwrap();
            let mut req = request(&w, &p);
            req.crop = CropRect {
                x: 0.0,
                y: 0.0,
                width: 0.5,
                height: 0.5,
            };
            req.regenerate_bw = false;
            req.regenerate_enhanced = false;
            let out = apply(req).unwrap();
            let oriented = decode(&bytes).unwrap();
            assert_eq!(
                (out.width, out.height),
                (oriented.width() / 2, oriented.height() / 2)
            );
            assert_eq!(
                fs::read(out.crop_path).unwrap(),
                jpeg_bytes(&oriented.crop_imm(0, 0, out.width, out.height)).unwrap()
            );
            assert_eq!(fs::read(&p).unwrap(), bytes);
        }
    }
    #[test]
    fn crop_lease_is_exclusive_and_managed_crop_is_not_focus_renamed() {
        let lease = EditLease::begin().unwrap();
        assert!(is_editing());
        assert!(EditLease::begin().is_err());
        drop(lease);
        assert!(!is_editing());
        let w = Work::new();
        let p = w.photo("photo.jpg");
        apply(request(&w, &p)).unwrap();
        let focus = super::super::process::collect_process_files(
            &super::super::process::ProcessTask::Focus,
            &w.0,
            false,
        );
        assert_eq!(focus, vec![p]);
        let bw = super::super::process::collect_process_files(
            &super::super::process::ProcessTask::Bw,
            &w.0,
            false,
        );
        assert_eq!(bw.len(), 2);
        assert!(bw.contains(&w.0.join("photo_crop.jpg")));
    }
    #[test]
    fn crop_refuses_oversized_payload_before_any_transaction() {
        let w = Work::new();
        let p = w.photo("photo.jpg");
        let f = family(w.0.to_str().unwrap(), p.to_str().unwrap()).unwrap();
        assert!(publish(
            &f,
            vec![None, None, None, None],
            vec![None, None, None, Some(vec![0; 64 * 1024 + 1])]
        )
        .is_err());
        assert_eq!(fs::read_dir(&w.0).unwrap().count(), 1);
    }
}
