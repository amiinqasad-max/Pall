-- TARTAN — Daily Challenge & Cash Championship system.
--
-- Adds, on top of 0001_init.sql:
--   1. A staff-role table and an is_staff() helper used by every admin RPC.
--   2. Normal-game coin economy: purchasable packages, purchase records, a
--      coin-transaction ledger, and coin-priced revives.
--   3. The Championship: a daily qualification round (free, unlimited
--      entrants, a percentile-derived target) feeding a free-entry, paid-
--      advantage-free cash final, with an immutable per-day configuration
--      snapshot, a Top-N prize table, and a payout ledger that never marks
--      anything paid without an admin's explicit, one-directional say-so.
--   4. Region gating for cash prizes, fail-closed by default.
--
-- Design notes carried over from 0001 and worth restating here:
--
--  * The client is never trusted with a score, a balance, or a rank. Every
--    write to a money- or ranking-relevant table goes through a
--    SECURITY DEFINER function that re-derives what it can and rejects what
--    it cannot; RLS denies the client any direct INSERT/UPDATE path.
--
--  * "Paid" is a status this system records, not an action it performs. No
--    function in this file moves real money. mark_payout_paid() only
--    records that an admin moved it *outside* this system and requires a
--    non-empty external_reference as evidence that they did. Likewise,
--    admin_verify_and_credit_purchase() credits coins after an admin has
--    verified a purchase by whatever means they have today; there is no
--    live Apple/Google/Stripe receipt check wired in here, because doing
--    that honestly requires real store/processor credentials this project
--    does not have. Wiring one in later only ever needs to change what calls
--    admin_verify_and_credit_purchase() — the ledger and the coin balance it
--    updates do not change shape.
--
--  * The qualification target is computed once, by start_challenge(), from
--    the *previous* completed challenge's server-validated scores — never
--    from the live, in-progress challenge, which is exactly the number a
--    player could otherwise influence by manipulating their own score.
--
--  * Every challenge freezes its own copy of the rules that govern it
--    (target, prize pool, distribution, winner count) at start_challenge().
--    Changing daily_challenge_configs afterward cannot reach back into an
--    active or ended challenge — see the frozen columns on daily_challenges.

-- ---------------------------------------------------------------- staff

create table if not exists tartan.staff_roles (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  role        text not null check (role in ('admin', 'moderator')),
  granted_by  uuid references auth.users (id),
  granted_at  timestamptz not null default now()
);

-- Declared before every policy/function below that checks it — a CREATE
-- POLICY that references tartan.is_staff() before it exists fails at
-- migration time, not silently, so this ordering is load-bearing. Granting
-- the first admin is a manual `insert into tartan.staff_roles ...` — there
-- is deliberately no self-service path to staff.
create or replace function tartan.is_staff(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = tartan
as $$
  select exists (select 1 from tartan.staff_roles where user_id = p_user);
$$;

grant execute on function tartan.is_staff(uuid) to anon, authenticated;

alter table tartan.staff_roles enable row level security;

drop policy if exists "staff: read own or staff" on tartan.staff_roles;
create policy "staff: read own or staff"
  on tartan.staff_roles for select
  using (auth.uid() = user_id or tartan.is_staff(auth.uid()));

grant select on tartan.staff_roles to authenticated;

-- --------------------------------------------------------- coin economy

create table if not exists tartan.coin_packages (
  id               text primary key,
  name             text not null,
  coins            integer not null check (coins > 0),
  price_usd_cents  integer not null check (price_usd_cents > 0),
  active           boolean not null default true,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

insert into tartan.coin_packages (id, name, coins, price_usd_cents, sort_order) values
  ('coins_500',  '500 Coins',   500,  100, 1),
  ('coins_1000', '1,000 Coins', 1000, 150, 2),
  ('coins_2000', '2,000 Coins', 2000, 250, 3)
on conflict (id) do nothing;

alter table tartan.coin_packages enable row level security;

drop policy if exists "packages: read" on tartan.coin_packages;
create policy "packages: read"
  on tartan.coin_packages for select
  using (active or tartan.is_staff(auth.uid()));

create table if not exists tartan.purchase_records (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  package_id       text not null references tartan.coin_packages (id),
  -- 'web' today (this is a PWA, not yet a native app); 'ios'/'android' are
  -- reserved for when a native wrapper ships and can carry a real store
  -- receipt instead of an opaque token.
  platform         text not null check (platform in ('web', 'ios', 'android')),
  receipt_token    text not null,
  price_usd_cents  integer not null,
  currency         text not null default 'USD',
  status           text not null default 'pending_verification'
                     check (status in ('pending_verification', 'verified', 'rejected', 'credited')),
  created_at       timestamptz not null default now(),
  verified_at      timestamptz,
  credited_at      timestamptz,
  -- The same receipt can never be credited twice, whether that is a client
  -- retry or a deliberate replay.
  unique (platform, receipt_token)
);

create index if not exists purchase_records_user_idx on tartan.purchase_records (user_id, created_at desc);
create index if not exists purchase_records_status_idx on tartan.purchase_records (status);

alter table tartan.purchase_records enable row level security;

drop policy if exists "purchases: read own or staff" on tartan.purchase_records;
create policy "purchases: read own or staff"
  on tartan.purchase_records for select
  using (auth.uid() = user_id or tartan.is_staff(auth.uid()));

-- No INSERT/UPDATE policy: record_purchase_attempt() and
-- admin_verify_and_credit_purchase() are the only writers.

create table if not exists tartan.coin_transactions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users (id) on delete cascade,
  purchase_record_id  uuid references tartan.purchase_records (id),
  -- Positive = credit, negative = debit. Always paired with balance_after so
  -- the ledger is auditable without replaying every prior row.
  amount              bigint not null,
  reason              text not null check (reason in ('purchase_credit', 'revive_spend', 'admin_adjustment')),
  balance_after       bigint not null,
  created_at          timestamptz not null default now()
);

create index if not exists coin_transactions_user_idx on tartan.coin_transactions (user_id, created_at desc);

alter table tartan.coin_transactions enable row level security;

drop policy if exists "coin tx: read own or staff" on tartan.coin_transactions;
create policy "coin tx: read own or staff"
  on tartan.coin_transactions for select
  using (auth.uid() = user_id or tartan.is_staff(auth.uid()));

create table if not exists tartan.revive_transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  run_session_id  text not null,
  coins_spent     integer not null,
  created_at      timestamptz not null default now()
);

create index if not exists revive_transactions_user_idx on tartan.revive_transactions (user_id, created_at desc);

alter table tartan.revive_transactions enable row level security;

