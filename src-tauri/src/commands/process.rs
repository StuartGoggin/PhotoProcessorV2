use image::{DynamicImage, GrayImage, ImageBuffer, Luma, Rgb, RgbImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessProgress {
    pub total: usize,
    pub done: usize,
    pub current_file: String,
    pub phase: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessResult {
    pub processed: usize,
    pub out_of_focus: usize,
    pub errors: Vec<String>,
}

const SECTION_SIZE: u32 = 200;

fn laplacian_variance(gray: &GrayImage, x0: u32, y0: u32, w: u32, h: u32) -> f64 {
    let x1 = (x0 + w).min(gray.width());
    let y1 = (y0 + h).min(gray.height());
    if x1 <= x0 + 2 || y1 <= y0 + 2 {
        return 0.0;
    }

    let mut values: Vec<f64> = Vec::new();
    for y in (y0 + 1)..(y1 - 1) {
        for x in (x0 + 1)..(x1 - 1) {
            let c = gray.get_pixel(x, y)[0] as f64;
            let n = gray.get_pixel(x, y - 1)[0] as f64;
            let s = gray.get_pixel(x, y + 1)[0] as f64;
            let e = gray.get_pixel(x + 1, y)[0] as f64;
            let w = gray.get_pixel(x - 1, y)[0] as f64;
            let lap = (4.0 * c - n - s - e - w).abs();
            values.push(lap);
        }
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let var = values.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / values.len() as f64;
    var
}

fn sobel_variance(gray: &GrayImage, x0: u32, y0: u32, w: u32, h: u32) -> f64 {
    let x1 = (x0 + w).min(gray.width());
    let y1 = (y0 + h).min(gray.height());
    if x1 <= x0 + 2 || y1 <= y0 + 2 {
        return 0.0;
    }

    let mut mags: Vec<f64> = Vec::new();
    for y in (y0 + 1)..(y1 - 1) {
        for x in (x0 + 1)..(x1 - 1) {
            let tl = gray.get_pixel(x - 1, y - 1)[0] as f64;
            let tm = gray.get_pixel(x, y - 1)[0] as f64;
            let tr = gray.get_pixel(x + 1, y - 1)[0] as f64;
            let ml = gray.get_pixel(x - 1, y)[0] as f64;
            let mr = gray.get_pixel(x + 1, y)[0] as f64;
            let bl = gray.get_pixel(x - 1, y + 1)[0] as f64;
            let bm = gray.get_pixel(x, y + 1)[0] as f64;
            let br = gray.get_pixel(x + 1, y + 1)[0] as f64;
            let gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
            let gy = -tl - 2.0 * tm - tr + bl + 2.0 * bm + br;
            mags.push((gx * gx + gy * gy).sqrt());
        }
    }
    let mean = mags.iter().sum::<f64>() / mags.len() as f64;
    mags.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / mags.len() as f64
}

fn focus_score(img: &DynamicImage) -> (f64, f64, f64) {
    let gray = img.to_luma8();
    let w = gray.width();
    let h = gray.height();

    let mut section_scores: Vec<f64> = Vec::new();

    let mut y0 = 0u32;
    while y0 < h {
        let mut x0 = 0u32;
        while x0 < w {
            let lap = laplacian_variance(&gray, x0, y0, SECTION_SIZE, SECTION_SIZE);
            let sob = sobel_variance(&gray, x0, y0, SECTION_SIZE, SECTION_SIZE);
            // Combine: normalise Laplacian (0-100 scale), sobel provides gradient richness
            let score = (lap.sqrt() * 0.7 + sob.sqrt() * 0.3) / 10.0;
            section_scores.push(score);
            x0 += SECTION_SIZE;
        }
        y0 += SECTION_SIZE;
    }

    if section_scores.is_empty() {
        return (0.0, 0.0, 0.0);
    }

    let max_score = section_scores.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let avg_score = section_scores.iter().sum::<f64>() / section_scores.len() as f64;
    let focus_pct = section_scores.iter().filter(|&&s| s >= 2.0).count() as f64
        / section_scores.len() as f64
        * 100.0;

    (max_score, avg_score, focus_pct)
}

fn is_out_of_focus(max_score: f64, avg_score: f64, focus_pct: f64) -> bool {
    max_score < 4.0 || (focus_pct < 10.0 && avg_score < 3.0)
}

fn mark_blurry_filename(path: &Path, n: u32) -> PathBuf {
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_string();
    let new_name = format!("{}{{Out of Focus {}}}.{}", stem, n, ext);
    path.parent().unwrap_or(Path::new(".")).join(new_name)
}

fn apply_clahe_luma(gray: &GrayImage) -> GrayImage {
    let w = gray.width();
    let h = gray.height();
    let tile_w = (w / 8).max(1);
    let tile_h = (h / 8).max(1);
    let clip = 3.0f64;

    let tiles_x = (w + tile_w - 1) / tile_w;
    let tiles_y = (h + tile_h - 1) / tile_h;

    // Build CLHEs per tile
    let mut tile_luts: Vec<Vec<u8>> = Vec::new();
    for ty in 0..tiles_y {
        for tx in 0..tiles_x {
            let x0 = tx * tile_w;
            let y0 = ty * tile_h;
            let x1 = (x0 + tile_w).min(w);
            let y1 = (y0 + tile_h).min(h);
            let pixel_count = ((x1 - x0) * (y1 - y0)) as f64;

            let mut hist = [0f64; 256];
            for y in y0..y1 {
                for x in x0..x1 {
                    hist[gray.get_pixel(x, y)[0] as usize] += 1.0;
                }
            }

            // Clip and redistribute
            let clip_limit = clip * pixel_count / 256.0;
            let mut excess = 0.0f64;
            for v in hist.iter_mut() {
                if *v > clip_limit {
                    excess += *v - clip_limit;
                    *v = clip_limit;
                }
            }
            let redist = excess / 256.0;
            for v in hist.iter_mut() {
                *v += redist;
            }

            // CDF -> LUT
            let mut cdf = 0.0f64;
            let mut lut = [0u8; 256];
            for (i, v) in hist.iter().enumerate() {
                cdf += v;
                lut[i] = ((cdf / pixel_count) * 255.0).round().clamp(0.0, 255.0) as u8;
            }
            tile_luts.push(lut.to_vec());
        }
    }

    // Interpolate
    let mut out = GrayImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let pix = gray.get_pixel(x, y)[0];

            let tx_f = (x as f64 + 0.5) / tile_w as f64 - 0.5;
            let ty_f = (y as f64 + 0.5) / tile_h as f64 - 0.5;
            let tx0 = (tx_f.floor() as i64).clamp(0, tiles_x as i64 - 1) as u32;
            let ty0 = (ty_f.floor() as i64).clamp(0, tiles_y as i64 - 1) as u32;
            let tx1 = (tx0 + 1).min(tiles_x - 1);
            let ty1 = (ty0 + 1).min(tiles_y - 1);

            let wx = (tx_f - tx0 as f64).clamp(0.0, 1.0);
            let wy = (ty_f - ty0 as f64).clamp(0.0, 1.0);

            let idx = |txx: u32, tyy: u32| (tyy * tiles_x + txx) as usize;
            let v00 = tile_luts[idx(tx0, ty0)][pix as usize] as f64;
            let v10 = tile_luts[idx(tx1, ty0)][pix as usize] as f64;
            let v01 = tile_luts[idx(tx0, ty1)][pix as usize] as f64;
            let v11 = tile_luts[idx(tx1, ty1)][pix as usize] as f64;

            let interp = v00 * (1.0 - wx) * (1.0 - wy)
                + v10 * wx * (1.0 - wy)
                + v01 * (1.0 - wx) * wy
                + v11 * wx * wy;

            out.put_pixel(x, y, Luma([interp.round().clamp(0.0, 255.0) as u8]));
        }
    }
    out
}

fn unsharp_mask_rgb(img: &RgbImage, radius: f32, amount: f32) -> RgbImage {
    let w = img.width();
    let h = img.height();
    // Simple box blur approximation for speed
    let blur = blur_rgb(img, radius);
    let mut out = RgbImage::new(w, h);
    for (x, y, px) in img.enumerate_pixels() {
        let b = blur.get_pixel(x, y);
        let sharpened: [u8; 3] = [0, 1, 2].map(|c| {
            let orig = px[c] as f32;
            let blurred = b[c] as f32;
            let val = orig + amount * (orig - blurred);
            val.clamp(0.0, 255.0) as u8
        });
        out.put_pixel(x, y, Rgb(sharpened));
    }
    out
}

fn blur_rgb(img: &RgbImage, _radius: f32) -> RgbImage {
    // 3x3 box blur
    let w = img.width();
    let h = img.height();
    let mut out = RgbImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let mut sums = [0u32; 3];
            let mut count = 0u32;
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let nx = x as i32 + dx;
                    let ny = y as i32 + dy;
                    if nx >= 0 && nx < w as i32 && ny >= 0 && ny < h as i32 {
                        let p = img.get_pixel(nx as u32, ny as u32);
                        sums[0] += p[0] as u32;
                        sums[1] += p[1] as u32;
                        sums[2] += p[2] as u32;
                        count += 1;
                    }
                }
            }
            out.put_pixel(
                x,
                y,
                Rgb([(sums[0] / count) as u8, (sums[1] / count) as u8, (sums[2] / count) as u8]),
            );
        }
    }
    out
}

