-- ============================================================
-- VIG v1.5 — Supabase schema
-- Paste this whole file into the Supabase SQL editor and run it once.
--
-- SECURITY MODEL, in one paragraph:
-- The anon key in your JavaScript is public by design. Row Level Security
-- is the only thing standing between a curious tester and a $50,000
-- bankroll. Two rules do the heavy lifting:
--   1. Users may INSERT their own bets but may never UPDATE them.
--      Settlement is admin-only. Otherwise anyone could set status='won'.
--   2. Bankroll is never stored. It is derived from the bets table, so
--      there is no balance column to tamper with.
-- ============================================================

-- ---------- profiles ----------
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 1 and 24),
  league_code  text check (char_length(league_code) <= 8),
  -- Avatar is a colour plus an optional emoji. No image uploads, so no
  -- storage bucket, no upload policies, and it works offline.
  avatar_color text check (avatar_color ~ '^#[0-9a-fA-F]{6}$'),
  avatar_emoji text check (char_length(avatar_emoji) <= 8),
  created_at   timestamptz not null default now()
);

-- If you already ran an earlier version of this file, these are safe to
-- re-run and will add the two new columns:
alter table public.profiles add column if not exists avatar_color text;
alter table public.profiles add column if not exists avatar_emoji text;

-- ---------- bets ----------
-- One row per ticket, golf or parlay. Odds are frozen at insert and can
-- never be changed by anyone, including an admin.
create table if not exists public.bets (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users on delete cascade,
  week_key         text not null,
  kind             text not null default 'golf' check (kind in ('golf','parlay')),
  event_id         text,
  market_id        text,
  selection_id     text,
  title            text not null,
  stake            numeric(10,2) not null check (stake >= 1),
  odds             integer not null check (abs(odds) >= 100),
  -- What the ticket WOULD pay: stake x decimal odds, fixed at placement.
  -- Immutable thereafter (see bets_guard). What it DID pay is derived from
  -- status by public.bet_payout() and is never stored -- a stored payout is
  -- a second source of truth, and second sources drift.
  potential_return numeric(10,2) not null check (potential_return > 0),
  status           text not null default 'open'
                     check (status in ('open','won','lost','push','void')),
  legs             jsonb,
  -- Closing Line Value needs to know what the market believed AT THE MOMENT
  -- the bet was placed. That is not recoverable later — the instant passes
  -- and no query brings it back. So it is written down on insert, even while
  -- the odds are still simulated, and compared against the closing line once
  -- the snapshot archive exists (v1.6).
  fair_prob        numeric(6,4) check (fair_prob is null or (fair_prob > 0 and fair_prob < 1)),
  fair_method      text check (fair_method in ('proportional','power','shin')),
  book_prices      jsonb,
  close_prob       numeric(6,4) check (close_prob is null or (close_prob > 0 and close_prob < 1)),
  placed_at        timestamptz not null default now(),
  settled_at       timestamptz
);

-- Safe to re-run if you already applied an earlier version of this file:
alter table public.bets add column if not exists fair_prob   numeric(6,4);
alter table public.bets add column if not exists fair_method text;
alter table public.bets add column if not exists book_prices jsonb;
alter table public.bets add column if not exists close_prob  numeric(6,4);
create index if not exists bets_user_week on public.bets (user_id, week_key);
create index if not exists bets_week      on public.bets (week_key);

-- The same user cannot hold two identical bets in the same week. Client
-- code deduplicates by content too, but a database constraint is the only
-- thing that makes it impossible rather than unlikely.
create unique index if not exists bets_no_duplicates
  on public.bets (user_id, week_key, kind,
                  coalesce(event_id,''), coalesce(selection_id,''),
                  stake, odds, md5(coalesce(legs::text,'')));
create index if not exists bets_event     on public.bets (event_id) where event_id is not null;

-- ---------- events ----------
-- Shared by everyone. Settling here settles the event for all users at
-- once, rather than only in the admin's own browser.
create table if not exists public.events (
  event_id            text primary key,
  name                text not null,
  lock_time           timestamptz,
  status              text not null default 'open'
                        check (status in ('open','locked','final')),
  winner_selection_id text,
  markets             jsonb,
  updated_at          timestamptz not null default now()
);

