/**
 * The test library a dev build reads from `media_to_test`: in the desktop app through the Rust side
 * (`library.rs`), in the browser from the dev server (`apps/player/test-media.ts`, same scanner, files as URLs).
 * Any other build gets an empty library and the pages keep their empty states.
 */
import { useEffect, useState } from 'react';
import type { Album, Track } from '@pastel-studio/react';
import { isTauri } from '../desktop';
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
  /** The folder that was read; empty when there is no test library. */
  root: string;
  tracks: LibTrack[];
  albums: LibAlbum[];
  movies: LibVideo[];
  series: LibSeries[];
  scanMs: number;
}

export const EMPTY_LIBRARY: Library = { root: '', tracks: [], albums: [], movies: [], series: [], scanMs: 0 };

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

/** The library, read once; `null` while it loads. */
export function useLibrary(): Library | null {
  const [library, setLibrary] = useState<Library | null>(isTauri() || WEB_TEST_MEDIA ? null : EMPTY_LIBRARY);
  useEffect(() => {
    if (isTauri()) invoke<Library>('library_get').then(setLibrary, () => setLibrary(EMPTY_LIBRARY));
    else if (WEB_TEST_MEDIA) fetchWebLibrary().then(setLibrary, () => setLibrary(EMPTY_LIBRARY));
  }, []);
  return library;
}

const covers = new Map<string, Promise<string | undefined>>();

/** An album's cover: a data URL from the desktop app (fetched once per album), or the dev server's URL. */
export function useCover(albumId: string): string | undefined {
  const [cover, setCover] = useState<string | undefined>();
  useEffect(() => {
    if (!isTauri()) {
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
