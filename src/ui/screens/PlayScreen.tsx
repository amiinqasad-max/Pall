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
import { AD_REWARDS, REWARDED_DAILY_CAP, ads } from '@/systems/ads';
import { audio } from '@/systems/audio';
import { haptics } from '@/systems/haptics';
import { analytics } from '@/systems/analytics';
import { submitRun } from '@/services/leaderboard';
import { dailyChallenge } from '@/data/missions';
import { levelFromXp } from '@/data/progression';
import { storage } from '@/systems/storage';
import { GameHud } from '@/ui/components/GameHud';
import { Button, Meter, StatGrid } from '@/ui/components/primitives';
import { distance as fmtDistance, num } from '@/core/format';
import { formatDuration } from '@/core/time';
import { dayKey } from '@/core/time';
import type { RunResult } from '@/types';

type Phase = 'loading' | 'playing' | 'paused' | 'offer' | 'results';

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

  const stageRef = useRef<HTMLDivElement>(null);
  const engine = useRef<GameModule | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [offer, setOffer] = useState<{ result: RunResult; cause: string } | null>(null);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [coinAdsLeft, setCoinAdsLeft] = useState(REWARDED_DAILY_CAP);
  const [coinClaimed, setCoinClaimed] = useState(false);

  // The loadout is frozen for the whole run: changing a skin mid-run from
  // another tab must not reach into the live scene.
  const loadout = useRef({
    skinId: save.equipped.skin,
    trailId: save.equipped.trail,
    environmentId: save.environment,
    daily: useUi.getState().previous === 'daily',
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

    const isDaily = loadout.current.daily && !save.daily.completed;
    const challenge = dailyChallenge(dayKey());

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
        seed: isDaily ? challenge.seed : undefined,
        reducedMotion: save.settings.reducedMotion || device.reducedMotion,
      });

      setPhase('playing');
      analytics.track('run_started', { daily: isDaily, tier, skin: loadout.current.skinId });
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
      const outcome = completeRun(result);
      setSummary(outcome);
      setPhase('results');
      setCoinClaimed(false);

      void ads.noteRunFinished();

      if (outcome.rejected) {
        analytics.track('run_not_submitted', { reason: outcome.rejected });
      } else {
        const level = levelFromXp(useStore.getState().save.player.totalXp).level;
        void submitRun(result, useStore.getState().save.player.username, level);
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

  const restart = async (): Promise<void> => {
    // Interstitials live here — between sessions, never mid-run.
    await ads.interstitial();
    setSummary(null);
    setOffer(null);
    setPhase('playing');
    // Remounting the screen is the cleanest possible reset: the effect above
    // tears the old canvas down and builds a fresh one.
    go('home');
    setTimeout(() => go('play'), 30);
  };

  const exit = async (): Promise<void> => {
    await ads.interstitial();
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
              <Button variant="ghost" block onClick={declineContinue}>
                End run
              </Button>
            </div>
          </div>
        </div>
      )}

      {phase === 'results' && summary && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Run complete">
          <div className="sheet">
            <div className="center">
              {summary.newRecord && <div className="result__record">New personal best</div>}
              <div className="result__label">Score</div>
              <div className="result__score">{num(summary.result.score)}</div>
              <div className="small muted" style={{ marginTop: 4 }}>
                Best {num(Math.max(summary.previousBest, summary.result.score))}
              </div>
            </div>

            {summary.rejected && (
              <p className="tiny center" style={{ color: 'var(--danger)', marginTop: 'var(--sp-3)' }}>
                This run could not be verified and was not recorded.
              </p>
            )}

            <div style={{ margin: 'var(--sp-4) 0' }}>
              <StatGrid
                items={[
                  { label: 'Distance', value: fmtDistance(summary.result.distance) },
                  { label: 'Time', value: formatDuration(summary.result.durationMs) },
                  { label: 'Prisms', value: num(summary.result.prisms) },
                  { label: 'Dodged', value: num(summary.result.obstaclesDodged) },
                  { label: 'Near miss', value: num(summary.result.nearMisses) },
                  { label: 'Top speed', value: `${Math.round(summary.result.topSpeed * 3.6)} km/h` },
                ]}
              />
            </div>

            <div style={{ marginBottom: 'var(--sp-4)' }}>
              <div className="row row--between tiny muted" style={{ marginBottom: 4 }}>
                <span>Level {level.level}</span>
                <span className="numeric">+{num(summary.xpGained)} XP</span>
              </div>
              <Meter value={level.progress} />
              {summary.levelsGained > 0 && (
                <p className="tiny center" style={{ color: 'var(--teal-bright)', marginTop: 6 }}>
                  Level up! {summary.levelsGained > 1 ? `+${summary.levelsGained} levels` : ''}
                </p>
              )}
            </div>

            {summary.missionsCompleted.length > 0 && (
              <div className="panel" style={{ marginBottom: 'var(--sp-3)' }}>
                <div className="panel__title" style={{ marginBottom: 'var(--sp-2)' }}>
                  Missions complete
                </div>
                {summary.missionsCompleted.map((mission) => (
                  <div key={mission.id} className="small row row--between">
                    <span>{mission.title}</span>
                    <span className="dim">+{mission.xp} XP</span>
                  </div>
                ))}
              </div>
            )}

            {summary.challengeCompleted && (
              <div className="panel panel--accent center" style={{ marginBottom: 'var(--sp-3)' }}>
                <div className="strong">Daily challenge complete</div>
                <Button size="sm" variant="amber" onClick={() => go('daily')} className="btn--block">
                  Claim reward
                </Button>
              </div>
            )}

            <div className="stack">
              {!coinClaimed && coinAdsLeft > 0 && (
                <Button variant="amber" block disabled={busy} onClick={() => void claimCoinAd()}>
                  {busy ? 'Loading…' : `▶ Watch ad for ${AD_REWARDS.reward_coins} coins`}
                </Button>
              )}
              {coinClaimed && (
                <p className="tiny center dim" style={{ margin: 0 }}>
                  Bonus collected. {coinAdsLeft} more available today.
                </p>
              )}
              <Button variant="primary" size="lg" block onClick={() => void restart()}>
                Run again
              </Button>
              <Button variant="ghost" block onClick={() => void exit()}>
                Home
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
