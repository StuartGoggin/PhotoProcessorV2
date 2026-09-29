//! Verified preview reuse without copying video or opening arbitrary local files.
use super::*;
const MAX_INLINE_BYTES: u64 = 64 * 1024 * 1024;

fn preview_project(request: &recovery::RenderRequest) -> Project {
    let mut p = request.project.clone();
    p.width = 1280; p.height = 720; p.bitrate_mbps = 4; p.music.enabled = false;
    p.clips.retain(|clip| clip.include);
    for clip in &mut p.clips { clip.rendered = None; clip.reviewed = false; clip.revision = 0; clip.notes.clear(); }
    p
}
fn key(request: &recovery::RenderRequest) -> Result<String, String> {
    let mut p = preview_project(request);
    p.output_dir = fs::canonicalize(&p.output_dir).map_err(|e| e.to_string())?.to_string_lossy().into_owned();
    let mut evidence = vec!["inline-preview-v1".into(), FRAGMENT_CACHE_VERSION.into(), recovery::generation(),
        serde_json::to_string(&p).map_err(|e| e.to_string())?,
        format!("{:?}|{:?}", request.preview_start, request.preview_length)];
    for clip in &p.clips {
        evidence.push(source_signature(&source(Path::new(&request.staging_dir), &clip.path)?)?);
    }
    Ok(signature(&evidence))
}
fn owned_output(job: &StudioJob, request: &recovery::RenderRequest) -> Result<PathBuf, String> {
    if job.kind != "preview" || !request.preview || request.kind != "preview" || job.status != "completed" {
        return Err("Only a completed Studio preview can be played inline".into());
    }
    let path = fs::canonicalize(job.output.as_ref().ok_or("Preview output unavailable")?).map_err(|e| e.to_string())?;
    let root = fs::canonicalize(&request.project.output_dir).map_err(|e| e.to_string())?;
    if !path.starts_with(&root) || path.file_name().and_then(|s| s.to_str()) != Some("preview.mp4") || !path.is_file() {
        return Err("Preview is not a generated preview inside its output folder".into());
    }
    Ok(path)
}
pub(super) fn render_cached(request: recovery::RenderRequest, id: &str) -> Result<String, String> {
    validate(&request.project)?;
    validate_preview_range(request.preview, request.preview_start, request.preview_length)?;
    checkpoint(id)?;
    let started = std::time::Instant::now();
    let identity = key(&request)?;
    let p = preview_project(&request);
    let ff = detect_ffmpeg_capabilities()?.binary;
    let candidates: Vec<_> = jobs().lock().map_err(|e| e.to_string())?.values()
        .filter(|job| job.id != id && job.kind == "preview" && job.status == "completed" && job.preview_key == identity && !job.preview_checksum.is_empty()).cloned().collect();
    for candidate in candidates {
        checkpoint(id)?;
        // Both the previous request and this request must own the cached path.
        let valid = recovery::saved_request(&candidate.id).ok().and_then(|saved| owned_output(&candidate, &saved).ok())
            .and_then(|_| owned_output(&candidate, &request).ok())
            .filter(|path| compute_md5(path).ok().as_ref() == Some(&candidate.preview_checksum)
                && rendered_clip_is_valid(&ff, path, &p, candidate.duration));
        if let Some(path) = valid {
            if key(&request)? != identity { return Err("Source changed during preview verification. Preview again after copying or editing finishes.".into()); }
            update(id, |job| {
                job.cache_hits += 1; job.preview_key = identity.clone(); job.preview_checksum = candidate.preview_checksum.clone();
                job.duration = candidate.duration; job.encoder = candidate.encoder.clone();
                job.logs.push(format!("Reused verified preview; no video re-encode. Verification {:.2}s", started.elapsed().as_secs_f64()));
            });
            return Ok(path.to_string_lossy().into_owned());
        }
    }
    update(id, |job| job.logs.push(format!("Preview source verification {:.2}s; no matching verified preview", started.elapsed().as_secs_f64())));
    let output = render(p, request.staging_dir.clone(), true, request.preview_start, request.preview_length, "preview", false, id)?;
    checkpoint(id)?;
    // A source edited mid-render must never publish an identity for later reuse.
    if key(&request)? != identity { return Err("Source changed during preview rendering. Output was retained, but is not reusable; preview again when copying or editing finishes.".into()); }
    let checksum = compute_md5(Path::new(&output)).map_err(|e| e.to_string())?;
    let seconds = duration(&inspect(&ff, Path::new(&output))?)?;
    update(id, |job| { job.preview_key = identity; job.preview_checksum = checksum; job.duration = seconds; });
    Ok(output)
}

