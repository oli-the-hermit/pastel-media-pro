//! "Can't find this file": pointing a file of the library at where it is now, taking one that is gone for good out
//! of the library, and a library folder that moved. Only the library's own rows change: the files are never touched.
//! A file keeps its row, so its place in playlists, where it was left and its corrected match all stay.

use crate::db::{self, Db};
use crate::import::{self, FolderCounts, JobView};
use crate::library;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

/// What became of a relink.
#[derive(Serialize, Debug, PartialEq, Eq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum Relinked {
    /// The file is found again.
    Done,
    /// The file picked is not the one that went missing (another size or content): the page asks before using it.
    Different,
    /// The file picked is in the library already, as another song or video.
    Taken,
    /// A song can't become a video, or the other way round.
    WrongKind,
}

fn path_string(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

/// The place a path is inside, if any.
fn place_of(conn: &Connection, path: &Path) -> Option<import::Place> {
    import::places(conn).into_iter().find(|p| path.starts_with(&p.root))
}

/// Points the library's file at `old` to the file at `new`. The same file (same fingerprint and size) is taken at
/// once. Another file is only taken with `anyway`, and is then read again (its tags, its length, its art).
pub fn relink_file(conn: &Connection, cache: &Path, old: &str, new: &Path, anyway: bool) -> Result<Relinked, String> {
    let (id, fp, size, kind): (i64, Option<String>, i64, String) = conn
        .query_row("SELECT id, fp, size, kind FROM files WHERE path = ?1", [old], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("this file is not in the library")?;
    let new = new.canonicalize().map_err(|_| "that file can't be found")?;
    let on_disk = import::stat(&new).ok_or("that file is not a song or a video the library can hold")?;
    if import::kind_name(on_disk.kind) != kind {
        return Ok(Relinked::WrongKind);
    }
    let new_path = path_string(&new);
    let other: Option<i64> = conn.query_row("SELECT id FROM files WHERE path = ?1 AND id <> ?2", params![new_path, id], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
    if other.is_some() {
        return Ok(Relinked::Taken);
    }
    let new_fp = import::fingerprint(&new, on_disk.size).ok_or("that file can't be read")?;
    let same = fp.as_deref() == Some(new_fp.as_str()) && size as u64 == on_disk.size;
    if !same && !anyway {
        return Ok(Relinked::Different);
    }
    let place = place_of(conn, &new);
    conn.execute(
        "UPDATE files SET path = ?2, place_id = ?3, mtime = ?4, scanned_at = ?5, missing = 0 WHERE id = ?1",
        params![id, new_path, place.as_ref().map(|p| p.id), on_disk.mtime, db::now()],
    )
    .map_err(|e| e.to_string())?;
    if !same {
        let rec = import::read_file(&on_disk, place.as_ref().map(|p| p.root.as_path()), cache, &FolderCounts::default())?;
        import::write_record(conn, &rec, place.as_ref().map(|p| p.id), cache).map_err(|e| e.to_string())?;
    }
    Ok(Relinked::Done)
}

/// Takes a file out of the library: one that can't be found, or one that was added on its own. A file that is
/// there, in a library folder, would only come back at the next check for changes.
pub fn forget_file(conn: &Connection, path: &str) -> Result<(), String> {
    let (id, place): (i64, Option<i64>) = conn
        .query_row("SELECT id, place_id FROM files WHERE path = ?1", [path], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or("this file is not in the library")?;
    if place.is_some() && Path::new(path).is_file() {
        return Err("this file is in one of your library folders, so it would come back".into());
    }
    conn.execute("DELETE FROM files WHERE id = ?1", [id]).map_err(|e| e.to_string())?;
    Ok(())
}

/// A library folder that was moved or renamed: the place and its files follow to `folder`, each file by its path
/// below the place. What isn't there under the new folder is found missing by the check that follows.
pub fn relink_place(conn: &Connection, place_id: i64, folder: &Path) -> Result<(), String> {
    let all = import::places(conn);
    let place = all.iter().find(|p| p.id == place_id).ok_or("this folder is not in the library")?;
    let folder = folder.canonicalize().map_err(|_| "that folder can't be found")?;
    if !folder.is_dir() {
        return Err("that is not a folder".into());
    }
    if folder == place.root {
        return Ok(());
    }
    if all.iter().any(|p| p.id != place_id && (folder.starts_with(&p.root) || p.root.starts_with(&folder))) {
        return Err("that folder is in your library already".into());
    }
    let moved = |old: &str| -> Option<String> { Path::new(old).strip_prefix(&place.root).ok().map(|rel| path_string(&folder.join(rel))) };
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for table in ["files", "skipped"] {
        let rows: Vec<String> = tx
            .prepare(&format!("SELECT path FROM {table} WHERE place_id = ?1"))
            .and_then(|mut st| st.query_map([place_id], |r| r.get::<_, String>(0)).map(|m| m.flatten().collect()))
            .map_err(|e| e.to_string())?;
        for old in rows {
            if let Some(new) = moved(&old) {
                // A file the library already has under the new folder keeps its own row; this one stays where it was
                // and is found missing.
                tx.execute(&format!("UPDATE OR IGNORE {table} SET path = ?2 WHERE path = ?1"), params![old, new]).map_err(|e| e.to_string())?;
            }
        }
    }
    tx.execute("UPDATE places SET path = ?2 WHERE id = ?1", params![place_id, path_string(&folder)]).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn changed(app: &AppHandle) {
    library::refresh_places(app);
    library::invalidate(app);
    let _ = app.emit("library://changed", ());
}

fn images_dir(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().map(|d| d.join("images")).unwrap_or_default()
}

/// The page's "Find it…": `new_path` comes from the file dialog.
#[tauri::command]
pub fn file_relink(app: AppHandle, path: String, new_path: String, anyway: Option<bool>) -> Result<Relinked, String> {
    library::ensure_ready(&app)?;
    let done = {
        let db = app.state::<Db>();
        let conn = db.conn()?;
        relink_file(&conn, &images_dir(&app), &path, Path::new(&new_path), anyway.unwrap_or(false))?
    };
    if done == Relinked::Done {
        changed(&app);
    }
    Ok(done)
}

/// The page's "Remove from library".
#[tauri::command]
pub fn file_forget(app: AppHandle, path: String) -> Result<(), String> {
    library::ensure_ready(&app)?;
    {
        let db = app.state::<Db>();
        let conn = db.conn()?;
        forget_file(&conn, &path)?;
    }
    changed(&app);
    Ok(())
}

/// Settings → Library's "Find folder…": the place follows to the folder picked, then is checked for changes.
#[tauri::command]
pub fn place_relink(app: AppHandle, place_id: i64, folder: String) -> Result<JobView, String> {
    library::ensure_ready(&app)?;
    {
        let db = app.state::<Db>();
        let conn = db.conn()?;
        relink_place(&conn, place_id, Path::new(&folder))?;
    }
    changed(&app);
    import::rescan(&app, Some(place_id), false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filters::Filters;

    fn tree(name: &str, files: &[(&str, &[u8])]) -> PathBuf {
        let root = std::env::temp_dir().join(format!("pmp-relink-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        for (f, bytes) in files {
            let p = root.join(f);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, bytes).unwrap();
        }
        root
    }

    fn library() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        db::migrate(&mut conn).unwrap();
        conn
    }

    /// Reads a place's files into the library, as a check for changes does.
    fn read_place(conn: &Connection, root: &Path, cache: &Path) -> i64 {
        let id = import::adopt_folder(conn, root, &Filters::everything()).unwrap();
        let place = import::places(conn).into_iter().find(|p| p.id == id).unwrap();
        let stop = std::sync::atomic::AtomicBool::new(false);
        let (todo, seen) = import::plan_rescan(conn, &place, &stop);
        import::flag_missing(conn, id, &seen).unwrap();
        for f in todo {
            let rec = import::read_file(&f, Some(root), cache, &FolderCounts::default()).unwrap();
            import::write_record(conn, &rec, Some(id), cache).unwrap();
        }
        id
    }

    fn row(conn: &Connection, like: &str) -> (i64, String, bool) {
        conn.query_row("SELECT id, path, missing FROM files WHERE path LIKE ?1", [format!("%{like}")], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap()
    }

    #[test]
    fn a_file_is_found_again_where_it_was_moved_to() {
        let root = tree("moved", &[("Films/Night Train (2019).mkv", b"the same film"), ("Films/Other (2001).mkv", b"another film")]);
        let cache = root.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let conn = library();
        read_place(&conn, &root.join("Films"), &cache);
        let (id, old, _) = row(&conn, "Night Train (2019).mkv");

        // Moved out of the library folder: the check finds it missing
        let elsewhere = root.join("Elsewhere");
        std::fs::create_dir_all(&elsewhere).unwrap();
        let new = elsewhere.join("Night Train.mkv");
        std::fs::rename(&old, &new).unwrap();
        read_place(&conn, &root.join("Films"), &cache);
        assert!(row(&conn, "Night Train (2019).mkv").2, "it is missing");

        // Another file is not taken without asking, nor a file the library has already
        let different = elsewhere.join("Different.mkv");
        std::fs::write(&different, b"not that film at all").unwrap();
        assert_eq!(relink_file(&conn, &cache, &old, &different, false), Ok(Relinked::Different));
        assert_eq!(relink_file(&conn, &cache, &old, &root.join("Films/Other (2001).mkv"), true), Ok(Relinked::Taken));
        let song = elsewhere.join("song.mp3");
        std::fs::write(&song, b"a song").unwrap();
        assert_eq!(relink_file(&conn, &cache, &old, &song, true), Ok(Relinked::WrongKind));
        assert!(row(&conn, "Night Train (2019).mkv").2, "still missing after the refusals");

        // The same file, where it is now: the row is kept, outside any library folder
        assert_eq!(relink_file(&conn, &cache, &old, &new, false), Ok(Relinked::Done));
        let (id_after, path, missing) = row(&conn, "Night Train.mkv");
        assert_eq!((id_after, missing), (id, false));
        assert_eq!(Path::new(&path), new.as_path());
        let place: Option<i64> = conn.query_row("SELECT place_id FROM files WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(place, None);

        // Another file, taken on purpose: the row is kept and the file read again
        std::fs::remove_file(&new).unwrap();
        assert_eq!(relink_file(&conn, &cache, &path, &different, true), Ok(Relinked::Done));
        let (id_last, _, missing) = row(&conn, "Different.mkv");
        assert_eq!((id_last, missing), (id, false));
        let size: i64 = conn.query_row("SELECT size FROM files WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(size as usize, b"not that film at all".len());
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn only_a_file_that_would_not_come_back_is_forgotten() {
        let root = tree("forget", &[("Films/Here (2019).mkv", b"here"), ("Films/Gone (2020).mkv", b"gone")]);
        let cache = root.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let conn = library();
        read_place(&conn, &root.join("Films"), &cache);
        let (_, here, _) = row(&conn, "Here (2019).mkv");
        let (_, gone, _) = row(&conn, "Gone (2020).mkv");
        std::fs::remove_file(&gone).unwrap();
        read_place(&conn, &root.join("Films"), &cache);

        assert!(forget_file(&conn, &here).is_err(), "a file that is there in a library folder stays");
        assert_eq!(forget_file(&conn, &gone), Ok(()));
        let left: i64 = conn.query_row("SELECT count(*) FROM files", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 1);
        assert!(Path::new(&here).is_file(), "nothing on disk was touched");
        std::fs::remove_dir_all(root).ok();
    }

    #[test]
    fn a_library_folder_that_moved_takes_its_files_with_it() {
        let root = tree("place", &[("Old/Show/Season 1/Show.S01E01.mkv", b"one"), ("Old/Show/Season 1/Show.S01E02.mkv", b"two"), ("Music/a.mp3", b"x")]);
        let cache = root.join("cache");
        std::fs::create_dir_all(&cache).unwrap();
        let conn = library();
        let place = read_place(&conn, &root.join("Old"), &cache);
        let music = import::adopt_folder(&conn, &root.join("Music"), &Filters::everything()).unwrap();
        let (id, _, _) = row(&conn, "Show.S01E01.mkv");

        std::fs::rename(root.join("Old"), root.join("New")).unwrap();
        assert!(relink_place(&conn, place, &root.join("Music")).is_err(), "not onto a folder the library has");
        assert!(relink_place(&conn, music, &root.join("Nowhere")).is_err(), "not onto a folder that isn't there");
        assert_eq!(relink_place(&conn, place, &root.join("New")), Ok(()));

        let (id_after, path, _) = row(&conn, "Show.S01E01.mkv");
        assert_eq!(id_after, id);
        assert!(Path::new(&path).starts_with(root.join("New")) && Path::new(&path).is_file(), "{path}");
        let places = import::places(&conn);
        assert_eq!(places.iter().find(|p| p.id == place).unwrap().root, root.join("New"));
        // The check that follows finds every file where the library now says it is
        read_place(&conn, &root.join("New"), &cache);
        let missing: i64 = conn.query_row("SELECT count(*) FROM files WHERE missing = 1", [], |r| r.get(0)).unwrap();
        let files: i64 = conn.query_row("SELECT count(*) FROM files", [], |r| r.get(0)).unwrap();
        assert_eq!((missing, files), (0, 2));
        std::fs::remove_dir_all(root).ok();
    }
}
