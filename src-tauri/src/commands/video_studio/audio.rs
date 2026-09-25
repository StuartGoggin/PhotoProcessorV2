//! Camera-audio processing only. Presets are fixed, versioned and shared by
//! bounded listening previews and final assembly; picture caches stay original.
use super::*;

pub(super) fn inherit() -> String { "inherit".into() }
pub(super) fn validate(p: &Project) -> Result<(), String> {
    preset_filters(&p.default_wind_reduction)?;
    for c in &p.clips {
        if c.wind_reduction != "inherit" { preset_filters(&c.wind_reduction)?; }
    }
    Ok(())
}

pub(super) fn effective<'a>(p: &'a Project, c: &'a Clip) -> &'a str {
    if c.wind_reduction == "inherit" { &p.default_wind_reduction } else { &c.wind_reduction }
}

// No gate, speech model, normalization or gain boost. A shelf gently reduces
// hiss without cutting off all high-frequency event detail. These also reduce
// wanted low/high sounds: Off is the migration default and A/B is intentional.
fn preset_filters(preset: &str) -> Result<Vec<String>, String> {
    let (bass, treble) = match preset {
        "off" => return Ok(vec![]),
        "light" => (60, -2),
        "moderate" => (85, -4),
        "strong" => (110, -6),
        _ => return Err("Unknown wind reduction preset".into()),
    };
    Ok(vec![format!("highpass=f={bass}:p=2"), format!("treble=g={treble}:f=6000:t=q:w=0.5")])
}

pub(super) fn recipe(p: &Project) -> Option<Value> {
    let included: Vec<_> = p.clips.iter().filter(|c| c.include).collect();
    if included.iter().all(|c| effective(p, c) == "off") { return None; }
    Some(json!([1, included.iter().map(|c| json!([c.id, effective(p, c)])).collect::<Vec<_>>()]))
}

pub(super) fn segment_presets(p: &Project, assembled: bool, has_card: bool) -> Vec<String> {
    let mut presets = vec![];
    if has_card { presets.push("off".into()); }
    for c in p.clips.iter().filter(|c| c.include) {
        presets.push(effective(p, c).into());
        if !assembled {
            presets.extend(c.replays.iter().filter(|r| r.enabled).map(|_| effective(p, c).into()));
        }
    }
    presets
}

// FFmpeg limits expression-tree depth. A flat a+b+c+... is left-associative
// and fails around 100 terms (reported as ENOMEM). Keep identical conditions
// in a balanced tree: logarithmic depth, even for large direct replay sequences.
fn balanced_sum(terms: &[String]) -> String {
    match terms {
        [] => "0".into(),
        [only] => only.clone(),
        _ => {
            let middle = terms.len() / 2;
            format!("({}+{})", balanced_sum(&terms[..middle]), balanced_sum(&terms[middle..]))
        }
    }
}

/// At most six biquads regardless of clip count. Frame-sized audio blocks make
/// per-clip switches exact at the measured video boundaries (48 kHz / fps is
/// integral for all supported formats). No full-video copy or PCM scratch file.
pub(super) fn camera_chain(fps: u32, windows: &[(String, u64, u64)]) -> Result<String, String> {
    if ![25, 30, 50, 60].contains(&fps) { return Err("Unsupported audio timeline rate".into()); }
    for (preset, start, end) in windows {
        preset_filters(preset)?;
        if start >= end { return Err("Invalid camera audio interval".into()); }
    }
    let mut filters = vec!["aresample=48000:async=1:first_pts=0".to_string(), format!("asetnsamples=n={}:p=0", 48000 / fps)];
    for preset in ["light", "moderate", "strong"] {
        let ranges = windows.iter().filter(|(name, _, _)| name == preset)
            .map(|(_, start, end)| format!("gte(n,{start})*lt(n,{end})")).collect::<Vec<_>>();
        if ranges.is_empty() { continue; }
        for filter in preset_filters(preset)? {
            filters.push(format!("{filter}:enable='{}'", balanced_sum(&ranges)));
        }
    }
    Ok(filters.join(","))
}

