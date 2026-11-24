//! The library, an early form of Phase 3's: the folders the person adds in Settings → Library (kept in
//! `library-folders.json` in the app's config folder), plus, in a build with the `test-media` feature, the repo's
//! `media_to_test` folder (or `PASTEL_TEST_MEDIA`). They are read when a media page first opens (never at launch,
//! D16) and kept in memory until a folder is added or removed. Read-only: nothing is ever written to them.
//! The real library (SQLite, the review list, the import queue, rescans) is Phase 3; this follows spike S6.

use crate::formats::{self, MediaKind};
use crate::parse::{self, Kind};
use base64::Engine as _;
use lofty::config::{ParseOptions, ParsingMode};
use lofty::file::{AudioFile, TaggedFile, TaggedFileExt};
use lofty::picture::PictureType;
use lofty::prelude::*;
use lofty::probe::Probe;
use lofty::tag::{ItemKey, Tag};
use serde::Serialize;
use tauri::{AppHandle, Manager};
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
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

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibVideo {
    pub id: String,
    pub title: String,
    pub year: Option<u16>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    /// An episode's own title, when its file name gives one.
    pub episode_title: Option<String>,
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
    /// The folders that were read, as shown to people; empty when there are none.
    pub roots: Vec<String>,
    pub tracks: Vec<LibTrack>,
    pub albums: Vec<LibAlbum>,
    pub movies: Vec<LibVideo>,
    pub series: Vec<LibSeries>,
    pub scan_ms: u64,
}

/// A folder the person added, as shown, and whether it is there now (a drive can be unplugged).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Folder {
    pub path: String,
    pub found: bool,
}

#[derive(Default)]
pub struct LibraryState {
    /// The folders the person added (canonical paths; a folder that is gone keeps the path it was saved with).
    folders: Mutex<Vec<PathBuf>>,
    /// Grows each time the folders change: a scan that started before a change is not kept.
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

/// Every folder the library reads: the test folder first (in a build that has one), then the person's that are
/// there now.
pub fn roots(state: &LibraryState) -> Vec<PathBuf> {
    root().into_iter().chain(state.folders.lock().unwrap().iter().filter(|p| p.is_dir()).cloned()).collect()
}

/// The folders as Settings lists them.
pub fn folder_list(folders: &[PathBuf]) -> Vec<Folder> {
    folders.iter().map(|p| Folder { path: shown(p), found: p.is_dir() }).collect()
}

/// Whether the engine may open this path: only files inside the library's folders.
pub fn allowed(state: &LibraryState, path: &str) -> bool {
    let Ok(p) = Path::new(path).canonicalize() else { return false };
    p.is_file() && roots(state).iter().any(|r| p.starts_with(r))
}

/// A folder as people see it: without Windows' `\\?\` long-path prefix.
pub fn shown(path: &Path) -> String {
    path.to_string_lossy().trim_start_matches(r"\\?\").to_string()
}

/// The list after adding `folder`: unchanged if it is already read (itself or a folder above it); folders inside it
/// make way for it, so no file is read twice.
pub fn with_folder(folders: &[PathBuf], folder: PathBuf) -> Vec<PathBuf> {
    if folders.iter().any(|f| folder.starts_with(f)) {
        return folders.to_vec();
    }
    let mut out: Vec<PathBuf> = folders.iter().filter(|f| !f.starts_with(&folder)).cloned().collect();
    out.push(folder);
    out
}

fn folders_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("library-folders.json"))
}

/// Reads the saved folders at start (a tiny file). A folder that is gone stays in the list, marked in Settings, and
/// is read again once it is back.
pub fn load_folders(app: &AppHandle) {
    let saved: Vec<String> = folders_file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    let folders = saved.iter().map(PathBuf::from).map(|p| p.canonicalize().unwrap_or(p)).collect();
    *app.state::<LibraryState>().folders.lock().unwrap() = folders;
}

