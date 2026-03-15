use image::{DynamicImage, GrayImage, ImageBuffer, Luma, Rgb, RgbImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::async_runtime;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;
use crate::utils::{append_app_log, num_cpus};

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessTask {
    Focus,
    Enhance,
    Bw,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessJobStatus {
    Queued,
    Running,
    Paused,
    Aborted,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessJob {
    pub id: String,
    pub task: ProcessTask,
    pub staging_dir: String,
    pub status: ProcessJobStatus,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub total: usize,
    pub done: usize,
    pub processed: usize,
    pub out_of_focus: usize,
    pub current_file: String,
    pub errors: Vec<String>,
    pub logs: Vec<String>,
    pub pause_requested: bool,
    pub abort_requested: bool,
}

fn process_jobs_store() -> &'static Mutex<HashMap<String, ProcessJob>> {
    static STORE: OnceLock<Mutex<HashMap<String, ProcessJob>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_process_job_id() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    format!("process-job-{}", id)
}

fn now_string() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string()
}

fn update_process_job(job_id: &str, mutator: impl FnOnce(&mut ProcessJob)) {
    if let Ok(mut jobs) = process_jobs_store().lock() {
        if let Some(job) = jobs.get_mut(job_id) {
            mutator(job);
        }
    }
}

fn append_process_job_log(job_id: &str, message: impl AsRef<str>) {
    let ts = now_string();
    update_process_job(job_id, |job| {
        job.logs.push(format!("[{}] {}", ts, message.as_ref()));
        if job.logs.len() > 2000 {
            let to_drop = job.logs.len() - 2000;
            job.logs.drain(0..to_drop);
        }
    });
}

fn wait_if_process_paused_or_aborted(job_id: Option<&str>) -> bool {
    let Some(job_id) = job_id else { return false; };

    loop {
        let (pause_requested, abort_requested) = match process_jobs_store().lock() {
            Ok(jobs) => match jobs.get(job_id) {
                Some(job) => (job.pause_requested, job.abort_requested),
                None => return true,
            },
            Err(_) => return true,
        };

        if abort_requested {
            return true;
        }

        if pause_requested {
            update_process_job(job_id, |job| {
                if !matches!(job.status, ProcessJobStatus::Paused) {
                    job.status = ProcessJobStatus::Paused;
                    job.current_file = "Paused".to_string();
                }
            });
            thread::sleep(Duration::from_millis(200));
            continue;
        }

        update_process_job(job_id, |job| {
            if matches!(job.status, ProcessJobStatus::Paused) {
                job.status = ProcessJobStatus::Running;
            }
        });
        return false;
    }
}

#[tauri::command]
pub fn list_process_jobs() -> Result<Vec<ProcessJob>, String> {
    let jobs = process_jobs_store().lock().map_err(|e| e.to_string())?;
    let mut out: Vec<ProcessJob> = jobs.values().cloned().collect();
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[tauri::command]
pub fn clear_finished_process_jobs() -> Result<usize, String> {
    let mut jobs = process_jobs_store().lock().map_err(|e| e.to_string())?;
    let before = jobs.len();
    jobs.retain(|_, job| !matches!(job.status, ProcessJobStatus::Completed | ProcessJobStatus::Failed | ProcessJobStatus::Aborted));
    Ok(before.saturating_sub(jobs.len()))
}

#[tauri::command]
pub fn pause_process_job(job_id: String) -> Result<bool, String> {
    let mut jobs = process_jobs_store().lock().map_err(|e| e.to_string())?;
    let Some(job) = jobs.get_mut(&job_id) else { return Ok(false); };
    if matches!(job.status, ProcessJobStatus::Completed | ProcessJobStatus::Failed | ProcessJobStatus::Aborted) {
        return Ok(false);
    }
    job.pause_requested = true;
    job.status = ProcessJobStatus::Paused;
    job.current_file = "Paused".to_string();
    job.logs.push(format!("[{}] pause requested", now_string()));
    Ok(true)
}

#[tauri::command]
pub fn resume_process_job(job_id: String) -> Result<bool, String> {
    let mut jobs = process_jobs_store().lock().map_err(|e| e.to_string())?;
    let Some(job) = jobs.get_mut(&job_id) else { return Ok(false); };
    if matches!(job.status, ProcessJobStatus::Completed | ProcessJobStatus::Failed | ProcessJobStatus::Aborted) {
        return Ok(false);
    }
    job.pause_requested = false;
    job.status = ProcessJobStatus::Running;
    job.logs.push(format!("[{}] resume requested", now_string()));
    Ok(true)
}

#[tauri::command]
pub fn abort_process_job(job_id: String) -> Result<bool, String> {
    let mut jobs = process_jobs_store().lock().map_err(|e| e.to_string())?;
    let Some(job) = jobs.get_mut(&job_id) else { return Ok(false); };
    if matches!(job.status, ProcessJobStatus::Completed | ProcessJobStatus::Failed | ProcessJobStatus::Aborted) {
        return Ok(false);
    }
    job.abort_requested = true;
    job.pause_requested = false;
    job.current_file = "Abort requested".to_string();
    job.logs.push(format!("[{}] abort requested", now_string()));
    Ok(true)
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
    async_runtime::spawn_blocking(move || run_process_task(app, staging_dir, ProcessTask::Focus, None))
        .await
        .map_err(|e| format!("Process background task failed: {}", e))?
}

#[tauri::command]
pub async fn run_enhancement(
    app: AppHandle,
    staging_dir: String,
) -> Result<ProcessResult, String> {
    async_runtime::spawn_blocking(move || run_process_task(app, staging_dir, ProcessTask::Enhance, None))
        .await
        .map_err(|e| format!("Process background task failed: {}", e))?
}

#[tauri::command]
pub async fn run_bw_conversion(
    app: AppHandle,
    staging_dir: String,
) -> Result<ProcessResult, String> {
    async_runtime::spawn_blocking(move || run_process_task(app, staging_dir, ProcessTask::Bw, None))
        .await
        .map_err(|e| format!("Process background task failed: {}", e))?
}

fn task_name(task: &ProcessTask) -> &'static str {
    match task {
        ProcessTask::Focus => "focus",
        ProcessTask::Enhance => "enhance",
        ProcessTask::Bw => "bw",
    }
}

fn run_process_task(
    app: AppHandle,
    staging_dir: String,
    task: ProcessTask,
    job_id: Option<String>,
) -> Result<ProcessResult, String> {
    let root = PathBuf::from(&staging_dir);
    let jpgs = collect_jpgs(&root);
    let total = jpgs.len();
    let done_count = Arc::new(AtomicU64::new(0));
    let oof_count = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(Mutex::new(Vec::<String>::new()));

    let task_label = task_name(&task);
    let _ = append_app_log(&app, format!("process_{} start staging='{}'", task_label, staging_dir));

    if let Some(job_id) = &job_id {
        update_process_job(job_id, |job| {
            job.status = ProcessJobStatus::Running;
            job.started_at = Some(now_string());
            job.current_file = "Starting".to_string();
            job.total = total;
        });
        append_process_job_log(job_id, format!("start task={} staging='{}'", task_label, staging_dir));
    }

    if total == 0 {
        if let Some(job_id) = &job_id {
            update_process_job(job_id, |job| {
                job.status = ProcessJobStatus::Completed;
                job.finished_at = Some(now_string());
                job.current_file = "Done".to_string();
            });
            append_process_job_log(job_id, "no supported jpg files found");
        }
        let _ = append_app_log(&app, format!("process_{} no files", task_label));
        return Ok(ProcessResult { processed: 0, out_of_focus: 0, errors: vec![] });
    }

    let app_clone = app.clone();
    let done_clone = done_count.clone();
    let oof_clone = oof_count.clone();
    let errors_clone = errors.clone();
    let task_clone = task.clone();
    let job_id_clone = job_id.clone();

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads((num_cpus() * 2).max(4))
        .build()
        .map_err(|e| e.to_string())?;

    pool.install(|| {
        jpgs.par_iter().for_each(|path| {
            if wait_if_process_paused_or_aborted(job_id_clone.as_deref()) {
                return;
            }

            let result = (|| -> anyhow::Result<()> {
                match task_clone {
                    ProcessTask::Focus => {
                        let img = image::open(path)?;
                        let (max_score, avg_score, focus_pct) = focus_score(&img);
                        if is_out_of_focus(max_score, avg_score, focus_pct) {
                            let n = ((10.0 - max_score).round() as u32).clamp(1, 10);
                            let new_path = mark_blurry_filename(path, n);
                            fs::rename(path, &new_path)?;
                            oof_clone.fetch_add(1, Ordering::Relaxed);
                            let _ = append_app_log(&app_clone, format!("process_focus marked_blurry from='{}' to='{}'", path.display(), new_path.display()));
                            if let Some(job_id) = &job_id_clone {
                                append_process_job_log(job_id, format!("marked blurry '{}' -> '{}'", path.display(), new_path.display()));
                            }
                        }
                    }
                    ProcessTask::Enhance => {
                        let img = image::open(path)?.into_rgb8();
                        let enhanced = enhance_rgb_clahe(&img);
                        let sharpened = unsharp_mask_rgb(&enhanced, 1.0, 0.5);
                        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                        let out_path = path.parent().unwrap_or(Path::new(".")).join(format!("{}_improved.jpg", stem));
                        sharpened.save(&out_path)?;
                        let _ = append_app_log(&app_clone, format!("process_enhance wrote='{}'", out_path.display()));
                        if let Some(job_id) = &job_id_clone {
                            append_process_job_log(job_id, format!("enhanced '{}' -> '{}'", path.display(), out_path.display()));
                        }
                    }
                    ProcessTask::Bw => {
                        let img = image::open(path)?.into_luma8();
                        let clahe = apply_clahe_luma(&img);
                        let sharpened = unsharp_mask_gray(&clahe, 1.0, 0.6);
                        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
                        let out_path = path.parent().unwrap_or(Path::new(".")).join(format!("{}_BW.jpg", stem));
                        sharpened.save(&out_path)?;
                        let _ = append_app_log(&app_clone, format!("process_bw wrote='{}'", out_path.display()));
                        if let Some(job_id) = &job_id_clone {
                            append_process_job_log(job_id, format!("bw '{}' -> '{}'", path.display(), out_path.display()));
                        }
                    }
                }
                Ok(())
            })();

            if let Err(e) = result {
                errors_clone.lock().unwrap().push(format!("{}: {}", path.display(), e));
                let _ = append_app_log(&app_clone, format!("process_{} error file='{}' message='{}'", task_name(&task_clone), path.display(), e));
                if let Some(job_id) = &job_id_clone {
                    append_process_job_log(job_id, format!("error '{}' => {}", path.display(), e));
                }
            }

            let done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;
            let current_file = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();

            let _ = app_clone.emit(
                "process-progress",
                ProcessProgress {
                    total,
                    done: done as usize,
                    current_file: current_file.clone(),
                    phase: task_name(&task_clone).to_string(),
                },
            );

            if let Some(job_id) = &job_id_clone {
                update_process_job(job_id, |job| {
                    job.done = done as usize;
                    job.processed = done as usize;
                    job.out_of_focus = oof_clone.load(Ordering::Relaxed) as usize;
                    job.current_file = current_file.clone();
                });
            }
        });
    });

    let final_errors = errors.lock().unwrap().clone();
    let processed = done_count.load(Ordering::Relaxed) as usize;
    let out_of_focus = oof_count.load(Ordering::Relaxed) as usize;
    let was_aborted = job_id
        .as_ref()
        .and_then(|id| process_jobs_store().lock().ok().and_then(|jobs| jobs.get(id).map(|j| j.abort_requested)))
        .unwrap_or(false);

    let _ = append_app_log(&app, format!("process_{} complete processed={} out_of_focus={} errors={}", task_label, processed, out_of_focus, final_errors.len()));

    if let Some(job_id) = &job_id {
        let failed = !final_errors.is_empty();
        update_process_job(job_id, |job| {
            job.status = if was_aborted {
                ProcessJobStatus::Aborted
            } else if failed {
                ProcessJobStatus::Failed
            } else {
                ProcessJobStatus::Completed
            };
            job.finished_at = Some(now_string());
            job.done = processed;
            job.processed = processed;
            job.out_of_focus = out_of_focus;
            job.errors = final_errors.clone();
            job.current_file = "Done".to_string();
        });

        if was_aborted {
            append_process_job_log(job_id, format!("aborted processed={} out_of_focus={} errors={}", processed, out_of_focus, final_errors.len()));
        } else {
            append_process_job_log(job_id, format!("complete processed={} out_of_focus={} errors={}", processed, out_of_focus, final_errors.len()));
        }
    }

    Ok(ProcessResult {
        processed,
        out_of_focus,
        errors: final_errors,
    })
}

#[tauri::command]
pub fn start_process_job(
    app: AppHandle,
    staging_dir: String,
    task: String,
) -> Result<String, String> {
    let task_enum = match task.to_lowercase().as_str() {
        "focus" => ProcessTask::Focus,
        "enhance" => ProcessTask::Enhance,
        "bw" => ProcessTask::Bw,
        _ => return Err(format!("Unknown process task: {}", task)),
    };

    let job_id = next_process_job_id();
    let job = ProcessJob {
        id: job_id.clone(),
        task: task_enum.clone(),
        staging_dir: staging_dir.clone(),
        status: ProcessJobStatus::Queued,
        created_at: now_string(),
        started_at: None,
        finished_at: None,
        total: 0,
        done: 0,
        processed: 0,
        out_of_focus: 0,
        current_file: "Queued".to_string(),
        errors: vec![],
        logs: vec![format!("[{}] queued", now_string())],
        pause_requested: false,
        abort_requested: false,
    };

    {
        let mut jobs = process_jobs_store().lock().map_err(|e| e.to_string())?;
        jobs.insert(job_id.clone(), job);
    }

    let app_for_task = app.clone();
    let job_id_for_task = job_id.clone();
    async_runtime::spawn(async move {
        let _ = async_runtime::spawn_blocking(move || {
            run_process_task(app_for_task, staging_dir, task_enum, Some(job_id_for_task))
        })
        .await;
    });

    Ok(job_id)
}
