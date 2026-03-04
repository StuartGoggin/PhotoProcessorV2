
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs;
use crate::utils::{compute_md5, num_cpus, unique_dest};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgress {
    pub total: usize,
    pub done: usize,
    pub current_file: String,
    pub phase: String,
    pub speed_mbps: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferResult {
    pub copied: usize,
    pub verified: usize,
    pub errors: Vec<String>,
}



fn collect_all_files(dir: &Path) -> Vec<PathBuf> {
    WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n != "checksums.md5")
                .unwrap_or(true)
        })
        .collect()
}

#[tauri::command]
pub async fn start_transfer(
    app: AppHandle,
    staging_dir: String,
    archive_dir: String,
) -> Result<TransferResult, String> {
    let staging = PathBuf::from(&staging_dir);
    let archive = PathBuf::from(&archive_dir);

    if !staging.exists() {
        return Err(format!("Staging dir does not exist: {}", staging_dir));
    }
    fs::create_dir_all(&archive).map_err(|e| e.to_string())?;

    let files = collect_all_files(&staging);
    let total = files.len();
    let done_count = Arc::new(AtomicU64::new(0));
    let bytes_copied = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let start_time = std::time::Instant::now();

    let archive_clone = archive.clone();
    let staging_clone = staging.clone();
    let app_clone = app.clone();
    let done_clone = done_count.clone();
    let bytes_clone = bytes_copied.clone();
    let errors_clone = errors.clone();

    // Copy phase
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(8)
        .build()
        .map_err(|e| e.to_string())?;

    pool.install(|| {
        files.par_iter().for_each(|src| {
            let rel = src.strip_prefix(&staging_clone).unwrap_or(src);
            let dest = archive_clone.join(rel);

            let result = (|| -> anyhow::Result<u64> {
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent)?;
                }
                let bytes = fs::copy(src, &dest)?;
                Ok(bytes)
            })();

            match result {
                Ok(bytes) => {
                    bytes_clone.fetch_add(bytes, Ordering::Relaxed);
                    let done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;
                    let elapsed = start_time.elapsed().as_secs_f64();
                    let speed = if elapsed > 0.0 {
                        (bytes_clone.load(Ordering::Relaxed) as f64 / (1024.0 * 1024.0)) / elapsed
                    } else {
                        0.0
                    };
                    let _ = app_clone.emit(
                        "transfer-progress",
                        TransferProgress {
                            total,
                            done: done as usize,
                            current_file: src
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("")
                                .to_string(),
                            phase: "copy".to_string(),
                            speed_mbps: speed,
                        },
                    );
                }
                Err(e) => {
                    errors_clone
                        .lock()
                        .unwrap()
                        .push(format!("{}: {}", src.display(), e));
                }
            }
        });
    });

    let copied = done_count.load(Ordering::Relaxed) as usize;

    // MD5 generation phase
    let archive_files = collect_all_files(&archive);
    let md5_total = archive_files.len();
    let md5_done = Arc::new(AtomicU64::new(0));
    let md5_errors = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let checksums = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));

    let app_clone2 = app.clone();
    let md5_done_clone = md5_done.clone();
    let md5_errors_clone = md5_errors.clone();
    let checksums_clone = checksums.clone();
    let archive_clone2 = archive.clone();

    let pool2 = rayon::ThreadPoolBuilder::new()
        .num_threads(num_cpus())
        .build()
        .map_err(|e| e.to_string())?;

    pool2.install(|| {
        archive_files.par_iter().for_each(|path| {
            match compute_md5(path) {
                Ok(hash) => {
                    let rel = path
                        .strip_prefix(&archive_clone2)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .replace('\\', "/");
                    checksums_clone
                        .lock()
                        .unwrap()
                        .push(format!("{}  {}", hash, rel));
                    let done = md5_done_clone.fetch_add(1, Ordering::Relaxed) + 1;
                    let _ = app_clone2.emit(
                        "transfer-progress",
                        TransferProgress {
                            total: md5_total,
                            done: done as usize,
                            current_file: path
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("")
                                .to_string(),
                            phase: "md5".to_string(),
                            speed_mbps: 0.0,
                        },
                    );
                }
                Err(e) => {
                    md5_errors_clone
                        .lock()
                        .unwrap()
                        .push(format!("{}: {}", path.display(), e));
                }
            }
        });
    });

    // Write checksum file
    let mut all_checksums = checksums.lock().unwrap().clone();
    all_checksums.sort();
    let checksum_path = archive.join("checksums.md5");
    fs::write(&checksum_path, all_checksums.join("\n"))
        .map_err(|e| format!("Failed to write checksums: {}", e))?;

    let verified = md5_done.load(Ordering::Relaxed) as usize;
    let mut all_errors = errors.lock().unwrap().clone();
    all_errors.extend(md5_errors.lock().unwrap().clone());

    Ok(TransferResult {
        copied,
        verified,
        errors: all_errors,
    })
}

#[tauri::command]
pub async fn verify_checksums(
    app: AppHandle,
    archive_dir: String,
) -> Result<TransferResult, String> {
    let archive = PathBuf::from(&archive_dir);
    let checksum_path = archive.join("checksums.md5");

    if !checksum_path.exists() {
        return Err("No checksums.md5 file found in archive directory".to_string());
    }

    let content = fs::read_to_string(&checksum_path).map_err(|e| e.to_string())?;
    let entries: Vec<(String, PathBuf)> = content
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.splitn(2, "  ").collect();
            if parts.len() == 2 {
                Some((
                    parts[0].to_string(),
                    archive.join(parts[1].trim()),
                ))
            } else {
                None
            }
        })
        .collect();

    let total = entries.len();
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
        entries.par_iter().for_each(|(expected_hash, path)| {
            let result = (|| -> anyhow::Result<()> {
                if !path.exists() {
                    anyhow::bail!("File not found: {}", path.display());
                }
                let actual_hash = compute_md5(path)?;
                if actual_hash != *expected_hash {
                    anyhow::bail!(
                        "Hash mismatch for {}: expected {} got {}",
                        path.display(),
                        expected_hash,
                        actual_hash
                    );
                }
                Ok(())
            })();

            if let Err(e) = result {
                errors_clone.lock().unwrap().push(e.to_string());
            }

            let done = done_clone.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = app_clone.emit(
                "transfer-progress",
                TransferProgress {
                    total,
                    done: done as usize,
                    current_file: path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string(),
                    phase: "verify".to_string(),
                    speed_mbps: 0.0,
                },
            );
        });
    });

    let errs = errors.lock().unwrap().clone();
    Ok(TransferResult {
        copied: 0,
        verified: done_count.load(Ordering::Relaxed) as usize,
        errors: errs,
    })
}













