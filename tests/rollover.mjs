/* Turning AUTO_ROLLOVER on: the stale week closes, ungraded tickets are
   refunded, and a fresh bankroll appears — without losing the record. */
import { boot, runner, ticket } from './harness.mjs';

const t = runner('automatic weekly rollover');
const { V } = await boot();

t.section('rollover is on');
t.eq('AUTO_ROLLOVER', V.AUTO_ROLLOVER, true);

t.section('a week that never closed, closes');
{
  /* Exactly the situation on the live account: tickets placed weeks ago,
     still open, because the week never advanced. */
  const stale = {
    key: '2026-08-04',
    bankroll: 749,
    tickets: [
      Object.assign(ticket(V, { id: 'T1', stake: 100, odds: 250 }), { legs: [{ title: 'some pick', odds: 250 }] }),
      Object.assign(ticket(V, { id: 'T2', stake: 75, odds: 300 }), { legs: [{ title: 'another', odds: 300 }] }),
      Object.assign(ticket(V, { id: 'T3', status: 'lost', stake: 76, odds: 200, settledAt: new Date().toISOString() }),
        { legs: [{ title: 'a loser', odds: 200 }] })
    ],
    history: [1000]
  };
  t.eq('two are open', stale.tickets.filter(x => x.status === 'open').length, 2);
  t.eq('bankroll reflects the stakes at risk', V.derivedBankroll(stale), 749);

  V.archiveWeek(stale);

  t.ok('no ticket is still open', !stale.tickets.some(x => x.status === 'open'),
       stale.tickets.map(x => x.status).join(','));
  t.eq('the ungraded ones voided', stale.tickets.filter(x => x.status === 'void').length, 2);
  t.eq('the graded loss stays lost', stale.tickets[2].status, 'lost');

  t.section('voiding refunds — it does not confiscate');
  t.eq('first stake back', V.payout(stale.tickets[0]), 100);
  t.eq('second stake back', V.payout(stale.tickets[1]), 75);
  t.eq('only the real loss is kept', V.derivedBankroll(stale), 924);
  t.ok('each voided ticket keeps its projection',
       stale.tickets.slice(0, 2).every(x => V.potentialReturn(x) > 0));
}

t.section('the new week starts clean');
{
  const fresh = V.blankWeek('2026-08-18');
  t.eq('back to the full bankroll', V.derivedBankroll(fresh), 1000);
  t.eq('no tickets carried over', fresh.tickets.length, 0);
  t.eq('and it is the current week', fresh.key, '2026-08-18');
}

t.section('the record survives the reset');
{
  const lt = V.Store.get(V.KEYS.lifetime, null);
  t.ok('lifetime totals exist', !!lt, JSON.stringify(lt));
  t.ok('and counted the archived bets', lt && lt.bets >= 3, lt ? `${lt.bets} bets` : 'none');
  t.ok('weeks played incremented', lt && lt.weeks >= 1, lt ? `${lt.weeks} weeks` : 'none');
}

t.section('a stale week key triggers the roll on load');
{
  V.week.key = '2026-07-28';           // long past
  V.week.tickets = [];
  const rolled = V.ensureWeek();
  t.ok('ensureWeek acts now', rolled === true, String(rolled));
  t.eq('and lands on the current week', V.week.key, V.weekKeyFor());
  t.eq('with a full bankroll', V.derivedBankroll(V.week), 1000);
}

t.done();
