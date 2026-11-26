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
    /// An episode's own title, when the name gives one ("Show - S01E02 - Title").
    pub episode_title: Option<String>,
}

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($pat).unwrap());
    };
}

re!(SXXEXX, r"(?i)\bS(\d{1,2})[ ._-]?E(\d{1,3})(?:[ ._-]?(?:E|-E?)\d{1,3})?");
re!(NXNN, r"(?i)\b(\d{1,2})x(\d{2,3})\b");
re!(SEASON_EPISODE_WORDS, r"(?i)\b(?:Season|Temporada)[ ._-]*(\d{1,2})[ ._,-]*(?:Episode|Episodio|Cap[ií]tulo|Cap)[ ._-]*(\d{1,3})");
re!(ANIME_DASH, r"^(.+?)\s+-\s+(\d{2,4})(?:v\d)?(?:\s|$|\[|\()");
re!(YEAR_WORD, r"\b((?:19|20)\d{2})\b");
re!(SINGLE_LETTERS, r"\b(?:[A-Za-z] ){2,}[A-Za-z]\b");
re!(EP_WORD, r"(?i)^(.*?)\b(?:Episode|Episodio|Ep|Cap[ií]tulo|Cap)[ ._-]*(\d{1,3})\b");
re!(LEADING_NUMBER, r"^(\d{1,3})(?:\s*[-.]\s*|\s+)(\S.*)?$");
re!(ONLY_NUMBER, r"^(\d{1,3})$");
re!(GROUP_PREFIX, r"^\[([^\]]+)\]\s*");
re!(TRAILING_HASH, r"\s*\[[0-9A-Fa-f]{8}\]\s*$");
re!(BRACKETED, r"\[[^\]]*\]|\([^)]*\)");
re!(SEASON_FOLDER, r"(?i)^(?:Season|Series|Staffel|Temporada|Saison|Stagione|Temp\.?)[ ._-]*(\d{1,2})\b|^[ST](\d{1,2})$");
// A season's folder that also names its show: "Show S01", "Show - Season 2", "Show.S01.1080p.BluRay" (not "Show.S01E02…")
re!(SEASON_SUFFIX, r"(?i)^(.+?)[ ._-]+(?:S(\d{1,2})|(?:Season|Staffel|Temporada|Saison|Stagione)[ ._-]*(\d{1,2}))(?:$|[ ._\-\[(].*$)");
re!(SPECIALS_FOLDER, r"(?i)^(?:Specials?|Especiales|OVAs?|OADs?)$");
// "Show E05", and inside a season folder or beside other episodes "Show 05"
re!(E_NUMBER, r"(?i)^(.*?)[ ._-]+E(\d{2,3})\b");
re!(TRAILING_NUMBER, r"^(.*\D)[ ._-]+(\d{1,3})$");
// "Show OVA - 01", "Show Special 2", "Show SP1": a special, numbered apart from the show's episodes
re!(SPECIAL_NUMBER, r"(?i)^(.*?)[ ._-]+(?:OVA|OAD|Specials?|SP)[ ._-]*(\d{1,3})(?:v\d)?\b");
re!(SPECIAL_NAME, r"(?i)^(.+?)[ ._-]+(?:OVAs?|OADs?|Specials?)$");
re!(PAREN_YEAR, r"\(\s*(?:19|20)\d{2}\s*\)");
re!(GENERIC_NUMBERED, r"^(?:vid|img|mov|clip|screen ?recording|recording|video)[ _-]?\d");
// Words in release names after an episode number that are not its title: languages and streaming sources.
re!(RELEASE_WORDS, r"(?i)\b(?:GERMAN|FRENCH|SPANISH|ITALIAN|LATINO|CASTELLANO|ESP|ENG|VOSE|SUBBED|DUBBED|DL|NF|AMZN|HMAX|DSNP|ATVP|iNTERNAL)\b");
re!(TRAILING_SEASON, r"(?i)\s+(?:season|series|temporada|staffel|saison|stagione)\s*\d{1,2}$|\s+s\d{1,2}$|\s+\d(?:st|nd|rd|th)\s+season$|\s+part\s+\d{1,2}$|\s+(?:ii|iii|iv|vi|vii|viii)$|\s+(?:ovas?|oads?|specials?)$");
re!(
    NOISE,
    r"(?i)\b(?:2160p|1080p|1080i|720p|576p|480p|4K|UHD|BluRay|BDRip|BRRip|BD|DVDRip|R2DVD|DVD|WEB-?DL|WEBRip|WEB|HDTV|HDRip|REMUX|REPACK|PROPER|EXTENDED|UNRATED|x264|x265|h\.?264|h\.?265|HEVC|AVC|AAC\d?(?:\.\d)?|AC-?3|DTS(?:-HD)?|FLAC\d?(?:\.\d)?|DD\d(?:\.\d)?|5\.1|7\.1|10bit|Hi10p?|Hi10|35mm|Dual[ ._-]?Audio|Multi|YTS(?:\.\w+)?|YIFY|RARBG|Scan)\b"
);

