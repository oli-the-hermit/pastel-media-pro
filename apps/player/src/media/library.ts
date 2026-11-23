/**
 * The library, an early form of Phase 3's: in the desktop app, the folders added in Settings → Library (and a dev
 * build's `media_to_test`), read by the Rust side (`library.rs`); in the browser, the dev server's test folder
 * (`apps/player/test-media.ts`, same scanner, files as URLs). It is read the first time a page needs it, never at
 * launch, so opening a file stays instant (D16), and again after the folders change.
 */
import { useEffect, useState } from 'react';
import type { Album, Track } from '@pastel-studio/react';
import { isDesktop } from '@pastel-studio/desktop';
import { strings } from '../strings';

export interface LibTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  number: number | null;
  disc: number | null;
  year: number | null;
  /** Seconds. */
  duration: number;
  /** A file path in the desktop app, a URL in the browser. */
  path: string;
  /** The file has tags but no audio the engine can read. */
  unplayable: boolean;
}

export interface LibAlbum {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  trackIds: string[];
  /** In the browser: the cover's URL on the dev server. */
  cover?: string;
}

export interface LibVideo {
  id: string;
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  fileName: string;
  path: string;
}

export interface LibSeries {
  id: string;
  title: string;
  episodes: LibVideo[];
}

export interface Library {
  /** The folders that were read; empty when there are none. */
  roots: string[];
  tracks: LibTrack[];
  albums: LibAlbum[];
  movies: LibVideo[];
  series: LibSeries[];
  scanMs: number;
}

export const EMPTY_LIBRARY: Library = { roots: [], tracks: [], albums: [], movies: [], series: [], scanMs: 0 };

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await import('@tauri-apps/api/core')).invoke<T>(cmd, args);
}

/** Whether the dev server has a test library for the browser (set by apps/player/test-media.ts). */
const WEB_TEST_MEDIA = !!import.meta.env.VITE_TEST_MEDIA;

const webCovers = new Map<string, string>();

async function fetchWebLibrary(): Promise<Library> {
  const res = await fetch('/__test-media/library.json');
  if (!res.ok) return EMPTY_LIBRARY;
  const lib = (await res.json()) as Library;
  for (const a of lib.albums) if (a.cover) webCovers.set(a.id, a.cover);
  return lib;
}

// The library is read again after the folders change: every hook that shows it follows.
let version = 0;
const changed = new Set<() => void>();

function libraryChanged() {
  version += 1;
  covers.clear();
  changed.forEach((l) => l());
}

/**
 * The library, read the first time `needed` is true (a page that shows it opened) and again whenever the folders
 * change; `null` until then and while it loads.
 */
export function useLibrary(needed: boolean): Library | null {
  const source = isDesktop() ? 'desktop' : WEB_TEST_MEDIA ? 'web' : 'none';
  const [library, setLibrary] = useState<Library | null>(source === 'none' ? EMPTY_LIBRARY : null);
  const [asked, setAsked] = useState(false);
  const [seen, setSeen] = useState(version);
  if (needed && !asked) setAsked(true);
  useEffect(() => {
    const follow = () => setSeen(version);
    changed.add(follow);
    return () => {
      changed.delete(follow);
    };
  }, []);
  useEffect(() => {
    if (!asked) return;
    let alive = true;
    const show = (l: Library) => alive && setLibrary(l);
    setLibrary(null);
    if (source === 'desktop') invoke<Library>('library_get').then(show, () => show(EMPTY_LIBRARY));
    else if (source === 'web') fetchWebLibrary().then(show, () => show(EMPTY_LIBRARY));
    else setLibrary(EMPTY_LIBRARY);
    return () => {
      alive = false;
    };
  }, [asked, source, seen]);
  return library;
}

/** Whether this build can add folders: the desktop app. */
export const canAddFolders = () => isDesktop();

/** The folders added in Settings → Library. */
export async function libraryFolders(): Promise<string[]> {
  if (!isDesktop()) return [];
  return invoke<string[]>('library_folders');
}

/** Windows' folder dialog; resolves to the new list (unchanged when cancelled). */
export async function addLibraryFolder(): Promise<string[]> {
  const before = await libraryFolders();
  const after = await invoke<string[]>('library_add_folder', { title: strings.library.addTitle });
  if (after.join('\n') !== before.join('\n')) libraryChanged();
  return after;
}

/** Stops reading a folder; its files are untouched. */
export async function removeLibraryFolder(folder: string): Promise<string[]> {
  const after = await invoke<string[]>('library_remove_folder', { folder });
  libraryChanged();
  return after;
}

const covers = new Map<string, Promise<string | undefined>>();

/** An album's cover: a data URL from the desktop app (fetched once per album), or the dev server's URL. */
export function useCover(albumId: string): string | undefined {
  const [cover, setCover] = useState<string | undefined>();
  useEffect(() => {
    if (!isDesktop()) {
      setCover(webCovers.get(albumId));
      return;
    }
    let alive = true;
    if (!covers.has(albumId)) covers.set(albumId, invoke<string | null>('library_cover', { albumId }).then((c) => c ?? undefined, () => undefined));
    void covers.get(albumId)!.then((c) => alive && setCover(c));
    return () => {
      alive = false;
    };
  }, [albumId]);
  return cover;
}

export function toTrack(t: LibTrack, cover?: string): Track {
  return {
    id: t.id,
    title: t.unplayable ? `${t.title} ${strings.music.unplayableMark}` : t.title,
    artist: t.artist || strings.music.unknownArtist,
    album: t.album || strings.music.noAlbum,
    duration: Math.round(t.duration),
    number: t.number ?? undefined,
    year: t.year ?? undefined,
    cover,
  };
}

export function toAlbum(a: LibAlbum, tracks: LibTrack[], cover?: string): Album {
  return {
    id: a.id,
    title: a.title || strings.music.noAlbum,
    artist: a.artist || strings.music.unknownArtist,
    kind: 'Album',
    year: a.year ?? undefined,
    cover,
    tracks: tracks.map((t) => toTrack(t, cover)),
  };
}
