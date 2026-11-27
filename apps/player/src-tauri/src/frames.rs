//! Pictures taken out of the videos themselves: a film's or a series' backdrop when no art gives one, and one
//! picture per episode. A second, windowless engine (`engine::mpv`, `Output::Images`) writes a frame; this module
//! picks the liveliest of a few, makes it small once and keeps it in the image cache as a `frame`.
//!
//! One file at a time, on a thread of its own, behind everything else: what a page is showing is asked for first
//! (`frames_want`), the rest of the library follows. Art found later (beside the files, online) takes a frame's place.

use crate::db::{self, Db};
use crate::library::{self, Library};
use image::RgbImage;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

/// A backdrop's and an episode picture's width in the cache.
const BACKDROP_WIDTH: u32 = 1280;
const STILL_WIDTH: u32 = 480;
/// Where in a video the frames for a backdrop are looked for, in percent; an episode's picture is the middle one.
const MOMENTS: [u8; 3] = [20, 35, 50];
/// While frames are being made, the pages hear of new ones this often at most.
const ANNOUNCE_EVERY: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Job {
    /// A film's backdrop.
    Backdrop(i64),
    /// An episode's picture.
    Still(i64),
    /// A series' backdrop, from one of its episodes.
    Show(String, i64),
}

#[derive(Default)]
pub struct Frames {
    queue: Mutex<VecDeque<(Job, bool)>>,
    known: Mutex<HashSet<Job>>,
    wake: Condvar,
    started: AtomicBool,
}

fn file_id(video_id: &str) -> Option<i64> {
    video_id.strip_prefix('v')?.parse().ok()
}

/// How lively a frame is: the spread of its brightness, sampled. A frame that is nearly black or nearly white
/// (a fade, a title card) counts for little.
pub fn liveliness(img: &RgbImage) -> f64 {
    let (mut n, mut sum, mut squares) = (0.0f64, 0.0f64, 0.0f64);
    for (i, p) in img.pixels().enumerate() {
        if i % 7 != 0 {
            continue;
        }
        let luma = 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64;
        n += 1.0;
        sum += luma;
        squares += luma * luma;
    }
    if n == 0.0 {
        return 0.0;
    }
    let mean = sum / n;
    let spread = (squares / n - mean * mean).max(0.0);
    if !(28.0..=235.0).contains(&mean) {
        spread * 0.05
    } else {
        spread
    }
}

/// Keeps a frame in the image cache, made `width` wide at most, and answers its hash.
pub fn store(conn: &Connection, cache: &Path, img: &RgbImage, kind: &str, width: u32) -> Option<String> {
    let img = image::DynamicImage::ImageRgb8(img.clone());
    let img = if img.width() > width { img.resize(width, u32::MAX, image::imageops::FilterType::Triangle) } else { img };
    let rgb = image::DynamicImage::ImageRgb8(img.to_rgb8());
    let mut jpeg = vec![];
    rgb.write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 84)).ok()?;
    let mut h = blake3::Hasher::new();
    h.update(kind.as_bytes());
    h.update(&jpeg);
    let hash = h.finalize().to_hex()[..32].to_string();
    let file = cache.join(format!("{hash}.jpg"));
    std::fs::write(&file, &jpeg).ok()?;
    conn.execute(
        "INSERT OR IGNORE INTO images(hash, kind, path, w, h, bytes, last_used_at, origin) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'frame')",
        params![hash, kind, file.to_string_lossy(), rgb.width(), rgb.height(), jpeg.len() as i64, db::now()],
    )
    .ok()?;
    Some(hash)
}

/// The jobs a library still has for the frame maker: films with no backdrop, episodes with no picture, series with
/// no backdrop. Files that can't be found, or that were asked before, are left out.
fn pending(lib: &Library) -> Vec<Job> {
    let mut jobs = vec![];
    for s in &lib.series {
        let there = |e: &&library::LibVideo| !e.missing;
        if s.backdrop.is_none() && !s.frame_tried {
            // Not from a special, and not from the very first minutes of the first episode alone: the first real one.
            let from = s.episodes.iter().filter(there).find(|e| e.season.unwrap_or(1) > 0).or(s.episodes.iter().find(there));
            if let Some(id) = from.and_then(|e| file_id(&e.id)) {
                jobs.push(Job::Show(s.key.clone(), id));
            }
        }
    }
    for m in lib.movies.iter().filter(|m| !m.missing && !m.frames_tried && m.backdrop.is_none()) {
        jobs.extend(file_id(&m.id).map(Job::Backdrop));
    }
    for e in lib.series.iter().flat_map(|s| &s.episodes).filter(|e| !e.missing && !e.frames_tried && e.still.is_none()) {
        jobs.extend(file_id(&e.id).map(Job::Still));
    }
    jobs
}

