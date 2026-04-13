mod commands;
mod utils;

use commands::{
    files::{
        load_staging_timeline, prewarm_staging_timeline_cache, read_image_base64,
        read_image_thumbnail_base64, read_video_thumbnail_base64,
        read_video_hover_preview_base64,
        prewarm_staging_timeline_thumbnails, rename_file,
        start_import_prewarm_worker,
        reveal_in_explorer, open_in_default_app,
    },
    import::{
        abort_import_job, clear_finished_import_jobs, list_import_jobs, list_staging_tree,
        list_sd_cards, pause_import_job, resume_import_job, start_import, start_import_job,
    },
    logs::{clear_log_file, read_log_file},
    naming::{
        apply_event_naming, list_event_day_directories, load_event_naming_catalog,
        prefill_event_naming_from_archive, save_event_naming_catalog, scan_event_naming_library,
    },
    process::{
        abort_process_job, clear_finished_process_jobs, list_process_jobs, pause_process_job,
        check_face_scan_environment,
        install_face_scan_deps,
        resume_process_job, run_bw_conversion, run_enhancement, run_focus_detection,
        run_video_stabilization,
        start_event_naming_job, start_process_job,
    },
    settings::{load_settings, save_settings},
    staging_tags::{apply_staging_tags, load_staging_tags, set_file_staging_tags, write_staging_tags_to_metadata},
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
            list_event_day_directories,
            load_event_naming_catalog,
            save_event_naming_catalog,
            scan_event_naming_library,
            prefill_event_naming_from_archive,
            apply_event_naming,
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
            start_event_naming_job,
            check_face_scan_environment,
            install_face_scan_deps,
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
            read_image_thumbnail_base64,
            read_video_thumbnail_base64,
            read_video_hover_preview_base64,
            prewarm_staging_timeline_thumbnails,
            start_import_prewarm_worker,
            reveal_in_explorer,
            open_in_default_app,
            load_staging_timeline,
            prewarm_staging_timeline_cache,
            // Staging Explorer tags
            load_staging_tags,
            apply_staging_tags,
            set_file_staging_tags,
            write_staging_tags_to_metadata,
            // Logs
            read_log_file,
            clear_log_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
