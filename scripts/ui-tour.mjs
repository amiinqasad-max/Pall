/**
 * UI tour: walk every menu screen in a phone-sized Chromium and capture a shot
 * of each, so a design change can be reviewed as pixels rather than as CSS.
 *
 * Deliberately never enters a run — the game itself has its own smoke test, and
 * booting WebGL under swiftshader here would only add flake.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT ?? './.uitour';
mkdirSync(OUT, { recursive: true });
const BASE = process.env.BASE ?? 'http://127.0.0.1:4173';

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

const errors = [];
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`[console] ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));

// Cards drift continuously by design, so Playwright's stability check would
// wait forever. The drift is 4px over 3s — nothing a finger would miss.
const tap = async (locator) => locator.click({ force: true });

const shot = async (name) => {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`— ${name}`);
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);

// The daily reward pops on home; capture it before dismissing it.
const collect = page.locator('button', { hasText: /Collect .* coins/ });
if (await collect.count()) {
  await shot('00-daily-reward');
  await tap(collect.first());
  await page.waitForTimeout(700);
  await shot('01-daily-reward-claimed');
  const cont = page.locator('button', { hasText: /^Continue$/ });
  if (await cont.count()) await tap(cont.first());
  await page.waitForTimeout(500);
}

await shot('02-home');

const nav = async (label, name) => {
  const item = page.locator('.nav__item', { hasText: label });
  if (!(await item.count())) {
    errors.push(`nav item missing: ${label}`);
    return;
  }
  await tap(item.first());
  await shot(name);
};

await nav('Store', '03-store');
await nav('Missions', '04-missions');
await nav('Ranks', '05-leaderboard');
await nav('Profile', '06-profile');

// Settings hangs off the profile screen's gear (the back arrow is the other
// icon button on that header, so select by label rather than by position).
const gear = page.locator('[aria-label="Settings"]').first();
if (await gear.count()) {
  await tap(gear);
  await shot('07-settings');
}

// Daily challenge screen, reached from home ('Play' is the home tab).
// Settings has no nav dock either.
const outOfSettings = page.locator('[aria-label="Back"]').first();
if (await outOfSettings.count()) {
  await tap(outOfSettings);
  await page.waitForTimeout(400);
}
await tap(page.locator('.nav__item', { hasText: 'Play' }).first());
await page.waitForTimeout(500);
const daily = page.locator('button', { hasText: /challenge|Claim reward/ });
if (await daily.count()) {
  await tap(daily.first());
  await shot('08-daily');
}

// The daily screen has no nav dock, so leave it by its back control first.
const back = page.locator('[aria-label="Back"]').first();
if (await back.count()) {
  await tap(back);
  await page.waitForTimeout(500);
}

// A store purchase sheet, to check the overlay material.
await tap(page.locator('.nav__item', { hasText: 'Store' }).first());
await page.waitForTimeout(500);
const locked = page.locator('.cosmetic--locked').first();
if (await locked.count()) {
  await tap(locked);
  await shot('09-store-sheet');
}

console.log(errors.length ? `\n${errors.length} error(s):\n${errors.join('\n')}` : '\nno console errors');
await browser.close();
process.exit(errors.length ? 1 : 0);
