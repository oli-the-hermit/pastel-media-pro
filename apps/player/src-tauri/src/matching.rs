//! Local matching (architecture.md §4, "Import, places and metadata"): a video's details from what sits beside it,
//! in this order: a Kodi `.nfo`, a small JSON sidecar, folder art, then the file name (`parse.rs`). Nothing goes
//! online (TMDB is Phase 5, opt-in per place, D13). Read-only: nothing here writes next to the files.

use regex::Regex;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Details found for one video, from one source.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Details {
    /// nfo or sidecar.
    pub source: &'static str,
    /// "tmdb:603", "imdb:tt0133093".
    pub external_id: Option<String>,
    pub title: Option<String>,
    pub original_title: Option<String>,
    pub year: Option<u16>,
    pub overview: Option<String>,
    pub runtime_min: Option<u32>,
    pub genres: Vec<String>,
    pub rating: Option<f64>,
}

macro_rules! re {
    ($name:ident, $pat:expr) => {
        fn $name() -> &'static Regex {
            static RE: OnceLock<Regex> = OnceLock::new();
            RE.get_or_init(|| Regex::new($pat).unwrap())
        }
    };
}

re!(imdb_id, r"\btt\d{7,9}\b");
re!(tmdb_url, r"themoviedb\.org/(?:movie|tv)/(\d+)");

/// The text inside the first `<tag>…</tag>` (any attributes), with XML entities and CDATA undone.
fn tag(xml: &str, name: &str) -> Option<String> {
    tags(xml, name).into_iter().next()
}

fn tags(xml: &str, name: &str) -> Vec<String> {
    let re = Regex::new(&format!(r"(?is)<{name}(?:\s[^>]*)?>(.*?)</{name}>")).unwrap();
    re.captures_iter(xml).map(|c| unescape(c[1].trim())).filter(|s| !s.is_empty()).collect()
}

fn unescape(s: &str) -> String {
    let s = s.strip_prefix("<![CDATA[").and_then(|s| s.strip_suffix("]]>")).unwrap_or(s);
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&").trim().to_string()
}

