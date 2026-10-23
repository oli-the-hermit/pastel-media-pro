/**
 * Visual capture of the app (Focus Space's harness, for Media Pro's shell).
 *
 * Starts the player's Vite, drives the installed Chrome through the shell with reduced motion,
 * and writes one PNG per view and theme. The theme follows the emulated system, as on a first
 * run. Compare two runs with `npm run visual:diff`.
 *
 *   npm run visual:capture                 → documentation/visual/current
 *   npm run visual:capture -- --out <dir>  → any folder (e.g. the baseline)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';
import { createServer } from 'vite';
import { strings } from '../../apps/player/src/strings.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLAYER = path.join(ROOT, 'apps/player');
const PORT = 3310;
const BASE = `http://localhost:${PORT}`;
const VIEWPORT = { width: 1440, height: 900 };
const WIDE = { width: 1920, height: 1080 };
const MINI = { width: 400, height: 152 };
const THEMES = ['dark', 'light'] as const;
/** The library's own words, which the shell shows as they are. */
const LIBRARY = { expandMenu: 'Expand menu', collapseMenu: 'Collapse menu', close: 'Close', vibrant: 'Nebula purple', muted: 'Slate', base: 'Solar lime' };

const outArg = process.argv.indexOf('--out');
const OUT_DIR = path.resolve(ROOT, outArg > -1 ? process.argv[outArg + 1] : 'documentation/visual/current');

const settle = (page: Page, ms = 450) => page.waitForTimeout(ms);

