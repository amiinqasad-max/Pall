import { useEffect, useState } from 'react';
import { useMissions, useStore } from '@/state/store';
import { useUi } from '@/state/ui';
import { formatCountdown, msUntilUtcMidnight, msUntilWeeklyReset } from '@/core/time';
import { audio } from '@/systems/audio';
import { haptics } from '@/systems/haptics';
import { Button, IconButton, Meter, Panel, Tabs } from '@/ui/components/primitives';
import { num } from '@/core/format';

export function MissionsScreen() {
  const go = useUi((s) => s.go);
  const toast = useUi((s) => s.toast);
  const claim = useStore((s) => s.claimMission);
  const [period, setPeriod] = useState<'daily' | 'weekly'>('daily');
  const missions = useMissions(period);
  const [resetIn, setResetIn] = useState(0);

  useEffect(() => {
    const tick = (): void => setResetIn(period === 'daily' ? msUntilUtcMidnight() : msUntilWeeklyReset());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [period]);

  const onClaim = (id: string, xp: number, title: string): void => {
    if (!claim(id)) return;
    audio.play('achievement');
    haptics.fire('success');
    toast(`${title} · +${xp} XP`, 'reward', '✓');
  };

  const claimable = missions.filter((m) => m.progress.progress >= m.def.target && !m.progress.claimed);

  return (
    <>
      <header className="topbar">
        <IconButton icon="←" label="Back" onClick={() => go('home')} />
        <h1 className="topbar__title">Missions</h1>
        <span className="tiny dim numeric">Resets {formatCountdown(resetIn)}</span>
      </header>

      <div className="screen__body">
        <Tabs
          tabs={[
            { id: 'daily', label: 'Daily' },
            { id: 'weekly', label: 'Weekly' },
          ]}
          value={period}
          onChange={setPeriod}
        />

        <div className="stack">
          {missions.map(({ def, progress }) => {
            const complete = progress.progress >= def.target;
            const pct = Math.min(1, progress.progress / def.target);
            return (
              <Panel key={def.id} accent={complete && !progress.claimed}>
                <div className="row row--between" style={{ marginBottom: 'var(--sp-2)' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="strong">{def.title}</div>
                    <div className="small muted">{def.description}</div>
                  </div>
                  <div className="chip chip--level" style={{ flex: 'none' }}>
                    +{def.xp} XP
                  </div>
                </div>

                <Meter value={pct} amber={complete} />
                <div className="row row--between tiny muted" style={{ marginTop: 6 }}>
                  <span className="numeric">
                    {num(Math.min(progress.progress, def.target))} / {num(def.target)}
                  </span>
                  {progress.claimed && <span className="badge badge--done">Claimed</span>}
                </div>

                {complete && !progress.claimed && (
                  <Button
                    variant="amber"
                    size="sm"
                    block
                    className="btn--block"
                    onClick={() => onClaim(def.id, def.xp, def.title)}
                  >
                    Claim {def.xp} XP
                  </Button>
                )}
              </Panel>
            );
          })}
        </div>

        {claimable.length === 0 && (
          <p className="tiny dim center" style={{ marginTop: 'var(--sp-4)' }}>
            Missions award XP. Coins come from the daily challenge, login rewards and rewarded ads.
          </p>
        )}
      </div>
    </>
  );
}
