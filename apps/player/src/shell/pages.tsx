import React from 'react';
import { IconCaptions, IconFileVideo, IconHome, IconMonitor, IconMusic, IconQueue } from '@pastel-studio/react';
import { strings } from '../strings';

export type PageKey = keyof typeof strings.pages;

export interface Page {
  key: PageKey;
  icon: React.ReactNode;
}

/** The pages in the drawer's order. Their names and empty texts are in strings.pages. */
export const PAGES: Page[] = [
  { key: 'home', icon: <IconHome size={20} /> },
  { key: 'music', icon: <IconMusic size={20} /> },
  { key: 'movies', icon: <IconFileVideo size={20} /> },
  { key: 'series', icon: <IconMonitor size={20} /> },
  { key: 'playlists', icon: <IconQueue size={20} /> },
  { key: 'subtitles', icon: <IconCaptions size={20} /> },
];
