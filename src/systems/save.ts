/**
 * The save file: schema, defaults, migrations, and signed persistence.
 *
 * One document holds everything. It is small (a few KB), written debounced,
 * and signed so tampering is detectable. Migrations run forward only and are
 * additive — a save from v1 must still open in v9.
 */

import { storage } from '@/systems/storage';
import { sign, verify } from '@/systems/integrity';
import { DEFAULT_SKIN, DEFAULT_TRAIL, defaultUnlocks } from '@/data/cosmetics';
import { dayKey, weekKey } from '@/core/time';
import type { LedgerEntry, MissionProgress, Settings } from '@/types';

export const SAVE_VERSION = 1;
const SAVE_KEY = 'save';
const SIG_KEY = 'save.sig';
const INSTALL_KEY = 'install.id';

export interface PlayerStats {
  runs: number;
  bestScore: number;
  bestDistance: number;
  bestTimeMs: number;
  totalDistance: number;
  totalTimeMs: number;
  totalPrisms: number;
  obstaclesDodged: number;
  nearMisses: number;
  dailyChallengesCompleted: number;
  missionsCompleted: number;
  longestStreak: number;
  adsWatched: number;
  continuesUsed: number;
}

export interface SaveData {
  version: number;
  installId: string;
  createdAt: number;
  updatedAt: number;

  player: {
    username: string;
    totalXp: number;
    country: string | null;
    /** Set once the player has been through the first-run flow. */
    onboarded: boolean;
  };

  wallet: {
    coins: number;
    lifetimeEarned: number;
    lifetimeSpent: number;
  };

  /** Most recent first, capped so the save never grows without bound. */
  ledger: LedgerEntry[];

  unlocks: string[];
  equipped: { skin: string; trail: string };
  environment: string;

  stats: PlayerStats;

  missions: {
    dailyKey: string;
    daily: MissionProgress[];
    weeklyKey: string;
    weekly: MissionProgress[];
  };

  daily: {
    /** Day key the challenge state below belongs to. */
    day: string;
    progress: number;
    completed: boolean;
    claimed: boolean;
    bestScore: number;
    attempts: number;
  };

  rewards: {
    lastClaimDay: string | null;
    streak: number;
    /** Highest streak ever reached; feeds an achievement. */
    longestStreak: number;
    totalClaims: number;
  };

  /** Achievement id -> unlock timestamp. */
  achievements: Record<string, number>;

  settings: Settings;

  cloud: {
    userId: string | null;
    lastSyncAt: number;
    /** Local changes not yet pushed. */
    dirty: boolean;
  };
}

export const LEDGER_LIMIT = 60;

export const DEFAULT_SETTINGS: Settings = {
  musicVolume: 0.55,
  sfxVolume: 0.85,
  muted: false,
  haptics: true,
  quality: 'auto',
  showFps: false,
  leftHanded: false,
  reducedMotion: false,
  analytics: true,
};

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Anonymous but stable and human-friendly, e.g. "Runner-7Q4K". */
export function generateUsername(): string {
  const alphabet = 'ACDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `Runner-${suffix}`;
}

export function emptyStats(): PlayerStats {
  return {
    runs: 0,
    bestScore: 0,
    bestDistance: 0,
    bestTimeMs: 0,
    totalDistance: 0,
    totalTimeMs: 0,
    totalPrisms: 0,
    obstaclesDodged: 0,
    nearMisses: 0,
    dailyChallengesCompleted: 0,
    missionsCompleted: 0,
    longestStreak: 0,
    adsWatched: 0,
    continuesUsed: 0,
  };
}

export function createSave(installId: string): SaveData {
  const now = Date.now();
  return {
    version: SAVE_VERSION,
    installId,
    createdAt: now,
    updatedAt: now,
    player: {
      username: generateUsername(),
      totalXp: 0,
      country: null,
      onboarded: false,
    },
    wallet: { coins: 0, lifetimeEarned: 0, lifetimeSpent: 0 },
    ledger: [],
    unlocks: defaultUnlocks(),
    equipped: { skin: DEFAULT_SKIN, trail: DEFAULT_TRAIL },
    environment: 'env.harbour',
    stats: emptyStats(),
    missions: { dailyKey: dayKey(), daily: [], weeklyKey: weekKey(), weekly: [] },
    daily: { day: dayKey(), progress: 0, completed: false, claimed: false, bestScore: 0, attempts: 0 },
    rewards: { lastClaimDay: null, streak: 0, longestStreak: 0, totalClaims: 0 },
    achievements: {},
    settings: { ...DEFAULT_SETTINGS },
    cloud: { userId: null, lastSyncAt: 0, dirty: false },
  };
}