fn save_folders(app: &AppHandle, folders: &[PathBuf]) -> Result<(), String> {
    let file = folders_file(app).ok_or("no config folder")?;
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let list: Vec<String> = folders.iter().map(|p| shown(p)).collect();
    std::fs::write(file, serde_json::to_string_pretty(&list).unwrap_or_default()).map_err(|e| e.to_string())
}

/// Replaces the folder list: saved, and the library is read again on its next use.
fn set_folders(app: &AppHandle, folders: Vec<PathBuf>) -> Result<Vec<Folder>, String> {
    save_folders(app, &folders)?;
    let state = app.state::<LibraryState>();
    state.generation.fetch_add(1, Ordering::SeqCst);
    *state.folders.lock().unwrap() = folders.clone();
    *state.library.lock().unwrap() = None;
    state.cover_sources.lock().unwrap().clear();
    state.covers.lock().unwrap().clear();
    Ok(folder_list(&folders))
}

/// The folders the person added, as shown, each marked when it can't be found.
#[tauri::command]
pub fn library_folders(state: tauri::State<'_, LibraryState>) -> Vec<Folder> {
    folder_list(&state.folders.lock().unwrap())
}

/// Picks a folder in Windows' dialog and adds it; resolves to the new list (unchanged when cancelled).
#[tauri::command]
pub async fn library_add_folder(app: AppHandle, title: String) -> Result<Vec<Folder>, String> {
    use tauri_plugin_dialog::DialogExt;
    let picked = app.dialog().file().set_title(title).blocking_pick_folder();
    let current = app.state::<LibraryState>().folders.lock().unwrap().clone();
    let Some(folder) = picked.and_then(|f| f.into_path().ok()).and_then(|p| p.canonicalize().ok()) else {
        return Ok(folder_list(&current));
    };
    set_folders(&app, with_folder(&current, folder))
}

