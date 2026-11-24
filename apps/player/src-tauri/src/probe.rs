//! The quick probe (spike S8): a video's length and picture size read from its container's headers, without
//! decoding and without a helper program. MP4/MOV/M4V/3GP (ISO-BMFF `moov`, wherever it sits in the file),
//! Matroska/WebM (`Info` and `Tracks` before the first cluster) and AVI (`avih`). Other containers, and files whose
//! headers say nothing, return `None`; the import fills them in later from the engine. A handful of small reads per
//! file, skipping media data with seeks: it never reads a film's body.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Default, serde::Serialize)]
pub struct Probe {
    /// Seconds; `None` when the header doesn't give it.
    pub duration: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

impl Probe {
    fn is_empty(&self) -> bool {
        self.duration.is_none() && self.width.is_none()
    }
}

/// The header facts of a video file, or `None` for a container it doesn't read (or a broken file).
pub fn probe(path: &Path) -> Option<Probe> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    let file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let mut r = BufReader::with_capacity(16 * 1024, file);
    let p = match ext.as_str() {
        "mp4" | "m4v" | "mov" | "3gp" => isobmff(&mut r, len),
        "mkv" | "webm" => matroska(&mut r, len),
        "avi" => avi(&mut r),
        _ => None,
    }?;
    (!p.is_empty()).then_some(p)
}

fn read_n<R: Read>(r: &mut R, n: usize) -> Option<Vec<u8>> {
    let mut b = vec![0; n];
    r.read_exact(&mut b).ok()?;
    Some(b)
}

fn be(b: &[u8]) -> u64 {
    b.iter().fold(0, |a, &x| (a << 8) | x as u64)
}

fn le32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

// ---- ISO-BMFF (MP4, MOV) ----

/// A box header at the reader's position: (type, size of the body, header length).
fn box_header<R: Read>(r: &mut R, remaining: u64) -> Option<([u8; 4], u64)> {
    let h = read_n(r, 8)?;
    let mut size = be(&h[0..4]);
    let kind = [h[4], h[5], h[6], h[7]];
    let mut header = 8;
    if size == 1 {
        size = be(&read_n(r, 8)?);
        header = 16;
    } else if size == 0 {
        size = remaining;
    }
    if size < header || size > remaining {
        return None;
    }
    Some((kind, size - header))
}

fn isobmff<R: Read + Seek>(r: &mut R, len: u64) -> Option<Probe> {
    let mut pos = 0;
    // Top level: skip `ftyp`, `mdat`, `free`… with seeks until `moov` (at the start or at the end of the file).
    while pos + 8 <= len {
        r.seek(SeekFrom::Start(pos)).ok()?;
        let (kind, body) = box_header(r, len - pos)?;
        let start = r.stream_position().ok()?;
        if &kind == b"moov" {
            return moov(r, start, body);
        }
        pos = start + body;
    }
    None
}

fn moov<R: Read + Seek>(r: &mut R, start: u64, body: u64) -> Option<Probe> {
    let mut p = Probe::default();
    let end = start + body;
    let mut pos = start;
    while pos + 8 <= end {
        r.seek(SeekFrom::Start(pos)).ok()?;
        let (kind, size) = box_header(r, end - pos)?;
        let at = r.stream_position().ok()?;
        match &kind {
            b"mvhd" => {
                let b = read_n(r, size.min(32) as usize)?;
                let (scale, dur) = if b[0] == 1 { (be(&b[20..24]), be(&b[24..32])) } else { (be(&b[12..16]), be(&b[16..20])) };
                if scale > 0 && dur > 0 && dur != u32::MAX as u64 {
                    p.duration = Some(dur as f64 / scale as f64);
                }
            }
            b"trak" if p.width.is_none() => {
                if let Some((w, h)) = trak_size(r, at, size) {
                    (p.width, p.height) = (Some(w), Some(h));
                }
            }
            _ => {}
        }
        pos = at + size;
    }
    Some(p)
}

