//! Everything that goes online starts here (plan D13): the requests themselves, the keys, and the choices a person
//! made about it. The window never asks the internet for anything (its CSP stays closed); Rust does, and only once
//! a key was typed into Settings and the folder a file is in has not been switched off.
//!
//! A key lives in the system's keychain (Windows Credential Manager), never in the database, a file or a log:
//! errors are made from a status, not from the address that was asked, since a key can ride in an address.

use rusqlite::{params, Connection};
use serde_json::Value;
use std::time::Duration;

/// Why a request gave nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Failure {
    /// 404: the service has no such thing.
    NotFound,
    /// 401 or 403: the key is wrong, or was taken back.
    Unauthorized,
    /// 429 or 503: asked too fast; try later.
    Busy,
    /// No connection, a timeout, an answer that can't be read.
    Other(String),
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::NotFound => write!(f, "not found"),
            Failure::Unauthorized => write!(f, "the key was not accepted"),
            Failure::Busy => write!(f, "the service is busy, try again in a moment"),
            Failure::Other(why) => write!(f, "{why}"),
        }
    }
}

/// The one client every request goes through.
pub struct Http {
    agent: ureq::Agent,
}

impl Default for Http {
    fn default() -> Self {
        Self::new()
    }
}

impl Http {
    pub fn new() -> Http {
        // A generic name and the project's address: MusicBrainz asks for a way to reach the maintainers. Nothing
        // about the person or their computer.
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("PastelMediaPro/", env!("CARGO_PKG_VERSION"), " ( https://github.com/oli-the-hermit/pastel-media-pro )"))
            .build();
        Http { agent }
    }

    fn call(&self, url: &str, query: &[(&str, &str)], bearer: Option<&str>) -> Result<ureq::Response, Failure> {
        let mut request = self.agent.get(url);
        for (k, v) in query {
            request = request.query(k, v);
        }
        if let Some(token) = bearer {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        request.call().map_err(|e| match e {
            ureq::Error::Status(404, _) => Failure::NotFound,
            ureq::Error::Status(401 | 403, _) => Failure::Unauthorized,
            ureq::Error::Status(429 | 503, _) => Failure::Busy,
            ureq::Error::Status(code, _) => Failure::Other(format!("the service answered {code}")),
            // The kind only ("connection failed", "dns failed"): the full text names the address.
            ureq::Error::Transport(t) => Failure::Other(t.kind().to_string()),
        })
    }

    pub fn json(&self, url: &str, query: &[(&str, &str)], bearer: Option<&str>) -> Result<Value, Failure> {
        self.call(url, query, bearer)?.into_json().map_err(|_| Failure::Other("the answer could not be read".into()))
    }

    /// A picture, up to 20 MB.
    pub fn bytes(&self, url: &str) -> Result<Vec<u8>, Failure> {
        use std::io::Read;
        let mut out = vec![];
        self.call(url, &[], None)?.into_reader().take(20 * 1024 * 1024).read_to_end(&mut out).map_err(|_| Failure::Other("the picture could not be read".into()))?;
        Ok(out)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Keys

/// The services a key can be kept for.
pub const SERVICES: [&str; 2] = ["tmdb", "omdb"];
const KEYCHAIN: &str = "Pastel Media Pro";

fn entry(service: &str) -> Result<keyring::Entry, String> {
    if !SERVICES.contains(&service) {
        return Err("no such service".into());
    }
    keyring::Entry::new(KEYCHAIN, service).map_err(|_| "the keychain can't be reached".to_string())
}

/// A service's key from the keychain; nothing when none was saved. A debug build takes one from the environment
/// first (`PASTEL_TMDB_KEY`, `PASTEL_OMDB_KEY`): automated runs never touch the keychain.
pub fn key(service: &str) -> Option<String> {
    if cfg!(debug_assertions) {
        if let Ok(k) = std::env::var(format!("PASTEL_{}_KEY", service.to_uppercase())) {
            return Some(k).filter(|k| !k.is_empty());
        }
    }
    entry(service).ok()?.get_password().ok().filter(|k| !k.is_empty())
}

/// A debug build that takes this service's key from the environment leaves the keychain alone.
fn from_environment(service: &str) -> bool {
    cfg!(debug_assertions) && std::env::var_os(format!("PASTEL_{}_KEY", service.to_uppercase())).is_some()
}

pub fn save_key(service: &str, key: &str) -> Result<(), String> {
    if from_environment(service) {
        return Ok(());
    }
    entry(service)?.set_password(key.trim()).map_err(|_| "the key could not be saved in the keychain".to_string())
}

pub fn forget_key(service: &str) -> Result<(), String> {
    if from_environment(service) {
        return Ok(());
    }
    match entry(service)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("the key could not be removed from the keychain".into()),
    }
}

/// Where a service is asked. A debug build can point each at a stand-in (`PASTEL_TMDB_URL`, `PASTEL_TMDB_IMAGES`,
/// `PASTEL_OMDB_URL`, `PASTEL_MUSICBRAINZ_URL`, `PASTEL_COVERART_URL`), so checks never call the real ones.
pub fn base(name: &str, real: &str) -> String {
    if cfg!(debug_assertions) {
        if let Ok(url) = std::env::var(format!("PASTEL_{name}_URL")) {
            return url.trim_end_matches('/').to_string();
        }
    }
    real.to_string()
}

// ---------------------------------------------------------------------------------------------------------------
// Choices (app_settings)

pub fn setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM app_settings WHERE key = ?1", [key], |r| r.get(0)).ok()
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT OR REPLACE INTO app_settings(key, value) VALUES (?1, ?2)", params![key, value]).map(|_| ())
}

