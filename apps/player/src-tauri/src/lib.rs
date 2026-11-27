use tauri::{DragDropEvent, Manager, WindowEvent};

#[cfg(debug_assertions)]
mod bridge;
pub mod cache;
pub mod db;
mod engine;
pub mod filters;
pub mod frames;
mod formats;
pub mod history;
pub mod playlists;
pub mod import;
pub mod library;
pub mod matching;
pub mod online;
mod open;
pub mod parse;
pub mod probe;
pub mod relink;
pub mod tmdb;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // First, so a second launch hands its files over and exits before anything else starts (spike S4).
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        open::receive(app, open::paths_from_args(&args, std::path::Path::new(&cwd)));
    }));
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(engine::Engine::default())
        .manage(library::LibraryState::default())
        .manage(db::Db::default())
        .manage(import::ImportState::default())
        .manage(open::OpenState::default())
        .manage(frames::Frames::default())
        .setup(|app| {
            // Where library.db lives; it is opened on the library's first use, not now (D16).
            if let Ok(dir) = app.path().app_data_dir() {
                app.state::<db::Db>().set_path(dir.join("library.db"));
            }
            // A debug build checked from a browser: no window, no engine; the page's IPC comes over localhost.
            #[cfg(debug_assertions)]
            if bridge::start(app.handle()) {
                return Ok(());
            }
            engine::start(app.handle());
            open::receive_launch(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine::engine_load,
            engine::engine_command,
            engine::engine_set,
            engine::engine_status,
            library::library_get,
            library::library_cover,
            library::library_image,
            history::history_record,
            history::history_list,
            history::history_get,
            playlists::playlists_list,
            playlists::playlist_create,
            playlists::playlist_update,
            playlists::playlist_delete,
            playlists::playlist_set,
            import::import_pick_folder,
            import::import_pick_files,
            import::import_discover,
            import::import_discover_cancel,
            import::import_start,
            import::import_jobs,
            import::import_stop,
            import::import_retry,
            import::import_dismiss,
            import::import_clear_finished,
            import::places_list,
            import::places_rescan,
            import::places_remove,
            relink::file_relink,
            relink::file_forget,
            relink::place_relink,
            frames::frames_want,
            cache::cache_info,
            cache::cache_set_cap,
            cache::cache_clear,
            open::open_launched,
            open::open_take,
            open::open_pick,
            open::open_cover,
        ])
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            match event {
                // Files dropped from Explorer play like opened ones (Tauri's drop handler gives their paths, S4).
                WindowEvent::DragDrop(DragDropEvent::Drop { paths, .. }) => {
                    open::receive(window.app_handle(), paths.clone());
                }
                // The mini player only mirrors the main window, so closing main quits.
                WindowEvent::Destroyed => window.app_handle().exit(0),
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the Pastel Media Pro desktop app");
}
