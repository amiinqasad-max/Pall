/**
 * Admin/staff actions.
 *
 * Every function here is a thin wrapper over a staff-gated RPC in
 * supabase/migrations/0002_championship.sql — the actual authorization check
 * (`tartan.is_staff(auth.uid())`) lives server-side and is re-checked inside
 * every one of those functions, not just here. A non-staff caller gets a
 * clean rejection from Postgres, not a UI that merely hides the buttons.
 */

import { ensureSession, supabase } from '@/services/supabase';

export async function isStaff(): Promise<boolean> {
  const sb = await supabase();
  const session = await ensureSession();
  if (!sb || !session) return false;
  try {
    const { data, error } = await sb.rpc('is_staff', { p_user: session.user.id });
    return !error && Boolean(data);
  } catch {
    return false;
  }
}

export interface AdminChallengeConfig {
  referencePercentile: number;
  qualificationMultiplier: number;
  minimumTarget: number;
  maximumTarget: number;
  fallbackTarget: number;
  minimumSampleSize: number;
  defaultPrizePoolCents: number;
  defaultWinnerCount: number;
  defaultMaxFinalAttempts: number;
  /** The per-rank prize template, exploded into challenge_prizes rows at
   *  start_challenge() time. Kept as the raw jsonb shape the RPC expects
   *  ({rank, amount_cents} or {rank_from, rank_to, amount_cents}) rather than
   *  a typed model — this is edited as JSON text in the admin screen. */
  defaultPrizeDistribution: unknown[];
}

export async function fetchChallengeConfig(): Promise<AdminChallengeConfig | null> {
  const sb = await supabase();
  if (!sb) return null;
  const { data, error } = await sb.from('daily_challenge_configs').select('*').eq('id', 1).maybeSingle();
  if (error || !data) return null;
  const row = data as Record<string, unknown>;
  return {
    referencePercentile: Number(row.reference_percentile),
    qualificationMultiplier: Number(row.qualification_multiplier),
    minimumTarget: Number(row.minimum_target),
    maximumTarget: Number(row.maximum_target),
    fallbackTarget: Number(row.fallback_target),
    minimumSampleSize: Number(row.minimum_sample_size),
    defaultPrizePoolCents: Number(row.default_prize_pool_usd_cents),
    defaultWinnerCount: Number(row.default_winner_count),
    defaultMaxFinalAttempts: Number(row.default_max_final_attempts),
    defaultPrizeDistribution: Array.isArray(row.default_prize_distribution) ? row.default_prize_distribution : [],
  };
}

export async function updateChallengeConfig(cfg: AdminChallengeConfig): Promise<boolean> {
  const sb = await supabase();
  if (!sb) return false;
  const { error } = await sb.rpc('update_challenge_config', {
    p_reference_percentile: cfg.referencePercentile,
    p_qualification_multiplier: cfg.qualificationMultiplier,
    p_minimum_target: cfg.minimumTarget,
    p_maximum_target: cfg.maximumTarget,
    p_fallback_target: cfg.fallbackTarget,
    p_minimum_sample_size: cfg.minimumSampleSize,
    p_default_prize_pool_usd_cents: cfg.defaultPrizePoolCents,
    p_default_winner_count: cfg.defaultWinnerCount,
    p_default_prize_distribution: cfg.defaultPrizeDistribution,
    p_default_max_final_attempts: cfg.defaultMaxFinalAttempts,
  });
  return !error;
}

export interface AdminChallengeRow {
  id: string;
  challengeDate: string;
  status: string;
}

export async function fetchRecentChallenges(limit = 10): Promise<AdminChallengeRow[]> {
  const sb = await supabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from('daily_challenges')
    .select('id, challenge_date, status')
    .order('challenge_date', { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    challengeDate: r.challenge_date as string,
    status: r.status as string,
  }));
}

export async function createChallenge(date: string, startIso: string, endIso: string): Promise<string | null> {
  const sb = await supabase();
  if (!sb) return null;
  const { data, error } = await sb.rpc('create_challenge', {
    p_challenge_date: date,
    p_start_time: startIso,
    p_end_time: endIso,
  });
  return error ? null : (data as string);
}

async function callLifecycle(fn: string, challengeId: string): Promise<boolean> {
  const sb = await supabase();
  if (!sb) return false;
  const { error } = await sb.rpc(fn, { p_challenge_id: challengeId });
  return !error;
}

