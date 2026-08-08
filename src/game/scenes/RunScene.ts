/**
 * The run scene: one endless run from countdown to death.
 *
 * Structure of a frame, in order:
 *   1. advance the clock, speed and distance
 *   2. consume one buffered input
 *   3. integrate the ball (steering spring, jump arc)
 *   4. generate track ahead, recycle track behind
 *   5. collide against obstacles the ball crossed this frame
 *   6. render road, then entities, then the ball
 *
 * Collision runs on the *swept* interval between last frame's z and this
 * frame's z, not on the ball's current position. At 63 m/s a frame covers
 * about a metre, so a position-only test would let the ball tunnel straight
 * through thin obstacles at high speed — the classic endless-runner bug where
 * deaths feel random.
 */

import Phaser from 'phaser';
import { GAME } from '@/game/config';
import { Projector, fogFactor, mixColor, type CameraState } from '@/game/render/projection';
import { RoadRenderer } from '@/game/render/RoadRenderer';
import { TrackGenerator } from '@/game/world/TrackGenerator';
import {
  LANE_WIDTH,
  OBSTACLE_LABELS,
  extentAt,
  laneToX,
  type Extent,
  type Obstacle,
} from '@/game/world/obstacles';
import { SpritePool } from '@/game/systems/SpritePool';
import { Juice } from '@/game/systems/Juice';
import { SpeedCue, speedCueTier } from '@/game/systems/SpeedCue';
import { Backdrop } from '@/game/render/Backdrop';
import { TouchInput } from '@/game/systems/TouchInput';
import { generateBallTexture, generateSharedTextures, textureForTrail } from '@/game/render/textures';
import { gameEvents } from '@/game/events';
import { getSkin, getTrail } from '@/data/cosmetics';
import { getEnvironment, type Environment } from '@/data/progression';
import { PerformanceGovernor, isLiteTier, qualityFor } from '@/systems/device';
import { audio } from '@/systems/audio';
import { haptics } from '@/systems/haptics';
import { analytics } from '@/systems/analytics';
import { createRng, hashString, randomSeed } from '@/core/rng';
import type { PerfTier, RunResult } from '@/types';

export interface RunConfig {
  skinId: string;
  trailId: string;
  environmentId: string;
  tier: PerfTier;
  daily: boolean;
  /** Fixed seed for the daily challenge; omitted for a normal run. */
  seed?: number;
  reducedMotion: boolean;
  /**
   * Set when this run counts toward the Championship. The caller (PlayScreen)
   * is responsible for passing the matching challenge-wide `seed` alongside
   * this so every participant faces the identical track; `championshipPhase`
   * itself is what `die()` reads to structurally guarantee "no paid
   * advantages in the final" (see below). Omitted entirely for a normal run.
   */
  championshipPhase?: 'qualifying' | 'final';
}

type RunPhase = 'idle' | 'countdown' | 'running' | 'dying' | 'dead' | 'paused';

/** Scratch array for collision extents; never reallocated. */
const extents: Extent[] = new Array(4).fill(null).map(() => ({ min: 0, max: 0, bottom: 0, top: 0 }));

export class RunScene extends Phaser.Scene {
  private config!: RunConfig;
  private projector!: Projector;
  private road!: RoadRenderer;
  private track!: TrackGenerator;
  private input$!: TouchInput;
  private governor!: PerformanceGovernor;
  private env!: Environment;

  private obstaclePool!: SpritePool;
  private prismPool!: SpritePool;
  private decorPool!: SpritePool;
  private ball!: Phaser.GameObjects.Image;
  private ballShadow!: Phaser.GameObjects.Image;
  private trailEmitter?: Phaser.GameObjects.Particles.ParticleEmitter;
  private burstEmitter?: Phaser.GameObjects.Particles.ParticleEmitter;
  private sky!: Phaser.GameObjects.Graphics;
  private vignette!: Phaser.GameObjects.Graphics;
  private flashLayer!: Phaser.GameObjects.Rectangle;
  private backdrop!: Backdrop;
  private juice!: Juice;
  private speedCue!: SpeedCue;

  private camera: CameraState = { z: 0, x: 0, height: GAME.camera.height, curveX: 0, worldY: 0 };

  // --- Run state -------------------------------------------------------------
  private phase: RunPhase = 'idle';
  private runTime = 0;
  private startedAt = 0;
  private distance = 0;
  private score = 0;
  private speed: number = GAME.speed.start;
  private boostFactor = 1;
  private targetBoost = 1;
  private stage = 0;
  private prisms = 0;
  private chain = 0;
  private nearMisses = 0;
  private obstaclesDodged = 0;
  private topSpeed = 0;
  private seed = 0;
  private continued = false;
  private graceUntil = 0;

  private ballX = 0;
  /** Lateral velocity, m/s. Driven by the steering spring, clamped to a max. */
  private ballVx = 0;
  /** Accumulator for the fixed-step lateral integration. */
  private lateralAccumulator = 0;
  private ballY = 0;
  private ballZ = 0;
  private previousZ = 0;
  private airborne = false;
  /** Vertical velocity, m/s. The jump is integrated, not sampled from a curve. */
  private ballVy = 0;
  /** Landing squash timer. Separate from the jump clock — they are not the same thing. */
  private landingBounce = 0;
  private spin = 0;

  /**
   * Gravity, derived so a jump reaches exactly `jumpHeight` in `jumpTime`
   * seconds: for a symmetric arc, h = g·T²/8, so g = 8h/T².
   */
  private static readonly GRAVITY =
    (8 * GAME.player.jumpHeight) / (GAME.player.jumpTime * GAME.player.jumpTime);
  /** Launch velocity for that arc: v = g·T/2. */
  private static readonly JUMP_VELOCITY = (RunScene.GRAVITY * GAME.player.jumpTime) / 2;

  /** Consecutive frames the ball has projected outside the viewport. */
  private offScreenFrames = 0;

  private quality = qualityFor('high');
  private tickAccumulator = 0;
  private perfReportAt = 0;

  constructor() {
    super({ key: 'run' });
  }

  init(config: RunConfig): void {
    this.config = config;
  }