/// The language titles and descriptions are asked in ("en-US" until another is picked).
pub fn language(conn: &Connection) -> String {
    setting(conn, "metadata_language").filter(|l| !l.is_empty()).unwrap_or_else(|| "en-US".into())
}

/// A stand-in for the services, for tests: answers the paths it was given, and remembers what was asked.
#[cfg(test)]
pub mod fake {
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    pub struct Fake {
        pub url: String,
        asked: Arc<Mutex<Vec<String>>>,
    }

    impl Fake {
        /// `routes`: a path (with its query when the route has one) and what it answers. A path with no route is a 404.
        pub fn start(routes: Vec<(&str, u16, Vec<u8>)>) -> Fake {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let routes: HashMap<String, (u16, Vec<u8>)> = routes.into_iter().map(|(p, s, b)| (p.to_string(), (s, b))).collect();
            let asked = Arc::new(Mutex::new(vec![]));
            let log = asked.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut line = String::new();
                    if reader.read_line(&mut line).is_err() {
                        continue;
                    }
                    let mut headers = vec![];
                    loop {
                        let mut h = String::new();
                        if reader.read_line(&mut h).is_err() || h.trim().is_empty() {
                            break;
                        }
                        headers.push(h.trim().to_string());
                    }
                    let target = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                    let path = target.split('?').next().unwrap_or("/").to_string();
                    let auth = headers.iter().find(|h| h.to_lowercase().starts_with("authorization:")).cloned().unwrap_or_default();
                    log.lock().unwrap().push(format!("{target} {auth}").trim().to_string());
                    let (status, body) = routes.get(&target).or_else(|| routes.get(&path)).cloned().unwrap_or((404, b"{}".to_vec()));
                    let mut stream = stream;
                    let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                    let _ = stream.write_all(&body);
                }
            });
            Fake { url, asked }
        }

        pub fn asked(&self) -> Vec<String> {
            self.asked.lock().unwrap().clone()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_never_repeats_the_address_that_was_asked() {
        let fake = fake::Fake::start(vec![("/ok", 200, br#"{"a":1}"#.to_vec()), ("/denied", 401, b"{}".to_vec()), ("/slow", 429, b"{}".to_vec())]);
        let http = Http::new();
        assert_eq!(http.json(&format!("{}/ok", fake.url), &[("api_key", "SECRET")], None).unwrap()["a"], 1);
        assert_eq!(http.json(&format!("{}/denied", fake.url), &[("api_key", "SECRET")], None), Err(Failure::Unauthorized));
        assert_eq!(http.json(&format!("{}/slow", fake.url), &[], None), Err(Failure::Busy));
        assert_eq!(http.json(&format!("{}/nothing", fake.url), &[], None), Err(Failure::NotFound));
        // Nothing listens there
        let gone = http.json("http://127.0.0.1:1/x", &[("api_key", "SECRET")], None).unwrap_err();
        assert!(!gone.to_string().contains("SECRET") && !gone.to_string().contains("127.0.0.1"), "{gone}");
        // A token rides in a header, not in the address
        http.json(&format!("{}/ok", fake.url), &[], Some("TOKEN")).unwrap();
        assert!(fake.asked().last().unwrap().contains("Bearer TOKEN"));
    }

    #[test]
    fn the_language_is_english_until_another_is_picked() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::db::migrate(&mut conn).unwrap();
        assert_eq!(language(&conn), "en-US");
        set_setting(&conn, "metadata_language", "es-ES").unwrap();
        assert_eq!(language(&conn), "es-ES");
    }
}
