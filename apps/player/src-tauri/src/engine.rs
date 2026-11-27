//! The playback engine: libmpv, loaded at run time, drawing into the main window behind the transparent page
//! (spikes S1 and S7). The app starts without the DLL; the engine is created on the first `engine_load`.

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

#[cfg(windows)]
pub(crate) mod mpv {
    use libloading::Library;
    use std::ffi::{c_char, c_int, c_void, CStr, CString};

    pub struct Mpv {
        _lib: Library,
        h: *mut c_void,
        command: unsafe extern "C" fn(*mut c_void, *const *const c_char) -> c_int,
        set_prop: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int,
        get_prop: unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_char,
        free: unsafe extern "C" fn(*mut c_void),
        wait_event: unsafe extern "C" fn(*mut c_void, f64) -> *const Event,
        error_string: unsafe extern "C" fn(c_int) -> *const c_char,
        terminate: unsafe extern "C" fn(*mut c_void),
    }

    /// Where an engine puts its picture.
    pub enum Output<'a> {
        /// The app's window: the player.
        Window(isize),
        /// Nowhere, and no sound either: the tests.
        #[cfg_attr(not(test), allow(dead_code))]
        Nothing,
        /// One JPEG per frame shown, in this folder, with no sound: taking a frame out of a video (`frames.rs`).
        Images(&'a std::path::Path),
    }

    /// `mpv_event` and the start of `mpv_event_end_file`, from client.h (checked against the shipped header).
    #[repr(C)]
    pub struct Event {
        event_id: c_int,
        error: c_int,
        reply_userdata: u64,
        data: *mut c_void,
    }
    #[repr(C)]
    struct EndFile {
        reason: c_int,
        error: c_int,
    }
    const EVENT_NONE: c_int = 0;
    const EVENT_SHUTDOWN: c_int = 1;
    const EVENT_END_FILE: c_int = 7;
    const END_FILE_REASON_ERROR: c_int = 4;
    // The handle is only used behind the engine's mutex; libmpv's client API is thread-safe.
    unsafe impl Send for Mpv {}

