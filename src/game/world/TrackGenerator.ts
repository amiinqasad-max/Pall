/**
 * Procedural track generation.
 *
 * The track is built one feature at a time — a curve, a crest, a narrowing, a
 * boost lane — rather than one obstacle at a time. Features give a run its
 * shape and rhythm; obstacles are then placed *inside* a feature with spacing
 * derived from how fast the player will actually be moving when they arrive.
 *
 * The fairness contract, enforced in `minSpacing`, is the important part: an
 * obstacle is never placed closer than (reaction + recovery) x current speed
 * from the previous one, whatever the difficulty stage says. Difficulty makes
 * the game denser and more varied, never unreadable. There is no run that
 * cannot be survived by a player who is looking at the screen.
 */

import { createRng, type Rng } from '@/core/rng';
import { GAME } from '@/game/config';
import {
  MAX_LANE,
  MIN_LANE,
  extentAt,
  nextObstacleId,
  type Extent,
  type Obstacle,
  type ObstacleType,
} from '@/game/world/obstacles';

export interface Segment {
  index: number;
  /** World z at the start of the segment. */
  z: number;
  /** Curvature contribution; integrated by the renderer as it walks forward. */
  curve: number;
  /** Elevation of the road surface, metres. */
  y: number;
  /** 1 = full width. Narrow sections scale this down and mask outer lanes. */
  widthScale: number;
  /** True where the road is missing entirely and the player must jump. */
  hole: boolean;
  /** True inside a speed zone; the renderer paints chevrons here. */
  boost: boolean;
  /** Alternating stripe flag, for the rumble strips and road banding. */
  lit: boolean;
}

export interface Prism {
  id: number;
  z: number;
  lane: number;
  /** Height above the road; arcs float prisms over jump gaps. */
  y: number;
  collected: boolean;
}

export interface GeneratedChunk {
  segments: Segment[];
  obstacles: Obstacle[];
  prisms: Prism[];
}

type FeatureKind =
  | 'straight'
  | 'curve'
  | 'hill'
  | 'narrow'
  | 'boost'
  | 'chasm'
  | 'bonus'
  | 'gauntlet';

/** Obstacle vocabulary by stage. Later stages add types, never remove them. */
const STAGE_TYPES: ObstacleType[][] = [
  ['block', 'mover'],
  ['block', 'mover', 'barrier', 'gate'],
  ['block', 'mover', 'barrier', 'gate', 'wall', 'pulse'],
  ['block', 'mover', 'barrier', 'gate', 'wall', 'pulse', 'laser', 'faller'],
  ['block', 'mover', 'barrier', 'gate', 'wall', 'pulse', 'laser', 'faller', 'spinner'],
  ['block', 'mover', 'barrier', 'gate', 'wall', 'pulse', 'laser', 'faller', 'spinner'],
];

/**
 * The free lateral travel a cluster must leave for the ball's *centre*, in
 * metres, at every phase of its animation.
 *
 * Lane-count budgeting is not a sufficient guarantee once the player steers
 * freely: a rotating barrier spanning four lanes is 8.6m wide at full
 * extension, which covers the whole road after the ball's radius is accounted
 * for, and the player cannot dodge it by timing because forward speed is not
 * theirs to control. This is the real contract, and `ensurePassable` enforces
 * it in metres.
 */
const MIN_CORRIDOR = 0.55;

/**
 * How far ahead the passability sweep looks, in seconds, and how finely.
 * 10s covers a full cycle of the slowest obstacle (rate 0.7 rad/s), so a
 * cluster is verified against every phase it could present on arrival — not
 * just the one it happens to show at generation time.
 */
const SWEEP_SECONDS = 10;
const SWEEP_SAMPLES = 64;

/** Scratch buffers for the passability sweep; never reallocated. */
const sweepExtents: Extent[] = new Array(4).fill(null).map(() => ({ min: 0, max: 0, bottom: 0, top: 0 }));
const sweepBlocked: { min: number; max: number }[] = [];

/** How many lanes each type tends to take away, for the "is this survivable" check. */
const LANES_CONSUMED: Record<ObstacleType, number> = {
  block: 1,
  mover: 2,
  barrier: 3,
  wall: 2,
  gate: 4,
  faller: 1,
  spinner: 3,
  laser: 3,
  gap: 2,
  pulse: 1,
};

