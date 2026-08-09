/**
 * Coin economy: Read Article earning.
 *
 * Mirrors `services/championship.ts`'s shape deliberately — same session
 * bootstrap, same "no backend configured"/"offline" fallbacks, same
 * attempt-now-tell-the-player-if-it-failed submission style (no offline
 * queue: a claim consumes a finite, countable daily allowance, so queuing
 * one for later replay risks double-counting exactly the way a Championship
 * submission would).
 *
 * Every credit here goes through supabase/migrations/0003_coin_economy.sql /
 * 0005_coins_store_v2.sql's RPCs — the client never writes profiles.coins or
 * coin_transactions directly, and never decides on its own that a reward was
 * earned. Watch Video was removed entirely in 0005 — there is no client-side
 * trace of it left either.
 */

import { ensureSession, isOnline, supabase } from '@/services/supabase';
import { analytics } from '@/systems/analytics';
import type { Article, CoinHistoryEntry, CoinRewardClaimResult, EconomyStatus } from '@/types';

/**
 * Mirrors `game_constants.article_min_read_seconds` (set in
 * supabase/migrations/0003_coin_economy.sql) — used only to drive the
 * client's own countdown UI in ArticleReaderSheet. The server re-checks
 * elapsed time against its own clock at claim time regardless of what this
 * constant says, so a stale value here only affects UX pacing, never how
 * many coins can actually be earned. Keep the two in step.
 */
export const ARTICLE_MIN_READ_SECONDS = 120;

function mapStatus(row: Record<string, unknown>): EconomyStatus {
  return {
    coins: Number(row.coins),
    articleRewardCoins: Number(row.article_reward_coins),
    articleRewardDailyLimit: Number(row.article_reward_daily_limit),
    articleClaimsToday: Number(row.article_claims_today),
    reviveCostCoins: Number(row.revive_cost_coins),
  };
}

/** Balance + the Read Article reward amount and today's progress, in one
 *  round trip — null when signed out, offline, or the backend isn't
 *  configured. */
export async function fetchEconomyStatus(): Promise<EconomyStatus | null> {
  const sb = await supabase();
  const session = await ensureSession();
  if (!sb || !session || !isOnline()) return null;
  try {
    const { data, error } = await sb.rpc('economy_status');
    if (error || !data) return null;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;
    return mapStatus(row as Record<string, unknown>);
  } catch (err) {
    analytics.track('economy_status_fetch_failed', { message: String(err) });
    return null;
  }
}

export async function fetchCoinHistory(limit = 50): Promise<CoinHistoryEntry[]> {
  const sb = await supabase();
  const session = await ensureSession();
  if (!sb || !session || !isOnline()) return [];
  try {
    const { data, error } = await sb.rpc('coin_history', { p_limit: limit });
    if (error || !data) return [];
    return (data as Record<string, unknown>[]).map((row) => ({
      amount: Number(row.amount),
      reason: row.reason as string,
      detail: (row.detail as string | null) ?? null,
      balanceAfter: Number(row.balance_after),
      createdAt: row.created_at as string,
    }));
  } catch (err) {
    analytics.track('economy_history_fetch_failed', { message: String(err) });
    return [];
  }
}

/** Every currently-active, admin-managed article link (tartan.articles).
 *  The client picks one at random and opens its URL — there is no in-app
 *  article content anymore. Empty (not null) when none are configured, so
 *  the UI can distinguish "no articles yet" from "couldn't reach server". */
export async function fetchActiveArticles(): Promise<Article[]> {
  const sb = await supabase();
  if (!sb || !isOnline()) return [];
  try {
    const { data, error } = await sb.from('articles').select('*').eq('active', true).order('created_at');
    if (error || !data) return [];
    return (data as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      title: row.title as string,
      url: row.url as string,
      active: Boolean(row.active),
    }));
  } catch {
    return [];
  }
}

/** Starts a timed article-read session for a given article id — the server
 *  timestamps `started_at` itself, so the elapsed time checked at claim time
 *  can't be shortened by a manipulated client clock, and rejects any id that
 *  isn't a real, currently-active admin-managed article. */
export async function startArticleSession(articleId: string): Promise<string | null> {
  const sb = await supabase();
  const session = await ensureSession();
  if (!sb || !session || !isOnline()) return null;
  try {
    const { data, error } = await sb.rpc('start_article_session', { p_article_id: articleId });
    if (error) {
      analytics.track('article_reward_session_failed', { message: error.message });
      return null;
    }
    return (data as string) ?? null;
  } catch (err) {
    analytics.track('article_reward_session_failed', { message: String(err) });
    return null;
  }
}

export async function claimArticleReward(sessionId: string): Promise<CoinRewardClaimResult> {
  const sb = await supabase();
  if (!sb || !isOnline()) return 'offline';
  const session = await ensureSession();
  if (!session) return 'not_signed_in';
  try {
    const { data, error } = await sb.rpc('claim_article_reward', { p_session_id: sessionId });
    if (error) {
      analytics.track('article_reward_claim_failed', { message: error.message });
      return 'offline';
    }
    analytics.track('article_reward_claimed', { result: data });
    return (data as CoinRewardClaimResult) ?? 'not_found';
  } catch (err) {
    analytics.track('article_reward_claim_failed', { message: String(err) });
    return 'offline';
  }
}
