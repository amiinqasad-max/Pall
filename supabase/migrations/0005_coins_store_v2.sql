-- TARTAN — Coins Store v2: remove Watch Video, admin-managed Read Article
-- links, and a WhatsApp-based manual Buy Coins flow.
--
-- On top of 0001/0002/0003/0004:
--
--  1. Watch Video → Coins is removed completely: the RPCs, the session
--     table, the game_constants rows, and the 'video_reward' ledger reason
--     are all dropped, not merely hidden. Ads elsewhere in the game
--     (rewarded continue, daily bonus, mystery reward, post-run coin bonus)
--     are untouched — this only removes the Coins-for-video feature.
--
--  2. Read Article becomes the only free earn method, and its content moves
--     from static in-app text to admin-managed links: a new tartan.articles
--     table (title + url + active), with staff-only CRUD RPCs. The client
--     picks one active article at random and opens its real URL — this
--     project still cannot prove a human read every word (see 0003's
--     header), so the server-side guarantee stays exactly what it was:
--     a server-timestamped session, a minimum elapsed time checked against
--     the server's own clock, one claim per session, and a daily cap.
--
--  3. Buy Coins moves from "record a purchase attempt, wait for a staff
--     member to verify it" (unchanged mechanism) to Birr-priced packages
--     opening a pre-filled WhatsApp message — the verification step was
--     already manual/staff-gated before this file and stays exactly that;
--     only the price currency (USD cents → Birr) and the reported
--     "platform" (a new 'whatsapp' value) change. Nothing here ever credits
--     coins on its own — admin_verify_and_credit_purchase (unchanged) is
--     still the only thing that does, and still only for a staff member.
--
-- Revive stays at 100 coins (0003) and remains usable in the Cash
-- Championship final (0004) — this file does not touch either.

-- ============================================================ 1. Watch Video

drop function if exists tartan.claim_video_reward(uuid);
drop function if exists tartan.start_video_ad_session();
drop table if exists tartan.video_ad_sessions;

delete from tartan.coin_transactions where reason = 'video_reward';
delete from tartan.game_constants
 where key in ('video_reward_coins', 'video_reward_daily_limit', 'video_min_watch_seconds');

alter table tartan.coin_transactions drop constraint if exists coin_transactions_reason_check;
alter table tartan.coin_transactions add constraint coin_transactions_reason_check
  check (reason in ('purchase_credit', 'revive_spend', 'admin_adjustment', 'article_reward'));

-- ============================================================ 2. Articles

create table if not exists tartan.articles (
  id          uuid primary key default gen_random_uuid(),
  title       text not null check (length(trim(title)) > 0),
  url         text not null check (length(trim(url)) > 0),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id)
);

alter table tartan.articles enable row level security;

drop policy if exists "articles: read active or staff" on tartan.articles;
create policy "articles: read active or staff"
  on tartan.articles for select
  using (active or tartan.is_staff(auth.uid()));

-- No INSERT/UPDATE/DELETE policy — admin_upsert_article()/admin_delete_article()
-- (both staff-gated SECURITY DEFINER functions) are the only writers.

