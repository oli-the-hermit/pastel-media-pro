/**
 * The web version's test library, for the dev server only: when the server starts, the desktop app's own scanner
 * (`library-export`, the Rust `test-media` feature) reads the repo's `media_to_test` folder (or PASTEL_TEST_MEDIA);
 * the server then hands the browser the library, the album covers and the files under /__test-media/. A production
 * build has none of this. Read-only: nothing is written to the folder.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const TAURI_DIR = path.join(REPO, 'apps', 'player', 'src-tauri');
const CACHE = path.join(REPO, 'node_modules', '.cache', 'pastel-test-media');
const BASE = '/__test-media/';

const TYPES: Record<string, string> = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', wma: 'audio/x-ms-wma', mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
  mov: 'video/quicktime', avi: 'video/x-msvideo', ts: 'video/mp2t', wmv: 'video/x-ms-wmv', jpg: 'image/jpeg',
};

interface Exported {
  tracks: { path: string }[];
  albums: { id: string; cover?: string }[];
  movies: { path: string }[];
  series: { episodes: { path: string }[] }[];
}

function runExport(root: string, log: (m: string) => void): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('cargo', ['run', '--quiet', '--features', 'test-media', '--bin', 'library-export', '--', root, CACHE], { cwd: TAURI_DIR });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      log(code === 0 ? `test library: ${out.trim()}` : `test library: the export failed (${code})\n${out}`);
      resolve(code === 0);
    });
  });
}

/** A file path from the scanner → its URL on this server (relative to the folder, each segment encoded). */
function fileUrl(root: string, file: string): string {
  const rel = path.relative(root, file.replace(/^\\\\\?\\/, ''));
  return BASE + 'file/' + rel.split(path.sep).map(encodeURIComponent).join('/');
}

function sendFile(req: IncomingMessage, res: ServerResponse, file: string): void {
  const size = fs.statSync(file).size;
  const type = TYPES[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', type);
  if (!range) {
    res.setHeader('Content-Length', size);
    fs.createReadStream(file).pipe(res);
    return;
  }
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${size}`);
    res.end();
    return;
  }
  res.statusCode = 206;
  res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(file, { start, end }).pipe(res);
}

/** The folder to read, or nothing: PASTEL_TEST_MEDIA=off turns it off (the visual harness does, to keep its pages empty). */
function testRoot(): string | null {
  if (process.env.PASTEL_TEST_MEDIA === 'off') return null;
  const root = path.resolve(process.env.PASTEL_TEST_MEDIA ?? path.join(REPO, 'media_to_test'));
  return fs.existsSync(root) ? root : null;
}

export function testMedia(): Plugin {
  return {
    name: 'pastel-test-media',
    apply: 'serve',
    // Tells the page whether to ask for a test library (otherwise it shows the empty pages at once).
    config: () => ({ define: { 'import.meta.env.VITE_TEST_MEDIA': JSON.stringify(testRoot() ? '1' : '') } }),
    configureServer(server) {
      const root = testRoot();
      if (!root) return;
      const log = (m: string) => server.config.logger.info(m);
      const ready = runExport(root, log);

      server.middlewares.use(BASE, async (req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0]);
        try {
          if (url === '/library.json') {
            if (!(await ready)) return next();
            const lib = JSON.parse(fs.readFileSync(path.join(CACHE, 'library.json'), 'utf8')) as Exported;
            for (const t of lib.tracks) t.path = fileUrl(root, t.path);
            for (const v of [...lib.movies, ...lib.series.flatMap((s) => s.episodes)]) v.path = fileUrl(root, v.path);
            for (const a of lib.albums) if (fs.existsSync(path.join(CACHE, 'covers', `${a.id}.jpg`))) a.cover = `${BASE}cover/${a.id}.jpg`;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify({ ...lib, root }));
            return;
          }
          const cover = /^\/cover\/(a\d+)\.jpg$/.exec(url);
          if (cover) return sendFile(req, res, path.join(CACHE, 'covers', `${cover[1]}.jpg`));
          if (url.startsWith('/file/')) {
            const file = path.resolve(root, url.slice('/file/'.length));
            // Only files inside the test folder.
            if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
              res.statusCode = 404;
              res.end();
              return;
            }
            return sendFile(req, res, file);
          }
        } catch {
          res.statusCode = 500;
          res.end();
          return;
        }
        next();
      });
    },
  };
}
