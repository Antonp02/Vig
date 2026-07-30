/* Vercel serverless function — keeps the API key server-side.
   The browser never sees it. Set ODDS_API_KEY in your Vercel
   project settings (Settings -> Environment Variables). */

const SPORT = process.env.ODDS_SPORT || 'americanfootball_nfl';
const REGION = 'us';
const MARKETS = 'h2h';        // moneyline only = 1 credit per call

/* The Odds API free tier is 500 credits/month and one call costs
   markets x regions. A 2-hour edge cache means ~12 calls/day
   (~360/month) no matter how much traffic the site gets.
   On a paid plan, drop this to 300. */
const CACHE_SECONDS = 7200;

export default async function handler(req, res) {
  const key = process.env.ODDS_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'ODDS_API_KEY is not configured' });
  }

  const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds`
    + `?apiKey=${encodeURIComponent(key)}`
    + `&regions=${REGION}&markets=${MARKETS}&oddsFormat=american`;

  try {
    const upstream = await fetch(url);
    const remaining = upstream.headers.get('x-requests-remaining');
    const used = upstream.headers.get('x-requests-used');

    if (!upstream.ok) {
      const body = await upstream.text();
      console.error('[odds] upstream error', upstream.status, body.slice(0, 200));
      return res.status(502).json({ error: 'upstream error', status: upstream.status });
    }

    const data = await upstream.json();

    res.setHeader('Cache-Control',
      `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 2}`);
    if (remaining) res.setHeader('X-Odds-Quota-Remaining', remaining);
    if (used) res.setHeader('X-Odds-Quota-Used', used);

    /* Watch your quota in the response headers while testing. */
    console.log(`[odds] ${Array.isArray(data) ? data.length : 0} games, quota left: ${remaining}`);
    return res.status(200).json(data);
  } catch (err) {
    console.error('[odds] fetch failed', err);
    return res.status(502).json({ error: 'fetch failed' });
  }
}
