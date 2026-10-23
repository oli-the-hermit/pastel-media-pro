# Pastel Media Pro

A local media player for audio and video, built on the Pastel Studio design system.

Status: in development (Phase 0, the foundation). Nothing plays yet.

License: [MIT](LICENSE).

## Setup

You need Node 22.18 or newer, and for the desktop app Rust (MSVC) and WebView2 (part of Windows 11).

The design system is linked from its own repository, which must sit beside this one and have its
dependencies installed (the link brings none of them, and the Geist font comes from there):

```
003-Development/
  pastel-studio-theme/   npm install
  pastel-media-pro/      npm install
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | The app in the browser, at http://localhost:3300 |
| `npm run desktop` | The desktop app, reloading as you edit |
| `npm run desktop:test-build` | A debug desktop build under its own identifier, so it never touches the installed app's data |
| `npm run desktop:build` | The Windows installer (NSIS) |
| `npm run check` | Types, ESLint, Stylelint, the tests and a production build |
| `npm run corpus` | Generates a synthetic media test corpus into `corpus/` with ffmpeg |

## Continuous integration

`.github/workflows/check.yml` runs `npm run check` and the Rust tests on Windows for every push
and pull request. While the design system's repository is private, CI checks it out beside this
one with a read-only token:

1. On GitHub, create a fine-grained personal access token with access to `pastel-studio-ds`
   only, and the repository permission **Contents: Read-only**.
2. In this repository's **Settings → Secrets and variables → Actions**, add it as
   `DESIGN_SYSTEM_TOKEN`.

CI checks out the design system's `main`, so changes the app needs there must be pushed first.
If that checkout fails with "Bad credentials", the token was mistyped, has expired or was revoked:
make a new one and replace the secret.

## Layout

- `apps/player`: the desktop app (Tauri 2, React, Vite); its Rust side is in `apps/player/src-tauri`.
- `packages/`: shared code, added as the app needs it (media core, engines, media UI, the music add-on).
