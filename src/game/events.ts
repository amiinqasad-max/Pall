/**
 * The game <-> UI event contract.
 *
 * This is the only channel between Phaser and React. `tick` fires every frame
 * and is consumed by a HUD that writes straight to DOM nodes; everything else
 * is low frequency and drives React state.
 */

import { Emitter } from '@/core/events';
import type { RunResult } from '@/types';

export interface GameTick {
  score: number;
  distance: number;
  speed: number;
  stage: number;
  prisms: number;
  /** Consecutive prisms collected without a miss; drives the score chain. */
  chain: number;
  boosting: boolean;
  fps: number;
}

export interface GameEventMap {
  /** Textures built, first frame rendered — the splash can go. */
  ready: void;
  countdown: { value: number };
  started: { daily: boolean; seed: number };
  tick: GameTick;
  stage: { stage: number; name: string };
  prism: { total: number; chain: number };
  nearMiss: { total: number };
  /** Player hit something. `canContinue` gates the rewarded-ad offer. */
  died: { result: RunResult; canContinue: boolean; cause: string };
  /** The run is finally over — after any continue was declined or used up. */
  finished: { result: RunResult };
  continued: void;
  paused: void;
  resumed: void;
  qualityChanged: { tier: string };
}

export const gameEvents = new Emitter<GameEventMap>();
