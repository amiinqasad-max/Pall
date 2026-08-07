/**
 * The single source of truth for player state.
 *
 * Everything that survives a reload lives in one `SaveData` document held here.
 * Actions mutate it immutably, mark the cloud copy dirty, and schedule a
 * debounced write. The Phaser game never touches this directly — it reports a
 * finished run through `completeRun` and reads a frozen loadout at start.
 */

import { create } from 'zustand';
import {
  createSave,
  flushSave,
  loadSave,
  persistSave,
  wipeSave,
  type PlayerStats,
  type SaveData,
} from '@/systems/save';
import { validateRun } from '@/systems/integrity';
import { dailyChallenge, dailyMissions, rewardForStreakDay, weeklyMissions } from '@/data/missions';
import {
  ACHIEVEMENTS,
  ENVIRONMENTS,
  environmentsForLevel,
  levelFromXp,
  xpForRun,
  type AchievementStats,
  type LevelState,
} from '@/data/progression';
import { evaluateUnlock, getCosmetic } from '@/data/cosmetics';
import { dayKey, daysBetween, weekKey } from '@/core/time';
import { analytics } from '@/systems/analytics';
import type {
  CoinSource,
  Cosmetic,
  DailyChallenge,
  LedgerEntry,
  MissionDef,
  MissionProgress,
  RunResult,
  Settings,
} from '@/types';
import { LEDGER_LIMIT } from '@/systems/save';

/** What a finished run produced, for the game-over screen to animate. */
export interface RunSummary {
  result: RunResult;
  xpGained: number;
  newRecord: boolean;
  previousBest: number;
  levelsGained: number;
  level: number;
  missionsCompleted: MissionDef[];
  achievementsUnlocked: string[];
  challengeCompleted: boolean;
  rejected: string | null;
}

export interface PurchaseResult {
  ok: boolean;
  error?: 'owned' | 'needs_level' | 'needs_coins' | 'unknown';
}

interface StoreState {
  ready: boolean;
  save: SaveData;
  /** Set when the save signature failed to verify at boot. */
  tampered: boolean;
  lastSummary: RunSummary | null;
  /** Coins earned this session, purely for the wallet animation. */
  coinPulse: number;

  init(): Promise<void>;
  refreshPeriodic(): void;

  earnCoins(source: CoinSource, amount: number, detail?: string): void;
  purchase(cosmeticId: string): PurchaseResult;
  equip(cosmeticId: string): void;
  setEnvironment(id: string): void;

  addXp(amount: number, reason: string): { levelsGained: number; level: number };
  completeRun(result: RunResult): RunSummary;

  claimMission(missionId: string): boolean;
  claimDailyChallenge(): boolean;
  claimDailyReward(): { claimed: boolean; coins: number; xp: number; day: number };
  dailyRewardAvailable(): boolean;

  updateSettings(patch: Partial<Settings>): void;
  setUsername(name: string): void;
  setCountry(code: string | null): void;
  setOnboarded(): void;
  markSynced(userId: string | null): void;
  applyCloudSave(remote: SaveData): void;
  resetProgress(): Promise<void>;
}

function progressFor(defs: MissionDef[], existing: MissionProgress[]): MissionProgress[] {
  const byId = new Map(existing.map((p) => [p.id, p]));
  return defs.map((d) => byId.get(d.id) ?? { id: d.id, progress: 0, claimed: false });
}

function achievementStats(save: SaveData): AchievementStats {
  return {
    runs: save.stats.runs,
    bestScore: save.stats.bestScore,
    bestDistance: save.stats.bestDistance,
    totalDistance: save.stats.totalDistance,
    totalTimeMs: save.stats.totalTimeMs,
    totalPrisms: save.stats.totalPrisms,
    obstaclesDodged: save.stats.obstaclesDodged,
    nearMisses: save.stats.nearMisses,
    dailyChallengesCompleted: save.stats.dailyChallengesCompleted,
    longestStreak: save.rewards.longestStreak,
    missionsCompleted: save.stats.missionsCompleted,
  };
}

