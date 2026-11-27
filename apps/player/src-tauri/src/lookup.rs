//! Which title a file is, and what is kept of TMDB's answer (plan D13; the asking itself is `tmdb.rs`).
//!
//! A film is found by an id beside it (`.nfo`, sidecar), or else by its name and year, and only when that is plain
//! (`tmdb::pick`). What is kept: a `metadata` row with source `tmdb` (and `omdb` for an IMDb rating), a poster and
//! a backdrop in the image cache. A series is found the same way and kept in `shows`; its episodes get their names,
//! words and pictures from its seasons. A person's own art and `.nfo` always come first; a frame taken from the
//! video gives way to TMDB's picture. `lookups` remembers what was asked, and what a person chose themselves.

use crate::db;
use crate::online::{Failure, Http};
use crate::tmdb::{self, Kind, Tmdb};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

/// Everything one lookup needs.
pub struct Ctx<'a> {
    pub conn: &'a Connection,
    pub cache: &'a Path,
    pub http: &'a Http,
    pub tmdb: &'a Tmdb<'a>,
    /// An OMDb key, when the person gave one: IMDb ratings.
    pub omdb: Option<&'a str>,
}

/// Keeps a fetched picture in the image cache as it came (a JPEG), marked `tmdb`; its hash.
pub fn keep_picture(conn: &Connection, cache: &Path, bytes: &[u8], kind: &str) -> Option<String> {
    let img = image::load_from_memory(bytes).ok()?;
    let jpeg = if image::guess_format(bytes).ok() == Some(image::ImageFormat::Jpeg) {
        bytes.to_vec()
    } else {
        let mut out = vec![];
        image::DynamicImage::ImageRgb8(img.to_rgb8()).write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 86)).ok()?;
        out
    };
    let mut h = blake3::Hasher::new();
    h.update(kind.as_bytes());
    h.update(&jpeg);
    let hash = h.finalize().to_hex()[..32].to_string();
    let file = cache.join(format!("{hash}.jpg"));
    std::fs::write(&file, &jpeg).ok()?;
    conn.execute(
        "INSERT OR IGNORE INTO images(hash, kind, path, w, h, bytes, last_used_at, origin) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'tmdb')",
        params![hash, kind, file.to_string_lossy(), img.width(), img.height(), jpeg.len() as i64, db::now()],
    )
    .ok()?;
    Some(hash)
}

fn fetch(ctx: &Ctx, path: Option<&str>, size: &str, kind: &str) -> Option<String> {
    let bytes = ctx.tmdb.picture(path?, size).ok()?;
    keep_picture(ctx.conn, ctx.cache, &bytes, kind)
}

/// Whether a video's picture may be replaced by TMDB's: there is none, or it is a frame or an older fetched one.
/// A person's own art stays.
fn replaceable(conn: &Connection, file_id: i64, column: &str) -> bool {
    let sql = format!("SELECT i.origin FROM videos v LEFT JOIN images i ON i.hash = v.{column} WHERE v.file_id = ?1");
    conn.query_row(&sql, [file_id], |r| r.get::<_, Option<String>>(0)).ok().flatten().is_none_or(|origin| origin != "own")
}

fn note(conn: &Connection, kind: &str, key: &str, state: &str, external_id: Option<&str>) {
    // A person's own choice is never written over by what was found by itself.
    let _ = conn.execute(
        "INSERT INTO lookups(kind, key, state, external_id, tried_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(kind, key) DO UPDATE SET state = CASE WHEN lookups.state IN ('chosen', 'removed') THEN lookups.state ELSE excluded.state END,
           external_id = CASE WHEN lookups.state IN ('chosen', 'removed') THEN lookups.external_id ELSE excluded.external_id END, tried_at = excluded.tried_at",
        params![kind, key, state, external_id, db::now()],
    );
}

/// The TMDB id a title is known by before any search: the person's choice, or an id beside the file.
fn known_id(ctx: &Ctx, kind: Kind, chosen: Option<&str>, beside: Option<&str>) -> Result<Option<u64>, Failure> {
    for id in [chosen, beside].into_iter().flatten() {
        if let Some(n) = id.strip_prefix("tmdb:").and_then(|n| n.parse().ok()) {
            return Ok(Some(n));
        }
        if let Some(imdb) = id.strip_prefix("imdb:") {
            if let Some(found) = ctx.tmdb.find_imdb(imdb, kind)? {
                return Ok(Some(found.id));
            }
        }
    }
    Ok(None)
}

