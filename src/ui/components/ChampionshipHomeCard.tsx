/**
 * The Home-screen entry point into the Daily Championship.
 *
 * Unlike the card this replaced, this one is *always* rendered once the
 * store has finished its first fetch — loading, a network error, "nothing
 * scheduled today", the free qualification round, the qualified/final state,
 * and the ended-challenge/payout state are all real, visible states here.
 * Rendering nothing at all (the previous behaviour whenever `challenge` was
 * null) is what made the whole feature look unreachable: this card was the
 * *only* navigation path into ChampionshipScreen/ChampionshipFinalScreen, so
 * silently omitting it silently removed the entire feature from the app.
 *
 * Reused verbatim on MissionsScreen too, since that's the closest thing this
 * app has to a "Games/Challenges" section — one component, two entry points,
 * no new navigation structure.
 */

import { useEffect, useState } from 'react';
import { useUi } from '@/state/ui';
import { useChampionship } from '@/state/championship';
import { Button, Meter, Panel } from '@/ui/components/primitives';
import { num, ordinal } from '@/core/format';
import { formatCountdown } from '@/core/time';

function money(cents: number | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

function payoutStatusLabel(status: string): string {
  switch (status) {
    case 'pending_verification':
      return 'Pending Verification';
    case 'verified':
      return 'Verified';
    case 'approved':
      return 'Approved';
    case 'paid':
      return 'Paid';
    default:
      return status;
  }
}

export function ChampionshipHomeCard() {
  const go = useUi((s) => s.go);
  const { challenge, participant, qualifiedCount, cashPrizeEnabled, payout, selfRank, ready, error, init, refreshLeaderboard } =
    useChampionship();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const qualified = participant?.qualificationStatus === 'qualified';
  const active = challenge && challenge.status !== 'ended' && challenge.status !== 'cancelled';

  // A single, non-polling rank check once the player is qualified — enough
  // to show "Current Rank" on Home without turning this card into a second
  // live leaderboard poller (that job stays on ChampionshipFinalScreen).
  useEffect(() => {
    if (challenge && active && qualified) void refreshLeaderboard();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.id, active, qualified]);

  // ---- Loading -------------------------------------------------------------
  if (!ready) {
    return (
      <Panel title="🏆 Daily Championship" tone="violet" float>
        <p className="small muted center" style={{ margin: 0 }}>
          Loading today’s challenge…
        </p>
      </Panel>
    );
  }

  // ---- Network error (distinct from "nothing scheduled") -------------------
  if (error && !challenge) {
    return (
      <Panel title="🏆 Daily Championship" tone="violet" float>
        <p className="small muted center" style={{ margin: '0 0 var(--sp-3)' }}>
          Couldn’t load today’s challenge.
        </p>
        <Button block size="sm" className="btn--block" onClick={() => void init(null)}>
          Try Again
        </Button>
      </Panel>
    );
  }

  // ---- No Championship scheduled today -------------------------------------
  if (!challenge) {
    return (
      <Panel title="🏆 Daily Championship" tone="violet" float>
        <p className="small muted center" style={{ margin: 0 }}>
          No Daily Championship is active right now. Check back soon.
        </p>
      </Panel>
    );
  }

  // ---- Ended: final results + payout status --------------------------------
  if (challenge.status === 'ended' || challenge.status === 'cancelled') {
    const placed = participant?.finalRank != null;
    return (
      <Panel title="🏆 Challenge Complete" tone="violet" float>
        {placed ? (
          <>
            <div className="row row--between">
              <div>
                <div className="result__label">Final rank</div>
                <div className="strong numeric" style={{ fontSize: 'var(--fs-xl)' }}>
                  {ordinal(participant!.finalRank!)}
                </div>
              </div>
              {cashPrizeEnabled && payout && (
                <div className="center">
                  <div className="result__label">Prize</div>
                  <div className="strong numeric" style={{ fontSize: 'var(--fs-xl)' }}>
                    {money(payout.prizeAmountCents)}
                  </div>
                </div>
              )}
            </div>
            {cashPrizeEnabled && payout && (
              <p className="tiny dim center" style={{ margin: 'var(--sp-2) 0 0' }}>
                Status: {payoutStatusLabel(payout.payoutStatus)}
              </p>
            )}
          </>
        ) : (
          <p className="small muted center" style={{ margin: 0 }}>
            Today’s Championship has ended. You didn’t place in the Top {challenge.winnerCount ?? 25} this time.
          </p>
        )}
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <Button block size="sm" className="btn--block" onClick={() => go('championshipFinal')}>
            View results
          </Button>
        </div>
      </Panel>
    );
  }

  // ---- Qualified: straight to the final ------------------------------------
  if (qualified) {
    return (
      <Panel
        title="🏆 Cash Championship"
        tone="violet"
        float
        action={<span className="badge badge--done">✅ Qualified</span>}
      >
        <div className="row row--between">
          <div>
            <div className="result__label">Your score</div>
            <div className="result__score numeric">{num(participant!.finalScore)}</div>
          </div>
          <div className="center">
            <div className="result__label">Current rank</div>
            <div className="strong numeric" style={{ fontSize: 'var(--fs-xl)' }}>
              {selfRank ? ordinal(selfRank) : '—'}
            </div>
          </div>
        </div>
        <div style={{ marginTop: 'var(--sp-3)' }}>
          <Button block size="sm" variant="amber" className="btn--block" onClick={() => go('championshipFinal')}>
            Continue Championship
          </Button>
        </div>
      </Panel>
    );
  }

  // ---- Free qualification round --------------------------------------------
  const target = challenge.qualificationTarget ?? 0;
  const score = participant?.qualificationScore ?? 0;
  const progress = target > 0 ? Math.min(1, score / target) : 0;
  const timeLeft = Math.max(0, new Date(challenge.endTime).getTime() - now);
  const notStarted = challenge.status === 'scheduled';

  return (
    <Panel title="🏆 Daily Championship" tone="violet" float>
      {cashPrizeEnabled ? (
        <p className="small muted" style={{ margin: '0 0 var(--sp-2)' }}>
          Reach {num(target)} points to qualify. No purchase necessary.
        </p>
      ) : (
        <p className="small muted" style={{ margin: '0 0 var(--sp-2)' }}>
          Skill Challenge — cash prizes are currently unavailable in your region. Reach {num(target)} points to
          qualify for the free final.
        </p>
      )}
      {score > 0 && (
        <div style={{ marginBottom: 'var(--sp-2)' }}>
          <div className="row row--between tiny muted" style={{ marginBottom: 4 }}>
            <span>Your score</span>
            <span className="numeric">
              {num(score)} / {num(target)}
            </span>
          </div>
          <Meter value={progress} amber />
        </div>
      )}
      <div className="row row--between tiny muted" style={{ marginBottom: 'var(--sp-3)' }}>
        <span>{qualifiedCount === 1 ? '1 player qualified' : `${num(qualifiedCount)} players qualified`}</span>
        {cashPrizeEnabled && <span>Prize pool {money(challenge.prizePoolCents)}</span>}
      </div>
      {notStarted ? (
        <p className="small muted center" style={{ margin: 0 }}>
          Today’s Championship hasn’t opened yet.
        </p>
      ) : (
        <>
          <Button block size="sm" className="btn--block" onClick={() => go('championship')}>
            {cashPrizeEnabled ? 'Play Challenge' : 'Play Free Challenge'}
          </Button>
          <p className="tiny dim center" style={{ margin: 'var(--sp-2) 0 0' }}>
            {formatCountdown(timeLeft)} remaining
          </p>
        </>
      )}
    </Panel>
  );
}
