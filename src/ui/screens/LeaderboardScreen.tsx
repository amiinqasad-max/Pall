import { useEffect, useState } from 'react';
import { fetchLeaderboard } from '@/services/leaderboard';
import { isBackendConfigured } from '@/services/supabase';
import { useStore, useLevel } from '@/state/store';
import { useUi } from '@/state/ui';
import { EmptyState, IconButton, Panel, Tabs } from '@/ui/components/primitives';
import { flagEmoji, num, ordinal } from '@/core/format';
import type { LeaderboardEntry, LeaderboardScope } from '@/types';

export function LeaderboardScreen() {
  const go = useUi((s) => s.go);
  const save = useStore((s) => s.save);
  const level = useLevel();
  const [scope, setScope] = useState<LeaderboardScope>('global');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [selfRank, setSelfRank] = useState<number | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'offline'>('loading');

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    void fetchLeaderboard(scope).then((page) => {
      if (cancelled) return;
      setEntries(page.entries);
      setSelfRank(page.selfRank);
      setState(page.offlineOnly || (page.stale && page.entries.length === 0) ? 'offline' : 'ready');
    });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  return (
    <>
      <header className="topbar">
        <IconButton icon="←" label="Back" onClick={() => go('home')} />
        <h1 className="topbar__title">Leaderboard</h1>
      </header>

      <div className="screen__body">
        <Tabs
          tabs={[
            { id: 'global', label: 'All time' },
            { id: 'daily', label: 'Today' },
            { id: 'weekly', label: 'This week' },
          ]}
          value={scope}
          onChange={setScope}
        />

        {/* The player's own standing is pinned above the list — it is the only
            row most people are looking for. */}
        <div className="listrow listrow--self" style={{ marginBottom: 'var(--sp-3)' }}>
          <div className="listrow__rank">{selfRank ? ordinal(selfRank) : '—'}</div>
          <div className="listrow__main">
            <div className="listrow__name">{save.player.username}</div>
            <div className="tiny dim">Level {level.level} · you</div>
          </div>
          <div className="listrow__score numeric">{num(save.stats.bestScore)}</div>
        </div>

        {state === 'loading' && (
          <div className="stack">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="listrow" style={{ opacity: 0.35 }}>
                <div className="listrow__rank">—</div>
                <div className="listrow__main">
                  <div className="listrow__name dim">Loading…</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {state === 'offline' && (
          <Panel>
            <EmptyState
              icon="⌁"
              title={isBackendConfigured ? 'Leaderboard unavailable' : 'Playing offline'}
              body={
                isBackendConfigured
                  ? 'Your runs are saved and will be submitted as soon as you reconnect.'
                  : 'No backend is configured for this build, so scores stay on this device. Your best is still tracked above.'
              }
            />
          </Panel>
        )}

        {state === 'ready' && entries.length === 0 && (
          <Panel>
            <EmptyState icon="◇" title="Nobody has posted yet" body="Be the first name on this board." />
          </Panel>
        )}

        {state === 'ready' && entries.length > 0 && (
          <div className="stack stack--tight">
            {entries.map((entry) => (
              <div key={`${entry.userId}-${entry.rank}`} className={`listrow ${entry.isSelf ? 'listrow--self' : ''}`}>
                <div className={`listrow__rank ${entry.rank <= 3 ? `listrow__rank--${entry.rank}` : ''}`}>
                  {entry.rank}
                </div>
                <div className="listrow__main">
                  <div className="listrow__name">
                    {flagEmoji(entry.country)} {entry.username}
                  </div>
                  <div className="tiny dim">Level {entry.level}</div>
                </div>
                <div className="listrow__score numeric">{num(entry.score)}</div>
              </div>
            ))}
          </div>
        )}

        <p className="tiny dim center" style={{ marginTop: 'var(--sp-4)' }}>
          Scores are validated on the server. Runs that fail validation are not ranked.
        </p>
      </div>
    </>
  );
}
