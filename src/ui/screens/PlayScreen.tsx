/**
 * The play screen.
 *
 * Hosts the Phaser canvas and every state the run can be in: countdown, live,
 * paused, the continue offer, and the results sheet. The canvas is created on
 * mount and destroyed on unmount, so leaving the screen genuinely frees the
 * WebGL context and the texture set.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, type RunSummary } from '@/state/store';
import { useUi } from '@/state/ui';
import { gameEvents } from '@/game/events';
import { detectDevice, qualityFor } from '@/systems/device';
import { AD_REWARDS, DOUBLE_REWARD_MULTIPLIER, REWARDED_DAILY_CAP, ads } from '@/systems/ads';
import { audio } from '@/systems/audio';
import { haptics } from '@/systems/haptics';
import { analytics } from '@/systems/analytics';
import { submitRun } from '@/services/leaderboard';
import { REVIVE_COST_COINS, spendCoinsForRevive } from '@/services/championship';
import { championshipSessionId, useChampionship } from '@/state/championship';
import { dailyChallenge } from '@/data/missions';
import { levelFromXp } from '@/data/progression';
import { storage } from '@/systems/storage';
import { GameHud } from '@/ui/components/GameHud';
import { Button } from '@/ui/components/primitives';
import { ResultsSheet } from '@/ui/components/ResultsSheet';
import { num } from '@/core/format';
import { dayKey } from '@/core/time';
import type { RunResult } from '@/types';

type Phase = 'loading' | 'playing' | 'paused' | 'offer' | 'results';

/** Which screen sent the player here decides which mode this run plays in.
 *  Mirrors the existing `daily` inference below — no separate nav param. */
function championshipPhaseFromNav(): 'qualifying' | 'final' | undefined {
  const previous = useUi.getState().previous;
  if (previous === 'championship') return 'qualifying';
  if (previous === 'championshipFinal') return 'final';
  return undefined;
}

/**
 * The engine is a lazy chunk. Phaser is ~320KB gzipped — a third of the whole
 * download — and none of it is needed to render the menus, so it is fetched
 * the first time a player actually presses Play. The service worker caches it
 * after that, making every later run instant and available offline.
 */
type GameModule = typeof import('@/game/index');

const REWARD_COUNT_KEY = 'ads.rewardedToday';

