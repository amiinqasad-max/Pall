-- TARTAN — Coin economy expansion.
--
-- Adds two new, fully server-authoritative earning methods (Watch Video,
-- Read Article) on top of the coin economy already built in 0001/0002, and
-- raises the Revive price from 50 to 100 coins. Nothing about the
-- Championship (qualification, final, leaderboard, payout state machine) is
-- touched by this file.
--
-- Design notes:
--
--  * There is exactly one balance column (tartan.profiles.coins) and, as of
--    this file, exactly one ledger for every source added here
--    (tartan.coin_transactions, already built in 0002 for purchase_credit/
--    revive_spend) -- no second, competing balance or ledger table.
--    tartan.coin_ledger (0001, still used by grant_coins) is untouched.
--
--  * Neither "watched a video" nor "read an article" is something this
--    build can prove the way a payment or a physics-bounded run score can:
--    there is no ad-network server-to-server reward postback wired in here
--    (that needs a real ad network account and webhook signature
--    verification this project does not have -- the same honesty already
--    stated in 0002's header for purchases/payouts), and no server can
--    confirm a human read every word of an article. What genuinely can be
--    enforced server-side, and is: a session the server itself timestamps
--    at start, a minimum elapsed time measured against the server's own
--    clock rather than anything the client reports (so a manipulated
--    client-side clock cannot shorten it), exactly one claim per session,
--    and a hard, admin-configurable daily cap per source. That turns
--    "unlimited instant farming loop" into "bounded, rate-limited,
--    replay-proof" -- the honest ceiling of what's achievable without a
--    real ad-network/content-provider integration.

-- ---------------------------------------------------------------- constants

update tartan.game_constants set value = 100, updated_at = now() where key = 'revive_cost_coins';

insert into tartan.game_constants (key, value) values
  ('video_reward_coins',         10),
  ('video_reward_daily_limit',   10),
  ('video_min_watch_seconds',     8),
  ('article_reward_coins',       30),
  ('article_reward_daily_limit',  3),
  ('article_min_read_seconds',  120)
on conflict (key) do nothing;

-- ---------------------------------------------------- coin_transactions reasons

-- Widen the existing ledger's reason vocabulary rather than adding a second
-- table -- video_reward/article_reward sit alongside the purchase_credit/
-- revive_spend/admin_adjustment reasons 0002 already defined here.
alter table tartan.coin_transactions drop constraint if exists coin_transactions_reason_check;
alter table tartan.coin_transactions add constraint coin_transactions_reason_check
  check (reason in ('purchase_credit', 'revive_spend', 'admin_adjustment', 'video_reward', 'article_reward'));

-- --------------------------------------------------------- video reward

create table if not exists tartan.video_ad_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  started_at  timestamptz not null default now(),
  claimed     boolean not null default false,
  claimed_at  timestamptz
);

create index if not exists video_ad_sessions_user_idx on tartan.video_ad_sessions (user_id, started_at desc);

alter table tartan.video_ad_sessions enable row level security;

drop policy if exists "video sessions: read own or staff" on tartan.video_ad_sessions;
create policy "video sessions: read own or staff"
  on tartan.video_ad_sessions for select
  using (auth.uid() = user_id or tartan.is_staff(auth.uid()));

-- No INSERT/UPDATE policy: start_video_ad_session()/claim_video_reward() are
-- the only writers.

create or replace function tartan.start_video_ad_session()
returns uuid
language plpgsql
security definer
set search_path = tartan
as $$
declare
  v_user   uuid := auth.uid();
  v_id     uuid;
  v_recent int;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- A coarse brake on session spam, independent of the daily reward cap
  -- below -- nobody legitimately starts more than a handful of these a
  -- minute, and this is the cheapest possible brake on a scripted caller.
  select count(*) into v_recent from tartan.video_ad_sessions
   where user_id = v_user and started_at > now() - interval '1 minute';
  if v_recent >= 10 then
    raise exception 'too many attempts, try again shortly' using errcode = '22023';
  end if;

  insert into tartan.video_ad_sessions (user_id) values (v_user) returning id into v_id;
  return v_id;
end;
$$;

grant execute on function tartan.start_video_ad_session() to authenticated;

