/**
 * The cosmetic catalogue.
 *
 * Everything here is purely visual. No skin rolls faster, no trail widens the
 * road, nothing changes a hitbox. That is a deliberate product constraint, and
 * it is enforced structurally: the game engine reads only `palette`, `colors`
 * and `style` off these records, and nothing else in the codebase branches on
 * a cosmetic id.
 */

import type { BallSkin, Cosmetic, Trail, UnlockRule } from '@/types';

export const SKINS: BallSkin[] = [
  {
    id: 'skin.neon',
    name: 'Neon',
    kind: 'skin',
    tagline: 'The house ball. Cold light, warm edge.',
    unlock: { type: 'default' },
    palette: { core: 0xe6fffb, rim: 0x0f766e, glow: 0x2dd4bf, spec: 0xffffff },
    animated: 'pulse',
    rarity: 'standard',
  },
  {
    id: 'skin.ember',
    name: 'Fire',
    kind: 'skin',
    tagline: 'Burns hotter the longer you last.',
    unlock: { type: 'coins', cost: 400 },
    palette: { core: 0xfff1d6, rim: 0xc2410c, glow: 0xf59e0b, spec: 0xfffbeb },
    animated: 'flicker',
    rarity: 'standard',
  },
  {
    id: 'skin.ice',
    name: 'Ice',
    kind: 'skin',
    tagline: 'Cut from something that never melted.',
    unlock: { type: 'coins', cost: 400 },
    palette: { core: 0xf0f9ff, rim: 0x0369a1, glow: 0x7dd3fc, spec: 0xffffff },
    animated: 'none',
    rarity: 'standard',
  },
  {
    id: 'skin.emerald',
    name: 'Emerald',
    kind: 'skin',
    tagline: 'Faceted, and quietly expensive.',
    unlock: { type: 'level', level: 5 },
    palette: { core: 0xd1fae5, rim: 0x047857, glow: 0x34d399, spec: 0xecfdf5 },
    animated: 'pulse',
    rarity: 'rare',
  },
  {
    id: 'skin.cyber',
    name: 'Cyber',
    kind: 'skin',
    tagline: 'Circuit-etched. Hums at speed.',
    unlock: { type: 'coins', cost: 900 },
    palette: { core: 0xe0f2fe, rim: 0x1d4ed8, glow: 0x38bdf8, spec: 0xffffff },
    animated: 'orbit',
    rarity: 'rare',
  },
  {
    id: 'skin.shadow',
    name: 'Shadow',
    kind: 'skin',
    tagline: 'Absorbs the track light. Gives none back.',
    unlock: { type: 'level+coins', level: 8, cost: 750 },
    palette: { core: 0x334155, rim: 0x020617, glow: 0x64748b, spec: 0x94a3b8 },
    animated: 'none',
    rarity: 'rare',
  },
  {
    id: 'skin.crystal',
    name: 'Crystal',
    kind: 'skin',
    tagline: 'Refracts every gate you pass through.',
    unlock: { type: 'level+coins', level: 12, cost: 1400 },
    palette: { core: 0xfdf4ff, rim: 0x7e22ce, glow: 0xe879f9, spec: 0xffffff },
    animated: 'orbit',
    rarity: 'epic',
  },
  {
    id: 'skin.galaxy',
    name: 'Galaxy',
    kind: 'skin',
    tagline: 'A very small amount of deep space.',
    unlock: { type: 'level+coins', level: 18, cost: 2200 },
    palette: { core: 0x1e1b4b, rim: 0x0b1020, glow: 0x818cf8, spec: 0xf5d0fe },
    animated: 'orbit',
    rarity: 'epic',
  },
  {
    id: 'skin.gold',
    name: 'Gold',
    kind: 'skin',
    tagline: 'For players who finish what they start.',
    unlock: { type: 'level+coins', level: 25, cost: 3600 },
    palette: { core: 0xfff7cd, rim: 0xb45309, glow: 0xfbbf24, spec: 0xfffef2 },
    animated: 'pulse',
    rarity: 'legendary',
  },
];

