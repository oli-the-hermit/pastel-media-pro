/**
 * A check of long lists in a real layout, with no window on screen: the Songs view and the player's queue of a
 * large test library must draw only the rows near the screen and follow the scroll.
 *
 * Usage: start the web build on a folder of many songs (PASTEL_TEST_MEDIA=<folder> npm run dev -w @pastel-media/player
 * -- --port 3330), then: node scripts/visual/long-lists.ts [http://localhost:3330]
 */
import { launchChromium } from './browser.ts';

const url = process.argv[2] ?? 'http://localhost:3330';
const browser = await launchChromium();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const fail = (why: string): never => {
  console.error(`FAILED: ${why}`);
  process.exitCode = 1;
  throw new Error(why);
};

try {
  await page.goto(url);
  await page.getByRole('button', { name: 'Music', exact: true }).click();
  const started = Date.now();
  await page.getByRole('radio', { name: 'Songs' }).click({ timeout: 120_000 });
  const rows = page.locator('.ps-track-list li[aria-label]');
  await rows.first().waitFor();
  const shownIn = Date.now() - started;
  const total = Number(await rows.first().getAttribute('aria-setsize'));
  const drawn = await rows.count();
  console.log(`Songs: ${total.toLocaleString()} songs, ${drawn} rows drawn, first rows after ${shownIn} ms`);
  if (!(total > 1000)) fail('this check needs a library of more than a thousand songs');
  if (drawn > 120) fail(`${drawn} rows are drawn at once`);

  // Half way down, then the end: other rows, in the right place
  const scroller = page.locator('.ps-app-shell-main');
  const place = async () => ({
    first: Number(await rows.first().getAttribute('aria-posinset')),
    last: Number(await rows.last().getAttribute('aria-posinset')),
    count: await rows.count(),
    top: await scroller.evaluate((el) => Math.round(el.scrollTop)),
  });
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
  await page.waitForTimeout(400);
  const middle = await place();
  console.log(`Half way: rows ${middle.first} to ${middle.last} (${middle.count} drawn), scroll at ${middle.top}`);
  if (Math.abs(middle.first - total / 2) > 200) fail(`half way down shows row ${middle.first}`);
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(400);
  const end = await place();
  console.log(`The end: rows ${end.first} to ${end.last} (${end.count} drawn)`);
  if (end.last !== total) fail(`the end shows row ${end.last}, not ${total}`);
  const onScreen = await rows.last().evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= window.innerHeight + 1;
  });
  if (!onScreen) fail('the last row is not on screen at the end of the list');

  // A wheel's worth at a time: the scroll stays where it is put
  await scroller.evaluate((el) => (el.scrollTop = 30_000));
  await page.waitForTimeout(200);
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(700, 500);
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
  const wheeled = await place();
  console.log(`After twelve wheel steps from 30,000: scroll at ${wheeled.top}, rows ${wheeled.first} to ${wheeled.last}`);
  if (Math.abs(wheeled.top - 34_800) > 600) fail(`the scroll is at ${wheeled.top} after wheeling 4,800 down from 30,000`);

  // The search narrows the list, and the sort turns it round
  await page.getByPlaceholder(/Search/).first().fill('Song 19999');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  console.log(`Search "Song 19999": ${await rows.count()} row(s)`);
  if ((await rows.count()) !== 1) fail('the search did not narrow the list to one song');
  await page.getByPlaceholder(/Search/).first().fill('');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  // Play the first song: the whole library is the queue
  await scroller.evaluate((el) => (el.scrollTop = 0));
  await page.waitForTimeout(300);
  const before = Date.now();
  await rows.first().dblclick();
  await page.getByRole('button', { name: 'Player', exact: true }).click();
  const queued = page.locator('.ps-play-queue li');
  await queued.first().waitFor();
  const queueRows = await queued.count();
  console.log(`Queue: ${queueRows} rows drawn for a queue of ${total.toLocaleString()}, shown ${Date.now() - before} ms after the double click`);
  if (queueRows > 160) fail(`${queueRows} queue rows are drawn at once`);
  // Play next from far down the library reaches the top of the queue
  await page.getByRole('button', { name: 'Music', exact: true }).click();
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForTimeout(400);
  const lastName = (await rows.last().getAttribute('aria-label')) ?? '';
  // A row's tools show when the pointer is on it
  await rows.last().hover();
  await rows.last().getByRole('button', { name: /More actions/ }).click();
  await page.getByRole('menuitem', { name: 'Play next' }).click();
  await page.getByRole('button', { name: 'Player', exact: true }).click();
  await page.waitForTimeout(400);
  const upNext = await page.locator('.ps-play-queue li').nth(1).innerText();
  console.log(`Play next: "${lastName.split(',')[0]}" is now first in Up next: ${upNext.includes(lastName.split(',')[0])}`);
  if (!upNext.includes(lastName.split(',')[0])) fail('Play next did not put the song first in Up next');
  console.log('Long lists: all checks passed.');
} finally {
  await browser.close();
}
