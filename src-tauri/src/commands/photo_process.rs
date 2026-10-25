//! Shared photo recipe for preview and final files. Orientation is baked exactly
//! once before analysis/processing; generated JPEGs have no stale rotation tag.
use image::{DynamicImage, GrayImage, ImageDecoder, ImageReader, Luma};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Preview and saved output must show the same compression at 100%.
pub(super) fn jpeg_bytes(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut bytes, 95).encode_image(image).map_err(|e| e.to_string())?;
    Ok(bytes)
}
pub(super) fn save_generated(path: &Path, image: &DynamicImage) -> Result<(), String> {
    use std::io::Write;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    struct Temporary { path: std::path::PathBuf, owned: bool }
    impl Drop for Temporary { fn drop(&mut self) { if self.owned { let _ = std::fs::remove_file(&self.path); } } }
    let bytes = jpeg_bytes(image)?;
    let parent = path.parent().ok_or("Generated photo has no parent folder")?;
    let mut temporary = Temporary { path: parent.join(format!(".photogogo-photo-{}-{}-{}.tmp",std::process::id(),chrono::Utc::now().timestamp_millis(),NEXT.fetch_add(1,std::sync::atomic::Ordering::Relaxed))), owned: false };
    // Publish only a complete JPEG. On disk-full, write failure or a locked
    // destination, the previous generated version is not truncated.
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary.path).map_err(|e| e.to_string())?;
    temporary.owned = true;
    file.write_all(&bytes).map_err(|e| e.to_string())?; file.sync_all().map_err(|e| e.to_string())?; drop(file);
    std::fs::rename(&temporary.path,path).map_err(|e| format!("Cannot publish generated photo; previous output retained: {e}"))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BwParams {
    pub local_contrast: f32,
    pub sharpness: f32,
    pub curve_strength: f32,
    pub shadow_depth: f32,
    pub highlight_lift: f32,
    pub midpoint: f32,
}
impl Default for BwParams {
    fn default() -> Self { Self { local_contrast: 1.0, sharpness: 0.6, curve_strength: 0.25, shadow_depth: 0.12, highlight_lift: 0.12, midpoint: 0.5 } }
}
impl BwParams {
    pub fn validate(&self) -> Result<(), String> {
        for (name, value, min, max) in [
            ("local contrast", self.local_contrast, 0.0, 1.0), ("sharpening", self.sharpness, 0.0, 1.0),
            ("curve strength", self.curve_strength, 0.0, 1.0), ("shadow depth", self.shadow_depth, 0.0, 0.25),
            ("highlight lift", self.highlight_lift, 0.0, 0.25), ("midpoint", self.midpoint, 0.25, 0.75),
        ] {
            if !value.is_finite() || value < min || value > max { return Err(format!("B&W {name} must be between {min} and {max}")); }
        }
        Ok(())
    }
}

pub(super) fn load_oriented(path: &Path) -> Result<DynamicImage, String> {
    if std::fs::metadata(path).map_err(|e| e.to_string())?.len() > 64 * 1024 * 1024 { return Err("Photo exceeds the 64 MiB processing read limit".into()); }
    let mut decoder = ImageReader::open(path).map_err(|e| e.to_string())?.with_guessed_format().map_err(|e| e.to_string())?
        .into_decoder().map_err(|e| e.to_string())?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 100_000_000 { return Err("Photo exceeds the 100 megapixel safety limit".into()); }
    let orientation = decoder.orientation().map_err(|e| e.to_string())?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    image.apply_orientation(orientation);
    Ok(image)
}

/// Monotone cubic Hermite LUT. Endpoints remain black/white and all five anchors
/// remain ordered; harmonic tangents preserve a smooth curve without overshoot.
pub(super) fn tone_lut(params: &BwParams) -> [u8; 256] {
    let p = params.midpoint as f64;
    let x = [0.0, p * 0.5, p, p + (1.0 - p) * 0.5, 1.0];
    let y = [0.0, x[1] - (params.shadow_depth * params.curve_strength) as f64 * p,
        p, x[3] + (params.highlight_lift * params.curve_strength) as f64 * (1.0 - p), 1.0];
    let mut slopes = [0.0; 4];
    for i in 0..4 { slopes[i] = (y[i + 1] - y[i]) / (x[i + 1] - x[i]); }
    let mut tangent = [slopes[0], 0.0, 0.0, 0.0, slopes[3]];
    for i in 1..4 {
        let left = x[i] - x[i - 1]; let right = x[i + 1] - x[i];
        let a = 2.0 * right + left; let b = right + 2.0 * left;
        tangent[i] = (a + b) / (a / slopes[i - 1] + b / slopes[i]);
    }
    std::array::from_fn(|i| {
        let value = i as f64 / 255.0;
        let at = (0..4).find(|&j| value <= x[j + 1]).unwrap_or(3);
        let width = x[at + 1] - x[at]; let t = (value - x[at]) / width;
        let t2 = t * t; let t3 = t2 * t;
        let out = (2.0*t3 - 3.0*t2 + 1.0) * y[at] + (t3 - 2.0*t2 + t) * width * tangent[at]
            + (-2.0*t3 + 3.0*t2) * y[at + 1] + (t3 - t2) * width * tangent[at + 1];
        (out * 255.0).round().clamp(0.0, 255.0) as u8
    })
}

