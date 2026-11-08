use super::*;
fn fixture() -> Session {
    let client = "controller-test-owner".to_string();
    let surface = Surface {
        client: client.clone(),
        revision: 7,
        title: "Review".into(),
        keys: vec![
            Key {
                label: "Select".into(),
                image_data: String::new(),
                enabled: true,
            };
            6
        ],
        dials: vec![
            Label {
                label: "Browse".into()
            };
            3
        ],
        side_buttons: vec![
            Label {
                label: "Mode".into()
            };
            3
        ],
    };
    Session {
        client,
        status: Status {
            enabled: true,
            phase: "connected".into(),
            message: String::new(),
            device: None,
            vendor_stopped: false,
            last_input: None,
            error: None,
            brightness: 70,
            session: Some("device-session".into()),
            client: Some("controller-test-owner".into()),
        },
        generation: 2,
        frame: Some(Frame {
            surface,
            images: fallback(),
            received: Instant::now(),
        }),
        presented: Some(7),
        session: "device-session".into(),
        pending: None,
        drain: false,
        serial: 0,
    }
}
fn key(s: &mut Session) -> Option<Input> {
    admit(s, "key", 0, 1, 2, "controller-test-owner", Some(7), false)
}
#[test]
fn hardware_jpeg_rotates_clockwise_to_compensate_the_counterclockwise_display() {
    // Hand-derived clockwise mapping: BL->TL, TL->TR, TR->BR, BR->BL.
    let pixels = RgbImage::from_fn(60, 60, |x, y| match (x < 30, y < 30) {
        (true, true) => Rgb([255, 0, 0]),
        (false, true) => Rgb([0, 255, 0]),
        (false, false) => Rgb([0, 0, 255]),
        (true, false) => Rgb([255, 255, 255]),
    });
    let upright = DynamicImage::ImageRgb8(pixels);
    let bytes = ajazz_sdk::convert_image(Kind::Akp03E, hardware_artwork(upright.clone())).unwrap();
    let sent = image::load_from_memory(&bytes).unwrap().to_rgb8();
    for (x, y, want) in [
        (12, 12, [255, 255, 255]),
        (47, 12, [255, 0, 0]),
        (47, 47, [0, 255, 0]),
        (12, 47, [0, 0, 255]),
    ] {
        let got = sent.get_pixel(x, y).0;
        assert!(
            got.iter()
                .zip(want)
                .all(|(a, b)| (*a as i16 - b as i16).abs() < 25),
            "Encoded hardware corner ({x},{y}) has {got:?}, expected {want:?}"
        );
    }
    assert_eq!(
        upright.to_rgb8().get_pixel(12, 12).0,
        [255, 0, 0],
        "The upright preview input must not be altered"
    );
}
#[test]
fn fresh_preferences_start_the_display_at_full_brightness() {
    let absent = std::env::temp_dir().join(format!(
        "photogogo-display-absent-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    ));
    assert_eq!(load_config(&absent).unwrap().brightness, 100);
    assert!(
        !absent.exists(),
        "Reading defaults does not write a preference file"
    );
}
#[test]
fn previous_default_brightness_upgrades_without_enabling_a_released_controller() {
    let root = std::env::temp_dir().join(format!(
        "photogogo-display-settings-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    ));
    fs::create_dir(&root).unwrap();
    let path = root.join("preferences.json");
    let old = br#"{"enabled":false,"brightness":70}"#;
    fs::write(&path, old).unwrap();
    let upgraded = load_config(&path).unwrap();
    assert_eq!(upgraded.brightness, 100);
    assert!(!upgraded.enabled);
    assert_eq!(
        fs::read(&path).unwrap(),
        old,
        "Reading migration must not rewrite preferences"
    );
    for (data, wanted) in [
        (br#"{"enabled":false,"brightness":45}"#.as_slice(), 45),
        (
            br#"{"enabled":false,"brightness":70,"brightness_profile":1}"#.as_slice(),
            70,
        ),
    ] {
        fs::write(&path, data).unwrap();
        let saved = load_config(&path).unwrap();
        assert_eq!(saved.brightness, wanted);
        assert!(!saved.enabled);
    }
    fs::remove_file(path).unwrap();
    fs::remove_dir(root).unwrap();
}
#[test]
fn physical_button_and_dial_release_reports_never_repeat_the_action() {
    for action in [
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x25, 0x30, 0x31, 0x33, 0x35, 0x34,
    ] {
        let mut report = vec![0u8; 512];
        report[0] = 1;
        report[9] = action;
        let mut total = 0;
        for state in [1, 0, 1, 0] {
            report[10] = state;
            total += inputs(ajazz_sdk::parse_akp03e_pressed_input(&report).unwrap()).len();
        }
        assert_eq!(
            total, 2,
            "Action {action:02X}: release must not toggle a photo or invoke a dial press again"
        );
    }
}
#[test]
fn physical_dial_twists_keep_their_direction_for_both_state_markers() {
    for (action, index, delta) in [
        (0x90, 0, -1),
        (0x91, 0, 1),
        (0x50, 1, -1),
        (0x51, 1, 1),
        (0x60, 2, -1),
        (0x61, 2, 1),
    ] {
        for state in [0, 1] {
            let mut report = vec![0u8; 512];
            report[0] = 1;
            report[9] = action;
            report[10] = state;
            assert_eq!(
                inputs(ajazz_sdk::parse_akp03e_pressed_input(&report).unwrap()),
                vec![("dial", index, delta)]
            );
        }
    }
}
#[test]
fn consumed_releases_do_not_end_draining_and_only_timeouts_are_empty() {
    for action in [0x01, 0x25, 0x33] {
        let mut report = vec![0u8; 512];
        report[0] = 1;
        report[9] = action;
        for state in [1, 0, 1, 0] {
            report[10] = state;
            let event = ajazz_sdk::parse_akp03e_pressed_input(&report).unwrap();
            assert!(
                !event.is_empty(),
                "A consumed release must not hide the rest of the HID queue"
            );
            assert_eq!(inputs(event).len(), usize::from(state != 0));
        }
        report[10] = 5;
        assert_eq!(
            inputs(ajazz_sdk::parse_akp03e_pressed_input(&report).unwrap()).len(),
            1,
            "All nonzero press states retain their meaning"
        );
    }
    assert!(ajazz_sdk::parse_akp03e_pressed_input(&vec![0; 512])
        .unwrap()
        .is_empty());
    assert!(ajazz_sdk::parse_akp03e_pressed_input(&[1, 2, 3]).is_err());
    for action in [0, 0x7F] {
        let mut unknown = vec![0; 512];
        unknown[0] = 1;
        unknown[9] = action;
        assert!(ajazz_sdk::parse_akp03e_pressed_input(&unknown).is_err());
    }
}
#[test]
fn reconnect_panel_preserves_the_actual_usb_failure() {
    let core = Core {
        state: Mutex::new(fixture()),
        stop: AtomicBool::new(false),
        directory: std::env::temp_dir().join("photogogo-controller-unused-diagnostic-root"),
    };
    record_io_failure(
        &core,
        2,
        "Brightness / initialise: HidApi error: The parameter is incorrect. (87)",
        false,
    );
    let s = core.state.lock().unwrap();
    assert_eq!(s.status.phase, "disconnected");
    assert!(
        s.status
            .error
            .as_deref()
            .unwrap()
            .contains("The parameter is incorrect. (87)"),
        "The user must see the real USB failure, not a generic reconnect message"
    );
    assert!(s.status.message.contains("Brightness / initialise"));
    assert!(s.presented.is_none() && s.status.session.is_none());
}
#[test]
fn an_old_usb_failure_cannot_replace_a_retry_or_release() {
    for enabled in [false, true] {
        let mut state = fixture();
        state.generation = 3;
        state.status.enabled = enabled;
        state.status.phase = if enabled { "searching" } else { "disabled" }.into();
        state.status.message = "New user choice".into();
        let core = Core {
            state: Mutex::new(state),
            stop: AtomicBool::new(false),
            directory: std::env::temp_dir().join("photogogo-controller-unused-diagnostic-root"),
        };
        record_io_failure(&core, 2, "Old USB session failed", false);
        let s = core.state.lock().unwrap();
        assert_eq!(s.status.message, "New user choice");
        assert_eq!(
            s.status.phase,
            if enabled { "searching" } else { "disabled" }
        );
    }
}
#[test]
fn rapid_presses_are_dropped_and_wrong_acks_do_not_unlock() {
    let mut s = fixture();
    let first = key(&mut s).unwrap();
    assert!(key(&mut s).is_none());
    assert!(!acknowledge(&mut s, "previous-session", &first.id));
    assert!(!acknowledge(&mut s, &first.session, "wrong-id"));
    assert!(s.pending.is_some());
    assert!(acknowledge(&mut s, &first.session, &first.id));
    assert!(s.pending.is_none());
    assert!(
        key(&mut s).is_none(),
        "ACK must drain queued HID input before re-arming"
    );
    s.drain = false;
    assert!(key(&mut s).is_some());
}
#[test]
fn only_a_confirmed_fresh_display_can_act() {
    let mut s = fixture();
    s.presented = None;
    assert!(key(&mut s).is_none());
    s.presented = Some(6);
    assert!(key(&mut s).is_none());
    s.presented = Some(7);
    s.frame.as_mut().unwrap().received = Instant::now() - Duration::from_secs(11);
    assert!(key(&mut s).is_none());
    s.frame.as_mut().unwrap().received = Instant::now();
    s.frame.as_mut().unwrap().surface.keys[0].enabled = false;
    assert!(key(&mut s).is_none());
    s.frame.as_mut().unwrap().surface.keys[0].enabled = true;
    assert!(key(&mut s).is_some());
}
#[test]
fn release_generation_client_and_warmup_are_independent_fences() {
    let mut s = fixture();
    assert!(takeover_allowed(&s, 2, false));
    assert!(!takeover_allowed(&s, 1, false));
    assert!(!takeover_allowed(&s, 2, true));
    s.status.enabled = false;
    assert!(!takeover_allowed(&s, 2, false));
    assert!(key(&mut s).is_none());
    s.status.enabled = true;
    assert!(admit(
        &mut s,
        "key",
        0,
        1,
        1,
        "controller-test-owner",
        Some(7),
        false
    )
    .is_none());
    assert!(admit(&mut s, "key", 0, 1, 2, "previous-owner", Some(7), false).is_none());
    assert!(admit(
        &mut s,
        "key",
        0,
        1,
        2,
        "controller-test-owner",
        Some(7),
        true
    )
    .is_none());
    assert!(admit(
        &mut s,
        "key",
        9,
        1,
        2,
        "controller-test-owner",
        Some(7),
        false
    )
    .is_none());
    assert!(key(&mut s).is_some());
}
#[test]
fn renderer_reload_requires_a_new_client_and_new_display() {
    let mut s = fixture();
    let first = key(&mut s).unwrap();
    claim(&mut s, "new-renderer-client-1234".into());
    assert!(s.frame.is_none() && s.presented.is_none() && s.pending.is_none() && s.drain);
    assert_ne!(s.session, first.session);
    assert!(!acknowledge(&mut s, &first.session, &first.id));
    let session = s.session.clone();
    claim(&mut s, "new-renderer-client-1234".into());
    assert_eq!(s.session, session, "StrictMode claim is idempotent");
    assert!(key(&mut s).is_none());
}
#[test]
fn an_unconfirmed_action_timeout_does_not_clear_or_replay_it() {
    let mut s = fixture();
    let first = key(&mut s).unwrap();
    s.pending.as_mut().unwrap().since = Instant::now() - Duration::from_secs(31);
    assert!(action_timed_out(&s));
    assert!(s.pending.is_some());
    assert!(key(&mut s).is_none());
    assert!(!acknowledge(&mut s, &first.session, "unrelated"));
    assert!(action_timed_out(&s));
}
#[test]
fn jpeg_dimensions_are_validated_before_decode() {
    let mut s = fixture();
    let mut frame = s.frame.take().unwrap().surface;
    let mut bytes = Vec::new();
    image::codecs::jpeg::JpegEncoder::new(&mut bytes)
        .encode_image(&DynamicImage::ImageRgb8(RgbImage::new(600, 600)))
        .unwrap();
    for key in &mut frame.keys {
        key.image_data = format!("data:image/jpeg;base64,{}", STANDARD.encode(&bytes));
    }
    assert!(decode_surface(frame.clone()).is_err());
    bytes.clear();
    image::codecs::jpeg::JpegEncoder::new(&mut bytes)
        .encode_image(&DynamicImage::ImageRgb8(RgbImage::new(60, 60)))
        .unwrap();
    for key in &mut frame.keys {
        key.image_data = format!("data:image/jpeg;base64,{}", STANDARD.encode(&bytes));
    }
    assert!(decode_surface(frame).is_ok());
}
#[test]
fn one_archive_independent_device_lease_excludes_another_instance() {
    let root = std::env::temp_dir().join(format!(
        "photogogo-controller-test-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_nanos_opt().unwrap()
    ));
    fs::create_dir(&root).unwrap();
    let first = OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(root.join("controller.lock"))
        .unwrap();
    fs2::FileExt::try_lock_exclusive(&first).unwrap();
    let second = OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.join("controller.lock"))
        .unwrap();
    assert!(fs2::FileExt::try_lock_exclusive(&second).is_err());
    drop(first);
    assert!(fs2::FileExt::try_lock_exclusive(&second).is_ok());
    drop(second);
    let path = root.join("preferences.json");
    persist(&path, br#"{"enabled":false,"brightness":70}"#).unwrap();
    persist(&path, br#"{"enabled":true,"brightness":45}"#).unwrap();
    let saved: Config = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    assert!(saved.enabled);
    assert_eq!(saved.brightness, 45);
    assert!(load_config(&root.join("preferences.json")).unwrap().enabled);
    fs::write(
        root.join("preferences.json"),
        br#"{"enabled":true,"brightness":255}"#,
    )
    .unwrap();
    assert!(load_config(&root.join("preferences.json")).is_err());
    fs::write(root.join("preferences.json"), vec![b' '; 8192]).unwrap();
    assert!(load_config(&root.join("preferences.json")).is_err());
    fs::write(root.join("preferences.json"), b"not JSON").unwrap();
    assert!(load_config(&root.join("preferences.json")).is_err());
    assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("photogogo-controller-test-"));
    fs::remove_dir_all(root).unwrap();
}
