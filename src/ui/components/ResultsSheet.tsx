/**
 * The results screen.
 *
 * This is the most-viewed screen in the game — a player sees it once per run,
 * hundreds of times — so it is the one place where staging is worth the most.
 * Nothing appears at once: the score counts up, then the stats land one by one,
 * then XP fills, then rewards. Each beat has somewhere to look.
 *
 * The whole sequence is skipped under reduced motion, where every value is
 * simply present immediately.
 */

import { useEffect, useState } from 'react';
import type { RunSummary } from '@/state/store';
import type { LevelState } from '@/data/progression';
import { AD_REWARDS } from '@/systems/ads';
import { audio } from '@/systems/audio';
import { haptics } from '@/systems/haptics';
import { useUi } from '@/state/ui';
import { Button, Meter, RewardBurst } from '@/ui/components/primitives';
import { useAnimatedNumber, useStagger } from '@/ui/hooks/useAnimatedNumber';
import { distance as fmtDistance, num } from '@/core/format';
import { formatDuration } from '@/core/time';

interface Props {
  summary: RunSummary;
  level: LevelState;
  coinAdsLeft: number;
  coinClaimed: boolean;
  busy: boolean;
  reducedMotion: boolean;
  /** Set when this run was a Championship run — qualification or final. */
  championshipPhase?: 'qualifying' | 'final';
  /** The raw status string the submission RPC returned, e.g. 'qualified',
   *  'accepted', or a rejection reason. Null while the report is in flight. */
  championshipResult?: string | null;
  onClaimCoins: () => void;
  onDouble: () => void;
  onRestart: () => void;
  onHome: () => void;
  onDaily: () => void;
  onChampionship: () => void;
}

