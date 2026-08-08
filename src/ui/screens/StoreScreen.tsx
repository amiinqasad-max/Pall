/**
 * The store.
 *
 * Cosmetics, plus the Coins tab: earn (limited gameplay rewards handled
 * elsewhere in Missions, Watch Video, Read Article) and buy. There is no
 * bundle, no gacha, no timer on the cosmetics side, and nothing sold here
 * changes how the ball handles — the copy says so plainly, because a player
 * who suspects pay-to-win stops trusting the leaderboard.
 */

import { useEffect, useState } from 'react';
import { SKINS, TRAILS, evaluateUnlock } from '@/data/cosmetics';
import { ARTICLES, type Article } from '@/data/articles';
import { useCoins, useLevel, useStore } from '@/state/store';
import { useEconomy } from '@/state/economy';
import { useUi } from '@/state/ui';
import { ads } from '@/systems/ads';
import { audio } from '@/systems/audio';
import { haptics } from '@/systems/haptics';
import { fetchCoinPackages, recordPurchaseAttempt } from '@/services/championship';
import { ARTICLE_MIN_READ_SECONDS } from '@/services/coinEconomy';
import { Button, CoinChip, IconButton, Panel, Sheet, Tabs } from '@/ui/components/primitives';
import { ArticleReaderSheet } from '@/ui/components/ArticleReaderSheet';
import { CoinHistorySheet } from '@/ui/components/CoinHistorySheet';
import { num } from '@/core/format';
import type { Cosmetic, CoinPackage, CoinRewardClaimResult } from '@/types';

const CLAIM_MESSAGES: Record<CoinRewardClaimResult, string> = {
  credited: 'Reward granted',
  already_claimed: 'Already claimed',
  too_early: 'Not quite yet',
  daily_limit_reached: 'Today’s limit reached — come back tomorrow',
  not_found: 'Reward not granted',
  offline: 'Couldn’t reach the server — try again',
  not_signed_in: 'Not signed in',
};

/**
 * No real payment processor is wired into this build — buying a package
 * records a real, auditable purchase_records row (see
 * supabase/migrations/0002_championship.sql) but coins are only credited
 * once a staff member verifies it through admin_verify_and_credit_purchase.
 * The UI says so plainly rather than pretending a purchase completed —
 * showing "success" for money that was never actually collected would be
 * exactly the "fake purchase confirmation" the brief says to prevent.
 */
const PAYMENTS_LIVE = false;

