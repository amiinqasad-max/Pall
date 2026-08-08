/**
 * XP curve, level rewards, environments and achievements.
 *
 * The curve is deliberately generous early (level 5 lands inside the first
 * session for most players, which is where the Emerald skin unlock sits) and
 * then stretches out, so the long tail of levels stays meaningful for months.
 */

import { SKINS, TRAILS } from '@/data/cosmetics';

/** XP needed to go from `level` to `level + 1`. */
export function xpForLevel(level: number): number {
  if (level < 1) return 0;
  return Math.round(90 * Math.pow(level, 1.42) + 60 * level);
}

/** Total XP required to have reached `level`. */
export function totalXpForLevel(level: number): number {
  let sum = 0;
  for (let l = 1; l < level; l++) sum += xpForLevel(l);
  return sum;
}

export interface LevelState {
  level: number;
  /** XP banked toward the next level. */
  xpIntoLevel: number;
  xpForNext: number;
  progress: number;
}

/** Resolves a lifetime XP total into a level and a progress bar. */
export function levelFromXp(totalXp: number): LevelState {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalXp));
  // The curve is steep enough that this loop runs a few hundred times at most,
  // even for an absurd XP total, and it runs once per XP change.
  for (;;) {
    const need = xpForLevel(level);
    if (remaining < need || level >= MAX_LEVEL) break;
    remaining -= need;
    level++;
  }
  const xpForNext = level >= MAX_LEVEL ? 0 : xpForLevel(level);
  return {
    level,
    xpIntoLevel: remaining,
    xpForNext,
    progress: xpForNext === 0 ? 1 : remaining / xpForNext,
  };
}

export const MAX_LEVEL = 60;

/** XP awarded for a finished run, derived from what actually happened in it. */
export function xpForRun(input: {
  distance: number;
  durationMs: number;
  prisms: number;
  nearMisses: number;
  newRecord: boolean;
}): number {
  const base = Math.floor(input.distance / 45);
  const time = Math.floor(input.durationMs / 6000);
  const style = Math.floor(input.prisms * 0.6 + input.nearMisses * 1.2);
  const record = input.newRecord ? 60 : 0;
  return Math.max(5, base + time + style + record);
}

// --- Environments -------------------------------------------------------------

export interface Environment {
  id: string;
  name: string;
  /** Level at which the environment enters the rotation. */
  level: number;
  blurb: string;
  palette: {
    sky: [number, number];
    fog: number;
    road: [number, number];
    shoulder: [number, number];
    rumble: number;
    lane: number;
    accent: number;
    grid: number;
  };
}

export const ENVIRONMENTS: Environment[] = [
  {
    id: 'env.harbour',
    name: 'Deep Harbour',
    level: 1,
    blurb: 'Where every run starts. Cosmic dark, violet horizon.',
    palette: {
      sky: [0x050810, 0x0d1030],
      fog: 0x050810,
      road: [0x0c0f22, 0x11142e],
      shoulder: [0x090b1a, 0x0c0f22],
      rumble: 0x7c3aed,
      lane: 0x22d3ee,
      accent: 0x67e8f9,
      grid: 0x2e1065,
    },
  },
  {
    id: 'env.solstice',
    name: 'Solstice Flats',
    level: 3,
    blurb: 'Long amber light across an endless salt plain.',
    palette: {
      sky: [0x1a1008, 0x3a2410],
      fog: 0x1a1008,
      road: [0x241a10, 0x2e2114],
      shoulder: [0x1c130a, 0x241a10],
      rumble: 0xf59e0b,
      lane: 0xfbbf24,
      accent: 0x2dd4bf,
      grid: 0x78350f,
    },
  },
  {
    id: 'env.voidline',
    name: 'Voidline',
    level: 7,
    blurb: 'No horizon. Only the track and the dark.',
    palette: {
      sky: [0x05060f, 0x11132b],
      fog: 0x05060f,
      road: [0x0f1230, 0x161a3d],
      shoulder: [0x0a0c22, 0x0f1230],
      rumble: 0x6366f1,
      lane: 0x818cf8,
      accent: 0xe879f9,
      grid: 0x312e81,
    },
  },
  {
    id: 'env.bloom',
    name: 'Coral Bloom',
    level: 14,
    blurb: 'Bioluminescent, and faster than it looks.',
    palette: {
      sky: [0x0d0618, 0x2a0f38],
      fog: 0x0d0618,
      road: [0x1b0f2a, 0x231435],
      shoulder: [0x140a20, 0x1b0f2a],
      rumble: 0xec4899,
      lane: 0xf9a8d4,
      accent: 0x22d3ee,
      grid: 0x701a75,
    },
  },
  {
    id: 'env.meridian',
    name: 'Gold Meridian',
    level: 22,
    blurb: 'The end of the line. Everything here is polished.',
    palette: {
      sky: [0x140f04, 0x3d2f0c],
      fog: 0x140f04,
      road: [0x201907, 0x2b210b],
      shoulder: [0x181205, 0x201907],
      rumble: 0xfbbf24,
      lane: 0xfde68a,
      accent: 0xffffff,
      grid: 0x92400e,
    },
  },
];

export function environmentsForLevel(level: number): Environment[] {
  const unlocked = ENVIRONMENTS.filter((e) => e.level <= level);
  return unlocked.length ? unlocked : [ENVIRONMENTS[0]];
}

export function getEnvironment(id: string): Environment {
  return ENVIRONMENTS.find((e) => e.id === id) ?? ENVIRONMENTS[0];
}

// --- Badges -------------------------------------------------------------------

