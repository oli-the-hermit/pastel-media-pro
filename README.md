# Pastel Media Pro

[![Check](https://github.com/oli-the-hermit/pastel-media-pro/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/oli-the-hermit/pastel-media-pro/actions/workflows/check.yml)

A local media player for Windows, and later Android, in the making: a music library, shelves for
films and series, almost any audio or video format, and subtitles transcribed on your own machine,
with nothing leaving the computer. It is built on the
[Pastel Studio design system](https://github.com/oli-the-hermit/pastel-studio-ds), the same base
as [Focus Space](https://github.com/oli-the-hermit/Focus-Space).

> **Status: in development, phase 0 (the foundation).** The app opens to its shell (navigation,
> the account menu, Appearance with light, dark and 32 accent colours, Settings) around empty
> pages. Nothing plays yet.

## Setup

You need Node 22.18 or newer, and for the desktop app Rust (MSVC) and WebView2 (part of
Windows 11).

The design system is linked from its own repository, which must sit beside this one with its
dependencies installed (the link brings none of them, and the Geist font comes from there):

```bash
git clone https://github.com/oli-the-hermit/pastel-studio-ds.git pastel-studio-theme
git clone https://github.com/oli-the-hermit/pastel-media-pro.git
cd pastel-studio-theme && npm install && cd ..
cd pastel-media-pro && npm install
```

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | The app in the browser, at http://localhost:3300 |
| `npm run desktop` | The desktop app, reloading as you edit |
| `npm run desktop:test-build` | A debug desktop build under its own identifier, so it never touches the installed app's data |
| `npm run desktop:build` | The Windows installer (NSIS) |
| `npm run check` | Types, ESLint, Stylelint, the tests and a production build |
| `npm run visual:capture` | A screenshot of every view of the shell in both themes (needs Chrome); `visual:diff` compares them with the baseline |
| `npm run corpus` | Generates a synthetic media test corpus into `corpus/` with ffmpeg |

`.github/workflows/check.yml` runs `npm run check` and the Rust tests on Windows for every push
and pull request, with the design system's `main` checked out beside the app.

## Layout

- `apps/player`: the desktop app (Tauri 2, React, Vite); its Rust side is in `apps/player/src-tauri`.
- `packages/`: shared code, added as the app needs it (media core, engines, media UI, the music add-on).
- `scripts/`: the lint guardrails' tests, the visual harness and the test corpus generator.

## License

[MIT](LICENSE).
