// Points this checkout at a design system folder: node_modules/@pastel-studio/{react,desktop,tokens} become links
// to that folder's packages. The app normally links the design system beside it (../pastel-studio-theme, as
// apps/player/package.json says); a branch of it checked out elsewhere (a git worktree with components that
// aren't merged yet) is linked with this, and unlinked the same way.
//   node scripts/link-design-system.ts ../pastel-studio-theme-media   # use that folder
//   node scripts/link-design-system.ts                                # back to ../pastel-studio-theme
//   node scripts/link-design-system.ts --show                         # where the links point now
// The folder needs its own packages installed (npm ci there). Vite reads where the links point
// (apps/player/vite.config.ts), so nothing else has to be set.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCOPE = path.join(ROOT, 'node_modules', '@pastel-studio');
const PACKAGES = ['react', 'desktop', 'tokens'];
const arg = process.argv[2];

const show = () => {
  for (const name of PACKAGES) {
    const link = path.join(SCOPE, name);
    console.log(`@pastel-studio/${name} → ${fs.existsSync(link) ? fs.realpathSync(link) : '(missing)'}`);
  }
};
if (arg === '--show') {
  show();
  process.exit(0);
}

const target = path.resolve(ROOT, arg ?? '../pastel-studio-theme');
for (const name of PACKAGES) {
  const pkg = path.join(target, 'packages', name);
  if (!fs.existsSync(path.join(pkg, 'package.json'))) {
    console.error(`No design system package at ${pkg}`);
    process.exit(1);
  }
}
if (!fs.existsSync(path.join(target, 'node_modules'))) {
  console.error(`${target} has no node_modules: run "npm ci" there first.`);
  process.exit(1);
}
fs.mkdirSync(SCOPE, { recursive: true });
for (const name of PACKAGES) {
  const link = path.join(SCOPE, name);
  // A link is removed as a link: its target's files are never touched.
  if (fs.lstatSync(link, { throwIfNoEntry: false })) fs.rmSync(link, { recursive: false, force: true });
  fs.symlinkSync(path.join(target, 'packages', name), link, 'junction');
}
show();
