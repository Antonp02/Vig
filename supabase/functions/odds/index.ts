/* ============================================================
   VIG — NFL odds proxy (Supabase Edge Function, Deno)

   The browser calls this. This calls The Odds API. The API key stays in
   Edge Function Secrets and is never sent to, or reachable from, a client.

   Deploy:
     supabase functions deploy odds --no-verify-jwt
     supabase secrets set ODDS_API_KEY=...

   --no-verify-jwt is deliberate: the board renders for signed-out visitors,
   so this endpoint has to be public. What protects the quota is not auth but
   the cache — see below.

   QUOTA
   Free tier is 500 credits a month, ~16/day. One call to h2h/us/american is
   one credit. This function never calls upstream just because someone asked:
   it serves `odds_cache` and only refreshes when the row is stale AND the
   day's budget has room. Traffic is therefore decoupled from cost.

   TTL is adaptive. Prices barely move days out and move constantly near
   kickoff, so a game within six hours shortens the TTL; otherwise it stays
   long. When the budget is spent the function serves stale cache and says so
   rather than failing — a slightly old price beats an empty board.
   ============================================================ */

const ODDS_HOST = 'https://api.the-odds-api.com';

/* The Odds API's golf coverage is the four majors only — Masters, PGA
   Championship, US Open, The Open. Regular tour stops, the BMW Championship
   included, are not offered at any plan level. So `?sport=golf` asks the
   catalogue which golf markets are actually live and returns whichever match;
   when none do, it says so plainly. The client must never dress a captured
   price up as a live one. */
const GOLF_PREFIX = 'golf_';
const SPORT = Deno.env.get('ODDS_SPORT') ?? 'americanfootball_nfl';
const REGION = Deno.env.get('ODDS_REGION') ?? 'us';
const MARKETS = 'h2h'; // moneyline only — 1 credit per call

const TTL_NEAR_MS = Number(Deno.env.get('ODDS_TTL_NEAR_MIN') ?? 15) * 60_000;
const TTL_FAR_MS = Number(Deno.env.get('ODDS_TTL_FAR_MIN') ?? 180) * 60_000;
const NEAR_WINDOW_MS = 6 * 60 * 60_000;
const DAILY_CAP = Number(Deno.env.get('ODDS_DAILY_CAP') ?? 15);

/* Origins allowed to call this. Anything else gets no CORS header and the
   browser blocks it. Add a domain here when VIG moves off Pages. */
const ALLOWED = new Set([
  'https://antonp02.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:5173',
]);

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, accept',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && ALLOWED.has(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

/* An upstream error body can echo the query string back, key and all. Nothing
   from upstream is ever forwarded verbatim; this is the belt to that braces. */
