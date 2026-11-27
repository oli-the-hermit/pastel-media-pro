import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';
import { testMedia } from './test-media';

// The design system is linked with file: from its own repo beside this one (see the README), or from another
// folder of it (scripts/link-design-system.ts): the dev server may read files from wherever the link points.
const linked = fileURLToPath(new URL('../../node_modules/@pastel-studio/react', import.meta.url));
const designSystem = fs.existsSync(linked) ? path.resolve(fs.realpathSync(linked), '..', '..') : fileURLToPath(new URL('../../../pastel-studio-theme', import.meta.url));

export default defineConfig({
  // Relative asset paths, so the bundled UI loads inside the Tauri window.
  base: './',
  // testMedia: the dev server's test library for the web version (dev only).
  plugins: [react(), testMedia()],
  // The library brings its own React from its repo: one copy, or hooks break.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: 3300,
    strictPort: true,
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), designSystem] },
    // Dev only: a windowless debug build answers the page's IPC here (src-tauri/src/bridge.rs, src/devBridge.ts).
    proxy: { '/__bridge': { target: `http://127.0.0.1:${process.env.PASTEL_BRIDGE_PORT ?? 3399}`, rewrite: (p) => p.replace(/^\/__bridge/, '') } },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