function ledgerEntry(amount: number, reason: LedgerEntry['reason'], balanceAfter: number, detail?: string): LedgerEntry {
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    amount,
    reason,
    detail,
    balanceAfter,
  };
}

/** Advances a mission's progress given what a run produced. */
function missionDelta(def: MissionDef, run: RunResult, ctx: { newRecord: boolean; challengeDone: boolean }): number {
  switch (def.kind) {
    case 'play_runs':
      return 1;
    case 'survive_seconds':
      // "in a single run" — track the best single run, not a sum.
      return run.durationMs / 1000;
    case 'single_run_distance':
      return run.distance;
    case 'total_distance':
      return run.distance;
    case 'dodge_obstacles':
      return run.obstaclesDodged;
    case 'collect_prisms':
      return run.prisms;
    case 'near_misses':
      return run.nearMisses;
    case 'complete_daily_challenge':
      return ctx.challengeDone ? 1 : 0;
    case 'beat_record':
      return ctx.newRecord ? 1 : 0;
    default:
      return 0;
  }
}

/** Missions phrased "in a single run" take a max rather than accumulating. */
function isBestOf(kind: MissionDef['kind']): boolean {
  return kind === 'survive_seconds' || kind === 'single_run_distance';
}

export const useStore = create<StoreState>((set, get) => ({
  ready: false,
  save: createSave('pending'),
  tampered: false,
  lastSummary: null,
  coinPulse: 0,

  async init() {
    const { save, tampered } = await loadSave();
    set({ save, tampered, ready: true });
    get().refreshPeriodic();
    if (tampered) analytics.track('save_signature_mismatch', {});
  },

  /**
   * Rolls daily and weekly content forward. Called at boot and whenever the app
   * returns to the foreground, so a session left open overnight still picks up
   * the new day's challenge.
   */
  refreshPeriodic() {
    const today = dayKey();
    const thisWeek = weekKey();
    const save = get().save;
    let changed = false;
    const next: SaveData = { ...save };

    if (save.missions.dailyKey !== today) {
      next.missions = {
        ...next.missions,
        dailyKey: today,
        daily: progressFor(dailyMissions(today), []),
      };
      changed = true;
    } else if (save.missions.daily.length === 0) {
      next.missions = { ...next.missions, daily: progressFor(dailyMissions(today), save.missions.daily) };
      changed = true;
    }

    if (save.missions.weeklyKey !== thisWeek) {
      next.missions = {
        ...next.missions,
        weeklyKey: thisWeek,
        weekly: progressFor(weeklyMissions(thisWeek), []),
      };
      changed = true;
    } else if (save.missions.weekly.length === 0) {
      next.missions = { ...next.missions, weekly: progressFor(weeklyMissions(thisWeek), save.missions.weekly) };
      changed = true;
    }

    if (save.daily.day !== today) {
      next.daily = { day: today, progress: 0, completed: false, claimed: false, bestScore: 0, attempts: 0 };
      changed = true;
    }

    // A missed day breaks the streak. The claim itself happens on demand.
    if (save.rewards.lastClaimDay && daysBetween(save.rewards.lastClaimDay, today) > 1 && save.rewards.streak > 0) {
      next.rewards = { ...next.rewards, streak: 0 };
      changed = true;
    }

    if (changed) {
      next.cloud = { ...next.cloud, dirty: true };
      set({ save: next });
      persistSave(next);
    }
  },

  // --- Economy ---------------------------------------------------------------

  /**
   * The only way coins enter the game. The `CoinSource` union is the contract:
   * rewarded ads, the daily challenge, and daily login rewards. Gameplay —
   * distance, score, prisms — never calls this, by design.
   */
  earnCoins(source, amount, detail) {
    const rounded = Math.max(0, Math.floor(amount));
    if (rounded === 0) return;
    const save = get().save;
    const coins = save.wallet.coins + rounded;
    const next: SaveData = {
      ...save,
      wallet: {
        coins,
        lifetimeEarned: save.wallet.lifetimeEarned + rounded,
        lifetimeSpent: save.wallet.lifetimeSpent,
      },
      ledger: [ledgerEntry(rounded, source, coins, detail), ...save.ledger].slice(0, LEDGER_LIMIT),
      cloud: { ...save.cloud, dirty: true },
    };
    set({ save: next, coinPulse: get().coinPulse + rounded });
    persistSave(next);
    analytics.track('coins_earned', { source, amount: rounded, balance: coins });
  },

  purchase(cosmeticId) {
    const save = get().save;
    const cosmetic = getCosmetic(cosmeticId);
    if (!cosmetic) return { ok: false, error: 'unknown' };
    if (save.unlocks.includes(cosmeticId)) return { ok: false, error: 'owned' };

    const level = levelFromXp(save.player.totalXp).level;
    const verdict = evaluateUnlock(cosmetic, { owned: false, coins: save.wallet.coins, level });
    if (verdict.reason === 'needs_level' || verdict.reason === 'needs_both') {
      return { ok: false, error: 'needs_level' };
    }
    if (verdict.reason === 'needs_coins') return { ok: false, error: 'needs_coins' };

    const coins = save.wallet.coins - verdict.cost;
    const next: SaveData = {
      ...save,
      wallet: {
        coins,
        lifetimeEarned: save.wallet.lifetimeEarned,
        lifetimeSpent: save.wallet.lifetimeSpent + verdict.cost,
      },
      unlocks: [...save.unlocks, cosmeticId],
      ledger:
        verdict.cost > 0
          ? [ledgerEntry(-verdict.cost, 'purchase', coins, cosmetic.name), ...save.ledger].slice(0, LEDGER_LIMIT)
          : save.ledger,
      cloud: { ...save.cloud, dirty: true },
    };
    set({ save: next });
    persistSave(next, true);
    analytics.track('cosmetic_purchased', { id: cosmeticId, cost: verdict.cost, balance: coins });
    return { ok: true };
  },

  equip(cosmeticId) {
    const save = get().save;
    const cosmetic = getCosmetic(cosmeticId);
    if (!cosmetic || !save.unlocks.includes(cosmeticId)) return;
    const slot: keyof SaveData['equipped'] = cosmetic.kind === 'skin' ? 'skin' : 'trail';
    if (save.equipped[slot] === cosmeticId) return;
    const next: SaveData = {
      ...save,
      equipped: { ...save.equipped, [slot]: cosmeticId },
      cloud: { ...save.cloud, dirty: true },
    };
    set({ save: next });
    persistSave(next);
    analytics.track('cosmetic_equipped', { id: cosmeticId, slot });
  },

  setEnvironment(id) {
    const save = get().save;
    const level = levelFromXp(save.player.totalXp).level;
    const allowed = environmentsForLevel(level).some((e) => e.id === id);
    if (!allowed || save.environment === id) return;
    const next: SaveData = { ...save, environment: id, cloud: { ...save.cloud, dirty: true } };
    set({ save: next });
    persistSave(next);
  },

  // --- Progression -----------------------------------------------------------

  addXp(amount, reason) {
    const rounded = Math.max(0, Math.floor(amount));
    const save = get().save;
    const before = levelFromXp(save.player.totalXp);
    const totalXp = save.player.totalXp + rounded;
    const after = levelFromXp(totalXp);
    const next: SaveData = {
      ...save,
      player: { ...save.player, totalXp },
      cloud: { ...save.cloud, dirty: true },
    };
    set({ save: next });
    persistSave(next);
    if (after.level > before.level) {
      analytics.track('level_up', { level: after.level, reason });
    }
    return { levelsGained: after.level - before.level, level: after.level };
  },

  completeRun(result) {
    const state = get();
    const save = state.save;
    const verdict = validateRun(result);

    if (!verdict.ok) {
      // The run still ends and the player still sees a score; it just does not
      // touch records, missions or XP. Everything gets reported for review.
      analytics.track('run_rejected', { reason: verdict.reason, score: result.score, distance: result.distance });
      const summary: RunSummary = {
        result,
        xpGained: 0,
        newRecord: false,
        previousBest: save.stats.bestScore,
        levelsGained: 0,
        level: levelFromXp(save.player.totalXp).level,
        missionsCompleted: [],
        achievementsUnlocked: [],
        challengeCompleted: false,
        rejected: verdict.reason,
      };
      set({ lastSummary: summary });
      return summary;
    }

    const previousBest = save.stats.bestScore;
    const newRecord = result.score > previousBest;

    const stats: PlayerStats = {
      ...save.stats,
      runs: save.stats.runs + 1,
      bestScore: Math.max(save.stats.bestScore, result.score),
      bestDistance: Math.max(save.stats.bestDistance, result.distance),
      bestTimeMs: Math.max(save.stats.bestTimeMs, result.durationMs),
      totalDistance: save.stats.totalDistance + result.distance,
      totalTimeMs: save.stats.totalTimeMs + result.durationMs,
      totalPrisms: save.stats.totalPrisms + result.prisms,
      obstaclesDodged: save.stats.obstaclesDodged + result.obstaclesDodged,
      nearMisses: save.stats.nearMisses + result.nearMisses,
      continuesUsed: save.stats.continuesUsed + (result.continued ? 1 : 0),
    };

    // --- Daily challenge ------------------------------------------------------
    const challenge = dailyChallenge(save.daily.day);
    let daily = { ...save.daily, attempts: save.daily.attempts + (result.daily ? 1 : 0) };
    let challengeCompleted = false;
    if (result.daily && !daily.completed) {
      const value = challengeProgressValue(challenge, result);
      const progress = Math.max(daily.progress, value);
      const completed = progress >= challenge.target;
      daily = {
        ...daily,
        progress,
        completed,
        bestScore: Math.max(daily.bestScore, result.score),
      };
      if (completed) {
        challengeCompleted = true;
        stats.dailyChallengesCompleted = save.stats.dailyChallengesCompleted + 1;
        analytics.track('daily_challenge_completed', { day: challenge.day, kind: challenge.kind });
      }
    } else if (result.daily) {
      daily = { ...daily, bestScore: Math.max(daily.bestScore, result.score) };
    }

    // --- Missions -------------------------------------------------------------
    const dailyDefs = dailyMissions(save.missions.dailyKey);
    const weeklyDefs = weeklyMissions(save.missions.weeklyKey);
    const completedNow: MissionDef[] = [];
    const ctx = { newRecord, challengeDone: challengeCompleted };

    const advance = (defs: MissionDef[], progressList: MissionProgress[]): MissionProgress[] =>
      progressList.map((p) => {
        const def = defs.find((d) => d.id === p.id);
        if (!def || p.progress >= def.target) return p;
        const delta = missionDelta(def, result, ctx);
        if (delta <= 0) return p;
        const progress = isBestOf(def.kind) ? Math.max(p.progress, delta) : p.progress + delta;
        const done = progress >= def.target;
        if (done && p.progress < def.target) completedNow.push(def);
        return { ...p, progress, completedAt: done ? Date.now() : p.completedAt };
      });

    const missions = {
      ...save.missions,
      daily: advance(dailyDefs, save.missions.daily),
      weekly: advance(weeklyDefs, save.missions.weekly),
    };

    // --- XP -------------------------------------------------------------------
    const xpGained = xpForRun({
      distance: result.distance,
      durationMs: result.durationMs,
      prisms: result.prisms,
      nearMisses: result.nearMisses,
      newRecord,
    });

    const beforeLevel = levelFromXp(save.player.totalXp);
    const totalXp = save.player.totalXp + xpGained;

    // --- Achievements ---------------------------------------------------------
    const achievements = { ...save.achievements };
    const unlocked: string[] = [];
    const probe = achievementStats({ ...save, stats });
    let achievementXp = 0;
    for (const a of ACHIEVEMENTS) {
      if (achievements[a.id]) continue;
      if (probe[a.stat] >= a.target) {
        achievements[a.id] = Date.now();
        unlocked.push(a.id);
        achievementXp += a.xp;
      }
    }

    const finalXp = totalXp + achievementXp;
    const finalLevel = levelFromXp(finalXp);

    const next: SaveData = {
      ...save,
      player: { ...save.player, totalXp: finalXp },
      stats,
      daily,
      missions,
      achievements,
      cloud: { ...save.cloud, dirty: true },
    };

    set({ save: next });
    persistSave(next, true);

    analytics.track('run_completed', {
      score: result.score,
      distance: Math.round(result.distance),
      durationMs: result.durationMs,
      stage: result.stage,
      prisms: result.prisms,
      nearMisses: result.nearMisses,
      daily: result.daily,
      newRecord,
      continued: result.continued,
      level: finalLevel.level,
    });
    for (const id of unlocked) analytics.track('achievement_unlocked', { id });

    const summary: RunSummary = {
      result,
      xpGained: xpGained + achievementXp,
      newRecord,
      previousBest,
      levelsGained: finalLevel.level - beforeLevel.level,
      level: finalLevel.level,
      missionsCompleted: completedNow,
      achievementsUnlocked: unlocked,
      challengeCompleted,
      rejected: null,
    };
    set({ lastSummary: summary });
    return summary;
  },

  // --- Claims ----------------------------------------------------------------

  claimMission(missionId) {
    const save = get().save;
    const defs = [...dailyMissions(save.missions.dailyKey), ...weeklyMissions(save.missions.weeklyKey)];
    const def = defs.find((d) => d.id === missionId);
    if (!def) return false;

    const bucket: 'daily' | 'weekly' = def.period;
    const list = save.missions[bucket];
    const entry = list.find((p) => p.id === missionId);
    if (!entry || entry.claimed || entry.progress < def.target) return false;

    const updated = list.map((p) => (p.id === missionId ? { ...p, claimed: true } : p));
    const next: SaveData = {
      ...save,
      missions: { ...save.missions, [bucket]: updated },
      player: { ...save.player, totalXp: save.player.totalXp + def.xp },
      stats: { ...save.stats, missionsCompleted: save.stats.missionsCompleted + 1 },
      cloud: { ...save.cloud, dirty: true },
    };
    set({ save: next });
    persistSave(next, true);
    analytics.track('mission_claimed', { id: missionId, kind: def.kind, xp: def.xp, period: def.period });
    return true;
  },

  /** Daily challenge is one of the three legitimate coin faucets. */
  claimDailyChallenge() {
    const save = get().save;
    if (!save.daily.completed || save.daily.claimed) return false;
    const challenge = dailyChallenge(save.daily.day);

    const coins = save.wallet.coins + challenge.coinReward;
    const next: SaveData = {
      ...save,
      daily: { ...save.daily, claimed: true },
      wallet: {
        coins,
        lifetimeEarned: save.wallet.lifetimeEarned + challenge.coinReward,
        lifetimeSpent: save.wallet.lifetimeSpent,
      },
      ledger: [ledgerEntry(challenge.coinReward, 'daily_challenge', coins, challenge.title), ...save.ledger].slice(
        0,
        LEDGER_LIMIT,
      ),
      player: { ...save.player, totalXp: save.player.totalXp + challenge.xpReward },
      cloud: { ...save.cloud, dirty: true },
    };
    set({ save: next, coinPulse: get().coinPulse + challenge.coinReward });
    persistSave(next, true);
    analytics.track('daily_challenge_claimed', { day: challenge.day, coins: challenge.coinReward });
    return true;
  },

  dailyRewardAvailable() {
    return get().save.rewards.lastClaimDay !== dayKey();
  },

  /** Daily login reward — the second legitimate coin faucet. */
  claimDailyReward() {
    const save = get().save;
    const today = dayKey();
    if (save.rewards.lastClaimDay === today) {
      return { claimed: false, coins: 0, xp: 0, day: save.rewards.streak };
    }

    const continues = save.rewards.lastClaimDay ? daysBetween(save.rewards.lastClaimDay, today) === 1 : false;
    const streak = continues ? save.rewards.streak + 1 : 1;
    const reward = rewardForStreakDay(streak);

    const coins = save.wallet.coins + reward.coins;
    const longestStreak = Math.max(save.rewards.longestStreak, streak);
    const next: SaveData = {
      ...save,
      rewards: {
        lastClaimDay: today,
        streak,
        longestStreak,
        totalClaims: save.rewards.totalClaims + 1,
      },
      wallet: {
        coins,
        lifetimeEarned: save.wallet.lifetimeEarned + reward.coins,
        lifetimeSpent: save.wallet.lifetimeSpent,
      },
      ledger: [ledgerEntry(reward.coins, 'daily_reward', coins, `Day ${streak}`), ...save.ledger].slice(
        0,
        LEDGER_LIMIT,
      ),
      player: { ...save.player, totalXp: save.player.totalXp + reward.xp },
      stats: { ...save.stats, longestStreak },
      cloud: { ...save.cloud, dirty: true },
    };
    set({ save: next, coinPulse: get().coinPulse + reward.coins });
    persistSave(next, true);
    analytics.track('daily_reward_claimed', { streak, coins: reward.coins });
    return { claimed: true, coins: reward.coins, xp: reward.xp, day: streak };
  },

  // --- Settings & account ----------------------------------------------------

  updateSettings(patch) {
    const save = get().save;
    const next: SaveData = {
      ...save,
      settings: { ...save.settings, ...patch },
      cloud: { ...save.cloud, dirty: true },
    };
    set({ save: next });
    persistSave(next);
  },

  setUsername(name) {
    const clean = name.trim().slice(0, 18).replace(/\s+/g, ' ');
    if (!clean) return;
    const save = get().save;
    const next: SaveData = {
      ...save,
      player: { ...save.player, username: clean },
      cloud: { ...save.cloud, dirty: true },
    };
    set({ save: next });
    persistSave(next, true);
  },

  setCountry(code) {
    const save = get().save;
    if (save.player.country === code) return;
    const next: SaveData = { ...save, player: { ...save.player, country: code }, cloud: { ...save.cloud, dirty: true } };
    set({ save: next });
    persistSave(next);
  },

  setOnboarded() {
    const save = get().save;
    if (save.player.onboarded) return;
    const next: SaveData = { ...save, player: { ...save.player, onboarded: true } };
    set({ save: next });
    persistSave(next);
  },

  markSynced(userId) {
    const save = get().save;
    const next: SaveData = {
      ...save,
      cloud: { userId: userId ?? save.cloud.userId, lastSyncAt: Date.now(), dirty: false },
    };
    set({ save: next });
    persistSave(next);
  },

  /**
   * Merges a cloud save into the local one. Conflicts resolve per-field toward
   * the better outcome rather than "latest wins", because a player who plays
   * offline on a plane and then opens the app on a second device should never
   * lose the run they just made.
   */
  applyCloudSave(remote) {
    const local = get().save;
    const merged: SaveData = {
      ...local,
      player: {
        ...local.player,
        totalXp: Math.max(local.player.totalXp, remote.player?.totalXp ?? 0),
        username: remote.updatedAt > local.updatedAt ? remote.player?.username ?? local.player.username : local.player.username,
        country: local.player.country ?? remote.player?.country ?? null,
      },
      wallet: {
        // Coins are the one field where the server is authoritative: taking a
        // max here would let a player fork their wallet across two devices.
        coins: remote.wallet?.coins ?? local.wallet.coins,
        lifetimeEarned: Math.max(local.wallet.lifetimeEarned, remote.wallet?.lifetimeEarned ?? 0),
        lifetimeSpent: Math.max(local.wallet.lifetimeSpent, remote.wallet?.lifetimeSpent ?? 0),
      },
      unlocks: Array.from(new Set([...local.unlocks, ...(remote.unlocks ?? [])])),
      stats: mergeStats(local.stats, remote.stats),
      achievements: { ...(remote.achievements ?? {}), ...local.achievements },
      rewards: {
        lastClaimDay:
          (remote.rewards?.lastClaimDay ?? '') > (local.rewards.lastClaimDay ?? '')
            ? remote.rewards.lastClaimDay
            : local.rewards.lastClaimDay,
        streak: Math.max(local.rewards.streak, remote.rewards?.streak ?? 0),
        longestStreak: Math.max(local.rewards.longestStreak, remote.rewards?.longestStreak ?? 0),
        totalClaims: Math.max(local.rewards.totalClaims, remote.rewards?.totalClaims ?? 0),
      },
      cloud: { userId: remote.cloud?.userId ?? local.cloud.userId, lastSyncAt: Date.now(), dirty: false },
    };
    set({ save: merged });
    persistSave(merged, true);
  },

  async resetProgress() {
    await wipeSave();
    const { save } = await loadSave();
    set({ save, lastSummary: null, tampered: false });
    analytics.track('progress_reset', {});
  },
}));

