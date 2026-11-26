# Pastel Media Pro

[![Check](https://github.com/oli-the-hermit/pastel-media-pro/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/oli-the-hermit/pastel-media-pro/actions/workflows/check.yml)

A local media player for Windows, and later Android, in the making: a music library, shelves for
films and series, almost any audio or video format, and subtitles transcribed on your own machine,
with nothing leaving the computer. It is built on the
[Pastel Studio design system](https://github.com/oli-the-hermit/pastel-studio-ds), the same base
as [Focus Space](https://github.com/oli-the-hermit/Focus-Space).

> **Status: alpha, on the way to v0.1.** A file opened from Windows ("Open with", a double-click, a
> drop on the window) plays at once in the built-in player (libmpv), and several files become one
> queue. Music and Streaming read the folders you add in Settings → Library: your albums and songs,
> and your films and series, one series per show, each with its own title page. Before v0.1 comes
> the import flow: a review list, an import queue and a library database.

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

The desktop app plays through libmpv, which is not in the repository (101 MB): extract
`libmpv-2.dll` from the pinned LGPL archive named in [docs/third-party.md](docs/third-party.md)
into `lib/`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | The app in the browser, at http://localhost:3300 |
| `npm run desktop` | The desktop app, reloading as you edit |
| `npm run desktop:test-build` | A debug desktop build under its own identifier, so it never touches the installed app's data |
| `npm run desktop:build` | The Windows installer (NSIS), with libmpv bundled. It first checks `lib/libmpv-2.dll` is the pinned LGPL build and that the third-party notices are up to date |
| `npm run desktop:build:test-installer` | An installer for testing, "Pastel Media Pro Test": its own identifier and data, libmpv bundled |
| `npm run check` | Types, ESLint, Stylelint, the tests and a production build |
| `npm run notices` | Regenerates the third-party notices the app shows in About ([docs/third-party.md](docs/third-party.md)) |
| `npm run visual:capture` | A screenshot of every view of the shell in both themes; `visual:diff` compares them with the baseline. Run `npm run visual:install` once first: it puts Playwright's Chromium in `node_modules` |
| `npm run corpus` | Generates a synthetic media test corpus into `corpus/` with ffmpeg |

`.github/workflows/check.yml` runs `npm run check` and the Rust tests on Windows for every push
and pull request, with the design system's `main` checked out beside the app.

## Layout

- `apps/player`: the desktop app (Tauri 2, React, Vite); its Rust side is in `apps/player/src-tauri`.
- `packages/`: shared code, added as the app needs it (media core, engines, media UI, the music add-on).
- `scripts/`: the lint guardrails' tests, the visual harness and the test corpus generator.

## License

[MIT](LICENSE). The player plays media through libmpv and FFmpeg, shipped as a separate DLL under
the LGPL 2.1 or later; [docs/third-party.md](docs/third-party.md) lists everything the app ships from
others and where their source is.