export class TrackGenerator {
  private rng: Rng;
  private segments: Segment[] = [];
  /** Absolute index of segments[0]; older segments are dropped as we pass them. */
  private baseIndex = 0;
  private nextIndex = 0;

  private obstacles: Obstacle[] = [];
  private prisms: Prism[] = [];
  private nextPrismId = 1;

  /** Where the last obstacle cluster ended, in metres. */
  private lastObstacleZ = 0;
  private lastBreatherZ = 0;
  private currentCurve = 0;
  private currentY = 0;
  private currentWidth = 1;

  /** Segments remaining in the feature being emitted. */
  private featureRemaining = 0;
  private featureKind: FeatureKind = 'straight';
  private featureCurveTarget = 0;
  private featureHillTarget = 0;
  private featureWidthTarget = 1;
  private featureLength = 0;

  constructor(seed: number) {
    this.rng = createRng(seed);
  }

  reset(seed: number): void {
    this.rng = createRng(seed);
    this.segments = [];
    this.obstacles = [];
    this.prisms = [];
    this.baseIndex = 0;
    this.nextIndex = 0;
    this.nextPrismId = 1;
    this.lastObstacleZ = 0;
    this.lastBreatherZ = 0;
    this.currentCurve = 0;
    this.currentY = 0;
    this.currentWidth = 1;
    this.featureRemaining = 0;
    this.featureKind = 'straight';

    // The opening 220m is deliberately flat, wide and empty. First impressions
    // decide whether a new player takes a second run, and nobody's first ten
    // seconds should be a death.
    this.emitIntro();
  }

  private emitIntro(): void {
    const introSegments = Math.ceil(220 / GAME.world.segmentLength);
    for (let i = 0; i < introSegments; i++) {
      this.pushSegment({ curve: 0, y: 0, widthScale: 1, hole: false, boost: false });
    }
    this.lastObstacleZ = 150;
    this.lastBreatherZ = 0;
  }

  private pushSegment(opts: {
    curve: number;
    y: number;
    widthScale: number;
    hole: boolean;
    boost: boolean;
  }): Segment {
    const index = this.nextIndex++;
    const segment: Segment = {
      index,
      z: index * GAME.world.segmentLength,
      curve: opts.curve,
      y: opts.y,
      widthScale: opts.widthScale,
      hole: opts.hole,
      boost: opts.boost,
      // Alternating every segment gives a 6m dash / 6m gap. Longer bands look
      // fine at distance but leave the near field — which fills most of the
      // screen — without a lane dash in view for seconds at a time.
      lit: index % 2 === 0,
    };
    this.segments.push(segment);
    return segment;
  }

  /** Total metres of track generated so far. */
  get generatedTo(): number {
    return this.nextIndex * GAME.world.segmentLength;
  }

  segmentAt(z: number): Segment | undefined {
    const index = Math.floor(z / GAME.world.segmentLength);
    return this.segments[index - this.baseIndex];
  }

  segmentByIndex(index: number): Segment | undefined {
    return this.segments[index - this.baseIndex];
  }

  get firstIndex(): number {
    return this.baseIndex;
  }

  get lastIndex(): number {
    return this.nextIndex - 1;
  }

  get activeObstacles(): Obstacle[] {
    return this.obstacles;
  }

  get activePrisms(): Prism[] {
    return this.prisms;
  }

  /**
   * Ensures track exists up to `targetZ`, generating features as needed.
   * `stage` and `speed` shape what gets generated; both come from the live run.
   */
  ensureAhead(targetZ: number, stage: number, speed: number): void {
    let guard = 0;
    while (this.generatedTo < targetZ && guard++ < 4000) {
      if (this.featureRemaining <= 0) this.chooseFeature(stage);
      this.emitSegment(stage, speed);
    }
  }

