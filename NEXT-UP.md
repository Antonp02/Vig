# VIG — work plan

## Road to v1.7 (the official URL)

| Version | Ships | Notes |
|---|---|---|
| **v1.4** | Mobile: bottom nav, profile bottom sheet, layout fixes | then **deploy to Vercel** |
| **v1.5** | **Snapshot architecture** — Vercel Cron + Supabase table | **subscribe to the $30 tier here** |
| **v1.6** | Line Winder UI — crosshair, live timeframes, entry markers | builds on a filling archive |
| **v1.7** | Golf + NFL live odds wired through; Trending stops being fabricated | official URL |

### The scheduling trap

Subscribing at v1.7 buys nothing on launch day. Line Winder charts *history*, and
history only exists if something has been recording it:

```
subscribe at v1.5 (with the cron)   ~2,160 hourly snapshots by v1.7
subscribe at v1.7 (at launch)              0
```

**The paid tier and the cron must ship together.** A higher tier while
`recordSnapshot()` still writes to `localStorage` on page load means paying for
data that lands in one browser and vanishes. The tier buys granularity; the cron
and the table are what make granularity worth having.

### Budget at $30/month (20,000 credits)

```
NFL h2h, hourly                          720/mo     4%
NFL h2h + golf outrights, hourly       1,440/mo     7%
NFL 3 markets + golf, hourly           2,880/mo    14%
NFL 3 markets + golf, every 15 min    11,520/mo    58%
```

Enormous headroom — even fifteen-minute polling across four markets plus golf
uses under 60%. Money was never the constraint; 500 free credits was.

One wording note: hourly polling is not "real time". It is 168 points a week,
plenty for a weekly chart, but it smooths the *shape* of sudden moves. At this
tier fifteen-minute polling is affordable and worth switching to once the archive
exists.

### Work v1.7 needs beyond paying

- `api/odds.js` takes a sport parameter — currently hardcoded to
  `americanfootball_nfl`.
- `normalizeOddsApi()` handles only the `h2h` shape. Golf is the `outrights`
  market: different payload structure, ~150 entries per event.
- Trending reads the hardcoded `TRENDING` constant including its invented `fair`
  prices. Live golf odds replace the golf half and remove the honesty problem —
  those green "value" chips currently compare one fabricated number to another.
- Tennis and soccer stay simulated unless their sport keys are added too.

---

# v1.1 — next update

Short list, built on v1.0. One primary feature.

---

## 1. Draft summary — actionable coaching note (primary)

A brief note at the end of the results panel telling the user what to do
differently. Requested example: *"try and add more RBs to boost draft rating."*

### The obvious version is bad

"Add more RBs" is generic and will be wrong about half the time. Someone who
drafted RB3 and RB6 does not need more running backs — they need a tight end.
Advice that doesn't read the actual roster is noise, and once a user catches it
being wrong they stop trusting the grade too.

### The good version: leverage, not position counts

Everything needed is already computed in `gradeDraft()`. Each starter has a
`score` (positional rank vs. startable pool) and each position has a `weight`
(PPR value spread). So:

```
leverage(slot) = (1 − score) × weight[pos]
```

That is literally how many grade points are recoverable at that slot. Rank the
ten starters by it and the top one is the highest-value fix available. This
correctly refuses to nag about D/ST — weight 1.9 means even a terrible D/ST slot
has almost nothing to recover, so it will never surface as the top note, which
is right.

### Counterfactual, so the advice is concrete

`gradeDraft()` is a pure function of a roster array, so the improvement can be
*measured* rather than asserted. Clone the roster, substitute the player
currently at a target rank for that position (say the 12th-best), re-grade, and
report the delta:

> **Your FLEX is the weak spot.** Chase Brown is RB19 of 34 — the least valuable
> high-leverage slot on your roster. A top-12 RB there lifts this draft from
> **C+ to B**. Your WR room is the strength: Nacua and JSN are both top-8.

Three sentences: weakness, measured fix, strength. Ending on the strength keeps
it from reading as pure criticism.

Implementation notes:
- Substitute the actual player at the target rank, skipping anyone already on
  the roster.
- If the top-leverage slot is already strong (score > ~0.85), switch the message
  to depth or to "no obvious upgrade — this is a good roster."
- Cap at one weakness and one strength. Brief was the request.

### Second note: depth risk

Separate from leverage. Count roster players per position against starting
slots. Flag a high-weight position where the count equals the minimum — two RBs
and no RB on the bench is a bye-week and injury problem the grade does not
capture, because the grade only reads starters.

Only raise it for RB/WR (weights 14.9 and 12.1). Nobody needs a backup kicker.

### Keep it honest

State the rank being compared against, same as everywhere else in this app. The
note should read as arithmetic the user could check, not as an oracle. No
composite "roster health score."