  create(): void {
    this.env = getEnvironment(this.config.environmentId);
    this.quality = qualityFor(this.config.tier);

    generateSharedTextures(this);
    generateBallTexture(this, getSkin(this.config.skinId));

    this.projector = new Projector();
    this.projector.setFogDistance(this.quality.drawDistance * GAME.world.segmentLength * 0.85);

    this.sky = this.add.graphics().setDepth(0);
    this.backdrop = new Backdrop(this, this.env, this.config.tier, this.config.reducedMotion);
    this.road = new RoadRenderer(this, this.projector, this.env, this.quality.drawDistance);
    this.road.setQuality(this.quality.drawDistance, !isLiteTier(this.config.tier));

    this.obstaclePool = new SpritePool(this, 'obstacle.block', 28, 20);
    this.prismPool = new SpritePool(this, 'prism', 16, 22);
    this.decorPool = new SpritePool(this, 'decor.post', 40, 12);

    this.ballShadow = this.add.image(0, 0, 'shadow').setDepth(24).setVisible(false);
    this.ball = this.add.image(0, 0, 'ball').setDepth(30);

    this.createParticles();
    this.vignette = this.add.graphics().setDepth(60);

    // Full-screen colour wash for impacts and pickups. A tinted rectangle is
    // an order of magnitude cheaper than the camera's own flash, and unlike the
    // camera version it composes with the vignette instead of overriding it.
    this.flashLayer = this.add
      .rectangle(0, 0, 10, 10, 0xffffff, 0)
      .setOrigin(0, 0)
      .setDepth(58)
      .setBlendMode(Phaser.BlendModes.ADD);

    this.juice = new Juice(this.cameras.main, {
      reducedMotion: this.config.reducedMotion,
      allowShake: !isLiteTier(this.config.tier),
    });

    this.applyPostFx();

    this.track = new TrackGenerator(0);
    this.input$ = new TouchInput(this);
    this.speedCue = new SpeedCue(this, speedCueTier(this.config.tier, this.config.reducedMotion));
    this.governor = new PerformanceGovernor(this.config.tier, (tier) => this.applyTier(tier));

    this.scale.on(Phaser.Scale.Events.RESIZE, this.layout, this);
    this.layout();

    // Nothing is interactive until the countdown finishes.
    this.input$.setEnabled(false);
    gameEvents.emit('ready', undefined);
    this.beginRun();
  }

  /**
   * Bloom, on the tiers that can pay for it.
   *
   * Phaser's bloom is a multi-pass gaussian over the whole frame — genuinely
   * expensive on a low-end GPU, and the art is already built around additive
   * emissive sprites, so the low tier loses very little by going without. The
   * medium tier gets a softer, cheaper configuration than high.
   */
  private applyPostFx(): void {
    if (this.config.reducedMotion || isLiteTier(this.config.tier)) return;
    try {
      // Restraint is the whole game here. Phaser's bloom has no luminance
      // threshold — it blooms the entire frame — so anything above about 0.5
      // strength stops being a glow on the bright elements and becomes a milky
      // veil over the dark ones, taking the road's contrast with it. These
      // values add halo to the emissive rails and the ball while leaving the
      // road surface and the lane markings crisp.
      const strong = this.config.tier === 'high';
      this.cameras.main.postFX.addBloom(
        0xffffff,
        1,
        1,
        strong ? 0.5 : 0.36,
        strong ? 0.55 : 0.4,
        strong ? 4 : 2,
      );
    } catch {
      // Bloom needs the WebGL renderer and a working post-pipeline; on a driver
      // that refuses it the game simply renders without.
    }
  }

  private createParticles(): void {
    const trail = getTrail(this.config.trailId);
    const texture = textureForTrail(trail);
    const rate = Math.round(trail.rate * this.quality.trailRateScale);

    if (rate > 0 && !this.config.reducedMotion) {
      // The emitter itself stays pinned at the origin and particles are spawned
      // via particleX/particleY. Moving the emitter GameObject instead would
      // drag every live particle with it — the trail would stick to the ball
      // rather than being left behind it, which is the whole point.
      this.trailEmitter = this.add.particles(0, 0, texture, {
        lifespan: trail.style === 'ribbon' ? 700 : 520,
        // Screen-space "down" is toward the camera: the track recedes, so
        // anything the ball leaves behind travels down and outward.
        speed: { min: 30, max: 150 },
        angle: { min: 66, max: 114 },
        scale: { start: 0.55, end: 0 },
        alpha: { start: 0.9, end: 0 },
        quantity: 1,
        frequency: Math.max(12, 1000 / rate),
        blendMode: Phaser.BlendModes.ADD,
        tint: trail.colors,
        maxAliveParticles: Math.round(this.quality.maxParticles * 0.6),
      });
      this.trailEmitter.setDepth(28);
    }

    this.burstEmitter = this.add.particles(0, 0, 'spark', {
      lifespan: 620,
      speed: { min: 60, max: 260 },
      scale: { start: 0.65, end: 0 },
      alpha: { start: 1, end: 0 },
      blendMode: Phaser.BlendModes.ADD,
      emitting: false,
      maxAliveParticles: this.quality.maxParticles,
    });
    this.burstEmitter.setDepth(40);
  }

  private layout(): void {
    const { width, height } = this.scale.gameSize;
    // Steering sensitivity is a fraction of the viewport, so it has to be
    // recomputed whenever the viewport changes (rotation, browser chrome).
    this.input$?.resize(width);
    this.projector.resize(width, height, {
      playerOffset: GAME.camera.playerOffset,
      cameraHeight: GAME.camera.height,
      roadHalfWidth: GAME.world.roadHalfWidth,
      playerRadius: GAME.player.radius,
      roadFill: GAME.camera.roadFill,
      ballAnchor: GAME.camera.ballAnchor,
      minHorizon: GAME.camera.minHorizon,
    });
    this.drawSky(width, height);
    this.drawVignette(width, height);
    this.flashLayer?.setSize(width, height);
    this.backdrop?.resize(width, height, this.projector.horizon);
    this.speedCue?.resize(width, height);
  }

  private drawSky(width: number, height: number): void {
    const g = this.sky;
    g.clear();
    const [top, bottom] = this.env.palette.sky;
    const horizon = this.projector.horizon;

    // A stepped gradient: 24 bands is indistinguishable from a smooth one at
    // this contrast and costs a fraction of a bitmap upload on every resize.
    const bands = 24;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      g.fillStyle(mixColor(top, bottom, t), 1);
      g.fillRect(0, (horizon / bands) * i, width, horizon / bands + 1);
    }

    // Starfield. Seeded from the environment id so a given world always has
    // the same sky, and drawn once into the static layer rather than per frame.
    const stars = createRng(hashString(this.env.id));
    const count = isLiteTier(this.config.tier) ? 40 : 110;
    for (let i = 0; i < count; i++) {
      const x = stars.range(0, width);
      // Bias stars upward: a uniform spread looks like noise, a squared
      // distribution looks like a sky.
      const y = stars.next() ** 1.7 * horizon * 0.95;
      const size = stars.range(0.6, 1.9);
      g.fillStyle(0xffffff, stars.range(0.16, 0.7));
      g.fillRect(x, y, size, size);
    }

