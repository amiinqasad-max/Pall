/**
 * In-browser regression check for the Championship's navigation reachability.
 *
 * This exists because the bug it catches is invisible to every other check:
 * the Home card that is the *only* entry point into ChampionshipScreen /
 * ChampionshipFinalScreen used to render nothing at all whenever there was no
 * active challenge (or no backend configured) — a silent, structural "the
 * whole feature is gone" regression that a build/typecheck pass cannot see
 * and a human has to notice by eye. This asserts the card is always visible
 * in some real state instead.
 *
 * Requires `npm run preview` (a production build — this reads real rendered
 * text, not the dev-only debug handle the touch/terrain scripts use).
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173';
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE || undefined,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`[console] ${m.text()}`); });

let failures = 0;
const check = (ok, message) => {
  if (ok) console.log(`  ok    ${message}`);
  else { failures++; console.error(`  FAIL  ${message}`); }
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// Dismiss the daily-reward modal if it's showing — same pattern smoke.mjs /
// verify-control.mjs already use; unrelated to the Championship UI itself.
const collect = page.locator('button', { hasText: /Collect .* coins/ });
if (await collect.count()) {
  await collect.first().click();
  await page.waitForTimeout(500);
  const cont = page.locator('button', { hasText: /^Continue$/ });
  if (await cont.count()) await cont.first().click();
  await page.waitForTimeout(400);
}

console.log('\nHome screen — Championship card');
const homeText = await page.locator('.screen').innerText();
check(homeText.includes('🏆'), 'Home renders a Championship-branded card (🏆 present)');
check(
  homeText.includes('No Daily Championship is active right now') ||
    homeText.includes('Loading') ||
    homeText.includes("Couldn't load"),
  'Home shows a real, visible Championship state (not silently absent)',
);
check(!homeText.includes('undefined') && !homeText.includes('NaN'), 'no raw undefined/NaN leaked into the card text');

console.log('\nMissions screen — secondary Championship entry point');
await page.locator('.nav__item', { hasText: 'Missions' }).click();
await page.waitForTimeout(400);
const missionsText = await page.locator('.screen').innerText();
check(missionsText.includes('🏆'), 'Missions screen also shows the Championship card');

console.log('\nBack to Home, into the qualification screen');
await page.locator('.nav__item', { hasText: 'Play' }).click();
await page.waitForTimeout(300);
// The card's own button text depends on state; try the two most likely labels.
const btn = page.locator('button', { hasText: /Play Challenge|Play Free Challenge|Continue Championship|View results/ });
if (await btn.count()) {
  await btn.first().click();
  await page.waitForTimeout(400);
  const champText = await page.locator('.screen').innerText();
  check(champText.includes('🏆'), 'Tapping through from Home reaches a real Championship screen');
  console.log('  (reached screen text)', champText.slice(0, 120).replace(/\n/g, ' | '));
} else {
  console.log('  (no active challenge in this environment — card correctly shows a static no-challenge message, nothing to tap into)');
}

console.log('\nerrors:', errors.length ? errors.slice(0, 5) : 'none');
await browser.close();
if (failures > 0 || errors.length > 0) {
  console.error(`\n${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\nall Championship UI checks passed\n');
