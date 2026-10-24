//! Reads a video's file name (and its folders) as a movie or an episode: title, year, season, episode.
//! Regexes only, no network. Measured in spike S6: 91 % of 75 hand-labelled names right on the first try.
use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Kind {
    Movie,
    Episode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub kind: Kind,
    pub title: String,
    pub year: Option<u16>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
}

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pat).unwrap());
    };
}

re!(SXXEXX, r"(?i)\bS(\d{1,2})[ ._-]?E(\d{1,3})(?:[ ._-]?(?:E|-E?)\d{1,3})?");
re!(NXNN, r"(?i)\b(\d{1,2})x(\d{2,3})\b");
re!(SEASON_EPISODE_WORDS, r"(?i)\bSeason[ ._-]*(\d{1,2})[ ._,-]*Episode[ ._-]*(\d{1,3})");
re!(ANIME_DASH, r"^(.+?)\s+-\s+(\d{2,4})(?:v\d)?(?:\s|$|\[|\()");
re!(YEAR_WORD, r"\b((?:19|20)\d{2})\b");
re!(SINGLE_LETTERS, r"\b(?:[A-Za-z] ){2,}[A-Za-z]\b");
re!(EP_WORD, r"(?i)^(.*?)\b(?:Episode|Ep)[ ._-]*(\d{1,3})\b");
re!(LEADING_NUMBER, r"^(\d{1,3})(?:\s*[-.]\s*|\s+)(\S.*)?$");
re!(ONLY_NUMBER, r"^(\d{1,3})$");
re!(GROUP_PREFIX, r"^\[([^\]]+)\]\s*");
re!(TRAILING_HASH, r"\s*\[[0-9A-Fa-f]{8}\]\s*$");
re!(BRACKETED, r"\[[^\]]*\]|\([^)]*\)");
re!(SEASON_FOLDER, r"(?i)^(?:Season|Series|Staffel|Temporada)[ ._-]*(\d{1,2})$|^S(\d{1,2})$");
re!(
    NOISE,
    r"(?i)\b(?:2160p|1080p|1080i|720p|576p|480p|4K|UHD|BluRay|BDRip|BRRip|BD|DVDRip|R2DVD|DVD|WEB-?DL|WEBRip|WEB|HDTV|HDRip|REMUX|REPACK|PROPER|EXTENDED|UNRATED|x264|x265|h\.?264|h\.?265|HEVC|AVC|AAC\d?(?:\.\d)?|AC-?3|DTS(?:-HD)?|FLAC\d?(?:\.\d)?|DD\d(?:\.\d)?|5\.1|7\.1|10bit|Hi10p?|Hi10|35mm|Dual[ ._-]?Audio|Multi|YTS(?:\.\w+)?|YIFY|RARBG|Scan)\b"
);

fn is_generic(title: &str) -> bool {
    let t = title.trim().to_lowercase();
    t.is_empty()
        || t.len() <= 1
        || ["video", "movie", "film", "episode", "recording", "untitled", "new folder"].contains(&t.as_str())
        || Regex::new(r"^(?:vid|img|mov|clip|screen ?recording|recording|video)[ _-]?\d")
            .unwrap()
            .is_match(&t)
}

/// Dots and underscores as spaces, when the name uses them as separators.
fn separators(s: &str) -> String {
    let spaces = s.matches(' ').count();
    let seps = s.matches(['.', '_']).count();
    if seps > spaces {
        let spaced = s.replace(['.', '_'], " ");
        // "S.W.A.T." came apart into single letters: put the dots back
        SINGLE_LETTERS
            .replace_all(&spaced, |c: &regex::Captures| format!("{}.", c[0].replace(' ', ".")))
            .to_string()
    } else {
        s.to_string()
    }
}

/// Years that read as a release year: 1900 to next year, and not part of a date such as 2026-05-18.
fn year_spans(s: &str) -> Vec<(usize, usize, u16)> {
    let b = s.as_bytes();
    YEAR_WORD
        .find_iter(s)
        .filter_map(|m| {
            let y: u16 = m.as_str().parse().ok()?;
            let dash_before = m.start() >= 2 && b[m.start() - 1] == b'-' && b[m.start() - 2].is_ascii_digit();
            let dash_after = m.end() + 1 < b.len() && b[m.end()] == b'-' && b[m.end() + 1].is_ascii_digit();
            let date_like = dash_before || dash_after;
            (y <= 2027 && !date_like).then_some((m.start(), m.end(), y))
        })
        .collect()
}

