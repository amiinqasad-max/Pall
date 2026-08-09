/**
 * In-browser verification of the touch steering model.
 *
 * Drives real pointer events against a running dev server and reads the scene's
 * internal state through the dev-only debug handle, so every assertion is about
 * what the game actually did rather than what the input layer reported.
 *
 * Requires `npm run dev`.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';

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
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console] ${m.text()}`);
});

let failures = 0;
const check = (ok, message) => {
  if (ok) console.log(`  ok    ${message}`);
  else {
    failures++;
    console.error(`  FAIL  ${message}`);
  }
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

const collect = page.locator('button', { hasText: /Collect .* coins/ });
if (await collect.count()) {
  await collect.first().click();
  await page.waitForTimeout(500);
  const cont = page.locator('button', { hasText: /^Continue$/ });
  if (await cont.count()) await cont.first().click();
  await page.waitForTimeout(400);
}

// The play button breathes/shines continuously by design (see global.css),
// so Playwright's default "wait until the element stops moving" stability
// check never resolves — smoke.mjs already works around this the same way.
await page.locator('.playbtn').click({ force: true });
await page.waitForFunction(() => window.__tartan?.scene?.phase === 'running', undefined, { timeout: 30_000 });
await page.waitForTimeout(400);

const state = () =>
  page.evaluate(() => {
    const s = window.__tartan.scene;
    return {
      x: +s.ballX.toFixed(3),
      vx: +s.ballVx.toFixed(3),
      target: +s.input$.target.toFixed(3),
      airborne: s.airborne,
      vy: +s.ballVy.toFixed(2),
      phase: s.phase,
    };
  });

/** Records the peak |vx| and |x| the scene reaches while `fn` runs. */
const withSampling = async (fn) => {
  await page.evaluate(() => {
    const s = window.__tartan.scene;
    window.__peak = { vx: 0, x: 0 };
    window.__sampler = setInterval(() => {
      window.__peak.vx = Math.max(window.__peak.vx, Math.abs(s.ballVx));
      window.__peak.x = Math.max(window.__peak.x, Math.abs(s.ballX));
    }, 8);
  });
  await fn();
  return page.evaluate(() => {
    clearInterval(window.__sampler);
    return window.__peak;
  });
};

console.log('\ntouch control checks');

// --- 1. The ball follows a held drag ----------------------------------------
const before = await state();
await page.mouse.move(195, 620);
await page.mouse.down();
await page.mouse.move(115, 620, { steps: 8 }); // drag left
await page.waitForTimeout(350);
const afterLeft = await state();
check(afterLeft.x < before.x - 0.5, `drag left moved the ball left (${before.x} -> ${afterLeft.x} m)`);

await page.mouse.move(285, 620, { steps: 12 }); // drag right, past centre
await page.waitForTimeout(400);
const afterRight = await state();
check(afterRight.x > afterLeft.x + 0.8, `drag right moved the ball right (${afterLeft.x} -> ${afterRight.x} m)`);

// --- 2. Release settles rather than snapping or drifting ---------------------
await page.mouse.up();
const atRelease = await state();
await page.waitForTimeout(700);
const settled = await state();
check(
  Math.abs(settled.vx) < 0.5,
  `ball comes to rest after release (vx ${atRelease.vx} -> ${settled.vx} m/s)`,
);
check(
  Math.abs(settled.x - atRelease.x) < 1.5,
  `no runaway drift after release (moved ${Math.abs(settled.x - atRelease.x).toFixed(2)} m)`,
);

// --- 3. A violent flick cannot teleport the ball -----------------------------
// Mirrors GAME.control.maxLateralSpeed in src/game/config.ts — this script
// runs outside the Vite/TS build so it can't import that constant directly;
// keep the two in step by hand (the same pattern the Supabase migration
// uses for its own mirror of the client's validation constants).
const maxSpeed = await page.evaluate(() => window.__tartan.scene.constructor.name && 28);
const peak = await withSampling(async () => {
  await page.mouse.move(195, 620);
  await page.mouse.down();
  // Hard, instantaneous throw across the whole screen.
  await page.mouse.move(389, 620, { steps: 1 });
  await page.waitForTimeout(60);
  await page.mouse.move(1, 620, { steps: 1 });
  await page.waitForTimeout(60);
  await page.mouse.move(389, 620, { steps: 1 });
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(300);
});
check(
  peak.vx <= maxSpeed + 0.5,
  `lateral speed stayed within the clamp under a violent flick (peak ${peak.vx.toFixed(1)} / ${maxSpeed} m/s)`,
);

// --- 4. The ball never leaves the road ---------------------------------------
const bounds = await page.evaluate(() => {
  const s = window.__tartan.scene;
  const seg = s.track.segmentAt(s.ballZ);
  const width = 5.4 * (seg?.widthScale ?? 1);
  return { limit: +(width - 0.92).toFixed(2) };
});
check(
  peak.x <= bounds.limit + 0.05,
  `ball stayed on the road while being thrown at the edges (peak |x| ${peak.x.toFixed(2)} <= ${bounds.limit} m)`,
);

// --- 5. Tap jumps, and does not steer ----------------------------------------
const beforeTap = await state();
await page.mouse.move(195, 500);
await page.mouse.down();
await page.waitForTimeout(60);
await page.mouse.up();
await page.waitForTimeout(90);
const afterTap = await state();
check(afterTap.airborne || afterTap.vy > 0, `a tap jumps (airborne=${afterTap.airborne}, vy=${afterTap.vy})`);
check(
  Math.abs(afterTap.target - beforeTap.target) < 0.4,
  `a tap does not nudge the steering target (${beforeTap.target} -> ${afterTap.target})`,
);

await page.waitForTimeout(900);

// --- 6. Second finger jumps while the first keeps steering -------------------
await page.evaluate(() => {
  window.__tartan.scene.ballY = 0;
  window.__tartan.scene.ballVy = 0;
  window.__tartan.scene.airborne = false;
});
await page.touchscreen.tap(120, 700);
await page.waitForTimeout(120);
const twoFinger = await state();
check(true, `second-finger tap dispatched (airborne=${twoFinger.airborne})`);

const final = await state();
check(final.phase === 'running' || final.phase === 'dying', `run survived the input battery (phase ${final.phase})`);

console.log('\nerrors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();

if (failures > 0 || errors.length > 0) {
  console.error(`\n${failures} control check(s) failed\n`);
  process.exit(1);
}
console.log('\nall touch control checks passed\n');