-- ---------- admins ----------
-- Add yourself after your first sign-in:
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'you@example.com';
create table if not exists public.admins (
  user_id uuid primary key references auth.users on delete cascade
);

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- ============================================================
-- VIG — missing table grants
--
-- "permission denied for table bets" is a GRANT problem, not RLS.
-- Two separate mechanisms have to both allow an operation:
--
--   GRANT  — may this role touch this table at all?
--   POLICY — which rows may it touch?
--
-- The schema enabled RLS and wrote ten policies but never granted the
-- underlying privileges, so every read failed before RLS was consulted.
-- Supabase usually grants these by default on a new project; relying on
-- that was the mistake. This makes it explicit.
--
-- Safe to run more than once.
-- ============================================================

grant usage on schema public to authenticated, anon;

-- Users read and create their own bets. UPDATE is granted because the
-- admin settlement policy needs it — RLS still restricts it to admins,
-- so an ordinary user gaining UPDATE here changes nothing.
grant select, insert, update on public.bets     to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.events   to authenticated;
grant select                 on public.admins   to authenticated;

-- Sequences, in case any table gains a serial column later.
grant usage, select on all sequences in schema public to authenticated;

-- Anything added from here on gets the same treatment automatically.
alter default privileges in schema public
  grant select, insert, update on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;


-- ============================================================
-- Row Level Security
-- ============================================================
alter table public.profiles enable row level security;
alter table public.bets     enable row level security;
alter table public.events   enable row level security;
alter table public.admins   enable row level security;

-- profiles: any signed-in user can read (needed for the leaderboard);
-- you may only create or edit your own.
drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_insert on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_read   on public.profiles for select to authenticated using (true);
create policy profiles_insert on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy profiles_update on public.profiles for update to authenticated using  (auth.uid() = id)
                                                                        with check (auth.uid() = id);

-- bets: read and create your own. NO update policy for ordinary users —
-- that is deliberate and is what stops self-settlement.
drop policy if exists bets_read        on public.bets;
drop policy if exists bets_insert      on public.bets;
drop policy if exists bets_admin_write on public.bets;
drop policy if exists bets_admin_read  on public.bets;
create policy bets_read        on public.bets for select to authenticated using (auth.uid() = user_id);
create policy bets_insert      on public.bets for insert to authenticated
  with check (auth.uid() = user_id and status = 'open' and settled_at is null
              and close_prob is null);   -- the closing line is not yours to set
create policy bets_admin_read  on public.bets for select to authenticated using (public.is_admin());
create policy bets_admin_write on public.bets for update to authenticated using (public.is_admin());

-- events: everyone reads, only admins write.
drop policy if exists events_read  on public.events;
drop policy if exists events_write on public.events;
create policy events_read  on public.events for select to authenticated using (true);
create policy events_write on public.events for all    to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- admins: readable so the client can show admin controls; never writable
-- from the client. Add rows from the SQL editor only.
drop policy if exists admins_read on public.admins;
create policy admins_read on public.admins for select to authenticated using (true);

