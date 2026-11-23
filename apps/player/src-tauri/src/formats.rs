//! The file types the app opens, from `media-extensions.json` (the installer's associations use the same list).

use serde::Deserialize;
use std::path::Path;
use std::sync::OnceLock;

#[derive(Deserialize)]
struct Lists {
    audio: Vec<String>,
    video: Vec<String>,
}

fn lists() -> &'static Lists {
    static LISTS: OnceLock<Lists> = OnceLock::new();
    LISTS.get_or_init(|| serde_json::from_str(include_str!("../media-extensions.json")).expect("media-extensions.json is valid"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MediaKind {
    Audio,
    Video,
}

/// Audio, video, or `None` for a file type the app doesn't play. By extension, any case.
pub fn kind_of(path: &Path) -> Option<MediaKind> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    let l = lists();
    if l.audio.iter().any(|e| *e == ext) {
        Some(MediaKind::Audio)
    } else if l.video.iter().any(|e| *e == ext) {
        Some(MediaKind::Video)
    } else {
        None
    }
}

/// The extensions of one kind, for the open dialog's filters.
pub fn extensions(kind: MediaKind) -> Vec<&'static str> {
    let l = lists();
    let list = if kind == MediaKind::Audio { &l.audio } else { &l.video };
    list.iter().map(String::as_str).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_audio_and_video_in_any_case() {
        assert_eq!(kind_of(Path::new("a/Song.FLAC")), Some(MediaKind::Audio));
        assert_eq!(kind_of(Path::new("Movie.Name.2019.1080p.mkv")), Some(MediaKind::Video));
        assert_eq!(kind_of(Path::new("notes.txt")), None);
        assert_eq!(kind_of(Path::new("no-extension")), None);
    }
}
