/**
 * Obstacle definitions.
 *
 * An obstacle is data, not an object graph: a type, a lane, a phase, and a few
 * numbers. Its lateral extent at any instant is a pure function of those plus
 * the clock (`extentAt`), which means collision and rendering read from exactly
 * the same source. There is no physics body anywhere in this game, and no way
 * for what you see to disagree with what kills you.
 *
 * The clock is run time, not wall time, so a paused game freezes every moving
 * obstacle in place and resumes them from where they were.
 */

import { GAME } from '@/game/config';

export type ObstacleType =
  | 'block'
  | 'mover'
  | 'barrier'
  | 'wall'
  | 'gate'
  | 'faller'
  | 'spinner'
  | 'laser'
  | 'gap'
  | 'pulse';

export interface Obstacle {
  id: number;
  type: ObstacleType;
  /** World z of the obstacle plane. */
  z: number;
  /** Base lane index, -2..2 on a five-lane road. */
  lane: number;
  /** Width in lanes for wide obstacles (barriers, walls). */
  laneSpan: number;
  /** Animation phase offset, so identical obstacles do not move in lockstep. */
  phase: number;
  /** Animation rate, radians or cycles per second depending on type. */
  rate: number;
  /** How far the obstacle travels, in lanes, for the moving types. */
  amplitude: number;
  /**
   * Height of the obstacle above the road, in metres. A jump clears anything
   * shorter than the ball's apex; `Infinity` can never be jumped.
   */
  height: number;
  /** For gates: the lanes that are safe to pass through. */
  safeLanes?: number[];
  /** Set once the player has passed this obstacle, so it counts only once. */
  passed: boolean;
  /** True when the player already collided with it (grace period continues). */
  resolved: boolean;
}

/** Lateral half-extent of a standard single-lane obstacle, in metres. */
const laneWidth = (GAME.world.roadHalfWidth * 2) / GAME.world.lanes;

/**
 * How far a gate's solid panels are pulled back from the edge of the opening.
 *
 * An opening exactly one lane wide (2.16m) admits a 1.84m ball with 0.16m to
 * spare on each side. That was fine when the player snapped to lane centres and
 * is far too fine now that they steer freely — it asks for pixel-accurate
 * placement at 60 m/s. Widening the aperture keeps the gate readable while
 * giving the ball's centre a real target to aim at.
 */
const GATE_OPENING_INSET = 0.3;

/** Far enough outside the road that an outer panel never shows a false gap. */
const OFF_ROAD = GAME.world.roadHalfWidth * 3;
export const LANE_WIDTH = laneWidth;
const BODY_HALF = laneWidth * 0.44;

export function laneToX(lane: number): number {
  return lane * laneWidth;
}

export function xToLane(x: number): number {
  return Math.round(x / laneWidth);
}

export const MIN_LANE = -Math.floor(GAME.world.lanes / 2);
export const MAX_LANE = Math.floor(GAME.world.lanes / 2);

/** A solid horizontal span, in metres. `null` means "not blocking right now". */
export interface Extent {
  min: number;
  max: number;
  /** Bottom of the obstacle. A ball above this passes over it. */
  bottom: number;
  /** Top of the obstacle. A ball above this has cleared it. */
  top: number;
}

/** Reusable buffers so per-frame collision does no allocation at all. */
const extentBuffer: Extent[] = [
  { min: 0, max: 0, bottom: 0, top: 0 },
  { min: 0, max: 0, bottom: 0, top: 0 },
  { min: 0, max: 0, bottom: 0, top: 0 },
  { min: 0, max: 0, bottom: 0, top: 0 },
];

function write(index: number, min: number, max: number, bottom: number, top: number): Extent {
  const e = extentBuffer[index];
  e.min = min;
  e.max = max;
  e.bottom = bottom;
  e.top = top;
  return e;
}

/**
 * The obstacle's solid spans at time `t` (seconds of run time).
 *
 * Returns a count and fills `out` with that many entries from the shared
 * buffer. Callers must consume the result before the next call — which they
 * all do, inside a single collision pass.
 */
