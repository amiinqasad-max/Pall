/**
 * Game lifecycle.
 *
 * Phaser is created lazily, on the first run, and torn down when the player
 * leaves the game screen. Keeping a WebGL context and a full texture set alive
 * behind the menus is the difference between ~90MB and ~25MB resident on a
 * low-end device, and it is the most common reason a mobile web game gets
 * killed in the background.
 */

import Phaser from 'phaser';
import { RunScene, type RunConfig } from '@/game/scenes/RunScene';
import { GAME } from '@/game/config';
import type { PerfTier } from '@/types';

let game: Phaser.Game | null = null;
let scene: RunScene | null = null;

export interface LaunchOptions extends Omit<RunConfig, 'tier'> {
  parent: HTMLElement;
  tier: PerfTier;
  /** Device pixel ratio cap, from the quality tier. */
  resolutionCap: number;
}

export function launchGame(options: LaunchOptions): void {
  destroyGame();

  const resolution = Math.min(window.devicePixelRatio || 1, options.resolutionCap);

  game = new Phaser.Game({
    type: Phaser.WEBGL,
    parent: options.parent,
    backgroundColor: '#08131a',
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH,
      width: options.parent.clientWidth,
      height: options.parent.clientHeight,
    },
    // We run our own audio engine; letting Phaser create a second
    // AudioContext costs memory and fights ours for the output device.
    audio: { noAudio: true },
    render: {
      antialias: options.tier !== 'low',
      powerPreference: 'high-performance',
      // Rounding sprite positions to whole pixels removes the shimmer on the
      // road banding without needing any filtering.
      roundPixels: true,
      pixelArt: false,
      transparent: false,
      // The compositor never needs to read the canvas back, and saying so lets
      // the driver skip a full-screen copy every frame.
      preserveDrawingBuffer: false,
      failIfMajorPerformanceCaveat: false,
    },
    fps: {
      target: GAME.quality[options.tier].targetFps,
      // Never let Phaser subdivide a slow frame into several updates: on a
      // struggling device that turns one dropped frame into a death spiral.
      forceSetTimeOut: false,
      smoothStep: true,
    },
    banner: false,
    disableContextMenu: true,
    autoFocus: true,
    scene: [RunScene],
  });

  // Phaser applies zoom rather than a device-pixel-ratio directly; setting it
  // here caps backing-store size on 3x displays where the extra pixels buy
  // nothing at this art style.
  game.scale.setZoom(1);
  if (game.renderer && 'resolution' in game.renderer) {
    (game.renderer as unknown as { resolution: number }).resolution = resolution;
  }

  game.scene.start('run', {
    skinId: options.skinId,
    trailId: options.trailId,
    environmentId: options.environmentId,
    tier: options.tier,
    daily: options.daily,
    seed: options.seed,
    reducedMotion: options.reducedMotion,
  } satisfies RunConfig);

  scene = game.scene.getScene('run') as RunScene;
}

export function destroyGame(): void {
  if (scene) {
    scene.shutdown();
    scene = null;
  }
  if (game) {
    game.destroy(true, false);
    game = null;
  }
}

function activeScene(): RunScene | null {
  if (!game) return null;
  if (!scene) scene = game.scene.getScene('run') as RunScene | null;
  return scene;
}

export function pauseGame(): void {
  activeScene()?.pauseRun();
}

export function resumeGame(): void {
  activeScene()?.resumeRun();
}

export function continueGame(): void {
  activeScene()?.continueRun();
}

export function finishGame(): void {
  activeScene()?.finishRun();
}

export function isGameRunning(): boolean {
  return game !== null;
}