/// The picture size of a video track (`tkhd`), turned when its matrix rotates it a quarter turn.
fn trak_size<R: Read + Seek>(r: &mut R, start: u64, body: u64) -> Option<(u32, u32)> {
    let end = start + body;
    let mut pos = start;
    while pos + 8 <= end {
        r.seek(SeekFrom::Start(pos)).ok()?;
        let (kind, size) = box_header(r, end - pos)?;
        let at = r.stream_position().ok()?;
        if &kind == b"tkhd" {
            let b = read_n(r, size.min(104) as usize)?;
            // Version 0 puts the matrix at 40 and the size at 76; version 1 has 12 more bytes of times.
            let o = if b[0] == 1 { 12 } else { 0 };
            if b.len() < 84 + o {
                return None;
            }
            let (w, h) = ((be(&b[76 + o..80 + o]) >> 16) as u32, (be(&b[80 + o..84 + o]) >> 16) as u32);
            if w == 0 || h == 0 {
                return None; // an audio or subtitle track
            }
            let a = be(&b[40 + o..44 + o]) as u32 as i32;
            let quarter = a == 0;
            return Some(if quarter { (h, w) } else { (w, h) });
        }
        pos = at + size;
    }
    None
}

// ---- Matroska / WebM (EBML) ----

/// A variable-length integer: (value, length). `keep_marker` for element ids.
fn vint<R: Read>(r: &mut R, keep_marker: bool) -> Option<(u64, u64)> {
    let first = read_n(r, 1)?[0];
    let n = first.leading_zeros() as usize + 1;
    if n > 8 {
        return None;
    }
    // The marker bit's mask, in a wider type: an 8-byte vint shifts by 8 (ffmpeg writes those).
    let mask = (0xFFu16 >> n) as u64;
    let mut v = if keep_marker { first as u64 } else { first as u64 & mask };
    let mut all_ones = !keep_marker && v == mask;
    for b in read_n(r, n - 1)? {
        v = (v << 8) | b as u64;
        all_ones &= b == 0xFF;
    }
    // An all-ones size means "unknown" (a live stream's segment or cluster).
    Some((if !keep_marker && all_ones { u64::MAX } else { v }, n as u64))
}

fn ebml_float(b: &[u8]) -> Option<f64> {
    match b.len() {
        4 => Some(f32::from_be_bytes(b.try_into().ok()?) as f64),
        8 => Some(f64::from_be_bytes(b.try_into().ok()?)),
        _ => None,
    }
}

const SEGMENT: u64 = 0x1853_8067;
const INFO: u64 = 0x1549_A966;
const TRACKS: u64 = 0x1654_AE6B;
const CLUSTER: u64 = 0x1F43_B675;

fn matroska<R: Read + Seek>(r: &mut R, len: u64) -> Option<Probe> {
    let (id, _) = vint(r, true)?;
    if id != 0x1A45_DFA3 {
        return None;
    }
    let (size, _) = vint(r, false)?;
    r.seek(SeekFrom::Current(size as i64)).ok()?;
    let (id, _) = vint(r, true)?;
    if id != SEGMENT {
        return None;
    }
    let (seg_size, _) = vint(r, false)?;
    let seg_start = r.stream_position().ok()?;
    let seg_end = if seg_size == u64::MAX { len } else { (seg_start + seg_size).min(len) };

    let mut p = Probe::default();
    let (mut scale, mut raw_duration) = (1_000_000u64, None);
    let (mut have_info, mut have_tracks) = (false, false);
    let mut pos = seg_start;
    while pos < seg_end && !(have_info && have_tracks) {
        r.seek(SeekFrom::Start(pos)).ok()?;
        let (id, _) = vint(r, true)?;
        let (size, _) = vint(r, false)?;
        let at = r.stream_position().ok()?;
        if id == CLUSTER || size == u64::MAX {
            break; // the media has started: what the header holds has been read
        }
        match id {
            INFO => {
                have_info = true;
                for (cid, data) in children(r, at, size, 64 * 1024)? {
                    match cid {
                        0x2A_D7B1 => scale = be(&data),
                        0x4489 => raw_duration = ebml_float(&data),
                        _ => {}
                    }
                }
            }
            TRACKS => {
                have_tracks = true;
                // A small element (a few KB even with many tracks): read it whole and walk it in memory.
                if size <= 4 * 1024 * 1024 {
                    let b = read_n(r, size as usize)?;
                    if let Some((w, h)) = mkv_video_size(&b) {
                        (p.width, p.height) = (Some(w), Some(h));
                    }
                }
            }
            _ => {}
        }
        pos = at + size;
    }
    p.duration = raw_duration.map(|d| d * scale as f64 / 1e9).filter(|d| *d > 0.0);
    Some(p)
}