fn is_generic(title: &str) -> bool {
    let t = title.trim().to_lowercase();
    t.is_empty()
        || t.len() <= 1
        || ["video", "movie", "film", "episode", "recording", "untitled", "new folder"].contains(&t.as_str())
        || GENERIC_NUMBERED.is_match(&t)
}

/// A folder that holds one season: its number, and the show's name when the folder carries it too
/// ("Season 2", "Temporada 1", "S03", "T1", "Specials"; "Show S01", "Show.S02.1080p.BluRay").
pub fn season_of(folder: &str) -> Option<(u32, Option<String>)> {
    if let Some(n) = SEASON_FOLDER.captures(folder).and_then(|c| c.get(1).or(c.get(2))).and_then(|m| m.as_str().parse().ok()) {
        return Some((n, None));
    }
    if SPECIALS_FOLDER.is_match(folder.trim()) {
        return Some((0, None));
    }
    let c = SEASON_SUFFIX.captures(folder)?;
    let n = c.get(2).or(c.get(3))?.as_str().parse().ok()?;
    let show = parse_movie(&c[1]).title;
    (!is_generic(&show)).then_some((n, Some(show)))
}

/// The show a special belongs to, when a title ends in the word for one: "DNA2 OVA" is a special of "DNA2".
pub fn special_of(title: &str) -> Option<String> {
    let base = clean_title(&SPECIAL_NAME.captures(title.trim())?[1]);
    (!is_generic(&base)).then_some(base)
}

/// A folder's name read as a title: "Mr. Robot (2015) [1080p]" is "Mr. Robot".
pub fn folder_title(folder: &str) -> String {
    parse_movie(folder).title
}

