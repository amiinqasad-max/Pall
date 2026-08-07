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
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        // A new build is live: swap it in on the next launch rather than
        // yanking the bundle out from under someone mid-run.
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              installing.postMessage({ type: 'SKIP_WAITING' });
            }
          });
        });
      })
      .catch(() => {
        // No service worker means no offline play, but the game still runs.
      });
  });
}