/// The direct children of an element as (id, bytes), each at most `cap` bytes (others are skipped).
fn children<R: Read + Seek>(r: &mut R, start: u64, size: u64, cap: u64) -> Option<Vec<(u64, Vec<u8>)>> {
    let mut out = vec![];
    let end = start + size;
    let mut pos = start;
    while pos < end {
        r.seek(SeekFrom::Start(pos)).ok()?;
        let (id, _) = vint(r, true)?;
        let (sz, _) = vint(r, false)?;
        let at = r.stream_position().ok()?;
        if sz == u64::MAX || at + sz > end {
            break;
        }
        if sz <= cap {
            out.push((id, read_n(r, sz as usize)?));
        }
        pos = at + sz;
    }
    Some(out)
}

/// The first video track's `PixelWidth` × `PixelHeight`, from the `Tracks` element's bytes.
fn mkv_video_size(tracks: &[u8]) -> Option<(u32, u32)> {
    let mut c = std::io::Cursor::new(tracks);
    let walk = |c: &mut std::io::Cursor<&[u8]>, end: u64| -> Vec<(u64, u64, u64)> {
        // (id, body start, body size) of each child up to `end`.
        let mut out = vec![];
        while c.position() < end {
            let (Some((id, _)), Some((sz, _))) = (vint(c, true), vint(c, false)) else { break };
            let at = c.position();
            if sz == u64::MAX || at + sz > end {
                break;
            }
            out.push((id, at, sz));
            c.set_position(at + sz);
        }
        out
    };
    for (id, at, sz) in walk(&mut c, tracks.len() as u64) {
        if id != 0xAE {
            continue; // TrackEntry
        }
        c.set_position(at);
        for (vid, vat, vsz) in walk(&mut c, at + sz) {
            if vid != 0xE0 {
                continue; // Video
            }
            c.set_position(vat);
            let (mut w, mut h) = (0, 0);
            for (pid, pat, psz) in walk(&mut c, vat + vsz) {
                let v = be(&tracks[pat as usize..(pat + psz) as usize]) as u32;
                match pid {
                    0xB0 => w = v,
                    0xBA => h = v,
                    _ => {}
                }
            }
            if w > 0 && h > 0 {
                return Some((w, h));
            }
        }
    }
    None
}

// ---- AVI ----

