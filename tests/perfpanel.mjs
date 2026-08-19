/* All-time performance, the weekly bankroll ledger, and the ad rail. */
import { boot, runner, ticket } from './harness.mjs';

const t = runner('all-time panel, bankroll ledger, ad slot');
const { V, window: w, document: d } = await boot();

const mk = (over) => Object.assign(ticket(V, over), { legs: [{ title: 'a pick', odds: over.odds || 250 }] });

t.section('all-time counts only graded bets');
{
  V.Store.set(V.KEYS.lifetime, { bets: 40, won: 20, lost: 15, push: 5, wagered: 2000,
    profit: 300, weeks: 4, wins: 20, biggestWin: 180, bestFinish: 1400,
    bestWeek: 312, worstWeek: -188 });
  V.week.tickets = [
    mk({ status: 'won',  stake: 100, odds: 200 }),   // +200 profit
    mk({ status: 'lost', stake: 50,  odds: 300 }),   // -50
    mk({ status: 'open', stake: 25,  odds: 250 }),   // not yet anything
    mk({ status: 'void', stake: 40,  odds: 250 }),   // refunded
    mk({ status: 'push', stake: 30,  odds: 250 })    // refunded
  ];
  const a = V.allTimeStats();
  t.eq('open bets are not graded', a.graded, 37);
  t.eq('wins', a.won, 21);
  t.eq('losses', a.lost, 16);
  t.ok('the open bet is tracked separately', a.open === 1, String(a.open));
  t.eq('void and push are neither', a.voided, 7);
  t.ok('hit rate uses graded only', a.hitRate === Math.round(21 / 37 * 100),
       `${a.hitRate}% from ${a.won}/${a.graded}`);

  t.section('and a void does not read as a loss');
  const onlyVoid = V.allTimeStats();
  t.ok('P/L excludes the refunded stakes', onlyVoid.profit === V.round2(300 + 150),
       `${onlyVoid.profit} — a $200 win less a $50 loss on top of 300`);
}

t.section('a weekly reset does not touch all-time');
{
  const before = V.allTimeStats();
  const stale = { key: '2026-08-04', bankroll: 900, history: [1000],
                  tickets: [mk({ status: 'lost', stake: 100, odds: 250, settledAt: new Date().toISOString() })] };
  V.archiveWeek(stale);
  const after = V.allTimeStats();
  t.ok('bets only ever go up', after.bets >= before.bets, `${before.bets} -> ${after.bets}`);
  t.ok('the archived loss is counted', after.lost > before.lost, `${before.lost} -> ${after.lost}`);
  t.ok('best week survives', after.bestWeek !== null, String(after.bestWeek));
}

t.section('best and worst are records, not the last 12 weeks');
{
  const lt = V.Store.get(V.KEYS.lifetime, null);
  t.ok('best is on the accumulator', typeof lt.bestWeek === 'number', JSON.stringify(lt.bestWeek));
  t.ok('worst too', typeof lt.worstWeek === 'number', JSON.stringify(lt.worstWeek));
  t.ok('worst is not above best', lt.worstWeek <= lt.bestWeek, `${lt.worstWeek} / ${lt.bestWeek}`);
}

t.section('the bankroll ledger is idempotent');
{
  V.setWeek(V.blankWeek(V.weekKeyFor()));
  t.eq('starts with one point', V.week.ledger.length, 1);
  t.eq('at the full bankroll', V.week.ledger[0].bankroll, 1000);
  t.eq('and says why', V.week.ledger[0].reason, 'week_start');

  V.week.tickets = [mk({ id: 'T9', status: 'won', stake: 100, odds: 200 })];
  const first = V.recordBankroll('ticket_settled', 'T9');
  t.ok('a settlement is recorded', !!first, JSON.stringify(first));
  t.eq('two points now', V.week.ledger.length, 2);

  /* The whole point: settlement running twice must not move the line twice. */
  const again = V.recordBankroll('ticket_settled', 'T9');
  t.ok('the same settlement is ignored', again === null);
  t.eq('still two points', V.week.ledger.length, 2);

  t.section('and a move of zero is not a point');
  V.week.tickets.push(mk({ id: 'T10', status: 'push', stake: 40, odds: 250 }));
  const nochange = V.recordBankroll('ticket_settled', 'T10');
  t.ok('a push that nets zero draws nothing', nochange === null,
       'otherwise the chart shows a flat step for every refund');
}