    impl Mpv {
        pub fn new(dll: &std::path::Path, output: Output) -> Result<Mpv, String> {
            unsafe {
                let lib = Library::new(dll).map_err(|e| format!("could not load {}: {e}", dll.display()))?;
                let create: unsafe extern "C" fn() -> *mut c_void = *lib.get(b"mpv_create\0").map_err(|e| e.to_string())?;
                let init: unsafe extern "C" fn(*mut c_void) -> c_int = *lib.get(b"mpv_initialize\0").map_err(|e| e.to_string())?;
                let set_opt: unsafe extern "C" fn(*mut c_void, *const c_char, *const c_char) -> c_int =
                    *lib.get(b"mpv_set_option_string\0").map_err(|e| e.to_string())?;
                let command = *lib.get(b"mpv_command\0").map_err(|e| e.to_string())?;
                let set_prop = *lib.get(b"mpv_set_property_string\0").map_err(|e| e.to_string())?;
                let get_prop = *lib.get(b"mpv_get_property_string\0").map_err(|e| e.to_string())?;
                let free = *lib.get(b"mpv_free\0").map_err(|e| e.to_string())?;
                let wait_event = *lib.get(b"mpv_wait_event\0").map_err(|e| e.to_string())?;
                let error_string = *lib.get(b"mpv_error_string\0").map_err(|e| e.to_string())?;
                let terminate = *lib.get(b"mpv_terminate_destroy\0").map_err(|e| e.to_string())?;
                let h = create();
                if h.is_null() {
                    return Err("mpv_create failed".into());
                }
                let opt = |k: &str, v: &str| {
                    let (k, v) = (CString::new(k).unwrap(), CString::new(v).unwrap());
                    set_opt(h, k.as_ptr(), v.as_ptr())
                };
                match output {
                    Output::Window(wid) => {
                        opt("wid", &wid.to_string());
                        opt("vo", "gpu-next");
                        opt("gpu-context", "d3d11");
                    }
                    Output::Nothing => {
                        opt("vo", "null");
                        opt("ao", "null");
                    }
                    Output::Images(dir) => {
                        opt("vo", "image");
                        opt("vo-image-format", "jpg");
                        opt("vo-image-jpeg-quality", "92");
                        opt("vo-image-outdir", &dir.to_string_lossy());
                        opt("ao", "null");
                    }
                }
                // PASTEL_MPV_LOG=<file> writes mpv's own log, for diagnosing a file that will not play.
                if let Ok(log) = std::env::var("PASTEL_MPV_LOG") {
                    opt("log-file", &log);
                }
                // PASTEL_MPV_MUTE=1 starts muted: automated runs of the desktop build make no sound.
                if std::env::var_os("PASTEL_MPV_MUTE").is_some() {
                    opt("mute", "yes");
                }
                for (k, v) in [
                    ("hwdec", "auto-safe"),
                    ("keep-open", "yes"),
                    ("idle", "yes"),
                    ("osc", "no"),
                    ("osd-level", "0"),
                    // A song's embedded cover would otherwise be drawn as a picture behind the page.
                    ("audio-display", "no"),
                    ("force-window", "no"),
                    ("input-default-bindings", "no"),
                    ("input-vo-keyboard", "no"),
                    ("config", "no"),
                    ("terminal", "no"),
                    ("ytdl", "no"),
                    ("volume", "80"),
                    ("volume-max", "100"),
                    ("msg-level", "all=warn"),
                ] {
                    opt(k, v);
                }
                if matches!(output, Output::Images(_)) {
                    // One frame of each file, decoded in software (a frame on the graphics card can't be written
                    // out), from the nearest key frame (any frame near the asked moment will do), then the file ends.
                    // Two decoding threads: it works behind everything else.
                    for (k, v) in [("frames", "1"), ("hwdec", "no"), ("hr-seek", "no"), ("keep-open", "no"), ("aid", "no"), ("sid", "no"), ("vd-lavc-threads", "2")] {
                        opt(k, v);
                    }
                }
                let rc = init(h);
                if rc < 0 {
                    return Err(format!("mpv_initialize failed: {rc}"));
                }
                Ok(Mpv { _lib: lib, h, command, set_prop, get_prop, free, wait_event, error_string, terminate })
            }
        }

        /// Reads mpv's events on a thread of its own (the only reader, as mpv requires) and reports each file that
        /// ended in an error, with mpv's reason ("unrecognized file format", "loading failed"…). The handle outlives
        /// the thread: the engine is never destroyed while the app runs.
        pub fn watch_errors(&self, on_error: impl Fn(String) + Send + 'static) {
            let (h, wait, describe) = (self.h as usize, self.wait_event, self.error_string);
            std::thread::spawn(move || loop {
                let e = unsafe { &*wait(h as *mut c_void, -1.0) };
                match e.event_id {
                    EVENT_SHUTDOWN => break,
                    EVENT_END_FILE if !e.data.is_null() => {
                        let end = unsafe { &*(e.data as *const EndFile) };
                        if end.reason == END_FILE_REASON_ERROR {
                            on_error(unsafe { CStr::from_ptr(describe(end.error)) }.to_string_lossy().into_owned());
                        }
                    }
                    _ => {}
                }
            });
        }

        /// Waits for the file that was loaded to end, reading mpv's events on this thread: only for an engine nothing
        /// else reads the events of (`watch_errors` is the other reader). An error is mpv's reason.
        pub fn wait_end(&self, timeout: std::time::Duration) -> Result<(), String> {
            let until = std::time::Instant::now() + timeout;
            while std::time::Instant::now() < until {
                let e = unsafe { &*(self.wait_event)(self.h, 0.25) };
                match e.event_id {
                    EVENT_NONE => {}
                    EVENT_SHUTDOWN => return Err("the engine stopped".into()),
                    EVENT_END_FILE if !e.data.is_null() => {
                        let end = unsafe { &*(e.data as *const EndFile) };
                        return if end.reason == END_FILE_REASON_ERROR {
                            Err(unsafe { CStr::from_ptr((self.error_string)(end.error)) }.to_string_lossy().into_owned())
                        } else {
                            Ok(())
                        };
                    }
                    _ => {}
                }
            }
            Err("it took too long".into())
        }

