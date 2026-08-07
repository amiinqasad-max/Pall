/**
 * Regression checks for the vertical projection.
 *
 * The bug these exist to catch: the camera sits at `camera.worldY +
 * camera.height` in world space, so projecting a point must subtract *both*.
 * An earlier version added `camera.worldY` instead of subtracting it, which
 * cancels correctly only while the track is perfectly flat — which the opening
 * 220m of every run is. The error therefore stayed invisible in short test runs
 * and appeared ~900m in, on hills, as the road collapsing to a band at the
 * horizon with the ball flung off-screen.
 *
 * The invariant asserted here is terrain-independent and would have caught it
 * on the first hill: the ball's screen position relative to the road directly
 * beneath it must not depend on how high that road happens to be.
 *
 * Run with `npm run check`.
 */

import { GAME } from '@/game/config';
import { Projector, type CameraState } from '@/game/render/projection';
import { TrackGenerator } from '@/game/world/TrackGenerator';

const VIEWPORT = { width: 390, height: 844 };

function makeProjector(): Projector {
  const projector = new Projector();
  projector.resize(VIEWPORT.width, VIEWPORT.height, {
    playerOffset: GAME.camera.playerOffset,
    cameraHeight: GAME.camera.height,
    roadHalfWidth: GAME.world.roadHalfWidth,
    playerRadius: GAME.player.radius,
    roadFill: GAME.camera.roadFill,
    ballAnchor: GAME.camera.ballAnchor,
    minHorizon: GAME.camera.minHorizon,
  });
  projector.setFogDistance(GAME.camera.drawDistance * GAME.world.segmentLength);
  return projector;
}

/** Mirrors RoadRenderer.elevationAt, straight from the generator. */
function elevationAt(track: TrackGenerator, z: number): number {
  const segLength = GAME.world.segmentLength;
  const index = Math.floor(z / segLength);
  const a = track.segmentByIndex(index);
  const b = track.segmentByIndex(index + 1);
  if (!a) return 0;
  if (!b) return a.y;
  const t = (z % segLength) / segLength;
  return a.y + (b.y - a.y) * t;
}

let failures = 0;
const fail = (message: string): void => {
  failures++;
  console.error(`  FAIL  ${message}`);
};
const pass = (message: string): void => console.log(`  ok    ${message}`);

// --- 1. The ball holds its place on screen regardless of terrain height ------

function checkTerrainIndependence(): void {
  const projector = makeProjector();
  const track = new TrackGenerator(12345);
  track.reset(12345);
  // Generate deep enough to be well past the flat intro and into real hills.
  track.ensureAhead(6000, 4, GAME.speed.max);

  const camera: CameraState = {
    z: 0,
    x: 0,
    height: GAME.camera.height,
    curveX: 0,
    worldY: 0,
  };

  let baseline: number | null = null;
  let worstDrift = 0;
  let worstElevation = 0;
  let offScreen = 0;
  let maxElevationSeen = 0;

  for (let ballZ = GAME.camera.playerOffset; ballZ < 5000; ballZ += 3) {
    camera.z = ballZ - GAME.camera.playerOffset;
    camera.worldY = elevationAt(track, camera.z);

    const roadY = elevationAt(track, ballZ);
    maxElevationSeen = Math.max(maxElevationSeen, Math.abs(roadY));

    // Ball resting on the road, and the road surface directly beneath it.
    const ball = projector.project(camera, 0, roadY + GAME.player.radius, ballZ, 0);
    const ground = projector.project(camera, 0, roadY, ballZ, 0);
    if (!ball.visible || !ground.visible) {
      fail(`projection reported not visible at z=${ballZ.toFixed(0)}`);
      return;
    }

    // The gap between the ball's centre and the road under it depends only on
    // the ball's radius and the depth — never on the terrain's absolute height.
    const gap = ground.screenY - ball.screenY;
    if (baseline === null) baseline = gap;
    const drift = Math.abs(gap - baseline);
    if (drift > worstDrift) {
      worstDrift = drift;
      worstElevation = roadY;
    }

    if (ball.screenY < -200 || ball.screenY > VIEWPORT.height + 200) offScreen++;
  }

  if (maxElevationSeen < 5) {
    fail(`test track is too flat to be meaningful (max |elevation| ${maxElevationSeen.toFixed(1)}m)`);
    return;
  }
  pass(`track exercised elevation up to ${maxElevationSeen.toFixed(1)}m`);

  if (worstDrift > 1) {
    fail(
      `ball drifts ${worstDrift.toFixed(1)}px from the road beneath it ` +
        `(at elevation ${worstElevation.toFixed(1)}m) — the projection is mixing up the camera's height reference`,
    );
  } else {
    pass(`ball holds position over the road within ${worstDrift.toFixed(2)}px across all terrain`);
  }

  if (offScreen > 0) {
    fail(`ball projected off-screen on ${offScreen} samples`);
  } else {
    pass('ball stays on screen across the whole track');
  }
}

// --- 2. A grounded ball sits at the configured anchor ------------------------

function checkAnchor(): void {
  const projector = makeProjector();
  const camera: CameraState = { z: 0, x: 0, height: GAME.camera.height, curveX: 0, worldY: 0 };

  // Flat ground, ball resting: it should land on the framing's anchor line.
  const ball = projector.project(camera, 0, GAME.player.radius, GAME.camera.playerOffset, 0);
  const expected = VIEWPORT.height * GAME.camera.ballAnchor;
  const delta = Math.abs(ball.screenY - expected);
  if (delta > 1) {
    fail(`grounded ball at y=${ball.screenY.toFixed(1)}, expected ~${expected.toFixed(1)}`);
  } else {
    pass(`grounded ball sits on the ${(GAME.camera.ballAnchor * 100).toFixed(0)}% anchor line`);
  }

  // Same test with the whole world lifted 20m: the ball must not move at all.
  const lifted: CameraState = { ...camera, worldY: 20 };
  const liftedBall = projector.project(lifted, 0, 20 + GAME.player.radius, GAME.camera.playerOffset, 0);
  const liftDelta = Math.abs(liftedBall.screenY - ball.screenY);
  if (liftDelta > 0.01) {
    fail(`lifting the world 20m moved the ball ${liftDelta.toFixed(1)}px — elevation is not cancelling`);
  } else {
    pass('raising the whole world leaves the shot unchanged');
  }
}

// --- 3. Jump apex stays inside the viewport ----------------------------------

function checkJumpEnvelope(): void {
  const projector = makeProjector();
  const camera: CameraState = { z: 0, x: 0, height: GAME.camera.height, curveX: 0, worldY: 0 };

  for (const elevation of [-22, -10, 0, 10, 22]) {
    camera.worldY = elevation;
    const apex = projector.project(
      camera,
      0,
      elevation + GAME.player.jumpHeight + GAME.player.radius,
      GAME.camera.playerOffset,
      0,
    );
    if (apex.screenY < 0) {
      fail(`jump apex leaves the top of the screen at elevation ${elevation}m (y=${apex.screenY.toFixed(0)})`);
      return;
    }
  }
  pass('jump apex stays on screen at every terrain elevation');
}

console.log('\nprojection checks');
checkTerrainIndependence();
checkAnchor();
checkJumpEnvelope();

if (failures > 0) {
  console.error(`\n${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('\nall projection checks passed\n');
