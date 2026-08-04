/* v1.6.5 — the bet lifecycle, against docs/SPORTSBOOK_MODEL.md.
   These replace the pre-v1.6.5 assertions that a loser's returnAmount is
   zeroed. That behaviour was the bug. */
import { boot, runner, ticket } from './harness.mjs';

const t = runner('bet lifecycle and accounting');
const { V } = await boot();

const START = 1000;

t.section('the two numbers are different numbers');
{
  const won = ticket(V, { status: 'won', stake: 100, odds: 250 });
  t.eq('potential is stake x decimal odds', V.potentialReturn(won), 350);
  t.eq('a winner pays the potential', V.payout(won), 350);

  const lost = ticket(V, { status: 'lost', stake: 100, odds: 250 });
  t.eq('a loser pays nothing', V.payout(lost), 0);
  t.eq('but keeps what it would have paid', V.potentialReturn(lost), 350);
  t.ok('and its stored projection is untouched', lost.returnAmount === 350, String(lost.returnAmount));

  const open = ticket(V, { status: 'open', stake: 100, odds: 250 });
  t.eq('an open ticket has not paid anything yet', V.payout(open), null);
  t.eq('though it would pay', V.potentialReturn(open), 350);

  t.eq('a push refunds the stake', V.payout(ticket(V, { status: 'push', stake: 40, odds: -110 })), 40);
  t.eq('a void refunds the stake', V.payout(ticket(V, { status: 'void', stake: 40, odds: -110 })), 40);
  t.eq('neither pays profit', V.payout(ticket(V, { status: 'push', stake: 40, odds: 900 })), 40);
}

t.section('bankroll is derived from the ledger');
{
  const bk = tickets => V.derivedBankroll({ tickets });
  t.eq('no bets', bk([]), START);
  t.eq('one open $100 is at risk', bk([ticket(V, { stake: 100 })]), 900);
  t.eq('a $100 winner at +250 returns $350', bk([ticket(V, { status: 'won', stake: 100, odds: 250 })]), 1250);
  t.eq('a $100 loser is down exactly the stake',
       bk([ticket(V, { status: 'lost', stake: 100, odds: 250 })]), 900);
  t.eq('a push is a round trip', bk([ticket(V, { status: 'push', stake: 100 })]), START);
  t.eq('a void is a round trip', bk([ticket(V, { status: 'void', stake: 100 })]), START);

  t.section('the loser costs the stake and only the stake');
  const long = bk([ticket(V, { status: 'lost', stake: 100, odds: 25000 })]);
  t.eq('a 250-1 loser costs $100, not $25,000', long, 900);

  t.section('a mixed book');
  t.eq('adds up', bk([
    ticket(V, { status: 'won',  stake: 100, odds: 450 }),   // +550
    ticket(V, { status: 'lost', stake: 50,  odds: 300 }),   //  -50
    ticket(V, { status: 'open', stake: 25,  odds: 300 }),   //  -25 at risk
    ticket(V, { status: 'push', stake: 40,  odds: -110 })   //   0
  ]), 1375);
}

t.section('settlement writes status and nothing else');
{
  const before = ticket(V, { stake: 100, odds: 250 });
  const projection = before.returnAmount;
  V.week.tickets = [before];
  V.settleOpenTickets();
  t.ok('the ticket is graded', before.status === 'won' || before.status === 'lost', before.status);
  t.eq('the projection survived settlement', before.returnAmount, projection);
  t.ok('settled_at was stamped', !!before.settledAt);
  t.eq('bankroll matches the ledger', V.week.bankroll, V.derivedBankroll(V.week));
  const expected = before.status === 'won' ? 1250 : 900;
  t.eq('and matches the outcome', V.week.bankroll, expected);
}

t.section('settling is idempotent');
{
  V.week.tickets = [ticket(V, { status: 'won', stake: 100, odds: 250, settledAt: new Date().toISOString() })];
  const first = V.derivedBankroll(V.week);
  V.settleOpenTickets();
  t.eq('a second pass changes nothing', V.derivedBankroll(V.week), first);
}

t.section('a legacy row is repaired, not trusted');
{
  const legacy = { id: 'OLD', kind: 'parlay', status: 'lost', stake: 100, odds: 250,
                   returnAmount: 0, legs: [{ title: 'x', odds: 250 }] };
  const w = { key: 'wk', bankroll: 0, tickets: [legacy], history: [] };
  const fixed = V.repairTickets(w);
  t.eq('one row repaired', fixed, 1);
  t.eq('from the price, which never changed', legacy.returnAmount, 350);
  t.eq('the money is unaffected by the repair', V.derivedBankroll(w), 900);
  t.eq('repairing twice is a no-op', V.repairTickets(w), 0);
  t.ok('and it can now satisfy potential_return > 0', V.potentialReturn(legacy) > 0);
}

t.section('week end voids what was never graded');
{
  const open = ticket(V, { stake: 100, odds: 250 });
  const lost = ticket(V, { status: 'lost', stake: 50, odds: 200, settledAt: new Date().toISOString() });
  const w = { key: 'wk-old', bankroll: 850, tickets: [open, lost], history: [START] };
  V.archiveWeek(w);
  t.eq('the ungraded ticket is voided', open.status, 'void');
  t.eq('its stake came back', V.payout(open), 100);
  t.eq('the loser stays lost', lost.status, 'lost');
  t.eq('closing bankroll is start minus the loss', V.derivedBankroll(w), 950);
  t.ok('the loser still records its projection', V.potentialReturn(lost) === 150, String(lost.returnAmount));
}

t.section('a fresh week resets the bankroll, not the record');
{
  const w = V.blankWeek('wk-new');
  t.eq('bankroll restored', V.derivedBankroll(w), START);
  t.eq('no tickets carried over', w.tickets.length, 0);
  const lt = V.Store.get('vig.v2.lifetime', null);
  t.ok('lifetime totals persisted across the archive', lt && lt.bets > 0,
       lt ? `${lt.bets} bets, ${lt.weeks} week(s)` : 'nothing stored');
}

t.section('the client and the schema agree on what may be uploaded');
{
  const lost = ticket(V, { status: 'lost', stake: 100, odds: 250 });
  t.ok('a settled loser is uploadable', V.potentialReturn(lost) > 0,
       `potential_return = ${V.potentialReturn(lost)}`);
  const refuses = (label, over, pattern) => {
    try { V.validateTicketForUpload(ticket(V, over)); t.ok(label, false, 'it was accepted'); }
    catch (e) { t.ok(label, pattern.test(e.message), e.message); }
  };
  refuses('a sub-$1 stake is refused before the network', { stake: 0.5, odds: 200 }, /at least \$1/);
  refuses('odds inside +/-100 are refused', { stake: 10, odds: 50 }, /odds out of range/);
  t.ok('a valid ticket passes', V.validateTicketForUpload(ticket(V, { stake: 10, odds: 250 })) === 35);
  t.ok('and so does a settled loser', V.validateTicketForUpload(lost) === 350);
  t.done();
}
