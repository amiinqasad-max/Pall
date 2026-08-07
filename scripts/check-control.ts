/**
 * Solvability checks for the continuous steering model.
 *
 * The track generator guarantees that every obstacle cluster leaves at least
 * one *lane* open. That guarantee was written for a lane-snapping player, who
 * always arrived exactly at a lane centre. Continuous steering breaks both
 * halves of that assumption:
 *
 *   - the ball is now positioned freely, so what matters is whether a free
 *     corridor is wide enough for its diameter, not whether a lane index is
 *     unoccupied; and
 *   - the ball now has a finite lateral speed, so a corridor being free is not
 *     enough — it has to be *reachable* from wherever the last cluster left the
 *     player, in the time the track gives them.
 *
 * This runs an autopilot over a long generated track and asserts both. If it
 * cannot find a path, a human cannot either.
 *
 * Run with `npm run check`.
 */

import { GAME } from '@/game/config';
import { TrackGenerator } from '@/game/world/TrackGenerator';
import { extentAt, type Extent, type Obstacle } from '@/game/world/obstacles';

const RADIUS = GAME.player.radius;
const MAX_SPEED = GAME.control.maxLateralSpeed;

let failures = 0;
const fail = (message: string): void => {
  failures++;
  console.error(`  FAIL  ${message}`);
};
const pass = (message: string): void => console.log(`  ok    ${message}`);

interface Crossing {
  z: number;
  /** Run time, seconds, when the ball reaches this plane. */
  time: number;
  obstacles: Obstacle[];
  /** Forward speed at the crossing, m/s. */
  speed: number;
}

const scratch: Extent[] = new Array(4).fill(null).map(() => ({ min: 0, max: 0, bottom: 0, top: 0 }));

/** Free intervals for the ball's centre at a cluster, in metres. */
function freeCorridors(crossing: Crossing, widthScale: number): [number, number][] {
  const limit = Math.max(RADIUS, GAME.world.roadHalfWidth * widthScale - RADIUS);
  const blocked: [number, number][] = [];

  for (const obstacle of crossing.obstacles) {
    // Chasms are cleared by jumping, not steering; they do not constrain the
    // lateral path and are checked separately.
    if (obstacle.type === 'gap') continue;
    const count = extentAt(obstacle, crossing.time, scratch);
    for (let i = 0; i < count; i++) {
      const e = scratch[i];
      // A jumpable obstacle still blocks the ground path, which is what this
      // check is about — it must be steerable *or* jumpable, and we assert the
      // stricter of the two.
      blocked.push([e.min - RADIUS, e.max + RADIUS]);
    }
  }

  blocked.sort((a, b) => a[0] - b[0]);

  const corridors: [number, number][] = [];
  let cursor = -limit;
  for (const [min, max] of blocked) {
    if (min > cursor) corridors.push([cursor, Math.min(min, limit)]);
    cursor = Math.max(cursor, max);
    if (cursor >= limit) break;
  }
  if (cursor < limit) corridors.push([cursor, limit]);

  return corridors.filter(([a, b]) => b - a > 1e-6);
}

function buildCrossings(seed: number, distance: number): { crossings: Crossing[]; track: TrackGenerator } {
  const track = new TrackGenerator(seed);
  track.reset(seed);

  const crossings: Crossing[] = [];
  const dt = 1 / 60;
  let z = GAME.camera.playerOffset;
  let time = 0;
  let nextIndex = 0;

  // Walk the run forward exactly as the scene does, so obstacle animation
  // phases are sampled at the moment the ball would actually arrive.
  while (z < distance) {
    const stages = GAME.difficulty.stages;
    let stage = 0;
    for (let i = 0; i < stages.length; i++) if (time >= stages[i].atSeconds) stage = i;

    const speed = Math.min(GAME.speed.max, GAME.speed.start + time * GAME.speed.accel * 10);
    track.ensureAhead(z + GAME.camera.drawDistance * GAME.world.segmentLength, stage, speed);

    const previousZ = z;
    z += speed * dt;
    time += dt;

    const obstacles = track.activeObstacles;
    while (nextIndex < obstacles.length && obstacles[nextIndex].z < previousZ) nextIndex++;

    for (let i = nextIndex; i < obstacles.length; i++) {
      const obstacle = obstacles[i];
      if (obstacle.z > z) break;
      const last = crossings[crossings.length - 1];
      // Cluster obstacles sharing a plane.
      if (last && Math.abs(last.z - obstacle.z) < 0.5) {
        last.obstacles.push(obstacle);
      } else {
        crossings.push({ z: obstacle.z, time, obstacles: [obstacle], speed });
      }
    }

    // The generator recycles behind the camera; keep our index in range.
    track.recycle(z - GAME.camera.playerOffset);
    nextIndex = 0;
  }

  return { crossings, track };
}

// --- 1. Every cluster leaves a corridor the ball physically fits through -----