function scrub(text: string, key: string): string {
  let out = text.length > 400 ? text.slice(0, 400) + '…' : text;
  if (key) out = out.split(key).join('[redacted]');
  return out.replace(/apiKey=[^&\s"']+/gi, 'apiKey=[redacted]');
}

async function db(path: string, init: RequestInit = {}): Promise<Response> {
  const url = Deno.env.get('SUPABASE_URL')!;
  const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  return await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: svc,
      Authorization: `Bearer ${svc}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

async function readCache(key: string) {
  try {
    const res = await db(`odds_cache?cache_key=eq.${encodeURIComponent(key)}&select=*`);
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch {
    return null;
  }
}

async function writeCache(key: string, payload: unknown, quotaLeft: number | null, note: string) {
  try {
    await db('odds_cache', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        cache_key: key,
        payload,
        fetched_at: new Date().toISOString(),
        upstream_ok: true,
        quota_left: quotaLeft,
        note,
      }),
    });
  } catch (e) {
    console.error('[odds] cache write failed', e);
  }
}

/* Returns the credit number claimed, or null when the day is spent. */
async function claimCredit(): Promise<number | null> {
  try {
    const res = await db('rpc/claim_odds_credit', {
      method: 'POST',
      body: JSON.stringify({ p_cap: DAILY_CAP }),
    });
    if (!res.ok) return null;
    const v = await res.json();
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}

/* How long the cached row stays good, given when the next game starts. */
function ttlFor(payload: unknown): number {
  if (!Array.isArray(payload) || !payload.length) return TTL_NEAR_MS;
  const now = Date.now();
  const soonest = payload
    .map((g: Record<string, unknown>) => Date.parse(String(g?.commence_time ?? '')))
    .filter((t: number) => Number.isFinite(t) && t > now)
    .sort((a: number, b: number) => a - b)[0];
  if (!soonest) return TTL_FAR_MS;
  return soonest - now <= NEAR_WINDOW_MS ? TTL_NEAR_MS : TTL_FAR_MS;
}

/* Ask upstream which sports are in season. Costs no credit. */
async function liveSports(key: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${ODDS_HOST}/v4/sports?apiKey=${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`sports catalogue ${res.status}`);
  return await res.json();
}

/* Golf outrights, if any golf market is live. Returns a status either way so
   the client can tell the difference between "no odds" and "no answer". */
async function golfOutrights(key: string, credit: number, cap: number) {
  const all = await liveSports(key);
  const golf = all.filter((s) => String(s.key ?? '').startsWith(GOLF_PREFIX) && s.active);

  if (!golf.length) {
    return {
      status: 'unavailable',
      reason: 'no_live_golf_market',
      detail: 'The odds provider covers the four majors only; no golf market is live.',
      available: [],
      events: [],
    };
  }

  const events: unknown[] = [];
  let used = credit;
  for (const s of golf) {
    if (used >= cap) break;
    const sk = String(s.key);
    const res = await fetch(
      `${ODDS_HOST}/v4/sports/${sk}/odds?apiKey=${encodeURIComponent(key)}` +
      `&regions=${encodeURIComponent(REGION)}&markets=outrights&oddsFormat=american`,
    );
    used++;
    if (!res.ok) continue;
    const rows = await res.json();
    if (Array.isArray(rows) && rows.length) events.push(...rows);
  }

  return {
    status: events.length ? 'live' : 'unavailable',
    reason: events.length ? null : 'market_returned_empty',
    detail: events.length ? null : 'A golf market is listed but returned no priced outrights.',
    available: golf.map((s) => ({ key: s.key, title: s.title })),
    events,
  };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json', ...cors, ...extra },
    });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'GET') return json({ error: 'method not allowed' }, 405);

  const key = Deno.env.get('ODDS_API_KEY') ?? '';
  if (!key) {
    console.error('[odds] ODDS_API_KEY is not set');
    return json({ error: 'odds feed is not configured' }, 503);
  }

  const sportParam = new URL(req.url).searchParams.get('sport') ?? 'nfl';
  const isGolf = sportParam === 'golf';
  const cacheKey = isGolf ? `golf:${REGION}:outrights` : `${SPORT}:${REGION}:${MARKETS}`;
  const cached = await readCache(cacheKey);
  const age = cached ? Date.now() - Date.parse(cached.fetched_at) : Infinity;
  const ttl = cached ? ttlFor(cached.payload) : 0;

  /* fresh enough — no upstream call, no credit spent */
  if (cached && age < ttl) {
    return json(cached.payload, 200, {
      'X-Odds-Cache': 'hit',
      'X-Odds-Age-Seconds': String(Math.round(age / 1000)),
    });
  }

  /* stale, so try to refresh — but only if the day has budget left */
  const credit = await claimCredit();
  if (credit === null) {
    if (cached) {
      console.warn('[odds] daily cap reached, serving stale cache');
      return json(cached.payload, 200, {
        'X-Odds-Cache': 'stale',
        'X-Odds-Age-Seconds': String(Math.round(age / 1000)),
        'X-Odds-Note': 'daily upstream cap reached',
      });
    }
    return json({ error: 'odds temporarily unavailable', reason: 'daily cap reached' }, 429);
  }

  /* ---- golf takes a different shape: a status object, not a bare array ---- */
  if (isGolf) {
    try {
      const payload = await golfOutrights(key, credit, DAILY_CAP);
      await writeCache(cacheKey, payload, null, `credit ${credit}/${DAILY_CAP} today`);
      return json(payload, 200, {
        'X-Odds-Cache': 'miss',
        'X-Odds-Golf-Status': String(payload.status),
        'X-Odds-Credit-Today': `${credit}/${DAILY_CAP}`,
      });
    } catch (e) {
      console.error('[odds] golf failed', scrub(String(e), key));
      if (cached) {
        return json(cached.payload, 200, { 'X-Odds-Cache': 'stale', 'X-Odds-Note': 'upstream unreachable' });
      }
      return json({
        status: 'unavailable', reason: 'upstream_error',
        detail: 'Could not reach the odds provider.', available: [], events: [],
      }, 200, { 'X-Odds-Golf-Status': 'unavailable' });
    }
  }

  const url =
    `${ODDS_HOST}/v4/sports/${SPORT}/odds` +
    `?apiKey=${encodeURIComponent(key)}` +
    `&regions=${encodeURIComponent(REGION)}` +
    `&markets=${MARKETS}&oddsFormat=american`;

  try {
    const upstream = await fetch(url);
    const quotaLeft = Number(upstream.headers.get('x-requests-remaining') ?? NaN);

    if (!upstream.ok) {
      const body = scrub(await upstream.text(), key);
      console.error('[odds] upstream', upstream.status, body);
      if (cached) {
        return json(cached.payload, 200, {
          'X-Odds-Cache': 'stale',
          'X-Odds-Note': `upstream ${upstream.status}`,
        });
      }
      return json({ error: 'upstream error', status: upstream.status }, 502);
    }

    const data = await upstream.json();
    const count = Array.isArray(data) ? data.length : 0;
    await writeCache(cacheKey, data, Number.isFinite(quotaLeft) ? quotaLeft : null,
      `credit ${credit}/${DAILY_CAP} today`);

    console.log(`[odds] refreshed: ${count} games, credit ${credit}/${DAILY_CAP}, quota left ${quotaLeft}`);
    return json(data, 200, {
      'X-Odds-Cache': 'miss',
      'X-Odds-Quota-Remaining': Number.isFinite(quotaLeft) ? String(quotaLeft) : 'unknown',
      'X-Odds-Credit-Today': `${credit}/${DAILY_CAP}`,
    });
  } catch (e) {
    console.error('[odds] fetch failed', scrub(String(e), key));
    if (cached) {
      return json(cached.payload, 200, { 'X-Odds-Cache': 'stale', 'X-Odds-Note': 'upstream unreachable' });
    }
    return json({ error: 'odds feed unreachable' }, 502);
  }
});
