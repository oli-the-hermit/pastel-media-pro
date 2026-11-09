import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

// Testing Library only unmounts by itself when the test functions are globals; they aren't here.
afterEach(cleanup);

// jsdom has no media queries. A light OS that never changes, and room for the expanded drawer.
beforeEach(() => {
  if (typeof window === 'undefined') return;
  window.matchMedia = (query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
  window.localStorage.clear();
});
