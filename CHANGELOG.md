# VIG — Changelog

Newest first. Full technical detail lives in `README.md`.

---

## v1.5.1 — Offline retry, passwords, real golf field, cleaner home

**Added**
- **Outbox for offline bets.** A bet that cannot reach the database is queued
  instead of being lost. It retries when the connection returns, when you sign
  in, every two minutes, and on demand from a "bets waiting to sync" chip in the
  header.
- **Email + password sign-in** alongside the magic link, so the same account
  opens on any device. Create-account and sign-in tabs, forgot-password, and
  "email me a link instead" as a no-password alternative.
- **Clickable profile card.** Tapping the header avatar opens a compact card with
  bankroll, week P/L, ROI and all-time profit, plus an avatar editor: eight brand
  colours and twelve badges. Stored per user, synced to `profiles` when signed
  in. No image uploads, so no storage bucket and it works offline.
- Real golf field: **20 selections** from Cantlay +700 through a +3000/+4000/+5000
  ladder, with The Field at +250. Book margin 12.1%.

**Changed**
- Home page: the hero headline moves off flat white to a silver-to-blue gradient
  with the emphasised half in brand blue, matching the logo. Supporting copy
  trimmed to one line, and the card background warmed toward the brand palette.
- Service worker cache bumped to `v1.5.1`.

**Fixed**
- **Bets placed offline used to vanish.** `syncFromCloud()` replaced the local
  ticket list with the database's version, so anything queued locally was
  overwritten the next time the server answered. The queue is now flushed
  *before* the pull, and anything still pending is merged on top rather than
  discarded.
- **The parlay slip let you tap Place with a stake larger than your bankroll**,
  then bounced you off a toast. It now disables and explains, matching the golf
  slip. Root cause: the stake field only re-ran the payout calculation, never the
  validation.
- The profile menu never rebuilt on open, so bankroll and ROI could be stale.

**Verified**
- Full odds-maths audit: American ↔ decimal conversions, round-trip over every
  value from −2000 to +2000, implied probability, de-vigging, payout formulas
  for both signs, money rounding, and bankroll derivation across won / lost /
  push / void / mixed books. 33 assertions, all passing.
- A parlay is quoted at a rounded American price and **pays from that quoted
  price**, never from the raw decimal product — which is how a real book behaves.
  Confirmed the quoted price never pays more than the underlying maths.

**Known issues**
- Settlement writes one row at a time; fine for a dozen testers.
- The outbox retries indefinitely and never gives up. A bet rejected for a real
  reason (rather than a network failure) would retry forever.
- Non-golf tickets still settle on a weighted coin flip.

---

## v1.5.0 — Accounts

**Added**
- **Supabase accounts** with email magic-link sign-in. No passwords, no reset
  flow, nothing to breach.
- **Optional signup.** Fantasy tools, Line Winder and Trending stay open to
  everyone. An account is required only where identity is genuinely needed:
  placing a mock bet, My Bets, and the leaderboard. The sheet always says which
  action prompted it and can be dismissed.
- **Real shared leaderboard** — your friends finally see each other. Generated
  rivals remain only as a clearly labelled demo when signed out.
- Account chip in the header showing sign-in state and display name.
- Signup count in the admin panel.
- `supabase/schema.sql` — four tables, ten RLS policies, four security-definer
  functions. `SUPABASE-SETUP.md` walks through the ten-minute setup.

**Changed**
- **Bankroll is now derived, never stored.** It is computed from the bets
  themselves — `1000 − staked + returns` — both locally and in the database.
  There is no balance field anywhere for anyone to edit.
- All-time ROI and lifetime figures are queries over the bets table rather than
  stored counters, so they cannot drift and a settlement correction propagates
  automatically.
- Service worker cache bumped to `v1.5.0`; `config.js` added to the precache.

**Security**
- Users may **insert** their own bets but have **no update policy**. Settlement
  is admin-only. Without that, anyone with browser devtools could set
  `status = 'won'` and pay themselves.
- The email lives in Supabase's `auth.users` and is **never copied into our own
  tables**. `profiles` holds a display name, an optional league code and a UUID.
  Verified by test.
- The leaderboard is a security-definer function returning summary rows only, so
  aggregating across users never exposes anyone's individual bets.

**Fixed**
- **A paused free-tier project made returning users look brand new.** Supabase
  reads the session from local storage, so the app still believed the user was
  signed in — but the profile query failed, `profile` came back null, and the app
  concluded they had no account and demanded a display name they already had,
  with no way to dismiss it. Now `profileUnknown` distinguishes "no profile row"
  from "the database did not answer": the user gets a plain explanation, a retry
  button, and can keep playing offline. A failed sync also no longer wipes the
  local ticket list.
- The sign-in sheet was being forced open during boot: `renderIdentityGate()`
  ran synchronously while `Cloud.init()` was still loading the SDK, took the
  local branch, and never closed once cloud mode took over — making an optional
  signup feel mandatory.
- The account chip did not refresh after saving a profile.

**Known issues**
- Settlement writes one row at a time. Fine for a dozen testers; would want a
  single RPC at scale.
- A bet placed while offline saves locally and is not retried against the
  database. It shows a toast saying so.
- Non-golf tickets still settle on a weighted coin flip rather than real
  results.
- Free-tier Supabase projects pause after 7 days with **no database queries** —
  and everything open to signed-out visitors (Fantasy, Line Winder, Trending) is
  served from static files and touches the database not at all. So the site can
  be visited daily and still pause if nobody signs in. Handled gracefully now,
  but resolved properly by the v1.6 snapshot cron, or an uptime pinger meanwhile.

---

## v1.4.4 — Private Golf Bankroll Test