export const startChallenge = (id: string): Promise<boolean> => callLifecycle('start_challenge', id);
export const pauseChallenge = (id: string): Promise<boolean> => callLifecycle('pause_challenge', id);
export const resumeChallenge = (id: string): Promise<boolean> => callLifecycle('resume_challenge', id);
export const endChallenge = (id: string): Promise<boolean> => callLifecycle('end_challenge', id);
export const cancelChallenge = (id: string): Promise<boolean> => callLifecycle('cancel_challenge', id);

export interface ChallengeMonitoring {
  totalParticipants: number;
  qualified: number;
  finalists: number;
  flagged: number;
  disqualified: number;
  winners: number;
  pendingPayouts: number;
  completedPayouts: number;
}

export async function fetchChallengeMonitoring(challengeId: string): Promise<ChallengeMonitoring | null> {
  const sb = await supabase();
  if (!sb) return null;
  const { data, error } = await sb.rpc('challenge_monitoring', { p_challenge_id: challengeId });
  if (error || !data || !Array.isArray(data) || data.length === 0) return null;
  const row = data[0] as Record<string, unknown>;
  return {
    totalParticipants: Number(row.total_participants),
    qualified: Number(row.qualified),
    finalists: Number(row.finalists),
    flagged: Number(row.flagged),
    disqualified: Number(row.disqualified),
    winners: Number(row.winners),
    pendingPayouts: Number(row.pending_payouts),
    completedPayouts: Number(row.completed_payouts),
  };
}

export interface AdminPayoutRow {
  id: string;
  userId: string;
  rank: number;
  finalScore: number;
  prizeAmountCents: number;
  verificationStatus: string;
  payoutStatus: string;
}

export async function fetchPayouts(challengeId: string): Promise<AdminPayoutRow[]> {
  const sb = await supabase();
  if (!sb) return [];
  const { data, error } = await sb
    .from('challenge_payouts')
    .select('*')
    .eq('challenge_id', challengeId)
    .order('rank');
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    rank: Number(r.rank),
    finalScore: Number(r.final_score),
    prizeAmountCents: Number(r.prize_amount_cents),
    verificationStatus: r.verification_status as string,
    payoutStatus: r.payout_status as string,
  }));
}

export async function markPayoutVerified(id: string): Promise<boolean> {
  const sb = await supabase();
  if (!sb) return false;
  const { error } = await sb.rpc('mark_payout_verified', { p_payout_id: id });
  return !error;
}

export async function markPayoutRejected(id: string, reason: string): Promise<boolean> {
  const sb = await supabase();
  if (!sb) return false;
  const { error } = await sb.rpc('mark_payout_rejected', { p_payout_id: id, p_reason: reason });
  return !error;
}

export async function markPayoutApproved(id: string): Promise<boolean> {
  const sb = await supabase();
  if (!sb) return false;
  const { error } = await sb.rpc('mark_payout_approved', { p_payout_id: id });
  return !error;
}

/** The only function that records real money having moved — and even this
 *  only records it. See the migration file's header for why. */
export async function markPayoutPaid(id: string, externalReference: string): Promise<boolean> {
  const sb = await supabase();
  if (!sb || !externalReference.trim()) return false;
  const { error } = await sb.rpc('mark_payout_paid', { p_payout_id: id, p_external_reference: externalReference });
  return !error;
}

export async function disqualifyParticipant(challengeId: string, userId: string, reason: string): Promise<boolean> {
  const sb = await supabase();
  if (!sb) return false;
  const { error } = await sb.rpc('admin_disqualify_participant', {
    p_challenge_id: challengeId,
    p_user: userId,
    p_reason: reason,
  });
  return !error;
}

export async function updateRegionSetting(country: string, enabled: boolean, minAge: number | null): Promise<boolean> {
  const sb = await supabase();
  if (!sb) return false;
  const { error } = await sb.rpc('update_region_setting', {
    p_country: country,
    p_enabled: enabled,
    p_min_age: minAge,
  });
  return !error;
}

// --- Coin economy config (0003_coin_economy.sql, 0005_coins_store_v2.sql) --

export interface AdminEconomyConfig {
  articleRewardCoins: number;
  articleRewardDailyLimit: number;
  articleMinReadSeconds: number;
  reviveCostCoins: number;
}

/** Reads straight off tartan.game_constants (already public-select, see
 *  0001_init.sql) rather than a dedicated RPC — there's nothing sensitive
 *  in these values, and the table is the single source of truth every RPC
 *  (spend_coins_for_revive, claim_article_reward, economy_status) already
 *  reads from directly. Watch Video's constants were removed entirely in
 *  0005 — there's nothing left here to read for it. */
