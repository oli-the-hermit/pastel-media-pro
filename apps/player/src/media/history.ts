/**
 * What was played, how far and when: the base of Continue watching, Recently played, the watched marks, and of
 * picking a film up where it was left. The desktop app keeps it in the library's database (history.rs); the web
 * version keeps it on the device, so every page that reads it can be tried in a browser.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { isDesktop } from '@pastel-studio/desktop';

export interface Play {
  path: string;
  /** Seconds: where it was left, and its length as the engine reported it (0 when it never did). */
  position: number;
  duration: number;
  finished: boolean;
  /** Times it was started. */
  count: number;
  /** Seconds since 1970. */
  lastPlayedAt: number;
}

/** A file counts as finished once this much of it was played (history.rs has the same number). */
export const FINISHED_AT = 0.9;
/** A video picks up where it was left once this many seconds of it were seen. */
export const RESUME_AFTER = 30;

const WEB_KEY = 'pastelmedia_history';

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await import('@tauri-apps/api/core')).invoke<T>(cmd, args);
}

let plays = new Map<string, Play>();
let snapshot: ReadonlyMap<string, Play> = plays;
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  snapshot = new Map(plays);
  listeners.forEach((l) => l());
}

function readWeb(): Play[] {
  try {
    const list = JSON.parse(window.localStorage.getItem(WEB_KEY) ?? '[]') as Play[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeWeb() {
  try {
    window.localStorage.setItem(WEB_KEY, JSON.stringify([...plays.values()]));
  } catch {
    /* the device's storage is full or off: the history lasts until the page closes */
  }
}

/** Reads the history once; pages that show it ask through `useHistory`. */
export function loadHistory(): Promise<void> {
  if (!loading) {
    loading = (isDesktop() ? invoke<Play[]>('history_list') : Promise.resolve(readWeb())).then(
      (list) => {
        // What was recorded while the list was on its way stays.
        plays = new Map([...list.map((p) => [p.path, p] as const), ...plays]);
        loaded = true;
        emit();
      },
      () => {
        loaded = true;
      },
    );
  }
  return loading;
}

/** Every file's play, by path; read the first time `needed` is true and kept up to date as things play. */
export function useHistory(needed = true): ReadonlyMap<string, Play> {
  useEffect(() => {
    if (needed) void loadHistory();
  }, [needed]);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

/** One file's play, without waiting for the whole history. */
export async function playOf(path: string): Promise<Play | undefined> {
  if (loaded || plays.has(path)) return plays.get(path);
  if (isDesktop()) return (await invoke<Play | null>('history_get', { path }).catch(() => null)) ?? undefined;
  await loadHistory();
  return plays.get(path);
}

/** Where a play picks up: its position once enough was seen and it isn't finished, otherwise the start. */
export function resumePoint(play: Play | undefined): number {
  return play && !play.finished && play.position >= RESUME_AFTER ? play.position : 0;
}

/** How much of it was seen, 0 to 1; 1 once it is finished. */
export function progressOf(play: Play | undefined): number {
  if (!play) return 0;
  if (play.finished) return 1;
  return play.duration > 0 ? Math.min(1, play.position / play.duration) : 0;
}

/**
 * Writes down where a file is. `started` counts one more play; `ended` says its end was reached. The desktop app
 * only keeps files of the library: for any other it answers false and nothing is remembered here either.
 */
export function recordPlay(path: string, position: number, duration: number, ended: boolean, started: boolean): void {
  if (!path) return;
  const before = plays.get(path);
  const known = duration > 0 ? duration : (before?.duration ?? 0);
  const next: Play = {
    path,
    position,
    duration: known,
    finished: ended || (known > 0 && position / known >= FINISHED_AT),
    count: (before?.count ?? 0) + (started ? 1 : 0),
    lastPlayedAt: Math.floor(Date.now() / 1000),
  };
  const keep = () => {
    plays.set(path, next);
    emit();
  };
  if (!isDesktop()) {
    keep();
    writeWeb();
    return;
  }
  void invoke<boolean>('history_record', { path, position, duration, ended, started }).then(
    (inLibrary) => inLibrary && keep(),
    () => {},
  );
}

/** For tests: forget everything. */
export function resetHistory(): void {
  plays = new Map();
  loaded = false;
  loading = null;
  emit();
}
