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
  };
}

export async function updateChallengeConfig(cfg: AdminChallengeConfig): Promise<boolean> {
  const sb = await supabase();
  if (!sb) return false;
  // The default_prize_distribution jsonb template isn't editable from this
  // minimal screen — it keeps whatever shape the migration seeded. A future,
  // fuller dashboard is the right place for a real distribution editor.
  const current = await sb.from('daily_challenge_configs').select('default_prize_distribution').eq('id', 1).maybeSingle();
  const { error } = await sb.rpc('update_challenge_config', {
    p_reference_percentile: cfg.referencePercentile,
    p_qualification_multiplier: cfg.qualificationMultiplier,
    p_minimum_target: cfg.minimumTarget,
    p_maximum_target: cfg.maximumTarget,
    p_fallback_target: cfg.fallbackTarget,
    p_minimum_sample_size: cfg.minimumSampleSize,
    p_default_prize_pool_usd_cents: cfg.defaultPrizePoolCents,
    p_default_winner_count: cfg.defaultWinnerCount,
    p_default_prize_distribution: current.data?.default_prize_distribution ?? [],
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
