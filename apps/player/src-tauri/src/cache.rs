//! The image cache (`<app data>/images`, the `images` table): how much it holds, its size limit, and clearing it.
//!
//! Everything in it but a person's own art can be made or fetched again, so: pictures nothing points at any more
//! (a folder was removed) are swept away; over the limit, episode pictures go first, the least recently made first,
//! and come back when their series is opened; Clear cache drops every frame and every fetched picture.

use crate::db::Db;
use crate::library;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// The limit until a person picks another, in megabytes.
pub const DEFAULT_CAP_MB: u64 = 1024;
const CAP_KEY: &str = "image_cache_mb";

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheInfo {
    pub bytes: u64,
    pub pictures: u64,
    pub cap_mb: u64,
}

pub fn cap_mb(conn: &Connection) -> u64 {
    conn.query_row("SELECT value FROM app_settings WHERE key = ?1", [CAP_KEY], |r| r.get::<_, String>(0)).ok().and_then(|v| v.parse().ok()).filter(|mb| *mb >= 50).unwrap_or(DEFAULT_CAP_MB)
}

pub fn info(conn: &Connection) -> CacheInfo {
    let (pictures, bytes): (i64, i64) = conn.query_row("SELECT count(*), COALESCE(sum(bytes), 0) FROM images", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap_or((0, 0));
    CacheInfo { bytes: bytes as u64, pictures: pictures as u64, cap_mb: cap_mb(conn) }
}

fn remove_files(cache: &Path, hashes: &[String]) {
    for hash in hashes {
        let _ = std::fs::remove_file(cache.join(format!("{hash}.jpg")));
    }
}

fn hashes(conn: &Connection, sql: &str) -> Vec<String> {
    conn.prepare(sql).and_then(|mut st| st.query_map([], |r| r.get::<_, String>(0)).map(|m| m.flatten().collect())).unwrap_or_default()
}

/// Every image something in the library points at.
const IN_USE: &str = "SELECT poster FROM videos WHERE poster IS NOT NULL
     UNION SELECT backdrop FROM videos WHERE backdrop IS NOT NULL
     UNION SELECT still FROM videos WHERE still IS NOT NULL
     UNION SELECT poster FROM shows WHERE poster IS NOT NULL
     UNION SELECT backdrop FROM shows WHERE backdrop IS NOT NULL
     UNION SELECT cover FROM album_art WHERE cover IS NOT NULL";

/// Removes the pictures nothing points at any more; how many.
pub fn sweep(conn: &Connection, cache: &Path) -> usize {
    let gone = hashes(conn, &format!("SELECT hash FROM images WHERE hash NOT IN ({IN_USE})"));
    if gone.is_empty() {
        return 0;
    }
    let _ = conn.execute(&format!("DELETE FROM images WHERE hash NOT IN ({IN_USE})"), []);
    remove_files(cache, &gone);
    gone.len()
}

/// Brings the cache under `cap_bytes` by dropping episode pictures, the least recently made first. They are marked
/// as asked, so they come back when their series is opened, not by themselves. How many were dropped.
pub fn trim(conn: &Connection, cache: &Path, cap_bytes: u64) -> usize {
    let mut total = info(conn).bytes;
    if total <= cap_bytes {
        return 0;
    }
    let stills: Vec<(String, i64)> = conn
        .prepare("SELECT hash, bytes FROM images WHERE kind = 'still' AND origin <> 'own' ORDER BY last_used_at, hash")
        .and_then(|mut st| st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|m| m.flatten().collect()))
        .unwrap_or_default();
    let mut dropped = vec![];
    for (hash, bytes) in stills {
        if total <= cap_bytes {
            break;
        }
        let _ = conn.execute("UPDATE videos SET still = NULL, frames_tried = 1 WHERE still = ?1", [&hash]);
        let _ = conn.execute("DELETE FROM images WHERE hash = ?1", [&hash]);
        total = total.saturating_sub(bytes as u64);
        dropped.push(hash);
    }
    remove_files(cache, &dropped);
    dropped.len()
}

