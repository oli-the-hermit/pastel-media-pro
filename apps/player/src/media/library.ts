/**
 * The library: in the desktop app, what the import put in `library.db` (Rust `library.rs`, `import.rs`); in the
 * browser, the dev server's test folder (`apps/player/test-media.ts`, the same grouping, files as URLs). It is read
 * the first time a page needs it, never at launch, so opening a file stays instant (D16), and again after an import,
 * a rescan or a removed folder changes it.
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
  /** When it joined the library, in seconds since 1970; 0 or absent for a file that isn't in it. */
  addedAt?: number;
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
  /** An episode's own title, when its file name gives one. */
  episodeTitle: string | null;
  fileName: string;
  path: string;
  /** Seconds, from the quick probe; absent in the browser. */
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  /** From a `.nfo` or a sidecar beside the file. */
  overview?: string | null;
  genres?: string[];
  /** Images in the library's cache (`usePoster`), from the art beside the file. */
  poster?: string | null;
  backdrop?: string | null;
  /** When it joined the library, in seconds since 1970; 0 or absent for a file that isn't in it. */
  addedAt?: number;
}

export interface LibSeries {
  id: string;
  title: string;
  poster?: string | null;
  episodes: LibVideo[];
}

export interface Library {
  /** The folders it comes from; empty when there are none (files can still be added on their own). */
  roots: string[];
  tracks: LibTrack[];
  albums: LibAlbum[];
  movies: LibVideo[];
  series: LibSeries[];
  scanMs: number;
}

export const EMPTY_LIBRARY: Library = { roots: [], tracks: [], albums: [], movies: [], series: [], scanMs: 0 };

/** Nothing in it, and no folder to read: the media pages ask for one. */
export const isEmptyLibrary = (l: Library) => l.roots.length === 0 && l.tracks.length === 0 && l.movies.length === 0 && l.series.length === 0;

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

// The library is read again after it changes: every hook that shows it follows.
let version = 0;
const changed = new Set<() => void>();

/** The library changed (an import, a rescan, a removed folder): pages that show it read it again. */
export function libraryChanged() {
  version += 1;
  covers.clear();
  images.clear();
  changed.forEach((l) => l());
}

/**
 * The library, read the first time `needed` is true (a page that shows it opened) and again whenever the folders
 * change; `null` until it has been read once.
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
    // Read again after a change, what is on screen stays until the new library arrives: a title page left open
    // is still there when a video ends, and nothing flashes back to "Reading your library…".
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

const covers = new Map<string, Promise<string | undefined>>();

/** An album's cover: a data URL from the desktop app (fetched once per album), or the dev server's URL. */
export function useCover(albumId: string): string | undefined {
  const [cover, setCover] = useState<string | undefined>();
  useEffect(() => {
    if (!isDesktop()) {
      setCover(webCovers.get(albumId));
      return;
    }
    // Nothing to show a cover of (the songs without an album)
    if (!albumId) {
      setCover(undefined);
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

const images = new Map<string, Promise<string | undefined>>();

/** An image of the library's cache, asked for once. */
function loadImage(hash: string): Promise<string | undefined> {
  if (!images.has(hash)) images.set(hash, invoke<string | null>('library_image', { hash }).then((c) => c ?? undefined, () => undefined));
  return images.get(hash)!;
}

/** A poster or backdrop from the library's image cache (made once by the import), or nothing. */
export function usePoster(hash: string | null | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>();
  useEffect(() => {
    setUrl(undefined);
    if (!hash || !isDesktop()) return;
    let alive = true;
    void loadImage(hash).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [hash]);
  return url;
}

/** Several images of the cache at once (Home's banner), in the order asked; nothing where there is none. */
export function usePosters(hashes: readonly (string | null | undefined)[]): (string | undefined)[] {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const wanted = hashes.map((h) => h ?? '').join('|');
  useEffect(() => {
    if (!isDesktop()) return;
    let alive = true;
    for (const hash of wanted.split('|')) {
      if (hash) void loadImage(hash).then((u) => alive && u && setUrls((known) => (known[hash] === u ? known : { ...known, [hash]: u })));
    }
    return () => {
      alive = false;
    };
  }, [wanted]);
  return hashes.map((h) => (h ? urls[h] : undefined));
}

const openedCovers = new Map<string, Promise<string | undefined>>();

/** The cover of a song opened from Windows (`path`; empty for none), read once per file by the desktop app. */
export function useOpenedCover(path: string): string | undefined {
  const [cover, setCover] = useState<string | undefined>();
  useEffect(() => {
    setCover(undefined);
    if (!path || !isDesktop()) return;
    let alive = true;
    if (!openedCovers.has(path)) openedCovers.set(path, invoke<string | null>('open_cover', { path }).then((c) => c ?? undefined, () => undefined));
    void openedCovers.get(path)!.then((c) => alive && setCover(c));
    return () => {
      alive = false;
    };
  }, [path]);
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
