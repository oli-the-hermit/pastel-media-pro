/**
 * The import filters (ux.md §2b), applied live to the review list. The rescan applies the saved ones in Rust
 * (`src-tauri/src/filters.rs`); both pass `filter-cases.json`. A value the quick probe couldn't read always passes.
 */

export type Preset = 'movies' | 'music' | 'everything' | 'custom';
export type MediaKind = 'audio' | 'video';

export interface Filters {
  preset: Preset;
  /** `null` for both. */
  kinds: MediaKind[] | null;
  /** Seconds. */
  minDuration: number | null;
  maxDuration: number | null;
  minBytes: number | null;
  maxBytes: number | null;
  /** Lines of picture (720, 1080, 2160); a wide film's cropped height counts by its width. */
  minHeight: number | null;
  /** Lower case, no dot; `null` for all. */
  extensions: string[] | null;
  /** Leave out samples, trailers and extras. */
  skipExtras: boolean;
}

/** What the filters look at in one file. */
export interface Candidate {
  kind: MediaKind;
  ext: string;
  size: number;
  duration: number | null;
  height: number | null;
  width?: number | null;
  /** The path below the folder, with `/`. */
  rel: string;
}

const ANY = { kinds: null, minDuration: null, maxDuration: null, minBytes: null, maxBytes: null, minHeight: null, extensions: null, skipExtras: false };

/** O19: "Movies & series" keeps videos of 20 minutes or more, without samples, trailers and extras. */
export const PRESETS: Record<Exclude<Preset, 'custom'>, Filters> = {
  movies: { ...ANY, preset: 'movies', kinds: ['video'], minDuration: 20 * 60, skipExtras: true },
  music: { ...ANY, preset: 'music', kinds: ['audio'] },
  everything: { ...ANY, preset: 'everything' },
};

const EXTRA_FOLDERS = new Set([
  'extras', 'extra', 'featurettes', 'featurette', 'sample', 'samples', 'trailers', 'trailer', 'behind the scenes',
  'deleted scenes', 'interviews', 'bonus',
]);
const WORDS = 'sample|trailer|teaser|featurette|behindthescenes|deleted|interview|extra|bonus|promo';
const EXTRA_NAME = new RegExp(`^(?:${WORDS})$|[-._ ](?:${WORDS})$|^sample[-._ ]`, 'i');

/** Whether a file is a sample, a trailer or another extra, by its name or its folder. */
export function isExtra(rel: string): boolean {
  const parts = rel.split('/');
  const file = parts.pop() ?? '';
  if (parts.some((f) => EXTRA_FOLDERS.has(f.trim().toLowerCase()))) return true;
  const dot = file.lastIndexOf('.');
  return EXTRA_NAME.test(dot > 0 ? file.slice(0, dot) : file);
}

/** The picture's lines as people name them: a 1920×800 scope film is "1080p". */
export function lines(c: { height?: number | null; width?: number | null }): number | null {
  if (c.height == null) return null;
  return c.width != null ? Math.max(c.height, Math.floor((c.width * 9) / 16)) : c.height;
}

export function passes(f: Filters, c: Candidate): boolean {
  if (f.kinds && !f.kinds.includes(c.kind)) return false;
  if (f.extensions && !f.extensions.some((e) => e.toLowerCase() === c.ext.toLowerCase())) return false;
  if ((f.minBytes != null && c.size < f.minBytes) || (f.maxBytes != null && c.size > f.maxBytes)) return false;
  if (c.duration != null && ((f.minDuration != null && c.duration < f.minDuration) || (f.maxDuration != null && c.duration > f.maxDuration))) {
    return false;
  }
  // A tier allows 10 %: a cropped 1080p release (1760×1072, 1904×1024) is "1080p", a DVD's 576 isn't 720p.
  if (c.kind === 'video' && f.minHeight != null) {
    const l = lines(c);
    if (l != null && l < f.minHeight * 0.9) return false;
  }
  return !(f.skipExtras && isExtra(c.rel));
}

/** A change to one filter: the preset becomes "custom" unless the result is a preset again. */
export function change(f: Filters, patch: Partial<Filters>): Filters {
  const next = { ...f, ...patch, preset: 'custom' as Preset };
  const same = (Object.keys(PRESETS) as (keyof typeof PRESETS)[]).find((k) => JSON.stringify({ ...PRESETS[k], preset: 'custom' }) === JSON.stringify(next));
  return same ? PRESETS[same] : next;
}

const TIERS = [2160, 1080, 720, 576, 480];

/** The tier a picture is named by (10 % below counts): 1760×1072 → 1080, 768×576 → 576. */
export function tier(c: { height?: number | null; width?: number | null }): number | null {
  const l = lines(c);
  if (l == null) return null;
  return TIERS.find((t) => l >= t * 0.9) ?? l;
}
