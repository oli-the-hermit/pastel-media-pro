/**
 * The test library a dev build reads from `media_to_test` (the Rust side, `library.rs`). A build without
 * it, or the app in a plain browser, gets an empty library and the pages keep their empty states.
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

/** The library, read once; `null` while it loads. */
export function useLibrary(): Library | null {
  const [library, setLibrary] = useState<Library | null>(isTauri() ? null : EMPTY_LIBRARY);
  useEffect(() => {
    if (!isTauri()) return;
    invoke<Library>('library_get').then(setLibrary, () => setLibrary(EMPTY_LIBRARY));
  }, []);
  return library;
}

const covers = new Map<string, Promise<string | undefined>>();

/** An album's cover as a data URL, fetched once per album. */
export function useCover(albumId: string): string | undefined {
  const [cover, setCover] = useState<string | undefined>();
  useEffect(() => {
    if (!isTauri()) return;
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