export function ResultsSheet({
  summary,
  level,
  coinAdsLeft,
  coinClaimed,
  busy,
  reducedMotion,
  championshipPhase,
  championshipResult,
  onClaimCoins,
  onDouble,
  onRestart,
  onHome,
  onDaily,
  onChampionship,
}: Props) {
  const toast = useUi((s) => s.toast);
  const [doubled, setDoubled] = useState(false);

  const score = useAnimatedNumber(summary.result.score, { durationMs: 1100, immediate: reducedMotion });
  const xp = useAnimatedNumber(summary.xpGained, { durationMs: 900, delayMs: 500, immediate: reducedMotion });

  const stats = [
    { label: 'Distance', value: fmtDistance(summary.result.distance) },
    { label: 'Time', value: formatDuration(summary.result.durationMs) },
    { label: 'Prisms', value: num(summary.result.prisms) },
    { label: 'Dodged', value: num(summary.result.obstaclesDodged) },
    { label: 'Near miss', value: num(summary.result.nearMisses) },
    { label: 'Top speed', value: `${Math.round(summary.result.topSpeed * 3.6)} km/h` },
  ];
  const shownStats = useStagger(reducedMotion ? 0 : stats.length, 70, 420);
  const visibleStats = reducedMotion ? stats.length : shownStats;

  // The XP bar fills to its final position only once the count-up reaches it,
  // so the two read as one motion instead of two competing ones.
  const [barFilled, setBarFilled] = useState(reducedMotion);
  useEffect(() => {
    if (reducedMotion) return;
    const t = setTimeout(() => setBarFilled(true), 620);
    return () => clearTimeout(t);
  }, [reducedMotion]);

  // A ticking sound under the count-up, throttled well below the frame rate.
  useEffect(() => {
    if (reducedMotion || summary.result.score < 100) return;
    let n = 0;
    const id = setInterval(() => {
      n++;
      audio.play('ui.toggle', { gain: 0.1, pitch: 1 + n * 0.04 });
      if (n > 8) clearInterval(id);
    }, 110);
    return () => clearInterval(id);
  }, [summary.result.score, reducedMotion]);

  const share = async (): Promise<void> => {
    const text = `I scored ${num(summary.result.score)} in TARTAN — ${fmtDistance(summary.result.distance)} before I hit something.`;
    try {
      // The Web Share API is the only path that reaches a native share sheet,
      // and it is gated on a user gesture, so it must be called straight from
      // the click rather than after an await.
      if (navigator.share) {
        await navigator.share({ title: 'TARTAN', text, url: location.origin });
        haptics.fire('success');
        return;
      }
      await navigator.clipboard.writeText(`${text} ${location.origin}`);
      toast('Copied to clipboard', 'info', '📋');
    } catch {
      // A cancelled share sheet rejects; that is not an error worth reporting.
    }
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Run complete">
      <div className="sheet results">
        <div className="center">
          {/* A record is the one outcome worth its own flourish; every run
              getting a burst would make none of them feel like an event. */}
          {summary.newRecord && (
            <RewardBurst icon="🏆" size="sm" sparkles={!reducedMotion} />
          )}
          {summary.newRecord && <div className="result__record">New personal best</div>}
          <div className="result__label">Score</div>
          <div className="result__score numeric">{num(score)}</div>
          <div className="small muted" style={{ marginTop: 4 }}>
            Best {num(Math.max(summary.previousBest, summary.result.score))}
          </div>
        </div>

        {summary.rejected && (
          <p className="tiny center" style={{ color: 'var(--danger)', marginTop: 'var(--sp-3)' }}>
            This run could not be verified and was not recorded.
          </p>
        )}

        <div className="statgrid" style={{ margin: 'var(--sp-4) 0' }}>
          {stats.map((item, i) => (
            <div key={item.label} className={i < visibleStats ? 'statcell statcell--in' : 'statcell'}>
              <div className="statgrid__value">{item.value}</div>
              <div className="statgrid__label">{item.label}</div>
            </div>
          ))}
        </div>

        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <div className="row row--between tiny muted" style={{ marginBottom: 4 }}>
            <span>Level {level.level}</span>
            <span className="numeric">+{num(xp)} XP</span>
          </div>
          <Meter value={barFilled ? level.progress : 0} />
          {summary.levelsGained > 0 && (
            <p className="tiny center levelup" style={{ color: 'var(--teal-bright)', marginTop: 6 }}>
              Level up{summary.levelsGained > 1 ? ` ×${summary.levelsGained}` : ''}
            </p>
          )}
        </div>

        {summary.missionsCompleted.length > 0 && (
          <div className="panel statcell--in" style={{ marginBottom: 'var(--sp-3)' }}>
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
          <div className="panel panel--accent center statcell--in" style={{ marginBottom: 'var(--sp-3)' }}>
            <div className="strong">Daily challenge complete</div>
            <Button size="sm" variant="amber" onClick={onDaily} className="btn--block">
              Claim reward
            </Button>
          </div>
        )}

        {championshipPhase && (
          <div className="panel panel--accent center statcell--in" style={{ marginBottom: 'var(--sp-3)' }}>
            <div className="strong">
              {championshipResult === 'qualified'
                ? '🎉 Championship qualified!'
                : championshipResult == null
                  ? 'Reporting to the Championship…'
                  : championshipPhase === 'qualifying'
                    ? 'Championship qualification run'
                    : 'Championship final run'}
            </div>
            <p className="tiny dim center" style={{ margin: '4px 0 var(--sp-2)' }}>
              {championshipPhase === 'qualifying'
                ? 'This score counts toward today’s qualification target.'
                : 'This score counts toward your best Championship final attempt.'}
            </p>
            <Button size="sm" variant="amber" onClick={onChampionship} className="btn--block">
              View Championship
            </Button>
          </div>
        )}

        <div className="stack">
          {!doubled && summary.xpGained > 0 && (
            <Button
              variant="amber"
              block
              disabled={busy}
              onClick={() => {
                setDoubled(true);
                onDouble();
              }}
            >
              {busy ? 'Loading…' : `▶ Double your ${num(summary.xpGained)} XP`}
            </Button>
          )}

          {!coinClaimed && coinAdsLeft > 0 && (
            <Button variant="default" block disabled={busy} onClick={onClaimCoins}>
              {busy ? 'Loading…' : `▶ Watch for ${AD_REWARDS.reward_coins} coins`}
            </Button>
          )}
          {coinClaimed && (
            <p className="tiny center dim" style={{ margin: 0 }}>
              Bonus collected. {coinAdsLeft} more available today.
            </p>
          )}

          <Button variant="primary" size="lg" block onClick={onRestart}>
            Run again
          </Button>

          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            <Button variant="ghost" onClick={onHome} className="btn--block">
              Home
            </Button>
            <Button variant="ghost" onClick={() => void share()} className="btn--block">
              Share
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
