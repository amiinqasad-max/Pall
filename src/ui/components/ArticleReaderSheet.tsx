/**
 * The "Read Article" earn flow.
 *
 * Articles are admin-managed links (tartan.articles, see
 * supabase/migrations/0005_coins_store_v2.sql) — there is no in-app article
 * content anymore, so this opens the real URL in a new tab and tracks the
 * read with a real server-timestamped session (see
 * tartan.start_article_session), enabling the claim button only once the
 * LOCAL countdown — mirroring the server's own minimum-read-time floor —
 * reaches zero. The countdown is purely for UX pacing; the actual gate is
 * the server re-checking elapsed time against its own clock when the claim
 * is submitted, so racing this UI or fiddling with the device clock does
 * not shorten anything that actually counts.
 */

import { useEffect, useRef, useState } from 'react';
import { useEconomy } from '@/state/economy';
import { Button, Sheet } from '@/ui/components/primitives';
import type { Article } from '@/types';

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
      if (!id) {
        setFailedToStart(true);
        return;
      }
      setSessionId(id);
      // Opt-in and user-initiated (this effect only runs because the player
      // just tapped "Read Article"), so a popup blocker should never see
      // this as an unsolicited pop — but if it does, the "Open article"
      // button below is the fallback.
      window.open(article.url, '_blank', 'noopener,noreferrer');
    });
  }, [article.id, article.url, startArticle]);

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
      <p className="small muted" style={{ marginBottom: 'var(--sp-3)' }}>
        The article opened in a new tab. Read it there, then come back here to claim your coins once the timer runs
        out.
      </p>

      <div style={{ marginBottom: 'var(--sp-3)' }}>
        <Button variant="ghost" block onClick={() => window.open(article.url, '_blank', 'noopener,noreferrer')}>
          Open article again
        </Button>
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
