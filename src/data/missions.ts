/**
 * Mission and daily-challenge generation.
 *
 * Both are derived purely from the UTC date key, so two players on opposite
 * sides of the world open the app and see the same challenge with the same
 * target, without a single network call. The server generates its copy the same
 * way when it validates a claim.
 */

import { rngFromKey } from '@/core/rng';
import { dayKey, weekKey } from '@/core/time';
import type { DailyChallenge, DailyChallengeKind, MissionDef, MissionKind } from '@/types';

type Template = {
  kind: MissionKind;
  title: string;
  /** Candidate targets; one is picked per period so difficulty varies. */
  targets: number[];
  xp: number;
  describe: (target: number) => string;
};

const DAILY_TEMPLATES: Template[] = [
  {
    kind: 'play_runs',
    title: 'Warm Up',
    targets: [3, 5, 6],
    xp: 60,
    describe: (t) => `Complete ${t} runs`,
  },
  {
    kind: 'survive_seconds',
    title: 'Hold the Line',
    targets: [60, 90, 120],
    xp: 90,
    describe: (t) => `Survive ${t} seconds in a single run`,
  },
  {
    kind: 'total_distance',
    title: 'Ground Covered',
    targets: [2500, 4000, 6000],
    xp: 80,
    describe: (t) => `Travel ${t.toLocaleString()} m today`,
  },
  {
    kind: 'single_run_distance',
    title: 'One Clean Push',
    targets: [1200, 1800, 2500],
    xp: 100,
    describe: (t) => `Reach ${t.toLocaleString()} m in one run`,
  },
  {
    kind: 'collect_prisms',
    title: 'Light Harvest',
    targets: [40, 60, 90],
    xp: 70,
    describe: (t) => `Collect ${t} prisms`,
  },
  {
    kind: 'dodge_obstacles',
    title: 'Threading',
    targets: [80, 130, 200],
    xp: 85,
    describe: (t) => `Dodge ${t} obstacles`,
  },
  {
    kind: 'near_misses',
    title: 'Close Quarters',
    targets: [15, 25, 40],
    xp: 110,
    describe: (t) => `Land ${t} near misses`,
  },
  {
    kind: 'complete_daily_challenge',
    title: "Today's Trial",
    targets: [1],
    xp: 120,
    describe: () => 'Complete the daily challenge',
  },
];

const WEEKLY_TEMPLATES: Template[] = [
  {
    kind: 'play_runs',
    title: 'Season Regular',
    targets: [25, 40, 55],
    xp: 300,
    describe: (t) => `Complete ${t} runs this week`,
  },
  {
    kind: 'total_distance',
    title: 'Distance Runner',
    targets: [25_000, 40_000, 60_000],
    xp: 380,
    describe: (t) => `Travel ${(t / 1000).toFixed(0)} km this week`,
  },
  {
    kind: 'complete_daily_challenge',
    title: 'Trial Streak',
    targets: [3, 4, 5],
    xp: 450,
    describe: (t) => `Complete ${t} daily challenges`,
  },
  {
    kind: 'beat_record',
    title: 'Raise the Bar',
    targets: [1, 2],
    xp: 400,
    describe: (t) => (t === 1 ? 'Beat your personal best' : `Beat your personal best ${t} times`),
  },
  {
    kind: 'collect_prisms',
    title: 'Prism Vault',
    targets: [350, 500, 700],
    xp: 320,
    describe: (t) => `Collect ${t} prisms this week`,
  },
  {
    kind: 'survive_seconds',
    title: 'Iron Nerve',
    targets: [150, 190, 240],
    xp: 500,
    describe: (t) => `Survive ${t} seconds in a single run`,
  },
];

function build(templates: Template[], count: number, seedKey: string, period: 'daily' | 'weekly'): MissionDef[] {
  const rng = rngFromKey(`missions:${period}:${seedKey}`);
  // Shuffle then take, so a player never gets the same mission twice in a set.
  const chosen = rng.shuffle(templates).slice(0, count);
  return chosen.map((tpl, i) => {
    const target = rng.pick(tpl.targets);
    return {
      id: `${period}:${seedKey}:${tpl.kind}:${i}`,
      kind: tpl.kind,
      title: tpl.title,
      description: tpl.describe(target),
      target,
      xp: tpl.xp,
      period,
    };
  });
}