fn avi<R: Read + Seek>(r: &mut R) -> Option<Probe> {
    let h = read_n(r, 12)?;
    if &h[0..4] != b"RIFF" || &h[8..12] != b"AVI " {
        return None;
    }
    // LIST hdrl, then avih: its fields are fixed (microseconds per frame, total frames, width, height).
    let l = read_n(r, 12)?;
    if &l[0..4] != b"LIST" || &l[8..12] != b"hdrl" {
        return None;
    }
    let a = read_n(r, 8 + 56)?;
    if &a[0..4] != b"avih" {
        return None;
    }
    let b = &a[8..];
    let (us_per_frame, frames, width, height) = (le32(&b[0..4]), le32(&b[16..20]), le32(&b[32..36]), le32(&b[36..40]));
    let duration = (us_per_frame > 0 && frames > 0).then(|| us_per_frame as f64 * frames as f64 / 1e6);
    Some(Probe { duration, width: (width > 0).then_some(width), height: (height > 0).then_some(height) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn mp4_box(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        b.extend_from_slice(kind);
        b.extend_from_slice(body);
        b
    }

    fn tkhd(w: u32, h: u32, rotated: bool) -> Vec<u8> {
        let mut b = vec![0u8; 84];
        let a: u32 = if rotated { 0 } else { 0x0001_0000 };
        b[40..44].copy_from_slice(&a.to_be_bytes());
        b[76..80].copy_from_slice(&(w << 16).to_be_bytes());
        b[80..84].copy_from_slice(&(h << 16).to_be_bytes());
        mp4_box(b"tkhd", &b)
    }

    fn mp4(moov_first: bool, rotated: bool) -> Vec<u8> {
        let mut mvhd = vec![0u8; 100];
        mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&5_400_500u32.to_be_bytes()); // 1:30:00.5
        let audio = mp4_box(b"trak", &tkhd(0, 0, false));
        let video = mp4_box(b"trak", &tkhd(1920, 1080, rotated));
        let moov = mp4_box(b"moov", &[mp4_box(b"mvhd", &mvhd), audio, video].concat());
        let (ftyp, mdat) = (mp4_box(b"ftyp", b"isom\0\0\0\0"), mp4_box(b"mdat", &[7u8; 5000]));
        if moov_first { [ftyp, moov, mdat].concat() } else { [ftyp, mdat, moov].concat() }
    }

    #[test]
    fn reads_an_mp4_wherever_its_moov_is() {
        for first in [true, false] {
            let b = mp4(first, false);
            let p = isobmff(&mut Cursor::new(&b), b.len() as u64).unwrap();
            assert_eq!(p, Probe { duration: Some(5400.5), width: Some(1920), height: Some(1080) });
        }
        // A phone video turned a quarter: portrait.
        let b = mp4(true, true);
        let p = isobmff(&mut Cursor::new(&b), b.len() as u64).unwrap();
        assert_eq!((p.width, p.height), (Some(1080), Some(1920)));
    }

    fn el(id: &[u8], body: &[u8]) -> Vec<u8> {
        // Sizes as 8-byte vints, as some muxers write them.
        let mut b = id.to_vec();
        b.push(0x01);
        b.extend_from_slice(&(body.len() as u64).to_be_bytes()[1..]);
        b.extend_from_slice(body);
        b
    }

    #[test]
    fn reads_matroska_info_and_tracks_before_the_clusters() {
        let info = el(&[0x15, 0x49, 0xA9, 0x66], &[el(&[0x2A, 0xD7, 0xB1], &[0x0F, 0x42, 0x40]), el(&[0x44, 0x89], &1_440_250.0f64.to_be_bytes())].concat());
        let audio = el(&[0xAE], &el(&[0xE1], &el(&[0xB5], &48000.0f32.to_be_bytes())));
        let video = el(&[0xAE], &el(&[0xE0], &[el(&[0xB0], &[0x03, 0x00]), el(&[0xBA], &[0x02, 0x40])].concat()));
        let tracks = el(&[0x16, 0x54, 0xAE, 0x6B], &[audio, video].concat());
        let cluster = el(&[0x1F, 0x43, 0xB6, 0x75], &[0u8; 4000]);
        let segment = el(&[0x18, 0x53, 0x80, 0x67], &[info, tracks, cluster].concat());
        let b = [el(&[0x1A, 0x45, 0xDF, 0xA3], &[0x42, 0x86, 0x81, 0x01]), segment].concat();
        let p = matroska(&mut Cursor::new(&b), b.len() as u64).unwrap();
        assert_eq!(p, Probe { duration: Some(1440.25), width: Some(768), height: Some(576) });
    }

    #[test]
    fn says_nothing_about_what_it_cannot_read() {
        let junk = vec![0x55u8; 4096];
        assert_eq!(isobmff(&mut Cursor::new(&junk), junk.len() as u64), None);
        assert_eq!(matroska(&mut Cursor::new(&junk), junk.len() as u64), None);
        assert_eq!(avi(&mut Cursor::new(&junk)), None);
        assert_eq!(probe(Path::new("no/such/file.mkv")), None);
    }
}