function mergeStats(a: PlayerStats, b?: PlayerStats): PlayerStats {
  if (!b) return a;
  const max = (k: keyof PlayerStats) => Math.max(a[k], b[k] ?? 0);
  return {
    runs: max('runs'),
    bestScore: max('bestScore'),
    bestDistance: max('bestDistance'),
    bestTimeMs: max('bestTimeMs'),
    totalDistance: max('totalDistance'),
    totalTimeMs: max('totalTimeMs'),
    totalPrisms: max('totalPrisms'),
    obstaclesDodged: max('obstaclesDodged'),
    nearMisses: max('nearMisses'),
    dailyChallengesCompleted: max('dailyChallengesCompleted'),
    missionsCompleted: max('missionsCompleted'),
    longestStreak: max('longestStreak'),
    adsWatched: max('adsWatched'),
    continuesUsed: max('continuesUsed'),
  };
}

/** Maps a run onto whatever the day's challenge happens to measure. */
export function challengeProgressValue(challenge: DailyChallenge, run: RunResult): number {
  switch (challenge.kind) {
    case 'survive_seconds':
      return run.durationMs / 1000;
    case 'reach_distance':
      return run.distance;
    case 'dodge_obstacles':
      return run.obstaclesDodged;
    case 'collect_prisms':
      return run.prisms;
    default:
      return 0;
  }
}