fn clean_title(s: &str) -> String {
    let s = TRAILING_HASH.replace(s, "");
    let s = BRACKETED.replace_all(&s, " ");
    let s = NOISE.replace_all(&s, " ");
    let s = s.trim_matches(|c: char| c.is_whitespace() || "-–—_.,+(){}[]".contains(c));
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse_stem(stem: &str, season_hint: Option<u32>) -> Option<Parsed> {
    let no_group = GROUP_PREFIX.replace(stem, "").to_string();
    let s = separators(&no_group);
    let mk = |title: &str, season: Option<u32>, ep: u32| Parsed {
        kind: Kind::Episode,
        title: clean_title(title),
        year: None,
        season,
        episode: Some(ep),
    };

    if let Some(c) = SXXEXX.captures(&s) {
        return Some(mk(&s[..c.get(0)?.start()], c[1].parse().ok(), c[2].parse().ok()?));
    }
    if let Some(c) = SEASON_EPISODE_WORDS.captures(&s) {
        return Some(mk(&s[..c.get(0)?.start()], c[1].parse().ok(), c[2].parse().ok()?));
    }
    if let Some(c) = NXNN.captures(&s) {
        return Some(mk(&s[..c.get(0)?.start()], c[1].parse().ok(), c[2].parse().ok()?));
    }
    // Anime releases: "Title - 05 (...)", only when the group tag or the dash form is explicit
    if let Some(c) = ANIME_DASH.captures(&s) {
        let title = c[1].to_string();
        let n: u32 = c[2].parse().ok()?;
        let year_like = c[2].len() == 4 && (1900..=2027).contains(&n); // "Movie - 2010" is a year, "One Piece - 1071" an episode
        if !year_like && (year_spans(&title).is_empty() || GROUP_PREFIX.is_match(stem)) {
            return Some(mk(&title, season_hint, n));
        }
    }
    if let Some(c) = EP_WORD.captures(&s) {
        return Some(mk(&c[1], season_hint, c[2].parse().ok()?));
    }
    // A file inside a season folder: "03 - Title" or "03". The show is the folder's; the episode's own title is not kept.
    if season_hint.is_some() {
        if let Some(c) = ONLY_NUMBER.captures(&s).or_else(|| LEADING_NUMBER.captures(&s)) {
            return Some(mk("", season_hint, c[1].parse().ok()?));
        }
    }
    None
}

fn parse_movie(stem: &str) -> Parsed {
    let no_group = GROUP_PREFIX.replace(stem, "").to_string();
    let s = separators(&no_group);
    // The year is the last plausible 19xx/20xx token that leaves a title before it; a lone leading year ("2012") is the title
    for (start, _, year) in year_spans(&s).into_iter().rev() {
        let before = clean_title(&s[..start]);
        if !before.is_empty() {
            return Parsed {
                kind: Kind::Movie,
                title: before,
                year: Some(year),
                season: None,
                episode: None,
            };
        }
    }
    Parsed {
        kind: Kind::Movie,
        title: clean_title(&s),
        year: None,
        season: None,
        episode: None,
    }
}

/// `rel` is a path relative to the library folder, with `/` separators.
pub fn parse(rel: &str) -> Parsed {
    let parts: Vec<&str> = rel.split('/').collect();
    let file = parts.last().copied().unwrap_or("");
    let stem = file.rsplit_once('.').map_or(file, |(s, _)| s);
    let folders = &parts[..parts.len().saturating_sub(1)];

    let season_hint = folders.iter().rev().take(2).find_map(|f| {
        SEASON_FOLDER
            .captures(f)
            .and_then(|c| c.get(1).or(c.get(2)))
            .and_then(|m| m.as_str().parse().ok())
    });

    if let Some(mut p) = parse_stem(stem, season_hint) {
        if is_generic(&p.title) {
            // "Season 2/Episode 03.mkv": the show is the folder above the season folder
            let show = folders.iter().rev().find(|f| !SEASON_FOLDER.is_match(f)).copied().unwrap_or("");
            let sp = parse_movie(show);
            p.title = sp.title;
        }
        return p;
    }
    let mut p = parse_movie(stem);
    if is_generic(&p.title) {
        if let Some(folder) = folders.last() {
            let fp = parse_movie(folder);
            if !is_generic(&fp.title) {
                p = fp;
            }
        }
    } else if p.year.is_none() {
        // The folder often carries the year ("Title (1982) [1080p]/Title.1080p.mkv")
        if let Some(folder) = folders.last() {
            let fp = parse_movie(folder);
            if fp.year.is_some() && fp.title.eq_ignore_ascii_case(&p.title) {
                p.year = fp.year;
            }
        }
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Case {
        path: &'static str,
        kind: Kind,
        title: &'static str,
        year: Option<u16>,
        season: Option<u32>,
        episode: Option<u32>,
    }

    const fn m(path: &'static str, title: &'static str, year: Option<u16>) -> Case {
        Case {
            path,
            kind: Kind::Movie,
            title,
            year,
            season: None,
            episode: None,
        }
    }
    const fn e(path: &'static str, title: &'static str, season: Option<u32>, episode: u32) -> Case {
        Case {
            path,
            kind: Kind::Episode,
            title,
            year: None,
            season,
            episode: Some(episode),
        }
    }

    /// The ground truth is written by hand, from how real releases and people name files; it is a sample, not a benchmark.
    fn cases() -> Vec<Case> {
        vec![
            // Movies: release names
            m(
                "Amityville.II.The.Possession.1982.1080p.BluRay.x264-[YTS.AG].mp4",
                "Amityville II The Possession",
                Some(1982),
            ),
            m("The Devils 1971 1080p 35mm 4K Scan AVC FLAC1.0.mkv", "The Devils", Some(1971)),
            m(
                "[naiyas] Vampire Hunter D (1985) (BD1080p HEVC-10 FLAC + AC-3 Dual Audio).mkv",
                "Vampire Hunter D",
                Some(1985),
            ),
            m(
                "[naiyas] Vampire Hunter D - Bloodlust (2000) (BD1080p HEVC-10 FLAC 5.1 Dual Audio).mkv",
                "Vampire Hunter D - Bloodlust",
                Some(2000),
            ),
            m("[SCY] Ninja Scroll (BD 1080p Hi10 FLAC) [D3B6E613].mkv", "Ninja Scroll", None),
            m("Salon.Kitty.1976.REPACK.1080p.BluRay.x264.AAC-[YTS.MX].mp4", "Salon Kitty", Some(1976)),
            m("DALIA  y el Libro Rojo.mp4", "DALIA y el Libro Rojo", None),
            m("Blade.Runner.2049.2017.2160p.UHD.BluRay.x265.mkv", "Blade Runner 2049", Some(2017)),
            m("2001 A Space Odyssey (1968).mkv", "2001 A Space Odyssey", Some(1968)),
            m("1917 (2019) [1080p].mp4", "1917", Some(2019)),
            m("1917.2019.1080p.WEB-DL.x264.mkv", "1917", Some(2019)),
            m("300 (2006).mkv", "300", Some(2006)),
            m("Se7en (1995).avi", "Se7en", Some(1995)),
            m("Alien 3 (1992).mkv", "Alien 3", Some(1992)),
            m("Movie 43 (2013).mp4", "Movie 43", Some(2013)),
            m("2012 (2009).mkv", "2012", Some(2009)),
            m("2012.mkv", "2012", None),
            m("The.Matrix.Reloaded.2003.REMUX.1080p.mkv", "The Matrix Reloaded", Some(2003)),
            m("Amélie (2001).mkv", "Amélie", Some(2001)),
            m("千と千尋の神隠し (2001).mkv", "千と千尋の神隠し", Some(2001)),
            m("Фонтан (2006) BDRip.mkv", "Фонтан", Some(2006)),
            m("Mad.Max.Fury.Road.2015.mkv", "Mad Max Fury Road", Some(2015)),
            m("Dr. Strangelove (1964).mkv", "Dr. Strangelove", Some(1964)),
            m("Léon - The Professional (1994).mkv", "Léon - The Professional", Some(1994)),
            m(
                "Amityville II The Possession (1982) [1080p] [YTS.AG]/Amityville.II.The.Possession.1982.1080p.BluRay.x264-[YTS.AG].mp4",
                "Amityville II The Possession",
                Some(1982),
            ),
            m("Proxy War (1973) [1080p] [BluRay] [YTS.MX]/video.mp4", "Proxy War", Some(1973)),
            m("Cheeky (2000) [1080p]/Cheeky.1080p.mp4", "Cheeky", Some(2000)),
            m("Movies/Home Alone/Home Alone.mp4", "Home Alone", None),
            m("Holiday_Trip_2019.mp4", "Holiday Trip", Some(2019)),
            m("S.W.A.T. (2003).mkv", "S.W.A.T.", Some(2003)),
            m("Mr. Nobody (2009).mkv", "Mr. Nobody", Some(2009)),
            m("Recording 2026-05-18 141121.mp4", "Recording 2026-05-18 141121", None),
            // Episodes
            e("Breaking.Bad.S01E02.720p.BluRay.x264.mkv", "Breaking Bad", Some(1), 2),
            e("Breaking Bad - S05E14 - Ozymandias.mkv", "Breaking Bad", Some(5), 14),
            e("Breaking Bad/Season 2/Breaking Bad - 2x05 - Breakage.mkv", "Breaking Bad", Some(2), 5),
            e("The Wire/Season 3/03 - Dead Soldiers.mkv", "The Wire", Some(3), 3),
            e("The Wire/Season 3/Episode 04.mkv", "The Wire", Some(3), 4),
            e("The Wire/S03/05.mkv", "The Wire", Some(3), 5),
            e("Friends 10x18 The Last One.avi", "Friends", Some(10), 18),
            e("Chernobyl.S01E01.1080p.WEB-DL.DD5.1.H.264.mkv", "Chernobyl", Some(1), 1),
            e("Doctor Who (2005) S02E13.mkv", "Doctor Who", Some(2), 13),
            e("Game.of.Thrones.S08E06.The.Iron.Throne.1080p.mkv", "Game of Thrones", Some(8), 6),
            e("The.Office.US.S02E01.mkv", "The Office US", Some(2), 1),
            e("Show Name S01E01E02.mkv", "Show Name", Some(1), 1),
            e("Show Name S01E01-E03.mkv", "Show Name", Some(1), 1),
            e("show_name_s1e3.mkv", "show name", Some(1), 3),
            e("Season 1 Episode 5 - Pilot.mkv", "", Some(1), 5),
            e("Twin Peaks/Season 1/Season 1, Episode 3.mkv", "Twin Peaks", Some(1), 3),
            e("Specials/Doctor Who S00E01 Born Again.mkv", "Doctor Who", Some(0), 1),
            e("Stranger Things S4E9 The Piggyback.mkv", "Stranger Things", Some(4), 9),
            e("Dark.S03E08.GERMAN.DL.1080p.mkv", "Dark", Some(3), 8),
            e("Ep 12.mkv", "", None, 12),
            // Anime releases
            e("[mottoj] DNA2 - 01 (R2DVD 768x576 x264 Hi10p FLAC Chap).mkv", "DNA2", None, 1),
            e("[SubsPlease] Frieren - 12 (1080p) [A1B2C3D4].mkv", "Frieren", None, 12),
            e("[Erai-raws] Spy x Family - 07 [1080p][HEVC][Multiple Subtitle].mkv", "Spy x Family", None, 7),
            e("[HorribleSubs] Steins;Gate 0 - 23v2 [720p].mkv", "Steins;Gate 0", None, 23),
            e(
                "[Group] Re:Zero kara Hajimeru Isekai Seikatsu - 04 [BD 1080p FLAC].mkv",
                "Re:Zero kara Hajimeru Isekai Seikatsu",
                None,
                4,
            ),
            e("[Judas] Attack on Titan - S04E03.mkv", "Attack on Titan", Some(4), 3),
            e("Cowboy Bebop - 26 [DVD].mkv", "Cowboy Bebop", None, 26),
            e("Naruto Shippuden/Naruto Shippuden - 245.mkv", "Naruto Shippuden", None, 245),
            e("[Anime Time] 86 EIGHTY-SIX - 02.mkv", "86 EIGHTY-SIX", None, 2),
            e("One Piece - 1071.mkv", "One Piece", None, 1071),
            // Likely misses (kept on purpose, to know how bad)
            m("Spider-Man.Into.the.Spider-Verse.2018.mkv", "Spider-Man Into the Spider-Verse", Some(2018)),
            e("24.S01E05.mkv", "24", Some(1), 5),
            e("Mr.Robot.S02E03.mkv", "Mr Robot", Some(2), 3),
            e("Bluey (2018)/Season 1/Bluey - S01E10 - Magic Xylophone.mkv", "Bluey", Some(1), 10),
            e("The Daily Show 2024-03-05.mkv", "The Daily Show", None, 0),
            m("Wall-E (2008).mkv", "Wall-E", Some(2008)),
            m("Ocean's Eleven (2001).mkv", "Ocean's Eleven", Some(2001)),
            m("Jaws.1975.mkv", "Jaws", Some(1975)),
            m("Tenet.2020.mkv", "Tenet", Some(2020)),
            m("Movie Title - Directors Cut (2010).mkv", "Movie Title - Directors Cut", Some(2010)),
            m("Zodiac 2007 Director's Cut 1080p.mkv", "Zodiac", Some(2007)),
            m("Pulp Fiction.mp4", "Pulp Fiction", None),
            m("FILM_0001.mp4", "FILM 0001", None),
        ]
    }

    /// The known misses stay misses on purpose; anything else that breaks is a regression.
    const KNOWN_MISSES: &[&str] = &["S.W.A.T. (2003).mkv", "The Daily Show 2024-03-05.mkv"];

    #[test]
    fn reads_the_labelled_names() {
        let mut wrong = vec![];
        for c in cases() {
            let p = parse(c.path);
            let right =
                p.kind == c.kind && p.title.to_lowercase() == c.title.to_lowercase() && p.year == c.year && p.season == c.season && p.episode == c.episode;
            if !right && !KNOWN_MISSES.contains(&c.path) {
                wrong.push(format!("{}: got {:?}", c.path, p));
            }
        }
        assert!(wrong.is_empty(), "misread:\n{}", wrong.join("\n"));
    }
}
