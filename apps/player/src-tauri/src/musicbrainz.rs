//! Album covers from MusicBrainz and the Cover Art Archive (their documentation as read on 2026-11-27), for
//! albums with no cover in their files or folder, and only when the person switched that on (Settings → Online;
//! off until then). No key is needed. What is sent: an album's artist and title.
//!
//! MusicBrainz asks for one call a second at most and a user agent that says who is asking (`online::Http`).
//! An album is looked up when a page first shows it without a cover, never the whole library at once.

use crate::db::{self, Db};
use crate::library;
use crate::online::{self, Failure, Http};
use crate::tmdb::same_name;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// The setting that switches this on.
pub const SETTING: &str = "album_covers_online";
/// MusicBrainz: "never more than one call per second".
const BETWEEN_CALLS: Duration = Duration::from_millis(1100);
const ANNOUNCE_EVERY: Duration = Duration::from_secs(10);

/// What an album is kept under: its artist and title, folded ("" for a compilation's artist).
pub fn album_key(artist: &str, title: &str) -> String {
    format!("{}|{}", crate::parse::series_key(artist), crate::parse::series_key(title))
}

/// A release group MusicBrainz found.
#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    pub mbid: String,
    pub year: Option<u16>,
}

/// A name inside a Lucene phrase.
fn phrase(s: &str) -> String {
    s.replace('\\', " ").replace('"', " ")
}

/// The release group that is this album, or nothing when MusicBrainz has no plain answer: its title must be the
/// album's and, for an album with an artist, one of its credited artists must be that artist.
pub fn search(http: &Http, artist: &str, title: &str) -> Result<Option<Group>, Failure> {
    let base = online::base("MUSICBRAINZ", "https://musicbrainz.org/ws/2");
    let query = if artist.is_empty() { format!("releasegroup:\"{}\"", phrase(title)) } else { format!("artist:\"{}\" AND releasegroup:\"{}\"", phrase(artist), phrase(title)) };
    let answer = http.json(&format!("{base}/release-group/"), &[("query", &query), ("fmt", "json"), ("limit", "8")], None)?;
    let groups = answer.get("release-groups").and_then(Value::as_array).cloned().unwrap_or_default();
    let credited = |g: &Value| {
        let credits = g.get("artist-credit").and_then(Value::as_array).cloned().unwrap_or_default();
        artist.is_empty() || credits.iter().any(|c| c.get("name").or_else(|| c.get("artist").and_then(|a| a.get("name"))).and_then(Value::as_str).is_some_and(|n| same_name(n, artist)))
    };
    Ok(groups.iter().find(|g| g.get("title").and_then(Value::as_str).is_some_and(|t| same_name(t, title)) && credited(g)).and_then(|g| {
        Some(Group { mbid: g.get("id")?.as_str()?.to_string(), year: g.get("first-release-date").and_then(Value::as_str).and_then(|d| d.get(..4)?.parse().ok()).filter(|y| *y > 1800) })
    }))
}

/// A release group's front cover, 500 px, from the Cover Art Archive; nothing when it has none (404).
pub fn front_cover(http: &Http, mbid: &str) -> Result<Option<Vec<u8>>, Failure> {
    let base = online::base("COVERART", "https://coverartarchive.org");
    match http.bytes(&format!("{base}/release-group/{mbid}/front-500")) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(Failure::NotFound) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Keeps a fetched cover in the image cache, marked `caa`; its hash.
fn keep_cover(conn: &Connection, cache: &Path, bytes: &[u8]) -> Option<String> {
    let img = image::load_from_memory(bytes).ok()?;
    let rgb = image::DynamicImage::ImageRgb8(img.thumbnail(500, 500).to_rgb8());
    let mut jpeg = vec![];
    rgb.write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 86)).ok()?;
    let mut h = blake3::Hasher::new();
    h.update(b"cover");
    h.update(&jpeg);
    let hash = h.finalize().to_hex()[..32].to_string();
    let file = cache.join(format!("{hash}.jpg"));
    std::fs::write(&file, &jpeg).ok()?;
    conn.execute(
        "INSERT OR IGNORE INTO images(hash, kind, path, w, h, bytes, last_used_at, origin) VALUES (?1, 'cover', ?2, ?3, ?4, ?5, ?6, 'caa')",
        params![hash, file.to_string_lossy(), rgb.width(), rgb.height(), jpeg.len() as i64, db::now()],
    )
    .ok()?;
    Some(hash)
}