        /// One frame of a video, from about `percent` of the way in, as the JPEG file an `Output::Images` engine
        /// leaves in `dir` (emptied first). A file that can't be sought that way (some transport streams) gives a
        /// frame from two seconds in, or its first.
        pub fn frame(&self, path: &str, percent: u8, dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
            let mut failure = String::new();
            // The last try asks for no place at all: a seek in a stream with one key frame finds nothing to show.
            for start in [format!("start={percent}%"), "start=2".to_string(), String::new()] {
                for old in std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
                    std::fs::remove_file(old.path()).ok();
                }
                self.set("pause", "no");
                let asked = if start.is_empty() { self.cmd(&["loadfile", path]) } else { self.cmd(&["loadfile", path, "replace", "-1", &start]) };
                if asked < 0 {
                    return Err("loadfile failed".into());
                }
                match self.wait_end(std::time::Duration::from_secs(30)) {
                    Ok(()) => {
                        let made = std::fs::read_dir(dir).map_err(|e| e.to_string())?.flatten().map(|e| e.path()).next();
                        match made {
                            Some(file) => return Ok(file),
                            None => failure = "no picture was written".into(),
                        }
                    }
                    Err(e) => {
                        // A file that is still open after the wait would write its frame into the next try
                        self.cmd(&["stop"]);
                        failure = e;
                    }
                }
            }
            Err(failure)
        }

        /// Ends the engine and frees it. Never for the player's engine: its event thread lives as long as the app.
        pub fn close(self) {
            unsafe { (self.terminate)(self.h) };
        }

        pub fn cmd(&self, args: &[&str]) -> c_int {
            let owned: Vec<CString> = args.iter().map(|a| CString::new(*a).unwrap_or_default()).collect();
            let mut ptrs: Vec<*const c_char> = owned.iter().map(|c| c.as_ptr()).collect();
            ptrs.push(std::ptr::null());
            unsafe { (self.command)(self.h, ptrs.as_ptr()) }
        }

        /// Loads a file: playing or paused, from its start or from `start` seconds in (for this file only).
        pub fn load(&self, path: &str, start: Option<f64>, paused: bool) -> c_int {
            self.set("pause", if paused { "yes" } else { "no" });
            match start {
                // loadfile <file> <flags> <index> <options>, as mpv 0.38 and later take it
                Some(s) if s > 0.0 => self.cmd(&["loadfile", path, "replace", "-1", &format!("start={s:.3}")]),
                _ => self.cmd(&["loadfile", path]),
            }
        }

        pub fn set(&self, k: &str, v: &str) -> c_int {
            let (k, v) = (CString::new(k).unwrap_or_default(), CString::new(v).unwrap_or_default());
            unsafe { (self.set_prop)(self.h, k.as_ptr(), v.as_ptr()) }
        }

        pub fn get(&self, k: &str) -> Option<String> {
            let k = CString::new(k).ok()?;
            unsafe {
                let p = (self.get_prop)(self.h, k.as_ptr());
                if p.is_null() {
                    return None;
                }
                let s = CStr::from_ptr(p).to_string_lossy().into_owned();
                (self.free)(p as *mut c_void);
                Some(s)
            }
        }
    }

    /// mpv makes its own child window when the first video loads; it has to sit behind the WebView.
    pub fn send_to_bottom(parent: isize) -> bool {
        use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM};
        use windows_sys::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetClassNameW, SetWindowPos, HWND_BOTTOM, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};
        unsafe extern "system" fn each(hwnd: HWND, found: LPARAM) -> BOOL {
            let mut buf = [0u16; 16];
            let n = GetClassNameW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            if String::from_utf16_lossy(&buf[..n.max(0) as usize]) == "mpv" {
                SetWindowPos(hwnd, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
                *(found as *mut bool) = true;
            }
            1
        }
        let mut found = false;
        unsafe { EnumChildWindows(parent as HWND, Some(each), &mut found as *mut bool as LPARAM) };
        found
    }
}