fn unsharp_mask_gray(img: &GrayImage, radius: f32, amount: f32) -> GrayImage {
    let blur = blur_gray(img, radius);
    let mut out = GrayImage::new(img.width(), img.height());
    for (x, y, px) in img.enumerate_pixels() {
        let b = blur.get_pixel(x, y)[0] as f32;
        let orig = px[0] as f32;
        let val = (orig + amount * (orig - b)).clamp(0.0, 255.0) as u8;
        out.put_pixel(x, y, Luma([val]));
    }
    out
}

fn blur_gray(img: &GrayImage, _radius: f32) -> GrayImage {
    let w = img.width();
    let h = img.height();
    let mut out = GrayImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let mut sum = 0u32;
            let mut count = 0u32;
            for dy in -1i32..=1 {
                for dx in -1i32..=1 {
                    let nx = x as i32 + dx;
                    let ny = y as i32 + dy;
                    if nx >= 0 && nx < w as i32 && ny >= 0 && ny < h as i32 {
                        sum += img.get_pixel(nx as u32, ny as u32)[0] as u32;
                        count += 1;
                    }
                }
            }
            out.put_pixel(x, y, Luma([(sum / count) as u8]));
        }
    }
    out
}

fn enhance_rgb_clahe(rgb: &RgbImage) -> RgbImage {
    // Convert to YCbCr-like: enhance Y (luma) channel via CLAHE, keep chroma
    let w = rgb.width();
    let h = rgb.height();
    let mut y_plane: GrayImage = ImageBuffer::new(w, h);
    let mut cb_plane: Vec<f32> = Vec::with_capacity((w * h) as usize);
    let mut cr_plane: Vec<f32> = Vec::with_capacity((w * h) as usize);

    for (x, y, px) in rgb.enumerate_pixels() {
        let r = px[0] as f32;
        let g = px[1] as f32;
        let b = px[2] as f32;
        let luma = 0.299 * r + 0.587 * g + 0.114 * b;
        y_plane.put_pixel(x, y, Luma([luma.clamp(0.0, 255.0) as u8]));
        cb_plane.push(b - luma);
        cr_plane.push(r - luma);
    }

    let enhanced_y = apply_clahe_luma(&y_plane);
    let sharpened_y = unsharp_mask_gray(&enhanced_y, 1.0, 0.5);

    let mut out = RgbImage::new(w, h);
    for (i, (x, y, _px)) in rgb.enumerate_pixels().enumerate() {
        let luma = sharpened_y.get_pixel(x, y)[0] as f32;
        let cb = cb_plane[i];
        let cr = cr_plane[i];
        let r = (luma + cr).clamp(0.0, 255.0) as u8;
        let g = (luma - 0.194 * cb - 0.509 * cr).clamp(0.0, 255.0) as u8;
        let b = (luma + cb).clamp(0.0, 255.0) as u8;
        out.put_pixel(x, y, Rgb([r, g, b]));
    }
    out
}

