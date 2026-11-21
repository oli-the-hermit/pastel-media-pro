//! Files the system hands the app play at once (D16), with no library involved. They arrive:
//! - on the command line at a cold start ("Open with", a double-click in Explorer);
//! - from a second launch, which the single-instance plugin relays here with its working directory;
//! - dropped on the window;
//! - picked in the Open dialog.
//!
//! Explorer starts one process per file for a multi-selection, about 12 ms apart (spike S4), so arrivals are
//! collected until none has come for `QUIET`, then handed to the page as one batch. Only these files and the
//! library's may reach the engine: the page can't name any other path (`is_allowed`).

use crate::formats::{self, MediaKind};
use crate::library::{self, LibTrack, LibVideo};
use crate::parse;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// How long after the last arrival a batch is handed over.
const QUIET: Duration = Duration::from_millis(250);
/// The event that tells the page a batch is waiting (`open_take` hands it over).
pub const EVENT: &str = "open-files";

/// One opened file, as the page plays it: a song (tags read) or a video (its name parsed).
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Opened {
    Audio(LibTrack),
    Video(LibVideo),
}

#[derive(Default)]
pub struct OpenState {
    inner: Mutex<Inner>,
    /// Bumped by every arrival; a batch is handed over only by the wait that saw the last one.
    generation: AtomicU64,
    next_id: AtomicU64,
}

#[derive(Default)]
struct Inner {
    /// Arrived, not yet described.
    incoming: Vec<PathBuf>,
    /// Described, waiting for the page.
    pending: Vec<Opened>,
    /// Every file handed to the app this session (canonical paths).
    allowed: HashSet<PathBuf>,
    /// The app was started with files: the page opens on the player.
    launched_with_files: bool,
}

/// The files among a launch's arguments: the program's own name and switches are skipped, relative paths are
/// read against the launch's working directory, and only existing files of a type the app plays are kept.
pub fn paths_from_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .map(|a| {
            let p = PathBuf::from(a);
            if p.is_absolute() { p } else { cwd.join(p) }
        })
        .filter(|p| p.is_file() && formats::kind_of(p).is_some())
        .collect()
}

fn canonical(path: &Path) -> Option<PathBuf> {
    path.canonicalize().ok()
}

/// Whether the engine may open this path: a file the system handed the app this session.
pub fn is_allowed(state: &OpenState, path: &str) -> bool {
    canonical(Path::new(path)).is_some_and(|p| state.inner.lock().unwrap().allowed.contains(&p))
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default()
}

/// What the page needs to play a file: a song's tags (its file name when it has none), or a video's parsed name.
fn describe(path: &Path, id: String) -> Option<Opened> {
    let shown = path.to_string_lossy().to_string();
    match formats::kind_of(path)? {
        MediaKind::Audio => {
            let track = library::read_track(path).map(|(t, _)| t).unwrap_or_else(|| LibTrack {
                id: String::new(),
                title: path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                artist: String::new(),
                album: String::new(),
                number: None,
                disc: None,
                year: None,
                duration: 0.0,
                path: shown.clone(),
                unplayable: false,
            });
            Some(Opened::Audio(LibTrack { id, path: shown, ..track }))
        }
        MediaKind::Video => {
            let name = file_name(path);
            let parsed = parse::parse(&name);
            Some(Opened::Video(LibVideo {
                id,
                title: parsed.title,
                year: parsed.year,
                season: parsed.season,
                episode: parsed.episode,
                file_name: name,
                path: shown,
            }))
        }
    }
}

/// Allows the files and describes them, in order (files that vanished or aren't media are left out).
fn admit(state: &OpenState, paths: &[PathBuf]) -> Vec<Opened> {
    let mut out = vec![];
    for p in paths {
        let Some(c) = canonical(p) else { continue };
        let id = format!("o{}", state.next_id.fetch_add(1, Ordering::Relaxed));
        if let Some(item) = describe(p, id) {
            state.inner.lock().unwrap().allowed.insert(c);
            out.push(item);
        }
    }
    out
}

