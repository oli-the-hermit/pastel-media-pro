# Figma screens

A Figma development plugin that builds Pastel Media Pro's screens in the Pastel Studio Figma file, so
the layout can be changed and previewed there quickly. The screens are made of the Pastel Studio
design system's Figma library (built by `pastel-studio-ds`, `tools/figma-library`), so a change to a
component shows on every screen. Each screen is re-pointed to Media Pro's accent (solar lime, its
default), which lives in the file's **App colours** collection as `media/…`.

The usual way to run it is the design system's **whole-file plugin** (`tools/figma-file` there), which
puts the library, the blocks and every app's screens in one new file. This folder's own plugin
builds the same screens into a file laid out the older way (a `Screens` page).

## What it builds

**Media Pro components** (on the Blocks page, in "Pastel Media Pro components"):

- **MediaProDrawer**, expanded and as a rail: the mark and the name, the pages (Player, Music,
  Streaming, Playlists, Subtitles), the profile.
- **MediaProTopBar:** the page's title, the library imports ring (shown with *Show imports*), the
  mini player, Help and the window's buttons.
- **MediaProTile:** an album's cover, a poster, a wide still, an artist's round picture. *In
  progress* and *Watched* are proposals.
- **TitleHeader:** the head of a film's or a series' page.
- Proposals, which the design system doesn't have yet: **FilterChip**, **LibraryToolbar**,
  **HeroCarousel**, **MediaRow**, **PlaylistTile**.

**Screens**, each a 1440 × 900 desktop window (the app's default size).

As the app is now:

- Player: empty; a song playing; a video playing; "We can't play this file".
- Music: the albums; an album.
- Streaming: Movies; a film; a series with its seasons and episodes.
- Playlists, empty.
- Settings: General; Library.
- Add a folder: the files found (the review list). Library: adding a folder (the import queue).
- About; Help.

Proposals, from the 2026-11-26 list (not built in the app yet; a starting point to design from):

- Player: the video is loading (solid backdrop and a spinner); the controls are hidden; welcome
  back (paused on the last song, with its queue).
- Music: albums with search and filters; songs; artists; searching (the suggestions open); an
  artist.
- Streaming: Home (the banner of up to six titles, Continue watching, rows; drawn taller than the
  window to show the whole page); Movies, Series and Clips with search and filters.
- Playlists: the playlists; a new playlist; a playlist.

Sizes and wording of the first group come from `apps/player/src` (`App.tsx`, `shell/`, `media/`,
`app.css`) and `apps/player/src/strings.ts`. The albums, films, folders and files shown are made up.

## Run it

In the whole-file plugin (see the design system's `tools/figma-file/README.md`): **Build
everything**, or **Mockups: Pastel Media Pro** in a file that already has the library.

On its own:

1. In the Figma desktop app, open a file that holds the library and has a `Screens` page (run
   **Pastel Studio DS: Figma library** first).
2. Menu → **Plugins → Development → Import plugin from manifest…**, then pick `manifest.json` in
   this folder. This is needed once.
3. Menu → **Plugins → Development → Pastel Media Pro: screens**.

A screen that already exists is skipped. To rebuild one, delete it and run the plugin again. The
plugin never changes what is already there, so move and edit the screens freely.

## Change it

Edit `screens.js`, then build `code.js`, which is what Figma runs:

```
npm run figma:screens
```

`build.mjs` puts together the screens kit from the design system beside this repo
(`../pastel-studio-theme/tools/figma-library/screens-kit.js`, or `--ds=<folder>`), Media Pro's
accent from the design system's palette, and `screens.js`. The screens need the kit that has
`componentsSection`, `shelve` and `soft` (the design system's branch `figma/three-page-file` and
later).

To check a change without Figma, use the design system's stand-in:

```
node ../pastel-studio-theme/tools/figma-file/build.mjs --apps=media --out=<file>
node ../pastel-studio-theme/tools/figma-file/smoke.mjs --only=media --code=<file> --preview=<folder>
```