  /** Drops geometry behind the camera so memory stays flat over a long run. */
  recycle(cameraZ: number): void {
    const keepFrom = Math.floor((cameraZ - 60) / GAME.world.segmentLength);
    const drop = keepFrom - this.baseIndex;
    if (drop > 120) {
      this.segments.splice(0, drop);
      this.baseIndex += drop;
    }

    const cutoff = cameraZ - 40;
    if (this.obstacles.length > 0 && this.obstacles[0].z < cutoff) {
      let i = 0;
      while (i < this.obstacles.length && this.obstacles[i].z < cutoff) i++;
      if (i > 0) this.obstacles.splice(0, i);
    }
    if (this.prisms.length > 0 && this.prisms[0].z < cutoff) {
      let i = 0;
      while (i < this.prisms.length && this.prisms[i].z < cutoff) i++;
      if (i > 0) this.prisms.splice(0, i);
    }
  }

  // --- Feature selection ------------------------------------------------------

  private chooseFeature(stage: number): void {
    const z = this.generatedTo;

    // A forced breather at a fixed cadence. Without this, weighted random
    // selection eventually produces a stretch that is technically fair but
    // exhausting, and players quit during those.
    if (z - this.lastBreatherZ > GAME.difficulty.breatherEverySeconds * 30) {
      this.featureKind = 'straight';
      this.featureLength = Math.ceil(70 / GAME.world.segmentLength);
      this.featureRemaining = this.featureLength;
      this.featureCurveTarget = 0;
      this.featureHillTarget = 0;
      this.featureWidthTarget = 1;
      this.lastBreatherZ = z;
      this.lastObstacleZ = Math.max(this.lastObstacleZ, z + 60);
      return;
    }

    const kinds: FeatureKind[] = ['straight', 'curve', 'hill', 'narrow', 'boost', 'bonus'];
    const weights = [22, 30, 18, 10, 9, 8];

    if (stage >= 1) {
      kinds.push('gauntlet');
      weights.push(10 + stage * 3);
    }
    if (stage >= 2) {
      kinds.push('chasm');
      weights.push(8 + stage * 2);
    }
    // Never two narrow or two chasm features back to back.
    const previous = this.featureKind;
    for (let i = 0; i < kinds.length; i++) {
      if (kinds[i] === previous && (previous === 'narrow' || previous === 'chasm' || previous === 'bonus')) {
        weights[i] = 0;
      }
    }

    this.featureKind = this.rng.weighted(kinds, weights);
    this.featureCurveTarget = 0;
    this.featureHillTarget = 0;
    this.featureWidthTarget = 1;

    switch (this.featureKind) {
      case 'straight':
        this.featureLength = this.rng.int(10, 24);
        break;
      case 'curve': {
        this.featureLength = this.rng.int(22, 46);
        const strength = this.rng.range(0.55, 1) * (0.6 + stage * 0.1);
        this.featureCurveTarget = strength * (this.rng.chance(0.5) ? 1 : -1) * 0.0055;
        break;
      }
      case 'hill':
        this.featureLength = this.rng.int(20, 40);
        this.featureHillTarget = this.rng.range(-1, 1) * 22;
        break;
      case 'narrow':
        this.featureLength = this.rng.int(16, 30);
        // Never narrower than three usable lanes.
        this.featureWidthTarget = this.rng.range(0.62, 0.78);
        break;
      case 'boost':
        this.featureLength = this.rng.int(14, 26);
        this.featureCurveTarget = this.rng.range(-0.2, 0.2) * 0.004;
        break;
      case 'chasm':
        this.featureLength = this.rng.int(14, 22);
        break;
      case 'bonus':
        this.featureLength = this.rng.int(16, 28);
        this.featureCurveTarget = this.rng.range(-0.35, 0.35) * 0.004;
        break;
      case 'gauntlet':
        this.featureLength = this.rng.int(24, 42);
        this.featureCurveTarget = this.rng.range(-0.4, 0.4) * 0.005;
        break;
    }

    this.featureRemaining = this.featureLength;
  }

  // --- Segment emission -------------------------------------------------------

