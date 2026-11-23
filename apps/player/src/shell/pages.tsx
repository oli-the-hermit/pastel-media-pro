import React from 'react';
import { IconCaptions, IconMonitor, IconMusic, IconPlay, IconQueue } from '@pastel-studio/react';
import { lastPage, type Settings } from '../settings';
import { strings } from '../strings';

export type PageKey = keyof typeof strings.pages;

export interface Page {
  key: PageKey;
  icon: React.ReactNode;
}

/** The pages in the drawer's order (D15). Their names and empty texts are in strings.pages. */
export const PAGES: Page[] = [
  { key: 'player', icon: <IconPlay size={21} /> },
  { key: 'music', icon: <IconMusic size={21} /> },
  { key: 'streaming', icon: <IconMonitor size={21} /> },
  { key: 'playlists', icon: <IconQueue size={21} /> },
  { key: 'subtitles', icon: <IconCaptions size={21} /> },
];

/** The pages shown: Streaming only while it's switched on. */
export function visiblePages(settings: Settings): Page[] {
  return PAGES.filter((p) => p.key !== 'streaming' || settings.showStreaming);
}

const isPage = (key: string | null, settings: Settings): key is PageKey => visiblePages(settings).some((p) => p.key === key);

/**
 * The page a launch opens on: the player when the app was started with files (D16), otherwise the "Start on"
 * setting; a page that's hidden, or no remembered page, falls back to the player.
 */
export function startPage(settings: Settings, launchedWithFiles: boolean): PageKey {
  if (launchedWithFiles) return 'player';
  const wanted = settings.startOn === 'last' ? lastPage() : settings.startOn;
  return isPage(wanted, settings) ? wanted : 'player';
}
