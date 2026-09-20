//! Console-mode stand-in for FFmpeg/FFprobe; never reads user media.
use std::io::Write;

#[link(name = "kernel32")]
extern "system" { fn GetConsoleWindow() -> *mut std::ffi::c_void; }
#[link(name = "user32")]
extern "system" { fn IsWindowVisible(window: *mut std::ffi::c_void) -> i32; }

fn main() {
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let has = |value: &str| args.iter().any(|arg| arg == value);
    let kind = if has("--console-control") { "control" }
        else if has("--capture-error") { "capture-error" }
        else if has("-show_entries") { "metadata" }
        else if has("-frames:v") { "thumbnail" }
        else { "hover-preview" };
    let window = unsafe { GetConsoleWindow() };
    let visible = !window.is_null() && unsafe { IsWindowVisible(window) } != 0;
    let mut log = std::fs::OpenOptions::new().create(true).append(true)
        .open(std::env::var_os("PHOTOGOGO_CONSOLE_TEST_LOG").unwrap()).unwrap();
    writeln!(log, "{kind}: console={} visible={visible}", !window.is_null()).unwrap();

    match kind {
        "control" => return,
        "capture-error" => {
            std::io::stdout().write_all(b"diagnostic stdout").unwrap();
            std::io::stderr().write_all(b"diagnostic stderr").unwrap();
            std::io::stdout().flush().unwrap();
            std::io::stderr().flush().unwrap();
            std::process::exit(19);
        },
        _ => assert!(args.contains(&std::env::var_os("PHOTOGOGO_CONSOLE_TEST_SOURCE").unwrap()), "source argument must survive spaces and shell metacharacters"),
    }
    if kind == "metadata" {
        print!("{{\"format\":{{\"duration\":\"1.0\"}},\"streams\":[]}}");
    } else if kind == "thumbnail" {
        std::io::stdout().write_all(&[0xff, 0xd8, 0xff, 0xd9]).unwrap();
    } else {
        std::fs::write(args.last().unwrap(), b"synthetic preview").unwrap();
    }
}