  private emitSegment(stage: number, speed: number): void {
    const progress = 1 - this.featureRemaining / Math.max(1, this.featureLength);
    // Ease features in and out so curves and hills never start with a kink.
    const ease = Math.sin(progress * Math.PI);

    this.currentCurve += (this.featureCurveTarget * ease - this.currentCurve) * 0.18;
    const targetY = this.featureHillTarget * ease;
    this.currentY += (targetY - this.currentY) * 0.1;
    this.currentWidth += (this.featureWidthTarget - this.currentWidth) * 0.12;

    const positionInFeature = this.featureLength - this.featureRemaining;
    const boost = this.featureKind === 'boost' && positionInFeature > 2 && this.featureRemaining > 2;

    // Chasms punch a hole through the middle of the feature.
    const chasmStart = Math.floor(this.featureLength * 0.45);
    const chasmLength = 2;
    const hole =
      this.featureKind === 'chasm' &&
      positionInFeature >= chasmStart &&
      positionInFeature < chasmStart + chasmLength;

    const segment = this.pushSegment({
      curve: this.currentCurve,
      y: this.currentY,
      widthScale: this.currentWidth,
      hole,
      boost,
    });

    this.featureRemaining--;

    if (hole && positionInFeature === chasmStart) this.placeChasm(segment, stage);
    else if (!hole) this.maybePlaceContent(segment, stage, speed);
  }

  // --- Placement --------------------------------------------------------------

  /**
   * The fairness floor: how far apart obstacle clusters must be, in metres.
   * Derived from the speed the player will be travelling, never from a
   * constant, so the late game does not quietly become unreadable.
   */
  private minSpacing(stage: number, speed: number): number {
    const cfg = GAME.difficulty;
    const stageCfg = GAME.difficulty.stages[Math.min(stage, GAME.difficulty.stages.length - 1)];
    const seconds = (cfg.minReactionSeconds + cfg.minRecoverySeconds) * stageCfg.gapMultiplier;
    return speed * seconds;
  }

  private placeChasm(segment: Segment, stage: number): void {
    const span = stage >= 3 && this.rng.chance(0.35) ? 5 : this.rng.int(2, 3);
    const lane = span >= 5 ? 0 : this.rng.int(MIN_LANE + 1, MAX_LANE - 1);
    this.obstacles.push({
      id: nextObstacleId(),
      type: 'gap',
      z: segment.z,
      lane,
      laneSpan: span,
      phase: 0,
      rate: 0,
      amplitude: 0,
      height: 0,
      passed: false,
      resolved: false,
    });
    this.lastObstacleZ = segment.z;

    // A prism arc over the gap: the reward for committing to the jump.
    for (let i = -1; i <= 1; i++) {
      this.prisms.push({
        id: this.nextPrismId++,
        z: segment.z + i * GAME.world.segmentLength * 0.6,
        lane,
        y: GAME.player.jumpHeight * 0.62 * (1 - Math.abs(i) * 0.25),
        collected: false,
      });
    }
  }

  private maybePlaceContent(segment: Segment, stage: number, speed: number): void {
    const stageCfg = GAME.difficulty.stages[Math.min(stage, GAME.difficulty.stages.length - 1)];

    if (this.featureKind === 'bonus') {
      this.maybePlacePrisms(segment, true);
      return;
    }

    const spacing = this.minSpacing(stage, speed);
    if (segment.z - this.lastObstacleZ < spacing) {
      this.maybePlacePrisms(segment, false);
      return;
    }

    const density = this.featureKind === 'gauntlet' ? Math.min(0.95, stageCfg.density * 1.35) : stageCfg.density;
    if (!this.rng.chance(density * 0.34)) {
      this.maybePlacePrisms(segment, false);
      return;
    }

    this.placeCluster(segment, stage, stageCfg.maxSimultaneous);
    this.lastObstacleZ = segment.z;
  }