**Added**
- Golf event inside the **Trending** tab, driven entirely by `data/golf-event.json` — event name, dates, lock time, status, golfers and odds are editable without touching JavaScript.
- Straight single-selection bet slip: odds, potential profit, total return, resulting bankroll, $10/$25/$50/$100 quick stakes plus a custom amount, and an explicit confirmation step.
- Test-admin panel behind **`?admin=1`** — set Open/Locked, pick the winning golfer, settle, void as push, undo settlement, Finalize Week, Start New Week, Reset test data.
- First-visit display name and optional league code, asked once.
- **Push** bet status: stake returned, no profit, excluded from P/L and hit rate.
- **ROI** on the leaderboard.
- Lifetime statistics — bets, W/L/push, wagered, profit, weeks, biggest win, best finish — accumulated at archive time and never reset.

**Changed**
- Weekly reset moved from `America/New_York 04:00` to **`America/Los_Angeles 02:00`, Tuesday**. That is Tuesday 5am ET, so a full NFL week (Thu → Mon night) and a golf tournament (Thu–Sun) each sit inside one competition week. Verified in both PDT and PST.
- `etParts()` renamed `tzParts()`, no longer Eastern-specific.
- Automatic weekly rollover **paused** (`AUTO_ROLLOVER = false`) so a week boundary cannot wipe results mid-test. The admin panel drives the cycle instead.

**Fixed**
- Typing `0` into the stake field silently became `25`. `Number(...) || 25` treats zero as falsy, so the minimum-stake validation could never fire.

**Known issues**
- **The leaderboard is single-device.** Rival entries are generated from a seed derived from the week key — deterministic, stable within a week, entirely local. Two friends on two phones see two unrelated leaderboards. Multi-device sync requires a backend (v1.5).
- All persistence is `localStorage`: bets, bankroll, weekly archive, lifetime stats, identity, event state.
- Ticket outcomes outside the golf event still settle on a weighted coin flip rather than real results.

---

## v1.4.3 — Subpath compatibility

**Fixed**
- Add to Home Screen was broken on GitHub Pages. The manifest used absolute paths (`start_url: "/"`, `scope: "/"`, `/icons/…`), which resolve to the domain root rather than `/Vig/`. All relative now, so one build works under a subpath and at a domain root.
- `DataSource.endpoint` made relative. Pages runs no serverless functions, so it 404s there and falls back to the simulated board.

---

## v1.4.2 — Service worker

**Added**
- Offline support via a service worker: **network-first** for documents, JS and CSS so a deploy is live immediately; cache-first for icons, manifest and the player dataset; `/api/*` never cached.

**Changed**
- Consolidated to a single `manifest.webmanifest`; `theme_color` set to brand blue `#2875CB`.

---

## v1.4.1 — Installable, mobile polish

**Added**
- Web manifest, iOS meta tags and generated icons — the site installs to the home screen and launches full screen.
- Sticky bet-slip bar above the bottom nav showing live legs, odds, return and a Place button.

**Fixed**
- iOS zoomed the viewport on any focused input under 16px; four fields inherited 12px from their label wrapper.
- Draft board would have become a 19,200px single row that reset scroll on every pick. Kept as a six-column grid, and the on-clock cell now scrolls itself into view.
- Roster moved above the player pool on mobile; it was landing ~3,800px down the page.

---

## v1.4 — Mobile navigation

**Added**
- Bottom navigation on phones: Mock · My Bets · Fantasy · Lines · Friends, with the logo carrying Home.
- Profile menu becomes a bottom sheet at ≤700px.
- Slip and open-ticket count badges on the bar.

**Fixed**
- Two proposed nav targets pointed at views that do not exist and **blanked the entire page**.
- Nav z-index sat above the login modal; toasts and the boot-error banner were buried behind the bar; content clearance was 6px short of the notched safe area.

---

## v1.3 — ESPN 2026 projections

**Added**
- 262 players with projected points, season totals and rostered percentage, in editable `data/espn-projections-2026.tsv`.
- Dual ranking modes: 2026 outlook vs 2025 production.
- 2026 arrivals with no prior-season data are now draftable.

**Fixed**
- Drafting a projection-only player produced NaN throughout the results panel.
- The final pick could become unmakeable, with 60 unusable rows on screen and nothing draftable.
- Team-code mismatches: nflverse writes the Rams as `LA`, ESPN writes Washington as `WSH`.

---

## v1.2 — Rebrand, round-weighted grading, games ticker

**Added**
- Real 2026 Week 1 kickoffs in a ticker under the header.
- Closing message after every draft.

**Changed**
- Palette moved to the logo's blue and silver; `--green` renamed `--accent`.
- Draft grading weights rounds 1–5 at 83% of the total.

**Fixed**
- Draft pool search did nothing before a draft started, hid already-drafted players, and matched names only.

---

## v1.1 — Mobile reliability

**Added**
- Isolated boot steps with an on-screen error banner naming any failing subsystem.
- Leverage-based draft summary.

**Fixed**
- An invisible toast element swallowed taps in the bottom-right corner.
- `pts.at(-1)` broke on Safari below 15.4.

---

## v1.0 — Real league format

**Added**
- Ten-starter roster (QB/RB/RB/WR/WR/TE/FLEX/OP/D-ST/K + 6 bench), 16 rounds, 192-cell board.
- D/ST and kicker scoring computed from raw components.
- Player search, positional ranks instead of percentiles, draft grading A+ to F−.

---

## v0.9.1 and earlier

Weekly bankroll cycles, multi-book odds, probability-spaced Line Winder, nflverse
player comparison, ticket settlement, persistence, and the data-provider
abstraction. See `README.md` for detail.
