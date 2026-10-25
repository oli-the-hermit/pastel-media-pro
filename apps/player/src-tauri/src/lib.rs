use tauri::{Manager, WindowEvent};

mod engine;
pub mod library;
pub mod parse;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(engine::Engine::default())
        .manage(library::LibraryState::default())
        .setup(|app| {
            engine::start(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine::engine_load,
            engine::engine_command,
            engine::engine_set,
            engine::engine_status,
            library::library_get,
            library::library_cover,
        ])
        .on_window_event(|window, event| {
            // The mini player only mirrors the main window, so closing main quits.
            if window.label() == "main" {
                if let WindowEvent::Destroyed = event {
                    window.app_handle().exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the Pastel Media Pro desktop app");
}
