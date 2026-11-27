/**
 * Looking titles up online (the desktop app's `online_work.rs`): what is switched on, and the few things a person
 * can do about it. Nothing here asks the internet: the desktop app does, with a key that stays in the system's
 * keychain. The window only ever learns whether a key is saved.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { isDesktop } from '@pastel-studio/desktop';

/** A library folder's own switch. */
export interface PlaceSwitch {
  id: number;
  path: string;
  enabled: boolean;
}

export interface OnlineStatus {
  tmdbKey: boolean;
  omdbKey: boolean;
  /** "en-US", "es-ES"… */
  language: string;
  places: PlaceSwitch[];
  matched: number;
  unmatched: number;
  waiting: number;
  /** Why lookups stopped: the key was refused, or there is no connection. */
  trouble: 'key' | 'offline' | null;
}

/** One of TMDB's answers to a search. */
export interface Candidate {
  id: number;
  title: string;
  originalTitle: string;
  year: number | null;
  overview: string;
}

export type Service = 'tmdb' | 'omdb';
export type TitleKind = 'movie' | 'show';

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await import('@tauri-apps/api/core')).invoke<T>(cmd, args);
}

let status: OnlineStatus | null = null;
let asked = false;
const listeners = new Set<() => void>();

function keep(next: OnlineStatus): OnlineStatus {
  status = next;
  listeners.forEach((l) => l());
  return next;
}

/** Reads the status again (lookups move on by themselves). */
export function refreshOnline(): Promise<OnlineStatus | null> {
  if (!isDesktop()) return Promise.resolve(null);
  asked = true;
  return invoke<OnlineStatus>('online_status').then(keep, () => status);
}

/** The status, read once when something first needs it; `null` in a browser and until it is read. */
export function useOnline(needed = true): OnlineStatus | null {
  useEffect(() => {
    if (needed && !asked) void refreshOnline();
  }, [needed]);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => status,
  );
}

/** Saves a key once its service accepted it; `null` takes it away. Rejects with "key-refused" for a wrong key. */
export const setKey = (service: Service, key: string | null) => invoke<OnlineStatus>('online_set_key', { service, key }).then(keep);
export const setPlace = (placeId: number, enabled: boolean) => invoke<OnlineStatus>('online_set_place', { placeId, enabled }).then(keep);
export const setLanguage = (language: string) => invoke<OnlineStatus>('online_set_language', { language }).then(keep);
export const lookUpNow = () => invoke<OnlineStatus>('online_lookup_now').then(keep);

export const searchTitles = (kind: TitleKind, query: string, year?: number | null) => invoke<Candidate[]>('online_search', { kind, query, year: year ?? null });

/** The person's own answer: a film by its file's path or a series by its key is this TMDB title, or has no match (`null`). */
export const setMatch = (kind: TitleKind, key: string, tmdbId: number | null) =>
  invoke<void>('online_set_match', { kind, key, external: tmdbId == null ? null : `tmdb:${tmdbId}` });

/** For tests. */
export function resetOnline(next: OnlineStatus | null = null): void {
  status = next;
  asked = next !== null;
  listeners.forEach((l) => l());
}
