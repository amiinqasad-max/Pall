/**
 * Numbers that count rather than jump.
 *
 * A score snapping from 0 to 4,318 is information; a score rolling up to 4,318
 * is a reward. The difference costs one rAF loop.
 *
 * The count is driven off requestAnimationFrame and writes through a ref, so a
 * three-second roll-up does not push three seconds of React renders through the
 * same main thread the results screen is animating on.
 */

import { useEffect, useRef, useState } from 'react';

/** Decelerating ease — fast at the start so the number feels eager. */
const easeOutExpo = (t: number): number => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));

export interface CountOptions {
  durationMs?: number;
  /** Wait before starting, for staggering a column of figures. */
  delayMs?: number;
  /** Skip the animation entirely (reduced motion). */
  immediate?: boolean;
}

/**
 * Returns a value that animates from 0 to `target`. Re-runs whenever the target
 * changes, so a value arriving late still counts up rather than appearing.
 */
export function useAnimatedNumber(target: number, options: CountOptions = {}): number {
  const { durationMs = 900, delayMs = 0, immediate = false } = options;
  const [value, setValue] = useState(immediate ? target : 0);
  const frame = useRef(0);
  const startedAt = useRef(0);

  useEffect(() => {
    if (immediate || target === 0) {
      setValue(target);
      return;
    }

    let cancelled = false;
    startedAt.current = 0;

    const step = (now: number): void => {
      if (cancelled) return;
      if (startedAt.current === 0) startedAt.current = now + delayMs;
      const elapsed = now - startedAt.current;
      if (elapsed < 0) {
        frame.current = requestAnimationFrame(step);
        return;
      }
      const t = Math.min(1, elapsed / durationMs);
      setValue(Math.round(target * easeOutExpo(t)));
      if (t < 1) frame.current = requestAnimationFrame(step);
    };

    frame.current = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame.current);
    };
  }, [target, durationMs, delayMs, immediate]);

  return value;
}

/**
 * Staged reveal.
 *
 * Returns how many items of `count` should currently be visible, advancing one
 * every `intervalMs`. Revealing a results screen all at once wastes it —
 * letting score, then XP, then missions land in sequence is what makes the
 * screen feel authored rather than dumped.
 */
export function useStagger(count: number, intervalMs = 140, startDelayMs = 220): number {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    setShown(0);
    if (count <= 0) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (let i = 0; i < count; i++) {
      timers.push(setTimeout(() => setShown((n) => Math.max(n, i + 1)), startDelayMs + i * intervalMs));
    }
    return () => timers.forEach(clearTimeout);
  }, [count, intervalMs, startDelayMs]);

  return shown;
}
