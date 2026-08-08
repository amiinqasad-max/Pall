/**
 * Championship reads and submissions.
 *
 * Mirrors `services/leaderboard.ts`'s shape deliberately — same session
 * bootstrap, same short-TTL cache, same "no backend configured" and "offline"
 * fallbacks — but does **not** reuse its offline-submission queue. A free
 * leaderboard run is a personal best that can be replayed later with no
 * downside; a Championship run consumes a finite, countable attempt (or
 * decides qualification), so queuing a submission for later replay risks
 * double-counting or a stale rejection once state has moved on. Championship
 * submissions are attempt-now, tell-the-player-if-it-failed, not queue-and-
 * flush.
 *
 * Every submission and every read goes through the RPCs in
 * supabase/migrations/0002_championship.sql — the client never writes a
 * qualification score, a final score, a rank, or a coin balance directly.
 */

import { ensureSession, isOnline, supabase } from '@/services/supabase';
import { analytics } from '@/systems/analytics';
import type {
  ChampionshipChallenge,
  ChampionshipLeaderboardEntry,
  ChampionshipParticipant,
  ChampionshipPayout,
  CoinPackage,
  RunResult,
} from '@/types';

const LEADERBOARD_CACHE_TTL_MS = 20_000;

/**
 * Mirrors `game_constants.revive_cost_coins` in
 * supabase/migrations/0002_championship.sql — the server is what actually
 * enforces this (spend_coins_for_revive reads the real row), this is only
 * for display before the request goes out. Keep the two in step.
 */
export const REVIVE_COST_COINS = 50;

interface LeaderboardCacheEntry {
  at: number;
  entries: ChampionshipLeaderboardEntry[];
  selfRank: number | null;
}

let leaderboardCache: Record<string, LeaderboardCacheEntry> = {};

function mapChallenge(row: Record<string, unknown>): ChampionshipChallenge {
  return {
    id: row.id as string,
    challengeDate: row.challenge_date as string,
    status: row.status as ChampionshipChallenge['status'],
    startTime: row.start_time as string,
    endTime: row.end_time as string,
    qualificationTrackSeed: Number(row.qualification_track_seed),
    finalTrackSeed: Number(row.final_track_seed),
    qualificationTarget: row.qualification_target == null ? null : Number(row.qualification_target),
    prizePoolCents: row.prize_pool_usd_cents == null ? null : Number(row.prize_pool_usd_cents),
    winnerCount: row.winner_count == null ? null : Number(row.winner_count),
    maxFinalAttempts: row.max_final_attempts == null ? null : Number(row.max_final_attempts),
  };
}

export interface TodaysChallengeResult {
  challenge: ChampionshipChallenge | null;
  /** True only when the fetch itself failed (offline, network error, a
   *  Postgres error) — false when it succeeded and simply found no row.
   *  The UI needs this distinction: "no Championship is scheduled today" and
   *  "couldn't reach the backend" are not the same message or the same
   *  recovery action (a retry button only makes sense for the latter). */
  error: boolean;
}

/** Today's Championship, whatever state it's in. `challenge` is null both
 *  when nothing is scheduled yet and when the fetch failed outright — check
 *  `error` to tell those apart. */
export async function fetchTodaysChallenge(): Promise<TodaysChallengeResult> {
  const sb = await supabase();
  // No backend configured at all is a deployment fact, not a transient
  // failure — showing a "couldn't load, try again" state that can never
  // succeed would be actively misleading, so this reads as "no challenge".
  if (!sb) return { challenge: null, error: false };
  if (!isOnline()) return { challenge: null, error: true };

  try {
    const today = new Date().toISOString().slice(0, 10);
    const { data, error } = await sb
      .from('daily_challenges')
      .select('*')
      .eq('challenge_date', today)
      .in('status', ['scheduled', 'active', 'paused', 'ended'])
      .maybeSingle();
    if (error) {
      analytics.track('championship_fetch_failed', { message: error.message });
      return { challenge: null, error: true };
    }
    if (!data) return { challenge: null, error: false };
    return { challenge: mapChallenge(data as Record<string, unknown>), error: false };
  } catch (err) {
    analytics.track('championship_fetch_failed', { message: String(err) });
    return { challenge: null, error: true };
  }
}

/** The signed-in player's own row for a challenge, or null if they haven't
 *  submitted anything yet. RLS already restricts this to the caller's own
 *  row, so no explicit user filter is needed. */