create or replace function tartan.admin_upsert_article(
  p_id text,
  p_title text,
  p_url text,
  p_active boolean
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
  if coalesce(trim(p_title), '') = '' or coalesce(trim(p_url), '') = '' then
    raise exception 'title and url are required' using errcode = '22023';
  end if;

  if coalesce(trim(p_id), '') = '' then
    insert into tartan.articles (title, url, active, created_by)
    values (trim(p_title), trim(p_url), coalesce(p_active, true), auth.uid())
    returning id into v_id;

    insert into tartan.challenge_audit_logs (actor_user_id, action, after)
    values (auth.uid(), 'create_article', jsonb_build_object('id', v_id, 'title', p_title, 'url', p_url));
  else
    v_id := p_id::uuid;
    update tartan.articles
       set title = trim(p_title), url = trim(p_url), active = coalesce(p_active, true), updated_at = now()
     where id = v_id;
    if not found then
      raise exception 'article % not found', p_id;
    end if;

    insert into tartan.challenge_audit_logs (actor_user_id, action, after)
    values (auth.uid(), 'update_article', jsonb_build_object('id', v_id, 'title', p_title, 'url', p_url, 'active', p_active));
  end if;

  return v_id;
end;
$$;

revoke execute on function tartan.admin_upsert_article(text, text, text, boolean) from public;
grant execute on function tartan.admin_upsert_article(text, text, text, boolean) to authenticated;

create or replace function tartan.admin_delete_article(p_id uuid) returns void
language plpgsql
security definer
set search_path = tartan
as $$
begin
  if not tartan.is_staff(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  delete from tartan.articles where id = p_id;
  insert into tartan.challenge_audit_logs (actor_user_id, action, after)
  values (auth.uid(), 'delete_article', jsonb_build_object('id', p_id));
end;
$$;

revoke execute on function tartan.admin_delete_article(uuid) from public;
grant execute on function tartan.admin_delete_article(uuid) to authenticated;

grant select on tartan.articles to anon, authenticated;

-- Read sessions must now reference a real, currently-active admin-managed
-- article — a client can no longer make one up. article_read_sessions keeps
-- storing article_id as text (unchanged column) so a later admin deletion of
-- an article never cascades into rewriting historical read/reward audit
-- rows.
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
  if not exists (select 1 from tartan.articles where id = p_article_id::uuid and active) then
    raise exception 'unknown or inactive article %', p_article_id using errcode = '22023';
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

-- ============================================================ 3. economy_status()

-- Return shape changes (video_* columns removed) so this must be dropped,
-- not just replaced.
drop function if exists tartan.economy_status();

create or replace function tartan.economy_status()
returns table (
  coins                       bigint,
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

-- ============================================================ 4. admin config

-- Param list shrinks (video_* params removed) so this must be dropped, not
-- just replaced.
drop function if exists tartan.admin_update_economy_config(numeric, numeric, numeric, numeric, numeric, numeric, numeric);

create or replace function tartan.admin_update_economy_config(
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

  update tartan.game_constants set value = p_article_reward_coins, updated_at = now() where key = 'article_reward_coins';
  update tartan.game_constants set value = p_article_reward_daily_limit, updated_at = now() where key = 'article_reward_daily_limit';
  update tartan.game_constants set value = p_article_min_read_seconds, updated_at = now() where key = 'article_min_read_seconds';
  update tartan.game_constants set value = p_revive_cost_coins, updated_at = now() where key = 'revive_cost_coins';

  insert into tartan.challenge_audit_logs (actor_user_id, action, after)
  values (auth.uid(), 'update_economy_config', jsonb_build_object(
    'article_reward_coins', p_article_reward_coins,
    'article_reward_daily_limit', p_article_reward_daily_limit,
    'article_min_read_seconds', p_article_min_read_seconds,
    'revive_cost_coins', p_revive_cost_coins
  ));
end;
$$;

revoke execute on function tartan.admin_update_economy_config(numeric, numeric, numeric, numeric) from public;
grant execute on function tartan.admin_update_economy_config(numeric, numeric, numeric, numeric) to authenticated;

-- ============================================================ 5. Buy Coins (Birr / WhatsApp)

alter table tartan.coin_packages rename column price_usd_cents to price_birr;

update tartan.coin_packages set price_birr = 50,  name = '500 Coins'    where id = 'coins_500';
update tartan.coin_packages set price_birr = 80,  name = '1,000 Coins'  where id = 'coins_1000';
update tartan.coin_packages set price_birr = 150, name = '2,000 Coins'  where id = 'coins_2000';

insert into tartan.coin_packages (id, name, coins, price_birr, sort_order) values
  ('coins_10000', '10,000 Coins', 10000, 500, 4)
on conflict (id) do update set
  name = excluded.name, coins = excluded.coins, price_birr = excluded.price_birr, sort_order = excluded.sort_order;

alter table tartan.purchase_records rename column price_usd_cents to price_birr;
alter table tartan.purchase_records alter column currency set default 'ETB';
update tartan.purchase_records set currency = 'ETB' where currency = 'USD';

alter table tartan.purchase_records drop constraint if exists purchase_records_platform_check;
alter table tartan.purchase_records add constraint purchase_records_platform_check
  check (platform in ('web', 'ios', 'android', 'whatsapp'));

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
  if p_platform not in ('web', 'ios', 'android', 'whatsapp') then
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

  insert into tartan.purchase_records (user_id, package_id, platform, receipt_token, price_birr, currency)
  values (v_user, p_package_id, p_platform, p_receipt_token, v_pkg.price_birr, 'ETB')
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

-- Param name changes (price_usd_cents -> price_birr) so this must be
-- dropped, not just replaced.
drop function if exists tartan.admin_upsert_coin_package(text, text, int, int, boolean, int);

create or replace function tartan.admin_upsert_coin_package(
  p_id text, p_name text, p_coins int, p_price_birr int, p_active boolean, p_sort_order int
) returns void
language plpgsql
security definer
set search_path = tartan
as $$
begin
  if not tartan.is_staff(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  insert into tartan.coin_packages (id, name, coins, price_birr, active, sort_order)
  values (p_id, p_name, p_coins, p_price_birr, p_active, p_sort_order)
  on conflict (id) do update set
    name = excluded.name, coins = excluded.coins, price_birr = excluded.price_birr,
    active = excluded.active, sort_order = excluded.sort_order, updated_at = now();
end;
$$;

grant execute on function tartan.admin_upsert_coin_package(text, text, int, int, boolean, int) to authenticated;

-- Complements admin_verify_and_credit_purchase (unchanged, 0002) — a staff
-- member can now also close out a bogus/duplicate/unpaid WhatsApp order
-- without crediting it.
create or replace function tartan.admin_reject_purchase(p_purchase_id uuid, p_reason text) returns void
language plpgsql
security definer
set search_path = tartan
as $$
begin
  if not tartan.is_staff(auth.uid()) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  update tartan.purchase_records set status = 'rejected', verified_at = now()
   where id = p_purchase_id and status = 'pending_verification';
  if not found then
    raise exception 'purchase % is not pending verification', p_purchase_id;
  end if;

  insert into tartan.challenge_audit_logs (actor_user_id, action, after)
  values (auth.uid(), 'reject_purchase', jsonb_build_object('purchase_id', p_purchase_id, 'reason', p_reason));
end;
$$;

revoke execute on function tartan.admin_reject_purchase(uuid, text) from public;
grant execute on function tartan.admin_reject_purchase(uuid, text) to authenticated;