/// Looks one album up and keeps what was found; whether a cover was found. `pause` waits between the two calls.
pub fn look_up(conn: &Connection, cache: &Path, http: &Http, artist: &str, title: &str, pause: impl Fn()) -> Result<bool, Failure> {
    let key = album_key(artist, title);
    let note = |state: &str, group: Option<&Group>, cover: Option<&str>| {
        let _ = conn.execute(
            "INSERT OR REPLACE INTO album_art(key, state, mbid, cover, year, tried_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![key, state, group.map(|g| g.mbid.as_str()), cover, group.and_then(|g| g.year), db::now()],
        );
    };
    let Some(group) = search(http, artist, title)? else {
        note("none", None, None);
        return Ok(false);
    };
    pause();
    let cover = front_cover(http, &group.mbid)?.and_then(|bytes| keep_cover(conn, cache, &bytes));
    note(if cover.is_some() { "found" } else { "none" }, Some(&group), cover.as_deref());
    Ok(cover.is_some())
}

// ---------------------------------------------------------------------------------------------------------------
// The queue: one album at a time, asked for by the pages that show them

#[derive(Default)]
pub struct Covers {
    /// (album id of this session, artist, title)
    queue: Mutex<VecDeque<(String, String, String)>>,
    known: Mutex<HashSet<String>>,
    wake: Condvar,
    started: AtomicBool,
}

fn images_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("images");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// An album with no cover of its own, as a page asks for it: the cover found online before, as a small JPEG data
/// URL; or nothing, and when the person switched online covers on, the album is queued to be looked up.
pub fn cover_for(app: &AppHandle, album_id: &str) -> Option<String> {
    let (artist, title) = library::album_named(app, album_id)?;
    if title.trim().is_empty() {
        return None;
    }
    let key = album_key(&artist, &title);
    let (row, on): (Option<(String, Option<String>)>, bool) = {
        let db = app.state::<Db>();
        let conn = db.conn().ok()?;
        (
            conn.query_row("SELECT state, cover FROM album_art WHERE key = ?1", [&key], |r| Ok((r.get(0)?, r.get(1)?))).optional().ok().flatten(),
            online::setting(&conn, SETTING).as_deref() == Some("1"),
        )
    };
    match row {
        Some((state, Some(hash))) if state == "found" => {
            let img = image::open(images_dir(app).join(format!("{hash}.jpg"))).ok()?;
            let mut jpeg = vec![];
            image::DynamicImage::ImageRgb8(img.thumbnail(256, 256).to_rgb8()).write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 82)).ok()?;
            Some(format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg)))
        }
        // Asked before and nothing found: not asked again by itself.
        Some((state, _)) if state != "failed" => None,
        _ => {
            if on {
                let state = app.state::<Covers>();
                if state.known.lock().unwrap().insert(key) {
                    state.queue.lock().unwrap().push_back((album_id.to_string(), artist, title));
                    if !state.started.swap(true, Ordering::SeqCst) {
                        let app = app.clone();
                        std::thread::Builder::new().name("covers".into()).spawn(move || worker(app)).ok();
                    }
                    state.wake.notify_one();
                }
            }
            None
        }
    }
}

fn announce(app: &AppHandle) {
    library::forget_library(app);
    let _ = app.emit("library://changed", ());
}

fn worker(app: AppHandle) {
    let state = app.state::<Covers>();
    let cache = images_dir(&app);
    let http = Http::new();
    let mut conn: Option<Connection> = None;
    let (mut found, mut failures, mut announced) = (0usize, 0usize, Instant::now());
    loop {
        let (album_id, artist, title) = {
            let mut queue = state.queue.lock().unwrap();
            loop {
                if let Some(next) = queue.pop_front() {
                    break next;
                }
                if found > 0 {
                    drop(queue);
                    announce(&app);
                    (found, announced) = (0, Instant::now());
                    queue = state.queue.lock().unwrap();
                    continue;
                }
                queue = state.wake.wait(queue).unwrap();
            }
        };
        if conn.is_none() {
            conn = app.state::<Db>().another().ok();
        }
        let Some(db) = conn.as_ref() else { continue };
        match look_up(db, &cache, &http, &artist, &title, || std::thread::sleep(BETWEEN_CALLS)) {
            Ok(true) => {
                failures = 0;
                found += 1;
                // The page asks for this album's cover again and gets the one that was found.
                library::forget_cover(&app, &album_id);
            }
            Ok(false) => failures = 0,
            Err(_) => {
                let _ = db.execute("INSERT OR REPLACE INTO album_art(key, state, tried_at) VALUES (?1, 'failed', ?2)", params![album_key(&artist, &title), db::now()]);
                state.known.lock().unwrap().remove(&album_key(&artist, &title));
                failures += 1;
                if failures >= 3 {
                    // No connection: what waits is dropped and asked again when its page is next shown.
                    let mut queue = state.queue.lock().unwrap();
                    let mut known = state.known.lock().unwrap();
                    for (_, a, t) in queue.drain(..) {
                        known.remove(&album_key(&a, &t));
                    }
                    failures = 0;
                }
            }
        }
        if found > 0 && announced.elapsed() > ANNOUNCE_EVERY {
            announce(&app);
            (found, announced) = (0, Instant::now());
        }
        std::thread::sleep(BETWEEN_CALLS);
    }
}

