//! Run only in an isolated GUI-subsystem parent via scripts/test-background-processes.ps1.
use super::*;

#[link(name = "kernel32")]
extern "system" {
    fn GetConsoleWindow() -> *mut std::ffi::c_void;
}

#[test]
#[ignore = "requires isolated GUI-subsystem parent; run scripts/test-background-processes.ps1"]
fn background_media_helpers_do_not_open_windows() {
    assert!(unsafe { GetConsoleWindow() }.is_null(), "parent must match the installed GUI application's console-free state");
    let dir = PathBuf::from(std::env::var_os("PHOTOGOGO_CONSOLE_TEST_DIR").expect("use the Windows regression script"));
    let log = dir.join("observations.txt");
    let probe = dir.join("ffmpeg.exe");
    let source = dir.join("synthetic clip & check.mp4");
    std::env::set_var("PHOTOGOGO_FFMPEG", &probe);
    std::env::set_var("PHOTOGOGO_CONSOLE_TEST_LOG", &log);
    std::env::set_var("PHOTOGOGO_CONSOLE_TEST_SOURCE", &source);

    // Positive detector control: bare console launch must be visible here.
    // A hidden console parent otherwise lets the broken implementation pass.
    assert!(Command::new(&probe).arg("--console-control").output().unwrap().status.success());
    let control = fs::read_to_string(&log).unwrap();
    assert_eq!(control.trim(), "control: console=true visible=true", "test environment cannot detect the original flashing-window bug");

    assert_eq!(render_video_thumbnail_at(&source, 220, 140, 1.0).unwrap(), [0xff, 0xd8, 0xff, 0xd9]);
    assert_eq!(probe_video_timeline_metadata(&source), (None, Some(1000)));
    let preview = dir.join("preview output & check.mp4");
    render_video_hover_preview_mp4_to_file(&source, 420, 240, 8, &preview).unwrap();
    assert_eq!(fs::read(preview).unwrap(), b"synthetic preview");

    // Hiding a console must not swallow diagnostic streams or the exit status.
    let failed = background_media_command(&probe).arg("--capture-error").output().unwrap();
    assert_eq!(failed.status.code(), Some(19));
    assert_eq!(failed.stdout, b"diagnostic stdout");
    assert_eq!(failed.stderr, b"diagnostic stderr");

    let observed = fs::read_to_string(&log).unwrap();
    println!("{observed}");
    let expected = concat!(
        "control: console=true visible=true\n",
        "thumbnail: console=false visible=false\n",
        "metadata: console=false visible=false\n",
        "hover-preview: console=false visible=false\n",
        "capture-error: console=false visible=false\n",
    );
    assert_eq!(observed, expected, "background media helper created a console window");
}
