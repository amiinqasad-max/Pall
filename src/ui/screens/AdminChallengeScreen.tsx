/**
 * Minimal Championship admin screen.
 *
 * Deliberately plain — per the resolved scope, this pass ships real,
 * staff-gated database functions for every admin capability (see
 * services/admin.ts and the RPCs in supabase/migrations/0002_championship.sql)
 * plus one lightweight screen to drive them from. A polished dashboard is
 * future work; nothing here blocks building one later, since all the actual
 * authority lives in the RPCs, not in this component.
 */

import { useEffect, useState } from 'react';
import { useUi } from '@/state/ui';
import {
  approveCoinOrder,
  cancelChallenge,
  createChallenge,
  deleteArticle,
  endChallenge,
  fetchAllArticles,
  fetchChallengeConfig,
  fetchChallengeMonitoring,
  fetchCoinOrders,
  fetchEconomyConfig,
  fetchPayouts,
  fetchRecentChallenges,
  isStaff,
  markPayoutApproved,
  markPayoutPaid,
  markPayoutVerified,
  pauseChallenge,
  rejectCoinOrder,
  resumeChallenge,
  startChallenge,
  updateChallengeConfig,
  updateEconomyConfig,
  updateRegionSetting,
  upsertArticle,
  type AdminArticleRow,
  type AdminChallengeConfig,
  type AdminChallengeRow,
  type AdminCoinOrderRow,
  type AdminEconomyConfig,
  type AdminPayoutRow,
  type ChallengeMonitoring,
} from '@/services/admin';
import { IconButton, Panel } from '@/ui/components/primitives';
import { num } from '@/core/format';