async function main() {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const vite = await createServer({ root: PLAYER, logLevel: 'error', server: { port: PORT, strictPort: true, open: false } });
  await vite.listen();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const failures: string[] = [];
  let count = 0;
  let checks = 0;

  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    context.setDefaultTimeout(5000);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));

    const shot = async (theme: string, name: string, action?: () => Promise<void>) => {
      try {
        if (action) await action();
        await settle(page);
        const dir = path.join(OUT_DIR, theme);
        fs.mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: path.join(dir, `${name}.png`) });
        count++;
      } catch (err) {
        failures.push(`${theme}/${name}: ${(err as Error).message.split('\n')[0]}`);
      }
    };

    const closeDialog = async () => {
      const close = page.getByRole('dialog').getByRole('button', { name: LIBRARY.close, exact: true });
      if (await close.count()) await close.first().click();
      await settle(page, 250);
    };
    const openAccountMenu = () => page.getByRole('button', { name: strings.account.defaultName }).click();
    const openView = (label: string) => async () => {
      await openAccountMenu();
      await page.getByRole('menuitem', { name: label, exact: true }).click();
      await page.getByRole('dialog').waitFor();
    };
    const pickAccent = (name: string) => page.getByRole('radio', { name, exact: true }).first().click();
    // The window is picked by the hash on load, so a hash change alone would keep the app.
    const openMini = async () => {
      await page.goto(`${BASE}/#mini`);
      await page.reload();
      await page.getByText(strings.mini.empty).waitFor();
    };
    const goTo = (label: string) => page.getByRole('navigation').getByRole('button', { name: label, exact: true }).click();

    // The first load waits for Vite to transform the app.
    await page.goto(BASE, { timeout: 60_000 });
    await page.getByRole('navigation').waitFor({ timeout: 60_000 });

    for (const theme of THEMES) {
      await page.emulateMedia({ colorScheme: theme });

      // ── Pages, the drawer as a rail ──
      for (const [i, [key, { label }]] of Object.entries(strings.pages).entries()) {
        await shot(theme, `1${i}-page-${key}`, () => goTo(label));
      }
      await goTo(strings.pages.home.label);
      await page.mouse.move(0, 0);

      // ── The account menu and its views ──
      await shot(theme, '20-account-menu', openAccountMenu);
      await page.keyboard.press('Escape');
      await shot(theme, '21-profile', openView(strings.account.profile));
      await closeDialog();
      await shot(theme, '22-appearance', openView(strings.account.appearance));
      await shot(theme, '23-appearance-vibrant', () => pickAccent(LIBRARY.vibrant));
      await closeDialog();
      await shot(theme, '24-home-vibrant');
      await openView(strings.account.appearance)();
      await shot(theme, '25-appearance-muted', () => pickAccent(LIBRARY.muted));
      await closeDialog();
      await shot(theme, '26-home-muted');
      await openView(strings.account.appearance)();
      await pickAccent(LIBRARY.base);
      await closeDialog();
      await shot(theme, '27-settings', openView(strings.account.settings));
      await shot(theme, '28-settings-playback', () => page.getByRole('tab', { name: strings.settings.tabs.playback.label }).click());
      await closeDialog();

      // ── Help, and the toast of Switch profile (it expires, so the page is reloaded after) ──
      await shot(theme, '30-help', () => page.getByRole('button', { name: strings.topBar.help }).click());
      await closeDialog();
      await shot(theme, '31-toast', async () => {
        await openAccountMenu();
        await page.getByRole('menuitem', { name: strings.account.switchProfile }).click();
      });
      await page.reload();
      await page.getByRole('navigation').waitFor();

      // ── Wide window: the expanded drawer, then back to the rail ──
      await page.setViewportSize(WIDE);
      await shot(theme, '40-wide-rail');
      await shot(theme, '41-wide-drawer-expanded', () => page.getByRole('button', { name: LIBRARY.expandMenu }).click());
      await shot(theme, '42-wide-account-menu', openAccountMenu);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: LIBRARY.collapseMenu }).click();
      await page.setViewportSize(VIEWPORT);

      // ── The mini player window's page ──
      await page.setViewportSize(MINI);
      await shot(theme, '50-mini', openMini);
      await page.setViewportSize(VIEWPORT);
      await page.goto(BASE);
      await page.reload();
      await page.getByRole('navigation').waitFor();
    }

    // ── Behavior checks ──
    const check = async (name: string, fn: () => Promise<boolean>) => {
      checks++;
      try { if (!(await fn())) failures.push(`check: ${name}`); } catch (err) { failures.push(`check: ${name}: ${(err as Error).message.split('\n')[0]}`); }
    };
    await check('The look and the drawer survive a reload', async () => {
      await openView(strings.account.appearance)();
      await page.getByRole('radio', { name: 'Light', exact: true }).click();
      await pickAccent(LIBRARY.vibrant);
      await closeDialog();
      await page.setViewportSize(WIDE);
      await page.getByRole('button', { name: LIBRARY.expandMenu }).click();
      await page.reload();
      await page.getByRole('navigation').waitFor();
      const kept = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        accent: document.documentElement.style.getPropertyValue('--ps-accent'),
      }));
      const expanded = await page.getByRole('button', { name: LIBRARY.collapseMenu }).count();
      await page.evaluate(() => localStorage.clear());
      await page.setViewportSize(VIEWPORT);
      await page.reload();
      return kept.theme === 'light' && kept.accent !== '' && expanded === 1;
    });
    await check('The mini player page paints in the remembered look', async () => {
      await page.evaluate(() => {
        localStorage.setItem('pastelmedia_theme_cache', 'dark');
        localStorage.setItem('pastelmedia_accent_cache', 'pulsar-pink');
      });
      await openMini();
      const look = await page.evaluate(() => ({
        theme: document.documentElement.dataset.theme,
        accent: document.documentElement.style.getPropertyValue('--ps-accent'),
      }));
      await page.evaluate(() => localStorage.clear());
      return look.theme === 'dark' && look.accent === '#FD77AA';
    });
    await check('No errors in the console', async () => errors.length === 0);
    if (errors.length) failures.push(...errors.map((e) => `console: ${e}`));
  } finally {
    await browser.close();
    await vite.close();
  }

  console.log(`Captured ${count} views and ran ${checks} behavior checks into ${path.relative(ROOT, OUT_DIR)}`);
  if (failures.length) {
    console.log(`\n${failures.length} failed:`);
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

await main();