export async function fetchMyParticipant(challengeId: string): Promise<ChampionshipParticipant | null> {
  const sb = await supabase();
  const session = await ensureSession();
  if (!sb || !session || !isOnline()) return null;

  try {
    const { data, error } = await sb
      .from('challenge_participants')
      .select('*')
      .eq('challenge_id', challengeId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    return {
      qualificationStatus: row.qualification_status as ChampionshipParticipant['qualificationStatus'],
      qualificationScore: Number(row.qualification_score),
      qualificationTimestamp: (row.qualification_timestamp as string | null) ?? null,
      finalAttemptsUsed: Number(row.final_attempts_used),
      finalScore: Number(row.final_score),
      finalRank: row.final_rank == null ? null : Number(row.final_rank),
      antiCheatStatus: row.anti_cheat_status as ChampionshipParticipant['antiCheatStatus'],
    };
  } catch (err) {
    analytics.track('championship_fetch_failed', { message: String(err) });
    return null;
  }
}

export type QualificationSubmitResult =
  | 'qualified'
  | 'accepted'
  | 'offline'
  | 'not_signed_in'
  | string; // any rejection_reason the RPC returns (too_short, distance_impossible, ...)

export async function submitQualificationRun(
  challengeId: string,
  run: RunResult,
  sessionId: string,
  deviceFingerprint: string,
): Promise<QualificationSubmitResult> {
  const sb = await supabase();
  if (!sb || !isOnline()) return 'offline';
  const session = await ensureSession();
  if (!session) return 'not_signed_in';

  try {
    const { data, error } = await sb.rpc('submit_qualification_run', {
      p_challenge_id: challengeId,
      p_score: Math.round(run.score),
      p_distance: Math.round(run.distance),
      p_duration_ms: Math.round(run.durationMs),
      p_prisms: run.prisms,
      p_near_misses: run.nearMisses,
      p_stage: run.stage,
      p_session_id: sessionId,
      p_device_fingerprint: deviceFingerprint,
    });
    if (error) {
      analytics.track('championship_qualify_submit_failed', { message: error.message });
      return 'offline';
    }
    analytics.track('championship_qualify_submitted', { result: data, score: run.score });
    return (data as string) ?? 'accepted';
  } catch (err) {
    analytics.track('championship_qualify_submit_failed', { message: String(err) });
    return 'offline';
  }
}

export type FinalSubmitResult = 'accepted' | 'offline' | 'not_signed_in' | string;

export async function submitFinalRun(
  challengeId: string,
  run: RunResult,
  sessionId: string,
): Promise<FinalSubmitResult> {
  const sb = await supabase();
  if (!sb || !isOnline()) return 'offline';
  const session = await ensureSession();
  if (!session) return 'not_signed_in';

  try {
    const { data, error } = await sb.rpc('submit_final_run', {
      p_challenge_id: challengeId,
      p_score: Math.round(run.score),
      p_distance: Math.round(run.distance),
      p_duration_ms: Math.round(run.durationMs),
      p_prisms: run.prisms,
      p_near_misses: run.nearMisses,
      p_stage: run.stage,
      p_session_id: sessionId,
    });
    if (error) {
      analytics.track('championship_final_submit_failed', { message: error.message });
      return 'offline';
    }
    analytics.track('championship_final_submitted', { result: data, score: run.score });
    // A new best invalidates the cached leaderboard immediately, so the
    // final screen's next read reflects the improvement rather than the
    // up-to-20s-stale cache.
    invalidateLeaderboardCache(challengeId);
    return (data as string) ?? 'accepted';
  } catch (err) {
    analytics.track('championship_final_submit_failed', { message: String(err) });
    return 'offline';
  }
}

function invalidateLeaderboardCache(challengeId: string): void {
  delete leaderboardCache[challengeId];
}

export interface ChampionshipLeaderboardPage {
  entries: ChampionshipLeaderboardEntry[];
  selfRank: number | null;
  stale: boolean;
}

export async function fetchChampionshipLeaderboard(
  challengeId: string,
  limit = 25,
): Promise<ChampionshipLeaderboardPage> {
  const sb = await supabase();
  const cached = leaderboardCache[challengeId];
  const fresh = cached && Date.now() - cached.at < LEADERBOARD_CACHE_TTL_MS;

  if (!sb || !isOnline()) {
    return { entries: cached?.entries ?? [], selfRank: cached?.selfRank ?? null, stale: true };
  }
  if (fresh) {
    return { entries: cached.entries, selfRank: cached.selfRank, stale: false };
  }

  try {
    const session = await ensureSession();
    const { data, error } = await sb.rpc('championship_leaderboard_page', {
      p_challenge_id: challengeId,
      p_limit: limit,
    });
    if (error) throw error;

    const rows = (data ?? []) as {
      rank: number;
      user_id: string;
      username: string;
      final_score: number;
      completed_at: string;
    }[];

    const entries: ChampionshipLeaderboardEntry[] = rows.map((r) => ({
      rank: Number(r.rank),
      userId: r.user_id,
      username: r.username,
      finalScore: Number(r.final_score),
      completedAt: r.completed_at,
      isSelf: session ? r.user_id === session.user.id : false,
    }));

    let selfRank: number | null = null;
    if (session) {
      const { data: rankData } = await sb.rpc('championship_self_rank', { p_challenge_id: challengeId });
      selfRank = rankData == null ? null : Number(rankData);
    }

    leaderboardCache = { ...leaderboardCache, [challengeId]: { at: Date.now(), entries, selfRank } };
    return { entries, selfRank, stale: false };
  } catch (err) {
    analytics.track('championship_leaderboard_fetch_failed', { message: String(err) });
    return { entries: cached?.entries ?? [], selfRank: cached?.selfRank ?? null, stale: true };
  }
}

/** The prize amount, in cents, at a given rank — null outside the paid
 *  ranks (below the winner count) or if prizes aren't loaded yet. */
export async function fetchPrizeAtRank(challengeId: string, rank: number | null): Promise<number | null> {
  if (!rank) return null;
  const sb = await supabase();
  if (!sb || !isOnline()) return null;
  try {
    const { data, error } = await sb
      .from('challenge_prizes')
      .select('prize_amount_cents')
      .eq('challenge_id', challengeId)
      .eq('rank', rank)
      .maybeSingle();
    if (error || !data) return null;
    return Number((data as { prize_amount_cents: number }).prize_amount_cents);
  } catch {
    return null;
  }
}

/** The signed-in player's own payout row for a challenge, or null if they
 *  never placed in the Top-N (end_challenge only seeds a row for finishers
 *  the frozen prize table actually covers). RLS already restricts this read
 *  to the caller's own row, exactly like fetchMyParticipant above. */
export async function fetchMyPayout(challengeId: string): Promise<ChampionshipPayout | null> {
  const sb = await supabase();
  const session = await ensureSession();
  if (!sb || !session || !isOnline()) return null;

  try {
    const { data, error } = await sb
      .from('challenge_payouts')
      .select('rank, prize_amount_cents, verification_status, payout_status')
      .eq('challenge_id', challengeId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    return {
      rank: Number(row.rank),
      prizeAmountCents: Number(row.prize_amount_cents),
      verificationStatus: row.verification_status as ChampionshipPayout['verificationStatus'],
      payoutStatus: row.payout_status as ChampionshipPayout['payoutStatus'],
    };
  } catch (err) {
    analytics.track('championship_fetch_failed', { message: String(err) });
    return null;
  }
}

/** The social-proof number on the qualification screen — safe to show
 *  publicly, unlike the participant list itself. */
export async function fetchQualifiedCount(challengeId: string): Promise<number> {
  const sb = await supabase();
  if (!sb || !isOnline()) return 0;
  try {
    const { data, error } = await sb.rpc('championship_qualified_count', { p_challenge_id: challengeId });
    if (error || data == null) return 0;
    return Number(data);
  } catch {
    return 0;
  }
}

/** Fail-closed: no country known, or no backend, means no cash prizes shown. */
export async function regionCashPrizeEnabled(country: string | null): Promise<boolean> {
  if (!country) return false;
  const sb = await supabase();
  if (!sb || !isOnline()) return false;
  try {
    const { data, error } = await sb.rpc('region_cash_prize_enabled', { p_country: country });
    if (error) return false;
    return Boolean(data);
  } catch {
    return false;
  }
}

/** Returns the new coin balance, or null if the player doesn't have enough
 *  coins (not an error — the caller offers the ad-based continue instead). */
export async function spendCoinsForRevive(runSessionId: string): Promise<number | null> {
  const sb = await supabase();
  const session = await ensureSession();
  if (!sb || !session || !isOnline()) return null;

  try {
    const { data, error } = await sb.rpc('spend_coins_for_revive', { p_run_session_id: runSessionId });
    if (error) {
      analytics.track('revive_spend_failed', { message: error.message });
      return null;
    }
    return data == null ? null : Number(data);
  } catch (err) {
    analytics.track('revive_spend_failed', { message: String(err) });
    return null;
  }
}

export async function fetchCoinPackages(): Promise<CoinPackage[]> {
  const sb = await supabase();
  if (!sb || !isOnline()) return [];
  try {
    const { data, error } = await sb.from('coin_packages').select('*').eq('active', true).order('sort_order');
    if (error || !data) return [];
    return (data as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      name: row.name as string,
      coins: Number(row.coins),
      priceUsdCents: Number(row.price_usd_cents),
    }));
  } catch {
    return [];
  }
}

/**
 * Records a purchase attempt for admin review (see the migration's header:
 * no live store-receipt verification is wired in here). Returns the purchase
 * record id, or null if the request couldn't be made at all.
 */
export async function recordPurchaseAttempt(
  packageId: string,
  platform: 'web' | 'ios' | 'android',
  receiptToken: string,
): Promise<string | null> {
  const sb = await supabase();
  const session = await ensureSession();
  if (!sb || !session || !isOnline()) return null;

  try {
    const { data, error } = await sb.rpc('record_purchase_attempt', {
      p_package_id: packageId,
      p_platform: platform,
      p_receipt_token: receiptToken,
    });
    if (error) {
      analytics.track('purchase_attempt_failed', { message: error.message });
      return null;
    }
    return (data as string) ?? null;
  } catch (err) {
    analytics.track('purchase_attempt_failed', { message: String(err) });
    return null;
  }
}

export function clearChampionshipCache(): void {
  leaderboardCache = {};
}

export { invalidateLeaderboardCache };
