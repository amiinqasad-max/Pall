/**
 * The Daily Championship's free qualification screen.
 *
 * This is the entry point to the whole system: today's target, the player's
 * progress toward it, and — once they cross it — the one-time "qualified"
 * reveal. Everything here is free to view and free to attempt; the rules
 * sheet says so explicitly, per the responsible-design copy requirements.
 */

import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/state/store';
import { useUi } from '@/state/ui';
import { useChampionship } from '@/state/championship';
import { storage } from '@/systems/storage';
import { Button, IconButton, Meter, Panel, Sheet } from '@/ui/components/primitives';
import { num } from '@/core/format';
import { formatCountdown } from '@/core/time';

function money(cents: number | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

/** Has this challenge's one-time qualified reveal already been shown? Kept
 *  in durable storage (not component state) so it survives a reload — the
 *  whole point is that it fires once, not once per visit. */
function seenKey(challengeId: string): string {
  return `championship.qualifiedSeen.${challengeId}`;
}

export function ChampionshipScreen() {
  const go = useUi((s) => s.go);
  const country = useStore((s) => s.save.player.country);
  const { challenge, participant, qualifiedCount, cashPrizeEnabled, ready, init } = useChampionship();

  const [now, setNow] = useState(Date.now());
  const [showRules, setShowRules] = useState(false);
  const [showQualified, setShowQualified] = useState(false);
  const initedFor = useRef<string | null>(null);

  useEffect(() => {
    void init(country);
    // Re-initialise if the player's known country ever changes (e.g. once
    // the profile gains one) — not just on first mount.
  }, [init, country]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // The one-time qualified reveal: fires the first time this challenge's
  // participant record is seen as qualified, never again after that, even
  // across reloads.
  useEffect(() => {
    if (!challenge || !participant || participant.qualificationStatus !== 'qualified') return;
    if (initedFor.current === challenge.id) return;
    void storage.get<boolean>(seenKey(challenge.id)).then((seen) => {
      if (!seen) {
        setShowQualified(true);
        void storage.set(seenKey(challenge.id), true);
      }
      initedFor.current = challenge.id;
    });
  }, [challenge, participant]);

  if (!ready) {
    return (
      <>
        <header className="topbar">
          <IconButton icon="←" label="Back" onClick={() => go('home')} />
          <h1 className="topbar__title">🏆 Daily Championship</h1>
        </header>
        <div className="screen__body">
          <Panel>
            <p className="small muted center" style={{ margin: 0 }}>
              Loading today’s Championship…
            </p>
          </Panel>
        </div>
      </>
    );
  }

  if (!challenge) {
    return (
      <>
        <header className="topbar">
          <IconButton icon="←" label="Back" onClick={() => go('home')} />
          <h1 className="topbar__title">🏆 Daily Championship</h1>
        </header>
        <div className="screen__body">
          <Panel>
            <p className="small muted center" style={{ margin: 0 }}>
              No Championship is running right now. Check back soon.
            </p>
          </Panel>
        </div>
      </>
    );
  }

  const target = challenge.qualificationTarget ?? 0;
  const score = participant?.qualificationScore ?? 0;
  const progress = target > 0 ? Math.min(1, score / target) : 0;
  const qualified = participant?.qualificationStatus === 'qualified';
  const timeLeft = Math.max(0, new Date(challenge.endTime).getTime() - now);
  const notStarted = challenge.status === 'scheduled';
  const ended = challenge.status === 'ended' || challenge.status === 'cancelled';

  return (
    <>
      <header className="topbar">
        <IconButton icon="←" label="Back" onClick={() => go('home')} />
        <h1 className="topbar__title">🏆 Daily Championship</h1>
        <button className="chip" onClick={() => setShowRules(true)} aria-label="Rules">
          Rules
        </button>
      </header>

      <div className="screen__body">
        <div className="stack">
          <Panel accent float title="Qualification target">
            <div className="result__score numeric">{num(target)}</div>
            <div className="row row--between tiny muted" style={{ margin: '6px 0 4px' }}>
              <span>Your score</span>
              <span className="numeric">
                {num(score)} / {num(target)}
              </span>
            </div>
            <Meter value={progress} amber />
            <p className="tiny dim center" style={{ marginTop: 'var(--sp-3)' }}>
              {qualifiedCount === 1 ? '1 player qualified today' : `${num(qualifiedCount)} players qualified today`}
            </p>
          </Panel>

          <Panel title="Prize pool" float>
            <div className="row row--between">
              <div>
                <div className="result__label">Prize pool</div>
                <div className="strong" style={{ fontSize: 'var(--fs-xl)' }}>
                  {cashPrizeEnabled ? money(challenge.prizePoolCents) : '—'}
                </div>
              </div>
              <div className="center">
                <div className="result__label">Winners</div>
                <div className="strong numeric" style={{ fontSize: 'var(--fs-lg)' }}>
                  Top {challenge.winnerCount ?? 25}
                </div>
              </div>
            </div>
            {!cashPrizeEnabled && (
              <p className="tiny dim center" style={{ marginTop: 'var(--sp-2)' }}>
                Cash prizes aren’t available in your region yet. You can still qualify and play the free final.
              </p>
            )}
          </Panel>

          {notStarted && (
            <p className="small muted center">Today’s Championship hasn’t opened yet.</p>
          )}
          {ended && (
            <p className="small muted center">Today’s Championship has ended.</p>
          )}
          {!notStarted && !ended && (
            <button className="playbtn" onClick={() => go('play')}>
              {qualified ? 'PLAY AGAIN' : 'PLAY NOW'}
            </button>
          )}

          {qualified && (
            <Button variant="amber" size="lg" block onClick={() => go('championshipFinal')}>
              View Championship final
            </Button>
          )}

          <p className="tiny dim center" style={{ margin: 0 }}>
            {formatCountdown(timeLeft)} remaining · Entry is free · No purchase necessary
          </p>
        </div>
      </div>

      {showQualified && challenge && (
        <Sheet title="🎉 Qualified!" onClose={() => setShowQualified(false)}>
          <p className="small" style={{ marginBottom: 'var(--sp-3)' }}>
            You reached {num(target)} points. You’re now eligible for today’s Cash Championship.
          </p>
          <div className="panel" style={{ marginBottom: 'var(--sp-4)' }}>
            <p className="small strong" style={{ margin: '0 0 4px' }}>
              Final Championship
            </p>
            <p className="tiny dim" style={{ margin: 0 }}>
              Everyone starts from 0. Coins and revives — paid or otherwise — are disabled during the final. It’s
              skill only, from here.
            </p>
          </div>
          <Button
            variant="amber"
            size="lg"
            block
            onClick={() => {
              setShowQualified(false);
              go('championshipFinal');
            }}
          >
            View Championship
          </Button>
        </Sheet>
      )}

      {showRules && (
        <Sheet title="How the Championship works" onClose={() => setShowRules(false)}>
          <div className="stack stack--tight" style={{ marginBottom: 'var(--sp-4)' }}>
            <p className="small" style={{ margin: 0 }}>
              1. Play a normal run. Reach today’s qualification target to qualify — free, unlimited attempts, open to
              everyone.
            </p>
            <p className="small" style={{ margin: 0 }}>
              2. The target is set automatically from yesterday’s scores — it isn’t a fixed number anyone can tune
              after the fact.
            </p>
            <p className="small" style={{ margin: 0 }}>
              3. Once qualified, the Championship final starts everyone at zero. No entry fee, no paid advantage —
              coins, revives and other purchases cannot be used there.
            </p>
            <p className="small" style={{ margin: 0 }}>
              4. When the final closes, the Top {challenge.winnerCount ?? 25} scores share the prize pool. Ranks are
              decided by score, with an earlier completion breaking a tie.
            </p>
          </div>
          <Button variant="ghost" block onClick={() => setShowRules(false)}>
            Close
          </Button>
        </Sheet>
      )}
    </>
  );
}
