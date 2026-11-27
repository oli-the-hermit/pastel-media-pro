//! Phase 3's import (ux.md §2b, architecture.md §4): **discover** a folder or some files (names and sizes streamed to
//! the review list over a Tauri `Channel`, then the quick probe's lengths and picture sizes), then **import** what was
//! kept as a job in the queue (fingerprint, tags or probe, the file name, `.nfo`/sidecar, folder art; one row per file
//! in `library.db`), and **rescan** the places (new files that pass the place's saved filters, changed files, files that
//! are gone). One worker thread runs the jobs in order; each can be stopped, and what failed can be retried.
//! Read-only on the person's folders, always: files are opened for reading and nothing is written beside them.

use crate::db::{self, Db};
use crate::filters::{self, Candidate, Filters};
use crate::formats::{self, MediaKind};
use crate::library::{self, LibTrack};
use crate::matching::{self, Details};
use crate::parse::{self, Kind, Parsed};
use crate::probe::{self, Probe};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

// ---------------------------------------------------------------------------------------------------------------
// Files on disk

/// A media file found by a walk.
#[derive(Clone, Debug)]
pub struct OnDisk {
    pub path: PathBuf,
    pub kind: MediaKind,
    pub size: u64,
    pub mtime: i64,
}

fn mtime_of(meta: &std::fs::Metadata) -> i64 {
    meta.modified().ok().and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0)
}

/// Every media file under a folder, in a stable order (hidden and system folders included: they are the person's).
pub fn walk(root: &Path, stop: &AtomicBool, mut each: impl FnMut(OnDisk)) {
    for e in WalkDir::new(root).sort_by_file_name().into_iter().filter_map(|e| e.ok()) {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        if !e.file_type().is_file() {
            continue;
        }
        let Some(kind) = formats::kind_of(e.path()) else { continue };
        let Ok(meta) = e.metadata() else { continue };
        each(OnDisk { path: e.path().to_path_buf(), kind, size: meta.len(), mtime: mtime_of(&meta) });
    }
}

pub fn kind_name(k: MediaKind) -> &'static str {
    match k {
        MediaKind::Audio => "audio",
        MediaKind::Video => "video",
    }
}

fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// The path below a place with `/`, or for a file added on its own, its last three parts ("Show/Season 1/x.mkv"):
/// enough for the file-name parser to see a season folder.
pub fn rel_of(root: Option<&Path>, p: &Path) -> String {
    let rel = match root.and_then(|r| p.strip_prefix(r).ok()) {
        Some(r) => r.to_path_buf(),
        None => {
            let parts: Vec<_> = p.components().rev().take(3).collect();
            parts.into_iter().rev().collect()
        }
    };
    rel.to_string_lossy().replace('\\', "/")
}

/// Size plus blake3 of the first and last 64 KB: re-links a moved or renamed file without reading it again (S6).
pub fn fingerprint(path: &Path, size: u64) -> Option<String> {
    const CHUNK: u64 = 64 * 1024;
    let mut f = std::fs::File::open(path).ok()?;
    let mut h = blake3::Hasher::new();
    h.update(&size.to_le_bytes());
    let mut buf = vec![0u8; CHUNK.min(size) as usize];
    f.read_exact(&mut buf).ok()?;
    h.update(&buf);
    if size > CHUNK {
        let tail = CHUNK.min(size - CHUNK);
        f.seek(SeekFrom::Start(size - tail)).ok()?;
        let mut buf = vec![0u8; tail as usize];
        f.read_exact(&mut buf).ok()?;
        h.update(&buf);
    }
    Some(h.finalize().to_hex()[..32].to_string())
}

/// A song's length without its tags, for the review list.
fn audio_seconds(path: &Path) -> Option<f64> {
    use lofty::config::ParseOptions;
    use lofty::file::AudioFile;
    let tf = lofty::probe::Probe::open(path).ok()?.options(ParseOptions::new().read_tags(false).read_cover_art(false)).read().ok()?;
    let d = tf.properties().duration().as_secs_f64();
    (d > 0.0).then_some(d)
}

/// The quick probe of one file (S8): a video's header, a song's properties.
pub fn quick_probe(kind: MediaKind, path: &Path) -> Probe {
    match kind {
        MediaKind::Video => probe::probe(path).unwrap_or_default(),
        MediaKind::Audio => Probe { duration: audio_seconds(path), ..Default::default() },
    }
}

/// Runs `f` over `items` on a few threads, keeping the order.
fn par_map<T: Sync, U: Send>(items: &[T], threads: usize, f: impl Fn(&T) -> U + Sync) -> Vec<U> {
    if items.len() < 2 || threads < 2 {
        return items.iter().map(&f).collect();
    }
    let size = items.len().div_ceil(threads);
    std::thread::scope(|s| {
        let handles: Vec<_> = items.chunks(size).map(|c| s.spawn(|| c.iter().map(&f).collect::<Vec<U>>())).collect();
        handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
    })
}

