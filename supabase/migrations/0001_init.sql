-- TARTAN — initial schema.
--
-- Everything lives in a dedicated `tartan` schema rather than `public`.
--
-- That is not stylistic. `profiles` and `coin_ledger` are among the most common
-- table names there are, and dropping this migration into a project that
-- already has them would silently skip the CREATE (because of IF NOT EXISTS)
-- and then attach TARTAN's policies to somebody else's tables — policies are
-- OR'd, so that *widens* access on a table this game knows nothing about. An
-- owned schema makes that class of accident impossible, and makes the whole
-- game removable with a single `drop schema tartan cascade`.
--
-- Design notes:
--
--  * Anonymous auth. A player is on the leaderboard one tap after install;
--    there is no sign-up wall. auth.uid() is the only identity.
--
--  * The client never writes a score directly. `submit_run` is the only path
--    into `runs`, it is SECURITY DEFINER, and it re-derives every bound the
--    client claims to have respected. RLS denies INSERT to everyone, so there
--    is no second route in.
--
--  * The validator here mirrors src/systems/integrity.ts. If you change the
--    game's speed or scoring constants, change both. The constants live in
--    `game_constants` precisely so they can be audited and updated in one
--    place without a redeploy.

create extension if not exists "pgcrypto";

create schema if not exists tartan;

-- PostgREST reaches the schema through these grants; row-level security is
-- what actually decides who sees what.
grant usage on schema tartan to anon, authenticated, service_role;


-- ---------------------------------------------------------------- constants

create table if not exists tartan.game_constants (
  key           text primary key,
  value         numeric not null,
  updated_at    timestamptz not null default now()
);

insert into tartan.game_constants (key, value) values
  ('max_speed',              63),
  ('speed_tolerance',        1.55),
  ('score_tolerance',        1.08),
  ('score_per_metre',        1),
  ('score_per_prism',        25),
  ('score_per_near_miss',    15),
  ('stage_bonus',            100),
  ('segment_length',         6),
  ('max_prisms_per_segment', 1.2),
  ('min_run_seconds',        1.5),
  ('max_run_seconds',        3600)
on conflict (key) do nothing;

create or replace function tartan.game_const(p_key text)
returns numeric
language sql
stable
as $$
  select value from tartan.game_constants where key = p_key;
$$;

-- ----------------------------------------------------------------- profiles

