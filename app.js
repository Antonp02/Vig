/* ============================================================
   VIG Mock Sportsbook — v0.8
   Weekly bankroll cycles, multi-book odds, probability-spaced
   Line Winder, Trending Sports board.
   ============================================================ */

/* Build stamp. Every "is this device on the new code?" question has cost a
   round trip; now it is on screen. Bumped with the service worker cache. */
const VIG_BUILD = 'v1.7.6';

/* ---------- 0. Persistence ---------- */
const KEYS = {
  week:      'vig.v2.week',
  results:   'vig.v2.results',
  snapshots: 'vig.v2.snapshots',
  drafts:    'vig.v2.drafts',
  mode:      'vig.v2.mode',            // legacy, migrated away in v1.7.4
  modeOverride: 'vig.v2.mode.override',
  modeMigrated: 'vig.v2.mode.migrated171',
  golf:      'vig.v2.golf',
  golfStake: 'vig.v2.golfStake',
  identity:  'vig.v2.identity',
  lifetime:  'vig.v2.lifetime',
  outbox:    'vig.v2.outbox',
  rejected:  'vig.v2.rejected',
  avatar:    'vig.v2.avatar'
};

const Store = (() => {
  let usable = false;
  const mem = {};
  try {
    window.localStorage.setItem('__vig__', '1');
    window.localStorage.removeItem('__vig__');
    usable = true;
  } catch (e) { usable = false; }
  return {
    persistent: usable,
    get(key, fallback) {
      try {
        const raw = usable ? window.localStorage.getItem(key) : mem[key];
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try {
        const raw = JSON.stringify(value);
        if (usable) window.localStorage.setItem(key, raw); else mem[key] = raw;
      } catch (e) {}
    },
    remove(key) {
      try { if (usable) window.localStorage.removeItem(key); else delete mem[key]; } catch (e) {}
    },
    reset() {
      Object.values(KEYS).forEach(k => {
        try { if (usable) window.localStorage.removeItem(k); else delete mem[k]; } catch (e) {}
      });
    }
  };
})();

/* ---------- 1. Odds math ------------------------------------
   FIX v0.8: American odds are always <= -100 or >= +100.
   A malformed feed value used to produce an Infinity payout.
------------------------------------------------------------ */
const MIN_ABS_ODDS = 100;

function validOdds(v) {
  return typeof v === 'number' && isFinite(v) && Math.abs(v) >= MIN_ABS_ODDS;
}

function fmtOdds(o) {
  if (!validOdds(o)) return '—';
  return o > 0 ? `+${o}` : `${o}`;
}

function decimalOdds(american) {
  if (!validOdds(american)) return NaN;
  return american > 0 ? 1 + american / 100 : 1 + 100 / Math.abs(american);
}

function impliedProb(american) {
  if (!validOdds(american)) return NaN;
  return american > 0
    ? 100 / (american + 100)
    : Math.abs(american) / (Math.abs(american) + 100);
}

/* ---- de-vigging -----------------------------------------------------
   Removing the book's margin to estimate what the market believes.
   Neither method is "the" true probability — both rest on an assumption
   about how the book spread its margin across outcomes.

   proportional : divide each implied probability by the overround.
                  Simple and ancient, but biased: it over-rates longshots
                  and under-rates favourites.
   power        : solve for k where sum(p^k) = 1. Handles that
                  favourite-longshot bias far better, which matters most
                  in fat-margin markets with many outcomes — golf
                  outrights being the obvious case.
--------------------------------------------------------------------- */
const DEVIG_METHOD = 'power';
function round4(n) { return Math.round(n * 10000) / 10000; }

function devigProportional(prices) {
  const raw = prices.map(impliedProb);
  const total = raw.reduce((a, b) => a + b, 0);
  return total > 0 ? raw.map(p => p / total) : raw.map(() => 1 / raw.length);
}

function devigPower(prices) {
  const raw = prices.map(impliedProb);
  if (!raw.length) return [];
  let lo = 0.5, hi = 3.0;
  for (let i = 0; i < 60; i++) {
    const k = (lo + hi) / 2;
    if (raw.reduce((a, p) => a + Math.pow(p, k), 0) > 1) lo = k; else hi = k;
  }
  const k = (lo + hi) / 2;
  const out = raw.map(p => Math.pow(p, k));
  const total = out.reduce((a, b) => a + b, 0);
  return total > 0 ? out.map(p => p / total) : out;
}

/* Fair probability of one selection within its market. The method used is
   recorded alongside the number so changing the default later never
   silently rewrites history. */
function fairProbability(prices, index, method) {
  const fn = (method || DEVIG_METHOD) === 'proportional' ? devigProportional : devigPower;
  const v = fn(prices)[index];
  return (typeof v === 'number' && isFinite(v) && v > 0 && v < 1) ? round4(v) : null;
}

/* Strip the book's margin from a two-way market so the pair sums to 1.
   Used by Line Winder's probability axis. */
function devigPair(a, b) {
  const pa = impliedProb(a), pb = impliedProb(b);
  const total = pa + pb;
  return total > 0 ? [pa / total, pb / total] : [0.5, 0.5];
}

function americanFromDecimal(d) {
  if (!isFinite(d) || d <= 1) return NaN;
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

function americanFromProb(p) {
  if (!(p > 0 && p < 1)) return NaN;
  return p >= 0.5 ? Math.round(-100 * p / (1 - p)) : Math.round(100 * (1 - p) / p);
}

function money(n) {
  const v = isFinite(n) ? n : 0;
  return `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

const round2 = n => Math.round(n * 100) / 100;
const median = arr => {
  const s = arr.filter(v => isFinite(v)).slice().sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/* ---------- 2. Weekly cycle ---------------------------------
   Bankroll resets to $1,000 every Monday 00:00 America/New_York.
   Week identity is the ET Monday date, so it is stable no matter
   what timezone the player is sitting in.
------------------------------------------------------------ */
/* Paused during the private test so a rollover cannot wipe results
   mid-session. The admin panel exposes Finalize Week / Start New Week
   instead. Flip to true for normal operation. */
/* v1.7.5: ON. This was false through development so a week never rolled out
   from under a test in progress. That is exactly why the bankroll did not reset
   on Tuesday — ensureWeek() computed the new week correctly and then declined to
   act on it. The board is real now and the reset has to be automatic, because a
   competition that only advances when the owner remembers to press a button is
   not a weekly competition. */
const AUTO_ROLLOVER = true;

const WEEKLY_BANKROLL = 1000;
const WEEKLY_BET_LIMIT = 25;
/* The competition week is anchored to Eastern so the label is unambiguous.
   Tuesday 04:00 ET is after Monday Night Football ends and well before Thursday
   kickoff, so an NFL week (Thu -> Mon night) never straddles two competition
   weeks. Golf runs Thu-Sun, clear of it too. */
const RESET_TZ = 'America/New_York';
/* An NFL week runs Thursday -> Monday night. A Monday 00:00 boundary split it
   in half, dropping Monday Night Football into the following VIG week. The
   reset is Tuesday 04:00 America/New_York: after MNF ends, before Thursday
   kickoff, and the same place real fantasy leagues process waivers.

   v1.7.0 moved this from 02:00 Pacific (= 05:00 Eastern) to 04:00 Eastern.
   Anchoring to Eastern rather than Pacific means the boundary is stated in the
   zone the league actually lives in, and DST is handled by the same tzParts()
   path either way. The shift is one hour, so the resulting week key is
   unchanged except for tickets placed between 04:00 and 05:00 Eastern on a
   Tuesday — a window with no games in it. */
const RESET_DOW = 2;        // 0=Sun, 2=Tue
const RESET_HOUR = 4;       // 04:00 Eastern
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function tzParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: RESET_TZ, weekday: 'short', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  return {
    year: +parts.year, month: +parts.month, day: +parts.day,
    hour: +parts.hour % 24, minute: +parts.minute, second: +parts.second,
    weekday: parts.weekday,
    dow: Math.max(0, DOW.indexOf(parts.weekday))
  };
}

/* Tuesday-of-week key, e.g. "2026-07-28". Times before 04:00 ET belong to the
   previous day, so Monday 23:00 still resolves to the prior Tuesday. */
function weekKeyFor(date = new Date()) {
  const p = tzParts(date);
  let base = Date.UTC(p.year, p.month - 1, p.day);
  let dow = p.dow;
  if (p.hour < RESET_HOUR) {                    // still "yesterday" for us
    base -= 864e5;
    dow = (dow + 6) % 7;
  }
  const daysSinceReset = (dow - RESET_DOW + 7) % 7;
  const d = new Date(base - daysSinceReset * 864e5);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/* Absolute instant of the next Tuesday 04:00 ET, DST-corrected. */
function nextResetAt(now = new Date()) {
  const p = tzParts(now);
  let dow = p.dow;
  let hoursIntoDay = p.hour - RESET_HOUR;
  if (hoursIntoDay < 0) { hoursIntoDay += 24; dow = (dow + 6) % 7; }
  const daysSinceReset = (dow - RESET_DOW + 7) % 7;
  const elapsedMs = ((daysSinceReset * 24 + hoursIntoDay) * 60 + p.minute) * 60000
                    + p.second * 1000;
  let candidate = new Date(now.getTime() + (7 * 864e5 - elapsedMs));
  const cp = tzParts(candidate);
  if (cp.hour !== RESET_HOUR) {                       // clocks shifted mid-week
    let diff = cp.hour - RESET_HOUR;
    if (diff > 12) diff -= 24; else if (diff < -12) diff += 24;
    candidate = new Date(candidate.getTime() - diff * 36e5);
  }
  return candidate;
}

function fmtCountdown(ms) {
  if (ms <= 0) return 'now';
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function blankWeek(key) {
  return { key, bankroll: WEEKLY_BANKROLL, tickets: [], history: [WEEKLY_BANKROLL] };
}

/* ---------- 3. Week-scoped stats (FIX v0.8) -----------------
   v0.7 subtracted every stake from returns, so a pending bet
   read as a loss. Realized P/L now only counts settled tickets
   and open stake is reported separately as exposure.
------------------------------------------------------------ */
function weekStats(w) {
  /* FIX: week.bankroll is a cache, and any path that changed a ticket status
     without recalculating left it stale — a settled bet could leave the stored
     figure 34.50 adrift from the truth. Derive it here so no consumer can ever
     read a stale number; the stored value is now only a persistence
     convenience. */
  if (w && w.tickets) {
    const fresh = derivedBankroll(w);
    if (Math.abs((w.bankroll || 0) - fresh) > 0.001) w.bankroll = fresh;
  }
  const t = w.tickets;
  /* 'void' is neither a win nor a loss — its stake was refunded, so it must be
     excluded from P/L, hit rate and risked or it reads as a loss. */
  const graded = t.filter(x => x.status === 'won' || x.status === 'lost');
  const open = t.filter(x => x.status === 'open');
  /* push and void both return the stake untouched, so neither belongs in
     profit, hit rate or amount risked */
  const voided = t.filter(x => x.status === 'void' || x.status === 'push');
  const returned = graded.reduce((a, x) => a + realizedReturn(x), 0);
  const gradedStake = graded.reduce((a, x) => a + x.stake, 0);
  const wins = graded.filter(x => x.status === 'won').length;
  return {
    betsUsed: t.length,
    betsLeft: Math.max(0, WEEKLY_BET_LIMIT - t.length),
    risked: round2(gradedStake + open.reduce((a, x) => a + x.stake, 0)),
    atRisk: round2(open.reduce((a, x) => a + x.stake, 0)),
    openCount: open.length,
    voidCount: voided.length,
    realizedPL: round2(returned - gradedStake),
    hitRate: graded.length ? Math.round(wins / graded.length * 100) : 0,
    settledCount: graded.length,
    /* return on the money actually resolved — undefined before anything settles */
    roi: gradedStake > 0 ? round2(100 * (returned - gradedStake) / gradedStake) : null,
    wagered: round2(gradedStake),
    bankroll: round2(w.bankroll)
  };
}

/* ---------- 4. Data layer, multi-book -----------------------
   FIX v0.8: v0.7 read bookmakers[0] and threw the rest away.
   The Odds API charges markets x regions, so every book in a
   region arrives at no extra credit cost. Now we keep them all.
     game.home.prices = [{book, title, price}, ...]
------------------------------------------------------------ */
const BOOK_LABELS = {
  draftkings: 'DraftKings', fanduel: 'FanDuel', betmgm: 'BetMGM',
  williamhill_us: 'Caesars', pointsbetus: 'PointsBet', betrivers: 'BetRivers',
  bovada: 'Bovada', mybookieag: 'MyBookie', lowvig: 'LowVig', betonlineag: 'BetOnline'
};

const MOCK_BOOKS = [
  { book: 'draftkings', title: 'DraftKings' }, { book: 'fanduel', title: 'FanDuel' },
  { book: 'betmgm', title: 'BetMGM' },        { book: 'williamhill_us', title: 'Caesars' }
];

/* Deterministic jitter so mock books disagree consistently. */
function seeded(seedStr) {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return () => {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    return h / 4294967296;
  };
}

function spreadAcrossBooks(basePrice, seedStr) {
  const rand = seeded(seedStr);
  return MOCK_BOOKS.map(b => {
    const nudge = Math.round((rand() - 0.5) * 16);       // +/- 8 cents of juice
    let p = basePrice + nudge;
    if (Math.abs(p) < MIN_ABS_ODDS) p = p >= 0 ? MIN_ABS_ODDS : -MIN_ABS_ODDS;
    return { book: b.book, title: b.title, price: p };
  });
}

const MOCK_BASE = [
  ['buf-mia', 'Thu 8:15 PM', ['BUF', 'Buffalo Bills', -125], ['MIA', 'Miami Dolphins', 105]],
  ['dal-phi', 'Sun 4:25 PM', ['DAL', 'Dallas Cowboys', 135], ['PHI', 'Philadelphia Eagles', -155]],
  ['kc-bal',  'Sun 8:20 PM', ['KC', 'Kansas City Chiefs', -118], ['BAL', 'Baltimore Ravens', -102]],
  ['sf-sea',  'Mon 8:15 PM', ['SF', 'San Francisco 49ers', -145], ['SEA', 'Seattle Seahawks', 125]],
  ['gb-det',  'Sun 1:00 PM', ['GB', 'Green Bay Packers', 110], ['DET', 'Detroit Lions', -130]],
  ['cin-cle', 'Sun 1:00 PM', ['CIN', 'Cincinnati Bengals', -165], ['CLE', 'Cleveland Browns', 140]]
];

/* The fallback ladder, best first:
     1. live feed
     2. the captured slate — real teams, real transcribed prices
     3. MOCK_BASE — invented games, only if no slate loaded

   v1.7.4: step 2 was missing. A failing feed dropped straight to invented
   fixtures even though a captured board of the actual week's games was sitting
   in memory. Real games at a slightly old price beat imaginary games. */
function fallbackGames() {
  const slate = (typeof RealBoard !== 'undefined') ? RealBoard.upcoming() : [];
  if (!slate.length) return mockGames();
  return slate.map(g => ({
    id: g.gameId,
    commence: g.kickoff,
    away: { abbr: g.away, name: NFL_NAMES[g.away] || g.away,
            prices: [{ title: 'Captured', price: g.current.mlAway }] },
    home: { abbr: g.home, name: NFL_NAMES[g.home] || g.home,
            prices: [{ title: 'Captured', price: g.current.mlHome }] }
  }));
}

function mockGames() {
  return MOCK_BASE.map(([id, commence, away, home]) => ({
    id, commence,
    away: { abbr: away[0], name: away[1], prices: spreadAcrossBooks(away[2], id + away[0]) },
    home: { abbr: home[0], name: home[1], prices: spreadAcrossBooks(home[2], id + home[0]) }
  }));
}

/* ---------- Trending Sports (replaces the Golf tab) ----------
   Golf / tennis / soccer outrights. `fair` is a simulated
   no-vig reference price; when the offered number is longer
   than fair we flag it as value on the board.
------------------------------------------------------------ */
const TRENDING = [
  /* Golf rows are loaded from data/golf-outrights.json at boot — see
     GolfOutrights.install(). The Open and FedEx St. Jude have both been played;
     hardcoding a finished tournament is how a board goes stale. */
  { id: 'tn-1', category: 'tennis', event: 'US Open',             title: 'Carlos Alcaraz to win title',   odds: 240,  fair: 225 },
  { id: 'tn-2', category: 'tennis', event: 'US Open',             title: 'Jannik Sinner to win title',    odds: 275,  fair: 300 },
  { id: 'tn-3', category: 'tennis', event: 'US Open',             title: 'Coco Gauff to win title',       odds: 550,  fair: 500 },
  { id: 'tn-4', category: 'tennis', event: 'Cincinnati Masters',  title: 'Alcaraz to reach the final',    odds: -130, fair: -140 },
  { id: 'sc-1', category: 'soccer', event: 'Premier League',      title: 'Arsenal to win the league',     odds: 260,  fair: 250 },
  { id: 'sc-2', category: 'soccer', event: 'Premier League',      title: 'Man City to win the league',    odds: 175,  fair: 190 },
  { id: 'sc-3', category: 'soccer', event: 'Champions League',    title: 'Real Madrid to lift the trophy',odds: 600,  fair: 575 },
  { id: 'sc-4', category: 'soccer', event: 'Champions League',    title: 'Liverpool to reach semi-finals',odds: 145,  fair: 160 },
  { id: 'fx-1', category: 'fantasy', event: 'Your league',        title: 'Lamar Jackson over 21.5 fantasy pts', odds: -115, fair: -120 },
  { id: 'fx-2', category: 'fantasy', event: 'Your league',        title: 'Breece Hall outscores opponent RB1',  odds: 125,  fair: 118 },
  { id: 'fx-3', category: 'fantasy', event: 'Your league',        title: 'Antonio wins fantasy matchup',        odds: -135, fair: -145 }
];

/* Value = offered price pays more than the fair reference. */
function edgePoints(m) {
  const offered = impliedProb(m.odds), fair = impliedProb(m.fair);
  if (!isFinite(offered) || !isFinite(fair)) return 0;
  return round2((fair - offered) * 100);
}

const NFL_ABBR = {
  'Arizona Cardinals':'ARI','Atlanta Falcons':'ATL','Baltimore Ravens':'BAL','Buffalo Bills':'BUF',
  'Carolina Panthers':'CAR','Chicago Bears':'CHI','Cincinnati Bengals':'CIN','Cleveland Browns':'CLE',
  'Dallas Cowboys':'DAL','Denver Broncos':'DEN','Detroit Lions':'DET','Green Bay Packers':'GB',
  'Houston Texans':'HOU','Indianapolis Colts':'IND','Jacksonville Jaguars':'JAX','Kansas City Chiefs':'KC',
  'Las Vegas Raiders':'LV','Los Angeles Chargers':'LAC','Los Angeles Rams':'LAR','Miami Dolphins':'MIA',
  'Minnesota Vikings':'MIN','New England Patriots':'NE','New Orleans Saints':'NO','New York Giants':'NYG',
  'New York Jets':'NYJ','Philadelphia Eagles':'PHI','Pittsburgh Steelers':'PIT','San Francisco 49ers':'SF',
  'Seattle Seahawks':'SEA','Tampa Bay Buccaneers':'TB','Tennessee Titans':'TEN','Washington Commanders':'WAS'
};

const abbrev = n => NFL_ABBR[n] || n.split(' ').pop().slice(0, 3).toUpperCase();
/* inverted so "bills" and "buffalo" both find BUF players in the draft pool */
const ABBR_TO_NAME = Object.keys(NFL_ABBR)
  .reduce((acc, full) => (acc[NFL_ABBR[full]] = full, acc), {});
const POS_ALIASES = {
  QB: 'qb quarterback', RB: 'rb runningback running back', WR: 'wr wide receiver widereceiver',
  TE: 'te tightend tight end', DST: 'dst def defense dst dst', K: 'k kicker pk'
};
const norm = s => String(s || '').toLowerCase().normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

function fmtKickoff(iso) {
  try {
    return new Date(iso).toLocaleString(undefined,
      { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  } catch (e) { return 'TBD'; }
}

function normalizeOddsApi(payload) {
  if (!Array.isArray(payload)) return [];
  return payload.map(ev => {
    const collect = teamName => {
      const out = [];
      (ev.bookmakers || []).forEach(bk => {
        const mk = (bk.markets || []).find(m => m.key === 'h2h');
        const oc = mk && (mk.outcomes || []).find(o => o.name === teamName);
        if (oc && validOdds(oc.price)) {
          out.push({ book: bk.key, title: bk.title || BOOK_LABELS[bk.key] || bk.key, price: oc.price });
        }
      });
      return out;
    };
    if (!ev.home_team || !ev.away_team) return null;
    const home = collect(ev.home_team), away = collect(ev.away_team);
    if (!home.length || !away.length) return null;
    return {
      id: ev.id,
      commence: fmtKickoff(ev.commence_time),
      away: { abbr: abbrev(ev.away_team), name: ev.away_team, prices: away },
      home: { abbr: abbrev(ev.home_team), name: ev.home_team, prices: home }
    };
  }).filter(Boolean);
}

/* Consensus = median implied probability across books, back to
   American. Best = the price paying the most (lowest implied). */
function consensusPrice(team) {
  const p = median(team.prices.map(x => impliedProb(x.price)));
  return isFinite(p) ? americanFromProb(p) : NaN;
}

function bestPrice(team) {
  return team.prices.reduce((best, x) =>
    (!best || impliedProb(x.price) < impliedProb(best.price)) ? x : best, null);
}

function bookSpread(team) {
  const probs = team.prices.map(x => impliedProb(x.price)).filter(isFinite);
  if (probs.length < 2) return 0;
  return round2((Math.max(...probs) - Math.min(...probs)) * 100);
}

/* ---------- Data source mode (v1.7.4) ----------------------------
   What the deploy says, unless this device deliberately said otherwise.

   VIG_CONFIG.DATA_SOURCE is the production switch: change it, push, and every
   visitor follows on their next load. 'live' is the default when the key is
   absent, so a config that predates this release still turns the feed on.
------------------------------------------------------------------ */
function configuredDataMode() {
  const v = String(((window.VIG_CONFIG || {}).DATA_SOURCE || 'live')).toLowerCase();
  return v === 'mock' ? 'mock' : 'live';
}

function resolveDataMode() {
  const o = Store.get(KEYS.modeOverride, null);
  if (o && (o.mode === 'live' || o.mode === 'mock')) return o.mode;
  return configuredDataMode();
}

/* One-time, idempotent. Everyone who used VIG before v1.7.4 has
   vig.v2.mode = 'mock' sitting in localStorage — not because they chose it, but
   because that was the old default. Left alone it would pin them to simulated
   prices permanently. So the legacy key is retired: a stored 'live' is honoured
   as a real choice, a stored 'mock' is treated as the old default and dropped.

   An admin who genuinely wants Mock re-selects it and gets a proper override. */
function migrateDataMode() {
  if (Store.get(KEYS.modeMigrated, false)) return null;
  const legacy = Store.get(KEYS.mode, null);
  let action = 'none';
  if (legacy === 'live') {
    Store.set(KEYS.modeOverride, { mode: 'live', at: new Date().toISOString(), by: 'migration' });
    action = 'kept-live';
  } else if (legacy === 'mock') {
    action = 'dropped-stale-mock';       // fall through to the configured default
  }
  Store.remove(KEYS.mode);
  Store.set(KEYS.modeMigrated, true);
  if (action !== 'none') console.info(`[VIG] data mode migration: ${action}`);
  return action;
}

migrateDataMode();

const DataSource = {
  /* v1.7.4: the mode used to be read straight from localStorage with a 'mock'
     default, which made it a per-browser setting. Switching the admin device to
     Live left every other user, and every other device, on simulated prices
     forever — there was no way to turn the product on.

     Now: the shipped config decides the default for everybody, and a stored
     override exists only when someone deliberately set one. Clearing the
     override returns that device to whatever the deploy says. */
  mode: resolveDataMode(),
  lastMeta: null,
  /* The Supabase Edge Function, when Supabase is configured. The API key lives
     in Edge Function Secrets and never reaches this file — the browser only
     ever sees the odds payload. Falls back to a same-origin `api/odds` so a
     Vercel deployment still works; on GitHub Pages that path 404s, which the
     caller already handles by dropping back to the simulated board. */
  endpoint() {
    const url = ((window.VIG_CONFIG || {}).SUPABASE_URL || '').trim().replace(/\/$/, '');
    return url ? `${url}/functions/v1/odds` : 'api/odds';
  },
  async fetchGames() {
    if (this.mode !== 'live') return fallbackGames();
    const ep = this.endpoint();
    const headers = { accept: 'application/json' };
    /* Supabase's gateway wants an apikey header even on a public function. The
       anon key is public by design; the odds key is what must stay hidden. */
    const anon = ((window.VIG_CONFIG || {}).SUPABASE_ANON_KEY || '').trim();
    if (anon && ep.includes('/functions/v1/')) {
      headers.apikey = anon;
      headers.Authorization = `Bearer ${anon}`;
    }
    const res = await fetch(ep, { headers });
    if (!res.ok) throw new Error(`odds proxy returned ${res.status}`);
    this.lastMeta = {
      cache: res.headers.get('x-odds-cache'),
      ageSeconds: Number(res.headers.get('x-odds-age-seconds')) || 0,
      quotaLeft: res.headers.get('x-odds-quota-remaining'),
      creditToday: res.headers.get('x-odds-credit-today'),
      note: res.headers.get('x-odds-note')
    };
    const games = normalizeOddsApi(await res.json());
    if (!games.length) throw new Error('feed returned no priced games');
    return games;
  },
  /* An explicit choice, remembered on this device only. */
  setMode(m, opts) {
    this.mode = (m === 'live') ? 'live' : 'mock';
    Store.set(KEYS.modeOverride, { mode: this.mode, at: new Date().toISOString(),
                                   by: (opts && opts.by) || 'admin' });
    Store.remove(KEYS.mode);
    return this.mode;
  },
  /* Drop back to the deployed default. */
  clearMode() {
    Store.remove(KEYS.modeOverride);
    Store.remove(KEYS.mode);
    this.mode = resolveDataMode();
    return this.mode;
  },
  isOverridden() { return !!Store.get(KEYS.modeOverride, null); },
  configuredDefault() { return configuredDataMode(); }
};

/* Board rows. Consensus is the bettable price; best price is
   shown alongside so the shopping value is visible. */
function marketsFromGames(list) {
  const rows = [];
  list.forEach(g => {
    [['away', g.away, g.home], ['home', g.home, g.away]].forEach(([side, team, opp]) => {
      const consensus = consensusPrice(team);
      const best = bestPrice(team);
      if (!validOdds(consensus)) return;
      rows.push({
        id: `${g.id}:${team.abbr}`,
        gameId: g.id, category: 'nfl',
        title: `${team.name} moneyline`,
        detail: `${side === 'away' ? `${team.abbr} at ${opp.abbr}` : `${team.abbr} vs. ${opp.abbr}`} · ${g.commence}`,
        odds: consensus,
        best: best ? best.price : consensus,
        bestBook: best ? best.title : '',
        bookCount: team.prices.length,
        spread: bookSpread(team)
      });
    });
  });
  TRENDING.forEach(m => rows.push({
    id: m.id, gameId: null, category: m.category,
    title: m.title, detail: m.event, odds: m.odds,
    best: m.odds, bestBook: '', bookCount: 1, spread: 0,
    edge: edgePoints(m), event: m.event
  }));
  return rows;
}

/* ---------- Golf outrights (v1.6.9) --------------------------------
   A real outright board. Every golfer is one selection at one price:
   to win the tournament, nothing else. They enter TRENDING, so the
   parlay builder, trending panel and bet slip pick them up with no
   special-casing — a golfer is just another leg.
------------------------------------------------------------------- */
const GolfOutrights = {
  data: null,
  async load() {
    if (this.data) return this.data;
    if (window.VIG_GOLF_OUTRIGHTS) { this.data = window.VIG_GOLF_OUTRIGHTS; return this.data; }
    const res = await fetch('data/golf-outrights.json');
    if (!res.ok) throw new Error(`golf outrights ${res.status}`);
    this.data = await res.json();
    return this.data;
  },
  selections() {
    const m = this.data && this.data.markets && this.data.markets[0];
    return (m && m.selections) || [];
  },
  eventLabel() {
    const d = this.data;
    return d ? `${d.name} · ${fmtEventDate(d.startTime)}` : 'Golf';
  },
  isOpen() {
    const d = this.data;
    if (!d || !d.lockTime) return true;
    return Date.now() < new Date(d.lockTime).getTime();
  },
  /* Live provenance. The odds provider covers the four majors only, so for a
     regular tour stop like the BMW the honest answer is "these are captured
     prices, from this date" — never a captured price wearing a live badge. */
  live: { status: 'unknown', reason: null, detail: null, checkedAt: null },

  async checkLive() {
    const base = ((window.VIG_CONFIG || {}).SUPABASE_URL || '').trim().replace(/\/$/, '');
    if (!base) { this.live = { status: 'unavailable', reason: 'not_configured',
      detail: 'No odds proxy configured.', checkedAt: Date.now() }; return this.live; }
    const anon = ((window.VIG_CONFIG || {}).SUPABASE_ANON_KEY || '').trim();
    try {
      const res = await fetch(`${base}/functions/v1/odds?sport=golf`,
        { headers: { accept: 'application/json', apikey: anon, Authorization: `Bearer ${anon}` } });
      if (!res.ok) throw new Error(`proxy ${res.status}`);
      const body = await res.json();
      const matched = this.matchEvent(body);
      /* A match only counts if the data file is a feed. A manual snapshot stays a
         manual snapshot even if some other golf market happens to be live. */
      this.live = {
        status: (matched && this.provenance().isLive) ? 'live' : 'unavailable',
        reason: matched ? null : (body.reason || 'event_not_covered'),
        detail: matched ? null : (body.detail ||
          'The odds provider covers the four majors only, so this event has no live market.'),
        checkedAt: Date.now()
      };
      if (matched) this.applyLive(matched);
    } catch (e) {
      this.live = { status: 'unavailable', reason: 'proxy_error',
        detail: 'Could not reach the odds proxy.', checkedAt: Date.now() };
    }
    renderTrending();
    renderOtherSports();
    return this.live;
  },

  /* Does any live golf event actually match the board we are showing? */
  matchEvent(body) {
    const events = (body && body.events) || [];
    if (!events.length || !this.data) return null;
    const want = String(this.data.name || '').toLowerCase();
    return events.find(e => {
      const title = String(e.sport_title || '').toLowerCase();
      return want && (title.includes(want) || want.includes(title.replace(/ winner$/, '')));
    }) || null;
  },

  /* Replace captured prices with the provider's consensus, where we have one. */
  applyLive(event) {
    const prices = {};
    ((event.bookmakers || [])[0] || {}).markets?.forEach(m => {
      (m.outcomes || []).forEach(o => { if (validOdds(o.price)) prices[o.name] = o.price; });
    });
    this.selections().forEach(s => { if (prices[s.name]) s.americanOdds = prices[s.name]; });
    this.install();
  },

  /* Where the prices came from, stated plainly.

     The word "live" is reserved. It appears only when provenance.isLive is true,
     which only a real feed sets. A hand-transcribed book snapshot says whose book
     and when, and nothing more — so the two can never be confused.

     TO SWAP IN A FEED LATER: set provenance.kind to "feed" and isLive to true in
     the data file. Nothing downstream reads anything but label / displayUpdated /
     isLive, so no code has to change. */
  provenance() {
    const p = (this.data && this.data.provenance) || {};
    return {
      kind: p.kind || 'manual-snapshot',
      label: p.label || 'Manual snapshot',
      updated: p.displayUpdated || '',
      isLive: p.isLive === true
    };
  },

  marketLabel() {
    const d = this.data;
    return (d && (d.marketLabel || d.name)) || 'Outrights';
  },

  statusLine() {
    const p = this.provenance();
    if (p.isLive) return { tone: 'live', label: p.label, text: p.updated || 'Live prices from the odds feed.' };
    return { tone: 'snapshot', label: p.label, text: p.updated };
  },

  /* Splice into TRENDING, replacing whatever golf rows are there. */
  install() {
    const rows = this.selections().map(s => ({
      id: `go-${s.selectionId}`,
      category: 'golf',
      event: this.eventLabel(),
      title: `${s.name} to win`,
      odds: s.americanOdds,
      fair: validOdds(s.fairOdds) ? s.fairOdds : s.americanOdds
    }));
    for (let i = TRENDING.length - 1; i >= 0; i--) {
      if (TRENDING[i].category === 'golf') TRENDING.splice(i, 1);
    }
    TRENDING.unshift(...rows);

    /* `markets` is built from TRENDING once, at board refresh, and the outright
       file loads after that — so without this the rows exist in TRENDING and the
       Trending panel still renders an empty golf section. Mirror the same shape
       marketsFromGames() produces rather than forcing a whole board rebuild. */
    if (Array.isArray(markets)) {
      for (let i = markets.length - 1; i >= 0; i--) {
        if (markets[i].category === 'golf') markets.splice(i, 1);
      }
      markets.push(...rows.map(m => ({
        id: m.id, gameId: null, category: m.category,
        title: m.title, detail: m.event, odds: m.odds,
        best: m.odds, bestBook: '', bookCount: 1, spread: 0,
        edge: edgePoints(m), event: m.event
      })));
    }
    return rows.length;
  }
};

/* ---------- 4b. Real Week 1 board (v1.5.3) --------------------------
   Real ESPN numbers with both the opening and current line, so the move
   between them is genuine rather than generated. Replaces the simulated
   board for NFL. Everything downstream — parlay builder, home cards,
   trending — consumes the same market shape as before.

   What is real here: current moneyline, current and opening spread,
   current and opening total. What is NOT: an opening moneyline, which
   the source did not carry. So no moneyline "open" is invented.
------------------------------------------------------------------- */
/* Slates in the order they happen. The board shows the earliest one that
   still has a game left to play, so it moves from preseason to Week 1 on its
   own rather than needing a deploy on the right morning. */
const BOARD_SLATES = [
  { file: 'data/nfl-2026-preseason-w2.json', global: 'VIG_NFL_PRESEASON_W2' },
  { file: 'data/nfl-2026-week1.json',        global: 'VIG_NFL_WEEK1' }
];

const RealBoard = {
  data: null,
  async load() {
    if (this.data) return this.data;
    const loaded = [];
    for (const s of BOARD_SLATES) {
      if (window[s.global]) { loaded.push(window[s.global]); continue; }
      try {
        const res = await fetch(s.file);
        if (res.ok) loaded.push(await res.json());
      } catch (e) { /* a missing slate is not fatal; try the next */ }
    }
    if (!loaded.length) throw new Error('no board data');
    const now = Date.now();
    const live = loaded.find(d => (d.games || []).some(g => new Date(g.kickoff).getTime() > now));
    this.data = live || loaded[loaded.length - 1];
    return this.data;
  },
  label() { return (this.data && this.data.label) || 'NFL'; },
  /* Games that have not kicked off, soonest first. */
  upcoming() {
    const now = Date.now();
    return this.games().filter(g => new Date(g.kickoff).getTime() > now)
      .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  },
  games() { return (this.data && this.data.games) || []; },
  find(gameId) { return this.games().find(g => g.gameId === gameId) || null; },

  /* open -> current, expressed from the away side */
  move(gameId) {
    const g = this.find(gameId);
    if (!g) return null;
    return {
      spread: round2(g.current.spread - g.open.spread),
      total: round2(g.current.total - g.open.total),
      openSpread: g.open.spread, curSpread: g.current.spread,
      openTotal: g.open.total, curTotal: g.current.total
    };
  },

  toMarkets() {
    const out = [];
    this.games().forEach(g => {
      const when = new Date(g.kickoff).toLocaleString(undefined,
        { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      const mk = (abbr, odds, isAway) => ({
        id: `${g.gameId}:${abbr}`,
        gameId: g.gameId,
        category: 'nfl',
        title: `${NFL_NAMES[abbr] || abbr} moneyline`,
        detail: `${g.away} at ${g.home} · ${when}`,
        odds,
        /* spread shown from this side */
        spreadLine: isAway ? g.current.spread : round2(-g.current.spread),
        total: g.current.total,
        /* present on slates that carry an opening moneyline (preseason W2 on) */
        openOdds: validOdds(isAway ? g.open.mlAway : g.open.mlHome)
                    ? (isAway ? g.open.mlAway : g.open.mlHome) : null,
        publicPct: g.public ? (isAway ? g.public.mlAway : g.public.mlHome) : null,
        real: true
      });
      out.push(mk(g.away, g.current.mlAway, true));
      out.push(mk(g.home, g.current.mlHome, false));
    });
    return out;
  }
};

const NFL_NAMES = {
  ARI:'Arizona Cardinals', ATL:'Atlanta Falcons', BAL:'Baltimore Ravens', BUF:'Buffalo Bills',
  CAR:'Carolina Panthers', CHI:'Chicago Bears', CIN:'Cincinnati Bengals', CLE:'Cleveland Browns',
  DAL:'Dallas Cowboys', DEN:'Denver Broncos', DET:'Detroit Lions', GB:'Green Bay Packers',
  HOU:'Houston Texans', IND:'Indianapolis Colts', JAX:'Jacksonville Jaguars', KC:'Kansas City Chiefs',
  LV:'Las Vegas Raiders', LAC:'Los Angeles Chargers', LA:'Los Angeles Rams', LAR:'Los Angeles Rams',
  MIA:'Miami Dolphins', MIN:'Minnesota Vikings', NE:'New England Patriots', NO:'New Orleans Saints',
  NYG:'New York Giants', NYJ:'New York Jets', PHI:'Philadelphia Eagles', PIT:'Pittsburgh Steelers',
  SF:'San Francisco 49ers', SEA:'Seattle Seahawks', TB:'Tampa Bay Buccaneers', TEN:'Tennessee Titans',
  WAS:'Washington Commanders', WSH:'Washington Commanders'
};

/* ---------- 5. State ---------- */
let games = [], markets = [], selected = [], lineTeams = [];
let snapshots = Store.get(KEYS.snapshots, []);
let savedDrafts = Store.get(KEYS.drafts, []);
let weekResults = Store.get(KEYS.results, []);
let week = Store.get(KEYS.week, null);
/* v1.6.5: a loser settled by an earlier build had its projection overwritten
   with zero. Rebuild it from the price so history reads correctly and the row
   can be uploaded. */
if (week && repairTickets(week)) Store.set(KEYS.week, week);
let draftState = null, replayTimer = null, countdownTimer = null, lastResult = null;
let chartMode = 'teams';                 // 'teams' | 'books'
let selectedLineTeams = [];              // teams mode, up to 4
let bookTeam = null;                     // books mode, exactly 1

/* Every leaderboard needs a stable name. Asked once, trimmed, stored. */
function getIdentity() { return Store.get(KEYS.identity, null); }
function saveIdentity(name, code) {
  const clean = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24);
  if (!clean) return null;
  const id = { name: clean, code: String(code || '').trim().slice(0, 8).toUpperCase() || null,
               since: new Date().toISOString() };
  Store.set(KEYS.identity, id);
  return id;
}

function ensureWeek() {
  const key = weekKeyFor();
  if (!week) { week = blankWeek(key); persist(); return true; }
  if (week.key !== key) {
    if (!AUTO_ROLLOVER) return false;      // testing: only the admin rolls the week
    if (week.tickets.length) archiveWeek(week);
    week = blankWeek(key);
    persist();
    return true;
  }
  return false;
}

const BLANK_LIFETIME = { bets: 0, won: 0, lost: 0, push: 0, wagered: 0,
                         profit: 0, weeks: 0, wins: 0, biggestWin: 0, bestFinish: 0 };

/* Lifetime totals are accumulated at archive time and never reset. The
   weekly bankroll is a format, not a record. */
function updateLifetime(w) {
  const lt = Object.assign({}, BLANK_LIFETIME, Store.get(KEYS.lifetime, null) || {});
  const s = weekStats(w);
  lt.bets   += w.tickets.length;
  lt.won    += w.tickets.filter(t => t.status === 'won').length;
  lt.lost   += w.tickets.filter(t => t.status === 'lost').length;
  lt.push   += w.tickets.filter(t => t.status === 'push' || t.status === 'void').length;
  lt.wagered = round2(lt.wagered + s.wagered);
  lt.profit  = round2(lt.profit + s.realizedPL);
  lt.weeks  += 1;
  const best = w.tickets.filter(t => t.status === 'won')
    .reduce((m, t) => Math.max(m, payout(t) - t.stake), 0);
  lt.biggestWin = round2(Math.max(lt.biggestWin, best));
  lt.bestFinish = round2(Math.max(lt.bestFinish, s.bankroll));
  Store.set(KEYS.lifetime, lt);
  return lt;
}

function archiveWeek(w) {
  /* Any ticket still open when the week ended never got a result, so refund
     the stake and mark it void. Previously the stake was debited and the
     ticket orphaned, so the money simply disappeared from the archive. */
  w.tickets.filter(t => t.status === 'open').forEach(t => {
    t.status = 'void';                    // payout() refunds the stake
    t.settledAt = t.settledAt || new Date().toISOString();
  });
  w.bankroll = derivedBankroll(w);
  const s = weekStats(w);
  const best = w.tickets
    .filter(t => t.status === 'won')
    .sort((a, b) => (payout(b) - b.stake) - (payout(a) - a.stake))[0];
  updateLifetime(w);
  weekResults.unshift({
    key: w.key, profit: s.realizedPL, hitRate: s.hitRate, betsUsed: s.betsUsed,
    roi: s.roi, wagered: s.wagered,
    bestTicket: best ? { legs: best.legs.length, odds: best.odds, profit: round2(payout(best) - best.stake) } : null
  });
  if (weekResults.length > 12) weekResults.pop();
  Store.set(KEYS.results, weekResults);
}

function persist() {
  Store.set(KEYS.week, week);
  Store.set(KEYS.results, weekResults);
  Store.set(KEYS.drafts, savedDrafts);
  Store.set(KEYS.snapshots, snapshots);
}

function showToast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2400);
}

const activeFilter = () => (document.querySelector('.filter.active') || { dataset: {} }).dataset.filter || 'all';
const activeBetFilter = () => (document.querySelector('.bet-filter.active') || { dataset: {} }).dataset.status || 'all';

function switchView(id) {
  /* Fantasy tools and Line Winder stay open. Only the views that are
     meaningless without identity ask for an account. */
  if (AUTH_GATED_VIEWS.indexOf(id) !== -1 && needsAccount()) {
    const why = id === 'bets' ? 'Sign in to keep your bets.'
              : 'Sign in to join the leaderboard.';
    openAuth(why);
    return;
  }
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active-view'));
  const t = document.getElementById(id);
  if (t) t.classList.add('active-view');
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === id));
  /* v1.4: the bottom bar follows EVERY navigation path — the seven data-jump
     buttons, the trending Add, the draft shortcut and the profile menu — not
     just its own taps. Syncing here rather than in the click handler is what
     stops the highlight going stale. */
  document.querySelectorAll('.mobile-nav-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === id));
  updateNavBadges();
  if (id === 'bets') { renderBets(activeBetFilter()); renderBetsLive();
    if (openTickets().length) refreshTickets({ quiet: true }); }
  if (id === 'friends' || id === 'leaderboard') renderCompetition();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* The bet slip lives below the market list, so on a phone you would scroll
   past every market to see your odds or place a ticket. This bar rides above
   the bottom nav and mirrors the slip live. */
function renderSlipBar() {
  const bar = document.getElementById('slipBar');
  if (!bar) return;
  const n = selected.length;
  if (!n) { bar.hidden = true; document.body.classList.remove('has-slip-bar'); return; }
  bar.hidden = false;
  document.body.classList.add('has-slip-bar');
  const a = combinedAmerican();
  const stakeEl = document.getElementById('stakeInput');
  const stake = Number((stakeEl && stakeEl.value) || 0);
  document.getElementById('slipBarLegs').textContent =
    n === 1 ? 'Straight bet' : `${n}-leg parlay`;
  document.getElementById('slipBarOdds').textContent = a === null ? '—' : fmtOdds(a);
  document.getElementById('slipBarReturn').textContent =
    a === null ? '—' : `${money(stake * decimalOdds(a))} to win`;
  const place = document.getElementById('slipBarPlace');
  const st = weekStats(week);
  /* a single leg is a straight bet — this still demanded two, so the bar
     stayed disabled while the desktop slip was happy to place it */
  place.disabled = n < 1 || st.betsLeft <= 0 || stake < 1 || stake > week.bankroll;
  place.textContent = st.betsLeft <= 0 ? 'Limit' : 'Place';
}

/* On mobile the bet slip sits below the market list, so adding a leg from
   Trending gives no visible feedback that anything happened. A count on the
   Mock tab is the only place it can be seen without scrolling. */
function updateNavBadges() {
  const mock = document.querySelector('.mobile-nav-btn[data-view="parlay"]');
  if (mock) setBadge(mock, selected.length);
  const bets = document.querySelector('.mobile-nav-btn[data-view="bets"]');
  if (bets && typeof week !== 'undefined' && week) {
    setBadge(bets, week.tickets.filter(t => t.status === 'open').length);
  }
}
function setBadge(btn, n) {
  let b = btn.querySelector('.nav-badge');
  if (!n) { if (b) b.remove(); return; }
  if (!b) {
    b = document.createElement('i');
    b.className = 'nav-badge';
    btn.appendChild(b);
  }
  b.textContent = n > 9 ? '9+' : String(n);
}

/* ---------- 6. Slip ---------- */
function combinedAmerican() {
  /* One leg is a straight bet at its own price; two or more multiply into
     a parlay. Previously a single pick returned null and the slip refused
     to place it at all. */
  if (!selected.length) return null;
  if (selected.length === 1) return selected[0].odds;
  const d = selected.reduce((a, m) => a * decimalOdds(m.odds), 1);
  const am = americanFromDecimal(d);
  return isFinite(am) ? am : null;
}

function toggleLeg(id) {
  if (selected.some(m => m.id === id)) {
    selected = selected.filter(m => m.id !== id);
  } else {
    const m = markets.find(x => x.id === id);
    if (!m) return;
    if (m.gameId && selected.some(s => s.gameId === m.gameId)) {
      showToast('Those picks are opposite sides of the same game.');
      return;
    }
    selected = [...selected, m];
  }
  renderMarkets(activeFilter());
  renderSlip();
}

function marketRow(m) {
  const shop = m.bookCount > 1 && m.best !== m.odds
    ? `<small class="shop-hint">Best ${fmtOdds(m.best)} at ${m.bestBook} · ${m.bookCount} books</small>` : '';
  const edge = m.edge > 0 ? `<span class="edge-chip">+${m.edge.toFixed(1)}% value</span>` : '';
  return `<div class="market-row">
    <div class="market-meta"><span>${m.title} ${edge}</span>
      <small>${m.detail} · ${m.category.toUpperCase()}${realMove(m)}</small>${shop}</div>
    <div class="pick-actions"><span class="odds">${fmtOdds(m.odds)}</span>
      ${addButton(m)}</div>
  </div>`;
}

/* The genuine open -> current move, shown only where it is real. */
function realMove(m) {
  if (!m.real || !RealBoard.data) return '';
  const mv = RealBoard.move(m.gameId);
  if (!mv) return '';
  const bits = [];
  if (mv.spread) {
    const away = (m.id || '').endsWith(':' + (RealBoard.find(m.gameId) || {}).away);
    const d = away ? mv.spread : -mv.spread;
    bits.push(`<em class="mv ${d < 0 ? 'good' : 'bad'}">${d > 0 ? '+' : ''}${d} spread</em>`);
  }
  if (mv.total) bits.push(`<em class="mv">${mv.total > 0 ? '+' : ''}${mv.total} total</em>`);
  return bits.length ? ` · ${bits.join(' ')}` : '';
}

/* One control, three states. Empty slip -> "Bet" (a straight bet).
   Something already on it -> "Add to parlay", in the parlay colour, so it
   is obvious you are building rather than replacing. Already picked ->
   "Added", and tapping again removes it, same as the x in the slip. */
function addButton(m) {
  const on = selected.some(s => s.id === m.id);
  if (on) return `<button class="add-btn added" data-add="${m.id}">Added ✕</button>`;
  if (!selected.length) return `<button class="add-btn" data-add="${m.id}">Bet</button>`;
  return `<button class="add-btn to-parlay" data-add="${m.id}">Add to parlay</button>`;
}

function renderMarkets(filter = 'all') {
  const data = markets.filter(m => filter === 'all' || m.category === filter);
  const box = document.getElementById('marketList');
  box.innerHTML = data.map(marketRow).join('') || '<div class="empty-state">No markets in this category.</div>';
  box.querySelectorAll('[data-add]').forEach(b => b.onclick = () => toggleLeg(b.dataset.add));
}

function renderSlip() {
  const box = document.getElementById('selectedLegs');
  if (!selected.length) {
    box.className = 'selected-legs empty-state';
    box.textContent = 'Tap a price to start. One pick is a straight bet, two or more builds a parlay.';
  } else {
    box.className = 'selected-legs';
    box.innerHTML = selected.map(m => `<div class="selected-leg">
      <div>${m.title}<small>${fmtOdds(m.odds)}</small></div>
      <button class="remove-leg" data-remove="${m.id}">×</button></div>`).join('');
    box.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => toggleLeg(b.dataset.remove));
  }
  const a = combinedAmerican();
  document.getElementById('combinedOdds').textContent = a === null ? '—' : fmtOdds(a);
  updateReturn();
  const s = weekStats(week);
  /* Match the golf slip: say why it is blocked rather than letting the
     user tap Place and bounce off a toast. */
  const stakeVal = Number((document.getElementById('stakeInput') || {}).value || 0);
  let reason = '';
  if (!selected.length) reason = '';
  else if (s.betsLeft <= 0) reason = `You have used all ${WEEKLY_BET_LIMIT} bets this week.`;
  else if (!(stakeVal >= 1)) reason = 'Minimum virtual stake is $1.';
  else if (stakeVal > week.bankroll) reason = `Stake exceeds your virtual bankroll of ${money(week.bankroll)}.`;

  const note = document.getElementById('slipError');
  if (note) { note.textContent = reason; note.hidden = !reason; }

  const btn = document.getElementById('placeMockBet');
  btn.disabled = !selected.length || !!reason;
  btn.textContent = s.betsLeft <= 0 ? 'Weekly limit reached'
    : reason ? 'Check your stake'
    : selected.length === 1 ? 'Place straight bet'
    : `Place ${selected.length}-leg parlay`;

  /* the slip heading and the odds label follow suit */
  const kind = document.getElementById('slipKind');
  if (kind) kind.textContent = !selected.length ? 'Bet slip'
    : selected.length === 1 ? 'Straight bet' : `${selected.length}-leg parlay`;
  const oddsLabel = document.getElementById('slipOddsLabel');
  if (oddsLabel) oddsLabel.textContent = selected.length > 1 ? 'Parlay odds' : 'Odds';
  updateNavBadges();
  renderSlipBar();
  if (typeof renderHomeGames === 'function') renderHomeGames();
}

function updateReturn() {
  const stake = Number(document.getElementById('stakeInput').value || 0);
  const a = combinedAmerican();
  document.getElementById('potentialReturn').textContent =
    money(a === null ? 0 : stake * decimalOdds(a));
}

function placeTicket() {
  if (!requireAccount('Sign in to place a mock bet.')) return;
  const s = weekStats(week);
  if (s.betsLeft <= 0) { showToast(`Weekly limit of ${WEEKLY_BET_LIMIT} tickets reached.`); return; }
  const stake = Number(document.getElementById('stakeInput').value || 0);
  const a = combinedAmerican();
  if (a === null) return;
  if (!(stake > 0) || stake > week.bankroll) {
    showToast('Choose a valid stake within your weekly bankroll.');
    return;
  }
  /* Snapshot what the market believed right now — the one piece of CLV
     that cannot be reconstructed later. For a parlay it is the product of
     each leg's de-vigged two-way price. */
  const legFair = selected.map(m => {
    const opp = markets.find(x => x.gameId === m.gameId && x.id !== m.id);
    if (!opp) return null;
    const pair = devigPair(m.odds, opp.odds);
    return (pair && isFinite(pair[0])) ? pair[0] : null;
  });
  const parlayFair = legFair.every(v => typeof v === 'number' && v > 0)
    ? round4(legFair.reduce((x, y) => x * y, 1)) : null;

  week.tickets.unshift({
    id: `VIG-${week.key.replace(/-/g, '')}-${String(week.tickets.length + 1).padStart(2, '0')}`,
    date: new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    status: 'open', stake, odds: a,
    returnAmount: round2(stake * decimalOdds(a)),
    fairProb: parlayFair,
    fairMethod: parlayFair === null ? null : 'proportional',
    bookPrices: { book: 'vig-sim', legs: selected.map(m => ({ id: m.id, odds: m.odds })) },
    legs: selected.map(m => ({ title: m.title, odds: m.odds, gameId: m.gameId }))
  });
  week.bankroll = derivedBankroll(week);
  selected = [];
  if (Cloud.enabled() && Cloud.signedIn() && cloudUnreachable()) {
    Outbox.add(week.tickets[0], week.key);
    showToast('Saved on this device — will sync when the server is back.');
  } else if (Cloud.enabled() && Cloud.signedIn()) {
    Cloud.placeBet(week.tickets[0], week.key)
      .then(saved => { week.tickets[0] = saved; week.bankroll = derivedBankroll(week); persist(); })
      .catch(e => {
        console.warn('[VIG] bet queued for retry:', e && e.message);
        Outbox.add(week.tickets[0], week.key);
        showToast('Saved on this device — will sync when the server is back.');
      });
  }
  persist();
  renderMarkets(activeFilter());
  renderSlip();
  updateDashboard();
  renderBets(activeBetFilter());
  renderCompetition();
  showToast(`Ticket placed. ${weekStats(week).betsLeft} of ${WEEKLY_BET_LIMIT} left this week.`);
}

/* ---------- 7. Settlement ---------- */
function legWinProbability(leg) {
  const price = validOdds(leg.odds) ? leg.odds : -110;
  const raw = impliedProb(price);
  const g = games.find(x => x.id === leg.gameId);
  if (g) {
    const hp = impliedProb(consensusPrice(g.home)), ap = impliedProb(consensusPrice(g.away));
    if (isFinite(hp) && isFinite(ap) && hp + ap > 0) return raw / (hp + ap);
  }
  return Math.min(0.97, raw * 0.955);
}

function settleOpenTickets() {
  const open = week.tickets.filter(t => t.status === 'open');
  if (!open.length) { showToast('No open tickets to settle.'); return; }
  let credited = 0;
  open.forEach(t => {
    const won = t.legs.every(l => Math.random() < legWinProbability(l));
    t.status = won ? 'won' : 'lost';
    t.settledAt = new Date().toISOString();
    /* returnAmount is NOT touched. A loser keeps what it would have paid;
       payout() reports 0 because the status says so. */
    credited += realizedReturn(t);
  });
  week.bankroll = derivedBankroll(week);
  week.history.push(round2(week.bankroll));
  if (week.history.length > 40) week.history.shift();
  persist();
  updateDashboard();
  renderBets(activeBetFilter());
  renderCompetition();
  showToast(`${open.length} ticket${open.length > 1 ? 's' : ''} settled. ${money(credited)} returned.`);
}

/* ---------- 8. Dashboard ---------- */
function updateDashboard() {
  const s = weekStats(week);
  document.getElementById('bankrollValue').textContent = money(s.bankroll);
  const chip = document.getElementById('bankrollChange');
  chip.textContent = `${s.realizedPL >= 0 ? '+' : ''}${money(s.realizedPL)}`;
  chip.className = `change-chip ${s.realizedPL < 0 ? 'negative' : ''}`;
  document.getElementById('ticketCount').textContent = `${s.betsUsed}/${WEEKLY_BET_LIMIT}`;
  document.getElementById('hitRate').textContent = `${s.hitRate}%`;
  document.getElementById('openCount').textContent = s.openCount;
  const left = document.getElementById('betsLeft');
  if (left) left.textContent = `${s.betsLeft} bets left`;
  renderChart();
  renderRecentBets();
  renderCountdown();
}

function renderCountdown() {
  const el = document.getElementById('weekReset');
  if (!el) return;
  el.textContent = `Resets in ${fmtCountdown(nextResetAt() - new Date())}`;
}

function renderChart() {
  const svg = document.getElementById('bankrollChart');
  const data = week.history.slice(-12);
  if (!svg) return;
  if (data.length < 2) {
    svg.innerHTML = `<text class="chart-label" x="50%" text-anchor="middle" y="95">Settle a ticket to start this week's curve</text>`;
    return;
  }
  const w = 520, h = 180, p = 18;
  const min = Math.min(...data) - 40, max = Math.max(...data) + 40;
  const step = (w - p * 2) / (data.length - 1);
  const pts = data.map((v, i) => [p + i * step, h - p - ((v - min) / (max - min)) * (h - p * 2)]);
  const path = pts.map((q, i) => `${i ? 'L' : 'M'}${q[0]},${q[1]}`).join(' ');
  svg.innerHTML = `<defs><linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2875CB" stop-opacity=".28"/>
      <stop offset="100%" stop-color="#2875CB" stop-opacity="0"/></linearGradient></defs>
    ${[35, 90, 145].map(y => `<line class="chart-grid" x1="${p}" y1="${y}" x2="${w - p}" y2="${y}"/>`).join('')}
    <path class="chart-area" d="${path} L${pts[pts.length - 1][0]},${h - p} L${pts[0][0]},${h - p} Z"/>
    <path class="chart-line" d="${path}"/>
    ${pts.map((q, i) => `<circle class="chart-dot" cx="${q[0]}" cy="${q[1]}" r="${i === pts.length - 1 ? 6 : 3}"/>`).join('')}
    <text class="chart-label" x="${p}" y="174">Monday reset</text>
    <text class="chart-label" text-anchor="end" x="${w - p}" y="174">now</text>`;
}

function renderRecentBets() {
  document.getElementById('recentBets').innerHTML = week.tickets.slice(0, 3).map(t =>
    `<div class="compact-bet"><div><strong>${t.legs.length}-leg parlay</strong>
      <small>${money(t.stake)} · ${fmtOdds(t.odds)}</small></div>
      <span class="status ${t.status}">${t.status}</span></div>`).join('')
    || '<div class="empty-state">No tickets this week yet.</div>';
}

/* "1-leg mock parlay" is a contradiction. Name what it actually is. */
function betLabel(t) {
  const n = (t.legs && t.legs.length) || 1;
  if (t.kind === 'golf') return 'Golf outright';
  return n === 1 ? 'Straight bet' : `${n}-leg parlay`;
}

function renderBets(status = 'all') {
  const data = week.tickets.filter(t => status === 'all' || t.status === status);
  document.getElementById('betHistory').innerHTML = data.length ? data.map(t =>
    `<article class="bet-card">
      <div class="bet-card-head"><span class="status ${t.status}">${
        t.status === 'open' && pendingSettlement().some(x => x.id === t.id) ? 'awaiting settlement' : t.status}</span><small>${t.id} · ${t.date}</small></div>
      <h3>${betLabel(t)} <span class="odds">${fmtOdds(t.odds)}</span></h3>
      <ol class="bet-legs">${t.legs.map(l => `<li>${l.title}${validOdds(l.odds) ? ` <span class="odds">${fmtOdds(l.odds)}</span>` : ''}</li>`).join('')}</ol>
      <div class="bet-card-foot">
        <div><span>Stake</span><strong>${money(t.stake)}</strong></div>
        <div><span>${t.status === 'won' ? 'Paid' : t.status === 'lost' ? 'Returned' : (t.status === 'void' || t.status === 'push') ? 'Refunded' : 'To win'}</span><strong>${money(t.status === 'open' ? potentialReturn(t) : payout(t))}</strong>${t.status === 'lost' ? `<small class="would-have-paid">would have paid ${money(potentialReturn(t))}</small>` : ''}</div>
        ${typeof t.fairProb === 'number' ? `<div><span>Market at entry</span><strong>${(t.fairProb * 100).toFixed(1)}%${
          typeof t.closeProb === 'number'
            ? ` <em class="clv ${t.closeProb > t.fairProb ? 'good' : 'bad'}">${t.closeProb > t.fairProb ? '+' : ''}${((t.closeProb - t.fairProb) * 100).toFixed(1)} CLV</em>`
            : ''}</strong></div>` : ''}
      </div></article>`).join('')
    : '<div class="empty-state">No tickets in this category.</div>';

  const s = weekStats(week);
  document.getElementById('totalRisked').textContent = money(s.risked);
  const net = document.getElementById('netProfit');
  net.textContent = `${s.realizedPL >= 0 ? '+' : ''}${money(s.realizedPL)}`;
  net.className = s.realizedPL < 0 ? 'negative' : 'positive';
  const risk = document.getElementById('atRisk');
  if (risk) risk.textContent = money(s.atRisk);
  const used = document.getElementById('betsUsed');
  if (used) used.textContent = `${s.betsUsed}/${WEEKLY_BET_LIMIT}`;
  const btn = document.getElementById('settleBets');
  if (btn) btn.disabled = !s.openCount;
}

/* ---------- 9. Featured + trending boards ---------- */
const FEATURED = [
  { name: 'Thursday Night Two-Leg', picks: ['buf-mia:BUF', 'gb-det:DET'], stake: 25 },
  { name: 'Sunday Favorites', picks: ['dal-phi:PHI', 'cin-cle:CIN', 'sf-sea:SF'], stake: 20 },
  { name: 'Prime-Time Swing', picks: ['kc-bal:KC', 'sf-sea:SEA'], stake: 15 },
  { name: 'Underdog Ticket', picks: ['buf-mia:MIA', 'dal-phi:DAL', 'cin-cle:CLE'], stake: 10 },
  { name: 'Sunday Early Double', picks: ['gb-det:DET', 'cin-cle:CIN'], stake: 25 },
  { name: 'Cross-Sport Card', picks: ['buf-mia:BUF', 'tn-1', 'sc-1'], stake: 10 },
  { name: 'Four-Game Sunday Card', picks: ['buf-mia:BUF', 'dal-phi:PHI', 'cin-cle:CIN', 'sf-sea:SF'], stake: 10 }
];

/* Composed from the live board rather than a fixed list. One leg per game,
   so no card can ever contain both sides of a matchup. */
function buildFeatured() {
  const nfl = markets.filter(m => m.category === 'nfl' && typeof m.odds === 'number');
  if (nfl.length < 4) return [];
  const byGame = {};
  nfl.forEach(m => (byGame[m.gameId] = byGame[m.gameId] || []).push(m));
  const games = Object.values(byGame).filter(p => p.length === 2);
  if (games.length < 2) return [];

  const favOf = p => p[0].odds <= p[1].odds ? p[0] : p[1];
  const dogOf = p => p[0].odds <= p[1].odds ? p[1] : p[0];
  const take = (arr, n) => arr.slice(0, n);

  /* shortest-priced favourites, longest-priced dogs, closest to even */
  const byFav = games.slice().sort((a, b) => favOf(a).odds - favOf(b).odds);
  const byDog = games.slice().sort((a, b) => dogOf(b).odds - dogOf(a).odds);
  const byClose = games.slice().sort((a, b) =>
    Math.abs(impliedProb(favOf(a).odds) - 0.5) - Math.abs(impliedProb(favOf(b).odds) - 0.5));

  const cards = [
    { name: 'Three chalk',      stake: 25, legs: take(byFav, 3).map(favOf) },
    { name: 'Longshot ticket',  stake: 10, legs: take(byDog, 3).map(dogOf) },
    { name: 'Coin flips',       stake: 20, legs: take(byClose, 2).map(favOf) },
    { name: 'Favourite double', stake: 25, legs: take(byFav, 2).map(favOf) },
    { name: 'Dog and chalk',    stake: 15, legs: [dogOf(byDog[0]), favOf(byFav[0])] }
  ];

  return cards
    .map(c => {
      /* dedupe by game, then by market, so a card is always internally sane */
      const seen = new Set(), legs = [];
      c.legs.forEach(l => {
        if (!l || seen.has(l.gameId)) return;
        seen.add(l.gameId); legs.push(l);
      });
      return { ...c, legs };
    })
    .filter(c => c.legs.length >= 2);
}

function renderFeatured() {
  const box = document.getElementById('featuredParlays');
  if (!box) return;
  /* FIX: these were hardcoded against the old simulated board, so once the
     real games landed every card pointed at fixtures that no longer exist —
     buf-mia when the board says buf-hou. A card built on a phantom game can
     never settle. Cards are now composed FROM whatever is on the board, so
     they cannot go stale when the board is refreshed. */
  const valid = buildFeatured();

  box.innerHTML = valid.map((p, i) => {
    const odds = americanFromDecimal(p.legs.reduce((a, l) => a * decimalOdds(l.odds), 1));
    return `<article class="featured-parlay-card">
      <div class="featured-parlay-top"><span>${p.name}</span><strong>${fmtOdds(odds)}</strong></div>
      <ol>${p.legs.map(l => `<li>${l.title.replace(' moneyline', '')} ${fmtOdds(l.odds)}</li>`).join('')}</ol>
      <div class="featured-parlay-foot"><span>${p.legs.length} legs · ${money(p.stake)} mock stake</span>
        <span class="featured-actions">
          <button class="add-btn" data-featured="${i}">Bet</button>
          <button class="add-btn to-parlay" data-featured-add="${i}">Add to parlay</button>
        </span></div></article>`;
  }).join('') || '<div class="empty-state">No featured builds for this board.</div>';

  /* Bet = take this card as your slip. Add to parlay = append its legs to
     whatever is already there, skipping anything that would collide. */
  box.querySelectorAll('[data-featured]').forEach(b => b.onclick = () => {
    const p = valid[Number(b.dataset.featured)];
    selected = p.legs.slice();
    document.getElementById('stakeInput').value = p.stake;
    renderMarkets(activeFilter());
    renderSlip();
    renderHomeGames();
    switchView('parlay');
    showToast(`${p.name} ready — set your stake and place it.`);
  });

  box.querySelectorAll('[data-featured-add]').forEach(b => b.onclick = () => {
    const p = valid[Number(b.dataset.featuredAdd)];
    let added = 0, skipped = 0;
    p.legs.forEach(leg => {
      if (selected.some(x => x.id === leg.id)) { skipped++; return; }
      /* never both sides of one game */
      if (selected.some(x => x.gameId && x.gameId === leg.gameId)) { skipped++; return; }
      selected.push(leg);
      added++;
    });
    renderMarkets(activeFilter());
    renderSlip();
    renderHomeGames();
    showToast(added
      ? `${added} leg${added === 1 ? '' : 's'} added${skipped ? `, ${skipped} skipped` : ''}. Now a ${selected.length}-leg parlay.`
      : 'Those picks are already on your slip.');
  });
}

function renderTrending() {
  const wrap = document.getElementById('trendingBoards');
  if (!wrap) return;
  const groups = [
    ['golf', 'Golf', 'Tournament outrights and finishing positions'],
    ['tennis', 'Tennis', 'Outright winners and round progression'],
    ['soccer', 'Soccer', 'League and cup outrights']
  ];
  wrap.innerHTML = groups.map(([cat, label, blurb]) => {
    const rows = markets.filter(m => m.category === cat);
    if (!rows.length) return '';
    const byEvent = {};
    rows.forEach(r => (byEvent[r.event || 'Featured'] = byEvent[r.event || 'Featured'] || []).push(r));
    return `<section class="panel trending-panel">
      <div class="panel-head"><div><span class="eyebrow">${label.toUpperCase()}</span><h2>${
          cat === 'golf' ? GolfOutrights.marketLabel() : label}</h2>
        <p class="muted-copy">${blurb}</p></div>${(() => {
          if (cat !== 'golf') return '<span class="updated">Simulated prices</span>';
          const s = GolfOutrights.statusLine();
          return `<span class="feed-tag feed-${s.tone}">${s.label}</span>`;
        })()}</div>
      ${cat === 'golf' && GolfOutrights.statusLine().text
        ? `<p class="feed-note">${GolfOutrights.statusLine().text}</p>` : ''}
      ${Object.entries(byEvent).map(([ev, list]) => `
        <div class="trending-event"><h3>${ev}</h3>
        ${list.map(m => `<div class="market-row">
          <div class="market-meta"><span>${m.title.replace(` to win`, ' — outright')}</span>
            <small>${(() => { const t = TRENDING.find(x => x.id === m.id);
              return t && validOdds(t.fair) ? `Fair ${fmtOdds(t.fair)} · offered ${fmtOdds(m.odds)}` : `offered ${fmtOdds(m.odds)}`;
            })()}</small></div>
          <div class="pick-actions">
            ${m.edge > 0 ? `<span class="edge-chip">+${m.edge.toFixed(1)}%</span>` : ''}
            <span class="odds">${fmtOdds(m.odds)}</span>
            <button class="add-btn" data-trend-add="${m.id}">${selected.some(s => s.id === m.id) ? 'Added' : 'Add'}</button>
          </div></div>`).join('')}</div>`).join('')}
    </section>`;
  }).join('');

  wrap.querySelectorAll('[data-trend-add]').forEach(b => b.onclick = () => {
    toggleLeg(b.dataset.trendAdd);
    renderTrending();
    showToast('Added to your mock slip.');
  });
}

/* Home is a football app first. v1.7.0: this used to lead with the two
   highest-edge rows of any sport, which is how a tennis outright and a fantasy
   prop ended up at the top of the page in preseason. Football fills the card;
   other sports only appear if the board is short, and they have their own
   panel besides. */
function renderTrendingPicks() {
  const box = document.getElementById('trendingPicks');
  const isFootball = m => m.category === 'nfl';
  /* soonest kickoff first, so the card leads with what is actually next */
  const kickoff = m => {
    const g = m.gameId ? RealBoard.find(m.gameId) : null;
    return g ? new Date(g.kickoff).getTime() : Infinity;
  };
  const football = markets.filter(isFootball).sort((a, b) =>
    (kickoff(a) - kickoff(b)) || ((b.edge || 0) - (a.edge || 0)));
  const show = football.slice(0, 4);
  if (show.length < 4) {
    const rest = markets.filter(m => !isFootball(m) && m.edge > 0)
      .sort((a, b) => b.edge - a.edge);
    show.push(...rest.slice(0, 4 - show.length));
  }
  box.innerHTML = show.map(m => `<div class="pick-row">
    <div class="pick-meta"><span>${m.title}</span><small>${m.detail}</small></div>
    <div class="pick-actions">${m.edge > 0 ? `<span class="edge-chip">+${m.edge.toFixed(1)}%</span>` : ''}
      <span class="odds">${fmtOdds(m.odds)}</span>
      <button class="add-btn" data-trend="${m.id}">Add</button></div></div>`).join('');
  box.querySelectorAll('[data-trend]').forEach(b => b.onclick = () => {
    switchView('parlay');
    toggleLeg(b.dataset.trend);
  });
}

/* The home "Other sports" card. It was three hardcoded golfers with invented
   movement arrows — prices from a tournament that finished weeks ago. It now
   renders the top of the real outright board, with the same provenance tag the
   Trending panel uses. */
function renderOtherSports() {
  const box = document.getElementById('otherSports');
  if (!box) return;
  const rows = TRENDING.filter(m => m.category === 'golf').slice(0, 3);
  if (!rows.length) {
    box.innerHTML = '<div class="empty-state">No outright board loaded.</div>';
    return;
  }
  const st = GolfOutrights.statusLine();
  const head = document.getElementById('otherSportsEvent');
  if (head) head.textContent = GolfOutrights.marketLabel();
  box.innerHTML = rows.map(m => `<div>
      <span>${m.title.replace(/ to win$/, '')}</span>
      <strong>${fmtOdds(m.odds)}</strong>
      <small>to win</small>
    </div>`).join('')
    + `<p class="feed-note-mini feed-${st.tone}">${st.label}${st.text ? ` · ${st.text}` : ''}</p>`;
}

/* ---------- 10. Line Winder ---------------------------------
   FIX v0.8: the y-axis was linear in American odds. There is no
   price between -100 and +100 (both are 50%), so 45% of the old
   plot was impossible space and a 1-point probability move across
   the boundary rendered as a 200-unit leap. The axis is now
   spaced by de-vigged implied probability and labelled in
   American odds, which is truthful and still reads like a book.
------------------------------------------------------------ */
const SEED_SERIES = {
  BUF: [-105,-110,-108,-116,-120,-122,-125], MIA: [-115,-110,-112,-104,100,102,105],
  DAL: [115,118,120,126,130,132,135],        PHI: [-130,-135,-138,-145,-148,-152,-155],
  KC:  [-110,-112,-115,-113,-116,-120,-118], BAL: [-110,-108,-105,-107,-104,100,-102],
  SF:  [-125,-128,-132,-136,-140,-142,-145], SEA: [107,110,114,118,120,122,125],
  GB:  [100,102,104,106,108,109,110],        DET: [-118,-120,-122,-124,-126,-128,-130],
  CIN: [-145,-148,-152,-156,-160,-162,-165], CLE: [124,128,130,134,136,138,140]
};
const LINE_COLORS = ['#2875CB', '#e2a84a', '#9a7cff', '#55b9c9'];

/* Real prices for games we actually have numbers for. A two-point series is
   thin, but it is real, and it is labelled as such next to the simulated board. */
function knownLineGames() {
  const rows = (Fantasy.data && Fantasy.data.knownLines) || [];
  return rows.map(r => {
    const openP = impliedProb(r.mlHomeOpen), nowP = impliedProb(r.mlHomeNow);
    const awayP = impliedProb(r.mlAway);
    const devig = p => (isFinite(p) && isFinite(awayP) && p + awayP > 0) ? p / (p + awayP) : NaN;
    return {
      ...r,
      openProb: devig(openP), nowProb: devig(nowP),
      marginOpen: (openP + awayP - 1) * 100,
      marginNow: (nowP + awayP - 1) * 100
    };
  });
}

function renderRealLine() {
  const box = document.getElementById('realLine');
  if (!box) return;
  const g = knownLineGames()[0];
  if (!g) { box.hidden = true; return; }
  box.hidden = false;
  const move = (g.nowProb - g.openProb) * 100;
  const when = new Date(g.date + 'T12:00:00').toLocaleDateString(undefined,
    { weekday: 'short', month: 'short', day: 'numeric' });
  box.innerHTML = `
    <div class="rl-head">
      <div><span class="eyebrow">REAL LINE · NFL KICKOFF</span>
        <h3>${g.away} at ${g.home}</h3>
        <p class="muted-copy">${when} · ${g.home} ${g.spreadHome} · total ${g.total}</p></div>
      <span class="rl-badge">actual prices</span>
    </div>
    <div class="rl-grid">
      <div><span>${g.home} open</span><strong>${fmtOdds(g.mlHomeOpen)}</strong><small>${g.openNote}</small></div>
      <div><span>${g.home} now</span><strong>${fmtOdds(g.mlHomeNow)}</strong><small>${g.nowNote}</small></div>
      <div><span>${g.away}</span><strong>${fmtOdds(g.mlAway)}</strong><small>moneyline</small></div>
      <div><span>De-vigged ${g.home}</span><strong>${(g.openProb * 100).toFixed(1)}% → ${(g.nowProb * 100).toFixed(1)}%</strong><small>${move >= 0 ? '+' : ''}${move.toFixed(2)} pts</small></div>
    </div>
    <p class="cmp-note">A ${Math.abs(g.mlHomeNow - g.mlHomeOpen)}-cent price move is worth
      <b>${Math.abs(move).toFixed(2)} of a percentage point</b> of win probability once the book's
      margin is removed — ${g.marginOpen.toFixed(2)}% at open, ${g.marginNow.toFixed(2)}% now.
      Raw American odds make that move look far larger than it is, which is why this chart is
      spaced by probability.</p>`;
}

function recordSnapshot(list) {
  const prices = {};
  list.forEach(g => {
    [g.away, g.home].forEach(team => {
      prices[`${g.id}:${team.abbr}`] = consensusPrice(team);
      team.prices.forEach(p => { prices[`${g.id}:${team.abbr}:${p.book}`] = p.price; });
    });
  });
  const last = snapshots[snapshots.length - 1];
  if (last && JSON.stringify(last.prices) === JSON.stringify(prices)) return;
  snapshots.push({ t: Date.now(), prices });
  if (snapshots.length > 60) snapshots.shift();
  Store.set(KEYS.snapshots, snapshots);
}

function buildLineTeams() {
  const out = [];
  /* Board slate first. From preseason W2 on, the source carries an OPENING
     moneyline for both sides, so this is a real two-point move on each line
     rather than a flat away price — and it carries the public split, which is
     the first half of answering "why did it move". */
  RealBoard.upcoming().forEach(g => {
    const label = `${g.away} @ ${g.home}`;
    const when = new Date(g.kickoff).toLocaleString(undefined,
      { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const side = (abbr, isAway) => {
      const open = isAway ? g.open.mlAway : g.open.mlHome;
      const now  = isAway ? g.current.mlAway : g.current.mlHome;
      const pub  = g.public ? (isAway ? g.public.mlAway : g.public.mlHome) : null;
      const series = validOdds(open) && open !== now ? [open, now] : [now, now];
      return {
        game: label, gameId: 'board-' + g.gameId, time: when,
        team: NFL_NAMES[abbr] || abbr, abbr, current: now,
        best: { price: now }, spread: 0, bookCount: 1,
        move: validOdds(open) ? now - open : 0,
        openPrice: validOdds(open) ? open : null,
        publicPct: (typeof pub === 'number') ? pub : null,
        series, books: {}, live: true, real: true
      };
    };
    out.push(side(g.away, true));
    out.push(side(g.home, false));
  });
  knownLineGames().forEach(g => {
    const label = `${g.away} @ ${g.home}`;
    out.push({
      game: label, gameId: 'real-' + g.date + g.home, time: 'Wed 8:20 PM',
      team: g.home, abbr: g.home, current: g.mlHomeNow,
      best: { price: g.mlHomeNow }, spread: 0, bookCount: 1,
      move: g.mlHomeNow - g.mlHomeOpen,
      series: [g.mlHomeOpen, g.mlHomeNow], books: {}, live: true, real: true
    });
    out.push({
      game: label, gameId: 'real-' + g.date + g.home, time: 'Wed 8:20 PM',
      team: g.away, abbr: g.away, current: g.mlAway,
      best: { price: g.mlAway }, spread: 0, bookCount: 1, move: 0,
      series: [g.mlAway, g.mlAway], books: {}, live: true, real: true
    });
  });
  games.forEach(g => {
    [g.away, g.home].forEach(team => {
      const key = `${g.id}:${team.abbr}`;
      const hist = snapshots.map(s => s.prices[key]).filter(validOdds);
      const live = hist.length >= 2;
      const series = live ? hist.slice(-12) : (SEED_SERIES[team.abbr] || [consensusPrice(team), consensusPrice(team)]);
      const books = {};
      team.prices.forEach(p => {
        const bh = snapshots.map(s => s.prices[`${key}:${p.book}`]).filter(validOdds);
        books[p.book] = { title: p.title, series: bh.length >= 2 ? bh.slice(-12) : [p.price, p.price], current: p.price };
      });
      out.push({
        game: `${g.away.abbr} @ ${g.home.abbr}`, gameId: g.id, time: g.commence,
        team: team.name, abbr: team.abbr, current: consensusPrice(team),
        best: bestPrice(team), spread: bookSpread(team), bookCount: team.prices.length,
        move: series[series.length - 1] - series[0], series, books, live
      });
    });
  });
  return out;
}

/* De-vig a team's series against its opponent's, index by index. */
function probSeries(t) {
  const opp = lineTeams.find(x => x.gameId === t.gameId && x.abbr !== t.abbr);
  return t.series.map((v, i) => {
    const p = impliedProb(v);
    if (!isFinite(p)) return NaN;
    if (!opp) return p;
    const q = impliedProb(opp.series[Math.min(i, opp.series.length - 1)]);
    return isFinite(q) && p + q > 0 ? p / (p + q) : p;
  });
}

function chartSeries() {
  if (chartMode === 'books') {
    const t = lineTeams.find(x => x.abbr === bookTeam) || lineTeams[0];
    if (!t) return [];
    return Object.entries(t.books).slice(0, 4).map(([, b]) => ({
      label: b.title, sub: `${t.abbr} moneyline`,
      probs: b.series.map(impliedProb), prices: b.series
    }));
  }
  return selectedLineTeams
    .map(a => lineTeams.find(t => t.abbr === a))
    .filter(Boolean)
    .map(t => ({ label: t.abbr, sub: t.team, probs: probSeries(t), prices: t.series }));
}

function renderLineMatchups() {
  const box = document.getElementById('lineMatchups');
  if (!box) return;
  const groups = {};
  lineTeams.forEach(t => (groups[t.game] = groups[t.game] || []).push(t));
  box.innerHTML = Object.entries(groups).map(([game, teams]) => `
    <article class="matchup-card">
      <div class="matchup-card-head"><strong>${game}</strong><span>${teams[0].time}</span></div>
      ${teams.map(t => `<label class="moneyline-team">
        <input type="${chartMode === 'books' ? 'radio' : 'checkbox'}" name="lw-pick" data-line-team="${t.abbr}" ${(chartMode === 'books' ? bookTeam === t.abbr : selectedLineTeams.includes(t.abbr)) ? 'checked' : ''}>
        <div><strong>${t.team}</strong>
          <small>${t.real
            ? `<b class="real-tag">real price</b>${validOdds(t.openPrice) ? ` opened ${fmtOdds(t.openPrice)}` : ''}`
            : t.bookCount > 1 ? `best ${fmtOdds(t.best.price)} · ${t.bookCount} books · ${t.spread.toFixed(1)}% spread` : `${t.abbr} moneyline`}</small>
          ${typeof t.publicPct === 'number' ? `<span class="pub-bar" title="${t.publicPct}% of public money on this side">
            <i style="width:${Math.max(2, Math.min(100, t.publicPct))}%"></i></span><small class="pub-pct">${t.publicPct}% of tickets</small>` : ''}</div>
        <div><span class="ml-price">${fmtOdds(t.current)}</span>
          ${t.move ? `<span class="ml-move ${t.move < 0 ? 'positive' : 'negative'}">${t.move < 0 ? '▼' : '▲'} ${Math.abs(t.move)}</span>`
                   : '<span class="ml-move flat">— unchanged</span>'}</div>
      </label>`).join('')}
    </article>`).join('');

  box.querySelectorAll('[data-line-team]').forEach(c => c.addEventListener('change', () => {
    const abbr = c.dataset.lineTeam;
    if (chartMode === 'books') {
      bookTeam = abbr;
    } else if (c.checked) {
      if (selectedLineTeams.length >= 4) {
        c.checked = false;
        showToast('Compare up to four teams at once.');
        return;
      }
      selectedLineTeams.push(abbr);
    } else {
      selectedLineTeams = selectedLineTeams.filter(x => x !== abbr);
    }
    renderLineMatchups();
    renderLineChart();
  }));
}

function renderLineChart(step) {
  const svg = document.getElementById('lineWinderChart');
  if (!svg) return;
  const series = chartSeries();
  const maxIdx = Math.max(1, ...series.map(s => s.probs.length - 1));
  const slider = document.getElementById('replaySlider');
  if (slider) slider.max = String(maxIdx);
  if (typeof step !== 'number' || isNaN(step)) step = slider ? Number(slider.value) : maxIdx;
  step = Math.min(Math.max(0, step), maxIdx);

  document.getElementById('lineChartTitle').textContent = series.length
    ? (chartMode === 'books'
        ? `${(lineTeams.find(t => t.abbr === bookTeam) || {}).abbr || ''} across books`
        : series.map(s => s.label).join(' vs '))
    : 'Select teams to compare';
  document.getElementById('lineChartSubtitle').textContent = chartMode === 'books'
    ? 'One team, every book. Divergence between books is where the shopping value is.'
    : 'Vertical axis is spaced by de-vigged win probability and labelled in American odds.';

  document.getElementById('lineLegend').innerHTML = series.map((s, i) => {
    const idx = Math.min(step, s.prices.length - 1);
    return `<div class="legend-item"><span class="legend-swatch" style="background:${LINE_COLORS[i]}"></span>
      <strong>${s.label}</strong><span>${fmtOdds(s.prices[idx])} · ${(s.probs[idx] * 100).toFixed(1)}%</span></div>`;
  }).join('');

  const W = 820, H = 360, pad = { l: 62, r: 24, t: 20, b: 42 };
  const visible = series.flatMap(s => s.probs.slice(0, step + 1)).filter(isFinite);
  if (!visible.length) { svg.innerHTML = ''; return; }
  let lo = Math.min(...visible) - 0.04, hi = Math.max(...visible) + 0.04;
  lo = Math.max(0.02, lo); hi = Math.min(0.98, hi);
  if (hi - lo < 0.12) { const mid = (hi + lo) / 2; lo = Math.max(0.02, mid - 0.06); hi = Math.min(0.98, mid + 0.06); }

  const x = i => pad.l + i * (W - pad.l - pad.r) / maxIdx;
  const y = p => pad.t + (hi - p) * (H - pad.t - pad.b) / (hi - lo);

  let out = '';
  const ticks = 5;
  for (let i = 0; i < ticks; i++) {
    const p = lo + (hi - lo) * i / (ticks - 1);
    out += `<line class="lw-grid" x1="${pad.l}" y1="${y(p)}" x2="${W - pad.r}" y2="${y(p)}"/>
      <text class="lw-axis" x="8" y="${y(p) + 4}">${fmtOdds(americanFromProb(p))}</text>
      <text class="lw-axis lw-axis-sub" text-anchor="end" x="${W - pad.r}" y="${y(p) - 5}">${(p * 100).toFixed(0)}%</text>`;
  }
  const anyLive = chartMode === 'teams' && selectedLineTeams
    .map(a => lineTeams.find(t => t.abbr === a)).some(t => t && t.live);
  for (let i = 0; i <= maxIdx; i++) {
    const label = anyLive ? (i === maxIdx ? 'Now' : `-${maxIdx - i}`)
      : (['Open', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Current'][i] || `t${i}`);
    out += `<text class="lw-axis" text-anchor="middle" x="${x(i)}" y="${H - 12}">${label}</text>`;
  }
  series.forEach((s, idx) => {
    const slice = s.probs.slice(0, step + 1).filter(isFinite);
    if (slice.length < 1) return;
    out += `<polyline class="lw-line" stroke="${LINE_COLORS[idx]}" points="${slice.map((p, i) => `${x(i)},${y(p)}`).join(' ')}"/>`;
    slice.forEach((p, i) => {
      out += `<circle class="lw-dot" fill="${LINE_COLORS[idx]}" cx="${x(i)}" cy="${y(p)}" r="5">
        <title>${s.sub}: ${fmtOdds(s.prices[Math.min(i, s.prices.length - 1)])} (${(p * 100).toFixed(1)}%)</title></circle>`;
    });
  });
  svg.innerHTML = out;
  document.getElementById('replayTime').textContent = step >= maxIdx ? 'Current' : `Step ${step + 1}`;
}

function initLineWinder() {
  lineTeams = buildLineTeams();
  const valid = lineTeams.map(t => t.abbr);
  selectedLineTeams = selectedLineTeams.filter(a => valid.includes(a));
  if (!selectedLineTeams.length) selectedLineTeams = valid.slice(0, 3);
  if (!bookTeam || !valid.includes(bookTeam)) bookTeam = selectedLineTeams[0] || valid[0] || null;
  renderLineMatchups();
  renderLineChart();
  renderRealLine();
}

function wireLineWinder() {
  const slider = document.getElementById('replaySlider');
  if (slider) slider.addEventListener('input', () => renderLineChart(Number(slider.value)));
  document.querySelectorAll('[data-chart-mode]').forEach(b => b.addEventListener('click', () => {
    chartMode = b.dataset.chartMode;
    document.querySelectorAll('[data-chart-mode]').forEach(x =>
      x.classList.toggle('active', x.dataset.chartMode === chartMode));
    initLineWinder();
  }));
  document.querySelectorAll('.line-range-btn').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.line-range-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    showToast(`${b.textContent} moneyline window selected.`);
  }));
  const replay = document.getElementById('replayBtn');
  if (replay) replay.addEventListener('click', () => {
    clearInterval(replayTimer);
    const maxIdx = Number(slider.max || 6);
    slider.value = 0;
    renderLineChart(0);
    replayTimer = setInterval(() => {
      const next = Number(slider.value) + 1;
      slider.value = next;
      renderLineChart(next);
      if (next >= maxIdx) clearInterval(replayTimer);
    }, 450);
  });
}

/* ---------- 11. Weekly competition --------------------------
   Friends and the leaderboard both rank on realized profit for
   the current week. Rival numbers are generated from a seed
   derived from the week key, so they are stable all week and
   change on Monday like everyone else's.
------------------------------------------------------------ */
const RIVALS = ['Mason', 'Luke', 'Josh', 'Dalton', 'Ava', 'Marcus', 'Ty'];

function rivalsForWeek(key) {
  const rand = seeded('vig-' + key);
  return RIVALS.map(name => {
    const betsUsed = 6 + Math.floor(rand() * (WEEKLY_BET_LIMIT - 5));
    const settled = Math.max(1, betsUsed - Math.floor(rand() * 4));
    const wins = Math.round(settled * (0.28 + rand() * 0.36));
    const profit = round2((rand() - 0.42) * 620);
    const staked = 40 + Math.floor(rand() * 260);
    return {
      name, betsUsed, profit,
      hitRate: Math.round(wins / settled * 100),
      bankroll: round2(WEEKLY_BANKROLL + profit),
      roi: round2(100 * profit / staked),
      best: { legs: 2 + Math.floor(rand() * 3), odds: 180 + Math.floor(rand() * 900) }
    };
  });
}

let cloudBoard = null;      // populated asynchronously from the database

async function refreshLeaderboard() {
  if (!(Cloud.enabled() && Cloud.signedIn())) { cloudBoard = null; return; }
  const rows = await Cloud.leaderboard(week.key);
  cloudBoard = rows.map(r => ({
    name: r.display_name,
    you: r.user_id === Cloud.userId(),
    betsUsed: Number(r.bets_used) || 0,
    profit: Number(r.profit) || 0,
    roi: r.roi === null || r.roi === undefined ? null : Number(r.roi),
    hitRate: Number(r.hit_rate) || 0,
    bankroll: Number(r.bankroll) || WEEKLY_BANKROLL,
    atRisk: Number(r.at_risk) || 0,
    best: Number(r.biggest_win) > 0 ? { legs: 1, odds: 0, profit: Number(r.biggest_win) } : null
  })).sort((a, b) => b.profit - a.profit);
  renderCompetition();
}

function standings() {
  /* Real rows the moment there is a database behind us. The generated
     rivals remain only as a labelled demo when there is not. */
  if (cloudBoard && cloudBoard.length) return cloudBoard;
  const s = weekStats(week);
  const ident = getIdentity();
  const me = {
    name: ident ? ident.name : 'You', you: true, roi: s.roi, betsUsed: s.betsUsed, profit: s.realizedPL,
    hitRate: s.hitRate, bankroll: s.bankroll,
    best: (() => {
      const b = week.tickets.filter(t => t.status === 'won')
        .sort((a, c) => (payout(c) - c.stake) - (payout(a) - a.stake))[0];
      return b ? { legs: b.legs.length, odds: b.odds } : null;
    })()
  };
  return [...rivalsForWeek(week.key), me].sort((a, b) => b.profit - a.profit);
}

/* ---------- all-time leaderboard ---------------------------------
   The weekly board answers "who is winning right now". This answers
   "who is actually good", which is the more interesting question once
   more than one week has been played — a bad week resets, a bad record
   does not. The `lifetime()` function has existed since v1.5.0; nothing
   was reading it.
------------------------------------------------------------------ */
let boardScope = 'week';       // 'week' | 'alltime'
let allTimeRows = null;

async function refreshAllTime() {
  if (!(Cloud.enabled() && Cloud.signedIn())) {
    allTimeRows = null;
    renderCompetition();          // was returning without repainting
    return;
  }
  try {
    const rows = await Cloud.lifetime();
    allTimeRows = (rows || []).map(r => ({
      userId: r.user_id,
      name: r.display_name,
      you: r.user_id === Cloud.userId(),
      bets: Number(r.bets) || 0,
      wins: Number(r.wins) || 0,
      losses: Number(r.losses) || 0,
      pushes: Number(r.pushes) || 0,
      wagered: Number(r.wagered) || 0,
      profit: Number(r.profit) || 0,
      roi: r.roi === null || r.roi === undefined ? null : Number(r.roi),
      biggestWin: Number(r.biggest_win) || 0,
      weeks: Number(r.weeks_played) || 0,
      clv: r.clv === null || r.clv === undefined ? null : Number(r.clv),
      clvBets: Number(r.clv_bets) || 0
    })).sort((a, b) => b.profit - a.profit);
  } catch (e) {
    console.warn('[VIG] all-time read failed:', e && e.message);
    allTimeRows = null;
  }
  renderCompetition();
}

function allTimeHtml() {
  if (!allTimeRows) {
    return `<div class="empty-state">${Cloud.enabled()
      ? 'Sign in to see the all-time board.'
      : 'All-time standings need an account.'}</div>`;
  }
  const played = allTimeRows.filter(r => r.bets > 0);
  if (!played.length) {
    return '<div class="empty-state">No settled bets yet. The all-time board fills in as weeks complete.</div>';
  }
  const medal = i => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
  return played.map((r, i) => {
    const rec = `${r.wins}-${r.losses}${r.pushes ? `-${r.pushes}` : ''}`;
    return `<div class="leader-row alltime${r.you ? ' you' : ''}">
      <div class="rank">${medal(i)}</div>
      <div>
        <strong>${r.name}${r.you ? ' <i class="you-tag">you</i>' : ''}</strong>
        <small>${rec} · ${r.bets} bet${r.bets === 1 ? '' : 's'} · ${r.weeks} week${r.weeks === 1 ? '' : 's'}${
          r.clv !== null && r.clvBets ? ` · <b class="${r.clv >= 0 ? 'positive' : 'negative'}">${r.clv >= 0 ? '+' : ''}${r.clv.toFixed(1)} CLV</b>` : ''}</small>
      </div>
      <div class="profit ${r.profit >= 0 ? '' : 'negative'}">${signedMoney(r.profit)}</div>
      <div class="tickets">${r.roi === null ? '—' : `${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(0)}% ROI`}</div>
    </div>`;
  }).join('');
}

/* money(-85) gives "$-85.00", which reads as a typo. Signed amounts belong
   outside the symbol. */
function signedMoney(n) {
  const v = Number(n) || 0;
  return `${v < 0 ? '-' : '+'}${money(Math.abs(v))}`;
}

function renderCompetition() {
  const rows = standings();
  const table = rows.map((r, i) => `
    <div class="leader-row ${r.you ? 'is-you' : ''}">
      <div class="rank">${i === 0 ? '👑' : `#${i + 1}`}</div>
      <div><strong>${r.name}</strong><small>${money(r.bankroll)} · ${r.hitRate}% hit${typeof r.roi === 'number' ? ` · ${r.roi >= 0 ? '+' : ''}${r.roi.toFixed(0)}% ROI` : ''} · ${r.betsUsed}/${WEEKLY_BET_LIMIT} bets</small></div>
      <div class="profit ${r.profit < 0 ? 'negative' : ''}">${r.profit >= 0 ? '+' : ''}${money(r.profit)}</div>
      <div class="tickets">${r.best ? `${r.best.legs}-leg ${fmtOdds(r.best.odds)}` : '—'}</div>
    </div>`).join('');

  const lb = document.getElementById('leaderboardList');
  document.querySelectorAll('[data-board-scope]').forEach(b =>
    b.classList.toggle('active', b.dataset.boardScope === boardScope));
  if (boardScope === 'alltime') {
    if (lb) lb.innerHTML = allTimeHtml();
    const note = document.getElementById('leaderboardNote');
    if (note) {
      note.hidden = !!allTimeRows;
      note.textContent = 'All-time standings need an account.';
    }
    const champ = document.getElementById('weekChampion');
    if (champ) champ.hidden = true;
    return;
  }
  const champShow = document.getElementById('weekChampion');
  if (champShow) champShow.hidden = false;
  if (lb) lb.innerHTML = table;
  const fr = document.getElementById('friendsRanking');
  if (fr) fr.innerHTML = table;

  const isDemo = !cloudBoard;
  const demoNote = document.getElementById('leaderboardNote');
  if (demoNote) {
    demoNote.hidden = !isDemo;
    demoNote.textContent = Cloud.enabled()
      ? 'Demo standings — sign in to see the real leaderboard.'
      : 'Demo standings. Rival figures are generated locally and are not real players.';
  }
  const champ = rows[0];
  const champBox = document.getElementById('weekChampion');
  if (champBox) {
    champBox.innerHTML = `<div class="champ-head"><span class="eyebrow">WEEK OF ${week.key}</span>
        <h2>${champ.you ? 'You are leading this week' : `${champ.name} is leading this week`}</h2>
        <p class="muted-copy">Ranked by realized profit. Everyone restarts at ${money(WEEKLY_BANKROLL)} Tuesday 4:00 AM ET.</p></div>
      <div class="champ-stats">
        <div><span>Profit</span><strong class="profit">${champ.profit >= 0 ? '+' : ''}${money(champ.profit)}</strong></div>
        <div><span>Hit rate</span><strong>${champ.hitRate}%</strong></div>
        <div><span>Bets used</span><strong>${champ.betsUsed}/${WEEKLY_BET_LIMIT}</strong></div>
        <div><span>Best ticket</span><strong>${champ.best ? `${champ.best.legs}-leg ${fmtOdds(champ.best.odds)}` : '—'}</strong></div>
      </div>`;
  }

  const mine = rows.findIndex(r => r.you) + 1;
  const cmp = document.getElementById('compareList');
  if (cmp) {
    const s = weekStats(week);
    cmp.innerHTML = `
      <div><span>Rank</span><strong>#${mine} of ${rows.length}</strong></div>
      <div><span>Weekly profit</span><strong>${s.realizedPL >= 0 ? '+' : ''}${money(s.realizedPL)}</strong></div>
      <div><span>Hit rate</span><strong>${s.hitRate}%</strong></div>
      <div><span>Bets used</span><strong>${s.betsUsed}/${WEEKLY_BET_LIMIT}</strong></div>`;
  }

  const hist = document.getElementById('weekHistory');
  if (hist) {
    hist.innerHTML = weekResults.length
      ? weekResults.map(r => `<div class="saved-row">
          <div><strong>Week of ${r.key}</strong><small>${r.betsUsed} bets · ${r.hitRate}% hit</small></div>
          <span class="grade">${r.bestTicket ? `best ${r.bestTicket.legs}-leg ${fmtOdds(r.bestTicket.odds)}` : 'no winners'}</span>
          <strong class="${r.profit < 0 ? 'negative' : 'profit'}">${r.profit >= 0 ? '+' : ''}${money(r.profit)}</strong></div>`).join('')
      : '<div class="empty-state">Your first completed week will be archived here on Monday.</div>';
  }
}

/* ---------- 12. Fantasy draft — real league format (v1.0) ----
   Ten starters, six bench, sixteen rounds:
     QB  RB RB  WR WR  TE  FLEX  OP  D/ST  K  + 6 BE
   The OP slot makes this a superflex league, which changes draft
   value materially — replacement QB is QB20, not QB12.
------------------------------------------------------------- */
const ROSTER_SLOTS = [
  { id: 'QB',   label: 'QB',   elig: ['QB'] },
  { id: 'RB1',  label: 'RB',   elig: ['RB'] },
  { id: 'RB2',  label: 'RB',   elig: ['RB'] },
  { id: 'WR1',  label: 'WR',   elig: ['WR'] },
  { id: 'WR2',  label: 'WR',   elig: ['WR'] },
  { id: 'TE',   label: 'TE',   elig: ['TE'] },
  { id: 'FLEX', label: 'FLEX', elig: ['RB', 'WR', 'TE'] },
  { id: 'OP',   label: 'OP',   elig: ['QB', 'RB', 'WR', 'TE'] },
  { id: 'DST',  label: 'D/ST', elig: ['DST'] },
  { id: 'K',    label: 'K',    elig: ['K'] }
];
const BENCH_SLOTS = 6;
const DRAFT_ROUNDS = ROSTER_SLOTS.length + BENCH_SLOTS;   // 16

/* ESPN "Roster Limits" — maximum players per position on one team.
   null = unlimited. These are placeholders: fill in the league's real
   caps and enforcement happens automatically everywhere, because
   assignSlot() is the single gate every pick passes through. */
const POSITION_LIMITS = { QB: null, RB: null, WR: null, TE: null, DST: null, K: null };

/* Slots are listed narrowest-first and their eligibility sets nest
   (FLEX ⊂ OP), so filling the first eligible empty slot can never
   strand a later pick. That guarantee dies if a non-nested slot is
   ever added — e.g. a WR/TE-only flex — at which point this needs
   real bipartite matching instead. Do not "optimise" it away. */
function assignSlot(roster, pos) {
  const cap = POSITION_LIMITS[pos];
  if (cap != null && roster.filter(r => r.pos === pos).length >= cap) return null;
  for (const s of ROSTER_SLOTS) {
    if (!s.elig.includes(pos)) continue;
    if (!roster.some(r => r.slot === s.id)) return s.id;
  }
  return roster.filter(r => r.slot === 'BE').length < BENCH_SLOTS ? 'BE' : null;
}
const needsStarter = (roster, pos) => {
  const s = assignSlot(roster, pos);
  return s !== null && s !== 'BE';
};

/* Value over replacement for THIS format. Swing slots (12 FLEX + 12 OP)
   are allocated by expected usage; the allocation is an assumption and
   is stated in the UI rather than hidden. */
/* Swing-slot allocation. QB was 8 of the 12 OP slots (demand 20), which put
   the top projected QB at pick 20 — too deep for a superflex league. Raised to
   10 (demand 22), which moves him to about pick 12, the round 1/2 turn, where
   superflex consensus actually has him. 24 was tried and overshot: ten QBs
   inside the top 30. */
const SWING = { FLEX: { RB: 8, WR: 12, TE: 4 }, OP: { QB: 10, RB: 1, WR: 1, TE: 0 } };
const BASE_STARTERS = { QB: 1, RB: 2, WR: 2, TE: 1, DST: 1, K: 1 };

/* Two different baselines, previously conflated — which broke the grade.

   `demand` (above) is how many of a position are STARTABLE. It sets replacement
   level for value over replacement, which orders the pool. Correct for that.

   `DRAFT_DEPTH` is how many of a position actually get DRAFTED across 16 rounds
   (~192 picks in a 12-team league). Grading a round-13 bench flier against
   starter-replacement scored it zero by construction, so six of every sixteen
   picks were automatic zeros and even a perfect draft topped out at 0.44.
   Grades are ranked against draft depth instead. */
const DRAFT_DEPTH = { QB: 30, RB: 55, WR: 62, TE: 26, DST: 14, K: 13 };
const draftDepth = (pos, teams) => Math.round((DRAFT_DEPTH[pos] || 40) * (teams / 12));

let players = [['1', 'Loading player pool…', 'RB', '']];
let draftPoolMeta = null;
let poolRankMode = 'proj';        // 'proj' = ESPN 2026 outlook | 'actual' = 2025 production

/* ESPN writes team defences by nickname; the 2025 pool uses abbreviations. */
const DST_NICKNAMES = {
  cardinals:'ARI', falcons:'ATL', ravens:'BAL', bills:'BUF', panthers:'CAR', bears:'CHI',
  bengals:'CIN', browns:'CLE', cowboys:'DAL', broncos:'DEN', lions:'DET', packers:'GB',
  texans:'HOU', colts:'IND', jaguars:'JAX', chiefs:'KC', raiders:'LV', chargers:'LAC',
  /* nflverse writes the Rams as LA, not LAR — this cost the Rams defence a
     match until it was caught. */
  rams:'LA', dolphins:'MIA', vikings:'MIN', patriots:'NE', saints:'NO', giants:'NYG',
  jets:'NYJ', eagles:'PHI', steelers:'PIT', ['49ers']:'SF', seahawks:'SEA',
  buccaneers:'TB', titans:'TEN', commanders:'WAS'
};
/* Sources disagree on a handful of team codes: ESPN writes WSH and LAR,
   nflverse writes WAS and LA. Normalise before comparing or displaying. */
const TEAM_ALIASES = { WSH: 'WAS', LAR: 'LA', JAC: 'JAX', ARZ: 'ARI', BLT: 'BAL', HST: 'HOU', CLV: 'CLE' };
const teamCode = t => TEAM_ALIASES[String(t || '').toUpperCase()] || String(t || '').toUpperCase();

/* Jr / Sr / II / III differ between sources constantly. */
const matchKey = name => {
  const raw = String(name || '');
  const dst = /d\/?st|defense/i.test(raw);
  if (dst) {
    const nick = norm(raw.replace(/d\/?st|defense/ig, ''));
    if (DST_NICKNAMES[nick]) return 'dst:' + teamCode(DST_NICKNAMES[nick]);
    return 'dst:' + teamCode(norm(raw).slice(0, 3));
  }
  return norm(raw.replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/ig, ''));
};

function mergeProjections() {
  if (!Fantasy.data) return { matched: 0, added: 0, total: 0 };
  const rows = (Fantasy.data.projections && Fantasy.data.projections.rows) || [];
  if (!rows.length) return { matched: 0, added: 0, total: 0 };
  const byKey = {};
  Fantasy.data.all.forEach(p => {
    const k = p.p === 'DST' ? 'dst:' + teamCode(p.t) : matchKey(p.n);
    byKey[k] = p;
  });
  let matched = 0, added = 0;
  Fantasy.projByName = {};
  rows.forEach(r => {
    const hit = byKey[matchKey(r.n)];
    if (hit) {
      hit.proj = r;
      hit.t = r.t ? teamCode(r.t) : hit.t;   // ESPN carries 2026 team changes
      Fantasy.projByName[hit.n] = r;
      matched++;
    } else {
      /* projection-only: a 2026 rookie or new arrival with no 2025 weekly
         data. Draftable, but not comparable — the compare tool needs a
         weekly series and there isn't one. */
      const synthetic = {
        id: 'proj-' + r.sn, n: r.n, sn: r.sn, p: r.p, t: teamCode(r.t),
        wk: [], s: [], r: [], ts: [], projOnly: true, proj: r
      };
      Fantasy.data.all.push(synthetic);
      Fantasy.projByName[r.n] = r;
      added++;
    }
  });
  Fantasy._cache = {};
  return { matched, added, total: rows.length };
}


function draftDemand(teams) {
  const d = {};
  Object.keys(BASE_STARTERS).forEach(pos => {
    d[pos] = BASE_STARTERS[pos] * teams + (SWING.FLEX[pos] || 0) + (SWING.OP[pos] || 0);
  });
  return d;
}

function buildDraftPool(teams = 12) {
  if (!Fantasy.data) return false;
  const ppr = p => p.s && p.s.length
    ? p.s.reduce((a, v, i) => a + v + (p.r[i] || 0), 0) / p.s.length : NaN;
  const demand = draftDemand(teams);
  const repl = {}, byPos = {};
  Fantasy.data.all.forEach(p => (byPos[p.p] = byPos[p.p] || []).push(p));
  Object.keys(demand).forEach(pos => {
    const vals = (byPos[pos] || []).map(ppr).filter(isFinite).sort((a, b) => b - a);
    repl[pos] = vals.length ? vals[Math.min(demand[pos], vals.length) - 1] : 0;
  });
  /* Projection-based replacement level, computed over projected season
     points where available. */
  const projPts = p => (p.proj ? p.proj.fpts / Math.max(1, p.proj.gp) : NaN);
  const replProj = {};
  Object.keys(demand).forEach(pos => {
    const vals = (byPos[pos] || []).map(projPts).filter(v => isFinite(v)).sort((a, b) => b - a);
    replProj[pos] = vals.length ? vals[Math.min(demand[pos], vals.length) - 1] : 0;
  });

  const seen = new Set(), pool = [];
  Object.keys(demand).forEach(pos => (byPos[pos] || []).forEach(p => {
    if (seen.has(p.n)) return;
    seen.add(p.n);
    const actualVbd = p.s.length ? ppr(p) - repl[pos] : NaN;
    const pv = projPts(p);
    const projVbd = isFinite(pv) ? pv - replProj[pos] : NaN;
    pool.push({
      n: p.n, pos, t: p.t || 'FA',
      vbd: isFinite(actualVbd) ? actualVbd : NaN,
      projVbd, proj: p.proj || null, projOnly: !!p.projOnly
    });
  }));

  /* Sort by the active mode. Anything missing the active metric drops below
     everything that has it, rather than being silently excluded. */
  const keyOf = p => poolRankMode === 'proj' ? p.projVbd : p.vbd;
  pool.sort((a, b) => {
    const x = keyOf(a), y = keyOf(b);
    if (isFinite(x) && isFinite(y)) return y - x;
    if (isFinite(x)) return -1;
    if (isFinite(y)) return 1;
    return (b.proj ? b.proj.rost : 0) - (a.proj ? a.proj.rost : 0);
  });

  players = pool.map((p, i) => [
    String(i + 1), p.n, p.pos, p.t,
    isFinite(keyOf(p)) ? keyOf(p) : null,
    norm(`${p.n} ${p.t} ${ABBR_TO_NAME[p.t] || ''} ${POS_ALIASES[p.pos] || p.pos}`),
    p.proj, p.projOnly, isFinite(p.vbd) ? p.vbd : null, isFinite(p.projVbd) ? p.projVbd : null
  ]);
  draftPoolMeta = { demand, repl, teams };
  return true;
}

const totalPicks = () => draftState.teams * DRAFT_ROUNDS;
const draftOver = () => draftState.pick > totalPicks();

function populateDraftSlots() {
  const count = Number(document.getElementById('teamCount').value);
  document.getElementById('draftSlot').innerHTML =
    Array.from({ length: count }, (_, i) => `<option ${i === 6 ? 'selected' : ''}>${i + 1}</option>`).join('');
}

function currentTeam() {
  const { teams, pick, round } = draftState;
  const pos = ((pick - 1) % teams) + 1;
  return round % 2 === 1 ? pos : teams - pos + 1;
}

function rosterOf(team) {
  if (!draftState.rosters[team]) draftState.rosters[team] = [];
  return draftState.rosters[team];
}

function makePick(team, row) {
  const roster = rosterOf(team);
  const slot = assignSlot(roster, row[2]);
  if (slot === null) return false;
  roster.push({ name: row[1], pos: row[2], team: row[3], slot, pick: draftState.pick });
  draftState.taken.push(row[1]);
  draftState.pick++;
  draftState.round = Math.ceil(draftState.pick / draftState.teams);
  return true;
}

/* CPU prefers filling a starting slot over stockpiling a bench, with a
   small reach factor so no two mocks are identical. */
function cpuPick(team) {
  const roster = rosterOf(team);
  const avail = players.filter(p => !draftState.taken.includes(p[1]));
  if (!avail.length) return null;
  const starters = avail.filter(p => needsStarter(roster, p[2]));
  const shortlist = (starters.length ? starters : avail).slice(0, 4);
  return shortlist[Math.floor(Math.random() * shortlist.length)] || avail[0];
}

function simulateUntilUser() {
  while (!draftOver() && currentTeam() !== draftState.slot) {
    const row = cpuPick(currentTeam());
    if (!row || !makePick(currentTeam(), row)) {
      showToast('Draft pool exhausted — ending draft.');
      finishDraft();
      return;
    }
  }
  if (draftOver()) finishDraft();
}

function startDraft() {
  const teams = Number(document.getElementById('teamCount').value);
  const slot = Number(document.getElementById('draftSlot').value);
  const scoring = document.getElementById('scoring').value;
  buildDraftPool(teams);
  draftState = { teams, slot, scoring, pick: 1, round: 1, taken: [], rosters: {} };
  document.getElementById('draftTitle').textContent =
    `${teams}-team ${scoring} · ${DRAFT_ROUNDS} rounds`;
  simulateUntilUser();
  renderDraft();
  if (draftState) showToast(`Draft started. You are on the clock at pick ${draftState.round}.${String(((draftState.pick - 1) % teams) + 1).padStart(2, '0')}.`);
}

function draftPlayer(name) {
  if (!draftState || currentTeam() !== draftState.slot) return;
  const row = players.find(x => x[1] === name);
  if (!row) return;
  if (!makePick(draftState.slot, row)) { showToast('No open roster spot for that position.'); return; }
  if (draftOver()) { finishDraft(); return; }
  simulateUntilUser();
  if (!draftState) return;
  renderDraft();
}

/* ---- Draft grading -----------------------------------------------
   Score each starter on positional rank against how many players at
   that position are startable league-wide, then take a weighted mean.

   The weight is the position's PPR *value spread* (top ppg minus
   replacement ppg), not the player's own points. Weighting by raw
   points was the first attempt and it overrated kickers: a kicker's
   12 ppg is a real share of a 188-point lineup, but K1 to K12 differ
   by under 4 ppg, so the choice barely matters. Measured spreads:
   RB 14.9, WR 12.1, TE 8.3, QB 6.9, K 3.8, D/ST 1.9 — so nailing your
   RB1 moves the grade roughly eight times more than nailing your D/ST,
   which is how it should feel.

   Thresholds are anchored to 3,000 simulated drafts across skill
   levels: a median draft lands near C/C-, a sharp one A-, an optimal
   one A+, a careless one F.
------------------------------------------------------------------- */
/* Round weighting: the first five rounds decide a fantasy season, the
   last eleven are lottery tickets and bye-week cover. Rounds 1-5 carry
   83% of the grade — a round-1 pick counts 11x a round-6 pick and 25x a
   round-16 pick. Explicit array rather than a formula so it stays
   readable and tunable. */
const ROUND_WEIGHTS = [
  1.00, 0.85, 0.72, 0.61, 0.52,                 // rounds 1-5   = 83%
  0.09, 0.09, 0.08, 0.08, 0.07, 0.07,           // rounds 6-11
  0.06, 0.06, 0.05, 0.05, 0.04                  // rounds 12-16
];
const roundWeight = r => ROUND_WEIGHTS[Math.min(Math.max(1, r || 1), ROUND_WEIGHTS.length) - 1];

/* Recalibrated against 2,500 simulated 16-round drafts under the new
   weighting: median lands at C, sharp A-, optimal A+, careless F. */
/* Anchored to measured skill levels from simulated drafts run through this
   exact grader, not to raw percentiles — a perfectly greedy draft is
   deterministic, so percentiles collapse the top grades onto one value.
   Measured after unrated picks were excluded from the mean:
   optimal 0.858, sharp 0.763, decent 0.662, casual 0.573, random 0.418.
   Those land on A+, A-, C+, D and F below. */
const GRADE_SCALE = [
  [0.840, 'A+'], [0.805, 'A'], [0.760, 'A-'],
  [0.725, 'B+'], [0.700, 'B'], [0.680, 'B-'],
  [0.655, 'C+'], [0.630, 'C'], [0.610, 'C-'],
  [0.590, 'D+'], [0.570, 'D'], [0.545, 'D-'],
  [0.490, 'F+'], [0.400, 'F'], [-Infinity, 'F-']
];
const letterFor = score => (GRADE_SCALE.find(([min]) => score >= min) || [0, 'F-'])[1];

/* Per-slot letters need their own mapping. A slot score is a clean 0-1 measure
   (positional rank against draft depth) whereas the overall score is a weighted
   mean compressed into roughly 0.18-0.62 — so reusing GRADE_SCALE for both
   handed A+ to a WR25. Conventional 0-1 grading applies here. */
const SLOT_SCALE = [
  [0.90, 'A+'], [0.85, 'A'], [0.80, 'A-'],
  [0.75, 'B+'], [0.70, 'B'], [0.65, 'B-'],
  [0.60, 'C+'], [0.55, 'C'], [0.50, 'C-'],
  [0.45, 'D+'], [0.40, 'D'], [0.35, 'D-'],
  [0.25, 'F+'], [0.15, 'F'], [-Infinity, 'F-']
];
const slotLetterFor = score => (SLOT_SCALE.find(([min]) => score >= min) || [0, 'F-'])[1];

/* Position weight = PPR points genuinely at stake there. */
function positionWeights(demand) {
  if (!Fantasy.data) return {};
  const key = 'w:' + poolRankMode + ':' + Object.values(demand).join(',');
  if (Fantasy._cache[key]) return Fantasy._cache[key];
  const ppr = p => {
    const v = Fantasy.draftMetric(p);
    return isFinite(v) && v > 0 ? v : NaN;
  };
  const out = {};
  Object.keys(demand).forEach(pos => {
    const vals = Fantasy.data.all.filter(p => p.p === pos).map(ppr).filter(isFinite).sort((a, b) => b - a);
    if (!vals.length) { out[pos] = 1; return; }
    const repl = vals[Math.min(demand[pos], vals.length) - 1];
    out[pos] = Math.max(0.5, vals[0] - repl);
  });
  Fantasy._cache[key] = out;
  return out;
}

function gradeDraft(roster) {
  const demand = (draftPoolMeta && draftPoolMeta.demand) || draftDemand(12);
  const weights = positionWeights(demand);
  const teams = (draftPoolMeta && draftPoolMeta.teams) || 12;
  const rows = roster.map(r => {
    const player = Fantasy.data ? Fantasy.data.all.find(x => x.n === r.name) : null;
    const prof = player ? Fantasy.profile(player) : null;
    const rk = player ? Fantasy.draftRank(player) : { rank: 0, total: 0 };
    const pool = draftDepth(r.pos, teams) || rk.total || 1;
    /* A pick we have no data for in the active mode is UNRATED, not a zero.
       Scoring it zero punished the drafter for a gap in our dataset — in
       2026-outlook mode that was 353 of 618 players. Unrated picks are
       excluded from the weighted mean and labelled in the results. */
    const metric = player ? Fantasy.draftMetric(player) : NaN;
    const rated = isFinite(metric);
    const slotScore = rated ? Math.max(0, 1 - (rk.rank - 1) / pool) : NaN;
    const round = r.pick ? Math.ceil(r.pick / teams) : 16;
    const ppg = rated ? metric : 0;
    return {
      slot: r.slot, name: r.name, pos: r.pos, team: r.team,
      rank: rated ? rk.rank : 0, total: rk.total, pool, round,
      ppg, rated,
      projected: !!(prof && prof.noHistory),
      score: rated ? slotScore : 0,
      letter: rated ? slotLetterFor(slotScore) : '—',
      starter: r.slot !== 'BE'
    };
  });
  const starters = rows.filter(r => r.starter);
  /* Every pick counts now, but weighted by round as well as position, so
     a round-1 miss dominates and a round-14 flier barely registers. */
  const wOf = r => roundWeight(r.round) * (weights[r.pos] || 1);
  const scored = rows.filter(r => r.rated);
  const den = scored.reduce((a, r) => a + wOf(r), 0);
  const raw = den ? scored.reduce((a, r) => a + r.score * wOf(r), 0) / den : 0;
  const score = isFinite(raw) ? raw : 0;
  const unrated = rows.length - scored.length;
  const starterPpg = starters.reduce((a, r) => a + r.ppg, 0);
  const earlyRows = scored.filter(r => r.round <= 5);
  const earlyDen = earlyRows.reduce((a, r) => a + wOf(r), 0);
  const earlyScore = earlyDen
    ? earlyRows.reduce((a, r) => a + r.score * wOf(r), 0) / earlyDen : 0;
  return { rows, score, letter: letterFor(score), starterPpg, weights, unrated,
           earlyScore, earlyLetter: letterFor(earlyScore) };
}

function finishDraft() {
  const roster = rosterOf(draftState.slot);
  const result = gradeDraft(roster);
  lastResult = {
    date: new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    format: `${draftState.teams}-team ${draftState.scoring} · ${DRAFT_ROUNDS}rd`,
    slot: draftState.slot,
    grade: result.letter,
    score: round2(result.score),
    starterPpg: round2(result.starterPpg),
    weights: result.weights,        // disclosed in the results footnote
    earlyScore: round2(result.earlyScore),
    earlyLetter: result.earlyLetter,
    rows: result.rows
  };
  savedDrafts.unshift(lastResult);
  if (savedDrafts.length > 10) savedDrafts.pop();
  draftState = null;
  persist();
  renderDraft();
  renderSavedDrafts();
  renderDraftResults(lastResult);
  showToast(`Draft complete — grade ${result.letter}.`);
}

/* A face and a prior-season finish. The headshot is an official NFL CDN
   URL that ships with the nflverse data — no images in the bundle, no
   hotlinking anyone's site. D/ST have no photo because they are not
   people, so they get a team badge; a broken image falls back to the
   same badge rather than showing a torn-page icon. */
function playerFace(name, pos, team, img, cls) {
  const badge = `<span class="face-badge">${pos === 'DST' ? (team || '??') : initialsOf(name)}</span>`;
  if (!img) return `<span class="face ${cls || ''}">${badge}</span>`;
  return `<span class="face ${cls || ''}">${badge}` +
         `<img src="${img}" alt="" loading="lazy" decoding="async" ` +
         `onload="this.parentNode.classList.add('loaded')" ` +
         `onerror="this.remove()"></span>`;
}
/* headshot by name, for the places that only carry a name string */
function faceOf(name) {
  if (!Fantasy.data) return null;
  const hit = Fantasy.data.all.find(x => x.n === name);
  return hit ? hit.img : null;
}
function initialsOf(n) {
  return String(n || '').trim().split(/\s+/).slice(0, 2)
    .map(w => w[0]).join('').toUpperCase() || '?';
}
/* "RB4 last year" — the most useful thing you can put beside a name. */
function priorRank(pl) {
  if (!pl || !pl.pr) return '';
  const pos = pl.p === 'DST' ? 'D/ST' : pl.p;
  return `<span class="prior" title="${pl.pt} PPR points in 2025">${pos}${pl.pr} <i>last yr</i></span>`;
}

function playerRow(p, active, roster) {
  const fits = roster ? assignSlot(roster, p[2]) : null;
  /* If every slot this position could occupy is taken and the bench is
     full, the pick is impossible. Say so on the button rather than
     letting the click no-op with a toast. */
  const blocked = !!roster && fits === null;
  const tag = blocked
    ? '<span class="need-chip full">roster full here</span>'
    : fits && fits !== 'BE'
      ? `<span class="need-chip">fills ${(ROSTER_SLOTS.find(s => s.id === fits) || {}).label || fits}</span>`
      : fits === 'BE' ? '<span class="need-chip bench">bench</span>' : '';
  const pr = p[6];
  const vbd = typeof p[4] === 'number'
    ? `<small>${p[4] >= 0 ? '+' : ''}${p[4].toFixed(1)} VOR</small>`
    : '<small class="no-metric">no data</small>';
  const flag = pr && pr.status
    ? `<i class="inj ${pr.status.toLowerCase()}" title="ESPN status: ${pr.status}">${pr.status}</i>` : '';
  const projCell = pr
    ? `<small class="proj-cell"><b>${pr.proj.toFixed(1)}</b> proj${flag}${
        pr.fpts ? ` · ${pr.fpts.toFixed(0)} szn` : ''}${
        pr.rost ? ` · ${pr.rost.toFixed(0)}%` : ''}</small>`
    : '<small class="proj-cell no-metric">—</small>';
  const btn = !active ? '<span></span>'
    : blocked ? '<button class="add-btn draft-btn" disabled title="No open slot for this position">No slot</button>'
    : `<button class="add-btn draft-btn" data-draft="${p[1]}">Draft</button>`;
  const rookie = p[7] ? '<span class="need-chip rookie">2026 only</span>' : '';
  const meta = Fantasy.data ? Fantasy.data.all.find(x => x.n === p[1]) : null;
  return `<div class="player-row${blocked ? ' blocked' : ''}">
    <div class="player-rank">${p[0]}</div>
    ${playerFace(p[1], p[2], p[3], meta && meta.img)}
    <div><strong>${p[1]}</strong><small>${p[3] || 'FA'} ${priorRank(meta)} ${rookie} ${tag}</small></div>
    <span class="position-chip">${p[2] === 'DST' ? 'D/ST' : p[2]}</span>
    ${projCell}
    ${vbd}
    ${btn}
  </div>`;
}

function renderRosterPanel(roster) {
  const box = document.getElementById('myRoster');
  if (!box) return;
  box.className = 'my-roster';
  const filled = id => roster.find(r => r.slot === id);
  const bench = roster.filter(r => r.slot === 'BE');
  box.innerHTML = ROSTER_SLOTS.map(s => {
    const r = filled(s.id);
    return `<div class="roster-slot ${r ? 'filled' : 'open'}">
      <span class="slot-tag">${s.label}</span>
      ${r ? `${playerFace(r.name, r.pos, r.team, faceOf(r.name), 'xs')}<div><strong>${r.name}</strong><small>${r.pos === 'DST' ? 'D/ST' : r.pos}${r.team ? ` · ${r.team}` : ''}</small></div>`
          : '<div class="slot-empty">—</div>'}
    </div>`;
  }).join('') + `<div class="bench-head">Bench ${bench.length}/${BENCH_SLOTS}</div>` +
    (bench.length ? bench.map(r => `<div class="roster-slot bench filled">
        <span class="slot-tag">BE</span>
        ${playerFace(r.name, r.pos, r.team, faceOf(r.name), 'xs')}<div><strong>${r.name}</strong><small>${r.pos === 'DST' ? 'D/ST' : r.pos}${r.team ? ` · ${r.team}` : ''}</small></div>
      </div>`).join('')
      : '<div class="slot-empty pad">No bench players yet</div>');
}

function renderScarcity() {
  const box = document.getElementById('draftScarcity');
  if (!box || !draftState) { if (box) box.innerHTML = ''; return; }
  const avail = players.filter(p => !draftState.taken.includes(p[1]));
  const rows = ['QB', 'RB', 'WR', 'TE', 'DST', 'K'].map(pos => {
    const left = avail.filter(p => p[2] === pos && (p[4] || 0) > 0).length;
    let needing = 0;
    for (let t = 1; t <= draftState.teams; t++) if (needsStarter(rosterOf(t), pos)) needing++;
    const tight = needing > left;
    return `<div class="scarce ${tight ? 'tight' : ''}">
      <span>${pos === 'DST' ? 'D/ST' : pos}</span>
      <strong>${left}</strong><small>${needing} teams need</small></div>`;
  }).join('');
  box.innerHTML = rows;
}

function poolQuery() {
  const el = document.getElementById('playerSearch');
  return norm(el ? el.value : '');
}
function poolPosFilter() {
  const b = document.querySelector('.pool-filter.active');
  return (b && b.dataset.poolPos) || 'all';
}
/* FIX: search used to be ignored entirely before a draft started, and a
   player already taken vanished from results with no explanation. Now one
   filter serves both states, and when you are searching, drafted players
   still appear — marked — so a name search never silently returns nothing. */
function filteredPool({ query, pos, taken, limit, roster }) {
  const q = query || '';
  let rows = players.filter(p => pos === 'all' || p[2] === pos);
  if (q) rows = rows.filter(p => (p[5] || norm(p[1])).includes(q));
  const isTaken = n => !!taken && taken.includes(n);
  let available = rows.filter(p => !isTaken(p[1]));

  /* FIX: late in a draft the bench fills up while K and D/ST slots are still
     open — and those sit at the bottom of a value board, so every row in the
     visible window was an unusable "No slot" entry with nothing draftable on
     screen. Rows you can actually take now float above rows you cannot,
     preserving value order inside each group. */
  let blockedCount = 0;
  if (roster) {
    const canTake = p => assignSlot(roster, p[2]) !== null;
    const yes = [], no = [];
    available.forEach(p => (canTake(p) ? yes : no).push(p));
    blockedCount = no.length;
    available = yes.concat(no);
  }
  const gone = q ? rows.filter(p => isTaken(p[1])) : [];
  return {
    total: rows.length,
    available: available.slice(0, limit),
    gone: gone.slice(0, 8),
    availableCount: available.length,
    goneCount: gone.length,
    blockedCount
  };
}

function renderPoolMeta(res, limit) {
  const el = document.getElementById('poolMeta');
  if (!el) return;
  const cov = Fantasy.projCoverage;
  const bits = [];
  if (cov && cov.total) {
    bits.push(poolRankMode === 'proj'
      ? `ESPN 2026 outlook · ${cov.total} of ${players.length} players covered`
      : `2025 production · all ${players.length} players`);
  }
  bits.push(`${res.availableCount} available`);
  if (res.goneCount) bits.push(`${res.goneCount} already drafted`);
  if (res.blockedCount) bits.push(`${res.blockedCount} have no open slot`);
  if (res.availableCount > limit) bits.push(`showing first ${limit}`);
  el.textContent = bits.join(' · ');
}

function renderDraft() {
  const board = document.getElementById('draftBoard');
  const pool = document.getElementById('playerPool');
  const roster = document.getElementById('myRoster');
  if (!board || !pool || !roster) return;

  if (!draftState) {
    board.innerHTML = `<div class="empty-state" style="grid-column:1/-1">Choose settings and start a ${DRAFT_ROUNDS}-round mock draft.</div>`;
    const res = filteredPool({ query: poolQuery(), pos: poolPosFilter(), taken: null, limit: 40 });
    pool.innerHTML = res.available.map(p => playerRow(p, false, null)).join('')
      || '<div class="empty-state">No players match.</div>';
    renderPoolMeta(res, 40);
    roster.className = 'my-roster empty-state';
    roster.textContent = 'Start a draft to see your roster fill.';
    document.getElementById('roundLabel').textContent = 'Round 1';
    document.getElementById('pickLabel').textContent = 'Pick 1.01';
    renderScarcity();
    return;
  }

  const cells = [];
  for (let i = 1; i <= totalPicks(); i++) {
    const round = Math.ceil(i / draftState.teams);
    const pos = ((i - 1) % draftState.teams) + 1;
    const team = round % 2 === 1 ? pos : draftState.teams - pos + 1;
    const mine = team === draftState.slot;
    const entry = (draftState.rosters[team] || []).find(r => r.pick === i);
    cells.push(`<div class="draft-cell ${mine ? 'mine' : ''} ${entry ? 'filled' : ''} ${i === draftState.pick ? 'onclock' : ''}">
      ${round}.${String(pos).padStart(2, '0')}<br>${entry ? `<b class="pc-${entry.pos}">${entry.pos === 'DST' ? 'DST' : entry.pos}</b>` : ''}</div>`);
  }
  board.innerHTML = cells.join('');
  /* The board rebuilds on every pick, which resets scroll to the start. On a
     phone that means you always see round 1 no matter whose turn it is. */
  requestAnimationFrame(() => {
    const live = board.querySelector('.draft-cell.onclock');
    if (live && live.scrollIntoView) {
      try { live.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); }
      catch (e) { /* older engines ignore the options object */ }
    }
  });
  const prog = document.getElementById('draftProgress');
  if (prog) prog.innerHTML = `<span style="width:${Math.min(100, 100 * (draftState.pick - 1) / totalPicks()).toFixed(1)}%"></span>`;
  document.getElementById('roundLabel').textContent = `Round ${draftState.round} of ${DRAFT_ROUNDS}`;
  document.getElementById('pickLabel').textContent =
    `Pick ${draftState.round}.${String(((draftState.pick - 1) % draftState.teams) + 1).padStart(2, '0')}`;

  const mine = rosterOf(draftState.slot);
  const res = filteredPool({ query: poolQuery(), pos: poolPosFilter(), taken: draftState.taken, limit: 60, roster: mine });
  const gone = res.gone.map(p => {
    const byMe = mine.some(r => r.name === p[1]);
    return `<div class="player-row gone">
      <div class="player-rank">${p[0]}</div>
      <div><strong>${p[1]}</strong><small>${p[3] || 'FA'} <span class="need-chip taken">${byMe ? 'on your roster' : 'already drafted'}</span></small></div>
      <span class="position-chip">${p[2] === 'DST' ? 'D/ST' : p[2]}</span>
      <small>${typeof p[4] === 'number' ? `${p[4] >= 0 ? '+' : ''}${p[4].toFixed(1)} VOR` : ''}</small>
      <span></span></div>`;
  }).join('');
  pool.innerHTML = (res.available.map(p => playerRow(p, true, mine)).join('') + gone)
    || '<div class="empty-state">No players match.</div>';
  renderPoolMeta(res, 60);
  pool.querySelectorAll('[data-draft]').forEach(b => b.onclick = () => draftPlayer(b.dataset.draft));

  renderRosterPanel(mine);
  renderScarcity();
}

/* ---- Draft summary -------------------------------------------------
   "Draft more RBs" is generic and wrong about half the time — someone
   holding RB3 and RB6 needs a tight end, not another back. So the note
   is derived instead of asserted:

     leverage(slot) = (1 - rankScore) x positionWeight

   which is literally how many grade points are recoverable there. It
   correctly refuses to nag about D/ST (weight 1.9) and the improvement
   is *measured* by re-grading a substituted roster, not claimed.
-------------------------------------------------------------------- */
const UPGRADE_TARGET_RANK = 12;

function draftSummary(res) {
  if (!res || !res.rows || !Fantasy.data) return null;
  const weights = res.weights || {};
  const starters = res.rows.filter(r => r.starter);
  if (!starters.length) return null;

  const ranked = starters.filter(r => r.rated)
    .map(r => ({ ...r, leverage: (1 - r.score) * (weights[r.pos] || 1) * roundWeight(r.round) }))
    .sort((a, b) => b.leverage - a.leverage);
  const weakest = ranked[0];
  const strongest = starters.filter(r => r.rated).slice().sort((a, b) => b.score - a.score)[0];
  if (!weakest || !strongest) return null;
  const slotLabel = id => (ROSTER_SLOTS.find(s => s.id === id) || {}).label || id;

  /* measured counterfactual: swap in the player at the target rank */
  let upgrade = null;
  if (weakest && weakest.rank > UPGRADE_TARGET_RANK) {
    const held = new Set(res.rows.map(r => r.name));
    const pool = Fantasy.peers(weakest.pos)
      .map(p => ({ p, r: Fantasy.rankOf(p, 'ppg').rank }))
      .sort((a, b) => a.r - b.r);
    const cand = pool.find(x => x.r >= UPGRADE_TARGET_RANK && !held.has(x.p.n))
              || pool.find(x => !held.has(x.p.n));
    if (cand) {
      const swapped = res.rows.map(r => r.slot === weakest.slot
        ? { slot: r.slot, name: cand.p.n, pos: cand.p.p, team: cand.p.t }
        : { slot: r.slot, name: r.name, pos: r.pos, team: r.team });
      const regraded = gradeDraft(swapped);
      if (regraded.letter !== res.grade) {
        upgrade = { rank: cand.r, letter: regraded.letter, pos: weakest.pos };
      }
    }
  }

  /* depth risk — only where the value spread justifies caring */
  const counts = {};
  res.rows.forEach(r => counts[r.pos] = (counts[r.pos] || 0) + 1);
  const thin = ['RB', 'WR'].filter(pos => {
    const startSlots = ROSTER_SLOTS.filter(s => s.elig.includes(pos) && s.elig.length === 1).length;
    return (counts[pos] || 0) <= startSlots;
  });

  return { weakest, strongest, upgrade, thin, slotLabel, ranked };
}

/* A closing line at the end of every draft. Keyed to the grade tier so a
   rough board gets encouragement rather than a lecture, with one real
   detail from the roster so it never reads as a form letter. */
const CLOSERS = {
  A: ['That is a serious board. You would be a problem in this league.',
      'Excellent draft. Very little left on the table.',
      'Hard to do much better from that slot.'],
  B: ['Solid draft with a real spine to it.',
      'Good board. A couple of swings from being scary.',
      'You will be competitive every week with this.'],
  C: ['Workable roster — the pieces are there.',
      'Middle of the pack, and one good waiver run from better.',
      'Nothing broken here, just room to sharpen.'],
  D: ['Rough patches, but seasons get won on the wire too.',
      'Not the board you wanted, though the core is salvageable.',
      'Tough draft. Worth running another and comparing.'],
  F: ['That one got away — worth another run.',
      'Rough board. The good news is mocks are free.',
      'Not your night. Run it again and target the early rounds.']
};

function closingMessage(res) {
  if (!res || !res.rows) return '';
  const tier = String(res.grade)[0];
  const pool = CLOSERS[tier] || CLOSERS.C;
  const line = pool[Math.floor(Math.random() * pool.length)];

  const early = res.rows.filter(r => r.round <= 5 && r.rated);
  const standout = early.slice().sort((a, b) => b.score - a.score)[0];
  const bits = [];
  if (standout && standout.score > 0.6) {
    bits.push(`Best early pick: <b>${standout.name}</b> at ${standout.pos === 'DST' ? 'D/ST' : standout.pos}${standout.rank} in round ${standout.round}.`);
  }
  /* If the first five rounds graded differently from the whole board, say
     so — it is the most useful single sentence in the panel. */
  if (res.earlyLetter && res.earlyLetter !== res.grade) {
    const better = res.earlyScore > res.score;
    bits.push(`Your first five rounds alone grade <b>${res.earlyLetter}</b> — ${better ? 'the early board was stronger than the depth behind it' : 'the depth picks pulled you up'}.`);
  }
  return `<div class="res-closer"><p>${line} ${bits.join(' ')}</p></div>`;
}

function summaryHtml(res) {
  const s = draftSummary(res);
  if (!s) return '';
  const posName = p => p === 'DST' ? 'D/ST' : p;
  const parts = [];

  if (s.weakest.score > 0.85) {
    parts.push(`<strong>No obvious upgrade.</strong> Every starting spot is near the top of its position — this is a strong roster to have come out of ${res.format.split('·')[0].trim()}.`);
  } else {
    parts.push(`<strong>Your ${s.slotLabel(s.weakest.slot)} is the weak spot.</strong> ${s.weakest.name} is ${posName(s.weakest.pos)}${s.weakest.rank} of ${s.weakest.total} — the least valuable high-leverage slot you have.`);
    if (s.upgrade) {
      parts.push(`A top-${s.upgrade.rank} ${posName(s.upgrade.pos)} there lifts this draft from <b>${res.grade}</b> to <b>${s.upgrade.letter}</b>.`);
    } else {
      parts.push(`Upgrading it would help, though not enough on its own to change the letter grade.`);
    }
  }

  if (s.thin.length) {
    parts.push(`Depth risk at ${s.thin.map(posName).join(' and ')} — you have no backup, so a bye week or injury starts costing you points the grade can't see.`);
  }

  parts.push(`Strength: ${s.strongest.name} at ${posName(s.strongest.pos)}${s.strongest.rank}.`);
  return `<div class="res-summary-note"><p>${parts.join(' ')}</p></div>`;
}

/* Post-draft results: the roster you actually ended up with, each
   starter's positional rank and PPR average, and a per-slot grade. */
function renderDraftResults(res) {
  const box = document.getElementById('draftResults');
  if (!box) return;
  if (!res) { box.innerHTML = ''; box.classList.remove('open'); return; }
  const slotLabel = id => id === 'BE' ? 'BE' : (ROSTER_SLOTS.find(s => s.id === id) || {}).label || id;
  const starters = res.rows.filter(r => r.starter);
  const bench = res.rows.filter(r => !r.starter);
  const line = r => `<div class="res-row">
      <span class="slot-tag">${slotLabel(r.slot)}</span>
      ${playerFace(r.name, r.pos, r.team, faceOf(r.name), 'xs')}
      <div><strong>${r.name}</strong><small>${r.pos === 'DST' ? 'D/ST' : r.pos}${r.team ? ` · ${r.team}` : ''}</small></div>
      <div class="res-round">R${r.round}</div>
      <div class="res-rank">${r.rated ? `${ordinal(r.rank)}<small>of ${r.pool}</small>` : `—<small>unrated</small>`}</div>
      <div class="res-ppg">${(isFinite(r.ppg) ? r.ppg : 0).toFixed(1)}<small>${r.projected ? 'proj' : 'ppg'}</small></div>
      <span class="res-grade g${r.letter[0]}">${r.letter}</span>
    </div>`;
  box.classList.add('open');
  box.innerHTML = `
    <div class="panel-head"><div><span class="eyebrow">DRAFT RESULTS</span>
      <h2>Your team</h2><p class="muted-copy">${res.format} · slot ${res.slot} · ${res.date}</p></div>
      <button class="text-btn" id="closeResults">Close</button></div>
    <div class="res-summary">
      <div class="res-badge g${res.grade[0]}"><strong>${res.grade}</strong><span>overall</span></div>
      <div><span>Starter PPR / week</span><strong>${res.starterPpg.toFixed(1)}</strong></div>
      <div><span>Rounds 1-5 grade</span><strong class="g${String(res.earlyLetter || res.grade)[0]}">${res.earlyLetter || '—'}</strong></div>
      <div><span>Picks rated</span><strong>${res.rows.filter(r => r.rated).length}/${res.rows.length}</strong></div>
    </div>
    ${summaryHtml(res)}
    <div class="res-list">${starters.map(line).join('')}</div>
    <div class="bench-head">Bench</div>
    <div class="res-list bench">${bench.map(line).join('') || '<div class="slot-empty pad">None</div>'}</div>
    <p class="cmp-note">Each slot is graded on positional rank against how many players at that position get drafted across ${DRAFT_ROUNDS} rounds in a ${(draftPoolMeta || {}).teams || 12}-team league (QB ${DRAFT_DEPTH.QB}, RB ${DRAFT_DEPTH.RB}, WR ${DRAFT_DEPTH.WR}, TE ${DRAFT_DEPTH.TE}).
      The overall grade weights those by how much PPR value is actually at stake per position${res.weights ? ` — ${['RB','WR','TE','QB','K','DST'].filter(k => res.weights[k]).map(k => `${k === 'DST' ? 'D/ST' : k} ${res.weights[k].toFixed(1)}`).join(', ')}` : ''} — so your RB1 moves the grade far more than your kicker.
      Rounds 1-5 carry 83% of the weight — a round-1 pick counts 11x a round-6 pick.
      Calibrated against simulated drafts run through this same grader: a greedy-optimal board
      scores A+, a sharp one A-, a middling one C+, a careless one F. Picks with no data in the
      active mode are marked unrated and left out of the mean rather than counted as zero.</p>
    ${closingMessage(res)}`;
  const close = document.getElementById('closeResults');
  if (close) close.onclick = () => renderDraftResults(null);
}

function renderSavedDrafts() {
  const box = document.getElementById('savedDrafts');
  if (!box) return;
  box.innerHTML = savedDrafts.length
    ? savedDrafts.map((d, i) => `<button class="saved-row" data-open-draft="${i}">
        <div><strong>${d.format}</strong><small>Slot ${d.slot} · ${d.date} · ${(d.rows || []).filter(r => r.starter).length} starters · ${(d.starterPpg || 0).toFixed(1)} ppg</small></div>
        <span class="grade g${String(d.grade)[0]}">${d.grade}</span><strong>View</strong></button>`).join('')
    : '<div class="empty-state">Complete a draft and it will be saved here.</div>';
  box.querySelectorAll('[data-open-draft]').forEach(b => b.onclick = () => {
    renderDraftResults(savedDrafts[Number(b.dataset.openDraft)]);
    const r = document.getElementById('draftResults');
    if (r && r.scrollIntoView) r.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

/* ---------- 12b. Upcoming games ticker ----------------------------
   Real 2026 Week 1 kickoffs from nflverse schedules. The strip loops by
   duplicating its contents, so the scroll is pure CSS with no timer.
------------------------------------------------------------------- */
function fmtGameTime(t) {
  const m = /^(\d{1,2}):(\d{2})/.exec(t || '');
  if (!m) return t || '';
  let h = Number(m[1]);
  const suffix = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${m[2]} ${suffix}`;
}

/* Kickoff as "Thu 8:00 PM", in Eastern regardless of where the viewer is —
   the board quotes ET everywhere else, and a ticker that silently localises
   would disagree with the game rows underneath it. */
function tickerWhen(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short',
    hour: 'numeric', minute: '2-digit'
  }).format(d).replace(',', '');
}

/* v1.7.4: the ticker used to read the fantasy schedule file, which is pinned to
   Week 1 — so it announced "Sunday, Sep 13" while the board showed preseason
   games three weeks sooner. It now reads the same slate as the board, so the two
   can never disagree and the ticker rolls forward on its own. */
function renderTicker() {
  const strip = document.getElementById('gameTicker');
  if (!strip) return;
  const bar = strip.closest('.ticker-bar');

  let games = [], label = '', count = 0;

  const slate = (typeof RealBoard !== 'undefined' && RealBoard.data) ? RealBoard.upcoming() : [];
  if (slate.length) {
    games = slate.map(g => ({ away: g.away, home: g.home, when: tickerWhen(g.kickoff) }));
    label = RealBoard.label();
    count = slate.length;
  } else if (Fantasy.data && Fantasy.data.schedule) {
    /* fall back to the fantasy schedule only if no slate has any game left */
    const sch = Fantasy.data.schedule;
    const feature = (sch.games || []).filter(g => g.date === sch.featureDate);
    const list = feature.length ? feature : (sch.games || []);
    games = list.map(g => ({ away: g.away, home: g.home, when: fmtGameTime(g.time) }));
    label = `${new Date(sch.featureDate + 'T12:00:00').toLocaleDateString(undefined,
      { weekday: 'long', month: 'short', day: 'numeric' })} · Week ${sch.week}`;
    count = list.length;
  }

  if (!games.length) { if (bar) bar.hidden = true; return; }
  if (bar) bar.hidden = false;

  const head = document.getElementById('tickerLabel');
  if (head) head.textContent = label;

  const item = g => `<span class="tick"><b>${g.away}</b><i>@</i><b>${g.home}</b><em>${g.when} ET</em></span>`;
  const run = games.map(item).join('');
  strip.innerHTML = `<div class="tick-run">${run}</div><div class="tick-run" aria-hidden="true">${run}</div>`;
  strip.style.animationDuration = `${Math.max(28, games.length * 4.5)}s`;
  const el = document.getElementById('tickerCount');
  if (el) el.textContent = `${count} game${count === 1 ? '' : 's'}`;
}

/* ---------- 12a2. Settlement from real results (v1.7.4) -------------
   Open tickets sat open forever: nothing in the app could learn that a game
   had finished. With the scores feed it can.

   TWO RULES, and the second matters more than it looks:

   1. A ticket grades when every leg has a final result. All legs correct is a
      win; one leg wrong is a loss, immediately, without waiting for the rest.
   2. A ticket that cannot be graded 3 days after its last kickoff is VOIDED and
      the stake refunded. Not lost — voided. The bettor did nothing wrong; the
      book failed to grade it, and a book that keeps your stake because its own
      feed missed a game is stealing. This is also what stops the ledger filling
      with tickets that can never resolve.

   AUTHORITY. docs/SPORTSBOOK_MODEL.md is explicit that the database settles and
   users may not update their own bets — otherwise anyone could self-declare a
   win. So this proposes; who applies it depends:
     offline / signed out -> applied locally, which is the only ledger there is
     signed in as admin   -> applied and pushed for everyone
     signed in, not admin -> NOT applied; the server's decision arrives by poll
------------------------------------------------------------------- */
const SETTLE_GRACE_MS = 3 * 24 * 60 * 60 * 1000;   // 3 days
const Scores = {
  data: null,
  fetchedAt: 0,
  async load({ force = false } = {}) {
    if (!force && this.data && Date.now() - this.fetchedAt < 5 * 60_000) return this.data;
    const base = ((window.VIG_CONFIG || {}).SUPABASE_URL || '').trim().replace(/\/$/, '');
    if (!base) return null;
    const anon = ((window.VIG_CONFIG || {}).SUPABASE_ANON_KEY || '').trim();
    const res = await fetch(`${base}/functions/v1/odds?feed=scores`, {
      headers: { accept: 'application/json', apikey: anon, Authorization: `Bearer ${anon}` }
    });
    if (!res.ok) throw new Error(`scores ${res.status}`);
    const body = await res.json();
    this.data = Array.isArray(body) ? body : [];
    this.fetchedAt = Date.now();
    return this.data;
  },
  /* Final result for one game, or null while it is unplayed or in progress. */
  result(game) {
    if (!game || !game.completed) return null;
    const s = {};
    (game.scores || []).forEach(x => { s[String(x.name)] = Number(x.score); });
    const home = s[game.home_team], away = s[game.away_team];
    if (!isFinite(home) || !isFinite(away)) return null;
    return {
      home: game.home_team, away: game.away_team,
      homeScore: home, awayScore: away,
      winner: home > away ? game.home_team : away > home ? game.away_team : null,  // null = tie
      completedAt: game.commence_time
    };
  }
};

/* Match a leg to a finished game. Legs carry a title like "Buffalo Bills
   moneyline" and a gameId; the feed uses full team names. */
function resultForLeg(leg, results) {
  if (!leg) return null;
  const title = String(leg.title || '');
  const gid = String(leg.gameId || '').toLowerCase();
  const hit = results.find(r => {
    if (title.includes(r.home) || title.includes(r.away)) return true;
    if (!gid) return false;
    const h = String(abbrev(r.home)).toLowerCase(), a = String(abbrev(r.away)).toLowerCase();
    return gid.includes(h) && gid.includes(a);
  });
  if (!hit) return null;

  /* Which side did this leg back? Title first; a gameId alone is the matchup,
     not a side, so an unreadable leg stays ungraded rather than guessed. */
  const backed = title.includes(hit.home) ? hit.home
               : title.includes(hit.away) ? hit.away : null;
  if (!backed) return null;
  if (hit.winner === null) return { outcome: 'push', game: hit };    // tie: stake back
  return { outcome: hit.winner === backed ? 'win' : 'loss', game: hit };
}

/* What SHOULD each open ticket become, given the results we have?
   Returns proposals only — nothing is written here. */
function gradeOpenTickets(results, now = Date.now()) {
  const out = [];
  (week.tickets || []).filter(t => t.status === 'open').forEach(t => {
    const legs = t.legs || [];
    const graded = legs.map(l => resultForLeg(l, results));

    /* One wrong leg settles a parlay immediately — the rest cannot save it. */
    if (graded.some(g => g && g.outcome === 'loss')) {
      out.push({ id: t.id, status: 'lost', reason: 'a leg lost' });
      return;
    }
    if (graded.every(g => g && (g.outcome === 'win' || g.outcome === 'push'))) {
      const allPush = graded.every(g => g.outcome === 'push');
      out.push({ id: t.id, status: allPush ? 'push' : 'won',
                 reason: allPush ? 'every leg tied' : 'every leg won' });
      return;
    }

    /* Ungraded. Has it run out of time? */
    const placed = Date.parse(t.placedAt || t.date || '') || 0;
    const lastKick = legs.reduce((max, l) => {
      const g = l.gameId ? RealBoard.find(l.gameId) : null;
      const k = g ? Date.parse(g.kickoff) : 0;
      return Math.max(max, k || 0);
    }, 0) || placed;
    if (lastKick && now - lastKick > SETTLE_GRACE_MS) {
      out.push({ id: t.id, status: 'void',
                 reason: 'no result within 3 days — stake refunded' });
    }
  });
  return out;
}

/* Apply proposals, respecting who is allowed to settle. */
async function autoSettleFromScores({ quiet = false } = {}) {
  let games;
  try { games = await Scores.load(); } catch (e) {
    if (!quiet) console.warn('[VIG] scores unavailable:', e.message);
    return { applied: 0, proposed: 0, blocked: null };
  }
  if (!games) return { applied: 0, proposed: 0, blocked: null };

  const results = games.map(g => Scores.result(g)).filter(Boolean);
  const proposals = gradeOpenTickets(results);
  if (!proposals.length) return { applied: 0, proposed: 0, blocked: null };

  const cloud = Cloud.enabled() && Cloud.signedIn();
  if (cloud && !Admin.isServerAdmin()) {
    /* The database decides. Saying so beats silently doing nothing. */
    return { applied: 0, proposed: proposals.length, blocked: 'server-settles' };
  }

  let applied = 0;
  proposals.forEach(p => {
    const t = (week.tickets || []).find(x => x.id === p.id);
    if (!t || t.status !== 'open') return;
    t.status = p.status;                     // status only — payout() derives the rest
    t.settledAt = new Date().toISOString();
    t.settledBy = 'scores';
    t.settleNote = p.reason;
    applied++;
    if (cloud) Outbox.addSettlement && Outbox.addSettlement(t, week.key);
  });
  if (applied) {
    week.bankroll = derivedBankroll(week);
    persist();
    updateDashboard(); renderBets(activeBetFilter()); renderCompetition();
    if (!quiet) showToast(`${applied} ticket${applied === 1 ? '' : 's'} settled from final scores.`);
  }
  return { applied, proposed: proposals.length, blocked: null };
}

/* ---------- 12b1. Live bet tracking ---------------------------------
   Open tickets need to reflect reality without a page reload. Right now
   the only thing that can change a status is an admin settling an event,
   which happens in the database — so this polls for it. When the live
   odds feed lands at v1.7 the same loop carries score-driven settlement,
   because the plumbing is identical: pull, diff, re-render, notify.
------------------------------------------------------------------- */
let lastSync = null;
let trackTimer = null;

function openTickets() { return week.tickets.filter(t => t.status === 'open'); }

/* Pull current status for this week's tickets and apply any changes.
   Returns the list of tickets whose status actually moved. */
async function refreshTickets({ quiet = false } = {}) {
  if (!(Cloud.enabled() && Cloud.signedIn())) {
    lastSync = Date.now();
    renderBetsLive();
    return [];
  }
  /* Deliberately no "skip if unreachable" guard here. That made the flag a
     one-way latch: once set, nothing ever tried again, so the app could
     never notice the server had come back. One request a minute is not
     hammering anyone — let the result decide. */
  let remote;
  try {
    remote = await Cloud.myBets(week.key);
  } catch (e) {
    Cloud.reachable = false;
    renderBetsLive();
    return [];
  }
  Cloud.reachable = true;          // the call came back, so we are online again
  if (Cloud.profileUnknown) Cloud.loadProfile().then(() => { renderAccountChip(); renderBetsLive(); });
  const byId = {};
  remote.forEach(t => (byId[t.id] = t));
  const changed = [];
  migrateLocalTickets(remote);
  week.tickets = dedupeTickets(week.tickets).map(local => {
    const r = byId[local.id];
    if (!r) return local;                       // queued locally, not yet sent
    if (r.status !== local.status || r.closeProb !== local.closeProb) changed.push(r);
    return r;
  });
  /* anything the server has that we do not — a bet placed on another
     device. This was being added to state but never re-rendered, because
     only status CHANGES triggered a redraw. */
  let added = 0;
  remote.forEach(r => {
    if (!week.tickets.some(t => t.id === r.id)) { week.tickets.push(r); added++; }
  });
  if (added) week.tickets.sort((a, b) =>
    String(b.placedAt || '').localeCompare(String(a.placedAt || '')));

  week.bankroll = derivedBankroll(week);
  lastSync = Date.now();
  persist();
  renderBetsLive();
  if (changed.length || added) {
    renderBets(activeBetFilter());
    updateDashboard();
    refreshLeaderboard();
    if (!quiet && added && !changed.length) {
      showToast(`${added} bet${added === 1 ? '' : 's'} synced from another device.`);
    }
    if (!quiet && changed.length) {
      const won = changed.filter(t => t.status === 'won').length;
      showToast(won ? `${won} bet${won === 1 ? '' : 's'} won.`
                    : `${changed.length} bet${changed.length === 1 ? '' : 's'} settled.`);
    }
  }
  return changed;
}

function renderBetsLive() {
  const label = document.getElementById('betsUpdated');
  const dot = document.getElementById('betsLiveDot');
  if (!label || !dot) return;
  const open = openTickets().length;
  if (!Cloud.enabled()) {
    label.textContent = open ? `${open} open · local only` : 'Local only';
    dot.className = 'live-dot off';
    return;
  }
  if (!Cloud.signedIn()) { label.textContent = 'Sign in to track bets'; dot.className = 'live-dot off'; return; }
  if (cloudUnreachable()) { label.textContent = 'Server unreachable'; dot.className = 'live-dot warn'; return; }
  const ago = lastSync ? Math.round((Date.now() - lastSync) / 1000) : null;
  const when = ago === null ? 'never'
    : ago < 5 ? 'just now'
    : ago < 60 ? `${ago}s ago`
    : `${Math.round(ago / 60)}m ago`;
  label.textContent = open ? `${open} open · updated ${when}` : `Updated ${when}`;
  dot.className = open ? 'live-dot on' : 'live-dot idle';
}

/* Poll only while something is actually open, and back off when the tab
   is hidden so a phone in a pocket is not waking the radio every minute. */
function startBetTracking() {
  /* This used to return early when the device had no open tickets, so a
     device whose bets were already graded stopped listening entirely and
     never saw anything change — including a settlement done elsewhere.
     It now always polls, just less often when nothing is pending. */
  let idleTicks = 0, settleTicks = 0;
  const tick = () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    /* Check for final scores every 5 minutes while anything is open. The
       scores response is cached server-side, so this costs nothing upstream
       most of the time. */
    if (openTickets().length && ++settleTicks >= 5) {
      settleTicks = 0;
      autoSettleFromScores({ quiet: false });
    }
    if (openTickets().length) { idleTicks = 0; refreshTickets({ quiet: false }); return; }
    renderBetsLive();
    if (++idleTicks >= 4) { idleTicks = 0; refreshTickets({ quiet: true }); }
  };
  clearInterval(trackTimer);
  trackTimer = setInterval(tick, 60000);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && openTickets().length) refreshTickets({ quiet: true });
    });
  }
  const btn = document.getElementById('betsRefresh');
  if (btn) btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Refreshing…';
    const changed = await refreshTickets({ quiet: true });
    btn.disabled = false; btn.textContent = 'Refresh';
    showToast(changed.length ? `${changed.length} bet${changed.length === 1 ? '' : 's'} updated.` : 'No changes.');
  };
  renderBetsLive();
}

/* ---------- 12b2. Games on the home dashboard ----------------------
   Driven by the moneyline board, not the schedule. The two do not cover
   the same fixtures — the board is this week's priced games, the schedule
   is the full 2026 Week 1 slate — so building from the schedule produced
   cards with no odds on them. The home screen should show what you can
   actually bet on. Team names and kickoff times are facts; no logos.
------------------------------------------------------------------- */
function renderHomeGames() {
  const box = document.getElementById('homeGames');
  if (!box) return;
  const nfl = markets.filter(m => m.category === 'nfl' && m.gameId);
  const byGame = {};
  nfl.forEach(m => (byGame[m.gameId] = byGame[m.gameId] || []).push(m));
  /* soonest kickoff first — the board now spans Wednesday to Sunday */
  const order = RealBoard.games().map(g => g.gameId);
  const ids = Object.keys(byGame)
    .sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999))
    .slice(0, 6);
  if (!ids.length) { box.innerHTML = '<div class="empty-state">Board loading…</div>'; return; }

  box.innerHTML = ids.map(id => {
    const pair = byGame[id];
    const detail = pair[0].detail || '';
    const when = detail.includes('·') ? detail.split('·').pop().trim() : id.toUpperCase().replace('-', ' @ ');
    const abbrOf = m => (m.id || '').split(':').pop();
    const side = m => {
      const on = selected.some(x => x.id === m.id);
      const cls = on ? ' on' : (selected.length ? ' to-parlay' : '');
      return `<button class="game-side${cls}" data-add="${m.id}" ` +
             `title="${on ? 'Remove from slip' : selected.length ? 'Add to parlay' : 'Bet this'}">` +
             `<span>${abbrOf(m)}</span><strong class="odds">${fmtOdds(m.odds)}</strong></button>`;
    };
    const g = RealBoard.find(id);
    const line = g ? `<div class="game-line">${g.away} ${g.current.spread > 0 ? '+' : ''}${g.current.spread} · O/U ${g.current.total}</div>` : '';
    return `<article class="game-card">
      <div class="game-when">${when}</div>
      <div class="game-sides">${pair.slice(0, 2).map(side).join('')}</div>
      ${line}
    </article>`;
  }).join('');

  box.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    const before = selected.length;
    toggleLeg(b.dataset.add);
    renderHomeGames();
    if (selected.length > before) {
      showToast(selected.length >= 2 ? 'Added — open the slip to place it.'
                                     : 'Added. Pick one more for a parlay.');
    }
  });
}

/* ---------- 12c. First-visit identity ---------- */
function renderIdentityGate() {
  const gate = document.getElementById('identityGate');
  if (!gate) return;
  /* Checking configured() rather than enabled() matters: boot calls this
     synchronously while Cloud.init() is still loading the SDK. Without it
     the local name prompt flashes up and then never closes once cloud
     mode takes over — which would make an optional signup feel forced. */
  if (Cloud.configured()) {
    renderAccountChip();
    if (needsProfile()) { openAuth('One more step.'); return; }
    renderAuthGate();
    if (!Cloud.signedIn()) gate.classList.remove('open');   // signup is optional
    else gate.classList.remove('open');
    return;
  }
  if (getIdentity()) { gate.classList.remove('open'); return; }
  gate.classList.add('open');
  renderAuthGate();
  return;
  const input = document.getElementById('identityName');
  const code = document.getElementById('identityCode');
  const save = document.getElementById('identitySave');
  const err = document.getElementById('identityError');
  const submit = () => {
    const id = saveIdentity(input.value, code.value);
    if (!id) { err.textContent = 'Please enter a display name.'; input.focus(); return; }
    gate.classList.remove('open');
    renderCompetition();
    showToast(`Welcome, ${id.name}.`);
  };
  save.onclick = submit;
  input.onkeydown = e => { if (e.key === 'Enter') submit(); };
  setTimeout(() => input && input.focus && input.focus(), 60);
}

/* ---------- 13. Feed status + boot ---------- */
function renderFeedStatus(state, detail) {
  const pill = document.getElementById('feedPill');
  if (!pill) return;
  pill.querySelector('.feed-label').textContent = {
    mock: 'Simulated feed', loading: 'Loading feed…',
    live: `Live feed${detail ? ` · ${detail}` : ''}`,
    error: 'Live feed unavailable · simulated'
  }[state] || state;
  pill.dataset.state = state;
}

async function loadBoard() {
  renderFeedStatus(DataSource.mode === 'live' ? 'loading' : 'mock');
  try {
    games = await DataSource.fetchGames();
    const books = games[0] ? games[0].home.prices.length : 0;
    renderFeedStatus(DataSource.mode === 'live' ? 'live' : 'mock', books ? `${books} books` : '');
  } catch (err) {
    console.warn('[VIG] live feed failed, using simulated:', err.message);
    games = fallbackGames();
    renderFeedStatus('error');
    showToast('Live odds unavailable. Showing the captured board.');
  }
  markets = marketsFromGames(games);
  recordSnapshot(games);
  selected = selected.map(s => markets.find(m => m.id === s.id)).filter(Boolean);
  renderMarkets(activeFilter());
  renderSlip();
  renderFeatured();
  renderTrending();
  renderTrendingPicks();
  initLineWinder();
}

function wireUp() {
  document.addEventListener('click', e => {
    const j = e.target.closest('[data-jump]');
    if (j) switchView(j.dataset.jump);
  });
  document.querySelectorAll('.filter').forEach(b => b.onclick = () => {
    document.querySelectorAll('.filter').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    renderMarkets(b.dataset.filter);
  });
  document.querySelectorAll('[data-board-scope]').forEach(b => b.onclick = () => {
    boardScope = b.dataset.boardScope;
    if (boardScope === 'alltime' && !allTimeRows) refreshAllTime();
    else renderCompetition();
  });
  document.querySelectorAll('.bet-filter').forEach(b => b.onclick = () => {
    document.querySelectorAll('.bet-filter').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    renderBets(b.dataset.status);
  });
  /* Must re-run the slip validation too, or typing a stake bigger than the
     bankroll updates the payout while leaving Place enabled. */
  document.getElementById('stakeInput').oninput = () => { updateReturn(); renderSlip(); };
  document.getElementById('clearSlip').onclick = () => {
    selected = []; renderMarkets(activeFilter()); renderSlip();
  };
  document.getElementById('placeMockBet').onclick = placeTicket;
  const settle = document.getElementById('settleBets');
  if (settle) settle.onclick = settleOpenTickets;
  const reset = document.getElementById('resetWeek');
  if (reset) reset.onclick = () => {
    week = blankWeek(weekKeyFor());
    selected = [];
    persist();
    updateDashboard(); renderBets(activeBetFilter()); renderSlip(); renderCompetition();
    showToast(`Week restarted at ${money(WEEKLY_BANKROLL)}.`);
  };
  document.getElementById('teamCount').onchange = populateDraftSlots;
  document.getElementById('startDraft').onclick = startDraft;
  document.getElementById('newDraftBtn').onclick = () => {
    switchView('fantasy'); document.getElementById('teamCount').focus();
  };
  document.getElementById('playerSearch').oninput = renderDraft;
  document.querySelectorAll('[data-rank-mode]').forEach(b => b.onclick = () => {
    poolRankMode = b.dataset.rankMode;
    Fantasy.invalidate();
    document.querySelectorAll('[data-rank-mode]').forEach(x =>
      x.classList.toggle('active', x.dataset.rankMode === poolRankMode));
    buildDraftPool((draftState && draftState.teams) || 12);
    renderDraft();
    showToast(poolRankMode === 'proj' ? 'Ranked by ESPN 2026 outlook.' : 'Ranked by 2025 production.');
  });
  document.querySelectorAll('.pool-filter').forEach(b => b.onclick = () => {
    document.querySelectorAll('.pool-filter').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    renderDraft();
  });
  safely('line winder wiring', wireLineWinder);
  safely('compare wiring', wireCompare);

  const pill = document.getElementById('feedPill');
  if (pill) pill.onclick = async () => {
    DataSource.setMode(DataSource.mode === 'live' ? 'mock' : 'live');
    await loadBoard();
    showToast(`Switched to ${DataSource.mode === 'live' ? 'live' : 'simulated'} odds.`);
  };

  const profileToggle = document.getElementById('profileToggle'), profileMenu = document.getElementById('profileMenu');
  profileToggle.addEventListener('click', e => {
    e.stopPropagation();
    /* rebuild on open so bankroll, ROI and avatar are current */
    safely('profile card', renderProfileCard);
    profileToggle.setAttribute('aria-expanded', String(profileMenu.classList.toggle('open')));
  });
  document.addEventListener('click', e => {
    if (!profileMenu.contains(e.target) && e.target !== profileToggle) {
      profileMenu.classList.remove('open');
      profileToggle.setAttribute('aria-expanded', 'false');
    }
  });
  document.querySelectorAll('[data-profile-action]').forEach(btn => btn.addEventListener('click', () => {
    const a = btn.dataset.profileAction;
    profileMenu.classList.remove('open');
    if (a === 'friends') switchView('friends');
    else if (a === 'profile') showToast('Profile page is queued for the next account build.');
    else if (a === 'settings') showToast('Settings panel is ready to connect to real accounts.');
    else if (a === 'help') showToast('Feedback tools will be added before public beta.');
    else showToast('Sign-out becomes active when login is connected.');
  }));

  const copyInvite = document.getElementById('copyInvite');
  if (copyInvite) copyInvite.addEventListener('click', () => {
    const link = document.getElementById('inviteLink');
    link.select();
    if (navigator.clipboard) navigator.clipboard.writeText(link.value).catch(() => {});
    showToast('Invite link copied for sharing.');
  });
  const groupSize = document.getElementById('groupSize');
  if (groupSize) groupSize.addEventListener('change', () => {
    document.getElementById('inviteLink').value =
      groupSize.value.startsWith('10') ? 'vig.app/invite/VIG-AP10' : 'vig.app/invite/VIG-AP20';
    showToast(`Group capacity changed to ${groupSize.value}.`);
  });
  const createInvite = document.getElementById('createInvite');
  if (createInvite) createInvite.addEventListener('click', () => showToast('Private invite link created.'));
  const manageMembers = document.getElementById('manageMembers');
  if (manageMembers) manageMembers.addEventListener('click', () => showToast('Member management is planned for account-enabled beta.'));

  /* v1.5.7: the v0.5 prototype modal is gone. It sat alongside the real
     Supabase gate, so there were two ways to sign in and one of them was
     theatre — it validated nothing, stored nothing, and reported success
     regardless. The header buttons now open the live gate. */
  const headerIn = document.getElementById('headerSignIn');
  if (headerIn) headerIn.addEventListener('click', () => {
    authMode2 = 'signin';
    openAuth('Sign in to save your bets.');
  });
  const headerUp = document.getElementById('headerSignUp');
  if (headerUp) headerUp.addEventListener('click', () => {
    authMode2 = 'signup';
    openAuth('Create an account to place mock bets.');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !needsProfile()) closeAuth2();
  });

  const ad = document.getElementById('openReplayAd');
  if (ad) ad.addEventListener('click', () => {
    const slider = document.getElementById('replaySlider');
    slider.value = 0; renderLineChart(0);
    const chart = document.getElementById('lineWinderChart');
    if (chart && chart.scrollIntoView) chart.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => document.getElementById('replayBtn').click(), 350);
  });
}

/* v1.1 — every boot step is isolated. Previously one thrown error part-way
   through wireUp() left the rest of the page with no event handlers at all,
   which presents as "nothing is clickable and tabs don't switch" — with no
   visible clue why. Now a failure is contained, reported on screen, and
   navigation is wired first so tabs work even if everything else dies. */
const bootErrors = [];
function safely(label, fn) {
  try { fn(); }
  catch (e) {
    console.error(`[VIG] ${label} failed:`, e);
    bootErrors.push(`${label}: ${e && e.message ? e.message : e}`);
  }
}

function wireNav() {
  document.querySelectorAll('.nav-btn').forEach(b =>
    b.addEventListener('click', () => switchView(b.dataset.view)));
  const slipOpen = document.getElementById('slipBarOpen');
  if (slipOpen) slipOpen.onclick = () => {
    switchView('parlay');
    const card = document.querySelector('.ticket-card');
    if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const slipPlace = document.getElementById('slipBarPlace');
  if (slipPlace) slipPlace.onclick = placeTicket;

  /* bottom bar. switchView already handles the highlight and the scroll. */
  document.querySelectorAll('.mobile-nav-btn').forEach(b =>
    b.addEventListener('click', () => switchView(b.dataset.view)));
  /* with Home off the bar, the logo carries it — the pattern people expect */
  const brand = document.getElementById('brandHome');
  if (brand) {
    brand.addEventListener('click', () => switchView('home'));
    brand.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchView('home'); }
    });
  }
}

function showBootErrors() {
  if (!bootErrors.length) return;
  const bar = document.getElementById('bootError');
  if (!bar) return;
  bar.hidden = false;
  bar.innerHTML = `<strong>Something failed to load.</strong>
    <span>${bootErrors.length} issue${bootErrors.length > 1 ? 's' : ''}. Tap to copy the details.</span>
    <code>${bootErrors.map(e => e.replace(/[<>&]/g, '')).join(' | ')}</code>`;
  bar.onclick = () => {
    const text = `VIG boot errors\n${navigator.userAgent}\n\n${bootErrors.join('\n')}`;
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    showToast('Error details copied.');
  };
}

function boot() {
  const params = new URLSearchParams(window.location.search);
  safely('url params', () => {
    if (params.get('data') === 'live') DataSource.setMode('live');
    if (params.get('data') === 'mock') DataSource.setMode('mock');
  });

  /* navigation first, unconditionally */
  safely('nav', wireNav);

  let isNewWeek = false;
  safely('week', () => { isNewWeek = ensureWeek(); });
  safely('wireUp', wireUp);
  safely('draft slots', populateDraftSlots);
  safely('bets', () => renderBets());
  safely('draft', renderDraft);
  safely('saved drafts', renderSavedDrafts);
  safely('competition', renderCompetition);
  safely('dashboard', updateDashboard);
  safely('board', loadBoard);
  safely('compare', initCompare);
  safely('nav badges', updateNavBadges);
  safely('cloud', () => {
    Cloud.init().then(ok => {
      renderAccountChip();
      renderHeaderAvatar();
      /* Cloud.init() is async, so the first render happened while
         Cloud.enabled() was still false and took the local branch. Rebuild
         once we actually know whether there is an account system. */
      renderProfileCard();
      renderIdentityGate();
      renderAdmin();
      if (ok && Cloud.signedIn()) { syncFromCloud(); refreshLeaderboard(); refreshAllTime(); }
    });
  });
  safely('identity', renderIdentityGate);
  safely('outbox', () => { renderSyncChip(); startOutboxRetry(); });
  safely('header avatar', renderHeaderAvatar);
  /* build the menu up front — it used to be filled only on first tap, which
     left a hardcoded v0.5 profile placeholder sitting
     in the markup until then. */
  safely('profile card', renderProfileCard);
  safely('real board', () => {
    RealBoard.load().then(() => {
      const real = RealBoard.toMarkets();
      if (real.length) {
        /* keep non-NFL demo markets, replace the NFL board with real numbers */
        markets = real.concat(markets.filter(m => m.category !== 'nfl'));
        renderMarkets(activeFilter());
        renderHomeGames();
        renderTrending();
        renderTrendingPicks();
        renderFeatured();     // cards are composed from the board, so rebuild them
        renderSlip();
        renderTicker();       // the strip reads the same slate — keep it in step
      }
    }).catch(e => console.warn('[VIG] real board unavailable:', e && e.message));
  });
  safely('home games', renderHomeGames);
  safely('bet tracking', startBetTracking);
  safely('golf outrights', async () => {
    await GolfOutrights.load();
    GolfOutrights.install();
    renderMarkets(activeFilter());
    renderTrending();
    renderTrendingPicks();
    renderOtherSports();
    renderTicker();
    /* Ask the feed whether this event has a live market. Never blocks the
       board — captured prices show immediately, labelled as captured. */
    GolfOutrights.checkLive();
  });
  safely('golf event', async () => {
    await GolfEvent.load();
    autoSettleFromEventData();
    renderGolfEvent();
    renderAdmin();
  });
  showBootErrors();

  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
   try {
    if (ensureWeek()) {
      updateDashboard(); renderBets(activeBetFilter()); renderCompetition(); renderSlip();
      showToast(`New week. Bankroll reset to ${money(WEEKLY_BANKROLL)}.`);
    } else {
      renderCountdown();
    }
   } catch (e) { console.error('[VIG] tick failed:', e); }
  }, 60000);

  if (isNewWeek && weekResults.length) {
    setTimeout(() => showToast(`New week started. Last week: ${weekResults[0].profit >= 0 ? '+' : ''}${money(weekResults[0].profit)}.`), 800);
  }
}



/* ============================================================
   14. Player comparison — nflverse (v1.0)
   Real weekly results. No projections, no composite grade.
   v1.0: ranks instead of percentiles, D/ST and K support,
   position-aware metric sets, and a search box instead of
   a 500-option <select>.
   ============================================================ */
const SCORING = {
  ppr:  { label: 'Full PPR',  mult: 1.0 },
  half: { label: 'Half PPR',  mult: 0.5 },
  std:  { label: 'Standard',  mult: 0.0 }
};

const METRIC_DEFS = {
  ppg:         { label: 'Points / game',  fmt: v => v.toFixed(1),      higher: true },
  floor:       { label: 'Floor (25th)',   fmt: v => v.toFixed(1),      higher: true },
  ceiling:     { label: 'Ceiling (90th)', fmt: v => v.toFixed(1),      higher: true },
  consistency: { label: 'Consistency',    fmt: v => v.toFixed(0),      higher: true },
  boom:        { label: 'Boom rate',      fmt: v => `${v.toFixed(0)}%`, higher: true },
  bust:        { label: 'Bust rate',      fmt: v => `${v.toFixed(0)}%`, higher: false },
  tshare:      { label: 'Target share',   fmt: v => `${v.toFixed(1)}%`, higher: true }
};

const BASE_METRICS = ['ppg', 'floor', 'ceiling', 'consistency', 'boom', 'bust'];
/* Target share is meaningless for a QB, a kicker or a defence, so the
   metric list is derived from the position rather than fixed at seven. */
const metricsFor = pos =>
  (['RB', 'WR', 'TE'].includes(pos) ? [...BASE_METRICS, 'tshare'] : BASE_METRICS);

const POSITIONS = [
  { key: 'QB', label: 'QB' }, { key: 'RB', label: 'RB' },
  { key: 'WR', label: 'WR' }, { key: 'TE', label: 'TE' },
  { key: 'DST', label: 'D/ST' }, { key: 'K', label: 'K' }
];

/* 1st, 2nd, 3rd, 4th … 11th, 21st, 101st */
function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
}

const Fantasy = {
  data: null,
  scoring: 'ppr',
  position: 'RB',
  picks: [null, null],
  _cache: {},

  async load() {
    if (this.data) return this.data;
    if (window.VIG_FANTASY) this.data = window.VIG_FANTASY;
    else {
      const res = await fetch('data/fantasy-2025.json');
      if (!res.ok) throw new Error(`fantasy data ${res.status}`);
      this.data = await res.json();
    }
    /* one flat pool so search and lookup don't care which file a
       player came from */
    this.data.all = [
      ...(this.data.players || []),
      ...(this.data.kickers || []),
      ...(this.data.defenses || [])
    ];
    return this.data;
  },

  weekly(p) {
    /* kickers and defences have no receptions, so the scoring
       multiplier is a no-op for them by construction */
    const m = SCORING[this.scoring].mult;
    return p.s.map((std, i) => round2(std + m * (p.r[i] || 0)));
  },

  profile(p) {
    const key = `${p.id}:${this.scoring}`;
    if (this._cache[key]) return this._cache[key];
    /* A projection-only player (2026 rookie or new arrival) has no 2025
       weekly series. Fall back to their projected per-game figure so the
       grade stays finite, and flag it so the UI can say which it used. */
    if (!p.s || !p.s.length) {
      const perGame = p.proj && p.proj.gp ? p.proj.fpts / p.proj.gp : 0;
      const blank = {
        games: 0, ppg: round2(perGame), floor: 0, ceiling: 0, consistency: 0,
        boom: 0, bust: 0, tshare: 0, weekly: [], weeks: [],
        noHistory: true, projected: !!p.proj
      };
      this._cache[key] = blank;
      return blank;
    }
    const pts = this.weekly(p);
    const sorted = pts.slice().sort((a, b) => a - b);
    const q = f => sorted[Math.min(sorted.length - 1, Math.round(f * (sorted.length - 1)))];
    const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
    const sd = Math.sqrt(pts.reduce((a, b) => a + (b - mean) ** 2, 0) / pts.length);
    const lines = this.thresholds(p.p);
    const prof = {
      games: pts.length,
      ppg: mean,
      floor: q(0.25),
      ceiling: q(0.90),
      consistency: mean > 0 ? Math.max(0, 100 * (1 - sd / mean)) : 0,
      boom: 100 * pts.filter(v => v >= lines.boom).length / pts.length,
      bust: 100 * pts.filter(v => v <= lines.bust).length / pts.length,
      tshare: 100 * (p.ts.reduce((a, b) => a + b, 0) / p.ts.length),
      weekly: pts, weeks: p.wk
    };
    this._cache[key] = prof;
    return prof;
  },

  /* Boom and bust lines come from each position's own weekly
     distribution. A QB's 80th-percentile week is over 22 points and a
     TE's is about 10 — one fixed line would be a fiction. */
  thresholds(position) {
    const key = `t:${position}:${this.scoring}`;
    if (this._cache[key]) return this._cache[key];
    const all = [];
    this.peers(position).forEach(p => all.push(...this.weekly(p)));
    all.sort((a, b) => a - b);
    const q = f => all.length ? all[Math.min(all.length - 1, Math.round(f * (all.length - 1)))] : 0;
    const t = { boom: q(0.80), bust: q(0.25) };
    this._cache[key] = t;
    return t;
  },

  peers(position) {
    const key = `peers:${position}`;
    if (!this._cache[key]) this._cache[key] = this.data.all.filter(p => p.p === position);
    return this._cache[key];
  },

  /* v1.0: rank, not percentile. "2nd of 127" beats "99th percentile" —
     it is a fact rather than a statistic about a statistic. */
  rankOf(player, metricKey) {
    const key = `r:${player.p}:${metricKey}:${this.scoring}`;
    let order = this._cache[key];
    if (!order) {
      const higher = METRIC_DEFS[metricKey].higher;
      order = this.peers(player.p)
        .map(p => ({ id: p.id, v: this.profile(p)[metricKey] }))
        .sort((a, b) => {
          const x = a.v, y = b.v;
          const fx = isFinite(x), fy = isFinite(y);
          if (!fx && !fy) return 0;
          if (!fx) return 1;
          if (!fy) return -1;
          return higher ? y - x : x - y;
        })
        .map(x => x.id);
      this._cache[key] = order;
    }
    const idx = order.indexOf(player.id);
    return { rank: idx < 0 ? order.length : idx + 1, total: order.length };
  },

  /* bar length still needs a 0–100 scale, so percentile drives width
     while the label shows the rank */
  share(player, metricKey) {
    const { rank, total } = this.rankOf(player, metricKey);
    return total > 1 ? 100 * (total - rank) / (total - 1) : 100;
  },

  search(query, position) {
    const q = (query || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    let pool = position ? this.peers(position) : this.data.all;
    if (q) pool = pool.filter(p => (p.sn || '').includes(q));
    return pool.slice(0, 40);
  },

  /* The grade must be measured with the same yardstick the board is sorted
     by. Ranking picks on 2025 production while the pool is ordered by 2026
     projections meant drafting the board optimally earned an F. */
  draftMetric(p) {
    if (poolRankMode === 'proj') {
      /* strict: no 2026 projection means unrated in this mode, not zero */
      return (p.proj && p.proj.gp) ? p.proj.fpts / p.proj.gp : NaN;
    }
    if (!p.s || !p.s.length) return NaN;
    const prof = this.profile(p);
    return isFinite(prof.ppg) ? prof.ppg : NaN;
  },

  draftRank(player) {
    const key = `dr:${player.p}:${poolRankMode}:${this.scoring}`;
    let order = this._cache[key];
    if (!order) {
      order = this.peers(player.p)
        .map(p => ({ id: p.id, v: this.draftMetric(p) }))
        .sort((a, b) => {
          const fx = isFinite(a.v), fy = isFinite(b.v);
          if (!fx && !fy) return 0;
          if (!fx) return 1;
          if (!fy) return -1;
          return b.v - a.v;
        })
        .map(x => x.id);
      this._cache[key] = order;
    }
    const idx = order.indexOf(player.id);
    return { rank: idx < 0 ? order.length : idx + 1, total: order.length };
  },

  find(id) { return this.data.all.find(p => p.id === id) || null; },
  invalidate() {
    Object.keys(this._cache).forEach(k => { if (!k.startsWith('peers:')) delete this._cache[k]; });
  }
};

function sparkline(pts, colour) {
  if (!pts.length) return '';
  const W = 150, H = 34, max = Math.max(...pts, 1), min = Math.min(...pts, 0);
  const x = i => pts.length > 1 ? i * W / (pts.length - 1) : W / 2;
  const y = v => H - 3 - (v - min) / (max - min || 1) * (H - 8);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="weekly scoring">
    <polyline points="${pts.map((v, i) => `${x(i)},${y(v)}`).join(' ')}"
      fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round"/>
    ${pts.map((v, i) => `<circle cx="${x(i)}" cy="${y(v)}" r="1.8" fill="${colour}"/>`).join('')}
  </svg>`;
}

function renderComparePickers() {
  if (!Fantasy.data) return;
  const list = Fantasy.peers(Fantasy.position);
  [0, 1].forEach(slot => {
    if (!Fantasy.picks[slot] || !list.some(p => p.id === Fantasy.picks[slot])) {
      Fantasy.picks[slot] = (list[slot] || list[0] || {}).id || null;
    }
    const p = Fantasy.find(Fantasy.picks[slot]);
    const input = document.getElementById(`searchSlot${slot}`);
    if (input && p) input.value = p.n;
  });
  document.querySelectorAll('[data-compare-pos]').forEach(b =>
    b.classList.toggle('active', b.dataset.comparePos === Fantasy.position));
  document.querySelectorAll('[data-scoring]').forEach(b =>
    b.classList.toggle('active', b.dataset.scoring === Fantasy.scoring));
  const toggle = document.getElementById('scoringToggle');
  if (toggle) toggle.style.display = ['DST', 'K'].includes(Fantasy.position) ? 'none' : '';
}

function renderSearchResults(slot, query) {
  const box = document.getElementById(`searchList${slot}`);
  if (!box) return;
  const hits = Fantasy.search(query, Fantasy.position);
  if (!query || !hits.length) { box.innerHTML = ''; box.classList.remove('open'); return; }
  box.innerHTML = hits.map(p => {
    const prof = Fantasy.profile(p);
    const { rank, total } = Fantasy.rankOf(p, 'ppg');
    return `<button class="search-hit" data-pick="${slot}" data-id="${p.id}">
      <span>${p.n}</span>
      <small>${p.p}${p.t ? ` · ${p.t}` : ''} · ${prof.ppg.toFixed(1)} ppg · ${ordinal(rank)} of ${total}</small>
    </button>`;
  }).join('');
  box.classList.add('open');
  box.querySelectorAll('[data-pick]').forEach(b => b.onclick = () => {
    Fantasy.picks[Number(b.dataset.pick)] = b.dataset.id;
    box.innerHTML = ''; box.classList.remove('open');
    renderComparePickers();
    renderCompare();
  });
}

function renderCompare() {
  const box = document.getElementById('compareCard');
  if (!box || !Fantasy.data) return;
  const a = Fantasy.find(Fantasy.picks[0]), b = Fantasy.find(Fantasy.picks[1]);
  if (!a || !b) { box.innerHTML = '<div class="empty-state">Pick two players to compare.</div>'; return; }
  const pa = Fantasy.profile(a), pb = Fantasy.profile(b);
  const lines = Fantasy.thresholds(a.p);
  const colours = ['#2875CB', '#e2a84a'];
  const metrics = metricsFor(a.p);

  let leadA = 0;
  const rows = metrics.map(key => {
    const m = METRIC_DEFS[key];
    const va = pa[key], vb = pb[key];
    const ra = Fantasy.rankOf(a, key), rb = Fantasy.rankOf(b, key);
    const aWins = m.higher ? va > vb : va < vb;
    if (aWins) leadA++;
    const side = (val, rank, share, colour, wins) => `
      <div class="cmp-side ${wins ? 'leads' : ''}">
        <div class="cmp-bar"><span style="width:${share.toFixed(0)}%;background:${colour}"></span></div>
        <div class="cmp-val"><strong>${m.fmt(val)}</strong><small>${ordinal(rank.rank)}</small></div>
      </div>`;
    return `<div class="cmp-row"><div class="cmp-label">${m.label}</div>
      ${side(va, ra, Fantasy.share(a, key), colours[0], aWins)}
      ${side(vb, rb, Fantasy.share(b, key), colours[1], !aWins)}</div>`;
  }).join('');

  const overallA = Fantasy.rankOf(a, 'ppg'), overallB = Fantasy.rankOf(b, 'ppg');
  const posLabel = (POSITIONS.find(p => p.key === a.p) || {}).label || a.p;
  const lowSample = Math.min(pa.games, pb.games) < 6;
  const scoringNote = ['DST', 'K'].includes(a.p)
    ? 'league scoring' : SCORING[Fantasy.scoring].label;

  box.innerHTML = `
    <div class="cmp-head">
      <div class="cmp-player" style="--c:${colours[0]}">
        ${playerFace(a.n, a.p, a.t, a.img, 'lg')}
        <strong>${a.n}</strong>
        <small>${posLabel}${a.t ? ` · ${a.t}` : ''} · ${pa.games} games · <b>${ordinal(overallA.rank)} of ${overallA.total}</b>${a.pr ? ` · finished ${posLabel}${a.pr}` : ''}</small>
        ${sparkline(pa.weekly, colours[0])}
      </div>
      <div class="cmp-vs">vs</div>
      <div class="cmp-player align-right" style="--c:${colours[1]}">
        ${playerFace(b.n, b.p, b.t, b.img, 'lg')}
        <strong>${b.n}</strong>
        <small>${posLabel}${b.t ? ` · ${b.t}` : ''} · ${pb.games} games · <b>${ordinal(overallB.rank)} of ${overallB.total}</b>${b.pr ? ` · finished ${posLabel}${b.pr}` : ''}</small>
        ${sparkline(pb.weekly, colours[1])}
      </div>
    </div>
    <div class="cmp-grid">
      <div class="cmp-row cmp-header"><div class="cmp-label">Metric</div>
        <div class="cmp-side">${a.n.split(' ').slice(-1)[0]}</div>
        <div class="cmp-side">${b.n.split(' ').slice(-1)[0]}</div></div>
      ${rows}
    </div>
    <div class="cmp-foot">
      <p><strong>${leadA > metrics.length / 2 ? a.n : leadA === metrics.length / 2 ? 'Even split' : b.n}</strong>
      leads ${Math.max(leadA, metrics.length - leadA)} of ${metrics.length} metrics.
      Ranks are within ${overallA.total} qualifying ${posLabel}s at ${Fantasy.data.minGames}+ games, in ${scoringNote}.</p>
      <p class="cmp-note">Boom = a week at or above ${lines.boom.toFixed(1)} pts (80th percentile for ${posLabel}s).
      Bust = at or below ${lines.bust.toFixed(1)} pts. Consistency = 100 − (σ ÷ mean). Bar length is relative standing; the number beside it is the exact rank.
      ${lowSample ? '<em>Small sample — one of these has under 6 games. Treat ranks loosely.</em>' : ''}</p>
      <p class="cmp-source">${Fantasy.data.season} regular season · nflverse (${Fantasy.data.license}) · built ${Fantasy.data.built}</p>
    </div>`;
}

function wireCompare() {
  document.querySelectorAll('[data-compare-pos]').forEach(b => b.onclick = () => {
    Fantasy.position = b.dataset.comparePos;
    Fantasy.picks = [null, null];
    [0, 1].forEach(s => { const l = document.getElementById(`searchList${s}`); if (l) { l.innerHTML = ''; l.classList.remove('open'); } });
    renderComparePickers();
    renderCompare();
  });
  document.querySelectorAll('[data-scoring]').forEach(b => b.onclick = () => {
    Fantasy.scoring = b.dataset.scoring;
    Fantasy.invalidate();
    renderComparePickers();
    renderCompare();
    showToast(`Comparing in ${SCORING[Fantasy.scoring].label}.`);
  });
  [0, 1].forEach(slot => {
    const input = document.getElementById(`searchSlot${slot}`);
    if (!input) return;
    input.oninput = () => renderSearchResults(slot, input.value);
    input.onfocus = () => renderSearchResults(slot, input.value);
    input.onblur = () => setTimeout(() => {
      const l = document.getElementById(`searchList${slot}`);
      if (l) { l.innerHTML = ''; l.classList.remove('open'); }
    }, 180);
  });
  const swap = document.getElementById('compareSwap');
  if (swap) swap.onclick = () => { Fantasy.picks.reverse(); renderComparePickers(); renderCompare(); };
}

async function initCompare() {
  const box = document.getElementById('compareCard');
  try {
    await Fantasy.load();
    renderComparePickers();
    renderCompare();
    safely('ticker', renderTicker);
    safely('auto-settle', () => autoSettleFromScores({ quiet: true }));
    safely('projections', () => { Fantasy.projCoverage = mergeProjections(); });
    if (buildDraftPool() && !draftState) renderDraft();
  } catch (err) {
    console.warn('[VIG] fantasy data unavailable:', err.message);
    if (box) box.innerHTML = '<div class="empty-state">Player data unavailable. Run <code>node scripts/build-fantasy-data.mjs</code>.</div>';
  }
}



/* ============================================================
   15. Golf event — private bankroll test (v1.4.4)
   Self-contained straight-bet flow inside the Trending tab. Uses the
   same week.tickets store as the NFL slip so My Bets, the leaderboard
   and the weekly archive all pick these up for free, but keeps its own
   single-selection slip rather than overloading the parlay builder.

   Everything about the event is editable in data/golf-event.json —
   name, lock time, golfers, odds — with no code change.
   ============================================================ */
const GolfEvent = {
  data: null,
  selection: null,          // pending pick, pre-confirmation
  async load() {
    if (this.data) return this.data;
    if (window.VIG_GOLF_EVENT) { this.data = window.VIG_GOLF_EVENT; return this.data; }
    const res = await fetch('data/golf-event.json');
    if (!res.ok) throw new Error(`golf event ${res.status}`);
    this.data = await res.json();
    return this.data;
  },
  market() { return this.data && this.data.markets && this.data.markets[0]; },
  selections() { const m = this.market(); return (m && m.selections) || []; },
  find(id) { return this.selections().find(s => s.selectionId === id) || null; },
  /* admin overrides persist; the file stays the source of truth for odds */
  state() {
    const saved = Store.get(KEYS.golf, null);
    const base = {
      status: (this.data && this.data.status) || 'open',
      /* the event file can ship an already-settled result */
      winner: (this.data && this.data.winnerSelectionId) || null,
      settledAt: null
    };
    return Object.assign(base, saved || {});
  },
  setState(patch) {
    const next = Object.assign(this.state(), patch);
    Store.set(KEYS.golf, next);
    return next;
  },
  /* locked by the clock OR by an admin flip, whichever comes first */
  isLocked() {
    const st = this.state();
    if (st.status === 'locked' || st.status === 'final') return true;
    const lock = this.data && this.data.lockTime ? new Date(this.data.lockTime).getTime() : 0;
    return lock ? Date.now() >= lock : false;
  },
  isFinal() { return this.state().status === 'final'; }
};

function golfTickets(all) {
  return (all || week.tickets).filter(t => t.kind === 'golf');
}

function fmtEventDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined,
      { weekday: 'short', month: 'short', day: 'numeric' });
  } catch (e) { return iso; }
}

/* Final leaderboard. Shown once the event settles, with our own selections
   marked so a bettor can see exactly where their pick landed. */
function golfLeaderboardHtml() {
  const res = GolfEvent.data && GolfEvent.data.results;
  if (!res || !res.leaderboard) return '';
  const st = GolfEvent.state();
  const winner = st.winner || GolfEvent.data.winnerSelectionId;
  const mine = new Set(golfTickets().map(t => t.selectionId));
  return `<section class="panel golf-final">
    <div class="panel-head"><div><span class="eyebrow">FINAL LEADERBOARD</span>
      <h2>${res.winner} wins at ${res.toPar}</h2>
      <p class="muted-copy">${res.note || ''}</p></div>
      <span class="status-pill final">Final</span></div>
    ${winner === 'g-field' ? `<p class="golf-field-note">
      No listed golfer won, so <b>The Field</b> settles as the winner at
      ${fmtOdds((GolfEvent.find('g-field') || {}).americanOdds || 250)}.
      Every named selection loses.</p>` : ''}
    <div class="lb-head"><span>Pos</span><span>Player</span><span>To par</span><span>R1</span><span>R2</span></div>
    <div class="lb-rows">${res.leaderboard.map(r => {
      const onBoard = !!r.sel;
      const backed = r.sel && mine.has(r.sel);
      return `<div class="lb-row${onBoard ? ' on-board' : ''}${backed ? ' backed' : ''}">
        <span class="lb-pos">${r.pos}</span>
        <span class="lb-name">${r.name}${backed ? '<i class="lb-tag">your pick</i>'
          : onBoard ? '<i class="lb-tag dim">on the board</i>' : ''}</span>
        <span class="lb-par">${r.toPar}</span>
        <span class="lb-r">${r.r1}</span>
        <span class="lb-r">${r.r2}</span>
      </div>`;
    }).join('')}</div>
    <p class="disclaimer">Result data shown for a settled mock event. Virtual funds only.</p>
  </section>`;
}

/* BUG (v1.5.9): shipping the event with a winner made it *display* as settled
   without settling anyone's tickets. The board read "WON" next to The Field
   while the ticket stayed open and the bankroll never moved.

   Local mode: the event file is the only source of truth, so honour it and
   settle. Cloud mode: the database is the truth and RLS gives users no update
   on their own bets — by design, or anyone could pay themselves — so an admin
   must settle, and everyone else sees "awaiting settlement" until they do. */
function autoSettleFromEventData() {
  if (!GolfEvent.data) return 0;
  const declared = GolfEvent.data.winnerSelectionId;
  if (!declared || !GolfEvent.isFinal()) return 0;
  const open = golfTickets().filter(t => t.status === 'open'
    && t.eventId === GolfEvent.data.eventId);
  if (!open.length) return 0;

  if (Cloud.enabled() && Cloud.signedIn()) return 0;   // the server decides

  const r = settleGolfEvent(declared);
  if (r.settled) {
    updateDashboard();
    renderBets(activeBetFilter());
    renderCompetition();
    showToast(`Event settled — ${r.settled} ticket${r.settled === 1 ? '' : 's'}, ${money(r.paid)} returned.`);
  }
  return r.settled;
}

/* Tickets on a finished event that the server has not graded yet. */
function pendingSettlement() {
  if (!(Cloud.enabled() && Cloud.signedIn()) || !GolfEvent.data) return [];
  if (!GolfEvent.isFinal()) return [];
  return golfTickets().filter(t => t.status === 'open'
    && t.eventId === GolfEvent.data.eventId);
}

/* v1.7.4: the VIG Founders Invitational is over, and a finished private test
   event has no business on a public tab. It stays reachable under ?admin=1 so
   any ungraded tickets can still be settled — removing the card must not strand
   somebody's stake. Live events show for everyone as before. */
function golfEventVisible() {
  if (!GolfEvent.data) return false;
  const st = GolfEvent.state();
  const finished = st && (st.status === 'final' || st.status === 'settled');
  return finished ? Admin.enabled() : true;
}

function renderGolfEvent() {
  const box = document.getElementById('golfEvent');
  if (!box) return;
  if (!golfEventVisible()) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;
  if (!GolfEvent.data) {
    box.innerHTML = '<div class="empty-state">Golf event unavailable. Check data/golf-event.json.</div>';
    return;
  }
  const ev = GolfEvent.data;
  const st = GolfEvent.state();
  const locked = GolfEvent.isLocked();
  const final = GolfEvent.isFinal();
  const s = weekStats(week);
  const statusLabel = final ? 'Final' : locked ? 'Locked' : 'Open';
  const lockMs = ev.lockTime ? new Date(ev.lockTime).getTime() - Date.now() : 0;

  const rows = GolfEvent.selections().map(sel => {
    const mine = golfTickets().filter(t => t.selectionId === sel.selectionId)
                              .reduce((a, t) => a + t.stake, 0);
    const won = final && st.winner === sel.selectionId;
    return `<div class="golf-row ${won ? 'winner' : ''}">
      <div class="golf-name"><strong>${sel.name}</strong>
        ${sel.note ? `<small>${sel.note}</small>` : ''}
        ${mine ? `<small class="golf-mine">${money(mine)} on this</small>` : ''}</div>
      <span class="odds">${fmtOdds(sel.americanOdds)}</span>
      ${locked
        ? `<span class="golf-locked${won ? ' win' : ''}">${won ? 'WINNER' : '—'}</span>`
        : `<button class="add-btn" data-golf-pick="${sel.selectionId}">Add</button>`}
    </div>`;
  }).join('');

  box.innerHTML = `
    <section class="panel golf-panel">
      <div class="golf-head">
        <div>
          <span class="eyebrow">${GolfEvent.market() ? GolfEvent.market().name.toUpperCase() : 'TOURNAMENT WINNER'}</span>
          <h2>${ev.name}</h2>
          <p class="muted-copy">${fmtEventDate(ev.startTime)} – ${fmtEventDate(ev.endTime)}${ev.venue ? ` · ${ev.venue}` : ''}</p>
        </div>
        <div class="golf-status">
          <span class="status-pill ${statusLabel.toLowerCase()}">${statusLabel}</span>
          <small>${final ? 'Settled' : locked ? 'Betting closed' : (lockMs > 0 ? `Locks in ${fmtCountdown(lockMs)}` : 'Locks at start')}</small>
        </div>
      </div>
      <div class="golf-bankroll">
        <div><span>Virtual bankroll</span><strong>${money(s.bankroll)}</strong></div>
        <div><span>At risk</span><strong>${money(s.atRisk)}</strong></div>
        <div><span>Bets left</span><strong>${s.betsLeft} of ${WEEKLY_BET_LIMIT}</strong></div>
      </div>
      <p class="golf-notice">VIG is a free sports prediction game using virtual funds.
        No real-money wagering, deposits, withdrawals, or cash prizes are offered.</p>
      <div class="golf-list">${rows}</div>
    </section>
    ${(() => {
      const pend = pendingSettlement();
      if (!pend.length) return '';
      const owed = pend.reduce((a, t) => a + (t.selectionId === (GolfEvent.state().winner) ? potentialReturn(t) : 0), 0);
      return `<div class="settle-pending">
        <strong>${pend.length} ticket${pend.length === 1 ? '' : 's'} awaiting settlement.</strong>
        The tournament is final${owed ? `, and ${money(owed)} is owed to you` : ''}, but bets are graded
        centrally so every player settles at the same time.${Cloud.admin
          ? ' You are an admin — open <code>?admin=1</code> to settle for everyone.'
          : ' Your bankroll updates as soon as that happens.'}</div>`;
    })()}
    ${final ? golfLeaderboardHtml() : ''}
    <div id="golfSlip"></div>`;

  box.querySelectorAll('[data-golf-pick]').forEach(b => b.onclick = () => {
    GolfEvent.selection = b.dataset.golfPick;
    renderGolfSlip();
    const slip = document.getElementById('golfSlip');
    if (slip && slip.scrollIntoView) slip.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  renderGolfSlip();
}

const GOLF_STAKES = [10, 25, 50, 100];

function renderGolfSlip() {
  const box = document.getElementById('golfSlip');
  if (!box) return;
  const sel = GolfEvent.selection && GolfEvent.find(GolfEvent.selection);
  if (!sel) { box.innerHTML = ''; return; }
  const s = weekStats(week);
  /* `|| 25` would swallow a deliberate 0 and silently substitute the default,
     so the minimum-stake validation could never fire. */
  const rawStake = Store.get(KEYS.golfStake, 25);
  const stake = (typeof rawStake === 'number' && isFinite(rawStake) && rawStake >= 0)
    ? rawStake : 25;
  const dec = decimalOdds(sel.americanOdds);
  const profit = stake * (dec - 1);
  const total = stake + profit;
  const after = round2(week.bankroll - stake);

  let error = '';
  if (!(stake >= 1)) error = 'Minimum virtual stake is $1.';
  else if (stake > week.bankroll) error = `Stake exceeds your virtual bankroll of ${money(week.bankroll)}.`;
  else if (s.betsLeft <= 0) error = `You have used all ${WEEKLY_BET_LIMIT} bets this week.`;
  else if (GolfEvent.isLocked()) error = 'Betting is closed for this event.';

  box.innerHTML = `<section class="panel golf-slip">
    <div class="panel-head"><div><span class="eyebrow">BET SLIP</span><h2>${sel.name}</h2>
      <p class="muted-copy">${GolfEvent.data.name} · ${GolfEvent.market().name}</p></div>
      <button class="text-btn" id="golfClear">Clear</button></div>
    <div class="golf-slip-grid">
      <div><span>Odds</span><strong class="odds">${fmtOdds(sel.americanOdds)}</strong></div>
      <div><span>Potential profit</span><strong>${money(profit)}</strong></div>
      <div><span>Total return</span><strong>${money(total)}</strong></div>
      <div><span>Bankroll after</span><strong>${money(Math.max(0, after))}</strong></div>
    </div>
    <label class="golf-stake-label">Virtual stake
      <input id="golfStake" type="number" min="1" step="1" value="${stake}" inputmode="numeric">
    </label>
    <div class="golf-stake-quick">
      ${GOLF_STAKES.map(v => `<button class="secondary ${v === stake ? 'active' : ''}" data-golf-stake="${v}">$${v}</button>`).join('')}
    </div>
    ${error ? `<p class="golf-error">${error}</p>` : ''}
    <button class="full primary" id="golfPlace" ${error ? 'disabled' : ''}>
      ${error ? 'Cannot place' : `Review ${money(stake)} mock bet`}</button>
    <p class="disclaimer">Mock bet using virtual funds. Odds are locked in at submission.</p>
  </section>`;

  const input = document.getElementById('golfStake');
  input.oninput = () => { Store.set(KEYS.golfStake, (input.value === '' ? 0 : Number(input.value))); renderGolfSlip(); };
  box.querySelectorAll('[data-golf-stake]').forEach(b => b.onclick = () => {
    Store.set(KEYS.golfStake, Number(b.dataset.golfStake));
    renderGolfSlip();
  });
  document.getElementById('golfClear').onclick = () => { GolfEvent.selection = null; renderGolfSlip(); };
  const place = document.getElementById('golfPlace');
  if (place && !error) place.onclick = () => confirmGolfBet(sel, stake, profit, total);
}

/* Explicit confirmation, per the test spec — a mock bet still commits
   bankroll and a bet count, so it should not be a single tap. */
function confirmGolfBet(sel, stake, profit, total) {
  const msg = `Place a mock bet?\n\n${sel.name} to win ${GolfEvent.data.name}`
    + `\nOdds ${fmtOdds(sel.americanOdds)}`
    + `\nVirtual stake ${money(stake)}`
    + `\nPotential return ${money(total)}`
    + `\n\nVirtual funds only. No real money is involved.`;
  const go = (typeof window.confirm === 'function') ? window.confirm(msg) : true;
  if (!go) return;
  placeGolfBet(sel, stake, total);
}

function placeGolfBet(sel, stake, total) {
  if (!requireAccount('Sign in to place a mock bet.')) return;
  const s = weekStats(week);
  if (GolfEvent.isLocked()) { showToast('Betting is closed for this event.'); return; }
  if (s.betsLeft <= 0) { showToast(`Weekly limit of ${WEEKLY_BET_LIMIT} bets reached.`); return; }
  if (!(stake >= 1) || stake > week.bankroll) { showToast('Invalid virtual stake.'); return; }

  /* Snapshot what the market believed right now — the one piece of CLV
     that cannot be reconstructed later. */
  const fieldPrices = GolfEvent.selections().map(x => x.americanOdds);
  const myIndex = GolfEvent.selections().findIndex(x => x.selectionId === sel.selectionId);

  week.tickets.unshift({
    id: `VIG-G-${Date.now().toString(36).toUpperCase()}`,
    kind: 'golf',
    fairProb: fairProbability(fieldPrices, myIndex),
    fairMethod: DEVIG_METHOD,
    bookPrices: { book: 'vig-sim', prices: fieldPrices },
    eventId: GolfEvent.data.eventId,
    marketId: GolfEvent.market().marketId,
    selectionId: sel.selectionId,
    date: new Date().toLocaleString(undefined,
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    placedAt: new Date().toISOString(),
    status: 'open',
    stake,
    odds: sel.americanOdds,             // frozen at submission, never recalculated
    returnAmount: round2(total),
    legs: [{ title: `${sel.name} — ${GolfEvent.market().name}`, odds: sel.americanOdds, gameId: null }]
  });
  week.bankroll = derivedBankroll(week);
  GolfEvent.selection = null;
  if (Cloud.enabled() && Cloud.signedIn() && cloudUnreachable()) {
    Outbox.add(week.tickets[0], week.key);
    showToast('Saved on this device — will sync when the server is back.');
  } else if (Cloud.enabled() && Cloud.signedIn()) {
    Cloud.placeBet(week.tickets[0], week.key)
      .then(saved => {
        week.tickets[0] = saved;          // adopt the row id from the database
        week.bankroll = derivedBankroll(week);
        persist();
      })
      .catch(e => {
        console.warn('[VIG] bet queued for retry:', e && e.message);
        Outbox.add(week.tickets[0], week.key);
        showToast('Saved on this device — will sync when the server is back.');
      });
  }
  persist();
  renderGolfEvent();
  updateDashboard();
  renderBets(activeBetFilter());
  renderCompetition();
  showToast(`Mock bet placed. ${weekStats(week).betsLeft} of ${WEEKLY_BET_LIMIT} left.`);
}

/* ---- settlement -------------------------------------------------
   Idempotent by construction: only tickets still 'open' are touched,
   and each records settledAt. Clicking settle twice pays nobody twice.
------------------------------------------------------------------ */
function settleGolfEvent(winnerId, { push = false } = {}) {
  const open = golfTickets().filter(t => t.status === 'open'
    && t.eventId === GolfEvent.data.eventId);
  if (!open.length) return { settled: 0, paid: 0 };
  let paid = 0;
  open.forEach(t => {
    /* status is the only thing settlement writes. Every payout follows
       from it, so these three branches can no longer disagree with the
       money. */
    if (push) t.status = 'push';
    else if (t.selectionId === winnerId) t.status = 'won';
    else t.status = 'lost';
    paid += realizedReturn(t);
    t.settledAt = new Date().toISOString();
  });
  week.bankroll = derivedBankroll(week);
  week.history.push(round2(week.bankroll));
  if (week.history.length > 40) week.history.shift();
  GolfEvent.setState({ status: 'final', winner: push ? null : winnerId, settledAt: new Date().toISOString() });
  persist();
  return { settled: open.length, paid: round2(paid) };
}



/* ============================================================
   16. Test-admin controls (v1.4.4)
   Hidden behind ?admin=1 — deliberately not a button anyone can find
   by accident. Everything here is destructive-ish, so each action
   confirms first and settlement is idempotent.
   ============================================================ */
const Admin = {
  /* v1.7.4: this used to LATCH. One visit to ?admin=1 wrote vig.v2.admin=true
     and the settlement controls then appeared on every load forever, for that
     browser, with no way to put them away short of clearing storage. Test
     controls sitting permanently on the page is not a beta, it's a bug.

     Visibility is now purely a property of the current URL: ?admin=1, or a
     path ending /admin. Close the tab and the panel is gone.

     This is about what is SHOWN. Whether the buttons actually do anything is
     decided by public.admins in the database — see Admin.isServerAdmin(). */
  enabled() {
    try {
      const p = new URLSearchParams(location.search);
      if (p.get('admin') === '1') return true;
      return /\/admin\/?$/.test(location.pathname);
    } catch (e) { return false; }
  },
  /* The Hide button: drop the param and reload, so the panel is gone and the
     URL matches what is on screen. */
  disable() {
    Store.remove('vig.v2.admin');            // retire the old latch if present
    try {
      const u = new URL(location.href);
      u.searchParams.delete('admin');
      location.replace(u.toString());
    } catch (e) { location.reload(); }
  },
  /* URL visibility is not authority. Only the database says who may settle for
     everyone; this mirrors the answer the server already gave us. */
  isServerAdmin() {
    try { return Cloud.admin === true; } catch (e) { return false; }
  }
};

/* ONE settlement path, with one source of truth at a time.

   Signed in : the database settles atomically, then every device
               re-reads. The client never grades its own bets — RLS
               rejects it anyway, and grading locally first is precisely
               what let two devices disagree.
   Local only: there is no database, so local storage is the truth. */
async function settleAndSync(winnerId, { push = false } = {}) {
  const lock = ['adminSettle', 'adminPush'].map(id => document.getElementById(id));
  lock.forEach(b => { if (b) b.disabled = true; });

  if (!(Cloud.enabled() && Cloud.signedIn())) {
    const r = settleGolfEvent(winnerId, { push });
    updateDashboard(); renderBets(activeBetFilter()); renderCompetition();
    renderGolfEvent(); renderAdmin();
    showToast(`Settled ${r.settled} bet${r.settled === 1 ? '' : 's'}, ${money(r.paid)} returned.`);
    return r;
  }

  try {
    const res = await Cloud.settleEvent(GolfEvent.data.eventId, winnerId, { push });
    GolfEvent.setState({ status: 'final', winner: push ? null : winnerId,
                         settledAt: new Date().toISOString() });
    await syncFromCloud();                 // re-read rather than assume
    await refreshLeaderboard();
    refreshAllTime();
    renderGolfEvent(); renderAdmin();
    showToast(res.settled
      ? `Settled ${res.settled} for everyone · ${res.winners} won · ${money(res.paid)} paid.`
      : 'Nothing left to settle.');
    return res;
  } catch (e) {
    renderAdmin();
    const msg = e && e.message ? e.message : 'failed';
    showToast(/admin/i.test(msg) ? 'Admin only — this account cannot settle.'
                                 : `Settlement failed: ${msg}`);
    console.warn('[VIG] settlement failed:', msg);
    return { settled: 0 };
  }
}

let adminOpenCount = null;     // open bets on this event across ALL users

/* What this device holds, versus what the database holds. Built because
   two devices disagreeing had no way to say WHY without a console. */
async function syncReport() {
  const local = week.tickets || [];
  const localBank = derivedBankroll(week);
  const rep = {
    build: VIG_BUILD,
    signedIn: Cloud.enabled() && Cloud.signedIn(),
    email: Cloud.email(),
    weekKey: week.key,
    localCount: local.length,
    localBankroll: localBank,
    localOnly: local.filter(t => LOCAL_ID.test(String(t.id || ''))).map(t => t.id),
    queued: Outbox.count(),
    rejected: DeadLetter.all(),
    remoteCount: null, remoteBankroll: null, agrees: null, error: null
  };
  if (!rep.signedIn) return rep;
  try {
    const remote = await Cloud.myBets(week.key);
    /* Adopt any server row this device is still holding under a placeholder
       id, so the report describes the truth rather than a stale label. */
    rep.adopted = reconcileWithRemote(remote);
    if (rep.adopted) {
      rep.localOnly = (week.tickets || []).filter(t => LOCAL_ID.test(String(t.id || ''))).map(t => t.id);
      rep.queued = Outbox.count();
      rep.localBankroll = derivedBankroll(week);
      rep.localCount = (week.tickets || []).length;
    }
    rep.remoteCount = remote.length;
    rep.remoteBankroll = derivedBankroll({ tickets: remote });
    /* "In sync" must mean nothing is outstanding, not merely that two totals
       happen to match. A queued or rejected ticket is a difference. */
    rep.agrees = rep.remoteCount === rep.localCount
              && Math.abs(rep.remoteBankroll - rep.localBankroll) < 0.01
              && rep.queued === 0
              && rep.localOnly.length === 0
              && rep.rejected.length === 0;
  } catch (e) {
    const msg = e && e.message ? e.message : 'read failed';
    /* A missing GRANT and an empty result are very different problems, and
       the raw Postgres wording does not say which to fix. */
    rep.error = /permission denied/i.test(msg)
      ? 'permission denied — the authenticated role has no grant on this table. Run the grants migration.'
      : msg;
  }
  return rep;
}

function renderSyncReport(rep) {
  const el = document.getElementById('adminSync');
  if (!el) return;
  if (!rep.signedIn) {
    el.innerHTML = `<p class="admin-note">Build <b>${rep.build}</b> · not signed in — local only.</p>`;
    return;
  }
  const row = (k, v, warn) => `<div class="sr-row${warn ? ' warn' : ''}"><span>${k}</span><strong>${v}</strong></div>`;
  el.innerHTML = `
    <div class="sync-report">
      ${row('Build', rep.build)}
      ${row('Account', rep.email || '—')}
      ${row('Week', rep.weekKey)}
      ${row('Tickets here', rep.localCount)}
      ${row('Tickets on server', rep.error ? 'unreadable' : rep.remoteCount, !!rep.error)}
      ${row('Bankroll here', money(rep.localBankroll))}
      ${row('Bankroll on server', rep.error ? '—' : money(rep.remoteBankroll),
            rep.agrees === false)}
      ${rep.localOnly.length ? row('Not yet uploaded', rep.localOnly.length, true) : ''}
      ${rep.queued ? row('Queued to send', rep.queued, true) : ''}
      ${rep.rejected && rep.rejected.length ? row('Rejected', rep.rejected.length, true) : ''}
    </div>
    ${rep.rejected && rep.rejected.length ? `<p class="admin-note warn"><b>Upload rejected</b> — ${
      rep.rejected.length} ticket(s) the server will not accept:<br>${
      rep.rejected.map(r => `<code>${r.ticket.id}</code> — ${r.reason}`).join('<br>')
    }</p>` : ''}
    <p class="admin-note">${
      rep.error ? `Server unreadable: ${rep.error}`
      : rep.agrees ? 'This device matches the database.'
      : `<b>Out of step.</b> ${rep.localOnly.length
          ? `${rep.localOnly.length} ticket(s) on this device were never uploaded — Force resync will send them.`
          : 'Force resync will pull the server\'s version.'}`}</p>
    <div class="admin-actions">
      <button class="secondary" id="adminResync">Force resync</button>
    </div>`;
  const btn = document.getElementById('adminResync');
  if (btn) btn.onclick = async () => {
    btn.disabled = true; btn.textContent = 'Syncing…';
    await syncFromCloud();
    await refreshLeaderboard();
    updateDashboard(); renderBets(activeBetFilter()); renderGolfEvent();
    const again = await syncReport();
    renderSyncReport(again);
    showToast(again.agrees ? 'In sync with the database.' : 'Still out of step — see the report.');
  };
}

function renderAdmin() {
  /* Belt and braces on the URL gate: if admin is not in the URL the panel is
     emptied and hidden, so it cannot take up space or catch a stray tap. */
  {
    const p = document.getElementById('adminPanel');
    if (p && !Admin.enabled()) { p.innerHTML = ''; p.hidden = true; return; }
  }
  const box = document.getElementById('adminPanel');
  if (!box) return;
  if (!Admin.enabled() || !GolfEvent.data) { box.hidden = true; return; }
  box.hidden = false;
  const st = GolfEvent.state();
  /* These used to count only the ADMIN'S OWN tickets, so once the admin's
     personal bet was graded the Settle button disabled itself while other
     people's bets were still open in the database. `adminOpenCount` is the
     server's number across every user; the local figure is only a fallback
     for offline play. */
  const localOpen = golfTickets().filter(t => t.status === 'open').length;
  const graded = golfTickets().filter(t => t.status !== 'open').length;
  const open = (adminOpenCount === null) ? localOpen : adminOpenCount;
  const lt = Store.get(KEYS.lifetime, null);

  box.innerHTML = `
    <div class="panel-head"><div><span class="eyebrow">TEST ADMIN</span>
      <h2>Settlement controls</h2>
      <p class="muted-copy">Private beta only. Event status <strong>${st.status}</strong> ·
        ${open} open golf bet${open === 1 ? '' : 's'} · ${graded} settled</p></div>
      <button class="text-btn" id="adminHide">Hide</button></div>

    <div class="admin-grid">
      <div class="admin-block">
        <h3>Event status</h3>
        <div class="admin-actions">
          <button class="secondary" data-admin-status="open"   ${st.status === 'open' ? 'disabled' : ''}>Open</button>
          <button class="secondary" data-admin-status="locked" ${st.status === 'locked' ? 'disabled' : ''}>Lock</button>
        </div>
      </div>

      <div class="admin-block">
        <h3>Settle tournament</h3>
        <label>Winning golfer
          <select id="adminWinner">
            <option value="">— choose —</option>
            ${GolfEvent.selections().map(s =>
              `<option value="${s.selectionId}" ${st.winner === s.selectionId ? 'selected' : ''}>${s.name} (${fmtOdds(s.americanOdds)})</option>`).join('')}
          </select></label>
        <div class="admin-actions">
          <button class="primary" id="adminSettle" ${open ? '' : 'disabled'}>Settle ${open} bet${open === 1 ? '' : 's'}</button>
          <button class="secondary" id="adminPush" ${open ? '' : 'disabled'}>Void as push</button>
        </div>
        ${!open ? `<p class="admin-note">Nothing is open on this event${
          adminOpenCount === null ? '' : ' anywhere'}. Settling is disabled because
          there is nothing left to grade${st.settledAt ? ` — it was settled ${new Date(st.settledAt).toLocaleString()}` : ''}.
          Use <b>Undo settlement</b> to reopen it.</p>` : ''}
        <div class="admin-actions" hidden>
        </div>
        ${st.settledAt ? `<p class="admin-note">Settled ${new Date(st.settledAt).toLocaleString()}. Settling again pays nobody twice.</p>` : ''}
      </div>

      <div class="admin-block">
        <h3>Weekly cycle</h3>
        <p class="admin-note">Automatic rollover is <strong>${AUTO_ROLLOVER ? 'on' : 'paused for testing'}</strong>.</p>
        <div class="admin-actions">
          <button class="secondary" id="adminFinalize">Finalize week</button>
          <button class="secondary" id="adminNewWeek">Start new week</button>
        </div>
        ${lt ? `<p class="admin-note">Lifetime: ${lt.bets} bets · ${lt.won}W ${lt.lost}L ${lt.push}P ·
          ${lt.profit >= 0 ? '+' : ''}${money(lt.profit)} · ${lt.weeks} week${lt.weeks === 1 ? '' : 's'} archived</p>` : ''}
      </div>

      <div class="admin-block wide">
        <h3>Sync report</h3>
        <div id="adminSync"><p class="admin-note">Reading…</p></div>
      </div>

      <div class="admin-block">
        <h3>Users</h3>
        <p class="admin-note" id="adminUserCount">${Cloud.enabled()
          ? (Cloud.signedIn() ? 'Counting…' : 'Sign in to read the signup count.')
          : 'Local mode — no accounts configured.'}</p>
        <p class="admin-note">${Cloud.enabled()
          ? `Signed in as ${Cloud.email() || 'unknown'}${Cloud.admin ? ' · admin' : ''}`
          : 'Add Supabase keys in config.js to enable accounts.'}</p>
      </div>

      <div class="admin-block danger">
        <h3>Reset test data</h3>
        <p class="admin-note">Clears this week's bets and the event result. Lifetime stats are kept.</p>
        <div class="admin-actions">
          <button class="secondary" id="adminUndo">Undo settlement</button>
          <button class="secondary" id="adminReset">Reset test</button>
        </div>
      </div>
    </div>`;

  const rerender = () => { renderGolfEvent(); updateDashboard(); renderBets(activeBetFilter());
                           renderCompetition(); renderAdmin(); };

  syncReport().then(renderSyncReport);

  if (Cloud.enabled() && Cloud.signedIn()) {
    /* refresh the cross-user open count, then repaint once it lands */
    Cloud.eventOpenCount(GolfEvent.data.eventId).then(n => {
      if (n !== null && n !== adminOpenCount) { adminOpenCount = n; renderAdmin(); }
    });
    Cloud.adminStats().then(st2 => {
      const el = document.getElementById('adminUserCount');
      if (!el) return;
      if (!st2) { el.textContent = 'Could not read the signup count.'; return; }
      el.innerHTML = `<b>${st2.signups}</b> account${st2.signups === 1 ? '' : 's'} · ` +
        `${st2.profiles} with a display name · ${st2.bets} bet${st2.bets === 1 ? '' : 's'} placed` +
        (st2.open_bets ? ` · ${st2.open_bets} open` : '') +
        (st2.signups > st2.profiles
          ? `<br><small>${st2.signups - st2.profiles} signed in but never chose a name — they will not appear on the leaderboard.</small>`
          : '');
    });
    Cloud.userCount().then(n => {
      const el = document.getElementById('adminUserCount');
      /* superseded by adminStats() above; kept as a fallback only */
      if (el && !el.innerHTML.trim()) el.textContent = (n === null)
        ? 'Could not read the signup count.' : `${n} profile${n === 1 ? '' : 's'}.`;
    });
  }

  box.querySelectorAll('[data-admin-status]').forEach(b => b.onclick = () => {
    GolfEvent.setState({ status: b.dataset.adminStatus });
    rerender();
    showToast(`Event set to ${b.dataset.adminStatus}.`);
  });

  document.getElementById('adminSettle').onclick = () => {
    const w = document.getElementById('adminWinner').value;
    if (!w) { showToast('Choose the winning golfer first.'); return; }
    const name = (GolfEvent.find(w) || {}).name || w;
    if (!confirm(`Settle all open golf bets with ${name} as the winner?\n\nThis pays winners and marks the rest lost.`)) return;
    settleAndSync(w, { push: false });
  };

  document.getElementById('adminPush').onclick = () => {
    if (!confirm('Void all open golf bets as push?\n\nEvery stake is returned with no profit.')) return;
    settleAndSync(null, { push: true });
  };

  document.getElementById('adminFinalize').onclick = () => {
    const s = weekStats(week);
    if (s.openCount && !confirm(`${s.openCount} bet${s.openCount === 1 ? ' is' : 's are'} still open.\n\nFinalizing voids them and refunds the stakes. Continue?`)) return;
    if (!confirm('Finalize this week? Results are archived and lifetime stats updated.')) return;
    archiveWeek(week);
    persist();
    rerender();
    showToast('Week finalized and archived.');
  };

  document.getElementById('adminNewWeek').onclick = () => {
    if (!confirm(`Start a new week?\n\nEveryone returns to ${money(WEEKLY_BANKROLL)} with ${WEEKLY_BET_LIMIT} bets. Archived weeks and lifetime stats are kept.`)) return;
    week = blankWeek(weekKeyFor());
    GolfEvent.setState({ status: (GolfEvent.data && GolfEvent.data.status) || 'open', winner: null, settledAt: null });
    persist();
    rerender();
    showToast(`New week started at ${money(WEEKLY_BANKROLL)}.`);
  };

  document.getElementById('adminUndo').onclick = async () => {
    if (!confirm('Undo settlement?\n\nGolf bets return to open and the payouts are reversed.')) return;
    if (Cloud.enabled() && Cloud.signedIn()) {
      try {
        const n = await Cloud.unsettleEvent(GolfEvent.data.eventId);
        GolfEvent.setState({ status: 'open', winner: null, settledAt: null });
        adminOpenCount = null;
        await syncFromCloud();
        await refreshLeaderboard();
        renderGolfEvent(); renderAdmin();
        showToast(`${n} bet${n === 1 ? '' : 's'} reopened for everyone.`);
      } catch (e) {
        showToast(`Could not undo: ${e && e.message ? e.message : 'failed'}`);
      }
      return;
    }
    let reversed = 0;
    /* Reversing is now only a status change. Nothing to recompute, because
       nothing was destroyed; nothing to subtract, because the bankroll is
       derived from the ledger rather than accumulated into. */
    golfTickets().filter(t => t.settledAt).forEach(t => {
      t.status = 'open';
      delete t.settledAt;
      reversed++;
    });
    week.bankroll = derivedBankroll(week);
    GolfEvent.setState({ status: 'open', winner: null, settledAt: null });
    persist();
    rerender();
    showToast(`${reversed} bet${reversed === 1 ? '' : 's'} reopened.`);
  };

  document.getElementById('adminReset').onclick = () => {
    if (!confirm('Reset the test?\n\nThis week\'s bets are cleared and the event reopened. Lifetime stats and archived weeks are kept.')) return;
    week = blankWeek(weekKeyFor());
    GolfEvent.setState({ status: (GolfEvent.data && GolfEvent.data.status) || 'open', winner: null, settledAt: null });
    persist();
    rerender();
    showToast('Test data reset.');
  };

  document.getElementById('adminHide').onclick = () => {
    Admin.disable();
    renderAdmin();
    showToast('Admin hidden. Re-open with ?admin=1');
  };
}



/* ============================================================
   17. Cloud — Supabase accounts, bets and leaderboard (v1.5)

   Degrades to nothing. If SUPABASE_URL is blank, Cloud.enabled() is
   false, no gates appear, and the app behaves exactly as it did in
   v1.4.4 with local storage only.

   Bankroll is never stored anywhere — not locally, not in the
   database. It is derived from the bets themselves, so there is no
   balance field for anyone to edit.
   ============================================================ */
const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

const Cloud = {
  client: null,
  session: null,
  profile: null,
  admin: false,
  status: 'off',          // off | loading | ready | error
  error: null,

  config() {
    const c = window.VIG_CONFIG || {};
    return { url: (c.SUPABASE_URL || '').trim(), key: (c.SUPABASE_ANON_KEY || '').trim() };
  },
  configured() { const c = this.config(); return !!(c.url && c.key); },
  enabled() { return this.status === 'ready'; },
  signedIn() { return !!(this.session && this.session.user); },
  userId() { return this.signedIn() ? this.session.user.id : null; },
  /* The email is never copied into our own tables. This reads it back
     from the auth session purely to show "signed in as" in the UI. */
  email() { return this.signedIn() ? this.session.user.email : null; },

  loadSdk() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = SDK_URL;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('Supabase SDK failed to load'));
      document.head.appendChild(el);
    });
  },

  async init() {
    if (!this.configured()) { this.status = 'off'; return false; }
    this.status = 'loading';
    try {
      await this.loadSdk();
      const { url, key } = this.config();
      this.client = window.supabase.createClient(url, key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
      const { data } = await this.client.auth.getSession();
      this.session = data ? data.session : null;
      this.client.auth.onAuthStateChange((_evt, sess) => {
        this.session = sess;
        onAuthChanged();
      });
      if (this.signedIn()) await this.afterSignIn();
      this.status = 'ready';
      return true;
    } catch (e) {
      this.status = 'error';
      this.error = e && e.message ? e.message : String(e);
      console.warn('[VIG] cloud unavailable, staying local:', this.error);
      return false;
    }
  },

  async afterSignIn() {
    await this.loadProfile();
    await this.loadAdmin();
  },

  /* "Failed to fetch" is what the browser says when a request never reached a
     server at all. It is the same message whether the project is paused, the
     device is offline, or the URL is wrong — useless on its own. So when we see
     it, go and find out which, by asking the auth server's own health endpoint.
     It needs no key and no session. */
  async diagnose() {
    const { url, key } = this.config();
    if (!url || !key) return { ok: false, cause: 'unconfigured',
      message: 'No Supabase URL or key in config.js.' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false)
      return { ok: false, cause: 'offline', message: 'This device is offline.' };
    if (!window.supabase || !window.supabase.createClient)
      return { ok: false, cause: 'sdk', message: 'The Supabase SDK did not load — a blocker or firewall may be stopping the CDN.' };
    let res;
    try {
      res = await fetch(url.replace(/\/$/, '') + '/auth/v1/health',
                        { headers: { apikey: key }, cache: 'no-store' });
    } catch (e) {
      return { ok: false, cause: 'unreachable',
        message: 'The Supabase project did not answer. Free projects pause after about a week idle — check the dashboard for a Restore button.' };
    }
    if (res.status === 401 || res.status === 403)
      return { ok: false, cause: 'key',
        message: `The project answered but rejected the key (${res.status}). The anon/publishable key in config.js may be stale.` };
    if (res.status >= 500)
      return { ok: false, cause: 'server',
        message: `The project answered with ${res.status} — Supabase side, not yours.` };
    return { ok: true, cause: 'reachable',
      message: 'Auth server is reachable, so the failure is with this specific request, not the connection.' };
  },

  async signUpPassword(email, password) {
    if (!this.client) throw new Error('Cloud not ready');
    const { data, error } = await this.client.auth.signUp({
      email: String(email || '').trim(),
      password: String(password || ''),
      options: { emailRedirectTo: location.origin + location.pathname }
    });
    if (error) throw error;
    return data;
  },

  async signInPassword(email, password) {
    if (!this.client) throw new Error('Cloud not ready');
    const { data, error } = await this.client.auth.signInWithPassword({
      email: String(email || '').trim(),
      password: String(password || '')
    });
    if (error) throw error;
    return data;
  },

  async resetPassword(email) {
    if (!this.client) throw new Error('Cloud not ready');
    const { error } = await this.client.auth.resetPasswordForEmail(
      String(email || '').trim(), { redirectTo: location.origin + location.pathname });
    if (error) throw error;
    return true;
  },

  async signIn(email) {
    if (!this.client) throw new Error('Cloud not ready');
    const redirectTo = location.origin + location.pathname;
    const { error } = await this.client.auth.signInWithOtp({
      email: String(email || '').trim(),
      options: { emailRedirectTo: redirectTo }
    });
    if (error) throw error;
    return true;
  },

  async signOut() {
    if (!this.client) return;
    await this.client.auth.signOut();
    this.session = null; this.profile = null; this.admin = false;
  },

  /* `profileUnknown` is the difference between "this user has no profile
     row yet" and "we could not reach the database". Conflating them meant a
     returning user hit a paused free-tier project and was asked to pick a
     display name they already had — with no way to dismiss it. */
  profileUnknown: false,
  reachable: true,

  async loadProfile() {
    if (!this.signedIn()) { this.profile = null; this.profileUnknown = false; return null; }
    try {
      const { data, error } = await this.client
        .from('profiles').select('*').eq('id', this.userId()).maybeSingle();
      if (error) throw error;
      this.profile = data || null;
      this.profileUnknown = false;
      this.reachable = true;
      return this.profile;
    } catch (e) {
      console.warn('[VIG] profile read failed:', e && e.message);
      this.profile = null;
      this.profileUnknown = true;      // unknown, not absent
      this.reachable = false;
      return null;
    }
  },

  async saveProfile(displayName, leagueCode, extra) {
    if (!this.signedIn()) throw new Error('Not signed in');
    const name = String(displayName || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    if (!name) throw new Error('Display name required');
    const row = {
      id: this.userId(), display_name: name,
      league_code: String(leagueCode || '').trim().slice(0, 8).toUpperCase() || null
    };
    if (extra && typeof extra === 'object') {
      if (extra.avatar_color) row.avatar_color = extra.avatar_color;
      if (extra.avatar_emoji !== undefined) row.avatar_emoji = extra.avatar_emoji || null;
    }
    const { data, error } = await this.client
      .from('profiles').upsert(row).select().single();
    if (error) throw error;
    this.profile = data;
    return data;
  },

  async loadAdmin() {
    if (!this.signedIn()) { this.admin = false; return false; }
    const { data } = await this.client
      .from('admins').select('user_id').eq('user_id', this.userId()).maybeSingle();
    this.admin = !!data;
    return this.admin;
  },

  /* ---- bets ---- */
  /* THROWS on failure rather than returning []. An empty array and a failed
     read are completely different things: syncFromCloud() assigns the result
     straight to week.tickets, so swallowing the error here would have wiped
     a user's entire ticket list the moment the server hiccuped. */
  async myBets(weekKey) {
    if (!this.signedIn()) return [];
    const { data, error } = await this.client
      .from('bets').select('*')
      .eq('user_id', this.userId()).eq('week_key', weekKey)
      .order('placed_at', { ascending: false });
    if (error) {
      this.reachable = false;
      throw new Error(error.message || 'bets read failed');
    }
    this.reachable = true;
    return (data || []).map(rowToTicket).filter(Boolean);
  },

  async placeBet(ticket, weekKey) {
    /* Malformed before unauthenticated: a bad ticket is bad regardless of
       session, and this is the clearer error of the two. */
    validateTicketForUpload(ticket);
    if (!this.signedIn()) throw new Error('Not signed in');
    const row = {
      user_id: this.userId(),
      week_key: weekKey,
      kind: ticket.kind === 'golf' ? 'golf' : 'parlay',
      event_id: ticket.eventId || null,
      market_id: ticket.marketId || null,
      selection_id: ticket.selectionId || null,
      title: ticket.legs && ticket.legs.length
        ? (ticket.legs.length === 1 ? ticket.legs[0].title : `${ticket.legs.length}-leg parlay`)
        : 'Mock bet',
      stake: ticket.stake,
      odds: ticket.odds,
      potential_return: potentialReturn(ticket),
      legs: ticket.legs || null,
      fair_prob: (typeof ticket.fairProb === 'number') ? ticket.fairProb : null,
      fair_method: ticket.fairMethod || null,
      book_prices: ticket.bookPrices || null
    };
    const { data, error } = await this.client.from('bets').insert(row).select().single();
    if (error) throw error;
    const t = rowToTicket(data);
    if (!t) throw new Error('Server returned an unexpected row');
    return t;
  },

  /* ONE atomic server call. This used to be a client-side loop that
     updated rows one at a time AFTER the client had already changed its
     own local copy — a dual write with local-first ordering, which is
     what let two devices end up with different bankrolls. */
  async settleEvent(eventId, winnerSelectionId, { push = false } = {}) {
    if (!this.client) throw new Error('Cloud not ready');
    const { data, error } = await this.client.rpc('settle_event', {
      p_event: eventId, p_selection: winnerSelectionId || null, p_push: !!push
    });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return {
      settled: Number((row && row.settled) || 0),
      winners: Number((row && row.winners) || 0),
      paid: Number((row && row.paid) || 0)
    };
  },

  async unsettleEvent(eventId) {
    if (!this.client) throw new Error('Cloud not ready');
    const { data, error } = await this.client.rpc('unsettle_event', { p_event: eventId });
    if (error) throw error;
    return Number(data || 0);
  },

  /* Open bets on an event across EVERY user, not just this one. */
  async eventOpenCount(eventId) {
    if (!this.signedIn()) return null;
    const { data, error } = await this.client.rpc('event_open_count', { p_event: eventId });
    return error ? null : Number(data || 0);
  },

  async adminStats() {
    if (!this.signedIn()) return null;
    const { data, error } = await this.client.rpc('admin_stats');
    if (error) return null;
    return Array.isArray(data) ? data[0] : data;
  },

  /* ---- shared reads ---- */
  async leaderboard(weekKey) {
    if (!this.signedIn()) return [];
    const { data, error } = await this.client
      .rpc('leaderboard', { p_week: weekKey, p_start: WEEKLY_BANKROLL });
    if (error) { console.warn('[VIG] leaderboard failed:', error.message); return []; }
    return data || [];
  },
  async lifetime() {
    if (!this.signedIn()) return [];
    const { data, error } = await this.client.rpc('lifetime', { p_start: WEEKLY_BANKROLL });
    if (error) return [];
    return data || [];
  },
  async userCount() {
    if (!this.signedIn()) return null;
    const { data, error } = await this.client.rpc('user_count');
    return error ? null : data;
  },

  /* ---- events ---- */
  async getEvent(eventId) {
    if (!this.enabled() || !this.signedIn()) return null;
    const { data } = await this.client
      .from('events').select('*').eq('event_id', eventId).maybeSingle();
    return data || null;
  },
  async upsertEvent(row) {
    if (!this.admin) throw new Error('Admin only');
    const { data, error } = await this.client
      .from('events').upsert(Object.assign({ updated_at: new Date().toISOString() }, row))
      .select().single();
    if (error) throw error;
    return data;
  }
};

/* ---- outbox --------------------------------------------------------
   A bet that cannot reach the database is queued here instead of being
   silently lost. Two things were wrong before: nothing retried, and
   syncFromCloud() replaced the local list wholesale — so an offline bet
   vanished the next time the server answered. The queue is flushed
   BEFORE pulling the remote list, and anything still pending is merged
   on top of it.
-------------------------------------------------------------------- */
const Outbox = {
  all() { return Store.get(KEYS.outbox, []) || []; },
  count() { return this.all().length; },
  add(ticket, weekKey) {
    const q = this.all();
    const fp = ticketFingerprint(ticket);
    if (q.some(x => x.ticket.id === ticket.id || ticketFingerprint(x.ticket) === fp)) return;
    q.push({ ticket, weekKey, queuedAt: new Date().toISOString(), tries: 0 });
    Store.set(KEYS.outbox, q);
    renderSyncChip();
  },
  remove(localId) {
    Store.set(KEYS.outbox, this.all().filter(x => x.ticket.id !== localId));
    renderSyncChip();
  },
  bump(localId) {
    const q = this.all();
    const hit = q.find(x => x.ticket.id === localId);
    if (hit) { hit.tries += 1; Store.set(KEYS.outbox, q); }
  },
  clear() { Store.set(KEYS.outbox, []); renderSyncChip(); }
};

/* A ticket the server will never accept must leave the queue, or it blocks
   everything behind it and retries forever. It is not discarded — it is set
   aside with the reason, so the sync report can show it and a human can
   decide. Silence is what made the original 400 so hard to find. */
const DeadLetter = {
  all() { return Store.get(KEYS.rejected, []) || []; },
  count() { return this.all().length; },
  add(entry, reason) {
    const q = this.all();
    if (q.some(x => x.ticket.id === entry.ticket.id)) return;
    q.push({ ticket: entry.ticket, weekKey: entry.weekKey, reason,
             rejectedAt: new Date().toISOString(), tries: entry.tries || 0 });
    Store.set(KEYS.rejected, q);
  },
  clear() { Store.set(KEYS.rejected, []); }
};

/* Which failures are worth retrying? A dropped connection, yes. A row the
   schema will refuse on every attempt, no. Getting this distinction wrong is
   what turned one invalid ticket into an endless retry loop that also
   declared a perfectly healthy server unreachable. */
function isPermanentRejection(msg) {
  return /stake must be at least|odds out of range|potential return must be positive/i.test(msg)
      || /violates check constraint|23514|22P02|invalid input syntax/i.test(msg)
      || /row-level security|42501|permission denied/i.test(msg)
      || /null value in column|23502/i.test(msg);
}

/* A ticket placed while the app was in local mode — no Supabase keys, or
   keys that had been blanked — exists only in this browser. Once the cloud
   connects, syncFromCloud() replaces the ticket list with the server's, and
   anything never uploaded is silently dropped. That is data loss, and it
   happened for real: a settled winning bet vanished because config.js was
   blank when it was placed.

   Cloud-placed tickets carry a Supabase uuid. Locally-placed ones carry a
   VIG- prefix, so the two are trivially distinguishable. */
const LOCAL_ID = /^VIG-/;

/* Matching on id alone was not enough. The SAME bet can exist under two
   different ids — a VIG- one created locally and a uuid assigned by the
   database — so a bet that had already been uploaded looked local-only and
   was uploaded a second time. That is how a $25 parlay became two $25
   parlays and quietly took $25 off the bankroll.

   Identity has to come from the bet's CONTENT, not from whichever id
   happens to be attached to it. */
function ticketFingerprint(t) {
  if (!t) return '';
  const legs = (t.legs || [])
    .map(l => `${(l.title || '').trim()}@${l.odds}`)
    .sort()
    .join('|');
  return [
    t.kind || 'parlay',
    t.eventId || '',
    t.selectionId || '',
    Number(t.stake).toFixed(2),
    Number(t.odds),
    legs
  ].join('~');
}

function localOnlyTickets(remote) {
  const seen = new Set((remote || []).map(ticketFingerprint));
  const queued = new Set(Outbox.all().map(x => ticketFingerprint(x.ticket)));
  const out = [];
  const mine = new Set();
  week.tickets.forEach(t => {
    if (!LOCAL_ID.test(String(t.id || ''))) return;   // already a server row
    const fp = ticketFingerprint(t);
    if (seen.has(fp) || queued.has(fp) || mine.has(fp)) return;
    mine.add(fp);                                     // and never twice in one pass
    out.push(t);
  });
  return out;
}

/* A bet can be on the server and still carry its VIG- placeholder id here,
   if the swap after upload missed. It then reads as "never uploaded" forever
   and keeps a stale outbox entry alive. Identity is the fingerprint, so adopt
   the server's row wherever one matches and retire the queue entry. */
function reconcileWithRemote(remote) {
  const byFp = new Map();
  (remote || []).forEach(r => byFp.set(ticketFingerprint(r), r));
  let adopted = 0;
  week.tickets.forEach((t, i) => {
    if (!LOCAL_ID.test(String(t.id || ''))) return;
    const hit = byFp.get(ticketFingerprint(t));
    if (!hit) return;
    week.tickets[i] = hit;                 // the server's row wins
    Outbox.remove(t.id);                   // nothing left to send
    adopted++;
  });
  if (adopted) { week.bankroll = derivedBankroll(week); persist(); renderSyncChip(); }
  return adopted;
}

/* Collapse anything that slipped through, keeping the server's copy. */
function dedupeTickets(list) {
  const byFp = new Map();
  (list || []).forEach(t => {
    const fp = ticketFingerprint(t);
    const prev = byFp.get(fp);
    if (!prev) { byFp.set(fp, t); return; }
    /* prefer the row that lives in the database, then the graded one */
    const prevLocal = LOCAL_ID.test(String(prev.id || ''));
    const thisLocal = LOCAL_ID.test(String(t.id || ''));
    if (prevLocal && !thisLocal) byFp.set(fp, t);
    else if (prevLocal === thisLocal && prev.status === 'open' && t.status !== 'open') byFp.set(fp, t);
  });
  return [...byFp.values()];
}

/* Upload them rather than discarding them. RLS only accepts an insert with
   status 'open', which is correct — a user cannot declare their own bet a
   winner. A settled local ticket therefore uploads as open and is graded by
   the admin settling the event, which lands it in the same state. */
function migrateLocalTickets(remote) {
  const orphans = localOnlyTickets(remote);
  if (!orphans.length) return 0;
  /* Uploaded as 'open' because RLS refuses a self-declared winner; the admin
     settling the event grades it. Since v1.6.5 the projection survives
     settlement untouched, so re-opening no longer has to reconstruct
     anything — the row is valid the moment its status changes. */
  orphans.forEach(t => {
    const reopened = Object.assign({}, t, { status: 'open', returnAmount: potentialReturn(t) });
    delete reopened.settledAt;
    Outbox.add(reopened, week.key);
  });
  console.warn(`[VIG] ${orphans.length} local-only ticket(s) queued for upload`);
  return orphans.length;
}

let flushing = false;

/* Returns how many made it. Safe to call repeatedly — each success
   removes its entry, so a retry never double-inserts. */
async function flushOutbox() {
  if (flushing) return 0;
  if (!(Cloud.enabled() && Cloud.signedIn())) return 0;
  const queue = Outbox.all();
  if (!queue.length) return 0;
  flushing = true;
  let sent = 0, rejected = 0;
  try {
    for (const entry of queue) {
      try {
        const saved = await Cloud.placeBet(entry.ticket, entry.weekKey);
        /* Swap the local placeholder for the row the database returned. Match
           on fingerprint as well as id: the placeholder carries a VIG- id and
           the saved row a uuid, and if the id lookup misses, the local copy
           keeps its local id forever and reads as "never uploaded". */
        const fp = ticketFingerprint(entry.ticket);
        let i = week.tickets.findIndex(t => t.id === entry.ticket.id);
        if (i < 0) i = week.tickets.findIndex(t => ticketFingerprint(t) === fp);
        if (i >= 0) week.tickets[i] = saved;
        Outbox.remove(entry.ticket.id);
        sent++;
      } catch (e) {
        const msg = (e && e.message) || '';
        /* The database refusing a duplicate means the bet is already
           there — that is a success for our purposes, not a failure to
           retry forever. */
        if (/duplicate key|bets_no_duplicates|23505/i.test(msg)) {
          Outbox.remove(entry.ticket.id);
          continue;
        }
        /* Permanent: the row is wrong, not the connection. Set it aside with
           the reason and keep going — one bad ticket must not hold up the
           queue behind it, and it must not mark a healthy server down. */
        if (isPermanentRejection(msg)) {
          console.warn('[VIG] upload rejected permanently:', msg, entry.ticket);
          DeadLetter.add(entry, msg);
          Outbox.remove(entry.ticket.id);
          rejected++;
          continue;
        }
        Outbox.bump(entry.ticket.id);
        Cloud.reachable = false;
        break;                        // server is down; stop hammering it
      }
    }
  } finally { flushing = false; }
  if (sent) { week.bankroll = derivedBankroll(week); persist(); }
  if (rejected) renderSyncChip();
  return sent;
}

function renderSyncChip() {
  const el = document.getElementById('syncChip');
  if (!el) return;
  const n = Outbox.count();
  if (!n || !Cloud.enabled()) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `${n} bet${n === 1 ? '' : 's'} waiting to sync`;
  el.onclick = async () => {
    el.textContent = 'Syncing…';
    const sent = await flushOutbox();
    renderSyncChip();
    showToast(sent ? `${sent} bet${sent === 1 ? '' : 's'} synced.` : 'Still cannot reach the server.');
    if (sent) { renderBets(activeBetFilter()); refreshLeaderboard(); }
  };
}

function rowToTicket(r) {
  /* A malformed or unexpected row used to produce a ticket with NaN stake,
     which then poisoned derivedBankroll() and showed the user a bankroll of
     NaN. Coerce defensively: a bad row becomes a harmless zero rather than
     corrupting every downstream figure. */
  const num = (v, d) => { const n = Number(v); return isFinite(n) ? n : d; };
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    console.warn('[VIG] unexpected bet row shape', r);
    return null;
  }
  return {
    id: r.id,
    kind: r.kind,
    eventId: r.event_id,
    marketId: r.market_id,
    selectionId: r.selection_id,
    date: new Date(r.placed_at).toLocaleString(undefined,
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    placedAt: r.placed_at,
    /* the column defaults to 'open' server-side; never let a missing value
       become undefined, which would make the ticket invisible to every
       status filter and to settlement */
    status: r.status || 'open',
    stake: num(r.stake, 0),
    odds: num(r.odds, 100),
    /* rows written before v1.6.5 may carry a zeroed projection; rebuild it
       from the price rather than trusting the stored figure */
    returnAmount: (function () {
      const stored = num(r.potential_return, 0);
      if (stored > 0) return stored;
      const stake = num(r.stake, 0), odds = num(r.odds, 0);
      return (stake > 0 && validOdds(odds)) ? round2(stake * decimalOdds(odds)) : 0;
    })(),
    settledAt: r.settled_at || undefined,
    fairProb: (r.fair_prob === null || r.fair_prob === undefined) ? null : num(r.fair_prob, null),
    fairMethod: r.fair_method || null,
    bookPrices: r.book_prices || null,
    closeProb: (r.close_prob === null || r.close_prob === undefined) ? null : num(r.close_prob, null),
    legs: r.legs || [{ title: r.title, odds: Number(r.odds), gameId: null }],
    remote: true
  };
}

/* ============================================================
   THE ACCOUNTING MODEL (v1.6.5). Two different numbers that were
   previously one field:

     potentialReturn(t)  what the ticket WOULD pay. Fixed at placement
                         from stake x odds. Never changes again, for any
                         reason, in any status. Stored as `returnAmount`
                         locally and `potential_return` in Postgres.

     payout(t)           what the ticket DID pay. A pure function of
                         status — derived, never stored, so it cannot
                         drift the way a cached number can:
                           open        -> null   (undecided)
                           won         -> potential
                           lost        -> 0
                           push, void  -> stake  (refund, no profit)

   The stake leaves the bankroll at placement and only ever comes back
   through payout(). A loser therefore keeps its potential return on
   record and still pays nothing, which is how a book actually works —
   and it stops the migration path from producing rows that violate
   `potential_return > 0`.
   ============================================================ */
function potentialReturn(t) {
  const v = Number(t && t.returnAmount);
  if (isFinite(v) && v > 0) return round2(v);
  /* legacy row written before v1.6.5, when settling a loser overwrote the
     projection with zero. Recover it from the price, which never changed. */
  const stake = Number(t && t.stake), odds = Number(t && t.odds);
  if (isFinite(stake) && stake > 0 && validOdds(odds)) return round2(stake * decimalOdds(odds));
  return 0;
}

/* Mirror of the schema's own CHECK constraints, applied before we spend a
   round trip. A 400 from PostgREST is opaque to the user and, before
   v1.6.5, was swallowed and retried forever. */
function validateTicketForUpload(ticket) {
  const stake = Number(ticket && ticket.stake), odds = Number(ticket && ticket.odds);
  const pot = potentialReturn(ticket);
  if (!(stake >= 1)) throw new Error(`stake must be at least $1 (got ${ticket && ticket.stake})`);
  if (!validOdds(odds)) throw new Error(`odds out of range: ${ticket && ticket.odds} (must be <= -100 or >= +100)`);
  if (!(pot > 0)) throw new Error(`potential return must be positive (got ${pot})`);
  return pot;
}

function payout(t) {
  if (!t) return 0;
  switch (t.status) {
    case 'won':  return potentialReturn(t);
    case 'lost': return 0;
    case 'push':
    case 'void': return round2(Number(t.stake) || 0);
    default:     return null;               // still open — nothing settled
  }
}

/* What a ticket has actually returned to the bankroll so far. An open
   ticket has returned nothing; its stake is still at risk. */
function realizedReturn(t) { const p = payout(t); return p === null ? 0 : p; }

/* Repair tickets written by an older version. Idempotent. */
function repairTickets(w) {
  let fixed = 0;
  ((w && w.tickets) || []).forEach(t => {
    const p = potentialReturn(t);
    if (p > 0 && Number(t.returnAmount) !== p) { t.returnAmount = p; fixed++; }
  });
  return fixed;
}

/* Bankroll is a function of the bets, never a stored number. Works
   identically local or remote, and cannot drift out of step with the
   ticket list. */
function derivedBankroll(w) {
  const t = (w && w.tickets) || [];
  const n = v => { const x = Number(v); return isFinite(x) ? x : 0; };
  const staked = t.reduce((a, x) => a + n(x.stake), 0);
  const returned = t.reduce((a, x) => a + n(realizedReturn(x)), 0);
  const out = round2(WEEKLY_BANKROLL - staked + returned);
  /* last line of defence — a bankroll of NaN is worse than a wrong one */
  return isFinite(out) ? out : WEEKLY_BANKROLL;
}



/* ============================================================
   18. Auth UI and gating (v1.5)
   Signup is optional. Fantasy tools and Line Winder stay open to
   everyone. An account is required only where identity is genuinely
   needed: placing a bet, My Bets, and the leaderboard.
   ============================================================ */
const AUTH_GATED_VIEWS = ['bets', 'friends', 'leaderboard'];
let authPending = false;

function needsAccount() { return Cloud.enabled() && !Cloud.signedIn(); }
function needsProfile() {
  return Cloud.enabled() && Cloud.signedIn() && !Cloud.profile && !Cloud.profileUnknown;
}
/* Signed in, but the database did not answer. Almost always a paused
   free-tier project. */
function cloudUnreachable() {
  /* Two things can tell us the server is down: the profile read failing at
     boot, or any later call failing. Previously only the first was checked,
     so a failed poll left the UI claiming everything was fine. */
  return Cloud.enabled() && Cloud.signedIn()
    && (Cloud.profileUnknown || Cloud.reachable === false);
}

/* Returns true if the action may proceed. Otherwise opens the sign-in
   sheet with a reason, so the ask never feels arbitrary. */
function requireAccount(reason) {
  if (!needsAccount()) return true;
  openAuth(reason || 'This needs an account.');
  return false;
}

function openAuth(reason) {
  const gate = document.getElementById('identityGate');
  if (!gate) return;
  gate.classList.add('open');
  wireAuthClose();
  const why = document.getElementById('authReason');
  if (why) { why.textContent = reason || ''; why.hidden = !reason; }
  renderAuthGate();
  setTimeout(() => {
    const el = document.getElementById(needsProfile() ? 'identityName' : 'authEmailInput');
    if (el && el.focus) el.focus();
  }, 60);
}
function closeAuth2() {
  const gate = document.getElementById('identityGate');
  if (gate) gate.classList.remove('open');
}

function renderAuthGate() {
  const body = document.getElementById('authBody');
  if (!body) return;

  /* Cloud switched off entirely — keep the original local name prompt. */
  if (!Cloud.enabled()) {
    body.innerHTML = `
      <h2>Pick a display name</h2>
      <p>This is how you appear on the private leaderboard. Virtual funds only — no real money, deposits or prizes.</p>
      <label>Display name<input id="identityName" type="text" maxlength="24" placeholder="e.g. Antonio" autocomplete="nickname"></label>
      <label>League code <small>(optional)</small><input id="identityCode" type="text" maxlength="8" placeholder="VIG01"></label>
      <p class="identity-error" id="identityError"></p>
      <button class="full primary" id="identitySave">Start with $1,000 virtual</button>`;
    wireLocalIdentity();
    return;
  }

  /* Signed in but no profile row yet — ask for a name. */
  if (needsProfile()) {
    body.innerHTML = `
      <h2>Pick a display name</h2>
      <p>Signed in as <strong>${Cloud.email() || 'your account'}</strong>. This name is how you appear on the leaderboard.</p>
      <label>Display name<input id="identityName" type="text" maxlength="24" placeholder="e.g. Antonio" autocomplete="nickname"></label>
      <label>League code <small>(optional)</small><input id="identityCode" type="text" maxlength="8" placeholder="VIG01"></label>
      <p class="identity-error" id="identityError"></p>
      <button class="full primary" id="identitySave">Start with $1,000 virtual</button>
      <button class="auth-switch" id="authSignOut">Sign out</button>`;
    wireCloudProfile();
    return;
  }

  /* Signed in but the server did not answer — say so plainly rather than
     asking a returning user to set up an account they already have. */
  if (cloudUnreachable()) {
    body.innerHTML = `
      <h2>Can't reach the server</h2>
      <p>You are signed in, but the database did not respond. On the free plan a
         project pauses after a week without activity and needs a manual resume,
         which takes about 30 seconds.</p>
      <p class="auth-privacy">Your bets are safe. Everything on this device still
         works — new bets save locally and will not sync until the server is back.</p>
      <button class="full primary" id="authRetry">Try again</button>
      <button class="auth-switch" id="authDismiss">Keep playing offline</button>`;
    const retry = document.getElementById('authRetry');
    if (retry) retry.onclick = async () => {
      retry.disabled = true; retry.textContent = 'Checking…';
      await Cloud.loadProfile();
      if (Cloud.reachable) { closeAuth2(); renderAccountChip(); syncFromCloud(); refreshLeaderboard(); }
      else { retry.disabled = false; retry.textContent = 'Try again'; showToast('Still no response.'); }
    };
    const d = document.getElementById('authDismiss');
    if (d) d.onclick = closeAuth2;
    return;
  }

  /* Signed in with a profile — nothing to ask. */
  if (Cloud.signedIn()) { closeAuth2(); return; }

  /* Signed out. Password by default so the same account opens on any
     device; magic link kept as a no-password alternative. */
  const mode = authMode2;
  body.innerHTML = `
    <h2>${mode === 'signup' ? 'Create your account' : 'Sign in'}</h2>
    <p>Fantasy tools and Line Winder are free without an account.
       Sign in to place mock bets, keep them across devices, and join the leaderboard.</p>
    <div class="auth-tabs">
      <button class="auth-tab ${mode === 'signin' ? 'active' : ''}" data-auth-mode2="signin">Sign in</button>
      <button class="auth-tab ${mode === 'signup' ? 'active' : ''}" data-auth-mode2="signup">Create account</button>
    </div>
    <label>Email address<input id="authEmailInput" type="email" placeholder="you@example.com"
      autocomplete="email" inputmode="email"></label>
    <label>Password<input id="authPasswordInput" type="password"
      placeholder="${mode === 'signup' ? 'At least 8 characters' : 'Your password'}"
      autocomplete="${mode === 'signup' ? 'new-password' : 'current-password'}"></label>
    <p class="auth-privacy">We use your email to sign you in and save your bets.
      Nothing else. No marketing, never shared.</p>
    <p class="identity-error" id="identityError"></p>
    <button class="full primary" id="authSubmit2">${mode === 'signup' ? 'Create account' : 'Sign in'}</button>
    <button class="auth-switch" id="authMagic">Email me a sign-in link instead</button>
    ${mode === 'signin' ? '<button class="auth-switch subtle" id="authForgot">Forgot password</button>' : ''}
    <button class="auth-switch subtle" id="authDismiss">Keep looking around</button>`;
  wirePasswordAuth();
}

let authMode2 = 'signin';

function wirePasswordAuth() {
  const email = document.getElementById('authEmailInput');
  const pass = document.getElementById('authPasswordInput');
  const err = document.getElementById('identityError');
  const btn = document.getElementById('authSubmit2');

  document.querySelectorAll('[data-auth-mode2]').forEach(b => b.onclick = () => {
    authMode2 = b.dataset.authMode2;
    renderAuthGate();
  });

  const submit = async () => {
    const e = (email.value || '').trim();
    const p = pass.value || '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { err.textContent = 'Enter a valid email address.'; email.focus(); return; }
    if (authMode2 === 'signup' && p.length < 8) { err.textContent = 'Password must be at least 8 characters.'; pass.focus(); return; }
    if (!p) { err.textContent = 'Enter your password.'; pass.focus(); return; }
    err.textContent = '';
    btn.disabled = true; btn.textContent = authMode2 === 'signup' ? 'Creating…' : 'Signing in…';
    try {
      if (authMode2 === 'signup') {
        const res = await Cloud.signUpPassword(e, p);
        if (res && res.session) { onAuthChanged(); }
        else {
          document.getElementById('authBody').innerHTML = `
            <h2>Confirm your email</h2>
            <p>We sent a confirmation link to <strong>${e}</strong>. Open it and you are in.</p>
            <button class="auth-switch" id="authDismiss">Close</button>`;
          const d = document.getElementById('authDismiss'); if (d) d.onclick = closeAuth2;
        }
      } else {
        await Cloud.signInPassword(e, p);
        onAuthChanged();
      }
    } catch (ex) {
      const msg = ex && ex.message ? ex.message : 'Could not sign in.';
      if (/invalid login/i.test(msg)) {
        err.textContent = 'That email and password do not match.';
      } else if (/failed to fetch|networkerror|load failed|network request failed/i.test(msg)) {
        /* the connection died, not the credentials — find out why and say so */
        err.textContent = 'Checking the connection…';
        const d = await Cloud.diagnose();
        err.textContent = d.ok
          ? 'The server is reachable but refused the request. Email sign-in may be disabled for this project.'
          : d.message;
        console.warn('[VIG] auth diagnosis:', d);
      } else if (/email logins are disabled|signups not allowed|not enabled/i.test(msg)) {
        err.textContent = 'Email sign-in is turned off for this project. Enable it in Supabase → Authentication → Providers.';
      } else if (/rate limit|too many/i.test(msg)) {
        err.textContent = 'Too many attempts. Wait a minute and try again.';
      } else {
        err.textContent = msg;
      }
      btn.disabled = false; btn.textContent = authMode2 === 'signup' ? 'Create account' : 'Sign in';
    }
  };
  btn.onclick = submit;
  pass.onkeydown = ev => { if (ev.key === 'Enter') submit(); };
  email.onkeydown = ev => { if (ev.key === 'Enter') pass.focus(); };

  const magic = document.getElementById('authMagic');
  if (magic) magic.onclick = () => {
    document.getElementById('authBody').innerHTML = `
      <h2>Sign in without a password</h2>
      <p>We will email you a link. Open it on this device and you are straight in.</p>
      <label>Email address<input id="authEmailInput" type="email" placeholder="you@example.com"
        autocomplete="email" inputmode="email" value="${(email.value || '').trim()}"></label>
      <p class="auth-privacy">We use your email to sign you in and save your bets.
        Nothing else. No marketing, never shared.</p>
      <p class="identity-error" id="identityError"></p>
      <button class="full primary" id="authSend">Email me a sign-in link</button>
      <button class="auth-switch subtle" id="authBackToPassword">Use a password instead</button>`;
    wireMagicLink();
    const back = document.getElementById('authBackToPassword');
    if (back) back.onclick = renderAuthGate;
  };

  const forgot = document.getElementById('authForgot');
  if (forgot) forgot.onclick = async () => {
    const e = (email.value || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) { err.textContent = 'Enter your email first, then tap this.'; email.focus(); return; }
    try { await Cloud.resetPassword(e); showToast('Password reset link sent.'); }
    catch (ex) { err.textContent = ex && ex.message ? ex.message : 'Could not send the reset link.'; }
  };

  const dismiss = document.getElementById('authDismiss');
  if (dismiss) dismiss.onclick = closeAuth2;
}

function wireLocalIdentity() {
  const input = document.getElementById('identityName');
  const code = document.getElementById('identityCode');
  const err = document.getElementById('identityError');
  const submit = () => {
    const id = saveIdentity(input.value, code.value);
    if (!id) { err.textContent = 'Please enter a display name.'; input.focus(); return; }
    closeAuth2(); renderCompetition(); showToast(`Welcome, ${id.name}.`);
  };
  document.getElementById('identitySave').onclick = submit;
  input.onkeydown = e => { if (e.key === 'Enter') submit(); };
}

function wireCloudProfile() {
  const input = document.getElementById('identityName');
  const code = document.getElementById('identityCode');
  const err = document.getElementById('identityError');
  const btn = document.getElementById('identitySave');
  const submit = async () => {
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const prof = await Cloud.saveProfile(input.value, code.value);
      saveIdentity(prof.display_name, prof.league_code || '');
      closeAuth2();
      renderAccountChip();
      await syncFromCloud();
      await refreshLeaderboard();
      showToast(`Welcome, ${prof.display_name}.`);
    } catch (e) {
      err.textContent = e && e.message ? e.message : 'Could not save that name.';
      btn.disabled = false; btn.textContent = 'Start with $1,000 virtual';
    }
  };
  btn.onclick = submit;
  input.onkeydown = e => { if (e.key === 'Enter') submit(); };
  const out = document.getElementById('authSignOut');
  if (out) out.onclick = async () => { await Cloud.signOut(); onAuthChanged(); };
}

function wireMagicLink() {
  const input = document.getElementById('authEmailInput');
  const err = document.getElementById('identityError');
  const btn = document.getElementById('authSend');
  const send = async () => {
    const email = (input.value || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      err.textContent = 'Enter a valid email address.'; input.focus(); return;
    }
    err.textContent = '';
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      await Cloud.signIn(email);
      authPending = true;
      document.getElementById('authBody').innerHTML = `
        <h2>Check your email</h2>
        <p>A sign-in link is on its way to <strong>${email}</strong>.
           Open it on this device and you will be signed straight in.</p>
        <p class="auth-privacy">The link expires in an hour. No password to remember.</p>
        <button class="auth-switch" id="authDismiss">Close</button>`;
      const d = document.getElementById('authDismiss');
      if (d) d.onclick = closeAuth2;
    } catch (e) {
      err.textContent = e && e.message ? e.message : 'Could not send the link.';
      btn.disabled = false; btn.textContent = 'Email me a sign-in link';
    }
  };
  btn.onclick = send;
  input.onkeydown = e => { if (e.key === 'Enter') send(); };
  const dismiss = document.getElementById('authDismiss');
  if (dismiss) dismiss.onclick = closeAuth2;
}

/* Pull the signed-in user's week from the database so bets follow them
   across devices. */
async function syncFromCloud() {
  if (!Cloud.enabled() || !Cloud.signedIn()) return;
  try {
    /* Flush first. Pulling the remote list before sending queued bets is
       what used to make an offline bet disappear. */
    await flushOutbox();
    let remote;
    try {
      remote = await Cloud.myBets(week.key);
    } catch (e) {
      /* keep whatever is on the device — never trade real tickets for an
         empty list because one request failed */
      console.warn('[VIG] ticket read failed, keeping local:', e && e.message);
      renderBetsLive();
      return;
    }
    /* rescue anything placed offline or in local mode BEFORE the list is
       replaced, otherwise it disappears here */
    const rescued = migrateLocalTickets(remote);
    if (rescued) {
      await flushOutbox();
      remote = await Cloud.myBets(week.key);
      showToast(`${rescued} bet${rescued === 1 ? '' : 's'} from this device uploaded to your account.`);
    }
    const pending = Outbox.all().map(x => x.ticket);
    const remoteFps = new Set(remote.map(ticketFingerprint));
    week.tickets = dedupeTickets(
      remote.concat(pending.filter(t => !remoteFps.has(ticketFingerprint(t)))));
    week.bankroll = derivedBankroll(week);
    persist();
    updateDashboard();
    renderBets(activeBetFilter());
    await renderCompetition();
    renderGolfEvent();
  } catch (e) {
    console.warn('[VIG] cloud sync failed:', e && e.message);
  }
}

function startOutboxRetry() {
  if (typeof window === 'undefined') return;
  window.addEventListener('online', () => {
    Cloud.reachable = true;
    flushOutbox().then(n => { if (n) { renderBets(activeBetFilter()); refreshLeaderboard();
                                       showToast(`${n} queued bet${n === 1 ? '' : 's'} synced.`); } });
  });
  setInterval(() => {
    if (Outbox.count()) flushOutbox().then(n => { if (n) { renderBets(activeBetFilter()); refreshLeaderboard(); } });
  }, 120000);
}

function onAuthChanged() {
  safely('auth change', () => {
    if (Cloud.signedIn()) {
      Cloud.afterSignIn().then(async () => {
        await flushOutbox();
        if (needsProfile()) openAuth('One more step.');
        else { closeAuth2(); syncFromCloud(); }
        renderAccountChip();
        renderHeaderAvatar();
        renderProfileCard();
        renderAdmin();
      });
    } else {
      renderAccountChip();
      renderHeaderAvatar();
      renderProfileCard();
      renderAuthGate();
    }
  });
}

function wireAuthClose() {
  const btn = document.getElementById('authCloseBtn');
  if (btn) btn.onclick = () => {
    /* Cannot dismiss the profile step — a signed-in user without a name
       would be invisible on the leaderboard. */
    if (needsProfile()) { showToast('Please choose a display name.'); return; }
    closeAuth2();
  };
}

const AVATAR_COLORS = ['#2875CB','#4ad991','#e8bd69','#9a7cff','#ff7d8e','#55b9c9','#c9c8c8','#eb6834'];
const AVATAR_EMOJI = ['', '🏈', '⛳️', '🏀', '⚾️', '🎯', '🔥', '🧊', '👑', '🦈', '🐐', '💸'];

function avatarOf(profile, identity) {
  const p = profile || {};
  const name = p.display_name || (identity && identity.name) || 'You';
  const local = Store.get(KEYS.avatar, {}) || {};
  return {
    name,
    initials: name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || 'V',
    color: p.avatar_color || local.color || '#2875CB',
    emoji: (p.avatar_emoji !== undefined && p.avatar_emoji !== null) ? p.avatar_emoji : (local.emoji || '')
  };
}

function avatarHtml(a, cls) {
  return `<span class="avatar ${cls || ''}" style="background:${a.color}">${
    a.emoji ? `<em>${a.emoji}</em>` : a.initials}</span>`;
}

function renderProfileCard() {
  const box = document.getElementById('profileMenu');
  if (!box) return;
  /* A local display name left over from before accounts existed is NOT an
     account. Showing it while signed out made the profile read as "a
     different account" on a device that had simply never signed in. */
  const signedIn = Cloud.enabled() && Cloud.signedIn();
  const ident = (Cloud.enabled() && !signedIn) ? null : getIdentity();
  const a = avatarOf(signedIn ? Cloud.profile : null, ident);
  const s = weekStats(week);
  const lt = Store.get(KEYS.lifetime, null);

  box.innerHTML = `<div class="sheet-grip" aria-hidden="true"></div>
    <div class="profile-card">
      <button class="avatar-btn" id="avatarEdit" aria-label="Change avatar">
        ${avatarHtml(a, 'lg')}${(Cloud.enabled() && !signedIn) ? '' : '<span class="avatar-pencil">✎</span>'}
      </button>
      <div class="profile-who">
        <strong>${signedIn ? a.name : (Cloud.enabled() ? 'Not signed in' : a.name)}</strong>
        <small>${signedIn ? (Cloud.email() || 'signed in')
                          : (Cloud.enabled() ? 'Sign in to see your bets here' : 'Local play')}</small>
        ${ident && ident.code ? `<small class="profile-code">League ${ident.code}</small>` : ''}
      </div>
    </div>
    ${(Cloud.enabled() && !signedIn) ? `
      <button class="full primary profile-signin" data-profile-action="signin">Sign in or create account</button>
      <p class="profile-hint">Your bankroll, bets and leaderboard place live with your account,
        so they follow you to any device.</p>` : `
    <div class="profile-stats">
      <div><span>Bankroll</span><strong>${money(s.bankroll)}</strong></div>
      <div><span>This week</span><strong class="${s.realizedPL >= 0 ? 'positive' : 'negative'}">${s.realizedPL >= 0 ? '+' : ''}${money(s.realizedPL)}</strong></div>
      <div><span>ROI</span><strong>${s.roi === null ? '—' : `${s.roi >= 0 ? '+' : ''}${s.roi.toFixed(0)}%`}</strong></div>
      <div><span>All-time</span><strong>${lt ? `${lt.profit >= 0 ? '+' : ''}${money(lt.profit)}` : '—'}</strong></div>
    </div>`}
    <div id="avatarPicker" class="avatar-picker" hidden>
      <p class="avatar-hint">Pick a colour</p>
      <div class="swatches">${AVATAR_COLORS.map(c =>
        `<button class="swatch ${c === a.color ? 'on' : ''}" style="background:${c}" data-av-color="${c}" aria-label="colour"></button>`).join('')}</div>
      <p class="avatar-hint">Pick a badge</p>
      <div class="emojis">${AVATAR_EMOJI.map(e =>
        `<button class="emoji ${e === a.emoji ? 'on' : ''}" data-av-emoji="${e}">${e || '–'}</button>`).join('')}</div>
    </div>
    <div class="profile-divider"></div>
    <button data-profile-action="friends">Leaderboard &amp; groups</button>
    <button data-profile-action="bets">My bets</button>
    <button data-profile-action="help">Help &amp; feedback</button>
    <p class="build-stamp">Build ${VIG_BUILD}</p>
    <div class="profile-divider"></div>
    ${signedIn
      ? '<button data-profile-action="signout">Sign out</button>'
      : (Cloud.enabled() ? '<button data-profile-action="signin" class="accent">Sign in / create account</button>' : '')}`;

  const edit = document.getElementById('avatarEdit');
  const picker = document.getElementById('avatarPicker');
  if (edit) edit.onclick = () => {
    if (Cloud.enabled() && !Cloud.signedIn()) { openAuth('Sign in to customise your profile.'); return; }
    if (picker) picker.hidden = !picker.hidden;
  };

  const saveAvatar = patch => {
    const local = Object.assign({ color: a.color, emoji: a.emoji }, Store.get(KEYS.avatar, {}) || {}, patch);
    Store.set(KEYS.avatar, local);
    if (Cloud.enabled() && Cloud.signedIn() && Cloud.profile) {
      Cloud.saveProfile(Cloud.profile.display_name, Cloud.profile.league_code || '',
        { avatar_color: local.color, avatar_emoji: local.emoji })
        .catch(e => console.warn('[VIG] avatar not saved:', e && e.message));
    }
    renderProfileCard();
    renderAccountChip();
    renderHeaderAvatar();
    const open = document.getElementById('avatarPicker');
    if (open) open.hidden = false;
  };
  box.querySelectorAll('[data-av-color]').forEach(b => b.onclick = () => saveAvatar({ color: b.dataset.avColor }));
  box.querySelectorAll('[data-av-emoji]').forEach(b => b.onclick = () => saveAvatar({ emoji: b.dataset.avEmoji }));

  box.querySelectorAll('[data-profile-action]').forEach(btn => btn.addEventListener('click', () => {
    const action = btn.dataset.profileAction;
    box.classList.remove('open');
    if (action === 'friends') switchView('friends');
    else if (action === 'bets') switchView('bets');
    else if (action === 'signin') openAuth('Sign in to save your bets.');
    else if (action === 'signout') { Cloud.signOut().then(onAuthChanged); showToast('Signed out.'); }
    else showToast('Feedback tools arrive before public beta.');
  }));
}

function renderHeaderAvatar() {
  const el = document.getElementById('profileAvatar');
  if (!el) return;
  const a = avatarOf(Cloud.profile, getIdentity());
  el.style.background = a.color;
  el.textContent = a.emoji || a.initials;
}

function renderAccountChip() {
  const chip = document.getElementById('accountChip');
  const actions = document.querySelector('.account-actions');
  /* Log in / Sign up only make sense when there is an account system and you
     are not already in it. */
  if (actions) actions.hidden = !Cloud.enabled() || Cloud.signedIn();
  if (!chip) return;
  if (!Cloud.enabled()) { chip.hidden = true; return; }
  chip.hidden = false;
  if (Cloud.signedIn()) {
    const offline = cloudUnreachable();
    const local = getIdentity();
    const name = (Cloud.profile && Cloud.profile.display_name)
      || (local && local.name) || 'Account';
    const av = avatarOf(Cloud.profile, local);
    chip.innerHTML = `${avatarHtml(av, 'sm')}<span>${name}</span>${offline ? '<span class="chip-dot off"></span>' : ''}`;
    chip.onclick = offline
      ? () => openAuth('')
      : () => switchView('friends');
  } else {
    chip.innerHTML = `<span class="chip-dot"></span><span>Sign in</span>`;
    chip.onclick = () => openAuth('Sign in to save your bets.');
  }
}

/* Debug handle. Open the console and poke at VIG.Fantasy.profile(...)
   or VIG.DataSource.mode while working on this. */
window.VIG = {
               playerFace, priorRank, initialsOf, faceOf,
               RealBoard, NFL_NAMES, realMove, addButton, buildFeatured,
               refreshTickets, renderBetsLive, startBetTracking, openTickets, betLabel,
               VIG_BUILD, syncReport, renderSyncReport,
               get adminOpenCount() { return adminOpenCount; }, get selected() { return selected; }, Fantasy, Store, DataSource, weekStats, SCORING, METRIC_DEFS,
               get bootErrors() { return bootErrors; }, tzParts, weekKeyFor, nextResetAt, RESET_TZ, RESET_HOUR,
               GolfEvent, Admin, settleGolfEvent, settleAndSync, golfLeaderboardHtml, autoSettleFromEventData, pendingSettlement, golfTickets, getIdentity, saveIdentity, archiveWeek, blankWeek,
               Cloud, derivedBankroll, requireAccount,
               RealBoard, buildLineTeams, validOdds, GolfOutrights, TRENDING, DataSource,
               weekKeyFor, nextResetAt, RESET_TZ, RESET_HOUR, RESET_DOW,
               resolveDataMode, configuredDataMode, migrateDataMode, Store, KEYS,
               fallbackGames, mockGames, renderTicker, Admin, Scores,
               gradeOpenTickets, autoSettleFromScores, resultForLeg, golfEventVisible,
               SETTLE_GRACE_MS, renderGolfEvent,
               renderTrendingPicks, renderOtherSports, renderTrending, switchView,
               explainAuthFailure: () => Cloud.diagnose(),
               payout, potentialReturn, realizedReturn, repairTickets, validateTicketForUpload, settleOpenTickets, updateLifetime,
               decimalOdds, americanFromDecimal, impliedProb, round2, fmtOdds, combinedAmerican, devigPair,
               devigProportional, devigPower, fairProbability, DEVIG_METHOD, round4, needsAccount, needsProfile, openAuth,
               refreshLeaderboard, syncFromCloud, AUTH_GATED_VIEWS, cloudUnreachable,
               refreshAllTime, allTimeHtml, signedMoney, get boardScope() { return boardScope; },
               get authMode2() { return authMode2; }, set authMode2(v) { authMode2 = v; },
               Outbox, flushOutbox, renderSyncChip, migrateLocalTickets, localOnlyTickets,
               DeadLetter, isPermanentRejection, reconcileWithRemote, ticketFingerprint,
               ticketFingerprint, dedupeTickets, renderBets, activeBetFilter, WEEKLY_BET_LIMIT, WEEKLY_BANKROLL, week, renderProfileCard, avatarOf, AVATAR_COLORS, renderHeaderAvatar, renderHomeGames,
               get cloudBoard() { return cloudBoard; },
               updateLifetime, AUTO_ROLLOVER, renderGolfEvent, renderAdmin,
               ensureWeek, archiveWeek, blankWeek, potentialReturn,
               ROSTER_SLOTS, DRAFT_ROUNDS, assignSlot, ordinal, buildDraftPool,
               gradeDraft, letterFor, slotLetterFor, GRADE_SCALE, SLOT_SCALE, POSITION_LIMITS, positionWeights, DRAFT_DEPTH,
               ROUND_WEIGHTS, roundWeight, closingMessage, renderTicker, fmtGameTime,
               knownLineGames, renderRealLine,
               filteredPool, norm, ABBR_TO_NAME, mergeProjections, matchKey, teamCode, updateNavBadges,
               renderSlipBar,
               get poolRankMode() { return poolRankMode; },
               draftSummary,
               get lastResult() { return lastResult; },
               get draftState() { return draftState; }, get pool() { return players; },
               get week() { return week; }, get games() { return games; },
               get markets() { return markets; } };

/* Service worker: offline support without the staleness trap. Registration
   failure is non-fatal — the app runs fine without it, and it will not
   register at all over file:// or plain http. */
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(err => {
      console.warn('[VIG] service worker not registered:', err && err.message);
    });
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
