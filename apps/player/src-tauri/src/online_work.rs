//! Looking titles up, behind everything else, and the commands Settings → Online and a title page use.
//!
//! Nothing happens until a TMDB key was saved (that switches lookups on for every library folder; each folder has
//! its own switch after that). The worker has a database connection of its own, so the pages are never kept
//! waiting for an answer from the internet. `lookup.rs` decides what a file is and what is kept.

use crate::db::Db;
use crate::library::{self, Library};
use crate::lookup::{self, Ctx, EpisodeFile};
use crate::online::{self, Failure, Http};
use crate::tmdb::{self, Candidate, Kind, Tmdb};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// Shorter than this and with no year in its name, a video is a clip or a home video: not looked up.
const CLIP_SECONDS: f64 = 20.0 * 60.0;
const ANNOUNCE_EVERY: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, PartialEq)]
enum Job {
    Movie { file_id: i64, name: String, year: Option<u16> },
    Show { key: String, name: String, year: Option<u16>, episodes: Vec<EpisodeFile> },
}

impl Job {
    fn id(&self) -> String {
        match self {
            Job::Movie { file_id, .. } => format!("movie:{file_id}"),
            Job::Show { key, .. } => format!("show:{key}"),
        }
    }
}

#[derive(Default)]
pub struct Lookups {
    queue: Mutex<VecDeque<Job>>,
    known: Mutex<HashSet<String>>,
    wake: Condvar,
    started: AtomicBool,
    /// Why lookups stopped, when they did: the key was refused, or there is no connection.
    trouble: Mutex<Option<String>>,
}

fn file_id(video_id: &str) -> Option<i64> {
    video_id.strip_prefix('v')?.parse().ok()
}

/// Whether lookups are on at all: a key was saved and not taken away since.
fn switched_on(conn: &Connection) -> bool {
    online::setting(conn, "tmdb_on").as_deref() == Some("1")
}

/// The titles of a library that were not asked about yet, in the folders that allow it.
fn pending(conn: &Connection, lib: &Library) -> Vec<Job> {
    let asked: HashMap<(String, String), String> = conn
        .prepare("SELECT kind, key, state FROM lookups")
        .and_then(|mut st| st.query_map([], |r| Ok(((r.get(0)?, r.get(1)?), r.get(2)?))).map(|m| m.flatten().collect()))
        .unwrap_or_default();
    // A file added on its own belongs to no folder: it follows the main switch.
    let allowed: HashSet<i64> = conn
        .prepare("SELECT f.id FROM files f LEFT JOIN places p ON p.id = f.place_id WHERE f.kind = 'video' AND COALESCE(p.tmdb_enabled, 1) = 1")
        .and_then(|mut st| st.query_map([], |r| r.get(0)).map(|m| m.flatten().collect()))
        .unwrap_or_default();
    let open = |kind: &str, key: &str| asked.get(&(kind.to_string(), key.to_string())).is_none_or(|state| state == "failed");
    let mut jobs = vec![];
    for m in lib.movies.iter().filter(|m| !m.missing) {
        let Some(id) = file_id(&m.id) else { continue };
        let clip = m.year.is_none() && m.duration.is_some_and(|d| d < CLIP_SECONDS);
        if allowed.contains(&id) && !clip && open("movie", &id.to_string()) {
            jobs.push(Job::Movie { file_id: id, name: m.title.clone(), year: m.year });
        }
    }
    for s in &lib.series {
        let episodes: Vec<EpisodeFile> = s
            .episodes
            .iter()
            .filter(|e| !e.missing)
            .filter_map(|e| Some((file_id(&e.id).filter(|id| allowed.contains(id))?, e.season.unwrap_or(1), e.episode?)))
            .collect();
        if !episodes.is_empty() && open("show", &s.key) {
            jobs.push(Job::Show { key: s.key.clone(), name: s.title.clone(), year: s.year, episodes });
        }
    }
    jobs
}

/// Called with each library the pages are given: what was not asked about yet is queued.
pub fn after_library(app: &AppHandle, lib: &Library) {
    let jobs = {
        let db = app.state::<Db>();
        let Ok(conn) = db.conn() else { return };
        if !switched_on(&conn) {
            return;
        }
        pending(&conn, lib)
    };
    if jobs.is_empty() || online::key("tmdb").is_none() {
        return;
    }
    let state = app.state::<Lookups>();
    {
        let mut known = state.known.lock().unwrap();
        let mut queue = state.queue.lock().unwrap();
        for job in jobs {
            if known.insert(job.id()) {
                queue.push_back(job);
            }
        }
    }
    if !state.started.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        std::thread::Builder::new().name("lookups".into()).spawn(move || worker(app)).ok();
    }
    state.wake.notify_one();
}