export function PlayScreen() {
  const go = useUi((s) => s.go);
  const toast = useUi((s) => s.toast);
  const save = useStore((s) => s.save);
  const completeRun = useStore((s) => s.completeRun);
  const earnCoins = useStore((s) => s.earnCoins);
  const addXp = useStore((s) => s.addXp);

  const stageRef = useRef<HTMLDivElement>(null);
  const engine = useRef<GameModule | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [offer, setOffer] = useState<{ result: RunResult; cause: string } | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [coinAdsLeft, setCoinAdsLeft] = useState(REWARDED_DAILY_CAP);
  const [coinClaimed, setCoinClaimed] = useState(false);
  const [doubled, setDoubled] = useState(false);
  const [reviving, setReviving] = useState(false);
  const [championshipResult, setChampionshipResult] = useState<string | null>(null);
  const coins = useStore((s) => s.save.wallet.coins);

  // The loadout is frozen for the whole run: changing a skin mid-run from
  // another tab must not reach into the live scene.
  const loadout = useRef({
    skinId: save.equipped.skin,
    trailId: save.equipped.trail,
    environmentId: save.environment,
    daily: useUi.getState().previous === 'daily',
    championshipPhase: championshipPhaseFromNav(),
    seed: undefined as number | undefined,
  });

  // --- Launch -----------------------------------------------------------------
  useEffect(() => {
    const container = stageRef.current;
    if (!container) return;
    let cancelled = false;

    const device = detectDevice();
    const requested = save.settings.quality;
    const tier = requested === 'auto' ? device.tier : requested;
    const quality = qualityFor(tier);

    // The Championship and the (unrelated) mission-style daily challenge
    // never overlap — a run is one or the other, never both.
    const championshipPhase = loadout.current.championshipPhase;
    const isDaily = !championshipPhase && loadout.current.daily && !save.daily.completed;
    const challenge = dailyChallenge(dayKey());
    const championshipChallenge = useChampionship.getState().challenge;
    const championshipSeed =
      championshipPhase === 'qualifying'
        ? championshipChallenge?.qualificationTrackSeed
        : championshipPhase === 'final'
          ? championshipChallenge?.finalTrackSeed
          : undefined;

    void (async () => {
      const mod = await import('@/game/index');
      // The player navigated away while the chunk was in flight.
      if (cancelled || !stageRef.current) return;
      engine.current = mod;

      mod.launchGame({
        parent: container,
        skinId: loadout.current.skinId,
        trailId: loadout.current.trailId,
        environmentId: loadout.current.environmentId,
        tier,
        resolutionCap: quality.resolutionCap,
        daily: isDaily,
        seed: championshipPhase ? championshipSeed : isDaily ? challenge.seed : undefined,
        championshipPhase,
        reducedMotion: save.settings.reducedMotion || device.reducedMotion,
      });

      setPhase('playing');
      analytics.track('run_started', { daily: isDaily, championshipPhase, tier, skin: loadout.current.skinId });
    })();

    return () => {
      cancelled = true;
      engine.current?.destroyGame();
      engine.current = null;
    };
    // Intentionally launch once per mount; changing settings mid-run must not
    // rebuild the canvas underneath the player.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Rewarded-ad daily counter ---------------------------------------------
  useEffect(() => {
    void storage.get<{ day: string; count: number }>(REWARD_COUNT_KEY).then((record) => {
      const today = dayKey();
      const count = record?.day === today ? record.count : 0;
      setCoinAdsLeft(Math.max(0, REWARDED_DAILY_CAP - count));
    });
  }, []);

  const noteRewardTaken = useCallback(async () => {
    const today = dayKey();
    const record = await storage.get<{ day: string; count: number }>(REWARD_COUNT_KEY);
    const count = (record?.day === today ? record.count : 0) + 1;
    await storage.set(REWARD_COUNT_KEY, { day: today, count });
    setCoinAdsLeft(Math.max(0, REWARDED_DAILY_CAP - count));
  }, []);

  // --- Run lifecycle ----------------------------------------------------------
  useEffect(() => {
    const offDied = gameEvents.on('died', ({ result, canContinue, cause }) => {
      audio.play('gameover');
      if (canContinue) {
        setOffer({ result, cause });
        setPhase('offer');
      } else {
        // Nothing to offer, so end it immediately.
        engine.current?.finishGame();
      }
    });

    const offFinished = gameEvents.on('finished', ({ result }) => {
      // A Championship run still counts as "playing the game" for normal
      // progression (XP, missions, stats) — completeRun runs unconditionally.
      // The score that actually matters for qualification/prizes is reported
      // separately below, through the Championship's own server-authoritative
      // submission path, never through this local/free-leaderboard one.
      const outcome = completeRun(result);
      setSummary(outcome);
      setPhase('results');
      setCoinClaimed(false);
      setDoubled(false);

      void ads.noteRunFinished();

      if (outcome.rejected) {
        analytics.track('run_not_submitted', { reason: outcome.rejected });
      } else {
        const level = levelFromXp(useStore.getState().save.player.totalXp).level;
        void submitRun(result, useStore.getState().save.player.username, level);
      }

      const championshipPhase = loadout.current.championshipPhase;
      if (championshipPhase === 'qualifying') {
        void useChampionship.getState().reportQualificationRun(result).then(setChampionshipResult);
      } else if (championshipPhase === 'final') {
        void useChampionship.getState().reportFinalRun(result).then(setChampionshipResult);
      }

      if (outcome.newRecord) {
        audio.play('achievement');
        haptics.fire('success');
      }
      if (outcome.levelsGained > 0) audio.play('levelup');
    });

    const offPaused = gameEvents.on('paused', () => setPhase('paused'));
    const offResumed = gameEvents.on('resumed', () => setPhase('playing'));
    const offContinued = gameEvents.on('continued', () => {
      setPhase('playing');
      setOffer(null);
    });

    return () => {
      offDied();
      offFinished();
      offPaused();
      offResumed();
      offContinued();
    };
  }, [completeRun]);

  // Pause when the app goes to the background — losing a run to a phone call
  // is the fastest way to lose a player.
  useEffect(() => {
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') engine.current?.pauseGame();
    };
    document.addEventListener('visibilitychange', onHidden);
    return () => document.removeEventListener('visibilitychange', onHidden);
  }, []);

  // --- Actions ----------------------------------------------------------------

  const takeContinue = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const outcome = await ads.rewarded('reward_continue');
    setBusy(false);
    if (outcome.completed) {
      engine.current?.continueGame();
    } else {
      toast('No ad available right now', 'error');
      engine.current?.finishGame();
    }
  };

  const declineContinue = (): void => {
    setOffer(null);
    engine.current?.finishGame();
  };

  // Coin-priced revive. Never reachable during a Championship final: `die()`
  // in RunScene sets `canContinue = false` there, so the offer phase this
  // button lives in is never entered in the first place — see RunScene.die().
  const takeRevive = async (): Promise<void> => {
    if (busy || reviving) return;
    setReviving(true);
    const newBalance = await spendCoinsForRevive(championshipSessionId());
    setReviving(false);
    if (newBalance == null) {
      toast('Not enough coins', 'error');
      return;
    }
    useStore.getState().applyServerCoinBalance(newBalance);
    audio.play('boost');
    haptics.fire('success');
    engine.current?.continueGame();
  };

  const claimCoinAd = async (): Promise<void> => {
    if (busy || coinClaimed || coinAdsLeft <= 0) return;
    setBusy(true);
    const outcome = await ads.rewarded('reward_coins');
    setBusy(false);
    if (!outcome.completed) {
      toast('Reward not granted', 'error');
      return;
    }
    const amount = AD_REWARDS.reward_coins;
    earnCoins('rewarded_ad', amount, 'Post-run bonus');
    useStore.setState((state) => ({
      save: { ...state.save, stats: { ...state.save.stats, adsWatched: state.save.stats.adsWatched + 1 } },
    }));
    setCoinClaimed(true);
    void noteRewardTaken();
    audio.play('coin');
    haptics.fire('reward');
    toast(`+${amount} coins`, 'reward', '🪙');
  };

  const claimDouble = async (): Promise<void> => {
    if (busy || doubled || !summary) return;
    setBusy(true);
    const outcome = await ads.rewarded('reward_double');
    setBusy(false);
    if (!outcome.completed) {
      toast('Reward not granted', 'error');
      return;
    }
    // Doubling only ever *adds*; the run's own XP was already banked when it
    // finished, so this is a top-up rather than a recalculation.
    const bonus = summary.xpGained * (DOUBLE_REWARD_MULTIPLIER - 1);
    addXp(bonus, 'double_reward');
    setDoubled(true);
    void noteRewardTaken();
    audio.play('levelup');
    haptics.fire('reward');
    toast(`+${num(bonus)} bonus XP`, 'reward', '✨');
  };

  const restart = async (): Promise<void> => {
    setSummary(null);
    setOffer(null);
    setPhase('playing');
    // Remounting the screen is the cleanest possible reset: the effect above
    // tears the old canvas down and builds a fresh one.
    go('home');
    setTimeout(() => {
      // Guard against a stray forced navigation: if the player backed out to
      // somewhere other than home during this 30ms window (a rapid tap on the
      // nav bar, the Android back gesture), this must not yank them back into
      // a new run they no longer asked for.
      if (useUi.getState().screen === 'home') go('play');
    }, 30);
  };

  const exit = (): void => {
    go('home');
  };

  // --- Render -----------------------------------------------------------------

  const level = levelFromXp(save.player.totalXp);

  return (
    <div className="stage-wrap" style={{ position: 'absolute', inset: 0 }}>
      <div className="stage" ref={stageRef} />

      <GameHud
        visible={phase === 'playing'}
        showFps={save.settings.showFps}
        bestScore={save.stats.bestScore}
        onPause={() => engine.current?.pauseGame()}
      />

      {phase === 'loading' && (
        <div className="splash" aria-live="polite">
          <div className="brandmark splash__mark">TARTAN</div>
          <div className="bar" style={{ width: '9rem', height: 3, borderRadius: 99, background: '#ffffff1a' }}>
            <i
              style={{
                display: 'block',
                height: '100%',
                width: '40%',
                borderRadius: 99,
                background: 'linear-gradient(90deg, var(--teal), var(--amber))',
                animation: 'sheen 1.1s ease-in-out infinite',
              }}
            />
          </div>
          <p className="small muted">Building the track…</p>
        </div>
      )}

      {phase === 'paused' && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Paused">
          <div className="sheet center">
            <h2 className="sheet__title">Paused</h2>
            <p className="sheet__sub">Take your time. The track waits.</p>
            <div className="stack">
              <Button variant="primary" size="lg" block onClick={() => engine.current?.resumeGame()}>
                Resume
              </Button>
              <Button
                variant="ghost"
                block
                onClick={() => {
                  engine.current?.finishGame();
                }}
              >
                End run
              </Button>
            </div>
          </div>
        </div>
      )}

      {phase === 'offer' && offer && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Continue run">
          <div className="sheet center">
            <p className="result__label">{offer.cause} got you</p>
            <div className="result__score">{num(offer.result.score)}</div>
            <p className="sheet__sub" style={{ marginTop: 'var(--sp-3)' }}>
              Keep this run alive. One continue per run.
            </p>
            <div className="stack">
              <Button variant="amber" size="lg" block disabled={busy} onClick={() => void takeContinue()}>
                {busy ? 'Loading…' : '▶ Watch ad to continue'}
              </Button>
              {/* Normal-game monetization only — this offer phase is never
                  entered at all during a Championship final, so there is no
                  separate check needed here to keep it out of that mode. */}
              <Button
                variant="default"
                block
                disabled={reviving || coins < REVIVE_COST_COINS}
                onClick={() => void takeRevive()}
              >
                {reviving ? 'Reviving…' : `🪙 Revive for ${REVIVE_COST_COINS} coins`}
              </Button>
              <Button variant="ghost" block onClick={declineContinue}>
                End run
              </Button>
            </div>
          </div>
        </div>
      )}

      {phase === 'results' && summary && (
        <ResultsSheet
          summary={summary}
          level={level}
          coinAdsLeft={coinAdsLeft}
          coinClaimed={coinClaimed}
          busy={busy}
          reducedMotion={save.settings.reducedMotion}
          championshipPhase={loadout.current.championshipPhase}
          championshipResult={championshipResult}
          onClaimCoins={() => void claimCoinAd()}
          onDouble={() => void claimDouble()}
          onRestart={() => void restart()}
          onHome={exit}
          onDaily={() => go('daily')}
          onChampionship={() => go(loadout.current.championshipPhase === 'final' ? 'championshipFinal' : 'championship')}
        />
      )}
    </div>
  );
}