/// A title that ends in a running number, as a show's files named without season marks do ("Show 03"):
/// what comes before it, the number, and whether it is written with two digits or more.
pub fn numbered(title: &str) -> Option<(String, u32, bool)> {
    let c = TRAILING_NUMBER.captures(title.trim())?;
    let base = clean_title(&c[1]);
    (!is_generic(&base)).then_some((base, c[2].parse().ok()?, c[2].len() >= 2))
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

/// The text after an episode number, up to the first release word: the episode's own title, if any.
fn episode_title(rest: &str) -> Option<String> {
    let cut = [NOISE.find(rest), RELEASE_WORDS.find(rest), TRAILING_HASH.find(rest)].into_iter().flatten().map(|m| m.start()).min().unwrap_or(rest.len());
    let t = clean_title(&rest[..cut]);
    (!t.is_empty() && !t.chars().all(|c| c.is_ascii_digit())).then_some(t)
}

fn parse_stem(stem: &str, season_hint: Option<u32>) -> Option<Parsed> {
    let no_group = GROUP_PREFIX.replace(stem, "").to_string();
    let s = separators(&no_group);
    let mk = |title: &str, season: Option<u32>, ep: u32, rest: &str| Parsed {
        kind: Kind::Episode,
        title: clean_title(title),
        year: None,
        season,
        episode: Some(ep),
        episode_title: episode_title(rest),
    };

    if let Some(c) = SXXEXX.captures(&s) {
        let m = c.get(0)?;
        return Some(mk(&s[..m.start()], c[1].parse().ok(), c[2].parse().ok()?, &s[m.end()..]));
    }
    if let Some(c) = SEASON_EPISODE_WORDS.captures(&s) {
        let m = c.get(0)?;
        return Some(mk(&s[..m.start()], c[1].parse().ok(), c[2].parse().ok()?, &s[m.end()..]));
    }
    if let Some(c) = NXNN.captures(&s) {
        let m = c.get(0)?;
        return Some(mk(&s[..m.start()], c[1].parse().ok(), c[2].parse().ok()?, &s[m.end()..]));
    }
    // A special: season 0 of the show, which the pages call "Specials"
    if let Some(c) = SPECIAL_NUMBER.captures(&s) {
        if !clean_title(&c[1]).is_empty() {
            return Some(mk(&c[1], Some(0), c[2].parse().ok()?, &s[c.get(0)?.end()..]));
        }
    }
    // Anime releases: "Title - 05 (...)", only when the group tag or the dash form is explicit
    if let Some(c) = ANIME_DASH.captures(&s) {
        let title = c[1].to_string();
        let n: u32 = c[2].parse().ok()?;
        let year_like = c[2].len() == 4 && (1900..=2027).contains(&n); // "Movie - 2010" is a year, "One Piece - 1071" an episode
        // A year in brackets is the show's own ("Show (2015) - 05"); a bare one makes it a film's name
        if !year_like && (year_spans(&PAREN_YEAR.replace_all(&title, " ")).is_empty() || GROUP_PREFIX.is_match(stem)) {
            return Some(mk(&title, season_hint, n, ""));
        }
    }
    if let Some(c) = EP_WORD.captures(&s) {
        return Some(mk(&c[1], season_hint, c[2].parse().ok()?, &s[c.get(0)?.end()..]));
    }
    if let Some(c) = E_NUMBER.captures(&s) {
        return Some(mk(&c[1], season_hint, c[2].parse().ok()?, &s[c.get(0)?.end()..]));
    }
    // A file inside a season folder: "03 - Title" or "03". The show is the folder's; the episode's own title is not kept.
    if season_hint.is_some() {
        if let Some(c) = ONLY_NUMBER.captures(&s).or_else(|| LEADING_NUMBER.captures(&s)) {
            return Some(mk("", season_hint, c[1].parse().ok()?, c.get(2).map_or("", |m| m.as_str())));
        }
        // "Show 05", "Show.105": the number at the end, with the season in front of it when it has three digits
        let cleaned = clean_title(&s);
        if let Some(c) = TRAILING_NUMBER.captures(&cleaned) {
            let n: u32 = c[2].parse().ok()?;
            let ep = if c[2].len() == 3 && season_hint == Some(n / 100) { n % 100 } else { n };
            return Some(mk(&c[1], season_hint, ep, ""));
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
                episode_title: None,
            };
        }
    }
    Parsed {
        kind: Kind::Movie,
        title: clean_title(&s),
        year: None,
        season: None,
        episode: None,
        episode_title: None,
    }
}

