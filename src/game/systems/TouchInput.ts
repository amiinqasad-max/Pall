/**
 * Direct touch steering.
 *
 * The player puts a finger anywhere on the screen and drags; the ball follows.
 * There are no swipe gestures to recognise and nothing to time.
 *
 * Three decisions matter here:
 *
 * 1. **Relative, not absolute.** Touching the screen does not teleport the ball
 *    to the finger. The touch point becomes an anchor, and further movement is
 *    applied as an offset from it. Absolute mapping is simpler but unusable in
 *    practice — the ball snaps across the road the instant you touch, and you
 *    can only reach the edges by reaching the edges of the screen.
 *
 * 2. **Sensitivity is a fraction of the viewport, not metres per pixel.** The
 *    same physical thumb sweep crosses the same amount of road on every device.
 *
 * 3. **The target is owned here but clamped by the scene.** The scene knows the
 *    road's width at the ball's position and writes the clamped value back via
 *    `setTarget`. Without that write-back, dragging past the edge would build up
 *    invisible slack that has to be unwound before the ball moves back — the
 *    single most common way a drag control develops "dead" travel.
 *
 * Jumping stays available without any swipe: a tap (a touch that barely moves),
 * a second finger while steering, or an upward flick all fire it.
 */

import Phaser from 'phaser';
import { GAME } from '@/game/config';

export type DiscreteAction = 'jump' | 'slam';

export class TouchInput {
  /** Lateral target, in world metres. The ball springs toward this. */
  private targetX = 0;
  /** Metres of road per pixel of finger travel; derived from the viewport. */
  private metresPerPixel = 0.05;

  private steeringPointer: number | null = null;
  private anchorScreenX = 0;
  private anchorTargetX = 0;
  private pressStartedAt = 0;
  private pressStartX = 0;
  private pressStartY = 0;
  private travelled = 0;
  private flickFired = false;

  /** Recent horizontal finger velocity, px/s, smoothed. For release inertia. */
  private fingerVelocity = 0;
  private lastMoveAt = 0;
  private lastMoveX = 0;
  /** Set for one frame after release; the scene converts it into ball velocity. */
  private releaseImpulse = 0;

  private queue: DiscreteAction[] = [];
  private keyAxis = 0;
  private enabled = true;
  private keys: Record<string, Phaser.Input.Keyboard.Key> = {};
  private detachers: (() => void)[] = [];

  constructor(private scene: Phaser.Scene) {
    this.attach();
    this.resize(scene.scale.gameSize.width);
  }

  /** Recomputes sensitivity. Call on boot and on every viewport change. */
  resize(viewportWidth: number): void {
    const roadWidth = GAME.world.roadHalfWidth * 2;
    const travelPx = Math.max(1, viewportWidth * GAME.control.traverseFraction);
    this.metresPerPixel = roadWidth / travelPx;
  }

