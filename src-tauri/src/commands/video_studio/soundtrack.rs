use super::*;

#[tauri::command]
pub fn studio_start_music(project: Project, staging_dir: String) -> Result<String, String> {
    validate(&project)?;
    validate_music_direction(project.music.direction.as_ref().ok_or("Draft a music direction first")?)?;
    lmms_binary(&project.music.lmms_path)?;
    recovery::enqueue(recovery::RenderRequest { project, staging_dir, preview: false,
        preview_start: None, preview_length: None, kind: "music".into(), clip_id: None, assemble_only: false })
}
fn lmms_binary(path: &str) -> Result<PathBuf, String> {
    let binary = fs::canonicalize(path).map_err(|_| "Choose your installed lmms.exe")?;
    if !binary.is_file() || !binary.file_name().map(|name| name.eq_ignore_ascii_case("lmms.exe")).unwrap_or(false) {
        return Err("Choose the LMMS executable (lmms.exe)".into());
    }
    Ok(binary)
}

// A self-contained synthesizer score: no downloaded samples, soundfonts or VSTs.
// AI supplies the musical direction; the local arranger supplies original notes.
fn compose_project(direction: &MusicDirection, seconds: f64) -> Result<String, String> {
    validate_music_direction(direction)?;
    let bars = ((seconds * f64::from(direction.bpm) / 240.).ceil() as u32).clamp(1, 7200);
    let mut xml = format!(r#"<?xml version="1.0"?><!DOCTYPE lmms-project><lmms-project creator="LMMS" creatorversion="1.2.2" type="song" version="1.0"><head bpm="{}" mastervol="70" masterpitch="0" timesig_numerator="4" timesig_denominator="4"/><song><trackcontainer>"#, direction.bpm);
    for (track, name, volume, wave, attack, release) in [
        (0, "Warm harmony", 22, 0, 0.15, 0.2), (1, "Soft bass", 25, 0, 0.01, 0.06),
        (2, "Light pulse", 14, 1, 0.01, 0.12),
    ] {
        xml.push_str(&format!(r#"<track type="0" name="{name}" muted="0" solo="0"><instrumenttrack vol="{volume}" pan="0" pitch="0" basenote="57" fxch="0" usemasterpitch="1"><instrument name="tripleoscillator"><tripleoscillator vol0="100" vol1="0" vol2="0" wavetype0="{wave}" coarse0="0" finel0="0" finer0="0" pan0="0"/></instrument><eldata><elvol amt="1" att="{attack}" hold="0" dec="0.15" sustain="0.7" rel="{release}"/></eldata><fxchain enabled="0" numofeffects="0"/></instrumenttrack>"#));
        for bar in 0..bars {
            let energy = section_energy(direction, bar);
            let (root, minor) = chord_root(&direction.chord_progression[bar as usize % direction.chord_progression.len()], pitch_for_root(&direction.key));
            let third = if minor { 3 } else { 4 };
            xml.push_str(&format!(r#"<pattern type="1" name="{name}" pos="{}" len="192" steps="16">"#, bar * 192));
            let mut add = |pos: u32, len: u32, key: i16, vol: u8| xml.push_str(&format!(r#"<note pos="{pos}" len="{len}" key="{key}" vol="{vol}" pan="0"/>"#));
            match track {
                0 => for interval in [0, third, 7] { add(0, 182, 48 + root + interval, 45 + energy * 7); },
                1 => for beat in 0..4 { add(beat * 48, 38, 24 + root, 45 + energy * 8); },
                _ => for beat in 0..if energy >= 4 { 8 } else { 4 } {
                    let step = if energy >= 4 { 24 } else { 48 };
                    let tones = [0, third, 7, 12];
                    add(beat * step, step / 2, 60 + root + tones[((bar + beat) % 4) as usize], 35 + energy * 7);
                },
            }
            xml.push_str("</pattern>");
        }
        xml.push_str("</track>");
    }
    xml.push_str("</trackcontainer></song></lmms-project>");
    Ok(xml)
}

pub(super) fn render_soundtrack(p: &Project, id: &str) -> Result<String, String> {
    let binary = lmms_binary(&p.music.lmms_path)?;
    let direction = p.music.direction.as_ref().ok_or("Music direction missing")?;
    let folder = Path::new(&p.output_dir).join(format!("VideoStudio-music-{id}"));
    fs::create_dir(&folder).map_err(|e| e.to_string())?;
    let project = folder.join("soundtrack.mmp");
    let output = folder.join("soundtrack.wav");
    let partial = folder.join("soundtrack.partial.wav");
    fs::write(&project, compose_project(direction, project_timeline_seconds(p))?).map_err(|e| e.to_string())?;
    update(id, |j| { j.phase = "Rendering the soundtrack in LMMS".into(); j.music_project_path = Some(project.to_string_lossy().into_owned()); });
    let args = vec!["render".into(), project.to_string_lossy().into_owned(), "-s".into(), "48000".into(), "-x".into(), "1".into(), "-f".into(), "wav".into(), "-o".into(), partial.to_string_lossy().into_owned()];
    diagnostics::run_process(&binary, &args, &folder, id, "Rendering the soundtrack in LMMS", None, Some(Duration::from_secs(1800)), None)?;
    let ff = detect_ffmpeg_capabilities()?.binary;
    let info = inspect(&ff, &partial)?;
    let seconds = info["format"]["duration"].as_str().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.);
    if seconds + 0.1 < project_timeline_seconds(p) || !info["streams"].as_array().map(|s| s.iter().any(|s| s["codec_type"] == "audio")).unwrap_or(false) {
        return Err("LMMS output is missing audio or is shorter than the video".into());
    }
    fs::rename(partial, &output).map_err(|e| e.to_string())?;
    Ok(output.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "uses locally installed LMMS and FFmpeg to render audible audio"]
    fn lmms_audio_smoke() {
        let root = std::env::temp_dir().join(format!("studio-lmms-{}", chrono::Utc::now().timestamp_millis()));
        fs::create_dir(&root).unwrap();
        let mut p = super::super::tests::project(&root);
        p.music.lmms_path = std::env::var("PHOTOGOGO_LMMS").unwrap_or_else(|_| "C:/Program Files/LMMS/lmms.exe".into());
        p.music.direction = Some(MusicDirection { title: "Warm test".into(), summary: "Quiet synth score".into(), genre: "ambient".into(), mood: "warm".into(), key: "C".into(), mode: "major".into(), bpm: 100, energy: 2, instruments: vec!["pad".into()], chord_progression: vec!["C".into(), "G".into()], arrangement: vec![MusicSection {name: "intro".into(),bars: 4,energy: 2}] });
        let id = "lmms-audio-test";
        jobs().lock().unwrap().insert(id.into(), StudioJob { id: id.into(), status: "running".into(), ..StudioJob::default() });
        let audio = render_soundtrack(&p, id).unwrap();
        let ff = detect_ffmpeg_capabilities().unwrap().binary;
        let info = inspect(&ff, Path::new(&audio)).unwrap();
        assert_eq!(info["streams"][0]["sample_rate"], "48000");
        let volume = command(&ff).args(["-i", &audio, "-af", "volumedetect", "-f", "null", "-"]).output().unwrap();
        let log = String::from_utf8_lossy(&volume.stderr);
        assert!(!log.contains("mean_volume: -inf"));
        assert!(log.contains("mean_volume:"));
        println!("Verified audible LMMS score: {audio}\n{log}");
    }
    #[test]
    fn lmms_score_contains_self_contained_instruments() {
        let direction = MusicDirection { title: "x".into(), summary: "x".into(), genre: "ambient".into(), mood: "warm".into(), key: "C".into(), mode: "major".into(), bpm: 100, energy: 2, instruments: vec!["pad".into()], chord_progression: vec!["C".into(), "G".into()], arrangement: vec![MusicSection {name: "intro".into(),bars: 4,energy: 2}] };
        let xml = compose_project(&direction, 10.).unwrap();
        assert_eq!(xml.matches("<track ").count(), 3);
        assert!(xml.contains("tripleoscillator")); assert!(xml.ends_with("</lmms-project>"));
        assert!(!xml.contains("soundfont"));
    }
}