-- Returns one of: 'credited', 'already_claimed', 'too_early',
-- 'daily_limit_reached', 'not_found' -- mirrors submit_qualification_run's
-- status-string convention rather than raising for every non-success case,
-- since all of these are legitimate, expected outcomes the UI must react to.
create or replace function tartan.claim_video_reward(p_session_id uuid)
returns text
language plpgsql
security definer
set search_path = tartan
as $$
declare
  v_user     uuid := auth.uid();
  v_session  tartan.video_ad_sessions%rowtype;
  v_amount   bigint := tartan.game_const('video_reward_coins');
  v_min_secs numeric := tartan.game_const('video_min_watch_seconds');
  v_daily_cap int := tartan.game_const('video_reward_daily_limit')::int;
  v_today_ct int;
  v_balance  bigint;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Locked for the duration of this call so two concurrent claims against
  -- the same session cannot both pass the "not yet claimed" check.
  select * into v_session from tartan.video_ad_sessions
   where id = p_session_id and user_id = v_user
   for update;
  if not found then
    return 'not_found';
  end if;
  if v_session.claimed then
    return 'already_claimed';
  end if;
  if extract(epoch from (now() - v_session.started_at)) < v_min_secs then
    return 'too_early';
  end if;

  select count(*) into v_today_ct
    from tartan.coin_transactions
   where user_id = v_user and reason = 'video_reward'
     and created_at > date_trunc('day', now() at time zone 'utc');
  if v_today_ct >= v_daily_cap then
    return 'daily_limit_reached';
  end if;

  update tartan.profiles set coins = coins + v_amount, updated_at = now()
   where user_id = v_user and not banned
   returning coins into v_balance;
  if v_balance is null then
    return 'not_found';
  end if;

  insert into tartan.coin_transactions (user_id, amount, reason, balance_after)
  values (v_user, v_amount, 'video_reward', v_balance);

  update tartan.video_ad_sessions set claimed = true, claimed_at = now()
   where id = p_session_id;

  return 'credited';
end;
$$;

grant execute on function tartan.claim_video_reward(uuid) to authenticated;

-- -------------------------------------------------------- article reward

create table if not exists tartan.article_read_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  article_id  text not null,
  started_at  timestamptz not null default now(),
  claimed     boolean not null default false,
  claimed_at  timestamptz
);

create index if not exists article_read_sessions_user_idx on tartan.article_read_sessions (user_id, started_at desc);

alter table tartan.article_read_sessions enable row level security;

drop policy if exists "article sessions: read own or staff" on tartan.article_read_sessions;
create policy "article sessions: read own or staff"
  on tartan.article_read_sessions for select
  using (auth.uid() = user_id or tartan.is_staff(auth.uid()));

create or replace function tartan.start_article_session(p_article_id text)
returns uuid
language plpgsql
security definer
set search_path = tartan
as $$
declare
  v_user   uuid := auth.uid();
  v_id     uuid;
  v_recent int;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if coalesce(trim(p_article_id), '') = '' then
    raise exception 'invalid article id' using errcode = '22023';
  end if;

  select count(*) into v_recent from tartan.article_read_sessions
   where user_id = v_user and started_at > now() - interval '1 minute';
  if v_recent >= 10 then
    raise exception 'too many attempts, try again shortly' using errcode = '22023';
  end if;

  insert into tartan.article_read_sessions (user_id, article_id) values (v_user, p_article_id) returning id into v_id;
  return v_id;
end;
$$;

grant execute on function tartan.start_article_session(text) to authenticated;

-- Same status-string convention as claim_video_reward.
create or replace function tartan.claim_article_reward(p_session_id uuid)
returns text
language plpgsql
security definer
set search_path = tartan
as $$
declare
  v_user     uuid := auth.uid();
  v_session  tartan.article_read_sessions%rowtype;
  v_amount   bigint := tartan.game_const('article_reward_coins');
  v_min_secs numeric := tartan.game_const('article_min_read_seconds');
  v_daily_cap int := tartan.game_const('article_reward_daily_limit')::int;
  v_today_ct int;
  v_balance  bigint;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_session from tartan.article_read_sessions
   where id = p_session_id and user_id = v_user
   for update;
  if not found then
    return 'not_found';
  end if;
  if v_session.claimed then
    return 'already_claimed';
  end if;
  if extract(epoch from (now() - v_session.started_at)) < v_min_secs then
    return 'too_early';
  end if;

  select count(*) into v_today_ct
    from tartan.coin_transactions
   where user_id = v_user and reason = 'article_reward'
     and created_at > date_trunc('day', now() at time zone 'utc');
  if v_today_ct >= v_daily_cap then
    return 'daily_limit_reached';
  end if;

  update tartan.profiles set coins = coins + v_amount, updated_at = now()
   where user_id = v_user and not banned
   returning coins into v_balance;
  if v_balance is null then
    return 'not_found';
  end if;

  insert into tartan.coin_transactions (user_id, amount, reason, balance_after)
  values (v_user, v_amount, 'article_reward', v_balance);

  update tartan.article_read_sessions set claimed = true, claimed_at = now()
   where id = p_session_id;

  return 'credited';
end;
$$;

grant execute on function tartan.claim_article_reward(uuid) to authenticated;

-- -------------------------------------------------------------- status/history

