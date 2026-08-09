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
  | 'daily'
  | 'championship'
  | 'championshipFinal'
  | 'admin';

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

// --- Championship ---------------------------------------------------------
//
// A separate system from the mission-style `DailyChallenge` above (see
// data/missions.ts) — that one is a fixed-stat mission with coin/XP rewards.
// This is the percentile-qualified, free-entry cash Championship. The two
// are deliberately kept apart in code even though the on-screen copy for
// this one says "Daily Championship".

export type ChallengeStatus = 'scheduled' | 'active' | 'ended' | 'paused' | 'cancelled';
export type QualificationStatus = 'not_qualified' | 'qualified' | 'disqualified';
export type AntiCheatStatus = 'clean' | 'flagged' | 'disqualified';
export type PayoutVerificationStatus = 'pending_verification' | 'verified' | 'rejected';
export type PayoutStatus = 'pending' | 'approved' | 'paid' | 'cancelled';

/** One calendar day's Championship, as the client reads it — the immutable
 *  snapshot fields are null until the challenge has actually started. */
export interface ChampionshipChallenge {
  id: string;
  challengeDate: string;
  status: ChallengeStatus;
  startTime: string;
  endTime: string;
  qualificationTrackSeed: number;
  finalTrackSeed: number;
  qualificationTarget: number | null;
  prizePoolCents: number | null;
  winnerCount: number | null;
  maxFinalAttempts: number | null;
}

/** The signed-in player's own state within a challenge. */
export interface ChampionshipParticipant {
  qualificationStatus: QualificationStatus;
  qualificationScore: number;
  qualificationTimestamp: string | null;
  finalAttemptsUsed: number;
  finalScore: number;
  finalRank: number | null;
  antiCheatStatus: AntiCheatStatus;
}

export interface ChampionshipLeaderboardEntry {
  rank: number;
  userId: string;
  username: string;
  finalScore: number;
  completedAt: string;
  isSelf?: boolean;
}

/** The signed-in player's own payout row for a challenge they placed in —
 *  absent entirely until end_challenge() seeds it for the Top-N finishers. */
export interface ChampionshipPayout {
  rank: number;
  prizeAmountCents: number;
  verificationStatus: PayoutVerificationStatus;
  payoutStatus: PayoutStatus;
}

/** Priced in Birr (whole units, not cents) — see
 *  supabase/migrations/0005_coins_store_v2.sql. Buying one opens a
 *  pre-filled WhatsApp message; nothing here credits coins automatically. */
export interface CoinPackage {
  id: string;
  name: string;
  coins: number;
  priceBirr: number;
}

// --- Coin economy (Read Article earn method) ------------------------------
//
// Server-authoritative and separate from the local `CoinSource`/`LedgerEntry`
// pair above, which stays exactly as it was — these read from
// tartan.economy_status()/coin_history() (supabase/migrations/0003_coin_economy.sql,
// 0005_coins_store_v2.sql), never from local save state.

/** Everything the Coins tab needs to render in one round trip: balance, the
 *  Read Article reward amount, today's progress against its admin-configured
 *  daily cap, and the current revive cost. */
export interface EconomyStatus {
  coins: number;
  articleRewardCoins: number;
  articleRewardDailyLimit: number;
  articleClaimsToday: number;
  reviveCostCoins: number;
}

/** The status string every claim RPC returns — every value here is a real,
 *  expected outcome the UI reacts to, not just a success/failure bit. */
export type CoinRewardClaimResult =
  | 'credited'
  | 'already_claimed'
  | 'too_early'
  | 'daily_limit_reached'
  | 'not_found'
  | 'offline'
  | 'not_signed_in';

/** One row from tartan.coin_history() — merges the coin_ledger (rewarded_ad/
 *  daily_challenge/daily_reward) and coin_transactions (purchase_credit/
 *  revive_spend/article_reward) tables into one read. */
export interface CoinHistoryEntry {
  amount: number;
  reason: string;
  detail: string | null;
  balanceAfter: number;
  createdAt: string;
}

/** An admin-managed "Read Article" link (tartan.articles,
 *  0005_coins_store_v2.sql). The client opens `url` directly — there is no
 *  in-app article content anymore, only server-managed links. */
export interface Article {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

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
