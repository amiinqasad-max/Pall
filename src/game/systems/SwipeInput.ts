/**
 * Touch and keyboard input.
 *
 * Two things matter more than anything else here:
 *
 * 1. Latency. The lane change fires the instant a swipe passes the distance
 *    threshold, mid-gesture — not on touchend. Waiting for the finger to lift
 *    adds 80-150ms and is the single biggest reason a swipe control can feel
 *    "laggy" even at a locked 60fps.
 *
 * 2. Buffering. An input during a lane change is queued rather than dropped,
 *    so a fast double-swipe reliably moves two lanes. Dropping the second
 *    input is the thing that makes players feel the game cheated them.
 */

import Phaser from 'phaser';
import { GAME } from '@/game/config';

export type InputAction = 'left' | 'right' | 'jump' | 'slam';

interface Pointer {
  id: number;
  startX: number;
  startY: number;
  startTime: number;
  /** Set once this gesture has produced a lane change. */
  consumed: boolean;
  moved: boolean;
}

export class SwipeInput {
  private active: Pointer | null = null;
  private queue: InputAction[] = [];
  private enabled = true;
  private keys: Record<string, Phaser.Input.Keyboard.Key> = {};
  private detachers: (() => void)[] = [];

  constructor(private scene: Phaser.Scene) {
    this.attach();
  }

  private attach(): void {
    const input = this.scene.input;

    const onDown = (pointer: Phaser.Input.Pointer): void => {
      if (!this.enabled) return;
      this.active = {
        id: pointer.id,
        startX: pointer.x,
        startY: pointer.y,
        startTime: performance.now(),
        consumed: false,
        moved: false,
      };
    };

    const onMove = (pointer: Phaser.Input.Pointer): void => {
      if (!this.enabled || !this.active || this.active.id !== pointer.id) return;
      const dx = pointer.x - this.active.startX;
      const dy = pointer.y - this.active.startY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) this.active.moved = true;
      if (this.active.consumed) return;

      const absX = Math.abs(dx);
      const absY = Math.abs(dy);

      if (absX >= GAME.input.swipeThreshold && absX > absY * GAME.input.axisRatio) {
        this.push(dx > 0 ? 'right' : 'left');
        this.active.consumed = true;
        // Re-anchor rather than ending the gesture: a continuous drag across
        // the screen can then produce a second lane change without lifting.
        this.active.startX = pointer.x;
        this.active.startY = pointer.y;
        this.active.consumed = false;
        return;
      }

      if (absY >= GAME.input.swipeThreshold && absY > absX * GAME.input.axisRatio) {
        this.push(dy < 0 ? 'jump' : 'slam');
        this.active.consumed = true;
      }
    };

    const onUp = (pointer: Phaser.Input.Pointer): void => {
      if (!this.enabled || !this.active || this.active.id !== pointer.id) return;
      const held = performance.now() - this.active.startTime;
      // A quick tap with no travel is a jump. It is the discoverable control:
      // players tap before they swipe.
      if (!this.active.moved && held <= GAME.input.tapMaxMs) this.push('jump');
      this.active = null;
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

    // Keyboard, for desktop play and for testing without a touch device.
    const keyboard = this.scene.input.keyboard;
    if (keyboard) {
      this.keys = keyboard.addKeys('LEFT,RIGHT,UP,DOWN,A,D,W,S,SPACE') as Record<
        string,
        Phaser.Input.Keyboard.Key
      >;
      const bind = (key: Phaser.Input.Keyboard.Key | undefined, action: InputAction): void => {
        if (!key) return;
        const handler = (): void => {
          if (this.enabled) this.push(action);
        };
        key.on('down', handler);
        this.detachers.push(() => key.off('down', handler));
      };
      bind(this.keys.LEFT, 'left');
      bind(this.keys.A, 'left');
      bind(this.keys.RIGHT, 'right');
      bind(this.keys.D, 'right');
      bind(this.keys.UP, 'jump');
      bind(this.keys.W, 'jump');
      bind(this.keys.SPACE, 'jump');
      bind(this.keys.DOWN, 'slam');
      bind(this.keys.S, 'slam');
    }
  }

  private push(action: InputAction): void {
    // Cap the queue. Beyond a couple of buffered moves the player has lost
    // track of where the ball is anyway, and honouring a long backlog feels
    // like the ball is driving itself.
    if (this.queue.length >= GAME.player.inputBuffer + 1) this.queue.shift();
    this.queue.push(action);
  }

  /** Pops the next buffered action, or null. Called once per frame. */
  consume(): InputAction | null {
    return this.queue.shift() ?? null;
  }

  /** Drops buffered input — used on pause, death and continue. */
  flush(): void {
    this.queue.length = 0;
    this.active = null;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.flush();
  }

  destroy(): void {
    for (const detach of this.detachers) detach();
    this.detachers.length = 0;
    this.queue.length = 0;
    this.active = null;
  }
}