-- One round trip for everything the Coins tab needs to render: balance, the
-- two earn methods' reward amounts and today's progress against their caps,
-- and the current revive cost.
create or replace function tartan.economy_status()
returns table (
  coins                       bigint,
  video_reward_coins          bigint,
  video_reward_daily_limit    int,
  video_claims_today          int,
  article_reward_coins        bigint,
  article_reward_daily_limit  int,
  article_claims_today        int,
  revive_cost_coins           bigint
)
language plpgsql
stable
security definer
set search_path = tartan
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  return query
  select
    p.coins,
    tartan.game_const('video_reward_coins')::bigint,
    tartan.game_const('video_reward_daily_limit')::int,
    (select count(*)::int from tartan.coin_transactions
      where user_id = v_user and reason = 'video_reward'
        and created_at > date_trunc('day', now() at time zone 'utc')),
    tartan.game_const('article_reward_coins')::bigint,
    tartan.game_const('article_reward_daily_limit')::int,
    (select count(*)::int from tartan.coin_transactions
      where user_id = v_user and reason = 'article_reward'
        and created_at > date_trunc('day', now() at time zone 'utc')),
    tartan.game_const('revive_cost_coins')::bigint
  from tartan.profiles p
  where p.user_id = v_user;
end;
$$;

grant execute on function tartan.economy_status() to authenticated;

-- The caller's own coin history, merging both ledgers this project has
-- (coin_ledger from 0001 for rewarded_ad/daily_challenge/daily_reward,
-- coin_transactions from 0002 for purchase_credit/revive_spend/
-- video_reward/article_reward) into one reverse-chronological read -- not a
-- third table, just a read over the two that already exist.
create or replace function tartan.coin_history(p_limit int default 50)
returns table (
  amount        bigint,
  reason        text,
  detail        text,
  balance_after bigint,
  created_at    timestamptz
)
language sql
stable
security definer
set search_path = tartan
as $$
  select amount, reason, detail, balance_after, created_at
    from tartan.coin_ledger
   where user_id = auth.uid()
  union all
  select amount, reason, null::text as detail, balance_after, created_at
    from tartan.coin_transactions
   where user_id = auth.uid()
  order by created_at desc
  limit least(greatest(p_limit, 1), 200);
$$;

grant execute on function tartan.coin_history(int) to authenticated;

-- --------------------------------------------------------------- admin config

create or replace function tartan.admin_update_economy_config(
  p_video_reward_coins numeric,
  p_video_reward_daily_limit numeric,
  p_video_min_watch_seconds numeric,
  p_article_reward_coins numeric,
  p_article_reward_daily_limit numeric,
  p_article_min_read_seconds numeric,
  p_revive_cost_coins numeric
) returns void
language plpgsql
security definer
set search_path = tartan
as $$
begin
  if not tartan.is_staff(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update tartan.game_constants set value = p_video_reward_coins, updated_at = now() where key = 'video_reward_coins';
  update tartan.game_constants set value = p_video_reward_daily_limit, updated_at = now() where key = 'video_reward_daily_limit';
  update tartan.game_constants set value = p_video_min_watch_seconds, updated_at = now() where key = 'video_min_watch_seconds';
  update tartan.game_constants set value = p_article_reward_coins, updated_at = now() where key = 'article_reward_coins';
  update tartan.game_constants set value = p_article_reward_daily_limit, updated_at = now() where key = 'article_reward_daily_limit';
  update tartan.game_constants set value = p_article_min_read_seconds, updated_at = now() where key = 'article_min_read_seconds';
  update tartan.game_constants set value = p_revive_cost_coins, updated_at = now() where key = 'revive_cost_coins';

  insert into tartan.challenge_audit_logs (actor_user_id, action, after)
  values (auth.uid(), 'update_economy_config', jsonb_build_object(
    'video_reward_coins', p_video_reward_coins,
    'video_reward_daily_limit', p_video_reward_daily_limit,
    'video_min_watch_seconds', p_video_min_watch_seconds,
    'article_reward_coins', p_article_reward_coins,
    'article_reward_daily_limit', p_article_reward_daily_limit,
    'article_min_read_seconds', p_article_min_read_seconds,
    'revive_cost_coins', p_revive_cost_coins
  ));
end;
$$;

-- Defense-in-depth, matching the hardening already applied in
-- 0002_championship.sql: revoke the PUBLIC execute privilege Postgres grants
-- by default on every new function, since the internal is_staff() check is
-- the only thing that should ever gate this.
revoke execute on function tartan.admin_update_economy_config(numeric, numeric, numeric, numeric, numeric, numeric, numeric) from public;
grant execute on function tartan.admin_update_economy_config(numeric, numeric, numeric, numeric, numeric, numeric, numeric) to authenticated;

-- --------------------------------------------------------------- grants

-- Base table grants only; RLS above narrows both to "own row or staff".
-- Every write goes through the SECURITY DEFINER functions above.
grant select on tartan.video_ad_sessions, tartan.article_read_sessions to authenticated;
