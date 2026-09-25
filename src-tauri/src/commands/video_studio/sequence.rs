//! A saved export describes one immutable ordered sequence, not a live project.
use super::*;

// Keep this versioned array contract aligned with studioWorkflow.sequenceRecipe.
// It intentionally excludes cache paths, review notes and scheduling state.
pub(super) fn recipe(p: &Project) -> Value {
    json!([
        1,
        [p.name, p.title, p.subtitle, p.title_seconds, p.opening_title_mode],
        [p.width, p.height, p.fps, effective_bitrate(p)],
        if p.music.enabled { json!([p.music.audio_path, p.music.music_volume, p.music.original_volume]) } else { Value::Null },
        p.clips.iter().filter(|c| c.include).map(|c| json!([
            c.id, c.path, c.revision, c.duration, c.chapter, c.title, c.title_seconds,
            c.stabilization, c.stabilization_method,
            [c.custom_stabilization.radius, c.custom_stabilization.block_size, c.custom_stabilization.contrast],
            c.framing,
            c.replays.iter().filter(|r| r.enabled).map(|r| json!([r.id, r.start, r.end, r.speed, r.caption])).collect::<Vec<_>>()
        ])).collect::<Vec<_>>()
    ])
}

pub(super) fn verify_prepared(planned: &Project, prepared: &Project) -> Result<(), String> {
    if recipe(planned) != recipe(prepared) {
        return Err("Prepared clip sequence does not match this saved render request; no final video was published".into());
    }
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssembledClip {
    clip_id: String,
    source_path: String,
    revision: u32,
    rendered_path: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Verification {
    version: u32,
    planned: Vec<ClipTarget>,
    assembled: Vec<AssembledClip>,
}

// This is called after each clip's source/signature/checksum verification and
// before an opening overlay changes the first segment's path. It checks the
// actual concat inputs in order, rather than writing two copies of the plan.
pub(super) fn verify_assembly(p: &Project, segments: &[(PathBuf, String)], has_card: bool) -> Result<Verification, String> {
    let included: Vec<_> = p.clips.iter().filter(|c| c.include).collect();
    let offset = usize::from(has_card);
    if included.is_empty() || segments.len() != included.len() + offset {
        return Err("Assembly clip count does not match this saved render request; no final video was published".into());
    }
    let planned = included.iter().map(|c| ClipTarget { clip_id: c.id.clone(), source_path: c.path.clone(), revision: c.revision }).collect();
    let mut assembled = Vec::with_capacity(included.len());
    for (clip, (actual_path, _)) in included.into_iter().zip(&segments[offset..]) {
        let rendered = clip.rendered.as_ref().ok_or("Assembly clip has no verified render")?;
        if actual_path.as_path() != Path::new(&rendered.path) {
            return Err(format!("Assembly clip order or file differs at {}; no final video was published", clip.chapter));
        }
        assembled.push(AssembledClip {
            clip_id: clip.id.clone(), source_path: clip.path.clone(), revision: clip.revision,
            rendered_path: actual_path.to_string_lossy().into_owned(),
        });
    }
    Ok(Verification { version: 1, planned, assembled })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> Project {
        let mut p = super::super::tests::project(Path::new("sequence-fixture"));
        let mut second = p.clips[0].clone();
        second.id = "two".into(); second.path = "second.mp4".into();
        p.clips.push(second);
        for clip in &mut p.clips {
            clip.rendered = Some(ClipRender {
                path: format!("{}.render.mp4", clip.id), width: p.width, height: p.height,
                fps: p.fps, duration: clip.duration, rendered_at: "fixture".into(),
                bitrate_mbps: p.bitrate_mbps, revision: clip.revision,
                signature: "verified elsewhere".into(), checksum: "verified elsewhere".into(),
            });
        }
        p
    }

    #[test]
    fn sequence_recipe_tracks_order_identity_and_output_edits() {
        let original = project();
        let saved = recipe(&original);
        assert_eq!(saved[0], 1);
        assert_eq!(saved[4][0][0], "one");
        assert_eq!(saved[4][1][0], "two");
        for change in 0..7 {
            let mut p = original.clone();
            match change {
                0 => p.clips.reverse(),
                1 => { p.clips[1].id = "replacement".into(); p.clips[1].path = "replacement.mp4".into(); },
                2 => p.clips[0].chapter = "New chapter".into(),
                3 => p.clips[0].stabilization = "strong".into(),
                4 => p.bitrate_mbps += 1,
                5 => p.title = "New opening".into(),
                _ => { p.music.enabled = true; p.music.audio_path = "soundtrack.wav".into(); },
            }
            assert_ne!(recipe(&p), saved, "recipe change {change} was ignored");
        }
    }

    #[test]
    fn sequence_recipe_ignores_cache_review_defaults_and_excluded_clips() {
        let mut p = project();
        let saved = recipe(&p);
        p.clips[0].reviewed = false; p.clips[0].notes = "review note".into();
        p.clips[0].rendered = None; p.performance = "balanced".into();
        p.adaptive_scheduling = false; p.default_stabilization = "strong".into();
        p.output_dir = "different destination".into(); p.music.audio_path = "unused.wav".into();
        let mut excluded = p.clips[0].clone(); excluded.id = "excluded".into(); excluded.include = false;
        p.clips.push(excluded);
        let mut disabled_replay = p.clips[0].replays[0].clone();
        disabled_replay.id = "disabled".into(); disabled_replay.enabled = false;
        p.clips[0].replays.push(disabled_replay);
        assert_eq!(recipe(&p), saved);
        p.clips[1].include = false;
        assert_ne!(recipe(&p), saved);
        let legacy: StudioJob = serde_json::from_value(json!({"kind":"project","targets":[]})).unwrap();
        assert!(legacy.sequence.is_none());
    }

    #[test]
    fn prepared_sequence_rejects_omission_reorder_and_same_count_replacement() {
        let expected = project();
        assert!(verify_prepared(&expected, &expected).is_ok());
        for change in 0..3 {
            let mut actual = expected.clone();
            match change {
                0 => { actual.clips.pop(); },
                1 => actual.clips.reverse(),
                _ => actual.clips[1].path = "wrong-source.mp4".into(),
            }
            assert!(verify_prepared(&expected, &actual).is_err());
        }
        let mut larger = expected.clone();
        for number in 3..=51 {
            let mut clip = expected.clips[0].clone(); clip.id = number.to_string();
            larger.clips.push(clip);
        }
        let mut older = larger.clone(); older.clips.truncate(31);
        assert!(verify_prepared(&larger, &older).is_err());
        assert!(verify_prepared(&larger, &larger).is_ok());
    }

    #[test]
    fn assembly_verification_checks_actual_paths_not_just_planned_count() {
        let p = project();
        let parts: Vec<_> = p.clips.iter().map(|c| (PathBuf::from(&c.rendered.as_ref().unwrap().path), c.chapter.clone())).collect();
        let receipt = verify_assembly(&p, &parts, false).unwrap();
        let saved = serde_json::to_value(&receipt).unwrap();
        assert_eq!(saved["planned"][1]["clipId"], "two");
        assert_eq!(saved["assembled"][1]["clipId"], "two");
        assert_eq!(saved["assembled"][1]["renderedPath"], "two.render.mp4");
        assert!(verify_assembly(&p, &parts[..1], false).is_err());
        let mut reversed = parts.clone(); reversed.reverse();
        assert!(verify_assembly(&p, &reversed, false).is_err());
        let mut replaced = parts.clone(); replaced[1].0 = PathBuf::from("another.render.mp4");
        assert!(verify_assembly(&p, &replaced, false).is_err());
        let mut with_card = vec![(PathBuf::from("opening.mp4"), "Opening title".into())];
        with_card.extend(parts);
        assert!(verify_assembly(&p, &with_card, true).is_ok());
        assert!(verify_assembly(&p, &with_card, false).is_err());
    }
}
