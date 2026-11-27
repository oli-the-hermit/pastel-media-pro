//! The library (Phase 3): what `import.rs` put in `library.db`, shaped for the pages (albums; films and series). It
//! is opened when a media page first needs it, never at launch (D16), and kept in memory until an import, a rescan or
//! a removed place changes it. On that first use the places are checked for changes in the background. The folders
//! are the person's places; a build with the `test-media` feature also adds the repo's `media_to_test` folder (or
//! `PASTEL_TEST_MEDIA`). Read-only: nothing is ever written to the person's folders.
//!
//! The scan below (`scan`, `scan_all`) is the Phase 2 reader, kept for the web version's test library
//! (`bin/library-export.rs`); both share how songs become albums and episodes become series (`assemble`).

use crate::db::Db;
use crate::formats::{self, MediaKind};
use crate::parse::{self, Kind};
use base64::Engine as _;
use lofty::config::{ParseOptions, ParsingMode};
use lofty::file::{AudioFile, TaggedFile, TaggedFileExt};
use lofty::picture::PictureType;
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, Tag};
use rusqlite::Connection;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use walkdir::WalkDir;

const FOLDER_COVERS: &[&str] = &["cover.jpg", "folder.jpg", "front.jpg", "album.jpg", "cover.png", "folder.png"];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub number: Option<u32>,
    pub disc: Option<u32>,
    pub year: Option<u32>,
    /// Seconds.
    pub duration: f64,
    pub path: String,
    /// Set when the file has tags but no audio the engine can read.
    pub unplayable: bool,
    /// When it joined the library, in seconds since 1970; 0 for a file read without the database.
    pub added_at: i64,
    /// The file isn't where the library has it ("Can't find this file").
    pub missing: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibAlbum {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub year: Option<u32>,
    pub track_ids: Vec<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LibVideo {
    pub id: String,
    pub title: String,
    pub year: Option<u16>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    /// An episode's own title, when its file name (or its `.nfo`) gives one.
    pub episode_title: Option<String>,
    pub file_name: String,
    pub path: String,
    /// Seconds, from the quick probe.
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// From a `.nfo` or a sidecar.
    pub overview: Option<String>,
    pub genres: Vec<String>,
    /// Images (`library_image`), from the art beside the file.
    pub poster: Option<String>,
    pub backdrop: Option<String>,
    /// When it joined the library, in seconds since 1970. For a file read without the database (the web version's
    /// test library): when it was last changed, which stands in for it.
    pub added_at: i64,
    /// The file isn't where the library has it ("Can't find this file").
    pub missing: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibSeries {
    pub id: String,
    pub title: String,
    pub poster: Option<String>,
    pub episodes: Vec<LibVideo>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    /// The folders it comes from, as shown to people; empty when there are none.
    pub roots: Vec<String>,
    pub tracks: Vec<LibTrack>,
    pub albums: Vec<LibAlbum>,
    pub movies: Vec<LibVideo>,
    pub series: Vec<LibSeries>,
    pub scan_ms: u64,
}

#[derive(Default)]
pub struct LibraryState {
    /// The places' folders (canonical), and the test folder in a build that has one: the engine opens files in them.
    folders: Mutex<Vec<PathBuf>>,
    /// The database is open, `library-folders.json` moved into it, the places known.
    ready: AtomicBool,
    /// Grows at every change: a library built before a change is not kept.
    generation: AtomicU64,
    library: Mutex<Option<Library>>,
    /// Album id → the files to look in for its cover, and the thumbnail once made.
    cover_sources: Mutex<HashMap<String, Vec<PathBuf>>>,
    covers: Mutex<HashMap<String, Option<String>>>,
}

/// The test folder, in a build that has one.
pub fn root() -> Option<PathBuf> {
    if !cfg!(feature = "test-media") {
        return None;
    }
    let p = std::env::var("PASTEL_TEST_MEDIA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../media_to_test")));
    p.canonicalize().ok().filter(|p| p.is_dir())
}

/// Whether the engine may open this path: a file in the library, or inside one of its places.
pub fn allowed(app: &AppHandle, path: &str) -> bool {
    let Ok(p) = Path::new(path).canonicalize() else { return false };
    if !p.is_file() {
        return false;
    }
    let state = app.state::<LibraryState>();
    if state.folders.lock().unwrap().iter().any(|r| p.starts_with(r)) {
        return true;
    }
    // A file added on its own: only once the library is open (a page showed it).
    state.ready.load(Ordering::SeqCst)
        && app.state::<Db>().conn().ok().is_some_and(|c| c.query_row("SELECT 1 FROM files WHERE path = ?1", [p.to_string_lossy()], |_| Ok(())).is_ok())
}

/// A folder as people see it: without Windows' `\\?\` long-path prefix.
pub fn shown(path: &Path) -> String {
    path.to_string_lossy().trim_start_matches(r"\\?\").to_string()
}

fn folders_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("library-folders.json"))
}

/// The folders of Phase 2's `library-folders.json` become places (filters "Everything", as they were read), once.
/// They are imported by the first check for changes. The file is renamed, not deleted.
fn move_folders_file(app: &AppHandle, conn: &Connection) {
    let Some(file) = folders_file(app).filter(|f| f.is_file()) else { return };
    let saved: Vec<String> = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    for folder in saved {
        let p = PathBuf::from(&folder);
        let p = p.canonicalize().unwrap_or(p);
        let _ = crate::import::adopt_folder(conn, &p, &crate::filters::Filters::everything());
    }
    let _ = std::fs::rename(&file, file.with_extension("moved-to-library-db.json"));
}

/// Opens the library database on its first use: moves the old folder list in, adds a test build's folder, and
/// learns the places. Cheap after the first call.
pub fn ensure_ready(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<LibraryState>();
    if state.ready.load(Ordering::SeqCst) {
        return Ok(());
    }
    {
        let db = app.state::<Db>();
        let conn = db.conn()?;
        move_folders_file(app, &conn);
        if let Some(test) = root() {
            let _ = crate::import::adopt_folder(&conn, &test, &crate::filters::Filters::everything());
        }
    }
    state.ready.store(true, Ordering::SeqCst);
    refresh_places(app);
    Ok(())
}

/// Reads the places' folders again (after one is added or removed).
pub fn refresh_places(app: &AppHandle) {
    let db = app.state::<Db>();
    let Ok(conn) = db.conn() else { return };
    let places: Vec<PathBuf> = crate::import::places(&conn).into_iter().map(|p| p.root).chain(root()).collect();
    drop(conn);
    *app.state::<LibraryState>().folders.lock().unwrap() = places;
}

