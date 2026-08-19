/* Settling open tickets from final scores, and the 3-day void. */
import { boot, runner, ticket } from './harness.mjs';

const t = runner('settlement from results');
const { V, window: w } = await boot();
await V.RealBoard.load();

const DAY = 86400000;
const leg = (title, gameId, odds = -134) => ({ title, odds, gameId });

/* Shape of a completed game from the scores feed. */
const finished = (away, home, awayScore, homeScore) => ({
  id: `${away}-${home}`, completed: true,
  commence_time: new Date(Date.now() - 4 * 3600e3).toISOString(),
  home_team: home, away_team: away,
  scores: [{ name: home, score: homeScore }, { name: away, score: awayScore }]
});

const results = [
  finished('Las Vegas Raiders', 'Houston Texans', 17, 24),
  finished('San Francisco 49ers', 'Los Angeles Chargers', 21, 14),
  finished('New York Jets', 'Pittsburgh Steelers', 20, 20)   // tie
].map(g => V.Scores.result(g));

t.section('reading a final score');
{
  t.eq('three results parsed', results.length, 3);
  t.eq('the home side won', results[0].winner, 'Houston Texans');
  t.eq('the away side won', results[1].winner, 'San Francisco 49ers');
  t.eq('a tie has no winner', results[2].winner, null);
  t.ok('an unfinished game yields nothing',
       V.Scores.result({ completed: false, home_team: 'x', away_team: 'y' }) === null);
  t.ok('a completed game with no scores yields nothing',
       V.Scores.result({ completed: true, home_team: 'x', away_team: 'y', scores: [] }) === null);
}

t.section('grading a single leg');
{
  const win = V.resultForLeg(leg('Houston Texans moneyline', 'lv-hou'), results);
  t.eq('backing the winner wins', win.outcome, 'win');
  const lose = V.resultForLeg(leg('Las Vegas Raiders moneyline', 'lv-hou'), results);
  t.eq('backing the loser loses', lose.outcome, 'loss');
  const push = V.resultForLeg(leg('Pittsburgh Steelers moneyline', 'nyj-pit'), results);
  t.eq('a tie pushes', push.outcome, 'push');
  t.ok('an unplayed game stays ungraded',
       V.resultForLeg(leg('Green Bay Packers moneyline', 'gb-den'), results) === null);
  t.ok('a leg naming no side stays ungraded',
       V.resultForLeg(leg('some prop', 'lv-hou'), results) === null,
       'a gameId is a matchup, not a pick');
}

t.section('grading a ticket');
{
  const mk = (legs, over = {}) => Object.assign(
    ticket(V, Object.assign({ stake: 50, odds: 250 }, over)), { legs });

  V.week.tickets = [
    mk([leg('Houston Texans moneyline', 'lv-hou')]),
    mk([leg('Las Vegas Raiders moneyline', 'lv-hou')]),
    mk([leg('Houston Texans moneyline', 'lv-hou'),
        leg('San Francisco 49ers moneyline', 'sf-lac')]),
    mk([leg('Houston Texans moneyline', 'lv-hou'),
        leg('Los Angeles Chargers moneyline', 'sf-lac')]),
    mk([leg('Houston Texans moneyline', 'lv-hou'),
        leg('Green Bay Packers moneyline', 'gb-den')]),
    mk([leg('Pittsburgh Steelers moneyline', 'nyj-pit')])
  ];
  const p = V.gradeOpenTickets(results);
  const byIdx = i => p.find(x => x.id === V.week.tickets[i].id);

  t.eq('single winner', byIdx(0).status, 'won');
  t.eq('single loser', byIdx(1).status, 'lost');
  t.eq('both legs correct wins', byIdx(2).status, 'won');
  t.eq('one wrong leg loses', byIdx(3).status, 'lost');
  t.ok('a parlay with a game still to play stays open', !byIdx(4),
       'nothing should be proposed for it');
  t.eq('a tie pushes', byIdx(5).status, 'push');
}