// ---------------------------------------------------------------------------------------------------------------
// Discovery (the review list's rows)

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub i: u32,
    pub path: String,
    pub rel: String,
    pub name: String,
    pub ext: String,
    pub kind: &'static str,
    pub size: u64,
    /// Already in the library.
    pub in_library: bool,
    /// Unchecked in an earlier review of this place.
    pub skipped: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Fact {
    pub i: u32,
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum DiscoverEvent {
    /// Names and sizes, in batches as the walk goes.
    Found { files: Vec<Found> },
    /// The walk is over.
    Listed { total: usize, ms: u64 },
    /// Lengths and picture sizes, in batches as the probe goes.
    Probed { facts: Vec<Fact> },
    Done { ms: u64 },
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiscoverStart {
    pub id: u64,
    /// The folder as people see it (None for files).
    pub folder: Option<String>,
    /// The folder is a place already (or inside one): its saved filters, to start the review list from.
    pub filters: Option<Filters>,
    /// The place the folder belongs to, shown, when it is inside one already.
    pub inside: Option<String>,
}

struct Discovery {
    stop: Arc<AtomicBool>,
}

fn discover_thread(
    files: Vec<OnDisk>,
    root: Option<PathBuf>,
    walk_root: bool,
    known: HashSet<String>,
    skipped: HashSet<String>,
    stop: Arc<AtomicBool>,
    channel: Channel<DiscoverEvent>,
) {
    let started = Instant::now();
    let mut all: Vec<OnDisk> = files;
    let mut batch = vec![];
    let mut last = Instant::now();
    let send = |batch: &mut Vec<Found>, force: bool, last: &mut Instant| {
        if !batch.is_empty() && (force || batch.len() >= 500 || last.elapsed() > Duration::from_millis(120)) {
            let _ = channel.send(DiscoverEvent::Found { files: std::mem::take(batch) });
            *last = Instant::now();
        }
    };
    let found = |i: usize, f: &OnDisk| {
        let p = path_string(&f.path);
        Found {
            i: i as u32,
            rel: rel_of(root.as_deref(), &f.path),
            name: f.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
            ext: f.path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default(),
            kind: kind_name(f.kind),
            size: f.size,
            in_library: known.contains(&p),
            skipped: skipped.contains(&p),
            path: p,
        }
    };
    if walk_root {
        if let Some(root) = &root {
            walk(root, &stop, |f| {
                batch.push(found(all.len(), &f));
                all.push(f);
                send(&mut batch, false, &mut last);
            });
        }
    } else {
        for (i, f) in all.iter().enumerate() {
            batch.push(found(i, f));
        }
    }
    send(&mut batch, true, &mut last);
    let _ = channel.send(DiscoverEvent::Listed { total: all.len(), ms: started.elapsed().as_millis() as u64 });

    // The quick probe, videos first (their length decides most filters), a chunk at a time.
    let mut order: Vec<usize> = (0..all.len()).collect();
    order.sort_by_key(|&i| all[i].kind != MediaKind::Video);
    for chunk in order.chunks(64) {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let facts = par_map(chunk, 4, |&i| {
            let p = quick_probe(all[i].kind, &all[i].path);
            Fact { i: i as u32, duration: p.duration, width: p.width, height: p.height }
        });
        let _ = channel.send(DiscoverEvent::Probed { facts });
    }
    let _ = channel.send(DiscoverEvent::Done { ms: started.elapsed().as_millis() as u64 });
}

// ---------------------------------------------------------------------------------------------------------------
// Places

#[derive(Clone, Debug)]
pub struct Place {
    pub id: i64,
    pub root: PathBuf,
    pub filters: Filters,
}

fn csv(v: &Option<Vec<String>>) -> Option<String> {
    v.as_ref().map(|v| v.join(","))
}

fn uncsv(s: Option<String>) -> Option<Vec<String>> {
    s.map(|s| s.split(',').filter(|x| !x.is_empty()).map(String::from).collect())
}

pub fn save_filters(conn: &Connection, place_id: i64, f: &Filters) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO place_filters(place_id, preset, kinds, min_duration_s, max_duration_s, min_bytes, max_bytes, min_height, extensions, name_rules)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            place_id,
            f.preset,
            csv(&f.kinds),
            f.min_duration.map(|d| d as i64),
            f.max_duration.map(|d| d as i64),
            f.min_bytes.map(|b| b as i64),
            f.max_bytes.map(|b| b as i64),
            f.min_height,
            csv(&f.extensions),
            f.skip_extras.then_some("skip-extras"),
        ],
    )?;
    Ok(())
}

pub fn load_filters(conn: &Connection, place_id: i64) -> Option<Filters> {
    conn.query_row(
        "SELECT preset, kinds, min_duration_s, max_duration_s, min_bytes, max_bytes, min_height, extensions, name_rules FROM place_filters WHERE place_id = ?1",
        [place_id],
        |r| {
            Ok(Filters {
                preset: r.get(0)?,
                kinds: uncsv(r.get(1)?),
                min_duration: r.get::<_, Option<i64>>(2)?.map(|d| d as f64),
                max_duration: r.get::<_, Option<i64>>(3)?.map(|d| d as f64),
                min_bytes: r.get::<_, Option<i64>>(4)?.map(|b| b as u64),
                max_bytes: r.get::<_, Option<i64>>(5)?.map(|b| b as u64),
                min_height: r.get(6)?,
                extensions: uncsv(r.get(7)?),
                skip_extras: r.get::<_, Option<String>>(8)?.is_some_and(|n| n.contains("skip-extras")),
            })
        },
    )
    .optional()
    .ok()
    .flatten()
}

pub fn places(conn: &Connection) -> Vec<Place> {
    let Ok(mut st) = conn.prepare("SELECT id, path FROM places ORDER BY id") else { return vec![] };
    let rows: Vec<(i64, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|m| m.flatten().collect()).unwrap_or_default();
    rows.into_iter().map(|(id, path)| Place { id, root: PathBuf::from(path), filters: load_filters(conn, id).unwrap_or_else(Filters::everything) }).collect()
}

/// The place a new folder becomes: a folder inside a place belongs to it; a folder around places takes them in
/// (their files move to it, nothing is read twice). Returns the place's id.
pub fn adopt_folder(conn: &Connection, folder: &Path, filters: &Filters) -> rusqlite::Result<i64> {
    let all = places(conn);
    if let Some(outer) = all.iter().find(|p| folder.starts_with(&p.root)) {
        return Ok(outer.id);
    }
    conn.execute("INSERT INTO places(path, kind_hint, created_at) VALUES (?1, ?2, ?3)", params![path_string(folder), kind_hint(filters), db::now()])?;
    let id = conn.last_insert_rowid();
    save_filters(conn, id, filters)?;
    for inner in all.iter().filter(|p| p.root.starts_with(folder)) {
        conn.execute("UPDATE files SET place_id = ?1 WHERE place_id = ?2", params![id, inner.id])?;
        conn.execute("UPDATE skipped SET place_id = ?1 WHERE place_id = ?2", params![id, inner.id])?;
        conn.execute("DELETE FROM places WHERE id = ?1", [inner.id])?;
    }
    Ok(id)
}

fn kind_hint(f: &Filters) -> &'static str {
    match f.kinds.as_deref() {
        Some([k]) if k == "audio" => "music",
        Some([k]) if k == "video" => "video",
        _ => "mixed",
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading one file

/// An image found beside a video, made small once (a poster 342 px wide, a backdrop 1280), named by its hash.
pub struct Picture {
    pub hash: String,
    pub kind: &'static str,
    /// The resized JPEG, or `None` when the cache has it already.
    pub jpeg: Option<(Vec<u8>, u32, u32)>,
}

pub struct VideoFacts {
    pub probe: Probe,
    pub parsed: Parsed,
    pub show_folder: Option<String>,
    pub details: Option<Details>,
    pub poster: Option<Picture>,
    pub backdrop: Option<Picture>,
}

pub struct Record {
    pub path: String,
    pub size: u64,
    pub mtime: i64,
    pub fp: Option<String>,
    pub kind: MediaKind,
    pub track: Option<(LibTrack, String)>,
    pub video: Option<VideoFacts>,
}

fn picture(src: &Path, kind: &'static str, width: u32, cache: &Path) -> Option<Picture> {
    let bytes = std::fs::read(src).ok()?;
    let mut h = blake3::Hasher::new();
    h.update(kind.as_bytes());
    h.update(&bytes);
    let hash = h.finalize().to_hex()[..32].to_string();
    if cache.join(format!("{hash}.jpg")).is_file() {
        return Some(Picture { hash, kind, jpeg: None });
    }
    let img = image::load_from_memory(&bytes).ok()?;
    let img = if img.width() > width { img.resize(width, u32::MAX, image::imageops::FilterType::Triangle) } else { img };
    let rgb = image::DynamicImage::ImageRgb8(img.to_rgb8());
    let mut out = vec![];
    rgb.write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 84)).ok()?;
    Some(Picture { hash, kind, jpeg: Some((out, rgb.width(), rgb.height())) })
}

