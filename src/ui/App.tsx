/**
 * Application shell.
 *
 * Owns boot orchestration, the screen router, the global overlays (toasts, ad
 * veil) and the bottom navigation. Screens themselves are plain components
 * that read from the stores.
 */

import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/state/store';
import { useUi } from '@/state/ui';
import { analytics } from '@/systems/analytics';
import { ads } from '@/systems/ads';
import { sync } from '@/systems/sync';
import { audio } from '@/systems/audio';
import { haptics } from '@/systems/haptics';
import { attachAnalyticsSink } from '@/services/supabase';
import { detectDevice } from '@/systems/device';
import { requestPersistence } from '@/systems/storage';
import { HomeScreen } from '@/ui/screens/HomeScreen';
import { PlayScreen } from '@/ui/screens/PlayScreen';
import { StoreScreen } from '@/ui/screens/StoreScreen';
import { ProfileScreen } from '@/ui/screens/ProfileScreen';
import { LeaderboardScreen } from '@/ui/screens/LeaderboardScreen';
import { SettingsScreen } from '@/ui/screens/SettingsScreen';
import { MissionsScreen } from '@/ui/screens/MissionsScreen';
import { DailyScreen } from '@/ui/screens/DailyScreen';
import { Toasts } from '@/ui/components/Toasts';
import { AdOverlay } from '@/ui/components/AdOverlay';
import { NavBar } from '@/ui/components/NavBar';
import { MenuBackdrop } from '@/ui/components/MenuBackdrop';
import { DailyRewardModal } from '@/ui/components/DailyRewardModal';
import { feedback } from '@/ui/components/primitives';
import type { ScreenId } from '@/types';

const NAV_SCREENS: ScreenId[] = ['home', 'store', 'missions', 'leaderboard', 'profile'];

export function App() {
  const ready = useStore((s) => s.ready);
  const settings = useStore((s) => s.save.settings);
  const screen = useUi((s) => s.screen);
  const [booted, setBooted] = useState(false);
  const bootStarted = useRef(false);

  // --- Boot -------------------------------------------------------------------
  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;

    const boot = async (): Promise<void> => {
      const device = detectDevice();
      await analytics.init();
      analytics.track('boot', { tier: device.tier, cores: device.cores, memory: device.memoryGb });

      await useStore.getState().init();
      await requestPersistence();

      // Backend work is fire-and-forget: none of it may delay first paint.
      attachAnalyticsSink();
      void ads.init();
      void sync.start();

      // Splash minimum dwell. Boot is usually faster than this, and a splash
      // that flashes for 90ms looks broken rather than fast.
      const elapsed = performance.now();
      if (elapsed < 900) await new Promise((resolve) => setTimeout(resolve, 900 - elapsed));

      document.getElementById('boot')?.classList.add('gone');
      setTimeout(() => document.getElementById('boot')?.remove(), 500);

      setBooted(true);
      useUi.getState().go('home');
    };

    void boot();
  }, []);

  // --- Settings propagation ---------------------------------------------------
  useEffect(() => {
    audio.configure(settings);
    haptics.setEnabled(settings.haptics);
    analytics.setEnabled(settings.analytics);

    // Exposes the resolved quality tier as a root attribute so the menu
    // chrome (card float, play-button breathe/sheen, nav-dot pulse, etc. in
    // global.css) can shed itself on the weakest devices independently of
    // the OS-level prefers-reduced-motion flag — a device can be ultraLow
    // without the player having asked for reduced motion.
    const resolved = settings.quality === 'auto' ? detectDevice().tier : settings.quality;
    document.documentElement.dataset.perfTier = resolved;
  }, [settings]);

  // --- Audio unlock -----------------------------------------------------------
  // Browsers only allow an AudioContext to start inside a user gesture, so the
  // first tap anywhere in the app is what actually brings sound online.
  useEffect(() => {
    if (!booted) return;
    const unlock = (): void => {
      audio.unlock();
      audio.configure(useStore.getState().save.settings);
      if (useUi.getState().screen !== 'play') audio.startMusic();
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, [booted]);

  // --- Ad UI plumbing ---------------------------------------------------------
  useEffect(() => {
    ads.setStateListener((showing) => useUi.getState().setAdShowing(showing));
    return () => ads.setStateListener(null);
  }, []);

  // --- Daily / weekly rollover while the app is open --------------------------
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return;
      useStore.getState().refreshPeriodic();
    };
    document.addEventListener('visibilitychange', onVisible);
    // Also handles a device left open across UTC midnight.
    const interval = setInterval(onVisible, 60_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(interval);
    };
  }, []);

  // --- Music follows the screen ----------------------------------------------
  useEffect(() => {
    if (!booted || !audio.isStarted) return;
    if (screen === 'play') audio.setIntensity(0.5);
    else audio.setIntensity(0.18);
  }, [screen, booted]);

  // --- Android back button ----------------------------------------------------
  useEffect(() => {
    const onPop = (): void => {
      const current = useUi.getState().screen;
      if (current === 'home') return;
      feedback('back');
      useUi.getState().go('home');
      history.pushState(null, '', location.href);
    };
    history.pushState(null, '', location.href);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // --- Deep links from the PWA shortcuts --------------------------------------
  useEffect(() => {
    if (!booted) return;
    const target = new URLSearchParams(location.search).get('screen');
    if (target && ['play', 'daily', 'leaderboard', 'store'].includes(target)) {
      useUi.getState().go(target as ScreenId);
    }
  }, [booted]);

  if (!ready || !booted) return null;

  return (
    <div className="app">
      {/* Unmounted during a run: the canvas covers it completely, and paying
          for five composited layers behind an opaque WebGL surface is the kind
          of cost that only shows up on the phones that can least afford it. */}
      {screen !== 'play' && <MenuBackdrop />}

      <main className="screen screen-enter" key={screen}>
        {screen === 'home' && <HomeScreen />}
        {screen === 'play' && <PlayScreen />}
        {screen === 'store' && <StoreScreen />}
        {screen === 'missions' && <MissionsScreen />}
        {screen === 'leaderboard' && <LeaderboardScreen />}
        {screen === 'profile' && <ProfileScreen />}
        {screen === 'settings' && <SettingsScreen />}
        {screen === 'daily' && <DailyScreen />}
      </main>

      {NAV_SCREENS.includes(screen) && <NavBar />}

      <DailyRewardModal />
      <Toasts />
      {/* Always mounted: it owns the house-ad fallback handler, which must be
          registered before any placement is requested. */}
      <AdOverlay />
    </div>
  );
}
