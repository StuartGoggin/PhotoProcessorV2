//! Relocation is a proposed project edit, never a filesystem move or a render.
use super::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelinkPlan {
    pub(super) project: Project,
    changes: Vec<PathChange>,
    pub(super) errors: Vec<String>,
    warnings: Vec<String>,
    pub(super) verified_renders: usize,
    elapsed_seconds: f64,
}
#[derive(Serialize)]
pub struct PathChange { label: String, from: String, to: String }

fn safe_absolute(path: &Path) -> bool {
    path.is_absolute() && !path.components().any(|part| matches!(part, std::path::Component::ParentDir))
}
// Component comparison prevents "stage-other" and traversal from becoming a
// descendant of "stage". Canonical source() then checks junction/symlink escapes.
fn mapped(path: &str, old_root: &str, new_root: &Path) -> Result<Option<PathBuf>, String> {
    if path.is_empty() || old_root.trim().is_empty() { return Ok(None); }
    let original = Path::new(path);
    let old = Path::new(old_root);
    if !safe_absolute(original) || !safe_absolute(old) || !safe_absolute(new_root) {
        return Err(format!("Relinking requires absolute paths without '..': {path}"));
    }
    let mut parts = original.components();
    for expected in old.components() {
        let Some(actual) = parts.next() else { return Ok(None); };
        let equal = if cfg!(windows) {
            actual.as_os_str().to_string_lossy().eq_ignore_ascii_case(&expected.as_os_str().to_string_lossy())
        } else { actual == expected };
        if !equal { return Ok(None); }
    }
    Ok(Some(new_root.join(parts.as_path())))
}
fn change_path(value: &mut String, old: &str, new: &Path, label: String, changes: &mut Vec<PathChange>) -> Result<(), String> {
    if let Some(mapped) = mapped(value, old, new)? {
        let to = mapped.to_string_lossy().into_owned();
        if *value != to { changes.push(PathChange { label, from: value.clone(), to: to.clone() }); *value = to; }
    }
    Ok(())
}

// Only known lexical/canonical spellings of the OLD path are tried. Never guess
// timestamps, old cache generations, settings, or content hashes to force reuse.
fn old_identities(path: &str, current_source_key: &str) -> Vec<String> {
    let Some((_, evidence)) = current_source_key.split_once('|') else { return vec![]; };
    let mut paths = vec![path.to_string()];
    if let Ok(canonical) = fs::canonicalize(path) { paths.push(canonical.to_string_lossy().into_owned()); }
    #[cfg(windows)] {
        let normalized = path.replace('/', "\\");
        let plain = normalized.strip_prefix("\\\\?\\UNC\\").map(|s| format!("\\\\{s}"))
            .unwrap_or_else(|| normalized.strip_prefix("\\\\?\\").unwrap_or(&normalized).into());
        let canonical = if let Some(unc) = plain.strip_prefix("\\\\") { format!("\\\\?\\UNC\\{unc}") }
            else { format!("\\\\?\\{plain}") };
        paths.extend([normalized, plain, canonical]);
    }
    paths.sort(); paths.dedup();
    paths.into_iter().map(|p| format!("{p}|{evidence}")).collect()
}
fn proven_identity(p: &Project, clip: &Clip, current_source_key: &str, saved: &ClipRender) -> bool {
    !saved.signature.is_empty() && old_identities(&clip.path, current_source_key).into_iter()
        .any(|key| recovery::clip_signature_for_source(p, clip, key).ok().as_ref() == Some(&saved.signature))
}
fn next_revision(clip: &Clip, history: &[StudioJob]) -> Result<u32, String> {
    history.iter().flat_map(|job| job.targets.iter().filter(|target| target.clip_id == clip.id).map(|target| target.revision)
        .chain(job.artifacts.iter().filter(|artifact| artifact.clip_id == clip.id).map(|artifact| artifact.rendered.revision)))
        .fold(clip.revision, u32::max).checked_add(1).ok_or("Clip revision limit reached; save a new project before relinking".into())
}