pub(super) fn render_bw(image: &DynamicImage, params: &BwParams) -> GrayImage {
    let original = image.to_luma8();
    let mut adjusted = if params.local_contrast > 0.0 {
        let enhanced = super::process::apply_clahe_luma(&original);
        image::ImageBuffer::from_fn(original.width(), original.height(), |x, y| {
            let a = original.get_pixel(x, y)[0] as f32; let b = enhanced.get_pixel(x, y)[0] as f32;
            Luma([(a + (b - a) * params.local_contrast).round().clamp(0.0, 255.0) as u8])
        })
    } else { original };
    if params.curve_strength > 0.0 {
        let lut = tone_lut(params);
        for pixel in adjusted.pixels_mut() { pixel[0] = lut[pixel[0] as usize]; }
    }
    if params.sharpness > 0.0 { super::process::unsharp_mask_gray(&adjusted, 1.0, params.sharpness) } else { adjusted }
}

pub(super) fn render_enhanced(image: &DynamicImage, contrast: f32, sharpness: f32) -> image::RgbImage {
    let original = image.to_rgb8();
    if contrast == 0.0 {
        return if sharpness > 0.0 { super::process::unsharp_mask_rgb(&original, 1.0, sharpness) } else { original };
    }
    let enhanced = super::process::enhance_rgb_clahe(&original);
    let blended = image::ImageBuffer::from_fn(original.width(), original.height(), |x,y| {
        image::Rgb(std::array::from_fn(|c| {
            let a = original.get_pixel(x,y)[c] as f32; let b = enhanced.get_pixel(x,y)[c] as f32;
            (a + (b-a) * contrast).round().clamp(0.0,255.0) as u8
        }))
    });
    if sharpness > 0.0 { super::process::unsharp_mask_rgb(&blended, 1.0, sharpness) } else { blended }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn neutral_recipe_is_identity_and_s_curve_is_bounded_monotone() {
        let off = BwParams { local_contrast: 0.0, sharpness: 0.0, curve_strength: 0.0, ..BwParams::default() };
        assert_eq!(tone_lut(&off), std::array::from_fn(|i| i as u8));
        let image = DynamicImage::ImageLuma8(image::GrayImage::from_fn(256, 8, |x,_| Luma([x as u8])));
        assert_eq!(render_bw(&image, &off), image.to_luma8());
        for pivot in [0.25, 0.5, 0.75] {
            for strength in [0.0, 0.25, 1.0] {
                let params = BwParams { midpoint: pivot, curve_strength: strength, shadow_depth: 0.25, highlight_lift: 0.25, ..off };
                let lut = tone_lut(&params);
                assert_eq!((lut[0], lut[255]), (0,255)); assert!(lut.windows(2).all(|p| p[0] <= p[1]));
            }
        }
        let curve = tone_lut(&BwParams::default()); assert!(curve[64] < 64); assert!(curve[191] > 191);
    }
    #[test]
    fn recipe_validation_refuses_non_finite_or_out_of_range() {
        assert!(BwParams::default().validate().is_ok());
        assert!(BwParams { midpoint: 0.0, ..BwParams::default() }.validate().is_err());
        assert!(BwParams { sharpness: f32::NAN, ..BwParams::default() }.validate().is_err());
    }

    fn fixture_image() -> image::RgbImage {
        image::RgbImage::from_fn(80,48,|x,y| image::Rgb(if x < 40 { if y < 24 { [230,20,30] } else { [15,40,225] } } else if y < 24 { [30,225,20] } else { [220,210,30] }))
    }

    fn oriented_jpeg(orientation: u16) -> Vec<u8> {
        let mut jpeg = Vec::new(); image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg,98).encode_image(&DynamicImage::ImageRgb8(fixture_image())).unwrap();
        let mut tiff = b"II\x2a\0\x08\0\0\0\x01\0\x12\x01\x03\0\x01\0\0\0".to_vec();
        tiff.extend(orientation.to_le_bytes()); tiff.extend([0;6]);
        let mut output = jpeg[..2].to_vec(); output.extend([0xff,0xe1]); output.extend(((tiff.len()+8) as u16).to_be_bytes());
        output.extend(b"Exif\0\0"); output.extend(tiff); output.extend(&jpeg[2..]); output
    }

    #[test]
    fn all_eight_exif_orientations_preserve_corners_and_generated_orientation() {
        let directory = std::env::temp_dir().join(format!("pgg-photo-orientation-{}",std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        for orientation in 1..=8 {
            let path = directory.join(format!("original-{orientation}.jpg"));
            std::fs::write(&path,oriented_jpeg(orientation)).unwrap();
            let raw = image::open(&path).unwrap().to_rgb8();
            let upright = load_oriented(&path).unwrap();
            let size = if orientation >= 5 { (48,80) } else { (80,48) };
            assert_eq!((upright.width(),upright.height()),size);
            let actual = upright.to_rgb8();
            for (x,y,pixel) in actual.enumerate_pixels() {
                let (sx,sy) = match orientation { 1 => (x,y), 2 => (79-x,y), 3 => (79-x,47-y), 4 => (x,47-y), 5 => (y,x), 6 => (y,47-x), 7 => (79-y,47-x), 8 => (79-y,x), _ => unreachable!() };
                assert_eq!(pixel,raw.get_pixel(sx,sy),"orientation {orientation} corner/pixel {x},{y}");
            }
            let bw = render_bw(&upright,&BwParams::default()); let enhanced = render_enhanced(&upright,1.0,0.5);
            for (suffix,image) in [("bw",DynamicImage::ImageLuma8(bw)),("improved",DynamicImage::ImageRgb8(enhanced))] {
                let out = directory.join(format!("output-{orientation}-{suffix}.jpg")); save_generated(&out,&image).unwrap();
                let mut decoder = ImageReader::open(&out).unwrap().into_decoder().unwrap();
                assert_eq!(decoder.dimensions(),size);
                assert_eq!(decoder.orientation().unwrap(),image::metadata::Orientation::NoTransforms);
            }
        }
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn bw_never_depends_on_enhanced_and_enhancement_off_is_identity() {
        let directory = std::env::temp_dir().join(format!("pgg-photo-independent-{}",std::process::id()));
        std::fs::create_dir_all(&directory).unwrap(); let source = directory.join("original.jpg"); fixture_image().save(&source).unwrap();
        let before = std::fs::read(&source).unwrap();
        let run = || render_bw(&load_oriented(&source).unwrap(),&BwParams::default());
        let first = run(); let enhanced = directory.join("original_improved.jpg");
        std::fs::write(&enhanced,b"not even a JPEG").unwrap(); assert_eq!(run(),first);
        std::fs::remove_file(enhanced).unwrap(); assert_eq!(run(),first);
        let loaded = load_oriented(&source).unwrap(); assert_eq!(render_enhanced(&loaded,0.0,0.0),loaded.to_rgb8());
        assert_eq!(std::fs::read(&source).unwrap(),before); std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn generated_photo_publication_preserves_previous_output_on_failure() {
        let directory = std::env::temp_dir().join(format!("pgg-photo-publish-{}",std::process::id())); std::fs::create_dir_all(&directory).unwrap();
        let target = directory.join("photo_BW.jpg"); let image = DynamicImage::ImageRgb8(fixture_image());
        save_generated(&target,&image).unwrap(); let before = std::fs::read(&target).unwrap();
        #[cfg(windows)] {
            use std::os::windows::fs::OpenOptionsExt;
            let lock = std::fs::OpenOptions::new().read(true).share_mode(0).open(&target).unwrap();
            assert!(save_generated(&target,&image).is_err()); drop(lock);
            assert_eq!(std::fs::read(&target).unwrap(),before);
        }
        let blocked = directory.join("directory.jpg"); std::fs::create_dir(&blocked).unwrap();
        assert!(save_generated(&blocked,&image).is_err()); assert!(blocked.is_dir());
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(),2);
        save_generated(&target,&image).unwrap(); assert_eq!(std::fs::read(&target).unwrap(),before);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
