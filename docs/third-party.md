# Third-party software

Pastel Media Pro is MIT-licensed ([LICENSE](../LICENSE)). This page lists what it ships from others,
under which licence, and what that asks of us. The full notices the app shows in **Account → About**
are generated from the dependency trees:

```bash
npm run notices          # rewrites apps/player/public/licenses/
node scripts/release/notices.ts --check   # run by npm run desktop:build: fails when they are out of date
```

`apps/player/public/licenses/third-party-notices.txt` lists every npm package the interface bundles
and every Rust crate the executable links (dev and build tools left out), each with its licence and
licence files; identical licence texts are written once. `LGPL-2.1.txt` is the FSF's text, verbatim.

## What ships

| Component | Licence | How it ships | What we do |
|---|---|---|---|
| **libmpv** (mpv's library) | LGPL-2.1-or-later (built with `-Dgpl=false`) | `libmpv-2.dll`, a separate file beside the app, loaded at run time | Notice and LGPL text in About; source pointers below; the DLL can be replaced by the user |
| **FFmpeg** (inside libmpv) | LGPL-2.1-or-later (no `--enable-gpl`) | Inside `libmpv-2.dll` | As above. Patent-encumbered codecs (H.264, HEVC, AAC…) are decoded; patent licences are the user's matter in their country |
| Other libraries inside `libmpv-2.dll` (libass, libplacebo, FreeType, HarfBuzz, FriBidi, dav1d, libvpx, LuaJIT, libbluray…) | Their own (LGPL, BSD, MIT, ISC, zlib, FTL…) | Inside `libmpv-2.dll` | **Not yet verified one by one**: the list comes from mpv-winbuild's build scripts for this build (plan R2) |
| Tauri, its plugins, and the other Rust crates | MIT / Apache-2.0 (mostly dual), Unicode-3.0, Zlib, BSD-3-Clause, ISC, MPL-2.0 (5 crates, unmodified, source on crates.io) | Linked into the executable | Notices (generated) |
| React, React DOM, scheduler, `@tauri-apps/api` | MIT / Apache-2.0 OR MIT | Bundled into the interface | Notices (generated) |
| Pastel Studio design system (`@pastel-studio/react`, `desktop`, `tokens`) | MIT | Bundled into the interface | Notices (generated) |
| Geist (the font, through `@fontsource-variable/geist`) | OFL-1.1 | Bundled into the interface | Notices (generated) |
| WebView2 | Microsoft's runtime, part of Windows 11 | The installer embeds Microsoft's bootstrapper, which installs it if missing | Nothing to bundle |

No GPL component ships. The installer refuses to build with any `libmpv-2.dll` other than the pinned
LGPL build (`lib/libmpv.json`, checked by `scripts/release/check-libmpv.ts`).

## libmpv: the build we ship

- mpv `v0.41.0-1224-g6a262d11f`, built with `-Dgpl=false`; FFmpeg `N-127696-g8b3525e71`, without
  `--enable-gpl`; read from the running DLL in spike S1.
- From [zhongfly/mpv-winbuild](https://github.com/zhongfly/mpv-winbuild): the archive
  `mpv-dev-lgpl-x86_64-20261019-git-6a262d11f6.7z`, sha256
  `95420b393fd86dc39853d5df6b03bed318720c501a089930231058558ec40bf2`.
- `libmpv-2.dll`: 101,356,544 bytes, sha256
  `f454227e5b608966230605bdaaecc9b19e8d735b7b5cf8777ec0985d3bb09dfe`.

To build an installer, extract `libmpv-2.dll` from that archive into `lib/` (it is git-ignored).

### Source code (LGPL)

- mpv: <https://github.com/mpv-player/mpv>, commit `6a262d11f`.
- FFmpeg: <https://github.com/FFmpeg/FFmpeg>, commit `8b3525e71`.
- The build scripts that produced this DLL: <https://github.com/zhongfly/mpv-winbuild>.

The LGPL asks that whoever distributes the binary also gives access to its corresponding source.
Pointing at upstream repositories is the usual practice but not the strongest form of it: attaching
the exact source archives to each GitHub release next to the installer removes any doubt. A build we
control in CI (plan R2, the shared `tools/binaries/` manifest) is the long-term answer.

### Replacing the DLL

The app loads `libmpv-2.dll` at run time from beside its executable (`engine.rs`), with no import
library, so a user may replace it with their own build of a compatible libmpv (client API 2.x).
