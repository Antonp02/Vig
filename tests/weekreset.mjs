/* The competition week boundary: Tuesday 04:00 America/New_York.
   The 3:59/4:00 pair is the whole test — everything else is a sanity check
   around it. */
import { boot, runner } from './harness.mjs';

const t = runner('weekly reset boundary');
const { V } = await boot();

/* Build an absolute instant from a wall-clock time in New York. */
function et(y, m, d, hh, mm = 0, ss = 0) {
  for (let guess = Date.UTC(y, m - 1, d, hh, mm, ss); ; guess += 3600000) {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date(guess)).reduce((a, x) => (a[x.type] = x.value, a), {});
    if (+p.year === y && +p.month === m && +p.day === d && +p.hour === hh && +p.minute === mm)
      return new Date(guess);
    if (guess > Date.UTC(y, m - 1, d, hh, mm, ss) + 36e5 * 30) throw new Error('no such local time');
  }
}

t.section('configured as asked');
t.eq('timezone', V.RESET_TZ, 'America/New_York');
t.eq('hour', V.RESET_HOUR, 4);
t.eq('day (2 = Tuesday)', V.RESET_DOW, 2);

t.section('the 3:59 / 4:00 boundary');
{
  /* Tuesday 25 Aug 2026. Before 04:00 belongs to the week that began the
     previous Tuesday; at 04:00 the new week starts. */
  const before = V.weekKeyFor(et(2026, 8, 25, 3, 59));
  const at     = V.weekKeyFor(et(2026, 8, 25, 4, 0));
  t.eq('03:59 is still last week', before, '2026-08-18');
  t.eq('04:00 starts the new week', at, '2026-08-25');
  t.ok('they differ', before !== at, `${before} vs ${at}`);

  t.eq('03:59:59 is last week', V.weekKeyFor(et(2026, 8, 25, 3, 59, 59)), '2026-08-18');
  t.eq('04:00:01 is this week', V.weekKeyFor(et(2026, 8, 25, 4, 0, 1)), '2026-08-25');
}

t.section('the rest of the week holds one key');
{
  const wk = '2026-08-25';
  t.eq('Tuesday noon', V.weekKeyFor(et(2026, 8, 25, 12)), wk);
  t.eq('Thursday night kickoff', V.weekKeyFor(et(2026, 8, 27, 20, 15)), wk);
  t.eq('Sunday afternoon', V.weekKeyFor(et(2026, 8, 30, 13)), wk);
  t.eq('Monday night football', V.weekKeyFor(et(2026, 8, 31, 20, 15)), wk);
  t.eq('Tuesday 03:00, still last week', V.weekKeyFor(et(2026, 9, 1, 3)), wk);
  t.eq('and 04:00 rolls it', V.weekKeyFor(et(2026, 9, 1, 4)), '2026-09-01');
}

t.section('an NFL week never straddles two competition weeks');
{
  /* Thu kickoff through Mon night must all share a key, or MNF would settle
     into a different week than the Thursday game. */
  const keys = [
    V.weekKeyFor(et(2026, 9, 10, 20, 15)),  // Thu
    V.weekKeyFor(et(2026, 9, 13, 13, 0)),   // Sun
    V.weekKeyFor(et(2026, 9, 14, 23, 30)),  // Mon night, late
  ];
  t.ok('one key across the football week', new Set(keys).size === 1, keys.join(' / '));
}

t.section('daylight saving does not shift the boundary');
{
  /* DST ends Sun 1 Nov 2026. The Tuesday after is still 04:00 local. */
  t.eq('03:59 EST, before the roll', V.weekKeyFor(et(2026, 11, 3, 3, 59)), '2026-10-27');
  t.eq('04:00 EST, after', V.weekKeyFor(et(2026, 11, 3, 4, 0)), '2026-11-03');

  /* DST begins Sun 8 Mar 2026 — the Tuesday after is in EDT. */
  t.eq('03:59 EDT, before', V.weekKeyFor(et(2026, 3, 10, 3, 59)), '2026-03-03');
  t.eq('04:00 EDT, after', V.weekKeyFor(et(2026, 3, 10, 4, 0)), '2026-03-10');
}

t.section('the next reset always lands on Tuesday 04:00 local');
{
  const fmt = d => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit',
    minute: '2-digit', hourCycle: 'h23'
  }).format(d);
  let bad = [];
  [et(2026, 8, 25, 4, 1), et(2026, 8, 28, 12), et(2026, 8, 31, 23, 59),
   et(2026, 9, 1, 3, 59), et(2026, 11, 4, 12), et(2026, 3, 11, 12)]
    .forEach(when => {
      const s = fmt(V.nextResetAt(when));
      if (!/^Tue,? 04:00$/.test(s)) bad.push(`${fmt(when)} -> ${s}`);
    });
  t.ok('always Tuesday 04:00 ET', bad.length === 0, bad.join(' | '));

  const soon = V.nextResetAt(et(2026, 8, 25, 4, 1));
  t.ok('and always in the future', soon > et(2026, 8, 25, 4, 1));
  t.ok('within seven days', soon - et(2026, 8, 25, 4, 1) <= 7 * 864e5 + 36e5);
}

t.section('the constants cannot drift unnoticed');
{
  /* A regression guard. If someone edits RESET_HOUR or RESET_TZ, this fails
     before anyone notices bankrolls resetting at the wrong hour. */
  t.eq('RESET_TZ pinned', V.RESET_TZ, 'America/New_York');
  t.eq('RESET_HOUR pinned', V.RESET_HOUR, 4);
  t.eq('RESET_DOW pinned to Tuesday', V.RESET_DOW, 2);
}

t.done();
