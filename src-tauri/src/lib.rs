mod commands;
mod utils;

use commands::{
    files::{read_image_base64, rename_file, reveal_in_explorer},
    import::{
        abort_import_job, clear_finished_import_jobs, list_import_jobs, list_staging_tree,
        list_sd_cards, pause_import_job, resume_import_job, start_import, start_import_job,
    },
    logs::{clear_log_file, read_log_file},
    process::{
        abort_process_job, clear_finished_process_jobs, list_process_jobs, pause_process_job,
        resume_process_job, run_bw_conversion, run_enhancement, run_focus_detection,
        run_video_stabilization,
        start_process_job,
    },
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
            start_import_job,
            list_staging_tree,
            list_sd_cards,
            list_import_jobs,
            clear_finished_import_jobs,
            pause_import_job,
            resume_import_job,
            abort_import_job,
            // Post-processing
            run_focus_detection,
            run_enhancement,
            run_bw_conversion,
            run_video_stabilization,
            start_process_job,
            list_process_jobs,
            clear_finished_process_jobs,
            pause_process_job,
            resume_process_job,
            abort_process_job,
            // Transfer
            start_transfer,
            verify_checksums,
            // Tidy
            collect_trash,
            // Files (Review page)
            rename_file,
            read_image_base64,
            reveal_in_explorer,
            // Logs
            read_log_file,
            clear_log_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
