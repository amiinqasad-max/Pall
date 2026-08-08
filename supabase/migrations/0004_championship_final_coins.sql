-- TARTAN — Championship rule change: allow Coins/Revives in the final.
--
-- Previously `start_challenge()` (0002_championship.sql) snapshotted a
-- `final_rules` jsonb blob onto every new challenge with
-- `coins_disabled: true` and `paid_revives_disabled: true`. That blob was
-- never actually read by any RPC or client code — the real restriction
-- lived entirely client-side, in RunScene.die() forcing `canContinue =
-- false` whenever `championshipPhase === 'final'`, which made the coin-
-- revive offer unreachable during the final. Nothing in this schema ever
-- rejected a `spend_coins_for_revive` call based on Championship phase.
--
-- Per the updated rule: a qualified player's Coins — however earned (free
-- gameplay rewards, Watch Video, Read Article, or purchase) — may fund a
-- revive during the Cash Championship final, exactly as in a normal run.
-- The actual behavior change is in src/game/scenes/RunScene.ts (`die()`
-- no longer excludes the 'final' phase from `canContinue`) and
-- src/ui/screens/PlayScreen.tsx. This migration only re-points
-- `start_challenge()`'s descriptive `final_rules` snapshot so it stops
-- claiming a restriction that no longer holds — it is metadata, not an
-- enforcement path, and nothing else about the function changes.
--
-- Unaffected, deliberately: qualification, prize/payout/KYC/region-gating
-- systems, anti-cheat, coin prices, the revive price, and
-- `paid_power_ups_disabled` (power-ups don't exist in this codebase yet;
-- that flag is left exactly as it was).

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
      -- Changed by this migration: Coins and Coin-priced revives are now
      -- explicitly allowed during the final (see header comment above).
      'coins_disabled', false, 'paid_revives_disabled', false,
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
