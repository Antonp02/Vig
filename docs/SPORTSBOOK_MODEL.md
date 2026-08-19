# VIG — Sportsbook Model

**The accounting rules VIG runs on.** If a change contradicts this document, either the change is wrong or this document needs revising first. Don't let them disagree silently.

Written at v1.6.5, after a chat expired and took the reasoning with it.

---

## 1. The two numbers

The mistake that produced v1.6.5 was using one field for two quantities. They are not the same number and must never share storage.

| | **Potential return** | **Payout** |
|---|---|---|
| Means | what the ticket *would* pay | what the ticket *did* pay |
| Set | once, at placement | never — it is derived |
| Formula | `stake × decimalOdds(odds)` | a function of `status` |
| Changes | **never**, in any status | whenever status changes |
| Stored | `returnAmount` / `bets.potential_return` | nowhere |

```
payout(ticket):
  open        →  null      (undecided; the stake is still at risk)
  won         →  potential
  lost        →  0
  push, void  →  stake     (refund, no profit)
```

A losing ticket **keeps its potential return on record** and still pays nothing. That is the whole fix. It is how a paper ticket works: the slip in your pocket says what it would have paid, and it pays nothing.

**Why derived and not stored:** a stored payout is a second source of truth for a number that can already be computed exactly. Second sources drift. We had that bug with the bankroll cache and did not want it twice.

Client: `potentialReturn()`, `payout()`, `realizedReturn()` in `app.js`.
Server: `public.bet_payout(status, stake, potential)`.
Keep them identical. If you change one, change the other in the same commit.

---

## 2. Bet lifecycle

```
              placed                 graded
   (none) ──────────────▶ open ──────────────▶ won / lost / push / void
                            ▲                          │
                            └──────────────────────────┘
                                    reopened
                                (admin reversal only)
```

**Placement.** Terms are frozen: `stake`, `odds`, `potential_return`. Nobody may change them afterwards — not the user, not an admin, not a migration. The database enforces this in `bets_guard`.

**Grading.** Settlement writes **status and nothing else**. Every monetary consequence follows from status via `payout()`. This is why the three branches of a settlement can no longer disagree with the money — there is only one branch that touches money, and it doesn't exist.

**Reversal.** A graded ticket may return to `open`. It may **not** go straight to a different grade. Reopen first. Two deliberate acts leave a legible trail; one silent correction does not.

**Ungraded at week end.** Voided, stake refunded. An ungraded ticket is not a loss.

---

## 3. Bankroll lifecycle

**Bankroll is derived from the ledger. It is never accumulated into.**

```
bankroll = WEEKLY_BANKROLL
         − Σ stake        (every ticket, the moment it is placed)
         + Σ payout       (open contributes nothing)
```

The stake leaves immediately at placement and comes back only through `payout()`. A loser's stake never comes back — that is not an edge case, it is the ordinary outcome and needs no special handling anywhere.

`week.bankroll` exists only as a persistence convenience. `weekStats()` recomputes and corrects it on every read. **Never write to it directly.** Any code doing `week.bankroll += x` is a bug; it was the cause of the drift fixed in v1.5.x and the reason settlement and un-settlement could disagree.

Three implementations must agree: `derivedBankroll()` in the client, the `leaderboard()` RPC, and the `lifetime()` RPC. They are tested against each other.

---

## 3b. Settlement from results

A ticket grades when **every leg has a final result**. All correct is a win; one
wrong leg is a loss **immediately**, without waiting for the other games — the
bettor is already beaten, and making them wait is theatre.

A tie is a **push**: stake back, no profit.

### The three-day rule

A ticket that cannot be graded **3 days after its last kickoff is voided and the
stake refunded**.

Not lost — **voided**. The bettor did nothing wrong; the book failed to grade it,
and a book that keeps a stake because its own feed missed a game is stealing.
This is also what stops the ledger accumulating tickets that can never resolve.

`SETTLE_GRACE_MS` in `app.js`, tested at the boundary.

### Who may settle

`gradeOpenTickets()` **proposes**; it never writes. Who applies the proposal:

| Situation | What happens |
|---|---|
| Offline / signed out | applied locally — the local ledger is the only one there is |
| Signed in **as admin** | applied and pushed for everyone |
| Signed in, **not** admin | **not applied**; the server's decision arrives by poll |

That third row is the important one. If a signed-in user could settle their own
bets from the client, they could declare themselves a winner. RLS forbids it at
the database; this mirrors that rule in the UI rather than fighting it.

Results come from the odds provider's `/scores` feed via the same Edge Function
proxy, cached server-side like prices.

## 4. Weekly reset

Tuesday 04:00 America/New_York.

1. Any ticket still `open` is voided and its stake refunded.
2. Lifetime totals accumulate: bets, wins, losses, wagered, profit, biggest win, best finish.
3. The week is archived into `weekResults` (last 12 kept).
4. A fresh week starts at `WEEKLY_BANKROLL`.

**The weekly bankroll is a format, not a record.** It resets. Lifetime statistics never do.

---

## 5. Sync model

**The database is the source of truth.** The client is a cache that may be discarded at any time without loss.

- Bets are **insert-only** for users. RLS forbids a user updating their own ticket — otherwise anyone could set `status = 'won'`.
- Settlement is **admin-only** and happens server-side, in `settle_event()`, for every user at once. Settling in one browser is not settling.
- Bankroll is **never stored server-side**. There is no balance column to tamper with; it is computed from `bets` on demand.
- Writes queue in the **Outbox** and flush when reachable. A rejected row is surfaced in the sync report, never swallowed.
- A local-only ticket migrates as `status: 'open'`, because RLS refuses a self-declared winner. The admin grades it afterwards. Since v1.6.5 this needs no field reconstruction: the projection survived settlement, so the reopened row is valid by construction.

**Order of operations for anything that changes money:** write the database first, then re-render from what the database returns. Local-first writes produce two truths and one of them is wrong.

---

## 6. Invariants

Worth asserting in tests, and most are enforced in the schema:

1. `potential_return > 0` for every row, always.
2. `stake`, `odds`, `potential_return` never change after insert.
3. `status = 'open'` ⟺ `settled_at is null`.
4. A transition is legal only if it starts or ends at `open`.
5. `payout(open)` is null; every other status yields a number.
6. Client bankroll equals server bankroll for the same ticket set.
7. A lost ticket's potential return is unchanged from placement.
8. Settlement run twice changes nothing the second time.

---

## 7. Things deliberately not done

- **No stored payout column.** Derivable, therefore derived.
- **No balance column.** Nothing to tamper with, nothing to reconcile.
- **No direct grade-to-grade transition.** Reopen first.
- **No client-side settlement authority.** The client proposes; the server decides.