export async function fetchEconomyConfig(): Promise<AdminEconomyConfig | null> {
  const sb = await supabase();
  if (!sb) return null;
  const { data, error } = await sb
    .from('game_constants')
    .select('key, value')
    .in('key', ['article_reward_coins', 'article_reward_daily_limit', 'article_min_read_seconds', 'revive_cost_coins']);
  if (error || !data) return null;
  const byKey = Object.fromEntries((data as { key: string; value: number }[]).map((r) => [r.key, Number(r.value)]));
  return {
    articleRewardCoins: byKey.article_reward_coins ?? 30,
    articleRewardDailyLimit: byKey.article_reward_daily_limit ?? 3,
    articleMinReadSeconds: byKey.article_min_read_seconds ?? 120,
    reviveCostCoins: byKey.revive_cost_coins ?? 100,
  };
}

export async function updateEconomyConfig(cfg: AdminEconomyConfig): Promise<boolean> {
  const sb = await supabase();
  if (!sb) return false;
  const { error } = await sb.rpc('admin_update_economy_config', {
    p_article_reward_coins: cfg.articleRewardCoins,
    p_article_reward_daily_limit: cfg.articleRewardDailyLimit,
    p_article_min_read_seconds: cfg.articleMinReadSeconds,
    p_revive_cost_coins: cfg.reviveCostCoins,
  });
  return !error;
}

// --- Articles (0005_coins_store_v2.sql) -------------------------------------

export interface AdminArticleRow {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

/** Staff sees every article, active or not (RLS: `active or is_staff()`);
 *  a non-staff caller would only ever see the active ones anyway. */
export async function fetchAllArticles(): Promise<AdminArticleRow[]> {
  const sb = await supabase();
  if (!sb) return [];
  const { data, error } = await sb.from('articles').select('*').order('created_at', { ascending: false });
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map((r) => ({
    id: r.id as string,
    title: r.title as string,
    url: r.url as string,
    active: Boolean(r.active),
  }));
}

/** Creates a new article when `id` is null, otherwise edits the existing
 *  one in place (title/url/active can all change together). */
export async function upsertArticle(
  id: string | null,
  title: string,
  url: string,
  active: boolean,
): Promise<boolean> {
  const sb = await supabase();
  if (!sb) return false;
  const { error } = await sb.rpc('admin_upsert_article', {
    p_id: id,
    p_title: title,
    p_url: url,
    p_active: active,
  });
  return !error;
}

export async function deleteArticle(id: string): Promise<boolean> {
  const sb = await supabase();
  if (!sb) return false;
  const { error } = await sb.rpc('admin_delete_article', { p_id: id });
  return !error;
}

// --- Coin Orders (WhatsApp purchases, 0005_coins_store_v2.sql) -------------

export interface AdminCoinOrderRow {
  id: string;
  userId: string;
  packageId: string;
  packageName: string;
  coins: number;
  priceBirr: number;
  platform: string;
  receiptToken: string;
  status: string;
  createdAt: string;
}

/** Every purchase_records row, newest first — staff sees every user's
 *  orders (RLS: `own row or staff`). Embeds coin_packages via its foreign
 *  key so the coins/package name show up without a second round trip. */
export async function fetchCoinOrders(status?: string): Promise<AdminCoinOrderRow[]> {
  const sb = await supabase();
  if (!sb) return [];
  let query = sb
    .from('purchase_records')
    .select('*, coin_packages(name, coins)')
    .order('created_at', { ascending: false })
    .limit(200);
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map((r) => {
    const pkg = (r.coin_packages ?? null) as { name?: string; coins?: number } | null;
    return {
      id: r.id as string,
      userId: r.user_id as string,
      packageId: r.package_id as string,
      packageName: pkg?.name ?? (r.package_id as string),
      coins: Number(pkg?.coins ?? 0),
      priceBirr: Number(r.price_birr),
      platform: r.platform as string,
      receiptToken: r.receipt_token as string,
      status: r.status as string,
      createdAt: r.created_at as string,
    };
  });
}

/** Credits the order's coins to its buyer and marks it `credited` — the
 *  only thing that ever actually grants coins for a purchase. Staff-gated
 *  server-side; confirms the payment was received outside this system
 *  before calling. */
export async function approveCoinOrder(purchaseId: string): Promise<boolean> {
  const sb = await supabase();
  if (!sb) return false;
  const { error } = await sb.rpc('admin_verify_and_credit_purchase', { p_purchase_id: purchaseId });
  return !error;
}

/** Closes out a bogus/duplicate/unpaid order without crediting anything. */
export async function rejectCoinOrder(purchaseId: string, reason: string): Promise<boolean> {
  const sb = await supabase();
  if (!sb) return false;
  const { error } = await sb.rpc('admin_reject_purchase', { p_purchase_id: purchaseId, p_reason: reason });
  return !error;
}
