/**
 * The "Read Article" earn flow.
 *
 * Starts a real server-timestamped session on open (see
 * tartan.start_article_session in 0003_coin_economy.sql) and only enables
 * the claim button once the LOCAL countdown — mirroring the server's own
 * minimum-read-time floor — reaches zero. The countdown is purely for UX
 * pacing; the actual gate is the server re-checking elapsed time against
 * its own clock when the claim is submitted, so racing this UI or fiddling
 * with the device clock does not shorten anything that actually counts.
 */

import { useEffect, useRef, useState } from 'react';
import { useEconomy } from '@/state/economy';
import { Button, Sheet } from '@/ui/components/primitives';
import type { Article } from '@/data/articles';

export function ArticleReaderSheet({
  article,
  minReadSeconds,
  rewardCoins,
  onClose,
  onResult,
}: {
  article: Article;
  minReadSeconds: number;
  rewardCoins: number;
  onClose: () => void;
  onResult: (result: string) => void;
}) {
  const startArticle = useEconomy((s) => s.startArticle);
  const claimArticle = useEconomy((s) => s.claimArticle);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(minReadSeconds);
  const [claiming, setClaiming] = useState(false);
  const [failedToStart, setFailedToStart] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startArticle(article.id).then((id) => {
      if (!id) setFailedToStart(true);
      setSessionId(id);
    });
  }, [article.id, startArticle]);

  useEffect(() => {
    if (!sessionId) return;
    const t = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => clearInterval(t);
  }, [sessionId]);

  const canClaim = sessionId && remaining <= 0 && !claiming;

  const claim = async (): Promise<void> => {
    if (!sessionId || claiming) return;
    setClaiming(true);
    const result = await claimArticle(sessionId);
    setClaiming(false);
    onResult(result);
    if (result === 'credited') onClose();
  };

  return (
    <Sheet title={`📖 ${article.title}`} onClose={onClose}>
      <div className="stack" style={{ maxHeight: '20rem', overflowY: 'auto', marginBottom: 'var(--sp-3)' }}>
        {article.paragraphs.map((p, i) => (
          <p key={i} className="small" style={{ margin: 0, lineHeight: 1.6 }}>
            {p}
          </p>
        ))}
      </div>

      {failedToStart && (
        <p className="small center" style={{ color: 'var(--danger)' }}>
          Couldn’t start this — check your connection and try again.
        </p>
      )}

      <div className="row row--between tiny muted" style={{ marginBottom: 'var(--sp-2)' }}>
        <span>Reward</span>
        <span className="strong">+{rewardCoins} 🪙</span>
      </div>

      <Button variant="amber" size="lg" block disabled={!canClaim} onClick={() => void claim()}>
        {claiming
          ? 'Claiming…'
          : remaining > 0
            ? `Keep reading… ${remaining}s`
            : `Claim +${rewardCoins} Coins`}
      </Button>
    </Sheet>
  );
}
