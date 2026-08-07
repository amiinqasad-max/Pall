/**
 * Cloud save synchronisation.
 *
 * Offline is the normal case, not the error case: the game is fully playable
 * with no network, and sync is a background reconciliation that happens when
 * connectivity allows. Nothing in the UI ever blocks on it.
 *
 * Conflict handling lives in `applyCloudSave` on the store — this module only
 * decides *when* to pull and push.
 */

import { ensureSession, isOnline, supabase } from '@/services/supabase';
import { useStore } from '@/state/store';
import { flushPendingRuns } from '@/services/leaderboard';
import { analytics } from '@/systems/analytics';
import { levelFromXp } from '@/data/progression';
import type { SaveData } from '@/systems/save';

const PUSH_DEBOUNCE_MS = 8_000;
const MIN_PUSH_INTERVAL_MS = 20_000;

class SyncManager {
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPushAt = 0;
  private inFlight = false;
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    window.addEventListener('online', () => void this.onReconnect());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.onReconnect();
      else void this.push(true);
    });

    await this.pull();
    void flushPendingRuns();

    // Push whenever local state is dirty. Subscribing to the store rather than
    // polling means an idle app makes no requests at all.
    useStore.subscribe((state) => {
      if (state.save.cloud.dirty) this.schedulePush();
    });
  }

  private schedulePush(): void {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.push();
    }, PUSH_DEBOUNCE_MS);
  }

  private async onReconnect(): Promise<void> {
    if (!isOnline()) return;
    await this.pull();
    await flushPendingRuns();
    await this.push();
  }

  /** Fetches the server copy and merges it into local state. */
  async pull(): Promise<void> {
    const sb = await supabase();
    if (!sb || !isOnline()) return;
    const session = await ensureSession();
    if (!session) return;

    try {
      const { data, error } = await sb
        .from('profiles')
        .select('save, updated_at')
        .eq('user_id', session.user.id)
        .maybeSingle();

      if (error) throw error;
      if (data?.save) {
        useStore.getState().applyCloudSave(data.save as SaveData);
        analytics.track('cloud_pull', { updatedAt: data.updated_at });
      }
      useStore.getState().markSynced(session.user.id);
    } catch (err) {
      analytics.track('cloud_pull_failed', { message: String(err) });
    }
  }

  /** Writes the local save up. `force` skips the rate limit (used on hide). */
  async push(force = false): Promise<void> {
    const state = useStore.getState();
    if (!state.save.cloud.dirty && !force) return;
    if (this.inFlight) return;
    if (!force && Date.now() - this.lastPushAt < MIN_PUSH_INTERVAL_MS) {
      this.schedulePush();
      return;
    }

    const sb = await supabase();
    if (!sb || !isOnline()) return;
    const session = await ensureSession();
    if (!session) return;

    this.inFlight = true;
    try {
      const save = useStore.getState().save;
      const level = levelFromXp(save.player.totalXp).level;
      const { error } = await sb.from('profiles').upsert(
        {
          user_id: session.user.id,
          username: save.player.username,
          // The wallet is mirrored into dedicated columns so the server can
          // enforce coin rules without parsing the blob on every check.
          coins: save.wallet.coins,
          lifetime_earned: save.wallet.lifetimeEarned,
          lifetime_spent: save.wallet.lifetimeSpent,
          total_xp: save.player.totalXp,
          level,
          save,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      );
      if (error) throw error;
      this.lastPushAt = Date.now();
      useStore.getState().markSynced(session.user.id);
      analytics.track('cloud_push', {});
    } catch (err) {
      analytics.track('cloud_push_failed', { message: String(err) });
    } finally {
      this.inFlight = false;
    }
  }
}

export const sync = new SyncManager();