drop policy if exists "revive tx: read own or staff" on tartan.revive_transactions;
create policy "revive tx: read own or staff"
  on tartan.revive_transactions for select
  using (auth.uid() = user_id or tartan.is_staff(auth.uid()));

insert into tartan.game_constants (key, value) values
  ('revive_cost_coins', 50)
on conflict (key) do nothing;

-- ------------------------------------------------------ championship config

create table if not exists tartan.daily_challenge_configs (
  id                             int primary key default 1 check (id = 1),
  reference_percentile           numeric not null default 70 check (reference_percentile between 1 and 99),
  qualification_multiplier       numeric not null default 0.80 check (qualification_multiplier > 0),
  minimum_target                 bigint not null default 1000,
  maximum_target                 bigint not null default 1000000,
  fallback_target                bigint not null default 5000,
  -- Below this many valid samples, start_challenge() will not trust the
  -- computed percentile at all and falls back instead (see §3 of the brief:
  -- "should not be manipulated by individual players").
  minimum_sample_size            int not null default 30,
  default_prize_pool_usd_cents   bigint not null default 25000,
  default_winner_count           int not null default 25,
  -- One template entry per exact rank or contiguous rank range; exploded into
  -- one row per rank in challenge_prizes at start_challenge() time.
  default_prize_distribution     jsonb not null default '[
    {"rank": 1, "amount_cents": 10000},
    {"rank": 2, "amount_cents": 5000},
    {"rank": 3, "amount_cents": 2500},
    {"rank": 4, "amount_cents": 1000},
    {"rank": 5, "amount_cents": 1000},
    {"rank_from": 6, "rank_to": 10, "amount_cents": 500},
    {"rank_from": 11, "rank_to": 25, "amount_cents": 200}
  ]'::jsonb,
  default_max_final_attempts     int not null default 3,
  updated_at                     timestamptz not null default now(),
  updated_by                     uuid references auth.users (id)
);

insert into tartan.daily_challenge_configs (id) values (1) on conflict (id) do nothing;

alter table tartan.daily_challenge_configs enable row level security;

drop policy if exists "config: staff only" on tartan.daily_challenge_configs;
create policy "config: staff only"
  on tartan.daily_challenge_configs for select
  using (tartan.is_staff(auth.uid()));

create table if not exists tartan.region_settings (
  country_code        text primary key,
  cash_prize_enabled  boolean not null default false,
  min_age             int,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references auth.users (id)
);

alter table tartan.region_settings enable row level security;

drop policy if exists "region: read all" on tartan.region_settings;
create policy "region: read all"
  on tartan.region_settings for select
  using (true);

-- --------------------------------------------------------- championships

create table if not exists tartan.daily_challenges (
  id                         uuid primary key default gen_random_uuid(),
  challenge_date             date not null unique,
  status                     text not null default 'scheduled'
                               check (status in ('scheduled', 'active', 'ended', 'paused', 'cancelled')),
  start_time                 timestamptz not null,
  end_time                   timestamptz not null,
  -- Deterministic per-day track seeds, independent of the client's existing
  -- (unrelated) dailyChallenge() seed — the two systems never share a track.
  qualification_track_seed   bigint not null,
  final_track_seed           bigint not null,

  -- Frozen by start_challenge(); nothing after that point may write these.
  qualification_target       bigint,
  reference_percentile       numeric,
  qualification_multiplier   numeric,
  minimum_target             bigint,
  maximum_target             bigint,
  prize_pool_usd_cents       bigint,
  winner_count               int,
  prize_distribution         jsonb,
  max_final_attempts         int,
  final_rules                jsonb,

  created_at                 timestamptz not null default now(),
  created_by                 uuid references auth.users (id)
);

create index if not exists daily_challenges_status_idx on tartan.daily_challenges (status, challenge_date desc);

alter table tartan.daily_challenges enable row level security;

drop policy if exists "challenges: read all" on tartan.daily_challenges;
create policy "challenges: read all"
  on tartan.daily_challenges for select
  using (true);

create table if not exists tartan.challenge_participants (
  challenge_id              uuid not null references tartan.daily_challenges (id) on delete cascade,
  user_id                   uuid not null references auth.users (id) on delete cascade,
  qualification_status      text not null default 'not_qualified'
                               check (qualification_status in ('not_qualified', 'qualified', 'disqualified')),
  qualification_score       bigint not null default 0,
  qualification_timestamp   timestamptz,
  final_attempts_used       int not null default 0,
  final_score               bigint not null default 0,
  final_rank                int,
  session_id                text,
  device_fingerprint_hash   text,
  anti_cheat_status         text not null default 'clean'
                               check (anti_cheat_status in ('clean', 'flagged', 'disqualified')),
  created_at                timestamptz not null default now(),
  -- Bumped only when final_score genuinely improves (see submit_final_run) —
  -- this is what makes it usable as the "earlier verified completion wins
  -- the tie" column in the leaderboard sort, not just a last-write time.
  updated_at                timestamptz not null default now(),
  primary key (challenge_id, user_id)
);

create index if not exists challenge_participants_rank_idx
  on tartan.challenge_participants (challenge_id, final_score desc, updated_at asc);
create index if not exists challenge_participants_status_idx
  on tartan.challenge_participants (challenge_id, qualification_status);
create index if not exists challenge_participants_session_idx
  on tartan.challenge_participants (challenge_id, session_id);

alter table tartan.challenge_participants enable row level security;

drop policy if exists "participants: read own or staff" on tartan.challenge_participants;
create policy "participants: read own or staff"
  on tartan.challenge_participants for select
  using (auth.uid() = user_id or tartan.is_staff(auth.uid()));

create table if not exists tartan.challenge_qualifications (
  id                uuid primary key default gen_random_uuid(),
  challenge_id      uuid not null references tartan.daily_challenges (id) on delete cascade,
  user_id           uuid not null references auth.users (id) on delete cascade,
  score             bigint not null check (score >= 0),
  distance          int not null default 0,
  duration_ms        int not null default 0,
  server_validated  boolean not null default true,
  rejection_reason  text,
  submitted_at      timestamptz not null default now()
);

create index if not exists challenge_qualifications_idx
  on tartan.challenge_qualifications (challenge_id, user_id, submitted_at desc);

alter table tartan.challenge_qualifications enable row level security;

drop policy if exists "qualifications: read own or staff" on tartan.challenge_qualifications;
create policy "qualifications: read own or staff"
  on tartan.challenge_qualifications for select
  using (auth.uid() = user_id or tartan.is_staff(auth.uid()));

