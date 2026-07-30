# Vig Mock Sportsbook v1.0

Fantasy Lab now mirrors the real league. Ten starters, six bench, sixteen
rounds, real players, real defences, real kickers — and comparison ranks
instead of percentiles.

Odds remain simulated. Player statistics are real (nflverse, 2025 regular
season).

## Roster format

```
QB · RB · RB · WR · WR · TE · FLEX · OP · D/ST · K   + 6 bench   = 16 rounds
```

FLEX takes RB/WR/TE. **OP takes any offensive player including QB**, which makes
this a superflex league and changes draft value materially — replacement QB is
QB20, not QB12.

Slot assignment fills dedicated → FLEX → OP → bench. That greedy order is safe
here *because* the eligibility sets nest (FLEX ⊂ OP, and OP adds QB), so filling
the narrowest eligible slot can never strand a later pick. **The guarantee dies
if a non-nested slot is ever added** — e.g. a WR/TE-only flex alongside the
RB/WR/TE one — at which point it needs real bipartite matching. There is a
comment saying so in `assignSlot()`.

## Ranks, not percentiles

"99th percentile" was a statistic about a statistic. The card now reads
**2nd of 127**. Bar length still encodes relative standing, since a bar needs a
0–100 scale, but every number beside it is an exact positional rank. Ordinals
handle the teens correctly (11th, 12th, 13th, not 11st).

## Position-aware comparison

Target share is meaningless for a quarterback, a kicker or a defence, so the
metric list is derived from position rather than fixed at seven rows:

| Position | Metrics |
|---|---|
| RB, WR, TE | points/gm, floor, ceiling, consistency, boom, bust, target share |
| QB, D/ST, K | the same six, minus target share |

The PPR/Half/Standard toggle hides itself for D/ST and K, where reception
scoring is meaningless.

## Player search

Typing replaces the 500-option `<select>`. Matching runs against a normalised
`sn` key built in the pipeline — lowercased, punctuation stripped — so `jamarr`
finds Ja'Marr Chase and `amonra` finds Amon-Ra St. Brown. Results show
position, team, points per game and rank inline.

## Three-source pipeline

```
node scripts/build-fantasy-data.mjs 2025
```

| Source | Supplies |
|---|---|
| `stats_player_week_2025.csv` | offence (pre-scored) and kickers (raw) |
| `stats_team_week_2025.csv` | defensive components |
| `schedules/games.csv` | points allowed, via the opponent's score |

19,421 player-week rows + 570 team-week rows + 7,548 games → **142 KB**:
503 offensive players, 40 kickers, 32 defences.

nflverse pre-scores offence but leaves **kickers at zero** and has no team-defence
rows at all, so both are computed here from components using ESPN default
scoring. Every weight is a config object at the top of the script.

**Two of the seven D/ST categories come from the opponent's row**, not the
team's own: a team-stats row records kicks *that team* had blocked, and points
allowed is the opponent's score. Getting the direction backwards produces
plausible-looking but wrong numbers.

Sanity check on the output: top defences by total were HOU 134, SEA 128,
DEN 126; top kickers Myers 202, Fairbairn 194, Aubrey 187. Cameron Dicker and
Cam Little — the two names cut off in the league screenshots — both appear.

## Draft room

- **192-cell board** (12 × 16) with the on-clock pick outlined.
- **Roster panel** showing all ten named slots filling in real time, plus bench.
- **Pool ordered by value over replacement** for this exact format, not a static
  ranking. Each row shows which slot the player would fill.
- **Scarcity strip** — startable players left at each position versus how many
  teams still need one; turns gold when demand exceeds supply.
- **Position filters** on the pool, including D/ST and K.
- CPU managers prefer filling a starting slot over stockpiling bench, with a
  small reach factor so no two mocks are identical.
- Picks that cannot be rostered show **"No slot"** on a disabled button rather
  than no-opping with a toast.


## Draft grading (A+ to F-)

Every starter is scored on **positional rank** against how many players at that
position are startable league-wide (QB20, RB34, WR38, TE16, D/ST12, K12 for a
12-team league with the OP slot). Those scores are then combined into one letter.

The combining weight is the position's **PPR value spread** — top points per game
minus replacement points per game — not the player's own points. Weighting by raw
points was the first attempt and it overrated kickers: a kicker's 12 ppg is a real
share of a 188-point lineup, but K1 through K12 differ by under 4 ppg, so the
choice barely matters. Measured spreads:

```
RB 14.9   WR 12.1   TE 8.3   QB 6.9   K 3.8   D/ST 1.9
```

Nailing your RB1 therefore moves the grade about eight times more than nailing
your D/ST. Verified: downgrading RB1 from RB2 to RB31 costs 0.136; doing the same
to your kicker costs 0.036.

Thresholds are anchored to **3,000 simulated drafts** across skill levels, so the
letters discriminate rather than clustering:

| Draft quality | Score | Grade |
|---|---|---|
| Optimal greedy | 0.787 | A+ |
| Sharp | 0.743 | A- |
| Decent | 0.638 | C+ |
| Casual | 0.484 | F+ |
| Near-random | 0.333 | F- |

The results footnote states the demand figures and the actual weights, so no
number in the grade is hidden.

## Draft results view

Finishing a draft opens a results panel: the overall grade as a badge, starter
PPR per week, and every roster spot in league order with its positional rank,
PPR average and per-slot letter. Bench listed separately. Saved drafts in the
history panel are tappable to reopen any past graded roster.

## Roster limits — needs your numbers

`POSITION_LIMITS` in `app.js` is the config for ESPN's per-position maximums. It
currently reads `null` for every position, meaning unlimited, which preserves
current behaviour. Fill in the real caps and enforcement happens everywhere
automatically, because `assignSlot()` is the single gate every pick passes
through — the draft pool, the CPU managers, the roster panel and the "No slot"
button state all derive from it.

I could not read the values from the photo of the settings screen. They need to
be typed in.

## Visual pass on the draft room

- Progress bar under the round/pick label.
- Board cells colour-coded by position, with the on-clock pick outlined in gold.
- Player rows show which slot the pick would fill, plus value over replacement.
- Grade colours run green (A) through blue (B), gold (C), orange (D), red (F).

## Fixed in v1.0

- Clicking a player when every eligible slot and the bench were full did nothing
  but toast. The button is now disabled and labelled.
- Draft grade is computed from positional rank and PPR value spread rather than
  cycling through a fixed list.
- The results footnote claimed to disclose the position weights but the weights
  were never attached to the saved result object, so it rendered empty.

## Test coverage

124 assertions across five suites: v1.0 features, the Tuesday week boundary,
interaction stress, and a whole-document audit that clicks every button in
every view and reports zero errors. Slot assignment is unit-tested against the
tricky cases — second QB to OP, third RB to FLEX, fourth to OP, full bench
returning null, and a position cap blocking assignment. Grading is tested for
monotonicity, for correct letters at the calibrated anchors, and for weighting
RB above K. A full 16-round draft is played to completion and the saved
roster verified to contain exactly ten starters with every slot filled once,
including a D/ST and a K.

The deployed layout is also verified over HTTP as separate files.

## Still simulated

All odds. Ticket outcomes (drawn against de-vigged implied probability). Rival
players on the leaderboard. Authentication.

## Next

Live odds need the collection architecture, not a bigger API tier: a Vercel Cron
plus a Supabase table, because `recordSnapshot()` currently fires on page load
and writes to `localStorage` — per-browser, and empty until someone visits.
See V1.0-NOTES.md.

Player statistics from nflverse (CC-BY 4.0) — the footer credit is a license
condition, not a courtesy.
