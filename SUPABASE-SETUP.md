# Supabase setup — about 10 minutes, once

Until you finish this, the app runs exactly as it did in v1.4.4: local only,
no accounts, nothing gated. Nothing breaks in the meantime.

---

## 1. Create the project

1. Go to **supabase.com** → sign in with GitHub → **New project**
2. Name it `vig`, choose a region near you (**East US** for Florida)
3. Set a database password and save it somewhere — you will not need it for
   this, but you cannot see it again
4. Wait ~2 minutes for it to provision

Free tier: 500 MB database, 50,000 monthly active users, unlimited API
requests. No card required.

## 2. Run the schema

Left sidebar → **SQL Editor** → **New query**. Paste the entire contents of
`supabase/schema.sql` and press **Run**.

You should see `Success. No rows returned`. That creates four tables, ten
row-level-security policies and four functions.

## 3. Copy your two keys

Left sidebar → **Settings** (gear) → **API**. Copy:

- **Project URL** — looks like `https://abcdefgh.supabase.co`
- **anon public** key — a long string starting `eyJ...`

Open `config.js` in your repo and paste them in:

```js
window.VIG_CONFIG = {
  SUPABASE_URL: 'https://abcdefgh.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...'
};
```

**The anon key is public by design.** It is safe to commit — it is visible to
anyone who views your JavaScript, and that is how Supabase works. The RLS
policies are what protect the data. **Never** put the `service_role` key here;
that one bypasses every policy.

## 4. Point auth back at your site

Left sidebar → **Authentication** → **URL Configuration**:

- **Site URL:** `https://antonp02.github.io/Vig/`
- **Redirect URLs:** add the same, plus `http://localhost:8000/` if you test
  locally

Without this, the magic link sends people to the wrong place.

## 5. Commit and push

Vercel or Pages redeploys, and accounts are live.

---

## Make yourself an admin

After you have signed in once, SQL Editor → New query:

```sql
insert into public.admins (user_id)
select id from auth.users where email = 'your@email.com';
```

Then `?admin=1` shows the settlement panel, and settling an event settles it
**for everyone**, not just in your browser.

## Where to see your users

- **Authentication → Users** — the full list, signup dates, last sign-in
- **Reports** — monthly active users over time, which tells you who came back
- **In the app** — the admin panel shows the signup count

## The one gotcha

Free projects **pause after 7 days with no database activity** and need a manual
resume from the dashboard (~30 seconds).

"Activity" means **actual queries reaching Postgres**. Not dashboard visits, not
page views, not cached responses. Which matters here more than usual:

| Action | Hits the database? |
|---|---|
| Visitor opens the site, signed out | no |
| Fantasy compare / mock draft | no — bundled JSON |
| Line Winder | no — local snapshots |
| Trending / golf board | no — reads `golf-event.json` |
| **Signed-in user opens the app** | **yes** — profile, admin, bets, leaderboard |
| **Places a bet** | **yes** |
| **Magic-link sign-in** | **yes** |

So the site can be visited every day and still pause, because everything open to
signed-out visitors is served from static files. What resets the clock is
somebody **signing in**.

If it does pause, the app handles it: a signed-in user sees a plain "can't reach
the server" notice with a retry, keeps playing locally, and nothing is lost.

Two ways round it:

- A free UptimeRobot monitor pinging your project URL every 5 minutes
- Wait for v1.6 — the odds-snapshot cron writes hourly and keeps it awake by
  itself

Pro is $25/month and removes the pause, but you do not need it yet.

## Email sending

Supabase's built-in email sender is rate-limited and can be slow — fine for a
dozen friends. If links start arriving late, Authentication → Emails lets you
plug in a real SMTP provider (Resend has a free tier).