export const TRAILS: Trail[] = [
  {
    id: 'trail.energy',
    name: 'Energy Trail',
    kind: 'trail',
    tagline: 'Clean teal exhaust. Always included.',
    unlock: { type: 'default' },
    colors: [0x2dd4bf, 0x0f766e, 0x99f6e4],
    rate: 46,
    style: 'stream',
    rarity: 'standard',
  },
  {
    id: 'trail.fire',
    name: 'Fire Trail',
    kind: 'trail',
    tagline: 'Leaves the track a little warmer.',
    unlock: { type: 'coins', cost: 350 },
    colors: [0xf59e0b, 0xdc2626, 0xfef3c7],
    rate: 58,
    style: 'bloom',
    rarity: 'standard',
  },
  {
    id: 'trail.electric',
    name: 'Electric Trail',
    kind: 'trail',
    tagline: 'Arcs off the shoulder on hard cuts.',
    unlock: { type: 'level', level: 4 },
    colors: [0x38bdf8, 0xffffff, 0x2563eb],
    rate: 64,
    style: 'spark',
    rarity: 'rare',
  },
  {
    id: 'trail.galaxy',
    name: 'Galaxy Trail',
    kind: 'trail',
    tagline: 'Scatters cold stars behind you.',
    unlock: { type: 'level+coins', level: 10, cost: 1200 },
    colors: [0x818cf8, 0xe879f9, 0xffffff],
    rate: 52,
    style: 'bloom',
    rarity: 'epic',
  },
  {
    id: 'trail.rainbow',
    name: 'Rainbow Trail',
    kind: 'trail',
    tagline: 'Earned the long way. Worn loudly.',
    unlock: { type: 'level+coins', level: 20, cost: 2600 },
    colors: [0xef4444, 0xf59e0b, 0x22c55e, 0x38bdf8, 0xa855f7],
    rate: 70,
    style: 'ribbon',
    rarity: 'legendary',
  },
];

export const COSMETICS: Cosmetic[] = [...SKINS, ...TRAILS];

export const DEFAULT_SKIN = 'skin.neon';
export const DEFAULT_TRAIL = 'trail.energy';

const byId = new Map<string, Cosmetic>(COSMETICS.map((c) => [c.id, c]));

export function getCosmetic(id: string): Cosmetic | undefined {
  return byId.get(id);
}

export function getSkin(id: string): BallSkin {
  const found = byId.get(id);
  return found && found.kind === 'skin' ? found : SKINS[0];
}

export function getTrail(id: string): Trail {
  const found = byId.get(id);
  return found && found.kind === 'trail' ? found : TRAILS[0];
}

/** Cosmetics granted to a brand-new account. */
export function defaultUnlocks(): string[] {
  return COSMETICS.filter((c) => c.unlock.type === 'default').map((c) => c.id);
}

export function coinCost(rule: UnlockRule): number {
  return rule.type === 'coins' || rule.type === 'level+coins' ? rule.cost : 0;
}

export function requiredLevel(rule: UnlockRule): number {
  return rule.type === 'level' || rule.type === 'level+coins' ? rule.level : 0;
}

export type LockReason = 'owned' | 'affordable' | 'needs_coins' | 'needs_level' | 'needs_both';

/** Single source of truth for how a store card renders and whether it buys. */
export function evaluateUnlock(
  cosmetic: Cosmetic,
  opts: { owned: boolean; coins: number; level: number },
): { reason: LockReason; cost: number; level: number } {
  const cost = coinCost(cosmetic.unlock);
  const level = requiredLevel(cosmetic.unlock);
  if (opts.owned) return { reason: 'owned', cost, level };
  const levelOk = opts.level >= level;
  const coinsOk = opts.coins >= cost;
  if (levelOk && coinsOk) return { reason: 'affordable', cost, level };
  if (!levelOk && !coinsOk) return { reason: 'needs_both', cost, level };
  if (!levelOk) return { reason: 'needs_level', cost, level };
  return { reason: 'needs_coins', cost, level };
}
