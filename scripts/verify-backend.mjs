/**
 * End-to-end verification against a real Supabase project.
 *
 * Asserts the parts that cannot be checked any other way: that anonymous
 * sign-in works, that the server-side validator actually rejects impossible
 * runs, that RLS blocks the direct write path into `runs`, and that the coin
 * faucet refuses a source outside the three legitimate ones.
 *
 * Needs VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in the environment.
 * Reads and writes real rows, so point it at a project you are happy to have
 * probe data in.
 */
import { createClient } from '@supabase/supabase-js';

const URL = process.env.VITE_SUPABASE_URL;
const KEY = process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const sb = createClient(URL, KEY, { db: { schema: 'tartan' }, auth: { persistSession: false } });

let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) fails++; };

console.log('\nbackend checks');

const { data: auth, error: authErr } = await sb.auth.signInAnonymously();
check(!authErr && !!auth?.session, `anonymous sign-in (${authErr?.message ?? 'user ' + auth?.user?.id?.slice(0,8)})`);
if (authErr) { process.exit(1); }

// A legitimate run: 1200m in 40s, well inside every bound.
const legit = {
  p_score: 1500, p_distance: 1200, p_duration_ms: 40000, p_prisms: 8,
  p_obstacles_dodged: 20, p_near_misses: 3, p_stage: 1, p_seed: 12345,
  p_daily: false, p_continued: false, p_username: 'BackendProbe', p_level: 3,
};
const { data: ok1, error: e1 } = await sb.rpc('submit_run', legit);
check(!e1 && ok1 === true, `submit_run accepts a legitimate run (${e1?.message ?? 'returned ' + ok1})`);

// Impossible: 50km in 5 seconds. Terminal speed is 63 m/s.
const { data: ok2, error: e2 } = await sb.rpc('submit_run', {
  ...legit, p_score: 9999999, p_distance: 50000, p_duration_ms: 5000,
});
check(!e2 && ok2 === false, `submit_run REJECTS an impossible run (${e2?.message ?? 'returned ' + ok2})`);

// Score inflated far beyond what the scoring formula can produce.
const { data: ok3, error: e3 } = await sb.rpc('submit_run', { ...legit, p_score: 5000000 });
check(!e3 && ok3 === false, `submit_run REJECTS an inflated score (${e3?.message ?? 'returned ' + ok3})`);

// The client must not be able to write a score directly.
const { error: e4 } = await sb.from('runs').insert({
  user_id: auth.user.id, score: 999999, distance: 1, duration_ms: 1000,
});
check(!!e4, `direct INSERT into runs is denied by RLS (${e4?.message?.slice(0, 60) ?? 'NOT DENIED'})`);

// Leaderboards.
for (const scope of ['global', 'daily', 'weekly']) {
  const { data, error } = await sb.rpc('leaderboard_page', { p_scope: scope, p_limit: 10 });
  check(!error && Array.isArray(data), `leaderboard_page('${scope}') -> ${error?.message ?? data.length + ' rows'}`);
}
const { data: rank, error: rankErr } = await sb.rpc('leaderboard_self_rank', { p_scope: 'global' });
check(!rankErr, `leaderboard_self_rank -> ${rankErr?.message ?? 'rank ' + rank}`);

// Coin faucet: valid source accepted, gameplay source rejected by CHECK.
const { data: bal, error: cErr } = await sb.rpc('grant_coins', {
  p_amount: 120, p_reason: 'rewarded_ad', p_detail: 'backend probe',
});
check(!cErr && typeof bal === 'number', `grant_coins('rewarded_ad') -> ${cErr?.message ?? 'balance ' + bal}`);

const { error: badErr } = await sb.rpc('grant_coins', { p_amount: 500, p_reason: 'gameplay' });
check(!!badErr, `grant_coins REJECTS an illegitimate source (${badErr?.message?.slice(0, 50) ?? 'NOT REJECTED'})`);

// Cloud save round-trip.
const { error: upErr } = await sb.from('profiles').upsert({
  user_id: auth.user.id, username: 'BackendProbe', coins: 120, total_xp: 500, level: 3,
  save: { probe: true }, updated_at: new Date().toISOString(),
}, { onConflict: 'user_id' });
check(!upErr, `cloud save upsert (${upErr?.message?.slice(0, 60) ?? 'ok'})`);

const { data: profile, error: readErr } = await sb.from('profiles')
  .select('username, coins, save').eq('user_id', auth.user.id).maybeSingle();
check(!readErr && profile?.save?.probe === true, `cloud save read back (${readErr?.message ?? JSON.stringify(profile?.save)})`);

// Analytics is write-only from the client.
const { error: aErr } = await sb.from('analytics_events').insert({
  user_id: auth.user.id, session_id: 'probe', name: 'backend_probe',
  props: {}, occurred_at: new Date().toISOString(), seq: 1,
});
check(!aErr, `analytics insert (${aErr?.message?.slice(0, 60) ?? 'ok'})`);

const { data: aRead, error: aReadErr } = await sb.from('analytics_events').select('id').limit(1);
check(
  Boolean(aReadErr) || (Array.isArray(aRead) && aRead.length === 0),
  `analytics is write-only (${aReadErr ? 'denied: ' + aReadErr.message.slice(0, 40) : (aRead?.length ?? '?') + ' rows'})`,
);

console.log(fails === 0 ? '\nall backend checks passed\n' : `\n${fails} backend check(s) failed\n`);
process.exit(fails === 0 ? 0 : 1);