  private attach(): void {
    const input = this.scene.input;

    const onDown = (pointer: Phaser.Input.Pointer): void => {
      if (!this.enabled) return;

      // A second finger while already steering is a jump. This is what makes
      // one-handed play work: the steering thumb never has to let go.
      if (this.steeringPointer !== null && pointer.id !== this.steeringPointer) {
        this.push('jump');
        return;
      }

      this.steeringPointer = pointer.id;
      this.anchorScreenX = pointer.x;
      this.anchorTargetX = this.targetX;
      this.pressStartedAt = performance.now();
      this.pressStartX = pointer.x;
      this.pressStartY = pointer.y;
      this.travelled = 0;
      this.flickFired = false;
      this.fingerVelocity = 0;
      this.lastMoveAt = this.pressStartedAt;
      this.lastMoveX = pointer.x;
    };

    const onMove = (pointer: Phaser.Input.Pointer): void => {
      if (!this.enabled || pointer.id !== this.steeringPointer) return;

      const now = performance.now();
      const dx = pointer.x - this.anchorScreenX;
      this.targetX = this.anchorTargetX + dx * this.metresPerPixel;

      this.travelled = Math.max(
        this.travelled,
        Math.hypot(pointer.x - this.pressStartX, pointer.y - this.pressStartY),
      );

      // Exponentially smoothed finger velocity. A single-frame delta is far too
      // noisy on a real touchscreen to drive release inertia from.
      const dt = Math.max(1, now - this.lastMoveAt) / 1000;
      const instant = (pointer.x - this.lastMoveX) / dt;
      this.fingerVelocity += (instant - this.fingerVelocity) * 0.35;
      this.lastMoveAt = now;
      this.lastMoveX = pointer.x;

      // Upward flick: a secondary jump affordance for players who never
      // discover tap-to-jump. Fires once per press.
      const up = this.pressStartY - pointer.y;
      if (!this.flickFired && up > GAME.control.flickUpPx && up > Math.abs(dx) * 1.1) {
        this.flickFired = true;
        this.push('jump');
      }
    };

    const onUp = (pointer: Phaser.Input.Pointer): void => {
      if (pointer.id !== this.steeringPointer) return;
      const held = performance.now() - this.pressStartedAt;

      // A tap: short, and it went nowhere. Not a swipe — there is no direction
      // to read, only the absence of movement.
      if (
        this.enabled &&
        !this.flickFired &&
        held <= GAME.control.tapMaxMs &&
        this.travelled <= GAME.control.tapSlopPx
      ) {
        this.push('jump');
      } else if (this.enabled) {
        // Carry a little of the finger's motion through the release so the ball
        // eases out rather than stopping dead under the thumb.
        this.releaseImpulse = this.fingerVelocity * this.metresPerPixel * GAME.control.releaseInertia;
      }

      this.steeringPointer = null;
      this.fingerVelocity = 0;
    };

    input.on(Phaser.Input.Events.POINTER_DOWN, onDown);
    input.on(Phaser.Input.Events.POINTER_MOVE, onMove);
    input.on(Phaser.Input.Events.POINTER_UP, onUp);
    input.on(Phaser.Input.Events.POINTER_UP_OUTSIDE, onUp);

    this.detachers.push(() => {
      input.off(Phaser.Input.Events.POINTER_DOWN, onDown);
      input.off(Phaser.Input.Events.POINTER_MOVE, onMove);
      input.off(Phaser.Input.Events.POINTER_UP, onUp);
      input.off(Phaser.Input.Events.POINTER_UP_OUTSIDE, onUp);
    });

    // Keyboard, for desktop play and for driving the automated checks. Held
    // keys steer continuously, matching the touch model rather than stepping.
    const keyboard = this.scene.input.keyboard;
    if (keyboard) {
      this.keys = keyboard.addKeys('LEFT,RIGHT,UP,DOWN,A,D,W,S,SPACE') as Record<
        string,
        Phaser.Input.Keyboard.Key
      >;
      const bindAction = (key: Phaser.Input.Keyboard.Key | undefined, action: DiscreteAction): void => {
        if (!key) return;
        const handler = (): void => {
          if (this.enabled) this.push(action);
        };
        key.on('down', handler);
        this.detachers.push(() => key.off('down', handler));
      };
      bindAction(this.keys.UP, 'jump');
      bindAction(this.keys.W, 'jump');
      bindAction(this.keys.SPACE, 'jump');
      bindAction(this.keys.DOWN, 'slam');
      bindAction(this.keys.S, 'slam');
    }
  }

  private push(action: DiscreteAction): void {
    // At most one buffered discrete action: these are instantaneous, and a
    // backlog of queued jumps makes the ball feel like it is driving itself.
    if (this.queue.length >= 2) this.queue.shift();
    this.queue.push(action);
  }

  /** Steering target in world metres. Read every frame. */
  get target(): number {
    return this.targetX;
  }

  /** True while a finger is down and steering. */
  get isSteering(): boolean {
    return this.steeringPointer !== null;
  }

  /**
   * Writes back the clamped target. The scene owns the road bounds, so it
   * corrects the target after clamping and the anchor stays honest.
   */
  setTarget(value: number): void {
    if (this.steeringPointer !== null) {
      // Re-anchor so the finger's current position maps to the clamped target;
      // otherwise the slack reappears on the next move event.
      this.anchorTargetX += value - this.targetX;
    }
    this.targetX = value;
  }

  /** Consumes the pending release inertia, in m/s. */
  takeReleaseImpulse(): number {
    const impulse = this.releaseImpulse;
    this.releaseImpulse = 0;
    return impulse;
  }

  /** -1, 0 or 1 from held steering keys. */
  get keyboardAxis(): number {
    if (!this.enabled) return 0;
    const left = this.keys.LEFT?.isDown || this.keys.A?.isDown;
    const right = this.keys.RIGHT?.isDown || this.keys.D?.isDown;
    this.keyAxis = (right ? 1 : 0) - (left ? 1 : 0);
    return this.keyAxis;
  }

  /** Pops the next buffered jump/slam, or null. */
  consumeAction(): DiscreteAction | null {
    return this.queue.shift() ?? null;
  }

  /** Drops input state — used on pause, death and continue. */
  flush(): void {
    this.queue.length = 0;
    this.steeringPointer = null;
    this.releaseImpulse = 0;
    this.fingerVelocity = 0;
  }

  /** Recentres the control on the ball, so a resumed run does not lurch. */
  recentre(worldX: number): void {
    this.targetX = worldX;
    this.anchorTargetX = worldX;
    this.flush();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.flush();
  }

  destroy(): void {
    for (const detach of this.detachers) detach();
    this.detachers.length = 0;
    this.flush();
  }
}
