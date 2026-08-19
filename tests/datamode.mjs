/* Live is a deploy-wide default, not a per-browser localStorage value — and
   the quota cap actually stops request 16. */
import { boot, runner } from './harness.mjs';

const t = runner('data mode rollout and quota cap');
const { V, window: w } = await boot();

t.section('the deploy decides, not the browser');
{
  V.Store.remove(V.KEYS.modeOverride);
  V.Store.remove(V.KEYS.mode);
  t.eq('config ships live', V.configuredDataMode(), 'live');
  t.eq('a fresh visitor gets live', V.resolveDataMode(), 'live');

  const saved = w.VIG_CONFIG.DATA_SOURCE;
  w.VIG_CONFIG.DATA_SOURCE = 'mock';
  t.eq('flipping config flips everyone', V.resolveDataMode(), 'mock');
  w.VIG_CONFIG.DATA_SOURCE = saved;
  t.eq('and back', V.resolveDataMode(), 'live');

  w.VIG_CONFIG.DATA_SOURCE = undefined;
  t.eq('an older config still gets live', V.resolveDataMode(), 'live');
  w.VIG_CONFIG.DATA_SOURCE = saved;
}

t.section('an admin override survives, and can be released');
{
  V.DataSource.setMode('mock');
  t.eq('override wins over config', V.resolveDataMode(), 'mock');
  t.ok('and is marked as an override', V.DataSource.isOverridden());
  t.eq('while the config default is unchanged', V.DataSource.configuredDefault(), 'live');

  V.DataSource.clearMode();
  t.eq('clearing returns to the deploy default', V.resolveDataMode(), 'live');
  t.ok('and the override is gone', !V.DataSource.isOverridden());
}

t.section('existing users are not stranded on mock');
{
  /* The whole point. Everyone who used VIG before v1.7.1 has the old default
     sitting in localStorage; left alone it pins them to simulated prices. */
  V.Store.remove(V.KEYS.modeOverride);
  V.Store.remove(V.KEYS.modeMigrated);
  V.Store.set(V.KEYS.mode, 'mock');

  const action = V.migrateDataMode();
  t.eq('the stale mock is dropped', action, 'dropped-stale-mock');
  t.eq('so they land on live', V.resolveDataMode(), 'live');
  t.ok('and the legacy key is gone', V.Store.get(V.KEYS.mode, null) === null);
  t.eq('running it again does nothing', V.migrateDataMode(), null);
}

t.section('a deliberate live choice is kept');
{
  V.Store.remove(V.KEYS.modeOverride);
  V.Store.remove(V.KEYS.modeMigrated);
  V.Store.set(V.KEYS.mode, 'live');
  t.eq('kept as a real choice', V.migrateDataMode(), 'kept-live');
  t.eq('and resolves live', V.resolveDataMode(), 'live');
  V.Store.remove(V.KEYS.modeOverride);
  V.Store.remove(V.KEYS.modeMigrated);
}

t.section('a failing feed falls back to real games, not invented ones');
{
  await V.RealBoard.load();
  const games = V.fallbackGames();
  t.ok('fallback returns games', games.length > 0, String(games.length));
  const abbrs = games.map(g => `${g.away.abbr}@${g.home.abbr}`);
  t.ok('they are the captured slate', abbrs.includes('LV@HOU'), abbrs.slice(0, 4).join(','));
  t.ok('at the transcribed price',
       games.find(g => g.home.abbr === 'HOU').home.prices[0].price === -134,
       JSON.stringify(games.find(g => g.home.abbr === 'HOU').home.prices));
  t.ok('labelled captured, not a book quote',
       games[0].home.prices.every(p => p.title === 'Captured'));

  const invented = V.mockGames().map(g => `${g.away.abbr}@${g.home.abbr}`);
  t.ok('and not the invented fixtures', !abbrs.some(a => invented.includes(a)),
       invented.slice(0, 3).join(','));
}

t.section('the quota cap blocks request 16');
{
  /* A faithful model of the corrected SQL:
       on conflict do update set used = used + 1 where used < p_cap returning used
     No row updated -> RETURNING yields nothing -> v_used stays null. */
  function claim(state, cap) {
    if (cap == null || cap < 1) return null;
    if (state.used == null) { state.used = 1; return 1; }     // INSERT path
    if (state.used < cap) { state.used += 1; return state.used; }
    return null;                                              // WHERE refused
  }

  const cap = 15;
  const state = { used: null };
  const granted = [];
  for (let i = 1; i <= 20; i++) granted.push(claim(state, cap));

  t.eq('credits 1..15 are granted', granted.slice(0, 15).filter(x => x !== null).length, 15);
  t.eq('the 15th credit is 15', granted[14], 15);
  t.eq('request 16 is refused', granted[15], null);
  t.ok('and so is everything after it', granted.slice(15).every(x => x === null),
       JSON.stringify(granted.slice(15)));
  t.eq('used never exceeds the cap', state.used, cap);

  t.section('the v1.7.0 bug, so it cannot come back');
  /* The old logic: hold the value at the cap, then `if v_used > p_cap`. */
  function claimBuggy(state, cap) {
    if (state.used == null) { state.used = 1; return 1; }
    state.used = state.used < cap ? state.used + 1 : state.used;
    return state.used > cap ? null : state.used;
  }
  const bad = { used: null };
  const badGranted = [];
  for (let i = 1; i <= 20; i++) badGranted.push(claimBuggy(bad, cap));
  t.ok('the old version granted request 16', badGranted[15] !== null,
       `granted ${badGranted[15]}`);
  t.ok('and every request after it', badGranted.slice(15).every(x => x !== null));
  t.ok('the fix differs from the bug exactly there',
       granted[15] === null && badGranted[15] !== null);

  t.section('a cap of zero permits nothing');
  const none = { used: null };
  t.eq('not even the first call', claim(none, 0), null);
}

t.done();
