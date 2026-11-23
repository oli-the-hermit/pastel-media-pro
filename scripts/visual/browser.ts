/**
 * The browser the visual harness drives: Playwright's Chromium, kept inside this repo's node_modules
 * (`npm run visual:install`), not in the user's AppData. Some hosts see a virtualised AppData, where Windows can't
 * load the browser's side-by-side manifest ("side-by-side configuration is incorrect").
 */
import { spawnSync } from 'node:child_process';
import type { Browser } from 'playwright-core';

// Playwright reads this when it loads, so it is set before the dynamic import below.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= '0';

export async function launchChromium(): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  return chromium.launch({ channel: 'chromium', headless: true });
}

if (process.argv.includes('--install')) {
  const r = spawnSync('npx', ['playwright-core', 'install', 'chromium'], { stdio: 'inherit', shell: true, env: process.env });
  process.exit(r.status ?? 1);
}