export function extentAt(obstacle: Obstacle, t: number, out: Extent[]): number {
  const time = t * obstacle.rate + obstacle.phase;

  switch (obstacle.type) {
    case 'block': {
      const x = laneToX(obstacle.lane);
      out[0] = write(0, x - BODY_HALF, x + BODY_HALF, 0, obstacle.height);
      return 1;
    }

    case 'mover': {
      // Slides smoothly between lanes; the sine keeps it slowest at the
      // extremes, which is where the player has to read its direction.
      const lane = obstacle.lane + Math.sin(time) * obstacle.amplitude;
      const x = laneToX(lane);
      out[0] = write(0, x - BODY_HALF, x + BODY_HALF, 0, obstacle.height);
      return 1;
    }

    case 'wall': {
      // Sweeps in from one side and covers a contiguous block of lanes.
      const travel = Math.sin(time) * obstacle.amplitude;
      const centre = laneToX(obstacle.lane + travel);
      const half = (obstacle.laneSpan * laneWidth) / 2;
      out[0] = write(0, centre - half, centre + half, 0, obstacle.height);
      return 1;
    }

    case 'barrier': {
      // A bar pivoting about the road centre. Its lateral shadow is the
      // projection of the bar, so it is widest when level with the player and
      // vanishes as it turns edge-on.
      const half = Math.abs(Math.cos(time)) * ((obstacle.laneSpan * laneWidth) / 2);
      const centre = laneToX(obstacle.lane);
      if (half < BODY_HALF * 0.35) return 0;
      out[0] = write(0, centre - half, centre + half, 0, obstacle.height);
      return 1;
    }

    case 'spinner': {
      // Two arms at right angles: as one shrinks the other grows, so there is
      // always a readable gap moving across the road.
      const c = Math.abs(Math.cos(time));
      const s = Math.abs(Math.sin(time));
      const reach = (obstacle.laneSpan * laneWidth) / 2;
      const centre = laneToX(obstacle.lane);
      let count = 0;
      if (c > 0.12) out[count++] = write(0, centre - c * reach, centre + c * reach, 0, obstacle.height);
      if (s > 0.12) {
        // The perpendicular arm reads as a narrow pillar at the hub.
        out[count++] = write(1, centre - BODY_HALF * s, centre + BODY_HALF * s, 0, obstacle.height * (0.5 + s * 0.5));
      }
      return count;
    }

    case 'gate': {
      // Everything except the safe lanes is solid. Contiguous blocked lanes
      // merge into one span so a five-lane gate is at most two extents.
      const safe = obstacle.safeLanes ?? [obstacle.lane];
      let count = 0;
      let runStart: number | null = null;

      const closeRun = (endLane: number): void => {
        if (runStart === null || count >= extentBuffer.length) return;
        // Pull the panel back from the opening, but only on edges that face an
        // opening. An outer panel runs off the road instead, so the inset can
        // never manufacture a gap along the rail.
        const min =
          runStart === MIN_LANE ? -OFF_ROAD : laneToX(runStart) - laneWidth / 2 + GATE_OPENING_INSET;
        const max =
          endLane === MAX_LANE ? OFF_ROAD : laneToX(endLane) + laneWidth / 2 - GATE_OPENING_INSET;
        out[count] = write(count, min, max, 0, obstacle.height);
        count++;
        runStart = null;
      };

      for (let lane = MIN_LANE; lane <= MAX_LANE; lane++) {
        if (safe.includes(lane)) {
          closeRun(lane - 1);
        } else if (runStart === null) {
          runStart = lane;
        }
      }
      closeRun(MAX_LANE);
      return count;
    }

    case 'faller': {
      // Hangs above the road, then drops. Before it lands it is not solid at
      // ball height, which is the tell the player has to spot.
      const cycle = (time % (Math.PI * 2)) / (Math.PI * 2);
      const dropStart = 0.55;
      const x = laneToX(obstacle.lane);
      if (cycle < dropStart) {
        const hover = 3.4;
        out[0] = write(0, x - BODY_HALF, x + BODY_HALF, hover, hover + obstacle.height);
        return 1;
      }
      const fall = Math.min(1, (cycle - dropStart) / 0.18);
      const bottom = 3.4 * (1 - fall * fall);
      out[0] = write(0, x - BODY_HALF, x + BODY_HALF, bottom, bottom + obstacle.height);
      return 1;
    }

    case 'laser': {
      // Pulses on and off. Off means genuinely non-solid — the timing is the
      // whole obstacle.
      const duty = 0.45;
      const cycle = (time % (Math.PI * 2)) / (Math.PI * 2);
      if (cycle > duty) return 0;
      const half = (obstacle.laneSpan * laneWidth) / 2;
      const centre = laneToX(obstacle.lane);
      // Beams sit low, so a well-timed jump clears one that is already on.
      out[0] = write(0, centre - half, centre + half, 0, obstacle.height);
      return 1;
    }

    case 'pulse': {
      // A pillar that extends and retracts on a strict rhythm.
      const cycle = (Math.sin(time) + 1) / 2;
      if (cycle < 0.35) return 0;
      const x = laneToX(obstacle.lane);
      const height = obstacle.height * cycle;
      out[0] = write(0, x - BODY_HALF, x + BODY_HALF, 0, height);
      return 1;
    }

    case 'gap': {
      // A hole. Solid from below the road up to zero, so only an airborne ball
      // survives it; handled specially in the collision pass.
      const half = (obstacle.laneSpan * laneWidth) / 2;
      const centre = laneToX(obstacle.lane);
      out[0] = write(0, centre - half, centre + half, -10, 0);
      return 1;
    }

    default:
      return 0;
  }
}

/** Whether a jump can clear this obstacle type at all. */
export function isJumpable(obstacle: Obstacle): boolean {
  return obstacle.height <= GAME.player.jumpHeight * 0.86;
}

/** Human-readable name, used by the tutorial hints and the death message. */
export const OBSTACLE_LABELS: Record<ObstacleType, string> = {
  block: 'Block',
  mover: 'Drifter',
  barrier: 'Rotor',
  wall: 'Sweeper',
  gate: 'Energy Gate',
  faller: 'Dropper',
  spinner: 'Spinner',
  laser: 'Laser',
  gap: 'Chasm',
  pulse: 'Pulse Pillar',
};

let nextId = 1;
export function nextObstacleId(): number {
  return nextId++;
}
