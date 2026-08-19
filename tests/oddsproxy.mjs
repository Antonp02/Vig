/* The odds proxy as the browser sees it: where it points, what it sends,
   and — the point of the whole exercise — what it must never carry. */
import { boot, runner } from './harness.mjs';

const t = runner('odds proxy and key safety');
const { V, window: w } = await boot();

t.section('the endpoint resolves to the Edge Function');
{
  const ep = V.DataSource.endpoint();
  t.ok('points at Supabase functions', /\/functions\/v1\/odds$/.test(ep), ep);
  t.ok('uses the configured project', ep.startsWith(w.VIG_CONFIG.SUPABASE_URL.replace(/\/$/, '')), ep);
  t.ok('no double slash', !/[^:]\/\//.test(ep), ep);
}

t.section('the odds API key is nowhere in the shipped bundle');
{
  /* The whole reason for the function. If a key literal ever lands in app.js
     this fails loudly. */
  const src = w.document.documentElement.outerHTML;
  t.ok('no ODDS_API_KEY reference in client code', !/ODDS_API_KEY\s*[:=]\s*['"]/.test(src));
  t.ok('no the-odds-api host in client code', !/api\.the-odds-api\.com/.test(src),
       'the client should only ever talk to our own proxy');
  t.ok('no apiKey query param built client-side', !/apiKey=\$\{/.test(src));
  const cfgKeys = Object.keys(w.VIG_CONFIG || {});
  t.ok('config carries only the Supabase pair', cfgKeys.every(k => /^SUPABASE_/.test(k)),
       cfgKeys.join(','));
}

t.section('falls back cleanly with no Supabase configured');
{
  const saved = w.VIG_CONFIG.SUPABASE_URL;
  w.VIG_CONFIG.SUPABASE_URL = '';
  t.eq('drops to the same-origin path', V.DataSource.endpoint(), 'api/odds');
  w.VIG_CONFIG.SUPABASE_URL = saved;
  t.ok('and restores', /functions\/v1\/odds$/.test(V.DataSource.endpoint()));
}

t.section('mock mode never touches the network');
{
  let called = false;
  const realFetch = w.fetch;
  w.fetch = () => { called = true; return Promise.reject(new Error('should not be called')); };
  V.DataSource.setMode('mock');
  const games = await V.DataSource.fetchGames();
  t.ok('mock mode returns games', Array.isArray(games) && games.length > 0, String(games && games.length));
  t.ok('and made no request', !called);
  w.fetch = realFetch;
}

t.section('live mode sends the anon key, never the odds key');
{
  let seen = null;
  const realFetch = w.fetch;
  w.fetch = (url, opts) => {
    seen = { url: String(url), headers: (opts && opts.headers) || {} };
    return Promise.resolve({
      ok: true,
      headers: { get: (h) => ({ 'x-odds-cache': 'hit', 'x-odds-age-seconds': '42' })[String(h).toLowerCase()] || null },
      json: () => Promise.resolve([])
    });
  };
  V.DataSource.setMode('live');
  try { await V.DataSource.fetchGames(); } catch (e) { /* empty feed throws, fine */ }
  w.fetch = realFetch;
  V.DataSource.setMode('mock');

  t.ok('called the proxy', seen && /functions\/v1\/odds/.test(seen.url), seen ? seen.url : 'no call');
  t.ok('sent the anon key', !!(seen && seen.headers.apikey), JSON.stringify(seen && seen.headers));
  const hdrs = JSON.stringify((seen && seen.headers) || {});
  t.ok('the anon key is the publishable one', /sb_publishable_|^\{.*eyJ/.test(hdrs) || hdrs.includes('sb_'), hdrs.slice(0, 60));
  t.ok('no odds key in any header', !/ODDS|the-odds-api/i.test(hdrs));
  t.ok('no apiKey in the URL', !/apikey=/i.test(seen.url.split('?')[1] || ''), seen.url);
  t.ok('cache metadata was captured', V.DataSource.lastMeta && V.DataSource.lastMeta.cache === 'hit',
       JSON.stringify(V.DataSource.lastMeta));
}

t.section('a proxy failure does not take the board down');
{
  const realFetch = w.fetch;
  w.fetch = () => Promise.resolve({ ok: false, status: 429, headers: { get: () => null }, json: () => Promise.resolve({}) });
  V.DataSource.setMode('live');
  let threw = null;
  try { await V.DataSource.fetchGames(); } catch (e) { threw = e.message; }
  w.fetch = realFetch;
  V.DataSource.setMode('mock');
  t.ok('it throws a readable error', /429/.test(threw || ''), String(threw));
  t.ok('and the simulated board still renders',
       (await V.DataSource.fetchGames()).length > 0);
}

t.done();
