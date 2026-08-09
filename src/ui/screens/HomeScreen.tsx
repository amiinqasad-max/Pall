import { useEffect, useState } from 'react';
import { useStore, useLevel, useCoins, useMissions } from '@/state/store';
import { useUi } from '@/state/ui';
import { useChampionship } from '@/state/championship';
import { dailyChallenge } from '@/data/missions';
import { badgeForLevel } from '@/data/progression';
import { challengeProgressValue } from '@/state/store';
import { formatCountdown, msUntilUtcMidnight } from '@/core/time';
import { compact, num } from '@/core/format';
import { Button, CoinChip, Meter, Panel } from '@/ui/components/primitives';
import { ChampionshipHomeCard } from '@/ui/components/ChampionshipHomeCard';
import { InstallPrompt } from '@/ui/components/InstallPrompt';

export function HomeScreen() {
  const go = useUi((s) => s.go);
  const save = useStore((s) => s.save);
  const level = useLevel();
  const coins = useCoins();
  const daily = useMissions('daily');
  const [resetIn, setResetIn] = useState(msUntilUtcMidnight());
  const initChampionship = useChampionship((s) => s.init);

  useEffect(() => {
    const timer = setInterval(() => setResetIn(msUntilUtcMidnight()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    void initChampionship(save.player.country);
  }, [initChampionship, save.player.country]);

  const challenge = dailyChallenge(save.daily.day);
  const challengeProgress = Math.min(1, save.daily.progress / challenge.target);
  const badge = badgeForLevel(level.level);

  const missionsDone = daily.filter((m) => m.progress.progress >= m.def.target).length;

  return (
    <>
      <header className="topbar">
        <div className="brandmark" style={{ fontSize: '1.35rem' }}>
          TARTAN
        </div>
        <div className="topbar__spacer" />
        <CoinChip coins={coins} onClick={() => go('store')} />
        <button className="chip chip--level" onClick={() => go('profile')} aria-label={`Level ${level.level}`}>
          <span aria-hidden="true">{badge.glyph}</span>
          <span className="numeric">{level.level}</span>
        </button>
      </header>

      <div className="screen__body">
        <div className="stack">
          {/* Personal best is the headline number: this is a chase-the-record game. */}
          <Panel accent float>
            <div className="row row--between">
              <div>
                <div className="result__label">Best score</div>
                <div className="result__score">{num(save.stats.bestScore)}</div>
              </div>
              <div className="center">
                <div className="result__label">Runs</div>
                <div className="strong numeric" style={{ fontSize: 'var(--fs-lg)' }}>
                  {compact(save.stats.runs)}
                </div>
              </div>
            </div>
            <div style={{ marginTop: 'var(--sp-3)' }}>
              <div className="row row--between tiny muted" style={{ marginBottom: 4 }}>
                <span>Level {level.level}</span>
                <span className="numeric">
                  {level.xpForNext > 0 ? `${num(level.xpIntoLevel)} / ${num(level.xpForNext)} XP` : 'MAX'}
                </span>
              </div>
              <Meter value={level.progress} />
            </div>
          </Panel>

          <button className="playbtn" onClick={() => go('play')}>
            PLAY
          </button>

          {/* The Championship — distinct from the mission-style "Daily
              challenge" card below. Always rendered: loading, error,
              no-active-challenge, qualification, qualified, and ended/payout
              are all real states inside this one card, not conditions on
              whether to show it at all (see the component's own header for
              why that used to make the whole feature unreachable). */}
          <ChampionshipHomeCard />

          {/* Daily challenge: same target, same seed, everyone, every day. */}
          <Panel
            title="Daily challenge"
            tone="amber"
            float
            action={<span className="tiny dim numeric">{formatCountdown(resetIn)}</span>}
          >
            <div className="row row--between" style={{ marginBottom: 'var(--sp-2)' }}>
              <div style={{ minWidth: 0 }}>
                <div className="strong">{challenge.title}</div>
                <div className="small muted">{challenge.description}</div>
              </div>
              {save.daily.completed && !save.daily.claimed && <span className="badge badge--ready">Claim</span>}
              {save.daily.claimed && <span className="badge badge--done">Done</span>}
            </div>
            <Meter value={challengeProgress} amber />
            <div className="row row--between tiny muted" style={{ marginTop: 6 }}>
              <span className="numeric">
                {Math.floor(save.daily.progress)} / {challenge.target}
              </span>
              <span>🪙 {challenge.coinReward} · {challenge.xpReward} XP</span>
            </div>
            <Button
              block
              size="sm"
              variant={save.daily.completed && !save.daily.claimed ? 'amber' : 'default'}
              className="btn--block"
              onClick={() => go('daily')}
            >
              {save.daily.claimed ? 'View challenge' : save.daily.completed ? 'Claim reward' : 'Take the challenge'}
            </Button>
          </Panel>

          <Panel
            title="Today's missions"
            float
            action={
              <span className="tiny dim numeric">
                {missionsDone} / {daily.length}
              </span>
            }
          >
            <div className="stack stack--tight">
              {daily.map(({ def, progress }) => {
                const complete = progress.progress >= def.target;
                return (
                  <div key={def.id}>
                    <div className="row row--between small" style={{ marginBottom: 4 }}>
                      <span className={complete ? 'muted' : undefined}>{def.description}</span>
                      {complete && !progress.claimed && <span className="badge badge--ready">Claim</span>}
                    </div>
                    <Meter value={Math.min(1, progress.progress / def.target)} thin />
                  </div>
                );
              })}
            </div>
            <Button block size="sm" variant="ghost" onClick={() => go('missions')} className="btn--block">
              All missions
            </Button>
          </Panel>

          <InstallPrompt />
        </div>
      </div>
    </>
  );
}

/** Re-exported so the daily screen and the run pipeline agree on the maths. */
export { challengeProgressValue };