export interface Badge {
  id: string;
  name: string;
  level: number;
  glyph: string;
  /** Which rank-emblem treatment renders this badge — see `.rank-badge--*` in global.css. */
  tone: 'slate' | 'cyan' | 'cyanviolet' | 'violet' | 'violetbright' | 'gold' | 'prism';
}

/**
 * Seven-tier competitive rank ladder, spread across the full level curve so the
 * top tier stays aspirational rather than reachable in a single season.
 */
export const BADGES: Badge[] = [
  { id: 'badge.rookie', name: 'Rookie', level: 1, glyph: '◇', tone: 'slate' },
  { id: 'badge.runner', name: 'Runner', level: 6, glyph: '◈', tone: 'cyan' },
  { id: 'badge.striker', name: 'Striker', level: 15, glyph: '⬡', tone: 'cyanviolet' },
  { id: 'badge.elite', name: 'Elite', level: 25, glyph: '✦', tone: 'violet' },
  { id: 'badge.master', name: 'Master', level: 38, glyph: '✪', tone: 'violetbright' },
  { id: 'badge.legend', name: 'Legend', level: 48, glyph: '✧', tone: 'gold' },
  { id: 'badge.galaxy', name: 'Galaxy', level: 58, glyph: '✹', tone: 'prism' },
];

export function badgeForLevel(level: number): Badge {
  let current = BADGES[0];
  for (const b of BADGES) if (level >= b.level) current = b;
  return current;
}

// --- Level reward table -------------------------------------------------------

export interface LevelReward {
  level: number;
  label: string;
  kind: 'skin' | 'trail' | 'environment' | 'badge';
}

/**
 * Derived from the catalogues rather than hand-maintained, so a new cosmetic
 * with a level gate automatically shows up on the progression track.
 */
export const LEVEL_REWARDS: LevelReward[] = (() => {
  const rewards: LevelReward[] = [];
  for (const s of SKINS) {
    const lvl = s.unlock.type === 'level' || s.unlock.type === 'level+coins' ? s.unlock.level : 0;
    if (lvl > 0) rewards.push({ level: lvl, label: `${s.name} skin`, kind: 'skin' });
  }
  for (const t of TRAILS) {
    const lvl = t.unlock.type === 'level' || t.unlock.type === 'level+coins' ? t.unlock.level : 0;
    if (lvl > 0) rewards.push({ level: lvl, label: t.name, kind: 'trail' });
  }
  for (const e of ENVIRONMENTS) {
    if (e.level > 1) rewards.push({ level: e.level, label: `${e.name} environment`, kind: 'environment' });
  }
  for (const b of BADGES) rewards.push({ level: b.level, label: `${b.name} badge`, kind: 'badge' });
  return rewards.sort((a, b) => a.level - b.level);
})();

// --- Achievements -------------------------------------------------------------

export interface Achievement {
  id: string;
  name: string;
  description: string;
  xp: number;
  /** Reads the lifetime stat block and returns progress toward `target`. */
  stat: keyof AchievementStats;
  target: number;
}

export interface AchievementStats {
  runs: number;
  bestScore: number;
  bestDistance: number;
  totalDistance: number;
  totalTimeMs: number;
  totalPrisms: number;
  obstaclesDodged: number;
  nearMisses: number;
  dailyChallengesCompleted: number;
  longestStreak: number;
  missionsCompleted: number;
}

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'ach.first', name: 'First Light', description: 'Finish your first run.', xp: 40, stat: 'runs', target: 1 },
  { id: 'ach.runs25', name: 'Regular', description: 'Complete 25 runs.', xp: 120, stat: 'runs', target: 25 },
  { id: 'ach.runs150', name: 'Committed', description: 'Complete 150 runs.', xp: 400, stat: 'runs', target: 150 },
  { id: 'ach.dist2k', name: 'Long Haul', description: 'Travel 2 km in a single run.', xp: 150, stat: 'bestDistance', target: 2000 },
  { id: 'ach.dist5k', name: 'Horizon Chaser', description: 'Travel 5 km in a single run.', xp: 350, stat: 'bestDistance', target: 5000 },
  { id: 'ach.total100k', name: 'Century', description: 'Travel 100 km in total.', xp: 500, stat: 'totalDistance', target: 100_000 },
  { id: 'ach.score10k', name: 'Five Figures', description: 'Score 10,000 in one run.', xp: 200, stat: 'bestScore', target: 10_000 },
  { id: 'ach.score50k', name: 'Record Holder', description: 'Score 50,000 in one run.', xp: 600, stat: 'bestScore', target: 50_000 },
  { id: 'ach.prisms500', name: 'Collector', description: 'Collect 500 prisms.', xp: 180, stat: 'totalPrisms', target: 500 },
  { id: 'ach.dodge1000', name: 'Untouchable', description: 'Dodge 1,000 obstacles.', xp: 250, stat: 'obstaclesDodged', target: 1000 },
  { id: 'ach.near250', name: 'Close Shave', description: 'Land 250 near misses.', xp: 220, stat: 'nearMisses', target: 250 },
  { id: 'ach.daily7', name: 'Dedicated', description: 'Complete 7 daily challenges.', xp: 300, stat: 'dailyChallengesCompleted', target: 7 },
  { id: 'ach.streak7', name: 'Week One', description: 'Reach a 7-day login streak.', xp: 260, stat: 'longestStreak', target: 7 },
  { id: 'ach.streak30', name: 'Unbroken', description: 'Reach a 30-day login streak.', xp: 800, stat: 'longestStreak', target: 30 },
  { id: 'ach.missions50', name: 'Taskmaster', description: 'Complete 50 missions.', xp: 350, stat: 'missionsCompleted', target: 50 },
];