/// Forgets the library built in memory: the next `library_get` reads the database again.
pub fn invalidate(app: &AppHandle) {
    let state = app.state::<LibraryState>();
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.library.lock().unwrap() = None;
    state.cover_sources.lock().unwrap().clear();
    state.covers.lock().unwrap().clear();
}

/// First non-empty value of a field over the file's tags, primary first: an MP3 with only ID3v1 has an empty
/// ID3v2 as its primary tag (S6).
fn text(tf: &TaggedFile, get: impl Fn(&Tag) -> Option<String>) -> String {
    let primary = tf.primary_tag();
    primary
        .into_iter()
        .chain(tf.tags().iter().filter(|t| Some(t.tag_type()) != primary.map(|p| p.tag_type())))
        .filter_map(|t| get(t).map(|s| s.trim().to_string()))
        .find(|s| !s.is_empty())
        .unwrap_or_default()
}

fn number(tf: &TaggedFile, get: impl Fn(&Tag) -> Option<u32>) -> Option<u32> {
    tf.tags().iter().find_map(get)
}

/// An MP3's length in seconds without its tags: from the first frame's count of frames (a Xing or Info header)
/// or else from its bitrate and the file's size. A fair guess for a song whose tags can't be read.
fn mp3_seconds(path: &Path) -> Option<f64> {
    use std::io::{Read, Seek, SeekFrom};
    if !path.extension()?.to_string_lossy().eq_ignore_ascii_case("mp3") {
        return None;
    }
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    let mut head = [0u8; 10];
    f.read_exact(&mut head).ok()?;
    // An ID3v2 tag says how long it is; one that lies (past the file's end) is not believed
    let mut start = 0u64;
    if &head[..3] == b"ID3" {
        start = 10 + (((head[6] & 0x7f) as u64) << 21 | ((head[7] & 0x7f) as u64) << 14 | ((head[8] & 0x7f) as u64) << 7 | (head[9] & 0x7f) as u64);
        if start >= len {
            start = 0;
        }
    }
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = vec![];
    f.take(128 * 1024).read_to_end(&mut buf).ok()?;
    for i in 0..buf.len().saturating_sub(4) {
        if buf[i] != 0xFF || buf[i + 1] & 0xE0 != 0xE0 {
            continue;
        }
        let (version, layer) = ((buf[i + 1] >> 3) & 3, (buf[i + 1] >> 1) & 3);
        let (bitrate, rate) = ((buf[i + 2] >> 4) as usize, ((buf[i + 2] >> 2) & 3) as usize);
        if version == 1 || layer != 1 || bitrate == 0 || bitrate == 15 || rate == 3 {
            continue;
        }
        let v1 = version == 3;
        let kbps = if v1 { [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][bitrate] } else { [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][bitrate] };
        let hz = [44100u32, 48000, 32000][rate] >> if v1 { 0 } else if version == 2 { 1 } else { 2 };
        let samples = if v1 { 1152.0 } else { 576.0 };
        let frame = &buf[i..(i + 200).min(buf.len())];
        if let Some(x) = frame.windows(4).position(|w| w == b"Xing" || w == b"Info") {
            if frame.len() >= x + 12 && frame[x + 7] & 1 == 1 {
                let frames = u32::from_be_bytes([frame[x + 8], frame[x + 9], frame[x + 10], frame[x + 11]]) as f64;
                if frames > 0.0 {
                    return Some(frames * samples / hz as f64);
                }
            }
        }
        return Some((len - start - i as u64) as f64 * 8.0 / (kbps as f64 * 1000.0));
    }
    None
}

/// A song whose tags can't be read is still a song, and still in the library: named by its file ("07 - Title.mp3"
/// gives its number too), in an album named after its folder. Its length is worked out for an MP3; for the rest it
/// is filled in the first time the song plays.
fn track_from_name(path: &Path) -> Option<(LibTrack, String)> {
    if std::fs::metadata(path).ok()?.len() == 0 {
        return None;
    }
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let digits: String = stem.chars().take_while(|c| c.is_ascii_digit()).collect();
    let after = &stem[digits.len()..];
    let rest = after.trim_start_matches([' ', '-', '.', '_']);
    // "07 - Title", "07. Title", "07 Title"; not "99 Luftballons"
    let marked = after.trim_start().starts_with(['-', '.', '_']) || (digits.starts_with('0') && after.starts_with(' '));
    let (number, title) = if (1..=3).contains(&digits.len()) && marked && !rest.is_empty() { (digits.parse().ok(), rest.to_string()) } else { (None, stem.clone()) };
    let album = path.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let track = LibTrack {
        id: String::new(),
        title,
        artist: String::new(),
        album,
        number,
        disc: None,
        year: None,
        duration: mp3_seconds(path).unwrap_or(0.0),
        path: path.to_string_lossy().to_string(),
        unplayable: false,
        added_at: 0,
        missing: false,
    };
    Some((track, String::new()))
}

/// One song's tags and length (cover art skipped), and its album artist. A song whose tags can't be read is named by
/// its file (`track_from_name`); `None` only for a file that can't be opened or is empty.
pub(crate) fn read_track(path: &Path) -> Option<(LibTrack, String)> {
    let opts = ParseOptions::new().read_cover_art(false);
    let (tf, unplayable) = match Probe::open(path).ok()?.options(opts).read() {
        Ok(tf) => (tf, false),
        // Tags but no readable audio (a downloader left only the tag): keep it, flagged (S6).
        Err(_) => match Probe::open(path).ok()?.options(ParseOptions::new().read_cover_art(false).read_properties(false).parsing_mode(ParsingMode::Relaxed)).read() {
            Ok(tf) => (tf, true),
            Err(_) => return track_from_name(path),
        },
    };
    let stem = path.file_stem()?.to_string_lossy().to_string();
    let title = Some(text(&tf, |t| t.title().map(|s| s.to_string()))).filter(|s| !s.is_empty()).unwrap_or(stem);
    let album_artist = text(&tf, |t| t.get_string(ItemKey::AlbumArtist).map(String::from));
    let artist = text(&tf, |t| t.artist().map(|s| s.to_string()));
    let track = LibTrack {
        id: String::new(),
        title,
        artist: artist.clone(),
        album: text(&tf, |t| t.album().map(|s| s.to_string())),
        number: number(&tf, |t| t.track()),
        disc: number(&tf, |t| t.disk()),
        year: number(&tf, |t| t.date().map(|d| d.year as u32)),
        duration: tf.properties().duration().as_secs_f64(),
        path: path.to_string_lossy().to_string(),
        unplayable,
        added_at: 0,
        missing: false,
    };
    Some((track, if album_artist.is_empty() { artist } else { album_artist }))
}