  /**
   * Places one to three obstacles at roughly the same depth, then verifies at
   * least one lane is left open. If the roll produced a wall, it is thinned
   * until it is passable — the generator never emits an unwinnable cluster.
   */
  private placeCluster(segment: Segment, stage: number, maxCount: number): void {
    const types = STAGE_TYPES[Math.min(stage, STAGE_TYPES.length - 1)];
    const usableLanes = this.usableLanes(segment.widthScale);
    const count = this.rng.int(1, Math.min(maxCount, Math.max(1, usableLanes.length - 1)));

    const chosen: Obstacle[] = [];
    let lanesConsumed = 0;
    const available = this.rng.shuffle(usableLanes);

    for (let i = 0; i < count; i++) {
      const type = this.rng.pick(types);
      const consumes = LANES_CONSUMED[type];
      // Always leave at least one lane's worth of road unaccounted for.
      if (lanesConsumed + consumes > usableLanes.length - 1) break;

      const lane = available[i % available.length];
      const obstacle = this.buildObstacle(type, segment, lane, usableLanes, stage);
      if (!obstacle) continue;
      chosen.push(obstacle);
      lanesConsumed += consumes;
    }

    if (chosen.length === 0) {
      // Fall back to the simplest possible hazard rather than an empty cluster.
      const lane = this.rng.pick(usableLanes);
      chosen.push(this.buildObstacle('block', segment, lane, usableLanes, stage)!);
    }

    const passable = this.ensurePassable(chosen, segment.widthScale);
    for (const o of passable) this.obstacles.push(o);

    // Risk/reward: a prism sitting in the lane next to a hazard.
    if (this.rng.chance(0.4)) {
      const taken = new Set(passable.map((o) => o.lane));
      const free = usableLanes.filter((l) => !taken.has(l));
      if (free.length > 0) {
        this.prisms.push({
          id: this.nextPrismId++,
          z: segment.z,
          lane: this.rng.pick(free),
          y: 0.9,
          collected: false,
        });
      }
    }
  }


  /**
   * Widest free travel available to the ball's centre at time `t`, in metres.
   * Returns 0 when the cluster is completely solid.
   */
  private widestCorridorAt(obstacles: Obstacle[], widthScale: number, t: number): number {
    const limit = Math.max(
      GAME.player.radius,
      GAME.world.roadHalfWidth * widthScale - GAME.player.radius,
    );

    sweepBlocked.length = 0;
    for (const obstacle of obstacles) {
      // Chasms are cleared by jumping; they do not constrain the lateral path.
      if (obstacle.type === 'gap') continue;
      const count = extentAt(obstacle, t, sweepExtents);
      for (let i = 0; i < count; i++) {
        sweepBlocked.push({
          min: sweepExtents[i].min - GAME.player.radius,
          max: sweepExtents[i].max + GAME.player.radius,
        });
      }
    }
    sweepBlocked.sort((a, b) => a.min - b.min);

    let widest = 0;
    let cursor = -limit;
    for (const span of sweepBlocked) {
      if (span.min > cursor) widest = Math.max(widest, Math.min(span.min, limit) - cursor);
      cursor = Math.max(cursor, span.max);
      if (cursor >= limit) break;
    }
    if (cursor < limit) widest = Math.max(widest, limit - cursor);

    return widest;
  }

  /** The tightest the cluster ever gets, across a full sweep of its animation. */
  private narrowestCorridor(obstacles: Obstacle[], widthScale: number): number {
    let narrowest = Infinity;
    for (let i = 0; i < SWEEP_SAMPLES; i++) {
      const t = (i / SWEEP_SAMPLES) * SWEEP_SECONDS;
      narrowest = Math.min(narrowest, this.widestCorridorAt(obstacles, widthScale, t));
      if (narrowest <= 0) break;
    }
    return narrowest;
  }

  /**
   * Guarantees the cluster can actually be driven through.
   *
   * Shrinks the widest sweeping obstacle first, because narrowing a rotor reads
   * as a design choice while deleting it leaves a conspicuously empty stretch.
   * Only when nothing can shrink further does it start dropping obstacles.
   *
   * Runs once per cluster — roughly once every 100m of track — so the sweep
   * costs nothing measurable next to the rest of generation.
   */
  private ensurePassable(obstacles: Obstacle[], widthScale: number): Obstacle[] {
    let cluster = obstacles.slice();

    for (let guard = 0; guard < 12; guard++) {
      if (this.narrowestCorridor(cluster, widthScale) >= MIN_CORRIDOR) return cluster;

      // Prefer shrinking: find the widest span still above the floor.
      let widest: Obstacle | null = null;
      for (const o of cluster) {
        if (o.type === 'gap' || o.laneSpan <= 1) continue;
        if (!widest || o.laneSpan > widest.laneSpan) widest = o;
      }
      if (widest) {
        widest.laneSpan -= 1;
        continue;
      }

      // Nothing left to shrink: drop the most recently added hazard.
      const droppable = cluster.filter((o) => o.type !== 'gap');
      if (droppable.length <= 1) break;
      const victim = droppable[droppable.length - 1];
      cluster = cluster.filter((o) => o !== victim);
    }

    // A single obstacle that still cannot be passed is worse than none at all.
    if (this.narrowestCorridor(cluster, widthScale) < MIN_CORRIDOR) {
      return cluster.filter((o) => o.type === 'gap');
    }
    return cluster;
  }