/// Brings the main window forward, out of the taskbar if it was minimized.
fn raise(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Files arrived from the system. They're handed to the page once no more have come for `QUIET`.
pub fn receive(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    let state = app.state::<OpenState>();
    state.inner.lock().unwrap().incoming.extend(paths);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIET);
        let state = app.state::<OpenState>();
        if state.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let batch = std::mem::take(&mut state.inner.lock().unwrap().incoming);
        let items = admit(&state, &batch);
        if items.is_empty() {
            return;
        }
        state.inner.lock().unwrap().pending.extend(items);
        let _ = app.emit_to("main", EVENT, ());
        raise(&app);
    });
}

/// At a cold start: the files on the command line.
pub fn receive_launch(app: &AppHandle) {
    let args: Vec<String> = std::env::args().collect();
    let cwd = std::env::current_dir().unwrap_or_default();
    let paths = paths_from_args(&args, &cwd);
    if !paths.is_empty() {
        app.state::<OpenState>().inner.lock().unwrap().launched_with_files = true;
        receive(app, paths);
    }
}

/// Whether the app was started with files (they arrive a moment later): the page then opens on the player.
#[tauri::command]
pub fn open_launched(state: tauri::State<'_, OpenState>) -> bool {
    state.inner.lock().unwrap().launched_with_files
}

/// The batch of opened files waiting for the page, emptied by the call.
#[tauri::command]
pub fn open_take(state: tauri::State<'_, OpenState>) -> Vec<Opened> {
    std::mem::take(&mut state.inner.lock().unwrap().pending)
}

/// The Open dialog: the files picked, allowed and described; empty when cancelled.
#[tauri::command]
pub async fn open_pick(app: AppHandle, title: String, audio_label: String, video_label: String) -> Result<Vec<Opened>, String> {
    use tauri_plugin_dialog::DialogExt;
    let audio = formats::extensions(MediaKind::Audio);
    let video = formats::extensions(MediaKind::Video);
    let all: Vec<&str> = audio.iter().chain(video.iter()).copied().collect();
    let picked = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter(format!("{audio_label} · {video_label}"), &all)
        .add_filter(audio_label, &audio)
        .add_filter(video_label, &video)
        .blocking_pick_files();
    let paths: Vec<PathBuf> = picked.unwrap_or_default().into_iter().filter_map(|f| f.into_path().ok()).collect();
    Ok(admit(&app.state::<OpenState>(), &paths))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pastel-open-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn keeps_existing_media_files_and_reads_relative_paths_against_the_launch_folder() {
        let d = temp_dir("args");
        for f in ["a song.mp3", "Movie (2019).mkv", "notes.txt"] {
            std::fs::write(d.join(f), b"x").unwrap();
        }
        let args: Vec<String> = ["app.exe", "--flag", "a song.mp3", "notes.txt", "missing.mkv"]
            .iter()
            .map(|s| s.to_string())
            .chain([d.join("Movie (2019).mkv").to_string_lossy().to_string()])
            .collect();
        let got = paths_from_args(&args, &d);
        assert_eq!(got, vec![d.join("a song.mp3"), d.join("Movie (2019).mkv")]);
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn admits_only_described_files_and_allows_exactly_those() {
        let d = temp_dir("admit");
        let video = d.join("Some.Film.2019.1080p.BluRay.x265.mkv");
        let song = d.join("Untagged song.mp3");
        std::fs::write(&video, b"x").unwrap();
        std::fs::write(&song, b"not really audio").unwrap();
        let state = OpenState::default();
        let items = admit(&state, &[video.clone(), song.clone(), d.join("gone.mp4")]);
        assert_eq!(items.len(), 2);
        match &items[0] {
            Opened::Video(v) => {
                assert_eq!(v.title, "Some Film");
                assert_eq!(v.year, Some(2019));
            }
            other => panic!("expected a video, got {other:?}"),
        }
        match &items[1] {
            Opened::Audio(t) => assert_eq!(t.title, "Untagged song"),
            other => panic!("expected a song, got {other:?}"),
        }
        assert!(is_allowed(&state, &video.to_string_lossy()));
        assert!(is_allowed(&state, &song.to_string_lossy()));
        assert!(!is_allowed(&state, &d.join("other.mkv").to_string_lossy()));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
