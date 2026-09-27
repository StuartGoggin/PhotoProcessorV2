//! Quality-only roll constraint. Defaults preserve legacy filters and cache keys.
use super::*;

pub(super) fn prevent_rotation(p: &Project, c: &Clip) -> bool {
    c.stabilization != "off" && c.stabilization_method == "quality"
        && c.prevent_rotation.unwrap_or(p.default_prevent_rotation)
}

pub(super) fn append_cache_policy(parts: &mut Vec<String>, p: &Project, c: &Clip) {
    if prevent_rotation(p, c) { parts.push("quality-no-added-rotation-v1".into()); }
}

pub(super) fn base_key(p: &Project, c: &Clip, source_key: &str, encoder: &str) -> Result<String, String> {
    let mut parts = vec!["base".into(), source_key.into(), format_key(p), c.stabilization.clone(),
        c.stabilization_method.clone(), serde_json::to_string(&c.custom_stabilization).map_err(|e| e.to_string())?,
        c.framing.clone(), encoder.into()];
    append_cache_policy(&mut parts, p, c);
    Ok(signature(&parts))
}

pub(super) fn quality_filter(p: &Project, c: &Clip, transform: &str, smoothing: u32, output: &str) -> String {
    let (zoom, optzoom, speed) = match c.framing.as_str() {
        "maxFrame" => (0, 0, 0.0),
        "aggressiveCrop" => (8, 2, 0.4),
        _ => (4, 2, 0.25),
    };
    // vid.stab clamps the applied alpha after smoothing. 0 prevents added roll;
    // unlike virtual tripod, relative=1 and pan/tilt smoothing remain unchanged.
    let rotation = if prevent_rotation(p, c) { ":maxangle=0" } else { "" };
    format!("vidstabtransform=input={transform}:smoothing={smoothing}:zoom={zoom}:optzoom={optzoom}:zoomspeed={speed}:relative=1:crop=black:interpol=bicubic{rotation},unsharp=5:5:0.6:3:3:0.0,{output}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_rotation_defaults_round_trip_and_reject_invalid_types() {
        let mut raw = serde_json::to_value(super::super::tests::project(Path::new("."))).unwrap();
        raw.as_object_mut().unwrap().remove("defaultPreventRotation");
        raw["clips"][0].as_object_mut().unwrap().remove("preventRotation");
        let old: Project = serde_json::from_value(raw.clone()).unwrap();
        assert!(!old.default_prevent_rotation);
        assert_eq!(old.clips[0].prevent_rotation, None);
        for choice in [Value::Null, json!(true), json!(false)] {
            raw["defaultPreventRotation"] = json!(true);
            raw["clips"][0]["preventRotation"] = choice.clone();
            let saved: Project = serde_json::from_value(raw.clone()).unwrap();
            assert_eq!(serde_json::to_value(saved).unwrap()["clips"][0]["preventRotation"], choice);
        }
        raw["clips"][0]["preventRotation"] = json!("true,tripod=1");
        assert!(serde_json::from_value::<Project>(raw).is_err());
    }

    #[test]
    fn rotation_constraint_inherits_with_explicit_off_and_quality_only() {
        let mut p = super::super::tests::project(Path::new("."));
        p.default_prevent_rotation = true;
        assert!(!prevent_rotation(&p, &p.clips[0]), "Fast unaffected");
        p.clips[0].stabilization_method = "quality".into();
        assert!(prevent_rotation(&p, &p.clips[0]));
        p.clips[0].prevent_rotation = Some(false);
        assert!(!prevent_rotation(&p, &p.clips[0]));
        p.default_prevent_rotation = false;
        p.clips[0].prevent_rotation = Some(true);
        assert!(prevent_rotation(&p, &p.clips[0]));
        p.clips[0].stabilization = "off".into();
        assert!(!prevent_rotation(&p, &p.clips[0]));
    }

    #[test]
    fn quality_rotation_changes_only_angle_limit_not_pan_zoom_or_smoothing() {
        let mut p = super::super::tests::project(Path::new("."));
        p.clips[0].stabilization_method = "quality".into();
        for framing in ["maxFrame", "edgeSafe", "aggressiveCrop"] {
            p.clips[0].framing = framing.into();
            p.default_prevent_rotation = false;
            let old = quality_filter(&p, &p.clips[0], "motion_0.trf", 30, "format=yuv420p");
            p.default_prevent_rotation = true;
            let constrained = quality_filter(&p, &p.clips[0], "motion_0.trf", 30, "format=yuv420p");
            assert_eq!(constrained.replace(":maxangle=0", ""), old);
            assert!(constrained.contains(":smoothing=30:"));
            assert!(constrained.contains(":relative=1:"));
            assert!(!constrained.contains("tripod"));
        }
    }

    #[test]
    fn base_cache_preserves_legacy_and_keys_only_effective_rotation() {
        let mut p = super::super::tests::project(Path::new("."));
        p.clips[0].stabilization_method = "quality".into();
        let c = &p.clips[0];
        let legacy = signature(&["base".into(), "source".into(), format_key(&p), c.stabilization.clone(),
            c.stabilization_method.clone(), serde_json::to_string(&c.custom_stabilization).unwrap(), c.framing.clone(), "libx264".into()]);
        assert_eq!(base_key(&p, c, "source", "libx264").unwrap(), legacy);
        p.default_prevent_rotation = true;
        assert_ne!(base_key(&p, &p.clips[0], "source", "libx264").unwrap(), legacy);
        p.clips[0].prevent_rotation = Some(false);
        assert_eq!(base_key(&p, &p.clips[0], "source", "libx264").unwrap(), legacy);
        for (method, preset) in [("fast", "gentle"), ("quality", "off")] {
            p.clips[0].stabilization_method = method.into(); p.clips[0].stabilization = preset.into();
            let before = base_key(&p, &p.clips[0], "source", "libx264").unwrap();
            p.clips[0].prevent_rotation = Some(true);
            assert_eq!(base_key(&p, &p.clips[0], "source", "libx264").unwrap(), before);
        }
    }

    #[test]
    #[ignore = "bounded 320x180 FFmpeg pixel test; requires bundled media tools"]
    fn no_added_rotation_pixels_smoke() {
        let ff = detect_ffmpeg_capabilities().unwrap().binary;
        let root = std::env::temp_dir().join(format!("studio-rotation-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir(&root).unwrap();
        let mut p = super::super::tests::project(&root);
        p.width = 320; p.height = 180; p.fps = 25;
        p.clips[0].stabilization_method = "quality".into();
        p.clips[0].framing = "maxFrame".into();
        // Feed known motion into the real transform stage, independent of detector
        // noise: same X/Y, with and without erroneous angle estimates. Keep
        // relative=1 and production smoothing; test all decoded pixels, not logs.
        for (name, shift, rotate) in [("still.trf", false, false), ("roll.trf", false, true),
            ("xy.trf", true, false), ("xy-roll.trf", true, true)] {
            let mut data = String::from("# deterministic transform fixture\n");
            for frame in 0..25 {
                let wave = (frame as f64 * 0.8).sin();
                let x = if shift { wave * 4. } else { 0. };
                let y = if shift { wave * 3. } else { 0. };
                let angle = if rotate { wave * 0.08 } else { 0. };
                data.push_str(&format!("{frame} {x} {y} {angle} 0 0\n"));
            }
            fs::write(root.join(name), data).unwrap();
        }
        let pixels = |project: &Project, motion: &str| {
            let filter = quality_filter(project, &project.clips[0], motion, 18, "format=yuv420p");
            let result = command(&ff).current_dir(&root).env("OMP_NUM_THREADS", "2")
                .args(["-v", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-f", "lavfi", "-i",
                    "testsrc2=size=320x180:rate=25", "-frames:v", "25", "-vf", &filter,
                    "-an", "-threads", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "pipe:1"])
                .output().unwrap();
            assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
            assert_eq!(result.stdout.len(), 320 * 180 * 3 / 2 * 25);
            result.stdout
        };
        let still = pixels(&p, "still.trf");
        let rotating = pixels(&p, "roll.trf");
        assert!(rotating != still, "negative control must add visible rotation");
        let xy = pixels(&p, "xy.trf");
        assert!(xy != still, "fixture must exercise translation correction");
        p.default_prevent_rotation = true;
        assert!(pixels(&p, "roll.trf") == still, "angle-only motion must add exactly zero roll");
        assert!(pixels(&p, "xy-roll.trf") == xy, "angle constraint must retain the same X/Y correction");
        println!("PASS: 25 frames at 320x180; zero-roll output exactly matches every reference pixel; X/Y correction preserved. FFmpeg: {}", ff.display());
        println!("Transform fixtures retained at {}", root.display());
    }
}
