/**
 * Time helpers.
 *
 * Daily content resets at 00:00 UTC for everyone. Using UTC rather than local
 * time means the daily challenge is genuinely identical worldwide, and it
 * removes a whole class of exploits where a player changes timezone to farm
 * rewards.
 */

const DAY_MS = 86_400_000;

/** "2026-08-06" for the given instant, in UTC. */
export function dayKey(at: number | Date = Date.now()): string {
  const d = at instanceof Date ? at : new Date(at);
  return d.toISOString().slice(0, 10);
}

/** ISO week key, e.g. "2026-W32". Weekly missions reset on Monday 00:00 UTC. */
export function weekKey(at: number | Date = Date.now()): string {
  const d = at instanceof Date ? new Date(at.getTime()) : new Date(at);
  d.setUTCHours(0, 0, 0, 0);
  // Shift to the Thursday of the current ISO week, then count weeks from Jan 4.
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week =
    1 + Math.round(((d.getTime() - week1.getTime()) / DAY_MS - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** Whole days between two day keys (b - a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY_MS);
}

/** Milliseconds until the next UTC midnight — powers the "resets in" timers. */
export function msUntilUtcMidnight(now = Date.now()): number {
  return DAY_MS - (now % DAY_MS);
}

/** Milliseconds until the next Monday 00:00 UTC. */
export function msUntilWeeklyReset(now = Date.now()): number {
  const d = new Date(now);
  const daysToMonday = (8 - (d.getUTCDay() || 7)) % 7 || 7;
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysToMonday);
  return next - now;
}

/** "6h 12m" / "12m 30s" / "45s" — compact countdown text for the UI. */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** "1:04.2" style run duration. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}:${s.toFixed(1).padStart(4, '0')}` : `${s.toFixed(1)}s`;
}
