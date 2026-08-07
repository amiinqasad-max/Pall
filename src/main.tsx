import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@/ui/App';
import '@/ui/styles/global.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * Service worker registration.
 *
 * Production only — in dev it would serve stale bundles and cost an hour of
 * confusion. Registration is deferred until after load so it never competes
 * with the first paint for bandwidth on a slow connection.
 */
declare const __TARTAN_STANDALONE__: boolean | undefined;
const standalone = typeof __TARTAN_STANDALONE__ !== 'undefined' && __TARTAN_STANDALONE__;

if ('serviceWorker' in navigator && import.meta.env.PROD && !standalone) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        // A new build is live: install it and take over immediately.
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              installing.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });

        // An installed PWA can sit on a stale build for a long time: the new
        // worker activates, but the page already running keeps executing the
        // old bundle until something happens to reload it. Reload once when
        // control changes so a returning player always lands on the current
        // version — but never mid-run, because dropping someone's run to ship
        // a patch is worse than shipping it a minute later.
        let reloading = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          if (reloading) return;
          if (new URLSearchParams(location.search).get('screen') === 'play') return;
          if (document.querySelector('.stage canvas')) return;
          reloading = true;
          location.reload();
        });

        // Check for a new build when the app comes back to the foreground.
        // Without this an installed PWA only ever checks at cold start, which
        // on mobile can be days apart.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void registration.update();
        });
      })
      .catch(() => {
        // No service worker means no offline play, but the game still runs.
      });
  });
}
