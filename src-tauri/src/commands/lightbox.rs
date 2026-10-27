//! Bounded, read-only full-resolution Lightbox payloads. File IO and base64
//! encoding run away from the UI thread. RAW display uses a labelled embedded
//! camera preview; only RAW Development can create full-quality RAW outputs.
use image::ImageReader;
use serde::Serialize;
use std::io::{Cursor, Read};
use std::path::Path;

const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_IMAGE_PIXELS: u64 = 100_000_000;

#[derive(Debug, Serialize)]
pub struct LightboxImage {
    data: String,
    mime: &'static str,
    width: u32,
    height: u32,
    #[serde(skip_serializing_if="Option::is_none")]
    source: Option<&'static str>,
    #[serde(rename="sourceWidth",skip_serializing_if="Option::is_none")]
    source_width: Option<u32>,
    #[serde(rename="sourceHeight",skip_serializing_if="Option::is_none")]
    source_height: Option<u32>,
}

fn read_payload(path: &Path) -> Result<LightboxImage, String> {
    if super::raw_development::is_raw(path) {
        super::raw_development::reject_link(path)?;
        let(image,w,h)=super::raw_development::worker::camera_preview(path)?;
        let image=image.thumbnail(2000,2000);
        let bytes=super::photo_process::jpeg_bytes(&image)?;
        return Ok(LightboxImage {data:crate::utils::base64_encode(&bytes),mime:"image/jpeg",width:image.width(),height:image.height(),source:Some("cameraPreview"),source_width:Some(w),source_height:Some(h)});
    }
    let file = std::fs::File::open(path).map_err(|error| error.to_string())?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    if length > MAX_IMAGE_BYTES { return Err("Image exceeds the 64 MiB Lightbox read limit".into()); }
    let mut data = Vec::new();
    file.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut data).map_err(|error| error.to_string())?;
    if data.len() as u64 > MAX_IMAGE_BYTES { return Err("Image grew beyond the Lightbox read limit".into()); }
    let reader = ImageReader::new(Cursor::new(&data)).with_guessed_format().map_err(|error| error.to_string())?;
    let mime = match reader.format() {
        Some(image::ImageFormat::Jpeg) => "image/jpeg",
        Some(image::ImageFormat::Png) => "image/png",
        _ => return Err("Lightbox supports JPEG and PNG display; RAW decoding is not available".into()),
    };
    let (width, height) = reader.into_dimensions().map_err(|error| error.to_string())?;
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS {
        return Err("Image dimensions exceed the Lightbox safety limit".into());
    }
    Ok(LightboxImage { data: crate::utils::base64_encode(&data), mime, width, height, source:None,source_width:None,source_height:None })
}

#[tauri::command]
pub async fn read_lightbox_image(path: String) -> Result<LightboxImage, String> {
    tauri::async_runtime::spawn_blocking(move || read_payload(Path::new(&path)))
        .await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn full_resolution_and_content_mime_are_preserved() {
        let directory = std::env::temp_dir().join(format!("pgg-lightbox-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join("original.jpg");
        image::RgbImage::new(1920, 1080).save(&path).unwrap();
        let result = read_payload(&path).unwrap();
        assert_eq!((result.width, result.height), (1920, 1080));
        assert_eq!(result.mime, "image/jpeg");
        assert_eq!(result.data, crate::utils::base64_encode(&std::fs::read(&path).unwrap()));
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&directory).unwrap();
    }
    #[test]
    fn missing_invalid_and_oversized_files_are_refused() {
        let path = std::env::temp_dir().join(format!("pgg-lightbox-invalid-{}", std::process::id()));
        assert!(read_payload(&path).is_err());
        std::fs::write(&path, b"not a photo").unwrap();
        assert!(read_payload(&path).is_err());
        std::fs::File::create(&path).unwrap().set_len(MAX_IMAGE_BYTES + 1).unwrap();
        assert!(read_payload(&path).unwrap_err().contains("64 MiB"));
        std::fs::remove_file(path).unwrap();
    }
}
