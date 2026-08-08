/**
 * Immediate-mode sprite pooling.
 *
 * The scene re-decides what is on screen every frame, so rather than tracking
 * object lifetimes, each frame calls `begin()`, acquires as many sprites as it
 * needs, and calls `end()` to hide the rest. Sprites are never created or
 * destroyed after warm-up, which means no allocation and no GC pressure in the
 * steady state — the thing that actually causes frame hitches on low-end
 * Android, far more than draw calls do.
 */

import Phaser from 'phaser';

/** How long a pool must sit below the trim threshold before it shrinks. */
const TRIM_DELAY_MS = 3000;
/** Utilisation below which a pool is considered oversized for what's on screen. */
const TRIM_UTILISATION = 0.4;

export class SpritePool {
  private sprites: Phaser.GameObjects.Image[] = [];
  private cursor = 0;
  /** The pool never shrinks below its warm-up size — that size is the
   *  steady-state floor the "no allocation after warm-up" guarantee assumes. */
  private readonly warmSize: number;
  /** `scene.time.now` at which the pool first dropped below TRIM_UTILISATION,
   *  or null while utilisation is healthy. */
  private lowSince: number | null = null;

  constructor(
    private scene: Phaser.Scene,
    private defaultTexture: string,
    initialSize: number,
    private depth: number,
  ) {
    this.warmSize = initialSize;
    for (let i = 0; i < initialSize; i++) this.sprites.push(this.create());
  }

  private create(): Phaser.GameObjects.Image {
    const sprite = this.scene.add.image(0, 0, this.defaultTexture);
    sprite.setActive(false).setVisible(false).setDepth(this.depth);
    return sprite;
  }

  begin(): void {
    this.cursor = 0;
  }

  /** Returns a ready-to-position sprite showing `texture`. */
  acquire(texture: string): Phaser.GameObjects.Image {
    let sprite = this.sprites[this.cursor];
    if (!sprite) {
      sprite = this.create();
      this.sprites.push(sprite);
    }
    this.cursor++;
    if (sprite.texture.key !== texture) sprite.setTexture(texture);
    sprite.setActive(true).setVisible(true);
    sprite.setAngle(0);
    sprite.setAlpha(1);
    sprite.setOrigin(0.5, 0.5);
    sprite.setBlendMode(Phaser.BlendModes.NORMAL);
    return sprite;
  }

  /** Hides everything not acquired this frame. */
  end(): void {
    for (let i = this.cursor; i < this.sprites.length; i++) {
      const sprite = this.sprites[i];
      if (!sprite.visible) break; // the tail is already hidden
      sprite.setActive(false).setVisible(false);
    }

    this.maybeShrink();
  }

  /**
   * Reclaims memory after a spike (a dense `gauntlet` stretch, say) once the
   * pool has been oversized for its recent demand for a sustained window.
   *
   * This is intentionally lazy and cheap: one comparison and a timestamp read
   * per frame, no allocation, and it only ever acts once the low-utilisation
   * window has actually elapsed — a momentary dip (one thin frame between
   * clusters) must not thrash the pool back down and then immediately grow it
   * again on the very next obstacle.
   */
  private maybeShrink(): void {
    if (this.sprites.length <= this.warmSize) return;

    const utilisation = this.cursor / this.sprites.length;
    const now = this.scene.time.now;

    if (utilisation >= TRIM_UTILISATION) {
      this.lowSince = null;
      return;
    }
    if (this.lowSince === null) {
      this.lowSince = now;
      return;
    }
    if (now - this.lowSince < TRIM_DELAY_MS) return;

    // Keep a small margin above the current cursor so a pool doesn't trim
    // itself right down to the warm floor and then immediately have to grow
    // again on the next frame that needs one more sprite than this one did.
    const target = Math.max(this.warmSize, Math.ceil(this.cursor * 1.25));
    this.trim(target);
    this.lowSince = null;
  }

  /** Trims the pool back toward `target` after a spike. */
  trim(target: number): void {
    while (this.sprites.length > target) {
      const sprite = this.sprites.pop();
      sprite?.destroy();
    }
  }

  get size(): number {
    return this.sprites.length;
  }

  get used(): number {
    return this.cursor;
  }

  destroy(): void {
    for (const sprite of this.sprites) sprite.destroy();
    this.sprites.length = 0;
  }
}