/**
 * Forward-only migrations. Each step upgrades one version; a save is run
 * through every step above its own version, in order.
 */
const MIGRATIONS: Record<number, (save: SaveData) => SaveData> = {
  // v1 is the initial schema. Future example:
  // 2: (save) => ({ ...save, someNewField: defaultValue }),
};

function migrate(raw: SaveData): SaveData {
  let save = raw;
  for (let v = save.version + 1; v <= SAVE_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (step) save = step(save);
    save.version = v;
  }
  return save;
}

/**
 * Fills in anything a hand-edited or partially-written save is missing, so a
 * corrupt field degrades to its default instead of throwing at read time.
 */
function reconcile(save: SaveData, installId: string): SaveData {
  const base = createSave(installId);
  const merged: SaveData = {
    ...base,
    ...save,
    installId,
    player: { ...base.player, ...save.player },
    wallet: { ...base.wallet, ...save.wallet },
    equipped: { ...base.equipped, ...save.equipped },
    stats: { ...base.stats, ...save.stats },
    missions: { ...base.missions, ...save.missions },
    daily: { ...base.daily, ...save.daily },
    rewards: { ...base.rewards, ...save.rewards },
    settings: { ...base.settings, ...save.settings },
    cloud: { ...base.cloud, ...save.cloud },
    achievements: save.achievements ?? {},
    ledger: Array.isArray(save.ledger) ? save.ledger.slice(0, LEDGER_LIMIT) : [],
    unlocks: Array.isArray(save.unlocks) ? save.unlocks : base.unlocks,
  };

  // Defaults are always owned, even if an old save predates a cosmetic.
  for (const id of defaultUnlocks()) {
    if (!merged.unlocks.includes(id)) merged.unlocks.push(id);
  }
  // Never leave the player equipped with something they do not own.
  if (!merged.unlocks.includes(merged.equipped.skin)) merged.equipped.skin = DEFAULT_SKIN;
  if (!merged.unlocks.includes(merged.equipped.trail)) merged.equipped.trail = DEFAULT_TRAIL;

  merged.wallet.coins = Math.max(0, Math.floor(merged.wallet.coins) || 0);
  merged.player.totalXp = Math.max(0, Math.floor(merged.player.totalXp) || 0);

  return merged;
}

async function installId(): Promise<string> {
  let id = await storage.get<string>(INSTALL_KEY);
  if (!id) {
    id = randomId();
    await storage.set(INSTALL_KEY, id);
  }
  return id;
}

export interface LoadResult {
  save: SaveData;
  /** True when the signature did not match — surfaced to analytics, not the user. */
  tampered: boolean;
  fresh: boolean;
}

export async function loadSave(): Promise<LoadResult> {
  const id = await installId();
  const raw = await storage.get<SaveData>(SAVE_KEY);
  if (!raw || typeof raw !== 'object') {
    return { save: createSave(id), tampered: false, fresh: true };
  }

  const signature = (await storage.get<string>(SIG_KEY)) ?? '';
  const valid = await verify(raw, id, signature);

  const save = reconcile(migrate(raw), id);

  if (!valid) {
    // Progress is kept — punishing a player for a browser that dropped a key,
    // or for our own bug, is far worse than the alternative. The flag travels
    // to the server, which is where leaderboard eligibility is actually decided.
    return { save, tampered: true, fresh: false };
  }
  return { save, tampered: false, fresh: false };
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pending: SaveData | null = null;

/** Debounced write. Rapid mutations during a run collapse into one commit. */
export function persistSave(save: SaveData, immediate = false): void {
  pending = save;
  if (immediate) {
    void flushSave();
    return;
  }
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void flushSave();
  }, 400);
}

export async function flushSave(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const save = pending;
  if (!save) return;
  pending = null;
  save.updatedAt = Date.now();
  const signature = await sign(save, save.installId);
  await storage.set(SAVE_KEY, save);
  await storage.set(SIG_KEY, signature);
}

export async function wipeSave(): Promise<void> {
  pending = null;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  await storage.remove(SAVE_KEY);
  await storage.remove(SIG_KEY);
}
