import React from 'react';
import { createRoot } from 'react-dom/client';
import { CrashBoundary } from '@pastel-studio/react';
import '@pastel-studio/react/styles.css';
import '@pastel-media/media-ui/styles.css';
import './app.css';
import { App } from './App';
import { MINI_WINDOW_HASH } from './desktop';
import { launchedWithFiles } from './media/opened';
import { MiniApp } from './mini/MiniApp';
import { paintCachedTheme } from './theme';

// Every window paints in the remembered look before its first frame.
paintCachedTheme();

// Dev only: `?bridge` runs this page in a plain browser against a windowless debug build (src/devBridge.ts).
if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('bridge')) {
  (await import('./devBridge')).installBridge();
}

// The mini player window loads the same bundle at index.html#mini.
const isMiniWindow = window.location.hash === MINI_WINDOW_HASH;

// One quick question to the Rust side first: a launch with files opens straight on the player, with no other page
// painted before it (D16).
void (isMiniWindow ? Promise.resolve(false) : launchedWithFiles()).then((withFiles) =>
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <CrashBoundary>{isMiniWindow ? <MiniApp /> : <App launchedWithFiles={withFiles} />}</CrashBoundary>
    </React.StrictMode>
  )
);
