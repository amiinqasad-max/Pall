/**
 * Game feel.
 *
 * Every effect that makes an interaction land — hit stop, slow motion, camera
 * punch, roll, flash — routed through one object so they compose instead of
 * fighting. Two systems each grabbing the camera independently is how you get
 * the jitter that reads as "cheap"; here every contribution is summed once and
 * applied once per frame.
 *
 * Everything is expressed as a decaying offset from rest. Nothing latches, so
 * an effect interrupted by another (a near miss during a boost, a crash during
 * a stage change) resolves cleanly rather than leaving the camera parked.
 *
 * Budget: this is ~40 floating point operations per frame and allocates
 * nothing. The expensive part of juice is particles, which live elsewhere and
 * are tier-gated.
 */

import type Phaser from 'phaser';
import { GAME } from '@/game/config';

export interface JuiceOptions {
  /** Honours prefers-reduced-motion and the in-game toggle. */
  reducedMotion: boolean;
  /** Disables the costlier effects on the low tier. */
  allowShake: boolean;
}

export class Juice {
  /** Seconds of frozen simulation remaining. */
  private hitStop = 0;
  /** Multiplier applied to simulation dt. 1 = normal. */
  private timeScale = 1;
  private timeScaleTarget = 1;
  private timeScaleHold = 0;

  /** Additive camera zoom above 1. */
  private zoomPunch = 0;
  /** Camera roll in radians. */
  private roll = 0;
  private rollTarget = 0;
  /** Field-of-view widening, 1 = base. */
  private fov = 1;
  private fovTarget = 1;

  /** 0..1 white flash currently on screen. */
  private flash = 0;
  private flashColor = 0xffffff;

  constructor(
    private camera: Phaser.Cameras.Scene2D.Camera,
    private options: JuiceOptions,
  ) {}

  setOptions(options: JuiceOptions): void {
    this.options = options;
    if (options.reducedMotion) this.resetVisuals();
  }

  // --- Triggers ---------------------------------------------------------------

  /**
   * Freezes the simulation for a moment. This is the single highest-value
   * effect in an action game: a few frames of stillness at the instant of
   * impact reads as weight far more convincingly than any amount of shake.
   */
  freeze(seconds: number): void {
    if (this.options.reducedMotion) return;
    this.hitStop = Math.max(this.hitStop, seconds);
  }

  /** Eases the world into slow motion, then back. */
  slowMotion(scale: number, seconds: number): void {
    if (this.options.reducedMotion) return;
    this.timeScaleTarget = Math.min(this.timeScaleTarget, scale);
    this.timeScaleHold = Math.max(this.timeScaleHold, seconds);
  }

  /** A brief push-in. Positive zooms toward the ball. */
  punch(amount: number): void {
    if (this.options.reducedMotion) return;
    this.zoomPunch = Math.max(this.zoomPunch, amount);
  }

  /** Screen shake, routed here so the tier gate lives in one place. */
  shake(durationMs: number, intensity: number): void {
    if (this.options.reducedMotion || !this.options.allowShake) return;
    this.camera.shake(durationMs, intensity);
  }

  /** A full-screen colour wash that decays over ~200ms. */
  flashScreen(color: number, strength = 1): void {
    if (this.options.reducedMotion) return;
    this.flashColor = color;
    this.flash = Math.max(this.flash, strength);
  }

  /**
   * Lateral lean. Driven continuously from the ball's velocity rather than
   * fired as an event, so the camera banks *through* a move instead of
   * snapping after it.
   */
  setLean(lateralVelocity: number): void {
    if (this.options.reducedMotion) {
      this.rollTarget = 0;
      return;
    }
    const normalised = Math.max(-1, Math.min(1, lateralVelocity / GAME.control.maxLateralSpeed));
    this.rollTarget = normalised * GAME.juice.maxRoll;
  }

  /**
   * Speed-driven field of view. Widening the lens as the run accelerates makes
   * the periphery rush, which is what actually communicates speed — the road
   * texture alone saturates and stops reading past a certain rate.
   */
  setSpeedFov(speed: number): void {
    if (this.options.reducedMotion) {
      this.fovTarget = 1;
      return;
    }
    const t = Math.max(0, Math.min(1, (speed - GAME.speed.start) / (GAME.speed.max - GAME.speed.start)));
    this.fovTarget = 1 + t * GAME.juice.speedFov;
  }

  // --- Per-frame --------------------------------------------------------------

  /**
   * Advances the effects and returns the dt the simulation should use.
   *
   * Returning zero during hit stop freezes the world without freezing the
   * render loop, so particles and the UI keep breathing while the game itself
   * holds still — the difference between a deliberate pause and a stutter.
   */
  update(dt: number): number {
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      this.applyCamera(dt);
      return 0;
    }

    if (this.timeScaleHold > 0) {
      this.timeScaleHold -= dt;
      if (this.timeScaleHold <= 0) this.timeScaleTarget = 1;
    }
    // Ease in fast, ease out slow: snapping into slow motion sells the moment,
    // snapping out of it feels like a dropped frame.
    const rate = this.timeScale > this.timeScaleTarget ? 14 : 4.5;
    this.timeScale += (this.timeScaleTarget - this.timeScale) * Math.min(1, dt * rate);

    this.applyCamera(dt);
    return dt * this.timeScale;
  }

  private applyCamera(dt: number): void {
    const decay = Math.min(1, dt * 9);

    this.zoomPunch += (0 - this.zoomPunch) * decay;
    this.roll += (this.rollTarget - this.roll) * Math.min(1, dt * GAME.juice.rollLerp);
    this.fov += (this.fovTarget - this.fov) * Math.min(1, dt * 2.5);
    this.flash += (0 - this.flash) * Math.min(1, dt * 7);

    // One write per property per frame, from the summed state.
    this.camera.setZoom(1 + this.zoomPunch);
    this.camera.setRotation(this.roll);
  }

  private resetVisuals(): void {
    this.zoomPunch = 0;
    this.roll = 0;
    this.rollTarget = 0;
    this.fov = 1;
    this.fovTarget = 1;
    this.flash = 0;
    this.camera.setZoom(1);
    this.camera.setRotation(0);
  }

  /** Current FOV multiplier, read by the projector. */
  get fovScale(): number {
    return this.fov;
  }

  /** Current flash strength and colour, for the overlay renderer. */
  get flashState(): { strength: number; color: number } {
    return { strength: this.flash, color: this.flashColor };
  }

  get frozen(): boolean {
    return this.hitStop > 0;
  }

  /** Called on death and continue so nothing carries across. */
  reset(): void {
    this.hitStop = 0;
    this.timeScale = 1;
    this.timeScaleTarget = 1;
    this.timeScaleHold = 0;
    this.resetVisuals();
  }
}