/// How many videos a folder holds, counted once per job.
#[derive(Default)]
pub struct FolderCounts(Mutex<HashMap<PathBuf, usize>>);

impl FolderCounts {
    fn videos_in(&self, dir: &Path) -> usize {
        if let Some(n) = self.0.lock().unwrap().get(dir) {
            return *n;
        }
        let n = std::fs::read_dir(dir).map(|rd| rd.flatten().filter(|e| formats::kind_of(&e.path()) == Some(MediaKind::Video)).count()).unwrap_or(0);
        self.0.lock().unwrap().insert(dir.to_path_buf(), n);
        n
    }
}

/// Reads one file for the library: its fingerprint, then tags (a song) or the probe, the name, the details and the
/// art beside it (a video). The error is what people read in the queue's list of what went wrong.
pub fn read_file(f: &OnDisk, root: Option<&Path>, cache: &Path, counts: &FolderCounts) -> Result<Record, String> {
    let fp = fingerprint(&f.path, f.size).ok_or_else(|| match std::fs::File::open(&f.path) {
        // Windows' sharing and lock violations: another program holds the file.
        Err(e) if matches!(e.raw_os_error(), Some(32) | Some(33)) => "it's open in another program".to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => "it can't be opened (in use or no permission)".to_string(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "it isn't there any more".to_string(),
        Err(e) => e.to_string(),
        Ok(_) => "it can't be read".to_string(),
    })?;
    let mut rec = Record { path: path_string(&f.path), size: f.size, mtime: f.mtime, fp: Some(fp), kind: f.kind, track: None, video: None };
    match f.kind {
        MediaKind::Audio => {
            rec.track = Some(library::read_track(&f.path).ok_or("it can't be opened, or it is empty")?);
        }
        MediaKind::Video => {
            let rel = rel_of(root, &f.path);
            let parsed = parse::parse(&rel);
            let root_name = root.and_then(|r| r.file_name()).map(|n| n.to_string_lossy().into_owned());
            let show_folder = parse::show_folder_in(&rel, root_name.as_deref());
            let lone = parsed.kind == Kind::Movie && f.path.parent().map(|d| counts.videos_in(d) == 1).unwrap_or(false);
            let show_dir = show_folder.as_ref().and_then(|_| f.path.parent()?.parent().map(Path::to_path_buf));
            let art = matching::art(&f.path, lone, show_dir.as_deref());
            rec.video = Some(VideoFacts {
                probe: probe::probe(&f.path).unwrap_or_default(),
                details: matching::details(&f.path, lone),
                poster: art.poster.and_then(|p| picture(&p, "poster", 342, cache)),
                backdrop: art.backdrop.and_then(|p| picture(&p, "backdrop", 1280, cache)),
                parsed,
                show_folder,
            });
        }
    }
    Ok(rec)
}

/// Writes one file's rows; returns whether it was new to the library. A new path whose fingerprint matches a missing
/// file takes that file's row (moved or renamed: its id, and everything that points at it, are kept).
pub fn write_record(conn: &Connection, rec: &Record, place_id: Option<i64>, cache: &Path) -> rusqlite::Result<bool> {
    let now = db::now();
    let existing: Option<i64> = conn.query_row("SELECT id FROM files WHERE path = ?1", [&rec.path], |r| r.get(0)).optional()?;
    let relinked: Option<i64> = if existing.is_none() {
        conn.query_row("SELECT id FROM files WHERE missing = 1 AND fp = ?1 AND size = ?2 LIMIT 1", params![rec.fp, rec.size as i64], |r| r.get(0)).optional()?
    } else {
        None
    };
    let kind = kind_name(rec.kind);
    let id = match existing.or(relinked) {
        Some(id) => {
            conn.execute(
                "UPDATE files SET path = ?2, place_id = COALESCE(?3, place_id), fp = ?4, size = ?5, mtime = ?6, kind = ?7, scanned_at = ?8, missing = 0 WHERE id = ?1",
                params![id, rec.path, place_id, rec.fp, rec.size as i64, rec.mtime, kind, now],
            )?;
            id
        }
        None => {
            conn.execute(
                "INSERT INTO files(place_id, fp, path, size, mtime, kind, added_at, scanned_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![place_id, rec.fp, rec.path, rec.size as i64, rec.mtime, kind, now],
            )?;
            conn.last_insert_rowid()
        }
    };
    if let Some((t, album_artist)) = &rec.track {
        conn.execute(
            "INSERT OR REPLACE INTO tracks(file_id, title, artist, album_artist, album, track_no, disc_no, year, duration_ms, problem)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![id, t.title, t.artist, album_artist, t.album, t.number, t.disc, t.year, (t.duration * 1000.0) as i64, t.unplayable.then_some("no readable audio")],
        )?;
    }
    if let Some(v) = &rec.video {
        let mut pictures = vec![];
        for p in [&v.poster, &v.backdrop].into_iter().flatten() {
            if let Some((jpeg, w, h)) = &p.jpeg {
                let file = cache.join(format!("{}.jpg", p.hash));
                if std::fs::write(&file, jpeg).is_ok() {
                    conn.execute(
                        "INSERT OR IGNORE INTO images(hash, kind, path, w, h, bytes, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![p.hash, p.kind, path_string(&file), w, h, jpeg.len() as i64, now],
                    )?;
                    pictures.push(p.hash.clone());
                }
            } else {
                pictures.push(p.hash.clone());
            }
        }
        let has = |p: &Option<Picture>| p.as_ref().filter(|p| pictures.contains(&p.hash)).map(|p| p.hash.clone());
        let pr = &v.parsed;
        conn.execute(
            "INSERT OR REPLACE INTO videos(file_id, duration_ms, width, height, kind, title, year, season, episode, episode_title, show_folder, poster, backdrop)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                id,
                v.probe.duration.map(|d| (d * 1000.0) as i64),
                v.probe.width,
                v.probe.height,
                if pr.kind == Kind::Movie { "movie" } else { "episode" },
                pr.title,
                pr.year,
                pr.season,
                pr.episode,
                pr.episode_title,
                v.show_folder,
                has(&v.poster),
                has(&v.backdrop),
            ],
        )?;
        conn.execute("DELETE FROM metadata WHERE file_id = ?1 AND source IN ('nfo', 'sidecar')", [id])?;
        if let Some(d) = &v.details {
            conn.execute(
                "INSERT INTO metadata(file_id, source, external_id, title, original_title, year, overview, runtime_min, genres, rating, fetched_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![id, d.source, d.external_id, d.title, d.original_title, d.year, d.overview, d.runtime_min, (!d.genres.is_empty()).then(|| d.genres.join(", ")), d.rating, now],
            )?;
        }
    }
    Ok(existing.is_none() && relinked.is_none())
}

