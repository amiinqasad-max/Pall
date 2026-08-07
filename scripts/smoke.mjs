/**
 * Smoke test: boot the built game in a mobile-sized Chromium, play a run with
 * synthetic swipes, and report console errors, gameplay telemetry and shots.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT ?? './.smoke';
mkdirSync(OUT, { recursive: true });

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173';

// PLAYWRIGHT_EXECUTABLE lets CI point at a preinstalled browser; otherwise
// Playwright resolves its own download.
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
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}\n${err.stack ?? ''}`));

const shot = async (name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`— ${name}`);
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1600);

// Dismiss the daily reward.
const collect = page.locator('button', { hasText: /Collect .* coins/ });
if (await collect.count()) {
  await collect.first().click();
  await page.waitForTimeout(500);
  const cont = page.locator('button', { hasText: /^Continue$/ });
  if (await cont.count()) await cont.first().click();
  await page.waitForTimeout(400);
}
await shot('01-home');

await page.locator('.playbtn').click();
await page.waitForTimeout(900);
await shot('02-loading-or-countdown');

await page.waitForTimeout(2600); // engine chunk + 3 x 600ms countdown

const inOverlay = () => page.locator('.overlay').count().then((n) => n > 0);

/** Holds and drags to steer, the way the game is actually played. */
const steer = async (dx) => {
  const cx = 195;
  const cy = 620;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy, { steps: 5 });
  await page.waitForTimeout(180);
  await page.mouse.up();
};

/** A quick tap with no travel: the jump input. */
const tap = async () => {
  await page.mouse.move(195, 500);
  await page.mouse.down();
  await page.waitForTimeout(60);
  await page.mouse.up();
};

await shot('03-playing-early');

// Play for a while, only swiping while actually in a run.
let framesPlayed = 0;
let firstDeathAtMs = null;
const runStart = Date.now();

while (Date.now() - runStart < 40_000) {
  if (await inOverlay()) {
    if (firstDeathAtMs === null) firstDeathAtMs = Date.now() - runStart;
    break;
  }
  framesPlayed++;
  if (framesPlayed === 6) await shot('04-playing-mid');
  if (framesPlayed === 14) await shot('05-playing-late');
  await steer(Math.random() > 0.5 ? -110 : 110);
  await page.waitForTimeout(500);
  if (Math.random() > 0.7) {
    await tap();
    await page.waitForTimeout(250);
  }
}

await page.waitForTimeout(600);
await shot('06-overlay');

// Read the HUD numbers that were on screen at the end.
const hud = await page.evaluate(() => {
  const score = document.querySelector('.hud__score')?.textContent ?? null;
  const overlayText = document.querySelector('.overlay')?.textContent ?? null;
  return { score, overlayText: overlayText?.slice(0, 220) ?? null };
});

// If the continue offer is up, decline it so we can see the results sheet.
const endRun = page.locator('button', { hasText: /^End run$/ });
if (await endRun.count()) {
  await endRun.first().click();
  await page.waitForTimeout(1200);
  await shot('07-results');
}

const metrics = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    domContentLoadedMs: Math.round(nav?.domContentLoadedEventEnd ?? 0),
    transferredKb: Math.round(
      performance
        .getEntriesByType('resource')
        .reduce((sum, r) => sum + (r.transferSize || 0), 0) / 1024,
    ),
    heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
  };
});

console.log('\n--- run ---');
console.log(`survived swipe-cycles: ${framesPlayed}`);
console.log(`time to first overlay: ${firstDeathAtMs === null ? '>40s (never died)' : `${firstDeathAtMs}ms`}`);
console.log(`hud score at end: ${hud.score}`);
console.log(`overlay: ${hud.overlayText?.replace(/\s+/g, ' ').trim()}`);

console.log('\n--- metrics ---');
console.log(JSON.stringify(metrics, null, 2));

console.log('\n--- errors ---');
console.log(errors.length === 0 ? 'none' : errors.slice(0, 20).join('\n'));

await browser.close();
process.exit(errors.length > 0 ? 1 : 0);
