/**
 * Championship state.
 *
 * Deliberately separate from `state/store.ts` (`SaveData`), the same way
 * `services/championship.ts` is kept separate from `services/leaderboard.ts`:
 * this is server-authoritative, network-backed state, never written locally
 * and trusted back. Merging it into the local save would reintroduce exactly
 * the "client claims a score" trust problem the submission RPCs exist to
 * avoid — nothing here is ever read as truth without a server round trip.
 */

import { create } from 'zustand';
import {
  fetchChampionshipLeaderboard,
  fetchMyParticipant,
  fetchQualifiedCount,
  fetchTodaysChallenge,
  regionCashPrizeEnabled,
  submitFinalRun,
  submitQualificationRun,
} from '@/services/championship';
import { hashString } from '@/core/rng';
import type {
  ChampionshipChallenge,
  ChampionshipLeaderboardEntry,
  ChampionshipParticipant,
  RunResult,
} from '@/types';

/**
 * A coarse, privacy-conscious device signal — the same ethos as
 * `systems/analytics.ts`'s own "no advertising identifiers" stance. This is
 * hashed once per boot and used only for duplicate-account clustering in the
 * anti-cheat pass server-side; it identifies a *class* of device, not a person.
 */
function deviceFingerprint(): string {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const parts = [
    screen.width,
    screen.height,
    window.devicePixelRatio || 1,
    new Date().getTimezoneOffset(),
    navigator.hardwareConcurrency ?? 0,
    nav.deviceMemory ?? 0,
    navigator.language,
  ].join(':');
  return hashString(parts).toString(16);
}

/** One id per app boot, per the anti-cheat design — not per challenge, not
 *  persisted, so it cannot be reused to fingerprint a returning player. */
const SESSION_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

interface ChampionshipState {
  challenge: ChampionshipChallenge | null;
  participant: ChampionshipParticipant | null;
  leaderboard: ChampionshipLeaderboardEntry[];
  selfRank: number | null;
  qualifiedCount: number;
  /** Fail-closed until a region is checked and found allow-listed. */
  cashPrizeEnabled: boolean;
  loading: boolean;
  ready: boolean;

  init(country: string | null): Promise<void>;
  refreshParticipant(): Promise<void>;
  refreshLeaderboard(): Promise<void>;
  reportQualificationRun(run: RunResult): Promise<string>;
  reportFinalRun(run: RunResult): Promise<string>;
}

export const useChampionship = create<ChampionshipState>((set, get) => ({
  challenge: null,
  participant: null,
  leaderboard: [],
  selfRank: null,
  qualifiedCount: 0,
  cashPrizeEnabled: false,
  loading: false,
  ready: false,

  async init(country) {
    set({ loading: true });
    const [challenge, cashPrizeEnabled] = await Promise.all([
      fetchTodaysChallenge(),
      regionCashPrizeEnabled(country),
    ]);
    set({ challenge, cashPrizeEnabled, loading: false, ready: true });
    if (challenge) {
      const [, qualifiedCount] = await Promise.all([
        get().refreshParticipant(),
        fetchQualifiedCount(challenge.id),
      ]);
      set({ qualifiedCount });
    }
  },

  async refreshParticipant() {
    const challenge = get().challenge;
    if (!challenge) return;
    const participant = await fetchMyParticipant(challenge.id);
    set({ participant });
  },

  async refreshLeaderboard() {
    const challenge = get().challenge;
    if (!challenge) return;
    const page = await fetchChampionshipLeaderboard(challenge.id);
    set({ leaderboard: page.entries, selfRank: page.selfRank });
  },

  async reportQualificationRun(run) {
    const challenge = get().challenge;
    if (!challenge) return 'no_challenge';
    const result = await submitQualificationRun(challenge.id, run, SESSION_ID, deviceFingerprint());
    await get().refreshParticipant();
    if (result === 'qualified') {
      set({ qualifiedCount: await fetchQualifiedCount(challenge.id) });
    }
    return result;
  },

  async reportFinalRun(run) {
    const challenge = get().challenge;
    if (!challenge) return 'no_challenge';
    const result = await submitFinalRun(challenge.id, run, SESSION_ID);
    await Promise.all([get().refreshParticipant(), get().refreshLeaderboard()]);
    return result;
  },
}));

/** Stable for the lifetime of this tab; exposed for the coin-priced revive
 *  RPC, which logs against the same run/session identity as everything else. */
export function championshipSessionId(): string {
  return SESSION_ID;
}