create table if not exists tartan.challenge_final_scores (
  id                uuid primary key default gen_random_uuid(),
  challenge_id      uuid not null references tartan.daily_challenges (id) on delete cascade,
  user_id           uuid not null references auth.users (id) on delete cascade,
  score             bigint not null check (score >= 0),
  distance          int not null default 0,
  duration_ms       int not null default 0,
  attempt_number    int not null,
  server_validated  boolean not null default true,
  rejection_reason  text,
  submitted_at      timestamptz not null default now()
);

create index if not exists challenge_final_scores_idx
  on tartan.challenge_final_scores (challenge_id, user_id, submitted_at desc);

alter table tartan.challenge_final_scores enable row level security;

drop policy if exists "final scores: read own or staff" on tartan.challenge_final_scores;
create policy "final scores: read own or staff"
  on tartan.challenge_final_scores for select
  using (auth.uid() = user_id or tartan.is_staff(auth.uid()));

-- A periodically-refreshed cache, not a live view: at 100k+ participants a
-- full re-rank on every leaderboard open is wasteful when the top of the
-- board barely moves minute to minute. refresh_challenge_leaderboard() below
-- is designed to be called on a schedule (see the pg_cron note near the
-- bottom of this file); a player's own rank is still computed live and
-- cheaply by championship_self_rank() so it never looks stale to them.
create table if not exists tartan.challenge_leaderboards (
  challenge_id  uuid not null references tartan.daily_challenges (id) on delete cascade,
  rank          int not null,
  user_id       uuid not null references auth.users (id) on delete cascade,
  final_score   bigint not null,
  completed_at  timestamptz not null,
  refreshed_at  timestamptz not null default now(),
  primary key (challenge_id, rank)
);

create index if not exists challenge_leaderboards_user_idx on tartan.challenge_leaderboards (challenge_id, user_id);

alter table tartan.challenge_leaderboards enable row level security;

drop policy if exists "leaderboard: read all" on tartan.challenge_leaderboards;
create policy "leaderboard: read all"
  on tartan.challenge_leaderboards for select
  using (true);

create table if not exists tartan.challenge_prizes (
  challenge_id        uuid not null references tartan.daily_challenges (id) on delete cascade,
  rank                int not null,
  prize_amount_cents  bigint not null,
  primary key (challenge_id, rank)
);

alter table tartan.challenge_prizes enable row level security;

drop policy if exists "prizes: read all" on tartan.challenge_prizes;
create policy "prizes: read all"
  on tartan.challenge_prizes for select
  using (true);

create table if not exists tartan.challenge_payouts (
  id                    uuid primary key default gen_random_uuid(),
  challenge_id          uuid not null references tartan.daily_challenges (id) on delete cascade,
  user_id               uuid not null references auth.users (id) on delete cascade,
  rank                  int not null,
  final_score           bigint not null,
  prize_amount_cents    bigint not null,
  verification_status   text not null default 'pending_verification'
                           check (verification_status in ('pending_verification', 'verified', 'rejected')),
  payout_status          text not null default 'pending'
                           check (payout_status in ('pending', 'approved', 'paid', 'cancelled')),
  -- Evidence that a real, external transfer happened. mark_payout_paid()
  -- refuses to run without one.
  external_reference     text,
  created_at             timestamptz not null default now(),
  verified_at            timestamptz,
  approved_at            timestamptz,
  paid_at                timestamptz,
  unique (challenge_id, user_id)
);

create index if not exists challenge_payouts_rank_idx on tartan.challenge_payouts (challenge_id, rank);
create index if not exists challenge_payouts_status_idx on tartan.challenge_payouts (payout_status);

alter table tartan.challenge_payouts enable row level security;

drop policy if exists "payouts: read own or staff" on tartan.challenge_payouts;
create policy "payouts: read own or staff"
  on tartan.challenge_payouts for select
  using (auth.uid() = user_id or tartan.is_staff(auth.uid()));

