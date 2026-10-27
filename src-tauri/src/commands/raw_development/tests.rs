use super::*;
use std::fs;
#[test]
fn scope_is_bounded_and_selected_is_explicit() {
    let space = worker::Workspace::new().unwrap();
    let dir = &space.0;
    for name in [
        "one.CR3",
        "two{Like oo}.cr3",
        "three{trash}.cr3",
        "not-raw.jpg",
    ] {
        fs::write(dir.join(name), b"fixture").unwrap();
    }
    let mut req = Request {
        staging_dir: dir.to_string_lossy().into(),
        scope_dir: dir.to_string_lossy().into(),
        scope_mode: ProcessScopeMode::FolderOnly,
        selection: "all".into(),
        min_rating: 0,
        selected_paths: vec![],
        recipe: RawRecipe::default(),
        use_photo_overrides: false,
    };
    assert_eq!(req.files().unwrap().len(), 3);
    req.selection = "nonTrash".into();
    assert_eq!(req.files().unwrap().len(), 2);
    req.selection = "minRating".into();
    req.min_rating = 2;
    assert_eq!(req.files().unwrap().len(), 1);
    req.selection = "selected".into();
    assert!(req.files().unwrap().is_empty());
    req.selected_paths = vec![dir.join("one.CR3").to_string_lossy().into()];
    assert_eq!(req.files().unwrap().len(), 1);
    assert!(safe_source(&req.staging_dir, "../outside.cr3").is_err());
}
#[test]
fn publication_preserves_sources_collisions_and_old_lineage() {
    let space = worker::Workspace::new().unwrap();
    let raw = space.0.join("master.cr3");
    fs::write(&raw, b"original master bytes").unwrap();
    let before = worker::hash(&raw).unwrap();
    let scratch = space.0.join("result.jpg");
    image::RgbImage::new(512, 512).save(&scratch).unwrap();
    let r = RawRecipe::default();
    let first = worker::publish(
        &raw,
        &[(scratch.clone(), "developed".into())],
        &r,
        &before,
        &"a".repeat(64),
    )
    .unwrap();
    assert_eq!(worker::hash(&raw).unwrap(), before);
    assert_eq!(first.len(), 1);
    assert!(worker::publish(
        &raw,
        &[(scratch.clone(), "developed".into())],
        &r,
        &before,
        &"a".repeat(64)
    )
    .is_ok());
    worker::publish(
        &raw,
        &[(scratch.clone(), "developed".into())],
        &r,
        &before,
        &"b".repeat(64),
    )
    .unwrap();
    let m = manifest::load(&space.0).unwrap();
    let rec = m.records.values().next().unwrap();
    assert_eq!(rec.outputs.len(), 2);
    assert_eq!(rec.outputs.iter().filter(|o| o.active).count(), 1);
    let collision = space
        .0
        .join(format!("master_raw-developed-{}.jpg", "c".repeat(12)));
    fs::write(&collision, b"user photo").unwrap();
    assert!(worker::publish(
        &raw,
        &[(scratch, "developed".into())],
        &r,
        &before,
        &"c".repeat(64)
    )
    .is_err());
    assert_eq!(fs::read(collision).unwrap(), b"user photo");
    fs::rename(&raw, space.0.join("master{Like o}.cr3")).unwrap();
    let files = fs::read_dir(&space.0)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .collect::<Vec<_>>();
    assert_eq!(manifest::associations(&space.0, &files).unwrap().len(), 2);
}
#[test]
fn missing_or_thumbnail_dimensions_are_never_full_raw_export() {
    assert!(worker::expected_dimensions(&serde_json::json!({})).is_err());
    assert!(
        worker::expected_dimensions(&serde_json::json!({"ImageWidth":240,"ImageHeight":135}))
            .is_err()
    );
    assert_eq!(
        worker::expected_dimensions(
            &serde_json::json!({"ExifImageWidth":6000,"ExifImageHeight":4000,"Orientation":6})
        )
        .unwrap(),
        (4000, 6000)
    );
}
#[test]
fn publication_keeps_colour_bw_and_tiff_branches_independent() {
    let space = worker::Workspace::new().unwrap();
    let raw = space.0.join("master.cr3");
    fs::write(&raw, b"master").unwrap();
    let hash = worker::hash(&raw).unwrap();
    let jpeg = space.0.join("result.jpg");
    image::RgbImage::new(512, 512).save(&jpeg).unwrap();
    let r = RawRecipe::default();
    worker::publish(
        &raw,
        &[(jpeg.clone(), "developed".into())],
        &r,
        &hash,
        &"a".repeat(64),
    )
    .unwrap();
    let mut bw = r.clone();
    bw.colour = false;
    bw.bw = true;
    worker::publish(
        &raw,
        &[(jpeg.clone(), "bw".into())],
        &bw,
        &hash,
        &"b".repeat(64),
    )
    .unwrap();
    worker::publish(
        &raw,
        &[(jpeg.clone(), "developed".into())],
        &r,
        &hash,
        &"c".repeat(64),
    )
    .unwrap();
    let tiff = space.0.join("result.tif");
    image::RgbImage::new(512, 512).save(&tiff).unwrap();
    let mut t = r.clone();
    t.output = "tiff16".into();
    worker::publish(
        &raw,
        &[(tiff, "developed".into())],
        &t,
        &hash,
        &"d".repeat(64),
    )
    .unwrap();
    let m = manifest::load(&space.0).unwrap();
    let outputs = &m.records.values().next().unwrap().outputs;
    assert_eq!(outputs.iter().filter(|o| o.active).count(), 3);
    assert!(
        !outputs
            .iter()
            .find(|o| o.recipe_hash == "a".repeat(64))
            .unwrap()
            .active
    );
    assert!(
        outputs
            .iter()
            .find(|o| o.recipe_hash == "b".repeat(64))
            .unwrap()
            .active
    );
    fs::write(&raw, b"explicitly changed master").unwrap();
    let changed = worker::hash(&raw).unwrap();
    worker::publish(
        &raw,
        &[(jpeg, "developed".into())],
        &r,
        &changed,
        &"e".repeat(64),
    )
    .unwrap();
    let m = manifest::load(&space.0).unwrap();
    assert_eq!(
        m.records
            .values()
            .next()
            .unwrap()
            .outputs
            .iter()
            .filter(|o| o.active)
            .count(),
        1
    );
}
#[test]
fn raw_lineage_survives_event_moves_and_blocks_individual_maintenance() {
    let space = worker::Workspace::new().unwrap();
    let event = space.0.join("event");
    fs::create_dir(&event).unwrap();
    let raw = event.join("master.cr3");
    fs::write(&raw, b"source").unwrap();
    manifest::edit(&raw, |r| {
        r.recipe = Some(RawRecipe::default());
        Ok(())
    })
    .unwrap();
    assert!(capture::guard_move(&raw, &event.join("other.cr3")).is_err());
    assert!(capture::guard_move(&raw, &space.0.join("master.cr3")).is_err());
    assert!(capture::preflight_reprocess(&[raw.clone()]).is_err());
    {
        let _lease = capture::guard_move(&raw, &event.join("master{Like o}.cr3")).unwrap();
        fs::rename(&raw, event.join("master{Like o}.cr3")).unwrap();
    }
    let moved = space.0.join("renamed-event");
    fs::rename(&event, &moved).unwrap();
    let renamed = moved.join("master{Like o}.cr3");
    assert!(manifest::override_for(&renamed).unwrap().is_some());
    let old = fs::read(moved.join(manifest::NAME)).unwrap();
    let hash = worker::hash(&renamed).unwrap();
    manifest::edit(&renamed, |r| {
        r.source_hash = hash.clone();
        Ok(())
    })
    .unwrap();
    let saved = fs::read(moved.join(manifest::NAME)).unwrap();
    fs::write(&renamed, b"changed while reuse checks ran").unwrap();
    assert!(manifest::confirm_reuse(&renamed, &hash).is_err());
    assert_eq!(fs::read(moved.join(manifest::NAME)).unwrap(), saved);
    assert!(!old.is_empty());
    fs::write(moved.join(manifest::NAME), b"broken").unwrap();
    assert!(capture::guard_move(&renamed, &moved.join("master{Like oo}.cr3")).is_err());
}
#[test]
fn usable_sensor_margin_is_not_a_resize_or_thumbnail() {
    let m = serde_json::json!({"ExifImageWidth":6000,"ExifImageHeight":4000,"SensorWidth":6188,"SensorHeight":4120,"Orientation":1});
    assert!(worker::validate_full_dimensions(&m, 6014, 4016).is_ok());
    assert!(worker::validate_full_dimensions(&m, 1600, 1067).is_err());
    assert!(worker::validate_full_dimensions(&m, 7000, 5000).is_err());
    assert!(worker::validate_full_dimensions(
        &serde_json::json!({"ExifImageWidth":6000,"ExifImageHeight":4000}),
        6014,
        4016
    )
    .is_err());
}
#[test]
fn raw_metadata_is_bounded_and_shared_readers_fail_closed() {
    let space = worker::Workspace::new().unwrap();
    let raw = space.0.join("master.cr3");
    fs::write(&raw, b"master").unwrap();
    manifest::edit(&raw, |r| {
        r.recipe = Some(RawRecipe::default());
        Ok(())
    })
    .unwrap();
    let old = fs::read(space.0.join(manifest::NAME)).unwrap();
    assert!(manifest::edit(&raw, |r| {
        r.source_hash = "x".repeat(16 * 1024 * 1024);
        Ok(())
    })
    .is_err());
    assert_eq!(fs::read(space.0.join(manifest::NAME)).unwrap(), old);
    let _lease = worker::FolderLease::acquire(&space.0).unwrap();
    assert!(manifest::associations(&space.0, &[raw.clone()]).is_err());
    drop(_lease);
    fs::write(space.0.join(manifest::NAME), b"broken").unwrap();
    assert!(manifest::associations(&space.0, &[raw]).is_err());
    assert!(manifest::exclude_owned_jpegs(vec![space.0.join("candidate.jpg")]).is_err());
}
#[test]
fn preview_contract_deserializes_actual_frontend_payload() {
    let v = serde_json::json!({"stagingDir":"C:/stage","scopeDir":"C:/stage","scopeMode":"folderOnly","selection":"all","minRating":0,"recipe":RawRecipe::default(),"path":"C:/stage/test.cr3","fullResolution":true});
    let r: PreviewRequest = serde_json::from_value(v).unwrap();
    assert!(r.full_resolution);
}
#[test]
#[ignore = "Requires explicitly supplied original CR3; read-only source, bounded local RAW decodes"]
fn raw_real_file_quality_smoke() {
    let path = PathBuf::from(
        std::env::var_os("PHOTOGOGO_RAW_TEST_SOURCE").expect("Set PHOTOGOGO_RAW_TEST_SOURCE"),
    );
    let evidence = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../test-output/raw-development/quality")
        .join(path.file_stem().unwrap());
    fs::create_dir_all(&evidence).unwrap();
    let before = worker::hash(&path).unwrap();
    let meta = worker::metadata(&path).unwrap();
    worker::expected_dimensions(&meta).unwrap();
    let start = Instant::now();
    let preview = worker::camera_preview(&path).unwrap();
    preview
        .0
        .thumbnail(1600, 1600)
        .save(evidence.join("camera.jpg"))
        .unwrap();
    let preview_ms = start.elapsed().as_millis();
    fs::write(
        evidence.join("natural.pp3"),
        RawRecipe::default().pp3(false, false).unwrap(),
    )
    .unwrap();
    let mut checks = vec![];
    for kind in ["natural", "neutral", "bw", "exposure"] {
        let space = worker::Workspace::new().unwrap();
        let mut r = RawRecipe::default();
        if kind == "neutral" {
            r.highlights = 0.;
            r.curve_strength = 0.;
            r.sharpening = 0.;
            r.chroma_noise = 0.;
        }
        if kind == "exposure" {
            r.exposure = 1.;
        }
        let start = Instant::now();
        let out = worker::execute(&path, &r, kind == "bw", false, &space, None).unwrap();
        worker::final_metadata(&path, &out, true).unwrap();
        let m = worker::metadata(&out).unwrap();
        worker::validate_full_dimensions(
            &meta,
            m["ImageWidth"].as_u64().unwrap(),
            m["ImageHeight"].as_u64().unwrap(),
        )
        .unwrap();
        assert_eq!(m["Orientation"], 1);
        assert!(m["ProfileDescription"].is_string());
        assert_eq!(m["DateTimeOriginal"], meta["DateTimeOriginal"]);
        let image = super::super::photo_process::load_oriented(&out).unwrap();
        image
            .thumbnail(1600, 1600)
            .save(evidence.join(format!("{kind}.jpg")))
            .unwrap();
        image
            .crop_imm(image.width() / 3, image.height() / 3, 1000, 1000)
            .save(evidence.join(format!("{kind}-detail.png")))
            .unwrap();
        if kind == "natural" {
            let mut corners = image::RgbaImage::new(1024, 1024);
            for (x, y, dx, dy) in [
                (0, 0, 0, 0),
                (image.width() - 512, 0, 512, 0),
                (0, image.height() - 512, 0, 512),
                (image.width() - 512, image.height() - 512, 512, 512),
            ] {
                image::imageops::overlay(
                    &mut corners,
                    &image.crop_imm(x, y, 512, 512).to_rgba8(),
                    dx,
                    dy,
                );
            }
            corners.save(evidence.join("natural-corners.png")).unwrap();
        }
        checks.push(serde_json::json!({"kind":kind,"ms":start.elapsed().as_millis(),"hash":worker::hash(&out).unwrap(),"metadata":m}));
    }
    assert_ne!(checks[0]["hash"], checks[3]["hash"]);
    assert_ne!(checks[0]["hash"], checks[2]["hash"]);
    assert_eq!(worker::hash(&path).unwrap(), before);
    fs::write(evidence.join("report.json"),serde_json::to_vec_pretty(&serde_json::json!({"sourceHashUnchanged":true,"sourceHash":before,"sourceMetadata":meta,"previewMs":preview_ms,"previewDimensions":[preview.1,preview.2],"checks":checks})).unwrap()).unwrap();
}
#[test]
#[ignore = "Requires explicitly supplied CR3; isolated TIFF, portrait metadata fixture and repeatability checks"]
fn raw_real_file_export_edges() {
    let source = PathBuf::from(
        std::env::var_os("PHOTOGOGO_RAW_TEST_SOURCE").expect("Set PHOTOGOGO_RAW_TEST_SOURCE"),
    );
    let original_hash = worker::hash(&source).unwrap();
    let meta = worker::source_metadata(&source).unwrap();
    let r = RawRecipe::default();
    let mut hashes = vec![];
    for _ in 0..2 {
        let w = worker::Workspace::new().unwrap();
        let out = worker::execute(&source, &r, false, false, &w, None).unwrap();
        worker::final_metadata(&source, &out, true).unwrap();
        hashes.push(worker::hash(&out).unwrap())
    }
    assert_eq!(
        hashes[0], hashes[1],
        "Identical recipes must produce reusable unchanged bytes"
    );
    let t = worker::Workspace::new().unwrap();
    let mut r = RawRecipe::default();
    r.output = "tiff16".into();
    r.keep_gps = false;
    let out = worker::execute(&source, &r, false, false, &t, None).unwrap();
    worker::final_metadata(&source, &out, false).unwrap();
    let m = worker::metadata(&out).unwrap();
    assert_eq!(m["FileType"], "TIFF");
    assert!(m["BitsPerSample"].to_string().contains("16"));
    worker::validate_full_dimensions(
        &meta,
        m["ImageWidth"].as_u64().unwrap(),
        m["ImageHeight"].as_u64().unwrap(),
    )
    .unwrap();
    let portrait = worker::Workspace::new().unwrap();
    let copy = portrait.0.join("portrait.cr3");
    fs::copy(&source, &copy).unwrap();
    let (tool, _) = super::super::metadata_tools::resolve("");
    super::super::metadata_tools::run(
        &tool,
        &[
            "-overwrite_original".into(),
            "-Orientation#=6".into(),
            copy.as_os_str().to_owned(),
        ],
    )
    .unwrap();
    let pm = worker::source_metadata(&copy).unwrap();
    let r = RawRecipe::default();
    let output = worker::execute(&copy, &r, false, false, &portrait, None).unwrap();
    worker::final_metadata(&copy, &output, true).unwrap();
    let om = worker::metadata(&output).unwrap();
    let (w, h) = (
        om["ImageWidth"].as_u64().unwrap(),
        om["ImageHeight"].as_u64().unwrap(),
    );
    assert!(h > w);
    worker::validate_full_dimensions(&pm, w, h).unwrap();
    assert_eq!(om["Orientation"], 1);
    assert_eq!(worker::hash(&source).unwrap(), original_hash);
    let evidence = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../test-output/raw-development/quality/export-edges.json");
    fs::write(evidence,serde_json::to_vec_pretty(&serde_json::json!({"sourceHashUnchanged":true,"deterministicRecipe":true,"repeatHash":hashes[0],"tiff16":m,"portraitMetadataFixture":om})).unwrap()).unwrap();
}
#[test]
#[ignore = "Requires explicitly supplied CR3; isolated library/pair/reuse and active cancellation integration"]
fn raw_real_file_library_and_cancel() {
    use crate::commands::{google_photos::catalogue, metadata_tools};
    let source = PathBuf::from(std::env::var_os("PHOTOGOGO_RAW_TEST_SOURCE").unwrap());
    let before = worker::hash(&source).unwrap();
    let space = worker::Workspace::new().unwrap();
    let raw = space.0.join("different-import-name.cr3");
    fs::copy(&source, &raw).unwrap();
    let jpeg = space.0.join("camera-name.jpg");
    worker::camera_preview(&raw).unwrap().0.save(&jpeg).unwrap();
    let (tool, _) = metadata_tools::resolve("");
    metadata_tools::run(
        &tool,
        &[
            "-overwrite_original".into(),
            "-TagsFromFile".into(),
            raw.as_os_str().to_owned(),
            "-Model".into(),
            "-DateTimeOriginal".into(),
            "-SubSecTimeOriginal".into(),
            "-SerialNumber".into(),
            jpeg.as_os_str().to_owned(),
        ],
    )
    .unwrap();
    assert_eq!(
        capture::pairs(&[raw.clone(), jpeg.clone()], &HashSet::new()),
        vec![(0, 1)]
    );
    let mut r = RawRecipe::default();
    r.auto_exposure = true;
    let decode = worker::Workspace::new().unwrap();
    let out = worker::execute(&raw, &r, false, false, &decode, None).unwrap();
    worker::final_metadata(&raw, &out, false).unwrap();
    let h = worker::hash(&raw).unwrap();
    let recipe_hash = "d".repeat(64);
    worker::publish(&raw, &[(out, "developed".into())], &r, &h, &recipe_hash).unwrap();
    assert_eq!(manifest::reusable(&raw, &recipe_hash, &r).unwrap(), Some(1));
    manifest::confirm_reuse(&raw, &h).unwrap();
    let tagged = space.0.join("different-import-name{Like oo}.cr3");
    {
        let _lease = capture::guard_move(&raw, &tagged).unwrap();
        fs::rename(&raw, &tagged).unwrap();
    }
    let catalogue = catalogue::scan(&space.0).unwrap();
    let camera = catalogue
        .assets
        .iter()
        .find(|a| a.relative_path == "camera-name.jpg")
        .unwrap();
    let master = catalogue
        .assets
        .iter()
        .find(|a| a.relative_path.ends_with(".cr3"))
        .unwrap();
    assert_eq!(camera.family_id, master.family_id);
    assert_eq!(camera.stars, 2);
    assert!(!camera.selected);
    assert_eq!(catalogue.assets.len(), 3);
    let id = "raw-real-cancel-fixture";
    let job:process::ProcessJob=serde_json::from_value(serde_json::json!({"id":id,"task":"rawDevelop","stagingDir":"fixture","scopeDir":"fixture","scopeMode":"folderOnly","status":"running","createdAt":"fixture","total":1,"done":0,"processed":0,"resultCount":0,"currentFile":"fixture","errors":[],"logs":[],"statusLine":"","pauseRequested":false,"abortRequested":false})).unwrap();
    process::process_jobs_store()
        .lock()
        .unwrap()
        .insert(id.into(), job);
    let abort = std::thread::spawn(move || {
        for _ in 0..600 {
            let mut jobs = process::process_jobs_store().lock().unwrap();
            let j = jobs.get_mut(id).unwrap();
            if j.logs.iter().any(|s| s.contains("RAW decoder started")) {
                j.abort_requested = true;
                return true;
            }
            drop(jobs);
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        false
    });
    let cancelled = worker::Workspace::new().unwrap();
    let started = Instant::now();
    let result = worker::execute(
        &tagged,
        &RawRecipe::default(),
        false,
        false,
        &cancelled,
        Some(id),
    );
    assert!(
        abort.join().unwrap(),
        "Abort must reach an actually started decoder"
    );
    assert!(result.is_err());
    assert!(started.elapsed().as_secs() < 20);
    assert!(!cancelled.0.join("colour.jpg").exists());
    process::process_jobs_store().lock().unwrap().remove(id);
    assert_eq!(worker::hash(&source).unwrap(), before);
    let evidence = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../test-output/raw-development/library-cancel.json");
    fs::write(evidence,serde_json::to_vec_pretty(&serde_json::json!({"metadataPairDifferentNames":true,"canonicalRating":2,"exactSelectionPreserved":true,"reusedOutputs":1,"sourceHashUnchanged":true,"activeDecoderAbortMs":started.elapsed().as_millis(),"autoLevelsDecoded":true})).unwrap()).unwrap();
}