/// A Kodi `.nfo`: XML with `<title>`, `<year>`, `<plot>`, `<uniqueid type="tmdb">`… Release groups' `.nfo` files are
/// text art with an IMDb or TMDB link: only the id is taken from those.
pub fn parse_nfo(text: &str) -> Option<Details> {
    let mut d = Details { source: "nfo", ..Default::default() };
    if text.contains("<movie") || text.contains("<episodedetails") || text.contains("<tvshow") {
        d.title = tag(text, "title");
        d.original_title = tag(text, "originaltitle").filter(|o| Some(o) != d.title.as_ref());
        d.year = tag(text, "year").and_then(|y| y.parse().ok()).or_else(|| tag(text, "premiered").and_then(|p| p.get(..4)?.parse().ok()));
        d.overview = tag(text, "plot").or_else(|| tag(text, "outline"));
        d.runtime_min = tag(text, "runtime").and_then(|r| r.parse().ok()).filter(|r| *r > 0);
        d.genres = tags(text, "genre");
        d.rating = tag(text, "rating").and_then(|r| r.parse().ok()).or_else(|| tag(text, "value").and_then(|r| r.parse().ok()));
        let re = Regex::new(r#"(?is)<uniqueid[^>]*type="(\w+)"[^>]*>(.*?)</uniqueid>"#).unwrap();
        let ids: Vec<(String, String)> = re.captures_iter(text).map(|c| (c[1].to_lowercase(), c[2].trim().to_string())).collect();
        d.external_id = ids
            .iter()
            .find(|(t, _)| t == "tmdb")
            .map(|(_, v)| format!("tmdb:{v}"))
            .or_else(|| tag(text, "tmdbid").map(|v| format!("tmdb:{v}")))
            .or_else(|| ids.iter().find(|(t, _)| t == "imdb").map(|(_, v)| format!("imdb:{v}")))
            .or_else(|| tag(text, "imdbid").map(|v| format!("imdb:{v}")));
    }
    if d.external_id.is_none() {
        d.external_id = tmdb_url().captures(text).map(|c| format!("tmdb:{}", &c[1])).or_else(|| imdb_id().find(text).map(|m| format!("imdb:{}", m.as_str())));
    }
    (d.title.is_some() || d.external_id.is_some()).then_some(d)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sidecar {
    title: Option<String>,
    original_title: Option<String>,
    year: Option<u16>,
    overview: Option<String>,
    runtime: Option<u32>,
    #[serde(default)]
    genres: Vec<String>,
    #[serde(alias = "tmdb_id", alias = "tmdb")]
    tmdb_id: Option<serde_json::Value>,
    #[serde(alias = "imdb_id", alias = "imdb")]
    imdb_id: Option<String>,
}

/// A small JSON sidecar (`Film.json`): `{ "title", "year", "tmdbId" | "imdbId", "overview", "genres" }`.
pub fn parse_sidecar(text: &str) -> Option<Details> {
    let s: Sidecar = serde_json::from_str(text).ok()?;
    let tmdb = s.tmdb_id.and_then(|v| match v {
        serde_json::Value::Number(n) => Some(n.to_string()),
        serde_json::Value::String(t) if !t.is_empty() => Some(t),
        _ => None,
    });
    let d = Details {
        source: "sidecar",
        external_id: tmdb.map(|t| format!("tmdb:{t}")).or(s.imdb_id.map(|i| format!("imdb:{i}"))),
        title: s.title.filter(|t| !t.trim().is_empty()),
        original_title: s.original_title,
        year: s.year,
        overview: s.overview,
        runtime_min: s.runtime,
        genres: s.genres,
        rating: None,
    };
    (d.title.is_some() || d.external_id.is_some()).then_some(d)
}

fn read_text(p: &Path) -> Option<String> {
    let meta = std::fs::metadata(p).ok()?;
    if !meta.is_file() || meta.len() > 1024 * 1024 {
        return None;
    }
    Some(String::from_utf8_lossy(&std::fs::read(p).ok()?).into_owned())
}

/// The details beside a video: `<name>.nfo` (or a lone film's `movie.nfo`), else `<name>.json`.
pub fn details(video: &Path, lone_in_folder: bool) -> Option<Details> {
    let dir = video.parent()?;
    let stem = video.file_stem()?.to_string_lossy();
    let mut nfos = vec![dir.join(format!("{stem}.nfo"))];
    if lone_in_folder {
        nfos.push(dir.join("movie.nfo"));
    }
    nfos.iter()
        .find_map(|p| read_text(p).and_then(|t| parse_nfo(&t)))
        .or_else(|| read_text(&dir.join(format!("{stem}.json"))).and_then(|t| parse_sidecar(&t)))
}

/// A series as a whole, from Kodi's `tvshow.nfo` in the show's folder.
pub fn show_details(show_dir: &Path) -> Option<Details> {
    let file = show_dir.join("tvshow.nfo");
    let meta = std::fs::metadata(&file).ok()?;
    if !meta.is_file() || meta.len() > 1024 * 1024 {
        return None;
    }
    parse_nfo(&String::from_utf8_lossy(&std::fs::read(&file).ok()?))
}

/// Picture files beside a video, Kodi's names first. A folder-wide name (`poster.jpg`, `folder.jpg`) counts only for a
/// film alone in its folder, or for an episode from its show's folder: a folder of loose films shares no poster.
#[derive(Debug, Default, PartialEq)]
pub struct Art {
    pub poster: Option<PathBuf>,
    pub backdrop: Option<PathBuf>,
}

const IMAGE_EXTS: &[&str] = &["jpg", "jpeg", "png"];

fn first_existing(dir: &Path, names: &[String]) -> Option<PathBuf> {
    let entries: Vec<(String, PathBuf)> = std::fs::read_dir(dir).ok()?.flatten().map(|e| (e.file_name().to_string_lossy().to_lowercase(), e.path())).collect();
    names.iter().find_map(|n| entries.iter().find(|(name, _)| name == n).map(|(_, p)| p.clone()))
}

fn named(bases: &[&str]) -> Vec<String> {
    bases.iter().flat_map(|b| IMAGE_EXTS.iter().map(move |e| format!("{b}.{e}"))).collect()
}

pub fn art(video: &Path, lone_in_folder: bool, show_dir: Option<&Path>) -> Art {
    let Some(dir) = video.parent() else { return Art::default() };
    let stem = video.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    let mut poster_names = named(&[&format!("{stem}-poster"), &stem]);
    let mut backdrop_names = named(&[&format!("{stem}-fanart"), &format!("{stem}-backdrop")]);
    if lone_in_folder {
        poster_names.extend(named(&["poster", "folder", "cover", "movie"]));
        backdrop_names.extend(named(&["fanart", "backdrop", "background"]));
    }
    let mut art = Art { poster: first_existing(dir, &poster_names), backdrop: first_existing(dir, &backdrop_names) };
    if let Some(show) = show_dir {
        art.poster = art.poster.or_else(|| first_existing(show, &named(&["poster", "folder", "cover", "show"])));
        art.backdrop = art.backdrop.or_else(|| first_existing(show, &named(&["fanart", "backdrop", "background"])));
    }
    art
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_kodi_nfo() {
        let nfo = r#"<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>Proxy War</title>
  <originaltitle>Jingi naki tatakai: Dairi senso</originaltitle>
  <year>1973</year>
  <plot><![CDATA[The third film of the Battles Without Honor & Humanity series.]]></plot>
  <runtime>102</runtime>
  <genre>Crime</genre><genre>Drama</genre>
  <ratings><rating name="imdb" default="true"><value>7.4</value></rating></ratings>
  <uniqueid type="imdb">tt0070225</uniqueid>
  <uniqueid type="tmdb" default="true">28010</uniqueid>
</movie>"#;
        let d = parse_nfo(nfo).unwrap();
        assert_eq!(d.title.as_deref(), Some("Proxy War"));
        assert_eq!(d.original_title.as_deref(), Some("Jingi naki tatakai: Dairi senso"));
        assert_eq!(d.year, Some(1973));
        assert_eq!(d.overview.as_deref(), Some("The third film of the Battles Without Honor & Humanity series."));
        assert_eq!(d.runtime_min, Some(102));
        assert_eq!(d.genres, vec!["Crime", "Drama"]);
        assert_eq!(d.rating, Some(7.4));
        assert_eq!(d.external_id.as_deref(), Some("tmdb:28010"));
    }

    #[test]
    fn takes_only_the_id_from_a_release_nfo() {
        let nfo = "  ▄▄▄ GROUP ▄▄▄\n  IMDB.....: https://www.imdb.com/title/tt0113277/\n  Size.....: 8.2 GB";
        let d = parse_nfo(nfo).unwrap();
        assert_eq!((d.title, d.external_id.as_deref()), (None, Some("imdb:tt0113277")));
        assert_eq!(parse_nfo("just some text"), None);
    }

    #[test]
    fn reads_a_json_sidecar() {
        let d = parse_sidecar(r#"{ "title": "Heat", "year": 1995, "tmdbId": 949, "genres": ["Crime"] }"#).unwrap();
        assert_eq!((d.title.as_deref(), d.year, d.external_id.as_deref()), (Some("Heat"), Some(1995), Some("tmdb:949")));
        assert_eq!(parse_sidecar(r#"{ "imdb_id": "tt0113277" }"#).unwrap().external_id.as_deref(), Some("imdb:tt0113277"));
        assert_eq!(parse_sidecar("[1, 2]"), None);
    }

    #[test]
    fn finds_art_beside_a_film_but_never_shares_a_loose_folder_poster() {
        let root = std::env::temp_dir().join(format!("pmp-art-{}", std::process::id()));
        let film = root.join("Heat (1995)");
        let loose = root.join("Loose");
        let show = root.join("Dark");
        let season = show.join("Season 1");
        for d in [&film, &loose, &season] {
            std::fs::create_dir_all(d).unwrap();
        }
        for f in [film.join("Heat.mkv"), film.join("Poster.JPG"), film.join("fanart.jpg"), loose.join("A.mkv"), loose.join("B.mkv"), loose.join("folder.jpg"), loose.join("b-poster.png"), season.join("Dark.S01E01.mkv"), show.join("poster.jpg")] {
            std::fs::write(f, b"x").unwrap();
        }
        let heat = art(&film.join("Heat.mkv"), true, None);
        assert_eq!(heat.poster.unwrap().file_name().unwrap(), "Poster.JPG");
        assert_eq!(heat.backdrop.unwrap().file_name().unwrap(), "fanart.jpg");
        assert_eq!(art(&loose.join("A.mkv"), false, None), Art::default());
        assert_eq!(art(&loose.join("B.mkv"), false, None).poster.unwrap().file_name().unwrap(), "b-poster.png");
        assert_eq!(art(&season.join("Dark.S01E01.mkv"), false, Some(&show)).poster.unwrap().file_name().unwrap(), "poster.jpg");
        std::fs::remove_dir_all(&root).ok();
    }
}
