/* The BMW Championship outright board: transcription, de-vig, and parlay use. */
import { boot, runner } from './harness.mjs';

const t2 = runner('golf outright board');
const { V } = await boot();
await V.GolfOutrights.load();
V.GolfOutrights.install();

t2.section('the field is on the board');
const golf = V.TRENDING.filter(m => m.category === 'golf');
t2.eq('thirty golfers', golf.length, 30);
t2.ok('all are outright winners', golf.every(g => / to win$/.test(g.title)),
      golf.filter(g => !/ to win$/.test(g.title)).map(g => g.title).join(','));
t2.ok('no finished tournament left on the board',
      !V.TRENDING.some(m => /Open Championship|St\. Jude/.test(m.event || '')));
t2.ok('every row is one event', new Set(golf.map(g => g.event)).size === 1, golf[0].event);

t2.section('prices survived transcription');
const price = n => (golf.find(g => g.title.startsWith(n)) || {}).odds;
t2.eq('Scheffler', price('Scottie Scheffler'), 300);
t2.eq('McIlroy', price('Rory McIlroy'), 1600);
t2.eq('Fleetwood', price('Tommy Fleetwood'), 2000);
t2.eq('Cantlay', price('Patrick Cantlay'), 3000);
t2.eq('Thorbjornsen', price('Michael Thorbjornsen'), 5000);
t2.eq('Alex Fitzpatrick', price('Alex Fitzpatrick'), 7500);
t2.ok('all are legal American odds', golf.every(g => V.validOdds(g.odds)));
t2.ok('every price is plus money', golf.every(g => g.odds > 0));

t2.section('the fair price is a real de-vig, not a guess');
t2.ok('fair is always longer than offered', golf.every(g => g.fair > g.odds),
      golf.filter(g => g.fair <= g.odds).map(g => g.title).join(','));
const impl = o => o > 0 ? 100 / (o + 100) : Math.abs(o) / (Math.abs(o) + 100);
const book = golf.reduce((a, g) => a + impl(g.odds), 0);
const fair = golf.reduce((a, g) => a + impl(g.fair), 0);
t2.ok('the raw book is overround', book > 1, book.toFixed(4));
t2.ok('de-vigged it totals under 100%', fair < 1.0, fair.toFixed(4));
t2.ok('and reserves a slice for unlisted players', fair > 0.93 && fair < 0.99, fair.toFixed(4));

t2.section('a golfer parlays like any other leg');
const g1 = golf.find(x => x.title.startsWith('Scottie'));
const g2 = golf.find(x => x.title.startsWith('Rory'));
t2.ok('two golfers can be selected', !!g1 && !!g2);
const dec = o => o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
const combined = dec(g1.odds) * dec(g2.odds);
t2.ok('combined odds are computable', isFinite(combined) && combined > 1, combined.toFixed(2));
t2.eq('a $10 two-golfer parlay returns', Math.round(10 * combined), 680);

t2.section('sign-in failures get diagnosed, not echoed');
const d = await V.Cloud.diagnose();
t2.ok('diagnose returns a cause', !!d.cause, JSON.stringify(d));
t2.ok('and a message a human can act on', typeof d.message === 'string' && d.message.length > 10, d.message);

t2.done();