/// Drops every picture that can be made or fetched again (all but a person's own art). The videos are marked as
/// asked: their pictures come back for what is opened, not for the whole library at once. How many were dropped.
pub fn clear(conn: &Connection, cache: &Path) -> usize {
    const AGAIN: &str = "SELECT hash FROM images WHERE origin <> 'own'";
    let gone = hashes(conn, AGAIN);
    let _ = conn.execute_batch(&format!(
        "UPDATE videos SET poster = NULL WHERE poster IN ({AGAIN});
         UPDATE videos SET backdrop = NULL WHERE backdrop IN ({AGAIN});
         UPDATE videos SET still = NULL WHERE still IN ({AGAIN});
         UPDATE shows SET poster = NULL WHERE poster IN ({AGAIN});
         UPDATE shows SET backdrop = NULL WHERE backdrop IN ({AGAIN});
         DELETE FROM album_art WHERE cover IN ({AGAIN});
         UPDATE videos SET frames_tried = 1;
         DELETE FROM images WHERE origin <> 'own';"
    ));
    remove_files(cache, &gone);
    gone.len()
}

/// After pictures were made: orphans go, and the limit is kept.
pub fn tidy(conn: &Connection, cache: &Path) {
    sweep(conn, cache);
    trim(conn, cache, cap_mb(conn) * 1024 * 1024);
}

fn images_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().map(|d| d.join("images")).unwrap_or_default()
}

fn changed(app: &AppHandle) {
    library::forget_library(app);
    let _ = app.emit("library://changed", ());
}

/// Settings → Storage: how much the cache holds, and its limit.
#[tauri::command]
pub fn cache_info(app: AppHandle) -> Result<CacheInfo, String> {
    library::ensure_ready(&app)?;
    let db = app.state::<Db>();
    let conn = db.conn()?;
    sweep(&conn, &images_dir(&app));
    Ok(info(&conn))
}

/// Sets the limit (megabytes) and keeps it at once.
#[tauri::command]
pub fn cache_set_cap(app: AppHandle, mb: u64) -> Result<CacheInfo, String> {
    library::ensure_ready(&app)?;
    let (dropped, now) = {
        let db = app.state::<Db>();
        let conn = db.conn()?;
        conn.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?1, ?2)", params![CAP_KEY, mb.max(50).to_string()]).map_err(|e| e.to_string())?;
        let dropped = trim(&conn, &images_dir(&app), cap_mb(&conn) * 1024 * 1024);
        (dropped, info(&conn))
    };
    if dropped > 0 {
        changed(&app);
    }
    Ok(now)
}

