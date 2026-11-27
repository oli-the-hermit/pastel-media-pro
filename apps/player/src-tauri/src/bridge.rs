//! A debug-only bridge so the UI can be checked in a plain browser (the Claude desktop app's browser pane) against the
//! real Rust library and import code: the app runs without a window, and this answers the page's IPC over localhost.
//! `PASTEL_BRIDGE_PORT=<port>` starts it; release builds don't contain it. The page side is `src/devBridge.ts`, which
//! the dev server loads with `?bridge`; Vite proxies `/__bridge/` here.
//!
//! - `POST /invoke` `{ cmd, args }` → `{ ok }` or `{ err }`: the same command functions the window calls.
//! - `GET /events?after=N` → events (`import://job`, `library://changed`) and channel messages after `N`, waiting up
//!   to a few seconds for one.

use crate::{import, library};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::async_runtime::block_on as block;
use tauri::{AppHandle, Listener, Manager};

#[derive(Default)]
struct Queue {
    items: Mutex<Vec<Value>>,
    ready: Condvar,
}

impl Queue {
    fn push(&self, mut item: Value) {
        let mut items = self.items.lock().unwrap();
        item["seq"] = json!(items.len() + 1);
        items.push(item);
        self.ready.notify_all();
    }

    fn after(&self, seq: usize) -> Vec<Value> {
        let mut items = self.items.lock().unwrap();
        if items.len() <= seq {
            items = self.ready.wait_timeout(items, Duration::from_secs(5)).unwrap().0;
        }
        items.iter().skip(seq).cloned().collect()
    }
}

/// Starts the bridge when `PASTEL_BRIDGE_PORT` is set (debug builds only). Returns whether it started.
pub fn start(app: &AppHandle) -> bool {
    let Some(port) = std::env::var("PASTEL_BRIDGE_PORT").ok().and_then(|p| p.parse::<u16>().ok()) else { return false };
    let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) else { return false };
    let queue = Arc::new(Queue::default());
    for name in ["import://job", "library://changed"] {
        let q = queue.clone();
        app.listen_any(name, move |e| {
            let payload: Value = serde_json::from_str(e.payload()).unwrap_or(Value::Null);
            q.push(json!({ "kind": "event", "name": name, "payload": payload }));
        });
    }
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (app, queue) = (app.clone(), queue.clone());
            std::thread::spawn(move || {
                let _ = serve(stream, &app, &queue);
            });
        }
    });
    true
}

fn serve(mut stream: TcpStream, app: &AppHandle, queue: &Arc<Queue>) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    let target = line.split_whitespace().nth(1).unwrap_or("/").to_string();
    let mut length = 0;
    loop {
        let mut h = String::new();
        reader.read_line(&mut h)?;
        if h.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = h.split_once(':') {
            if k.eq_ignore_ascii_case("content-length") {
                length = v.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body)?;
    let reply = if target.starts_with("/invoke") {
        let req: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let cmd = req["cmd"].as_str().unwrap_or_default().to_string();
        match dispatch(app, queue, &cmd, &req["args"]) {
            Ok(v) => json!({ "ok": v }),
            Err(e) => json!({ "err": e }),
        }
    } else if target.starts_with("/events") {
        let after = target.split("after=").nth(1).and_then(|n| n.parse().ok()).unwrap_or(0);
        Value::Array(queue.after(after))
    } else {
        json!({ "err": "unknown path" })
    };
    let text = reply.to_string();
    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", text.len(), text)
}

fn arg<T: serde::de::DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null)).map_err(|e| format!("{name}: {e}"))
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

/// The commands the pages use, called as the window would call them.
fn dispatch(app: &AppHandle, queue: &Arc<Queue>, cmd: &str, args: &Value) -> Result<Value, String> {
    match cmd {
        "library_get" => to_value(block(library::library_get(app.clone()))?),
        "library_cover" => to_value(block(library::library_cover(app.state(), arg(args, "albumId")?))?),
        "library_image" => to_value(block(library::library_image(app.clone(), arg(args, "hash")?))?),
        "history_record" => to_value(block(crate::history::history_record(
            app.clone(),
            arg(args, "path")?,
            arg(args, "position")?,
            arg(args, "duration")?,
            arg(args, "ended")?,
            arg(args, "started")?,
        ))?),
        "history_list" => to_value(block(crate::history::history_list(app.clone()))?),
        "history_get" => to_value(block(crate::history::history_get(app.clone(), arg(args, "path")?))?),
        "playlists_list" => to_value(block(crate::playlists::playlists_list(app.clone()))?),
        "playlist_create" => to_value(block(crate::playlists::playlist_create(app.clone(), arg(args, "name")?, arg(args, "description")?))?),
        "playlist_update" => {
            to_value(block(crate::playlists::playlist_update(app.clone(), arg(args, "id")?, arg(args, "name")?, arg(args, "description")?))?)
        }
        "playlist_delete" => to_value(block(crate::playlists::playlist_delete(app.clone(), arg(args, "id")?))?),
        "playlist_set" => to_value(block(crate::playlists::playlist_set(app.clone(), arg(args, "id")?, arg(args, "paths")?))?),
        "import_pick_folder" => to_value(block(import::import_pick_folder(app.clone(), arg(args, "title")?))),
        "import_pick_files" => to_value(block(import::import_pick_files(app.clone(), arg(args, "title")?, arg(args, "audio")?, arg(args, "video")?))),
        "import_discover" => {
            // The page's Channel arrives as "__CHANNEL__:<id>"; its messages go out through the event queue.
            let id: String = arg(args, "onEvent")?;
            let id: u64 = id.trim_start_matches("__CHANNEL__:").parse().map_err(|_| "bad channel")?;
            let q = queue.clone();
            let channel = Channel::new(move |body| {
                let payload = match body {
                    InvokeResponseBody::Json(s) => serde_json::from_str(&s).unwrap_or(Value::Null),
                    InvokeResponseBody::Raw(_) => Value::Null,
                };
                q.push(json!({ "kind": "channel", "id": id, "payload": payload }));
                Ok(())
            });
            to_value(import::import_discover(app.clone(), arg(args, "folder")?, arg(args, "files")?, channel)?)
        }
        "import_discover_cancel" => to_value(import::import_discover_cancel(app.state(), arg(args, "id")?)),
        "import_start" => to_value(import::import_start(app.clone(), arg(args, "request")?)?),
        "import_jobs" => to_value(import::import_jobs(app.state())),
        "import_stop" => to_value(import::import_stop(app.state(), arg(args, "id")?)),
        "import_retry" => to_value(import::import_retry(app.clone(), arg(args, "id")?)?),
        "import_dismiss" => to_value(import::import_dismiss(app.clone(), arg(args, "id")?)),
        "import_clear_finished" => to_value(import::import_clear_finished(app.state())),
        "places_list" => to_value(import::places_list(app.clone())?),
        "places_rescan" => to_value(import::places_rescan(app.clone(), arg(args, "placeId")?)?),
        "places_remove" => to_value(import::places_remove(app.clone(), arg(args, "placeId")?)?),
        "open_launched" => Ok(json!(false)),
        "open_take" => Ok(json!([])),
        // Playback and the window itself aren't part of the bridge (no window, no engine).
        _ if cmd.starts_with("plugin:") => Ok(Value::Null),
        _ => Err(format!("{cmd} isn't available in the browser bridge")),
    }
}
