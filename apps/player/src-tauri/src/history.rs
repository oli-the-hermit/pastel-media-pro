//! What was played, how far and when (`plays`, one row per library file). The page records as a file plays; the
//! pages read it for Continue watching, Recently played, the watched marks, and to pick a film up where it was left.
//! A file that isn't in the library (opened from Windows) has no row: nothing is recorded for it.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db::{now, Db};

/// A file counts as finished once this much of it was played, or its end was reached.
pub const FINISHED_AT: f64 = 0.9;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Play {
    pub path: String,
    /// Seconds: where it was left, and its length as the engine reported it (0 when it never did).
    pub position: f64,
    pub duration: f64,
    pub finished: bool,
    /// Times it was started.
    pub count: u32,
    /// Seconds since 1970.
    pub last_played_at: i64,
}

/// Writes down where a file is. `started` counts one more play; `ended` says its end was reached.
/// Returns false, and writes nothing, for a file that isn't in the library.
pub fn record(conn: &Connection, path: &str, position: f64, duration: f64, ended: bool, started: bool, at: i64) -> rusqlite::Result<bool> {
    let Some(id) = conn.query_row("SELECT id FROM files WHERE path = ?1", [path], |r| r.get::<_, i64>(0)).optional()? else {
        return Ok(false);
    };
    let finished = ended || (duration > 0.0 && position / duration >= FINISHED_AT);
    let ms = |seconds: f64| (seconds.max(0.0) * 1000.0).round() as i64;
    conn.execute(
        "INSERT INTO plays(file_id, position_ms, duration_ms, finished, play_count, last_played_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(file_id) DO UPDATE SET
           position_ms = excluded.position_ms,
           duration_ms = CASE WHEN excluded.duration_ms > 0 THEN excluded.duration_ms ELSE duration_ms END,
           finished = excluded.finished,
           play_count = play_count + excluded.play_count,
           last_played_at = excluded.last_played_at",
        params![id, ms(position), ms(duration), finished, started as i64, at],
    )?;
    // A song added without its length (its tags couldn't be read) learns it the first time it plays.
    if duration > 0.0 {
        conn.execute("UPDATE tracks SET duration_ms = ?2 WHERE file_id = ?1 AND duration_ms = 0", params![id, ms(duration)])?;
    }
    Ok(true)
}

fn play_of(r: &rusqlite::Row) -> rusqlite::Result<Play> {
    Ok(Play {
        path: r.get(0)?,
        position: r.get::<_, i64>(1)? as f64 / 1000.0,
        duration: r.get::<_, i64>(2)? as f64 / 1000.0,
        finished: r.get(3)?,
        count: r.get(4)?,
        last_played_at: r.get(5)?,
    })
}

const COLUMNS: &str = "f.path, p.position_ms, p.duration_ms, p.finished, p.play_count, p.last_played_at FROM plays p JOIN files f ON f.id = p.file_id";

/// Everything that was played and is still in the library, the latest first.
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Play>> {
    conn.prepare(&format!("SELECT {COLUMNS} WHERE f.missing = 0 ORDER BY p.last_played_at DESC, p.file_id DESC"))?.query_map([], play_of)?.collect()
}

/// One file's row, if it was ever played.
pub fn get(conn: &Connection, path: &str) -> rusqlite::Result<Option<Play>> {
    conn.query_row(&format!("SELECT {COLUMNS} WHERE f.path = ?1"), [path], play_of).optional()
}

#[tauri::command]
pub async fn history_record(app: AppHandle, path: String, position: f64, duration: f64, ended: bool, started: bool) -> Result<bool, String> {
    crate::library::ensure_ready(&app)?;
    let db = app.state::<Db>();
    let conn = db.conn()?;
    record(&conn, &path, position, duration, ended, started, now()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn history_list(app: AppHandle) -> Result<Vec<Play>, String> {
    crate::library::ensure_ready(&app)?;
    let db = app.state::<Db>();
    let conn = db.conn()?;
    list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn history_get(app: AppHandle, path: String) -> Result<Option<Play>, String> {
    crate::library::ensure_ready(&app)?;
    let db = app.state::<Db>();
    let conn = db.conn()?;
    get(&conn, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> Connection {
        let conn = crate::db::memory();
        conn.execute_batch(
            "INSERT INTO places(id, path, created_at) VALUES (1, 'D:\\Media', 1);
             INSERT INTO files(id, place_id, path, size, mtime, kind, added_at, scanned_at) VALUES
               (1, 1, 'D:\\Media\\Heat (1995).mkv', 1, 1, 'video', 1, 1),
               (2, 1, 'D:\\Media\\01 - Song.mp3', 1, 1, 'audio', 1, 1),
               (3, 1, 'D:\\Media\\Gone.mkv', 1, 1, 'video', 1, 1);
             UPDATE files SET missing = 1 WHERE id = 3;
             INSERT INTO tracks(file_id, title, artist, album_artist, album, duration_ms) VALUES (2, 'Song', '', '', 'Media', 0);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn keeps_where_a_film_was_left_and_when_it_is_finished() {
        let conn = library();
        let heat = r"D:\Media\Heat (1995).mkv";
        assert!(record(&conn, heat, 0.0, 6000.0, false, true, 100).unwrap());
        assert!(record(&conn, heat, 1500.5, 6000.0, false, false, 110).unwrap());
        let p = get(&conn, heat).unwrap().unwrap();
        assert_eq!((p.position, p.duration, p.finished, p.count, p.last_played_at), (1500.5, 6000.0, false, 1, 110));
        // Past nine tenths it is finished, without reaching the last second; watching again counts a second play
        record(&conn, heat, 5500.0, 6000.0, false, false, 120).unwrap();
        assert!(get(&conn, heat).unwrap().unwrap().finished);
        record(&conn, heat, 12.0, 0.0, false, true, 130).unwrap();
        let again = get(&conn, heat).unwrap().unwrap();
        assert_eq!((again.finished, again.count, again.duration), (false, 2, 6000.0), "a length of 0 doesn't erase the known one");
    }

    #[test]
    fn lists_the_latest_first_without_what_is_gone_or_was_never_in_the_library() {
        let conn = library();
        assert!(!record(&conn, r"C:\Downloads\clip.mp4", 5.0, 60.0, false, true, 50).unwrap(), "not a library file");
        record(&conn, r"D:\Media\Gone.mkv", 5.0, 60.0, false, true, 60).unwrap();
        record(&conn, r"D:\Media\Heat (1995).mkv", 5.0, 6000.0, false, true, 70).unwrap();
        record(&conn, r"D:\Media\01 - Song.mp3", 200.0, 200.0, true, true, 80).unwrap();
        let paths: Vec<_> = list(&conn).unwrap().into_iter().map(|p| (p.path, p.finished)).collect();
        assert_eq!(paths, vec![(r"D:\Media\01 - Song.mp3".to_string(), true), (r"D:\Media\Heat (1995).mkv".to_string(), false)]);
        // The song had no length: playing it filled it in
        let ms: i64 = conn.query_row("SELECT duration_ms FROM tracks WHERE file_id = 2", [], |r| r.get(0)).unwrap();
        assert_eq!(ms, 200_000);
    }
}
