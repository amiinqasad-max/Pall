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
import { analytics } from '@/systems/analytics';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isBackendConfigured = Boolean(URL && ANON_KEY);

let clientPromise: Promise<SupabaseClient | null> | null = null;
let sessionPromise: Promise<Session | null> | null = null;

async function createSupabase(): Promise<SupabaseClient | null> {
  if (!isBackendConfigured) return null;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    return createClient(URL!, ANON_KEY!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: 'tartan.auth',
      },
      global: {
        headers: { 'x-tartan-client': '1.0.0' },
      },
      realtime: { params: { eventsPerSecond: 2 } },
    });
  } catch {
    // Chunk fetch failed (offline on a cold cache). Try again next call.
    clientPromise = null;
    return null;
  }
}

export function supabase(): Promise<SupabaseClient | null> {
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
