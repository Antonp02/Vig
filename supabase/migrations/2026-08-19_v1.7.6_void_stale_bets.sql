-- ============================================================
-- VIG v1.7.6 — void stale open bets from closed weeks
--
-- Safe to run more than once. Preview first, then commit.
--
-- WHY
-- Weekly rollover archives a closed week on the CLIENT: ungraded tickets are
-- voided and the stakes refunded. The server never heard about it, because RLS
-- correctly forbids a user updating their own bets — otherwise anyone could
-- declare themselves a winner. So rows from weeks that closed while
-- AUTO_ROLLOVER was off are still sitting at status = 'open' in Postgres.
--
-- They do no harm to any bankroll: bets are scoped per week, and a closed week
-- is not part of the current one. But they make admin_stats and any historical
-- query read wrong, and "open" is simply not true of a game played weeks ago.
--
-- WHAT THIS DOES NOT DO
-- It does not decide winners. A ticket nobody graded is VOID, not lost and not
-- won — the bettor did nothing wrong, so the stake goes back. Grading from
-- results is the settlement path's job, not a cleanup script's.
-- ============================================================

-- ---------- the week key, as the client computes it ----------
-- Tuesday 04:00 America/New_York. Must agree with weekKeyFor() in app.js;
-- tests/weekkeysql.mjs checks the two against each other across DST.
create or replace function public.vig_week_key(p_at timestamptz default now())
returns date
language sql
immutable
as $$
  select (local_ts)::date - (((extract(dow from local_ts)::int - 2) + 7) % 7)
  from (select (p_at at time zone 'America/New_York') - interval '4 hours' as local_ts) s;
$$;

comment on function public.vig_week_key(timestamptz) is
  'Tuesday-of-competition-week, 04:00 America/New_York. Mirrors weekKeyFor() in app.js.';

-- ---------- preview ----------
-- Run this on its own first. It changes nothing.
create or replace function public.stale_open_bets()
returns table (week_key text, bets bigint, staked numeric, oldest timestamptz)
language sql
security definer
set search_path = public
as $$
  select b.week_key,
         count(*)          as bets,
         sum(b.stake)      as staked,
         min(b.created_at) as oldest
    from public.bets b
   where b.status = 'open'
     and b.week_key < public.vig_week_key()::text
   group by b.week_key
   order by b.week_key;
$$;

revoke all on function public.stale_open_bets() from public, anon;
grant execute on function public.stale_open_bets() to authenticated;

-- ---------- the cleanup ----------
create or replace function public.void_stale_bets(p_commit boolean default false)
returns table (week_key text, voided bigint, refunded numeric)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Admin only. Voiding refunds stakes across every user's ledger, so this is
  -- not something an ordinary signed-in account may trigger.
  if not exists (select 1 from public.admins a where a.user_id = auth.uid()) then
    raise exception 'admin only' using errcode = '42501';
  end if;

  if not p_commit then
    -- dry run: report exactly what a commit would touch
    return query
      select b.week_key, count(*)::bigint, sum(b.stake)
        from public.bets b
       where b.status = 'open'
         and b.week_key < public.vig_week_key()::text
       group by b.week_key
       order by b.week_key;
    return;
  end if;

  -- open -> void is a legal transition under bets_guard, and the trigger sets
  -- settled_at. stake, odds and potential_return are untouched, as they must be.
  return query
    with updated as (
      update public.bets b
         set status = 'void'
       where b.status = 'open'
         and b.week_key < public.vig_week_key()::text
      returning b.week_key, b.stake
    )
    select u.week_key, count(*)::bigint, sum(u.stake)
      from updated u
     group by u.week_key
     order by u.week_key;
end;
$$;

revoke all on function public.void_stale_bets(boolean) from public, anon, authenticated;

-- ============================================================
-- HOW TO RUN
--
--   select * from public.stale_open_bets();        -- look first
--   select * from public.void_stale_bets(false);   -- dry run, as admin
--   select * from public.void_stale_bets(true);    -- commit
--
-- Then confirm nothing is left behind:
--
--   select * from public.stale_open_bets();        -- expect zero rows
--
-- Bets in the CURRENT week are never touched, whatever their status.
-- ============================================================
