// Unit tests for the whole repository: npm test
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The design system is linked from its own repo, which has its own React: one copy, or hooks break.
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    environment: 'jsdom',
    include: ['apps/**/*.test.{ts,tsx}', 'packages/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/src-tauri/**'],
    setupFiles: ['./vitest.setup.ts'],
  },
});
