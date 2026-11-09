import { fileURLToPath } from 'node:url';
import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';

// The design system is linked with file: from its own repo beside this one (see the README).
const designSystem = fileURLToPath(new URL('../../../pastel-studio-theme', import.meta.url));

export default defineConfig({
  // Relative asset paths, so the bundled UI loads inside the Tauri window.
  base: './',
  plugins: [react()],
  // The library brings its own React from its repo: one copy, or hooks break.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: 3300,
    strictPort: true,
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), designSystem] },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
