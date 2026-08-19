# VIG v1.7.0 — Deployment guide

**Nothing in this release is live yet.** Everything is built and tested; this
document is the sequence that puts it live. It assumes no prior Supabase CLI
experience and spells out every command.

Budget about 20 minutes. You can stop after any numbered part and come back.

Three parts:

1. **Database** — two new tables (5 min, browser only)
2. **Edge Function** — the odds proxy (10 min, terminal)
3. **Frontend** — push to GitHub (5 min)

---

## Before you start

You'll need:

- The Supabase dashboard open: <https://supabase.com/dashboard>
- Your project: `jauikslookwsvktlzdbq`
- A terminal, in your VIG repo folder
- The v1.7.0 source unzipped over your repo

---

# Part 1 — Database

### 1.1 Open the SQL Editor

Dashboard → your project → **SQL Editor** in the left sidebar → **New query**.

### 1.2 Paste and run

Open `supabase/migrations/2026-08-19_v1.7.0_odds_cache.sql` in a text editor,
copy **all** of it, paste into the SQL editor, click **Run**.

Expect: *Success. No rows returned.* That's correct — it creates things rather
than returning them.

### 1.3 Check it worked

New query, paste this, Run:

```sql
select table_name from information_schema.tables
 where table_schema = 'public'
   and table_name in ('odds_cache', 'odds_budget');
```

**Expect exactly 2 rows.** If you get 0, the migration didn't run — scroll up in
the editor for a red error message.

### 1.4 Check the security

```sql
select relname, relrowsecurity
  from pg_class
 where relname in ('odds_cache', 'odds_budget');
```

**Both rows must show `relrowsecurity = true`.**

If either is false, **stop**. Those tables would be readable by anyone holding
your public key. Re-run the migration.

✅ *Part 1 done.*

---

# Part 2 — Edge Function

### 2.1 Install the Supabase CLI

Mac:

```bash
brew install supabase/tap/supabase
```

No Homebrew? Use npm:

```bash
npm install -g supabase
```

Check:

```bash
supabase --version
```

Any version number means you're fine.

### 2.2 Log in

```bash
supabase login
```

A browser window opens. Approve it. Back in the terminal you'll see
*Finished supabase login*.

### 2.3 Link the project

From inside your VIG repo folder:

```bash
supabase link --project-ref jauikslookwsvktlzdbq
```

It asks for your **database password** — the one set when the project was
created, *not* your Supabase account password. If you don't have it: Dashboard →
Settings → Database → **Reset database password**.

### 2.4 Confirm the API key is there

```bash
supabase secrets list
```

**`ODDS_API_KEY` should appear in the list.** You already set it, so it should
be. If not:

```bash
supabase secrets set ODDS_API_KEY=your_key_here
```

### 2.5 Deploy

```bash
supabase functions deploy odds --no-verify-jwt
```

Takes 20–60 seconds. Ends with *Deployed Function odds*.

> `--no-verify-jwt` is deliberate. It makes the function public, which it has to
> be, because the board shows to signed-out visitors. What protects your API
> quota is the cache, not a login.

### 2.6 Test it

```bash
curl -i "https://jauikslookwsvktlzdbq.supabase.co/functions/v1/odds" \
  -H "apikey: sb_publishable_FzHJkfp3m9XFTbyvs56phg_pJaZtI8S"
```

**Expect `HTTP/2 200`** and a wall of JSON with team names in it.

Near the top look for:

```
x-odds-cache: miss
x-odds-quota-remaining: 497
x-odds-credit-today: 1/15
```

Write down that `quota-remaining` number.

- **500 instead?** The key isn't set — back to 2.4.
- **404 instead?** The function didn't deploy — repeat 2.5.

### 2.7 The important test — is the cache working?

This decides whether your 500 monthly credits last a month or a week.

Run the same curl **three more times**, then in the SQL Editor:

```sql
select * from public.odds_budget where day = current_date;
```

**`used` must be 1.**

- **`used` = 1** ✅ Working. One upstream call served four requests.
- **`used` = 4** ❌ The cache isn't being read. **Do not switch to Live mode.**
  Check that Part 1 actually succeeded.

### 2.8 Confirm the golf endpoint is honest

```bash
curl -s "https://jauikslookwsvktlzdbq.supabase.co/functions/v1/odds?sport=golf" \
  -H "apikey: sb_publishable_FzHJkfp3m9XFTbyvs56phg_pJaZtI8S"
```

**Expect `"status":"unavailable"`.** That's the correct answer, not a failure —
the provider covers the four majors only and the BMW Championship isn't one of
them. The app handles it by showing the FanDuel snapshot, clearly labelled.

✅ *Part 2 done.*

---

# Part 3 — Frontend

### 3.1 Copy the files in

Unzip **VIG v1.7.0 Source.zip** and copy its contents over your repo folder,
replacing existing files.

`config.js` in the zip is identical to the one in your repo, so it's safe either
way.

### 3.2 Push

```bash
git add -A
git commit -m "v1.7.0 — odds proxy, FanDuel snapshot, reset to Tue 04:00 ET"
git push
```

GitHub Pages takes 1–2 minutes to rebuild.

### 3.3 Hard-refresh both devices

- **Mac Chrome:** Cmd + Shift + R
- **iPhone Safari:** close the tab entirely, then reopen

### 3.4 Confirm it's actually the new build

Go to `https://antonp02.github.io/Vig/?admin=1`.

**The Build line must read `v1.7.0`.**

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

# Part 4 — Switch on live NFL odds

**Only after 2.7 showed `used = 1`.**

`?admin=1` → **Data source** → **Live**.

Check:

- The NFL board repopulates with real book prices
- DevTools → Network → reload → the `odds` request shows **200**
- **No request to `api.the-odds-api.com`** appears in that list. If one does, the
  key is leaking — switch back to Mock and tell me

Reload twice more, then re-check `odds_budget`. `used` shouldn't have moved.

---

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
