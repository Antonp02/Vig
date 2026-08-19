# VIG — Live odds feed

How real sportsbook prices reach VIG, and why it's built the way it is.

---

## The rule

**The Odds API key never leaves the server.** It lives in Supabase Edge Function
Secrets. It is not in `config.js`, not in `app.js`, not in the bundle, and not in
any request the browser makes. The browser talks only to our own proxy; the proxy
talks to The Odds API.

There is a test that fails if a key literal or the upstream hostname ever appears
in client code — `tests/oddsproxy.mjs`. Don't delete it.

The Supabase **anon key is different** and is public by design. It's in
`config.js` and travels in request headers. RLS is what protects that data.

---

## The quota problem

The free tier is **500 credits a month**, roughly 16 a day. One call to
`h2h` / `us` / `american` costs one credit.

The naive proxy — browser asks, function calls upstream, function answers —
costs one credit *per visitor per page load*. Three friends checking the board a
few times a day would empty the month inside a week.

So the function never calls upstream on a visitor's behalf. It serves
`public.odds_cache` and refreshes only when the row is stale **and** the day's
budget has room. **A thousand visitors and one visitor cost exactly the same.**

### Adaptive TTL

Prices barely move three days out and move constantly near kickoff.

| Situation | TTL | Upstream calls/day |
|---|---|---|
| A game within 6 hours | 15 min | up to ~24 in that window |
| Otherwise | 3 hours | 8 |

### Hard daily cap

`claim_odds_credit(cap)` increments a per-day counter atomically and returns
`null` once the cap is hit. Two concurrent requests cannot both see the last
credit as free.

When the cap is reached the function **serves stale cache and says so** in
`X-Odds-Note` rather than failing. A slightly old price beats an empty board.

Default cap is 15/day (`ODDS_DAILY_CAP`). At 15/day a 31-day month is 465, just
under 500.

---

## Deploying

```bash
supabase secrets set ODDS_API_KEY=your_key_here     # already done
supabase functions deploy odds --no-verify-jwt
```

Then run `supabase/migrations/2026-08-19_v1.7.0_odds_cache.sql` once.

`--no-verify-jwt` is deliberate. The board renders for signed-out visitors, so
the endpoint must be public. Auth is not what protects the quota — the cache is.

### Environment knobs

| Variable | Default | Meaning |
|---|---|---|
| `ODDS_API_KEY` | — | required; the secret |
| `ODDS_SPORT` | `americanfootball_nfl` | upstream sport key |
| `ODDS_REGION` | `us` | book region |
| `ODDS_TTL_NEAR_MIN` | `15` | TTL when a game is within 6h |
| `ODDS_TTL_FAR_MIN` | `180` | TTL otherwise |
| `ODDS_DAILY_CAP` | `15` | max upstream calls per UTC day |

---

## CORS

`ALLOWED` in `index.ts` lists the origins that may call the function. Currently
GitHub Pages plus localhost. **Add the new origin there when VIG moves to a
custom domain**, or the board will silently fall back to simulated data.

---

## Reading the response

| Header | Meaning |
|---|---|
| `X-Odds-Cache` | `hit` fresh, `miss` refreshed, `stale` served old |
| `X-Odds-Age-Seconds` | age of the cached row |
| `X-Odds-Quota-Remaining` | credits left this month, from upstream |
| `X-Odds-Credit-Today` | e.g. `4/15` |
| `X-Odds-Note` | why a stale response was served |

The client keeps these in `DataSource.lastMeta`.

---

## Checking the budget

```sql
select * from public.odds_budget order by day desc limit 7;
select cache_key, fetched_at, quota_left, note from public.odds_cache;
```

Neither table is reachable from the browser: RLS is on with **no policy**, so
only the service role — which exists only inside the Edge Function — can read
them.

---

## Failure behaviour

| What broke | What the visitor gets |
|---|---|
| Cache fresh | cached odds, no upstream call |
| Cache stale, budget left | fresh odds |
| Cache stale, budget spent | stale odds + a note |
| Upstream errors or times out | stale odds if any, else 502 |
| Key not set | 503, logged server-side |
| Function unreachable | client falls back to the simulated board |

The board never goes blank because the feed had a bad day.
