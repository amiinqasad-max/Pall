/**
 * Device capability detection.
 *
 * The goal is a defensible first guess at a quality tier before the first
 * frame renders, then continuous correction from measured frame time. A phone
 * that reports 8 cores but thermally throttles two minutes into a session
 * should end up on the same tier as a phone that never had the headroom.
 */

import { GAME, type QualitySettings } from '@/game/config';
import type { PerfTier } from '@/types';

export interface DeviceProfile {
  tier: PerfTier;
  cores: number;
  memoryGb: number | null;
  dpr: number;
  /** True when the browser exposes a data-saver preference. */
  saveData: boolean;
  reducedMotion: boolean;
  touch: boolean;
  standalone: boolean;
}

export function detectDevice(): DeviceProfile {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    connection?: { saveData?: boolean; effectiveType?: string };
  };
  const cores = nav.hardwareConcurrency ?? 4;
  const memoryGb = nav.deviceMemory ?? null;
  const dpr = window.devicePixelRatio || 1;
  const saveData = Boolean(nav.connection?.saveData);
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  let tier: PerfTier = 'medium';

  // deviceMemory is the strongest single signal available and is exactly the
  // axis the performance target is written against (1GB vs 2GB Android).
  if (memoryGb !== null) {
    if (memoryGb <= 2) tier = 'low';
    else if (memoryGb <= 4) tier = 'medium';
    else tier = 'high';
  } else {
    // iOS never reports deviceMemory. Core count plus DPR is a decent proxy:
    // every iPhone that runs a modern browser handles the medium tier fine.
    if (cores <= 4) tier = 'low';
    else if (cores <= 6) tier = 'medium';
    else tier = 'high';
  }

  // A very high core count with a very low DPR is usually a desktop; give it
  // the top tier regardless of what memory reporting says.
  if (cores >= 8 && dpr <= 2 && memoryGb !== null && memoryGb >= 8) tier = 'high';

  // Explicit user-side signals always win over hardware guesses.
  if (saveData) tier = 'low';

  return {
    tier,
    cores,
    memoryGb,
    dpr,
    saveData,
    reducedMotion,
    touch: 'ontouchstart' in window || navigator.maxTouchPoints > 0,
    standalone: window.matchMedia?.('(display-mode: standalone)').matches ?? false,
  };
}

export function qualityFor(tier: PerfTier): QualitySettings {
  return GAME.quality[tier] as QualitySettings;
}

/**
 * Watches frame time during play and reports when the current tier is not
 * holding up. Downgrades are permanent for the session — oscillating between
 * tiers is more distracting than simply running at the lower one.
 */
export class PerformanceGovernor {
  private frames = 0;
  private accum = 0;
  private worst = 0;
  private windowStart = 0;
  private downgrades = 0;
  private lastSample = { fps: 60, minFps: 60 };

  constructor(
    private tier: PerfTier,
    private onDowngrade: (tier: PerfTier) => void,
  ) {}

  /** Call once per frame with the delta in ms. */
  sample(deltaMs: number, nowMs: number): void {
    if (this.windowStart === 0) this.windowStart = nowMs;
    // Ignore obvious stalls: tab switches and GC pauses are not tier signals.
    if (deltaMs > 250) return;

    this.frames++;
    this.accum += deltaMs;
    this.worst = Math.max(this.worst, deltaMs);

    const elapsed = nowMs - this.windowStart;
    if (elapsed < 3000) return;

    const fps = this.frames / (this.accum / 1000);
    const minFps = 1000 / Math.max(1, this.worst);
    this.lastSample = { fps, minFps };

    const target = GAME.quality[this.tier].targetFps;
    // Two consecutive bad windows, not one, so a single stutter never demotes.
    if (fps < target * 0.72 && this.downgrades < 2) {
      const next: PerfTier | null = this.tier === 'high' ? 'medium' : this.tier === 'medium' ? 'low' : null;
      if (next) {
        this.tier = next;
        this.downgrades++;
        this.onDowngrade(next);
      }
    }

    this.frames = 0;
    this.accum = 0;
    this.worst = 0;
    this.windowStart = nowMs;
  }

  get stats(): { fps: number; minFps: number } {
    return this.lastSample;
  }

  get currentTier(): PerfTier {
    return this.tier;
  }
}
