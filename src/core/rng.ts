/**
 * Deterministic pseudo-random number generation.
 *
 * Every system that must agree across devices — the daily challenge, the daily
 * mission set, the shape of a seeded track — draws from a seeded generator
 * rather than Math.random. Same seed in, same world out, on every phone.
 */

export type Rng = {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Float in [min, max). */
  range(min: number, max: number): number;
  /** True with the given probability. */
  chance(p: number): boolean;
  /** Uniform pick from a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** Weighted pick; weights must be positive and align with `items`. */
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  /** Fisher–Yates shuffle, returns a new array. */
  shuffle<T>(items: readonly T[]): T[];
  /** Current internal state, so a generator can be checkpointed. */
  state(): number;
};

/**
 * Mulberry32 — 32-bit, one multiply-heavy round, passes gjrand's basic suite.
 * Fast enough to call thousands of times per frame during track generation.
 */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;

  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const rng: Rng = {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    range: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
    weighted(items, weights) {
      let total = 0;
      for (let i = 0; i < weights.length; i++) total += weights[i];
      let roll = next() * total;
      for (let i = 0; i < items.length; i++) {
        roll -= weights[i];
        if (roll <= 0) return items[i];
      }
      return items[items.length - 1];
    },
    shuffle(items) {
      const out = items.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    },
    state: () => a,
  };

  return rng;
}

/**
 * FNV-1a. Turns a string key ("2026-08-06", a user id) into a stable 32-bit
 * seed. Not cryptographic — it exists to make content deterministic, not safe.
 */
export function hashString(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Convenience: a generator seeded from any string key. */
export function rngFromKey(key: string): Rng {
  return createRng(hashString(key));
}

/** A generator seeded from the clock, for things that should differ per run. */
export function randomSeed(): number {
  return (Math.floor(Math.random() * 0xffffffff) ^ Date.now()) >>> 0;
}