fn images_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("images");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn announce(app: &AppHandle) {
    library::forget_library(app);
    let _ = app.emit("library://changed", ());
}

/// Everything waiting is dropped and may be asked again (a key, a language or a folder's switch changed).
fn start_over(app: &AppHandle) {
    let state = app.state::<Lookups>();
    state.queue.lock().unwrap().clear();
    state.known.lock().unwrap().clear();
    *state.trouble.lock().unwrap() = None;
}

/// After a change in Settings: the pages are told, and the library is read here too, so lookups start at once and
/// not only when a page that shows the library is opened.
fn restart(app: &AppHandle) {
    start_over(app);
    announce(app);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = library::library_get(app).await;
    });
}

fn run(ctx: &Ctx, job: &Job) -> Result<bool, Failure> {
    match job {
        Job::Movie { file_id, name, year } => lookup::movie(ctx, *file_id, name, *year),
        Job::Show { key, name, year, episodes } => lookup::show(ctx, key, name, *year, episodes),
    }
}

fn worker(app: AppHandle) {
    let state = app.state::<Lookups>();
    let cache = images_dir(&app);
    let http = Http::new();
    let mut conn: Option<Connection> = None;
    let (mut found, mut failures, mut announced) = (0usize, 0usize, Instant::now());
    loop {
        let job = {
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
        let (Some(db), Some(key)) = (conn.as_ref(), online::key("tmdb")) else {
            state.queue.lock().unwrap().clear();
            continue;
        };
        let omdb = online::key("omdb");
        let tmdb = Tmdb::new(&http, key, online::language(db));
        let ctx = Ctx { conn: db, cache: &cache, http: &http, tmdb: &tmdb, omdb: omdb.as_deref() };
        let mut outcome = run(&ctx, &job);
        if outcome == Err(Failure::Busy) {
            // Asked too fast: a pause, then once more.
            std::thread::sleep(Duration::from_secs(3));
            outcome = run(&ctx, &job);
        }
        match outcome {
            Ok(matched) => {
                failures = 0;
                found += matched as usize;
            }
            Err(Failure::Unauthorized) => {
                *state.trouble.lock().unwrap() = Some("key".into());
                state.queue.lock().unwrap().clear();
                state.known.lock().unwrap().clear();
            }
            Err(_) => {
                // No answer: tried again another time. Three in a row and the rest waits too (no connection).
                let (kind, key) = match &job {
                    Job::Movie { file_id, .. } => ("movie", file_id.to_string()),
                    Job::Show { key, .. } => ("show", key.clone()),
                };
                let _ = db.execute(
                    "INSERT INTO lookups(kind, key, state, tried_at) VALUES (?1, ?2, 'failed', ?3) ON CONFLICT(kind, key) DO UPDATE SET tried_at = excluded.tried_at",
                    params![kind, key, crate::db::now()],
                );
                failures += 1;
                if failures >= 3 {
                    *state.trouble.lock().unwrap() = Some("offline".into());
                    state.queue.lock().unwrap().clear();
                    state.known.lock().unwrap().clear();
                    failures = 0;
                }
            }
        }
        if found > 0 && announced.elapsed() > ANNOUNCE_EVERY {
            announce(&app);
            (found, announced) = (0, Instant::now());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Commands

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaceSwitch {
    pub id: i64,
    pub path: String,
    pub enabled: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// A key is saved (the key itself never leaves the keychain).
    pub tmdb_key: bool,
    pub omdb_key: bool,
    pub language: String,
    pub places: Vec<PlaceSwitch>,
    pub matched: u64,
    pub unmatched: u64,
    pub waiting: u64,
    /// "key" (the key was refused) or "offline", when lookups stopped.
    pub trouble: Option<String>,
    /// Covers of albums that have none are looked for at MusicBrainz (no key needed).
    pub album_covers: bool,
}

fn status(app: &AppHandle) -> Result<Status, String> {
    let db = app.state::<Db>();
    let conn = db.conn()?;
    let count = |state: &str| conn.query_row("SELECT count(*) FROM lookups WHERE state IN (SELECT value FROM json_each(?1))", [state], |r| r.get::<_, i64>(0)).unwrap_or(0) as u64;
    let places = conn
        .prepare("SELECT id, path, tmdb_enabled FROM places ORDER BY id")
        .and_then(|mut st| {
            st.query_map([], |r| Ok(PlaceSwitch { id: r.get(0)?, path: library::shown(std::path::Path::new(&r.get::<_, String>(1)?)), enabled: r.get(2)? })).map(|m| m.flatten().collect())
        })
        .unwrap_or_default();
    let lookups = app.state::<Lookups>();
    let waiting = lookups.queue.lock().unwrap().len() as u64;
    let trouble = lookups.trouble.lock().unwrap().clone();
    Ok(Status {
        tmdb_key: switched_on(&conn) && online::key("tmdb").is_some(),
        omdb_key: online::key("omdb").is_some(),
        language: online::language(&conn),
        places,
        matched: count(r#"["matched","chosen"]"#),
        unmatched: count(r#"["none"]"#),
        waiting,
        trouble,
        album_covers: online::setting(&conn, crate::musicbrainz::SETTING).as_deref() == Some("1"),
    })
}

/// Settings → Online: what is switched on, and how far the lookups are.
#[tauri::command]
pub async fn online_status(app: AppHandle) -> Result<Status, String> {
    library::ensure_ready(&app)?;
    status(&app)
}

/// Saves a key after the service accepted it (`key` given), or takes it away (`None`). Saving TMDB's switches
/// lookups on for every library folder; taking it away switches them off. What was found stays.
#[tauri::command]
pub async fn online_set_key(app: AppHandle, service: String, key: Option<String>) -> Result<Status, String> {
    library::ensure_ready(&app)?;
    let key = key.map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
    if let Some(k) = &key {
        let http = Http::new();
        let checked = match service.as_str() {
            "tmdb" => Tmdb::new(&http, k.clone(), "en-US".into()).check(),
            // A film OMDb is sure to have
            "omdb" => tmdb::imdb_rating(&http, k, "tt0133093").map(|_| ()),
            _ => return Err("no such service".into()),
        };
        match checked {
            Ok(()) => {}
            Err(Failure::Unauthorized) => return Err("key-refused".into()),
            Err(e) => return Err(format!("{e}")),
        }
        online::save_key(&service, k)?;
    } else {
        online::forget_key(&service)?;
    }
    {
        let db = app.state::<Db>();
        let conn = db.conn()?;
        if service == "tmdb" {
            online::set_setting(&conn, "tmdb_on", if key.is_some() { "1" } else { "0" }).map_err(|e| e.to_string())?;
            if key.is_some() {
                conn.execute("UPDATE places SET tmdb_enabled = 1", []).map_err(|e| e.to_string())?;
            }
        } else if key.is_some() {
            // Titles found before the key came are asked again, for their IMDb rating.
            conn.execute("DELETE FROM lookups WHERE state = 'matched'", []).map_err(|e| e.to_string())?;
        }
    }
    restart(&app);
    status(&app)
}

/// A library folder's own switch.
#[tauri::command]
pub async fn online_set_place(app: AppHandle, place_id: i64, enabled: bool) -> Result<Status, String> {
    library::ensure_ready(&app)?;
    app.state::<Db>().conn()?.execute("UPDATE places SET tmdb_enabled = ?2 WHERE id = ?1", params![place_id, enabled]).map_err(|e| e.to_string())?;
    restart(&app);
    status(&app)
}

/// The language titles and descriptions are asked in ("en-US", "es-ES"…). What was found is asked again in it.
#[tauri::command]
pub async fn online_set_language(app: AppHandle, language: String) -> Result<Status, String> {
    library::ensure_ready(&app)?;
    {
        let db = app.state::<Db>();
        let conn = db.conn()?;
        online::set_setting(&conn, "metadata_language", language.trim()).map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM lookups WHERE state = 'matched'", []).map_err(|e| e.to_string())?;
    }
    restart(&app);
    status(&app)
}

/// "Look up now": what found nothing, or got no answer, is asked again.
#[tauri::command]
pub async fn online_lookup_now(app: AppHandle) -> Result<Status, String> {
    library::ensure_ready(&app)?;
    app.state::<Db>().conn()?.execute("DELETE FROM lookups WHERE state IN ('none', 'failed')", []).map_err(|e| e.to_string())?;
    restart(&app);
    status(&app)
}

fn kind_of(kind: &str) -> Result<Kind, String> {
    match kind {
        "movie" => Ok(Kind::Movie),
        "show" => Ok(Kind::Show),
        _ => Err("no such kind".into()),
    }
}

/// "Not the right title?": TMDB's answers for what the person typed.
#[tauri::command]
pub async fn online_search(app: AppHandle, kind: String, query: String, year: Option<u16>) -> Result<Vec<Candidate>, String> {
    library::ensure_ready(&app)?;
    let key = online::key("tmdb").ok_or("no-key")?;
    let language = online::language(&*app.state::<Db>().conn()?);
    let http = Http::new();
    let mut found = Tmdb::new(&http, key, language).search(kind_of(&kind)?, query.trim(), year).map_err(|e| e.to_string())?;
    found.truncate(12);
    Ok(found)
}

/// The person's own answer for a film (`key` = its file's path) or a series (`key` = the series' key): a TMDB id
/// ("tmdb:603"), fetched at once, or `None` for "this has no match" (TMDB's words and pictures are taken away and
/// it is never asked again).
#[tauri::command]
pub async fn online_set_match(app: AppHandle, kind: String, key: String, external: Option<String>) -> Result<(), String> {
    library::ensure_ready(&app)?;
    let which = kind_of(&kind)?;
    // The series' episodes as the library has them now
    let episodes: Vec<EpisodeFile> = match which {
        Kind::Show => library::episodes_of(&app, &key),
        Kind::Movie => vec![],
    };
    let conn = app.state::<Db>().another()?;
    let (row_key, file) = match which {
        Kind::Movie => {
            let id: i64 = conn.query_row("SELECT id FROM files WHERE path = ?1", [&key], |r| r.get(0)).map_err(|_| "this file is not in the library")?;
            (id.to_string(), Some(id))
        }
        Kind::Show => (key.clone(), None),
    };
    match (which, file) {
        (Kind::Movie, Some(id)) => lookup::unmatch_movie(&conn, id),
        _ => lookup::unmatch_show(&conn, &row_key, &episodes.iter().map(|e| e.0).collect::<Vec<_>>()),
    }
    lookup::choose(&conn, &kind, &row_key, external.as_deref()).map_err(|e| e.to_string())?;
    if external.is_some() {
        let tmdb_key = online::key("tmdb").ok_or("no-key")?;
        let http = Http::new();
        let omdb = online::key("omdb");
        let tmdb = Tmdb::new(&http, tmdb_key, online::language(&conn));
        let cache = images_dir(&app);
        let ctx = Ctx { conn: &conn, cache: &cache, http: &http, tmdb: &tmdb, omdb: omdb.as_deref() };
        match file {
            Some(id) => lookup::movie(&ctx, id, "", None),
            None => lookup::show(&ctx, &row_key, "", None, &episodes),
        }
        .map_err(|e| e.to_string())?;
    }
    announce(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{LibSeries, LibVideo};

    #[test]
    fn only_what_was_not_asked_in_folders_that_allow_it_is_queued() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        conn.execute_batch(
            "INSERT INTO places(id, path, kind_hint, created_at, tmdb_enabled) VALUES (1, 'D:\\On', 'mixed', 1, 1), (2, 'D:\\Off', 'mixed', 1, 0);
             INSERT INTO files(id, place_id, path, size, mtime, kind, added_at, scanned_at) VALUES
               (1, 1, 'D:\\On\\a.mkv', 1, 1, 'video', 1, 1), (2, 2, 'D:\\Off\\b.mkv', 1, 1, 'video', 1, 1), (3, 1, 'D:\\On\\c.mkv', 1, 1, 'video', 1, 1),
               (4, NULL, 'D:\\Loose\\d.mkv', 1, 1, 'video', 1, 1), (5, 1, 'D:\\On\\clip.mkv', 1, 1, 'video', 1, 1), (6, 1, 'D:\\On\\e1.mkv', 1, 1, 'video', 1, 1),
               (7, 1, 'D:\\On\\gone.mkv', 1, 1, 'video', 1, 1), (8, 1, 'D:\\On\\again.mkv', 1, 1, 'video', 1, 1);
             INSERT INTO lookups(kind, key, state, tried_at) VALUES ('movie', '3', 'none', 1), ('movie', '8', 'failed', 1), ('show', 'asked', 'matched', 1);",
        )
        .unwrap();
        let film = |id: i64, more: LibVideo| LibVideo { id: format!("v{id}"), title: format!("Film {id}"), year: Some(2001), duration: Some(6000.0), ..more };
        let lib = Library {
            movies: vec![
                film(1, LibVideo::default()),
                film(2, LibVideo::default()),
                film(3, LibVideo::default()),
                film(4, LibVideo::default()),
                LibVideo { year: None, duration: Some(90.0), ..film(5, LibVideo::default()) },
                film(7, LibVideo { missing: true, ..Default::default() }),
                film(8, LibVideo::default()),
            ],
            series: vec![
                LibSeries { key: "dark".into(), title: "Dark".into(), episodes: vec![LibVideo { season: Some(1), episode: Some(1), ..film(6, LibVideo::default()) }], ..Default::default() },
                LibSeries { key: "asked".into(), title: "Asked".into(), episodes: vec![LibVideo { season: Some(1), episode: Some(1), ..film(6, LibVideo::default()) }], ..Default::default() },
            ],
            ..Default::default()
        };
        let ids: Vec<String> = pending(&conn, &lib).iter().map(Job::id).collect();
        // 2 is in a folder switched off, 3 found nothing before, 5 is a clip, 7 can't be found; 8 got no answer and is asked again
        assert_eq!(ids, ["movie:1", "movie:4", "movie:8", "show:dark"]);
        assert!(!switched_on(&conn));
        online::set_setting(&conn, "tmdb_on", "1").unwrap();
        assert!(switched_on(&conn));
    }
}
