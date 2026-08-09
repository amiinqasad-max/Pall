/**
 * The world behind the track.
 *
 * Two silhouette ridges, a fog band on the horizon, and drifting motes. All of
 * it is generated procedurally and rendered as three TileSprites plus one
 * emitter — four draw calls total, regardless of how much apparent depth is on
 * screen.
 *
 * The parallax is driven by the *accumulated road curvature*, not by elapsed
 * time. That is the detail that makes it read as a world rather than a
 * scrolling wallpaper: when the track banks left, the horizon swings right, at
 * a rate set by each layer's distance. Scrolling on a timer looks convincing
 * for about four seconds and then reads as fake, because it keeps moving
 * through a straight.
 */

import Phaser from 'phaser';
import { createRng, hashString } from '@/core/rng';
import { mixColor } from '@/game/render/projection';
import { isLiteTier } from '@/systems/device';
import type { Environment } from '@/data/progression';
import type { PerfTier } from '@/types';

/** How much of the camera's lateral motion each layer echoes. */
const FAR_PARALLAX = 0.06;
const NEAR_PARALLAX = 0.15;

export class Backdrop {
  private far?: Phaser.GameObjects.TileSprite;
  private near?: Phaser.GameObjects.TileSprite;
  private haze?: Phaser.GameObjects.Image;
  private motes?: Phaser.GameObjects.Particles.ParticleEmitter;

  private horizon = 0;

  constructor(
    private scene: Phaser.Scene,
    private env: Environment,
    private tier: PerfTier,
    private reducedMotion: boolean,
  ) {
    this.buildTextures();
  }

  /**
   * Ridge silhouettes, baked once per environment.
   *
   * A ridge is a sum of three sine waves at different frequencies plus a small
   * random walk — cheap, tileable if the frequencies are integers over the
   * width, and far more natural than the single sine that a first attempt
   * always reaches for.
   */
  private buildRidge(key: string, opts: { height: number; color: number; roughness: number; seed: string }): void {
    const width = 1024;
    const height = Math.ceil(opts.height);
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    const texture = this.scene.textures.createCanvas(key, width, height);
    if (!texture) return;
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, width, height);