// --- Selectors ----------------------------------------------------------------

export const selectLevel = (s: StoreState): LevelState => levelFromXp(s.save.player.totalXp);
export const selectCoins = (s: StoreState): number => s.save.wallet.coins;
export const selectOwned = (s: StoreState): string[] => s.save.unlocks;

export function useLevel(): LevelState {
  return useStore((s) => levelFromXp(s.save.player.totalXp));
}

export function useCoins(): number {
  return useStore((s) => s.save.wallet.coins);
}

export function useSettings(): Settings {
  return useStore((s) => s.save.settings);
}

/** Mission definitions paired with the player's progress, ready to render. */
export function useMissions(period: 'daily' | 'weekly'): { def: MissionDef; progress: MissionProgress }[] {
  return useStore((s) => {
    const defs = period === 'daily' ? dailyMissions(s.save.missions.dailyKey) : weeklyMissions(s.save.missions.weeklyKey);
    const list = s.save.missions[period];
    return defs.map((def) => ({
      def,
      progress: list.find((p) => p.id === def.id) ?? { id: def.id, progress: 0, claimed: false },
    }));
  });
}

export function useUnlockedEnvironments() {
  return useStore((s) => environmentsForLevel(levelFromXp(s.save.player.totalXp).level));
}

export function isOwned(save: SaveData, cosmetic: Cosmetic): boolean {
  return save.unlocks.includes(cosmetic.id);
}

export { ENVIRONMENTS };

/** Flush pending writes when the tab is hidden or closed. */
if (typeof document !== 'undefined') {
  const flush = () => void flushSave();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  window.addEventListener('pagehide', flush);
}
