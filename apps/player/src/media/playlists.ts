/**
 * Playlists: lists of songs a person makes. The desktop app keeps them in the library's database (playlists.rs);
 * the web version keeps them on the device, so the pages can be tried in a browser. Songs are named by their
 * file's path, as in the play history; a song is in a playlist once.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { isDesktop } from '@pastel-studio/desktop';

export interface Playlist {
  id: number;
  name: string;
  description: string;
  /** Seconds since 1970. */
  createdAt: number;
  /** When it was renamed, or its songs changed. */
  updatedAt: number;
  /** Its songs' files, in order. One the library does not have right now stays in the list, and is not shown. */
  paths: string[];
}

const WEB_KEY = 'pastelmedia_playlists';

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await import('@tauri-apps/api/core')).invoke<T>(cmd, args);
}

let lists: Playlist[] = [];
let snapshot: readonly Playlist[] = lists;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

const now = () => Math.floor(Date.now() / 1000);
const once = (paths: string[]) => [...new Set(paths)];

function emit() {
  // The one changed last first, as the database lists them.
  lists = [...lists].sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id);
  snapshot = lists;
  if (!isDesktop()) {
    try {
      window.localStorage.setItem(WEB_KEY, JSON.stringify(lists));
    } catch {
      /* the device's storage is full or off: the playlists last until the page closes */
    }
  }
  listeners.forEach((l) => l());
}

function readWeb(): Playlist[] {
  try {
    const stored = JSON.parse(window.localStorage.getItem(WEB_KEY) ?? '[]') as Playlist[];
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

/** Reads the playlists once; pages that show them ask through `usePlaylists`. */
export function loadPlaylists(): Promise<void> {
  if (!loading) {
    loading = (isDesktop() ? invoke<Playlist[]>('playlists_list') : Promise.resolve(readWeb())).then(
      (stored) => {
        // One made while the list was on its way stays.
        lists = [...lists.filter((p) => !stored.some((s) => s.id === p.id)), ...stored];
        emit();
      },
      () => {},
    );
  }
  return loading;
}

/** Every playlist, the one changed last first; read the first time `needed` is true and kept up to date. */
export function usePlaylists(needed = true): readonly Playlist[] {
  useEffect(() => {
    if (needed) void loadPlaylists();
  }, [needed]);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}

const put = (playlist: Playlist) => {
  lists = [...lists.filter((p) => p.id !== playlist.id), playlist];
  emit();
};

/** A new playlist, with these songs in it when some are given. */
export async function createPlaylist(name: string, description = '', paths: string[] = []): Promise<Playlist> {
  await loadPlaylists();
  const made: Playlist = isDesktop()
    ? await invoke<Playlist>('playlist_create', { name, description })
    : { id: lists.reduce((m, p) => Math.max(m, p.id), 0) + 1, name: name.trim(), description: description.trim(), createdAt: now(), updatedAt: now(), paths: [] };
  put(made);
  if (paths.length > 0) await setPlaylistSongs(made.id, paths);
  return lists.find((p) => p.id === made.id) ?? made;
}

export async function updatePlaylist(id: number, name: string, description: string): Promise<void> {
  const before = lists.find((p) => p.id === id);
  if (!before) return;
  if (isDesktop()) await invoke<boolean>('playlist_update', { id, name, description });
  put({ ...before, name: name.trim(), description: description.trim(), updatedAt: now() });
}

export async function deletePlaylist(id: number): Promise<void> {
  if (isDesktop()) await invoke<boolean>('playlist_delete', { id });
  lists = lists.filter((p) => p.id !== id);
  emit();
}

/**
 * Makes these songs the playlist's, in this order: how songs are added, taken out and moved. The page shows the
 * new list at once; the desktop app then answers with the list as it kept it (only songs of the library).
 */
export async function setPlaylistSongs(id: number, paths: string[]): Promise<void> {
  const before = lists.find((p) => p.id === id);
  if (!before) return;
  put({ ...before, paths: once(paths), updatedAt: now() });
  if (!isDesktop()) return;
  try {
    const kept = await invoke<string[] | null>('playlist_set', { id, paths: once(paths) });
    const current = lists.find((p) => p.id === id);
    if (kept && current) put({ ...current, paths: kept });
  } catch (e) {
    // It was not saved: back to what it had.
    put(before);
    throw e;
  }
}

/** Adds songs at the end of a playlist; answers how many were not in it yet. */
export async function addToPlaylist(id: number, paths: string[]): Promise<number> {
  const before = lists.find((p) => p.id === id);
  if (!before) return 0;
  const fresh = once(paths).filter((p) => !before.paths.includes(p));
  if (fresh.length > 0) await setPlaylistSongs(id, [...before.paths, ...fresh]);
  return fresh.length;
}

/** For tests: forget everything. */
export function resetPlaylists(): void {
  lists = [];
  snapshot = lists;
  loading = null;
  listeners.forEach((l) => l());
}
