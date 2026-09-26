//! Final delivery is frame based: one manifest supplies MP4 chapters and the
//! editable publishing text. Neither project headings nor ordering enter the
//! reusable clip cache, and no renderer accepts a client-supplied sidecar path.
use super::*;

const DESCRIPTION: &str = "youtube-description.txt";
const MANIFEST: &str = "delivery.json";
const MAX_TEXT_BYTES: u64 = 20_000;
// Existing saved projects may hold 500 clips with 100 replays apiece. Do not
// introduce a smaller late-render limit than the project model already allows.
const MAX_CHAPTERS: usize = 51_001;
const MAX_SIDECAR_BYTES: u64 = 32_000_000;
static DESCRIPTION_WRITE: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Chapter {
    start_frame: u64,
    end_frame: u64,
    title: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Manifest {
    version: u32,
    fps: u32,
    pub frames: u64,
    pub chapters: Vec<Chapter>,
}

fn label(text: &str) -> String {
    let value = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let value: String = value.chars().filter(|c| !c.is_control()).collect();
    if value.is_empty() { "Untitled segment".into() } else { value }
}

impl Manifest {
    pub fn new(fps: u32) -> Self { Self { version: 1, fps, frames: 0, chapters: vec![] } }
    pub fn append(&mut self, title: &str, frames: u64) -> Result<(), String> {
        if frames == 0 || self.fps == 0 { return Err("Cannot create a zero-frame delivery chapter".into()); }
        let end = self.frames.checked_add(frames).ok_or("Delivery frame count overflow")?;
        self.chapters.push(Chapter { start_frame: self.frames, end_frame: end, title: label(title) });
        self.frames = end;
        Ok(())
    }
    pub fn seconds(&self) -> f64 { self.frames as f64 / self.fps as f64 }
    pub fn ffmetadata(&self) -> String {
        let mut text = String::from(";FFMETADATA1\n");
        for c in &self.chapters {
            let safe = c.title.replace('\\', "\\\\").replace('=', "\\=").replace(';', "\\;").replace('#', "\\#");
            text.push_str(&format!("[CHAPTER]\nTIMEBASE=1/{}\nSTART={}\nEND={}\ntitle={safe}\n", self.fps, c.start_frame, c.end_frame));
        }
        text
    }
    pub fn matches_chapters(&self, info: &Value) -> bool {
        let Some(chapters) = info["chapters"].as_array() else { return false; };
        chapters.len() == self.chapters.len() && chapters.iter().zip(&self.chapters).all(|(actual, expected)| {
            measured_frame(actual, "start_time", self.fps) == Some(expected.start_frame)
                && measured_frame(actual, "end_time", self.fps) == Some(expected.end_frame)
                && actual["tags"]["title"].as_str() == Some(expected.title.as_str())
        })
    }
    fn validate(&self) -> Result<(), String> {
        if self.version != 1 || ![25, 30, 50, 60].contains(&self.fps) || self.chapters.is_empty() || self.chapters.len() > MAX_CHAPTERS {
            return Err("Unrecognised or invalid delivery metadata; export the video again".into());
        }
        let mut end = 0;
        for c in &self.chapters {
            if c.start_frame != end || c.end_frame <= end || c.title != label(&c.title) {
                return Err("Invalid delivery chapter data; export the video again".into());
            }
            end = c.end_frame;
        }
        if end != self.frames { return Err("Delivery frame count is inconsistent; export the video again".into()); }
        Ok(())
    }
    fn chapter_lines(&self) -> Vec<String> {
        self.chapters.iter().map(|c| format!("{} {}", timestamp(c.start_frame / u64::from(self.fps)), c.title)).collect()
    }
    fn warnings(&self) -> Vec<String> {
        let mut warnings = vec![];
        if self.chapters.len() < 3 { warnings.push("YouTube chapters require at least three timestamps.".into()); }
        if self.chapters.iter().any(|c| c.end_frame - c.start_frame < u64::from(self.fps) * 10) {
            warnings.push("At least one segment is shorter than 10 seconds; YouTube may not enable chapters. Your video has not been altered.".into());
        }
        if self.chapters.windows(2).any(|c| c[0].start_frame / u64::from(self.fps) == c[1].start_frame / u64::from(self.fps)) {
            warnings.push("Some segments start in the same second. Whole-second YouTube timestamps cannot represent those boundaries distinctly.".into());
        }
        warnings
    }
}

fn timestamp(seconds: u64) -> String {
    if seconds >= 3600 { format!("{:02}:{:02}:{:02}", seconds / 3600, seconds / 60 % 60, seconds % 60) }
    else { format!("{:02}:{:02}", seconds / 60, seconds % 60) }
}

pub(super) fn frame_count(info: &Value) -> Result<u64, String> {
    info["streams"].as_array().and_then(|streams| streams.iter().find(|s| s["codec_type"] == "video"))
        .and_then(|v| v["nb_frames"].as_str()).and_then(|n| n.parse::<u64>().ok()).filter(|n| *n > 0)
        .ok_or_else(|| "Cannot verify segment frames".into())
}

fn measured_frame(chapter: &Value, field: &str, fps: u32) -> Option<u64> {
    let seconds = chapter[field].as_str()?.parse::<f64>().ok()?;
    if !seconds.is_finite() || seconds < 0. || seconds > u64::MAX as f64 / f64::from(fps) { return None; }
    // Old outputs use a millisecond chapter timebase; nearest-frame recovery
    // loses no information at any supported Studio rate (25–60 fps).
    Some((seconds * f64::from(fps)).round() as u64)
}

pub(super) fn clip_chapters(info: &Value, clip: &Clip, fps: u32, frames: u64) -> Result<Vec<(String, u64)>, String> {
    let chapters = info["chapters"].as_array().ok_or("Rendered clip has no chapter timing; render it again")?;
    let mut names = vec![clip.chapter.clone()];
    names.extend(clip.replays.iter().filter(|r| r.enabled).map(|r| format!("Replay - {}", r.caption)));
    if chapters.len() != names.len() { return Err(format!("{} has incomplete replay chapter timing; render the clip again", clip.chapter)); }
    let mut result = vec![];
    let mut start = 0;
    for (index, (chapter, name)) in chapters.iter().zip(names).enumerate() {
        let actual_start = measured_frame(chapter, "start_time", fps).ok_or("Invalid clip chapter start")?;
        let end = if index + 1 == chapters.len() { frames } else {
            measured_frame(&chapters[index + 1], "start_time", fps).ok_or("Invalid clip chapter end")?
        };
        if actual_start != start || end <= start || end > frames { return Err("Rendered clip chapter timing is inconsistent; render it again".into()); }
        result.push((name, end - start));
        start = end;
    }
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
pub(super) fn opening_overlay(ff: &Path, p: &Project, encoder_name: &str, input: &Path, work: &Path, id: &str, frames: u64, first_chapter_frames: u64) -> Result<PathBuf, String> {
    let visible_seconds = p.title_seconds.min(first_chapter_frames as f64 / f64::from(p.fps));
    let filter = graphics::title_filter(p, work, None, "opening-overlay", Some((0,(visible_seconds*p.fps as f64).ceil() as u64)))?;
    let output = work.join("opening-overlay.mp4");
    let mut args = vec!["-i".into(), input.to_string_lossy().into_owned(), "-map".into(), "0:v:0".into(), "-map".into(), "0:a:0".into(), "-map_chapters".into(), "-1".into(), "-vf".into(), filter];
    args.extend(encoder(p, encoder_name));
    // Copy the already-normalised source audio exactly; only first-clip pixels
    // change. Frame count, geometry and colour signalling are reverified below.
    args.extend(["-c:a".into(), "copy".into(), "-frames:v".into(), frames.to_string(), output.to_string_lossy().into_owned()]);
    run(ff, p, args, work, id, "Applying opening title to the first included video", frames as f64 / f64::from(p.fps), 85., 2.)?;
    checkpoint(id)?;
    let info = inspect(ff, &output)?;
    verify_output(&info, p, frames as f64 / f64::from(p.fps))?;
    if frame_count(&info)? != frames { return Err("Opening title changed the clip frame count".into()); }
    Ok(output)
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedDelivery {
    output_name: String,
    manifest: Manifest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sequence: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sequence_verification: Option<sequence::Verification>,
}

pub(super) fn write_artifacts(folder: &Path, p: &Project, output_name: &str, manifest: &Manifest, sequence_verification: Option<&sequence::Verification>) -> Result<(), String> {
    manifest.validate()?;
    let heading = if p.title.trim().is_empty() { label(&p.name) } else { label(&p.title) };
    let subtitle = if p.subtitle.trim().is_empty() { String::new() } else { format!("\n{}", label(&p.subtitle)) };
    let text = format!("{heading}{subtitle}\n\nChapters\n{}\n", manifest.chapter_lines().join("\n"));
    // Artifacts are part of the unpublished .partial folder. Any write failure
    // fails the job before the one final directory rename announces completion.
    fs::write(folder.join(DESCRIPTION), text.as_bytes()).map_err(|e| format!("Could not save YouTube description: {e}"))?;
    fs::write(folder.join(MANIFEST), serde_json::to_vec_pretty(&SavedDelivery {
        output_name: output_name.into(), manifest: manifest.clone(),
        sequence: Some(sequence::recipe(p)), sequence_verification: sequence_verification.cloned(),
    }).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Could not save delivery metadata: {e}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportChapter { start_seconds: f64, title: String }
#[derive(Serialize)]
pub struct ExportDescription { text: String, path: String, chapters: Vec<ExportChapter>, warnings: Vec<String> }

fn output_folder(job_id: &str) -> Result<PathBuf, String> {
    let output = {
        let store = jobs().lock().map_err(|e| e.to_string())?;
        let job = store.get(job_id).ok_or("Unknown Studio export job")?;
        if job.status != "completed" || !matches!(job.kind.as_str(), "project" | "assembly") {
            return Err("Choose a successfully completed full-video export, not a preview or clip render".into());
        }
        job.output.clone().ok_or("This completed job has no output path")?
    };
    let output = Path::new(&output);
    if !output.is_file() { return Err("The exported video is missing or its drive is disconnected".into()); }
    let folder = output.parent().ok_or("Export folder unavailable")?;
    if folder.file_name().and_then(|v| v.to_str()).map(|v| v.ends_with(".partial")).unwrap_or(true) {
        return Err("The export has not finished verification".into());
    }
    fs::canonicalize(folder).map_err(|e| e.to_string())
}

fn read_regular(path: &Path, maximum: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "This export has no publishing description. Assemble/export it again to generate verified chapter timings.".to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() { return Err("Publishing sidecars must be regular files inside the export folder".into()); }
    let mut bytes = Vec::new();
    fs::File::open(path).map_err(|e| e.to_string())?.take(maximum + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > maximum { return Err("Publishing sidecar exceeds the size limit".into()); }
    Ok(bytes)
}

fn load_delivery(folder: &Path) -> Result<SavedDelivery, String> {
    let saved: SavedDelivery = serde_json::from_slice(&read_regular(&folder.join(MANIFEST), MAX_SIDECAR_BYTES)?).map_err(|e| format!("Invalid delivery metadata: {e}"))?;
    if saved.output_name != "training-video.mp4" { return Err("Delivery metadata does not describe a final video".into()); }
    saved.manifest.validate()?;
    Ok(saved)
}

fn read_description(job_id: &str) -> Result<ExportDescription, String> {
    let folder = output_folder(job_id)?;
    let saved = load_delivery(&folder)?;
    let path = folder.join(DESCRIPTION);
    let text = String::from_utf8(read_regular(&path, MAX_SIDECAR_BYTES)?).map_err(|e| e.to_string())?;
    let mut warnings = saved.manifest.warnings();
    if text.chars().count() > 5000 { warnings.push("This description exceeds YouTube's 5,000-character limit; shorten it before publishing.".into()); }
    let chapter_lines = saved.manifest.chapter_lines();
    let actual: std::collections::HashSet<_> = text.lines().map(str::trim).collect();
    if !chapter_lines.iter().all(|line| actual.contains(line.as_str())) {
        warnings.push("The description was edited and no longer contains all generated timestamp lines. The verified video chapter metadata is unchanged.".into());
    }
    Ok(ExportDescription {
        text, path: path.to_string_lossy().into_owned(), warnings,
        chapters: saved.manifest.chapters.iter().map(|c| ExportChapter { start_seconds: c.start_frame as f64 / f64::from(saved.manifest.fps), title: c.title.clone() }).collect(),
    })
}

#[tauri::command]
pub async fn studio_read_export_description(job_id: String) -> Result<ExportDescription, String> {
    tauri::async_runtime::spawn_blocking(move || read_description(&job_id)).await.map_err(|e| e.to_string())?
}

fn save_description(job_id: &str, text: &str) -> Result<String, String> {
    if text.len() as u64 > MAX_TEXT_BYTES || text.contains('\0') { return Err("Description must be at most 20,000 UTF-8 bytes and contain no NUL characters".into()); }
    let _guard = DESCRIPTION_WRITE.lock().map_err(|e| e.to_string())?;
    let folder = output_folder(job_id)?;
    load_delivery(&folder)?;
    let path = folder.join(DESCRIPTION);
    read_regular(&path, MAX_SIDECAR_BYTES)?;
    let temporary = folder.join(format!(".youtube-description-{}-{}.tmp", std::process::id(), chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()));
    struct Cleanup(PathBuf);
    impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_file(&self.0); } }
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|e| e.to_string())?;
    let _cleanup = Cleanup(temporary.clone());
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temporary, &path).map_err(|e| format!("Could not replace description; original was preserved: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn studio_save_export_description(job_id: String, text: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || save_description(&job_id, &text)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_uses_measured_frames_not_rounded_recipe_lengths() {
        let mut manifest = Manifest::new(30);
        manifest.append("Opening", 31).unwrap();
        manifest.append("Camera 1", 361).unwrap();
        manifest.append("Replay", 60).unwrap();
        assert_eq!(manifest.chapters[2].start_frame, 392);
        assert_eq!(manifest.chapter_lines(), ["00:00 Opening", "00:01 Camera 1", "00:13 Replay"]);
        assert!(manifest.ffmetadata().contains("TIMEBASE=1/30\nSTART=31\nEND=392"));
        assert_eq!(manifest.warnings().len(), 1);
        assert!(manifest.validate().is_ok());
    }

    #[test]
    fn valid_legacy_long_labels_and_large_sequences_do_not_fail_after_rendering() {
        let mut m = Manifest::new(25);
        m.append(&"L".repeat(1001), 250).unwrap();
        for _ in 0..6001 { m.append("Replay", 250).unwrap(); }
        assert!(m.validate().is_ok());
        let mut p = super::super::tests::project(Path::new("."));
        p.clips[0].chapter = "L".repeat(1001);
        assert!(validate(&p).is_ok());
        p.clips[0].chapter = "L".repeat(8_000_001);
        assert!(validate(&p).unwrap_err().contains("chapter text"));
    }

    #[test]
    fn timestamps_support_long_exports_and_short_chapters_without_changing_timeline() {
        assert_eq!(timestamp(0), "00:00");
        assert_eq!(timestamp(3599), "59:59");
        assert_eq!(timestamp(3600), "01:00:00");
        assert_eq!(timestamp(366_101), "101:41:41");
        let mut m = Manifest::new(60);
        m.append("One", 1).unwrap(); m.append("Two", 1).unwrap();
        assert_eq!(m.frames, 2);
        assert_eq!(m.warnings().len(), 3);
        assert!(m.append("Bad", 0).is_err());
    }

    #[test]
    fn chapter_labels_are_safe_for_metadata_and_single_line_descriptions() {
        let mut m = Manifest::new(25);
        m.append("Rider's = 100%; #\\\nNext\0", 500).unwrap();
        assert_eq!(m.chapter_lines(), ["00:00 Rider's = 100%; #\\ Next"]);
        assert!(m.ffmetadata().contains("Rider's \\= 100%\\; \\#\\\\ Next"));
    }

    #[test]
    fn assembled_clips_keep_measured_replays_and_use_current_labels() {
        let mut clip = super::super::tests::project(Path::new(".")).clips.remove(0);
        clip.chapter = "Renamed main video".into();
        let info = json!({"chapters":[{"start_time":"0.000000"},{"start_time":"2.033000"}]});
        let chapters = clip_chapters(&info, &clip, 30, 110).unwrap();
        assert_eq!(chapters[0], ("Renamed main video".into(), 61));
        assert_eq!(chapters[1].1, 49);
        assert!(chapters[1].0.starts_with("Replay - "));
        assert!(clip_chapters(&json!({"chapters":[]}), &clip, 30, 110).is_err());
    }

    #[test]
    fn description_commands_require_verified_full_exports_and_preserve_manifest() {
        let root = std::env::temp_dir().join(format!("studio-delivery-test-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir(&root).unwrap();
        let p = super::super::tests::project(&root);
        let mut manifest = Manifest::new(25); manifest.append("First", 500).unwrap();
        fs::write(root.join("training-video.mp4"), b"fixture").unwrap();
        let id = format!("delivery-test-{}", root.display());
        jobs().lock().unwrap().insert(id.clone(), StudioJob { status: "running".into(), kind: "project".into(), output: Some(root.join("training-video.mp4").to_string_lossy().into_owned()), ..StudioJob::default() });
        assert!(read_description(&id).is_err());
        update(&id, |j| j.status = "failed".into()); assert!(save_description(&id, "x").is_err());
        update(&id, |j| j.status = "cancelled".into()); assert!(read_description(&id).is_err());
        update(&id, |j| j.status = "completed".into());
        assert!(read_description(&id).err().unwrap().contains("export it again"));
        write_artifacts(&root, &p, "training-video.mp4", &manifest, None).unwrap();
        let before = fs::read(root.join(MANIFEST)).unwrap();
        assert_eq!(read_description(&id).unwrap().chapters[0].start_seconds, 0.);
        save_description(&id, "My edit\n00:00 First\n").unwrap();
        assert_eq!(read_description(&id).unwrap().text, "My edit\n00:00 First\n");
        assert_eq!(fs::read(root.join(MANIFEST)).unwrap(), before);
        assert!(save_description(&id, &"x".repeat(20_001)).is_err());
        assert!(save_description(&id, "bad\0text").is_err());
        update(&id, |j| j.kind = "clip".into()); assert!(read_description(&id).is_err());
        jobs().lock().unwrap().remove(&id);
        fs::remove_dir_all(root).unwrap();
    }
}
