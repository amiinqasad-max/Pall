/**
 * Haptic feedback.
 *
 * navigator.vibrate is Android-only in practice — iOS Safari has never shipped
 * it. Rather than pretend otherwise, the API degrades to a no-op and the
 * settings toggle simply has no effect there.
 *
 * Patterns are short. A long buzz on every collision is the fastest way to get
 * a player to turn haptics off, and then you have lost the channel entirely.
 */

type HapticPattern = 'tap' | 'select' | 'impact' | 'heavy' | 'success' | 'warning' | 'reward';

const PATTERNS: Record<HapticPattern, number | number[]> = {
  tap: 8,
  select: 12,
  impact: [0, 26, 30, 16],
  heavy: [0, 45, 40, 60],
  success: [0, 14, 60, 14],
  warning: [0, 20, 50, 20, 50, 20],
  reward: [0, 12, 40, 12, 40, 26],
};

class Haptics {
  private enabled = true;
  private supported = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
  private lastAt = 0;

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.cancel();
  }

  get isSupported(): boolean {
    return this.supported;
  }

  fire(pattern: HapticPattern): void {
    if (!this.enabled || !this.supported) return;
    // Overlapping vibrations cancel each other on most Android builds and end
    // up feeling like nothing at all, so throttle to one every 60ms.
    const now = performance.now();
    if (now - this.lastAt < 60) return;
    this.lastAt = now;
    try {
      navigator.vibrate(PATTERNS[pattern]);
    } catch {
      this.supported = false;
    }
  }

  cancel(): void {
    if (!this.supported) return;
    try {
      navigator.vibrate(0);
    } catch {
      /* ignore */
    }
  }
}

export const haptics = new Haptics();
export type { HapticPattern };
