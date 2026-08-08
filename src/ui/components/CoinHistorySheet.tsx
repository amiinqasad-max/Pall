/**
 * Coin transaction history — reads tartan.coin_history(), which merges the
 * two ledger tables the server already keeps (coin_ledger for rewarded_ad/
 * daily_challenge/daily_reward, coin_transactions for purchase_credit/
 * revive_spend/video_reward/article_reward). Read-only: nothing here writes
 * anything, it's a window onto the real server-side ledger.
 */

import { useEffect, useState } from 'react';
import { useEconomy } from '@/state/economy';
import { useCoins } from '@/state/store';
import { Sheet } from '@/ui/components/primitives';
import { num } from '@/core/format';
import type { CoinHistoryEntry } from '@/types';

const REASON_LABELS: Record<string, string> = {
  rewarded_ad: 'Watch Ad',
  daily_challenge: 'Daily Mission',
  daily_reward: 'Daily Reward',
  purchase: 'Purchase',
  purchase_credit: 'Purchase',
  revive_spend: 'Revive',
  admin_adjustment: 'Adjustment',
  video_reward: 'Watch Video',
  article_reward: 'Read Article',
};

function label(entry: CoinHistoryEntry): string {
  return REASON_LABELS[entry.reason] ?? entry.reason;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function CoinHistorySheet({ onClose }: { onClose: () => void }) {
  const coins = useCoins();
  const history = useEconomy((s) => s.history);
  const loadHistory = useEconomy((s) => s.loadHistory);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void loadHistory().finally(() => setLoading(false));
  }, [loadHistory]);

  return (
    <Sheet title="🪙 Coin History" onClose={onClose}>
      {loading && (
        <p className="small muted center" style={{ margin: 0 }}>
          Loading…
        </p>
      )}
      {!loading && history.length === 0 && (
        <p className="small muted center" style={{ margin: 0 }}>
          No coin activity yet.
        </p>
      )}
      {!loading && history.length > 0 && (
        <div className="stack stack--tight" style={{ maxHeight: '22rem', overflowY: 'auto' }}>
          {history.map((entry, i) => (
            <div key={i} className="row row--between small">
              <div style={{ minWidth: 0 }}>
                <div>{label(entry)}</div>
                <div className="tiny dim">{formatWhen(entry.createdAt)}</div>
              </div>
              <div
                className="numeric strong"
                style={{ color: entry.amount > 0 ? 'var(--amber-bright)' : 'var(--grey)', flex: 'none' }}
              >
                {entry.amount > 0 ? '+' : ''}
                {num(entry.amount)}
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="row row--between" style={{ marginTop: 'var(--sp-3)', paddingTop: 'var(--sp-3)', borderTop: '1px solid var(--border)' }}>
        <span className="small muted">Current balance</span>
        <span className="strong numeric">🪙 {num(coins)}</span>
      </div>
    </Sheet>
  );
}
