//! The import filters (ux.md §2b): what a library place keeps. The review list applies them live in the webview
//! (`src/media/import/filters.ts`); a rescan applies the saved ones here. Both pass the cases in
//! `src/media/import/filter-cases.json`. A value the quick probe couldn't read always passes.

use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Filters {
    /// movies, music, everything or custom.
    pub preset: String,
    /// "audio", "video"; `None` for both.
    pub kinds: Option<Vec<String>>,
    /// Seconds.
    pub min_duration: Option<f64>,
    pub max_duration: Option<f64>,
    pub min_bytes: Option<u64>,
    pub max_bytes: Option<u64>,
    /// Lines of picture (720, 1080, 2160); a wide film's cropped height counts by its width.
    pub min_height: Option<u32>,
    /// Lower case, without the dot; `None` for all.
    pub extensions: Option<Vec<String>>,
    /// Leave out samples, trailers and extras.
    pub skip_extras: bool,
}

impl Filters {
    pub fn everything() -> Filters {
        Filters { preset: "everything".into(), ..Default::default() }
    }
}

/// What the filters look at in one file.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub kind: String,
    pub ext: String,
    pub size: u64,
    pub duration: Option<f64>,
    pub height: Option<u32>,
    #[serde(default)]
    pub width: Option<u32>,
    /// The path below the place, with `/`.
    pub rel: String,
}

/// Folder names that hold a film's or a show's extras (Plex's and Kodi's names, less "Other", "Scenes" and "Shorts",
/// which people also use for their own films).
const EXTRA_FOLDERS: &[&str] = &[
    "extras", "extra", "featurettes", "featurette", "sample", "samples", "trailers", "trailer", "behind the scenes",
    "deleted scenes", "interviews", "bonus",
];

fn extra_name() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    // A file named for what it is ("trailer.mp4"), or ending in it ("heat-sample.mkv"), or a release's sample
    // ("sample-heat.mkv"). A title that merely contains the word ("Free Sample Day") is a film.
    RE.get_or_init(|| {
        let words = "sample|trailer|teaser|featurette|behindthescenes|deleted|interview|extra|bonus|promo";
        Regex::new(&format!(r"(?i)^(?:{words})$|[-._ ](?:{words})$|^sample[-._ ]")).unwrap()
    })
}

/// Whether a file is a sample, a trailer or another extra, by its name or its folder.
pub fn is_extra(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').collect();
    let (folders, file) = parts.split_at(parts.len().saturating_sub(1));
    if folders.iter().any(|f| EXTRA_FOLDERS.contains(&f.to_lowercase().trim())) {
        return true;
    }
    let stem = file.first().map(|f| f.rsplit_once('.').map(|(s, _)| s).unwrap_or(f)).unwrap_or("");
    extra_name().is_match(stem)
}

/// The picture's lines as people name them: a 1920×800 scope film is "1080p".
fn lines(c: &Candidate) -> Option<u32> {
    let h = c.height?;
    Some(c.width.map(|w| h.max(w * 9 / 16)).unwrap_or(h))
}

/// Whether a file is kept.
pub fn passes(f: &Filters, c: &Candidate) -> bool {
    if let Some(kinds) = &f.kinds {
        if !kinds.iter().any(|k| *k == c.kind) {
            return false;
        }
    }
    if let Some(exts) = &f.extensions {
        if !exts.iter().any(|e| e.eq_ignore_ascii_case(&c.ext)) {
            return false;
        }
    }
    if f.min_bytes.is_some_and(|m| c.size < m) || f.max_bytes.is_some_and(|m| c.size > m) {
        return false;
    }
    if let Some(d) = c.duration {
        if f.min_duration.is_some_and(|m| d < m) || f.max_duration.is_some_and(|m| d > m) {
            return false;
        }
    }
    if c.kind == "video" {
        if let (Some(min), Some(l)) = (f.min_height, lines(c)) {
            if l < min {
                return false;
            }
        }
    }
    !(f.skip_extras && is_extra(&c.rel))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn cases() -> Value {
        serde_json::from_str(include_str!("../../src/media/import/filter-cases.json")).unwrap()
    }

    #[test]
    fn extras_are_known_by_name_and_folder() {
        for c in cases()["extras"].as_array().unwrap() {
            let rel = c["rel"].as_str().unwrap();
            assert_eq!(is_extra(rel), c["extra"].as_bool().unwrap(), "{rel}");
        }
    }

    #[test]
    fn the_shared_cases_pass_as_in_the_review_list() {
        let all = cases();
        for c in all["cases"].as_array().unwrap() {
            let f: Filters = match c.get("preset") {
                Some(p) => serde_json::from_value(all["presets"][p.as_str().unwrap()].clone()).unwrap(),
                None => serde_json::from_value(c["filters"].clone()).unwrap(),
            };
            let file: Candidate = serde_json::from_value(c["file"].clone()).unwrap();
            assert_eq!(passes(&f, &file), c["passes"].as_bool().unwrap(), "{}", c["name"]);
        }
    }
}