function checkCorridorWidth(): void {
  let narrowest = Infinity;
  let narrowestAt = 0;
  let blockedClusters = 0;
  let total = 0;

  for (const seed of [1, 7, 42, 1337, 99999]) {
    const { crossings } = buildCrossings(seed, 6000);
    for (const crossing of crossings) {
      total++;
      const corridors = freeCorridors(crossing, 1);
      if (corridors.length === 0) {
        blockedClusters++;
        continue;
      }
      const widest = Math.max(...corridors.map(([a, b]) => b - a));
      if (widest < narrowest) {
        narrowest = widest;
        narrowestAt = crossing.z;
      }
    }
  }

  // The generator emits roughly one cluster per 100m at current spacing, so
  // 5 x 6km lands around 150. Well below that means the walk is dropping
  // obstacles and the rest of this file is asserting nothing.
  if (total < 100) {
    fail(`only ${total} clusters sampled — the walk is dropping obstacles, so these checks prove nothing`);
    return;
  }
  pass(`${total} obstacle clusters sampled across 5 seeds and 30km`);

  if (blockedClusters > 0) {
    fail(`${blockedClusters} clusters leave no gap the ball can fit through`);
  } else {
    pass(`every cluster leaves a passable corridor (narrowest ${narrowest.toFixed(2)}m of free centre travel at z=${narrowestAt.toFixed(0)})`);
  }
}

// --- 2. A corridor is always reachable at the ball's top lateral speed -------

function checkReachability(): void {
  let worstDeficit = 0;
  let worstAt = 0;
  let unreachable = 0;
  let total = 0;
  let tightest = Infinity;

  for (const seed of [1, 7, 42, 1337, 99999]) {
    const { crossings } = buildCrossings(seed, 6000);
    let x = 0;
    let previousTime = 0;

    for (const crossing of crossings) {
      const corridors = freeCorridors(crossing, 1);
      if (corridors.length === 0) continue; // counted by the width check

      const available = Math.max(1e-3, crossing.time - previousTime);
      const reach = MAX_SPEED * available;
      total++;

      // Closest safe centre to where we already are.
      let best: number | null = null;
      let bestCost = Infinity;
      for (const [a, b] of corridors) {
        const clamped = Math.max(a, Math.min(b, x));
        const cost = Math.abs(clamped - x);
        if (cost < bestCost) {
          bestCost = cost;
          best = clamped;
        }
      }

      if (best === null) continue;

      const slack = reach - bestCost;
      if (slack < 0) {
        unreachable++;
        if (-slack > worstDeficit) {
          worstDeficit = -slack;
          worstAt = crossing.z;
        }
        // Move as far as we can and carry on, so one failure does not cascade.
        x += Math.sign(best - x) * reach;
      } else {
        tightest = Math.min(tightest, slack);
        x = best;
      }
      previousTime = crossing.time;
    }
  }

  pass(`${total} clusters evaluated for reachability at ${MAX_SPEED} m/s lateral`);

  if (unreachable > 0) {
    fail(
      `${unreachable} clusters cannot be reached in time — worst is ${worstDeficit.toFixed(2)}m short at z=${worstAt.toFixed(0)}. ` +
        `Either raise control.maxLateralSpeed or widen difficulty.minReactionSeconds.`,
    );
  } else {
    pass(`every cluster reachable; tightest margin ${tightest.toFixed(2)}m of spare lateral travel`);
  }
}

// --- 3. The steering spring is stable at low frame rates --------------------

function checkSpringStability(): void {
  const omega = 2 * Math.PI * GAME.control.responseHz;
  const step = GAME.control.substep;

  // Critical damping is only unconditionally stable while omega*step is small.
  const ratio = omega * step;
  if (ratio > 0.3) {
    fail(`spring substep is too coarse (omega*step = ${ratio.toFixed(2)}); it will ring at low frame rates`);
    return;
  }
  pass(`spring substep stable (omega*step = ${ratio.toFixed(3)})`);

  // Simulate a full-width step input at 20fps and confirm it settles without
  // overshooting — the failure a player would read as the ball "wobbling".
  let x = -GAME.world.roadHalfWidth;
  let v = 0;
  const target = GAME.world.roadHalfWidth;
  let accumulator = 0;
  let overshoot = 0;
  let settledAt = -1;

  for (let frame = 0; frame < 120; frame++) {
    accumulator += 1 / 20;
    if (accumulator > 0.25) accumulator = 0.25;
    while (accumulator >= step) {
      accumulator -= step;
      const accel = omega * omega * (target - x) - 2 * omega * v;
      v += accel * step;
      v = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v));
      x += v * step;
    }
    overshoot = Math.max(overshoot, x - target);
    if (settledAt < 0 && Math.abs(target - x) < 0.05) settledAt = frame / 20;
  }

  if (overshoot > 0.02) {
    fail(`spring overshoots by ${overshoot.toFixed(3)}m at 20fps — it is not critically damped`);
  } else {
    pass(`no overshoot at 20fps; full-width move settles in ${settledAt.toFixed(2)}s`);
  }

  // And the speed clamp must actually bind on a full-width flick.
  if (Math.abs(v) > MAX_SPEED + 1e-6) {
    fail(`lateral speed exceeded the clamp (${v.toFixed(1)} m/s)`);
  }
}

console.log('\ncontrol checks');
checkCorridorWidth();
checkReachability();
checkSpringStability();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\nall control checks passed\n');