export function dailyMissions(day = dayKey()): MissionDef[] {
  return build(DAILY_TEMPLATES, 3, day, 'daily');
}

export function weeklyMissions(week = weekKey()): MissionDef[] {
  return build(WEEKLY_TEMPLATES, 3, week, 'weekly');
}

// --- Daily challenge ----------------------------------------------------------

const CHALLENGE_KINDS: { kind: DailyChallengeKind; title: string; targets: number[]; describe: (t: number) => string }[] =
  [
    {
      kind: 'survive_seconds',
      title: 'Endurance',
      targets: [45, 60, 75, 90],
      describe: (t) => `Survive ${t} seconds in a single run`,
    },
    {
      kind: 'reach_distance',
      title: 'Long Run',
      targets: [1200, 1600, 2000, 2600],
      describe: (t) => `Reach ${t.toLocaleString()} m in a single run`,
    },
    {
      kind: 'dodge_obstacles',
      title: 'Precision',
      targets: [70, 95, 120, 150],
      describe: (t) => `Dodge ${t} obstacles in a single run`,
    },
    {
      kind: 'collect_prisms',
      title: 'Harvest',
      targets: [30, 45, 60, 80],
      describe: (t) => `Collect ${t} prisms in a single run`,
    },
  ];

/**
 * The one piece of content that must be byte-identical for every player, since
 * it seeds a shared track layout and feeds the daily leaderboard.
 */
export function dailyChallenge(day = dayKey()): DailyChallenge {
  const rng = rngFromKey(`challenge:${day}`);
  const spec = rng.pick(CHALLENGE_KINDS);
  const target = rng.pick(spec.targets);
  // Reward scales with where the target sits in its own band, so a 90-second
  // endurance day pays more than a 45-second one.
  const band = spec.targets.indexOf(target) / Math.max(1, spec.targets.length - 1);
  return {
    day,
    kind: spec.kind,
    target,
    title: spec.title,
    description: spec.describe(target),
    coinReward: Math.round(120 + band * 130),
    xpReward: Math.round(150 + band * 150),
    seed: rngFromKey(`track:${day}`).state(),
  };
}

// --- Daily login rewards ------------------------------------------------------

export interface DailyReward {
  day: number;
  coins: number;
  xp: number;
  /** Milestone days get a louder treatment in the UI. */
  milestone?: boolean;
  label?: string;
}

/**
 * A 30-day ladder. Days 1-7 are explicit, then the cycle repeats with a rising
 * multiplier and hard milestones at 14 and 30 so a long streak keeps paying.
 */
export function rewardForStreakDay(day: number): DailyReward {
  const table: Record<number, DailyReward> = {
    1: { day: 1, coins: 50, xp: 30 },
    2: { day: 2, coins: 75, xp: 40 },
    3: { day: 3, coins: 110, xp: 60, milestone: true, label: 'Day 3' },
    4: { day: 4, coins: 140, xp: 70 },
    5: { day: 5, coins: 175, xp: 85 },
    6: { day: 6, coins: 210, xp: 100 },
    7: { day: 7, coins: 400, xp: 220, milestone: true, label: 'Week 1' },
    14: { day: 14, coins: 700, xp: 380, milestone: true, label: 'Week 2' },
    30: { day: 30, coins: 2000, xp: 900, milestone: true, label: 'Month' },
  };
  if (table[day]) return table[day];

  const cycle = ((day - 1) % 7) + 1;
  const multiplier = 1 + Math.min(1.5, Math.floor((day - 1) / 7) * 0.25);
  const base = table[cycle];
  return {
    day,
    coins: Math.round(base.coins * multiplier),
    xp: Math.round(base.xp * multiplier),
  };
}

/** The ladder shown on the rewards screen. */
export function rewardLadder(currentStreak: number): DailyReward[] {
  const start = Math.max(1, currentStreak - 2);
  const days: number[] = [];
  for (let d = start; d < start + 5; d++) days.push(d);
  for (const milestone of [7, 14, 30]) {
    if (milestone > (days[days.length - 1] ?? 0)) {
      days.push(milestone);
      break;
    }
  }
  return days.map(rewardForStreakDay);
}