/// Clear cache.
#[tauri::command]
pub fn cache_clear(app: AppHandle) -> Result<CacheInfo, String> {
    library::ensure_ready(&app)?;
    crate::frames::forget_queue(&app);
    let now = {
        let db = app.state::<Db>();
        let conn = db.conn()?;
        clear(&conn, &images_dir(&app));
        info(&conn)
    };
    changed(&app);
    Ok(now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library(name: &str) -> (Connection, PathBuf) {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        let cache = std::env::temp_dir().join(format!("pmp-cache-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&cache);
        std::fs::create_dir_all(&cache).unwrap();
        conn.execute_batch(
            "INSERT INTO files(id, path, size, mtime, kind, added_at, scanned_at) VALUES
               (1, 'D:\\F\\a.mkv', 1, 1, 'video', 1, 1), (2, 'D:\\F\\b.mkv', 1, 1, 'video', 1, 1), (3, 'D:\\F\\c.mkv', 1, 1, 'video', 1, 1);
             INSERT INTO videos(file_id, kind, title) VALUES (1, 'movie', 'a'), (2, 'episode', 'b'), (3, 'episode', 'c');",
        )
        .unwrap();
        (conn, cache)
    }

    fn picture(conn: &Connection, cache: &Path, hash: &str, kind: &str, origin: &str, bytes: i64, at: i64) {
        std::fs::write(cache.join(format!("{hash}.jpg")), b"x").unwrap();
        conn.execute("INSERT INTO images(hash, kind, path, w, h, bytes, last_used_at, origin) VALUES (?1, ?2, '', 1, 1, ?3, ?4, ?5)", params![hash, kind, bytes, at, origin]).unwrap();
    }

    fn there(cache: &Path, hash: &str) -> bool {
        cache.join(format!("{hash}.jpg")).is_file()
    }

    #[test]
    fn pictures_nothing_points_at_are_swept() {
        let (conn, cache) = library("sweep");
        picture(&conn, &cache, "used", "poster", "own", 10, 1);
        picture(&conn, &cache, "orphan", "poster", "own", 10, 1);
        conn.execute("UPDATE videos SET poster = 'used' WHERE file_id = 1", []).unwrap();
        assert_eq!(sweep(&conn, &cache), 1);
        assert!(there(&cache, "used") && !there(&cache, "orphan"));
        assert_eq!(info(&conn), CacheInfo { bytes: 10, pictures: 1, cap_mb: DEFAULT_CAP_MB });
        std::fs::remove_dir_all(cache).ok();
    }

    #[test]
    fn over_the_limit_the_oldest_episode_pictures_go_and_are_not_made_again_by_themselves() {
        let (conn, cache) = library("trim");
        picture(&conn, &cache, "backdrop", "backdrop", "frame", 600, 1);
        picture(&conn, &cache, "old", "still", "frame", 300, 2);
        picture(&conn, &cache, "new", "still", "frame", 300, 3);
        conn.execute_batch("UPDATE videos SET backdrop = 'backdrop' WHERE file_id = 1; UPDATE videos SET still = 'old' WHERE file_id = 2; UPDATE videos SET still = 'new' WHERE file_id = 3;").unwrap();
        assert_eq!(trim(&conn, &cache, 2000), 0);
        assert_eq!(trim(&conn, &cache, 1000), 1);
        assert!(!there(&cache, "old") && there(&cache, "new") && there(&cache, "backdrop"));
        let (still, tried): (Option<String>, bool) = conn.query_row("SELECT still, frames_tried FROM videos WHERE file_id = 2", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((still, tried), (None, true));
        std::fs::remove_dir_all(cache).ok();
    }

    #[test]
    fn clearing_keeps_a_persons_own_art_and_drops_the_rest() {
        let (conn, cache) = library("clear");
        picture(&conn, &cache, "mine", "poster", "own", 10, 1);
        picture(&conn, &cache, "frame", "backdrop", "frame", 10, 1);
        picture(&conn, &cache, "show", "backdrop", "frame", 10, 1);
        conn.execute_batch(
            "UPDATE videos SET poster = 'mine', backdrop = 'frame' WHERE file_id = 1;
             INSERT INTO shows(key, source, backdrop, fetched_at) VALUES ('dark', 'frame', 'show', 1);",
        )
        .unwrap();
        assert_eq!(clear(&conn, &cache), 2);
        assert!(there(&cache, "mine") && !there(&cache, "frame") && !there(&cache, "show"));
        let (poster, backdrop): (Option<String>, Option<String>) = conn.query_row("SELECT poster, backdrop FROM videos WHERE file_id = 1", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!((poster.as_deref(), backdrop), (Some("mine"), None));
        let show: Option<String> = conn.query_row("SELECT backdrop FROM shows WHERE key = 'dark'", [], |r| r.get(0)).unwrap();
        assert_eq!(show, None);
        std::fs::remove_dir_all(cache).ok();
    }

    #[test]
    fn the_limit_is_the_default_until_one_is_set() {
        let (conn, cache) = library("cap");
        assert_eq!(cap_mb(&conn), DEFAULT_CAP_MB);
        conn.execute("INSERT INTO app_settings(key, value) VALUES ('image_cache_mb', '250')", []).unwrap();
        assert_eq!(cap_mb(&conn), 250);
        std::fs::remove_dir_all(cache).ok();
    }
}
