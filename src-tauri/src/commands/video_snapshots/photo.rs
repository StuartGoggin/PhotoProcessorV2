//! Snapshot pixels, embedded capture time, and collision-safe local publication.
//! The source frame is already decoded by the caller. No source video is written.
use chrono::{DateTime, Datelike, FixedOffset, SecondsFormat, TimeDelta};
use exif::{Field, In, Tag, Value};
use image::{DynamicImage, ImageDecoder, ImageEncoder, RgbImage};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const MAX_PNG_BYTES: usize = 256 * 1024 * 1024;
const MAX_PIXELS: u64 = 40_000_000;
const MAX_PROVENANCE_BYTES: usize = 1024 * 1024;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Crop {
    pub(crate) x: f32,
    pub(crate) y: f32,
    pub(crate) width: f32,
    pub(crate) height: f32,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PhotoRecipe {
    #[serde(default)]
    pub(crate) brightness: f32,
    #[serde(default)]
    pub(crate) contrast: f32,
    #[serde(default)]
    pub(crate) sharpness: f32,
    #[serde(default)]
    pub(crate) crop: Option<Crop>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PhotoExport {
    pub(crate) path: String,
    pub(crate) enhanced_path: Option<String>,
    pub(crate) provenance_path: String,
    pub(crate) captured_at: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

impl PhotoRecipe {
    fn validate(&self) -> Result<(), String> {
        for (label, value, minimum, maximum) in [
            ("Brightness", self.brightness, -0.5, 0.5),
            ("Contrast", self.contrast, -50.0, 50.0),
            ("Sharpness", self.sharpness, 0.0, 2.0),
        ] {
            if !value.is_finite() || !(minimum..=maximum).contains(&value) {
                return Err(format!("{label} must be between {minimum} and {maximum}"));
            }
        }
        if let Some(crop) = &self.crop {
            if ![crop.x, crop.y, crop.width, crop.height]
                .iter()
                .all(|n| n.is_finite())
                || !(0.0..1.0).contains(&crop.x)
                || !(0.0..1.0).contains(&crop.y)
                || !(0.0..=1.0).contains(&crop.width)
                || !(0.0..=1.0).contains(&crop.height)
                || crop.width <= 0.0
                || crop.height <= 0.0
                || crop.x as f64 + crop.width as f64 > 1.000_000_1
                || crop.y as f64 + crop.height as f64 > 1.000_000_1
            {
                return Err("Crop must be a nonempty rectangle inside the source frame".into());
            }
        }
        Ok(())
    }

    fn changed(&self) -> bool {
        self.brightness != 0.0
            || self.contrast != 0.0
            || self.sharpness != 0.0
            || self
                .crop
                .as_ref()
                .is_some_and(|c| c.x != 0.0 || c.y != 0.0 || c.width != 1.0 || c.height != 1.0)
    }
}

fn decode(png: &[u8]) -> Result<RgbImage, String> {
    if png.len() > MAX_PNG_BYTES {
        return Err("Snapshot frame exceeds the 256 MiB input limit".into());
    }
    let decoder = image::codecs::png::PngDecoder::new(Cursor::new(png))
        .map_err(|e| format!("Cannot read the decoded snapshot frame: {e}"))?;
    let (width, height) = decoder.dimensions();
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > MAX_PIXELS
    {
        return Err(
            "Snapshot frames must be at most 8192 pixels per side and 40 megapixels".into(),
        );
    }
    DynamicImage::from_decoder(decoder)
        .map(DynamicImage::into_rgb8)
        .map_err(|e| format!("Cannot decode the snapshot pixels: {e}"))
}

fn apply_recipe(mut pixels: RgbImage, recipe: &PhotoRecipe) -> RgbImage {
    if let Some(crop) = &recipe.crop {
        let (width, height) = pixels.dimensions();
        let left = ((crop.x * width as f32).floor() as u32).min(width - 1);
        let top = ((crop.y * height as f32).floor() as u32).min(height - 1);
        let right = (((crop.x + crop.width) * width as f32).ceil() as u32).clamp(left + 1, width);
        let bottom =
            (((crop.y + crop.height) * height as f32).ceil() as u32).clamp(top + 1, height);
        pixels =
            image::imageops::crop_imm(&pixels, left, top, right - left, bottom - top).to_image();
    }
    if recipe.brightness != 0.0 {
        pixels = image::imageops::brighten(&pixels, (recipe.brightness * 255.0).round() as i32);
    }
    if recipe.contrast != 0.0 {
        pixels = image::imageops::contrast(&pixels, recipe.contrast);
    }
    if recipe.sharpness != 0.0 {
        let blur = image::imageops::blur(&pixels, 1.0);
        for (pixel, blurred) in pixels.pixels_mut().zip(blur.pixels()) {
            for channel in 0..3 {
                let original = f32::from(pixel[channel]);
                pixel[channel] = (original
                    + recipe.sharpness * (original - f32::from(blurred[channel])))
                .round()
                .clamp(0.0, 255.0) as u8;
            }
        }
    }
    pixels
}

fn jpeg(pixels: &RgbImage, quality: u8, metadata: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, quality);
    if let Some(metadata) = metadata {
        encoder
            .set_exif_metadata(metadata)
            .map_err(|e| format!("Cannot embed photo capture time: {e}"))?;
    }
    encoder
        .encode(
            pixels.as_raw(),
            pixels.width(),
            pixels.height(),
            image::ExtendedColorType::Rgb8,
        )
        .map_err(|e| format!("Cannot encode snapshot photo: {e}"))?;
    Ok(bytes)
}

pub(super) fn preview(png: &[u8], recipe: &PhotoRecipe) -> Result<Vec<u8>, String> {
    recipe.validate()?;
    let pixels = apply_recipe(decode(png)?, recipe);
    let pixels = if pixels.width() > 960 || pixels.height() > 960 {
        DynamicImage::ImageRgb8(pixels)
            .resize(960, 960, image::imageops::FilterType::Triangle)
            .into_rgb8()
    } else {
        pixels
    };
    jpeg(&pixels, 88, None)
}

fn capture_time(shooting_start: &str, elapsed_us: i64) -> Result<DateTime<FixedOffset>, String> {
    if elapsed_us < 0 {
        return Err("Source frame position cannot be negative".into());
    }
    let start = DateTime::parse_from_rfc3339(shooting_start).map_err(|_| {
        "Confirm a valid shooting start time including its timezone offset".to_string()
    })?;
    let captured = start
        .checked_add_signed(TimeDelta::microseconds(elapsed_us))
        .ok_or("Photo capture time is outside the supported range")?;
    if !(1..=9999).contains(&start.year()) || !(1..=9999).contains(&captured.year()) {
        return Err("Photo capture year must be between 0001 and 9999".into());
    }
    Ok(captured)
}

fn exif_metadata(captured: &DateTime<FixedOffset>) -> Result<Vec<u8>, String> {
    let ascii = |tag, text: String| Field {
        tag,
        ifd_num: In::PRIMARY,
        value: Value::Ascii(vec![text.into_bytes()]),
    };
    let date = captured.format("%Y:%m:%d %H:%M:%S").to_string();
    // Preserve source-time precision in EXIF; filename milliseconds remain compatible with import.
    let subseconds = format!("{:09}", captured.timestamp_subsec_nanos());
    let offset = captured.format("%:z").to_string();
    let fields = [
        ascii(Tag::DateTimeOriginal, date.clone()),
        ascii(Tag::DateTimeDigitized, date.clone()),
        ascii(Tag::DateTime, date),
        ascii(Tag::SubSecTimeOriginal, subseconds.clone()),
        ascii(Tag::SubSecTimeDigitized, subseconds),
        ascii(Tag::OffsetTimeOriginal, offset.clone()),
        ascii(Tag::OffsetTimeDigitized, offset),
        ascii(Tag::Software, "PhotoGoGo Video snapshots".into()),
        Field {
            tag: Tag::Orientation,
            ifd_num: In::PRIMARY,
            value: Value::Short(vec![1]),
        },
        Field {
            tag: Tag::ColorSpace,
            ifd_num: In::PRIMARY,
            value: Value::Short(vec![1]),
        },
    ];
    let mut writer = exif::experimental::Writer::new();
    for field in &fields {
        writer.push_field(field);
    }
    let mut bytes = Cursor::new(Vec::new());
    writer
        .write(&mut bytes, false)
        .map_err(|e| format!("Cannot prepare photo metadata: {e}"))?;
    Ok(bytes.into_inner())
}

fn safe_person_name(name: &str) -> String {
    let mut result = String::new();
    let mut separator = false;
    for character in name.chars().take(200) {
        if character.is_alphanumeric() || character == '-' {
            if result.len() + character.len_utf8() + usize::from(separator) > 144 {
                break;
            }
            if separator && !result.is_empty() {
                result.push('_');
            }
            separator = false;
            result.push(character);
            if result.chars().count() >= 64 {
                break;
            }
        } else {
            separator = true;
        }
    }
    result
}

fn redirected(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        } // FILE_ATTRIBUTE_REPARSE_POINT
    }
    false
}