// ---------------------------------------------------------------------------------------------------------------
// Jobs: the import queue

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: i64,
    /// import or rescan.
    pub kind: &'static str,
    /// The folder, shown (None for files added on their own, or a rescan of every place).
    pub place: Option<String>,
    /// TransferRow's states: queued, sizing (finding files), running, done, failed, cancelled.
    pub state: &'static str,
    pub total: u64,
    pub done: u64,
    pub total_bytes: u64,
    pub done_bytes: u64,
    /// The file being read now.
    pub current: Option<String>,
    pub added: u64,
    pub updated: u64,
    /// Files that are gone since the last scan (rescans).
    pub missing: u64,
    /// "name: why", one per file that didn't make it.
    pub errors: Vec<String>,
    /// An automatic rescan: shown only once it finds something.
    pub quiet: bool,
}

impl JobView {
    fn over(&self) -> bool {
        matches!(self.state, "done" | "failed" | "cancelled")
    }
}

struct Job {
    view: JobView,
    stop: Arc<AtomicBool>,
    /// What failed, for Retry.
    failed: Vec<PathBuf>,
    place_id: Option<i64>,
}

enum Work {
    Import { job: i64, place: Option<Place>, files: Vec<PathBuf> },
    Rescan { job: i64, places: Vec<Place> },
}

#[derive(Default)]
pub struct ImportState {
    jobs: Mutex<Vec<Job>>,
    sender: Mutex<Option<mpsc::Sender<Work>>>,
    discoveries: Mutex<HashMap<u64, Discovery>>,
    next_discovery: AtomicU64,
    /// The places have been checked for changes this session (on the first use of the library).
    pub rescanned: AtomicBool,
}

fn emit_job(app: &AppHandle, view: &JobView) {
    let _ = app.emit("import://job", view.clone());
}

fn update(app: &AppHandle, id: i64, f: impl FnOnce(&mut JobView)) -> Option<JobView> {
    let state = app.state::<ImportState>();
    let mut jobs = state.jobs.lock().unwrap();
    let job = jobs.iter_mut().find(|j| j.view.id == id)?;
    f(&mut job.view);
    Some(job.view.clone())
}

fn stopped(app: &AppHandle, id: i64) -> bool {
    let state = app.state::<ImportState>();
    let jobs = state.jobs.lock().unwrap();
    jobs.iter().find(|j| j.view.id == id).map(|j| j.stop.load(Ordering::Relaxed)).unwrap_or(true)
}

fn images_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("images");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Creates a job (queued), shows it, and hands its work to the worker.
fn enqueue(app: &AppHandle, view: JobView, place_id: Option<i64>, work: impl FnOnce(i64) -> Work) -> Result<JobView, String> {
    let id = {
        let db = app.state::<Db>();
        let conn = db.conn()?;
        conn.execute(
            "INSERT INTO import_jobs(place_id, title, started_at, total, state) VALUES (?1, ?2, ?3, ?4, 'queued')",
            params![place_id, view.place.clone().unwrap_or_default(), db::now(), view.total as i64],
        )
        .map_err(|e| e.to_string())?;
        conn.last_insert_rowid()
    };
    let view = JobView { id, ..view };
    let state = app.state::<ImportState>();
    state.jobs.lock().unwrap().push(Job { view: view.clone(), stop: Arc::new(AtomicBool::new(false)), failed: vec![], place_id });
    if !view.quiet {
        emit_job(app, &view);
    }
    let mut sender = state.sender.lock().unwrap();
    if sender.is_none() {
        let (tx, rx) = mpsc::channel::<Work>();
        let app = app.clone();
        std::thread::Builder::new().name("import".into()).spawn(move || worker(app, rx)).map_err(|e| e.to_string())?;
        *sender = Some(tx);
    }
    sender.as_ref().unwrap().send(work(id)).map_err(|e| e.to_string())?;
    Ok(view)
}

fn worker(app: AppHandle, rx: mpsc::Receiver<Work>) {
    while let Ok(work) = rx.recv() {
        let (id, result) = match work {
            Work::Import { job, place, files } => (job, run_import(&app, job, place, files)),
            Work::Rescan { job, places } => (job, run_rescan(&app, job, places)),
        };
        finish(&app, id, result);
    }
}

/// What a job changed, for its last row and for the pages.
#[derive(Default)]
struct Outcome {
    changed: bool,
}

fn finish(app: &AppHandle, id: i64, result: Result<Outcome, String>) {
    let cancelled = stopped(app, id);
    let view = update(app, id, |v| {
        v.current = None;
        match &result {
            Err(e) => {
                v.state = "failed";
                v.errors.push(e.clone());
            }
            // Stopped while its last files were being read: it did finish.
            Ok(_) if cancelled && v.done < v.total => v.state = "cancelled",
            Ok(_) => v.state = "done",
        }
        // A quiet rescan that found something, or failed, shows its row.
        if v.added + v.updated + v.missing > 0 || !v.errors.is_empty() {
            v.quiet = false;
        }
    });
    if let Some(v) = &view {
        if let Ok(conn) = app.state::<Db>().conn() {
            let _ = conn.execute(
                "UPDATE import_jobs SET finished_at = ?2, total = ?3, done = ?4, problems = ?5, state = ?6 WHERE id = ?1",
                params![id, db::now(), v.total as i64, v.done as i64, v.errors.len() as i64, v.state],
            );
        }
        if !v.quiet {
            emit_job(app, v);
        }
    }
    if matches!(result, Ok(Outcome { changed: true })) {
        library::invalidate(app);
        let _ = app.emit("library://changed", ());
    }
}

