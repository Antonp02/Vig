/* ============================================================
   VIG Mock Sportsbook — v0.8
   Weekly bankroll cycles, multi-book odds, probability-spaced
   Line Winder, Trending Sports board.
   ============================================================ */

/* ---------- 0. Persistence ---------- */
const KEYS = {
  week:      'vig.v2.week',
  results:   'vig.v2.results',
  snapshots: 'vig.v2.snapshots',
  drafts:    'vig.v2.drafts',
  mode:      'vig.v2.mode',
  golf:      'vig.v2.golf',
  golfStake: 'vig.v2.golfStake',
  identity:  'vig.v2.identity',
  lifetime:  'vig.v2.lifetime',
  outbox:    'vig.v2.outbox',
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
const AUTO_ROLLOVER = false;

const WEEKLY_BANKROLL = 1000;
const WEEKLY_BET_LIMIT = 25;
/* The competition week is anchored to Pacific so the label is unambiguous.
   Tuesday 02:00 PT is Tuesday 05:00 ET — after Monday Night Football ends and
   well before Thursday kickoff, so an NFL week (Thu -> Mon night) never
   straddles two competition weeks. Golf runs Thu-Sun, clear of it too. */
const RESET_TZ = 'America/Los_Angeles';
/* An NFL week runs Thursday -> Monday night. A Monday 00:00 boundary split it
   in half, dropping Monday Night Football into the following VIG week. The
   reset is Tuesday 02:00 Pacific: after MNF ends, before Thursday kickoff, and
   the same place real fantasy leagues process waivers. */
const RESET_DOW = 2;        // 0=Sun, 2=Tue
const RESET_HOUR = 2;       // 02:00 Pacific
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

/* Tuesday-of-week key, e.g. "2026-07-28". Times before 02:00 PT belong to the
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

/* Absolute instant of the next Tuesday 02:00 PT, DST-corrected. */
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
  const t = w.tickets;
  /* 'void' is neither a win nor a loss — its stake was refunded, so it must be
     excluded from P/L, hit rate and risked or it reads as a loss. */
  const graded = t.filter(x => x.status === 'won' || x.status === 'lost');
  const open = t.filter(x => x.status === 'open');
  /* push and void both return the stake untouched, so neither belongs in
     profit, hit rate or amount risked */
  const voided = t.filter(x => x.status === 'void' || x.status === 'push');
  const returned = graded.reduce((a, x) => a + (x.status === 'won' ? x.returnAmount : 0), 0);
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
  { id: 'gf-1', category: 'golf', event: 'The Open Championship', title: 'Scottie Scheffler to win',      odds: 450,  fair: 420 },
  { id: 'gf-2', category: 'golf', event: 'The Open Championship', title: 'Rory McIlroy to win',           odds: 900,  fair: 850 },
  { id: 'gf-3', category: 'golf', event: 'The Open Championship', title: 'Ben Griffin top-10 finish',     odds: 320,  fair: 360 },
  { id: 'gf-4', category: 'golf', event: 'FedEx St. Jude',        title: 'Xander Schauffele to win',      odds: 1200, fair: 1100 },
  { id: 'gf-5', category: 'golf', event: 'FedEx St. Jude',        title: 'Collin Morikawa top-5 finish',  odds: 425,  fair: 400 },
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

const DataSource = {
  mode: Store.get(KEYS.mode, 'mock'),
  /* relative so the app works both at a domain root (Vercel) and under a
     subpath (GitHub Pages at /Vig/). Pages has no serverless functions, so
     this 404s there — which the catch below already handles by falling back
     to the simulated board. */
  endpoint: 'api/odds',
  async fetchGames() {
    if (this.mode !== 'live') return mockGames();
    const res = await fetch(this.endpoint, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`odds proxy returned ${res.status}`);
    const games = normalizeOddsApi(await res.json());
    if (!games.length) throw new Error('feed returned no priced games');
    return games;
  },
  setMode(m) { this.mode = m; Store.set(KEYS.mode, m); }
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

/* ---------- 5. State ---------- */
let games = [], markets = [], selected = [], lineTeams = [];
let snapshots = Store.get(KEYS.snapshots, []);
let savedDrafts = Store.get(KEYS.drafts, []);
let weekResults = Store.get(KEYS.results, []);
let week = Store.get(KEYS.week, null);
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
    .reduce((m, t) => Math.max(m, t.returnAmount - t.stake), 0);
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
    t.status = 'void';
    t.returnAmount = t.stake;
    w.bankroll = round2(w.bankroll + t.stake);
  });
  const s = weekStats(w);
  const best = w.tickets
    .filter(t => t.status === 'won')
    .sort((a, b) => (b.returnAmount - b.stake) - (a.returnAmount - a.stake))[0];
  updateLifetime(w);
  weekResults.unshift({
    key: w.key, profit: s.realizedPL, hitRate: s.hitRate, betsUsed: s.betsUsed,
    roi: s.roi, wagered: s.wagered,
    bestTicket: best ? { legs: best.legs.length, odds: best.odds, profit: round2(best.returnAmount - best.stake) } : null
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
  if (id === 'bets') renderBets(activeBetFilter());
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
  document.getElementById('slipBarLegs').textContent = `${n} leg${n === 1 ? '' : 's'}`;
  document.getElementById('slipBarOdds').textContent = a === null ? 'add 1 more' : fmtOdds(a);
  document.getElementById('slipBarReturn').textContent =
    a === null ? '—' : `${money(stake * decimalOdds(a))} to win`;
  const place = document.getElementById('slipBarPlace');
  const st = weekStats(week);
  place.disabled = n < 2 || st.betsLeft <= 0;
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
  if (selected.length < 2) return null;
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
      <small>${m.detail} · ${m.category.toUpperCase()}</small>${shop}</div>
    <div class="pick-actions"><span class="odds">${fmtOdds(m.odds)}</span>
      <button class="add-btn" data-add="${m.id}">${selected.some(s => s.id === m.id) ? 'Added' : 'Add'}</button></div>
  </div>`;
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
    box.textContent = 'Choose at least two picks to build a parlay.';
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
  if (selected.length < 2) reason = '';
  else if (s.betsLeft <= 0) reason = `You have used all ${WEEKLY_BET_LIMIT} bets this week.`;
  else if (!(stakeVal >= 1)) reason = 'Minimum virtual stake is $1.';
  else if (stakeVal > week.bankroll) reason = `Stake exceeds your virtual bankroll of ${money(week.bankroll)}.`;

  const note = document.getElementById('slipError');
  if (note) { note.textContent = reason; note.hidden = !reason; }

  const btn = document.getElementById('placeMockBet');
  btn.disabled = selected.length < 2 || !!reason;
  btn.textContent = s.betsLeft <= 0 ? 'Weekly limit reached'
    : reason ? 'Check your stake' : 'Place mock ticket';
  updateNavBadges();
  renderSlipBar();
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
  week.tickets.unshift({
    id: `VIG-${week.key.replace(/-/g, '')}-${String(week.tickets.length + 1).padStart(2, '0')}`,
    date: new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    status: 'open', stake, odds: a,
    returnAmount: round2(stake * decimalOdds(a)),
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
    if (won) { week.bankroll = round2(week.bankroll + t.returnAmount); credited += t.returnAmount; }
    else t.returnAmount = 0;
  });
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

function renderBets(status = 'all') {
  const data = week.tickets.filter(t => status === 'all' || t.status === status);
  document.getElementById('betHistory').innerHTML = data.length ? data.map(t =>
    `<article class="bet-card">
      <div class="bet-card-head"><span class="status ${t.status}">${t.status}</span><small>${t.id} · ${t.date}</small></div>
      <h3>${t.legs.length}-leg mock parlay <span class="odds">${fmtOdds(t.odds)}</span></h3>
      <ol class="bet-legs">${t.legs.map(l => `<li>${l.title}${validOdds(l.odds) ? ` <span class="odds">${fmtOdds(l.odds)}</span>` : ''}</li>`).join('')}</ol>
      <div class="bet-card-foot">
        <div><span>Stake</span><strong>${money(t.stake)}</strong></div>
        <div><span>${t.status === 'won' ? 'Paid' : t.status === 'lost' ? 'Return' : (t.status === 'void' || t.status === 'push') ? 'Refunded' : 'To win'}</span><strong>${money(t.returnAmount)}</strong></div>
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

function renderFeatured() {
  const box = document.getElementById('featuredParlays');
  if (!box) return;
  const valid = FEATURED.map(p => {
    const legs = p.picks.map(id => markets.find(m => m.id === id)).filter(Boolean);
    const ids = legs.map(l => l.gameId);
    const clash = ids.some((g, i) => g && ids.indexOf(g) !== i);
    return { ...p, legs, clash };
  }).filter(p => p.legs.length >= 2 && !p.clash);

  box.innerHTML = valid.map((p, i) => {
    const odds = americanFromDecimal(p.legs.reduce((a, l) => a * decimalOdds(l.odds), 1));
    return `<article class="featured-parlay-card">
      <div class="featured-parlay-top"><span>${p.name}</span><strong>${fmtOdds(odds)}</strong></div>
      <ol>${p.legs.map(l => `<li>${l.title.replace(' moneyline', '')} ${fmtOdds(l.odds)}</li>`).join('')}</ol>
      <div class="featured-parlay-foot"><span>${p.legs.length} legs · ${money(p.stake)} mock stake</span>
        <button class="add-btn" data-featured="${i}">Load slip</button></div></article>`;
  }).join('') || '<div class="empty-state">No featured builds for this board.</div>';

  box.querySelectorAll('[data-featured]').forEach(b => b.onclick = () => {
    const p = valid[Number(b.dataset.featured)];
    selected = p.legs.slice();
    document.getElementById('stakeInput').value = p.stake;
    renderMarkets(activeFilter());
    renderSlip();
    showToast(`${p.name} loaded into your mock slip.`);
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
      <div class="panel-head"><div><span class="eyebrow">${label.toUpperCase()}</span><h2>${label}</h2>
        <p class="muted-copy">${blurb}</p></div><span class="updated">Simulated prices</span></div>
      ${Object.entries(byEvent).map(([ev, list]) => `
        <div class="trending-event"><h3>${ev}</h3>
        ${list.map(m => `<div class="market-row">
          <div class="market-meta"><span>${m.title.replace(` to win`, ' — outright')}</span>
            <small>Fair ${fmtOdds(TRENDING.find(t => t.id === m.id).fair)} · offered ${fmtOdds(m.odds)}</small></div>
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

function renderTrendingPicks() {
  const box = document.getElementById('trendingPicks');
  const value = markets.filter(m => m.edge > 0).sort((a, b) => b.edge - a.edge).slice(0, 2);
  const nfl = markets.filter(m => m.category === 'nfl').slice(0, 2);
  const show = [...value, ...nfl];
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
  /* real prices first, flagged, so they read differently from the simulated board */
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
          <small>${t.real ? '<b class="real-tag">real price</b>' : t.bookCount > 1 ? `best ${fmtOdds(t.best.price)} · ${t.bookCount} books · ${t.spread.toFixed(1)}% spread` : `${t.abbr} moneyline`}</small></div>
        <div><span class="ml-price">${fmtOdds(t.current)}</span>
          <span class="ml-move ${t.move < 0 ? 'positive' : 'negative'}">${t.move < 0 ? '▼' : '▲'} ${Math.abs(t.move)}</span></div>
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
        .sort((a, c) => (c.returnAmount - c.stake) - (a.returnAmount - a.stake))[0];
      return b ? { legs: b.legs.length, odds: b.odds } : null;
    })()
  };
  return [...rivalsForWeek(week.key), me].sort((a, b) => b.profit - a.profit);
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
        <p class="muted-copy">Ranked by realized profit. Everyone restarts at ${money(WEEKLY_BANKROLL)} Tuesday 2:00 AM PT.</p></div>
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
  const projCell = pr
    ? `<small class="proj-cell"><b>${pr.proj.toFixed(1)}</b> proj · ${pr.fpts.toFixed(0)} szn · ${pr.rost.toFixed(0)}%</small>`
    : '<small class="proj-cell no-metric">—</small>';
  const btn = !active ? '<span></span>'
    : blocked ? '<button class="add-btn draft-btn" disabled title="No open slot for this position">No slot</button>'
    : `<button class="add-btn draft-btn" data-draft="${p[1]}">Draft</button>`;
  const rookie = p[7] ? '<span class="need-chip rookie">2026 only</span>' : '';
  return `<div class="player-row${blocked ? ' blocked' : ''}">
    <div class="player-rank">${p[0]}</div>
    <div><strong>${p[1]}</strong><small>${p[3] || 'FA'} ${rookie} ${tag}</small></div>
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
      ${r ? `<div><strong>${r.name}</strong><small>${r.pos === 'DST' ? 'D/ST' : r.pos}${r.team ? ` · ${r.team}` : ''}</small></div>`
          : '<div class="slot-empty">—</div>'}
    </div>`;
  }).join('') + `<div class="bench-head">Bench ${bench.length}/${BENCH_SLOTS}</div>` +
    (bench.length ? bench.map(r => `<div class="roster-slot bench filled">
        <span class="slot-tag">BE</span>
        <div><strong>${r.name}</strong><small>${r.pos === 'DST' ? 'D/ST' : r.pos}${r.team ? ` · ${r.team}` : ''}</small></div>
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

function renderTicker() {
  const strip = document.getElementById('gameTicker');
  if (!strip || !Fantasy.data || !Fantasy.data.schedule) return;
  const sch = Fantasy.data.schedule;
  const feature = (sch.games || []).filter(g => g.date === sch.featureDate);
  const games = feature.length ? feature : (sch.games || []);
  const bar = strip.closest('.ticker-bar');
  if (!games.length) { if (bar) bar.hidden = true; return; }
  if (bar) bar.hidden = false;

  const label = new Date(sch.featureDate + 'T12:00:00').toLocaleDateString(undefined,
    { weekday: 'long', month: 'short', day: 'numeric' });
  const head = document.getElementById('tickerLabel');
  if (head) head.textContent = `${label} · Week ${sch.week}`;

  const item = g => `<span class="tick"><b>${g.away}</b><i>@</i><b>${g.home}</b><em>${fmtGameTime(g.time)} ET</em></span>`;
  const run = games.map(item).join('');
  strip.innerHTML = `<div class="tick-run">${run}</div><div class="tick-run" aria-hidden="true">${run}</div>`;
  strip.style.animationDuration = `${Math.max(28, games.length * 4.5)}s`;
  const count = document.getElementById('tickerCount');
  if (count) count.textContent = `${games.length} games`;
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
    games = mockGames();
    renderFeedStatus('error');
    showToast('Live odds unavailable. Showing simulated board.');
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

  const authModal = document.getElementById('authModal');
  let authMode = 'login';
  function setAuthMode(mode) {
    authMode = mode;
    const s = mode === 'signup';
    document.getElementById('authEyebrow').textContent = s ? 'JOIN THE MARKET' : 'WELCOME BACK';
    document.getElementById('authTitle').textContent = s ? 'Create your VIG account' : 'Log in to your account';
    document.getElementById('authCopy').textContent = s
      ? 'Save picks, join private groups, and build your betting record.'
      : 'Track your tickets, bankroll, groups, and Line Winder watchlists.';
    document.getElementById('authSubmit').textContent = s ? 'Create account' : 'Log in';
    document.getElementById('authSwitch').textContent = s ? 'Already have an account? Log in' : 'New to VIG? Create an account';
    document.getElementById('authPassword').setAttribute('autocomplete', s ? 'new-password' : 'current-password');
  }
  function closeAuth() {
    authModal.classList.remove('open');
    authModal.setAttribute('aria-hidden', 'true');
  }
  document.querySelectorAll('.login-trigger').forEach(b => b.addEventListener('click', () => {
    setAuthMode(b.dataset.authMode || 'login');
    authModal.classList.add('open');
    authModal.setAttribute('aria-hidden', 'false');
    setTimeout(() => document.getElementById('authEmail').focus(), 50);
  }));
  document.querySelectorAll('[data-close-auth]').forEach(b => b.addEventListener('click', closeAuth));
  document.getElementById('authSwitch').addEventListener('click', () => setAuthMode(authMode === 'login' ? 'signup' : 'login'));
  document.getElementById('authSubmit').addEventListener('click', () => {
    if (!document.getElementById('authEmail').value.trim() || !document.getElementById('authPassword').value) {
      showToast('Enter an email and password to continue.');
      return;
    }
    closeAuth();
    showToast(authMode === 'signup' ? 'Prototype account created.' : 'Prototype login successful.');
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAuth(); });

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
      renderIdentityGate();
      renderAdmin();
      if (ok && Cloud.signedIn()) { syncFromCloud(); refreshLeaderboard(); }
    });
  });
  safely('identity', renderIdentityGate);
  safely('outbox', () => { renderSyncChip(); startOutboxRetry(); });
  safely('header avatar', renderHeaderAvatar);
  safely('golf event', async () => {
    await GolfEvent.load();
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
        <strong>${a.n}</strong>
        <small>${posLabel}${a.t ? ` · ${a.t}` : ''} · ${pa.games} games · <b>${ordinal(overallA.rank)} of ${overallA.total}</b></small>
        ${sparkline(pa.weekly, colours[0])}
      </div>
      <div class="cmp-vs">vs</div>
      <div class="cmp-player align-right" style="--c:${colours[1]}">
        <strong>${b.n}</strong>
        <small>${posLabel}${b.t ? ` · ${b.t}` : ''} · ${pb.games} games · <b>${ordinal(overallB.rank)} of ${overallB.total}</b></small>
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
    const base = { status: (this.data && this.data.status) || 'open', winner: null, settledAt: null };
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

function renderGolfEvent() {
  const box = document.getElementById('golfEvent');
  if (!box) return;
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
        ? `<span class="golf-locked">${won ? 'WON' : '—'}</span>`
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

  week.tickets.unshift({
    id: `VIG-G-${Date.now().toString(36).toUpperCase()}`,
    kind: 'golf',
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
    if (push) {
      t.status = 'push';
      t.returnAmount = t.stake;                 // stake back, no profit
      paid += t.stake;
    } else if (t.selectionId === winnerId) {
      t.status = 'won';                          // stake + profit returned
      paid += t.returnAmount;
    } else {
      t.status = 'lost';                         // stake already deducted
      t.returnAmount = 0;
    }
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
  enabled() {
    try {
      if (new URLSearchParams(location.search).get('admin') === '1') {
        Store.set('vig.v2.admin', true);
      }
      return Store.get('vig.v2.admin', false) === true;
    } catch (e) { return false; }
  },
  disable() { Store.set('vig.v2.admin', false); }
};

function renderAdmin() {
  const box = document.getElementById('adminPanel');
  if (!box) return;
  if (!Admin.enabled() || !GolfEvent.data) { box.hidden = true; return; }
  box.hidden = false;
  const st = GolfEvent.state();
  const open = golfTickets().filter(t => t.status === 'open').length;
  const graded = golfTickets().filter(t => t.status !== 'open').length;
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

  if (Cloud.enabled() && Cloud.signedIn()) {
    Cloud.userCount().then(n => {
      const el = document.getElementById('adminUserCount');
      if (el) el.textContent = (n === null)
        ? 'Could not read the signup count.'
        : `${n} signed-up user${n === 1 ? '' : 's'}.`;
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
    const r = settleGolfEvent(w);
    rerender();
    if (Cloud.enabled() && Cloud.admin) {
      Cloud.settleEvent(GolfEvent.data.eventId, w)
        .then(res => { showToast(`Settled ${res.settled} bet${res.settled === 1 ? '' : 's'} for everyone.`); refreshLeaderboard(); })
        .catch(e => showToast(`Settled locally. Server: ${e && e.message ? e.message : 'failed'}`));
    } else {
      showToast(`Settled ${r.settled} bet${r.settled === 1 ? '' : 's'}, ${money(r.paid)} returned.`);
    }
  };

  document.getElementById('adminPush').onclick = () => {
    if (!confirm('Void all open golf bets as push?\n\nEvery stake is returned with no profit.')) return;
    const r = settleGolfEvent(null, { push: true });
    rerender();
    showToast(`${r.settled} bet${r.settled === 1 ? '' : 's'} pushed, ${money(r.paid)} returned.`);
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

  document.getElementById('adminUndo').onclick = () => {
    if (!confirm('Undo settlement?\n\nGolf bets return to open and the payouts are reversed.')) return;
    let reversed = 0;
    golfTickets().filter(t => t.settledAt).forEach(t => {
      if (t.status === 'won' || t.status === 'push') week.bankroll = round2(week.bankroll - t.returnAmount);
      if (t.status === 'lost') t.returnAmount = round2(t.stake * decimalOdds(t.odds));
      t.status = 'open';
      delete t.settledAt;
      reversed++;
    });
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
  async myBets(weekKey) {
    if (!this.signedIn()) return [];
    const { data, error } = await this.client
      .from('bets').select('*')
      .eq('user_id', this.userId()).eq('week_key', weekKey)
      .order('placed_at', { ascending: false });
    if (error) { console.warn('[VIG] bets read failed:', error.message); return []; }
    return (data || []).map(rowToTicket);
  },

  async placeBet(ticket, weekKey) {
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
      potential_return: ticket.returnAmount,
      legs: ticket.legs || null
    };
    const { data, error } = await this.client.from('bets').insert(row).select().single();
    if (error) throw error;
    return rowToTicket(data);
  },

  /* Admin only — RLS rejects this for everyone else, which is the
     whole point. Ordinary users have no UPDATE policy on bets. */
  async settleEvent(eventId, winnerSelectionId, { push = false } = {}) {
    if (!this.admin) throw new Error('Admin only');
    const { data: open, error: readErr } = await this.client
      .from('bets').select('*').eq('event_id', eventId).eq('status', 'open');
    if (readErr) throw readErr;
    if (!open || !open.length) return { settled: 0 };
    const now = new Date().toISOString();
    let settled = 0;
    for (const b of open) {
      const status = push ? 'push' : (b.selection_id === winnerSelectionId ? 'won' : 'lost');
      const { error } = await this.client.from('bets')
        .update({ status, settled_at: now }).eq('id', b.id).eq('status', 'open');
      if (!error) settled++;
    }
    await this.client.from('events').update({
      status: 'final', winner_selection_id: push ? null : winnerSelectionId, updated_at: now
    }).eq('event_id', eventId);
    return { settled };
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
    if (q.some(x => x.ticket.id === ticket.id)) return;
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

let flushing = false;

/* Returns how many made it. Safe to call repeatedly — each success
   removes its entry, so a retry never double-inserts. */
async function flushOutbox() {
  if (flushing) return 0;
  if (!(Cloud.enabled() && Cloud.signedIn())) return 0;
  const queue = Outbox.all();
  if (!queue.length) return 0;
  flushing = true;
  let sent = 0;
  try {
    for (const entry of queue) {
      try {
        const saved = await Cloud.placeBet(entry.ticket, entry.weekKey);
        /* swap the local placeholder for the row the database returned */
        const i = week.tickets.findIndex(t => t.id === entry.ticket.id);
        if (i >= 0) week.tickets[i] = saved;
        Outbox.remove(entry.ticket.id);
        sent++;
      } catch (e) {
        Outbox.bump(entry.ticket.id);
        Cloud.reachable = false;
        break;                        // server is down; stop hammering it
      }
    }
  } finally { flushing = false; }
  if (sent) { week.bankroll = derivedBankroll(week); persist(); }
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
  return {
    id: r.id,
    kind: r.kind,
    eventId: r.event_id,
    marketId: r.market_id,
    selectionId: r.selection_id,
    date: new Date(r.placed_at).toLocaleString(undefined,
      { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    placedAt: r.placed_at,
    status: r.status,
    stake: Number(r.stake),
    odds: Number(r.odds),
    returnAmount: Number(r.potential_return),
    settledAt: r.settled_at || undefined,
    legs: r.legs || [{ title: r.title, odds: Number(r.odds), gameId: null }],
    remote: true
  };
}

/* Bankroll is a function of the bets, never a stored number. Works
   identically local or remote, and cannot drift out of step with the
   ticket list. */
function derivedBankroll(w) {
  const t = (w && w.tickets) || [];
  const staked = t.reduce((a, x) => a + x.stake, 0);
  const returned = t.reduce((a, x) =>
    a + (x.status === 'won' ? x.returnAmount
       : (x.status === 'push' || x.status === 'void') ? x.stake : 0), 0);
  return round2(WEEKLY_BANKROLL - staked + returned);
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
function cloudUnreachable() { return Cloud.enabled() && Cloud.signedIn() && Cloud.profileUnknown; }

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
      err.textContent = /invalid login/i.test(msg)
        ? 'That email and password do not match.' : msg;
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
    if (cloudUnreachable()) return;      // keep whatever is on the device
    /* Flush first. Pulling the remote list before sending queued bets is
       what used to make an offline bet disappear. */
    await flushOutbox();
    const remote = await Cloud.myBets(week.key);
    const pending = Outbox.all().map(x => x.ticket);
    const remoteIds = new Set(remote.map(t => t.id));
    week.tickets = remote.concat(pending.filter(t => !remoteIds.has(t.id)));
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
        renderAdmin();
      });
    } else {
      renderAccountChip();
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
  const ident = getIdentity();
  const a = avatarOf(Cloud.profile, ident);
  const s = weekStats(week);
  const lt = Store.get(KEYS.lifetime, null);
  const signedIn = Cloud.enabled() && Cloud.signedIn();

  box.innerHTML = `<div class="sheet-grip" aria-hidden="true"></div>
    <div class="profile-card">
      <button class="avatar-btn" id="avatarEdit" aria-label="Change avatar">
        ${avatarHtml(a, 'lg')}<span class="avatar-pencil">✎</span>
      </button>
      <div class="profile-who">
        <strong>${a.name}</strong>
        <small>${signedIn ? (Cloud.email() || 'signed in')
                          : (Cloud.enabled() ? 'Not signed in' : 'Local play')}</small>
        ${ident && ident.code ? `<small class="profile-code">League ${ident.code}</small>` : ''}
      </div>
    </div>
    <div class="profile-stats">
      <div><span>Bankroll</span><strong>${money(s.bankroll)}</strong></div>
      <div><span>This week</span><strong class="${s.realizedPL >= 0 ? 'positive' : 'negative'}">${s.realizedPL >= 0 ? '+' : ''}${money(s.realizedPL)}</strong></div>
      <div><span>ROI</span><strong>${s.roi === null ? '—' : `${s.roi >= 0 ? '+' : ''}${s.roi.toFixed(0)}%`}</strong></div>
      <div><span>All-time</span><strong>${lt ? `${lt.profit >= 0 ? '+' : ''}${money(lt.profit)}` : '—'}</strong></div>
    </div>
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
    <div class="profile-divider"></div>
    ${signedIn
      ? '<button data-profile-action="signout">Sign out</button>'
      : (Cloud.enabled() ? '<button data-profile-action="signin" class="accent">Sign in / create account</button>' : '')}`;

  const edit = document.getElementById('avatarEdit');
  const picker = document.getElementById('avatarPicker');
  if (edit) edit.onclick = () => { picker.hidden = !picker.hidden; };

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
window.VIG = { Fantasy, Store, DataSource, weekStats, SCORING, METRIC_DEFS,
               get bootErrors() { return bootErrors; }, tzParts, weekKeyFor, nextResetAt, RESET_TZ, RESET_HOUR,
               GolfEvent, Admin, settleGolfEvent, golfTickets, getIdentity, saveIdentity, archiveWeek, blankWeek,
               Cloud, derivedBankroll, requireAccount,
               decimalOdds, americanFromDecimal, impliedProb, round2, fmtOdds, combinedAmerican, devigPair, needsAccount, needsProfile, openAuth,
               refreshLeaderboard, syncFromCloud, AUTH_GATED_VIEWS, cloudUnreachable,
               get authMode2() { return authMode2; }, set authMode2(v) { authMode2 = v; },
               Outbox, flushOutbox, renderSyncChip, WEEKLY_BET_LIMIT, WEEKLY_BANKROLL, week, renderProfileCard, avatarOf, AVATAR_COLORS, renderHeaderAvatar,
               get cloudBoard() { return cloudBoard; },
               updateLifetime, AUTO_ROLLOVER, renderGolfEvent, renderAdmin,
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