fn chosen(conn: &Connection, kind: &str, key: &str) -> Option<(String, Option<String>)> {
    conn.query_row("SELECT state, external_id FROM lookups WHERE kind = ?1 AND key = ?2 AND state IN ('chosen', 'removed')", params![kind, key], |r| Ok((r.get(0)?, r.get(1)?))).ok()
}

fn imdb_rating(ctx: &Ctx, imdb_id: Option<&str>) -> Option<(String, f64)> {
    let (key, id) = (ctx.omdb?, imdb_id?);
    tmdb::imdb_rating(ctx.http, key, id).ok().flatten().map(|r| (format!("imdb:{id}"), r))
}

/// Looks one film up and keeps what was found; whether it was matched.
pub fn movie(ctx: &Ctx, file_id: i64, name: &str, year: Option<u16>) -> Result<bool, Failure> {
    let key = file_id.to_string();
    let picked = chosen(ctx.conn, "movie", &key);
    if picked.as_ref().is_some_and(|(state, _)| state == "removed") {
        return Ok(false);
    }
    let beside: Option<String> = ctx
        .conn
        .query_row("SELECT external_id FROM metadata WHERE file_id = ?1 AND source IN ('nfo', 'sidecar') AND external_id IS NOT NULL LIMIT 1", [file_id], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    let id = match known_id(ctx, Kind::Movie, picked.as_ref().and_then(|p| p.1.as_deref()), beside.as_deref())? {
        Some(id) => Some(id),
        None => tmdb::pick(&ctx.tmdb.search(Kind::Movie, name, year)?, name, year).map(|c| c.id),
    };
    let Some(id) = id else {
        note(ctx.conn, "movie", &key, "none", None);
        return Ok(false);
    };
    let t = ctx.tmdb.title(Kind::Movie, id)?;
    let external = format!("tmdb:{id}");
    let genres = (!t.genres.is_empty()).then(|| t.genres.join(", "));
    ctx.conn
        .execute(
            "INSERT OR REPLACE INTO metadata(file_id, source, external_id, title, original_title, year, overview, runtime_min, genres, rating, language, fetched_at)
             VALUES (?1, 'tmdb', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![file_id, external, t.title, t.original_title, t.year, t.overview, t.runtime_min, genres, t.rating, ctx.tmdb.language, db::now()],
        )
        .map_err(|e| Failure::Other(e.to_string()))?;
    for (column, path, size) in [("poster", &t.poster_path, tmdb::POSTER), ("backdrop", &t.backdrop_path, tmdb::BACKDROP)] {
        if replaceable(ctx.conn, file_id, column) {
            if let Some(hash) = fetch(ctx, path.as_deref(), size, column) {
                let _ = ctx.conn.execute(&format!("UPDATE videos SET {column} = ?2 WHERE file_id = ?1"), params![file_id, hash]);
            }
        }
    }
    let _ = ctx.conn.execute("DELETE FROM metadata WHERE file_id = ?1 AND source = 'omdb'", [file_id]);
    if let Some((imdb, rating)) = imdb_rating(ctx, t.imdb_id.as_deref()) {
        let _ = ctx.conn.execute("INSERT INTO metadata(file_id, source, external_id, rating, fetched_at) VALUES (?1, 'omdb', ?2, ?3, ?4)", params![file_id, imdb, rating, db::now()]);
    }
    note(ctx.conn, "movie", &key, "matched", Some(&external));
    Ok(true)
}

/// An episode of a series being looked up: its file, season and number.
pub type EpisodeFile = (i64, u32, u32);

/// Looks one series up and keeps what was found, for the series and for each of its episodes; whether it was matched.
pub fn show(ctx: &Ctx, key: &str, name: &str, year: Option<u16>, episodes: &[EpisodeFile]) -> Result<bool, Failure> {
    let picked = chosen(ctx.conn, "show", key);
    if picked.as_ref().is_some_and(|(state, _)| state == "removed") {
        return Ok(false);
    }
    let beside: Option<String> = ctx.conn.query_row("SELECT external_id FROM shows WHERE key = ?1 AND source = 'nfo' AND external_id IS NOT NULL", [key], |r| r.get(0)).optional().ok().flatten();
    let id = match known_id(ctx, Kind::Show, picked.as_ref().and_then(|p| p.1.as_deref()), beside.as_deref())? {
        Some(id) => Some(id),
        None => tmdb::pick(&ctx.tmdb.search(Kind::Show, name, year)?, name, year).map(|c| c.id),
    };
    let Some(id) = id else {
        note(ctx.conn, "show", key, "none", None);
        return Ok(false);
    };
    let t = ctx.tmdb.title(Kind::Show, id)?;
    let external = format!("tmdb:{id}");
    let poster = fetch(ctx, t.poster_path.as_deref(), tmdb::POSTER, "poster");
    let backdrop = fetch(ctx, t.backdrop_path.as_deref(), tmdb::BACKDROP, "backdrop");
    ctx.conn
        .execute(
            "INSERT OR REPLACE INTO shows(key, source, external_id, title, year, overview, genres, rating, poster, backdrop, language, fetched_at)
             VALUES (?1, 'tmdb', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![key, external, t.title, t.year, t.overview, (!t.genres.is_empty()).then(|| t.genres.join(", ")), t.rating, poster, backdrop, ctx.tmdb.language, db::now()],
        )
        .map_err(|e| Failure::Other(e.to_string()))?;
    let _ = ctx.conn.execute("DELETE FROM shows WHERE key = ?1 AND source = 'omdb'", [key]);
    if let Some((imdb, rating)) = imdb_rating(ctx, t.imdb_id.as_deref()) {
        let _ = ctx.conn.execute("INSERT INTO shows(key, source, external_id, rating, fetched_at) VALUES (?1, 'omdb', ?2, ?3, ?4)", params![key, imdb, rating, db::now()]);
    }
    let mut seasons: Vec<u32> = episodes.iter().map(|e| e.1).collect();
    seasons.sort_unstable();
    seasons.dedup();
    for season in seasons {
        let listed = ctx.tmdb.season(id, season)?;
        for (file_id, _, number) in episodes.iter().filter(|e| e.1 == season) {
            let Some(e) = listed.iter().find(|l| l.number == *number) else { continue };
            let _ = ctx.conn.execute(
                "INSERT OR REPLACE INTO metadata(file_id, source, external_id, title, overview, runtime_min, language, fetched_at) VALUES (?1, 'tmdb', ?2, ?3, ?4, ?5, ?6, ?7)",
                params![file_id, external, e.name, e.overview, e.runtime_min, ctx.tmdb.language, db::now()],
            );
            if replaceable(ctx.conn, *file_id, "still") {
                if let Some(hash) = fetch(ctx, e.still_path.as_deref(), tmdb::STILL, "still") {
                    let _ = ctx.conn.execute("UPDATE videos SET still = ?2 WHERE file_id = ?1", params![file_id, hash]);
                }
            }
        }
    }
    note(ctx.conn, "show", key, "matched", Some(&external));
    Ok(true)
}

/// Takes TMDB's words and pictures away from a film again (the person said it is not that title, or no title).
pub fn unmatch_movie(conn: &Connection, file_id: i64) {
    let _ = conn.execute("DELETE FROM metadata WHERE file_id = ?1 AND source IN ('tmdb', 'omdb')", [file_id]);
    for column in ["poster", "backdrop"] {
        let _ = conn.execute(
            &format!("UPDATE videos SET {column} = NULL WHERE file_id = ?1 AND {column} IN (SELECT hash FROM images WHERE origin = 'tmdb')"),
            [file_id],
        );
    }
    let _ = conn.execute("UPDATE videos SET frames_tried = 0 WHERE file_id = ?1", [file_id]);
}

/// The same for a series and its episodes.
pub fn unmatch_show(conn: &Connection, key: &str, episodes: &[i64]) {
    let _ = conn.execute("DELETE FROM shows WHERE key = ?1 AND source IN ('tmdb', 'omdb')", [key]);
    for id in episodes {
        let _ = conn.execute("DELETE FROM metadata WHERE file_id = ?1 AND source = 'tmdb'", [id]);
        let _ = conn.execute("UPDATE videos SET still = NULL, frames_tried = 0 WHERE file_id = ?1 AND still IN (SELECT hash FROM images WHERE origin = 'tmdb')", [id]);
    }
}

/// The person's own answer to "which title is this?": a TMDB id, or none at all (`external` = None).
pub fn choose(conn: &Connection, kind: &str, key: &str, external: Option<&str>) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO lookups(kind, key, state, external_id, tried_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![kind, key, if external.is_some() { "chosen" } else { "removed" }, external, db::now()],
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::online::fake::Fake;

    /// A small real JPEG.
    fn jpeg(shade: u8) -> Vec<u8> {
        let img = image::RgbImage::from_pixel(8, 12, image::Rgb([shade, 40, 90]));
        let mut out = vec![];
        image::DynamicImage::ImageRgb8(img).write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 80)).unwrap();
        out
    }

    fn library(name: &str) -> (Connection, std::path::PathBuf) {
        let mut conn = Connection::open_in_memory().unwrap();
        db::migrate(&mut conn).unwrap();
        let cache = std::env::temp_dir().join(format!("pmp-lookup-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cache);
        std::fs::create_dir_all(&cache).unwrap();
        conn.execute_batch(
            "INSERT INTO files(id, path, size, mtime, kind, added_at, scanned_at) VALUES
               (1, 'D:\\F\\The.Matrix.1999.mkv', 1, 1, 'video', 1, 1), (2, 'D:\\F\\Home video.mkv', 1, 1, 'video', 1, 1),
               (3, 'D:\\S\\Dark\\S01E01.mkv', 1, 1, 'video', 1, 1), (4, 'D:\\S\\Dark\\S01E02.mkv', 1, 1, 'video', 1, 1);
             INSERT INTO videos(file_id, kind, title) VALUES (1, 'movie', 'The Matrix'), (2, 'movie', 'Home video'), (3, 'episode', 'Dark'), (4, 'episode', 'Dark');",
        )
        .unwrap();
        (conn, cache)
    }

    fn services() -> Fake {
        Fake::start(vec![
            ("/search/movie", 200, br#"{"results":[{"id":603,"title":"The Matrix","original_title":"The Matrix","release_date":"1999-03-31","popularity":90}]}"#.to_vec()),
            ("/movie/603", 200, br#"{"id":603,"title":"The Matrix","original_title":"The Matrix","release_date":"1999-03-31","overview":"A hacker.","runtime":136,
                "genres":[{"name":"Action"}],"vote_average":8.2,"vote_count":9,"imdb_id":"tt0133093","poster_path":"/m.jpg","backdrop_path":"/b.jpg"}"#.to_vec()),
            ("/search/tv", 200, br#"{"results":[{"id":70523,"name":"Dark","original_name":"Dark","first_air_date":"2017-12-01","popularity":50}]}"#.to_vec()),
            ("/tv/70523", 200, br#"{"id":70523,"name":"Dark","original_name":"Dark","first_air_date":"2017-12-01","overview":"A town.","episode_run_time":[60],
                "genres":[{"name":"Crime"},{"name":"Drama"}],"vote_average":8.4,"vote_count":5,"external_ids":{"imdb_id":"tt5753856"},"poster_path":"/d.jpg","backdrop_path":"/db.jpg"}"#.to_vec()),
            ("/tv/70523/season/1", 200, br#"{"episodes":[{"episode_number":1,"name":"Secrets","overview":"A boy.","still_path":"/s1.jpg","runtime":51},{"episode_number":2,"name":"Lies","overview":"","still_path":null}]}"#.to_vec()),
            ("/img/w342/m.jpg", 200, jpeg(10)),
            ("/img/w1280/b.jpg", 200, jpeg(20)),
            ("/img/w342/d.jpg", 200, jpeg(30)),
            ("/img/w1280/db.jpg", 200, jpeg(40)),
            ("/img/w300/s1.jpg", 200, jpeg(50)),
            ("/omdb/?i=tt0133093&apikey=o", 200, br#"{"imdbRating":"8.7","Response":"True"}"#.to_vec()),
            ("/omdb/?i=tt5753856&apikey=o", 200, br#"{"Response":"False","Error":"Incorrect IMDb ID."}"#.to_vec()),
        ])
    }

    fn origin(conn: &Connection, hash: &str) -> String {
        conn.query_row("SELECT origin FROM images WHERE hash = ?1", [hash], |r| r.get(0)).unwrap()
    }

    #[test]
    fn a_film_and_a_series_are_matched_and_kept() {
        let (conn, cache) = library("match");
        let fake = services();
        std::env::set_var("PASTEL_OMDB_URL", format!("{}/omdb", fake.url));
        let http = Http::new();
        let tmdb = Tmdb { http: &http, base: fake.url.clone(), images: format!("{}/img", fake.url), key: "k".into(), language: "en-US".into() };
        let ctx = Ctx { conn: &conn, cache: &cache, http: &http, tmdb: &tmdb, omdb: Some("o") };

        // The film has art of its own for a poster and a frame for a backdrop: only the frame gives way.
        conn.execute_batch(
            "INSERT INTO images(hash, kind, path, w, h, bytes, last_used_at, origin) VALUES ('mine', 'poster', '', 1, 1, 1, 1, 'own'), ('frame', 'backdrop', '', 1, 1, 1, 1, 'frame');
             UPDATE videos SET poster = 'mine', backdrop = 'frame' WHERE file_id = 1;",
        )
        .unwrap();
        assert_eq!(movie(&ctx, 1, "The Matrix", Some(1999)), Ok(true));
        let (title, overview, genres, rating): (String, String, String, f64) =
            conn.query_row("SELECT title, overview, genres, rating FROM metadata WHERE file_id = 1 AND source = 'tmdb'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
        assert_eq!((title.as_str(), overview.as_str(), genres.as_str(), rating), ("The Matrix", "A hacker.", "Action", 8.2));
        let imdb: f64 = conn.query_row("SELECT rating FROM metadata WHERE file_id = 1 AND source = 'omdb'", [], |r| r.get(0)).unwrap();
        assert_eq!(imdb, 8.7);
        let (poster, backdrop): (String, String) = conn.query_row("SELECT poster, backdrop FROM videos WHERE file_id = 1", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(poster, "mine", "a person's own poster stays");
        assert_eq!(origin(&conn, &backdrop), "tmdb", "a frame gives way to TMDB's backdrop");
        assert!(cache.join(format!("{backdrop}.jpg")).is_file());

        // A name TMDB has nothing plain for is left as it is, and remembered as asked.
        assert_eq!(movie(&ctx, 2, "Home video", None), Ok(false));
        let state: String = conn.query_row("SELECT state FROM lookups WHERE kind = 'movie' AND key = '2'", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "none");

        // The series, and each episode from its season
        assert_eq!(show(&ctx, "dark", "Dark", None, &[(3, 1, 1), (4, 1, 2)]), Ok(true));
        let (year, genres, poster): (u16, String, String) = conn.query_row("SELECT year, genres, poster FROM shows WHERE key = 'dark' AND source = 'tmdb'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        assert_eq!((year, genres.as_str(), origin(&conn, &poster).as_str()), (2017, "Crime, Drama", "tmdb"));
        let none: i64 = conn.query_row("SELECT count(*) FROM shows WHERE key = 'dark' AND source = 'omdb'", [], |r| r.get(0)).unwrap();
        assert_eq!(none, 0, "OMDb has no rating for it");
        let names: Vec<String> = conn.prepare("SELECT title FROM metadata WHERE source = 'tmdb' AND file_id IN (3, 4) ORDER BY file_id").unwrap().query_map([], |r| r.get(0)).unwrap().flatten().collect();
        assert_eq!(names, ["Secrets", "Lies"]);
        let stills: (Option<String>, Option<String>) = (
            conn.query_row("SELECT still FROM videos WHERE file_id = 3", [], |r| r.get(0)).unwrap(),
            conn.query_row("SELECT still FROM videos WHERE file_id = 4", [], |r| r.get(0)).unwrap(),
        );
        assert!(stills.0.is_some() && stills.1.is_none());

        // Not that title after all: TMDB's words and pictures go, the person's own stay, and it is never asked again.
        unmatch_movie(&conn, 1);
        choose(&conn, "movie", "1", None).unwrap();
        let (poster, backdrop): (Option<String>, Option<String>) = conn.query_row("SELECT poster, backdrop FROM videos WHERE file_id = 1", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((poster.as_deref(), backdrop), (Some("mine"), None));
        let asked = fake.asked().len();
        assert_eq!(movie(&ctx, 1, "The Matrix", Some(1999)), Ok(false));
        assert_eq!(fake.asked().len(), asked, "nothing is asked for a title the person took the match from");
        // Their own pick is used without a search
        choose(&conn, "movie", "2", Some("tmdb:603")).unwrap();
        assert_eq!(movie(&ctx, 2, "Home video", None), Ok(true));
        assert!(!fake.asked()[asked..].iter().any(|a| a.contains("/search/")));
        let state: String = conn.query_row("SELECT state FROM lookups WHERE kind = 'movie' AND key = '2'", [], |r| r.get(0)).unwrap();
        assert_eq!(state, "chosen");

        std::env::remove_var("PASTEL_OMDB_URL");
        std::fs::remove_dir_all(cache).ok();
    }
}
