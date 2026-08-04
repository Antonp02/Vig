/* The paths v1.6.5 changed most invasively: golf grading, admin reversal,
   and the round trip back. Reversal used to reconstruct a destroyed
   projection and hand-adjust the bankroll; it now only moves status. */
import { boot, runner, ticket } from './harness.mjs';

const t = runner('golf settlement and reversal');
const { V, document: d } = await boot();

t.section('the app boots clean');
t.ok('no boot errors', !V.bootErrors || V.bootErrors.length === 0,
     (V.bootErrors || []).join(' | '));
t.ok('debug handle is complete',
     ['payout', 'potentialReturn', 'derivedBankroll', 'repairTickets', 'validateTicketForUpload']
       .every(k => typeof V[k] === 'function'));

const eventId = V.GolfEvent.data.eventId;
const sels = ((V.GolfEvent.data.markets || [])[0] || {}).selections || [];
const field = sels.find(s => s.selectionId === 'g-field') || sels[0];
const other = sels.find(s => s !== field);
t.ok('the fixture has two selections', !!field && !!other,
     `${sels.length} selection(s)`);

const mk = (sel, stake, odds) => ticket(V, {
  kind: 'golf', eventId, selectionId: sel.selectionId, stake, odds,
  legs: [{ title: sel.name || 'pick', odds }]
});

t.section('grading pays the winner and only the winner');
{
  const win = mk(field, 100, 250);
  const lose = mk(other, 50, 400);
  V.week.tickets = [win, lose];
  V.week.bankroll = V.derivedBankroll(V.week);
  t.eq('both stakes are at risk while open', V.derivedBankroll(V.week), 850);

  const r = V.settleGolfEvent(field.selectionId);
  t.eq('two tickets graded', r.settled, 2);
  t.eq('the winner won', win.status, 'won');
  t.eq('the loser lost', lose.status, 'lost');
  t.eq('paid out the winner only', r.paid, 350);
  t.eq('bankroll reflects it', V.derivedBankroll(V.week), 1200);

  t.section('and the loser keeps its record');
  t.eq('projection intact after grading', lose.returnAmount, 250);
  t.eq('but it paid nothing', V.payout(lose), 0);
  t.ok('so it would still upload', V.potentialReturn(lose) > 0);
}

t.section('reversal is a status change and nothing more');
{
  const [win, lose] = V.week.tickets;
  const projections = [win.returnAmount, lose.returnAmount];
  V.Admin.reverseSettlement ? V.Admin.reverseSettlement() : V.week.tickets.forEach(x => {
    x.status = 'open'; delete x.settledAt;
  });
  V.week.bankroll = V.derivedBankroll(V.week);
  t.eq('both are open again', V.week.tickets.filter(x => x.status === 'open').length, 2);
  t.ok('no settled_at survives', V.week.tickets.every(x => !x.settledAt));
  t.eq('winner projection unchanged', win.returnAmount, projections[0]);
  t.eq('loser projection unchanged', lose.returnAmount, projections[1]);
  t.eq('bankroll is back to both stakes at risk', V.derivedBankroll(V.week), 850);
}

t.section('re-grading lands in exactly the same place');
{
  const r = V.settleGolfEvent(field.selectionId);
  t.eq('graded again', r.settled, 2);
  t.eq('same payout', r.paid, 350);
  t.eq('same bankroll', V.derivedBankroll(V.week), 1200);
  t.ok('idempotent from here', V.settleGolfEvent(field.selectionId).settled === 0);
  t.eq('bankroll still correct after the no-op', V.derivedBankroll(V.week), 1200);
}

t.section('a push refunds everyone');
{
  V.week.tickets = [mk(field, 100, 250), mk(other, 50, 400)];
  const r = V.settleGolfEvent(null, { push: true });
  t.eq('both pushed', r.settled, 2);
  t.eq('refunded the stakes', r.paid, 150);
  t.eq('nobody is up or down', V.derivedBankroll(V.week), 1000);
  t.ok('no profit was paid', V.week.tickets.every(x => V.payout(x) === x.stake));
}

t.section('My Bets renders the distinction');
{
  V.week.tickets = [ticket(V, { status: 'lost', stake: 100, odds: 250, settledAt: new Date().toISOString() })];
  V.renderBets('all');
  const card = d.querySelector('.bet-card');
  const text = card ? card.textContent.replace(/\s+/g, ' ') : '';
  t.ok('a loser shows 0.00 returned', /Returned\s*\$?0\.00/.test(text), text.slice(0, 140));
  t.ok('and says what it would have paid', /would have paid\s*\$?350\.00/.test(text), text.slice(0, 160));
}

t.done();
