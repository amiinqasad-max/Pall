/** Shared contracts between the game engine, the systems layer and the UI. */

export type ScreenId =
  | 'splash'
  | 'home'
  | 'play'
  | 'gameover'
  | 'store'
  | 'profile'
  | 'leaderboard'
  | 'settings'
  | 'missions'
  | 'daily';

export type CosmeticKind = 'skin' | 'trail';

export type UnlockRule =
  | { type: 'default' }
  | { type: 'coins'; cost: number }
  | { type: 'level'; level: number }
  | { type: 'level+coins'; level: number; cost: number };

export interface BallSkin {
  id: string;
  name: string;
  kind: 'skin';
  /** Blurb shown on the store card. */
  tagline: string;
  unlock: UnlockRule;
  /** Core, rim and highlight colours used to bake the ball texture. */
  palette: { core: number; rim: number; glow: number; spec: number };
  /** Optional shimmer applied in the shader-free tint animation. */
  animated?: 'pulse' | 'flicker' | 'orbit' | 'none';
  rarity: 'standard' | 'rare' | 'epic' | 'legendary';
}

export interface Trail {
  id: string;
  name: string;
  kind: 'trail';
  tagline: string;
  unlock: UnlockRule;
  colors: number[];
  /** Particles emitted per second at full speed. Tuned down on low-end tiers. */
  rate: number;
  /** Visual behaviour of the emitted particles. */
  style: 'stream' | 'spark' | 'ribbon' | 'bloom';
  rarity: 'standard' | 'rare' | 'epic' | 'legendary';
}

export type Cosmetic = BallSkin | Trail;

/** Where a coin came from. The economy accepts nothing outside this union. */
export type CoinSource = 'rewarded_ad' | 'daily_challenge' | 'daily_reward';

export type LedgerEntry = {
  id: string;
  at: number;
  amount: number;
  /** Positive entries carry a CoinSource, negative ones carry the purchase id. */
  reason: CoinSource | 'purchase';
  detail?: string;
  balanceAfter: number;
};

export type MissionKind =
  | 'play_runs'
  | 'survive_seconds'
  | 'total_distance'
  | 'single_run_distance'
  | 'dodge_obstacles'
  | 'collect_prisms'
  | 'complete_daily_challenge'
  | 'beat_record'
  | 'near_misses';

export interface MissionDef {
  id: string;
  kind: MissionKind;
  title: string;
  description: string;
  target: number;
  xp: number;
  /** Weekly missions run Monday-to-Monday; daily ones reset at UTC midnight. */
  period: 'daily' | 'weekly';
}

export interface MissionProgress {
  id: string;
  progress: number;
  claimed: boolean;
  completedAt?: number;
}

export type DailyChallengeKind = 'survive_seconds' | 'reach_distance' | 'dodge_obstacles' | 'collect_prisms';

export interface DailyChallenge {
  /** UTC day key — the same challenge for every player on the planet. */
  day: string;
  kind: DailyChallengeKind;
  target: number;
  title: string;
  description: string;
  coinReward: number;
  xpReward: number;
  /** Seed applied to the track generator so everyone races the same layout. */
  seed: number;
}

/** Everything one run produces. Also the payload the server re-validates. */
export interface RunResult {
  score: number;
  distance: number;
  durationMs: number;
  prisms: number;
  obstaclesDodged: number;
  nearMisses: number;
  topSpeed: number;
  /** Highest difficulty stage reached, 0-based. */
  stage: number;
  seed: number;
  /** True when the run was started from the daily challenge entry point. */
  daily: boolean;
  endedAt: number;
  /** Whether the player used a rewarded-ad continue during this run. */
  continued: boolean;
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  score: number;
  level: number;
  country?: string | null;
  /** True for the signed-in player's own row. */
  isSelf?: boolean;
}

export type LeaderboardScope = 'global' | 'daily' | 'weekly';

export type PerfTier = 'ultraLow' | 'low' | 'medium' | 'high';

export interface Settings {
  musicVolume: number;
  sfxVolume: number;
  muted: boolean;
  haptics: boolean;
  /** 'auto' resolves against the detected device tier at boot. */
  quality: PerfTier | 'auto';
  showFps: boolean;
  leftHanded: boolean;
  reducedMotion: boolean;
  /** Opt-out for anonymous telemetry. On by default, honoured everywhere. */
  analytics: boolean;
}