    // Ground plane below the horizon, so the road sits on something.
    g.fillStyle(mixColor(bottom, this.env.palette.fog, 0.45), 1);
    g.fillRect(0, horizon - 1, width, height - horizon + 1);

    // Horizon bloom, layered so it falls off smoothly into the sky.
    for (let i = 3; i >= 1; i--) {
      g.fillStyle(this.env.palette.rumble, 0.07);
      g.fillEllipse(width / 2, horizon, width * (0.5 + i * 0.35), height * 0.035 * i);
    }
    g.fillStyle(this.env.palette.accent, 0.05);
    g.fillEllipse(width / 2, horizon, width * 0.6, height * 0.02);
  }

  private drawVignette(width: number, height: number): void {
    const g = this.vignette;
    g.clear();
    // Corner darkening, approximated with four edge bands. A radial gradient
    // would need a texture; this is visually equivalent behind the HUD.
    const depth = Math.min(width, height) * 0.22;
    for (let i = 0; i < 8; i++) {
      const alpha = 0.055 * (1 - i / 8);
      const inset = (depth / 8) * i;
      g.fillStyle(0x000000, alpha);
      g.fillRect(0, inset, width, depth / 8 + 1);
      g.fillRect(0, height - inset - depth / 8, width, depth / 8 + 1);
      g.fillRect(inset, 0, depth / 8 + 1, height);
      g.fillRect(width - inset - depth / 8, 0, depth / 8 + 1, height);
    }
  }

  // --- Lifecycle --------------------------------------------------------------

  private beginRun(): void {
    this.seed = this.config.seed ?? randomSeed();
    this.track.reset(this.seed);

    this.runTime = 0;
    this.distance = 0;
    this.score = 0;
    this.speed = GAME.speed.start;
    this.boostFactor = 1;
    this.targetBoost = 1;
    this.stage = 0;
    this.prisms = 0;
    this.chain = 0;
    this.nearMisses = 0;
    this.obstaclesDodged = 0;
    this.topSpeed = GAME.speed.start as number;
    this.continued = false;
    this.graceUntil = 0;

    this.ballX = 0;
    this.ballVx = 0;
    this.lateralAccumulator = 0;
    this.input$.recentre(0);
    this.ballY = 0;
    this.ballZ = GAME.camera.playerOffset;
    this.previousZ = this.ballZ;
    this.camera.z = 0;
    this.camera.x = 0;
    this.camera.worldY = 0;
    this.airborne = false;
    this.ballVy = 0;
    this.landingBounce = 0;
    this.offScreenFrames = 0;
    this.juice.reset();

    this.track.ensureAhead(this.ballZ + this.quality.drawDistance * GAME.world.segmentLength, 0, this.speed);

    this.phase = 'countdown';
    this.startCountdown();
  }

  private startCountdown(): void {
    let value = 3;
    gameEvents.emit('countdown', { value });
    audio.play('countdown', { pitch: 1 });
    const timer = this.time.addEvent({
      delay: 600,
      repeat: 3,
      callback: () => {
        value--;
        gameEvents.emit('countdown', { value });
        if (value > 0) {
          audio.play('countdown', { pitch: 1 + (3 - value) * 0.12 });
        } else {
          audio.play('boost');
          timer.remove();
          this.phase = 'running';
          this.startedAt = Date.now();
          this.input$.setEnabled(true);
          audio.setIntensity(0.35);
          gameEvents.emit('started', { daily: this.config.daily, seed: this.seed });
        }
      },
    });
  }

  pauseRun(): void {
    if (this.phase !== 'running') return;
    this.phase = 'paused';
    this.input$.setEnabled(false);
    this.input$.flush();
    audio.setIntensity(0.1);
    gameEvents.emit('paused', undefined);
  }

  resumeRun(): void {
    if (this.phase !== 'paused') return;
    this.phase = 'running';
    // Re-anchor on the ball's current position, or it would immediately spring
    // back to wherever the finger last left the target.
    this.input$.recentre(this.ballX);
    this.input$.setEnabled(true);
    audio.setIntensity(this.intensity());
    gameEvents.emit('resumed', undefined);
  }

  /** Called when the player takes a rewarded-ad continue. */
  continueRun(): void {
    if (this.phase !== 'dead' && this.phase !== 'dying') return;
    this.continued = true;
    this.chain = 0;
    this.speed = Math.max(GAME.speed.start, this.speed * GAME.speed.continueFalloff);
    this.graceUntil = this.runTime + GAME.player.continueGrace;

    // Clear the road immediately ahead so the player does not respawn into the
    // thing that just killed them.
    const clearTo = this.ballZ + this.speed * 2.2;
    for (const obstacle of this.track.activeObstacles) {
      if (obstacle.z > this.ballZ - 4 && obstacle.z < clearTo) obstacle.resolved = true;
    }

    this.ballX = 0;
    this.ballVx = 0;
    this.lateralAccumulator = 0;
    this.ballY = 0;
    this.airborne = false;
    this.ball.setAlpha(1);
    this.input$.recentre(0);

    this.phase = 'running';
    this.input$.setEnabled(true);
    this.input$.flush();
    audio.setIntensity(this.intensity());
    gameEvents.emit('continued', undefined);
  }

  /** Ends the run for good and hands the result to the app layer. */
  finishRun(): void {
    if (this.phase === 'idle') return;
    this.phase = 'dead';
    this.input$.setEnabled(false);
    audio.setIntensity(0);
    gameEvents.emit('finished', { result: this.buildResult() });
  }

  private buildResult(): RunResult {
    return {
      score: Math.floor(this.score),
      distance: Math.floor(this.distance),
      durationMs: Math.max(0, Date.now() - this.startedAt),
      prisms: this.prisms,
      obstaclesDodged: this.obstaclesDodged,
      nearMisses: this.nearMisses,
      topSpeed: this.topSpeed,
      stage: this.stage,
      seed: this.seed,
      daily: this.config.daily,
      endedAt: Date.now(),
      continued: this.continued,
    };
  }

  // --- Frame ------------------------------------------------------------------

  update(time: number, deltaMs: number): void {
    // Clamp: a backgrounded tab returns with a multi-second delta, and
    // integrating that would teleport the ball through half the level.
    const dt = Math.min(deltaMs, 50) / 1000;

    this.governor.sample(deltaMs, time);

    // Hit stop and slow motion scale the *simulation* only. Rendering keeps
    // running at full rate so particles and the backdrop stay alive through a
    // freeze, which is what separates a deliberate pause from a stutter.
    const simDt = this.juice.update(dt);

    if (this.phase === 'running') {
      this.stepSimulation(simDt);
    } else if (this.phase === 'dying') {
      this.stepDeath(simDt);
    }

    this.projector.setFov(this.juice.fovScale);
    this.renderFrame(dt);
    this.emitTick(dt, time);
  }

  private stepSimulation(dt: number): void {
    this.runTime += dt;

    // Difficulty stage.
    const stages = GAME.difficulty.stages;
    let stage = 0;
    for (let i = 0; i < stages.length; i++) if (this.runTime >= stages[i].atSeconds) stage = i;
    if (stage !== this.stage) {
      this.stage = stage;
      this.score += GAME.scoring.stageBonus;
      audio.setIntensity(this.intensity());
      gameEvents.emit('stage', { stage, name: stages[stage].name });
      haptics.fire('success');
      this.juice.punch(GAME.juice.stagePunch);
      this.juice.flashScreen(this.env.palette.accent, 0.35);
      audio.play('achievement', { gain: 0.5 });
    }

    // Speed. Linear in survival time, eased toward the boost multiplier.
    const base = Math.min(GAME.speed.max, GAME.speed.start + this.runTime * GAME.speed.accel * 10);
    this.boostFactor += (this.targetBoost - this.boostFactor) * Math.min(1, dt * GAME.speed.boostLerp);
    this.speed = base * this.boostFactor;
    this.topSpeed = Math.max(this.topSpeed, this.speed);

    this.previousZ = this.ballZ;
    const advance = this.speed * dt;
    this.distance += advance;
    this.ballZ += advance;
    this.camera.z = this.ballZ - GAME.camera.playerOffset;
    this.score += advance * GAME.scoring.perMetre;

    this.handleInput(dt);
    this.integrateBall(dt);

    // Continuous, velocity-driven: the camera banks *through* a move rather
    // than snapping after one.
    this.juice.setLean(this.ballVx);
    this.juice.setSpeedFov(this.speed);

    // Keep the world generated well past the fog plane so nothing pops in.
    this.track.ensureAhead(this.ballZ + (this.quality.drawDistance + 20) * GAME.world.segmentLength, this.stage, this.speed);
    this.track.recycle(this.camera.z);

    this.updateBoostZone();
    this.checkCollisions();
    this.collectPrisms();
  }

  private intensity(): number {
    return Math.min(1, 0.3 + (this.speed - GAME.speed.start) / (GAME.speed.max - GAME.speed.start) * 0.7);
  }

  /** Half the lateral space the ball may occupy at a given z, in metres. */
  private lateralLimitAt(z: number): number {
    const segment = this.track.segmentAt(z);
    const width = GAME.world.roadHalfWidth * (segment?.widthScale ?? 1);
    // Keep the whole ball on the road, not just its centre.
    return Math.max(GAME.player.radius, width - GAME.player.radius);
  }

  private handleInput(dt: number): void {
    // --- Steering: continuous, read every frame -------------------------------
    const axis = this.input$.keyboardAxis;
    if (axis !== 0) {
      this.input$.setTarget(this.input$.target + axis * GAME.control.keyboardSpeed * dt);
    }

    // Clamp the target to the road and write it back, so dragging past the edge
    // never accumulates slack that has to be unwound before the ball responds.
    const limit = this.lateralLimitAt(this.ballZ);
    const clamped = Math.max(-limit, Math.min(limit, this.input$.target));
    if (clamped !== this.input$.target) this.input$.setTarget(clamped);

    // Release inertia: a small carry-through so lifting the finger eases out
    // instead of stopping dead.
    const impulse = this.input$.takeReleaseImpulse();
    if (impulse !== 0) {
      this.ballVx = Math.max(
        -GAME.control.maxLateralSpeed,
        Math.min(GAME.control.maxLateralSpeed, this.ballVx + impulse),
      );
    }

    // --- Discrete actions -----------------------------------------------------
    const action = this.input$.consumeAction();
    if (!action) return;

    switch (action) {
      case 'jump':
        if (!this.airborne) {
          this.airborne = true;
          this.ballVy = RunScene.JUMP_VELOCITY;
          this.landingBounce = 0;
          audio.play('jump');
          haptics.fire('tap');
        }
        break;
      case 'slam':
        if (this.airborne) {
          // Drive the ball down hard: the counter-play to a badly timed jump.
          // Setting a velocity rather than rescaling a duration means the arc
          // stays a real trajectory and cannot be pushed to a negative or
          // absurd airtime by repeated inputs.
          this.ballVy = Math.min(this.ballVy, -GAME.player.slamSpeed);
        }
        break;
    }
  }

  /**
   * Lateral motion: a critically damped spring chasing the steering target.
   *
   *   a = w2*(target - x) - 2w*v      (critical damping: zeta = 1)
   *
   * Critical damping is the specific reason this feels controlled rather than
   * floaty — it is the fastest response that cannot overshoot, so the ball
   * never oscillates around the finger and needs no deadzone to hide wobble.
   *
   * Velocity is clamped, which is what stops a fast flick from teleporting the
   * ball: the spring asks for whatever acceleration it likes, but the ball can
   * only ever travel at `maxLateralSpeed`.
   *
   * Integrated at a fixed substep rather than once per frame. The spring is
   * stiff (w ~ 41 rad/s) and explicit integration at a 33ms frame time is close
   * to its stability limit — on a device that drops to 20fps the naive version
   * rings or diverges, which reads to a player as the controls "breaking" on
   * exactly the hardware that can least afford it.
   */
  private integrateLateral(dt: number): void {
    const omega = 2 * Math.PI * GAME.control.responseHz;
    const maxSpeed = GAME.control.maxLateralSpeed;
    const step = GAME.control.substep;
    const target = this.input$.target;

    this.lateralAccumulator += dt;
    // Bound the catch-up so a long stall cannot spiral into hundreds of steps.
    if (this.lateralAccumulator > 0.25) this.lateralAccumulator = 0.25;

    while (this.lateralAccumulator >= step) {
      this.lateralAccumulator -= step;
      const accel = omega * omega * (target - this.ballX) - 2 * omega * this.ballVx;
      this.ballVx += accel * step;
      if (this.ballVx > maxSpeed) this.ballVx = maxSpeed;
      else if (this.ballVx < -maxSpeed) this.ballVx = -maxSpeed;
      this.ballX += this.ballVx * step;
    }

    // Hard wall at the road edge. Zeroing the inward velocity stops the ball
    // from grinding along the rail with a bank of stored spring energy that
    // fires it across the road the moment the finger comes back.
    const limit = this.lateralLimitAt(this.ballZ);
    if (this.ballX > limit) {
      this.ballX = limit;
      if (this.ballVx > 0) this.ballVx = 0;
    } else if (this.ballX < -limit) {
      this.ballX = -limit;
      if (this.ballVx < 0) this.ballVx = 0;
    }
  }

  private integrateBall(dt: number): void {
    this.integrateLateral(dt);

    // Vertical motion: a straightforward semi-implicit Euler integration under
    // constant gravity. It replaces a parametric arc sampled by elapsed time,
    // which had no notion of velocity and so could not be interrupted (a slam
    // had to rewrite the jump's duration mid-flight, which is what let a
    // mistimed input produce a nonsensical trajectory).
    //
    // There is no restitution: the ball does not bounce on landing, by design.
    // Landing is a hard stop plus a cosmetic squash, because a bouncing ball in
    // a lane-based runner costs the player control at exactly the moment they
    // need it back.
    if (this.airborne) {
      this.ballVy -= RunScene.GRAVITY * dt;
      this.ballY += this.ballVy * dt;

      if (this.ballY <= 0) {
        this.ballY = 0;
        this.ballVy = 0;
        this.airborne = false;
        this.landingBounce = 0.18;
        audio.play('land', { gain: 0.5 });
        haptics.fire('tap');
      } else if (this.ballY > GAME.player.maxHeight) {
        // Structural backstop. Unreachable with the constants above; here so a
        // future change to the arc degrades to a capped jump rather than to a
        // ball outside the shot.
        this.ballY = GAME.player.maxHeight;
        this.ballVy = Math.min(this.ballVy, 0);
      }
    } else {
      this.ballY = 0;
      this.ballVy = 0;
      if (this.landingBounce > 0) this.landingBounce = Math.max(0, this.landingBounce - dt);
    }

    // Rolling. Circumference-accurate so the ball never looks like it slides.
    this.spin += (this.speed * dt) / (GAME.player.radius * Math.PI * 2) * 360;

    // Camera follows laterally, damped, and leans into curves.
    const curveLean = this.road.curveOffsetAt(this.ballZ + 30) - this.road.curveOffsetAt(this.ballZ);
    const targetX = this.ballX * 0.55 + curveLean * GAME.camera.curveLean * 0.05;
    this.camera.x += (targetX - this.camera.x) * Math.min(1, dt * 6);

    // Vertical: the camera tracks the *terrain*, never the ball.
    //
    // Its height above the road is a constant (GAME.camera.height); the only
    // thing that moves is the ground elevation it is measured from, and that is
    // smoothed so a sharp crest eases the horizon instead of snapping it.
    // Because the ball's own height never enters this, a jump moves the ball
    // within the frame and leaves the camera completely still.
    const groundUnderCamera = this.road.elevationAt(this.camera.z);
    const smoothing = 1 - Math.exp(-GAME.camera.elevationLerp * dt);
    this.camera.worldY += (groundUnderCamera - this.camera.worldY) * smoothing;

    // Smoothing alone is unbounded on a sustained climb, and an unbounded lag
    // is precisely what walks the ball off the top or bottom of the screen.
    // Clamp the reference to within a fixed distance of the ground under the
    // ball, which puts a hard ceiling on how far the ball can leave its anchor.
    const groundUnderBall = this.road.elevationAt(this.ballZ);
    const lag = GAME.camera.maxElevationLag;
    this.camera.worldY = Math.max(
      groundUnderBall - lag,
      Math.min(groundUnderBall + lag, this.camera.worldY),
    );
  }

  private updateBoostZone(): void {
    const segment = this.track.segmentAt(this.ballZ);
    const boosting = Boolean(segment?.boost);
    const desired = boosting ? GAME.speed.boostMultiplier : 1;
    if (desired !== this.targetBoost) {
      this.targetBoost = desired;
      if (boosting) {
        audio.play('boost');
        haptics.fire('select');
        this.juice.shake(180, 0.004);
        this.juice.punch(0.03);
        this.juice.flashScreen(this.env.palette.accent, 0.2);
      }
    }
  }

  // --- Collision --------------------------------------------------------------

  /**
   * Swept collision against every obstacle whose plane the ball crossed this
   * frame. The obstacle list is sorted by z, so this is a short forward scan,
   * not a search.
   */
  private checkCollisions(): void {
    const obstacles = this.track.activeObstacles;
    const from = this.previousZ;
    const to = this.ballZ;
    const invulnerable = this.runTime < this.graceUntil;

    for (let i = 0; i < obstacles.length; i++) {
      const obstacle = obstacles[i];
      if (obstacle.z > to + 1) break; // sorted: nothing further can have been crossed
      if (obstacle.passed || obstacle.resolved) continue;
      if (obstacle.z < from) {
        obstacle.passed = true;
        continue;
      }
      if (obstacle.z > to) continue;

      obstacle.passed = true;

      // Sample the obstacle at the exact moment of crossing rather than at the
      // frame boundary — at 60Hz that is up to a 16ms error, which is visible
      // on a fast-rotating barrier.
      const crossFraction = to > from ? (obstacle.z - from) / (to - from) : 0;
      const sampleTime = this.runTime - (1 - crossFraction) * (to - from) / Math.max(1, this.speed);

      const hit = this.testObstacle(obstacle, sampleTime);

      if (hit === 'hit') {
        if (invulnerable) {
          obstacle.resolved = true;
          continue;
        }
        this.die(OBSTACLE_LABELS[obstacle.type]);
        return;
      }

      this.obstaclesDodged++;
      if (hit === 'near') {
        this.nearMisses++;
        this.score += GAME.scoring.perNearMiss;
        audio.play('near_miss');
        // The signature moment of the genre: the world drops into slow motion
        // for a fifth of a second and the camera leans in, so threading a gap
        // registers as a skill rather than as nothing happening.
        this.juice.slowMotion(GAME.juice.nearMissScale, GAME.juice.nearMissSeconds);
        this.juice.punch(GAME.juice.nearMissPunch);
        this.juice.flashScreen(0xffffff, 0.18);
        haptics.fire('select');
        gameEvents.emit('nearMiss', { total: this.nearMisses });
      }
    }
  }

  private testObstacle(obstacle: Obstacle, sampleTime: number): 'hit' | 'near' | 'clear' {
    const count = extentAt(obstacle, sampleTime, extents);
    if (count === 0) return 'clear';

    const ballMin = this.ballX - GAME.player.radius;
    const ballMax = this.ballX + GAME.player.radius;
    const ballBottom = this.ballY;
    const ballTop = this.ballY + GAME.player.radius * 2;

    let nearest = Infinity;

    for (let i = 0; i < count; i++) {
      const extent = extents[i];
      const overlapsX = ballMax > extent.min && ballMin < extent.max;

      if (obstacle.type === 'gap') {
        // Inverted logic: the gap is safe only while the ball is off the ground.
        if (overlapsX && ballBottom < 0.35) return 'hit';
        continue;
      }

      if (overlapsX) {
        // Vertical test: cleared if the ball is entirely above the obstacle, or
        // entirely below a raised one (a faller still hanging overhead).
        const above = ballBottom >= extent.top - 0.15;
        const below = ballTop <= extent.bottom + 0.15;
        if (!above && !below) return 'hit';
      } else {
        const gap = ballMin > extent.max ? ballMin - extent.max : extent.min - ballMax;
        nearest = Math.min(nearest, gap);
      }
    }

    return nearest <= GAME.player.nearMissRadius ? 'near' : 'clear';
  }

  private collectPrisms(): void {
    const prisms = this.track.activePrisms;
    const from = this.previousZ;
    const to = this.ballZ;

    for (let i = 0; i < prisms.length; i++) {
      const prism = prisms[i];
      if (prism.z > to + 1) break;
      if (prism.collected || prism.z < from || prism.z > to) continue;

      const dx = Math.abs(laneToX(prism.lane) - this.ballX);
      const dy = Math.abs(prism.y - (this.ballY + GAME.player.radius));
      // Generous pickup radius. Missing a collectable you clearly drove through
      // feels like a bug even when it is technically correct.
      if (dx > LANE_WIDTH * 0.75 || dy > 1.6) {
        this.chain = 0;
        continue;
      }

      prism.collected = true;
      this.prisms++;
      this.chain++;
      // Chain bonus caps at 5x so a lucky bonus lane cannot dwarf survival.
      const multiplier = Math.min(5, 1 + Math.floor(this.chain / 5) * 0.5);
      this.score += GAME.scoring.perPrism * multiplier;

      audio.play(this.chain > 8 ? 'prism.streak' : 'prism', { pitch: 1 + Math.min(0.5, this.chain * 0.03) });
      haptics.fire('tap');
      // A deep chain earns a frame of stillness and a warm flash; a single
      // pickup gets neither, so the escalation is legible.
      if (this.chain >= 5) {
        this.juice.freeze(GAME.juice.chainFreeze);
        this.juice.flashScreen(0xf59e0b, Math.min(0.3, 0.08 + this.chain * 0.015));
      }
      gameEvents.emit('prism', { total: this.prisms, chain: this.chain });

      if (this.burstEmitter && !this.config.reducedMotion) {
        const projected = this.projector.project(
          this.camera,
          laneToX(prism.lane),
          prism.y,
          prism.z,
          this.road.curveOffsetAt(prism.z),
        );
        if (projected.visible) {
          this.burstEmitter.setParticleTint(0xf59e0b);
          this.burstEmitter.emitParticleAt(projected.screenX, projected.screenY, 6);
        }
      }
    }
  }

  private die(cause: string): void {
    if (this.phase !== 'running') return;
    this.phase = 'dying';
    this.input$.setEnabled(false);
    this.targetBoost = 1;

    audio.play('crash');
    audio.setIntensity(0.15);
    haptics.fire('heavy');

    // Freeze first, then shake. A few frames of absolute stillness at the
    // moment of impact carries more weight than any amount of shake, and the
    // shake reads as a consequence of the freeze rather than as noise.
    this.juice.freeze(GAME.juice.crashFreeze);
    this.juice.shake(320, 0.016);
    this.juice.flashScreen(0xf43f5e, 0.85);
    this.juice.punch(0.05);

    if (this.burstEmitter) {
      this.burstEmitter.setParticleTint(0xf87171);
      this.burstEmitter.emitParticleAt(this.ball.x, this.ball.y, isLiteTier(this.config.tier) ? 10 : 24);
    }
    this.trailEmitter?.stop();

    // Championship final: no continue exists here at all, paid or ad-based —
    // not hidden in the UI, structurally absent from this code path. This is
    // the one line that makes "no paid advantages in the final" true rather
    // than merely intended.
    const canContinue = this.config.championshipPhase !== 'final' && !this.continued && this.runTime > 8;
    analytics.track('run_death', {
      cause,
      distance: Math.round(this.distance),
      stage: this.stage,
      speed: Math.round(this.speed),
      runTime: Math.round(this.runTime),
    });

    gameEvents.emit('died', { result: this.buildResult(), canContinue, cause });
  }

  /** Short death animation: the world coasts to a stop while the ball fades. */
  private stepDeath(dt: number): void {
    this.speed = Math.max(0, this.speed - dt * 90);
    const advance = this.speed * dt;
    this.ballZ += advance;
    this.camera.z = this.ballZ - GAME.camera.playerOffset;
    this.ball.setAlpha(Math.max(0.15, this.ball.alpha - dt * 1.4));
    this.track.recycle(this.camera.z);
  }

  // --- Rendering --------------------------------------------------------------

  private renderFrame(dt: number): void {
    this.backdrop.update(this.camera.x, this.road.curveOffsetAt(this.camera.z + 400), this.speed, dt);
    this.road.render(this.camera, this.track);
    this.renderDecor();
    this.renderPrisms();
    this.renderObstacles();
    this.renderBall();
    // Peripheral only — rendered before the flash wash so a crash's red flash
    // still reads as the topmost, most urgent layer.
    const speedIntensity = this.phase === 'running' ? this.intensity() : 0;
    this.speedCue.update(speedIntensity, this.targetBoost > 1, this.runTime);
    this.renderFlash();
  }

  /** Applies the decaying colour wash. One property write per frame. */
  private renderFlash(): void {
    const { strength, color } = this.juice.flashState;
    if (strength <= 0.001) {
      if (this.flashLayer.alpha !== 0) this.flashLayer.setAlpha(0);
      return;
    }
    this.flashLayer.setFillStyle(color, 1);
    this.flashLayer.setAlpha(Math.min(0.55, strength * 0.55));
  }

  /**
   * Roadside posts, every few segments on both shoulders. Drawn from the same
   * projection as everything else, so they sit on the road as it curves and
   * crests. Cheap — two sprites per placement, and the near ones are the only
   * ones large enough to matter.
   */
  private renderDecor(): void {
    const pool = this.decorPool;
    pool.begin();

    const spacing = 4; // segments between posts
    const segLength = GAME.world.segmentLength;
    const baseIndex = Math.ceil(this.camera.z / segLength);
    const lastIndex = baseIndex + Math.floor(this.quality.drawDistance * 0.8);

    for (let index = baseIndex - (baseIndex % spacing); index <= lastIndex; index += spacing) {
      const segment = this.track.segmentByIndex(index);
      if (!segment) continue;

      const z = segment.z;
      const curve = this.road.curveOffsetAt(z);
      const offset = GAME.world.roadHalfWidth * segment.widthScale * 1.28;

      for (const side of [-1, 1]) {
        const projected = this.projector.project(this.camera, side * offset, segment.y + 1.5, z, curve);
        if (!projected.visible) continue;

        const fog = fogFactor(projected.depth, 2.4);
        if (fog > 0.9) continue;

        const sprite = pool.acquire('decor.post');
        sprite.setPosition(projected.screenX, projected.screenY);
        sprite.setDisplaySize(Math.max(1, 0.55 * projected.scale), Math.max(2, 3 * projected.scale));
        sprite.setDepth(12);
        sprite.setBlendMode(Phaser.BlendModes.ADD);
        sprite.setAlpha((1 - fog) * 0.85);
        sprite.setTint(segment.boost ? this.env.palette.accent : this.env.palette.lane);
      }
    }

    pool.end();
  }

  private renderObstacles(): void {
    const pool = this.obstaclePool;
    pool.begin();

    const obstacles = this.track.activeObstacles;
    const maxZ = this.camera.z + this.quality.drawDistance * GAME.world.segmentLength;

    // Iterate far to near so nearer obstacles are acquired last and can be
    // given a higher depth without a sort.
    let firstVisible = 0;
    while (firstVisible < obstacles.length && obstacles[firstVisible].z < this.camera.z - 6) firstVisible++;
    let lastVisible = firstVisible;
    while (lastVisible < obstacles.length && obstacles[lastVisible].z < maxZ) lastVisible++;

    for (let i = lastVisible - 1; i >= firstVisible; i--) {
      const obstacle = obstacles[i];
      if (obstacle.resolved && obstacle.type !== 'gap') continue;
      this.drawObstacle(pool, obstacle, i);
    }

    pool.end();
  }

  private drawObstacle(pool: SpritePool, obstacle: Obstacle, index: number): void {
    const curve = this.road.curveOffsetAt(obstacle.z);
    const roadY = this.road.elevationAt(obstacle.z);
    const count = extentAt(obstacle, this.runTime, extents);
    if (count === 0 && obstacle.type !== 'gap') return;

    const depthBase = 20 + (10000 - Math.min(9999, obstacle.z - this.camera.z)) * 0.0001;

    for (let e = 0; e < count; e++) {
      const extent = extents[e];
      const centreX = (extent.min + extent.max) / 2;
      const widthMetres = extent.max - extent.min;
      const heightMetres = Math.max(0.4, extent.top - extent.bottom);
      const centreY = roadY + extent.bottom + heightMetres / 2;

      const projected = this.projector.project(this.camera, centreX, centreY, obstacle.z, curve);
      if (!projected.visible) continue;

      const fog = fogFactor(projected.depth, 2.2);
      if (fog > 0.97) continue;

      const texture = this.textureFor(obstacle);
      const sprite = pool.acquire(texture);
      sprite.setPosition(projected.screenX, projected.screenY);
      sprite.setDisplaySize(
        Math.max(2, widthMetres * projected.scale),
        Math.max(2, heightMetres * projected.scale),
      );
      sprite.setDepth(depthBase + index * 0.0001 + e * 0.00001);
      sprite.setTint(mixColor(0xffffff, this.env.palette.fog, fog));
      sprite.setAlpha(1 - fog * 0.15);

      if (obstacle.type === 'laser') {
        sprite.setBlendMode(Phaser.BlendModes.ADD);
        // Pulse the beam so an armed laser is unmistakable at distance.
        sprite.setAlpha((0.75 + Math.sin(this.runTime * 18) * 0.2) * (1 - fog * 0.4));
      } else if (obstacle.type === 'barrier' || obstacle.type === 'spinner') {
        // Fake the pivot by squashing the bar rather than rotating a quad in
        // screen space, which would not match the projection.
        sprite.setAngle(Math.sin(this.runTime * obstacle.rate + obstacle.phase) * 6);
      }
    }

    // Gate frame: a decorative outline around the whole road, drawn on top of
    // the solid panels so the safe lane reads as an opening.
    if (obstacle.type === 'gate') {
      const projected = this.projector.project(this.camera, 0, roadY + 2.6, obstacle.z, curve);
      if (projected.visible) {
        const fog = fogFactor(projected.depth, 2.2);
        if (fog < 0.95) {
          const frame = pool.acquire('obstacle.gate');
          frame.setPosition(projected.screenX, projected.screenY);
          frame.setDisplaySize(GAME.world.roadHalfWidth * 2.2 * projected.scale, 5.6 * projected.scale);
          frame.setDepth(depthBase + index * 0.0001 + 0.00005);
          frame.setBlendMode(Phaser.BlendModes.ADD);
          frame.setAlpha(0.75 * (1 - fog));
        }
      }
    }
  }

  private textureFor(obstacle: Obstacle): string {
    switch (obstacle.type) {
      case 'block':
      case 'pulse':
        return 'obstacle.block';
      case 'mover':
      case 'wall':
        return 'obstacle.wall';
      case 'faller':
        return 'obstacle.platform';
      case 'barrier':
        return 'obstacle.bar';
      case 'spinner':
        return 'obstacle.spinner';
      case 'gate':
        return 'obstacle.gate.hazard';
      case 'laser':
        return 'obstacle.laser';
      case 'gap':
      default:
        return 'obstacle.block';
    }
  }

  private renderPrisms(): void {
    const pool = this.prismPool;
    pool.begin();

    const prisms = this.track.activePrisms;
    const maxZ = this.camera.z + this.quality.drawDistance * GAME.world.segmentLength * 0.75;

    for (let i = prisms.length - 1; i >= 0; i--) {
      const prism = prisms[i];
      if (prism.collected || prism.z < this.camera.z || prism.z > maxZ) continue;

      const curve = this.road.curveOffsetAt(prism.z);
      const roadY = this.road.elevationAt(prism.z);
      const projected = this.projector.project(this.camera, laneToX(prism.lane), roadY + prism.y, prism.z, curve);
      if (!projected.visible) continue;

      const fog = fogFactor(projected.depth, 2.2);
      if (fog > 0.94) continue;

      const sprite = pool.acquire('prism');
      const size = 1.5 * projected.scale;
      sprite.setPosition(projected.screenX, projected.screenY);
      sprite.setDisplaySize(size, size);
      sprite.setDepth(22);
      sprite.setBlendMode(Phaser.BlendModes.ADD);
      sprite.setAlpha(1 - fog * 0.6);
      // Bob and spin so collectables catch the eye against a busy road.
      sprite.setAngle(Math.sin(this.runTime * 2 + prism.z * 0.1) * 14);
      sprite.y += Math.sin(this.runTime * 3 + prism.z * 0.2) * projected.scale * 0.12;
    }

    pool.end();
  }

  /**
   * Recovery path for a ball that has left the frame.
   *
   * A single bad frame is tolerated — a resize mid-frame can produce one. A
   * sustained one means the run is unplayable, and letting it continue means
   * banking a score the player did not earn and could not see. Recover once by
   * resetting the vertical state; if that does not take, end the run.
   */
  private noteBallOffScreen(reason: string): void {
    if (this.phase !== 'running') return;
    this.offScreenFrames++;

    if (this.offScreenFrames === 12) {
      analytics.track('ball_offscreen_recovered', {
        reason,
        distance: Math.round(this.distance),
        ballY: this.ballY,
        cameraWorldY: this.camera.worldY,
      });
      this.ballY = 0;
      this.ballVy = 0;
      this.airborne = false;
      this.camera.worldY = this.road.elevationAt(this.ballZ);
      return;
    }

    if (this.offScreenFrames > 48) {
      analytics.track('ball_offscreen_fatal', {
        reason,
        distance: Math.round(this.distance),
        ballY: this.ballY,
        cameraWorldY: this.camera.worldY,
      });
      this.offScreenFrames = 0;
      this.die('The Void');
    }
  }

  private renderBall(): void {
    const curve = this.road.curveOffsetAt(this.ballZ);
    const roadY = this.road.elevationAt(this.ballZ);
    const projected = this.projector.project(
      this.camera,
      this.ballX,
      roadY + this.ballY + GAME.player.radius,
      this.ballZ,
      curve,
    );

    if (!projected.visible) {
      this.ball.setVisible(false);
      this.ballShadow.setVisible(false);
      this.noteBallOffScreen('behind_camera');
      return;
    }

    // Fail-safe. Nothing above should be able to put the ball outside the shot,
    // and the projection checks in scripts/check-projection.ts assert exactly
    // that. This exists because the alternative failure mode — the player
    // invisible while the score keeps climbing — is the worst outcome in the
    // game, and it should degrade to something recoverable rather than depend
    // on the maths upstream always being right.
    const margin = this.projector.height * 0.08;
    const off =
      projected.screenY < -margin ||
      projected.screenY > this.projector.height + margin ||
      !Number.isFinite(projected.screenX) ||
      !Number.isFinite(projected.screenY);

    if (off) {
      this.noteBallOffScreen('out_of_frame');
      // Pin it to the nearest edge so the player can still see where they are.
      projected.screenX = Math.max(0, Math.min(this.projector.width, projected.screenX || 0));
      projected.screenY = Math.max(0, Math.min(this.projector.height, projected.screenY || 0));
    } else {
      this.offScreenFrames = 0;
    }

    const size = GAME.player.radius * 2 * projected.scale;
    this.ball.setVisible(true);
    this.ball.setPosition(projected.screenX, projected.screenY);
    this.ball.setDisplaySize(size, size);
    this.ball.setAngle(this.spin * 0.25);

    // Contact shadow: pinned to the road, shrinking as the ball rises.
    if (this.quality.shadows) {
      const ground = this.projector.project(this.camera, this.ballX, roadY, this.ballZ, curve);
      if (ground.visible) {
        const lift = 1 - Math.min(1, this.ballY / GAME.player.jumpHeight) * 0.55;
        this.ballShadow.setVisible(true);
        this.ballShadow.setPosition(ground.screenX, ground.screenY);
        this.ballShadow.setDisplaySize(size * 1.15 * lift, size * 0.45 * lift);
        this.ballShadow.setAlpha(0.5 * lift);
      }
    } else {
      this.ballShadow.setVisible(false);
    }

    if (this.trailEmitter) {
      this.trailEmitter.particleX = projected.screenX;
      this.trailEmitter.particleY = projected.screenY + size * 0.3;
      this.trailEmitter.setParticleScale(size / 190, size / 190);
      const emitting = this.phase === 'running' && this.speed > 1;
      if (emitting !== this.trailEmitter.emitting) {
        if (emitting) this.trailEmitter.start();
        else this.trailEmitter.stop();
      }
    }

    // Squash on landing, for weight.
    if (this.landingBounce > 0) {
      // Cosmetic only: a decaying squash on touchdown. It reads as weight
      // without giving the ball any actual bounce to fight.
      const squash = 1 + Math.sin(this.landingBounce * 34) * 0.06 * (this.landingBounce / 0.18);
      this.ball.setDisplaySize(size * squash, size / squash);
    }
  }

  private emitTick(dt: number, time: number): void {
    this.tickAccumulator += dt;
    // The HUD writes to the DOM directly, so this can run every frame without
    // costing a React render.
    gameEvents.emit('tick', {
      score: Math.floor(this.score),
      distance: Math.floor(this.distance),
      speed: this.speed,
      stage: this.stage,
      prisms: this.prisms,
      chain: this.chain,
      boosting: this.targetBoost > 1,
      fps: this.governor.stats.fps,
    });

    if (time - this.perfReportAt > 60_000) {
      this.perfReportAt = time;
      analytics.trackPerformance({
        fps: Math.round(this.governor.stats.fps),
        minFps: Math.round(this.governor.stats.minFps),
        drawCalls: this.obstaclePool.used + this.prismPool.used,
        entities: this.track.activeObstacles.length + this.track.activePrisms.length,
        tier: this.governor.currentTier,
      });
    }
  }

  private applyTier(tier: PerfTier): void {
    this.quality = qualityFor(tier);
    this.road.setQuality(this.quality.drawDistance, !isLiteTier(tier));
    this.speedCue.setQuality(tier);
    this.projector.setFogDistance(this.quality.drawDistance * GAME.world.segmentLength * 0.85);
    if (this.trailEmitter) {
      const trail = getTrail(this.config.trailId);
      const rate = Math.max(1, Math.round(trail.rate * this.quality.trailRateScale));
      this.trailEmitter.frequency = Math.max(12, 1000 / rate);
      this.trailEmitter.maxAliveParticles = Math.round(this.quality.maxParticles * 0.6);
    }
    analytics.track('quality_downgraded', { tier });
    gameEvents.emit('qualityChanged', { tier });
  }

  shutdown(): void {
    this.scale.off(Phaser.Scale.Events.RESIZE, this.layout, this);
    this.input$.destroy();
    this.obstaclePool.destroy();
    this.prismPool.destroy();
    this.decorPool.destroy();
    this.backdrop.destroy();
    this.speedCue.destroy();
    this.trailEmitter?.destroy();
    this.burstEmitter?.destroy();
    this.road.destroy();
  }
}
