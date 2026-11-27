//! TMDB (The Movie Database) and OMDb, asked the way their documentation says (read 2026-11-27):
//! `api.themoviedb.org/3` with a v3 key as `api_key` or a v4 read token as a Bearer header; pictures from
//! `image.tmdb.org/t/p/<size><path>`; OMDb's `?i=<imdb id>&apikey=` for the IMDb rating.
//!
//! This file only asks and reads answers. Which title a file is, and what is kept of the answer, is `lookup.rs`.
//! TMDB's terms ask for the line "This product uses the TMDB API but is not endorsed or certified by TMDB." and
//! their logo in About (shell/AboutView.tsx).

use crate::online::{Failure, Http};
use serde_json::Value;

pub const POSTER: &str = "w342";
pub const BACKDROP: &str = "w1280";
pub const STILL: &str = "w300";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Movie,
    Show,
}

/// One answer of a search.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub id: u64,
    pub title: String,
    pub original_title: String,
    pub year: Option<u16>,
    pub overview: String,
    pub poster_path: Option<String>,
    pub popularity: f64,
}

/// A film or a series as TMDB describes it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Title {
    pub id: u64,
    pub title: String,
    pub original_title: Option<String>,
    pub year: Option<u16>,
    pub overview: Option<String>,
    pub runtime_min: Option<u32>,
    pub genres: Vec<String>,
    /// TMDB's own score, 0 to 10; nothing when nobody voted.
    pub rating: Option<f64>,
    pub imdb_id: Option<String>,
    pub poster_path: Option<String>,
    pub backdrop_path: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Episode {
    pub number: u32,
    pub name: Option<String>,
    pub overview: Option<String>,
    pub still_path: Option<String>,
    pub runtime_min: Option<u32>,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key)?.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// "1999-03-31" → 1999.
fn year_of(v: &Value, key: &str) -> Option<u16> {
    v.get(key)?.as_str()?.get(..4)?.parse().ok().filter(|y| *y > 1800)
}

fn candidate(v: &Value, kind: Kind) -> Option<Candidate> {
    let (title, original, date) = match kind {
        Kind::Movie => ("title", "original_title", "release_date"),
        Kind::Show => ("name", "original_name", "first_air_date"),
    };
    Some(Candidate {
        id: v.get("id")?.as_u64()?,
        title: text(v, title)?,
        original_title: text(v, original).unwrap_or_default(),
        year: year_of(v, date),
        overview: text(v, "overview").unwrap_or_default(),
        poster_path: text(v, "poster_path"),
        popularity: v.get("popularity").and_then(Value::as_f64).unwrap_or(0.0),
    })
}

fn title_of(v: &Value, kind: Kind) -> Option<Title> {
    let c = candidate(v, kind)?;
    let votes = v.get("vote_count").and_then(Value::as_u64).unwrap_or(0);
    let runtime = match kind {
        Kind::Movie => v.get("runtime").and_then(Value::as_u64),
        // A series gives its episodes' usual lengths
        Kind::Show => v.get("episode_run_time").and_then(Value::as_array).and_then(|a| a.first()).and_then(Value::as_u64),
    };
    Some(Title {
        id: c.id,
        original_title: Some(c.original_title).filter(|o| !o.is_empty() && *o != c.title),
        title: c.title,
        year: c.year,
        overview: Some(c.overview).filter(|o| !o.is_empty()),
        runtime_min: runtime.map(|r| r as u32).filter(|r| *r > 0),
        genres: v.get("genres").and_then(Value::as_array).map(|g| g.iter().filter_map(|x| text(x, "name")).collect()).unwrap_or_default(),
        rating: v.get("vote_average").and_then(Value::as_f64).filter(|r| votes > 0 && *r > 0.0),
        // A film has it on itself; a series under `external_ids` (asked for with `append_to_response`)
        imdb_id: text(v, "imdb_id").or_else(|| v.get("external_ids").and_then(|e| text(e, "imdb_id"))).filter(|id| id.starts_with("tt")),
        poster_path: c.poster_path,
        backdrop_path: text(v, "backdrop_path"),
    })
}

/// Names compared the way file names need: case, accents and punctuation aside, "&" as "and".
pub fn same_name(a: &str, b: &str) -> bool {
    let key = crate::parse::series_key;
    !a.trim().is_empty() && key(a) == key(b)
}

