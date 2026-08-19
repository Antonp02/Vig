# VIG v1.7.1 — Deployment guide

**Nothing is live yet, and I have not verified anything against your project.**
I have no credentials for it and no network access to it. Everything below is a
sequence for you to run, with a check after each step that proves it landed.

You have already done a lot of this — the migration ran, the tables exist with
RLS, and the function is deployed. So Parts 1 and 2 here are shorter than last
time: mostly the quota-cap fix, then verification.

Budget about 20 minutes. You can stop after any numbered part and come back.

Four parts:

1. **Quota-cap fix** — one SQL file, browser only (5 min) — **do this first**
2. **Verify the endpoint** — the checks from your handoff (10 min)
3. **Frontend** — push v1.7.1 to GitHub (5 min)
4. **Turn Live on for everyone** — one config line

---

## Before you start

You'll need:

- The Supabase dashboard open: <https://supabase.com/dashboard>
- Your project: `jauikslookwsvktlzdbq`
- A terminal, in your VIG repo folder
- The v1.7.0 source unzipped over your repo

---

# Part 1 — The quota-cap fix (do this first)

The cap in v1.7.0 did not work. Once `used` reached 15 it kept granting credits
instead of stopping, so your 500 monthly credits could drain in a few days
without any warning. **Fix this before anything else touches the endpoint.**

### 1.1 Run the corrected function

Dashboard → **SQL Editor** → **New query**. Paste all of
`supabase/migrations/2026-08-19_v1.7.1_quota_cap_fix.sql` and click **Run**.

The file does two things: replaces the function, then runs a self-test.

**Expect:** *Success* and, in the **Messages** tab below the editor, a line
reading:

```
NOTICE:  PASS — cap holds at 15 and claim 16 returns null
```

If you see `FAIL` or an exception, **stop and send me the message.** Do not go
further — an unbounded cap is the one failure that costs real money.

### 1.2 Confirm the function is the new one

```sql
select prosrc like '%where public.odds_budget.used < p_cap%' as fixed
  from pg_proc where proname = 'claim_odds_credit';
```

**Expect `fixed = true`.** If false, the old version is still installed.

### 1.3 Confirm "Verify JWT" is still off

Dashboard → **Edge Functions** → **odds** → **Details**.

**"Verify JWT with legacy secret" must be off.** If it's on, the board breaks for
signed-out visitors. Toggle it off and save; the setting sometimes reverts if the
save didn't take, so reload the page and check again.

✅ *Part 1 done.*

---

# Part 2 — Verify the endpoint

These are the checks from your handoff, in order.

### 2.1 One call

```bash
curl -i "https://jauikslookwsvktlzdbq.supabase.co/functions/v1/odds" \
  -H "apikey: sb_publishable_FzHJkfp3m9XFTbyvs56phg_pJaZtI8S"
```

Confirm all four:

- `HTTP/2 200`
- The body lists current or upcoming NFL games
- `x-odds-cache: miss`
- `x-odds-quota-remaining:` with a number — write it down

### 2.2 Three more calls

Run the same command three more times.

### 2.3 The cache check

```sql
select * from public.odds_budget where day = current_date;
```

**`used` must be 1, not 4.**

- **1** ✅ One upstream call served four requests.
- **4** ❌ The cache isn't being read. **Stay in Mock mode** and tell me.

### 2.4 Confirm the payload is cached

```sql
select cache_key, fetched_at, quota_left,
       jsonb_array_length(payload) as games
  from public.odds_cache;
```

Expect one row, `games` greater than zero.

### 2.5 CORS from the real site

Open `https://antonp02.github.io/Vig/`, then DevTools → **Console**, and paste:

```js
fetch('https://jauikslookwsvktlzdbq.supabase.co/functions/v1/odds', {
  headers: { apikey: window.VIG_CONFIG.SUPABASE_ANON_KEY }
}).then(r => console.log('CORS OK, status', r.status))
  .catch(e => console.log('CORS BLOCKED:', e.message));
```

**Expect `CORS OK, status 200`.** "CORS BLOCKED" means the origin isn't
allowlisted — check `ALLOWED` in `supabase/functions/odds/index.ts`.

