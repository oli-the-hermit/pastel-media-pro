// ESLint flat config for the whole monorepo. The base is the design system's (pastel-studio-theme);
// the text and raw-control guardrails are Focus Space's. Logged in documentation/copied-from-focus-space.md.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

/** User-facing text belongs in the app's strings.ts. */
const NO_HARDCODED_TEXT = [
  {
    selector: 'JSXText[value=/[A-Za-z]{2,}/]',
    message: 'Move user-facing text to strings.ts.'
  },
  {
    selector: 'JSXAttribute[name.name=/^(placeholder|title|alt|aria-label)$/] > Literal[value=/[A-Za-z]{2,}/]',
    message: 'Move user-facing text to strings.ts.'
  },
  {
    // Text handed to components through objects, e.g. menu items and tabs: { label: 'Music' }.
    selector: 'Property[key.name=/^(label|title|message|placeholder|ariaLabel|confirmLabel|primaryLabel|cancelLabel|emptyMessage|tooltip|hint|name)$/] > Literal[value=/[A-Za-z]{2,}/]',
    message: 'Move user-facing text to strings.ts.'
  }
];

/** Interactive elements come from the design system (or, for media pieces, packages/media-ui). */
const NO_RAW_CONTROLS = [
  {
    selector: 'JSXOpeningElement[name.name=/^(button|input|select|textarea)$/]',
    message: 'Use the component (Button, IconButton, Field, Checkbox, Switch, Select...) instead of a raw element.'
  }
];

/** A library component's classes stay inside the library: render the component, or ask it for a prop. */
const NO_LIBRARY_CLASSES = [
  {
    selector: 'JSXAttribute[name.name=/className$/i] Literal[value=/(^|\\s)ps-/]',
    message: 'ps-* classes belong to the design system. Use the component, or give it a prop.'
  },
  {
    selector: 'JSXAttribute[name.name=/className$/i] TemplateElement[value.raw=/(^|\\s)ps-/]',
    message: 'ps-* classes belong to the design system. Use the component, or give it a prop.'
  }
];

/** Each workspace is used through its package name and public entry points, never by its files. */
const BOUNDARY_PATTERNS = [
  { group: ['**/packages/**', '**/apps/**'], message: 'Import another workspace by its package name, not by a path into it.' },
  { group: ['@pastel-studio/*/src/**'], message: 'Use the design system through its entry points (@pastel-studio/react).' }
];

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/src-tauri/**', 'documentation/**', 'corpus/**', 'media_to_test/**']
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': 'error'
    }
  },
  {
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
      'no-restricted-imports': ['error', { patterns: BOUNDARY_PATTERNS }],
      'no-restricted-syntax': ['error', ...NO_HARDCODED_TEXT, ...NO_RAW_CONTROLS, ...NO_LIBRARY_CLASSES]
    }
  },
  {
    // Media pieces the library lacks are built here first (D7), so raw controls are allowed here.
    files: ['packages/media-ui/src/**/*.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...NO_HARDCODED_TEXT, ...NO_LIBRARY_CLASSES] }
  },
  {
    // The dictionary itself and the tests, which read the words back.
    files: ['apps/*/src/strings.ts', '**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...NO_RAW_CONTROLS, ...NO_LIBRARY_CLASSES] }
  },
  {
    files: ['scripts/**/*.{js,ts}', '*.config.{js,ts}', 'apps/*/*.config.{js,ts}'],
    languageOptions: { globals: globals.node }
  }
);
