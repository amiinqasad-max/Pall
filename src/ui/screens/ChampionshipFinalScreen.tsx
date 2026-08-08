/**
 * The Championship final: free entry, starts at zero, no paid advantages.
 *
 * Everything a qualified player needs is here — their own score/rank/prize
 * preview and the live Top 25 — reusing the same listrow markup as the
 * normal leaderboard so this reads as part of the same game, not a bolted-on
 * feature.
 */

import { useEffect, useState } from 'react';
import { useUi } from '@/state/ui';
import { useChampionship } from '@/state/championship';
import { fetchPrizeAtRank } from '@/services/championship';
import { Button, EmptyState, IconButton, Panel } from '@/ui/components/primitives';
import { num, ordinal } from '@/core/format';
import { formatCountdown } from '@/core/time';

function money(cents: number | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

export function ChampionshipFinalScreen() {
  const go = useUi((s) => s.go);
  const { challenge, participant, leaderboard, selfRank, cashPrizeEnabled, refreshLeaderboard } = useChampionship();
  const [now, setNow] = useState(Date.now());
  const [prizeAtRank, setPrizeAtRank] = useState<number | null>(null);

  useEffect(() => {
    void refreshLeaderboard();
    const t = setInterval(() => void refreshLeaderboard(), 20_000);
    return () => clearInterval(t);
  }, [refreshLeaderboard]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!challenge) return;
    void fetchPrizeAtRank(challenge.id, selfRank).then(setPrizeAtRank);
  }, [challenge, selfRank]);

  if (!challenge || !participant) {
    return (
      <>
        <header className="topbar">
          <IconButton icon="←" label="Back" onClick={() => go('championship')} />
          <h1 className="topbar__title">🏆 Championship</h1>
        </header>
        <div className="screen__body">
          <Panel>
            <EmptyState icon="◇" title="Qualify first" body="Reach today’s target to unlock the final." />
          </Panel>
        </div>
      </>
    );
  }

  if (participant.qualificationStatus !== 'qualified') {
    return (
      <>
        <header className="topbar">
          <IconButton icon="←" label="Back" onClick={() => go('championship')} />
          <h1 className="topbar__title">🏆 Championship</h1>
        </header>
        <div className="screen__body">
          <Panel>
            <EmptyState
              icon="◇"
              title="Not qualified yet"
              body="Play today’s Championship qualification round to unlock the free final."
            />
            <div style={{ marginTop: 'var(--sp-3)' }}>
              <Button variant="primary" block onClick={() => go('championship')}>
                Go to qualification
              </Button>
            </div>
          </Panel>
        </div>
      </>
    );
  }

  const attemptsLeft = Math.max(0, (challenge.maxFinalAttempts ?? 0) - participant.finalAttemptsUsed);
  const timeLeft = Math.max(0, new Date(challenge.endTime).getTime() - now);
  const disqualified = participant.antiCheatStatus === 'disqualified';

  return (
    <>
      <header className="topbar">
        <IconButton icon="←" label="Back" onClick={() => go('championship')} />
        <h1 className="topbar__title">🏆 Cash Championship</h1>
      </header>

      <div className="screen__body">
        <div className="stack">
          <Panel accent float>
            <div className="row row--between">
              <div>
                <div className="result__label">Your final score</div>
                <div className="result__score numeric">{num(participant.finalScore)}</div>
              </div>
              <div className="center">
                <div className="result__label">Rank</div>
                <div className="strong numeric" style={{ fontSize: 'var(--fs-xl)' }}>
                  {selfRank ? ordinal(selfRank) : '—'}
                </div>
              </div>
            </div>
            <div className="row row--between tiny muted" style={{ marginTop: 'var(--sp-3)' }}>
              <span>Prize at your rank</span>
              <span className="strong">{cashPrizeEnabled ? money(prizeAtRank) : 'unavailable in your region'}</span>
            </div>
            <div className="row row--between tiny muted" style={{ marginTop: 4 }}>
              <span>Time remaining</span>
              <span className="numeric">{formatCountdown(timeLeft)}</span>
            </div>
          </Panel>

          {disqualified && (
            <Panel>
              <p className="small center" style={{ color: 'var(--danger)', margin: 0 }}>
                This account is under review for today’s Championship and is not eligible for a prize. Normal play is
                unaffected.
              </p>
            </Panel>
          )}

          {!disqualified && (
            <>
              <button className="playbtn" onClick={() => go('play')} disabled={attemptsLeft <= 0}>
                {attemptsLeft > 0 ? 'PLAY FINAL' : 'NO ATTEMPTS LEFT'}
              </button>
              <p className="tiny dim center" style={{ margin: 0 }}>
                {attemptsLeft} of {challenge.maxFinalAttempts ?? 0} attempts remaining · your best score counts ·
                entry is free · coins and revives are disabled here
              </p>
            </>
          )}

          <Panel title="Top 25" float>
            {leaderboard.length === 0 && (
              <EmptyState icon="◇" title="No final scores yet" body="Be the first to post one." />
            )}
            {leaderboard.length > 0 && (
              <div className="stack stack--tight">
                {leaderboard.map((entry) => (
                  <div key={`${entry.userId}-${entry.rank}`} className={`listrow ${entry.isSelf ? 'listrow--self' : ''}`}>
                    <div className={`listrow__rank ${entry.rank <= 3 ? `listrow__rank--${entry.rank}` : ''}`}>
                      {entry.rank}
                    </div>
                    <div className="listrow__main">
                      <div className="listrow__name">{entry.username}</div>
                    </div>
                    <div className="listrow__score numeric">{num(entry.finalScore)}</div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