    const rng = createRng(hashString(opts.seed));
    // Integer frequencies keep the left and right edges continuous so the
    // TileSprite has no visible seam as it scrolls.
    const waves = [
      { freq: 2, amp: 0.42, phase: rng.range(0, Math.PI * 2) },
      { freq: 5, amp: 0.2, phase: rng.range(0, Math.PI * 2) },
      { freq: 11, amp: 0.09, phase: rng.range(0, Math.PI * 2) },
    ];

    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= width; x++) {
      const t = (x / width) * Math.PI * 2;
      let y = 0;
      for (const w of waves) y += Math.sin(t * w.freq + w.phase) * w.amp;
      // Jagged detail on top of the smooth profile.
      y += (rng.next() - 0.5) * opts.roughness;
      const peak = height * (0.42 - y * 0.4);
      ctx.lineTo(x, Math.max(0, peak));
    }
    ctx.lineTo(width, height);
    ctx.closePath();

    const fill = ctx.createLinearGradient(0, 0, 0, height);
    fill.addColorStop(0, cssColor(opts.color, 0.95));
    fill.addColorStop(1, cssColor(opts.color, 0.35));
    ctx.fillStyle = fill;
    ctx.fill();

    (this.scene.textures.get(key) as Phaser.Textures.CanvasTexture).refresh();
  }

  /** Soft horizontal gradient sitting on the horizon line. */
  private buildHaze(key: string): void {
    const width = 256;
    const height = 128;
    if (this.scene.textures.exists(key)) this.scene.textures.remove(key);
    const texture = this.scene.textures.createCanvas(key, width, height);
    if (!texture) return;
    const ctx = texture.getContext();
    ctx.clearRect(0, 0, width, height);
    const g = ctx.createLinearGradient(0, 0, 0, height);
    g.addColorStop(0, cssColor(this.env.palette.rumble, 0));
    g.addColorStop(0.5, cssColor(this.env.palette.rumble, 0.34));
    g.addColorStop(1, cssColor(this.env.palette.rumble, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
    (this.scene.textures.get(key) as Phaser.Textures.CanvasTexture).refresh();
  }

  private buildTextures(): void {
    const sky = this.env.palette.sky[1];
    const fog = this.env.palette.fog;
    this.buildRidge('backdrop.far', {
      height: 220,
      // Distant geometry sits close to the fog colour; that is what reads as
      // distance far more than scale does.
      color: mixColor(this.env.palette.grid, fog, 0.62),
      roughness: 0.05,
      seed: `${this.env.id}:far`,
    });
    this.buildRidge('backdrop.near', {
      height: 180,
      color: mixColor(this.env.palette.grid, sky, 0.25),
      roughness: 0.12,
      seed: `${this.env.id}:near`,
    });
    this.buildHaze('backdrop.haze');
  }

  /** Creates the display objects. Call after the projector knows the horizon. */
  create(width: number, height: number, horizon: number): void {
    this.destroy();
    this.horizon = horizon;

    const farHeight = 220;
    const nearHeight = 180;

    this.far = this.scene.add
      .tileSprite(0, horizon - farHeight * 0.82, width, farHeight, 'backdrop.far')
      .setOrigin(0, 0)
      .setDepth(2)
      .setAlpha(0.38);

    this.near = this.scene.add
      .tileSprite(0, horizon - nearHeight * 0.62, width, nearHeight, 'backdrop.near')
      .setOrigin(0, 0)
      .setDepth(3)
      .setAlpha(0.55);

    this.haze = this.scene.add
      .image(width / 2, horizon, 'backdrop.haze')
      .setDisplaySize(width * 1.6, height * 0.16)
      .setDepth(4)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setAlpha(0.32);

    // Floating motes. Purely atmospheric, so the low tier goes without.
    if (!isLiteTier(this.tier) && !this.reducedMotion) {
      this.motes = this.scene.add.particles(0, 0, 'particle', {
        x: { min: 0, max: width },
        y: { min: horizon - 60, max: height },
        lifespan: { min: 3200, max: 6000 },
        speedY: { min: -14, max: -4 },
        speedX: { min: -6, max: 6 },
        scale: { min: 0.04, max: 0.12 },
        // Alpha is driven by the FadeInOut processor below, not by the config:
        // motes need to ramp up *and* back down, and the built-in start/end
        // interpolation can only do one or the other.
        frequency: 260,
        quantity: 1,
        blendMode: Phaser.BlendModes.ADD,
        tint: [this.env.palette.lane, this.env.palette.accent],
        maxAliveParticles: 26,
      });
      this.motes.setDepth(5);
      // A custom alpha ramp: 0 -> 0.5 -> 0 across the particle's life.
      this.motes.addParticleProcessor(new FadeInOut());
    }
  }

  /**
   * `curveOffset` is the road's accumulated lateral shift at the fog plane, and
   * `cameraX` the camera's own pan. Both push the horizon, at a rate scaled by
   * each layer's apparent distance.
   */
  update(cameraX: number, curveOffset: number, speed: number, dt: number): void {
    if (!this.far || !this.near) return;
    const lateral = cameraX * 6 + curveOffset * 2.2;

    this.far.tilePositionX = lateral * FAR_PARALLAX;
    this.near.tilePositionX = lateral * NEAR_PARALLAX;

    // A whisper of vertical drift with speed, so a fast run feels like it is
    // pressing forward into the scene.
    const lift = Math.min(1, speed / 60) * 6;
    this.far.y = this.horizon - 220 * 0.82 + lift * 0.4;
    this.near.y = this.horizon - 180 * 0.62 + lift;

    if (this.haze) {
      // Slow breathing on the horizon glow.
      this.hazePhase += dt;
      this.haze.setAlpha(0.26 + Math.sin(this.hazePhase * 0.8) * 0.07);
    }
  }

  private hazePhase = 0;

  setEnvironment(env: Environment, width: number, height: number, horizon: number): void {
    this.env = env;
    this.buildTextures();
    this.create(width, height, horizon);
  }

  resize(width: number, height: number, horizon: number): void {
    this.create(width, height, horizon);
  }

  destroy(): void {
    this.far?.destroy();
    this.near?.destroy();
    this.haze?.destroy();
    this.motes?.destroy();
    this.far = undefined;
    this.near = undefined;
    this.haze = undefined;
    this.motes = undefined;
  }
}

/** Ramps particle alpha up then down; Phaser has no built-in for this curve. */
class FadeInOut extends Phaser.GameObjects.Particles.ParticleProcessor {
  update(particle: Phaser.GameObjects.Particles.Particle): void {
    const t = 1 - particle.lifeT;
    particle.alpha = Math.sin(t * Math.PI) * 0.5;
  }
}

function cssColor(color: number, alpha: number): string {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return `rgba(${r},${g},${b},${alpha})`;
}