#[tauri::command]
pub async fn studio_relink_media(project: Project, staging_dir: String, old_staging_dir: String, output_dir: String) -> Result<RelinkPlan, String> {
    tauri::async_runtime::spawn_blocking(move || plan(project, &staging_dir, &old_staging_dir, &output_dir)).await.map_err(|e| e.to_string())?
}
pub(super) fn plan(original: Project, staging: &str, old_staging: &str, output: &str) -> Result<RelinkPlan, String> {
    validate(&original)?;
    if [staging, old_staging, output].iter().any(|path| path.len() > 32_000) { return Err("Folder path is too long".into()); }
    let started = std::time::Instant::now();
    let staging_root = fs::canonicalize(staging).map_err(|e| format!("Configured staging folder unavailable: {staging}. Check Settings. {e}"))?;
    if !staging_root.is_dir() { return Err("Configured staging location must be a folder".into()); }
    let output_root = fs::canonicalize(output).map_err(|e| format!("Choose an existing output folder: {output}. {e}"))?;
    if !output_root.is_dir() { return Err("Output location must be a folder".into()); }
    // Use the user's selected spelling in the project; canonical paths are only
    // used for containment, hashing and verification.
    let new_stage = Path::new(staging);
    let new_output = Path::new(output);
    if !safe_absolute(new_stage) || !safe_absolute(new_output) { return Err("Select absolute staging and output folders".into()); }
    if !old_staging.trim().is_empty() && !safe_absolute(Path::new(old_staging)) { return Err("Enter the original absolute staging folder, for example E:\\stage".into()); }
    let mut result = RelinkPlan { project: original.clone(), changes: vec![], errors: vec![], warnings: vec![], verified_renders: 0, elapsed_seconds: 0. };
    if original.output_dir != output {
        result.changes.push(PathChange { label: "Output folder".into(), from: original.output_dir.clone(), to: output.into() });
        result.project.output_dir = output.into();
    }
    for (value, label) in [(&mut result.project.music.audio_path, "Music audio"), (&mut result.project.music.midi_path, "Music MIDI"), (&mut result.project.music.project_path, "Music project")] {
        change_path(value, &original.output_dir, new_output, label.into(), &mut result.changes)?;
        if !value.is_empty() && !Path::new(value).is_file() { result.warnings.push(format!("{label} unavailable: {value}")); }
    }
    if result.project.music.enabled {
        if let Err(error) = music_audio_source(&result.project.music.audio_path) { result.errors.push(format!("Enabled music unavailable: {}. {error}", result.project.music.audio_path)); }
    }
    result.project.music.request_id.clear(); // Old-machine music jobs must not replace the relocated choice.
    let mut ff: Option<Result<PathBuf, String>> = None;
    let history: Vec<_> = jobs().lock().map_err(|e| e.to_string())?.values().cloned().collect();
    for (index, old_clip) in original.clips.iter().enumerate() {
        let clip = &mut result.project.clips[index];
        change_path(&mut clip.path, old_staging, new_stage, format!("Source — {}", clip.chapter), &mut result.changes)?;
        if let Some(rendered) = &mut clip.rendered {
            change_path(&mut rendered.path, &original.output_dir, new_output, format!("Rendered — {}", clip.chapter), &mut result.changes)?;
        }
        let relocated = clip.path != old_clip.path;
        // Fence prior job artifacts, including output-only moves where the
        // source path is unchanged. Revision is not part of the native hash.
        if relocated || clip.rendered.is_some() {
            clip.revision = next_revision(clip, &history)?;
        }
        let checked = source(&staging_root, &clip.path);
        let mut reusable = false;
        match checked {
            Err(error) => { if clip.include { result.errors.push(error); } else { result.warnings.push(error); } }
            Ok(path) => {
                if let (Some(saved), Some(candidate)) = (&old_clip.rendered, &clip.rendered) {
                    let source_key = source_signature(&path)?;
                    if proven_identity(&original, old_clip, &source_key, saved)
                        && saved.width == original.width && saved.height == original.height && saved.fps == original.fps
                        && saved.bitrate_mbps == effective_bitrate(&original) && !saved.checksum.is_empty()
                        && compute_md5(Path::new(&candidate.path)).ok().as_ref() == Some(&saved.checksum) {
                        if ff.is_none() { ff = Some(detect_ffmpeg_capabilities().map(|caps| caps.binary)); }
                        match ff.as_ref().unwrap() {
                            Ok(binary) => reusable = rendered_clip_is_valid(binary, Path::new(&candidate.path), &original, saved.duration)
                                && source_signature(&path)? == source_key,
                            Err(error) => result.warnings.push(format!("{}: cached output cannot be verified until FFmpeg is available: {error}", clip.chapter)),
                        }
                    }
                    if reusable {
                        let signature = recovery::clip_signature_for_source(&original, clip, source_key)?;
                        let style = graphics::title_style_key(&original, clip);
                        let rotation = stabilization::prevent_rotation(&original, clip);
                        let rendered = clip.rendered.as_mut().unwrap();
                        rendered.signature = signature;
                        rendered.revision = clip.revision;
                        rendered.title_style_key = style;
                        rendered.prevent_rotation = rotation;
                        result.verified_renders += 1;
                    }
                }
            }
        }
        if !reusable {
            if let Some(rendered) = &mut clip.rendered {
                rendered.signature.clear();
                result.warnings.push(format!("{}: existing render retained for playback, but source/settings/checksum could not prove reuse. It is not marked ready.", clip.chapter));
            }
            if relocated { clip.reviewed = false; }
        }
    }
    validate(&result.project)?;
    result.elapsed_seconds = started.elapsed().as_secs_f64();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn studio_relink_revision_fences_newer_historical_jobs() {
        let p = super::super::tests::project(Path::new(".")); let mut clip = p.clips[0].clone(); clip.revision = 6;
        let job = StudioJob { targets:vec![ClipTarget { clip_id:clip.id.clone(), source_path:clip.path.clone(), revision:7, title_style_key:String::new(), prevent_rotation:false }], ..StudioJob::default() };
        assert_eq!(next_revision(&clip,&[job]).unwrap(),8);
        clip.revision = u32::MAX; assert!(next_revision(&clip,&[]).is_err());
    }
    #[test]
    fn studio_relink_mapping_is_component_bounded() {
        let root = std::env::temp_dir(); let old = root.join("old-stage"); let new = root.join("new-stage");
        assert_eq!(mapped(&old.join("day/clip.mp4").to_string_lossy(), &old.to_string_lossy(), &new).unwrap(), Some(new.join("day/clip.mp4")));
        assert!(mapped(&root.join("old-stage-other/clip.mp4").to_string_lossy(), &old.to_string_lossy(), &new).unwrap().is_none());
        assert!(mapped(&old.join("../escape.mp4").to_string_lossy(), &old.to_string_lossy(), &new).is_err());
        assert!(mapped("relative.mp4", &old.to_string_lossy(), &new).is_err());
    }
    #[test]
    fn studio_relink_requires_full_content_and_recipe_identity() {
        let root = std::env::temp_dir().join(format!("studio-relink-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir_all(&root).unwrap();
        let mut p = super::super::tests::project(&root);
        let path = root.join("source.mp4"); fs::write(&path, b"start middle end").unwrap();
        let canonical = fs::canonicalize(&path).unwrap();
        let key = source_signature(&canonical).unwrap();
        let saved = ClipRender { path: "unused".into(), width:p.width, height:p.height, fps:p.fps, duration:2., rendered_at:String::new(), bitrate_mbps:p.bitrate_mbps, revision:0,
            signature:recovery::clip_signature_for_source(&p, &p.clips[0], key.clone()).unwrap(), checksum:"checksum".into(), title_style_key:String::new(), prevent_rotation:false };
        assert!(proven_identity(&p, &p.clips[0], &key, &saved));
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        fs::write(&path, b"start CHANGEDend").unwrap();
        fs::File::options().write(true).open(&path).unwrap().set_times(fs::FileTimes::new().set_modified(modified)).unwrap();
        assert!(!proven_identity(&p, &p.clips[0], &source_signature(&canonical).unwrap(), &saved));
        p.clips[0].title = "Changed title".into();
        assert!(!proven_identity(&p, &p.clips[0], &key, &saved));
    }
}
