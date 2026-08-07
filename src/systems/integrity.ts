/**
 * Save integrity and run plausibility checks.
 *
 * An honest framing of what this is worth: anything running on the player's
 * device can be tampered with, and no amount of client-side signing changes
 * that. What this layer buys is (a) detection of casual save editing — the
 * "open devtools and set coins to 999999" case, which is the overwhelming
 * majority of it — and (b) a shared rule set with the server, so the
 * `submit_run` RPC in supabase/migrations rejects the same impossible runs
 * using the same numbers. The server is the authority for anything that
 * affects the leaderboard.
 */

import type { RunResult } from '@/types';
import { GAME } from '@/game/config';

const SIGNING_SALT = 'tartan.v1.integrity';

/** Web Crypto is available in every browser we target, over HTTPS. */
async function hmac(payload: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  if (crypto?.subtle) {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(key),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(payload));
    return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Non-secure contexts (plain http on a LAN during development) have no
  // SubtleCrypto. Fall back to a non-cryptographic digest so saves still round
  // trip; production is HTTPS-only and always takes the branch above.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const s = payload + key;
  for (let i = 0; i < s.length; i++) {
    h1 = Math.imul(h1 ^ s.charCodeAt(i), 0x01000193);
    h2 = Math.imul(h2 + s.charCodeAt(i), 0x85ebca6b) ^ (h1 >>> 7);
  }
  return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(16, '0');
}

/**
 * Per-install key. Derived from a random value minted on first launch, so a
 * save lifted from one device does not verify on another.
 */
function deviceKey(installId: string): string {
  return `${SIGNING_SALT}:${installId}`;
}

/** Stable stringify so key order never changes the signature. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

export async function sign(data: unknown, installId: string): Promise<string> {
  return hmac(canonical(data), deviceKey(installId));
}

export async function verify(data: unknown, installId: string, signature: string): Promise<boolean> {
  if (!signature) return false;
  const expected = await sign(data, installId);
  // Constant-time-ish compare. The value is not a secret, but it costs nothing.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

// --- Run plausibility --------------------------------------------------------

export type RunVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Recomputes the physical bounds of a run and rejects anything outside them.
 * Mirrors `tartan_validate_run` in the SQL migration — keep the two in step.
 */
export function validateRun(run: RunResult): RunVerdict {
  const seconds = run.durationMs / 1000;

  if (!Number.isFinite(run.score) || run.score < 0) return { ok: false, reason: 'score_range' };
  if (!Number.isFinite(run.distance) || run.distance < 0) return { ok: false, reason: 'distance_range' };
  if (seconds < GAME.validation.minRunSeconds) return { ok: false, reason: 'too_short' };
  if (seconds > GAME.validation.maxRunSeconds) return { ok: false, reason: 'too_long' };

  // Distance can never exceed top speed sustained for the whole run, plus a
  // small tolerance for the boost pads and frame-timing jitter.
  const maxDistance = seconds * GAME.speed.max * GAME.validation.speedTolerance;
  if (run.distance > maxDistance) return { ok: false, reason: 'distance_impossible' };

  // Score is distance plus prism value plus near-miss bonus; nothing else adds
  // to it, so an upper bound falls straight out of the formula.
  const maxScore =
    run.distance * GAME.scoring.perMetre +
    run.prisms * GAME.scoring.perPrism +
    run.nearMisses * GAME.scoring.perNearMiss +
    GAME.scoring.stageBonus * (run.stage + 1);
  if (run.score > maxScore * GAME.validation.scoreTolerance + 50) {
    return { ok: false, reason: 'score_impossible' };
  }

  // Collectables are gated by how much track actually existed.
  const maxPrisms = (run.distance / GAME.world.segmentLength) * GAME.validation.maxPrismsPerSegment + 5;
  if (run.prisms > maxPrisms) return { ok: false, reason: 'prisms_impossible' };

  if (run.topSpeed > GAME.speed.max * GAME.validation.speedTolerance) {
    return { ok: false, reason: 'speed_impossible' };
  }

  return { ok: true };
}
