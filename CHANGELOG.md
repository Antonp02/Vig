# VIG — Changelog

Newest first. Full technical detail lives in `README.md`.

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