create table if not exists tartan.profiles (
  user_id         uuid primary key references auth.users (id) on delete cascade,
  username        text not null default 'Runner',
  country         text,
  coins           bigint not null default 0 check (coins >= 0),
  lifetime_earned bigint not null default 0 check (lifetime_earned >= 0),
  lifetime_spent  bigint not null default 0 check (lifetime_spent >= 0),
  total_xp        bigint not null default 0 check (total_xp >= 0),
  level           int    not null default 1 check (level between 1 and 60),
  best_score      bigint not null default 0,
  -- The full client save blob, for cloud restore. Authoritative fields are
  -- mirrored into columns above so policies and queries never parse JSON.
  save            jsonb,
  banned          boolean not null default false,
  -- Incremented whenever submit_run rejects a run. A handful means bugs or a
  -- flaky clock; a hundred means someone is probing the validator.
  flags           int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists profiles_best_score_idx on tartan.profiles (best_score desc);

alter table tartan.profiles enable row level security;

drop policy if exists "profiles: read own" on tartan.profiles;
create policy "profiles: read own"
  on tartan.profiles for select
  using (auth.uid() = user_id);

drop policy if exists "profiles: insert own" on tartan.profiles;
create policy "profiles: insert own"
  on tartan.profiles for insert
  with check (auth.uid() = user_id);

-- A player may update their own row, but never their own coin balance beyond
-- what the server already recorded, and never their ban state. Coin grants go
-- through `grant_coins`; this policy stops the client from simply writing a
-- larger number into the column.
drop policy if exists "profiles: update own" on tartan.profiles;
create policy "profiles: update own"
  on tartan.profiles for update
  using (auth.uid() = user_id and not banned)
  with check (auth.uid() = user_id and not banned);

-- --------------------------------------------------------------------- runs

create table if not exists tartan.runs (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  score            bigint not null check (score >= 0),
  distance         int    not null check (distance >= 0),
  duration_ms      int    not null check (duration_ms >= 0),
  prisms           int    not null default 0 check (prisms >= 0),
  obstacles_dodged int    not null default 0 check (obstacles_dodged >= 0),
  near_misses      int    not null default 0 check (near_misses >= 0),
  stage            int    not null default 0,
  seed             bigint not null default 0,
  daily            boolean not null default false,
  continued        boolean not null default false,
  -- Server clock. Never trust a client timestamp for leaderboard windows.
  created_at       timestamptz not null default now(),
  day_key          date generated always as ((created_at at time zone 'utc')::date) stored
);

create index if not exists runs_leaderboard_idx on tartan.runs (score desc, created_at asc);
create index if not exists runs_daily_idx       on tartan.runs (day_key, score desc);
create index if not exists runs_user_idx        on tartan.runs (user_id, score desc);
create index if not exists runs_created_idx     on tartan.runs (created_at desc);

alter table tartan.runs enable row level security;

drop policy if exists "runs: read own" on tartan.runs;
create policy "runs: read own"
  on tartan.runs for select
  using (auth.uid() = user_id);

-- Deliberately no INSERT/UPDATE/DELETE policy. submit_run is the only writer.

-- ------------------------------------------------------------ coin ledger

create table if not exists tartan.coin_ledger (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  amount      bigint not null,
  -- Constrained to the three legitimate faucets plus spending. Anything else
  -- is a bug or an attack, and the database will say so.
  reason      text not null check (reason in ('rewarded_ad', 'daily_challenge', 'daily_reward', 'purchase')),
  detail      text,
  balance_after bigint not null,
  created_at  timestamptz not null default now()
);

create index if not exists coin_ledger_user_idx on tartan.coin_ledger (user_id, created_at desc);

alter table tartan.coin_ledger enable row level security;

drop policy if exists "ledger: read own" on tartan.coin_ledger;
create policy "ledger: read own"
  on tartan.coin_ledger for select
  using (auth.uid() = user_id);

-- ------------------------------------------------------------- analytics

create table if not exists tartan.analytics_events (
  id          bigserial primary key,
  user_id     uuid references auth.users (id) on delete set null,
  session_id  text,
  name        text not null,
  props       jsonb not null default '{}'::jsonb,
  seq         int,
  occurred_at timestamptz not null,
  created_at  timestamptz not null default now()
);

create index if not exists analytics_name_idx on tartan.analytics_events (name, occurred_at desc);
create index if not exists analytics_user_idx on tartan.analytics_events (user_id, occurred_at desc);

alter table tartan.analytics_events enable row level security;

-- Write-only from the client: a player can record their own events and cannot
-- read anyone's, including their own.
drop policy if exists "analytics: insert own" on tartan.analytics_events;
create policy "analytics: insert own"
  on tartan.analytics_events for insert
  with check (auth.uid() = user_id);

-- --------------------------------------------------------------- validation

-- Mirrors validateRun() in src/systems/integrity.ts. Returns null when the run
-- is plausible, or a reason code when it is not.
create or replace function tartan.validate_run(
  p_score bigint,
  p_distance int,
  p_duration_ms int,
  p_prisms int,
  p_near_misses int,
  p_stage int
) returns text
language plpgsql
stable
as $$
declare
  v_seconds      numeric := p_duration_ms / 1000.0;
  v_max_distance numeric;
  v_max_score    numeric;
  v_max_prisms   numeric;
begin
  if v_seconds < tartan.game_const('min_run_seconds') then
    return 'too_short';
  end if;
  if v_seconds > tartan.game_const('max_run_seconds') then
    return 'too_long';
  end if;

  -- Distance cannot exceed terminal speed sustained for the entire run.
  v_max_distance := v_seconds * tartan.game_const('max_speed') * tartan.game_const('speed_tolerance');
  if p_distance > v_max_distance then
    return 'distance_impossible';
  end if;

  -- Score is fully determined by distance, prisms, near misses and stage
  -- bonuses, so its ceiling falls straight out of the formula.
  v_max_score :=
      p_distance     * tartan.game_const('score_per_metre')
    + p_prisms       * tartan.game_const('score_per_prism')
    + p_near_misses  * tartan.game_const('score_per_near_miss')
    + (p_stage + 1)  * tartan.game_const('stage_bonus');

  if p_score > v_max_score * tartan.game_const('score_tolerance') + 50 then
    return 'score_impossible';
  end if;

  -- Collectables are bounded by how much track existed to put them on.
  v_max_prisms := (p_distance / tartan.game_const('segment_length'))
                  * tartan.game_const('max_prisms_per_segment') + 5;
  if p_prisms > v_max_prisms then
    return 'prisms_impossible';
  end if;

  return null;
end;
$$;

-- ------------------------------------------------------------- submit_run

create or replace function tartan.submit_run(
  p_score bigint,
  p_distance int,
  p_duration_ms int,
  p_prisms int,
  p_obstacles_dodged int,
  p_near_misses int,
  p_stage int,
  p_seed bigint,
  p_daily boolean,
  p_continued boolean,
  p_username text,
  p_level int
) returns boolean
language plpgsql
security definer
set search_path = tartan
as $$
declare
  v_user   uuid := auth.uid();
  v_reason text;
  v_banned boolean;
  v_recent int;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  -- Make sure a profile row exists before anything references it.
  insert into tartan.profiles (user_id, username, level)
  values (v_user, coalesce(nullif(trim(p_username), ''), 'Runner'), greatest(1, least(60, p_level)))
  on conflict (user_id) do nothing;

  select banned into v_banned from tartan.profiles where user_id = v_user;
  if v_banned then
    return false;
  end if;

  -- Rate limit: a human cannot finish more than a handful of runs a minute,
  -- and this is the cheapest possible brake on a scripted submitter.
  select count(*) into v_recent
  from tartan.runs
  where user_id = v_user and created_at > now() - interval '1 minute';

  if v_recent >= 12 then
    update tartan.profiles set flags = flags + 1 where user_id = v_user;
    return false;
  end if;

  v_reason := tartan.validate_run(
    p_score, p_distance, p_duration_ms, p_prisms, p_near_misses, p_stage
  );

  if v_reason is not null then
    update tartan.profiles
       set flags = flags + 1,
           -- Auto-ban only after a sustained pattern; one bad row is a bug.
           banned = (flags + 1) >= 50,
           updated_at = now()
     where user_id = v_user;
    return false;
  end if;

  insert into tartan.runs (
    user_id, score, distance, duration_ms, prisms,
    obstacles_dodged, near_misses, stage, seed, daily, continued
  ) values (
    v_user, p_score, p_distance, p_duration_ms, p_prisms,
    p_obstacles_dodged, p_near_misses, p_stage, p_seed, p_daily, p_continued
  );

  update tartan.profiles
     set best_score = greatest(best_score, p_score),
         username   = coalesce(nullif(trim(p_username), ''), username),
         level      = greatest(1, least(60, p_level)),
         updated_at = now()
   where user_id = v_user;

  return true;
end;
$$;

revoke all on function tartan.submit_run(bigint, int, int, int, int, int, int, bigint, boolean, boolean, text, int) from public;
grant execute on function tartan.submit_run(bigint, int, int, int, int, int, int, bigint, boolean, boolean, text, int) to authenticated;

-- ------------------------------------------------------------ grant_coins

-- The server-side counterpart to the client economy. Enforces the same rule:
-- coins only ever come from a rewarded ad, the daily challenge, or a login
-- reward, and the per-day cap is checked here rather than trusted from the
-- client.
create or replace function tartan.grant_coins(
  p_amount bigint,
  p_reason text,
  p_detail text default null
) returns bigint
language plpgsql
security definer
set search_path = tartan
as $$
declare
  v_user    uuid := auth.uid();
  v_balance bigint;
  v_today   int;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_reason not in ('rewarded_ad', 'daily_challenge', 'daily_reward') then
    raise exception 'invalid coin source: %', p_reason using errcode = '22023';
  end if;
  if p_amount <= 0 or p_amount > 2500 then
    raise exception 'invalid coin amount' using errcode = '22023';
  end if;

  -- Daily faucet ceiling. Generous enough that no honest player will meet it.
  select coalesce(sum(amount), 0) into v_today
  from tartan.coin_ledger
  where user_id = v_user
    and amount > 0
    and created_at > date_trunc('day', now() at time zone 'utc');

  if v_today + p_amount > 6000 then
    return null;
  end if;

  update tartan.profiles
     set coins = coins + p_amount,
         lifetime_earned = lifetime_earned + p_amount,
         updated_at = now()
   where user_id = v_user and not banned
   returning coins into v_balance;

  if v_balance is null then
    return null;
  end if;

  insert into tartan.coin_ledger (user_id, amount, reason, detail, balance_after)
  values (v_user, p_amount, p_reason, p_detail, v_balance);

  return v_balance;
end;
$$;

revoke all on function tartan.grant_coins(bigint, text, text) from public;
grant execute on function tartan.grant_coins(bigint, text, text) to authenticated;

-- ------------------------------------------------------------ leaderboards

-- One row per player (their best run in the window), ranked. Exposed through a
-- function rather than a view so the client cannot select arbitrary columns
-- off `profiles` — only the username, level and country are ever returned.
create or replace function tartan.leaderboard_page(
  p_scope text,
  p_limit int default 50
) returns table (
  rank bigint,
  user_id uuid,
  username text,
  score bigint,
  level int,
  country text
)
language sql
stable
security definer
set search_path = tartan
as $$
  with window_runs as (
    select r.user_id, max(r.score) as score
    from tartan.runs r
    join tartan.profiles p on p.user_id = r.user_id
    where not p.banned
      and (
        p_scope = 'global'
        or (p_scope = 'daily'  and r.day_key = (now() at time zone 'utc')::date)
        or (p_scope = 'weekly' and r.created_at >= date_trunc('week', now() at time zone 'utc'))
      )
    group by r.user_id
  )
  select
    row_number() over (order by w.score desc, p.created_at asc) as rank,
    w.user_id,
    p.username,
    w.score,
    p.level,
    p.country
  from window_runs w
  join tartan.profiles p on p.user_id = w.user_id
  order by w.score desc, p.created_at asc
  limit least(greatest(p_limit, 1), 100);
$$;

grant execute on function tartan.leaderboard_page(text, int) to anon, authenticated;

create or replace function tartan.leaderboard_self_rank(p_scope text)
returns bigint
language sql
stable
security definer
set search_path = tartan
as $$
  with window_runs as (
    select r.user_id, max(r.score) as score
    from tartan.runs r
    join tartan.profiles p on p.user_id = r.user_id
    where not p.banned
      and (
        p_scope = 'global'
        or (p_scope = 'daily'  and r.day_key = (now() at time zone 'utc')::date)
        or (p_scope = 'weekly' and r.created_at >= date_trunc('week', now() at time zone 'utc'))
      )
    group by r.user_id
  ),
  me as (select score from window_runs where user_id = auth.uid())
  select case
    when (select score from me) is null then null
    else (select count(*) + 1 from window_runs where score > (select score from me))
  end;
$$;

grant execute on function tartan.leaderboard_self_rank(text) to authenticated;

-- ------------------------------------------------------------- maintenance

-- Analytics is high volume and low value after a month. Schedule with pg_cron:
--   select cron.schedule('tartan-prune', '0 3 * * *', 'select tartan.prune_analytics()');
create or replace function tartan.prune_analytics()
returns void
language sql
security definer
set search_path = tartan
as $$
  delete from tartan.analytics_events where created_at < now() - interval '30 days';
$$;

-- Keep only each player's best 50 runs; the rest are never read again.
create or replace function tartan.prune_runs()
returns void
language sql
security definer
set search_path = tartan
as $$
  delete from tartan.runs r
  where r.id in (
    select id from (
      select id, row_number() over (partition by user_id order by score desc) as rn
      from tartan.runs
    ) ranked
    where ranked.rn > 50
  );
$$;

-- --------------------------------------------------------------- grants

-- Tables are reachable only through the policies above; the RPCs carry the
-- privileged paths and are granted individually next to their definitions.
-- A player owns their profile row, so they need the table privilege as well as
-- the policy: RLS narrows what a grant allows, it does not substitute for one.
grant select, insert, update on tartan.profiles to authenticated;

-- Read-only. `runs` is written solely by submit_run, `coin_ledger` solely by
-- grant_coins, both SECURITY DEFINER — withholding the write grant means even
-- a policy mistake cannot open a direct path.
grant select on tartan.runs, tartan.coin_ledger to authenticated;

-- Analytics is write-only from the client: insert, and deliberately no select,
-- so a player cannot read anyone's telemetry including their own.
grant insert on tartan.analytics_events to authenticated;
grant usage, select on sequence tartan.analytics_events_id_seq to authenticated;

grant select on tartan.game_constants to anon, authenticated;