export function AdminChallengeScreen() {
  const go = useUi((s) => s.go);
  const toast = useUi((s) => s.toast);
  const [authorized, setAuthorized] = useState<'checking' | 'yes' | 'no'>('checking');
  const [challenges, setChallenges] = useState<AdminChallengeRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [monitoring, setMonitoring] = useState<ChallengeMonitoring | null>(null);
  const [config, setConfig] = useState<AdminChallengeConfig | null>(null);
  const [prizeDistributionText, setPrizeDistributionText] = useState('');
  const [economyConfig, setEconomyConfig] = useState<AdminEconomyConfig | null>(null);
  const [payouts, setPayouts] = useState<AdminPayoutRow[]>([]);
  const [payoutRefs, setPayoutRefs] = useState<Record<string, string>>({});
  const [newDate, setNewDate] = useState('');
  const [startTime, setStartTime] = useState('00:00');
  const [endTime, setEndTime] = useState('23:59');
  const [country, setCountry] = useState('');
  const [regionEnabled, setRegionEnabled] = useState(false);
  const [articles, setArticles] = useState<AdminArticleRow[]>([]);
  const [articleDraft, setArticleDraft] = useState({ id: '', title: '', url: '', active: true });
  const [coinOrders, setCoinOrders] = useState<AdminCoinOrderRow[]>([]);
  const [ordersFilter, setOrdersFilter] = useState<'pending_verification' | 'all'>('pending_verification');

  useEffect(() => {
    void isStaff().then((ok) => setAuthorized(ok ? 'yes' : 'no'));
  }, []);

  const reloadChallenges = async (): Promise<void> => {
    setChallenges(await fetchRecentChallenges());
  };

  const reloadArticles = async (): Promise<void> => {
    setArticles(await fetchAllArticles());
  };

  const reloadOrders = async (filter: 'pending_verification' | 'all'): Promise<void> => {
    setCoinOrders(await fetchCoinOrders(filter === 'all' ? undefined : filter));
  };

  useEffect(() => {
    if (authorized !== 'yes') return;
    void reloadChallenges();
    void fetchChallengeConfig().then((cfg) => {
      setConfig(cfg);
      if (cfg) setPrizeDistributionText(JSON.stringify(cfg.defaultPrizeDistribution, null, 2));
    });
    void fetchEconomyConfig().then(setEconomyConfig);
    void reloadArticles();
    void reloadOrders(ordersFilter);
    // ordersFilter deliberately omitted: this effect is the initial staff-
    // gated load only, the filter dropdown below re-fetches on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized]);

  const reloadPayouts = async (challengeId: string): Promise<void> => {
    setPayouts(await fetchPayouts(challengeId));
  };

  useEffect(() => {
    if (!selected) return;
    void fetchChallengeMonitoring(selected).then(setMonitoring);
    void reloadPayouts(selected);
  }, [selected]);

  const runLifecycle = async (
    label: string,
    fn: (id: string) => Promise<boolean>,
  ): Promise<void> => {
    if (!selected) return;
    const ok = await fn(selected);
    toast(ok ? `${label} succeeded` : `${label} failed`, ok ? 'info' : 'error');
    void reloadChallenges();
    void fetchChallengeMonitoring(selected).then(setMonitoring);
  };

  if (authorized === 'checking') {
    return (
      <div className="screen__body">
        <p className="small muted center">Checking access…</p>
      </div>
    );
  }

  if (authorized === 'no') {
    return (
      <>
        <header className="topbar">
          <IconButton icon="←" label="Back" onClick={() => go('home')} />
          <h1 className="topbar__title">Admin</h1>
        </header>
        <div className="screen__body">
          <Panel>
            <p className="small center" style={{ margin: 0 }}>
              This account isn’t staff. Grant access with
              `insert into tartan.staff_roles (user_id, role) values (…, 'admin')`.
            </p>
          </Panel>
        </div>
      </>
    );
  }

  return (
    <>
      <header className="topbar">
        <IconButton icon="←" label="Back" onClick={() => go('home')} />
        <h1 className="topbar__title">Championship admin</h1>
      </header>

      <div className="screen__body">
        <div className="stack">
          <Panel title="Create challenge">
            <div className="stack stack--tight">
              <label className="row row--between small">
                <span>Date</span>
                <input
                  type="date"
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                  style={{ padding: '0.5rem', borderRadius: 8 }}
                />
              </label>
              <label className="row row--between small">
                <span>Start time (UTC)</span>
                <input
                  type="time"
                  value={startTime}
                  onChange={(e) => setStartTime(e.target.value)}
                  style={{ padding: '0.5rem', borderRadius: 8 }}
                />
              </label>
              <label className="row row--between small">
                <span>End time (UTC)</span>
                <input
                  type="time"
                  value={endTime}
                  onChange={(e) => setEndTime(e.target.value)}
                  style={{ padding: '0.5rem', borderRadius: 8 }}
                />
              </label>
              <button
                className="btn btn--sm btn--primary"
                onClick={async () => {
                  if (!newDate) return;
                  const start = new Date(`${newDate}T${startTime}:00Z`).toISOString();
                  const end = new Date(`${newDate}T${endTime}:59Z`).toISOString();
                  const id = await createChallenge(newDate, start, end);
                  toast(id ? `Challenge created (${startTime}–${endTime} UTC)` : 'Failed to create challenge', id ? 'info' : 'error');
                  void reloadChallenges();
                }}
              >
                Create
              </button>
            </div>
          </Panel>

          <Panel title="Recent challenges">
            <div className="stack stack--tight">
              {challenges.map((c) => (
                <button
                  key={c.id}
                  className={`listrow ${selected === c.id ? 'listrow--self' : ''}`}
                  onClick={() => setSelected(c.id)}
                  style={{ width: '100%', textAlign: 'left' }}
                >
                  <div className="listrow__main">
                    <div className="listrow__name">{c.challengeDate}</div>
                    <div className="tiny dim">{c.status}</div>
                  </div>
                </button>
              ))}
              {challenges.length === 0 && <p className="tiny dim center">No challenges yet.</p>}
            </div>
          </Panel>

          {selected && (
            <Panel title="Lifecycle">
              <div className="row" style={{ gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
                <button className="btn btn--sm" onClick={() => void runLifecycle('Start', startChallenge)}>
                  Start
                </button>
                <button className="btn btn--sm" onClick={() => void runLifecycle('Pause', pauseChallenge)}>
                  Pause
                </button>
                <button className="btn btn--sm" onClick={() => void runLifecycle('Resume', resumeChallenge)}>
                  Resume
                </button>
                <button className="btn btn--sm btn--amber" onClick={() => void runLifecycle('End', endChallenge)}>
                  End
                </button>
                <button className="btn btn--sm btn--danger" onClick={() => void runLifecycle('Cancel', cancelChallenge)}>
                  Cancel
                </button>
              </div>
            </Panel>
          )}

          {monitoring && (
            <Panel title="Monitoring">
              <div className="statgrid">
                {(
                  [
                    ['Participants', monitoring.totalParticipants],
                    ['Qualified', monitoring.qualified],
                    ['Finalists', monitoring.finalists],
                    ['Flagged', monitoring.flagged],
                    ['Disqualified', monitoring.disqualified],
                    ['Winners', monitoring.winners],
                    ['Pending payouts', monitoring.pendingPayouts],
                    ['Paid', monitoring.completedPayouts],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <div className="statgrid__value">{value}</div>
                    <div className="statgrid__label">{label}</div>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {selected && payouts.length > 0 && (
            <Panel title="Payouts">
              <p className="tiny dim" style={{ marginTop: 0 }}>
                Pending Verification → Verified → Approved → Paid. "Paid" only records that money moved outside this
                system — it never moves anything itself, and requires a reference.
              </p>
              <div className="stack stack--tight">
                {payouts.map((p) => (
                  <div key={p.id} className="listrow" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                    <div className="row row--between small">
                      <span className="strong">
                        #{p.rank} · {num(p.finalScore)} pts · ${(p.prizeAmountCents / 100).toFixed(2)}
                      </span>
                      <span className="tiny dim">
                        {p.verificationStatus} / {p.payoutStatus}
                      </span>
                    </div>
                    <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 6, flexWrap: 'wrap' }}>
                      {p.verificationStatus === 'pending_verification' && (
                        <button
                          className="btn btn--sm"
                          onClick={async () => {
                            const ok = await markPayoutVerified(p.id);
                            toast(ok ? 'Verified' : 'Failed', ok ? 'info' : 'error');
                            void reloadPayouts(selected);
                          }}
                        >
                          Mark verified
                        </button>
                      )}
                      {p.verificationStatus === 'verified' && p.payoutStatus === 'pending' && (
                        <button
                          className="btn btn--sm"
                          onClick={async () => {
                            const ok = await markPayoutApproved(p.id);
                            toast(ok ? 'Approved' : 'Failed', ok ? 'info' : 'error');
                            void reloadPayouts(selected);
                          }}
                        >
                          Approve
                        </button>
                      )}
                      {p.payoutStatus === 'approved' && (
                        <>
                          <input
                            placeholder="External reference"
                            value={payoutRefs[p.id] ?? ''}
                            onChange={(e) => setPayoutRefs({ ...payoutRefs, [p.id]: e.target.value })}
                            style={{ flex: 1, minWidth: '8rem', padding: '0.3rem', borderRadius: 6 }}
                          />
                          <button
                            className="btn btn--sm btn--primary"
                            onClick={async () => {
                              const ref = payoutRefs[p.id] ?? '';
                              const ok = await markPayoutPaid(p.id, ref);
                              toast(ok ? 'Marked paid' : 'Reference required', ok ? 'info' : 'error');
                              void reloadPayouts(selected);
                            }}
                          >
                            Mark paid
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {config && (
            <Panel title="Qualification & prize config">
              <div className="stack stack--tight">
                {(
                  [
                    ['Reference percentile', 'referencePercentile'],
                    ['Qualification multiplier', 'qualificationMultiplier'],
                    ['Minimum target', 'minimumTarget'],
                    ['Maximum target', 'maximumTarget'],
                    ['Fallback target', 'fallbackTarget'],
                    ['Minimum sample size', 'minimumSampleSize'],
                    ['Prize pool (cents)', 'defaultPrizePoolCents'],
                    ['Winner count', 'defaultWinnerCount'],
                    ['Max final attempts', 'defaultMaxFinalAttempts'],
                  ] as [string, Exclude<keyof AdminChallengeConfig, 'defaultPrizeDistribution'>][]
                ).map(([label, key]) => (
                  <label key={key} className="row row--between small">
                    <span>{label}</span>
                    <input
                      type="number"
                      value={config[key]}
                      onChange={(e) => setConfig({ ...config, [key]: Number(e.target.value) })}
                      style={{ width: '7rem', padding: '0.3rem', borderRadius: 6 }}
                    />
                  </label>
                ))}
                <label className="small" style={{ display: 'block' }}>
                  <span style={{ display: 'block', marginBottom: 4 }}>
                    Prize distribution (jsonb — one entry per exact rank or a rank range)
                  </span>
                  <textarea
                    value={prizeDistributionText}
                    onChange={(e) => setPrizeDistributionText(e.target.value)}
                    rows={6}
                    style={{ width: '100%', padding: '0.5rem', borderRadius: 6, fontFamily: 'monospace', fontSize: '0.8rem' }}
                  />
                </label>
                <button
                  className="btn btn--sm btn--primary"
                  onClick={async () => {
                    let distribution: unknown[];
                    try {
                      const parsed = JSON.parse(prizeDistributionText);
                      if (!Array.isArray(parsed)) throw new Error('not an array');
                      distribution = parsed;
                    } catch {
                      toast('Prize distribution must be valid JSON array', 'error');
                      return;
                    }
                    const ok = await updateChallengeConfig({ ...config, defaultPrizeDistribution: distribution });
                    toast(ok ? 'Config saved' : 'Save failed', ok ? 'info' : 'error');
                  }}
                >
                  Save config
                </button>
              </div>
              <p className="tiny dim" style={{ marginTop: 'var(--sp-2)' }}>
                Only affects challenges created after this save — an active or ended challenge already froze its own
                copy of these numbers.
              </p>
            </Panel>
          )}

          <Panel title="Region cash-prize gating">
            <div className="row" style={{ gap: 'var(--sp-2)' }}>
              <input
                placeholder="Country code, e.g. US"
                value={country}
                onChange={(e) => setCountry(e.target.value.toUpperCase())}
                style={{ flex: 1, padding: '0.5rem', borderRadius: 8 }}
                maxLength={2}
              />
              <label className="row small">
                <input
                  type="checkbox"
                  checked={regionEnabled}
                  onChange={(e) => setRegionEnabled(e.target.checked)}
                />
                Enabled
              </label>
              <button
                className="btn btn--sm btn--primary"
                onClick={async () => {
                  if (country.length !== 2) return;
                  const ok = await updateRegionSetting(country, regionEnabled, null);
                  toast(ok ? `${country} updated` : 'Update failed', ok ? 'info' : 'error');
                }}
              >
                Save
              </button>
            </div>
            <p className="tiny dim" style={{ marginTop: 'var(--sp-2)' }}>
              Fails closed: any country with no row here shows no cash prizes. Verify the applicable law and app-store
              policy for a region before enabling it.
            </p>
          </Panel>

          {economyConfig && (
            <Panel title="Coin economy">
              <div className="stack stack--tight">
                {(
                  [
                    ['Revive cost (coins)', 'reviveCostCoins'],
                    ['Read Article reward (coins)', 'articleRewardCoins'],
                    ['Read Article daily limit', 'articleRewardDailyLimit'],
                    ['Read Article minimum read time (s)', 'articleMinReadSeconds'],
                  ] as [string, keyof AdminEconomyConfig][]
                ).map(([label, key]) => (
                  <label key={key} className="row row--between small">
                    <span>{label}</span>
                    <input
                      type="number"
                      value={economyConfig[key]}
                      onChange={(e) => setEconomyConfig({ ...economyConfig, [key]: Number(e.target.value) })}
                      style={{ width: '7rem', padding: '0.3rem', borderRadius: 6 }}
                    />
                  </label>
                ))}
                <button
                  className="btn btn--sm btn--primary"
                  onClick={async () => {
                    const ok = await updateEconomyConfig(economyConfig);
                    toast(ok ? 'Economy config saved' : 'Save failed', ok ? 'info' : 'error');
                  }}
                >
                  Save economy config
                </button>
              </div>
              <p className="tiny dim" style={{ marginTop: 'var(--sp-2)' }}>
                These are the same tartan.game_constants rows spend_coins_for_revive/claim_article_reward already
                read directly — changes apply to the next call, not retroactively.
              </p>
            </Panel>
          )}

          <Panel title="Articles">
            <p className="tiny dim" style={{ marginTop: 0 }}>
              The Store's "Read Article" button opens a random active link from this list. Deactivating one keeps its
              history intact but stops it being picked; deleting removes it entirely.
            </p>
            <div className="stack stack--tight" style={{ marginBottom: 'var(--sp-3)' }}>
              {articles.map((a) => (
                <div key={a.id} className="listrow" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <div className="row row--between small">
                    <span className="strong" style={{ opacity: a.active ? 1 : 0.5 }}>
                      {a.title}
                    </span>
                    <span className="tiny dim">{a.active ? 'active' : 'inactive'}</span>
                  </div>
                  <a href={a.url} target="_blank" rel="noopener noreferrer" className="tiny dim" style={{ wordBreak: 'break-all' }}>
                    {a.url}
                  </a>
                  <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 6, flexWrap: 'wrap' }}>
                    <button
                      className="btn btn--sm"
                      onClick={() => setArticleDraft({ id: a.id, title: a.title, url: a.url, active: a.active })}
                    >
                      Edit
                    </button>
                    <button
                      className="btn btn--sm"
                      onClick={async () => {
                        const ok = await upsertArticle(a.id, a.title, a.url, !a.active);
                        toast(ok ? (a.active ? 'Deactivated' : 'Activated') : 'Failed', ok ? 'info' : 'error');
                        void reloadArticles();
                      }}
                    >
                      {a.active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      className="btn btn--sm btn--danger"
                      onClick={async () => {
                        const ok = await deleteArticle(a.id);
                        toast(ok ? 'Deleted' : 'Failed', ok ? 'info' : 'error');
                        void reloadArticles();
                      }}
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
              {articles.length === 0 && <p className="tiny dim center">No articles yet.</p>}
            </div>

            <div className="stack stack--tight">
              <p className="small strong" style={{ margin: 0 }}>
                {articleDraft.id ? 'Edit article' : 'Add article'}
              </p>
              <input
                placeholder="Title"
                value={articleDraft.title}
                onChange={(e) => setArticleDraft({ ...articleDraft, title: e.target.value })}
                style={{ padding: '0.5rem', borderRadius: 8 }}
              />
              <input
                placeholder="https://…"
                value={articleDraft.url}
                onChange={(e) => setArticleDraft({ ...articleDraft, url: e.target.value })}
                style={{ padding: '0.5rem', borderRadius: 8 }}
              />
              <label className="row small">
                <input
                  type="checkbox"
                  checked={articleDraft.active}
                  onChange={(e) => setArticleDraft({ ...articleDraft, active: e.target.checked })}
                />
                Active
              </label>
              <div className="row" style={{ gap: 'var(--sp-2)' }}>
                <button
                  className="btn btn--sm btn--primary"
                  onClick={async () => {
                    if (!articleDraft.title.trim() || !articleDraft.url.trim()) return;
                    const ok = await upsertArticle(
                      articleDraft.id || null,
                      articleDraft.title,
                      articleDraft.url,
                      articleDraft.active,
                    );
                    toast(ok ? 'Saved' : 'Save failed', ok ? 'info' : 'error');
                    if (ok) setArticleDraft({ id: '', title: '', url: '', active: true });
                    void reloadArticles();
                  }}
                >
                  {articleDraft.id ? 'Save changes' : 'Add article'}
                </button>
                {articleDraft.id && (
                  <button
                    className="btn btn--sm"
                    onClick={() => setArticleDraft({ id: '', title: '', url: '', active: true })}
                  >
                    Cancel edit
                  </button>
                )}
              </div>
            </div>
          </Panel>

          <Panel title="Coin Orders">
            <p className="tiny dim" style={{ marginTop: 0 }}>
              WhatsApp Buy Coins orders. Approving credits the buyer's coins immediately through the same
              server-authoritative ledger every other coin source uses — only do this after confirming the payment
              actually arrived.
            </p>
            <div className="row" style={{ gap: 'var(--sp-2)', marginBottom: 'var(--sp-3)' }}>
              {(['pending_verification', 'all'] as const).map((f) => (
                <button
                  key={f}
                  className={`btn btn--sm ${ordersFilter === f ? 'btn--primary' : ''}`}
                  onClick={() => {
                    setOrdersFilter(f);
                    void reloadOrders(f);
                  }}
                >
                  {f === 'pending_verification' ? 'Pending' : 'All'}
                </button>
              ))}
            </div>
            <div className="stack stack--tight">
              {coinOrders.map((o) => (
                <div key={o.id} className="listrow" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <div className="row row--between small">
                    <span className="strong">
                      🪙 {num(o.coins)} · {o.priceBirr} Birr
                    </span>
                    <span className="tiny dim">{o.status}</span>
                  </div>
                  <span className="tiny dim">
                    {o.packageName} · {o.platform} · {new Date(o.createdAt).toLocaleString()}
                  </span>
                  <span className="tiny dim" style={{ wordBreak: 'break-all' }}>
                    buyer {o.userId} · ref {o.receiptToken}
                  </span>
                  {o.status === 'pending_verification' && (
                    <div className="row" style={{ gap: 'var(--sp-2)', marginTop: 6, flexWrap: 'wrap' }}>
                      <button
                        className="btn btn--sm btn--primary"
                        onClick={async () => {
                          const ok = await approveCoinOrder(o.id);
                          toast(ok ? 'Approved — coins credited' : 'Approve failed', ok ? 'info' : 'error');
                          void reloadOrders(ordersFilter);
                        }}
                      >
                        Approve &amp; credit
                      </button>
                      <button
                        className="btn btn--sm btn--danger"
                        onClick={async () => {
                          const ok = await rejectCoinOrder(o.id, 'rejected from admin panel');
                          toast(ok ? 'Rejected' : 'Reject failed', ok ? 'info' : 'error');
                          void reloadOrders(ordersFilter);
                        }}
                      >
                        Reject
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {coinOrders.length === 0 && <p className="tiny dim center">No orders.</p>}
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
