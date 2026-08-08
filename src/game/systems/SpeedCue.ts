/**
 * Speed feel.
 *
 * A handful of peripheral streaks that sell velocity through composition
 * rather than through the simulation — purely a render-layer read of speed
 * state `RunScene` already computes (the same 0..1 intensity that already
 * drives the music and haptics). No new simulation complexity: this module
 * cannot affect the ball, the track, or collision in any way.
 *
 * Fixed-capacity by construction, like `SpritePool`: every streak's
 * `Image` is created once at boot and only repositioned/rescaled/faded
 * afterward. Nothing is created or destroyed in the steady state, and the
 * per-tier cap (0 on `ultraLow`) means the weakest devices pay nothing at
 * all for this — not even the cost of an idle, invisible sprite loop,
 * since `update` returns immediately when the streak list is empty.
 */

import Phaser from 'phaser';
import { createRng } from '@/core/rng';
import type { PerfTier } from '@/types';

interface Streak {
  image: Phaser.GameObjects.Image;
  /** Direction from screen centre, radians. */
  angle: number;
  /** Base distance from centre, as a fraction of the half-diagonal. */
  radius: number;
  /** Per-streak length multiplier, so they don't all read as identical. */
  length: number;
  /** Stagger for the wobble term, so streaks don't pulse in lockstep. */
  phase: number;
}

/** How many streaks exist per tier. Capacity is fixed at construction time. */
const CAP_BY_TIER: Record<PerfTier, number> = {
  ultraLow: 0,
  low: 5,
  medium: 9,
  high: 14,
};

/** Below this speed-ratio the layer stays fully dormant — too faint to read. */
const ACTIVATION_THRESHOLD = 0.22;

export class SpeedCue {
  private streaks: Streak[] = [];
  private cap: number;
  private width = 0;
  private height = 0;

  constructor(
    private scene: Phaser.Scene,
    tier: PerfTier,
  ) {
    this.cap = CAP_BY_TIER[tier] ?? 0;
    if (this.cap === 0) return;

    // Deterministic layout: the streaks' positions are set dressing, not
    // gameplay, and a seeded RNG means the pattern is stable across scene
    // reloads rather than reshuffling every run for no reason.
    const rng = createRng(0x5eed1e5);
    const total = CAP_BY_TIER.high;
    for (let i = 0; i < total; i++) {
      const image = this.scene.add
        .image(0, 0, 'speedline')
        .setBlendMode(Phaser.BlendModes.ADD)
        .setDepth(26)
        .setVisible(false);
      this.streaks.push({
        image,
        angle: (i / total) * Math.PI * 2 + rng.range(-0.16, 0.16),
        radius: rng.range(0.6, 0.98),
        length: rng.range(0.8, 1.35),
        phase: rng.range(0, Math.PI * 2),
      });
    }
    this.applyCap();
  }

  /** Recomputes layout on viewport resize; called from RunScene.layout(). */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /**
   * `intensity` is the same 0..1 speed ratio RunScene already derives for
   * music/haptics (`intensity()`), reused rather than recomputed here so
   * this module has no simulation logic of its own — only a render.
   */
  update(intensity: number, boosting: boolean, time: number): void {
    if (this.streaks.length === 0) return;

    const active = intensity > ACTIVATION_THRESHOLD;
    const half = Math.min(this.width, this.height) * 0.5;
    const boostPunch = boosting ? 1.25 : 1;
    const ramp = Math.min(1, (intensity - ACTIVATION_THRESHOLD) / (1 - ACTIVATION_THRESHOLD));

    for (let i = 0; i < this.streaks.length; i++) {
      const s = this.streaks[i];
      if (i >= this.cap || !active) {
        if (s.image.visible) s.image.setVisible(false);
        continue;
      }

      const wobble = 1 + Math.sin(time * 2.2 + s.phase) * 0.08;
      const dist = half * s.radius * wobble;
      const x = this.width / 2 + Math.cos(s.angle) * dist;
      // A slight vertical compression matches the road's own aspect, so the
      // streaks read as belonging to the same perspective as the track.
      const y = this.height / 2 + Math.sin(s.angle) * dist * 0.82;
      const len = half * 0.34 * s.length * ramp * boostPunch;

      s.image.setVisible(true);
      s.image.setPosition(x, y);
      s.image.setRotation(s.angle);
      s.image.setDisplaySize(len, Math.max(2, len * 0.05));
      s.image.setAlpha(Math.min(0.5, ramp * 0.55) * boostPunch);
    }
  }

  /** Called when the governor demotes/promotes the tier mid-run. */
  setQuality(tier: PerfTier): void {
    this.cap = Math.min(CAP_BY_TIER[tier] ?? 0, this.streaks.length);
    this.applyCap();
  }

  private applyCap(): void {
    for (let i = this.cap; i < this.streaks.length; i++) this.streaks[i].image.setVisible(false);
  }

  destroy(): void {
    for (const s of this.streaks) s.image.destroy();
    this.streaks.length = 0;
  }
}

/**
 * The effective tier to construct a SpeedCue with. Reduced motion forces the
 * zero-streak `ultraLow` cap regardless of device tier — this is simpler and
 * more clearly correct than threading a second boolean through the class.
 */
export function speedCueTier(tier: PerfTier, reducedMotion: boolean): PerfTier {
  return reducedMotion ? 'ultraLow' : tier;
}
