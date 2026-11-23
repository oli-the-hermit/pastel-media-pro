/**
 * The app's own settings, kept on this device (`localStorage`, prefix `pastelmedia_`) until profiles bring their
 * database (O16). Read with `useSettings`, which follows changes from any window.
 */
import { useSyncExternalStore } from 'react';

/** Where a plain launch opens. A launch with files always opens on the player (D16). */
export type StartPage = 'player' | 'music' | 'streaming' | 'last';

export interface Settings {
  startOn: StartPage;
  /** Off hides the Streaming tab, and nothing of it loads. */
  showStreaming: boolean;
}

export const DEFAULT_SETTINGS: Settings = { startOn: 'player', showStreaming: true };

const KEY = 'pastelmedia_settings';
const LAST_PAGE_KEY = 'pastelmedia_last_page';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function read(): Settings {
  try {
    const saved = JSON.parse(storage()?.getItem(KEY) ?? '{}') as Partial<Settings>;
    return {
      startOn: (['player', 'music', 'streaming', 'last'] as const).includes(saved.startOn as StartPage) ? (saved.startOn as StartPage) : DEFAULT_SETTINGS.startOn,
      showStreaming: typeof saved.showStreaming === 'boolean' ? saved.showStreaming : DEFAULT_SETTINGS.showStreaming,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

let current = read();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== 'undefined') {
  // Another window (or a test) changed them.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return;
    current = read();
    notify();
  });
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(change: Partial<Settings>): void {
  current = { ...current, ...change };
  try {
    storage()?.setItem(KEY, JSON.stringify(current));
  } catch {
    // Not saved (storage full or blocked): the change still holds until the app closes.
  }
  notify();
}

/** Reads the saved settings again; for tests that change `localStorage` between renders. */
export function reloadSettings(): void {
  current = read();
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, getSettings);
}

export function rememberLastPage(page: string): void {
  try {
    storage()?.setItem(LAST_PAGE_KEY, page);
  } catch {
    // Nothing to do: "Last page" then opens the player.
  }
}

export function lastPage(): string | null {
  try {
    return storage()?.getItem(LAST_PAGE_KEY) ?? null;
  } catch {
    return null;
  }
}