fn collect_jpgs(dir: &Path) -> Vec<PathBuf> {
    WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .map(|e| {
                    let el = e.to_lowercase();
                    el == "jpg" || el == "jpeg"
                })
                .unwrap_or(false)
        })
        .filter(|p| {
            // Skip already-processed files
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");
            !name.contains("_improved") && !name.contains("_BW") && !name.contains("{Out of Focus")
        })
        .collect()
}

#[tauri::command]
pub async fn run_focus_detection(
    app: AppHandle,
    staging_dir: String,
) -> Result<ProcessResult, String> {
    let root = PathBuf::from(&staging_dir);
    let jpgs = collect_jpgs(&root);
    let total = jpgs.len();
    let done_count = Arc::new(AtomicU64::new(0));
    let oof_count = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));

    let app_clone = app.clone();
    let done_clone = done_count.clone();
    let oof_clone = oof_count.clone();
    let errors_clone = errors.clone();

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(num_cpus())
        .build()
        .map_err(|e| e.to_string())?;

    pool.install(|| {
        jpgs.par_iter().for_each(|path| {
            let result = (|| -> anyhow::Result<()> {
                let img = image::open(path)?;
                let (max_score, avg_score, focus_pct) = focus_score(&img);

                if is_out_of_focus(max_score, avg_score, focus_pct) {
                    let n = ((10.0 - max_score).round() as u32).clamp(1, 10);
                    let new_path = mark_blurry_filename(path, n);
                    fs::rename(path, &new_path)?;
                    oof_clone.fetch_add(1, Ordering::Relaxed);
                }
                Ok(())
            })();

            if let Err(e) = result {
                errors_clone
                    .lock()
                    .unwrap()
                    .push(format!("{}: {}", path.display(), e));
            }

            let done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = app_clone.emit(
                "process-progress",
                ProcessProgress {
                    total,
                    done: done as usize,
                    current_file: path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string(),
                    phase: "focus".to_string(),
                },
            );
        });
    });


    let errs = errors.lock().unwrap().clone();
    Ok(ProcessResult {
        processed: done_count.load(Ordering::Relaxed) as usize,
        out_of_focus: oof_count.load(Ordering::Relaxed) as usize,
        errors: errs,
    })
}

