//! `library.db`, the device library (architecture.md §4): SQLite, bundled, in the app's data folder. Opened on the
//! first use of the library, never at launch (D16). Migrations are numbered SQL files in `migrations/`, applied in
//! order and counted in `PRAGMA user_version`; a test replays all of them on an empty database.

use rusqlite::Connection;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

/// Every migration, in order. Append only: a released one is never edited.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_library.sql"),
    include_str!("../migrations/002_history.sql"),
    include_str!("../migrations/003_playlists.sql"),
    include_str!("../migrations/004_pictures.sql"),
    include_str!("../migrations/005_settings.sql"),
];

/// Brings a database up to the latest version.
pub fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
    let have: usize = conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))? as usize;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(have) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

fn configure(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;")
}

/// Opens (creating if needed) and migrates a database file.
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut conn = Connection::open(path)?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

/// An in-memory database with the full schema, for tests.
pub fn memory() -> Connection {
    let mut conn = Connection::open_in_memory().expect("in-memory database");
    conn.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
    migrate(&mut conn).expect("migrations apply");
    conn
}

/// The app's one connection, opened lazily. Writes are short transactions; the import's worker batches its rows.
#[derive(Default)]
pub struct Db {
    conn: Mutex<Option<Connection>>,
    path: Mutex<Option<std::path::PathBuf>>,
    /// The thread holding the connection: asking again on the same thread would wait forever.
    owner: Mutex<Option<std::thread::ThreadId>>,
}

impl Db {
    /// Sets where the database lives (the app's data folder); it is opened on first use.
    pub fn set_path(&self, path: std::path::PathBuf) {
        *self.path.lock().unwrap() = Some(path);
    }

    /// For tests: an in-memory database.
    pub fn in_memory() -> Db {
        Db { conn: Mutex::new(Some(memory())), ..Default::default() }
    }

    /// The connection, opened on the first call.
    pub fn conn(&self) -> Result<DbGuard<'_>, String> {
        let me = std::thread::current().id();
        if *self.owner.lock().unwrap() == Some(me) {
            debug_assert!(false, "the library connection was asked for twice on one thread");
            return Err("the library database is busy on this thread".into());
        }
        let mut guard = self.conn.lock().unwrap();
        if guard.is_none() {
            let path = self.path.lock().unwrap().clone().ok_or("the library has no data folder")?;
            *guard = Some(open(&path).map_err(|e| format!("the library database could not be opened: {e}"))?);
        }
        *self.owner.lock().unwrap() = Some(me);
        Ok(DbGuard(guard, &self.owner))
    }
}

pub struct DbGuard<'a>(MutexGuard<'a, Option<Connection>>, &'a Mutex<Option<std::thread::ThreadId>>);

impl Drop for DbGuard<'_> {
    fn drop(&mut self) {
        *self.1.lock().unwrap() = None;
    }
}

impl std::ops::Deref for DbGuard<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.0.as_ref().unwrap()
    }
}

impl std::ops::DerefMut for DbGuard<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        self.0.as_mut().unwrap()
    }
}

/// Seconds since 1970, for the `*_at` columns.
pub fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_migration_replays_on_an_empty_database() {
        let conn = memory();
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version as usize, MIGRATIONS.len());
        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        for t in ["app_settings", "files", "images", "import_items", "import_jobs", "metadata", "overrides", "place_filters", "places", "shows", "skipped", "tracks", "videos"] {
            assert!(tables.iter().any(|x| x == t), "missing table {t}");
        }
    }

    #[test]
    fn asking_twice_on_one_thread_is_an_error_not_a_hang() {
        let db = Db::in_memory();
        let held = db.conn().unwrap();
        let again = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| db.conn().is_err()));
        // A debug build panics (to be found in tests); a release build answers with an error.
        assert!(again.unwrap_or(true));
        drop(held);
        assert!(db.conn().is_ok());
    }

    #[test]
    fn migrating_twice_changes_nothing_and_a_file_survives_a_reopen() {
        let dir = std::env::temp_dir().join(format!("pmp-db-{}", std::process::id()));
        let path = dir.join("library.db");
        {
            let conn = open(&path).unwrap();
            conn.execute("INSERT INTO places(path, created_at) VALUES ('D:\\Films', 1)", []).unwrap();
        }
        let mut conn = open(&path).unwrap();
        migrate(&mut conn).unwrap();
        let n: i64 = conn.query_row("SELECT count(*) FROM places", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        drop(conn);
        std::fs::remove_dir_all(&dir).ok();
    }
}
