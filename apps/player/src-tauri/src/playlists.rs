//! Playlists: lists of songs a person makes (`playlists`, `playlist_items`). The page names songs by their file's
//! path, as the play history does. Only songs of the library go in a playlist, each once.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db::{now, Db};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: i64,
    pub name: String,
    pub description: String,
    /// Seconds since 1970.
    pub created_at: i64,
    pub updated_at: i64,
    /// Its songs' files, in order. One that can't be found right now stays in the list.
    pub paths: Vec<String>,
}

fn paths_of(conn: &Connection, id: i64) -> rusqlite::Result<Vec<String>> {
    conn.prepare("SELECT f.path FROM playlist_items i JOIN files f ON f.id = i.file_id WHERE i.playlist_id = ?1 ORDER BY i.position")?
        .query_map([id], |r| r.get(0))?
        .collect()
}

/// One playlist with its songs, if it exists.
pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Option<Playlist>> {
    let row = conn
        .query_row("SELECT id, name, description, created_at, updated_at FROM playlists WHERE id = ?1", [id], |r| {
            Ok(Playlist { id: r.get(0)?, name: r.get(1)?, description: r.get(2)?, created_at: r.get(3)?, updated_at: r.get(4)?, paths: vec![] })
        })
        .optional()?;
    let Some(mut playlist) = row else { return Ok(None) };
    playlist.paths = paths_of(conn, id)?;
    Ok(Some(playlist))
}

/// Every playlist, the one changed last first.
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<Playlist>> {
    let ids: Vec<i64> = conn.prepare("SELECT id FROM playlists ORDER BY updated_at DESC, id DESC")?.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        if let Some(p) = get(conn, id)? {
            out.push(p);
        }
    }
    Ok(out)
}

/// A new, empty playlist.
pub fn create(conn: &Connection, name: &str, description: &str, at: i64) -> rusqlite::Result<Playlist> {
    conn.execute("INSERT INTO playlists(name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)", params![name.trim(), description.trim(), at])?;
    let id = conn.last_insert_rowid();
    Ok(Playlist { id, name: name.trim().into(), description: description.trim().into(), created_at: at, updated_at: at, paths: vec![] })
}

/// A new name and description. False when there is no such playlist.
pub fn update(conn: &Connection, id: i64, name: &str, description: &str, at: i64) -> rusqlite::Result<bool> {
    let n = conn.execute("UPDATE playlists SET name = ?2, description = ?3, updated_at = ?4 WHERE id = ?1", params![id, name.trim(), description.trim(), at])?;
    Ok(n > 0)
}

pub fn delete(conn: &Connection, id: i64) -> rusqlite::Result<bool> {
    Ok(conn.execute("DELETE FROM playlists WHERE id = ?1", [id])? > 0)
}

/// Makes these songs the playlist's, in this order: how songs are added, taken out and moved. A path that isn't a
/// song of the library, or comes a second time, is left out. Returns the list as it was kept.
pub fn set_items(conn: &Connection, id: i64, paths: &[String], at: i64) -> rusqlite::Result<Option<Vec<String>>> {
    let tx = conn.unchecked_transaction()?;
    if tx.execute("UPDATE playlists SET updated_at = ?2 WHERE id = ?1", params![id, at])? == 0 {
        return Ok(None);
    }
    tx.execute("DELETE FROM playlist_items WHERE playlist_id = ?1", [id])?;
    {
        let mut find = tx.prepare("SELECT id FROM files WHERE path = ?1 AND kind = 'audio'")?;
        let mut add = tx.prepare("INSERT OR IGNORE INTO playlist_items(playlist_id, position, file_id) VALUES (?1, ?2, ?3)")?;
        for (position, path) in paths.iter().enumerate() {
            if let Some(file) = find.query_row([path], |r| r.get::<_, i64>(0)).optional()? {
                add.execute(params![id, position as i64, file])?;
            }
        }
    }
    let kept = paths_of(&tx, id)?;
    tx.commit()?;
    Ok(Some(kept))
}

