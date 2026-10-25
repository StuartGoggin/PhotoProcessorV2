//! Upload-only copies: no source mutation or image recompression. Missing dates
//! are disclosed, never replaced by the folder/event date.
use super::model::{PhotoVariant, PlanItem};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
pub struct Prepared {
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub width: u32,
    pub height: u32,
    pub mime: String,
    pub capture_date: Option<String>,
}
pub fn hash_file(path: &Path) -> Result<String, String> {
    let file = File::open(path).map_err(|_| "Photo is no longer readable.")?;
    let mut hasher = Sha256::new();
    let mut bytes = [0_u8; 65536];
    let mut file = file.take(200_000_001);
    let mut total = 0;
    loop {
        let count = file
            .read(&mut bytes)
            .map_err(|_| "Could not fingerprint photo bytes.")?;
        if count == 0 {
            break;
        }
        total += count;
        if total > 200_000_000 {
            return Err("Photo exceeds the 200 MB upload safety limit.".into());
        }
        hasher.update(&bytes[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}
fn jpeg_metadata(path: &Path) -> Option<exif::Exif> {
    exif::Reader::new()
        .read_from_container(&mut std::io::BufReader::new(File::open(path).ok()?))
        .ok()
}
pub fn capture_date(path: &Path) -> Option<String> {
    let exif = jpeg_metadata(path)?;
    let field = exif
        .get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)
        .or_else(|| exif.get_field(exif::Tag::DateTimeDigitized, exif::In::PRIMARY))?;
    let exif::Value::Ascii(values) = &field.value else {
        return None;
    };
    let date = String::from_utf8_lossy(values.first()?)
        .trim_matches(char::from(0))
        .to_string();
    chrono::NaiveDateTime::parse_from_str(&date, "%Y:%m:%d %H:%M:%S").ok()?;
    Some(date)
}
fn is_derived(item: &PlanItem) -> bool {
    item.variant != PhotoVariant::Original
}
pub fn needs_tool(item: &PlanItem) -> bool {
    is_derived(item) || item.strip_gps
}
pub fn tool_path(directory: &str) -> PathBuf {
    crate::commands::metadata_tools::resolve(directory).0
}
fn run_tool(tool: &Path, args: &[std::ffi::OsString]) -> Result<Vec<u8>, String> {
    crate::commands::metadata_tools::run(tool, args)
}
pub fn check_tool(directory: &str) -> bool {
    crate::commands::metadata_tools::check(directory)
}
/// SHA over JPEG coding markers + entropy; ignores metadata-only APP/COM
/// segments. ExifTool edits must not change the actual encoded image payload.
fn jpeg_picture_hash(bytes: &[u8]) -> Result<String, String> {
    if !bytes.starts_with(&[255, 216]) {
        return Err("Invalid JPEG header.".into());
    }
    let mut hash = Sha256::new();
    let mut offset = 2;
    while offset + 1 < bytes.len() {
        if bytes[offset] != 255 {
            return Err("Invalid JPEG marker.".into());
        }
        let marker = bytes[offset + 1];
        if marker == 0xda {
            hash.update(&bytes[offset..]);
            return Ok(hex::encode(hash.finalize()));
        }
        if marker == 0xd9 {
            return Err("JPEG has no image scan.".into());
        }
        if offset + 4 > bytes.len() {
            return Err("Truncated JPEG.".into());
        }
        let length = u16::from_be_bytes([bytes[offset + 2], bytes[offset + 3]]) as usize;
        if length < 2 || offset + 2 + length > bytes.len() {
            return Err("Truncated JPEG metadata.".into());
        }
        if !(0xe0..=0xef).contains(&marker) && marker != 0xfe {
            hash.update(&bytes[offset..offset + 2 + length]);
        }
        offset += 2 + length;
    }
    Err("JPEG has no image scan.".into())
}
fn dimensions(path: &Path) -> Result<(u32, u32), String> {
    let size = image::ImageReader::open(path)
        .map_err(|_| "Could not inspect upload image.")?
        .with_guessed_format()
        .map_err(|_| "Could not identify upload image.")?
        .into_dimensions()
        .map_err(|_| "Invalid photo dimensions.")?;
    if size.0 == 0 || size.1 == 0 || u64::from(size.0) * u64::from(size.1) > 100_000_000 {
        return Err("Photo exceeds the 100 megapixel validation safety limit.".into());
    }
    Ok(size)
}
fn icc_colour_space(path: &Path) -> Result<Option<[u8; 4]>, String> {
    let mut file = File::open(path).map_err(|_| "Cannot inspect original colour metadata.")?;
    let mut marker = [0_u8; 2];
    file.read_exact(&mut marker)
        .map_err(|_| "Cannot inspect original colour metadata.")?;
    if marker != [255, 216] {
        return Ok(None);
    }
    for _ in 0..4096 {
        file.read_exact(&mut marker)
            .map_err(|_| "Truncated JPEG colour metadata.")?;
        if marker[0] != 255 {
            return Err("Invalid JPEG colour marker.".into());
        }
        if marker[1] == 0xda || marker[1] == 0xd9 {
            return Ok(None);
        }
        let mut length = [0_u8; 2];
        file.read_exact(&mut length)
            .map_err(|_| "Truncated colour metadata.")?;
        let length = u16::from_be_bytes(length) as usize;
        if length < 2 {
            return Err("Invalid JPEG colour segment.".into());
        }
        let mut data = vec![0_u8; length - 2];
        file.read_exact(&mut data)
            .map_err(|_| "Truncated colour segment.")?;
        if marker[1] == 0xe2 && data.starts_with(b"ICC_PROFILE\0") && data.get(12) == Some(&1) {
            let bytes: [u8; 4] = data
                .get(30..34)
                .ok_or("Original ICC profile is truncated.")?
                .try_into()
                .unwrap();
            return Ok(Some(bytes));
        }
    }
    Err("Original colour metadata exceeds its safety limit.".into())
}
pub fn validate_item(item: &PlanItem) -> Result<(), String> {
    let path = Path::new(&item.path);
    let reader = image::ImageReader::open(path)
        .map_err(|_| "Photo cannot be opened.")?
        .with_guessed_format()
        .map_err(|_| "Photo format cannot be identified.")?;
    let extension = path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        (extension.as_str(), reader.format()),
        ("jpg" | "jpeg", Some(image::ImageFormat::Jpeg)) | ("png", Some(image::ImageFormat::Png))
    ) {
        return Err("Photo contents do not match the validated JPEG/PNG filename format.".into());
    }
    dimensions(path)?;
    if is_derived(item) && !matches!(item.variant, PhotoVariant::Bw | PhotoVariant::CropBw) {
        let origin = Path::new(&item.original_path);
        match icc_colour_space(origin)? {
            Some(space) if &space != b"RGB " => return Err("The original has a non-RGB ICC profile incompatible with this generated RGB JPEG. Upload the original or create a colour-managed sRGB version first.".into()),
            None if jpeg_metadata(origin).and_then(|e| e.get_field(exif::Tag::ColorSpace, exif::In::PRIMARY).and_then(|f| f.value.get_uint(0))).is_some_and(|space| space != 1) => return Err("The original declares non-sRGB/uncalibrated colour without an embedded RGB ICC profile. Upload its original or a colour-managed sRGB version; the app will not guess the generated photo's colour profile.".into()),
            _ => {}
        }
    }
    Ok(())
}
pub fn prepare(
    item: &PlanItem,
    destination: &Path,
    exiftool_dir: &str,
) -> Result<Prepared, String> {
    let source = Path::new(&item.path);
    super::store::reject_link(source)?;
    validate_item(item)?;
    let before = hash_file(source)?;
    if before != item.source_sha256 {
        return Err("Photo changed since this plan was reviewed. Create a fresh plan; no changed bytes were uploaded.".into());
    }
    let (width, height) = dimensions(source)?;
    let ext = source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match ext.as_str() { "jpg" | "jpeg" => "image/jpeg", "png" => "image/png", _ => return Err("This version uploads verified JPEG and PNG photos; unsupported files are never silently converted.".into()) };
    let origin = Path::new(&item.original_path);
    let origin_before = if origin == source {
        before.clone()
    } else {
        hash_file(origin)?
    };
    if origin_before != item.original_sha256 {
        return Err("Original metadata lineage changed since review. Upload refused.".into());
    }
    let expected_date = capture_date(source).or_else(|| capture_date(origin));
    let input = File::open(source).map_err(|_| "Cannot open photo for upload copy.")?;
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|_| "Cannot create isolated upload copy.")?;
    struct PartialCopy<'a> {
        path: &'a Path,
        keep: bool,
    }
    impl Drop for PartialCopy<'_> {
        fn drop(&mut self) {
            if !self.keep {
                let _ = fs::remove_file(self.path);
            }
        }
    }
    let mut cleanup = PartialCopy {
        path: destination,
        keep: false,
    };
    let copied = std::io::copy(&mut input.take(200_000_001), &mut output)
        .map_err(|_| "Could not prepare full-resolution upload copy.")?;
    if copied > 200_000_000 {
        return Err("Photo grew beyond the upload-copy safety limit.".into());
    }
    output
        .flush()
        .and_then(|_| output.sync_all())
        .map_err(|_| "Cannot flush upload copy.")?;
    drop(output);
    if hash_file(destination)? != before {
        return Err("Upload copy checksum differs from the reviewed photo.".into());
    }
    if needs_tool(item) {
        if ext != "jpg" && ext != "jpeg" {
            return Err("Metadata/GPS-safe upload copies currently require JPEG. PNG originals without metadata changes remain supported.".into());
        }
        let before_picture =
            jpeg_picture_hash(&fs::read(destination).map_err(|_| "Cannot verify upload copy.")?)?;
        let mut args: Vec<std::ffi::OsString> = vec!["-overwrite_original".into(), "-P".into()];
        if is_derived(item) {
            super::store::reject_link(origin)?;
            args.extend([
                "-TagsFromFile".into(),
                origin.as_os_str().to_owned(),
                "-EXIF:DateTimeOriginal".into(),
                "-EXIF:CreateDate".into(),
                "-EXIF:OffsetTimeOriginal".into(),
                "-EXIF:OffsetTimeDigitized".into(),
                "-EXIF:SubSecTimeOriginal".into(),
                "-EXIF:SubSecTimeDigitized".into(),
            ]);
            // Generated B&W is grayscale: never attach an RGB original's ICC.
            if !matches!(item.variant, PhotoVariant::Bw | PhotoVariant::CropBw) {
                args.push("-ICC_Profile".into());
            } else {
                args.push("-ICC_Profile=".into());
            }
            if !item.strip_gps {
                args.extend(["-GPS:all".into(), "-XMP:GPS*".into()]);
            }
            args.extend([
                "-EXIF:Orientation#=1".into(),
                "-ThumbnailImage=".into(),
                "-PreviewImage=".into(),
            ]);
        }
        if item.strip_gps {
            args.extend(["-GPS:all=".into(), "-XMP:GPS*=".into()]);
        }
        args.push(destination.as_os_str().to_owned());
        run_tool(&tool_path(exiftool_dir), &args)?;
        let after_picture =
            jpeg_picture_hash(&fs::read(destination).map_err(|_| "Cannot verify upload pixels.")?)?;
        if before_picture != after_picture || dimensions(destination)? != (width, height) {
            return Err("Upload metadata preparation changed encoded image pixels/dimensions. Upload refused.".into());
        }
        if expected_date.is_some() && capture_date(destination) != expected_date {
            return Err("Capture-date restoration did not verify. Upload refused instead of assigning an incorrect date.".into());
        }
        if item.strip_gps {
            let metadata = run_tool(
                &tool_path(exiftool_dir),
                &[
                    "-j".into(),
                    "-GPS:all".into(),
                    "-XMP:GPS*".into(),
                    destination.as_os_str().to_owned(),
                ],
            )?;
            let values: Vec<serde_json::Value> =
                serde_json::from_slice(&metadata).map_err(|_| "Could not verify GPS removal.")?;
            if values.len() != 1
                || values[0]
                    .as_object()
                    .is_none_or(|o| o.keys().any(|key| key != "SourceFile"))
            {
                return Err("GPS removal did not verify; upload refused.".into());
            }
        }
    }
    if hash_file(source)? != before {
        return Err(
            "Source changed while the upload copy was prepared. Re-plan before uploading.".into(),
        );
    }
    if origin != source && hash_file(origin)? != origin_before {
        return Err("Original metadata changed during preparation. Upload refused.".into());
    }
    let result = Prepared {
        path: destination.to_string_lossy().into(),
        sha256: hash_file(destination)?,
        bytes: fs::metadata(destination)
            .map_err(|_| "Upload copy disappeared.")?
            .len(),
        width,
        height,
        mime: mime.into(),
        capture_date: expected_date,
    };
    cleanup.keep = true;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires the pinned portable metadata bundle; synthetic photos only"]
    fn bundled_exiftool_restores_dates_and_gps_without_reencoding_sources() {
        use super::super::model::PlanItemStatus;
        let tool = std::env::var_os("PHOTOGOGO_TEST_EXIFTOOL").map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tools/exiftool/exiftool_files/perl.exe"));
        assert!(check_tool(tool.to_str().unwrap()), "complete pinned runtime required");
        let root = std::env::temp_dir().join(format!("pgg-metadata-café-馬-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let original = root.join("original été.jpg");
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut jpeg).encode_image(
            &image::DynamicImage::ImageRgb8(image::RgbImage::new(40, 60))).unwrap();
        fs::write(&original, jpeg).unwrap();
        let profile = tool.parent().unwrap().join("t/images/ICC_Profile.icc");
        run_tool(&tool, &[
            "-overwrite_original".into(), "-DateTimeOriginal=2026:10:24 10:42:32".into(),
            "-OffsetTimeOriginal=+11:00".into(), "-SubSecTimeOriginal=360".into(),
            "-Orientation#=6".into(), "-GPSLatitude=37.8".into(), "-GPSLatitudeRef=S".into(),
            "-GPSLongitude=145.0".into(), "-GPSLongitudeRef=E".into(),
            format!("-ICC_Profile<={}", profile.display()).into(), original.as_os_str().to_owned(),
        ]).unwrap();
        let original_hash = hash_file(&original).unwrap();
        for variant in [PhotoVariant::Enhanced, PhotoVariant::Bw] {
            let source = root.join(format!("derived-{variant:?}.jpg"));
            let mut bytes = Vec::new();
            let image = if variant == PhotoVariant::Bw {
                image::DynamicImage::ImageLuma8(image::GrayImage::new(40,60))
            } else { image::DynamicImage::ImageRgb8(image::RgbImage::new(40,60)) };
            image::codecs::jpeg::JpegEncoder::new(&mut bytes).encode_image(&image).unwrap();
            fs::write(&source, &bytes).unwrap();
            let source_hash = hash_file(&source).unwrap();
            for strip_gps in [false, true] {
                let destination = root.join(format!("upload-{variant:?}-{strip_gps}.jpg"));
                let item = PlanItem { id:"fixture".into(), relative_path:"fixture.jpg".into(),
                    variant, bytes:bytes.len() as u64, status:PlanItemStatus::Ready, warnings:vec![],
                    path:source.to_string_lossy().into(), original_path:original.to_string_lossy().into(),
                    source_sha256:source_hash.clone(), original_sha256:original_hash.clone(),
                    modified_ms:0,event_name:"test".into(),event_date:None,album_key:"test".into(),strip_gps };
                let prepared = prepare(&item,&destination,tool.to_str().unwrap()).unwrap();
                assert_eq!(prepared.capture_date.as_deref(),Some("2026:10:24 10:42:32"));
                assert_eq!((prepared.width,prepared.height),(40,60));
                assert_eq!(jpeg_picture_hash(&bytes).unwrap(),jpeg_picture_hash(&fs::read(&destination).unwrap()).unwrap());
                assert_eq!(icc_colour_space(&destination).unwrap(),if variant == PhotoVariant::Bw {None}else{Some(*b"RGB ")});
                let read = run_tool(&tool,&["-j".into(),"-n".into(),"-Orientation".into(),"-OffsetTimeOriginal".into(),"-SubSecTimeOriginal".into(),"-GPSLatitude".into(),destination.as_os_str().to_owned()]).unwrap();
                let value: Vec<serde_json::Value> = serde_json::from_slice(&read).unwrap();
                assert_eq!(value[0]["Orientation"],1);
                assert_eq!(value[0]["OffsetTimeOriginal"],"+11:00");
                assert_eq!(value[0]["SubSecTimeOriginal"].to_string().trim_matches('"'),"360");
                assert_eq!(value[0].get("GPSLatitude").is_none(),strip_gps);
                assert_eq!(hash_file(&source).unwrap(),source_hash);
                assert_eq!(hash_file(&original).unwrap(),original_hash);
            }
        }
        fs::remove_dir_all(&root).unwrap();
    }
    #[test]
    fn metadata_can_change_without_changing_encoded_pixels() {
        let mut jpeg = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut jpeg)
            .encode_image(&image::DynamicImage::ImageRgb8(image::RgbImage::new(
                10, 20,
            )))
            .unwrap();
        let base = jpeg_picture_hash(&jpeg).unwrap();
        let mut tagged = vec![255, 216, 255, 225, 0, 6, 1, 2, 3, 4];
        tagged.extend_from_slice(&jpeg[2..]);
        assert_eq!(base, jpeg_picture_hash(&tagged).unwrap());
        *tagged.last_mut().unwrap() ^= 1;
        assert_ne!(base, jpeg_picture_hash(&tagged).unwrap());
    }
}
