/* The outbox: what retries, what does not, and what "in sync" means. */
import { boot, runner, ticket } from './harness.mjs';

const t = runner('outbox, rejection and reconciliation');
const { V } = await boot();

t.section('permanent vs transport failures');
{
  const perm = [
    'stake must be at least $1 (got 0.5)',
    'odds out of range: 50 (must be <= -100 or >= +100)',
    'potential return must be positive (got 0)',
    'new row for relation "bets" violates check constraint "bets_potential_return_check"',
    'new row violates row-level security policy for table "bets"',
    'null value in column "week_key" violates not-null constraint'
  ];
  perm.forEach(m => t.ok(`permanent: ${m.slice(0, 42)}`, V.isPermanentRejection(m), m));

  const transient = ['Failed to fetch', 'NetworkError when attempting to fetch resource',
                     'timeout of 8000ms exceeded', 'service unavailable'];
  transient.forEach(m => t.ok(`retryable: ${m.slice(0, 42)}`, !V.isPermanentRejection(m), m));
}

t.section('a poison ticket leaves the queue instead of blocking it');
{
  V.Outbox.clear(); V.DeadLetter.clear();
  /* Stand in for Supabase: signed in, reachable, and applying exactly the
     validation the real placeBet() applies. */
  V.Cloud.enabled = () => true;
  V.Cloud.signedIn = () => true;
  V.Cloud.placeBet = async (tk) => {
    V.validateTicketForUpload(tk);
    return Object.assign({}, tk, { id: `uuid-${tk.id}`, remote: true });
  };

  const bad = ticket(V, { id: 'VIG-BAD', stake: 0.5, odds: 200 });
  const good = ticket(V, { id: 'VIG-GOOD', stake: 25, odds: 300 });
  V.Outbox.add(bad, V.week.key);
  V.Outbox.add(good, V.week.key);
  t.eq('both queued', V.Outbox.count(), 2);

  V.week.tickets = [bad, good];
  const sent = await V.flushOutbox();
  t.ok('the invalid one is no longer queued', !V.Outbox.all().some(x => x.ticket.id === 'VIG-BAD'),
       V.Outbox.all().map(x => x.ticket.id).join(',') || '(empty)');
  t.eq('it is set aside with a reason', V.DeadLetter.count(), 1);
  const dl = V.DeadLetter.all()[0] || { reason: '' };
  t.ok('and the reason is legible', /at least \$1/.test(dl.reason), dl.reason);
  t.section('and crucially, the queue behind it still drained');
  t.eq('the valid ticket was sent', sent, 1);
  t.eq('nothing left queued', V.Outbox.count(), 0);
  t.ok('the good ticket adopted its server id',
       V.week.tickets.some(x => x.id === 'uuid-VIG-GOOD'),
       V.week.tickets.map(x => x.id).join(','));
  t.ok('the server was never marked unreachable', V.Cloud.reachable !== false,
       String(V.Cloud.reachable));
}

t.section('a server row held under a local id is adopted');
{
  V.Outbox.clear(); V.DeadLetter.clear();
  const local = ticket(V, { id: 'VIG-PLACEHOLDER', stake: 100, odds: 250 });
  V.week.tickets = [local];
  V.Outbox.add(local, V.week.key);
  /* the same bet, as the database returned it */
  const remote = Object.assign({}, local, { id: '9f1c0e2a-uuid', remote: true });
  t.eq('same fingerprint, different id', V.ticketFingerprint(local), V.ticketFingerprint(remote));

  const adopted = V.reconcileWithRemote([remote]);
  t.eq('one adopted', adopted, 1);
  t.eq('the local copy now carries the server id', V.week.tickets[0].id, '9f1c0e2a-uuid');
  t.eq('the stale queue entry is gone', V.Outbox.count(), 0);
  t.eq('no ticket was duplicated', V.week.tickets.length, 1);
  t.eq('the money is unchanged', V.derivedBankroll(V.week), 900);
  t.eq('reconciling again is a no-op', V.reconcileWithRemote([remote]), 0);
}

t.section('"in sync" means nothing is outstanding');
{
  V.Outbox.clear(); V.DeadLetter.clear();
  const row = ticket(V, { id: 'uuid-1', stake: 100, odds: 250, remote: true });
  V.week.tickets = [row];
  V.Cloud.session = { user: { email: 'test@vig.app' } };
  V.Cloud.myBets = async () => [row];

  const clean = await V.syncReport();
  t.ok('clean state agrees', clean.agrees === true,
       `queued ${clean.queued}, localOnly ${clean.localOnly.length}, rejected ${clean.rejected.length}`);

  V.Outbox.add(ticket(V, { id: 'VIG-PENDING', stake: 10, odds: 250 }), V.week.key);
  const pending = await V.syncReport();
  t.eq('the queued ticket is counted', pending.queued, 1);
  t.ok('and the report no longer claims a match', pending.agrees === false,
       `agrees=${pending.agrees}`);

  V.Outbox.clear();
  V.DeadLetter.add({ ticket: { id: 'VIG-BAD' }, weekKey: V.week.key, tries: 3 }, 'stake must be at least $1');
  const rejected = await V.syncReport();
  t.eq('a rejected ticket is reported', rejected.rejected.length, 1);
  t.ok('and also breaks the match', rejected.agrees === false, `agrees=${rejected.agrees}`);
  V.DeadLetter.clear();
}

t.done();
