use super::*;

fn request(label: &str) -> Request {
    Request::new(format!(
        "snapshot-test-{label}-{}",
        NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    ))
    .unwrap()
}

#[test]
fn actual_vfr_timestamps_and_b_frame_packet_order_are_not_fps_math() {
    let frames = parse_points(b"key_frame=1|pts=7000|best_effort_timestamp=7000\nkey_frame=0|pts=7120|best_effort_timestamp=7120\nkey_frame=0|pts=7440|best_effort_timestamp=7440\n", false).unwrap();
    assert_eq!(
        frames.iter().map(|v| v.pts).collect::<Vec<_>>(),
        vec![7000, 7120, 7440]
    );
    let packets = parse_points(
        b"pts=7000|flags=K_\npts=7440|flags=__\npts=7120|flags=__\n",
        true,
    )
    .unwrap();
    assert_eq!(
        packets.iter().map(|v| v.pts).collect::<Vec<_>>(),
        vec![7000, 7120, 7440]
    );
    assert!(packets[0].key);
    assert!(!packets[1].key);
}

#[test]
fn broken_timestamps_fail_closed() {
    for content in [
        "key_frame=1|pts=N/A",
        "key_frame=1|pts=10\nkey_frame=0|pts=10",
        "key_frame=1|pts=20\nkey_frame=0|pts=10",
    ] {
        assert!(parse_points(content.as_bytes(), false).is_err());
    }
    for value in ["", "0/1", "1/0", "-1/100", "1/2/3", "nan/100"] {
        assert!(parse_time_base(value).is_err());
    }
    assert_eq!(parse_time_base("1/90000").unwrap(), (1, 90000));
}

#[test]
fn cancelled_before_start_and_queued_requests_stay_cancelled() {
    let id = format!(
        "snapshot-before-{}",
        NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    );
    snapshot_cancel(id.clone()).unwrap();
    assert!(Request::new(id)
        .unwrap()
        .check()
        .unwrap_err()
        .contains("cancelled"));
    let pending = request("queue");
    let _hold = WORKER.lock().unwrap();
    pending.cancelled.store(true, Ordering::Relaxed);
    assert!(pending.worker().unwrap_err().contains("cancelled"));
    assert!(valid_request_id("../../file").is_err());
}

#[test]
fn local_inputs_and_session_kind_are_guarded() {
    assert!(local_path("https://example.com/video.mp4").is_err());
    assert!(local_path("relative.mp4").is_err());
    assert!(local_path("file:\0.mp4").is_err());
    assert!(
        valid_session(r#"{"version":1,"kind":"video-studio","sources":[],"selections":[]}"#)
            .is_err()
    );
    assert!(valid_session(
        r#"{"version":1,"kind":"photogogo-video-snapshots","sources":[],"selections":[]}"#
    )
    .is_ok());
    assert!(valid_session(&"x".repeat(SESSION_BYTES + 1)).is_err());
}

#[test]
fn showinfo_timestamp_validation_and_png_boundaries() {
    assert_eq!(decoded_pts(b"[Parsed_showinfo_1] n: 0 pts: 7000 pts_time:7\n[Parsed_showinfo_1] n: 1 pts: 7120 pts_time:7.12\n").unwrap(), vec![7000, 7120]);
    assert!(decoded_pts(b"[Parsed_showinfo_1] n: 0 pts: N/A pts_time:N/A\n").is_err());
    assert!(png_frames(b"not an image").is_err());
    assert!(png_frames(PNG_SIGNATURE).is_err());
}

fn media_fixture_dir() -> PathBuf {
    let root = std::env::var_os("PHOTOGOGO_STUDIO_TEST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../test-output"));
    let path = root.join(format!(
        "snapshots-exact-{}-{}",
        std::process::id(),
        NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&path).unwrap();
    fs::canonicalize(path).unwrap()
}
fn media(args: &[&str], request: &Request) -> ToolOutput {
    run_tool(
        false,
        &args.iter().map(|v| v.to_string()).collect::<Vec<_>>(),
        request,
        32 * 1024 * 1024,
        Duration::from_secs(30),
    )
    .unwrap()
}
fn compare_reference(clip: &IndexedClip, index: usize, request: &Request) {
    let extracted = extract(clip, index, 1, false, request).unwrap().remove(0);
    let path = clip.path.to_string_lossy();
    let filter = format!("select='eq(n,{index})',scale=w='ceil(max(iw,iw*sar))':h='ceil(max(ih,ih/sar))',setsar=1,format=rgb24");
    let expected = media(
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            &path,
            "-an",
            "-vf",
            &filter,
            "-frames:v",
            "1",
            "-fps_mode",
            "passthrough",
            "-threads",
            "2",
            "-c:v",
            "png",
            "-f",
            "image2pipe",
            "pipe:1",
        ],
        request,
    );
    let actual = image::load_from_memory(&extracted).unwrap().to_rgb8();
    let reference = image::load_from_memory(&expected.stdout).unwrap().to_rgb8();
    assert_eq!(actual.dimensions(), (clip.info.width, clip.info.height));
    assert_eq!(
        actual, reference,
        "Frame {index} must equal sequential decoder reference pixels"
    );
}