fn push(app: &AppHandle, jobs: Vec<Job>, asked: bool) {
    if jobs.is_empty() {
        return;
    }
    let state = app.state::<Frames>();
    {
        let mut known = state.known.lock().unwrap();
        let mut queue = state.queue.lock().unwrap();
        if asked {
            // What a page shows now goes first, in its own order, even if it was waiting further back.
            for job in jobs.into_iter().rev() {
                queue.retain(|(j, _)| *j != job);
                queue.push_front((job.clone(), true));
                known.insert(job);
            }
        } else {
            for job in jobs {
                if known.insert(job.clone()) {
                    queue.push_back((job, false));
                }
            }
        }
    }
    if !state.started.swap(true, Ordering::SeqCst) {
        let app = app.clone();
        std::thread::Builder::new().name("frames".into()).spawn(move || worker(app)).ok();
    }
    state.wake.notify_one();
}

/// Called with each library the pages are given: what it still lacks is queued, behind everything else.
pub fn after_library(app: &AppHandle, lib: &Library) {
    if cfg!(windows) {
        push(app, pending(lib), false);
    }
}

/// Forgets what waits and what was asked this session (the cache was cleared: everything may be asked again).
pub fn forget_queue(app: &AppHandle) {
    let state = app.state::<Frames>();
    state.queue.lock().unwrap().clear();
    state.known.lock().unwrap().clear();
}