---


## 2. v1.2 — rebrand (queued, do not start yet)

New logo received. Sampled palette:

```
brand blue    #2875CB   (basketball / "i" stroke / FANTASY TOOLS all ~#1D71C9-#2875CB)
brand silver  #C9C8C8   (VIG wordmark mid-tone)
```

Current site tokens for comparison — note the naming debt:

```
--green      #5f8fff   <- a periwinkle blue, not green. Misnamed since v0.5.
--green2     #bfd0ff
--green-dark #1b2d53
```

The logo blue (#2875CB) is deeper and more saturated than the site's #5f8fff.
Swapping tokens is a one-line change per variable, but **rename them at the same
time** — `--green` holding a blue value is the kind of thing that will cause a
wrong-colour bug in six months. Suggested: `--accent`, `--accent-soft`,
`--accent-dark`.

### Four things to decide before building

**1. The basketball.** It is the most prominent icon in the mark and the product
contains no basketball at all — NFL moneylines, NFL fantasy (QB/RB/WR/TE/D-ST/K),
plus golf, tennis and soccer in Trending. A basketball as the dot of the "i"
points at the one major sport not covered.

Options: swap for a football (awkward as an "i" dot — it is an oval, not a
circle), a plain dot, or **a small upward chart tick**, which would tie the mark
to Line Winder and to the Bloomberg-meets-Robinhood identity rather than to a
sport. That last option also solves the favicon problem below.

**2. Chrome versus flat, against the stated design rules.** The constitution
says: avoid flashy sportsbook aesthetics, avoid casino-style visuals, primary
inspiration Apple / Robinhood / Stripe / Bloomberg. A brushed-metal bevel with a
gradient sits closer to ESPN and DraftKings than to Stripe. It is a sharp logo —
this is not "change it", it is "choose it deliberately rather than drift into it,"
because everything else in the UI is flat.

**3. Favicon and small sizes.** The metallic gradient and the thin blue rules
will turn to mud at 32px and below. A flat single-colour variant is needed —
probably just the V, or VIG with no texture.

**4. Competing taglines.** The site header currently reads "Fantasy takes. Fake
money. Real receipts." The logo says MOCK SPORTS BOOK / FANTASY TOOLS. Pick one
hierarchy; running both is noise. Also worth knowing: the industry writes
"sportsbook" as one word, so "SPORTS BOOK" reads slightly off to anyone in the
space.

### The strategic part

Putting FANTASY TOOLS on the logo promotes fantasy from a tab to a co-equal
pillar, and the evidence supports it. The mock draft is the thing being used
repeatedly and generating unprompted feedback. Line Winder — nominally the
flagship — has not come up once since it was built, and its snapshot archive is
still empty by construction.

That is worth sitting with rather than just styling. If fantasy tools are what
people actually return for, the eight-tab layout, the home dashboard hierarchy,
and the roadmap order all deserve rethinking, not just the logo. The brand may be
telling you what the product is.

Scope for v1.2 when it starts: token rename and palette swap, logo assets at
three sizes, favicon, header lockup, tagline decision. Not a layout change —
that is a separate initiative.

## 3. Still blocked on typed input

`POSITION_LIMITS` in `app.js` — the MAXIMUMS column from ESPN's roster limits
page:

```js
const POSITION_LIMITS = { QB: ?, RB: ?, WR: ?, TE: ?, DST: ?, K: ? };
```

Four different image-enhancement approaches failed on the phone photos of the
laptop screen. Needs a real screenshot (Cmd+Shift+4) or the numbers typed.

Also unconfirmed:
- Any offensive scoring differing from standard PPR (TE premium, first-down
  points, yardage bonuses).
- Missed FG penalty — currently `missedFg: 0`; ESPN's true default may be −1.

Note that position limits interact with the summary feature: if RB is capped at
5, "add more RBs" advice has to respect the cap.

---

## 4. Carried from earlier notes

Not in v1.1 unless it gets quick:

- **Snapshot collection architecture.** `recordSnapshot()` still fires on page
  load and writes to `localStorage` — per-browser and empty until someone
  visits. Needs a Vercel Cron plus a Supabase table before Line Winder history
  means anything. This is the real blocker for live odds, not the API tier.
- **Mobile visual pass.** Still never verified on a real device. The scarcity
  strip, the 192-cell board, and the results rows are the newest cramped
  layouts.
- Sleeper league connection, real fantasy props on the bet slip.

---

## Feedback loop

Drafts are being run and feedback collected — that is the signal worth building
against. Worth capturing what people actually say, because "the grade felt too
harsh" and "the grade felt meaningless" point at opposite fixes, and the
calibration is a single array (`GRADE_SCALE`) that can be retuned in one edit.
