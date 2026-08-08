/**
 * Visual verification over hilly terrain.
 *
 * Hills only appear well past the flat opening, which is further than a bot can
 * reliably survive. This drives the dev-only debug handle to jump the run
 * forward, samples the terrain until it finds real elevation, and captures
 * frames there — plus the internal state, so the numbers can be checked against
 * what is on screen.
 *
 * Requires `npm run dev` (the handle is stripped from production builds).
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT ?? './.terrain';
const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
mkdirSync(OUT, { recursive: true });

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

// See verify-control.mjs / smoke.mjs — the play button animates continuously
// by design, so Playwright's default click-stability wait never resolves.
await page.locator('.playbtn').click({ force: true });

// Wait for the run to actually start rather than guessing at a duration: in
// dev the engine chunk loads unbundled and the countdown is 1.8s on top.
await page.waitForFunction(
  () => window.__tartan?.scene?.phase === 'running',
  undefined,
  { timeout: 30_000 },
);
await page.waitForTimeout(300);

const readState = () =>
  page.evaluate(() => {
    const s = window.__tartan?.scene;
    if (!s) return null;
    const roadY = s.road.elevationAt(s.ballZ);
    return {
      distance: Math.round(s.distance),
      ballY: +s.ballY.toFixed(2),
      ballVy: +s.ballVy.toFixed(2),
      airborne: s.airborne,
      roadElevation: +roadY.toFixed(2),
      cameraWorldY: +s.camera.worldY.toFixed(2),
      // What actually matters: the gap between the camera's ground reference
      // and the ground under the ball. Bounded => the ball stays framed.
      elevationLag: +(roadY - s.camera.worldY).toFixed(2),
      offScreenFrames: s.offScreenFrames,
      phase: s.phase,
    };
  });

/** Teleports the run forward without tearing anything down. */
const advance = (metres) =>
  page.evaluate((m) => {
    const s = window.__tartan?.scene;
    if (!s) return;
    s.ballZ += m;
    s.previousZ = s.ballZ;
    s.distance += m;
    s.camera.z = s.ballZ - 15;
    // Clear anything we teleported into so we do not die on arrival.
    for (const o of s.track.activeObstacles) if (o.z < s.ballZ + 60) o.resolved = true;
  }, metres);

const samples = [];
let captured = 0;
let worstLag = 0;
let maxElevation = 0;
let anyOffScreen = 0;

for (let step = 0; step < 26 && captured < 5; step++) {
  await advance(220);
  await page.waitForTimeout(420);

  const state = await readState();
  if (!state) break;
  samples.push(state);
  worstLag = Math.max(worstLag, Math.abs(state.elevationLag));
  maxElevation = Math.max(maxElevation, Math.abs(state.roadElevation));
  anyOffScreen += state.offScreenFrames;

  // Capture wherever the terrain is meaningfully sloped.
  if (Math.abs(state.roadElevation) > 4) {
    captured++;
    await page.screenshot({ path: `${OUT}/hill-${captured}-elev${state.roadElevation.toFixed(0)}m.png` });
    console.log(
      `  captured hill at ${state.distance}m — road ${state.roadElevation}m, camera ref ${state.cameraWorldY}m, lag ${state.elevationLag}m`,
    );
  }
  if (state.phase !== 'running') break;
}

// Jump on a slope: the camera must not move with the ball.
await page.evaluate(() => {
  const s = window.__tartan?.scene;
  if (s) {
    s.airborne = true;
    s.ballVy = 22.6;
  }
});
await page.waitForTimeout(180);
const midJump = await readState();
await page.screenshot({ path: `${OUT}/jump-apex.png` });
await page.waitForTimeout(700);
const afterLanding = await readState();

console.log('\n--- terrain samples ---');
console.table(samples);
console.log(`max |road elevation| reached: ${maxElevation.toFixed(1)} m`);
console.log(`worst camera elevation lag:   ${worstLag.toFixed(2)} m`);
console.log(`total off-screen frames:      ${anyOffScreen}`);
console.log('\nmid-jump: ', JSON.stringify(midJump));
console.log('after landing:', JSON.stringify(afterLanding));
console.log('\nerrors:', errors.length ? errors : 'none');

await browser.close();
process.exit(errors.length > 0 ? 1 : 0);