fn canonical_directory(path: &Path) -> Result<PathBuf, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|e| format!("Photo destination unavailable: {e}"))?;
    if !metadata.is_dir() || redirected(&metadata) {
        return Err(
            "Photo destination must be an existing local directory, not a redirected link".into(),
        );
    }
    fs::canonicalize(path).map_err(|e| e.to_string())
}

fn date_directory(destination: &Path, captured: &DateTime<FixedOffset>) -> Result<PathBuf, String> {
    let mut directory = canonical_directory(destination)?;
    for part in [
        captured.format("%Y"),
        captured.format("%m"),
        captured.format("%d"),
    ] {
        let child = directory.join(part.to_string());
        match fs::create_dir(&child) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("Cannot create dated photo folder: {error}")),
        }
        if canonical_directory(&child)? != child {
            return Err(
                "Dated photo folder changed or redirects outside the selected destination".into(),
            );
        }
        directory = child;
    }
    Ok(directory)
}

fn digest(bytes: &[u8]) -> String {
    hex::encode(Md5::digest(bytes))
}

fn matches_owned(path: &Path, expected: &[u8]) -> bool {
    if !fs::symlink_metadata(path)
        .map(|m| m.is_file() && !redirected(&m) && m.len() == expected.len() as u64)
        .unwrap_or(false)
    {
        return false;
    }
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut actual = Vec::with_capacity(expected.len());
    file.take(expected.len() as u64 + 1)
        .read_to_end(&mut actual)
        .is_ok()
        && actual == expected
}