/// A video as the pages group it: movie or episode, and for an episode the show's folder (above a season folder)
/// or else its parsed title.
pub struct VideoEntry {
    pub video: LibVideo,
    pub kind: Kind,
    pub show_folder: Option<String>,
    pub show_title: String,
}

/// Songs into albums (by album artist, or artist, and album title; songs without an album share one), videos into
/// films and series (by the show's folder, or else by their title compared loosely, `parse::series_key`). Ids that
/// are already set are kept (the database's); the others are numbered.
pub fn assemble(roots: Vec<String>, audio: Vec<(LibTrack, String)>, mut videos: Vec<VideoEntry>) -> (Library, HashMap<String, Vec<PathBuf>>) {
    settle_folders(&mut videos);
    let mut groups: BTreeMap<(String, String), Vec<LibTrack>> = BTreeMap::new();
    for (t, album_artist) in audio {
        groups.entry((album_artist.to_lowercase(), t.album.to_lowercase())).or_default().push(t);
    }
    let (mut lib, mut sources) = (Library { roots, ..Default::default() }, HashMap::new());
    // A compilation's songs carry their own artists and often no album artist, which made one album per artist.
    // Groups that share a title and a folder are one album; it has no artist of its own (the page says "Various artists").
    let mut merged: Vec<(Vec<LibTrack>, bool)> = vec![];
    let mut home: HashMap<(String, String), usize> = HashMap::new();
    for ((_, title), tracks) in groups {
        let dirs: Vec<String> = tracks.iter().map(|t| Path::new(&t.path).parent().map(|d| d.to_string_lossy().to_lowercase()).unwrap_or_default()).collect();
        let found = if title.is_empty() { None } else { dirs.iter().find_map(|d| home.get(&(title.clone(), d.clone())).copied()) };
        let at = match found {
            Some(at) => {
                merged[at].0.extend(tracks);
                merged[at].1 = true;
                at
            }
            None => {
                merged.push((tracks, false));
                merged.len() - 1
            }
        };
        for d in dirs {
            home.entry((title.clone(), d)).or_insert(at);
        }
    }
    for (i, (mut tracks, compilation)) in merged.into_iter().enumerate() {
        tracks.sort_by(|a, b| (a.disc, a.number, &a.path).cmp(&(b.disc, b.number, &b.path)));
        let id = format!("a{i}");
        let first = &tracks[0];
        let several = tracks.iter().any(|t| !t.artist.eq_ignore_ascii_case(&first.artist));
        let artist = if compilation && several { String::new() } else { tracks.iter().map(|t| t.artist.clone()).find(|a| !a.is_empty()).unwrap_or_default() };
        let mut album = LibAlbum { id: id.clone(), title: first.album.clone(), artist, year: tracks.iter().find_map(|t| t.year), track_ids: vec![] };
        sources.insert(id.clone(), tracks.iter().map(|t| PathBuf::from(&t.path)).collect::<Vec<_>>());
        for (j, mut t) in tracks.into_iter().enumerate() {
            if t.id.is_empty() {
                t.id = format!("{id}t{j}");
            }
            album.track_ids.push(t.id.clone());
            lib.tracks.push(t);
        }
        lib.albums.push(album);
    }

    #[derive(Default)]
    struct Show {
        folder: Option<String>,
        titles: Vec<String>,
        episodes: Vec<LibVideo>,
    }
    let mut series: BTreeMap<String, Show> = BTreeMap::new();
    for (i, mut e) in videos.into_iter().enumerate() {
        if e.video.id.is_empty() {
            e.video.id = format!("v{i}");
        }
        match e.kind {
            Kind::Movie => lib.movies.push(e.video),
            Kind::Episode => {
                let show = series.entry(parse::series_key(e.show_folder.as_deref().unwrap_or(&e.show_title))).or_default();
                show.folder = show.folder.take().or(e.show_folder);
                show.titles.push(e.show_title);
                show.episodes.push(e.video);
            }
        }
    }
    lib.movies.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()).then(a.year.cmp(&b.year)));
    for (i, (_, mut show)) in series.into_iter().enumerate() {
        show.episodes.sort_by(|a, b| (a.season.unwrap_or(0), a.episode.unwrap_or(0), &a.file_name).cmp(&(b.season.unwrap_or(0), b.episode.unwrap_or(0), &b.file_name)));
        let title = show.folder.unwrap_or_else(|| most_common(&show.titles));
        for e in &mut show.episodes {
            e.title = title.clone();
        }
        let poster = show.episodes.iter().find_map(|e| e.poster.clone());
        lib.series.push(LibSeries { id: format!("s{i}"), title, poster, episodes: show.episodes });
    }
    (lib, sources)
}

/// Reads a folder: the songs grouped into albums, the videos into movies and series, and for each album the files its cover may come from.
pub fn scan(root: &Path) -> (Library, HashMap<String, Vec<PathBuf>>) {
    scan_all(&[root.to_path_buf()])
}