#[derive(Default)]
pub struct Engine {
    #[cfg(windows)]
    mpv: Mutex<Option<mpv::Mpv>>,
    #[cfg(not(windows))]
    mpv: Mutex<Option<()>>,
    error: Mutex<Option<String>>,
    /// The file the page asked for last, and the last file that failed to open (it arrives as mpv's event).
    last_path: Arc<Mutex<String>>,
    load_error: Arc<Mutex<Option<LoadError>>>,
}

/// A file mpv could not open: a number that grows with each failure (the page shows each one once), the file, and
/// mpv's reason.
#[derive(Clone, serde::Serialize)]
pub struct LoadError {
    pub seq: u64,
    pub path: String,
    pub reason: String,
}

/// The next failure after `previous`.
pub fn next_load_error(previous: Option<&LoadError>, path: String, reason: String) -> LoadError {
    LoadError { seq: previous.map_or(1, |e| e.seq + 1), path, reason }
}

/// Where libmpv may be: an override, beside the app (installed, with the DLL as a resource), or the repo's `lib/` in a dev build.
fn dll_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut list = vec![];
    if let Ok(p) = std::env::var("PASTEL_MPV_DLL") {
        list.push(PathBuf::from(p));
    }
    if let Ok(dir) = app.path().resource_dir() {
        list.push(dir.join("libmpv-2.dll"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            list.push(dir.join("libmpv-2.dll"));
        }
    }
    if cfg!(debug_assertions) || cfg!(feature = "test-media") {
        list.push(PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../lib/libmpv-2.dll")));
    }
    list
}

/// A second engine that writes frames of videos into `dir` as pictures (`frames.rs`); the player's is untouched.
#[cfg(windows)]
pub(crate) fn frame_engine(app: &AppHandle, dir: &std::path::Path) -> Result<mpv::Mpv, String> {
    let dll = dll_candidates(app).into_iter().find(|p| p.is_file()).ok_or("libmpv-2.dll was not found")?;
    mpv::Mpv::new(&dll, mpv::Output::Images(dir))
}

#[cfg(windows)]
fn ensure(app: &AppHandle, engine: &Engine) -> Result<(), String> {
    let mut slot = engine.mpv.lock().unwrap();
    if slot.is_some() {
        return Ok(());
    }
    let dll = dll_candidates(app).into_iter().find(|p| p.is_file()).ok_or("libmpv-2.dll was not found")?;
    let win = app.get_webview_window("main").ok_or("no main window")?;
    let hwnd = win.hwnd().map_err(|e| e.to_string())?.0 as isize;
    let mpv = mpv::Mpv::new(&dll, mpv::Output::Window(hwnd))?;
    let (last, failed) = (engine.last_path.clone(), engine.load_error.clone());
    mpv.watch_errors(move |reason| {
        let mut slot = failed.lock().unwrap();
        *slot = Some(next_load_error(slot.as_ref(), last.lock().unwrap().clone(), reason));
    });
    *slot = Some(mpv);
    Ok(())
}

/// Creates the engine at start, before the window's event loop runs, as spike S1 did: created later, from a
/// command, mpv waited forever on the window thread and never opened a file. Without the DLL the app still runs.
pub fn start(app: &AppHandle) {
    #[cfg(windows)]
    {
        let engine = app.state::<Engine>();
        if let Err(e) = ensure(app, &engine) {
            *engine.error.lock().unwrap() = Some(e);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
}

// The commands are async, so they run off the window's thread: mpv's embedded window needs that thread free.

/// Plays a file. Only files the system handed the app (`open::is_allowed`) or in the library
/// (`library::allowed`) may be opened: the page can't name any other path.
#[tauri::command]
pub async fn engine_load(
    app: AppHandle,
    engine: State<'_, Engine>,
    opened: State<'_, crate::open::OpenState>,
    path: String,
    start: Option<f64>,
    paused: Option<bool>,
) -> Result<(), String> {
    // A file that moved or sits on a drive that isn't connected: the page offers to find it ("file-missing" is the
    // word it knows this by).
    if !std::path::Path::new(&path).is_file() {
        return Err("file-missing".into());
    }
    if !crate::open::is_allowed(&opened, &path) && !crate::library::allowed(&app, &path) {
        // The library is only opened once a page shows it. The song the player greets with is asked for before
        // that: open the library, then look again.
        if crate::library::ensure_ready(&app).is_err() || !crate::library::allowed(&app, &path) {
            return Err("this file is outside the library".into());
        }
    }
    #[cfg(windows)]
    {
        if let Some(e) = engine.error.lock().unwrap().clone() {
            return Err(e);
        }
        *engine.last_path.lock().unwrap() = path.clone();
        let rc = engine.mpv.lock().unwrap().as_ref().map_or(-1, |m| m.load(&path, start, paused.unwrap_or(false)));
        if rc < 0 {
            return Err(format!("loadfile failed ({rc})"));
        }
        let parent = app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map_or(0, |h| h.0 as isize);
        std::thread::spawn(move || {
            for _ in 0..50 {
                if mpv::send_to_bottom(parent) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        });
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, engine, opened, start, paused);
        Err("playback is Windows-only for now".into())
    }
}

/// An mpv command such as `cycle pause`, `seek 10 relative` or `stop`.
#[tauri::command]
pub async fn engine_command(engine: State<'_, Engine>, args: Vec<String>) -> Result<i32, String> {
    #[cfg(windows)]
    {
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        Ok(engine.mpv.lock().unwrap().as_ref().map_or(-1, |m| m.cmd(&refs)))
    }
    #[cfg(not(windows))]
    {
        let _ = (engine, args);
        Ok(-1)
    }
}

#[tauri::command]
pub async fn engine_set(engine: State<'_, Engine>, name: String, value: String) -> Result<i32, String> {
    #[cfg(windows)]
    {
        Ok(engine.mpv.lock().unwrap().as_ref().map_or(-1, |m| m.set(&name, &value)))
    }
    #[cfg(not(windows))]
    {
        let _ = (engine, name, value);
        Ok(-1)
    }
}

/// The playback state the page polls; empty strings until something loads.
#[tauri::command]
pub async fn engine_status(engine: State<'_, Engine>) -> Result<Value, String> {
    let error = engine.error.lock().unwrap().clone();
    let load_error = engine.load_error.lock().unwrap().clone();
    #[cfg(windows)]
    {
        let guard = engine.mpv.lock().unwrap();
        let Some(m) = guard.as_ref() else { return Ok(json!({ "ready": false, "error": error })) };
        let g = |k: &str| m.get(k).unwrap_or_default();
        Ok(json!({
            "ready": true, "error": error, "loadError": load_error,
            "path": g("path"), "pos": g("time-pos"), "dur": g("duration"), "pause": g("pause"),
            "volume": g("volume"), "mute": g("mute"), "speed": g("speed"), "eof": g("eof-reached"),
            "idle": g("idle-active"), "buffering": g("paused-for-cache"), "video": g("vid"),
            // Diagnostics: frames really drawn, by which output, at what size.
            "fps": g("estimated-vf-fps"), "vo": g("current-vo"), "hwdec": g("hwdec-current"),
            "width": g("width"), "height": g("height"), "osdWidth": g("osd-width"), "osdHeight": g("osd-height"),
            // The picture as it is shown (aspect and rotation applied), and whether its window is up with a frame in it.
            "dwidth": g("dwidth"), "dheight": g("dheight"), "voReady": g("vo-configured"), "frame": g("estimated-frame-number"),
        }))
    }
    #[cfg(not(windows))]
    {
        let _ = load_error;
        Ok(json!({ "ready": false, "error": error }))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::mpv::{Mpv, Output};
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    /// Eight seconds of silence as a WAV file (8 kHz, mono, 8 bit).
    fn silence() -> PathBuf {
        let data = vec![0x80u8; 64_000];
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&(36 + data.len() as u32).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        for v in [16u32, 0x0001_0001, 8000, 8000, 0x0008_0001] {
            wav.extend_from_slice(&v.to_le_bytes());
        }
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(data.len() as u32).to_le_bytes());
        wav.extend_from_slice(&data);
        let path = std::env::temp_dir().join(format!("pmp-engine-{}.wav", std::process::id()));
        std::fs::write(&path, wav).unwrap();
        path
    }

    fn wait_for(m: &Mpv, what: impl Fn(&Mpv) -> bool) -> bool {
        let until = Instant::now() + Duration::from_secs(8);
        while Instant::now() < until {
            if what(m) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        false
    }
    fn pos(m: &Mpv) -> Option<f64> {
        m.get("time-pos")?.parse().ok()
    }

    /// The real engine, with no window and no sound. Skipped where the DLL isn't (it is not in the repository).
    #[test]
    fn loads_at_a_position_and_paused_when_asked() {
        let dll = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../lib/libmpv-2.dll"));
        if !dll.is_file() {
            eprintln!("skipped: no libmpv-2.dll in lib/");
            return;
        }
        let m = Mpv::new(&dll, Output::Nothing).expect("the engine starts without a window");
        let file = silence();
        let path = file.to_string_lossy().to_string();

        // Paused, three seconds in: it waits there
        assert!(m.load(&path, Some(3.0), true) >= 0);
        assert!(wait_for(&m, |m| pos(m).is_some()), "the file loads");
        std::thread::sleep(Duration::from_millis(400));
        let at = pos(&m).unwrap();
        assert!((2.8..=3.2).contains(&at), "paused at the asked position, was at {at}");
        assert_eq!(m.get("pause").as_deref(), Some("yes"));

        // The next file plays from its start: the position was for that one load
        assert!(m.load(&path, None, false) >= 0);
        assert!(wait_for(&m, |m| pos(m).is_some_and(|p| p > 0.2 && p < 2.5)), "plays from the start, at {:?}", pos(&m));
        assert_eq!(m.get("pause").as_deref(), Some("no"));

        // Playing, from a position
        assert!(m.load(&path, Some(5.0), false) >= 0);
        assert!(wait_for(&m, |m| pos(m).is_some_and(|p| p >= 5.0)), "plays from five seconds, at {:?}", pos(&m));
        m.cmd(&["stop"]);
        std::fs::remove_file(file).ok();
    }

    /// The test videos: the repository's `corpus/` (it is not in the repository), or the folder `PASTEL_CORPUS` names.
    fn corpus() -> Option<PathBuf> {
        let dir = std::env::var("PASTEL_CORPUS").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../corpus")));
        dir.is_dir().then_some(dir)
    }

    /// A second engine with no window writes one frame of a video as a JPEG, for each kind of file in the corpus.
    #[test]
    fn writes_one_frame_of_a_video() {
        let dll = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../lib/libmpv-2.dll"));
        let (true, Some(corpus)) = (dll.is_file(), corpus()) else {
            eprintln!("skipped: no libmpv-2.dll in lib/, or no corpus");
            return;
        };
        let out = std::env::temp_dir().join(format!("pmp-frames-{}", std::process::id()));
        std::fs::create_dir_all(&out).unwrap();
        let m = Mpv::new(&dll, Output::Images(&out)).expect("the engine starts with pictures as its output");
        let mut report = vec![];
        for name in ["h264.mp4", "hevc.mp4", "h264-10bit.mkv", "hevc-10bit.mkv", "av1.mkv", "vp9.webm", "mpeg4.avi", "h264.ts", "portrait.mp4"] {
            let file = corpus.join("video").join(name);
            if !file.is_file() {
                continue;
            }
            let began = Instant::now();
            let frame = m.frame(&file.to_string_lossy(), 40, &out);
            let size = frame.as_ref().ok().and_then(|f| image::image_dimensions(f).ok());
            report.push(format!("{name}: {size:?}, {} ms", began.elapsed().as_millis()));
            assert!(frame.is_ok(), "{name} gives a frame: {frame:?}");
            assert!(size.is_some_and(|(w, h)| w > 0 && h > 0), "{name}'s picture can be read");
        }
        eprintln!("{}", report.join("\n"));
        assert!(!report.is_empty(), "the corpus has videos");
        m.close();
        std::fs::remove_dir_all(out).ok();
    }
}
