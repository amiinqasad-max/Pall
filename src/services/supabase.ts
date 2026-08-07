/**
 * Supabase client and session bootstrap.
 *
 * Two deliberate choices here:
 *
 * 1. The whole backend is optional. With no environment variables configured
 *    the game runs fully offline — local saves, local best scores, a
 *    leaderboard that shows only the player's own runs — and every call in
 *    this module short circuits. That keeps `npm run dev` working on a fresh
 *    clone and means a backend outage degrades the game instead of breaking it.
 *
 * 2. The SDK is a lazy chunk. Nothing on the first screen needs it, so it is
 *    imported on first use rather than blocking startup. Every consumer is
 *    already async, so this costs nothing at the call sites.
 *
 * Auth is anonymous by design. A player should be able to install the PWA and
 * be on the leaderboard in one tap; there is no sign-up wall.
 */

import type { SupabaseClient, Session } from '@supabase/supabase-js';

/**
 * The client is typed against the game's own schema, not `public`. Naming it
 * once here keeps that detail out of every consumer.
 */
type TartanClient = SupabaseClient<any, 'tartan', 'tartan'>;
import { analytics } from '@/systems/analytics';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;

/**
 * Supabase renamed the client-side key from "anon" to "publishable"
 * (`sb_publishable_...`). Both are accepted so a project on either naming works
 * without an edit; the newer name wins when both are present.
 *
 * Either way this key is meant to ship in the bundle — row-level security is
 * what protects the data, not the key's secrecy. A `service_role` or `sbp_`
 * token must never appear in a VITE_ variable: those are baked into the
 * JavaScript every visitor downloads.
 */
const CLIENT_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  import.meta.env.VITE_SUPABASE_ANON_KEY) as string | undefined;

/**
 * The game owns a `tartan` schema rather than living in `public`, so it can be
 * added to a project that already has tables without any chance of colliding
 * with them. See supabase/migrations/0001_init.sql.
 */
const SCHEMA = 'tartan';

/**
 * Every backend call is bounded.
 *
 * supabase-js applies no timeout of its own, so a request that stalls — a
 * captive portal, a dead cell handoff, a half-open socket — hangs forever, and
 * the UI waiting on it sits on a loading skeleton with no way out. On mobile
 * that is the common case, not the edge case. Ten seconds is far longer than a
 * healthy round trip and far shorter than a player's patience.
 */
const REQUEST_TIMEOUT_MS = 10_000;

function timedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // Respect a caller's own signal as well as the deadline.
  init?.signal?.addEventListener('abort', () => controller.abort(), { once: true });
  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export const isBackendConfigured = Boolean(URL && CLIENT_KEY);

let clientPromise: Promise<TartanClient | null> | null = null;
let sessionPromise: Promise<Session | null> | null = null;

async function createSupabase(): Promise<TartanClient | null> {
  if (!isBackendConfigured) return null;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    return createClient(URL!, CLIENT_KEY!, {
      db: { schema: SCHEMA },
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: 'tartan.auth',
      },
      global: {
        headers: { 'x-tartan-client': '1.0.0' },
        fetch: timedFetch,
      },
      realtime: { params: { eventsPerSecond: 2 } },
    });
  } catch {
    // Chunk fetch failed (offline on a cold cache). Try again next call.
    clientPromise = null;
    return null;
  }
}

export function supabase(): Promise<TartanClient | null> {
  if (!isBackendConfigured) return Promise.resolve(null);
  if (!clientPromise) clientPromise = createSupabase();
  return clientPromise;
}

/**
 * Returns a session, creating an anonymous one on first launch. Resolves to
 * null when the backend is unconfigured or unreachable — every caller must
 * handle that, and they all do.
 */
export function ensureSession(): Promise<Session | null> {
  if (!sessionPromise) sessionPromise = bootstrapSession();
  return sessionPromise;
}

async function bootstrapSession(): Promise<Session | null> {
  const sb = await supabase();
  if (!sb) return null;
  try {
    const { data } = await sb.auth.getSession();
    if (data.session) return data.session;
    const { data: signed, error } = await sb.auth.signInAnonymously();
    if (error) {
      analytics.track('auth_failed', { message: error.message });
      // Allow a later attempt; a transient network failure should not
      // permanently strand the player in offline mode.
      sessionPromise = null;
      return null;
    }
    analytics.track('auth_anonymous_created', {});
    return signed.session;
  } catch (err) {
    analytics.track('auth_failed', { message: String(err) });
    sessionPromise = null;
    return null;
  }
}

export async function currentUserId(): Promise<string | null> {
  const session = await ensureSession();
  return session?.user.id ?? null;
}

/** Wires the analytics buffer to the `analytics_events` table. */
export function attachAnalyticsSink(): void {
  if (!isBackendConfigured) return;
  analytics.setSink(async (events) => {
    const sb = await supabase();
    const session = await ensureSession();
    if (!sb || !session) return false;
    const rows = events.map((e) => ({
      user_id: session.user.id,
      session_id: analytics.session,
      name: e.name,
      props: e.props,
      occurred_at: new Date(e.at).toISOString(),
      seq: e.seq,
    }));
    const { error } = await sb.from('analytics_events').insert(rows);
    return !error;
  });
}

export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}