fn named(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("a playlist needs a name".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn playlists_list(app: AppHandle) -> Result<Vec<Playlist>, String> {
    crate::library::ensure_ready(&app)?;
    let db = app.state::<Db>();
    let conn = db.conn()?;
    list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn playlist_create(app: AppHandle, name: String, description: String) -> Result<Playlist, String> {
    named(&name)?;
    crate::library::ensure_ready(&app)?;
    let db = app.state::<Db>();
    let conn = db.conn()?;
    create(&conn, &name, &description, now()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn playlist_update(app: AppHandle, id: i64, name: String, description: String) -> Result<bool, String> {
    named(&name)?;
    crate::library::ensure_ready(&app)?;
    let db = app.state::<Db>();
    let conn = db.conn()?;
    update(&conn, id, &name, &description, now()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn playlist_delete(app: AppHandle, id: i64) -> Result<bool, String> {
    crate::library::ensure_ready(&app)?;
    let db = app.state::<Db>();
    let conn = db.conn()?;
    delete(&conn, id).map_err(|e| e.to_string())
}

/// The playlist's songs, replaced by these; answers the list as it was kept, or nothing when there is no such playlist.
#[tauri::command]
pub async fn playlist_set(app: AppHandle, id: i64, paths: Vec<String>) -> Result<Option<Vec<String>>, String> {
    crate::library::ensure_ready(&app)?;
    let db = app.state::<Db>();
    let conn = db.conn()?;
    set_items(&conn, id, &paths, now()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> Connection {
        let conn = crate::db::memory();
        conn.execute_batch(
            "INSERT INTO places(id, path, created_at) VALUES (1, 'D:\\Media', 1);
             INSERT INTO files(id, place_id, path, size, mtime, kind, added_at, scanned_at) VALUES
               (1, 1, 'D:\\Media\\a.mp3', 1, 1, 'audio', 1, 1),
               (2, 1, 'D:\\Media\\b.mp3', 1, 1, 'audio', 1, 1),
               (3, 1, 'D:\\Media\\c.mp3', 1, 1, 'audio', 1, 1),
               (4, 1, 'D:\\Media\\film.mkv', 1, 1, 'video', 1, 1);",
        )
        .unwrap();
        conn
    }

    const A: &str = r"D:\Media\a.mp3";
    const B: &str = r"D:\Media\b.mp3";
    const C: &str = r"D:\Media\c.mp3";
    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|p| p.to_string()).collect()
    }

    #[test]
    fn keeps_songs_in_the_order_given_each_once_and_only_songs_of_the_library() {
        let conn = library();
        let road = create(&conn, "  Road trip ", "", 10).unwrap();
        assert_eq!((road.name.as_str(), road.paths.len()), ("Road trip", 0));
        let kept = set_items(&conn, road.id, &paths(&[C, A, r"C:\Downloads\x.mp3", C, r"D:\Media\film.mkv", B]), 20).unwrap().unwrap();
        assert_eq!(kept, paths(&[C, A, B]));
        // Moved and one taken out: the same call
        assert_eq!(set_items(&conn, road.id, &paths(&[B, C]), 30).unwrap().unwrap(), paths(&[B, C]));
        let again = get(&conn, road.id).unwrap().unwrap();
        assert_eq!((again.paths, again.updated_at, again.created_at), (paths(&[B, C]), 30, 10));
        assert_eq!(set_items(&conn, 99, &paths(&[A]), 40).unwrap(), None, "no such playlist");
    }

    #[test]
    fn lists_the_one_changed_last_first_and_renames_and_deletes() {
        let conn = library();
        let one = create(&conn, "One", "", 10).unwrap();
        let two = create(&conn, "Two", "For the evening", 20).unwrap();
        assert_eq!(list(&conn).unwrap().iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["Two", "One"]);
        assert!(update(&conn, one.id, "First", "Mornings", 30).unwrap());
        let listed = list(&conn).unwrap();
        assert_eq!((listed[0].name.as_str(), listed[0].description.as_str()), ("First", "Mornings"));
        set_items(&conn, two.id, &paths(&[A]), 40).unwrap();
        assert!(delete(&conn, two.id).unwrap());
        assert!(!delete(&conn, two.id).unwrap());
        let left: i64 = conn.query_row("SELECT count(*) FROM playlist_items", [], |r| r.get(0)).unwrap();
        assert_eq!((list(&conn).unwrap().len(), left), (1, 0), "its songs' rows go with it");
    }

    #[test]
    fn a_file_that_leaves_the_library_leaves_its_playlists() {
        let conn = library();
        let p = create(&conn, "Mix", "", 10).unwrap();
        set_items(&conn, p.id, &paths(&[A, B, C]), 20).unwrap();
        conn.execute("DELETE FROM files WHERE id = 2", []).unwrap();
        assert_eq!(get(&conn, p.id).unwrap().unwrap().paths, paths(&[A, C]));
    }
}