/// The search's answer that a file's name means, or nothing when that isn't plain: its name must be the title (or
/// the original title), and when the file gives a year, the year must be within one of it. Of several, the best known.
pub fn pick<'a>(found: &'a [Candidate], title: &str, year: Option<u16>) -> Option<&'a Candidate> {
    let named: Vec<&Candidate> = found.iter().filter(|c| same_name(&c.title, title) || same_name(&c.original_title, title)).collect();
    let dated: Vec<&Candidate> = match year {
        Some(y) => named.into_iter().filter(|c| c.year.is_some_and(|cy| cy.abs_diff(y) <= 1)).collect(),
        None => named,
    };
    dated.into_iter().max_by(|a, b| a.popularity.total_cmp(&b.popularity))
}

/// TMDB, asked with one key in one language.
pub struct Tmdb<'a> {
    pub http: &'a Http,
    pub base: String,
    pub images: String,
    pub key: String,
    pub language: String,
}

impl<'a> Tmdb<'a> {
    pub fn new(http: &'a Http, key: String, language: String) -> Tmdb<'a> {
        Tmdb {
            http,
            base: crate::online::base("TMDB", "https://api.themoviedb.org/3"),
            images: crate::online::base("TMDB_IMAGES", "https://image.tmdb.org/t/p"),
            key,
            language,
        }
    }

    fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Value, Failure> {
        let url = format!("{}{path}", self.base);
        let mut q: Vec<(&str, &str)> = query.to_vec();
        // A v4 read token is long and has dots (a JWT); a v3 key is 32 letters and digits.
        if self.key.len() > 60 && self.key.contains('.') {
            self.http.json(&url, &q, Some(&self.key))
        } else {
            q.push(("api_key", &self.key));
            self.http.json(&url, &q, None)
        }
    }

    /// Whether the key is accepted.
    pub fn check(&self) -> Result<(), Failure> {
        self.get("/configuration", &[]).map(|_| ())
    }

    pub fn search(&self, kind: Kind, title: &str, year: Option<u16>) -> Result<Vec<Candidate>, Failure> {
        let (path, year_key) = match kind {
            Kind::Movie => ("/search/movie", "year"),
            Kind::Show => ("/search/tv", "first_air_date_year"),
        };
        let year = year.map(|y| y.to_string());
        let mut query = vec![("query", title), ("language", self.language.as_str()), ("include_adult", "false")];
        if let Some(y) = &year {
            query.push((year_key, y));
        }
        let answer = self.get(path, &query)?;
        Ok(answer.get("results").and_then(Value::as_array).map(|r| r.iter().filter_map(|v| candidate(v, kind)).collect()).unwrap_or_default())
    }

    /// The film or series an IMDb id ("tt0133093") belongs to.
    pub fn find_imdb(&self, imdb_id: &str, kind: Kind) -> Result<Option<Candidate>, Failure> {
        let answer = self.get(&format!("/find/{imdb_id}"), &[("external_source", "imdb_id"), ("language", self.language.as_str())])?;
        let list = if kind == Kind::Movie { "movie_results" } else { "tv_results" };
        Ok(answer.get(list).and_then(Value::as_array).and_then(|r| r.first()).and_then(|v| candidate(v, kind)))
    }

    pub fn title(&self, kind: Kind, id: u64) -> Result<Title, Failure> {
        let answer = match kind {
            Kind::Movie => self.get(&format!("/movie/{id}"), &[("language", self.language.as_str())])?,
            Kind::Show => self.get(&format!("/tv/{id}"), &[("language", self.language.as_str()), ("append_to_response", "external_ids")])?,
        };
        title_of(&answer, kind).ok_or(Failure::Other("the answer could not be read".into()))
    }

    /// A season's episodes; a season TMDB doesn't list has none.
    pub fn season(&self, show: u64, season: u32) -> Result<Vec<Episode>, Failure> {
        let answer = match self.get(&format!("/tv/{show}/season/{season}"), &[("language", self.language.as_str())]) {
            Err(Failure::NotFound) => return Ok(vec![]),
            other => other?,
        };
        let episodes = answer.get("episodes").and_then(Value::as_array).cloned().unwrap_or_default();
        Ok(episodes
            .iter()
            .filter_map(|e| {
                Some(Episode {
                    number: e.get("episode_number")?.as_u64()? as u32,
                    name: text(e, "name"),
                    overview: text(e, "overview"),
                    still_path: text(e, "still_path"),
                    runtime_min: e.get("runtime").and_then(Value::as_u64).map(|r| r as u32).filter(|r| *r > 0),
                })
            })
            .collect())
    }

    /// A picture's bytes, at one of TMDB's sizes (`POSTER`, `BACKDROP`, `STILL`).
    pub fn picture(&self, path: &str, size: &str) -> Result<Vec<u8>, Failure> {
        self.http.bytes(&format!("{}/{size}{path}", self.images))
    }
}

/// The IMDb rating of a title, from OMDb; nothing when OMDb has none for it.
pub fn imdb_rating(http: &Http, key: &str, imdb_id: &str) -> Result<Option<f64>, Failure> {
    let base = crate::online::base("OMDB", "https://www.omdbapi.com");
    let answer = http.json(&format!("{base}/"), &[("i", imdb_id), ("apikey", key)], None)?;
    if answer.get("Response").and_then(Value::as_str) == Some("False") {
        // "Invalid API key!" comes as an answer, not as a status
        let why = answer.get("Error").and_then(Value::as_str).unwrap_or_default().to_lowercase();
        return if why.contains("key") { Err(Failure::Unauthorized) } else { Ok(None) };
    }
    Ok(answer.get("imdbRating").and_then(Value::as_str).and_then(|r| r.parse::<f64>().ok()).filter(|r| *r > 0.0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::online::fake::Fake;

    fn tmdb<'a>(http: &'a Http, fake: &Fake, key: &str) -> Tmdb<'a> {
        Tmdb { http, base: fake.url.clone(), images: format!("{}/img", fake.url), key: key.into(), language: "en-US".into() }
    }

    const SEARCH: &str = r#"{"results":[
        {"id":603,"title":"The Matrix","original_title":"The Matrix","release_date":"1999-03-31","overview":"A hacker.","poster_path":"/m.jpg","popularity":90.5},
        {"id":604,"title":"The Matrix Reloaded","original_title":"The Matrix Reloaded","release_date":"2003-05-15","overview":"","poster_path":null,"popularity":60.0},
        {"id":9,"title":"Matrix","original_title":"Matrix","release_date":"1993-01-01","overview":"","popularity":2.0},
        {"id":10,"title":"The Matrix","original_title":"The Matrix","release_date":"2031-01-01","overview":"A remake.","popularity":99.0}]}"#;

    #[test]
    fn a_search_is_asked_and_read_as_documented() {
        let fake = Fake::start(vec![("/search/movie", 200, SEARCH.as_bytes().to_vec())]);
        let http = Http::new();
        let found = tmdb(&http, &fake, "abc123").search(Kind::Movie, "The Matrix", Some(1999)).unwrap();
        assert_eq!(found.len(), 4);
        assert_eq!((found[0].id, found[0].title.as_str(), found[0].year, found[0].poster_path.as_deref()), (603, "The Matrix", Some(1999), Some("/m.jpg")));
        let asked = fake.asked().pop().unwrap();
        for part in ["query=The+Matrix", "year=1999", "language=en-US", "api_key=abc123"] {
            assert!(asked.contains(part) || asked.contains(&part.replace('+', "%20")), "{part} in {asked}");
        }
        // A v4 token goes in a header, and not in the address
        let token = format!("{}.{}.{}", "a".repeat(30), "b".repeat(30), "c".repeat(30));
        tmdb(&http, &fake, &token).search(Kind::Movie, "The Matrix", None).unwrap();
        let asked = fake.asked().pop().unwrap();
        assert!(asked.contains(&format!("Bearer {token}")) && !asked.contains("api_key"), "{asked}");
    }

    #[test]
    fn only_a_plain_match_is_taken() {
        let found: Vec<Candidate> = serde_json::from_str::<Value>(SEARCH).unwrap()["results"].as_array().unwrap().iter().filter_map(|v| candidate(v, Kind::Movie)).collect();
        // The name and the year: the 1999 film, not the better known remake
        assert_eq!(pick(&found, "the matrix", Some(1999)).map(|c| c.id), Some(603));
        // A year off by one still counts (release dates differ by country)
        assert_eq!(pick(&found, "The Matrix", Some(2000)).map(|c| c.id), Some(603));
        // No year in the file's name: the best known of that name
        assert_eq!(pick(&found, "The.Matrix", None).map(|c| c.id), Some(10));
        // A name that is only part of a title is no match; nor is the right name with a year nothing has
        assert_eq!(pick(&found, "Matrix Reloaded", None), None);
        assert_eq!(pick(&found, "The Matrix", Some(1980)), None);
        assert_eq!(pick(&found, "", None), None);
    }

    #[test]
    fn a_film_a_series_and_a_season_are_read() {
        let fake = Fake::start(vec![
            ("/movie/603", 200, br#"{"id":603,"title":"Matrix","original_title":"The Matrix","release_date":"1999-03-31","overview":"A hacker.","runtime":136,
                "genres":[{"id":28,"name":"Action"},{"id":878,"name":"Science Fiction"}],"vote_average":8.2,"vote_count":25000,"imdb_id":"tt0133093","poster_path":"/m.jpg","backdrop_path":"/b.jpg"}"#.to_vec()),
            ("/tv/70523", 200, br#"{"id":70523,"name":"Dark","original_name":"Dark","first_air_date":"2017-12-01","overview":"","episode_run_time":[60],
                "genres":[{"id":80,"name":"Crime"}],"vote_average":0.0,"vote_count":0,"external_ids":{"imdb_id":"tt5753856"},"poster_path":"/d.jpg","backdrop_path":null}"#.to_vec()),
            ("/tv/70523/season/1", 200, br#"{"episodes":[{"episode_number":1,"name":"Secrets","overview":"A boy.","still_path":"/s1.jpg","runtime":51},{"episode_number":2,"name":"","overview":"","still_path":null,"runtime":null}]}"#.to_vec()),
            ("/find/tt0133093", 200, br#"{"movie_results":[{"id":603,"title":"The Matrix","release_date":"1999-03-31"}],"tv_results":[]}"#.to_vec()),
            ("/img/w342/m.jpg", 200, b"JPEG".to_vec()),
            ("/configuration", 401, b"{}".to_vec()),
        ]);
        let http = Http::new();
        let t = tmdb(&http, &fake, "k");
        let film = t.title(Kind::Movie, 603).unwrap();
        assert_eq!((film.title.as_str(), film.original_title.as_deref(), film.year, film.runtime_min), ("Matrix", Some("The Matrix"), Some(1999), Some(136)));
        assert_eq!((film.genres.join(", ").as_str(), film.rating, film.imdb_id.as_deref()), ("Action, Science Fiction", Some(8.2), Some("tt0133093")));
        assert_eq!((film.poster_path.as_deref(), film.backdrop_path.as_deref()), (Some("/m.jpg"), Some("/b.jpg")));
        let show = t.title(Kind::Show, 70523).unwrap();
        assert_eq!((show.title.as_str(), show.year, show.runtime_min, show.rating, show.imdb_id.as_deref()), ("Dark", Some(2017), Some(60), None, Some("tt5753856")));
        assert_eq!((show.original_title, show.overview, show.backdrop_path), (None, None, None));
        assert!(fake.asked().iter().any(|a| a.contains("/tv/70523?") && a.contains("append_to_response=external_ids")));
        let season = t.season(70523, 1).unwrap();
        assert_eq!(season.len(), 2);
        assert_eq!((season[0].number, season[0].name.as_deref(), season[0].still_path.as_deref(), season[0].runtime_min), (1, Some("Secrets"), Some("/s1.jpg"), Some(51)));
        assert_eq!((season[1].name.clone(), season[1].still_path.clone()), (None, None));
        assert_eq!(t.season(70523, 9).unwrap(), vec![], "a season TMDB doesn't list has no episodes");
        assert_eq!(t.find_imdb("tt0133093", Kind::Movie).unwrap().map(|c| c.id), Some(603));
        assert_eq!(t.find_imdb("tt0133093", Kind::Show).unwrap(), None);
        assert_eq!(t.picture("/m.jpg", POSTER).unwrap(), b"JPEG");
        assert_eq!(t.check(), Err(Failure::Unauthorized));
    }

    #[test]
    fn an_imdb_rating_is_read_from_omdb() {
        let fake = Fake::start(vec![
            ("/?i=tt0133093&apikey=k", 200, br#"{"Title":"The Matrix","imdbRating":"8.7","imdbVotes":"2,000,000","Response":"True"}"#.to_vec()),
            ("/?i=tt0000001&apikey=k", 200, br#"{"Response":"False","Error":"Incorrect IMDb ID."}"#.to_vec()),
            ("/?i=tt0000002&apikey=k", 200, br#"{"Title":"New","imdbRating":"N/A","Response":"True"}"#.to_vec()),
            ("/?i=tt0133093&apikey=bad", 200, br#"{"Response":"False","Error":"Invalid API key!"}"#.to_vec()),
        ]);
        std::env::set_var("PASTEL_OMDB_URL", &fake.url);
        let http = Http::new();
        assert_eq!(imdb_rating(&http, "k", "tt0133093"), Ok(Some(8.7)));
        assert_eq!(imdb_rating(&http, "k", "tt0000001"), Ok(None));
        assert_eq!(imdb_rating(&http, "k", "tt0000002"), Ok(None));
        assert_eq!(imdb_rating(&http, "bad", "tt0133093"), Err(Failure::Unauthorized));
        std::env::remove_var("PASTEL_OMDB_URL");
    }
}
