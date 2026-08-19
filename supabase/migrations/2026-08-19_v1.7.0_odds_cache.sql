-- ============================================================
-- VIG v1.7.0 — server-side odds cache and quota budget
--
-- Safe to run more than once.
--
-- WHY THIS TABLE EXISTS
-- The Odds API free tier is 500 credits a month, about 16 a day. Without a
-- shared cache, every visitor who loads the board costs one credit: three
-- friends refreshing a few times would empty the month in under a week.
--
-- So the Edge Function never calls upstream on behalf of a visitor. It reads
-- this table. Upstream is called only when the cached row is stale AND the
-- day's budget has room. Traffic and cost are decoupled: a thousand visitors
-- and one visitor cost exactly the same.
--
-- Nothing here is reachable from the browser. RLS is on with no policy, so
-- only the service role — which lives inside the Edge Function and nowhere
-- else — can touch it.
-- ============================================================

create table if not exists public.odds_cache (
  cache_key   text primary key,
  payload     jsonb       not null,
  fetched_at  timestamptz not null default now(),
  upstream_ok boolean     not null default true,
  quota_left  integer,
  note        text
);

comment on table public.odds_cache is
  'Shared odds payload. Read by the odds Edge Function; never exposed to clients.';

alter table public.odds_cache enable row level security;
-- deliberately no policy: service role only

-- ---------- daily budget ----------
-- One row per UTC day. The function increments before it calls upstream, so a
-- burst of concurrent requests cannot overshoot: the increment is atomic and
-- the check reads its own result.
create table if not exists public.odds_budget (
  day        date primary key,
  used       integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.odds_budget enable row level security;

-- Claim one credit for today. Returns the new count, or null if the cap is
-- already reached. Atomic: the insert-or-update and the test happen in one
-- statement, so two callers cannot both see the last credit as free.
-- SUPERSEDED IN v1.7.4 — this version did not enforce the cap.
-- At used = p_cap the CASE held the value, RETURNING yielded p_cap, and
-- `p_cap > p_cap` was false, so it returned a valid-looking credit forever.
-- The corrected function is in 2026-08-19_v1.7.4_quota_cap_fix.sql and is
-- reproduced here so a fresh install from this file alone is still correct.
create or replace function public.claim_odds_credit(p_cap integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used integer;
begin
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

  -- null means the WHERE refused the update: the day is spent
  return v_used;
end;
$$;

revoke all on function public.claim_odds_credit(integer) from public, anon, authenticated;

-- ---------- how much is left ----------
create or replace function public.odds_budget_today()
returns table (day date, used integer, updated_at timestamptz)
language sql
security definer
set search_path = public
as $$
  select day, used, updated_at
    from public.odds_budget
   where day = current_date;
$$;

revoke all on function public.odds_budget_today() from public, anon;
grant execute on function public.odds_budget_today() to authenticated;