create table if not exists tartan.challenge_disqualifications (
  id            uuid primary key default gen_random_uuid(),
  challenge_id  uuid not null references tartan.daily_challenges (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  reason        text not null,
  severity      text not null check (severity in ('flag', 'disqualify')),
  evidence      jsonb not null default '{}'::jsonb,
  source        text not null default 'system' check (source in ('system', 'admin')),
  created_by    uuid references auth.users (id),
  created_at    timestamptz not null default now()
);

create index if not exists challenge_disqualifications_idx
  on tartan.challenge_disqualifications (challenge_id, user_id);

alter table tartan.challenge_disqualifications enable row level security;

-- Staff only. Not shown to players — publishing exactly what trips the
-- anti-cheat system is a guide to evading it.
drop policy if exists "disqualifications: staff only" on tartan.challenge_disqualifications;
create policy "disqualifications: staff only"
  on tartan.challenge_disqualifications for select
  using (tartan.is_staff(auth.uid()));

create table if not exists tartan.challenge_audit_logs (
  id             uuid primary key default gen_random_uuid(),
  challenge_id   uuid references tartan.daily_challenges (id) on delete set null,
  actor_user_id  uuid references auth.users (id),
  action         text not null,
  before         jsonb,
  after          jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists challenge_audit_logs_idx on tartan.challenge_audit_logs (challenge_id, created_at desc);

alter table tartan.challenge_audit_logs enable row level security;

drop policy if exists "audit logs: staff only" on tartan.challenge_audit_logs;
create policy "audit logs: staff only"
  on tartan.challenge_audit_logs for select
  using (tartan.is_staff(auth.uid()));

-- ---------------------------------------------------- purchase functions

create or replace function tartan.record_purchase_attempt(
  p_package_id text,
  p_platform text,
  p_receipt_token text
) returns uuid
language plpgsql
security definer
set search_path = tartan
as $$
declare
  v_user   uuid := auth.uid();
  v_pkg    tartan.coin_packages%rowtype;
  v_id     uuid;
  v_recent int;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_platform not in ('web', 'ios', 'android') then
    raise exception 'invalid platform: %', p_platform using errcode = '22023';
  end if;

  select count(*) into v_recent
    from tartan.purchase_records
   where user_id = v_user and created_at > now() - interval '1 minute';
  if v_recent >= 5 then
    raise exception 'too many purchase attempts, try again shortly' using errcode = '22023';
  end if;

  select * into v_pkg from tartan.coin_packages where id = p_package_id and active;
  if not found then
    raise exception 'unknown or inactive package %', p_package_id;
  end if;

  insert into tartan.purchase_records (user_id, package_id, platform, receipt_token, price_usd_cents)
  values (v_user, p_package_id, p_platform, p_receipt_token, v_pkg.price_usd_cents)
  returning id into v_id;

  return v_id;
exception
  -- The same receipt submitted twice — a client retry or a replay attempt —
  -- returns the existing row rather than crediting or recording it again.
  when unique_violation then
    select id into v_id from tartan.purchase_records
     where platform = p_platform and receipt_token = p_receipt_token;
    return v_id;
end;
$$;

grant execute on function tartan.record_purchase_attempt(text, text, text) to authenticated;

-- No live Apple/Google/Stripe receipt verification is wired in here (see the
-- file header) — this is the manual admin action that stands in for it.
create or replace function tartan.admin_verify_and_credit_purchase(p_purchase_id uuid)
returns bigint
language plpgsql
security definer
set search_path = tartan
as $$
declare
  v_purchase tartan.purchase_records%rowtype;
  v_pkg      tartan.coin_packages%rowtype;
  v_balance  bigint;
begin
  if not tartan.is_staff(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into v_purchase from tartan.purchase_records where id = p_purchase_id for update;
  if not found or v_purchase.status <> 'pending_verification' then
    raise exception 'purchase % is not pending verification', p_purchase_id;
  end if;
  select * into v_pkg from tartan.coin_packages where id = v_purchase.package_id;

  update tartan.profiles set coins = coins + v_pkg.coins, updated_at = now()
   where user_id = v_purchase.user_id
   returning coins into v_balance;

  insert into tartan.coin_transactions (user_id, purchase_record_id, amount, reason, balance_after)
  values (v_purchase.user_id, p_purchase_id, v_pkg.coins, 'purchase_credit', v_balance);

  update tartan.purchase_records set status = 'credited', verified_at = now(), credited_at = now()
   where id = p_purchase_id;

  insert into tartan.challenge_audit_logs (actor_user_id, action, after)
  values (auth.uid(), 'credit_purchase', jsonb_build_object('purchase_id', p_purchase_id, 'coins', v_pkg.coins));

  return v_balance;
end;
$$;

grant execute on function tartan.admin_verify_and_credit_purchase(uuid) to authenticated;

create or replace function tartan.admin_upsert_coin_package(
  p_id text, p_name text, p_coins int, p_price_usd_cents int, p_active boolean, p_sort_order int
) returns void
language plpgsql
security definer
set search_path = tartan
as $$
begin
  if not tartan.is_staff(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into tartan.coin_packages (id, name, coins, price_usd_cents, active, sort_order)
  values (p_id, p_name, p_coins, p_price_usd_cents, p_active, p_sort_order)
  on conflict (id) do update set
    name = excluded.name, coins = excluded.coins, price_usd_cents = excluded.price_usd_cents,
    active = excluded.active, sort_order = excluded.sort_order, updated_at = now();
end;
$$;

grant execute on function tartan.admin_upsert_coin_package(text, text, int, int, boolean, int) to authenticated;

create or replace function tartan.spend_coins_for_revive(p_run_session_id text)
returns bigint
language plpgsql
security definer
set search_path = tartan
as $$
declare
  v_user    uuid := auth.uid();
  v_cost    bigint;
  v_balance bigint;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  v_cost := tartan.game_const('revive_cost_coins');

  update tartan.profiles set coins = coins - v_cost, updated_at = now()
   where user_id = v_user and coins >= v_cost
   returning coins into v_balance;

  if not found then
    -- Insufficient balance. Not an error — the client shows "not enough
    -- coins" and offers the ad-based continue or the store instead.
    return null;
  end if;

  insert into tartan.coin_transactions (user_id, amount, reason, balance_after)
  values (v_user, -v_cost, 'revive_spend', v_balance);

  insert into tartan.revive_transactions (user_id, run_session_id, coins_spent)
  values (v_user, p_run_session_id, v_cost);

  return v_balance;
end;
$$;

grant execute on function tartan.spend_coins_for_revive(text) to authenticated;

-- --------------------------------------------------- qualification target

create or replace function tartan.compute_qualification_target(
  p_previous_challenge_id uuid,
  p_percentile numeric,
  p_multiplier numeric,
  p_min bigint,
  p_max bigint,
  p_min_sample int,
  p_fallback bigint
) returns bigint
language plpgsql
stable
security definer
set search_path = tartan
as $$
declare
  v_sample_count      int;
  v_percentile_score  numeric;
  v_previous_target   bigint;
begin
  if p_previous_challenge_id is not null then
    select count(*), percentile_cont(p_percentile / 100.0) within group (order by score)
      into v_sample_count, v_percentile_score
      from tartan.challenge_qualifications
     where challenge_id = p_previous_challenge_id and server_validated;
  else
    v_sample_count := 0;
  end if;

  if v_sample_count >= p_min_sample then
    return greatest(p_min, least(p_max, round(v_percentile_score * p_multiplier)));
  end if;

  -- Too little reliable data (§3 of the brief): fall back to the last
  -- challenge that actually had a computed target, never to a live guess.
  select qualification_target into v_previous_target
    from tartan.daily_challenges
   where qualification_target is not null
   order by challenge_date desc
   limit 1;

  return coalesce(v_previous_target, p_fallback);
end;
$$;

-- ------------------------------------------------------ challenge lifecycle

create or replace function tartan.create_challenge(
  p_challenge_date date,
  p_start_time timestamptz,
  p_end_time timestamptz
) returns uuid
language plpgsql
security definer
set search_path = tartan
as $$
declare
  v_id uuid;
begin
  if not tartan.is_staff(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_end_time <= p_start_time then
    raise exception 'end_time must be after start_time';
  end if;

  insert into tartan.daily_challenges (
    challenge_date, status, start_time, end_time,
    qualification_track_seed, final_track_seed, created_by
  ) values (
    p_challenge_date, 'scheduled', p_start_time, p_end_time,
    -- Stable per-day integers from Postgres's own built-in text hash —
    -- independent of the client's hashString(); the server hands these
    -- straight to the client, which seeds its RNG with whatever integer it's
    -- given, so nothing needs to reproduce the algorithm on the other side.
    hashtext('championship:qualify:' || p_challenge_date::text),
    hashtext('championship:final:' || p_challenge_date::text),
    auth.uid()
  )
  returning id into v_id;

  insert into tartan.challenge_audit_logs (challenge_id, actor_user_id, action, after)
  values (v_id, auth.uid(), 'create_challenge', jsonb_build_object('challenge_date', p_challenge_date));

  return v_id;
end;
$$;

grant execute on function tartan.create_challenge(date, timestamptz, timestamptz) to authenticated;

create or replace function tartan.start_challenge(p_challenge_id uuid)
returns void
language plpgsql
security definer
set search_path = tartan
as $$
declare
  v_cfg     tartan.daily_challenge_configs%rowtype;
  v_prev_id uuid;
  v_target  bigint;
  v_before  jsonb;
begin
  if not tartan.is_staff(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select * into v_cfg from tartan.daily_challenge_configs where id = 1;

  select id into v_prev_id
    from tartan.daily_challenges
   where status = 'ended'
   order by challenge_date desc
   limit 1;

  v_target := tartan.compute_qualification_target(
    v_prev_id, v_cfg.reference_percentile, v_cfg.qualification_multiplier,
    v_cfg.minimum_target, v_cfg.maximum_target, v_cfg.minimum_sample_size, v_cfg.fallback_target
  );

  select to_jsonb(d) into v_before from tartan.daily_challenges d where id = p_challenge_id;

  update tartan.daily_challenges set
    status = 'active',
    qualification_target = v_target,
    reference_percentile = v_cfg.reference_percentile,
    qualification_multiplier = v_cfg.qualification_multiplier,
    minimum_target = v_cfg.minimum_target,
    maximum_target = v_cfg.maximum_target,
    prize_pool_usd_cents = v_cfg.default_prize_pool_usd_cents,
    winner_count = v_cfg.default_winner_count,
    prize_distribution = v_cfg.default_prize_distribution,
    max_final_attempts = v_cfg.default_max_final_attempts,
    final_rules = jsonb_build_object(
      'coins_disabled', true, 'paid_revives_disabled', true,
      'paid_power_ups_disabled', true, 'entry_fee_cents', 0, 'starting_score', 0
    )
  where id = p_challenge_id and status = 'scheduled';

  if not found then
    raise exception 'challenge % is not in scheduled status', p_challenge_id;
  end if;

  -- Explode the distribution template into one row per rank. 25 rows; cheap.
  insert into tartan.challenge_prizes (challenge_id, rank, prize_amount_cents)
  select p_challenge_id, r.rank, coalesce((
    select (elem ->> 'amount_cents')::bigint
      from jsonb_array_elements(v_cfg.default_prize_distribution) elem
     where (elem ->> 'rank')::int = r.rank
        or (r.rank between (elem ->> 'rank_from')::int and (elem ->> 'rank_to')::int)
     limit 1
  ), 0)
  from generate_series(1, v_cfg.default_winner_count) as r(rank)
  on conflict (challenge_id, rank) do nothing;

  insert into tartan.challenge_audit_logs (challenge_id, actor_user_id, action, before, after)
  values (p_challenge_id, auth.uid(), 'start_challenge', v_before,
          (select to_jsonb(d) from tartan.daily_challenges d where id = p_challenge_id));
end;
$$;

grant execute on function tartan.start_challenge(uuid) to authenticated;

create or replace function tartan.pause_challenge(p_challenge_id uuid) returns void
language plpgsql security definer set search_path = tartan as $$
begin
  if not tartan.is_staff(auth.uid()) then raise exception 'not authorized' using errcode = '42501'; end if;
  update tartan.daily_challenges set status = 'paused' where id = p_challenge_id and status = 'active';
  if not found then raise exception 'challenge % is not active', p_challenge_id; end if;
  insert into tartan.challenge_audit_logs (challenge_id, actor_user_id, action)
  values (p_challenge_id, auth.uid(), 'pause_challenge');
end;
$$;

grant execute on function tartan.pause_challenge(uuid) to authenticated;

create or replace function tartan.resume_challenge(p_challenge_id uuid) returns void
language plpgsql security definer set search_path = tartan as $$
begin
  if not tartan.is_staff(auth.uid()) then raise exception 'not authorized' using errcode = '42501'; end if;
  update tartan.daily_challenges set status = 'active' where id = p_challenge_id and status = 'paused';
  if not found then raise exception 'challenge % is not paused', p_challenge_id; end if;
  insert into tartan.challenge_audit_logs (challenge_id, actor_user_id, action)
  values (p_challenge_id, auth.uid(), 'resume_challenge');
end;
$$;

grant execute on function tartan.resume_challenge(uuid) to authenticated;

create or replace function tartan.refresh_challenge_leaderboard(p_challenge_id uuid, p_limit int default 200)
returns void
language plpgsql
security definer
set search_path = tartan
as $$
begin
  delete from tartan.challenge_leaderboards where challenge_id = p_challenge_id;

  insert into tartan.challenge_leaderboards (challenge_id, rank, user_id, final_score, completed_at)
  select p_challenge_id,
         row_number() over (order by cp.final_score desc, cp.updated_at asc),
         cp.user_id, cp.final_score, cp.updated_at
    from tartan.challenge_participants cp
   where cp.challenge_id = p_challenge_id
     and cp.qualification_status = 'qualified'
     and cp.anti_cheat_status <> 'disqualified'
     and cp.final_score > 0
   order by cp.final_score desc, cp.updated_at asc
   limit p_limit;
end;
$$;

-- Callable by any authenticated session so the client can force a refresh
-- when it opens the final screen, in addition to whatever schedule (see the
-- pg_cron note near the end of this file) keeps it warm in the background.
grant execute on function tartan.refresh_challenge_leaderboard(uuid, int) to authenticated;

create or replace function tartan.end_challenge(p_challenge_id uuid)
returns void
language plpgsql
security definer
set search_path = tartan
as $$
declare
  v_before jsonb;
begin
  if not tartan.is_staff(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select to_jsonb(d) into v_before from tartan.daily_challenges d where id = p_challenge_id;

  update tartan.daily_challenges set status = 'ended', end_time = least(end_time, now())
   where id = p_challenge_id and status in ('active', 'paused');
  if not found then
    raise exception 'challenge % is not active/paused', p_challenge_id;
  end if;

  perform tartan.refresh_challenge_leaderboard(p_challenge_id);

  update tartan.challenge_participants cp
     set final_rank = cl.rank
    from tartan.challenge_leaderboards cl
   where cl.challenge_id = p_challenge_id
     and cl.user_id = cp.user_id
     and cp.challenge_id = p_challenge_id;

  -- Seed payouts for the winners at pending_verification, from the frozen
  -- prize table joined to the frozen ranks. No money moves here.
  insert into tartan.challenge_payouts (challenge_id, user_id, rank, final_score, prize_amount_cents)
  select cl.challenge_id, cl.user_id, cl.rank, cl.final_score, pr.prize_amount_cents
    from tartan.challenge_leaderboards cl
    join tartan.challenge_prizes pr
      on pr.challenge_id = cl.challenge_id and pr.rank = cl.rank
   where cl.challenge_id = p_challenge_id
  on conflict (challenge_id, user_id) do nothing;

  insert into tartan.challenge_audit_logs (challenge_id, actor_user_id, action, before, after)
  values (p_challenge_id, auth.uid(), 'end_challenge', v_before,
          (select to_jsonb(d) from tartan.daily_challenges d where id = p_challenge_id));
end;
$$;

grant execute on function tartan.end_challenge(uuid) to authenticated;

create or replace function tartan.cancel_challenge(p_challenge_id uuid) returns void
language plpgsql
security definer
set search_path = tartan
as $$
begin
  if not tartan.is_staff(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update tartan.daily_challenges set status = 'cancelled'
   where id = p_challenge_id and status in ('scheduled', 'active', 'paused');
  if not found then
    raise exception 'challenge % cannot be cancelled from its current status', p_challenge_id;
  end if;
  -- A cancelled challenge cannot have paid anyone yet by construction
  -- (end_challenge is the only path that creates payout rows), but voiding
  -- any that slipped through some future code path is a one-line safety net.
  update tartan.challenge_payouts set payout_status = 'cancelled'
   where challenge_id = p_challenge_id and payout_status <> 'paid';
  insert into tartan.challenge_audit_logs (challenge_id, actor_user_id, action)
  values (p_challenge_id, auth.uid(), 'cancel_challenge');
end;
$$;

grant execute on function tartan.cancel_challenge(uuid) to authenticated;

-- --------------------------------------------------------- run submission

create or replace function tartan.submit_qualification_run(
  p_challenge_id uuid,
  p_score bigint,
  p_distance int,
  p_duration_ms int,
  p_prisms int,
  p_near_misses int,
  p_stage int,
  p_session_id text,
  p_device_fingerprint text
) returns text
language plpgsql
security definer
set search_path = tartan
as $$
declare
  v_user      uuid := auth.uid();
  v_challenge tartan.daily_challenges%rowtype;
  v_recent    int;
  v_reason    text;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_challenge from tartan.daily_challenges where id = p_challenge_id;
  if not found or v_challenge.status <> 'active' then
    return 'challenge_not_active';
  end if;
  if now() < v_challenge.start_time or now() > v_challenge.end_time then
    return 'outside_challenge_window';
  end if;

  select count(*) into v_recent
    from tartan.challenge_qualifications
   where user_id = v_user and challenge_id = p_challenge_id and submitted_at > now() - interval '1 minute';
  if v_recent >= 10 then
    return 'rate_limited';
  end if;

  -- Reuses the same physical-bounds validator the free leaderboard uses —
  -- a qualification run is scored by the same formula a normal run is.
  v_reason := tartan.validate_run(p_score, p_distance, p_duration_ms, p_prisms, p_near_misses, p_stage);

  insert into tartan.challenge_qualifications
    (challenge_id, user_id, score, distance, duration_ms, server_validated, rejection_reason)
  values (p_challenge_id, v_user, p_score, p_distance, p_duration_ms, v_reason is null, v_reason);

  if v_reason is not null then
    return v_reason;
  end if;

  insert into tartan.challenge_participants (
    challenge_id, user_id, qualification_score, session_id, device_fingerprint_hash
  ) values (p_challenge_id, v_user, p_score, p_session_id, p_device_fingerprint)
  on conflict (challenge_id, user_id) do update set
    qualification_score = greatest(tartan.challenge_participants.qualification_score, excluded.qualification_score),
    session_id = excluded.session_id,
    device_fingerprint_hash = excluded.device_fingerprint_hash;

  -- Duplicate-session signal: the same session_id claimed by a second user
  -- this challenge is a scripted-submission tell worth a human's attention,
  -- not a coincidence worth ignoring.
  if exists (
    select 1 from tartan.challenge_participants
     where challenge_id = p_challenge_id and session_id = p_session_id and user_id <> v_user
  ) then
    insert into tartan.challenge_disqualifications (challenge_id, user_id, reason, severity, evidence)
    values (p_challenge_id, v_user, 'duplicate_session_id', 'flag', jsonb_build_object('session_id', p_session_id));
    update tartan.challenge_participants set anti_cheat_status = 'flagged'
     where challenge_id = p_challenge_id and user_id = v_user and anti_cheat_status = 'clean';
  end if;

  if p_score >= v_challenge.qualification_target then
    update tartan.challenge_participants
       set qualification_status = 'qualified',
           qualification_timestamp = coalesce(qualification_timestamp, now())
     where challenge_id = p_challenge_id and user_id = v_user and qualification_status <> 'qualified';
    return 'qualified';
  end if;

  return 'accepted';
end;
$$;

grant execute on function
  tartan.submit_qualification_run(uuid, bigint, int, int, int, int, int, text, text)
  to authenticated;

create or replace function tartan.submit_final_run(
  p_challenge_id uuid,
  p_score bigint,
  p_distance int,
  p_duration_ms int,
  p_prisms int,
  p_near_misses int,
  p_stage int,
  p_session_id text
) returns text
language plpgsql
security definer
set search_path = tartan
as $$
declare
  v_user        uuid := auth.uid();
  v_challenge   tartan.daily_challenges%rowtype;
  v_participant tartan.challenge_participants%rowtype;
  v_reason      text;
  v_attempt     int;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select * into v_challenge from tartan.daily_challenges where id = p_challenge_id;
  if not found or v_challenge.status <> 'active' then
    return 'challenge_not_active';
  end if;

  -- Locked for the duration of this call: two concurrent submissions from
  -- the same buggy/malicious client must not both slip past the attempts
  -- check before either one's increment is visible to the other.
  select * into v_participant from tartan.challenge_participants
   where challenge_id = p_challenge_id and user_id = v_user
   for update;
  if not found or v_participant.qualification_status <> 'qualified' then
    return 'not_qualified';
  end if;
  if v_participant.anti_cheat_status = 'disqualified' then
    return 'disqualified';
  end if;
  if v_participant.final_attempts_used >= v_challenge.max_final_attempts then
    return 'attempts_exhausted';
  end if;

  v_reason := tartan.validate_run(p_score, p_distance, p_duration_ms, p_prisms, p_near_misses, p_stage);
  v_attempt := v_participant.final_attempts_used + 1;

  insert into tartan.challenge_final_scores
    (challenge_id, user_id, score, distance, duration_ms, attempt_number, server_validated, rejection_reason)
  values (p_challenge_id, v_user, p_score, p_distance, p_duration_ms, v_attempt, v_reason is null, v_reason);

  if v_reason is not null then
    update tartan.challenge_participants set final_attempts_used = v_attempt
     where challenge_id = p_challenge_id and user_id = v_user;
    return v_reason;
  end if;

  -- Best-of-N attempts. updated_at only moves on a genuine improvement,
  -- which is what makes it the correct "earlier completion wins the tie"
  -- column for the leaderboard sort — not merely the most recent attempt.
  update tartan.challenge_participants
     set final_attempts_used = v_attempt,
         final_score = greatest(final_score, p_score),
         updated_at = case when p_score > final_score then now() else updated_at end
   where challenge_id = p_challenge_id and user_id = v_user;

  return 'accepted';
end;
$$;

grant execute on function
  tartan.submit_final_run(uuid, bigint, int, int, int, int, int, text)
  to authenticated;

-- ------------------------------------------------------------- leaderboard

create or replace function tartan.championship_leaderboard_page(p_challenge_id uuid, p_limit int default 25)
returns table (rank int, user_id uuid, username text, final_score bigint, completed_at timestamptz)
language sql
stable
security definer
set search_path = tartan
as $$
  select cl.rank, cl.user_id, p.username, cl.final_score, cl.completed_at
    from tartan.challenge_leaderboards cl
    join tartan.profiles p on p.user_id = cl.user_id
   where cl.challenge_id = p_challenge_id
   order by cl.rank
   limit least(greatest(p_limit, 1), 200);
$$;

grant execute on function tartan.championship_leaderboard_page(uuid, int) to anon, authenticated;

create or replace function tartan.championship_self_rank(p_challenge_id uuid)
returns int
language sql
stable
security definer
set search_path = tartan
as $$
  select (count(*) + 1)::int
    from tartan.challenge_participants
   where challenge_id = p_challenge_id
     and qualification_status = 'qualified'
     and anti_cheat_status <> 'disqualified'
     and final_score > coalesce((
       select final_score from tartan.challenge_participants
        where challenge_id = p_challenge_id and user_id = auth.uid()
     ), -1);
$$;

grant execute on function tartan.championship_self_rank(uuid) to authenticated;

-- A safe, non-sensitive aggregate — "how many people have qualified today"
-- is exactly the social-proof number the Daily Challenge screen shows, and
-- unlike challenge_participants itself it reveals nothing about any one player.
create or replace function tartan.championship_qualified_count(p_challenge_id uuid)
returns bigint
language sql
stable
security definer
set search_path = tartan
as $$
  select count(*) from tartan.challenge_participants
   where challenge_id = p_challenge_id and qualification_status = 'qualified';
$$;

grant execute on function tartan.championship_qualified_count(uuid) to anon, authenticated;

-- -------------------------------------------------------------- payouts

create or replace function tartan.mark_payout_verified(p_payout_id uuid) returns void
language plpgsql security definer set search_path = tartan as $$
begin
  if not tartan.is_staff(auth.uid()) then raise exception 'not authorized' using errcode = '42501'; end if;
  update tartan.challenge_payouts set verification_status = 'verified', verified_at = now()
   where id = p_payout_id and verification_status = 'pending_verification';
  if not found then raise exception 'payout % not pending verification', p_payout_id; end if;
  insert into tartan.challenge_audit_logs (challenge_id, actor_user_id, action, after)
  select challenge_id, auth.uid(), 'mark_payout_verified', jsonb_build_object('payout_id', p_payout_id)
    from tartan.challenge_payouts where id = p_payout_id;
end;
$$;

grant execute on function tartan.mark_payout_verified(uuid) to authenticated;

create or replace function tartan.mark_payout_rejected(p_payout_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = tartan as $$
begin
  if not tartan.is_staff(auth.uid()) then raise exception 'not authorized' using errcode = '42501'; end if;
  update tartan.challenge_payouts
     set verification_status = 'rejected', payout_status = 'cancelled'
   where id = p_payout_id and verification_status = 'pending_verification';
  if not found then raise exception 'payout % not pending verification', p_payout_id; end if;
  insert into tartan.challenge_audit_logs (challenge_id, actor_user_id, action, after)
  select challenge_id, auth.uid(), 'mark_payout_rejected', jsonb_build_object('payout_id', p_payout_id, 'reason', p_reason)
    from tartan.challenge_payouts where id = p_payout_id;
end;
$$;

grant execute on function tartan.mark_payout_rejected(uuid, text) to authenticated;

create or replace function tartan.mark_payout_approved(p_payout_id uuid) returns void
language plpgsql security definer set search_path = tartan as $$
begin
  if not tartan.is_staff(auth.uid()) then raise exception 'not authorized' using errcode = '42501'; end if;
  update tartan.challenge_payouts set payout_status = 'approved', approved_at = now()
   where id = p_payout_id and verification_status = 'verified' and payout_status = 'pending';
  if not found then raise exception 'payout % not eligible for approval', p_payout_id; end if;
  insert into tartan.challenge_audit_logs (challenge_id, actor_user_id, action, after)
  select challenge_id, auth.uid(), 'mark_payout_approved', jsonb_build_object('payout_id', p_payout_id)
    from tartan.challenge_payouts where id = p_payout_id;
end;
$$;

grant execute on function tartan.mark_payout_approved(uuid) to authenticated;

-- The one function in this file that records real money having moved — and
-- even this only records it; it never moves anything itself. See file header.
create or replace function tartan.mark_payout_paid(p_payout_id uuid, p_external_reference text) returns void
language plpgsql security definer set search_path = tartan as $$
begin
  if not tartan.is_staff(auth.uid()) then raise exception 'not authorized' using errcode = '42501'; end if;
  if p_external_reference is null or length(trim(p_external_reference)) = 0 then
    raise exception 'external_reference is required to mark a payout paid';
  end if;
  update tartan.challenge_payouts
     set payout_status = 'paid', paid_at = now(), external_reference = p_external_reference
   where id = p_payout_id and payout_status = 'approved';
  if not found then raise exception 'payout % not approved', p_payout_id; end if;
  insert into tartan.challenge_audit_logs (challenge_id, actor_user_id, action, after)
  select challenge_id, auth.uid(), 'mark_payout_paid',
         jsonb_build_object('payout_id', p_payout_id, 'external_reference', p_external_reference)
    from tartan.challenge_payouts where id = p_payout_id;
end;
$$;

grant execute on function tartan.mark_payout_paid(uuid, text) to authenticated;

create or replace function tartan.admin_disqualify_participant(
  p_challenge_id uuid, p_user uuid, p_reason text
) returns void
language plpgsql security definer set search_path = tartan as $$
begin
  if not tartan.is_staff(auth.uid()) then raise exception 'not authorized' using errcode = '42501'; end if;

  update tartan.challenge_participants set anti_cheat_status = 'disqualified'
   where challenge_id = p_challenge_id and user_id = p_user;

  insert into tartan.challenge_disqualifications (challenge_id, user_id, reason, severity, source, created_by)
  values (p_challenge_id, p_user, p_reason, 'disqualify', 'admin', auth.uid());

  -- A disqualification found after end_challenge() must be able to void an
  -- already-queued payout before it reaches 'paid' — never after.
  update tartan.challenge_payouts set payout_status = 'cancelled'
   where challenge_id = p_challenge_id and user_id = p_user and payout_status <> 'paid';
end;
$$;

grant execute on function tartan.admin_disqualify_participant(uuid, uuid, text) to authenticated;

-- --------------------------------------------------------------- config

create or replace function tartan.update_challenge_config(
  p_reference_percentile numeric,
  p_qualification_multiplier numeric,
  p_minimum_target bigint,
  p_maximum_target bigint,
  p_fallback_target bigint,
  p_minimum_sample_size int,
  p_default_prize_pool_usd_cents bigint,
  p_default_winner_count int,
  p_default_prize_distribution jsonb,
  p_default_max_final_attempts int
) returns void
language plpgsql
security definer
set search_path = tartan
as $$
declare v_before jsonb;
begin
  if not tartan.is_staff(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select to_jsonb(c) into v_before from tartan.daily_challenge_configs c where id = 1;

  update tartan.daily_challenge_configs set
    reference_percentile = p_reference_percentile,
    qualification_multiplier = p_qualification_multiplier,
    minimum_target = p_minimum_target,
    maximum_target = p_maximum_target,
    fallback_target = p_fallback_target,
    minimum_sample_size = p_minimum_sample_size,
    default_prize_pool_usd_cents = p_default_prize_pool_usd_cents,
    default_winner_count = p_default_winner_count,
    default_prize_distribution = p_default_prize_distribution,
    default_max_final_attempts = p_default_max_final_attempts,
    updated_at = now(), updated_by = auth.uid()
  where id = 1;

  insert into tartan.challenge_audit_logs (actor_user_id, action, before, after)
  values (auth.uid(), 'update_challenge_config', v_before,
          (select to_jsonb(c) from tartan.daily_challenge_configs c where id = 1));
end;
$$;

grant execute on function
  tartan.update_challenge_config(numeric, numeric, bigint, bigint, bigint, int, bigint, int, jsonb, int)
  to authenticated;

create or replace function tartan.update_region_setting(p_country text, p_enabled boolean, p_min_age int) returns void
language plpgsql
security definer
set search_path = tartan
as $$
begin
  if not tartan.is_staff(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  insert into tartan.region_settings (country_code, cash_prize_enabled, min_age, updated_by)
  values (upper(p_country), p_enabled, p_min_age, auth.uid())
  on conflict (country_code) do update set
    cash_prize_enabled = excluded.cash_prize_enabled,
    min_age = excluded.min_age,
    updated_at = now(),
    updated_by = excluded.updated_by;

  insert into tartan.challenge_audit_logs (actor_user_id, action, after)
  values (auth.uid(), 'update_region_setting', jsonb_build_object('country', upper(p_country), 'enabled', p_enabled));
end;
$$;

grant execute on function tartan.update_region_setting(text, boolean, int) to authenticated;

-- Fail-closed: no row for a country means no cash prizes for that country.
create or replace function tartan.region_cash_prize_enabled(p_country text)
returns boolean
language sql
stable
security definer
set search_path = tartan
as $$
  select coalesce(
    (select cash_prize_enabled from tartan.region_settings where country_code = upper(p_country)),
    false
  );
$$;

grant execute on function tartan.region_cash_prize_enabled(text) to anon, authenticated;

-- ------------------------------------------------------------- monitoring

create or replace function tartan.challenge_monitoring(p_challenge_id uuid)
returns table (
  total_participants bigint,
  qualified bigint,
  finalists bigint,
  flagged bigint,
  disqualified bigint,
  winners bigint,
  pending_payouts bigint,
  completed_payouts bigint
)
language plpgsql
stable
security definer
set search_path = tartan
as $$
begin
  if not tartan.is_staff(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  return query
  select
    (select count(*) from tartan.challenge_participants where challenge_id = p_challenge_id),
    (select count(*) from tartan.challenge_participants where challenge_id = p_challenge_id and qualification_status = 'qualified'),
    (select count(*) from tartan.challenge_participants where challenge_id = p_challenge_id and final_score > 0),
    (select count(*) from tartan.challenge_participants where challenge_id = p_challenge_id and anti_cheat_status = 'flagged'),
    (select count(*) from tartan.challenge_participants where challenge_id = p_challenge_id and anti_cheat_status = 'disqualified'),
    (select count(*) from tartan.challenge_payouts where challenge_id = p_challenge_id),
    (select count(*) from tartan.challenge_payouts where challenge_id = p_challenge_id and payout_status in ('pending', 'approved')),
    (select count(*) from tartan.challenge_payouts where challenge_id = p_challenge_id and payout_status = 'paid');
end;
$$;

grant execute on function tartan.challenge_monitoring(uuid) to authenticated;

-- --------------------------------------------------------------- grants

-- Base table grants. RLS (above) narrows every one of these to "own row or
-- staff" or "public read"; nothing here grants INSERT/UPDATE/DELETE to
-- anon/authenticated anywhere — every write in this file goes through a
-- SECURITY DEFINER function, exactly like submit_run/grant_coins in 0001.
grant select on tartan.coin_packages to anon, authenticated;
grant select on tartan.purchase_records, tartan.coin_transactions, tartan.revive_transactions to authenticated;
grant select on tartan.daily_challenges, tartan.challenge_leaderboards, tartan.challenge_prizes to anon, authenticated;
grant select on tartan.challenge_participants, tartan.challenge_qualifications, tartan.challenge_final_scores to authenticated;
grant select on tartan.challenge_payouts to authenticated;
grant select on tartan.region_settings to anon, authenticated;
grant select on tartan.daily_challenge_configs, tartan.challenge_disqualifications, tartan.challenge_audit_logs to authenticated;

-- ------------------------------------------------------------- maintenance
--
-- Optional, exactly like the pg_cron examples in 0001_init.sql. Keeps the
-- leaderboard cache warm for every currently-active challenge without the
-- client ever paying for a full re-rank on open:
--
--   select cron.schedule(
--     'tartan-refresh-championship-leaderboard',
--     '*/1 * * * *',
--     $$select tartan.refresh_challenge_leaderboard(id) from tartan.daily_challenges where status = 'active'$$
--   );
--
-- Granting the first admin (there is no self-service path, deliberately):
--
--   insert into tartan.staff_roles (user_id, role) values ('<uuid-of-first-admin>', 'admin');