#[test]
#[ignore = "Bounded real FFmpeg extraction; generates only synthetic local fixtures"]
fn snapshots_exact_media_smoke() {
    let req = request("media");
    let _worker = req.worker().unwrap();
    let dir = media_fixture_dir();
    let cfr = dir.join("cfr-bframes.mp4");
    media(
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=128x72:rate=12:duration=3",
            "-c:v",
            "libx264",
            "-g",
            "12",
            "-bf",
            "3",
            "-pix_fmt",
            "yuv420p",
            "-metadata",
            "creation_time=2026-09-30T12:30:00Z",
            &cfr.to_string_lossy(),
        ],
        &req,
    );
    let info = open_impl(cfr.to_string_lossy().into_owned(), &req).unwrap();
    let clip = get_clip(&info.id).unwrap();
    assert_eq!(clip.points.len(), 36);
    assert_eq!(
        info.suggested_start.as_deref(),
        Some("2026-09-30T12:30:00+00:00")
    );
    for index in [0, 1, 11, 12, 13, 35] {
        compare_reference(&clip, index, &req);
    }
    let frames = frames_impl(info.id.clone(), 10, 4, &req).unwrap();
    assert_eq!(
        frames.frames.iter().map(|v| v.index).collect::<Vec<_>>(),
        vec![10, 11, 12, 13]
    );
    assert_eq!(frames.frames[1].at_ms, info.frame_times_ms[11]);
    assert!(frames.frames[0].data.starts_with("data:image/jpeg;base64,"));
    assert!(frames_impl(info.id.clone(), 35, 2, &req).is_err());

    let vfr = dir.join("vfr-nonzero.mp4");
    media(
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=128x72:rate=12:duration=3",
            "-vf",
            "select='not(mod(n,3))+not(mod(n,5))',setpts=PTS+7/TB",
            "-fps_mode",
            "vfr",
            "-copyts",
            "-c:v",
            "libx264",
            "-g",
            "6",
            "-bf",
            "2",
            "-avoid_negative_ts",
            "disabled",
            &vfr.to_string_lossy(),
        ],
        &req,
    );
    let vfr_info = open_impl(vfr.to_string_lossy().into_owned(), &req).unwrap();
    let vfr_clip = get_clip(&vfr_info.id).unwrap();
    assert!(vfr_clip.points[0].pts > 0);
    let gaps: Vec<_> = vfr_info
        .frame_times_ms
        .windows(2)
        .map(|v| (v[1] - v[0]).round() as i64)
        .collect();
    assert!(
        gaps.windows(2).any(|v| v[0] != v[1]),
        "Fixture must be genuinely variable-rate"
    );
    assert_eq!(vfr_info.frame_times_ms[0], 0.0);
    for index in [0, 1, 5, vfr_clip.points.len() - 1] {
        compare_reference(&vfr_clip, index, &req);
    }

    let anamorphic = dir.join("display-sar.mp4");
    media(
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=128x72:rate=10:duration=1",
            "-vf",
            "setsar=3/2",
            "-c:v",
            "libx264",
            "-g",
            "5",
            &anamorphic.to_string_lossy(),
        ],
        &req,
    );
    let sar_info = open_impl(anamorphic.to_string_lossy().into_owned(), &req).unwrap();
    assert_eq!((sar_info.width, sar_info.height), (192, 72));
    compare_reference(&get_clip(&sar_info.id).unwrap(), 4, &req);
    let rotated = dir.join("display-rotated.mp4");
    // Recent FFmpeg ignores the legacy rotate metadata assignment on stream
    // copy. Set real display-matrix side data on the input instead.
    media(
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-display_rotation:v:0",
            "90",
            "-i",
            &anamorphic.to_string_lossy(),
            "-c",
            "copy",
            &rotated.to_string_lossy(),
        ],
        &req,
    );
    let rotated_info = open_impl(rotated.to_string_lossy().into_owned(), &req).unwrap();
    assert_eq!((rotated_info.width, rotated_info.height), (72, 192));
    compare_reference(&get_clip(&rotated_info.id).unwrap(), 4, &req);

    let hdr = dir.join("hdr.mp4");
    // Stamp the decoded frame transfer before encoding, rather than relying
    // on an output codec option that stream-copy does not write into the VUI.
    media(
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            &cfr.to_string_lossy(),
            "-vf",
            "setparams=color_trc=smpte2084",
            "-c:v",
            "libx264",
            "-threads",
            "2",
            "-preset",
            "ultrafast",
            &hdr.to_string_lossy(),
        ],
        &req,
    );
    assert!(open_impl(hdr.to_string_lossy().into_owned(), &req)
        .unwrap_err()
        .contains("HDR"));

    // The sixth selected frame is original input frame 10, at 10/12 seconds
    // after the first displayed frame (not 5/12 and not its absolute 7.833 PTS).
    // Exercise the actual command boundary, including its worker and elapsed-time
    // wiring, then read back the files the user receives.
    let export_dir = dir.join("exported");
    fs::create_dir(&export_dir).unwrap();
    drop(_worker);
    let exported = tauri::async_runtime::block_on(snapshot_export(
        vfr_info.id.clone(),
        5,
        "2026-09-30T23:59:59.500+10:00".into(),
        "Synthetic Rider".into(),
        export_dir.to_string_lossy().into_owned(),
        photo::PhotoRecipe::default(),
        format!(
            "snapshot-export-smoke-{}",
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ),
    ))
    .unwrap();
    let _worker = req.worker().unwrap();
    assert_eq!(exported.captured_at, "2026-10-01T00:00:00.333333000+10:00");
    assert_eq!((exported.width, exported.height), (128, 72));
    assert!(exported.enhanced_path.is_none());
    assert!(exported
        .path
        .ends_with("20261001_000000_333_Synthetic_Rider.jpg"));
    let master = fs::read(&exported.path).unwrap();
    let master_pixels = image::load_from_memory(&master).unwrap().to_rgb8();
    assert_eq!(master_pixels.dimensions(), (128, 72));
    let metadata = exif::Reader::new()
        .read_from_container(&mut std::io::Cursor::new(&master))
        .unwrap();
    let ascii = |tag| match &metadata.get_field(tag, exif::In::PRIMARY).unwrap().value {
        exif::Value::Ascii(parts) => String::from_utf8(parts[0].clone()).unwrap(),
        other => panic!("Expected ASCII EXIF value, found {other:?}"),
    };
    assert_eq!(ascii(exif::Tag::DateTimeOriginal), "2026:10:01 00:00:00");
    assert_eq!(ascii(exif::Tag::SubSecTimeOriginal), "333333000");
    assert_eq!(ascii(exif::Tag::OffsetTimeOriginal), "+10:00");
    let receipt: serde_json::Value =
        serde_json::from_slice(&fs::read(&exported.provenance_path).unwrap()).unwrap();
    assert_eq!(receipt["state"], "complete");
    assert_eq!(receipt["capturedAt"], exported.captured_at);
    assert_eq!(receipt["elapsedSourceMicroseconds"], 833_333);
    assert_eq!(receipt["source"]["sourceFrameIndex"], 5);
    assert_eq!(receipt["source"]["sourcePts"], vfr_clip.points[5].pts);
    assert_eq!(
        receipt["source"]["timestampOriginPts"],
        vfr_clip.points[0].pts
    );
    assert_eq!(
        receipt["source"]["sourceTimeBase"],
        format!("{}/{}", vfr_clip.time_num, vfr_clip.time_den)
    );
    assert_eq!(receipt["source"]["sourceIdentity"], vfr_info.identity);
    assert_eq!(receipt["source"]["sourcePath"], vfr_info.path);

    // Independently decode by presentation frame number from the beginning,
    // then apply the documented quality-96 master JPEG encoding. Metadata must
    // not change pixels, and no thumbnail or adjacent frame may be substituted.
    let reference_png = media(
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            &vfr.to_string_lossy(),
            "-an",
            "-vf",
            "select='eq(n,5)',format=rgb24",
            "-frames:v",
            "1",
            "-fps_mode",
            "passthrough",
            "-threads",
            "2",
            "-c:v",
            "png",
            "-f",
            "image2pipe",
            "pipe:1",
        ],
        &req,
    );
    let reference_pixels = image::load_from_memory(&reference_png.stdout)
        .unwrap()
        .to_rgb8();
    let mut reference_jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut reference_jpeg, 96)
        .encode(
            reference_pixels.as_raw(),
            reference_pixels.width(),
            reference_pixels.height(),
            image::ExtendedColorType::Rgb8,
        )
        .unwrap();
    assert_eq!(
        master_pixels,
        image::load_from_memory(&reference_jpeg).unwrap().to_rgb8(),
        "The exported master must contain the selected full-resolution source frame"
    );

    // A live indexed original is protected against even a same-size edit that
    // tries to preserve timestamps; removing the clip releases its source lock.
    #[cfg(windows)]
    assert!(OpenOptions::new().write(true).open(&cfr).is_err());
    let old_identity = info.identity;
    drop(clip);
    snapshot_forget(vec![info.id, vfr_info.id, sar_info.id, rotated_info.id]).unwrap();
    OpenOptions::new()
        .append(true)
        .open(&cfr)
        .unwrap()
        .write_all(b"changed-fixture")
        .unwrap();
    let changed = open_impl(cfr.to_string_lossy().into_owned(), &req).unwrap();
    assert_ne!(changed.identity, old_identity);
    snapshot_forget(vec![changed.id]).unwrap();
    let report = json!({"ok":true,"checks":["CFR B frames","VFR nonzero PTS","keyframe-boundary seeking","sequential pixel equivalence","batched exact frames","SAR","rotation","HDR rejection","actual export command EXIF/provenance/pixels","source write lock","restored content identity"]});
    fs::write(
        dir.join("report.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("Snapshot exact-frame media evidence: {}", dir.display());
}

#[test]
#[ignore = "Bounded real FFmpeg cancellation; generated video only"]
fn snapshots_cancel_media_smoke() {
    let req = request("cancel-child");
    let _worker = req.worker().unwrap();
    let flag = req.cancelled.clone();
    let canceller = thread::spawn(move || {
        thread::sleep(Duration::from_millis(200));
        flag.store(true, Ordering::Relaxed);
    });
    let start = Instant::now();
    let result = run_tool(
        false,
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-re",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=32x32:rate=30",
            "-f",
            "null",
            "-",
        ]
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>(),
        &req,
        4096,
        Duration::from_secs(15),
    );
    canceller.join().unwrap();
    assert!(result.err().unwrap().contains("cancelled"));
    assert!(start.elapsed() < Duration::from_secs(5));
}

