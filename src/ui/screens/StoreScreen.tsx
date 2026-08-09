/**
 * The store.
 *
 * Cosmetics, plus the Coins tab: earn (limited gameplay rewards handled
 * elsewhere in Missions, plus Read Article here) and buy. There is no
 * bundle, no gacha, no timer on the cosmetics side, and nothing sold here
 * changes how the ball handles — the copy says so plainly, because a player
 * who suspects pay-to-win stops trusting the leaderboard.
 *
 * Buying a Coins package opens a pre-filled WhatsApp order (see
 * supabase/migrations/0005_coins_store_v2.sql) — nothing here ever credits
 * coins itself; a staff member verifies the payment and credits the order
 * by hand through the same server-authoritative ledger every other coin
 * source writes to.
 */

import { useEffect, useState } from 'react';
import { SKINS, TRAILS, evaluateUnlock } from '@/data/cosmetics';
import { useCoins, useLevel, useStore } from '@/state/store';
import { useEconomy } from '@/state/economy';
import { useUi } from '@/state/ui';
import { audio } from '@/systems/audio';
import { haptics } from '@/systems/haptics';
import { fetchCoinPackages, recordPurchaseAttempt } from '@/services/championship';
import { ARTICLE_MIN_READ_SECONDS, fetchActiveArticles } from '@/services/coinEconomy';
import { Button, CoinChip, IconButton, Panel, Sheet, Tabs } from '@/ui/components/primitives';
import { ArticleReaderSheet } from '@/ui/components/ArticleReaderSheet';
import { CoinHistorySheet } from '@/ui/components/CoinHistorySheet';
import { num } from '@/core/format';
import type { Article, Cosmetic, CoinPackage, CoinRewardClaimResult } from '@/types';

const CLAIM_MESSAGES: Record<CoinRewardClaimResult, string> = {
  credited: 'Reward granted',
  already_claimed: 'Already claimed',
  too_early: 'Not quite yet',
  daily_limit_reached: 'Today’s limit reached — come back tomorrow',
  not_found: 'Reward not granted',
  offline: 'Couldn’t reach the server — try again',
  not_signed_in: 'Not signed in',
};

/** The one number in this file a real deployment must change — see
 *  supabase/migrations/0005_coins_store_v2.sql's header. */
const WHATSAPP_NUMBER = '251915285572';

function buildOrderMessage(pkg: CoinPackage, orderId: string): string {
  return (
    `TARTAN Coins order\n` +
    `Package: ${pkg.name}\n` +
    `Coins: ${pkg.coins}\n` +
    `Price: ${pkg.priceBirr} Birr\n` +
    `Order ID: ${orderId}`
  );
}

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

  const [tab, setTab] = useState<'skin' | 'trail' | 'coins'>('skin');
  const [selected, setSelected] = useState<Cosmetic | null>(null);
  const [packages, setPackages] = useState<CoinPackage[]>([]);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [articles, setArticles] = useState<Article[]>([]);
  const [articlesLoaded, setArticlesLoaded] = useState(false);
  const [readingArticle, setReadingArticle] = useState<Article | null>(null);

  const items: Cosmetic[] = tab === 'skin' ? SKINS : tab === 'trail' ? TRAILS : [];

  useEffect(() => {
    if (tab !== 'coins') return;
    if (packages.length === 0) void fetchCoinPackages().then(setPackages);
    if (!articlesLoaded) void fetchActiveArticles().then((a) => { setArticles(a); setArticlesLoaded(true); });
    void refreshEconomy();
  }, [tab, packages.length, articlesLoaded, refreshEconomy]);

  // Buying a package never credits coins itself — it records a real,
  // auditable purchase_records row (so a staff member has something to
  // approve against) and opens WhatsApp with the order pre-filled in.
  // Coins are only ever credited once staff verifies the payment and
  // approves the order from the admin panel's Coin Orders section.
  const buyPackage = async (pkg: CoinPackage): Promise<void> => {
    if (purchasing) return;
    setPurchasing(pkg.id);
    const token = `${pkg.id}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
    const purchaseId = await recordPurchaseAttempt(pkg.id, 'whatsapp', token);
    setPurchasing(null);
    if (!purchaseId) {
      toast('Could not start that order', 'error');
      return;
    }
    const message = buildOrderMessage(pkg, purchaseId);
    window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`, '_blank', 'noopener,noreferrer');
    toast('Order recorded — send the WhatsApp message to complete it', 'info', '🧾');
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

  const readArticle = (): void => {
    if (articles.length === 0) return;
    setReadingArticle(articles[Math.floor(Math.random() * articles.length)]);
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
                  articlesLoaded && articles.length === 0
                    ? true
                    : economyStatus != null && economyStatus.articleClaimsToday >= economyStatus.articleRewardDailyLimit
                }
                onClick={readArticle}
              >
                {articlesLoaded && articles.length === 0
                  ? 'No articles available'
                  : economyStatus != null && economyStatus.articleClaimsToday >= economyStatus.articleRewardDailyLimit
                    ? 'Daily limit reached'
                    : 'READ ARTICLE'}
              </Button>
            </Panel>

            {/* BUY COINS */}
            <p className="tiny muted" style={{ margin: 0 }}>
              BUY COINS
            </p>

            <div className="panel panel--amber center">
              <p className="tiny" style={{ margin: 0 }}>
                Buying a package opens WhatsApp with your order pre-filled in. It doesn’t charge you or grant coins by
                itself — send the message, and a staff member credits your coins once your payment is confirmed.
              </p>
            </div>
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
                    {purchasing === pkg.id ? 'Opening WhatsApp…' : `${num(pkg.priceBirr)} Birr`}
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
          Coins tab above — read an article or buy a pack.
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
