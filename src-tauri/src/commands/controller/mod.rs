//! Session-owned AKP03E control. No keyboard injection, firmware writes, global
//! shortcuts, vendor-profile edits or background controller daemon.
mod process;
#[cfg(test)]
mod session_tests;
use ajazz_sdk::{Ajazz, AjazzInput, Kind};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Cursor, Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct Config {
    enabled: bool,
    brightness: u8,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: true,
            brightness: 70,
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    enabled: bool,
    phase: String,
    message: String,
    device: Option<String>,
    vendor_stopped: bool,
    last_input: Option<String>,
    error: Option<String>,
    brightness: u8,
    session: Option<String>,
    client: Option<String>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Key {
    label: String,
    image_data: String,
    enabled: bool,
}
#[derive(Clone, Deserialize)]
pub struct Label {
    label: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Surface {
    client: String,
    revision: u64,
    title: String,
    keys: Vec<Key>,
    dials: Vec<Label>,
    side_buttons: Vec<Label>,
}
struct Frame {
    surface: Surface,
    images: Vec<DynamicImage>,
    received: Instant,
}
#[derive(Clone, Serialize)]
struct Input {
    session: String,
    revision: u64,
    id: String,
    kind: String,
    index: usize,
    delta: i8,
}
struct Pending {
    id: String,
    since: Instant,
}
struct Session {
    client: String,
    status: Status,
    generation: u64,
    frame: Option<Frame>,
    presented: Option<u64>,
    session: String,
    pending: Option<Pending>,
    drain: bool,
    serial: u64,
}
struct Core {
    state: Mutex<Session>,
    stop: AtomicBool,
    directory: PathBuf,
}
pub struct ControllerManager(Arc<Core>);

impl ControllerManager {
    pub fn shutdown(&self) {
        self.0.stop.store(true, Ordering::Release);
    }
}
fn diagnostic(core: &Core, message: &str) {
    log::info!("AKP03E: {message}");
    let path = core.directory.join("controller.log");
    let truncate = fs::metadata(&path).is_ok_and(|m| m.len() > 1024 * 1024);
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .write(true)
        .append(!truncate)
        .truncate(truncate)
        .open(path)
    {
        let _ = writeln!(file, "{} {message}", chrono::Utc::now().to_rfc3339());
    }
}
fn phase(core: &Core, name: &str, message: &str, error: bool) {
    let mut s = core.state.lock().unwrap_or_else(|e| e.into_inner());
    if !s.status.enabled && name != "disabled" {
        return;
    }
    if s.status.phase != name || s.status.message != message {
        diagnostic(core, message);
    }
    s.status.phase = name.into();
    s.status.message = message.into();
    s.status.error = error.then(|| message.into());
    s.status.session = if name == "connected" {
        Some(s.session.clone())
    } else {
        None
    };
}
pub fn init(app: &AppHandle) -> Result<(), String> {
    let directory = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("controller");
    let loaded = if fs::create_dir_all(&directory).is_err() {
        Err("Controller preferences cannot be opened; automation is off.".into())
    } else {
        load_config(&directory.join("preferences.json"))
    };
    let error = loaded.as_ref().err().cloned();
    let config = loaded.unwrap_or(Config {
        enabled: false,
        brightness: 70,
    });
    let phase_name = if config.enabled {
        "searching"
    } else {
        "disabled"
    };
    let message = error.clone().unwrap_or_else(|| {
        "Waiting for an AJAZZ AKP03E. Restart AJAZZ manually after releasing PhotoGoGo control."
            .into()
    });
    let status = Status {
        enabled: config.enabled,
        brightness: config.brightness.min(100),
        phase: phase_name.into(),
        message,
        device: None,
        vendor_stopped: false,
        last_input: None,
        error,
        session: None,
        client: None,
    };
    let state = Session {
        client: String::new(),
        status,
        generation: 1,
        frame: None,
        presented: None,
        session: String::new(),
        pending: None,
        drain: true,
        serial: 0,
    };
    let core = Arc::new(Core {
        state: Mutex::new(state),
        stop: AtomicBool::new(false),
        directory,
    });
    app.manage(ControllerManager(core.clone()));
    let handle = app.clone();
    thread::Builder::new()
        .name("AKP03E controller".into())
        .spawn(move || worker(handle, core))
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
pub fn controller_status(manager: State<'_, ControllerManager>) -> Status {
    manager
        .0
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .status
        .clone()
}
#[tauri::command]
pub fn controller_claim_client(
    manager: State<'_, ControllerManager>,
    client: String,
) -> Result<Status, String> {
    if client.len() < 16
        || client.len() > 80
        || !client
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("Invalid controller client identity.".into());
    }
    let mut s = manager
        .0
        .state
        .lock()
        .map_err(|_| "Controller state unavailable")?;
    claim(&mut s, client);
    Ok(s.status.clone())
}
fn claim(s: &mut Session, client: String) {
    if s.client != client {
        s.client = client;
        s.status.client = Some(s.client.clone());
        s.serial += 1;
        s.session = format!("{}-{}", s.client, s.serial);
        s.frame = None;
        s.presented = None;
        s.pending = None;
        s.drain = true;
        if s.status.phase == "connected" {
            s.status.session = Some(s.session.clone());
        }
    }
}
#[tauri::command]
pub fn controller_configure(
    manager: State<'_, ControllerManager>,
    enabled: bool,
    brightness: Option<u8>,
) -> Result<Status, String> {
    let mut s = manager
        .0
        .state
        .lock()
        .map_err(|_| "Controller state unavailable")?;
    let value = brightness.unwrap_or(s.status.brightness);
    if value > 100 {
        return Err("Brightness must be between 0 and 100.".into());
    }
    let config = Config {
        enabled,
        brightness: value,
    };
    let bytes = serde_json::to_vec(&config).map_err(|e| e.to_string())?;
    let path = manager.0.directory.join("preferences.json");
    // Preferences live outside staging; publish only after the new bytes flush.
    persist(&path, &bytes)?;
    let restart = s.status.enabled != enabled || brightness.is_none();
    s.status.enabled = enabled;
    s.status.brightness = value;
    if restart {
        s.generation += 1;
        s.presented = None;
        s.pending = None;
        s.drain = true;
        s.status.session = None;
    }
    if restart {
        s.status.error = None;
        s.status.phase = if enabled { "searching" } else { "disabled" }.into();
        s.status.message = if enabled {
            "Looking for the AKP03E; AJAZZ will be stopped on takeover."
        } else {
            "Controller released. Restart the AJAZZ application manually when needed."
        }
        .into();
    }
    Ok(s.status.clone())
}
fn load_config(path: &std::path::Path) -> Result<Config, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Config::default()),
        Err(_) => return Err("Cannot read controller preferences; automation is off.".into()),
    };
    let mut bytes = Vec::new();
    file.take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read controller preferences; automation is off.")?;
    if bytes.len() > 4096 {
        return Err("Controller preferences exceed the size limit; automation is off.".into());
    }
    let config:Config=serde_json::from_slice(&bytes).map_err(|_|"Controller preferences are damaged; automation is off. Use Retry to save fresh preferences.")?;
    if config.brightness > 100 {
        return Err("Controller brightness is invalid; automation is off.".into());
    }
    Ok(config)
}
fn persist(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    let guard = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path.with_extension("lock"))
        .map_err(|e| e.to_string())?;
    fs2::FileExt::try_lock_exclusive(&guard)
        .map_err(|_| "Controller preferences are being saved by another instance.")?;
    let temp = path.with_extension("json.pending");
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let from: Vec<u16> = temp.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err("Could not save controller preferences; previous setting retained.".into());
        }
    }
    #[cfg(not(windows))]
    fs::rename(temp, path).map_err(|e| e.to_string())?;
    Ok(())
}
fn decode_surface(surface: Surface) -> Result<Frame, String> {
    if surface.client.len() < 16
        || surface.client.len() > 80
        || surface.revision == 0
        || surface.revision > 9_007_199_254_740_991
        || surface.title.len() > 100
        || surface.keys.len() != 6
        || surface.dials.len() != 3
        || surface.side_buttons.len() != 3
    {
        return Err("Invalid controller layout.".into());
    }
    if surface
        .dials
        .iter()
        .chain(&surface.side_buttons)
        .any(|v| v.label.len() > 100)
    {
        return Err("Controller label is too long.".into());
    }
    let mut images = Vec::with_capacity(6);
    for key in &surface.keys {
        if key.label.len() > 100 || key.image_data.len() > 32768 {
            return Err("Controller artwork exceeds its limit.".into());
        }
        let encoded = key
            .image_data
            .strip_prefix("data:image/jpeg;base64,")
            .ok_or("Controller artwork must be a JPEG data URL.")?;
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| "Invalid controller artwork encoding.")?;
        let dimensions = image::ImageReader::with_format(Cursor::new(&bytes), ImageFormat::Jpeg)
            .into_dimensions()
            .map_err(|_| "Invalid controller JPEG.")?;
        if dimensions != (60, 60) {
            return Err("Controller artwork must be 60 by 60 pixels.".into());
        }
        images.push(
            image::load_from_memory_with_format(&bytes, ImageFormat::Jpeg)
                .map_err(|_| "Cannot decode controller artwork.")?,
        );
    }
    Ok(Frame {
        surface,
        images,
        received: Instant::now(),
    })
}
#[tauri::command]
pub fn controller_surface(
    manager: State<'_, ControllerManager>,
    surface: Surface,
) -> Result<(), String> {
    // A repeated heartbeat refreshes expiry without decoding or repainting six JPEGs.
    {
        let mut s = manager
            .0
            .state
            .lock()
            .map_err(|_| "Controller state unavailable")?;
        if s.client != surface.client {
            return Err("Controller layout belongs to an inactive app session.".into());
        }
        if let Some(f) = s.frame.as_mut() {
            if f.surface.revision == surface.revision {
                f.received = Instant::now();
                return Ok(());
            }
        }
    }
    let frame = decode_surface(surface)?;
    let mut s = manager
        .0
        .state
        .lock()
        .map_err(|_| "Controller state unavailable")?;
    if s.client != frame.surface.client {
        return Err("Controller layout belongs to an inactive app session.".into());
    }
    if s.frame.as_ref().is_some_and(|f| {
        f.surface.revision > frame.surface.revision
            && f.received.elapsed() < Duration::from_secs(10)
    }) {
        return Ok(());
    }
    s.frame = Some(frame);
    s.presented = None;
    s.drain = true;
    Ok(())
}
#[tauri::command]
pub fn controller_ack(
    manager: State<'_, ControllerManager>,
    session: String,
    id: String,
    result: String,
    message: Option<String>,
) -> Result<(), String> {
    if !["handled", "ignored", "error"].contains(&result.as_str())
        || message.as_ref().is_some_and(|v| v.len() > 500)
    {
        return Err("Invalid controller acknowledgement.".into());
    }
    let mut s = manager
        .0
        .state
        .lock()
        .map_err(|_| "Controller state unavailable")?;
    let accepted = acknowledge(&mut s, &session, &id);
    if accepted && result == "error" {
        s.status.last_input = Some(
            message
                .unwrap_or("Action was not completed; inspect PhotoGoGo before retrying.".into()),
        );
    }
    Ok(())
}
fn acknowledge(s: &mut Session, session: &str, id: &str) -> bool {
    if s.session == session && s.pending.as_ref().is_some_and(|v| v.id == id) {
        s.pending = None;
        s.drain = true;
        return true;
    }
    false
}
fn action_timed_out(s: &Session) -> bool {
    s.pending
        .as_ref()
        .is_some_and(|p| p.since.elapsed() > Duration::from_secs(30))
}
fn takeover_allowed(s: &Session, generation: u64, stopping: bool) -> bool {
    s.status.enabled && s.generation == generation && !stopping
}
fn admit(
    s: &mut Session,
    kind: &str,
    index: usize,
    delta: i8,
    generation: u64,
    client: &str,
    revision: Option<u64>,
    warm: bool,
) -> Option<Input> {
    if s.generation != generation
        || s.client != client
        || s.drain
        || !s.status.enabled
        || s.pending.is_some()
        || warm
        || s.presented != revision
    {
        return None;
    }
    let frame = s.frame.as_ref().filter(|f| {
        f.received.elapsed() < Duration::from_secs(10)
            && Some(f.surface.revision) == revision
            && f.surface.client == client
    })?;
    let allowed = match kind {
        "key" => frame.surface.keys.get(index).is_some_and(|key| key.enabled) && delta == 1,
        "side" => index < 3 && delta == 1,
        "dial" => index < 3 && (-1..=1).contains(&delta),
        _ => false,
    };
    if !allowed {
        return None;
    }
    let revision = frame.surface.revision;
    s.serial += 1;
    let id = s.serial.to_string();
    let event = Input {
        session: s.session.clone(),
        revision,
        id: id.clone(),
        kind: kind.into(),
        index,
        delta,
    };
    s.pending = Some(Pending {
        id,
        since: Instant::now(),
    });
    s.status.last_input = Some(format!("{kind} {}", index + 1));
    Some(event)
}
fn inputs(input: AjazzInput) -> Vec<(&'static str, usize, i8)> {
    match input {
        AjazzInput::ButtonStateChange(v) => v
            .iter()
            .enumerate()
            .filter(|(_, b)| **b)
            .filter_map(|(i, _)| {
                if i < 6 {
                    Some(("key", i, 1))
                } else if i < 9 {
                    Some(("side", i - 6, 1))
                } else {
                    None
                }
            })
            .collect(),
        AjazzInput::EncoderStateChange(v) => v
            .iter()
            .take(3)
            .enumerate()
            .filter(|(_, b)| **b)
            .map(|(i, _)| ("dial", i, 0))
            .collect(),
        AjazzInput::EncoderTwist(v) => v
            .iter()
            .take(3)
            .enumerate()
            .filter(|(_, d)| **d != 0)
            .map(|(i, d)| ("dial", i, d.signum()))
            .collect(),
        _ => Vec::new(),
    }
}
fn fallback() -> Vec<DynamicImage> {
    (0..6)
        .map(|n| {
            let mut image = RgbImage::from_pixel(60, 60, Rgb([9, 18, 29]));
            for x in 10..50 {
                for y in (20 + n * 3)..(23 + n * 3) {
                    image.put_pixel(x, y, Rgb([42, 97, 112]));
                }
            }
            DynamicImage::ImageRgb8(image)
        })
        .collect()
}
fn worker(app: AppHandle, core: Arc<Core>) {
    let mut device: Option<Ajazz> = None;
    let mut lease: Option<std::fs::File> = None;
    let mut generation = 0;
    let mut attempted_stop = false;
    let mut blocked = false;
    let mut next_probe = Instant::now();
    let mut last_keepalive = Instant::now();
    let mut painted = None;
    let mut painted_faces: Vec<String> = Vec::new();
    let mut last_brightness = 255;
    let mut warm_until = Instant::now();
    let mut bad_packets = 0u64;
    let mut last_bad_log = Instant::now();
    while !core.stop.load(Ordering::Acquire) {
        let (enabled, current_generation, brightness) = {
            let s = core.state.lock().unwrap_or_else(|e| e.into_inner());
            (s.status.enabled, s.generation, s.status.brightness)
        };
        if generation != current_generation {
            if let Some(old) = device.take() {
                let _ = old.shutdown();
            }
            lease = None;
            generation = current_generation;
            attempted_stop = false;
            blocked = false;
            painted = None;
            last_brightness = 255;
            next_probe = Instant::now();
        }
        if !enabled || blocked {
            thread::sleep(Duration::from_millis(100));
            continue;
        }
        if device.is_none() {
            if Instant::now() < next_probe {
                thread::sleep(Duration::from_millis(100));
                continue;
            }
            next_probe = Instant::now() + Duration::from_secs(2);
            let hid = match ajazz_sdk::new_hidapi() {
                Ok(h) => h,
                Err(e) => {
                    phase(
                        &core,
                        "error",
                        &format!("Cannot inspect USB controller: {e}"),
                        true,
                    );
                    continue;
                }
            };
            let devices: Vec<_> = ajazz_sdk::list_devices(&hid)
                .into_iter()
                .filter(|(kind, _)| *kind == Kind::Akp03E)
                .collect();
            if devices.is_empty() {
                phase(&core,"searching","Connect the AJAZZ AKP03E. No AJAZZ application has been stopped for an absent device.",false);
                continue;
            }
            if devices.len() != 1 {
                phase(
                    &core,
                    "error",
                    "More than one AKP03E found. Connect one controller before Retry.",
                    true,
                );
                blocked = true;
                continue;
            }
            if lease.is_none() {
                match OpenOptions::new()
                    .create(true)
                    .truncate(false)
                    .read(true)
                    .write(true)
                    .open(core.directory.join("controller.lock"))
                    .and_then(|file| {
                        fs2::FileExt::try_lock_exclusive(&file)?;
                        Ok(file)
                    }) {
                    Ok(file) => lease = Some(file),
                    Err(_) => {
                        phase(&core,"error","Controller is already owned by another PhotoGoGo instance, or its lease is unavailable. Close the other instance, then Retry.",true);
                        blocked = true;
                        continue;
                    }
                }
            }
            if !attempted_stop {
                // This check commits takeover. Release before this point cannot stop AJAZZ.
                {
                    let s = core.state.lock().unwrap_or_else(|e| e.into_inner());
                    if !takeover_allowed(&s, generation, core.stop.load(Ordering::Acquire)) {
                        continue;
                    }
                }
                phase(
                    &core,
                    "taking-over",
                    "Taking over AKP03E; stopping only Stream Dock AJAZZ in this Windows session.",
                    false,
                );
                attempted_stop = true;
                match process::stop_vendor() {
                    Ok(n) => {
                        core.state
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .status
                            .vendor_stopped = n > 0;
                        diagnostic(&core,&format!("Takeover: stopped {n} verified AJAZZ process(es); restart is manual."));
                    }
                    Err(e) => {
                        phase(&core, "error", &e, true);
                        blocked = true;
                        continue;
                    }
                }
            }
            {
                let s = core.state.lock().unwrap_or_else(|e| e.into_inner());
                if !takeover_allowed(&s, generation, core.stop.load(Ordering::Acquire)) {
                    continue;
                }
            }
            match Ajazz::connect(&hid, Kind::Akp03E, &devices[0].1) {
                Ok(d) => {
                    let mut s = core.state.lock().unwrap_or_else(|e| e.into_inner());
                    if !takeover_allowed(&s, generation, core.stop.load(Ordering::Acquire)) {
                        drop(d);
                        continue;
                    }
                    device = Some(d);
                    s.serial += 1;
                    s.session = format!("{}-{}", chrono::Utc::now().timestamp_millis(), s.serial);
                    s.pending = None;
                    s.presented = None;
                    s.drain = true;
                    s.status.device =
                        Some("AJAZZ AKP03E · 6 displays / 3 dials / 3 side buttons".into());
                    painted = None;
                    last_brightness = 255;
                    warm_until = Instant::now() + Duration::from_millis(150);
                }
                Err(e) => {
                    phase(
                        &core,
                        "error",
                        &format!(
                            "Cannot open AKP03E: {e}. Close other controller software, then Retry."
                        ),
                        true,
                    );
                    continue;
                }
            }
        }
        let Some(d) = device.as_ref() else { continue };
        let action_timeout = {
            let s = core.state.lock().unwrap_or_else(|e| e.into_inner());
            action_timed_out(&s)
        };
        if action_timeout {
            phase(
                &core,
                "error",
                "Controller action was not confirmed. Check the app, then Retry controller.",
                true,
            );
            if let Some(old) = device.take() {
                let _ = old.shutdown();
            }
            blocked = true;
            continue;
        }
        let (client, revision, images, faces, drain) = {
            let mut s = core.state.lock().unwrap_or_else(|e| e.into_inner());
            let current = s
                .frame
                .as_ref()
                .filter(|f| f.received.elapsed() < Duration::from_secs(10));
            let rev = current.map(|f| f.surface.revision);
            let faces = current
                .map(|f| {
                    f.surface
                        .keys
                        .iter()
                        .map(|key| key.image_data.clone())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_else(|| (0..6).map(|i| format!("idle-{i}")).collect());
            let images = if painted.as_ref() != Some(&(s.client.clone(), rev)) {
                Some(current.map(|f| f.images.clone()).unwrap_or_else(fallback))
            } else {
                None
            };
            let drain = s.drain;
            s.drain = false;
            (s.client.clone(), rev, images, faces, drain)
        };
        let io = (|| -> Result<(), String> {
            if last_brightness != brightness {
                d.set_brightness(brightness).map_err(|e| e.to_string())?;
                last_brightness = brightness;
            }
            if let Some(images) = images {
                let force = painted.as_ref().map(|value| &value.0) != Some(&client);
                let mut changed = false;
                for (i, image) in images.into_iter().enumerate() {
                    if force || painted_faces.get(i) != faces.get(i) {
                        d.set_button_image(i as u8, image)
                            .map_err(|e| e.to_string())?;
                        changed = true;
                    }
                }
                if changed {
                    d.flush().map_err(|e| e.to_string())?;
                }
                painted_faces = faces;
                painted = Some((client.clone(), revision));
                let mut s = core.state.lock().unwrap_or_else(|e| e.into_inner());
                if s.client == client && s.frame.as_ref().map(|f| f.surface.revision) == revision {
                    s.presented = revision;
                }
                warm_until = Instant::now() + Duration::from_millis(50);
            }
            if last_keepalive.elapsed() > Duration::from_secs(2) {
                d.keep_alive().map_err(|e| e.to_string())?;
                last_keepalive = Instant::now();
            }
            if drain {
                for _ in 0..128 {
                    match d.read_input(None) {
                        Ok(value) if value.is_empty() => break,
                        Ok(_) => {}
                        Err(ajazz_sdk::AjazzError::BadData) => {}
                        Err(e) => return Err(e.to_string()),
                    }
                }
                warm_until = Instant::now() + Duration::from_millis(40);
            }
            let raw = match d.read_input(Some(Duration::from_millis(30))) {
                Ok(value) => value,
                Err(ajazz_sdk::AjazzError::BadData) => {
                    bad_packets += 1;
                    if last_bad_log.elapsed() > Duration::from_secs(10) {
                        diagnostic(
                            &core,
                            &format!(
                                "Ignored {bad_packets} unrecognised USB packets in this session."
                            ),
                        );
                        last_bad_log = Instant::now();
                    }
                    AjazzInput::NoData
                }
                Err(e) => return Err(e.to_string()),
            };
            if !raw.is_empty() {
                match process::vendor_running() {
                    Ok(false) => {}
                    Ok(true) => {
                        blocked = true;
                        return Err("AJAZZ restarted while PhotoGoGo was using the controller. PhotoGoGo released it; use Retry for a new takeover.".into());
                    }
                    Err(error) => {
                        blocked = true;
                        return Err(error);
                    }
                }
            }
            for (kind, index, delta) in inputs(raw) {
                let mut s = core.state.lock().unwrap_or_else(|e| e.into_inner());
                let Some(input) = admit(
                    &mut s,
                    kind,
                    index,
                    delta,
                    generation,
                    &client,
                    revision,
                    Instant::now() < warm_until,
                ) else {
                    continue;
                };
                drop(s);
                if app.emit("controller-input", input).is_err() {
                    return Err("Cannot deliver controller input to the app.".into());
                }
            }
            Ok(())
        })();
        if let Err(error) = io {
            diagnostic(&core, &format!("USB session ended: {error}"));
            device = None;
            painted = None;
            let mut s = core.state.lock().unwrap_or_else(|e| e.into_inner());
            s.presented = None;
            s.pending = None;
            s.status.device = None;
            drop(s);
            if blocked {
                phase(&core, "error", &error, true);
            } else {
                phase(&core,"disconnected","AKP03E disconnected or could not update. Reconnect it or use Retry; AJAZZ restart remains manual.",true);
            }
        } else {
            let mut s = core.state.lock().unwrap_or_else(|e| e.into_inner());
            if s.generation == generation && s.status.enabled {
                s.status.phase = "connected".into();
                s.status.message =
                    "PhotoGoGo controls AKP03E. Restart AJAZZ manually after release.".into();
                s.status.error = None;
                s.status.session = Some(s.session.clone());
            }
        }
    }
    if let Some(d) = device {
        let _ = d.shutdown();
    }
    diagnostic(
        &core,
        "PhotoGoGo stopped; USB handle released. AJAZZ restart is manual.",
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_akp03e_press_including_repeated_presses_is_one_action() {
        for _ in 0..3 {
            assert_eq!(
                inputs(AjazzInput::ButtonStateChange(vec![
                    true, false, false, false, false, false, false, true, false
                ])),
                vec![("key", 0, 1), ("side", 1, 1)]
            );
            assert_eq!(
                inputs(AjazzInput::EncoderStateChange(vec![false, true, false])),
                vec![("dial", 1, 0)]
            );
        }
    }
    #[test]
    fn all_dials_and_unexpected_indices_are_bounded() {
        assert_eq!(
            inputs(AjazzInput::EncoderTwist(vec![-4, 3, 0, 2])),
            vec![("dial", 0, -1), ("dial", 1, 1)]
        );
        assert!(inputs(AjazzInput::ButtonStateChange(vec![false; 30])).is_empty());
    }
    #[test]
    fn malformed_or_oversize_artwork_cannot_reach_hardware() {
        let surface = Surface {
            client: "test-controller-client".into(),
            revision: 1,
            title: "Test".into(),
            keys: vec![
                Key {
                    label: "test".into(),
                    image_data: "data:image/jpeg;base64,AAAA".into(),
                    enabled: true,
                };
                6
            ],
            dials: vec![Label { label: "d".into() }; 3],
            side_buttons: vec![Label { label: "s".into() }; 3],
        };
        assert!(decode_surface(surface).is_err());
    }
}
