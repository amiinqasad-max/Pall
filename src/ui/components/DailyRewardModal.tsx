/**
 * Daily login reward.
 *
 * Appears once per UTC day, on the home screen only, and never interrupts a
 * run. One of the three coin faucets in the game.
 */

import { useEffect, useState } from 'react';
import { useStore } from '@/state/store';
import { useUi } from '@/state/ui';
import { rewardForStreakDay, rewardLadder } from '@/data/missions';
import { audio } from '@/systems/audio';
import { haptics } from '@/systems/haptics';
import { Button } from '@/ui/components/primitives';
import { num } from '@/core/format';

export function DailyRewardModal() {
  const screen = useUi((s) => s.screen);
  const available = useStore((s) => s.save.rewards.lastClaimDay !== s.save.daily.day);
  const streak = useStore((s) => s.save.rewards.streak);
  const claimReward = useStore((s) => s.claimDailyReward);
  const toast = useUi((s) => s.toast);

  const [open, setOpen] = useState(false);
  const [claimed, setClaimed] = useState<{ coins: number; xp: number; day: number } | null>(null);

  useEffect(() => {
    // Home only. Popping this over the game-over screen would bury the score.
    if (screen === 'home' && available) {
      const timer = setTimeout(() => setOpen(true), 600);
      return () => clearTimeout(timer);
    }
    if (!available) setOpen(false);
    return undefined;
  }, [screen, available]);

  if (!open) return null;

  const nextDay = claimed?.day ?? streak + 1;
  const ladder = rewardLadder(nextDay);
  const pending = rewardForStreakDay(nextDay);

  const onClaim = (): void => {
    const result = claimReward();
    if (!result.claimed) {
      setOpen(false);
      return;
    }
    setClaimed({ coins: result.coins, xp: result.xp, day: result.day });
    audio.play('reward');
    haptics.fire('reward');
    toast(`+${num(result.coins)} coins · Day ${result.day}`, 'reward', '🪙');
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Daily reward">
      <div className="sheet center">
        <p className="tiny dim" style={{ letterSpacing: '0.16em', textTransform: 'uppercase', margin: 0 }}>
          Daily reward
        </p>
        <h2 className="sheet__title" style={{ marginTop: 'var(--sp-2)' }}>
          {claimed ? 'Collected' : `Day ${nextDay}`}
        </h2>
        <p className="sheet__sub">
          {claimed
            ? `Come back tomorrow to reach day ${claimed.day + 1}.`
            : streak > 0
              ? `${streak}-day streak. Keep it alive.`
              : 'Welcome back. Your streak starts today.'}
        </p>

        <div className="grid-3" style={{ marginBottom: 'var(--sp-4)' }}>
          {ladder.slice(0, 6).map((reward) => {
            const isCurrent = reward.day === nextDay;
            const isPast = reward.day < nextDay;
            return (
              <div
                key={reward.day}
                className="panel"
                style={{
                  padding: 'var(--sp-2)',
                  opacity: isPast ? 0.45 : 1,
                  borderColor: isCurrent ? 'var(--amber)' : undefined,
                }}
              >
                <div className="tiny dim">{reward.label ?? `Day ${reward.day}`}</div>
                <div className="strong small" style={{ color: reward.milestone ? 'var(--amber-bright)' : undefined }}>
                  {reward.coins}
                </div>
                <div className="tiny dim">coins</div>
              </div>
            );
          })}
        </div>

        {claimed ? (
          <Button variant="primary" block onClick={() => setOpen(false)}>
            Continue
          </Button>
        ) : (
          <>
            <Button variant="amber" block size="lg" onClick={onClaim}>
              Collect {num(pending.coins)} coins
            </Button>
            <p className="tiny dim" style={{ marginTop: 'var(--sp-2)' }}>
              +{pending.xp} XP · resets at 00:00 UTC
            </p>
          </>
        )}
      </div>
    </div>
  );
}