// Cleanup applies only to our private, unchanged files, never a published photo.
fn remove_owned(path: &Path, expected: &[u8]) {
    if matches_owned(path, expected) {
        let _ = fs::remove_file(path);
    }
}

struct Temporary {
    path: PathBuf,
    bytes: Vec<u8>,
    published: bool,
}
impl Temporary {
    fn new(directory: &Path, bytes: Vec<u8>) -> Result<Self, String> {
        for _ in 0..100 {
            let serial = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let name = format!(
                ".photogogo-snapshot-{}-{}-{serial}.partial",
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
            );
            let path = directory.join(name);
            match fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(mut file) => {
                    if let Err(error) = file.write_all(&bytes).and_then(|_| file.sync_all()) {
                        // Retain a short write for inspection. Never report it as a photo.
                        return Err(format!(
                            "Cannot finish private snapshot file {}: {error}",
                            path.display()
                        ));
                    }
                    return Ok(Self {
                        path,
                        bytes,
                        published: false,
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(format!("Cannot prepare snapshot file: {error}")),
            }
        }
        Err("Cannot reserve a private snapshot file".into())
    }

    fn publish(&mut self, destination: &Path) -> Result<(), String> {
        let parent = self.path.parent().ok_or("Snapshot file has no parent")?;
        if canonical_directory(parent)? != parent || destination.parent() != Some(parent) {
            return Err("Snapshot output folder changed before publication".into());
        }
        if !matches_owned(&self.path, &self.bytes) {
            return Err("Private snapshot file changed before publication".into());
        }
        publish_new(&self.path, destination).map_err(|e| {
            format!(
                "Cannot publish {} without replacing an existing file: {e}",
                destination.display()
            )
        })?;
        self.published = true;
        Ok(())
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        if !self.published {
            remove_owned(&self.path, &self.bytes);
        }
    }
}

#[cfg(windows)]
fn publish_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    // Same-volume rename, write-through, deliberately without REPLACE_EXISTING.
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 8) } == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(windows))]
fn publish_new(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::hard_link(source, destination)?;
    // Destination now owns complete bytes even if temporary cleanup is unavailable.
    if let Err(error) = fs::remove_file(source) {
        log::warn!("Snapshot temporary retained: {error}");
    }
    Ok(())
}

