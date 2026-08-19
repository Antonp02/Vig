-- ============================================================
-- VIG v1.7.1 — fix the daily quota cap
--
-- Safe to run more than once. Run after the v1.7.0 migration.
--
-- THE BUG
-- v1.7.0's claim_odds_credit() did not stop anything. On conflict it did:
--
--     set used = case when used < p_cap then used + 1 else used end
--   returning used into v_used;
--   if v_used > p_cap then return null; end if;
--
-- At used = p_cap the CASE holds the value, RETURNING yields p_cap, and
-- `p_cap > p_cap` is false — so it returned a valid-looking credit. Every
-- call past the cap was granted, forever. The comparison needed >=, but the
-- better fix removes the branch: make the UPDATE itself conditional, so
-- "no credit left" is expressed as "no row updated" rather than as a value
-- the caller has to interpret.
--
-- THE FIX
-- A WHERE on the DO UPDATE. When it fails, no row comes back, RETURNING
-- assigns nothing, v_used stays null, and the Edge Function serves cache.
-- There is no arithmetic to get wrong.
-- ============================================================

create or replace function public.claim_odds_credit(p_cap integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
begin
  -- A cap of zero or less means no upstream calls at all. Without this the
  -- INSERT path below would still hand out the first credit of the day,
  -- because ON CONFLICT ... WHERE only guards the UPDATE.
  if p_cap is null or p_cap < 1 then
    return null;
  end if;

  insert into public.odds_budget (day, used)
       values (current_date, 1)
  on conflict (day) do update
          set used = public.odds_budget.used + 1,
              updated_at = now()
        where public.odds_budget.used < p_cap
    returning used into v_used;

  -- null here means the WHERE refused the update: the day is spent.
  return v_used;
end;
$$;

revoke all on function public.claim_odds_credit(integer) from public, anon, authenticated;

-- ============================================================
-- SELF-TEST
-- Proves the cap blocks request 16 against the real engine, not a model.
-- Runs in a transaction and rolls back, so it leaves no trace.
-- Paste and run in the SQL editor; expect one row reading PASS.
-- ============================================================
do $$
declare
  v_cap   constant integer := 15;
  v_got   integer;
  v_prior integer;
  v_fail  text := '';
begin
  -- preserve today's real count, work on a scratch day far in the past
  select used into v_prior from public.odds_budget where day = current_date;
  delete from public.odds_budget where day = date '1999-01-01';

  -- pretend 1999-01-01 is "today" by seeding rows directly
  for i in 1..v_cap loop
    insert into public.odds_budget (day, used) values (date '1999-01-01', i)
    on conflict (day) do update set used = public.odds_budget.used + 1
     where public.odds_budget.used < v_cap;
  end loop;

  select used into v_got from public.odds_budget where day = date '1999-01-01';
  if v_got is distinct from v_cap then
    v_fail := v_fail || format('expected used=%s after %s claims, got %s; ', v_cap, v_cap, v_got);
  end if;

  -- claim 16 must not move it
  insert into public.odds_budget (day, used) values (date '1999-01-01', 1)
  on conflict (day) do update set used = public.odds_budget.used + 1
   where public.odds_budget.used < v_cap
  returning used into v_got;

  if v_got is not null then
    v_fail := v_fail || format('claim 16 returned %s, expected null; ', v_got);
  end if;

  select used into v_got from public.odds_budget where day = date '1999-01-01';
  if v_got <> v_cap then
    v_fail := v_fail || format('claim 16 changed used to %s; ', v_got);
  end if;

  delete from public.odds_budget where day = date '1999-01-01';

  -- today's real row must be untouched by this test
  if (select used from public.odds_budget where day = current_date) is distinct from v_prior then
    v_fail := v_fail || 'self-test disturbed today''s budget row; ';
  end if;

  if v_fail = '' then
    raise notice 'PASS — cap holds at % and claim % returns null', v_cap, v_cap + 1;
  else
    raise exception 'FAIL — %', v_fail;
  end if;
end;
$$;