t.section('a loss settles immediately, without waiting for the rest');
{
  /* The bettor is already beaten; making them wait three days for a Sunday
     game to confirm a Thursday loss would be theatre. */
  const tk = Object.assign(ticket(V, { stake: 20, odds: 400 }), {
    legs: [leg('Las Vegas Raiders moneyline', 'lv-hou'),
           leg('Green Bay Packers moneyline', 'gb-den')]
  });
  V.week.tickets = [tk];
  const p = V.gradeOpenTickets(results);
  t.eq('graded now', p.length, 1);
  t.eq('as a loss', p[0].status, 'lost');
  t.ok('and says why', /leg lost/.test(p[0].reason), p[0].reason);
}

t.section('three days ungraded means void, not lost');
{
  const old = Object.assign(ticket(V, { stake: 40, odds: 300 }), {
    legs: [leg('Green Bay Packers moneyline', 'gb-den')],
    placedAt: new Date(Date.now() - 10 * DAY).toISOString()
  });
  V.week.tickets = [old];

  const soon = V.gradeOpenTickets(results, Date.now());
  t.eq('inside the window it stays open', soon.length, 0);

  const later = V.gradeOpenTickets(results, Date.parse('2026-08-21T21:00:00-04:00') + 3 * DAY + 60000);
  t.eq('past three days it is settled', later.length, 1);
  t.eq('as VOID, not lost', later[0].status, 'void');
  t.ok('with the reason stated', /3 days/.test(later[0].reason), later[0].reason);

  t.section('and voiding gives the stake back');
  old.status = 'void';
  t.eq('the bettor is made whole', V.payout(old), 40);
  t.ok('a void is not a loss', V.payout(old) !== 0);
}

t.section('the boundary is exactly three days');
{
  const kick = Date.parse('2026-08-21T21:00:00-04:00');   // GB @ DEN
  const tk = Object.assign(ticket(V, { stake: 10, odds: 200 }), {
    legs: [leg('Green Bay Packers moneyline', 'gb-den')]
  });
  V.week.tickets = [tk];
  t.eq('a minute before, still open', V.gradeOpenTickets(results, kick + 3 * DAY - 60000).length, 0);
  t.eq('a minute after, voided', V.gradeOpenTickets(results, kick + 3 * DAY + 60000).length, 1);
  t.eq('the grace period is three days', V.SETTLE_GRACE_MS, 3 * DAY);
}

t.section('settled tickets are left alone');
{
  V.week.tickets = [
    Object.assign(ticket(V, { status: 'won', stake: 10, odds: 200 }),
      { legs: [leg('Houston Texans moneyline', 'lv-hou')] }),
    Object.assign(ticket(V, { status: 'lost', stake: 10, odds: 200 }),
      { legs: [leg('Las Vegas Raiders moneyline', 'lv-hou')] })
  ];
  t.eq('nothing re-graded', V.gradeOpenTickets(results).length, 0);
}

t.section('a non-admin never settles their own bets');
{
  V.week.tickets = [Object.assign(ticket(V, { stake: 25, odds: 250 }),
    { legs: [leg('Houston Texans moneyline', 'lv-hou')] })];
  V.Cloud.enabled = () => true;
  V.Cloud.signedIn = () => true;
  V.Cloud.admin = false;
  V.Scores.data = [finished('Las Vegas Raiders', 'Houston Texans', 17, 24)];
  V.Scores.fetchedAt = Date.now();

  const r = await V.autoSettleFromScores({ quiet: true });
  t.eq('nothing applied locally', r.applied, 0);
  t.ok('but the win was recognised', r.proposed > 0, JSON.stringify(r));
  t.eq('and the reason is named', r.blocked, 'server-settles');
  t.eq('the ticket is still open', V.week.tickets[0].status, 'open');

  t.section('an admin does settle');
  V.Cloud.admin = true;
  const r2 = await V.autoSettleFromScores({ quiet: true });
  t.eq('applied', r2.applied, 1);
  t.eq('as a win', V.week.tickets[0].status, 'won');
  t.ok('stamped with a settle time', !!V.week.tickets[0].settledAt);
  t.eq('and attributed to the feed', V.week.tickets[0].settledBy, 'scores');
  V.Cloud.enabled = () => false;
}

t.done();