/// Stops reading a folder (its files are untouched); resolves to the new list.
#[tauri::command]
pub fn library_remove_folder(app: AppHandle, folder: String) -> Result<Vec<Folder>, String> {
    let current = app.state::<LibraryState>().folders.lock().unwrap().clone();
    set_folders(&app, current.into_iter().filter(|p| shown(p) != folder).collect())
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

/// One song's tags and length (cover art skipped), and its album artist; `None` if the file has no readable tags.
pub(crate) fn read_track(path: &Path) -> Option<(LibTrack, String)> {
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
    scan_all(&[root.to_path_buf()])
}

/// Reads several folders into one library.
pub fn scan_all(roots: &[PathBuf]) -> (Library, HashMap<String, Vec<PathBuf>>) {
    let started = std::time::Instant::now();
    // Videos keep the folder they were found in: the parser reads their path below it (season folders).
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

    // Albums: grouped by album artist (or artist) and album title; songs without an album share one group.
    let mut groups: BTreeMap<(String, String), Vec<LibTrack>> = BTreeMap::new();
    for p in &audio {
        if let Some((t, album_artist)) = read_track(p) {
            groups.entry((album_artist.to_lowercase(), t.album.to_lowercase())).or_default().push(t);
        }
    }
    // Paths keep Windows' long-path prefix (long paths reach the engine intact, S4); the folders are shown without it.
    let (mut lib, mut sources) = (Library { roots: roots.iter().map(|r| shown(r)).collect(), ..Default::default() }, HashMap::new());
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

    // Videos: the parser says movie or episode. Episodes group into series by the show's folder ("Show/Season 1/…")
    // or else by their title, compared loosely (`parse::series_key`).
    #[derive(Default)]
    struct Show {
        folder: Option<String>,
        titles: Vec<String>,
        episodes: Vec<LibVideo>,
    }
    let mut series: BTreeMap<String, Show> = BTreeMap::new();
    for (i, (root, p)) in video.iter().enumerate() {
        let rel = p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/");
        let parsed = parse::parse(&rel);
        let v = LibVideo {
            id: format!("v{i}"),
            title: parsed.title.clone(),
            year: parsed.year,
            season: parsed.season,
            episode: parsed.episode,
            episode_title: parsed.episode_title.clone(),
            file_name: p.file_name().map(|f| f.to_string_lossy().to_string()).unwrap_or_default(),
            path: p.to_string_lossy().to_string(),
        };
        match parsed.kind {
            Kind::Movie => lib.movies.push(v),
            Kind::Episode => {
                let folder = parse::show_folder(&rel);
                let show = series.entry(parse::series_key(folder.as_deref().unwrap_or(&parsed.title))).or_default();
                show.folder = show.folder.take().or(folder);
                show.titles.push(parsed.title);
                show.episodes.push(v);
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
        lib.series.push(LibSeries { id: format!("s{i}"), title, episodes: show.episodes });
    }
    lib.scan_ms = started.elapsed().as_millis() as u64;
    (lib, sources)
}

/// The title most episodes use (the shortest of those that tie): "Mr. Robot" over a stray "Mr Robot Season 2".
fn most_common(titles: &[String]) -> String {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for t in titles.iter().filter(|t| !t.is_empty()) {
        *counts.entry(t.as_str()).or_default() += 1;
    }
    counts.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.len().cmp(&a.0.len())).then(b.0.cmp(a.0))).map(|(t, _)| t.to_string()).unwrap_or_default()
}

/// The library, read on the first call after a start or a change of folders (about 0.2 s for `media_to_test`).
#[tauri::command]
pub async fn library_get(state: tauri::State<'_, LibraryState>) -> Result<Library, String> {
    if let Some(l) = state.library.lock().unwrap().clone() {
        return Ok(l);
    }
    let generation = state.generation.load(Ordering::SeqCst);
    let roots = roots(&state);
    if roots.is_empty() {
        return Ok(Library::default());
    }
    let (lib, sources) = tauri::async_runtime::spawn_blocking(move || scan_all(&roots)).await.map_err(|e| e.to_string())?;
    // The folders changed while this scan ran: the page asks again for the new ones, so this one is not kept.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adding_a_folder_never_reads_a_file_twice() {
        let (music, videos) = (PathBuf::from(r"C:\Users\a\Music"), PathBuf::from(r"C:\Users\a\Videos"));
        let both = with_folder(&[music.clone()], videos.clone());
        assert_eq!(both, vec![music.clone(), videos.clone()]);
        // Again, or a folder inside one already read: nothing changes.
        assert_eq!(with_folder(&both, videos.clone()), both);
        assert_eq!(with_folder(&both, music.join("Albums")), both);
        // A folder above both takes their place.
        assert_eq!(with_folder(&both, PathBuf::from(r"C:\Users\a")), vec![PathBuf::from(r"C:\Users\a")]);
    }

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
    fn a_folder_that_is_gone_stays_listed_and_is_not_read() {
        let here = std::env::temp_dir().join(format!("pmp-here-{}", std::process::id()));
        std::fs::create_dir_all(&here).unwrap();
        let gone = PathBuf::from(r"Z:\Unplugged\Music");
        let state = LibraryState::default();
        *state.folders.lock().unwrap() = vec![here.clone(), gone.clone()];
        let list = folder_list(&state.folders.lock().unwrap());
        assert_eq!(list.iter().map(|f| f.found).collect::<Vec<_>>(), vec![true, false]);
        assert_eq!(list[1].path, r"Z:\Unplugged\Music");
        assert!(!roots(&state).contains(&gone));
        assert!(roots(&state).contains(&here));
        std::fs::remove_dir_all(&here).ok();
    }

    #[test]
    fn shows_folders_without_the_long_path_prefix() {
        assert_eq!(shown(Path::new(r"\\?\D:\Media\Films")), r"D:\Media\Films");
    }
}
