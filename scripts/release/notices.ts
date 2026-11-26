// Generates the third-party notices the app ships: every npm package the UI bundles and every Rust crate the
// executable links (not dev or build tools), with each one's licence and its licence files, identical texts
// written once. libmpv and FFmpeg come first, with the LGPL text, since they ship as a separate DLL.
// Usage: node scripts/release/notices.ts          (rewrites apps/player/public/licenses/)
//        node scripts/release/notices.ts --check  (fails when the committed notices are out of date)
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const appDir = join(root, 'apps', 'player');
const outDir = join(appDir, 'public', 'licenses');

export interface Notice {
  name: string;
  version: string;
  licence: string;
  url?: string;
  /** Licence and notice files: [file name, text]. */
  files: [string, string][];
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;

function licenceFiles(dir: string): [string, string][] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENCE_FILE.test(f))
    .sort()
    .map((f) => [f, readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim()] as [string, string])
    .filter(([, text]) => text.length > 0);
}

/** Licence files of a package, or of the repository it sits in (the design system keeps one at its root). */
function filesUpward(dir: string, stop: string): [string, string][] {
  for (let d = dir; d.startsWith(stop); d = dirname(d)) {
    const found = licenceFiles(d);
    if (found.length) return found;
    if (existsSync(join(d, '.git')) || dirname(d) === d) break;
  }
  return [];
}

function repoUrl(repository: unknown): string | undefined {
  const url = typeof repository === 'string' ? repository : (repository as { url?: string } | undefined)?.url;
  return url?.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/');
}

/** Finds `name` from `from` the way Node does: the nearest node_modules up the tree, links followed. */
function resolvePackage(name: string, from: string): string | null {
  for (let d = from; ; d = dirname(d)) {
    const candidate = join(d, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    if (dirname(d) === d) return null;
  }
}

/** The npm packages the UI bundle is made of: the app's dependencies and theirs, our own workspaces left out. */
export function npmNotices(): Notice[] {
  const seen = new Map<string, Notice>();
  const visit = (dir: string, isApp: boolean) => {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string;
      version: string;
      license?: string;
      repository?: unknown;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const key = `${pkg.name}@${pkg.version}`;
    if (seen.has(key)) return;
    if (!isApp && !pkg.name.startsWith('@pastel-media/')) {
      seen.set(key, { name: pkg.name, version: pkg.version, licence: pkg.license ?? 'UNKNOWN', url: repoUrl(pkg.repository), files: filesUpward(dir, dirname(dirname(root))) });
    } else {
      seen.set(key, { name: pkg.name, version: pkg.version, licence: '', files: [] });
    }
    for (const dep of Object.keys({ ...pkg.dependencies })) {
      const found = resolvePackage(dep, dir);
      if (!found) throw new Error(`${dep} (needed by ${pkg.name}) is not installed`);
      visit(found, false);
    }
  };
  visit(appDir, true);
  return [...seen.values()].filter((n) => n.licence !== '');
}

interface CargoMetadata {
  packages: { id: string; name: string; version: string; license: string | null; license_file: string | null; repository: string | null; manifest_path: string; source: string | null }[];
  resolve: { root: string; nodes: { id: string; deps: { pkg: string; dep_kinds: { kind: string | null }[] }[] }[] };
}

/** The crates linked into the Windows executable: normal dependencies only, followed from the app's crate. */
export function cargoNotices(metadata?: CargoMetadata): Notice[] {
  const meta =
    metadata ??
    (JSON.parse(
      execFileSync('cargo', ['metadata', '--format-version', '1', '--filter-platform', 'x86_64-pc-windows-msvc', '--locked'], {
        cwd: join(appDir, 'src-tauri'),
        maxBuffer: 256 * 1024 * 1024,
        encoding: 'utf8',
      }),
    ) as CargoMetadata);
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const linked = new Set<string>();
  const walk = (id: string) => {
    if (linked.has(id)) return;
    linked.add(id);
    for (const dep of nodes.get(id)?.deps ?? []) {
      if (dep.dep_kinds.some((k) => k.kind === null)) walk(dep.pkg);
    }
  };
  walk(meta.resolve.root);
  return meta.packages
    .filter((p) => linked.has(p.id) && p.id !== meta.resolve.root)
    .map((p) => {
      const dir = dirname(p.manifest_path);
      const files = licenceFiles(dir);
      if (p.license_file && !files.length) {
        const path = join(dir, p.license_file);
        if (existsSync(path)) files.push([p.license_file, readFileSync(path, 'utf8').replace(/\r\n/g, '\n').trim()]);
      }
      return { name: p.name, version: p.version, licence: p.license ?? (p.license_file ? `see ${p.license_file}` : 'UNKNOWN'), url: p.repository ?? undefined, files };
    });
}

const LIBMPV = `libmpv and FFmpeg
=================

Pastel Media Pro plays media through libmpv (mpv's library), which
includes FFmpeg and other libraries. They ship as a separate file,
libmpv-2.dll, beside the app, under the GNU Lesser General Public
License version 2.1 or later (the full text is LGPL-2.1.txt). The app
loads it at run time: you may replace libmpv-2.dll with your own build
of a compatible version.

The build shipped is mpv v0.41.0-1224-g6a262d11f built with
-Dgpl=false (the LGPL build), with FFmpeg N-127696-g8b3525e71 built
without --enable-gpl, from mpv-winbuild by zhongfly (the archive
mpv-dev-lgpl-x86_64-20261019-git-6a262d11f6.7z).

Source code:
  mpv:     https://github.com/mpv-player/mpv (commit 6a262d11f)
  FFmpeg:  https://github.com/FFmpeg/FFmpeg (commit 8b3525e71)
  Build:   https://github.com/zhongfly/mpv-winbuild
`;

function block(n: Notice, texts: Map<string, string>): string {
  const head = `${n.name} ${n.version}\nLicence: ${n.licence}${n.url ? `\n${n.url}` : ''}`;
  const refs = n.files.map(([file, text]) => {
    const hash = createHash('sha256').update(text).digest('hex').slice(0, 12);
    const label = `${file} (${hash})`;
    if (!texts.has(hash)) texts.set(hash, `${label}, first used by ${n.name} ${n.version}\n${'-'.repeat(label.length)}\n\n${text}`);
    return `  ${label}`;
  });
  return `${head}\n${refs.length ? refs.join('\n') : '  (no licence file in the package; the licence named above applies)'}`;
}

/** The notices file: libmpv first, then each package with its licence, then each distinct licence text once. */
export function render(npm: Notice[], cargo: Notice[]): string {
  const texts = new Map<string, string>();
  const sort = (a: Notice, b: Notice) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);
  const npmBlocks = [...npm].sort(sort).map((n) => block(n, texts));
  const cargoBlocks = [...cargo].sort(sort).map((n) => block(n, texts));
  return [
    'Pastel Media Pro: third-party notices',
    '=====================================',
    '',
    'Generated by scripts/release/notices.ts. Each package names its',
    'licence and the licence files it ships, by name and a short hash;',
    'the texts follow at the end, each written once.',
    '',
    LIBMPV,
    `The interface (npm packages, ${npm.length})`,
    '='.repeat(`The interface (npm packages, ${npm.length})`.length),
    '',
    npmBlocks.join('\n\n'),
    '',
    `The app (Rust crates, ${cargo.length})`,
    '='.repeat(`The app (Rust crates, ${cargo.length})`.length),
    '',
    cargoBlocks.join('\n\n'),
    '',
    'Licence texts',
    '=============',
    '',
    [...texts.values()].join('\n\n\n'),
    '',
  ].join('\n');
}

