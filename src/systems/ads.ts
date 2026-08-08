/**
 * Advertising.
 *
 * Built against Google's H5 Games Ads API (the `adBreak`/`adConfig` surface
 * that ships with the AdSense tag), because that is the only Google product
 * that actually serves a rewarded format to a web game.
 *
 * Policy, enforced here in code rather than left to call sites:
 *   - Rewarded ads are opt-in only. Nothing is ever shown without a tap on a
 *     button that states the reward first.
 *   - There are no interstitials. Not capped, not delayed — none. Every ad in
 *     this game is one the player asked for by tapping a button that named the
 *     reward first. An unskippable ad between runs is the single most reliable
 *     way to end a session, and a session that ends is worth less than the
 *     impression.
 *   - The game pauses and mutes for the duration, and controls are released
 *     before the ad is requested, so no tap can land on an ad by accident.
 *
 * When the SDK is absent — no client id configured, ad blocker, offline, or a
 * region with no fill — `HouseAdProvider` takes over. It shows an honest
 * in-game promo panel and still grants the reward. A player who blocks ads
 * gets a slightly worse deal, never a broken game.
 */

import { analytics } from '@/systems/analytics';
import { storage } from '@/systems/storage';

export type AdPlacement =
  | 'reward_coins'
  | 'reward_continue'
  | 'reward_double'
  | 'reward_daily_bonus'
  | 'reward_mystery'
  /** The Store's "Watch Video" earn method (see state/economy.ts) — a
   *  separate, smaller, server-tracked reward from reward_coins' own
   *  post-run bonus, so it gets its own placement label rather than
   *  sharing frequency-capping/analytics with an unrelated flow. */
  | 'reward_video_coins';

export type AdOutcome = {
  completed: boolean;
  /** Why an ad did not complete — useful for both analytics and messaging. */
  reason?: 'dismissed' | 'no_fill' | 'error' | 'frequency_capped' | 'blocked' | 'already_showing';
  /** True when the house fallback served instead of a real ad. */
  house?: boolean;
};

type AdBreakPlacement = {
  type: 'reward' | 'next' | 'browse' | 'start' | 'pause';
  name: string;
  beforeAd?: () => void;
  afterAd?: () => void;
  beforeReward?: (showAdFn: () => void) => void;
  adDismissed?: () => void;
  adViewed?: () => void;
  adBreakDone?: (info: { breakStatus: string }) => void;
};

declare global {
  interface Window {
    adBreak?: (placement: AdBreakPlacement) => void;
    adConfig?: (config: Record<string, unknown>) => void;
    adsbygoogle?: unknown[];
  }
}

const FREQ_KEY = 'ads.frequency';
const CLIENT_ID = import.meta.env.VITE_ADSENSE_CLIENT as string | undefined;

interface FrequencyState {
  day: string;
  shownToday: number;
  lastShownAt: number;
  totalRuns: number;
}

/** UI hook so React can render the house-ad panel and the "ad playing" veil. */
export type AdUiHandler = (
  request: { placement: AdPlacement; kind: 'rewarded'; house: boolean } | null,
) => Promise<boolean> | boolean;

class AdManager {
  private sdkReady = false;
  private sdkFailed = false;
  private showing = false;
  private frequency: FrequencyState = { day: '', shownToday: 0, lastShownAt: 0, totalRuns: 0 };
  private uiHandler: AdUiHandler | null = null;
  private onStateChange: ((showing: boolean) => void) | null = null;

  async init(): Promise<void> {
    this.frequency = (await storage.get<FrequencyState>(FREQ_KEY)) ?? this.frequency;
    if (!CLIENT_ID) {
      // No client id configured (the default for a fresh clone). House ads only.
      this.sdkFailed = true;
      return;
    }
    try {
      await this.loadSdk(CLIENT_ID);
      window.adConfig?.({
        preloadAdBreaks: 'on',
        sound: 'on',
        onReady: () => {
          this.sdkReady = true;
        },
      });
      this.sdkReady = true;
    } catch {
      this.sdkFailed = true;
      analytics.track('ad_sdk_blocked', {});
    }
  }