t.section('a week from before the ledger existed can be redrawn');
{
  const legacy = { key: '2026-08-11', bankroll: 950, history: [1000, 950], tickets: [
    mk({ id: 'L1', status: 'lost', stake: 50, odds: 250, settledAt: '2026-08-12T18:00:00Z' }),
    mk({ id: 'L2', status: 'won', stake: 100, odds: 200, settledAt: '2026-08-13T18:00:00Z' })
  ] };
  const rebuilt = V.rebuildLedger(legacy);
  t.ok('it produces points', rebuilt.length >= 3, String(rebuilt.length));
  t.eq('starting at the full bankroll', rebuilt[0].bankroll, 1000);
  t.eq('and ending where the week ended', rebuilt[rebuilt.length - 1].bankroll,
       V.derivedBankroll(legacy));
  t.ok('in settlement order',
       Date.parse(rebuilt[1].at) <= Date.parse(rebuilt[2].at));
}

t.section('the chart renders');
{
  V.setWeek(V.blankWeek(V.weekKeyFor()));
  V.renderBets('all');
  t.eq('eight all-time cells', d.querySelectorAll('.at-cell').length, 8);
  t.ok('an svg is drawn', !!d.querySelector('.bk-svg'));
  t.ok('flat at $1,000 with no bets', /1,000\.00/.test(d.getElementById('bankrollNow').textContent),
       d.getElementById('bankrollNow').textContent);
  t.eq('and says so', d.getElementById('bankrollDelta').textContent, 'even');
  t.ok('the $1,000 baseline is marked', !!d.querySelector('.bk-base'));

  t.section('losing money turns the line red');
  V.week.tickets = [mk({ id: 'R1', status: 'lost', stake: 200, odds: 250, settledAt: new Date().toISOString() })];
  V.renderBankrollChart();
  const stroke = d.querySelector('.bk-line').getAttribute('stroke');
  t.ok('red below the start', /red/.test(stroke), stroke);
  t.ok('and the delta is negative', /negative/.test(d.getElementById('bankrollDelta').className));

  V.week.tickets = [mk({ id: 'B1', status: 'won', stake: 100, odds: 300, settledAt: new Date().toISOString() })];
  V.renderBankrollChart();
  t.ok('blue above it', /accent/.test(d.querySelector('.bk-line').getAttribute('stroke')));
}

t.section('the ad rail is Home only');
{
  w.matchMedia = q => ({ matches: /min-width: 1350px/.test(q), addEventListener() {}, removeEventListener() {} });
  V.AdSlot.render('home');
  const rail = d.getElementById('adRail');
  t.ok('shown on Home', !rail.hidden);
  t.ok('marked as advertising', /VIG PROMOTION/.test(rail.textContent), rail.textContent.slice(0, 40));
  t.ok('with the creative', /Think you know ball/.test(rail.textContent));
  t.ok('and a call to action', !!d.getElementById('adCta'));

  ['bets', 'parlay', 'linewinder', 'fantasy', 'trending', 'leaderboard', 'friends'].forEach(v => {
    V.AdSlot.render(v);
    t.ok(`hidden on ${v}`, rail.hidden && rail.innerHTML === '');
  });

  t.section('and never squeezed onto a narrow screen');
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  V.AdSlot.render('home');
  t.ok('hidden below 1350px', rail.hidden);
}

t.section('the slot takes any creative, not just this one');
{
  w.matchMedia = q => ({ matches: /min-width: 1350px/.test(q), addEventListener() {}, removeEventListener() {} });
  const saved = V.AdSlot.creative;
  V.AdSlot.creative = { campaignId: 'x1', advertiser: 'Someone Else', label: 'ADVERTISEMENT',
    headline: 'A different pitch', body: 'Body copy.', lines: ['One.', 'Two.'],
    cta: 'GO', targetView: 'parlay', image: null, destination: null,
    impressionTracking: true, clickTracking: true };
  V.AdSlot.render('home');
  const rail = d.getElementById('adRail');
  t.ok('a third-party creative renders', /Someone Else/.test(rail.textContent));
  t.ok('with its own label', /ADVERTISEMENT/.test(rail.textContent));
  t.ok('and no code changed to do it', /A different pitch/.test(rail.textContent));
  V.AdSlot.creative = saved;
}

t.done();
