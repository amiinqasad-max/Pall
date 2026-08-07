/**
 * Ad presentation layer.
 *
 * Two jobs:
 *
 *   1. While a real SDK ad is on screen, cover the app with an opaque veil.
 *      The game is already paused; the veil guarantees no stray tap reaches a
 *      control underneath, which is both a policy requirement and simply the
 *      right behaviour.
 *
 *   2. When no ad can be served — blocked, offline, no fill, or no AdSense
 *      client configured — present the house panel instead. It is labelled for
 *      what it is. It does not imitate a third-party ad, it does not fake a
 *      close button, and the reward is granted either way.
 */

import { useEffect, useRef, useState } from 'react';
import { ads, type AdPlacement } from '@/systems/ads';
import { useUi } from '@/state/ui';
import { Button } from '@/ui/components/primitives';

const HOUSE_DURATION_SECONDS = 5;

const PROMOS: { title: string; body: string; icon: string }[] = [
  {
    icon: '📲',
    title: 'Install TARTAN',
    body: 'Add it to your home screen for instant loading and full offline play.',
  },
  {
    icon: '🏆',
    title: 'Chase the daily',
    body: 'Every player gets the same challenge and the same track. Beat it once a day.',
  },
  {
    icon: '◈',
    title: 'Nine ball skins',
    body: 'All cosmetic, all earnable. Nothing in the store makes you faster.',
  },
  {
    icon: '⚡',
    title: 'Keep your streak',
    body: 'Log in tomorrow to keep the login streak climbing toward the Day 30 payout.',
  },
];

interface HouseRequest {
  placement: AdPlacement;
  kind: 'rewarded' | 'interstitial';
  resolve: (completed: boolean) => void;
}

export function AdOverlay() {
  const adShowing = useUi((s) => s.adShowing);
  const [house, setHouse] = useState<HouseRequest | null>(null);
  const [remaining, setRemaining] = useState(HOUSE_DURATION_SECONDS);
  const promo = useRef(PROMOS[Math.floor(Math.random() * PROMOS.length)]);

  // Register the fallback handler once, for the lifetime of the app.
  useEffect(() => {
    ads.setUiHandler(
      (request) =>
        new Promise<boolean>((resolve) => {
          if (!request) {
            resolve(false);
            return;
          }
          promo.current = PROMOS[Math.floor(Math.random() * PROMOS.length)];
          setRemaining(HOUSE_DURATION_SECONDS);
          setHouse({ placement: request.placement, kind: request.kind, resolve });
        }),
    );
    return () => ads.setUiHandler(null);
  }, []);

  // Countdown for the house panel.
  useEffect(() => {
    if (!house) return;
    if (remaining <= 0) return;
    const timer = setTimeout(() => setRemaining((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [house, remaining]);

  const close = (completed: boolean): void => {
    house?.resolve(completed);
    setHouse(null);
  };

  if (house) {
    const done = remaining <= 0;
    return (
      <div className="overlay" role="dialog" aria-modal="true" aria-label="Sponsor message">
        <div className="sheet adpanel">
          <p className="tiny dim" style={{ letterSpacing: '0.14em', textTransform: 'uppercase', margin: 0 }}>
            TARTAN message
          </p>
          <div className="adpanel__frame">
            <div style={{ fontSize: '2.5rem' }} aria-hidden="true">
              {promo.current.icon}
            </div>
            <h3 style={{ margin: '0.5rem 0 0.25rem' }}>{promo.current.title}</h3>
            <p className="small muted" style={{ margin: 0 }}>
              {promo.current.body}
            </p>
          </div>

          {!done ? (
            <>
              <div className="adpanel__timer numeric">{remaining}</div>
              <p className="tiny dim">
                {house.kind === 'rewarded'
                  ? 'Your reward unlocks when this finishes.'
                  : 'Returning to the game shortly.'}
              </p>
            </>
          ) : (
            <div className="stack">
              <Button variant="primary" block onClick={() => close(true)}>
                {house.kind === 'rewarded' ? 'Claim reward' : 'Continue'}
              </Button>
            </div>
          )}

          {!done && house.kind === 'rewarded' && (
            <Button variant="ghost" size="sm" block onClick={() => close(false)}>
              No thanks
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (!adShowing) return null;

  // Veil for a real SDK ad: the creative renders in its own layer above this.
  return (
    <div className="overlay" aria-hidden="true" style={{ background: 'rgba(4, 10, 14, 0.94)' }}>
      <div className="center stack">
        <div className="brandmark" style={{ fontSize: '1.5rem' }}>
          TARTAN
        </div>
        <p className="small muted">Loading advertisement…</p>
      </div>
    </div>
  );
}