  private buildObstacle(
    type: ObstacleType,
    segment: Segment,
    lane: number,
    usableLanes: number[],
    stage: number,
  ): Obstacle | null {
    const base: Obstacle = {
      id: nextObstacleId(),
      type,
      z: segment.z,
      lane,
      laneSpan: 1,
      phase: this.rng.range(0, Math.PI * 2),
      rate: 1,
      amplitude: 0,
      height: 2.4,
      passed: false,
      resolved: false,
    };

    switch (type) {
      case 'block':
        base.height = this.rng.chance(0.35) ? 2.2 : 4.5;
        break;

      case 'mover':
        base.amplitude = this.rng.range(0.8, 1.6);
        base.rate = this.rng.range(1.1, 2.1);
        base.height = 4.2;
        // Keep the sweep inside the road.
        base.lane = Math.max(MIN_LANE + 1, Math.min(MAX_LANE - 1, lane));
        break;

      case 'barrier':
        base.lane = 0;
        base.laneSpan = this.rng.int(3, 4);
        base.rate = this.rng.range(1.2, 2.2) * (this.rng.chance(0.5) ? 1 : -1);
        base.height = 3.8;
        break;

      case 'spinner':
        base.lane = 0;
        base.laneSpan = this.rng.int(3, 4);
        base.rate = this.rng.range(1.4, 2.4) * (this.rng.chance(0.5) ? 1 : -1);
        base.height = 4;
        break;

      case 'wall':
        base.lane = 0;
        base.laneSpan = this.rng.int(2, 3);
        base.amplitude = this.rng.range(1.2, 2);
        base.rate = this.rng.range(0.9, 1.5);
        base.height = 5;
        break;

      case 'gate': {
        // One or two safe lanes; two below the late stages so it stays fair.
        const safeCount = stage >= 3 ? 1 : this.rng.chance(0.6) ? 2 : 1;
        const shuffled = this.rng.shuffle(usableLanes);
        base.safeLanes = shuffled.slice(0, Math.max(1, Math.min(safeCount, shuffled.length)));
        base.lane = base.safeLanes[0];
        base.laneSpan = GAME.world.lanes;
        base.height = 5.5;
        base.rate = 0;
        break;
      }

      case 'faller':
        base.rate = this.rng.range(0.7, 1.1);
        base.height = 3;
        break;

      case 'laser':
        base.lane = this.rng.int(MIN_LANE + 1, MAX_LANE - 1);
        base.laneSpan = this.rng.int(2, 3);
        base.rate = this.rng.range(0.8, 1.4);
        // Low enough to jump — that is the intended answer to a laser.
        base.height = 2.1;
        break;

      case 'pulse':
        base.rate = this.rng.range(1.4, 2.6);
        base.height = 4.4;
        break;

      default:
        return null;
    }

    return base;
  }

  private maybePlacePrisms(segment: Segment, generous: boolean): void {
    const chance = generous ? 0.85 : 0.09;
    if (!this.rng.chance(chance)) return;
    const usable = this.usableLanes(segment.widthScale);
    const lane = this.rng.pick(usable);
    this.prisms.push({
      id: this.nextPrismId++,
      z: segment.z,
      lane,
      y: 0.9,
      collected: false,
    });
  }

  /** Which lanes exist at this road width. Narrow roads mask the outer lanes. */
  private usableLanes(widthScale: number): number[] {
    const halfLanes = Math.floor((GAME.world.lanes * widthScale) / 2);
    const lanes: number[] = [];
    for (let l = Math.max(MIN_LANE, -halfLanes); l <= Math.min(MAX_LANE, halfLanes); l++) lanes.push(l);
    return lanes.length > 0 ? lanes : [0];
  }
}
