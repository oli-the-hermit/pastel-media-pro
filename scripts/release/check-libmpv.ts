// Checks that lib/libmpv-2.dll is the pinned LGPL build before an installer bundles it (lib/libmpv.json).
// The DLL is git-ignored (101 MB), so a fresh clone has none, and a different build could be GPL: the release
// and test installers run this first and stop on any mismatch.
// Usage: node scripts/release/check-libmpv.ts
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LibmpvPin {
  file: string;
  sha256: string;
  size: number;
  archive: { name: string; sha256: string; from: string };
}

export const libDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lib');

export function readPin(dir = libDir): LibmpvPin {
  return JSON.parse(readFileSync(join(dir, 'libmpv.json'), 'utf8')) as LibmpvPin;
}

/** Null when the DLL in `dir` matches the pin, else what is wrong and how to fix it. */
export function checkLibmpv(dir = libDir, pin = readPin(dir)): string | null {
  const path = join(dir, pin.file);
  const fetch = `Extract ${pin.file} from ${pin.archive.name} (${pin.archive.from}, sha256 ${pin.archive.sha256}) into lib/.`;
  if (!existsSync(path)) return `${path} is missing. ${fetch}`;
  const data = readFileSync(path);
  const sha256 = createHash('sha256').update(data).digest('hex');
  if (sha256 !== pin.sha256) return `${path} is not the pinned LGPL build (sha256 ${sha256}, expected ${pin.sha256}). ${fetch}`;
  return null;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problem = checkLibmpv();
  if (problem) {
    console.error(problem);
    process.exit(1);
  }
  console.log('libmpv-2.dll matches the pinned LGPL build.');
}
