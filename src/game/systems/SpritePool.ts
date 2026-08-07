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

export class SpritePool {
  private sprites: Phaser.GameObjects.Image[] = [];
  private cursor = 0;

  constructor(
    private scene: Phaser.Scene,
    private defaultTexture: string,
    initialSize: number,
    private depth: number,
  ) {
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
