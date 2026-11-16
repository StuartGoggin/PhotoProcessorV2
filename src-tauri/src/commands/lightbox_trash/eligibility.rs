//! One capture eligibility seam shared by planning and source-read admission.
use std::path::Path;
pub(crate) fn eligible(path: &Path) -> Result<bool, String> {
    check(path, 0)
}
fn check(path: &Path, depth: usize) -> Result<bool, String> {
    if depth > 4 {
        return Err("Crop source chain is too deep; review it before processing".into());
    }
    super::safety::inspect_optional(path)?;
    if !path.is_file() {
        return Err("Processing source is unavailable; refresh the folder".into());
    }
    let folder = path.parent().ok_or("Photo parent missing")?;
    if crate::commands::raw_development::is_raw(path) {
        let anchors = crate::commands::raw_development::capture::review_anchors(folder)?;
        return Ok(raw_decision(path, anchors.get(path).map(|p| p.as_path())));
    }
    if path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_lowercase()
        .contains("{trash}")
    {
        return Ok(false);
    }
    let key = crate::commands::google_photos::catalogue::curation_key(path);
    let stem = key.rsplit_once('.').map(|(s, _)| s).unwrap_or(&key);
    if let Some(base) = stem.strip_suffix("_crop") {
        let sources = std::fs::read_dir(folder)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.extension().is_some_and(|e| {
                    e.eq_ignore_ascii_case("jpg") || e.eq_ignore_ascii_case("jpeg")
                })
            })
            .filter(|p| {
                let key = crate::commands::google_photos::catalogue::curation_key(p);
                key.rsplit_once('.').map(|(s, _)| s) == Some(base)
            })
            .collect::<Vec<_>>();
        if sources.len() > 1 {
            return Err("Crop has ambiguous camera originals; review before processing".into());
        }
        if let Some(source) = sources.first() {
            return check(source, depth + 1);
        }
    }
    Ok(true)
}
fn raw_decision(path: &Path, anchor: Option<&Path>) -> bool {
    !crate::commands::raw_development::capture::review_flags(path, path, anchor).1
}
#[test]
fn paired_raw_eligibility_follows_camera_jpeg_restore_instead_of_old_raw_tag() {
    assert!(raw_decision(
        Path::new("raw{trash}.CR3"),
        Some(Path::new("camera.JPG"))
    ));
    assert!(!raw_decision(
        Path::new("raw.CR3"),
        Some(Path::new("camera{trash}.JPG"))
    ));
    assert!(!raw_decision(Path::new("raw{trash}.CR3"), None));
}