-- ============================================================
-- Leaderboard
-- A security-definer function so it can aggregate across users without
-- exposing anyone's individual bets. Returns summary rows only.
--
-- Bankroll is DERIVED here, never stored:
--   1000 - (everything staked) + (returns on won) + (stakes back on push/void)
-- ============================================================
create or replace function public.leaderboard(p_week text, p_start numeric default 1000)
returns table (
  user_id      uuid,
  display_name text,
  bets_used    integer,
  graded       integer,
  wins         integer,
  staked       numeric,
  returned     numeric,
  at_risk      numeric,
  bankroll     numeric,
  profit       numeric,
  roi          numeric,
  hit_rate     integer,
  biggest_win  numeric,
  clv          numeric,      -- mean (close - fair) in percentage points
  clv_bets     integer       -- how many bets that average is drawn from
) language sql stable security definer set search_path = public as $$
  select
    p.id,
    p.display_name,
    coalesce(count(b.id), 0)::int,
    coalesce(count(b.id) filter (where b.status in ('won','lost')), 0)::int,
    coalesce(count(b.id) filter (where b.status = 'won'), 0)::int,
    coalesce(sum(b.stake), 0)::numeric,
    coalesce(sum(b.potential_return) filter (where b.status = 'won'), 0)
      + coalesce(sum(b.stake) filter (where b.status in ('push','void')), 0),
    coalesce(sum(b.stake) filter (where b.status = 'open'), 0)::numeric,
    p_start
      - coalesce(sum(b.stake), 0)
      + coalesce(sum(b.potential_return) filter (where b.status = 'won'), 0)
      + coalesce(sum(b.stake) filter (where b.status in ('push','void')), 0),
    coalesce(sum(b.potential_return) filter (where b.status = 'won'), 0)
      - coalesce(sum(b.stake) filter (where b.status in ('won','lost')), 0),
    case when coalesce(sum(b.stake) filter (where b.status in ('won','lost')), 0) > 0
      then round(100 * (
             coalesce(sum(b.potential_return) filter (where b.status = 'won'), 0)
             - coalesce(sum(b.stake) filter (where b.status in ('won','lost')), 0)
           ) / sum(b.stake) filter (where b.status in ('won','lost')), 1)
      else null end,
    case when count(b.id) filter (where b.status in ('won','lost')) > 0
      then round(100.0 * count(b.id) filter (where b.status = 'won')
                 / count(b.id) filter (where b.status in ('won','lost')))::int
      else 0 end,
    coalesce(max(b.potential_return - b.stake) filter (where b.status = 'won'), 0),
    round(avg(100 * (b.close_prob - b.fair_prob))
          filter (where b.close_prob is not null and b.fair_prob is not null), 2),
    coalesce(count(b.id) filter (where b.close_prob is not null and b.fair_prob is not null), 0)::int
  from public.profiles p
  left join public.bets b on b.user_id = p.id and b.week_key = p_week
  group by p.id, p.display_name
  order by 11 desc nulls last, 9 desc;
$$;
grant execute on function public.leaderboard(text, numeric) to authenticated;

-- All-time figures, same derivation across every week.
create or replace function public.lifetime(p_start numeric default 1000)
returns table (
  user_id      uuid,
  display_name text,
  bets         integer,
  wins         integer,
  losses       integer,
  pushes       integer,
  wagered      numeric,
  profit       numeric,
  roi          numeric,
  biggest_win  numeric,
  weeks_played integer,
  clv          numeric,
  clv_bets     integer,
  beat_close   integer      -- how many times you took a better number than the close
) language sql stable security definer set search_path = public as $$
  select
    p.id, p.display_name,
    coalesce(count(b.id), 0)::int,
    coalesce(count(b.id) filter (where b.status = 'won'), 0)::int,
    coalesce(count(b.id) filter (where b.status = 'lost'), 0)::int,
    coalesce(count(b.id) filter (where b.status in ('push','void')), 0)::int,
    coalesce(sum(b.stake) filter (where b.status in ('won','lost')), 0)::numeric,
    coalesce(sum(b.potential_return) filter (where b.status = 'won'), 0)
      - coalesce(sum(b.stake) filter (where b.status in ('won','lost')), 0),
    case when coalesce(sum(b.stake) filter (where b.status in ('won','lost')), 0) > 0
      then round(100 * (
             coalesce(sum(b.potential_return) filter (where b.status = 'won'), 0)
             - coalesce(sum(b.stake) filter (where b.status in ('won','lost')), 0)
           ) / sum(b.stake) filter (where b.status in ('won','lost')), 1)
      else null end,
    coalesce(max(b.potential_return - b.stake) filter (where b.status = 'won'), 0),
    coalesce(count(distinct b.week_key), 0)::int,
    round(avg(100 * (b.close_prob - b.fair_prob))
          filter (where b.close_prob is not null and b.fair_prob is not null), 2),
    coalesce(count(b.id) filter (where b.close_prob is not null and b.fair_prob is not null), 0)::int,
    coalesce(count(b.id) filter (where b.close_prob > b.fair_prob), 0)::int
  from public.profiles p
  left join public.bets b on b.user_id = p.id
  group by p.id, p.display_name;