export function StoreScreen() {
  const go = useUi((s) => s.go);
  const toast = useUi((s) => s.toast);
  const coins = useCoins();
  const level = useLevel();
  const unlocks = useStore((s) => s.save.unlocks);
  const equipped = useStore((s) => s.save.equipped);
  const purchase = useStore((s) => s.purchase);
  const equip = useStore((s) => s.equip);

  const economyStatus = useEconomy((s) => s.status);
  const refreshEconomy = useEconomy((s) => s.refresh);
  const startVideo = useEconomy((s) => s.startVideo);
  const claimVideo = useEconomy((s) => s.claimVideo);

  const [tab, setTab] = useState<'skin' | 'trail' | 'coins'>('skin');
  const [selected, setSelected] = useState<Cosmetic | null>(null);
  const [busy, setBusy] = useState(false);
  const [packages, setPackages] = useState<CoinPackage[]>([]);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [readingArticle, setReadingArticle] = useState<Article | null>(null);

  const items: Cosmetic[] = tab === 'skin' ? SKINS : tab === 'trail' ? TRAILS : [];

  useEffect(() => {
    if (tab === 'coins' && packages.length === 0) {
      void fetchCoinPackages().then(setPackages);
    }
    if (tab === 'coins') void refreshEconomy();
  }, [tab, packages.length, refreshEconomy]);

  const buyPackage = async (pkg: CoinPackage): Promise<void> => {
    if (purchasing) return;
    setPurchasing(pkg.id);
    // A per-attempt token; a real payment SDK would hand back a signed
    // receipt here instead. See PAYMENTS_LIVE above.
    const token = `${pkg.id}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
    const purchaseId = await recordPurchaseAttempt(pkg.id, 'web', token);
    setPurchasing(null);
    if (!purchaseId) {
      toast('Could not start that purchase', 'error');
      return;
    }
    toast('Purchase recorded — pending verification', 'info', '🧾');
  };

  const onBuy = (cosmetic: Cosmetic): void => {
    const result = purchase(cosmetic.id);
    if (result.ok) {
      audio.play('purchase');
      haptics.fire('reward');
      toast(`${cosmetic.name} unlocked`, 'reward', '✨');
      equip(cosmetic.id);
      setSelected(null);
      return;
    }
    if (result.error === 'needs_coins') toast('Not enough coins', 'error');
    else if (result.error === 'needs_level') toast('Level requirement not met', 'error');
  };

  // Watch Video: starts a real server session first (so the minimum-watch
  // floor is measured against the server's own clock), only asks the ad
  // provider to actually serve a rewarded video, and only claims the reward
  // once that provider reports completion — never merely because the ad
  // started. The daily cap and replay protection are enforced by
  // claim_video_reward itself; this is just the UI around it.
  const watchVideo = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const sessionId = await startVideo();
    if (!sessionId) {
      setBusy(false);
      toast('Couldn’t start that right now', 'error');
      return;
    }
    const outcome = await ads.rewarded('reward_video_coins');
    if (!outcome.completed) {
      setBusy(false);
      toast('Reward not granted', 'error');
      return;
    }
    const result = await claimVideo(sessionId);
    setBusy(false);
    if (result === 'credited') {
      audio.play('coin');
      haptics.fire('reward');
      toast(`+${economyStatus?.videoRewardCoins ?? 10} coins`, 'reward', '🪙');
    } else {
      toast(CLAIM_MESSAGES[result], 'error');
    }
  };

  const onArticleResult = (result: string): void => {
    if (result === 'credited') {
      audio.play('coin');
      haptics.fire('reward');
      toast(`+${economyStatus?.articleRewardCoins ?? 30} coins`, 'reward', '🪙');
    } else {
      toast(CLAIM_MESSAGES[result as CoinRewardClaimResult] ?? 'Reward not granted', 'error');
    }
  };

  return (
    <>
      <header className="topbar">
        <IconButton icon="←" label="Back" onClick={() => go('home')} />
        <h1 className="topbar__title">Store</h1>
        <CoinChip coins={coins} />
      </header>

      <div className="screen__body">
        <Tabs
          tabs={[
            { id: 'skin', label: 'Ball skins' },
            { id: 'trail', label: 'Trails' },
            { id: 'coins', label: 'Coins' },
          ]}
          value={tab}
          onChange={setTab}
        />

        {tab === 'coins' && (
          <div className="stack">
            {/* COIN BALANCE */}
            <Panel
              title="🪙 YOUR COINS"
              tone="amber"
              action={
                <Button variant="ghost" onClick={() => setShowHistory(true)}>
                  History
                </Button>
              }
            >
              <div className="strong" style={{ fontSize: '1.6rem' }}>
                {num(coins)}
              </div>
            </Panel>

            {/* EARN COINS */}
            <p className="tiny muted" style={{ margin: 0 }}>
              EARN COINS
            </p>

            <Panel>
              <div className="row row--between" style={{ marginBottom: 'var(--sp-2)' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="strong">▶ Watch Video</div>
                  <div className="small muted">
                    Today: {num((economyStatus?.videoClaimsToday ?? 0) * (economyStatus?.videoRewardCoins ?? 10))}/
                    {num((economyStatus?.videoRewardDailyLimit ?? 0) * (economyStatus?.videoRewardCoins ?? 10))} Coins
                    earned
                  </div>
                </div>
                <div className="strong numeric">+{economyStatus?.videoRewardCoins ?? 10} 🪙</div>
              </div>
              <Button
                variant="amber"
                block
                disabled={
                  busy ||
                  (economyStatus != null && economyStatus.videoClaimsToday >= economyStatus.videoRewardDailyLimit)
                }
                onClick={() => void watchVideo()}
              >
                {busy
                  ? 'Loading…'
                  : economyStatus != null && economyStatus.videoClaimsToday >= economyStatus.videoRewardDailyLimit
                    ? 'Daily limit reached'
                    : 'WATCH VIDEO'}
              </Button>
            </Panel>

            <Panel>
              <div className="row row--between" style={{ marginBottom: 'var(--sp-2)' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="strong">📖 Read Article</div>
                  <div className="small muted">
                    {Math.ceil(ARTICLE_MIN_READ_SECONDS / 60)} min read · Today:{' '}
                    {economyStatus?.articleClaimsToday ?? 0}/{economyStatus?.articleRewardDailyLimit ?? 0}
                  </div>
                </div>
                <div className="strong numeric">+{economyStatus?.articleRewardCoins ?? 30} 🪙</div>
              </div>
              <Button
                variant="amber"
                block
                disabled={
                  economyStatus != null && economyStatus.articleClaimsToday >= economyStatus.articleRewardDailyLimit
                }
                onClick={() =>
                  setReadingArticle(ARTICLES[Math.floor(Math.random() * ARTICLES.length)] ?? ARTICLES[0])
                }
              >
                {economyStatus != null && economyStatus.articleClaimsToday >= economyStatus.articleRewardDailyLimit
                  ? 'Daily limit reached'
                  : 'READ ARTICLE'}
              </Button>
            </Panel>

            {/* BUY COINS */}
            <p className="tiny muted" style={{ margin: 0 }}>
              BUY COINS
            </p>

            {!PAYMENTS_LIVE && (
              <div className="panel panel--amber center">
                <p className="tiny" style={{ margin: 0 }}>
                  Payments aren’t connected in this build yet — buying a package records the request for review
                  rather than charging you or granting coins immediately.
                </p>
              </div>
            )}
            <div className="grid-2">
              {packages.map((pkg) => (
                <button
                  key={pkg.id}
                  className="cosmetic"
                  disabled={purchasing === pkg.id}
                  onClick={() => void buyPackage(pkg)}
                >
                  <div className="cosmetic__name">🪙 {num(pkg.coins)}</div>
                  <div className="cosmetic__meta">{pkg.name}</div>
                  <div className="strong" style={{ marginTop: 'var(--sp-2)' }}>
                    {purchasing === pkg.id ? 'Requesting…' : `$${(pkg.priceUsdCents / 100).toFixed(2)}`}
                  </div>
                </button>
              ))}
            </div>
            <p className="tiny dim center" style={{ margin: 0 }}>
              Coins are a virtual in-game currency with no cash value. Coins cannot be withdrawn, exchanged, or
              converted into real money.
            </p>
          </div>
        )}

        {tab !== 'coins' && (
        <>
        <div className="grid-2">
          {items.map((cosmetic) => {
            const owned = unlocks.includes(cosmetic.id);
            const isEquipped = equipped[cosmetic.kind === 'skin' ? 'skin' : 'trail'] === cosmetic.id;
            const verdict = evaluateUnlock(cosmetic, { owned, coins, level: level.level });

            return (
              <button
                key={cosmetic.id}
                className={`cosmetic ${isEquipped ? 'cosmetic--equipped' : ''} ${owned ? '' : 'cosmetic--locked'}`}
                onClick={() => {
                  audio.play('ui.tap');
                  if (owned) {
                    equip(cosmetic.id);
                    haptics.fire('select');
                  } else {
                    setSelected(cosmetic);
                  }
                }}
              >
                <span className={`rarity rarity--${cosmetic.rarity}`}>{cosmetic.rarity}</span>
                <CosmeticPreview cosmetic={cosmetic} />
                <div className="cosmetic__name">{cosmetic.name}</div>
                <div className="cosmetic__meta">
                  {isEquipped
                    ? 'Equipped'
                    : owned
                      ? 'Tap to equip'
                      : verdict.reason === 'needs_level' || verdict.reason === 'needs_both'
                        ? `Level ${verdict.level}`
                        : `🪙 ${num(verdict.cost)}`}
                </div>
              </button>
            );
          })}
        </div>

        <p className="tiny dim center" style={{ marginTop: 'var(--sp-4)' }}>
          Every item is cosmetic. Nothing sold here changes speed, control or difficulty. Need coins? Head to the
          Coins tab above — watch a video, read an article, or buy a pack.
        </p>
        </>
        )}
      </div>

      {selected && (
        <Sheet title={selected.name} subtitle={selected.tagline} onClose={() => setSelected(null)}>
          <div style={{ maxWidth: '9rem', margin: '0 auto var(--sp-4)' }}>
            <CosmeticPreview cosmetic={selected} />
          </div>
          <PurchaseActions cosmetic={selected} coins={coins} level={level.level} onBuy={onBuy} />
          <Button variant="ghost" block onClick={() => setSelected(null)}>
            Close
          </Button>
        </Sheet>
      )}

      {showHistory && <CoinHistorySheet onClose={() => setShowHistory(false)} />}

      {readingArticle && (
        <ArticleReaderSheet
          article={readingArticle}
          minReadSeconds={ARTICLE_MIN_READ_SECONDS}
          rewardCoins={economyStatus?.articleRewardCoins ?? 30}
          onClose={() => setReadingArticle(null)}
          onResult={onArticleResult}
        />
      )}
    </>
  );
}

function PurchaseActions({
  cosmetic,
  coins,
  level,
  onBuy,
}: {
  cosmetic: Cosmetic;
  coins: number;
  level: number;
  onBuy: (cosmetic: Cosmetic) => void;
}) {
  const verdict = evaluateUnlock(cosmetic, { owned: false, coins, level });

  if (verdict.reason === 'needs_level' || verdict.reason === 'needs_both') {
    return (
      <div className="stack" style={{ marginBottom: 'var(--sp-3)' }}>
        <Button block disabled>
          Reach level {verdict.level}
        </Button>
        <p className="tiny dim center" style={{ margin: 0 }}>
          {verdict.cost > 0 && `Then ${num(verdict.cost)} coins. `}
          You are level {level}.
        </p>
      </div>
    );
  }

  return (
    <div className="stack" style={{ marginBottom: 'var(--sp-3)' }}>
      <Button variant="amber" size="lg" block disabled={verdict.reason === 'needs_coins'} onClick={() => onBuy(cosmetic)}>
        {verdict.reason === 'needs_coins' ? `Need ${num(verdict.cost - coins)} more` : `Unlock for ${num(verdict.cost)} 🪙`}
      </Button>
    </div>
  );
}

/** Renders a skin as a CSS sphere and a trail as a gradient sweep. */
function CosmeticPreview({ cosmetic }: { cosmetic: Cosmetic }) {
  const toCss = (value: number): string => `#${value.toString(16).padStart(6, '0')}`;

  if (cosmetic.kind === 'skin') {
    const { core, rim, glow } = cosmetic.palette;
    return (
      <div
        className="cosmetic__orb"
        style={{
          background: `radial-gradient(circle at 32% 28%, ${toCss(core)} 0%, ${toCss(glow)} 45%, ${toCss(rim)} 100%)`,
          boxShadow: `inset -6px -8px 18px rgba(0,0,0,0.45), 0 0 18px ${toCss(glow)}44`,
        }}
        aria-hidden="true"
      />
    );
  }

  const stops = cosmetic.colors.map(toCss).join(', ');
  return (
    <div
      className="cosmetic__trail"
      style={{ background: `linear-gradient(100deg, transparent 0%, ${stops} 90%)` }}
      aria-hidden="true"
    />
  );
}
