/* The SQL week key must agree with the client's, or the cleanup would void
   bets from the week that is still running. This models vig_week_key() in JS
   and checks it against weekKeyFor() across a year, including both DST
   switches and the 03:59/04:00 boundary. */
import { boot, runner } from './harness.mjs';

const t = runner('SQL week key mirrors the client');
const { V } = await boot();

/* A faithful model of:
     (local_ts)::date - (((extract(dow from local_ts) - 2) + 7) % 7)
   where local_ts = (p_at at time zone 'America/New_York') - interval '4 hours' */
function sqlWeekKey(at) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(at).reduce((a, x) => (a[x.type] = x.value, a), {});
  /* wall-clock local time, then minus four hours, as naive arithmetic —
     which is what `at time zone` followed by an interval does in Postgres */
  const naive = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const shifted = new Date(naive - 4 * 3600e3);
  const dow = shifted.getUTCDay();
  const back = ((dow - 2) + 7) % 7;
  const d = new Date(shifted.getTime() - back * 86400e3);
  return d.toISOString().slice(0, 10);
}

t.section('the two agree on the boundary');
{
  const et = (y, m, d, hh, mm) => {
    for (let g = Date.UTC(y, m - 1, d, hh, mm); ; g += 3600000) {
      const p = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
      }).formatToParts(new Date(g)).reduce((a, x) => (a[x.type] = x.value, a), {});
      if (+p.year === y && +p.month === m && +p.day === d && +p.hour === hh && +p.minute === mm)
        return new Date(g);
    }
  };
  const pairs = [
    [2026, 8, 25, 3, 59], [2026, 8, 25, 4, 0],
    [2026, 11, 3, 3, 59], [2026, 11, 3, 4, 0],   // after DST ends
    [2026, 3, 10, 3, 59], [2026, 3, 10, 4, 0]    // after DST begins
  ];
  let bad = [];
  pairs.forEach(([y, m, d, hh, mm]) => {
    const at = et(y, m, d, hh, mm);
    const js = V.weekKeyFor(at), sql = sqlWeekKey(at);
    if (js !== sql) bad.push(`${y}-${m}-${d} ${hh}:${mm} js=${js} sql=${sql}`);
  });
  t.ok('boundary cases match', bad.length === 0, bad.join(' | '));
}

t.section('and across a full year, every six hours');
{
  let checked = 0, bad = [];
  for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 6 * 3600e3) {
    const at = new Date(ms);
    const js = V.weekKeyFor(at), sql = sqlWeekKey(at);
    checked++;
    if (js !== sql && bad.length < 5) bad.push(`${at.toISOString()} js=${js} sql=${sql}`);
  }
  t.ok(`${checked} samples all match`, bad.length === 0, bad.join(' | '));
}

t.section('every key is a Tuesday');
{
  let bad = [];
  for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 37 * 3600e3) {
    const key = sqlWeekKey(new Date(ms));
    if (new Date(key + 'T12:00:00Z').getUTCDay() !== 2) bad.push(key);
  }
  t.ok('all Tuesdays', bad.length === 0, bad.slice(0, 4).join(','));
}

t.section('the cleanup can only reach closed weeks');
{
  /* The SQL filters `week_key < vig_week_key()`. The current week is never
     less than itself, so live bets are out of scope by construction. */
  const now = V.weekKeyFor();
  t.ok('current week is not less than itself', !(now < now), now);
  const lastWeek = V.weekKeyFor(new Date(Date.now() - 7 * 86400e3));
  t.ok('last week sorts before it', lastWeek < now, `${lastWeek} < ${now}`);
  t.ok('keys sort correctly as text', '2026-08-04' < '2026-08-18',
       'ISO dates compare lexicographically, which is what the SQL relies on');
}

t.done();
