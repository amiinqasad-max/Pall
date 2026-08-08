/**
 * The store.
 *
 * Cosmetics only. There is no bundle, no gacha, no timer, and nothing here
 * changes how the ball handles — the copy says so plainly, because a player
 * who suspects pay-to-win stops trusting the leaderboard.
 */

import { useEffect, useState } from 'react';
import { SKINS, TRAILS, evaluateUnlock } from '@/data/cosmetics';
import { useCoins, useLevel, useStore } from '@/state/store';
import { useUi } from '@/state/ui';
import { AD_REWARDS, ads } from '@/systems/ads';
import { audio } from '@/systems/audio';
import { haptics } from '@/systems/haptics';
import { fetchCoinPackages, recordPurchaseAttempt } from '@/services/championship';
import { Button, CoinChip, IconButton, Sheet, Tabs } from '@/ui/components/primitives';
import { num } from '@/core/format';
import type { Cosmetic, CoinPackage } from '@/types';

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
  const earnCoins = useStore((s) => s.earnCoins);

  const [tab, setTab] = useState<'skin' | 'trail' | 'coins'>('skin');
  const [selected, setSelected] = useState<Cosmetic | null>(null);
  const [busy, setBusy] = useState(false);
  const [packages, setPackages] = useState<CoinPackage[]>([]);
  const [purchasing, setPurchasing] = useState<string | null>(null);

  const items: Cosmetic[] = tab === 'skin' ? SKINS : tab === 'trail' ? TRAILS : [];

  useEffect(() => {
    if (tab === 'coins' && packages.length === 0) {
      void fetchCoinPackages().then(setPackages);
    }
  }, [tab, packages.length]);

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

  const watchForCoins = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const outcome = await ads.rewarded('reward_coins');
    setBusy(false);
    if (!outcome.completed) {
      toast('Reward not granted', 'error');
      return;
    }
    earnCoins('rewarded_ad', AD_REWARDS.reward_coins, 'Store bonus');
    audio.play('coin');
    haptics.fire('reward');
    toast(`+${AD_REWARDS.reward_coins} coins`, 'reward', '🪙');
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
          <>
            {!PAYMENTS_LIVE && (
              <div className="panel panel--amber center" style={{ marginBottom: 'var(--sp-3)' }}>
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
            <p className="tiny dim center" style={{ marginTop: 'var(--sp-4)' }}>
              Coins are a virtual in-game currency with no cash value. Coins cannot be withdrawn, exchanged, or
              converted into real money.
            </p>
          </>
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

        <div className="panel" style={{ marginTop: 'var(--sp-4)' }}>
          <div className="row row--between" style={{ marginBottom: 'var(--sp-3)' }}>
            <div style={{ minWidth: 0 }}>
              <div className="strong">Need coins?</div>
              <div className="small muted">
                Coins come from rewarded ads, the daily challenge, and login rewards. Never from playing — so the
                leaderboard stays about skill.
              </div>
            </div>
          </div>
          <Button variant="amber" block disabled={busy} onClick={() => void watchForCoins()}>
            {busy ? 'Loading…' : `▶ Watch ad for ${AD_REWARDS.reward_coins} coins`}
          </Button>
        </div>

        <p className="tiny dim center" style={{ marginTop: 'var(--sp-4)' }}>
          Every item is cosmetic. Nothing sold here changes speed, control or difficulty.
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