pub(super) fn assembly_graph(camera: &str, music: Option<(u8, u8)>, total: f64) -> String {
    if let Some((music_volume, original_volume)) = music {
        let original = f64::from(original_volume) / 100.;
        let music = f64::from(music_volume) / 100.;
        let fade_start = (total - 2.).max(0.);
        format!("[0:a]{camera},volume={original:.2}[clip];[2:a]aresample=async=1:first_pts=0,volume={music:.2},afade=t=in:st=0:d=1,afade=t=out:st={fade_start:.3}:d=2,atrim=duration={total:.3}[music];[clip][music]amix=inputs=2:duration=first:dropout_transition=2:normalize=0,atrim=duration={total:.6}[mix]")
    } else {
        format!("[0:a]{camera},atrim=duration={total:.6}[mix]")
    }
}

#[derive(Serialize)]
pub struct AudioPreview { original: String, processed: String, seconds: f64, preset: String }
static PREVIEW: Mutex<()> = Mutex::new(());

fn preview_range(start: f64, seconds: f64, duration: f64) -> Result<f64, String> {
    if !start.is_finite() || start < 0. || !seconds.is_finite() || seconds <= 0. || seconds > 20.
        || !duration.is_finite() || start >= duration {
        return Err("Choose an audio preview inside the clip, up to 20 seconds".into());
    }
    Ok(seconds.min(duration - start))
}

// Write a proper seekable WAV header for browser playback, not pipe-mode WAV's
// unknown length header. The input is always bounded 48 kHz stereo PCM s16le.
fn wav(pcm: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(44 + pcm.len());
    bytes.extend(b"RIFF"); bytes.extend((36 + pcm.len() as u32).to_le_bytes());
    bytes.extend(b"WAVEfmt "); bytes.extend(16u32.to_le_bytes());
    bytes.extend(1u16.to_le_bytes()); bytes.extend(2u16.to_le_bytes());
    bytes.extend(48000u32.to_le_bytes()); bytes.extend(192000u32.to_le_bytes());
    bytes.extend(4u16.to_le_bytes()); bytes.extend(16u16.to_le_bytes());
    bytes.extend(b"data"); bytes.extend((pcm.len() as u32).to_le_bytes()); bytes.extend(pcm);
    bytes
}

