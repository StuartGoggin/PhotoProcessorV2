use super::*;
use std::fs;

#[test]
fn viewing_choice_is_separate_from_recipe_and_lineage_and_survives_rating_tags() {
    let space = worker::Workspace::new().unwrap();
    let source = space.0.join("shot.cr3");
    fs::write(&source, b"immutable RAW fixture").unwrap();
    let root = space.0.to_string_lossy();
    assert!(manifest::save_lightbox_choice(&root, "shot.cr3", "raw").is_err());
    manifest::save_lightbox_choice(&root, "shot.cr3", "cameraJpeg").unwrap();
    let m = manifest::load(&space.0).unwrap();
    let record = m.records.values().next().unwrap();
    assert!(record.recipe.is_none());
    assert!(record.last_applied_recipe.is_none());
    assert!(record.outputs.is_empty());
    assert!(record.source_hash.is_empty());
    assert_eq!(record.source_bytes, 0);
    assert_eq!(manifest::lightbox_choices(&space.0, &[source.clone()]).unwrap(), vec![(0, "cameraJpeg".into())]);
    let renamed = space.0.join("shot{Like oo}.cr3");
    let lease = capture::guard_move(&source, &renamed).unwrap();
    fs::rename(&source, &renamed).unwrap(); drop(lease);
    assert_eq!(manifest::lightbox_choices(&space.0, &[renamed.clone()]).unwrap().len(), 1);
    assert!(capture::guard_move(&renamed, &space.0.join("different.cr3")).is_err());
    fs::write(&renamed, b"a different RAW master fixture").unwrap();
    assert!(manifest::lightbox_choices(&space.0, &[renamed]).unwrap().is_empty());
}

#[test]
fn finish_choice_rejects_invalid_values_escape_and_non_raw_without_metadata_write() {
    let space = worker::Workspace::new().unwrap();
    fs::write(space.0.join("shot.cr3"), b"original").unwrap();
    fs::write(space.0.join("shot.jpg"), b"jpeg").unwrap();
    for (path, choice) in [("shot.cr3", "anything"), ("shot.jpg", "raw"), ("../outside.cr3", "cameraJpeg")] {
        assert!(manifest::save_lightbox_choice(&space.0.to_string_lossy(), path, choice).is_err());
    }
    assert!(!space.0.join(manifest::NAME).exists());
}

#[test]
fn paired_capture_review_preserves_jpeg_decisions_and_ignores_stale_raw_tags() {
    let raw = Path::new("shot{Like ooo}{trash}.cr3");
    let jpeg = Path::new("camera{Like oo}.jpg");
    assert_eq!(capture::review_flags(raw, raw, Some(jpeg)), (2, false));
    assert_eq!(capture::review_flags(jpeg, raw, Some(jpeg)), (2, false));
    assert_eq!(capture::review_flags(Path::new("developed.jpg"), raw, Some(jpeg)), (2, false));
    assert_eq!(capture::review_flags(Path::new("developed{trash}.jpg"), raw, Some(jpeg)), (2, true));
    assert_eq!(capture::review_flags(raw, raw, None), (3, true));
    let trashed = Path::new("camera{trash}.jpg");
    assert_eq!(capture::review_flags(raw, raw, Some(trashed)), (0, true));
}

#[test]
fn saved_raw_finish_retains_lineage_and_rejects_changed_or_tiff_only_output() {
    let space = worker::Workspace::new().unwrap();
    let source = space.0.join("shot.cr3");
    let output = space.0.join("developed.jpg");
    fs::write(&source, b"immutable RAW").unwrap();fs::write(&output, b"validated full resolution output fixture").unwrap();
    manifest::edit(&source, |r| {
        r.source_hash = worker::hash(&source)?; r.source_bytes=fs::metadata(&source).unwrap().len(); r.source_modified=manifest::modified(&source)?;
        r.recipe=Some(RawRecipe::default());
        r.outputs.push(manifest::Output { file:"developed.jpg".into(),kind:"developed".into(),hash:worker::hash(&output)?,bytes:fs::metadata(&output).unwrap().len(),recipe_hash:"recipe".into(),active:true });Ok(())
    }).unwrap();
    let before=manifest::load(&space.0).unwrap().records.values().next().unwrap().clone();
    manifest::save_lightbox_choice(&space.0.to_string_lossy(), "shot.cr3", "raw").unwrap();
    let after=manifest::load(&space.0).unwrap().records.values().next().unwrap().clone();
    assert_eq!(before.source_hash, after.source_hash);assert_eq!(before.source_bytes, after.source_bytes);assert_eq!(before.source_modified, after.source_modified);
    assert_eq!(serde_json::to_value(before.recipe).unwrap(),serde_json::to_value(after.recipe).unwrap());
    assert_eq!(serde_json::to_value(before.outputs).unwrap(),serde_json::to_value(after.outputs).unwrap());
    fs::write(&output,b"tampered output").unwrap();
    assert!(manifest::save_lightbox_choice(&space.0.to_string_lossy(), "shot.cr3", "raw").is_err());
    manifest::edit(&source,|r|{r.outputs[0].file="developed.tif".into();Ok(())}).unwrap();
    assert!(manifest::save_lightbox_choice(&space.0.to_string_lossy(), "shot.cr3", "raw").is_err());
}

#[test]
fn viewing_choice_moves_with_event_metadata_and_ambiguous_sources_are_not_guessed() {
    let space=worker::Workspace::new().unwrap();let event=space.0.join("event");fs::create_dir(&event).unwrap();
    let source=event.join("shot.cr3");fs::write(&source,b"fixture").unwrap();
    manifest::save_lightbox_choice(&event.to_string_lossy(),"shot.cr3","cameraJpeg").unwrap();
    let renamed=space.0.join("renamed event");fs::rename(&event,&renamed).unwrap();
    let source=renamed.join("shot.cr3");assert_eq!(manifest::lightbox_choices(&renamed,&[source.clone()]).unwrap().len(),1);
    let other=renamed.join("shot{Like o}.cr3");fs::copy(&source,&other).unwrap();
    assert!(manifest::lightbox_choices(&renamed,&[source,other]).unwrap().is_empty());
}
