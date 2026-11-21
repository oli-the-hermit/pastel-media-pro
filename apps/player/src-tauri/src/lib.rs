use tauri::{DragDropEvent, Manager, WindowEvent};

mod engine;
mod formats;
pub mod library;
mod open;
pub mod parse;

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
        .manage(open::OpenState::default())
        .setup(|app| {
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
            open::open_launched,
            open::open_take,
            open::open_pick,
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
