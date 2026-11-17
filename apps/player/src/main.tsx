import React from 'react';
import { createRoot } from 'react-dom/client';
import { CrashBoundary } from '@pastel-studio/react';
import '@pastel-studio/react/styles.css';
import './app.css';
import { App } from './App';
import { MINI_WINDOW_HASH } from './desktop';
import { MiniApp } from './mini/MiniApp';
import { paintCachedTheme } from './theme';

// Every window paints in the remembered look before its first frame.
paintCachedTheme();

// The mini player window loads the same bundle at index.html#mini.
const isMiniWindow = window.location.hash === MINI_WINDOW_HASH;

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CrashBoundary>{isMiniWindow ? <MiniApp /> : <App />}</CrashBoundary>
  </React.StrictMode>
);