/// A page shows these videos now (a film, a series' episodes; `show` is the series' key when its page has no
/// backdrop): their pictures are made first, even ones asked before that gave none.
#[tauri::command]
pub fn frames_want(app: AppHandle, paths: Vec<String>, show: Option<String>) -> Result<(), String> {
    if !cfg!(windows) || paths.is_empty() {
        return Ok(());
    }
    library::ensure_ready(&app)?;
    let mut jobs = vec![];
    {
        let db = app.state::<Db>();
        let conn = db.conn()?;
        if let Some(key) = show {
            let has: Option<String> = conn.query_row("SELECT backdrop FROM shows WHERE key = ?1 AND backdrop IS NOT NULL LIMIT 1", [&key], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
            let from: Option<i64> = conn.query_row("SELECT id FROM files WHERE path = ?1 AND missing = 0", [&paths[0]], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
            if let (None, Some(id)) = (has, from) {
                jobs.push(Job::Show(key, id));
            }
        }
        for path in &paths {
            let row: Option<(i64, String, Option<String>, Option<String>)> = conn
                .query_row(
                    "SELECT f.id, v.kind, v.backdrop, v.still FROM videos v JOIN files f ON f.id = v.file_id WHERE f.path = ?1 AND f.missing = 0",
                    [path],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match row {
                Some((id, kind, None, _)) if kind == "movie" => jobs.push(Job::Backdrop(id)),
                Some((id, kind, _, None)) if kind != "movie" => jobs.push(Job::Still(id)),
                _ => {}
            }
        }
    }
    push(&app, jobs, true);
    Ok(())
}

/// Tells the pages that pictures were made: the library is read again (the songs' covers are kept). The cache is
/// kept under its limit on the way.
fn announce(app: &AppHandle) {
    if let Ok(conn) = app.state::<Db>().conn() {
        crate::cache::tidy(&conn, &images_dir(app));
    }
    library::forget_library(app);
    let _ = app.emit("library://changed", ());
}

fn images_dir(app: &AppHandle) -> PathBuf {
    let dir = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("images");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[cfg(not(windows))]
fn worker(_app: AppHandle) {}

#[cfg(windows)]
fn worker(app: AppHandle) {
    use crate::engine::mpv::Mpv;
    let cache = images_dir(&app);
    let tmp = app.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir()).join("frames-tmp");
    let _ = std::fs::create_dir_all(&tmp);
    let state = app.state::<Frames>();
    let mut engine: Option<Mpv> = None;
    let mut made = 0usize;
    let mut announced = Instant::now();
    loop {
        let (job, asked) = {
            let mut queue = state.queue.lock().unwrap();
            loop {
                if let Some(next) = queue.pop_front() {
                    break next;
                }
                // Nothing left: the pages hear of what was made, and after a while the engine is let go.
                if made > 0 {
                    drop(queue);
                    announce(&app);
                    made = 0;
                    announced = Instant::now();
                    queue = state.queue.lock().unwrap();
                    continue;
                }
                let (q, timeout) = state.wake.wait_timeout(queue, Duration::from_secs(20)).unwrap();
                queue = q;
                if timeout.timed_out() && queue.is_empty() {
                    if let Some(e) = engine.take() {
                        e.close();
                    }
                }
            }
        };
        if engine.is_none() {
            engine = crate::engine::frame_engine(&app, &tmp).ok();
        }
        let Some(mpv) = engine.as_ref() else {
            // No engine (the DLL isn't there): nothing can be made this session.
            state.queue.lock().unwrap().clear();
            continue;
        };
        if make(&app, mpv, &tmp, &cache, &job).unwrap_or(false) {
            made += 1;
        }
        // What a page asked for shows as soon as its last one is made; the rest of the library every so often.
        let more_asked = state.queue.lock().unwrap().front().is_some_and(|(_, a)| *a);
        if made > 0 && ((asked && !more_asked) || announced.elapsed() > ANNOUNCE_EVERY) {
            announce(&app);
            made = 0;
            announced = Instant::now();
        }
        // Behind everything else: a breath between files.
        std::thread::sleep(Duration::from_millis(if asked { 0 } else { 60 }));
    }
}

/// The liveliest of the frames at `moments`, read back from the files the engine wrote.
#[cfg(windows)]
fn best_frame(mpv: &crate::engine::mpv::Mpv, tmp: &Path, path: &str, moments: &[u8]) -> Option<RgbImage> {
    let mut best: Option<(f64, RgbImage)> = None;
    for &at in moments {
        let Ok(file) = mpv.frame(path, at, tmp) else { continue };
        let Ok(img) = image::open(&file) else { continue };
        let img = img.to_rgb8();
        let score = liveliness(&img);
        if best.as_ref().is_none_or(|(s, _)| score > *s) {
            best = Some((score, img));
        }
    }
    best.map(|(_, img)| img)
}

/// Does one job; whether a picture was made. The file is marked as asked either way.
#[cfg(windows)]
fn make(app: &AppHandle, mpv: &crate::engine::mpv::Mpv, tmp: &Path, cache: &Path, job: &Job) -> Result<bool, String> {
    let id = match job {
        Job::Backdrop(id) | Job::Still(id) | Job::Show(_, id) => *id,
    };
    let row: Option<(String, Option<i64>)> = {
        let db = app.state::<Db>();
        let conn = db.conn()?;
        conn.query_row("SELECT f.path, v.duration_ms FROM videos v JOIN files f ON f.id = v.file_id WHERE f.id = ?1 AND f.missing = 0", [id], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .map_err(|e| e.to_string())?
    };
    let Some((path, duration)) = row else { return Ok(false) };
    // The engine works without the database held: a frame of a large film takes a moment.
    let img = if Path::new(&path).is_file() {
        // A very short video has one moment worth taking.
        let short = duration.is_some_and(|d| d < 60_000);
        match job {
            Job::Still(_) => best_frame(mpv, tmp, &path, &MOMENTS[1..2]),
            _ if short => best_frame(mpv, tmp, &path, &MOMENTS[1..2]),
            _ => best_frame(mpv, tmp, &path, &MOMENTS),
        }
    } else {
        None
    };
    let db = app.state::<Db>();
    let conn = db.conn()?;
    let made = match (job, &img) {
        (Job::Backdrop(_), Some(img)) => store(&conn, cache, img, "backdrop", BACKDROP_WIDTH)
            .map(|hash| conn.execute("UPDATE videos SET backdrop = ?2 WHERE file_id = ?1 AND backdrop IS NULL", params![id, hash]))
            .is_some(),
        (Job::Still(_), Some(img)) => store(&conn, cache, img, "still", STILL_WIDTH)
            .map(|hash| conn.execute("UPDATE videos SET still = ?2 WHERE file_id = ?1", params![id, hash]))
            .is_some(),
        (Job::Show(key, _), Some(img)) => store(&conn, cache, img, "backdrop", BACKDROP_WIDTH)
            .map(|hash| conn.execute("INSERT OR REPLACE INTO shows(key, source, backdrop, fetched_at) VALUES (?1, 'frame', ?2, ?3)", params![key, hash, db::now()]))
            .is_some(),
        _ => false,
    };
    match job {
        // A series that gave no frame is marked with a row that has no picture, so it is not asked again by itself.
        Job::Show(key, _) if !made => {
            let _ = conn.execute("INSERT OR REPLACE INTO shows(key, source, fetched_at) VALUES (?1, 'frame', ?2)", params![key, db::now()]);
        }
        Job::Show(..) => {}
        _ => {
            let _ = conn.execute("UPDATE videos SET frames_tried = 1 WHERE file_id = ?1", [id]);
        }
    }
    Ok(made)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{LibSeries, LibVideo};

    fn flat(value: u8) -> RgbImage {
        RgbImage::from_pixel(64, 36, image::Rgb([value, value, value]))
    }

    #[test]
    fn a_frame_with_something_in_it_beats_a_fade() {
        let mut busy = flat(120);
        for (i, p) in busy.pixels_mut().enumerate() {
            let v = if (i / 5) % 2 == 0 { 40 } else { 210 };
            *p = image::Rgb([v, v, v]);
        }
        let mut dark = flat(4);
        for (i, p) in dark.pixels_mut().enumerate() {
            if i % 3 == 0 {
                *p = image::Rgb([30, 30, 30]);
            }
        }
        assert!(liveliness(&busy) > liveliness(&flat(120)), "a flat frame is the dullest");
        assert!(liveliness(&busy) > liveliness(&dark) * 10.0, "a nearly black frame counts for little");
        assert_eq!(liveliness(&flat(0)), 0.0);
    }

    #[test]
    fn a_frame_is_kept_small_once_and_marked_as_a_frame() {
        let mut conn = Connection::open_in_memory().unwrap();
        db::migrate(&mut conn).unwrap();
        let cache = std::env::temp_dir().join(format!("pmp-frames-store-{}", std::process::id()));
        std::fs::create_dir_all(&cache).unwrap();
        let wide = RgbImage::from_fn(1920, 1080, |x, y| image::Rgb([(x % 255) as u8, (y % 255) as u8, 90]));
        let hash = store(&conn, &cache, &wide, "backdrop", BACKDROP_WIDTH).unwrap();
        assert_eq!(hash.len(), 32);
        let (w, h, origin): (u32, u32, String) = conn.query_row("SELECT w, h, origin FROM images WHERE hash = ?1", [&hash], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((w, h, origin.as_str()), (1280, 720, "frame"));
        assert_eq!(image::image_dimensions(cache.join(format!("{hash}.jpg"))).unwrap(), (1280, 720));
        // The same frame again is the same picture
        assert_eq!(store(&conn, &cache, &wide, "backdrop", BACKDROP_WIDTH), Some(hash));
        std::fs::remove_dir_all(cache).ok();
    }

    #[test]
    fn only_what_lacks_a_picture_and_can_be_found_is_asked() {
        let video = |id: &str, more: LibVideo| LibVideo { id: id.into(), ..more };
        let lib = Library {
            movies: vec![
                video("v1", LibVideo::default()),
                video("v2", LibVideo { backdrop: Some("aa".into()), ..Default::default() }),
                video("v3", LibVideo { missing: true, ..Default::default() }),
                video("v4", LibVideo { frames_tried: true, ..Default::default() }),
            ],
            series: vec![LibSeries {
                id: "s0".into(),
                key: "dark".into(),
                episodes: vec![
                    video("v10", LibVideo { season: Some(0), ..Default::default() }),
                    video("v11", LibVideo { season: Some(1), still: Some("bb".into()), ..Default::default() }),
                    video("v12", LibVideo { season: Some(1), ..Default::default() }),
                ],
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(pending(&lib), vec![Job::Show("dark".into(), 11), Job::Backdrop(1), Job::Still(10), Job::Still(12)]);
    }
}