/// Settings → Online: look for the covers of albums that have none. Switching it on asks again for what got no
/// answer before.
#[tauri::command]
pub async fn online_set_album_covers(app: AppHandle, on: bool) -> Result<bool, String> {
    library::ensure_ready(&app)?;
    {
        let db = app.state::<Db>();
        let conn = db.conn()?;
        online::set_setting(&conn, SETTING, if on { "1" } else { "0" }).map_err(|e| e.to_string())?;
    }
    let state = app.state::<Covers>();
    state.queue.lock().unwrap().clear();
    state.known.lock().unwrap().clear();
    // Albums that were asked for a cover and had none are asked again by the pages.
    library::forget_missing_covers(&app);
    announce(&app);
    Ok(on)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::online::fake::Fake;

    fn jpeg() -> Vec<u8> {
        let img = image::RgbImage::from_pixel(600, 600, image::Rgb([90, 40, 160]));
        let mut out = vec![];
        image::DynamicImage::ImageRgb8(img).write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)).unwrap();
        out
    }

    const GROUPS: &str = r#"{"release-groups":[
        {"id":"aaa","score":"100","title":"Blue (Live)","first-release-date":"1999","artist-credit":[{"name":"Joni Mitchell","artist":{"name":"Joni Mitchell"}}]},
        {"id":"bbb","score":"95","title":"Blue","first-release-date":"1971-06-22","artist-credit":[{"name":"Joni Mitchell","artist":{"name":"Joni Mitchell"}}]},
        {"id":"ccc","score":"90","title":"Blue","first-release-date":"2001","artist-credit":[{"name":"Somebody Else","artist":{"name":"Somebody Else"}}]}]}"#;

    #[test]
    fn an_album_is_found_by_its_artist_and_title_and_its_cover_kept() {
        let fake = Fake::start(vec![("/ws/release-group/", 200, GROUPS.as_bytes().to_vec()), ("/caa/release-group/bbb/front-500", 200, jpeg())]);
        std::env::set_var("PASTEL_MUSICBRAINZ_URL", format!("{}/ws", fake.url));
        std::env::set_var("PASTEL_COVERART_URL", format!("{}/caa", fake.url));
        let http = Http::new();
        // The title must be the album's and the artist one of the credited ones
        assert_eq!(search(&http, "Joni Mitchell", "Blue").unwrap(), Some(Group { mbid: "bbb".into(), year: Some(1971) }));
        assert_eq!(search(&http, "Nobody", "Blue").unwrap(), None);
        assert_eq!(search(&http, "Joni Mitchell", "Court and Spark").unwrap(), None);
        let asked = fake.asked().into_iter().find(|a| a.contains("release-group/?")).unwrap();
        assert!(asked.contains("fmt=json") && asked.contains("releasegroup"), "{asked}");

        let mut conn = Connection::open_in_memory().unwrap();
        db::migrate(&mut conn).unwrap();
        let cache = std::env::temp_dir().join(format!("pmp-covers-{}", std::process::id()));
        std::fs::create_dir_all(&cache).unwrap();
        assert_eq!(look_up(&conn, &cache, &http, "Joni Mitchell", "Blue", || {}), Ok(true));
        let (state, cover, year): (String, String, u16) = conn.query_row("SELECT state, cover, year FROM album_art WHERE key = ?1", [album_key("joni mitchell", "BLUE")], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((state.as_str(), year), ("found", 1971));
        let (w, origin): (u32, String) = conn.query_row("SELECT w, origin FROM images WHERE hash = ?1", [&cover], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((w, origin.as_str()), (500, "caa"));
        assert!(cache.join(format!("{cover}.jpg")).is_file());
        // An album MusicBrainz doesn't have is remembered as asked
        assert_eq!(look_up(&conn, &cache, &http, "Nobody", "Blue", || {}), Ok(false));
        let state: String = conn.query_row("SELECT state FROM album_art WHERE key = ?1", [album_key("Nobody", "Blue")], |r| r.get(0)).unwrap();
        assert_eq!(state, "none");

        std::env::remove_var("PASTEL_MUSICBRAINZ_URL");
        std::env::remove_var("PASTEL_COVERART_URL");
        std::fs::remove_dir_all(cache).ok();
    }
}