  private loadSdk(clientId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (document.querySelector('script[data-tartan-ads]')) return resolve();
      const script = document.createElement('script');
      script.async = true;
      script.dataset.tartanAds = 'true';
      script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(clientId)}`;
      script.crossOrigin = 'anonymous';
      script.setAttribute('data-ad-frequency-hint', '60s');
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('ad sdk failed'));
      document.head.appendChild(script);
      // An ad blocker often leaves the request hanging rather than erroring.
      setTimeout(() => (this.sdkReady ? resolve() : reject(new Error('ad sdk timeout'))), 4000);
    });
  }

  setUiHandler(handler: AdUiHandler | null): void {
    this.uiHandler = handler;
  }

  setStateListener(listener: ((showing: boolean) => void) | null): void {
    this.onStateChange = listener;
  }

  get isShowing(): boolean {
    return this.showing;
  }

  /** Lifetime run counter, kept for analytics and reward pacing. */
  async noteRunFinished(): Promise<void> {
    this.frequency = { ...this.frequency, totalRuns: this.frequency.totalRuns + 1 };
    await storage.set(FREQ_KEY, this.frequency);
  }

  /**
   * Rewarded ad. Always user-initiated: the caller has already shown a button
   * naming the reward, and the promise resolves only after the ad completes.
   */
  async rewarded(placement: AdPlacement): Promise<AdOutcome> {
    if (this.showing) return { completed: false, reason: 'already_showing' };

    analytics.track('ad_requested', { placement, kind: 'rewarded' });
    this.setShowing(true);
    try {
      const outcome = this.canUseSdk()
        ? await this.showSdkRewarded(placement)
        : await this.showHouseAd(placement, 'rewarded');

      // No fill is common on a new site. Falling back keeps the reward loop
      // intact rather than dead-ending the player.
      const final =
        !outcome.completed && (outcome.reason === 'no_fill' || outcome.reason === 'error')
          ? await this.showHouseAd(placement, 'rewarded')
          : outcome;

      analytics.track('ad_result', {
        placement,
        kind: 'rewarded',
        completed: final.completed,
        reason: final.reason ?? null,
        house: Boolean(final.house),
      });
      return final;
    } finally {
      this.setShowing(false);
    }
  }

  private canUseSdk(): boolean {
    return this.sdkReady && !this.sdkFailed && typeof window.adBreak === 'function' && navigator.onLine;
  }

  private setShowing(showing: boolean): void {
    this.showing = showing;
    this.onStateChange?.(showing);
  }

  private showSdkRewarded(placement: AdPlacement): Promise<AdOutcome> {
    return new Promise((resolve) => {
      let settled = false;
      let earned = false;
      const finish = (outcome: AdOutcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      // The SDK can hang if the creative fails to render. Bail out and let the
      // house ad take over rather than leaving the player on a dead screen.
      const timeout = setTimeout(() => finish({ completed: false, reason: 'error' }), 45_000);

      try {
        window.adBreak!({
          type: 'reward',
          name: placement,
          beforeReward: (showAdFn) => showAdFn(),
          adViewed: () => {
            earned = true;
          },
          adDismissed: () => {
            clearTimeout(timeout);
            finish({ completed: false, reason: 'dismissed' });
          },
          adBreakDone: (info) => {
            clearTimeout(timeout);
            if (earned || info.breakStatus === 'viewed') finish({ completed: true });
            else if (info.breakStatus === 'dismissed') finish({ completed: false, reason: 'dismissed' });
            else finish({ completed: false, reason: 'no_fill' });
          },
        });
      } catch {
        clearTimeout(timeout);
        finish({ completed: false, reason: 'error' });
      }
    });
  }

  /** Hands control to React, which renders the fallback promo panel. */
  private async showHouseAd(placement: AdPlacement, kind: 'rewarded'): Promise<AdOutcome> {
    if (!this.uiHandler) return { completed: false, reason: 'blocked', house: true };
    const completed = await this.uiHandler({ placement, kind, house: true });
    return { completed, reason: completed ? undefined : 'dismissed', house: true };
  }

}

export const ads = new AdManager();

/** Coins granted per completed rewarded ad, by placement. */
export const AD_REWARDS: Record<string, number> = {
  reward_coins: 120,
  reward_daily_bonus: 200,
  reward_mystery: 260,
};

/** Multiplier applied to a run's XP when the player takes the double-up ad. */
export const DOUBLE_REWARD_MULTIPLIER = 2;

/** How many rewarded coin ads a player may take per day. */
export const REWARDED_DAILY_CAP = 8;
