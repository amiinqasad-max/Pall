import { useState } from 'react';
import { useStore, useLevel, useCoins } from '@/state/store';
import { useUi } from '@/state/ui';
import { ACHIEVEMENTS, LEVEL_REWARDS, badgeForLevel, environmentsForLevel } from '@/data/progression';
import { Button, CoinChip, IconButton, Meter, Panel, Sheet, StatGrid, Tabs } from '@/ui/components/primitives';
import { compact, distance as fmtDistance, num } from '@/core/format';
import { formatDuration } from '@/core/time';
import { audio } from '@/systems/audio';

export function ProfileScreen() {
  const go = useUi((s) => s.go);
  const toast = useUi((s) => s.toast);
  const save = useStore((s) => s.save);
  const level = useLevel();
  const coins = useCoins();
  const setUsername = useStore((s) => s.setUsername);
  const setEnvironment = useStore((s) => s.setEnvironment);

  const [tab, setTab] = useState<'stats' | 'achievements' | 'wallet'>('stats');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(save.player.username);

  const badge = badgeForLevel(level.level);
  const environments = environmentsForLevel(level.level);
  const nextReward = LEVEL_REWARDS.find((r) => r.level > level.level);

  const saveName = (): void => {
    const clean = draft.trim();
    if (clean.length < 3) {
      toast('Name needs at least 3 characters', 'error');
      return;
    }
    setUsername(clean);
    setEditing(false);
    audio.play('ui.toggle');
    toast('Name updated');
  };

  return (
    <>
      <header className="topbar">
        <IconButton icon="←" label="Back" onClick={() => go('home')} />
        <h1 className="topbar__title">Profile</h1>
        <CoinChip coins={coins} />
        <IconButton icon="⚙" label="Settings" onClick={() => go('settings')} />
      </header>

      <div className="screen__body">
        <Panel accent>
          <div className="row" style={{ marginBottom: 'var(--sp-3)' }}>
            <div
              style={{
                width: '3.25rem',
                height: '3.25rem',
                borderRadius: '50%',
                display: 'grid',
                placeItems: 'center',
                fontSize: '1.5rem',
                background: 'linear-gradient(135deg, var(--teal) 0%, var(--navy-panel) 100%)',
                border: '1px solid var(--border-hi)',
                flex: 'none',
              }}
              aria-hidden="true"
            >
              {badge.glyph}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="strong" style={{ fontSize: 'var(--fs-lg)' }}>
                {save.player.username}
              </div>
              <div className="small muted">
                {badge.name} · Level {level.level}
              </div>
            </div>
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
          </div>

          <Meter value={level.progress} />
          <div className="row row--between tiny muted" style={{ marginTop: 6 }}>
            <span className="numeric">
              {level.xpForNext > 0 ? `${num(level.xpIntoLevel)} / ${num(level.xpForNext)} XP` : 'Max level'}
            </span>
            {nextReward && <span>Next: {nextReward.label} at {nextReward.level}</span>}
          </div>
        </Panel>

        <div style={{ height: 'var(--sp-3)' }} />

        <Tabs
          tabs={[
            { id: 'stats', label: 'Stats' },
            { id: 'achievements', label: 'Awards' },
            { id: 'wallet', label: 'Wallet' },
          ]}
          value={tab}
          onChange={setTab}
        />

        {tab === 'stats' && (
          <div className="stack">
            <Panel title="Records">
              <StatGrid
                items={[
                  { label: 'Best score', value: num(save.stats.bestScore) },
                  { label: 'Best run', value: fmtDistance(save.stats.bestDistance) },
                  { label: 'Longest', value: formatDuration(save.stats.bestTimeMs) },
                ]}
              />
            </Panel>
            <Panel title="Lifetime">
              <StatGrid
                items={[
                  { label: 'Runs', value: compact(save.stats.runs) },
                  { label: 'Distance', value: fmtDistance(save.stats.totalDistance) },
                  { label: 'Time', value: formatDuration(save.stats.totalTimeMs) },
                  { label: 'Prisms', value: compact(save.stats.totalPrisms) },
                  { label: 'Dodged', value: compact(save.stats.obstaclesDodged) },
                  { label: 'Near miss', value: compact(save.stats.nearMisses) },
                ]}
              />
            </Panel>
            <Panel title="Consistency">
              <StatGrid
                items={[
                  { label: 'Streak', value: `${save.rewards.streak}d` },
                  { label: 'Best streak', value: `${save.rewards.longestStreak}d` },
                  { label: 'Dailies', value: num(save.stats.dailyChallengesCompleted) },
                ]}
              />
            </Panel>

            <Panel title="Environment">
              <div className="stack stack--tight">
                {environments.map((env) => (
                  <button
                    key={env.id}
                    className={`listrow ${save.environment === env.id ? 'listrow--self' : ''}`}
                    onClick={() => {
                      setEnvironment(env.id);
                      audio.play('ui.toggle');
                    }}
                  >
                    <div className="listrow__main">
                      <div className="listrow__name">{env.name}</div>
                      <div className="tiny dim">{env.blurb}</div>
                    </div>
                    {save.environment === env.id && <span className="badge badge--done">On</span>}
                  </button>
                ))}
              </div>
              <p className="tiny dim" style={{ marginTop: 'var(--sp-2)', marginBottom: 0 }}>
                More environments unlock as you level up.
              </p>
            </Panel>
          </div>
        )}

        {tab === 'achievements' && (
          <div className="stack stack--tight">
            {ACHIEVEMENTS.map((achievement) => {
              const unlockedAt = save.achievements[achievement.id];
              return (
                <div key={achievement.id} className="listrow" style={{ opacity: unlockedAt ? 1 : 0.6 }}>
                  <div className="listrow__rank" aria-hidden="true">
                    {unlockedAt ? '✦' : '◇'}
                  </div>
                  <div className="listrow__main">
                    <div className="listrow__name">{achievement.name}</div>
                    <div className="tiny dim">{achievement.description}</div>
                  </div>
                  <div className="tiny dim">+{achievement.xp}</div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'wallet' && (
          <div className="stack">
            <Panel>
              <StatGrid
                items={[
                  { label: 'Balance', value: num(save.wallet.coins) },
                  { label: 'Earned', value: compact(save.wallet.lifetimeEarned) },
                  { label: 'Spent', value: compact(save.wallet.lifetimeSpent) },
                ]}
              />
            </Panel>
            <Panel title="Transactions">
              {save.ledger.length === 0 ? (
                <p className="small dim" style={{ margin: 0 }}>
                  No coin activity yet. Coins come from rewarded ads, the daily challenge and login rewards.
                </p>
              ) : (
                <div className="stack stack--tight">
                  {save.ledger.map((entry) => (
                    <div key={entry.id} className="row row--between small">
                      <div style={{ minWidth: 0 }}>
                        <div>{LEDGER_LABELS[entry.reason] ?? entry.reason}</div>
                        {entry.detail && <div className="tiny dim">{entry.detail}</div>}
                      </div>
                      <div
                        className="numeric strong"
                        style={{ color: entry.amount > 0 ? 'var(--amber-bright)' : 'var(--grey)' }}
                      >
                        {entry.amount > 0 ? '+' : ''}
                        {num(entry.amount)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        )}
      </div>

      {editing && (
        <Sheet title="Display name" subtitle="This is the name shown on the leaderboard." onClose={() => setEditing(false)}>
          <input
            value={draft}
            maxLength={18}
            onChange={(event) => setDraft(event.target.value)}
            className="panel"
            style={{ width: '100%', padding: 'var(--sp-3)', marginBottom: 'var(--sp-3)' }}
            aria-label="Display name"
          />
          <div className="stack">
            <Button variant="primary" block onClick={saveName}>
              Save
            </Button>
            <Button variant="ghost" block onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </Sheet>
      )}
    </>
  );
}

const LEDGER_LABELS: Record<string, string> = {
  rewarded_ad: 'Rewarded ad',
  daily_challenge: 'Daily challenge',
  daily_reward: 'Login reward',
  purchase: 'Store purchase',
};