/// `rel` is a path relative to the library folder, with `/` separators.
pub fn parse(rel: &str) -> Parsed {
    let parts: Vec<&str> = rel.split('/').collect();
    let file = parts.last().copied().unwrap_or("");
    let stem = file.rsplit_once('.').map_or(file, |(s, _)| s);
    let folders = &parts[..parts.len().saturating_sub(1)];

    let season_hint = folders.iter().rev().take(2).find_map(|f| season_of(f)).map(|(n, _)| n);
    // The show, from the folders: the one above the season folder, or the season folder's own name when it
    // carries the show ("Show S02/03.mkv")
    let show_from_folders = || {
        folders
            .iter()
            .rev()
            .find_map(|f| match season_of(f) {
                Some((_, None)) => None,
                Some((_, Some(show))) => Some(show),
                None => Some(parse_movie(f).title),
            })
            .unwrap_or_default()
    };

    if let Some(mut p) = parse_stem(stem, season_hint) {
        if is_generic(&p.title) {
            // "Season 2/Episode 03.mkv": the show is the folder's
            p.title = show_from_folders();
        }
        return p;
    }
    // Inside a season's folder, a file with no number is still the show's: a special, an extra ("Specials/Making of.mkv")
    if let Some(season) = season_hint {
        let own = parse_movie(stem).title;
        return Parsed {
            kind: Kind::Episode,
            title: show_from_folders(),
            year: None,
            season: Some(season),
            episode: None,
            episode_title: (!own.is_empty()).then_some(own),
        };
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

/// The show an episode belongs to, from its folders: the folder above its season folder ("Show/Season 1/…").
pub fn show_folder(rel: &str) -> Option<String> {
    show_folder_in(rel, None)
}

/// The same, knowing the library folder's own name: a show added as a library folder has its seasons at the top
/// ("Season 1/…" inside "…/Dark"), and is named by that folder. A season folder that names its show ("Dark S01")
/// needs no folder above it.
pub fn show_folder_in(rel: &str, library_folder: Option<&str>) -> Option<String> {
    let parts: Vec<&str> = rel.split('/').collect();
    let folders = &parts[..parts.len().saturating_sub(1)];
    let i = folders.iter().rposition(|f| season_of(f).is_some())?;
    if let Some((_, Some(show))) = season_of(folders[i]) {
        return Some(show);
    }
    let above = match i.checked_sub(1) {
        Some(j) => folders[j],
        None => library_folder?,
    };
    // Seasons inside seasons' folders ("Show S01-S03/Season 1"): the outer one names the show
    let show = season_of(above).and_then(|(_, s)| s).unwrap_or_else(|| parse_movie(above).title);
    (!is_generic(&show)).then_some(show)
}

/// What episodes of one show have in common however their files are named: lower case, letters and digits only,
/// without a trailing year or season ("Mr.Robot", "Mr. Robot (2015)" and "Mr Robot Season 2" are one show).
pub fn series_key(title: &str) -> String {
    let unaccented = |c: char| match c {
        'á' | 'à' | 'ä' | 'â' | 'ã' | 'å' => 'a',
        'é' | 'è' | 'ë' | 'ê' => 'e',
        'í' | 'ì' | 'ï' | 'î' => 'i',
        'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o',
        'ú' | 'ù' | 'ü' | 'û' => 'u',
        'ñ' => 'n',
        'ç' => 'c',
        c => c,
    };
    // "Pokémon" and "Pokemon", "Law & Order" and "Law and Order" are one show
    let t: String = title.to_lowercase().replace('&', " and ").chars().map(unaccented).map(|c| if c.is_alphanumeric() { c } else { ' ' }).collect();
    let is_year = |w: &str| w.len() == 4 && (w.starts_with("19") || w.starts_with("20")) && w.chars().all(|c| c.is_ascii_digit());
    let words: Vec<&str> = t.split_whitespace().collect();
    // A year is not part of the name, wherever it stands, unless it is all there is ("1923")
    let named: Vec<&str> = words.iter().copied().filter(|w| !is_year(w)).collect();
    let mut t = if named.is_empty() { words.join(" ") } else { named.join(" ") };
    // "Show Season 2", "Show S02", "Show 2nd Season", "Show Part 2", "Show II": the show without its season
    for _ in 0..2 {
        let cut = TRAILING_SEASON.replace(&t, "").to_string();
        if cut.is_empty() || cut == t {
            break;
        }
        t = cut;
    }
    t
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
            // Spanish names
            e("La Casa de Papel/Temporada 1/Capitulo 3.mkv", "La Casa de Papel", Some(1), 3),
            e("El Ministerio del Tiempo Temporada 2 Capítulo 5.mkv", "El Ministerio del Tiempo", Some(2), 5),
            e("Los Simpson - Cap 12.mkv", "Los Simpson", None, 12),
            e("Breaking Bad/Temporada 2 [1080p]/02 - Grilled.mkv", "Breaking Bad", Some(2), 2),
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

    #[test]
    fn keeps_an_episode_s_own_title_but_not_release_words() {
        let t = |p: &str| parse(p).episode_title;
        assert_eq!(t("Breaking Bad - S05E14 - Ozymandias.mkv").as_deref(), Some("Ozymandias"));
        assert_eq!(t("Game.of.Thrones.S08E06.The.Iron.Throne.1080p.mkv").as_deref(), Some("The Iron Throne"));
        assert_eq!(t("The Wire/Season 3/03 - Dead Soldiers.mkv").as_deref(), Some("Dead Soldiers"));
        assert_eq!(t("Friends 10x18 The Last One.avi").as_deref(), Some("The Last One"));
        assert_eq!(t("Breaking.Bad.S01E02.720p.BluRay.x264-DEMAND.mkv"), None);
        assert_eq!(t("Dark.S03E08.GERMAN.DL.1080p.mkv"), None);
        assert_eq!(t("[SubsPlease] Frieren - 12 (1080p) [A1B2C3D4].mkv"), None);
        assert_eq!(t("Pulp Fiction.mp4"), None);
    }

    #[test]
    fn one_show_however_its_files_are_named() {
        let k = |p: &str| series_key(&show_folder(p).unwrap_or_else(|| parse(p).title));
        let shows = [
            "Mr.Robot.S02E03.mkv",
            "Mr. Robot - S01E01 - Pilot.mkv",
            "Mr Robot (2015) S03E01.mkv",
            "Mr.Robot.2015.S04E02.1080p.mkv",
            "Mr Robot Season 2 S02E05.mkv",
            "Mr. Robot/Season 1/01.mkv",
            "Mr Robot (2015)/Temporada 3/Capitulo 2.mkv",
        ];
        for p in shows {
            assert_eq!(k(p), "mr robot", "{p}");
        }
        assert_ne!(k("Doctor Who S01E01.mkv"), k("Doctor Foster S01E01.mkv"));
        assert_eq!(show_folder("Breaking.Bad.S01E01.mkv"), None);
        assert_eq!(show_folder("Series/Lost/Season 2/Lost.S02E01.mkv").as_deref(), Some("Lost"));
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

    #[test]
    fn knows_a_season_s_folder_however_it_is_named() {
        let plain = |f: &str, n: u32| assert_eq!(season_of(f), Some((n, None)), "{f}");
        plain("Season 2", 2);
        plain("Temporada 1", 1);
        plain("Saison 4", 4);
        plain("Temp. 3", 3);
        plain("S03", 3);
        plain("T1", 1);
        plain("Specials", 0);
        let named = |f: &str, show: &str, n: u32| assert_eq!(season_of(f), Some((n, Some(show.to_string()))), "{f}");
        named("Mr Robot S02", "Mr Robot", 2);
        named("Dark.S01.1080p.BluRay.x264-GROUP", "Dark", 1);
        named("The Wire - Season 3", "The Wire", 3);
        named("La Casa de Papel Temporada 2 (2018)", "La Casa de Papel", 2);
        for f in ["Dark.S01E02.1080p.WEB", "Films", "Stargate SG-1", "Top 10", "The Series"] {
            assert_eq!(season_of(f), None, "{f}");
        }
    }

    #[test]
    fn names_the_show_from_a_season_folder_that_carries_it_or_from_the_library_folder() {
        assert_eq!(show_folder("Dark S01/Dark.S01E01.mkv").as_deref(), Some("Dark"));
        assert_eq!(show_folder("Series/Mr.Robot.S02.1080p.BluRay/Mr.Robot.S02E01.mkv").as_deref(), Some("Mr Robot"));
        // The show's own folder was added to the library: its seasons are at the top
        assert_eq!(show_folder("Season 1/01.mkv"), None);
        assert_eq!(show_folder_in("Season 1/01.mkv", Some("Dark")).as_deref(), Some("Dark"));
        assert_eq!(show_folder_in("Specials/Behind the scenes.mkv", Some("Dark (2017)")).as_deref(), Some("Dark"));
        assert_eq!(show_folder_in("Heat (1995).mkv", Some("Films")), None);
    }

    #[test]
    fn reads_episodes_named_without_season_marks() {
        let got = |p: &str| {
            let x = parse(p);
            (x.kind, x.title, x.season, x.episode)
        };
        let ep = |title: &str, season: Option<u32>, n: u32| (Kind::Episode, title.to_string(), season, Some(n));
        assert_eq!(got("Dark S02/03 - Ghosts.mkv"), ep("Dark", Some(2), 3));
        assert_eq!(got("Frieren/Season 1/Frieren 05.mkv"), ep("Frieren", Some(1), 5));
        assert_eq!(got("Frieren/Season 1/Frieren.105.1080p.mkv"), ep("Frieren", Some(1), 5));
        assert_eq!(got("Frieren E05.mkv"), ep("Frieren", None, 5));
        assert_eq!(got("Mr Robot (2015) - 05.mkv"), ep("Mr Robot", None, 5));
        // Not episodes: a number that is the film's name, with nothing around to say otherwise
        for film in ["Apollo 13.mkv", "District 9 (2009).mkv", "Ocean's 11.mkv", "Blade Runner 2049.mkv"] {
            assert_eq!(parse(film).kind, Kind::Movie, "{film}");
        }
    }

    #[test]
    fn one_show_whatever_its_accents_years_and_season_words() {
        let same = |a: &str, b: &str| assert_eq!(series_key(a), series_key(b), "{a} / {b}");
        same("Pokémon", "Pokemon");
        same("Law & Order", "Law and Order");
        same("Mr Robot 2015", "Mr. Robot");
        same("Mr Robot (2015) Season 2", "Mr Robot");
        same("Overlord II", "Overlord");
        same("Mob Psycho 100 2nd Season", "Mob Psycho 100");
        same("Attack on Titan Part 2", "Attack on Titan");
        assert_eq!(series_key("1923"), "1923");
        assert_ne!(series_key("Doctor Who"), series_key("Doctor Foster"));
    }

    #[test]
    fn a_special_is_season_zero_of_its_show() {
        let got = |p: &str| {
            let x = parse(p);
            (x.kind, x.title, x.season, x.episode)
        };
        let ep = |title: &str, season: Option<u32>, n: u32| (Kind::Episode, title.to_string(), season, Some(n));
        assert_eq!(got("[motto] DNA2 - 01 (R2DVD 768x576 x264 Hi10p FLAC Chap).mkv"), ep("DNA2", None, 1));
        assert_eq!(got("[motto] DNA2 OVA - 01 (R2DVD 768x576 x264 Hi10p FLAC Chap).mkv"), ep("DNA2", Some(0), 1));
        assert_eq!(got("Frieren Special 2.mkv"), ep("Frieren", Some(0), 2));
        assert_eq!(got("Show.SP1.1080p.mkv"), ep("Show", Some(0), 1));
        assert_eq!(series_key("DNA2 OVA"), series_key("DNA2"));
        assert_eq!(special_of("DNA2 OVA").as_deref(), Some("DNA2"));
        assert_eq!(special_of("Nova"), None);
        // Not specials: the letters inside a word
        assert_eq!(parse("Casanova 2005.mkv").kind, Kind::Movie);
    }
}