struct Reservation {
    path: PathBuf,
    bytes: Vec<u8>,
    retain: bool,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if !self.retain {
            remove_owned(&self.path, &self.bytes);
        }
    }
}

fn reserve(directory: &Path, base: &str, improved: bool) -> Result<(String, Reservation), String> {
    for suffix in 0..10_000 {
        let stem = if suffix == 0 {
            base.to_string()
        } else {
            format!("{base}_{suffix}")
        };
        let names = [
            format!("{stem}.jpg"),
            format!("{stem}_improved.jpg"),
            format!("{stem}.snapshot.json"),
            format!("{stem}.snapshot.partial.json"),
        ];
        if names
            .iter()
            .any(|name| fs::symlink_metadata(directory.join(name)).is_ok())
        {
            continue;
        }
        let path = directory.join(&names[3]);
        let bytes = serde_json::to_vec_pretty(&serde_json::json!({
            "schemaVersion": 1, "state": "incomplete", "master": names[0],
            "enhanced": if improved { Some(&names[1]) } else { None },
            "completionMarker": names[2],
            "message": "Only the final .snapshot.json marks a complete export. Retain any existing photos if this operation was interrupted."
        })).map_err(|e| e.to_string())?;
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                file.write_all(&bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|e| {
                        format!("Cannot write snapshot reservation {}: {e}", path.display())
                    })?;
                return Ok((
                    stem,
                    Reservation {
                        path,
                        bytes,
                        retain: false,
                    },
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Cannot reserve photo name: {error}")),
        }
    }
    Err("Too many photos already use this name and capture time; choose another destination".into())
}

/// `png` must be the caller's exact, display-oriented, SDR source frame, not a preview.
/// `recheck` verifies its source/frame identity immediately before publication.
/// The .snapshot.json file is published last and is the export completion marker.
pub(super) fn export(
    png: &[u8],
    destination: &Path,
    shooting_start: &str,
    elapsed_us: i64,
    person_name: &str,
    recipe: &PhotoRecipe,
    provenance: &serde_json::Value,
    recheck: impl Fn() -> Result<(), String>,
) -> Result<PhotoExport, String> {
    recipe.validate()?;
    if person_name.chars().count() > 200 {
        return Err("Person name is limited to 200 characters".into());
    }
    if serde_json::to_vec(provenance)
        .map_err(|e| e.to_string())?
        .len()
        > MAX_PROVENANCE_BYTES
    {
        return Err("Snapshot provenance exceeds its 1 MiB limit".into());
    }
    let captured = capture_time(shooting_start, elapsed_us)?;
    let captured_at = captured.to_rfc3339_opts(SecondsFormat::Nanos, false);
    let name = safe_person_name(person_name);
    let mut base = format!(
        "{}_{:03}",
        captured.format("%Y%m%d_%H%M%S"),
        captured.timestamp_subsec_millis()
    );
    if !name.is_empty() {
        base.push('_');
        base.push_str(&name);
    }
    let pixels = decode(png)?;
    let (width, height) = pixels.dimensions();
    let metadata = exif_metadata(&captured)?;
    let master = jpeg(&pixels, 96, Some(metadata.clone()))?;
    let improved = if recipe.changed() {
        let enhanced = apply_recipe(pixels, recipe);
        let dimensions = enhanced.dimensions();
        Some((jpeg(&enhanced, 96, Some(metadata))?, dimensions))
    } else {
        None
    };
    recheck()?;
    let directory = date_directory(destination, &captured)?;
    let (stem, mut reservation) = reserve(&directory, &base, improved.is_some())?;
    let master_path = directory.join(format!("{stem}.jpg"));
    let improved_path = improved
        .as_ref()
        .map(|_| directory.join(format!("{stem}_improved.jpg")));
    let provenance_path = directory.join(format!("{stem}.snapshot.json"));
    let receipt = serde_json::json!({
        "schemaVersion": 1, "state": "complete", "capturedAt": captured_at,
        "shootingStart": shooting_start, "elapsedSourceMicroseconds": elapsed_us,
        "personName": person_name.trim(), "filenamePerson": name,
        "recipe": recipe, "source": provenance,
        "master": { "file": master_path.file_name().unwrap().to_string_lossy(), "width": width, "height": height, "md5": digest(&master), "unenhanced": true },
        "enhanced": improved.as_ref().map(|(bytes, (w,h))| serde_json::json!({
            "file": improved_path.as_ref().unwrap().file_name().unwrap().to_string_lossy(),
            "width": w, "height": h, "md5": digest(bytes)
        }))
    });
    let mut master_file = Temporary::new(&directory, master)?;
    let mut improved_file = improved
        .map(|(bytes, _)| Temporary::new(&directory, bytes))
        .transpose()?;
    let mut receipt_file = Temporary::new(
        &directory,
        serde_json::to_vec_pretty(&receipt).map_err(|e| e.to_string())?,
    )?;
    recheck()?;
    // From this point a failed operation may have published a photo. Keep its
    // transaction receipt and report exact targets; never delete a final output.
    reservation.retain = true;
    let mut published = Vec::new();
    let outcome = (|| {
        master_file.publish(&master_path)?;
        published.push(master_path.clone());
        if let (Some(file), Some(path)) = (&mut improved_file, &improved_path) {
            file.publish(path)?;
            published.push(path.clone());
        }
        receipt_file.publish(&provenance_path)?;
        Ok::<_, String>(())
    })();
    if let Err(error) = outcome {
        let retained = if published.is_empty() {
            "none".into()
        } else {
            published
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join("; ")
        };
        return Err(format!("Snapshot export was not completed: {error}. Published photos retained: {retained}. Recovery receipt: {}. Existing files were not replaced; retry uses a new name.", reservation.path.display()));
    }
    reservation.retain = false;
    Ok(PhotoExport {
        path: master_path.to_string_lossy().into_owned(),
        enhanced_path: improved_path.map(|p| p.to_string_lossy().into_owned()),
        provenance_path: provenance_path.to_string_lossy().into_owned(),
        captured_at,
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TestRoot(PathBuf);
    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "photogogo-snapshot-photo-test-{}-{}-{}",
                std::process::id(),
                chrono::Utc::now().timestamp_nanos_opt().unwrap(),
                TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn frame(width: u32, height: u32) -> Vec<u8> {
        let image = RgbImage::from_fn(width, height, |x, y| {
            image::Rgb([(x % 200) as u8, (y % 200) as u8, ((x + y) % 200) as u8])
        });
        let mut out = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image)
            .write_to(&mut out, image::ImageFormat::Png)
            .unwrap();
        out.into_inner()
    }
    fn exif_ascii(bytes: &[u8], tag: Tag) -> String {
        let exif = exif::Reader::new()
            .read_from_container(&mut Cursor::new(bytes))
            .unwrap();
        match &exif.get_field(tag, In::PRIMARY).unwrap().value {
            Value::Ascii(parts) => String::from_utf8(parts[0].clone()).unwrap(),
            other => panic!("Expected ASCII, found {other:?}"),
        }
    }
    fn save(root: &Path, png: &[u8], recipe: &PhotoRecipe) -> PhotoExport {
        export(
            png,
            root,
            "2026-12-31T23:59:59.987654+11:00",
            25_000,
            "Jane Smith",
            recipe,
            &serde_json::json!({ "frameIndex": 19, "pts": 1500, "timeBase": "1/60000" }),
            || Ok(()),
        )
        .unwrap()
    }

    #[test]
    fn snapshots_photo_metadata_and_date_rollover_round_trip() {
        let root = TestRoot::new();
        let result = save(&root.0, &frame(48, 32), &PhotoRecipe::default());
        assert!(result.path.ends_with("20270101_000000_012_Jane_Smith.jpg"));
        assert!(Path::new(&result.path)
            .parent()
            .unwrap()
            .ends_with(Path::new("2027/01/01")));
        assert_eq!(result.captured_at, "2027-01-01T00:00:00.012654000+11:00");
        let bytes = fs::read(&result.path).unwrap();
        assert_eq!(
            exif_ascii(&bytes, Tag::DateTimeOriginal),
            "2027:01:01 00:00:00"
        );
        assert_eq!(exif_ascii(&bytes, Tag::SubSecTimeOriginal), "012654000");
        assert_eq!(exif_ascii(&bytes, Tag::OffsetTimeOriginal), "+11:00");
        assert_eq!(
            exif_ascii(&bytes, Tag::DateTimeDigitized),
            "2027:01:01 00:00:00"
        );
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 48);
        assert!(result.enhanced_path.is_none());
        let sidecar: serde_json::Value =
            serde_json::from_slice(&fs::read(&result.provenance_path).unwrap()).unwrap();
        assert_eq!(sidecar["state"], "complete");
        assert_eq!(sidecar["master"]["md5"], digest(&bytes));
        assert!(!String::from_utf8_lossy(&bytes).contains("frameIndex"));
    }

    #[test]
    fn snapshots_photo_requires_explicit_time_and_accepts_fixed_offsets() {
        for text in [
            "2026-01-01T00:00:00",
            "not a date",
            "2026-02-30T00:00:00+00:00",
        ] {
            assert!(capture_time(text, 0).is_err());
        }
        assert!(capture_time("2026-01-01T00:00:00Z", -1).is_err());
        assert_eq!(
            capture_time("2026-01-01T23:59:59-03:30", 2_000_000)
                .unwrap()
                .to_rfc3339(),
            "2026-01-02T00:00:01-03:30"
        );
        assert_eq!(
            capture_time("2024-02-28T23:59:59Z", 2_000_000)
                .unwrap()
                .format("%Y-%m-%d")
                .to_string(),
            "2024-02-29"
        );
    }

    #[test]
    fn snapshots_photo_recipe_and_preview_are_bounded() {
        let png = frame(1200, 100);
        let bytes = preview(&png, &PhotoRecipe::default()).unwrap();
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!(image.width(), 960);
        assert!(image.height() <= 960);
        for recipe in [
            PhotoRecipe {
                brightness: f32::NAN,
                ..Default::default()
            },
            PhotoRecipe {
                contrast: 51.0,
                ..Default::default()
            },
            PhotoRecipe {
                sharpness: -0.1,
                ..Default::default()
            },
            PhotoRecipe {
                crop: Some(Crop {
                    x: 0.9,
                    y: 0.0,
                    width: 0.2,
                    height: 1.0,
                }),
                ..Default::default()
            },
            PhotoRecipe {
                crop: Some(Crop {
                    x: 0.0,
                    y: 0.0,
                    width: 0.0,
                    height: 1.0,
                }),
                ..Default::default()
            },
        ] {
            assert!(preview(&png, &recipe).is_err());
        }
        assert!(preview(b"not png", &PhotoRecipe::default()).is_err());
        assert!(!PhotoRecipe {
            crop: Some(Crop {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 1.0
            }),
            ..Default::default()
        }
        .changed());
        assert_eq!(
            serde_json::from_str::<PhotoRecipe>("{}").unwrap(),
            PhotoRecipe::default()
        );
    }

    #[test]
    fn snapshots_photo_enhancement_preserves_master_and_metadata() {
        let root = TestRoot::new();
        let png = frame(60, 40);
        let original = png.clone();
        let first = save(&root.0, &png, &PhotoRecipe::default());
        let recipe = PhotoRecipe {
            brightness: 0.1,
            contrast: 10.0,
            sharpness: 0.7,
            crop: Some(Crop {
                x: 0.25,
                y: 0.0,
                width: 0.5,
                height: 1.0,
            }),
        };
        let second = save(&root.0, &png, &recipe);
        assert_eq!(png, original);
        assert_eq!(
            fs::read(&first.path).unwrap(),
            fs::read(&second.path).unwrap()
        );
        assert_eq!((second.width, second.height), (60, 40));
        let enhanced = fs::read(second.enhanced_path.unwrap()).unwrap();
        let image = image::load_from_memory(&enhanced).unwrap();
        assert_eq!((image.width(), image.height()), (30, 40));
        assert_eq!(
            exif_ascii(&enhanced, Tag::DateTimeOriginal),
            "2027:01:01 00:00:00"
        );
        assert_eq!(exif_ascii(&enhanced, Tag::OffsetTimeOriginal), "+11:00");
        assert_eq!(exif_ascii(&enhanced, Tag::SubSecTimeOriginal), "012654000");
    }

    #[test]
    fn snapshots_photo_names_cannot_escape_and_collisions_do_not_replace() {
        assert_eq!(
            safe_person_name("../../CON:<Jane>\\Smith\0 / "),
            "CON_Jane_Smith"
        );
        assert_eq!(safe_person_name("  Élodie O'Connor  "), "Élodie_O_Connor");
        assert_eq!(safe_person_name(" ../<>:"), "");
        let root = TestRoot::new();
        let png = frame(24, 24);
        let first = save(&root.0, &png, &PhotoRecipe::default());
        let bytes = fs::read(&first.path).unwrap();
        let second = save(&root.0, &png, &PhotoRecipe::default());
        assert_ne!(first.path, second.path);
        assert!(second.path.ends_with("_Jane_Smith_1.jpg"));
        assert_eq!(fs::read(&first.path).unwrap(), bytes);
        assert!(Path::new(&first.path).starts_with(fs::canonicalize(&root.0).unwrap()));
    }

    #[test]
    fn snapshots_photo_source_recheck_prevents_publication() {
        let root = TestRoot::new();
        let result = export(
            &frame(24, 24),
            &root.0,
            "2026-01-01T00:00:00Z",
            0,
            "",
            &PhotoRecipe::default(),
            &serde_json::json!({}),
            || Err("source changed".into()),
        );
        assert!(result.unwrap_err().contains("source changed"));
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    }

    #[test]
    fn snapshots_photo_final_source_recheck_cleans_only_unchanged_private_files() {
        use std::cell::Cell;
        let root = TestRoot::new();
        let calls = Cell::new(0);
        let date = fs::canonicalize(&root.0).unwrap().join("2026/01/01");
        let result = export(
            &frame(24, 24),
            &root.0,
            "2026-01-01T00:00:00Z",
            0,
            "",
            &PhotoRecipe::default(),
            &serde_json::json!({}),
            || {
                calls.set(calls.get() + 1);
                if calls.get() == 2 {
                    assert!(
                        fs::read_dir(&date).unwrap().count() >= 3,
                        "Temporary photos and transaction prepared"
                    );
                    fs::write(date.join("unrelated.txt"), b"must retain").unwrap();
                    return Err("source replaced after preparation".into());
                }
                Ok(())
            },
        );
        assert!(result.unwrap_err().contains("source replaced"));
        let entries: Vec<_> = fs::read_dir(date)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(entries, vec![std::ffi::OsString::from("unrelated.txt")]);
    }

    #[test]
    fn snapshots_photo_partial_publish_preserves_master_and_collision() {
        use std::cell::Cell;
        let root = TestRoot::new();
        let calls = Cell::new(0);
        let date = fs::canonicalize(&root.0).unwrap().join("2026/01/01");
        let existing = date.join("20260101_000000_000_improved.jpg");
        let result = export(
            &frame(24, 24),
            &root.0,
            "2026-01-01T00:00:00Z",
            0,
            "",
            &PhotoRecipe {
                brightness: 0.1,
                ..Default::default()
            },
            &serde_json::json!({}),
            || {
                calls.set(calls.get() + 1);
                if calls.get() == 2 {
                    fs::write(&existing, b"retain competing photo").unwrap();
                }
                Ok(())
            },
        );
        assert!(result.unwrap_err().contains("Published photos retained:"));
        assert_eq!(fs::read(existing).unwrap(), b"retain competing photo");
        let master = fs::read(date.join("20260101_000000_000.jpg")).unwrap();
        assert_eq!(
            exif_ascii(&master, Tag::DateTimeOriginal),
            "2026:01:01 00:00:00"
        );
        assert!(date
            .join("20260101_000000_000.snapshot.partial.json")
            .is_file());
        assert!(!date.join("20260101_000000_000.snapshot.json").exists());
    }

    #[test]
    fn snapshots_photo_late_collision_retains_existing_and_recovery_receipt() {
        use std::cell::Cell;
        let root = TestRoot::new();
        let calls = Cell::new(0);
        let root_canonical = fs::canonicalize(&root.0).unwrap();
        let victim = root_canonical.join("2026/01/01/20260101_000000_000.jpg");
        let result = export(
            &frame(24, 24),
            &root.0,
            "2026-01-01T00:00:00Z",
            0,
            "",
            &PhotoRecipe::default(),
            &serde_json::json!({}),
            || {
                calls.set(calls.get() + 1);
                if calls.get() == 2 {
                    fs::write(&victim, b"another writer's photo").unwrap();
                }
                Ok(())
            },
        );
        let error = result.unwrap_err();
        assert!(error.contains("Recovery receipt:"));
        assert_eq!(fs::read(&victim).unwrap(), b"another writer's photo");
        assert!(victim
            .parent()
            .unwrap()
            .join("20260101_000000_000.snapshot.partial.json")
            .is_file());
        assert!(!victim
            .parent()
            .unwrap()
            .join("20260101_000000_000.snapshot.json")
            .exists());
    }
}
