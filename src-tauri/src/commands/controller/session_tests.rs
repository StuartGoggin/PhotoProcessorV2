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
