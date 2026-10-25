//! The test library: in a build with the `test-media` feature, the repo's `media_to_test` folder (or
//! `PASTEL_TEST_MEDIA`) is scanned at start and shown on the media pages. Read-only; nothing is written to it.
//! The real library (folders the user picks, SQLite, rescans) is Phase 3; this follows spike S6.

use crate::parse::{self, Kind};
use base64::Engine as _;
use lofty::config::{ParseOptions, ParsingMode};
use lofty::file::{AudioFile, TaggedFile, TaggedFileExt};
use lofty::picture::PictureType;
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, Tag};
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use walkdir::WalkDir;

const AUDIO: &[&str] = &["mp3", "m4a", "flac", "ogg", "opus", "wav", "wma", "aac", "aiff", "ape", "wv", "oga"];
const VIDEO: &[&str] = &["mp4", "mkv", "avi", "mov", "webm", "ts", "m4v", "wmv", "flv", "mpg", "mpeg"];
const FOLDER_COVERS: &[&str] = &["cover.jpg", "folder.jpg", "front.jpg", "album.jpg", "cover.png", "folder.png"];

#[derive(Serialize, Clone)]
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

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibVideo {
    pub id: String,
    pub title: String,
    pub year: Option<u16>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub file_name: String,
    pub path: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LibSeries {
    pub id: String,
    pub title: String,
    pub episodes: Vec<LibVideo>,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    /// The folder that was read, or empty when this build has no test library.
    pub root: String,
    pub tracks: Vec<LibTrack>,
    pub albums: Vec<LibAlbum>,
    pub movies: Vec<LibVideo>,
    pub series: Vec<LibSeries>,
    pub scan_ms: u64,
}

#[derive(Default)]
pub struct LibraryState {
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

/// Whether the engine may open this path: only files inside the test folder.
pub fn allowed(path: &str) -> bool {
    match (root(), Path::new(path).canonicalize()) {
        (Some(r), Ok(p)) => p.starts_with(r) && p.is_file(),
        _ => false,
    }
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

fn read_track(path: &Path) -> Option<(LibTrack, String)> {
    let opts = ParseOptions::new().read_cover_art(false);
    let (tf, unplayable) = match Probe::open(path).ok()?.options(opts).read() {
        Ok(tf) => (tf, false),
        // Tags but no readable audio (a downloader left only the tag): keep it, flagged (S6).
        Err(_) => (Probe::open(path).ok()?.options(ParseOptions::new().read_cover_art(false).read_properties(false).parsing_mode(ParsingMode::Relaxed)).read().ok()?, true),
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
    };
    Some((track, if album_artist.is_empty() { artist } else { album_artist }))
}

/// Reads a folder: the songs grouped into albums, the videos into movies and series, and for each album the files its cover may come from.
pub fn scan(root: &Path) -> (Library, HashMap<String, Vec<PathBuf>>) {
    let started = std::time::Instant::now();
    let (mut audio, mut video) = (vec![], vec![]);
    for e in WalkDir::new(root).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_file()) {
        let ext = e.path().extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
        if AUDIO.contains(&ext.as_str()) {
            audio.push(e.path().to_path_buf());
        } else if VIDEO.contains(&ext.as_str()) {
            video.push(e.path().to_path_buf());
        }
    }

    // Albums: grouped by album artist (or artist) and album title; songs without an album share one group.
    let mut groups: BTreeMap<(String, String), Vec<LibTrack>> = BTreeMap::new();
    for p in &audio {
        if let Some((t, album_artist)) = read_track(p) {
            groups.entry((album_artist.to_lowercase(), t.album.to_lowercase())).or_default().push(t);
        }
    }
    // Paths keep Windows' \\?\ prefix (long paths reach the engine intact, S4); the folder is shown without it.
    let shown = root.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    let (mut lib, mut sources) = (Library { root: shown, ..Default::default() }, HashMap::new());
    for (i, ((_, _), mut tracks)) in groups.into_iter().enumerate() {
        tracks.sort_by(|a, b| (a.disc, a.number, &a.path).cmp(&(b.disc, b.number, &b.path)));
        let id = format!("a{i}");
        let first = &tracks[0];
        let artist = tracks.iter().map(|t| t.artist.clone()).find(|a| !a.is_empty()).unwrap_or_default();
        let mut album = LibAlbum { id: id.clone(), title: first.album.clone(), artist, year: tracks.iter().find_map(|t| t.year), track_ids: vec![] };
        sources.insert(id.clone(), tracks.iter().map(|t| PathBuf::from(&t.path)).collect::<Vec<_>>());
        for (j, mut t) in tracks.into_iter().enumerate() {
            t.id = format!("{id}t{j}");
            album.track_ids.push(t.id.clone());
            lib.tracks.push(t);
        }
        lib.albums.push(album);
    }

    // Videos: the parser says movie or episode; episodes group into series by title.
    let mut series: BTreeMap<String, Vec<LibVideo>> = BTreeMap::new();
    for (i, p) in video.iter().enumerate() {
        let rel = p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/");
        let parsed = parse::parse(&rel);
        let v = LibVideo {
            id: format!("v{i}"),
            title: parsed.title.clone(),
            year: parsed.year,
            season: parsed.season,
            episode: parsed.episode,
            file_name: p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
            path: p.to_string_lossy().to_string(),
        };
        match parsed.kind {
            Kind::Movie => lib.movies.push(v),
            Kind::Episode => series.entry(parsed.title.to_lowercase()).or_default().push(v),
        }
    }
    lib.movies.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()).then(a.year.cmp(&b.year)));
    for (i, (_, mut eps)) in series.into_iter().enumerate() {
        eps.sort_by_key(|e| (e.season.unwrap_or(0), e.episode.unwrap_or(0)));
        lib.series.push(LibSeries { id: format!("s{i}"), title: eps[0].title.clone(), episodes: eps });
    }
    lib.scan_ms = started.elapsed().as_millis() as u64;
    (lib, sources)
}

/// The test library, scanned on the first call (about 0.2 s for `media_to_test`).
#[tauri::command]
pub async fn library_get(state: tauri::State<'_, LibraryState>) -> Result<Library, String> {
    if let Some(l) = state.library.lock().unwrap().clone() {
        return Ok(l);
    }
    let Some(root) = root() else { return Ok(Library::default()) };
    let (lib, sources) = tauri::async_runtime::spawn_blocking(move || scan(&root)).await.map_err(|e| e.to_string())?;
    *state.cover_sources.lock().unwrap() = sources;
    *state.library.lock().unwrap() = Some(lib.clone());
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
    let url = tauri::async_runtime::spawn_blocking(move || {
        cover_thumbnail(&files).map(|jpg| format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpg)))
    })
    .await
    .map_err(|e| e.to_string())?;
    state.covers.lock().unwrap().insert(album_id, url.clone());
    Ok(url)
}
