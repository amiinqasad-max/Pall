/**
 * Menu frame-rate check.
 *
 * The 2.5D menu system leans on always-on animation — drifting cards, a
 * breathing play button, a parallax backdrop — so the claim that it holds 60fps
 * needs measuring rather than asserting. Runs with 4x CPU throttling, which is
 * roughly a mid-range Android against this container's core.
 *
 * Reports the 95th-percentile frame interval on the home screen, both idle and
 * while the parallax is being driven by a moving pointer.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173';
const THROTTLE = Number(process.env.THROTTLE ?? 4);
/** A 60fps frame is 16.7ms; anything under 20ms at p95 is a solid 60. */
const BUDGET_MS = Number(process.env.BUDGET_MS ?? 20);

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
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);

const collect = page.locator('button', { hasText: /Collect .* coins/ });
if (await collect.count()) {
  await collect.first().click({ force: true });
  await page.waitForTimeout(600);
  const cont = page.locator('button', { hasText: /^Continue$/ });
  if (await cont.count()) await cont.first().click({ force: true });
}
await page.waitForTimeout(800);

await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

/** Samples frame intervals for `ms` and returns p50/p95/worst. */
const sample = async (ms) =>
  page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        const gaps = [];
        let last = performance.now();
        const end = last + duration;
        const step = (now) => {
          gaps.push(now - last);
          last = now;
          if (now < end) requestAnimationFrame(step);
          else {
            gaps.sort((a, b) => a - b);
            resolve({
              frames: gaps.length,
              p50: +gaps[Math.floor(gaps.length * 0.5)].toFixed(2),
              p95: +gaps[Math.floor(gaps.length * 0.95)].toFixed(2),
              worst: +gaps[gaps.length - 1].toFixed(2),
            });
          }
        };
        requestAnimationFrame(step);
      }),
    ms,
  );

const idle = await sample(3000);

// Now drive the parallax: a pointer sweeping the screen keeps the backdrop's
// rAF loop hot for the whole sample, which is the worst case for the menus.
const moving = await Promise.all([
  sample(3000),
  (async () => {
    for (let i = 0; i < 60; i++) {
      await page.mouse.move(40 + (i % 20) * 15, 200 + ((i * 7) % 400));
      await page.waitForTimeout(45);
    }
  })(),
]).then(([result]) => result);

console.log(`CPU throttle: ${THROTTLE}x`);
console.log('home, idle   ', idle);
console.log('home, parallax', moving);

const worst = Math.max(idle.p95, moving.p95);
const ok = worst <= BUDGET_MS;
console.log(`\n${ok ? 'ok' : 'FAIL'}  p95 frame ${worst.toFixed(2)}ms (budget ${BUDGET_MS}ms)`);
await browser.close();
process.exit(ok ? 0 : 1);
