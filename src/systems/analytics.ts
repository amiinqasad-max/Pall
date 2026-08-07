/**
 * Analytics.
 *
 * Events are buffered locally and flushed in batches, so a player on a train
 * with no signal loses nothing and the game never blocks on a network call.
 * The buffer is capped and drops oldest-first; telemetry must never be the
 * reason a device runs out of storage.
 *
 * What is deliberately not collected: no advertising identifiers, no
 * cross-site identifiers, no precise location. The user id is the anonymous
 * Supabase id, and country is coarse (ISO-2, derived server-side from the
 * request) only so the leaderboard can show a flag.
 */

import { storage } from '@/systems/storage';
import { dayKey } from '@/core/time';

export interface AnalyticsEvent {
  name: string;
  props: Record<string, unknown>;
  at: number;
  /** Session-scoped sequence number, so ordering survives out-of-order flushes. */
  seq: number;
}

const BUFFER_KEY = 'analytics.buffer';
const SESSION_KEY = 'analytics.session';
const MAX_BUFFER = 400;
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_AT_COUNT = 25;

type Sink = (events: AnalyticsEvent[]) => Promise<boolean>;

class Analytics {
  private buffer: AnalyticsEvent[] = [];
  private seq = 0;
  private sink: Sink | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sessionId = '';
  private sessionStart = 0;
  private flushing = false;
  private enabled = true;

  async init(): Promise<void> {
    this.sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.sessionStart = Date.now();
    this.buffer = (await storage.get<AnalyticsEvent[]>(BUFFER_KEY)) ?? [];

    // Retention signal: how many distinct days this install has opened, and
    // whether today is a return visit.
    const seen = (await storage.get<string[]>(SESSION_KEY)) ?? [];
    const today = dayKey();
    const isNewDay = !seen.includes(today);
    if (isNewDay) {
      seen.push(today);
      await storage.set(SESSION_KEY, seen.slice(-60));
    }

    this.track('session_start', {
      daysActive: seen.length,
      returning: seen.length > 1,
      newDay: isNewDay,
      standalone: window.matchMedia?.('(display-mode: standalone)').matches ?? false,
      referrer: document.referrer ? new URL(document.referrer).hostname : null,
      language: navigator.language,
      hardwareConcurrency: navigator.hardwareConcurrency ?? null,
      deviceMemory: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    });

    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        this.track('session_pause', { elapsedMs: Date.now() - this.sessionStart });
        void this.flush(true);
      } else {
        this.track('session_resume', {});
      }
    });
    window.addEventListener('pagehide', () => {
      this.track('session_end', { durationMs: Date.now() - this.sessionStart });
      void this.flush(true);
    });
  }

  /** Stops the periodic flush. Used by tests and hot-reload teardown. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Wired up by the Supabase layer once a session exists. */
  setSink(sink: Sink | null): void {
    this.sink = sink;
    if (sink) void this.flush();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  track(name: string, props: Record<string, unknown>): void {
    if (!this.enabled) return;
    this.buffer.push({ name, props, at: Date.now(), seq: this.seq++ });
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    void storage.set(BUFFER_KEY, this.buffer);
    if (this.buffer.length >= FLUSH_AT_COUNT) void this.flush();
  }

  /** Performance sampling, called once a minute from the game loop. */
  trackPerformance(sample: { fps: number; minFps: number; drawCalls: number; entities: number; tier: string }): void {
    this.track('perf_sample', sample);
  }

  async flush(useBeacon = false): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    if (!navigator.onLine) return;
    if (!this.sink) return;

    this.flushing = true;
    const batch = this.buffer.slice(0, 100);
    try {
      const ok = useBeacon ? await this.sinkWithBeacon(batch) : await this.sink(batch);
      if (ok) {
        this.buffer = this.buffer.slice(batch.length);
        await storage.set(BUFFER_KEY, this.buffer);
      }
    } catch {
      // Keep the batch; the next tick retries it.
    } finally {
      this.flushing = false;
    }
  }

  private async sinkWithBeacon(batch: AnalyticsEvent[]): Promise<boolean> {
    // On pagehide a normal fetch is often killed mid-flight; the sink handles
    // keepalive itself, and we fall back to it if the beacon path is missing.
    return this.sink ? this.sink(batch) : false;
  }

  get session(): string {
    return this.sessionId;
  }
}

export const analytics = new Analytics();
