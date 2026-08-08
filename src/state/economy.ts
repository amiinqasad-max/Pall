/**
 * Coin economy state — server-authoritative, mirrors `state/championship.ts`
 * deliberately: nothing here is ever written locally and trusted back;
 * every claim re-fetches the real balance from the server afterward rather
 * than optimistically incrementing it.
 */

import { create } from 'zustand';
import {
  claimArticleReward,
  claimVideoReward,
  fetchCoinHistory,
  fetchEconomyStatus,
  startArticleSession,
  startVideoAdSession,
} from '@/services/coinEconomy';
import { useStore } from '@/state/store';
import type { CoinHistoryEntry, CoinRewardClaimResult, EconomyStatus } from '@/types';

interface EconomyState {
  status: EconomyStatus | null;
  history: CoinHistoryEntry[];
  loading: boolean;
  ready: boolean;

  refresh(): Promise<void>;
  startVideo(): Promise<string | null>;
  claimVideo(sessionId: string): Promise<CoinRewardClaimResult>;
  startArticle(articleId: string): Promise<string | null>;
  claimArticle(sessionId: string): Promise<CoinRewardClaimResult>;
  loadHistory(): Promise<void>;
}

export const useEconomy = create<EconomyState>((set, get) => ({
  status: null,
  history: [],
  loading: false,
  ready: false,

  async refresh() {
    set({ loading: true });
    const status = await fetchEconomyStatus();
    set({ status, loading: false, ready: true });
    if (status) useStore.getState().applyServerCoinBalance(status.coins);
  },

  async startVideo() {
    return startVideoAdSession();
  },

  /** Only call this once the ad provider has actually confirmed the
   *  rewarded video completed — never merely because it started. */
  async claimVideo(sessionId) {
    const result = await claimVideoReward(sessionId);
    if (result === 'credited') await get().refresh();
    return result;
  },

  async startArticle(articleId) {
    return startArticleSession(articleId);
  },

  async claimArticle(sessionId) {
    const result = await claimArticleReward(sessionId);
    if (result === 'credited') await get().refresh();
    return result;
  },

  async loadHistory() {
    const history = await fetchCoinHistory(50);
    set({ history });
  },
}));
