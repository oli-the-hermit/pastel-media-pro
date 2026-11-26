/**
 * The last session: the songs that were playing, which one, and where it was. Kept on the device, so the player
 * can greet with that song, paused where it was left, without reading the library at launch (D16). Its cover is
 * kept beside it for the same reason. Videos are not kept here: one left part-way waits in Continue watching.
 */
import type { LibTrack } from './library';

export interface LastSession {
  queue: LibTrack[];
  index: number;
  /** Seconds: where the song was, and its length as the engine reported it (0 when it never did). */
  position: number;
  duration: number;
}

const QUEUE_KEY = 'pastelmedia_last_queue';
const POSITION_KEY = 'pastelmedia_last_position';
const COVER_KEY = 'pastelmedia_last_cover';
/** A long queue (every song of the library) is kept around the song it was on, not whole. */
const MOST = 500;
const BEFORE = 50;
/** A cover bigger than this (characters of a data URL) is not kept. */
const COVER_MOST = 300_000;

function read<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage is off or full: the player greets with nothing next time */
  }
}

const isSong = (t: unknown): t is LibTrack => !!t && typeof t === 'object' && typeof (t as LibTrack).id === 'string' && typeof (t as LibTrack).path === 'string';

/** The session kept last, or nothing: never played, or what is stored cannot be read. */
export function readLastSession(): LastSession | null {
  const kept = read<{ queue: unknown; index: unknown }>(QUEUE_KEY);
  if (!kept || !Array.isArray(kept.queue) || typeof kept.index !== 'number') return null;
  const queue = kept.queue.filter(isSong);
  const song = queue[kept.index];
  if (queue.length !== kept.queue.length || !song || song.unplayable) return null;
  const at = read<{ path: string; position: number; duration: number }>(POSITION_KEY);
  const mine = at && at.path === song.path && Number.isFinite(at.position) && Number.isFinite(at.duration) ? at : null;
  const duration = mine && mine.duration > 0 ? mine.duration : song.duration;
  // Left at its very end: it starts over.
  const position = mine && mine.position > 0 && (duration <= 0 || mine.position < duration - 2) ? mine.position : 0;
  return { queue, index: kept.index, position, duration };
}

/** Keeps the queue and the song it is on. */
export function saveLastQueue(queue: LibTrack[], index: number): void {
  if (index < 0 || index >= queue.length) return;
  const from = queue.length > MOST ? Math.max(0, Math.min(index - BEFORE, queue.length - MOST)) : 0;
  write(QUEUE_KEY, { queue: queue.slice(from, from + MOST), index: index - from });
}

/** Keeps where the song is. */
export function saveLastPosition(path: string, position: number, duration: number): void {
  if (path) write(POSITION_KEY, { path, position, duration });
}

/** Keeps a song's cover, once the page has it, for the next greeting. */
export function saveLastCover(path: string, cover: string | undefined): void {
  if (!path || !cover || cover.length > COVER_MOST) return;
  const kept = read<{ path: string; cover: string }>(COVER_KEY);
  if (kept?.path === path && kept.cover === cover) return;
  write(COVER_KEY, { path, cover });
}

/** The cover kept for this song, if it is the one kept. */
export function lastCover(path: string): string | undefined {
  const kept = read<{ path: string; cover: string }>(COVER_KEY);
  return kept && kept.path === path && typeof kept.cover === 'string' ? kept.cover : undefined;
}