/// Reads several folders into one library, without the database (the web version's test library).
pub fn scan_all(roots: &[PathBuf]) -> (Library, HashMap<String, Vec<PathBuf>>) {
    let started = std::time::Instant::now();
    let (mut audio, mut video) = (vec![], vec![]);
    for root in roots {
        for e in WalkDir::new(root).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_file()) {
            match formats::kind_of(e.path()) {
                Some(MediaKind::Audio) => audio.push(e.path().to_path_buf()),
                Some(MediaKind::Video) => video.push((root.clone(), e.path().to_path_buf())),
                None => {}
            }
        }
    }
    // No database, so no day a file was added: when it was last changed stands in, and the pages that list
    // "recently added" have something to order by. Lengths come from the quick probe, as in an import.
    let changed = |p: &Path| {
        let at = std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
        at.map_or(0, |d| d.as_secs() as i64)
    };
    let tracks = audio
        .iter()
        .filter_map(|p| {
            read_track(p).map(|(mut t, artist)| {
                t.added_at = changed(p);
                (t, artist)
            })
        })
        .collect();
    let videos = video
        .iter()
        .map(|(root, p)| {
            let rel = p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/");
            let parsed = parse::parse(&rel);
            let root_name = root.file_name().map(|n| n.to_string_lossy().into_owned());
            let probed = crate::probe::probe(p).unwrap_or_default();
            VideoEntry {
                video: LibVideo {
                    title: parsed.title.clone(),
                    year: parsed.year,
                    season: parsed.season,
                    episode: parsed.episode,
                    episode_title: parsed.episode_title.clone(),
                    file_name: p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
                    path: p.to_string_lossy().to_string(),
                    duration: probed.duration,
                    width: probed.width,
                    height: probed.height,
                    added_at: changed(p),
                    ..Default::default()
                },
                kind: parsed.kind,
                show_folder: parse::show_folder_in(&rel, root_name.as_deref()),
                show_title: parsed.title,
            }
        })
        .collect();
    // Paths keep Windows' long-path prefix (long paths reach the engine intact, S4); the folders are shown without it.
    let (mut lib, sources) = assemble(roots.iter().map(|r| shown(r)).collect(), tracks, videos);
    lib.scan_ms = started.elapsed().as_millis() as u64;
    (lib, sources)
}

/// Reads the videos of each folder together, because a name alone can mislead:
/// - a folder where most episodes are one show's is that show's: its other episodes join it when the folder is named
///   after it or their name is close to it, and its "films" with the show's name or a running number are episodes;
/// - a folder with no episodes whose films differ only by a running number ("Show 01", "Show 02", "Show 03") holds
///   a show named without season marks.
/// Sequels stay films: they carry a year, or a one-digit number and a film's length.
fn settle_folders(videos: &mut [VideoEntry]) {
    let key_of = |e: &VideoEntry| parse::series_key(e.show_folder.as_deref().unwrap_or(&e.show_title));
    let related = |a: &str, b: &str| !a.is_empty() && !b.is_empty() && (a == b || a.starts_with(&format!("{b} ")) || b.starts_with(&format!("{a} ")));
    let mut by_dir: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (i, e) in videos.iter().enumerate() {
        let dir = Path::new(&e.video.path).parent().map(|p| p.to_string_lossy().to_lowercase()).unwrap_or_default();
        by_dir.entry(dir).or_default().push(i);
    }
    for idx in by_dir.into_values() {
        if idx.len() < 2 {
            continue;
        }
        let mut counts: BTreeMap<String, usize> = BTreeMap::new();
        for &i in &idx {
            if videos[i].kind == Kind::Episode {
                *counts.entry(key_of(&videos[i])).or_default() += 1;
            }
        }
        let episodes: usize = counts.values().sum();
        let top = counts.iter().filter(|(k, n)| !k.is_empty() && **n >= 2).max_by(|a, b| a.1.cmp(b.1).then(b.0.cmp(a.0))).map(|(k, n)| (k.clone(), *n));
        if let Some((top, n)) = top {
            let lead = idx.iter().map(|&i| &videos[i]).find(|e| e.kind == Kind::Episode && key_of(e) == top).map(|e| (e.show_folder.clone(), e.show_title.clone()));
            let Some((lead_folder, lead_title)) = lead else { continue };
            let mut seasons: BTreeMap<u32, usize> = BTreeMap::new();
            for &i in &idx {
                if let (Kind::Episode, Some(s)) = (&videos[i].kind, videos[i].video.season) {
                    *seasons.entry(s).or_default() += 1;
                }
            }
            let season = seasons.into_iter().max_by_key(|(_, c)| *c).map(|(s, _)| s);
            // The folder is the show's own, or one of its seasons', when its name says so
            let folder_key = Path::new(&videos[idx[0]].video.path)
                .ancestors()
                .skip(1)
                .filter_map(|a| a.file_name().map(|f| f.to_string_lossy().into_owned()))
                .find_map(|name| match parse::season_of(&name) {
                    Some((_, None)) => None,
                    Some((_, Some(show))) => Some(show),
                    None => Some(parse::folder_title(&name)),
                })
                .map(|t| parse::series_key(&t))
                .unwrap_or_default();
            let owns = related(&folder_key, &top) && n * 2 >= episodes;
            for &i in &idx {
                let key = key_of(&videos[i]);
                let e = &mut videos[i];
                match e.kind {
                    Kind::Episode => {
                        if key != top && (owns || related(&key, &top)) {
                            e.show_folder = lead_folder.clone();
                            e.show_title = lead_title.clone();
                        }
                    }
                    Kind::Movie => {
                        let number = parse::numbered(&e.video.title);
                        let named = related(&key, &top) || number.as_ref().is_some_and(|(base, ..)| related(&parse::series_key(base), &top));
                        // "Friends with Benefits (2011)" beside two episodes of Friends stays a film
                        let a_film = e.video.year.is_some() && number.is_none() && !owns;
                        if (named && !a_film) || (owns && number.is_some()) {
                            if key != top && number.is_none() && e.video.episode_title.is_none() {
                                e.video.episode_title = Some(e.video.title.clone());
                            }
                            e.kind = Kind::Episode;
                            e.video.episode = number.map(|(_, n, _)| n);
                            e.video.season = if parse::special_of(&e.video.title).is_some() { Some(0) } else { e.video.season.or(season) };
                            e.show_folder = lead_folder.clone();
                            e.show_title = lead_title.clone();
                        }
                    }
                }
            }
            continue;
        }
        let mut runs: BTreeMap<String, Vec<(usize, u32, bool)>> = BTreeMap::new();
        for &i in &idx {
            let e = &videos[i];
            if e.kind == Kind::Movie && e.video.year.is_none() {
                if let Some((base, n, padded)) = parse::numbered(&e.video.title) {
                    runs.entry(parse::series_key(&base)).or_default().push((i, n, padded));
                }
            }
        }
        for (key, run) in runs {
            let mut numbers: Vec<u32> = run.iter().map(|r| r.1).collect();
            numbers.sort_unstable();
            numbers.dedup();
            let short = run.iter().all(|r| videos[r.0].video.duration.is_some_and(|d| d < 80.0 * 60.0));
            if key.is_empty() || run.len() < 3 || numbers.len() != run.len() || !(run.iter().all(|r| r.2) || short) {
                continue;
            }
            let Some((title, ..)) = parse::numbered(&videos[run[0].0].video.title) else { continue };
            for (i, n, _) in run {
                let e = &mut videos[i];
                e.kind = Kind::Episode;
                e.video.episode = Some(n);
                e.show_title = title.clone();
            }
        }
    }
}

