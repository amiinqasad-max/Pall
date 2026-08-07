/**
 * Leaderboard submission and reads.
 *
 * Submission goes through the `submit_run` RPC rather than an INSERT, because
 * the client is not trusted with its own score. The function re-runs the same
 * plausibility checks as systems/integrity.ts, stamps the server clock, and
 * rejects anything impossible. Row-level security prevents writes to the
 * scores table by any other path — see supabase/migrations.
 *
 * Reads are cached briefly so opening and closing the leaderboard tab does not
 * hammer the database, and the last successful response is kept so the screen
 * still shows something useful offline.
 */

import { ensureSession, isOnline, supabase } from '@/services/supabase';
import { storage } from '@/systems/storage';
import { analytics } from '@/systems/analytics';
import type { LeaderboardEntry, LeaderboardScope, RunResult } from '@/types';

const CACHE_TTL_MS = 45_000;
const CACHE_KEY = 'leaderboard.cache';
const PENDING_KEY = 'leaderboard.pending';

interface CacheEntry {
  at: number;
  entries: LeaderboardEntry[];
  selfRank: number | null;
}

type Cache = Partial<Record<LeaderboardScope, CacheEntry>>;

export interface LeaderboardPage {
  entries: LeaderboardEntry[];
  selfRank: number | null;
  /** True when the data came from cache because the network was unavailable. */
  stale: boolean;
  /** True when there is no backend at all — the UI explains local-only mode. */
  offlineOnly: boolean;
}

/** Runs that could not be submitted are queued and retried on reconnect. */
interface PendingRun {
  run: RunResult;
  username: string;
  level: number;
  queuedAt: number;
}

export async function submitRun(run: RunResult, username: string, level: number): Promise<boolean> {
  const sb = await supabase();
  if (!sb || !isOnline()) {
    await queueRun(run, username, level);
    return false;
  }

  const session = await ensureSession();
  if (!session) {
    await queueRun(run, username, level);
    return false;
  }

  try {
    const { data, error } = await sb.rpc('submit_run', {
      p_score: Math.round(run.score),
      p_distance: Math.round(run.distance),
      p_duration_ms: Math.round(run.durationMs),
      p_prisms: run.prisms,
      p_obstacles_dodged: run.obstaclesDodged,
      p_near_misses: run.nearMisses,
      p_stage: run.stage,
      p_seed: run.seed,
      p_daily: run.daily,
      p_continued: run.continued,
      p_username: username,
      p_level: level,
    });

    if (error) {
      analytics.track('run_submit_failed', { message: error.message });
      await queueRun(run, username, level);
      return false;
    }
    // The RPC returns false when its own validator rejected the run.
    if (data === false) {
      analytics.track('run_submit_rejected', { score: run.score, distance: run.distance });
      return false;
    }
    invalidateCache();
    return true;
  } catch (err) {
    analytics.track('run_submit_failed', { message: String(err) });
    await queueRun(run, username, level);
    return false;
  }
}

async function queueRun(run: RunResult, username: string, level: number): Promise<void> {
  const pending = (await storage.get<PendingRun[]>(PENDING_KEY)) ?? [];
  // Only the best few are worth retrying; a queue of 200 mediocre runs helps
  // nobody and the leaderboard only cares about personal bests anyway.
  pending.push({ run, username, level, queuedAt: Date.now() });
  pending.sort((a, b) => b.run.score - a.run.score);
  await storage.set(PENDING_KEY, pending.slice(0, 10));
}

/** Retries queued submissions. Called on reconnect and at app start. */
export async function flushPendingRuns(): Promise<number> {
  const pending = (await storage.get<PendingRun[]>(PENDING_KEY)) ?? [];
  if (pending.length === 0 || !isOnline() || !(await supabase())) return 0;

  const remaining: PendingRun[] = [];
  let sent = 0;
  for (const item of pending) {
    const ok = await submitRunDirect(item);
    if (ok) sent++;
    else remaining.push(item);
  }
  await storage.set(PENDING_KEY, remaining);
  if (sent > 0) analytics.track('pending_runs_flushed', { count: sent });
  return sent;
}

/** Submits without re-queueing on failure, so flush cannot loop forever. */
async function submitRunDirect(item: PendingRun): Promise<boolean> {
  const sb = await supabase();
  const session = await ensureSession();
  if (!sb || !session) return false;
  const { run } = item;
  const { error } = await sb.rpc('submit_run', {
    p_score: Math.round(run.score),
    p_distance: Math.round(run.distance),
    p_duration_ms: Math.round(run.durationMs),
    p_prisms: run.prisms,
    p_obstacles_dodged: run.obstaclesDodged,
    p_near_misses: run.nearMisses,
    p_stage: run.stage,
    p_seed: run.seed,
    p_daily: run.daily,
    p_continued: run.continued,
    p_username: item.username,
    p_level: item.level,
  });
  return !error;
}

async function readCache(): Promise<Cache> {
  return (await storage.get<Cache>(CACHE_KEY)) ?? {};
}

let cacheInvalidatedAt = 0;
function invalidateCache(): void {
  cacheInvalidatedAt = Date.now();
}

export async function fetchLeaderboard(scope: LeaderboardScope, limit = 50): Promise<LeaderboardPage> {
  const sb = await supabase();
  const cache = await readCache();
  const cached = cache[scope];
  const fresh = cached && Date.now() - cached.at < CACHE_TTL_MS && cached.at > cacheInvalidatedAt;

  if (!sb) {
    return { entries: cached?.entries ?? [], selfRank: cached?.selfRank ?? null, stale: true, offlineOnly: true };
  }
  if (fresh) {
    return { entries: cached.entries, selfRank: cached.selfRank, stale: false, offlineOnly: false };
  }
  if (!isOnline()) {
    return { entries: cached?.entries ?? [], selfRank: cached?.selfRank ?? null, stale: true, offlineOnly: false };
  }

  try {
    const session = await ensureSession();
    const { data, error } = await sb.rpc('leaderboard_page', {
      p_scope: scope,
      p_limit: limit,
    });
    if (error) throw error;

    const rows = (data ?? []) as {
      rank: number;
      user_id: string;
      username: string;
      score: number;
      level: number;
      country: string | null;
    }[];

    const entries: LeaderboardEntry[] = rows.map((r) => ({
      rank: Number(r.rank),
      userId: r.user_id,
      username: r.username,
      score: Number(r.score),
      level: Number(r.level),
      country: r.country,
      isSelf: session ? r.user_id === session.user.id : false,
    }));

    const selfRank = await fetchSelfRank(scope);
    const next: Cache = { ...cache, [scope]: { at: Date.now(), entries, selfRank } };
    await storage.set(CACHE_KEY, next);
    return { entries, selfRank, stale: false, offlineOnly: false };
  } catch (err) {
    analytics.track('leaderboard_fetch_failed', { scope, message: String(err) });
    return { entries: cached?.entries ?? [], selfRank: cached?.selfRank ?? null, stale: true, offlineOnly: false };
  }
}

/**
 * The player's own rank, fetched separately because it is usually outside the
 * top 50 and a "you are 12,481st" line is a real motivator.
 */
async function fetchSelfRank(scope: LeaderboardScope): Promise<number | null> {
  const sb = await supabase();
  const session = await ensureSession();
  if (!sb || !session) return null;
  try {
    const { data, error } = await sb.rpc('leaderboard_self_rank', { p_scope: scope });
    if (error || data == null) return null;
    return Number(data) || null;
  } catch {
    return null;
  }
}