fn preview_pcm(ff: &Path, path: &Path, has_audio: bool, start: f64, seconds: f64, preset: &str) -> Result<Vec<u8>, String> {
    let mut args: Vec<String> = ["-v", "error", "-nostdin", "-threads", "1", "-filter_threads", "1"].map(String::from).into();
    if has_audio {
        args.extend(["-ss".into(), start.to_string(), "-i".into(), path.to_string_lossy().into_owned()]);
    } else {
        args.extend(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"].map(String::from));
    }
    let mut filters = vec!["aresample=48000:async=1:first_pts=0".into()];
    filters.extend(preset_filters(preset)?);
    // Pad absent/short source audio to the requested video interval, as clip
    // rendering does, so both listening sides have identical sample counts.
    filters.push(format!("apad,atrim=end_sample={}", (seconds * 48000.).round() as u64));
    args.extend(["-map".into(), "0:a:0".into(), "-vn".into(), "-sn".into(), "-dn".into(),
        "-af".into(), filters.join(","), "-ac".into(), "2".into(), "-ar".into(), "48000".into(),
        "-c:a".into(), "pcm_s16le".into(), "-f".into(), "s16le".into(), "pipe:1".into()]);
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    let out = super::super::process::command_output_limited(ff, &refs, 4_000_000, Duration::from_secs(30))?;
    if !out.status.success() || out.stdout.is_empty() {
        return Err(format!("Audio preview failed: {}", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(out.stdout)
}

#[tauri::command]
pub async fn studio_audio_preview(staging_dir: String, path: String, start: f64, seconds: f64, preset: String) -> Result<AudioPreview, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = PREVIEW.try_lock().map_err(|_| "Another audio preview is still being prepared")?;
        preset_filters(&preset)?;
        // Validate finite bounds before probing or launching any media work.
        preview_range(start, seconds, f64::MAX)?;
        let path = source(Path::new(&staging_dir), &path)?;
        let ff = detect_ffmpeg_capabilities()?.binary;
        let info = inspect(&ff, &path)?;
        let seconds = preview_range(start, seconds, duration(&info)?)?;
        let has_audio = info["streams"].as_array().map(|s| s.iter().any(|s| s["codec_type"] == "audio")).unwrap_or(false);
        let original = preview_pcm(&ff, &path, has_audio, start, seconds, "off")?;
        let processed = if preset == "off" { original.clone() } else { preview_pcm(&ff, &path, has_audio, start, seconds, &preset)? };
        if original.len() != processed.len() { return Err("Audio preview lengths did not match".into()); }
        Ok(AudioPreview { original: crate::utils::base64_encode(&wav(&original)), processed: crate::utils::base64_encode(&wav(&processed)), seconds, preset })
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn studio_audio_defaults_validation_and_sequence() {
        let mut p = super::super::tests::project(Path::new("."));
        let mut old = serde_json::to_value(&p).unwrap();
        old.as_object_mut().unwrap().remove("defaultWindReduction");
        old["clips"][0].as_object_mut().unwrap().remove("windReduction");
        let restored: Project = serde_json::from_value(old).unwrap();
        assert_eq!(effective(&restored, &restored.clips[0]), "off");
        assert!(recipe(&restored).is_none());
        let saved = sequence::recipe(&p);
        p.default_wind_reduction = "light".into();
        assert_eq!(effective(&p, &p.clips[0]), "light");
        assert_eq!(sequence::recipe(&p)[0], 2);
        assert_ne!(sequence::recipe(&p), saved);
        p.clips[0].wind_reduction = "off".into();
        assert_eq!(sequence::recipe(&p), saved);
        p.clips[0].wind_reduction = "strong,volume=20".into();
        assert!(validate(&p).is_err());
        assert!(preset_filters("inherit").is_err());
    }
    #[test]
    fn studio_audio_timeline_is_bounded_and_music_is_outside_filters() {
        let mut p = super::super::tests::project(Path::new("."));
        p.default_wind_reduction = "light".into();
        assert_eq!(segment_presets(&p, true, true), ["off", "light"]);
        assert_eq!(segment_presets(&p, false, true), ["off", "light", "light"]);
        let windows = (0..500).map(|n| ("light".into(), n * 25, n * 25 + 25)).collect::<Vec<_>>();
        let chain = camera_chain(25, &windows).unwrap();
        assert_eq!(chain.matches("highpass=").count(), 1);
        assert_eq!(chain.matches("treble=").count(), 1);
        assert!(chain.contains("asetnsamples=n=1920:p=0"));
        let graph = assembly_graph(&chain, Some((28, 45)), 500.);
        let music = graph.split("[2:a]").nth(1).unwrap();
        assert!(!music.contains("highpass")); assert!(!music.contains("treble"));
        assert!(graph.contains("normalize=0"));
        assert!(camera_chain(0, &windows).is_err());
    }
    #[test]
    fn studio_audio_preview_bounds_and_wav_length() {
        assert_eq!(preview_range(9., 10., 10.).unwrap(), 1.);
        for (start, seconds) in [(f64::NAN, 10.), (0., f64::INFINITY), (-1., 10.), (0., 21.), (10., 1.)] {
            assert!(preview_range(start, seconds, 10.).is_err());
        }
        let bytes = wav(&[0; 16]);
        assert_eq!(&bytes[..4], b"RIFF"); assert_eq!(bytes.len(), 60);
        assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 16);
    }

    // A short synthetic fixture, no private media or 4K benchmark. Run explicitly
    // with the bundled FFmpeg to exercise its actual filters/codec/muxer.
    #[test]
    #[ignore = "Requires FFmpeg; bounded synthetic audio and stream-copy smoke"]
    fn studio_audio_media_smoke() {
        let ff = detect_ffmpeg_capabilities().unwrap().binary;
        let root = std::env::temp_dir().join(format!("studio-audio-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        fs::create_dir(&root).unwrap();
        let file = root.join("source.mp4");
        let out = command(&ff).args(["-v", "error", "-nostdin", "-f", "lavfi", "-i", "color=size=320x180:rate=25", "-f", "lavfi", "-i",
            "aevalsrc=0.1*sin(2*PI*30*t)+0.1*sin(2*PI*1000*t)+0.1*sin(2*PI*12000*t):s=48000", "-t", "2", "-c:v", "libx264", "-bf", "0", "-c:a", "aac", "-b:a", "192k"])
            .arg(&file).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let original = preview_pcm(&ff, &file, true, 0., 2., "off").unwrap();
        assert_eq!(original.len(), 384000);
        fn tone(pcm: &[u8], hz: f64, begin: f64, end: f64) -> f64 {
            let mut sin = 0.; let mut cos = 0.;
            let start = (begin * 48000.) as usize; let stop = (end * 48000.) as usize;
            for n in start..stop {
                let sample = i16::from_le_bytes(pcm[n*4..n*4+2].try_into().unwrap()) as f64;
                let angle = std::f64::consts::TAU * hz * n as f64 / 48000.;
                sin += sample * angle.sin(); cos += sample * angle.cos();
            }
            sin.hypot(cos) / (stop-start) as f64
        }
        for preset in ["light", "moderate", "strong"] {
            let processed = preview_pcm(&ff, &file, true, 0., 2., preset).unwrap();
            assert_eq!(processed.len(), original.len());
            let ratio = |hz| tone(&processed, hz, 0.25, 0.75) / tone(&original, hz, 0.25, 0.75);
            assert!(ratio(30.) < 0.3, "{preset}: low bass not reduced");
            assert!((0.93..1.01).contains(&ratio(1000.)), "{preset}: midband was damaged: {}", ratio(1000.));
            assert!(ratio(12000.) < 0.88, "{preset}: high hiss band not reduced");
        }
        let silent = preview_pcm(&ff, &file, false, 0., 0.2, "strong").unwrap();
        assert_eq!(silent.len(), 38400); assert!(silent.iter().all(|v| *v == 0));
        let windows = vec![("strong".into(), 0, 25), ("off".into(), 25, 50)];
        let chain = camera_chain(25, &windows).unwrap();
        let filtered = root.join("filtered.mp4");
        let out = command(&ff).arg("-v").arg("error").arg("-i").arg(&file)
            .args(["-map", "0:v", "-map", "0:a", "-c:v", "copy", "-af", &chain, "-c:a", "aac", "-b:a", "192k"])
            .arg(&filtered).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let decoded = preview_pcm(&ff, &filtered, true, 0., 2., "off").unwrap();
        assert!(tone(&decoded, 30., 0.25, 0.75) / tone(&original, 30., 0.25, 0.75) < 0.2);
        assert!((0.9..1.1).contains(&(tone(&decoded, 30., 1.25, 1.75) / tone(&original, 30., 1.25, 1.75))), "Off clip was filtered");
        let video_hash = |path: &Path| command(&ff).arg("-v").arg("error").arg("-i").arg(path).args(["-map", "0:v", "-c:v", "copy", "-f", "hash", "-"]).output().unwrap().stdout;
        assert_eq!(video_hash(&file), video_hash(&filtered), "Audio change altered video packets");
        assert_eq!(delivery::frame_count(&inspect(&ff, &filtered).unwrap()).unwrap(), 50);
        assert!((duration(&inspect(&ff, &filtered).unwrap()).unwrap() - 2.).abs() < 0.05);
        // With camera volume zero, processing must not alter a single sample of
        // the music branch. Input 1 is a harmless duplicate filling metadata slot.
        let music_samples = |camera: &str| {
            let graph = assembly_graph(camera, Some((100, 0)), 2.);
            let out = command(&ff).args(["-v", "error"]).arg("-i").arg(&file).arg("-i").arg(&file).arg("-i").arg(&file)
                .args(["-filter_complex", &graph, "-map", "[mix]", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "s16le", "-"]).output().unwrap();
            assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr)); out.stdout
        };
        assert_eq!(music_samples(&chain), music_samples("aresample=48000:async=1:first_pts=0,asetnsamples=n=1920:p=0"));
        // The maximum 500-clip alternating recipe must parse and execute as a
        // script even when its expanded graph exceeds practical CLI budgets.
        let large = (0..500).map(|n| (["light", "moderate", "strong", "off"][(n % 4) as usize].into(), n * 25, n * 25 + 25)).collect::<Vec<_>>();
        let graph = assembly_graph(&camera_chain(25, &large).unwrap(), None, 2.);
        text_asset(&root, "audio-scale.txt", &graph).unwrap();
        let script = root.join("audio-scale.txt");
        let out = command(&ff).args(["-v", "error"]).arg("-i").arg(&file)
            .arg("-filter_complex_script").arg(script).args(["-map", "[mix]", "-f", "null", "-"]).output().unwrap();
        assert!(out.status.success(), "500-clip graph failed: {}", String::from_utf8_lossy(&out.stderr));
        println!("Verified bass/hiss attenuation, preserved midband, silent source, per-clip Off, unchanged video packets/frame count/duration and unfiltered music");
        fs::remove_dir_all(root).unwrap();
    }
}