### 2.6 Confirm no key leaks

Still in DevTools, **Network** tab, reload the page, then filter for
`the-odds-api`.

**Expect zero results.** The browser should only ever talk to your own
`functions/v1/odds`. If you see a request to `api.the-odds-api.com`, stop and
tell me.

✅ *Part 2 done — and only now is Live safe.*

---

# Part 3 — Frontend

### 3.1 Copy the files in

Unzip **VIG v1.7.1 Source.zip** and copy its contents over your repo folder,
replacing existing files.

`config.js` in the zip is identical to the one in your repo, so it's safe either
way.

### 3.2 Push

```bash
git add -A
git commit -m "v1.7.1 — odds proxy, FanDuel snapshot, reset to Tue 04:00 ET"
git push
```

GitHub Pages takes 1–2 minutes to rebuild.

### 3.3 Hard-refresh both devices

- **Mac Chrome:** Cmd + Shift + R
- **iPhone Safari:** close the tab entirely, then reopen

### 3.4 Confirm it's actually the new build

Go to `https://antonp02.github.io/Vig/?admin=1`.

**The Build line must read `v1.7.1`.**

Still says v1.6.x? The old service worker is holding on. Close *every* VIG tab
on that device and reopen. This is the single most common reason a deploy looks
like it "didn't work".

### 3.5 Eyeball the four visible changes

| Where | What you should see |
|---|---|
| Leaderboard | "Resets Tuesday 4:00 AM ET" |
| Home → Popular mock picks | Four NFL moneylines, Raiders/Texans first. No tennis, no fantasy prop |
| Home → Other sports | Scheffler +300, tagged *FanDuel snapshot* |
| Trending → Golf | Heading **BMW Championship — Winner**, badge **FanDuel snapshot**, note *Updated Aug. 19, 2026 at 11:42 p.m. ET* |

Nothing anywhere should call the golf prices live.

✅ *Part 3 done.*

---

# Part 4 — Turn Live on for everyone

**Only after Part 2 passed.**

In v1.7.0 the Live switch only changed your own browser. Now it's a shipped
setting. In `config.js`:

```js
window.VIG_CONFIG = {
  DATA_SOURCE: 'live',    // <- this line
```

It already reads `'live'` in the v1.7.1 zip, so pushing Part 3 turns it on for
every visitor on their next load. **If Part 2 did not pass, change it to
`'mock'` before pushing.**

Existing users are handled: anyone carrying the old `vig.v2.mode = 'mock'` from
before this release has it cleared once, automatically, so they follow the deploy
rather than staying stuck.

You keep a personal override: `?admin=1` → Data source, or `?data=mock` in the
URL. That affects only your device.

### Check it

- The NFL board fills with real book prices
- DevTools → Network → the `odds` request shows **200**
- No request to `api.the-odds-api.com` anywhere
- Reload twice, re-check `odds_budget` — `used` should not move
- On your phone, without touching admin, the board should also show live prices

# Part 5 — Check the quota tomorrow

```sql
select * from public.odds_budget order by day desc limit 7;
```

Expect around 8 on a quiet day, up to 15 on a game day. At 15 the board serves
slightly stale prices rather than breaking — that's intended.

---

## Replacing the FanDuel snapshot later

When a supported golf feed exists, you don't change any code. In
`data/golf-outrights.json`, edit the `provenance` block:

```json
"provenance": {
  "kind": "feed",
  "label": "Live feed",
  "displayUpdated": "Updated just now",
  "isLive": true
}
```

Everything downstream reads only `label`, `displayUpdated` and `isLive`. There's
a test covering exactly this swap.

---

## If something goes wrong

**Undo the frontend:**

```bash
git revert HEAD
git push
```

**Undo the function:**

```bash
supabase functions delete odds
```

The app catches the failure and falls back to the simulated board. It won't go
blank.

**The tables can stay.** They do nothing if nothing calls them.

---

## Still yours to do after this

- Cross-device sync check: `?admin=1` on both devices, expect **0 queued,
  0 not yet uploaded**
- Place a preseason bet on each device, confirm both agree
- Settle one game Sunday from the admin panel
- Then add Stewart as the second account