/** The LGPL text, from the copy Playwright's ffmpeg ships in node_modules (the FSF's own text, verbatim). */
function lgplText(): string {
  const browsers = join(root, 'node_modules', 'playwright-core', '.local-browsers');
  const dir = existsSync(browsers) ? readdirSync(browsers).find((d) => d.startsWith('ffmpeg-')) : undefined;
  const path = dir ? join(browsers, dir, 'COPYING.LGPLv2.1') : '';
  if (path && existsSync(path)) return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  const committed = join(outDir, 'LGPL-2.1.txt');
  if (existsSync(committed)) return readFileSync(committed, 'utf8').replace(/\r\n/g, '\n');
  throw new Error('No LGPL-2.1 text found: run npm run visual:install (it brings one) or restore apps/player/public/licenses/LGPL-2.1.txt');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const outputs: [string, string][] = [
    [join(outDir, 'third-party-notices.txt'), render(npmNotices(), cargoNotices())],
    [join(outDir, 'LGPL-2.1.txt'), lgplText()],
  ];
  if (process.argv.includes('--check')) {
    // Line endings aside: a Windows checkout turns the committed files' LF into CRLF.
    const stale = outputs.filter(([path, text]) => !existsSync(path) || readFileSync(path, 'utf8').replace(/\r\n/g, '\n') !== text).map(([path]) => path);
    if (stale.length) {
      console.error(`Out of date (run npm run notices): ${stale.join(', ')}`);
      process.exit(1);
    }
    console.log('The third-party notices are up to date.');
  } else {
    for (const [path, text] of outputs) writeFileSync(path, text);
    console.log(`Wrote ${outputs.map(([p]) => p).join(', ')}`);
  }
}