#[test]
fn snapshot_session_save_as_preserves_previous_files() {
    let dir = std::env::temp_dir().join(format!(
        "photogogo-snapshot-session-{}-{}",
        std::process::id(),
        NEXT_FILE.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join("session.json");
    let contents =
        r#"{"kind":"photogogo-video-snapshots","version":1,"sources":[],"selections":[]}"#;
    snapshot_save_session(path.to_string_lossy().into_owned(), contents.into()).unwrap();
    assert_eq!(
        snapshot_load_session(path.to_string_lossy().into_owned()).unwrap(),
        contents
    );
    assert!(
        snapshot_save_session(path.to_string_lossy().into_owned(), contents.into())
            .unwrap_err()
            .contains("already exists")
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), contents);
    fs::remove_file(&path).unwrap();
    fs::remove_dir(&dir).unwrap();
}

#[test]
#[ignore = "Bounded synthetic 2-second 4K50 navigation timings; not a user-footage speed claim"]
fn snapshots_4k50_navigation_measurement() {
    let req = request("4k50");
    let _worker = req.worker().unwrap();
    let dir = media_fixture_dir();
    let path = dir.join("synthetic-4k50.mp4");
    media(
        &[
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=3840x2160:rate=50:duration=2",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-threads",
            "2",
            "-g",
            "50",
            "-bf",
            "2",
            "-pix_fmt",
            "yuv420p",
            &path.to_string_lossy(),
        ],
        &req,
    );
    let started = Instant::now();
    let info = open_impl(path.to_string_lossy().into_owned(), &req).unwrap();
    let open_ms = started.elapsed().as_millis();
    assert_eq!(info.frame_times_ms.len(), 100);
    let started = Instant::now();
    frames_impl(info.id.clone(), 49, 1, &req).unwrap();
    let cold_seek_ms = started.elapsed().as_millis();
    let started = Instant::now();
    frames_impl(info.id.clone(), 45, 12, &req).unwrap();
    let batch_ms = started.elapsed().as_millis();
    let started = Instant::now();
    frames_impl(info.id.clone(), 45, 12, &req).unwrap();
    let cache_hit_ms = started.elapsed().as_millis();
    let report = json!({"fixture":"synthetic 3840x2160 50fps 2seconds GOP50","indexMs":open_ms,"coldSeekMs":cold_seek_ms,"twelveFrameBatchMs":batch_ms,"cacheHitMs":cache_hit_ms,"notAUserFootageRealtimeClaim":true});
    fs::write(
        dir.join("timings.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
    println!("Snapshot 4K50 timings: {report}");

    // Browsing above deliberately uses reduced JPEGs. Export the same frame
    // through the real command and verify the on-disk master is not that preview.
    let export_dir = dir.join("exported");
    fs::create_dir(&export_dir).unwrap();
    let source_before = fs::read(&path).unwrap();
    drop(_worker);
    let exported = tauri::async_runtime::block_on(snapshot_export(
        info.id.clone(),
        49,
        "2026-09-30T12:30:00+10:00".into(),
        "Full Resolution".into(),
        export_dir.to_string_lossy().into_owned(),
        photo::PhotoRecipe::default(),
        format!(
            "snapshot-4k-export-{}",
            NEXT_FILE.fetch_add(1, Ordering::Relaxed)
        ),
    ))
    .unwrap();
    let master = image::open(&exported.path).unwrap().to_rgb8();
    assert_eq!(master.dimensions(), (3840, 2160));
    assert_eq!((exported.width, exported.height), master.dimensions());
    assert_eq!(exported.captured_at, "2026-09-30T12:30:00.980000000+10:00");
    assert!(exported
        .path
        .ends_with("20260930_123000_980_Full_Resolution.jpg"));
    assert!(exported.enhanced_path.is_none());
    assert_eq!(
        source_before,
        fs::read(&path).unwrap(),
        "Export must not change the source video"
    );
    let provenance: Value =
        serde_json::from_slice(&fs::read(&exported.provenance_path).unwrap()).unwrap();
    assert_eq!(provenance["source"]["sourceFrameIndex"], 49);
    println!(
        "Snapshot full-resolution export: {} ({} x {})",
        exported.path, exported.width, exported.height
    );
    snapshot_forget(vec![info.id]).unwrap();
}