/// Reads and writes a list of files, a chunk at a time, with live progress.
fn process(app: &AppHandle, id: i64, place: Option<&Place>, files: Vec<OnDisk>) -> Result<Outcome, String> {
    let cache = images_dir(app);
    let counts = FolderCounts::default();
    let root = place.map(|p| p.root.clone());
    let total_bytes = files.iter().map(|f| f.size).sum();
    update(app, id, |v| {
        v.state = "running";
        v.total = files.len() as u64;
        v.total_bytes = total_bytes;
    });
    let mut out = Outcome::default();
    let mut last = Instant::now() - Duration::from_secs(1);
    for chunk in files.chunks(24) {
        if stopped(app, id) {
            break;
        }
        if let Some(v) = update(app, id, |v| v.current = chunk.first().and_then(|f| f.path.file_name()).map(|n| n.to_string_lossy().into_owned())) {
            if last.elapsed() > Duration::from_millis(100) && !v.quiet {
                emit_job(app, &v);
                last = Instant::now();
            }
        }
        let read: Vec<(&OnDisk, Result<Record, String>)> = chunk.iter().zip(par_map(chunk, 4, |f| read_file(f, root.as_deref(), &cache, &counts))).collect();
        let mut failed = vec![];
        let (mut added, mut updated) = (0, 0);
        {
            let db = app.state::<Db>();
            let mut conn = db.conn()?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for (f, rec) in &read {
                match rec {
                    Ok(rec) => match write_record(&tx, rec, place.map(|p| p.id), &cache) {
                        Ok(true) => added += 1,
                        Ok(false) => updated += 1,
                        Err(e) => failed.push((f.path.clone(), e.to_string())),
                    },
                    Err(e) => failed.push((f.path.clone(), e.clone())),
                }
            }
            for (p, why) in &failed {
                let _ = tx.execute("INSERT INTO import_items(job_id, path, state, problem) VALUES (?1, ?2, 'failed', ?3)", params![id, path_string(p), why]);
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
        out.changed |= added + updated > 0;
        let state = app.state::<ImportState>();
        let mut jobs = state.jobs.lock().unwrap();
        if let Some(job) = jobs.iter_mut().find(|j| j.view.id == id) {
            job.view.done += chunk.len() as u64;
            job.view.done_bytes += chunk.iter().map(|f| f.size).sum::<u64>();
            job.view.added += added;
            job.view.updated += updated;
            for (p, why) in failed {
                job.view.errors.push(format!("{}: {why}", p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()));
                job.failed.push(p);
            }
        }
    }
    Ok(out)
}

pub fn stat(path: &Path) -> Option<OnDisk> {
    let meta = std::fs::metadata(path).ok()?;
    Some(OnDisk { path: path.to_path_buf(), kind: formats::kind_of(path)?, size: meta.len(), mtime: mtime_of(&meta) })
}

/// The files the library has now, by path: (size, mtime, missing).
fn known_files(conn: &Connection, place_id: Option<i64>) -> HashMap<String, (u64, i64, bool)> {
    let sql = if place_id.is_some() { "SELECT path, size, mtime, missing FROM files WHERE place_id = ?1" } else { "SELECT path, size, mtime, missing FROM files WHERE ?1 IS NULL OR 1" };
    let Ok(mut st) = conn.prepare(sql) else { return HashMap::new() };
    st.query_map([place_id], |r| Ok((r.get::<_, String>(0)?, (r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)?, r.get::<_, bool>(3)?))))
        .map(|m| m.flatten().collect())
        .unwrap_or_default()
}

fn unchanged(known: &HashMap<String, (u64, i64, bool)>, f: &OnDisk) -> bool {
    known.get(&path_string(&f.path)).is_some_and(|&(size, mtime, missing)| !missing && size == f.size && mtime == f.mtime)
}

fn run_import(app: &AppHandle, id: i64, place: Option<Place>, paths: Vec<PathBuf>) -> Result<Outcome, String> {
    update(app, id, |v| v.state = "sizing");
    let known = known_files(&*app.state::<Db>().conn()?, None);
    let mut files = vec![];
    let mut gone = vec![];
    for p in paths {
        match stat(&p) {
            Some(f) if unchanged(&known, &f) => {}
            Some(f) => files.push(f),
            None => gone.push(p),
        }
    }
    let out = process(app, id, place.as_ref(), files)?;
    if let Some(place) = &place {
        if let Ok(conn) = app.state::<Db>().conn() {
            let _ = conn.execute("UPDATE places SET last_scan_at = ?2 WHERE id = ?1", params![place.id, db::now()]);
        }
    }
    if !gone.is_empty() {
        let state = app.state::<ImportState>();
        let mut jobs = state.jobs.lock().unwrap();
        if let Some(job) = jobs.iter_mut().find(|j| j.view.id == id) {
            for p in gone {
                job.view.errors.push(format!("{}: it isn't there any more", p.file_name().map(|n| n.to_string_lossy()).unwrap_or_default()));
            }
        }
    }
    Ok(out)
}

/// What a rescan of one place has to do: files to read (new ones that pass its filters, changed ones, ones that are
/// back) and the paths it saw (the others are gone).
pub fn plan_rescan(conn: &Connection, place: &Place, stop: &AtomicBool) -> (Vec<OnDisk>, HashSet<String>) {
    let (known, skipped) = place_rows(conn, place.id);
    plan_walk(&known, &skipped, place, stop)
}

/// A place's files in the library and its unchecked files: read before the walk, so the walk holds no lock.
pub fn place_rows(conn: &Connection, place_id: i64) -> (HashMap<String, (u64, i64, bool)>, HashSet<String>) {
    let skipped = conn
        .prepare("SELECT path FROM skipped WHERE place_id = ?1")
        .and_then(|mut st| st.query_map([place_id], |r| r.get::<_, String>(0)).map(|m| m.flatten().collect()))
        .unwrap_or_default();
    (known_files(conn, Some(place_id)), skipped)
}

fn plan_walk(known: &HashMap<String, (u64, i64, bool)>, skipped: &HashSet<String>, place: &Place, stop: &AtomicBool) -> (Vec<OnDisk>, HashSet<String>) {
    let f = &place.filters;
    let needs_probe = f.min_duration.is_some() || f.max_duration.is_some() || f.min_height.is_some();
    let (mut todo, mut seen) = (vec![], HashSet::new());
    walk(&place.root, stop, |file| {
        let p = path_string(&file.path);
        seen.insert(p.clone());
        if known.contains_key(&p) {
            if !unchanged(known, &file) {
                todo.push(file);
            }
            return;
        }
        if skipped.contains(&p) {
            return;
        }
        let probe = if needs_probe { quick_probe(file.kind, &file.path) } else { Probe::default() };
        let c = Candidate {
            kind: kind_name(file.kind).into(),
            ext: file.path.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default(),
            size: file.size,
            duration: probe.duration,
            height: probe.height,
            width: probe.width,
            rel: rel_of(Some(&place.root), &file.path),
        };
        if filters::passes(f, &c) {
            todo.push(file);
        }
    });
    (todo, seen)
}

/// Flags the files of a place that weren't seen (never deletes them: "Can't find this file"); returns their ids.
/// Done before the new files are read, so a moved file finds its old row missing and takes it over.
pub fn flag_missing(conn: &Connection, place_id: i64, seen: &HashSet<String>) -> rusqlite::Result<Vec<i64>> {
    let rows: Vec<(i64, String)> =
        conn.prepare("SELECT id, path FROM files WHERE place_id = ?1 AND missing = 0")?.query_map([place_id], |r| Ok((r.get(0)?, r.get(1)?)))?.flatten().collect();
    let mut ids = vec![];
    for (id, _) in rows.into_iter().filter(|(_, p)| !seen.contains(p)) {
        conn.execute("UPDATE files SET missing = 1 WHERE id = ?1", [id])?;
        ids.push(id);
    }
    Ok(ids)
}

/// How many of these files are still missing (the others were moved and found again).
pub fn still_missing(conn: &Connection, ids: &[i64]) -> u64 {
    ids.iter().filter(|id| conn.query_row("SELECT missing FROM files WHERE id = ?1", [**id], |r| r.get::<_, bool>(0)).unwrap_or(false)).count() as u64
}

fn run_rescan(app: &AppHandle, id: i64, places: Vec<Place>) -> Result<Outcome, String> {
    update(app, id, |v| v.state = "sizing");
    let stop = app.state::<ImportState>().jobs.lock().unwrap().iter().find(|j| j.view.id == id).map(|j| j.stop.clone()).unwrap_or_default();
    let mut out = Outcome::default();
    for place in places {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        // A folder on a drive that isn't connected: nothing in it is flagged missing; it is read again when it's back.
        if !place.root.is_dir() {
            continue;
        }
        let (known, skipped) = place_rows(&*app.state::<Db>().conn()?, place.id);
        let (todo, seen) = plan_walk(&known, &skipped, &place, &stop);
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let flagged = flag_missing(&*app.state::<Db>().conn()?, place.id, &seen).map_err(|e| e.to_string())?;
        let o = process(app, id, Some(&place), todo)?;
        out.changed |= o.changed || !flagged.is_empty();
        let db = app.state::<Db>();
        let conn = db.conn()?;
        let missing = still_missing(&conn, &flagged);
        let _ = conn.execute("UPDATE places SET last_scan_at = ?2 WHERE id = ?1", params![place.id, db::now()]);
        drop(conn);
        update(app, id, |v| v.missing += missing);
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------------------
// Commands

/// Automated runs of a debug build answer the dialogs from a file (`PASTEL_PICK_FILE`: one path per line, read at
/// each pick; empty for Cancel), so no dialog opens on the screen. Release builds never read it.
fn scripted_pick() -> Option<Vec<String>> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let file = std::env::var_os("PASTEL_PICK_FILE")?;
    let text = std::fs::read_to_string(file).unwrap_or_default();
    Some(text.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect())
}

fn canonical(p: &str) -> Option<String> {
    PathBuf::from(p).canonicalize().ok().map(|p| path_string(&p))
}

/// Picks a folder in Windows' dialog: its path, or nothing when cancelled.
#[tauri::command]
pub async fn import_pick_folder(app: AppHandle, title: String) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    if let Some(lines) = scripted_pick() {
        return lines.first().and_then(|p| canonical(p));
    }
    let picked = app.dialog().file().set_title(title).blocking_pick_folder()?;
    picked.into_path().ok().and_then(|p| p.canonicalize().ok()).map(|p| path_string(&p))
}

/// Picks media files in Windows' dialog.
#[tauri::command]
pub async fn import_pick_files(app: AppHandle, title: String, audio: String, video: String) -> Vec<String> {
    use tauri_plugin_dialog::DialogExt;
    if let Some(lines) = scripted_pick() {
        return lines.iter().filter_map(|p| canonical(p)).collect();
    }
    let all: Vec<&str> = formats::extensions(MediaKind::Audio).into_iter().chain(formats::extensions(MediaKind::Video)).collect();
    let picked = app
        .dialog()
        .file()
        .set_title(title)
        .add_filter(format!("{audio}, {video}"), &all)
        .add_filter(audio, &formats::extensions(MediaKind::Audio))
        .add_filter(video, &formats::extensions(MediaKind::Video))
        .blocking_pick_files()
        .unwrap_or_default();
    picked.into_iter().filter_map(|f| f.into_path().ok()).filter_map(|p| p.canonicalize().ok()).map(|p| path_string(&p)).collect()
}

/// Starts finding what's in a folder (or in some files): rows, then their lengths, arrive on `on_event`.
#[tauri::command]
pub fn import_discover(
    app: AppHandle,
    folder: Option<String>,
    files: Option<Vec<String>>,
    on_event: Channel<DiscoverEvent>,
) -> Result<DiscoverStart, String> {
    let state = app.state::<ImportState>();
    let id = state.next_discovery.fetch_add(1, Ordering::SeqCst) + 1;
    let stop = Arc::new(AtomicBool::new(false));
    let db = app.state::<Db>();
    let conn = db.conn()?;
    let known: HashSet<String> = known_files(&conn, None).into_iter().filter(|(_, (_, _, missing))| !missing).map(|(p, _)| p).collect();
    let (root, list, start) = if let Some(folder) = folder {
        let root = PathBuf::from(&folder).canonicalize().map_err(|e| e.to_string())?;
        if !root.is_dir() {
            return Err("not a folder".into());
        }
        let all = places(&conn);
        let outer = all.iter().find(|p| root.starts_with(&p.root));
        let start = DiscoverStart {
            id,
            folder: Some(library::shown(&root)),
            filters: outer.map(|p| p.filters.clone()),
            inside: outer.filter(|p| p.root != root).map(|p| library::shown(&p.root)),
        };
        (Some(root), vec![], start)
    } else {
        let list: Vec<OnDisk> = files.unwrap_or_default().iter().filter_map(|p| stat(Path::new(p))).collect();
        (None, list, DiscoverStart { id, folder: None, filters: None, inside: None })
    };
    let skipped: HashSet<String> = conn
        .prepare("SELECT path FROM skipped")
        .and_then(|mut st| st.query_map([], |r| r.get::<_, String>(0)).map(|m| m.flatten().collect()))
        .unwrap_or_default();
    drop(conn);
    state.discoveries.lock().unwrap().insert(id, Discovery { stop: stop.clone() });
    let walk_root = root.is_some();
    let app2 = app.clone();
    std::thread::Builder::new()
        .name("discover".into())
        .spawn(move || {
            discover_thread(list, root, walk_root, known, skipped, stop, on_event);
            app2.state::<ImportState>().discoveries.lock().unwrap().remove(&id);
        })
        .map_err(|e| e.to_string())?;
    Ok(start)
}

/// Stops a discovery (the review list was closed).
#[tauri::command]
pub fn import_discover_cancel(state: tauri::State<'_, ImportState>, id: u64) {
    if let Some(d) = state.discoveries.lock().unwrap().remove(&id) {
        d.stop.store(true, Ordering::SeqCst);
    }
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    /// A folder: it becomes a place, rescanned with these filters. None for files added on their own.
    pub folder: Option<String>,
    /// What to import (checked in the review list, or every file that passed the filters).
    pub files: Vec<String>,
    /// What was unchecked: a rescan won't bring it back.
    #[serde(default)]
    pub skipped: Vec<String>,
    pub filters: Filters,
    /// No review list: the job itself finds the folder's files and keeps those that pass the filters.
    #[serde(default)]
    pub direct: bool,
}

/// Starts importing: the job joins the queue and its row shows at once.
#[tauri::command]
pub fn import_start(app: AppHandle, request: ImportRequest) -> Result<JobView, String> {
    let place = match &request.folder {
        Some(folder) => {
            let root = PathBuf::from(folder).canonicalize().map_err(|e| e.to_string())?;
            let db = app.state::<Db>();
            let mut conn = db.conn()?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            let id = adopt_folder(&tx, &root, &request.filters).map_err(|e| e.to_string())?;
            // The filters belong to the place itself; a folder inside a place keeps the place's.
            let place_root: String = tx.query_row("SELECT path FROM places WHERE id = ?1", [id], |r| r.get(0)).map_err(|e| e.to_string())?;
            if Path::new(&place_root) == root {
                save_filters(&tx, id, &request.filters).map_err(|e| e.to_string())?;
            }
            for p in &request.skipped {
                tx.execute("INSERT OR REPLACE INTO skipped(path, place_id) VALUES (?1, ?2)", params![p, id]).map_err(|e| e.to_string())?;
            }
            for p in &request.files {
                tx.execute("DELETE FROM skipped WHERE path = ?1", [p]).map_err(|e| e.to_string())?;
            }
            let filters = load_filters(&tx, id).unwrap_or_else(|| request.filters.clone());
            tx.commit().map_err(|e| e.to_string())?;
            // The connection is let go first: refreshing the places takes it again.
            drop(conn);
            library::refresh_places(&app);
            Some(Place { id, root: PathBuf::from(place_root), filters })
        }
        None => None,
    };
    let view = JobView {
        kind: "import",
        place: place.as_ref().map(|p| library::shown(&p.root)),
        state: "queued",
        total: request.files.len() as u64,
        ..Default::default()
    };
    let place_id = place.as_ref().map(|p| p.id);
    if let (true, Some(place)) = (request.direct, place.clone()) {
        return enqueue(&app, view, place_id, move |job| Work::Rescan { job, places: vec![place] });
    }
    let files: Vec<PathBuf> = request.files.iter().map(PathBuf::from).collect();
    enqueue(&app, view, place_id, move |job| Work::Import { job, place, files })
}

/// Checks places for changes: one place, or all of them. `quiet` for the automatic check (no row unless it finds
/// something).
pub fn rescan(app: &AppHandle, place_id: Option<i64>, quiet: bool) -> Result<JobView, String> {
    let all = places(&*app.state::<Db>().conn()?);
    let chosen: Vec<Place> = all.into_iter().filter(|p| place_id.is_none_or(|id| p.id == id)).collect();
    let view = JobView {
        kind: "rescan",
        place: if chosen.len() == 1 { Some(library::shown(&chosen[0].root)) } else { None },
        state: "queued",
        quiet,
        ..Default::default()
    };
    enqueue(app, view, place_id, move |job| Work::Rescan { job, places: chosen })
}

#[tauri::command]
pub fn places_rescan(app: AppHandle, place_id: Option<i64>) -> Result<JobView, String> {
    rescan(&app, place_id, false)
}

/// The queue's rows (quiet rescans that found nothing are left out).
#[tauri::command]
pub fn import_jobs(state: tauri::State<'_, ImportState>) -> Vec<JobView> {
    state.jobs.lock().unwrap().iter().filter(|j| !j.view.quiet).map(|j| j.view.clone()).collect()
}

/// Stops a job after the file it is reading; what was imported stays.
#[tauri::command]
pub fn import_stop(state: tauri::State<'_, ImportState>, id: i64) {
    if let Some(j) = state.jobs.lock().unwrap().iter().find(|j| j.view.id == id) {
        j.stop.store(true, Ordering::SeqCst);
    }
}

/// Tries again what failed in a finished job, as a new job.
#[tauri::command]
pub fn import_retry(app: AppHandle, id: i64) -> Result<JobView, String> {
    let (failed, place_id, kind) = {
        let state = app.state::<ImportState>();
        let jobs = state.jobs.lock().unwrap();
        let j = jobs.iter().find(|j| j.view.id == id).ok_or("no such job")?;
        (j.failed.clone(), j.place_id, j.view.kind)
    };
    let job = if failed.is_empty() && kind == "rescan" {
        rescan(&app, place_id, false)?
    } else {
        let all = places(&*app.state::<Db>().conn()?);
        let place = place_id.and_then(|pid| all.into_iter().find(|p| p.id == pid));
        let view = JobView { kind: "import", place: place.as_ref().map(|p| library::shown(&p.root)), state: "queued", total: failed.len() as u64, ..Default::default() };
        enqueue(&app, view, place_id, move |job| Work::Import { job, place, files: failed })?
    };
    dismiss(&app, id);
    Ok(job)
}

fn dismiss(app: &AppHandle, id: i64) {
    app.state::<ImportState>().jobs.lock().unwrap().retain(|j| j.view.id != id || !j.view.over());
}

/// Takes a finished row away.
#[tauri::command]
pub fn import_dismiss(app: AppHandle, id: i64) {
    dismiss(&app, id);
}

/// Takes every finished row away.
#[tauri::command]
pub fn import_clear_finished(state: tauri::State<'_, ImportState>) {
    state.jobs.lock().unwrap().retain(|j| !j.view.over());
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlaceView {
    pub id: i64,
    pub path: String,
    /// The folder is there now (a drive can be unplugged).
    pub found: bool,
    pub files: u64,
    pub missing: u64,
    pub preset: String,
    pub last_scan_at: Option<i64>,
}

/// The library's places, for Settings → Library.
#[tauri::command]
pub fn places_list(app: AppHandle) -> Result<Vec<PlaceView>, String> {
    library::ensure_ready(&app)?;
    let db = app.state::<Db>();
    let conn = db.conn()?;
    let mut st = conn
        .prepare(
            "SELECT p.id, p.path, p.last_scan_at, COALESCE(f.preset, 'everything'),
                    (SELECT count(*) FROM files WHERE place_id = p.id AND missing = 0),
                    (SELECT count(*) FROM files WHERE place_id = p.id AND missing = 1)
             FROM places p LEFT JOIN place_filters f ON f.place_id = p.id ORDER BY p.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = st
        .query_map([], |r| {
            let path: String = r.get(1)?;
            Ok(PlaceView {
                id: r.get(0)?,
                found: Path::new(&path).is_dir(),
                path: library::shown(Path::new(&path)),
                last_scan_at: r.get(2)?,
                preset: r.get(3)?,
                files: r.get::<_, i64>(4)? as u64,
                missing: r.get::<_, i64>(5)? as u64,
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.flatten().collect())
}

/// Forgets a place and its files (the files themselves are untouched).
#[tauri::command]
pub fn places_remove(app: AppHandle, place_id: i64) -> Result<(), String> {
    {
        let db = app.state::<Db>();
        let conn = db.conn()?;
        conn.execute("DELETE FROM places WHERE id = ?1", [place_id]).map_err(|e| e.to_string())?;
    }
    library::refresh_places(&app);
    library::invalidate(&app);
    let _ = app.emit("library://changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(name: &str, files: &[(&str, &[u8])]) -> PathBuf {
        let root = std::env::temp_dir().join(format!("pmp-import-{name}-{}", std::process::id())).canonicalize().unwrap_or_else(|_| {
            let p = std::env::temp_dir().join(format!("pmp-import-{name}-{}", std::process::id()));
            std::fs::create_dir_all(&p).unwrap();
            p.canonicalize().unwrap()
        });
        for (f, bytes) in files {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, bytes).unwrap();
        }
        root
    }

    /// A rescan as the job runs it: walk, flag what is gone, read what is new or changed, count what is still gone.
    fn import_all(conn: &mut Connection, place: &Place, cache: &Path) -> (u64, u64) {
        let stop = AtomicBool::new(false);
        let (todo, seen) = plan_rescan(conn, place, &stop);
        let counts = FolderCounts::default();
        let tx = conn.transaction().unwrap();
        let flagged = flag_missing(&tx, place.id, &seen).unwrap();
        let mut added = 0;
        for f in &todo {
            let rec = read_file(f, Some(&place.root), cache, &counts).unwrap();
            if write_record(&tx, &rec, Some(place.id), cache).unwrap() {
                added += 1;
            }
        }
        let missing = still_missing(&tx, &flagged);
        tx.commit().unwrap();
        (added, missing)
    }

    #[test]
    fn a_rescan_adds_what_passes_flags_what_is_gone_and_relinks_a_moved_file() {
        let root = tree(
            "rescan",
            &[
                ("Heat (1995)/Heat.1995.mkv", b"heat-bytes"),
                ("Heat (1995)/Sample/heat-sample.mkv", b"sample"),
                ("Heat (1995)/movie.nfo", b"<movie><title>Heat</title><year>1995</year><plot>A thief.</plot></movie>"),
                ("Dark/Season 1/Dark.S01E01.mkv", b"dark-1"),
                ("notes.txt", b"not media"),
            ],
        );
        let cache = root.join(".cache");
        std::fs::create_dir_all(&cache).unwrap();
        let mut conn = db::memory();
        let filters = Filters { preset: "movies".into(), kinds: Some(vec!["video".into()]), skip_extras: true, ..Default::default() };
        let id = adopt_folder(&conn, &root, &filters).unwrap();
        let place = Place { id, root: root.clone(), filters };

        assert_eq!(import_all(&mut conn, &place, &cache), (2, 0), "the film and the episode, not the sample");
        let (title, overview): (String, String) = conn
            .query_row("SELECT m.title, m.overview FROM metadata m JOIN files f ON f.id = m.file_id WHERE f.path LIKE '%Heat.1995.mkv'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((title.as_str(), overview.as_str()), ("Heat", "A thief."));
        let show: String = conn.query_row("SELECT show_folder FROM videos WHERE kind = 'episode'", [], |r| r.get(0)).unwrap();
        assert_eq!(show, "Dark");

        // Nothing changed: nothing to read.
        assert_eq!(import_all(&mut conn, &place, &cache), (0, 0));

        // The episode is renamed: same bytes, new name. Its row (and id) is kept, under the new path.
        let id_before: i64 = conn.query_row("SELECT id FROM files WHERE path LIKE '%Dark.S01E01.mkv'", [], |r| r.get(0)).unwrap();
        std::fs::rename(root.join("Dark/Season 1/Dark.S01E01.mkv"), root.join("Dark/Season 1/Dark - S01E01 - Secrets.mkv")).unwrap();
        // One rescan: the old path is flagged gone, then the new one takes its row.
        assert_eq!(import_all(&mut conn, &place, &cache), (0, 0), "relinked, not added, and nothing left missing");
        let id_after: i64 = conn.query_row("SELECT id FROM files WHERE path LIKE '%Secrets.mkv' AND missing = 0", [], |r| r.get(0)).unwrap();
        assert_eq!(id_before, id_after);

        // The film is deleted: flagged, never removed.
        std::fs::remove_file(root.join("Heat (1995)/Heat.1995.mkv")).unwrap();
        assert_eq!(import_all(&mut conn, &place, &cache), (0, 1));
        let rows: i64 = conn.query_row("SELECT count(*) FROM files", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 2);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_unchecked_file_stays_out_of_rescans() {
        let root = tree("skipped", &[("A.mkv", b"a"), ("B.mkv", b"b")]);
        let mut conn = db::memory();
        let id = adopt_folder(&conn, &root, &Filters::everything()).unwrap();
        conn.execute("INSERT INTO skipped(path, place_id) VALUES (?1, ?2)", params![path_string(&root.join("B.mkv")), id]).unwrap();
        let place = Place { id, root: root.clone(), filters: Filters::everything() };
        let cache = std::env::temp_dir();
        assert_eq!(import_all(&mut conn, &place, &cache), (1, 0));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_folder_around_places_takes_them_in_and_one_inside_joins_its_place() {
        let conn = db::memory();
        let inner = PathBuf::from(r"D:\Media\Films");
        let id_inner = adopt_folder(&conn, &inner, &Filters::everything()).unwrap();
        conn.execute("INSERT INTO files(place_id, path, size, mtime, kind, added_at, scanned_at) VALUES (?1, 'D:\\Media\\Films\\a.mkv', 1, 1, 'video', 1, 1)", [id_inner]).unwrap();
        assert_eq!(adopt_folder(&conn, &inner.join("Noir"), &Filters::everything()).unwrap(), id_inner);
        let outer = adopt_folder(&conn, Path::new(r"D:\Media"), &Filters::everything()).unwrap();
        assert_ne!(outer, id_inner);
        let (places, file_place): (i64, i64) =
            conn.query_row("SELECT (SELECT count(*) FROM places), (SELECT place_id FROM files)", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((places, file_place), (1, outer));
    }

    #[test]
    fn filters_survive_the_database() {
        let conn = db::memory();
        let f = Filters {
            preset: "custom".into(),
            kinds: Some(vec!["video".into()]),
            min_duration: Some(1200.0),
            max_bytes: Some(10_000_000_000),
            min_height: Some(720),
            extensions: Some(vec!["mkv".into(), "mp4".into()]),
            skip_extras: true,
            ..Default::default()
        };
        let id = adopt_folder(&conn, Path::new(r"D:\Films"), &f).unwrap();
        assert_eq!(load_filters(&conn, id), Some(f));
    }

    #[test]
    fn a_file_on_its_own_keeps_enough_of_its_path_for_the_parser() {
        assert_eq!(rel_of(None, Path::new(r"D:\TV\Dark\Season 1\Dark.S01E01.mkv")), "Dark/Season 1/Dark.S01E01.mkv");
        assert_eq!(rel_of(Some(Path::new(r"D:\TV")), Path::new(r"D:\TV\Dark\Season 1\x.mkv")), "Dark/Season 1/x.mkv");
    }
}