/// The title most episodes use (the shortest of those that tie): "Mr. Robot" over a stray "Mr Robot Season 2".
fn most_common(titles: &[String]) -> String {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for t in titles.iter().filter(|t| !t.is_empty()) {
        *counts.entry(t.as_str()).or_default() += 1;
    }
    counts.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.len().cmp(&a.0.len())).then(b.0.cmp(a.0))).map(|(t, _)| t.to_string()).unwrap_or_default()
}

/// Whether a file of the library can't be found: a check for changes said so, or, for a file added on its own
/// (no library folder is checked for it), it isn't there now.
fn gone(flagged: bool, place: Option<i64>, path: &str) -> bool {
    flagged || (place.is_none() && !Path::new(path).is_file())
}

fn file_name_of(path: &str) -> String {
    Path::new(path).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The library as the pages show it, from the database: every file it holds, the ones that can't be found marked
/// `missing` ("Can't find this file"); the person's corrections over the `.nfo` over the file name.
pub fn from_db(conn: &Connection) -> rusqlite::Result<(Library, HashMap<String, Vec<PathBuf>>)> {
    let started = std::time::Instant::now();
    let roots: Vec<String> = crate::import::places(conn).iter().map(|p| shown(&p.root)).collect();
    let audio = conn
        .prepare(
            "SELECT f.id, f.path, t.title, t.artist, t.album_artist, t.album, t.track_no, t.disc_no, t.year, t.duration_ms, t.problem, f.added_at,
                    f.missing, f.place_id
             FROM tracks t JOIN files f ON f.id = t.file_id",
        )?
        .query_map([], |r| {
            let path: String = r.get(1)?;
            Ok((
                LibTrack {
                    id: format!("t{}", r.get::<_, i64>(0)?),
                    missing: gone(r.get(12)?, r.get(13)?, &path),
                    path,
                    title: r.get(2)?,
                    artist: r.get(3)?,
                    album: r.get(5)?,
                    number: r.get(6)?,
                    disc: r.get(7)?,
                    year: r.get(8)?,
                    duration: r.get::<_, i64>(9)? as f64 / 1000.0,
                    unplayable: r.get::<_, Option<String>>(10)?.is_some(),
                    added_at: r.get(11)?,
                },
                r.get::<_, String>(4)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let videos = conn
        .prepare(
            "SELECT f.id, f.path, o.kind, v.title, o.year, o.season,
                    o.episode, v.episode_title, v.show_folder, v.poster, v.backdrop, v.duration_ms, v.width, v.height,
                    o.title, m.title, m.year, m.overview, m.genres, p.path, f.added_at, f.missing, f.place_id
             FROM videos v JOIN files f ON f.id = v.file_id
             LEFT JOIN places p ON p.id = f.place_id
             LEFT JOIN overrides o ON o.file_id = f.id
             LEFT JOIN metadata m ON m.id = (SELECT id FROM metadata WHERE file_id = f.id ORDER BY CASE source WHEN 'nfo' THEN 0 WHEN 'sidecar' THEN 1 ELSE 2 END LIMIT 1)",
        )?
        .query_map([], |r| {
            let path: String = r.get(1)?;
            // The name is read again here, not taken from what the import wrote down: the parser's later fixes then
            // reach files that are already in the library, with no rescan. The person's corrections still come first.
            let place: Option<String> = r.get(19)?;
            let rel = crate::import::rel_of(place.as_deref().map(Path::new), Path::new(&path));
            let parsed = parse::parse(&rel);
            let place_name = place.as_deref().and_then(|p| Path::new(p).file_name()).map(|n| n.to_string_lossy().into_owned());
            let kind = match r.get::<_, Option<String>>(2)?.as_deref() {
                Some("movie") => Kind::Movie,
                Some(_) => Kind::Episode,
                None => parsed.kind.clone(),
            };
            let parsed_title = parsed.title.clone();
            let (over_title, meta_title): (Option<String>, Option<String>) = (r.get(14)?, r.get(15)?);
            // A film's `.nfo` names the film; an episode's names the episode (its show comes from the folder or name).
            let (title, episode_title) = match kind {
                Kind::Movie => (over_title.clone().or(meta_title).unwrap_or_else(|| parsed_title.clone()), parsed.episode_title.clone()),
                Kind::Episode => (over_title.clone().unwrap_or_else(|| parsed_title.clone()), meta_title.or(parsed.episode_title.clone())),
            };
            let year = r.get::<_, Option<u16>>(4)?.or(parsed.year).or(if kind == Kind::Movie { r.get(16)? } else { None });
            Ok(VideoEntry {
                video: LibVideo {
                    id: format!("v{}", r.get::<_, i64>(0)?),
                    title,
                    year,
                    season: r.get::<_, Option<u32>>(5)?.or(parsed.season),
                    episode: r.get::<_, Option<u32>>(6)?.or(parsed.episode),
                    episode_title,
                    file_name: file_name_of(&path),
                    missing: gone(r.get(21)?, r.get(22)?, &path),
                    path,
                    poster: r.get(9)?,
                    backdrop: r.get(10)?,
                    duration: r.get::<_, Option<i64>>(11)?.map(|d| d as f64 / 1000.0),
                    width: r.get(12)?,
                    height: r.get(13)?,
                    overview: r.get(17)?,
                    genres: r.get::<_, Option<String>>(18)?.map(|g| g.split(", ").map(String::from).collect()).unwrap_or_default(),
                    added_at: r.get(20)?,
                },
                kind,
                show_folder: parse::show_folder_in(&rel, place_name.as_deref()),
                show_title: over_title.unwrap_or(parsed_title),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let (mut lib, sources) = assemble(roots, audio, videos);
    lib.scan_ms = started.elapsed().as_millis() as u64;
    Ok((lib, sources))
}

/// The library, read from the database on the first call after a start or a change (a few milliseconds for a
/// test folder). The first call of a session also checks the places for changes, in the background: quietly,
/// unless a place has never been read (then its row shows in the queue).
#[tauri::command]
pub async fn library_get(app: AppHandle) -> Result<Library, String> {
    ensure_ready(&app)?;
    let state = app.state::<LibraryState>();
    let imports = app.state::<crate::import::ImportState>();
    if !imports.rescanned.swap(true, Ordering::SeqCst) {
        let never_read = app.state::<Db>().conn()?.query_row("SELECT count(*) FROM places WHERE last_scan_at IS NULL", [], |r| r.get::<_, i64>(0)).unwrap_or(0) > 0;
        let _ = crate::import::rescan(&app, None, !never_read);
    }
    if let Some(l) = state.library.lock().unwrap().clone() {
        return Ok(l);
    }
    let generation = state.generation.load(Ordering::SeqCst);
    let app2 = app.clone();
    let (lib, sources) = tauri::async_runtime::spawn_blocking(move || {
        let db = app2.state::<Db>();
        let conn = db.conn()?;
        from_db(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    // The library changed while this was read: the page asks again for the new one, so this one is not kept.
    if state.generation.load(Ordering::SeqCst) == generation {
        *state.cover_sources.lock().unwrap() = sources;
        *state.library.lock().unwrap() = Some(lib.clone());
    }
    Ok(lib)
}

fn cover_bytes(files: &[PathBuf]) -> Option<Vec<u8>> {
    for f in files.iter().take(3) {
        let tf = Probe::open(f).ok().and_then(|p| p.options(ParseOptions::new().read_properties(false)).read().ok());
        if let Some(tf) = tf {
            let pics: Vec<_> = tf.tags().iter().flat_map(|t| t.pictures()).collect();
            if let Some(p) = pics.iter().find(|p| p.pic_type() == PictureType::CoverFront).or(pics.first()) {
                return Some(p.data().to_vec());
            }
        }
    }
    let dir = files.first()?.parent()?;
    let names: Vec<_> = std::fs::read_dir(dir).ok()?.flatten().collect();
    let found = names.iter().find(|e| FOLDER_COVERS.contains(&e.file_name().to_string_lossy().to_lowercase().as_str()))?;
    std::fs::read(found.path()).ok()
}

/// An album's cover as a 256 px JPEG: its first embedded picture, or a cover image in its folder.
pub fn cover_thumbnail(files: &[PathBuf]) -> Option<Vec<u8>> {
    let img = image::load_from_memory(&cover_bytes(files)?).ok()?;
    let thumb = image::DynamicImage::ImageRgb8(img.thumbnail(256, 256).to_rgb8());
    let mut out = vec![];
    thumb.write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 82)).ok()?;
    Some(out)
}

/// An album's cover as a small JPEG data URL (256 px), or nothing. Made once per album.
#[tauri::command]
pub async fn library_cover(state: tauri::State<'_, LibraryState>, album_id: String) -> Result<Option<String>, String> {
    if let Some(c) = state.covers.lock().unwrap().get(&album_id) {
        return Ok(c.clone());
    }
    let files = state.cover_sources.lock().unwrap().get(&album_id).cloned().unwrap_or_default();
    let url = cover_url(files).await?;
    state.covers.lock().unwrap().insert(album_id, url.clone());
    Ok(url)
}

/// A cover as a small JPEG data URL, made off the window's thread.
pub async fn cover_url(files: Vec<PathBuf>) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        cover_thumbnail(&files).map(|jpg| format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpg)))
    })
    .await
    .map_err(|e| e.to_string())
}

/// A poster or backdrop from the image cache (made once by the import), as a JPEG data URL.
#[tauri::command]
pub async fn library_image(app: AppHandle, hash: String) -> Result<Option<String>, String> {
    if hash.len() != 32 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(None);
    }
    let file = app.path().app_data_dir().map_err(|e| e.to_string())?.join("images").join(format!("{hash}.jpg"));
    tauri::async_runtime::spawn_blocking(move || std::fs::read(file).ok().map(|jpg| format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpg))))
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn episodes_of_one_show_make_one_series_whatever_their_names() {
        let root = std::env::temp_dir().join(format!("pmp-series-{}", std::process::id()));
        let files = [
            "Mr.Robot.S01E02.720p.mkv",
            "Mr. Robot - S01E01 - Pilot.mkv",
            "Mr Robot (2015) S02E01.mkv",
            "Shows/Dark/Season 1/01 - Secrets.mkv",
            "Shows/Dark/Season 1/Dark.S01E02.GERMAN.1080p.mkv",
            "Shows/Dark/Temporada 2/Capitulo 1.mkv",
            "Films/Heat (1995).mkv",
        ];
        for f in files {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"").unwrap();
        }
        let (lib, _) = scan(&root);
        std::fs::remove_dir_all(&root).ok();

        let shows: Vec<_> = lib.series.iter().map(|s| (s.title.as_str(), s.episodes.len())).collect();
        assert_eq!(shows, vec![("Dark", 3), ("Mr Robot", 3)]);
        let robot = &lib.series[1];
        let order: Vec<_> = robot.episodes.iter().map(|e| (e.season, e.episode, e.episode_title.as_deref())).collect();
        assert_eq!(order, vec![(Some(1), Some(1), Some("Pilot")), (Some(1), Some(2), None), (Some(2), Some(1), None)]);
        assert!(robot.episodes.iter().all(|e| e.title == "Mr Robot"));
        assert_eq!(lib.series[0].episodes[0].episode_title.as_deref(), Some("Secrets"));
        assert_eq!(lib.movies.len(), 1);
    }

    #[test]
    fn the_database_gives_the_pages_the_same_shapes_with_the_nfo_over_the_name() {
        let conn = crate::db::memory();
        conn.execute_batch(
            "INSERT INTO places(id, path, created_at) VALUES (1, 'D:\\Media', 1);
             INSERT INTO files(id, place_id, path, size, mtime, kind, added_at, scanned_at) VALUES
               (1, 1, 'D:\\Media\\Films\\heat.1995.mkv', 1, 1, 'video', 1, 1),
               (2, 1, 'D:\\Media\\Dark\\Season 1\\Dark.S01E01.mkv', 1, 1, 'video', 1, 1),
               (3, 1, 'D:\\Media\\Album\\01.mp3', 1, 1, 'audio', 1, 1),
               (4, 1, 'D:\\Media\\Gone.mkv', 1, 1, 'video', 1, 1);
             UPDATE files SET missing = 1 WHERE id = 4;
             INSERT INTO videos(file_id, kind, title, year, season, episode, show_folder, duration_ms, height, poster) VALUES
               (1, 'movie', 'heat', 1995, NULL, NULL, NULL, 6000000, 1080, 'aa'),
               (2, 'episode', 'Dark', NULL, 1, 1, 'Dark', 3000000, 1080, NULL),
               (4, 'movie', 'Gone', NULL, NULL, NULL, NULL, NULL, NULL, NULL);
             INSERT INTO metadata(file_id, source, title, overview, genres, fetched_at) VALUES
               (1, 'nfo', 'Heat', 'A thief.', 'Crime, Drama', 1),
               (2, 'nfo', 'Secrets', NULL, NULL, 1);
             INSERT INTO tracks(file_id, title, artist, album_artist, album, track_no, duration_ms) VALUES (3, 'Song', 'A', 'A', 'Album', 1, 200000);",
        )
        .unwrap();
        let (lib, sources) = from_db(&conn).unwrap();
        assert_eq!(lib.roots, vec![r"D:\Media"]);
        assert_eq!(lib.movies.len(), 2, "a missing file is kept, and says so");
        let gone = lib.movies.iter().find(|m| m.id == "v4").unwrap();
        assert!(gone.missing);
        let heat = lib.movies.iter().find(|m| m.id == "v1").unwrap();
        assert!(!heat.missing && !lib.tracks[0].missing);
        assert_eq!((heat.title.as_str(), heat.overview.as_deref(), heat.genres.len(), heat.duration), ("Heat", Some("A thief."), 2, Some(6000.0)));
        assert_eq!(heat.id, "v1");
        assert_eq!(lib.series[0].title, "Dark");
        assert_eq!(lib.series[0].episodes[0].episode_title.as_deref(), Some("Secrets"));
        assert_eq!((lib.albums.len(), lib.tracks[0].id.as_str(), lib.tracks[0].duration), (1, "t3", 200.0));
        assert_eq!(sources[&lib.albums[0].id].len(), 1);
    }

    #[test]
    fn shows_folders_without_the_long_path_prefix() {
        assert_eq!(shown(Path::new(r"\\?\D:\Media\Films")), r"D:\Media\Films");
    }

    /// A library folder with these files, read without the database.
    fn scanned(name: &str, files: &[&str]) -> Library {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("pmp-{}-{n}", std::process::id())).join(name);
        for f in files {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, b"").unwrap();
        }
        let (lib, _) = scan(&root);
        std::fs::remove_dir_all(root.parent().unwrap()).ok();
        lib
    }
    fn shows(lib: &Library) -> Vec<(String, usize)> {
        lib.series.iter().map(|s| (s.title.clone(), s.episodes.len())).collect()
    }

    #[test]
    fn a_show_s_folder_holds_one_series_however_its_files_are_named() {
        let lib = scanned(
            "Series",
            &[
                "The Big Bang Theory/The.Big.Bang.Theory.S01E01.720p.mkv",
                "The Big Bang Theory/The Big Bang Theory - S01E02 - The Big Bran Hypothesis.mkv",
                "The Big Bang Theory/TBBT.S01E03.mkv",
                "The Big Bang Theory/Big Bang Theory 1x04.avi",
            ],
        );
        assert_eq!(shows(&lib), vec![("The Big Bang Theory".to_string(), 4)]);
        assert!(lib.movies.is_empty());
    }

    #[test]
    fn seasons_in_folders_of_their_own_make_one_series() {
        let lib = scanned(
            "Series",
            &[
                "Dark S01/Dark.S01E01.mkv",
                "Dark S01/Dark.S01E02.mkv",
                "Dark.S02.1080p.BluRay.x264/Dark.S02E01.GERMAN.mkv",
                "Dark Season 3/01 - Deja-vu.mkv",
                "Mr. Robot/Temporada 1/Capitulo 1.mkv",
                "Mr. Robot/T2/Mr.Robot.S02E01.mkv",
            ],
        );
        assert_eq!(shows(&lib), vec![("Dark".to_string(), 4), ("Mr. Robot".to_string(), 2)]);
        assert_eq!(lib.series[0].episodes.iter().map(|e| e.season).collect::<Vec<_>>(), vec![Some(1), Some(1), Some(2), Some(3)]);
    }

    #[test]
    fn a_show_added_as_a_library_folder_is_one_series_named_after_it() {
        let lib = scanned("Dark (2017)", &["Season 1/01.mkv", "Season 1/02.mkv", "Season 2/01.mkv", "Specials/Making of.mkv"]);
        assert_eq!(shows(&lib), vec![("Dark".to_string(), 4)]);
        assert!(lib.movies.is_empty());
    }

    #[test]
    fn episodes_without_season_marks_join_their_show_and_leave_the_films() {
        let lib = scanned(
            "Video",
            &[
                // beside marked episodes: the unmarked one is theirs
                "Anime/Frieren/[Group] Frieren - 01 [1080p].mkv",
                "Anime/Frieren/[Group] Frieren - 02 [1080p].mkv",
                "Anime/Frieren/Frieren 03.mkv",
                "Anime/Frieren/Frieren - Creditless Opening.mkv",
                // a folder of numbered files only
                "Anime/Cowboy Bebop/Cowboy Bebop 01.mkv",
                "Anime/Cowboy Bebop/Cowboy Bebop 02.mkv",
                "Anime/Cowboy Bebop/Cowboy Bebop 03.mkv",
                // films stay films: sequels, and a film that only shares a word with a show beside it
                "Films/Rocky 2.mkv",
                "Films/Rocky 3.mkv",
                "Films/Rocky 4.mkv",
                "Mixed/Friends.S01E01.mkv",
                "Mixed/Friends.S01E02.mkv",
                "Mixed/Friends with Benefits (2011).mkv",
            ],
        );
        assert_eq!(shows(&lib), vec![("Cowboy Bebop".to_string(), 3), ("Friends".to_string(), 2), ("Frieren".to_string(), 4)]);
        let frieren = &lib.series[2];
        assert_eq!(frieren.episodes.iter().filter_map(|e| e.episode).collect::<Vec<_>>(), vec![1, 2, 3]);
        assert!(frieren.episodes.iter().any(|e| e.episode_title.as_deref() == Some("Frieren - Creditless Opening")));
        let films: Vec<_> = lib.movies.iter().map(|m| m.title.as_str()).collect();
        assert_eq!(films, vec!["Friends with Benefits", "Rocky 2", "Rocky 3", "Rocky 4"]);
    }

    #[test]
    fn what_is_already_imported_is_read_again_with_the_person_s_corrections_first() {
        let conn = crate::db::memory();
        // As an earlier version imported them: the unmarked episode as a film, the seasons as two shows
        conn.execute_batch(
            "INSERT INTO places(id, path, created_at) VALUES (1, 'D:\\Media', 1);
             INSERT INTO files(id, place_id, path, size, mtime, kind, added_at, scanned_at) VALUES
               (1, 1, 'D:\\Media\\Frieren\\Frieren - 01.mkv', 1, 1, 'video', 1, 1),
               (2, 1, 'D:\\Media\\Frieren\\Frieren - 02.mkv', 1, 1, 'video', 1, 1),
               (3, 1, 'D:\\Media\\Frieren\\Frieren 03.mkv', 1, 1, 'video', 1, 1),
               (4, 1, 'D:\\Media\\Dark S01\\Dark.S01E01.mkv', 1, 1, 'video', 1, 1),
               (5, 1, 'D:\\Media\\Dark Season 2\\01.mkv', 1, 1, 'video', 1, 1),
               (6, 1, 'D:\\Media\\Shorts\\Pilot.S01E01.mkv', 1, 1, 'video', 1, 1);
             INSERT INTO videos(file_id, kind, title, year, season, episode, show_folder) VALUES
               (1, 'episode', 'Frieren', NULL, NULL, 1, NULL),
               (2, 'episode', 'Frieren', NULL, NULL, 2, NULL),
               (3, 'movie', 'Frieren 03', NULL, NULL, NULL, NULL),
               (4, 'episode', 'Dark', NULL, 1, 1, NULL),
               (5, 'movie', '01', NULL, NULL, NULL, NULL),
               (6, 'episode', 'Pilot', NULL, 1, 1, NULL);
             INSERT INTO overrides(file_id, kind, title) VALUES (6, 'movie', 'Pilot, the short film');",
        )
        .unwrap();
        let (lib, _) = from_db(&conn).unwrap();
        assert_eq!(shows(&lib), vec![("Dark".to_string(), 2), ("Frieren".to_string(), 3)]);
        assert_eq!(lib.movies.iter().map(|m| m.title.as_str()).collect::<Vec<_>>(), vec!["Pilot, the short film"]);
    }

    #[test]
    fn specials_are_a_season_of_their_show() {
        let lib = scanned(
            "Anime",
            &[
                "DNA2/[motto] DNA2 - 01 (R2DVD 768x576 x264 Hi10p FLAC Chap).mkv",
                "DNA2/[motto] DNA2 - 02 (R2DVD 768x576 x264 Hi10p FLAC Chap).mkv",
                "DNA2/[motto] DNA2 OVA - 01 (R2DVD 768x576 x264 Hi10p FLAC Chap).mkv",
                "DNA2/[motto] DNA2 OVA - 02 (R2DVD 768x576 x264 Hi10p FLAC Chap).mkv",
                "DNA2/DNA2 OVA.mkv",
            ],
        );
        assert_eq!(shows(&lib), vec![("DNA2".to_string(), 5)]);
        let mut by_season: Vec<(Option<u32>, Option<u32>)> = lib.series[0].episodes.iter().map(|e| (e.season, e.episode)).collect();
        by_season.sort();
        assert_eq!(by_season, vec![(None, Some(1)), (None, Some(2)), (Some(0), None), (Some(0), Some(1)), (Some(0), Some(2))]);
    }

    #[test]
    fn a_song_whose_tags_cant_be_read_is_added_by_its_file_name() {
        let dir = std::env::temp_dir().join(format!("pmp-songs-{}", std::process::id())).join("Chants de guerre");
        std::fs::create_dir_all(&dir).unwrap();
        // A tag header of a version no reader knows, then one MPEG-1 Layer III frame header (128 kbps, 44.1 kHz) and silence
        let mut bytes = b"ID3\x09\x00\x00\x00\x00\x00\x0A".to_vec();
        bytes.extend_from_slice(&[0u8; 10]);
        bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        bytes.resize(16_000 * 10 + 24, 0);
        let named = |name: &str| {
            let p = dir.join(name);
            std::fs::write(&p, &bytes).unwrap();
            read_track(&p).map(|(t, _)| (t.title, t.number, t.album, t.unplayable, t.duration.round() as u32))
        };
        let album = "Chants de guerre".to_string();
        assert_eq!(named("06 - Marche Funebre.mp3"), Some(("Marche Funebre".to_string(), Some(6), album.clone(), false, 10)));
        assert_eq!(named("07 Untitled.mp3"), Some(("Untitled".to_string(), Some(7), album.clone(), false, 10)));
        assert_eq!(named("99 Luftballons.mp3").map(|t| (t.0, t.1)), Some(("99 Luftballons".to_string(), None)));
        // An empty file is no song
        let empty = dir.join("00 - nothing.mp3");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(read_track(&empty).map(|(t, _)| t.title), None);
        std::fs::remove_dir_all(dir.parent().unwrap()).ok();
    }

    #[test]
    fn a_compilation_in_one_folder_is_one_album_with_no_artist_of_its_own() {
        let track = |title: &str, artist: &str, album: &str, path: &str| {
            (LibTrack { id: String::new(), title: title.into(), artist: artist.into(), album: album.into(), number: None, disc: None, year: None, duration: 1.0, path: path.into(), unplayable: false, added_at: 0, missing: false }, artist.to_string())
        };
        let (lib, _) = assemble(
            vec![],
            vec![
                track("One", "Cecil Sharp Project", "English Folk", r"D:\Music\English Folk\01.mp3"),
                track("Two", "Bella Hardy", "English Folk", r"D:\Music\English Folk\02.mp3"),
                track("Three", "Bella Hardy", "English Folk", r"D:\Music\English Folk\03.mp3"),
                // The same title elsewhere is another album; an album on two discs stays one, by its artist
                track("Other", "Someone", "English Folk", r"D:\Music\Someone\English Folk\01.mp3"),
                track("A", "Pentangle", "Basket of Light", r"D:\Music\Pentangle\Basket of Light\CD1\01.mp3"),
                track("B", "Pentangle", "Basket of Light", r"D:\Music\Pentangle\Basket of Light\CD2\01.mp3"),
            ],
            vec![],
        );
        let albums: Vec<_> = lib.albums.iter().map(|a| (a.title.as_str(), a.artist.as_str(), a.track_ids.len())).collect();
        assert_eq!(albums, vec![("English Folk", "", 3), ("Basket of Light", "Pentangle", 2), ("English Folk", "Someone", 1)]);
    }
}
