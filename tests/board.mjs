/* The preseason W2 slate: transcription integrity and the slate roll. */
import { boot, runner } from './harness.mjs';

const t = runner('board slate and real lines');
const { V, document: d } = await boot();
await V.RealBoard.load();

t.section('the right slate is showing');
t.eq('preseason W2 is live', V.RealBoard.label(), 'NFL Preseason · Week 2');
t.eq('ten games', V.RealBoard.games().length, 10);
t.eq('all still to play', V.RealBoard.upcoming().length, 10);
t.eq('two sides per game', V.RealBoard.toMarkets().length, 20);

t.section('every price is a legal American number');
{
  let bad = [];
  V.RealBoard.games().forEach(g => {
    [['open', g.open], ['current', g.current]].forEach(([which, side]) => {
      [['mlAway', side.mlAway], ['mlHome', side.mlHome]].forEach(([k, v]) => {
        if (!V.validOdds(v)) bad.push(`${g.gameId} ${which}.${k}=${v}`);
      });
    });
  });
  t.ok('no odds inside +/-100', bad.length === 0, bad.join(', '));
}

t.section('favourite and underdog are consistent');
{
  let bad = [];
  V.RealBoard.games().forEach(g => {
    /* exactly one side is the favourite, and the spread agrees with it */
    const awayFav = g.current.mlAway < g.current.mlHome;
    const spreadSaysAwayFav = g.current.spread < 0;
    if (awayFav !== spreadSaysAwayFav) bad.push(`${g.gameId}: ML says ${awayFav ? g.away : g.home}, spread says ${spreadSaysAwayFav ? g.away : g.home}`);
  });
  t.ok('moneyline and spread pick the same favourite', bad.length === 0, bad.join(' | '));
}

t.section('the transcription matches the source screens');
{
  const by = id => V.RealBoard.find(id);
  const chk = (id, field, want) => {
    const g = by(id);
    const got = field.split('.').reduce((o, k) => o && o[k], g);
    t.eq(`${id} ${field}`, got, want);
  };
  chk('lv-hou', 'current.mlHome', -134);
  chk('lv-hou', 'current.total', 40.5);
  chk('gb-den', 'open.mlAway', 217);
  chk('gb-den', 'current.mlAway', 200);
  chk('was-det', 'current.spread', 4.5);
  chk('was-det', 'open.spread', 3);
  chk('buf-cle', 'current.mlHome', -158);
  chk('nyg-mia', 'current.spread', -2.5);
  chk('bal-min', 'public.mlHome', 53);
}

t.section('SF at LAC flipped sides — the showcase for Line Winder');
{
  const g = V.RealBoard.find('sf-lac');
  t.ok('LAC opened favourite', g.open.mlHome < 0, String(g.open.mlHome));
  t.ok('and is now the dog', g.current.mlHome > 0, String(g.current.mlHome));
  t.ok('SF made the opposite move', g.open.mlAway > 0 && g.current.mlAway < 0);
  t.eq('a 228-cent swing', g.current.mlHome - g.open.mlHome, 228);
}

t.section('public splits are sane');
{
  let bad = [];
  V.RealBoard.games().forEach(g => {
    const p = g.public || {};
    if (typeof p.mlAway === 'number' && typeof p.mlHome === 'number' && p.mlAway + p.mlHome !== 100)
      bad.push(`${g.gameId} ml ${p.mlAway}+${p.mlHome}`);
    if (typeof p.spreadAway === 'number' && typeof p.spreadHome === 'number' && p.spreadAway + p.spreadHome !== 100)
      bad.push(`${g.gameId} spread ${p.spreadAway}+${p.spreadHome}`);
  });
  t.ok('each split totals 100%', bad.length === 0, bad.join(', '));
  t.ok('a missing split is null, not zero',
       V.RealBoard.find('atl-ind').public.spreadAway === null);
}

t.section('Line Winder picks up the real prices');
{
  const teams = V.buildLineTeams ? V.buildLineTeams() : [];
  const real = teams.filter(x => x.real && String(x.gameId).startsWith('board-'));
  t.eq('twenty real lines', real.length, 20);
  const lac = real.find(x => x.abbr === 'LAC');
  t.ok('LAC carries its opening price', lac && lac.openPrice === -123, lac ? String(lac.openPrice) : 'missing');
  t.eq('and a two-point series', lac.series.length, 2);
  t.ok('with a public split attached', typeof lac.publicPct === 'number', String(lac && lac.publicPct));
  const flat = real.find(x => x.abbr === 'HOU');
  t.eq('an unmoved line reports zero movement', flat.move, 0);
}

t.section('the ticker shows the same slate as the board');
{
  V.renderTicker();
  const label = d.getElementById('tickerLabel').textContent;
  const count = d.getElementById('tickerCount').textContent;
  t.eq('labelled with the live slate', label, 'NFL Preseason · Week 2');
  t.eq('and counts its games', count, '10 games');

  const ticks = [...d.querySelectorAll('.tick-run')][0].querySelectorAll('.tick');
  t.eq('one tick per game', ticks.length, 10);

  const text = [...ticks].map(x => x.textContent).join(' | ');
  t.ok('no stale Week 1 fixtures', !/Sep 13|Week 1/.test(label + text), label);
  t.ok('leads with Thursday night', /LV.*HOU.*Thu 8:00 PM/.test(ticks[0].textContent),
       ticks[0].textContent);
  t.ok('kickoffs are in order',
       /Thu/.test(ticks[0].textContent) && /Sat/.test(ticks[9].textContent),
       `${ticks[0].textContent} … ${ticks[9].textContent}`);
  t.ok('every tick carries a day and a time',
       [...ticks].every(x => /(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d{1,2}:\d{2} (AM|PM) ET/.test(x.textContent)),
       [...ticks].map(x => x.textContent).slice(0, 2).join(' | '));

  t.ok('the strip is duplicated for a seamless loop',
       d.querySelectorAll('.tick-run').length === 2);
  t.ok('and the bar is visible', !d.querySelector('.ticker-bar').hidden);
}

t.done();
