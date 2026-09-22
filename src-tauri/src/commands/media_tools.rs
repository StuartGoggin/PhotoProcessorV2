//! Keep rendering, previews and probes on the same managed media-tool release.
use std::{ffi::OsString, path::PathBuf};

fn candidates(
    tool: &str,
    explicit: Option<OsString>,
    current_exe: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut result = Vec::new();
    if let Some(path) = explicit {
        let path = PathBuf::from(path);
        if tool == "ffmpeg" {
            result.push(path);
        } else if let Some(parent) = path.parent() {
            result.push(parent.join("ffprobe.exe"));
            result.push(parent.join("ffprobe"));
        }
    }
    if let Some(exe) = current_exe {
        if let Some(parent) = exe.parent() {
            // The versioned installer owns this directory. A legacy loose binary
            // beside the app must not hide its tested backend.
            result.push(
                parent
                    .join("tools")
                    .join("ffmpeg")
                    .join("bin")
                    .join(format!("{tool}.exe")),
            );
            result.push(parent.join(format!("{tool}.exe")));
        }
    }
    result.push(PathBuf::from(tool));
    result
}

pub(super) fn ffmpeg_candidates() -> Vec<PathBuf> {
    candidates(
        "ffmpeg",
        std::env::var_os("PHOTOGOGO_FFMPEG"),
        std::env::current_exe().ok(),
    )
}

pub(super) fn ffprobe_candidates() -> Vec<PathBuf> {
    candidates(
        "ffprobe",
        std::env::var_os("PHOTOGOGO_FFMPEG"),
        std::env::current_exe().ok(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn managed_media_tools_precede_legacy_and_path() {
        for tool in ["ffmpeg", "ffprobe"] {
            assert_eq!(
                candidates(tool, None, Some(PathBuf::from("app").join("PhotoGoGo.exe"))),
                vec![
                    PathBuf::from("app")
                        .join("tools/ffmpeg/bin")
                        .join(format!("{tool}.exe")),
                    PathBuf::from("app").join(format!("{tool}.exe")),
                    PathBuf::from(tool),
                ]
            );
        }
    }

    #[test]
    fn explicit_backend_and_its_sibling_probe_remain_first_for_rollback() {
        let explicit = PathBuf::from("previous").join("ffmpeg.exe");
        let exe = Some(PathBuf::from("app").join("PhotoGoGo.exe"));
        assert_eq!(
            candidates(
                "ffmpeg",
                Some(explicit.clone().into_os_string()),
                exe.clone()
            )[0],
            explicit
        );
        let probes = candidates("ffprobe", Some(explicit.into_os_string()), exe);
        assert_eq!(probes[0], PathBuf::from("previous").join("ffprobe.exe"));
        assert_eq!(probes[1], PathBuf::from("previous").join("ffprobe"));
        assert_eq!(
            probes[2],
            PathBuf::from("app").join("tools/ffmpeg/bin/ffprobe.exe")
        );
    }

    #[test]
    fn path_fallback_survives_missing_executable_location() {
        assert_eq!(
            candidates("ffmpeg", None, None),
            vec![PathBuf::from("ffmpeg")]
        );
        assert_eq!(
            candidates("ffprobe", None, None),
            vec![PathBuf::from("ffprobe")]
        );
    }
}