#[tauri::command]
pub async fn studio_read_preview(job_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let job = jobs().lock().map_err(|e| e.to_string())?.get(&job_id).cloned().ok_or("Unknown preview job")?;
        let request = recovery::saved_request(&job_id)?;
        read(&job, &request)
    }).await.map_err(|e| e.to_string())?
}
fn read(job: &StudioJob, request: &recovery::RenderRequest) -> Result<String, String> {
    let path = owned_output(job, request)?;
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_INLINE_BYTES { return Err("Preview exceeds the 64 MiB inline limit. Open externally, or preview a shorter range.".into()); }
    let mut bytes = Vec::new();
    file.take(MAX_INLINE_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_INLINE_BYTES { return Err("Preview grew beyond the inline size limit. Open externally.".into()); }
    if job.preview_checksum.is_empty() || hex::encode(Md5::digest(&bytes)) != job.preview_checksum {
        return Err("Preview file changed or is from an older app. Generate the preview again.".into());
    }
    Ok(format!("data:video/mp4;base64,{}", crate::utils::base64_encode(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, recovery::RenderRequest) {
        let root = std::env::temp_dir().join(format!("studio-preview-check-{}",chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir_all(&root).unwrap(); fs::write(root.join("source.mp4"), b"source middle end").unwrap();
        let p = super::super::tests::project(&root);
        (root.clone(), recovery::RenderRequest { project:p, staging_dir:root.to_string_lossy().into_owned(), preview:true, preview_start:Some(0.), preview_length:Some(1.), kind:"preview".into(), clip_id:None, assemble_only:false })
    }
    #[test]
    fn studio_preview_range_is_validated_before_hashing() {
        for start in [-1., f64::NAN, f64::INFINITY] { assert!(validate_preview_range(true, Some(start), None).is_err()); }
        for length in [0., -1., 61., f64::NAN, f64::INFINITY] { assert!(validate_preview_range(true, None, Some(length)).is_err()); }
        assert!(validate_preview_range(false,Some(0.),None).is_err());
        assert!(validate_preview_range(true,Some(0.),Some(60.)).is_ok());
    }
    #[test]
    fn studio_preview_identity_tracks_source_range_recipe_and_destination() {
        let (root, request) = fixture(); let original = key(&request).unwrap();
        let mut next = request.clone(); next.project.clips[0].reviewed = false; next.project.clips[0].revision += 1;
        assert_eq!(key(&next).unwrap(), original);
        next.preview_start = Some(0.5); assert_ne!(key(&next).unwrap(), original);
        next = request.clone(); next.project.clips[0].prevent_rotation = Some(true); assert_ne!(key(&next).unwrap(), original);
        next = request.clone(); next.project.clips[0].title = "Other".into(); assert_ne!(key(&next).unwrap(), original);
        next = request.clone(); next.project.clips[0].replays[0].speed = 0.25; assert_ne!(key(&next).unwrap(), original);
        let changed = root.join("source.mp4"); let stamp = fs::metadata(&changed).unwrap().modified().unwrap();
        fs::write(&changed, b"source CHANGEDend").unwrap();
        fs::File::options().write(true).open(&changed).unwrap().set_times(fs::FileTimes::new().set_modified(stamp)).unwrap();
        assert_ne!(key(&request).unwrap(), original);
    }
    #[test]
    fn studio_preview_read_is_owned_bounded_and_checksum_checked() {
        let (root, request) = fixture(); let path = root.join("preview.mp4"); fs::write(&path,b"preview bytes").unwrap();
        let mut job = StudioJob { kind:"preview".into(), status:"completed".into(), output:Some(path.to_string_lossy().into_owned()), preview_checksum:compute_md5(&path).unwrap(), ..StudioJob::default() };
        assert!(read(&job,&request).unwrap().starts_with("data:video/mp4;base64,"));
        job.status = "running".into(); assert!(read(&job,&request).is_err()); job.status = "completed".into();
        job.kind = "project".into(); assert!(read(&job,&request).is_err()); job.kind = "preview".into();
        job.output = Some(root.join("source.mp4").to_string_lossy().into_owned()); assert!(read(&job,&request).is_err());
        job.output = Some(path.to_string_lossy().into_owned()); fs::write(&path,b"tampered").unwrap(); assert!(read(&job,&request).is_err());
        fs::File::create(&path).unwrap().set_len(MAX_INLINE_BYTES+1).unwrap(); assert!(read(&job,&request).unwrap_err().contains("64 MiB"));
        let mut other = request.clone(); other.project.output_dir = root.join("other").to_string_lossy().into_owned(); fs::create_dir_all(&other.project.output_dir).unwrap();
        assert!(owned_output(&job,&other).is_err());
    }
}