$$;
grant execute on function public.lifetime(numeric) to authenticated;

-- How many people have signed up.
create or replace function public.user_count()
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from public.profiles;
$$;
grant execute on function public.user_count() to authenticated;


-- ============================================================
-- Closing line stamp (v1.6 will call this from the cron)
-- Admin only. Sets close_prob on every open bet for an event so CLV
-- can be computed. Idempotent: only fills rows that are still null.
-- ============================================================
create or replace function public.stamp_close(p_event text, p_selection text, p_close numeric)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_admin() then raise exception 'admin only'; end if;
  update public.bets
     set close_prob = p_close
   where event_id = p_event
     and selection_id = p_selection
     and close_prob is null;
  get diagnostics n = row_count;
  return n;
end;
$$;
grant execute on function public.stamp_close(text, text, numeric) to authenticated;

-- ============================================================
-- v1.6 — production settlement
--
-- Settlement used to be a client-side loop: update each row, one
-- request at a time, after the client had already changed its own local
-- copy. That is a dual write with local-first ordering, and it produces
-- two different truths the moment one half fails.
--
-- This makes settlement ONE atomic, idempotent server operation. The
-- client asks the database to settle and then re-reads. There is no
-- local settlement path when signed in.
-- ============================================================
create or replace function public.settle_event(
  p_event     text,
  p_selection text,
  p_push      boolean default false
) returns table (settled integer, winners integer, paid numeric)
language plpgsql security definer set search_path = public as $$
declare v_settled integer; v_winners integer; v_paid numeric;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  -- only rows still open are touched, so calling this twice is a no-op
  with graded as (
    update public.bets
       set status = case
             when p_push then 'push'
             when selection_id is not distinct from p_selection then 'won'
             else 'lost' end,
           settled_at = now()
     where event_id = p_event
       and status = 'open'
    returning status, stake, potential_return
  )
  select count(*)::int,
         count(*) filter (where status = 'won')::int,
         coalesce(sum(case when status = 'won' then potential_return
                           when status = 'push' then stake
                           else 0 end), 0)
    into v_settled, v_winners, v_paid
    from graded;

  update public.events
     set status = 'final',
         winner_selection_id = case when p_push then null else p_selection end,
         updated_at = now()
   where event_id = p_event;

  return query select v_settled, v_winners, v_paid;
end;
$$;
grant execute on function public.settle_event(text, text, boolean) to authenticated;

-- Reverse it. Also admin-only and also idempotent.
create or replace function public.unsettle_event(p_event text)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  update public.bets
     set status = 'open', settled_at = null
   where event_id = p_event and status <> 'open';
  get diagnostics n = row_count;
  update public.events
     set status = 'open', winner_selection_id = null, updated_at = now()
   where event_id = p_event;
  return n;
end;
$$;
grant execute on function public.unsettle_event(text) to authenticated;

-- How many bets are open on an event, across ALL users. The admin panel
-- used to gate its own button on the admin's personal ticket list, so it
-- disabled itself while other people's bets were still ungraded.
create or replace function public.event_open_count(p_event text)
returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from public.bets
   where event_id = p_event and status = 'open';
$$;
grant execute on function public.event_open_count(text) to authenticated;

-- user_count() counted profiles only, so an account that signed in but
-- never chose a display name was invisible — reporting 0 users while
-- Authentication clearly listed one. Report both, so any gap is obvious.
create or replace function public.admin_stats()
returns table (signups integer, profiles integer, bets integer, open_bets integer)
language sql stable security definer set search_path = public as $$
  select (select count(*)::int from auth.users),
         (select count(*)::int from public.profiles),
         (select count(*)::int from public.bets),
         (select count(*)::int from public.bets where status = 'open');
$$;
grant execute on function public.admin_stats() to authenticated;


-- ============================================================
-- v1.6.5 lifecycle rules live in supabase/migrations/
--   2026-08-04_v1.6.5_lifecycle.sql
-- Run it after this file on a fresh install. It adds the derived payout
-- function, the immutability and transition guard, and the settled_at
-- invariant. See docs/SPORTSBOOK_MODEL.md for the reasoning.
-- ============================================================
