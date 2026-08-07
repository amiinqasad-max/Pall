/**
 * Daily challenge.
 *
 * The same objective, the same target and — because the track generator is
 * seeded from the date — the same layout for every player on Earth. That is
 * what makes the daily leaderboard a fair comparison rather than a lottery.
 */

import { useEffect, useState } from 'react';
import { useStore } from '@/state/store';
import { useUi } from '@/state/ui';
import { dailyChallenge } from '@/data/missions';
import { formatCountdown, msUntilUtcMidnight } from '@/core/time';
import { audio } from '@/systems/audio';
import { haptics } from '@/systems/haptics';
import { Button, IconButton, Meter, Panel } from '@/ui/components/primitives';
import { num } from '@/core/format';

export function DailyScreen() {
  const go = useUi((s) => s.go);
  const toast = useUi((s) => s.toast);
  const save = useStore((s) => s.save);
  const claimChallenge = useStore((s) => s.claimDailyChallenge);
  const [resetIn, setResetIn] = useState(msUntilUtcMidnight());

  useEffect(() => {
    const timer = setInterval(() => setResetIn(msUntilUtcMidnight()), 1000);
    return () => clearInterval(timer);
  }, []);

  const challenge = dailyChallenge(save.daily.day);
  const progress = Math.min(1, save.daily.progress / challenge.target);

  const onClaim = (): void => {
    if (!claimChallenge()) return;
    audio.play('reward');
    haptics.fire('reward');
    toast(`+${num(challenge.coinReward)} coins`, 'reward', '🪙');
  };

  return (
    <>
      <header className="topbar">
        <IconButton icon="←" label="Back" onClick={() => go('home')} />
        <h1 className="topbar__title">Daily challenge</h1>
        <span className="tiny dim numeric">{formatCountdown(resetIn)}</span>
      </header>

      <div className="screen__body">
        <Panel accent className="center">
          <div className="result__label">{challenge.title}</div>
          <h2 style={{ margin: 'var(--sp-2) 0', fontSize: 'var(--fs-xl)' }}>{challenge.description}</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            Everyone plays the same track today.
          </p>

          <div style={{ margin: 'var(--sp-4) 0 var(--sp-2)' }}>
            <Meter value={progress} amber />
          </div>
          <div className="row row--between tiny muted">
            <span className="numeric">
              {num(Math.floor(save.daily.progress))} / {num(challenge.target)}
            </span>
            <span className="numeric">{save.daily.attempts} attempts</span>
          </div>
        </Panel>

        <Panel title="Reward" className="stack" >
          <div className="row row--between">
            <span className="small muted">Tartan coins</span>
            <span className="strong" style={{ color: 'var(--amber-bright)' }}>
              🪙 {num(challenge.coinReward)}
            </span>
          </div>
          <div className="row row--between">
            <span className="small muted">Experience</span>
            <span className="strong">{num(challenge.xpReward)} XP</span>
          </div>
        </Panel>

        <div className="stack" style={{ marginTop: 'var(--sp-4)' }}>
          {save.daily.completed && !save.daily.claimed && (
            <Button variant="amber" size="lg" block onClick={onClaim}>
              Claim {num(challenge.coinReward)} coins
            </Button>
          )}

          {save.daily.claimed ? (
            <>
              <p className="center small muted" style={{ margin: 0 }}>
                Completed today. Best score {num(save.daily.bestScore)}.
              </p>
              <Button variant="primary" size="lg" block onClick={() => go('play')}>
                Free run
              </Button>
            </>
          ) : (
            <Button variant="primary" size="lg" block onClick={() => go('play')}>
              {save.daily.completed ? 'Run again' : 'Start challenge run'}
            </Button>
          )}

          <Button variant="ghost" block onClick={() => go('leaderboard')}>
            Daily leaderboard
          </Button>
        </div>
      </div>
    </>
  );
}
