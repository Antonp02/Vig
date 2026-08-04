-- ============================================================
-- VIG v1.6.5 — bet lifecycle, enforced at the database
--
-- Safe to run more than once. Changes no existing row's money; it only
-- repairs projections that an older client destroyed, and then makes it
-- impossible to destroy them again.
--
-- BACKGROUND
-- Until v1.6.5 the client used one field, potential_return, for two
-- different quantities: what a ticket would pay, and what it did pay.
-- Grading a loser overwrote the first with the second (zero). That was
-- accounting-neutral -- no bankroll anywhere reads a loser's return --
-- but it destroyed the placement fact and produced rows that violate
-- bets_potential_return_check on re-upload.
--
-- The payout is now DERIVED from status. It is never stored, so it
-- cannot drift.
-- ============================================================

-- ---------- 1. repair legacy rows ----------
-- A settled loser whose projection was zeroed. Rebuild it from the price,
-- which never changed. American odds -> decimal -> stake x decimal.
update public.bets
   set potential_return = round(
         stake * (case when odds > 0 then 1 + odds / 100.0
                       else 1 + 100.0 / abs(odds) end), 2)
 where potential_return <= 0
   and stake > 0
   and abs(odds) >= 100;

-- ---------- 2. the payout function ----------
-- The single definition of what a ticket has returned. Mirrors payout()
-- in app.js exactly. Returns null for an undecided ticket.
create or replace function public.bet_payout(
  p_status text, p_stake numeric, p_potential numeric
) returns numeric language sql immutable as $$
  select case p_status
           when 'won'  then p_potential
           when 'lost' then 0::numeric
           when 'push' then p_stake
           when 'void' then p_stake
           else null
         end;
$$;

-- ---------- 3. immutability + legal transitions ----------
-- The status check constraint validates a VALUE. It does not validate a
-- TRANSITION, so nothing stopped a ticket being settled twice, graded
-- straight from won to lost, or repriced after the fact.
create or replace function public.bets_guard()
returns trigger language plpgsql as $$
begin
  -- terms are frozen at placement, for everyone including an admin
  if new.stake            is distinct from old.stake            then
    raise exception 'stake is immutable after placement' using errcode = '23514';
  end if;
  if new.odds             is distinct from old.odds             then
    raise exception 'odds are immutable after placement' using errcode = '23514';
  end if;
  if new.potential_return is distinct from old.potential_return then
    raise exception 'potential_return is immutable after placement (payout is derived from status)'
      using errcode = '23514';
  end if;
  if new.user_id is distinct from old.user_id or new.week_key is distinct from old.week_key then
    raise exception 'a ticket cannot change owner or week' using errcode = '23514';
  end if;

  -- open -> graded, or graded -> open (an admin reversing a settlement).
  -- Never graded -> a different grade: reverse it first, so the audit
  -- trail shows two deliberate acts rather than one silent correction.
  if new.status is distinct from old.status then
    if not (old.status = 'open' or new.status = 'open') then
      raise exception 'illegal transition % -> %: reopen the ticket first', old.status, new.status
        using errcode = '23514';
    end if;
  end if;

  -- settled_at must agree with status
  if new.status = 'open' then
    new.settled_at := null;
  elsif new.settled_at is null then
    new.settled_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists bets_guard_update on public.bets;
create trigger bets_guard_update
  before update on public.bets
  for each row execute function public.bets_guard();

-- ---------- 4. an open ticket has not been settled ----------
-- Repair before constraining, or the ALTER fails validating old rows.
update public.bets set settled_at = null  where status =  'open' and settled_at is not null;
update public.bets set settled_at = now() where status <> 'open' and settled_at is null;

alter table public.bets drop constraint if exists bets_settled_at_check;
alter table public.bets add  constraint bets_settled_at_check
  check ((status = 'open') = (settled_at is null));