#[tauri::command]
pub async fn run_enhancement(
    app: AppHandle,
    staging_dir: String,
) -> Result<ProcessResult, String> {
    let root = PathBuf::from(&staging_dir);
    let jpgs = collect_jpgs(&root);
    let total = jpgs.len();
    let done_count = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));

    let app_clone = app.clone();
    let done_clone = done_count.clone();
    let errors_clone = errors.clone();

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(num_cpus())
        .build()
        .map_err(|e| e.to_string())?;

    pool.install(|| {
        jpgs.par_iter().for_each(|path| {
            let result = (|| -> anyhow::Result<()> {
                let img = image::open(path)?.into_rgb8();
                let enhanced = enhance_rgb_clahe(&img);
                let sharpened = unsharp_mask_rgb(&enhanced, 1.0, 0.5);

                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                let out_path = path
                    .parent()
                    .unwrap_or(Path::new("."))
                    .join(format!("{}_improved.jpg", stem));
                sharpened.save(&out_path)?;
                Ok(())
            })();

            if let Err(e) = result {
                errors_clone
                    .lock()
                    .unwrap()
                    .push(format!("{}: {}", path.display(), e));
            }

            let done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = app_clone.emit(
                "process-progress",
                ProcessProgress {
                    total,
                    done: done as usize,
                    current_file: path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string(),
                    phase: "enhance".to_string(),
                },
            );
        });
    });


    let errs = errors.lock().unwrap().clone();
    Ok(ProcessResult {
        processed: done_count.load(Ordering::Relaxed) as usize,
        out_of_focus: 0,
        errors: errs,
    })
}

#[tauri::command]
pub async fn run_bw_conversion(
    app: AppHandle,
    staging_dir: String,
) -> Result<ProcessResult, String> {
    let root = PathBuf::from(&staging_dir);
    let jpgs = collect_jpgs(&root);
    let total = jpgs.len();
    let done_count = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));

    let app_clone = app.clone();
    let done_clone = done_count.clone();
    let errors_clone = errors.clone();

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(num_cpus())
        .build()
        .map_err(|e| e.to_string())?;

    pool.install(|| {
        jpgs.par_iter().for_each(|path| {
            let result = (|| -> anyhow::Result<()> {
                let img = image::open(path)?.into_luma8();
                let clahe = apply_clahe_luma(&img);
                let sharpened = unsharp_mask_gray(&clahe, 1.0, 0.6);

                let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                let out_path = path
                    .parent()
                    .unwrap_or(Path::new("."))
                    .join(format!("{}_BW.jpg", stem));
                sharpened.save(&out_path)?;
                Ok(())
            })();

            if let Err(e) = result {
                errors_clone
                    .lock()
                    .unwrap()
                    .push(format!("{}: {}", path.display(), e));
            }

            let done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = app_clone.emit(
                "process-progress",
                ProcessProgress {
                    total,
                    done: done as usize,
                    current_file: path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string(),
                    phase: "bw".to_string(),
                },
            );
        });
    });


    let errs = errors.lock().unwrap().clone();
    Ok(ProcessResult {
        processed: done_count.load(Ordering::Relaxed) as usize,
        out_of_focus: 0,
        errors: errs,
    })
}

fn num_cpus() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
}
