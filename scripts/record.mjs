/**
 * Records a playthrough of the running dev/preview server to video.
 *
 * Plays with a simple "keep moving" heuristic so the clip shows real gameplay
 * rather than an immediate death, and restarts once so the loop is visible.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT ?? './.recording';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  recordVideo: { dir: OUT, size: { width: 390, height: 844 } },
});

const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

// Daily reward modal.
const collect = page.locator('button', { hasText: /Collect .* coins/ });
if (await collect.count()) {
  await collect.first().click();
  await page.waitForTimeout(700);
  const cont = page.locator('button', { hasText: /^Continue$/ });
  if (await cont.count()) await cont.first().click();
  await page.waitForTimeout(800);
}

await page.waitForTimeout(1200);
await page.locator('.playbtn').click();
await page.waitForTimeout(3800); // engine chunk + countdown

const swipe = async (dx, dy) => {
  await page.mouse.move(195, 620);
  await page.mouse.down();
  await page.mouse.move(195 + dx, 620 + dy, { steps: 4 });
  await page.mouse.up();
};

const overlayUp = () => page.locator('.overlay').count().then((n) => n > 0);

// Weave across the lanes with the occasional jump.
const start = Date.now();
let i = 0;
while (Date.now() - start < 26_000) {
  if (await overlayUp()) break;
  i++;
  await swipe(i % 3 === 0 ? 110 : -110, 0);
  await page.waitForTimeout(520);
  if (i % 5 === 0) {
    await swipe(0, -110);
    await page.waitForTimeout(360);
  }
}

await page.waitForTimeout(1800);

// Show the results sheet, then the store, so the clip covers the loop.
const endRun = page.locator('button', { hasText: /^End run$/ });
if (await endRun.count()) {
  await endRun.first().click();
  await page.waitForTimeout(2000);
}
const home = page.locator('button', { hasText: /^Home$/ });
if (await home.count()) {
  await home.first().click();
  await page.waitForTimeout(1800);
}
const storeTab = page.locator('.nav__item', { hasText: 'Store' });
if (await storeTab.count()) {
  await storeTab.first().click();
  await page.waitForTimeout(2200);
}
const missionsTab = page.locator('.nav__item', { hasText: 'Missions' });
if (await missionsTab.count()) {
  await missionsTab.first().click();
  await page.waitForTimeout(1800);
}

console.log('errors:', errors.length ? errors : 'none');
await context.close();
await browser.close();
console.log('video written to', OUT);
