mod commands;
mod utils;

use commands::{
    files::{read_image_base64, rename_file},
    import::{list_staging_tree, start_import},
    process::{run_bw_conversion, run_enhancement, run_focus_detection},
    settings::{load_settings, save_settings},
    tidy::collect_trash,
    transfer::{start_transfer, verify_checksums},
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            // Settings
            load_settings,
            save_settings,
            // Import
            start_import,
            list_staging_tree,
            // Post-processing
            run_focus_detection,
            run_enhancement,
            run_bw_conversion,
            // Transfer
            start_transfer,
            verify_checksums,
            // Tidy
            collect_trash,
            // Files (Review page)
            rename_file,
            read_image_base64,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
