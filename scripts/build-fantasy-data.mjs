#!/usr/bin/env node
/* Builds the VIG fantasy dataset from three nflverse releases.
   Run: node scripts/build-fantasy-data.mjs [season]
   Out: data/fantasy-<season>.json   (players + defenses + kickers)

   nflverse pre-scores offensive fantasy points but NOT kickers or team
   defenses, so both are computed here from raw components using the
   league's ESPN-default scoring below. Every value is a config knob —
   change it here and the whole app follows.

   Data: nflverse (CC-BY 4.0). Attribution required in the UI. */

const SEASON = process.argv[2] || '2025';
const BASE = 'https://github.com/nflverse/nflverse-data/releases/download';
const SRC = {
  players: `${BASE}/stats_player/stats_player_week_${SEASON}.csv`,
  teams:   `${BASE}/stats_team/stats_team_week_${SEASON}.csv`,
  games:   `${BASE}/schedules/games.csv`
};

const OFFENSE = new Set(['QB', 'RB', 'WR', 'TE']);
const MIN_GAMES = 4;

/* ---- League scoring (ESPN defaults, confirmed) ---- */
const K_SCORING = {
  fgBands: [[39, 3], [49, 4], [59, 5], [Infinity, 5]],   // [maxYards, points]
  pat: 1,
  missedFg: 0            // set to -1 if the league penalises misses
};

const DST_SCORING = {
  sack: 1, interception: 2, fumbleRecovery: 2,
  touchdown: 6, safety: 2, blockedKick: 2,
  pointsAllowed: [[0, 5], [6, 4], [13, 3], [17, 1], [27, 0], [34, -1], [45, -3], [Infinity, -5]]
};

/* ---- CSV ---- */
function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift();
  return rows.filter(r => r.length === head.length)
             .map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const int = v => Math.round(num(v));
const r1 = n => Math.round(n * 10) / 10;
const r3 = n => Math.round(n * 1000) / 1000;
const band = (tiers, v) => (tiers.find(([max]) => v <= max) || tiers[tiers.length - 1])[1];
/* normalised search key — mirrors Sleeper's search_full_name approach so
   Ja'Marr, Amon-Ra and D.J. all behave */
const searchKey = s => s.toLowerCase().normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return parseCsv(await res.text());
}

console.log(`building ${SEASON}…`);
const [pRows, tRows, gRows] = await Promise.all([get(SRC.players), get(SRC.teams), get(SRC.games)]);
console.log(`  players ${pRows.length} rows | teams ${tRows.length} | games ${gRows.length}`);

/* ---- 1. Offence: nflverse already scores these ---- */
const offMap = new Map();
for (const r of pRows) {
  if (r.season_type && r.season_type !== 'REG') continue;
  if (!OFFENSE.has(r.position)) continue;
  const id = r.player_id;
  if (!offMap.has(id)) offMap.set(id, {
    id, n: r.player_display_name, sn: searchKey(r.player_display_name),
    p: r.position, t: r.team || '', wk: [], s: [], r: [], ts: []
  });
  const p = offMap.get(id);
  p.t = r.team || p.t;
  p.wk.push(int(r.week));
  p.s.push(r1(num(r.fantasy_points)));       // standard; PPR = s + r
  p.r.push(int(r.receptions));
  p.ts.push(r3(num(r.target_share)));
}

/* ---- 2. Kickers: nflverse leaves fantasy_points at 0, so compute ---- */
const kMap = new Map();
for (const r of pRows) {
  if (r.season_type && r.season_type !== 'REG') continue;
  if (r.position !== 'K') continue;
  const made = [['fg_made_0_19', 19], ['fg_made_20_29', 29], ['fg_made_30_39', 39],
                ['fg_made_40_49', 49], ['fg_made_50_59', 59], ['fg_made_60_', 99]];
  let pts = int(r.pat_made) * K_SCORING.pat;
  for (const [col, yd] of made) pts += int(r[col]) * band(K_SCORING.fgBands, yd);
  const missed = ['fg_missed_0_19','fg_missed_20_29','fg_missed_30_39',
                  'fg_missed_40_49','fg_missed_50_59','fg_missed_60_']
                  .reduce((a, c) => a + int(r[c]), 0);
  pts += missed * K_SCORING.missedFg;

  const id = r.player_id;
  if (!kMap.has(id)) kMap.set(id, {
    id, n: r.player_display_name, sn: searchKey(r.player_display_name),
    p: 'K', t: r.team || '', wk: [], s: [], r: [], ts: []
  });
  const k = kMap.get(id);
  k.t = r.team || k.t;
  k.wk.push(int(r.week));
  k.s.push(r1(pts));
  k.r.push(0);
  k.ts.push(0);
}

/* ---- 3. Team defence ------------------------------------------------
   Two of the seven categories come from the OPPONENT's row, not the
   team's own: a team-stats row records kicks *that team* had blocked,
   and points allowed is the opponent's score. Getting the direction
   wrong yields plausible-looking but wrong numbers.
--------------------------------------------------------------------- */
const scoreFor = new Map();          // season|week|team -> points scored
for (const g of gRows) {
  if (g.season !== SEASON || g.game_type !== 'REG') continue;
  if (g.home_score === '' || g.away_score === '') continue;
  scoreFor.set(`${g.week}|${g.home_team}`, num(g.home_score));
  scoreFor.set(`${g.week}|${g.away_team}`, num(g.away_score));
}

const teamRow = new Map();           // week|team -> row
for (const r of tRows) {
  if (r.season_type && r.season_type !== 'REG') continue;
  teamRow.set(`${r.week}|${r.team}`, r);
}

const dMap = new Map();
for (const r of tRows) {
  if (r.season_type && r.season_type !== 'REG') continue;
  const wk = r.week, team = r.team, opp = r.opponent_team;
  const oppRow = teamRow.get(`${wk}|${opp}`);
  const pa = scoreFor.get(`${wk}|${opp}`);
  if (pa === undefined) continue;                  // game not final

  const blocks = oppRow                            // kicks THEY had blocked
    ? int(oppRow.fg_blocked) + int(oppRow.pat_blocked) + int(oppRow.pt_blocked) : 0;

  const pts =
      int(r.def_sacks)            * DST_SCORING.sack
    + int(r.def_interceptions)    * DST_SCORING.interception
    + int(r.fumble_recovery_opp)  * DST_SCORING.fumbleRecovery
    + int(r.def_tds)              * DST_SCORING.touchdown
    + int(r.def_safeties)         * DST_SCORING.safety
    + blocks                      * DST_SCORING.blockedKick
    + band(DST_SCORING.pointsAllowed, pa);

  const id = `DST-${team}`;
  if (!dMap.has(id)) dMap.set(id, {
    id, n: `${team} D/ST`, sn: searchKey(`${team} DST defense`),
    p: 'DST', t: team, wk: [], s: [], r: [], ts: []
  });
  const d = dMap.get(id);
  d.wk.push(int(wk));
  d.s.push(r1(pts));
  d.r.push(0);
  d.ts.push(0);
}

/* ---- 4. Upcoming schedule for the games ticker ----------------------
   Real 2026 kickoffs straight from nflverse schedules. Times are ET as
   published. Featured date is Week 1 Sunday. ------------------------ */
const SCHEDULE_SEASON = process.env.VIG_SCHEDULE_SEASON || '2026';
const FEATURE_DATE = process.env.VIG_FEATURE_DATE || '2026-09-13';
const sched = gRows
  .filter(g => g.season === SCHEDULE_SEASON && g.game_type === 'REG' && g.week === '1')
  .map(g => ({
    wd: (g.weekday || '').slice(0, 3),
    date: g.gameday,
    time: g.gametime,
    away: g.away_team,
    home: g.home_team,
    venue: g.stadium || ''
  }))
  .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

/* ---- 5. ESPN 2026 projections (optional, tab-separated) -------------
   data/espn-projections-2026.tsv — paste more rows from ESPN's
   "Add and Research Players" table any time; no code change needed.
   Columns: name  team  pos  opp  proj  st  rost  fpts  avg
   ESPN also carries 2026 team changes, which the 2025 actuals cannot.
------------------------------------------------------------------- */
const { readFileSync, existsSync } = await import('node:fs');
const PROJ_PATH = 'data/espn-projections-2026.tsv';
let projections = [];
if (existsSync(PROJ_PATH)) {
  const lines = readFileSync(PROJ_PATH, 'utf8').split('\n').filter(l => l.trim());
  const head = lines.shift().split('\t').map(h => h.trim());
  const idx = k => head.indexOf(k);
  projections = lines.map(l => {
    const c = l.split('\t');
    const name = (c[idx('name')] || '').trim();
    if (!name) return null;
    const fpts = num(c[idx('fpts')]), avg = num(c[idx('avg')]);
    return {
      n: name, sn: searchKey(name),
      t: (c[idx('team')] || '').trim(),
      p: (c[idx('pos')] || '').trim().toUpperCase(),
      opp: (c[idx('opp')] || '').trim(),
      proj: r1(num(c[idx('proj')])),
      st: r1(num(c[idx('st')])),
      rost: r1(num(c[idx('rost')])),
      fpts: r1(fpts),
      avg: r1(avg),
      /* AVG = FPTS / projected games, so this recovers the games estimate.
         Most are 17; a player expected to miss time shows fewer. */
      gp: avg > 0 ? Math.round(fpts / avg) : 17
    };
  }).filter(Boolean);
  projections.sort((a, b) => b.fpts - a.fpts);
}

/* ---- 6. Known real betting lines (optional, tab-separated) ----------
   data/known-lines-2026.tsv — real prices for games we actually have
   numbers for. Line Winder marks these as real rather than simulated.
------------------------------------------------------------------- */
const LINES_PATH = 'data/known-lines-2026.tsv';
let knownLines = [];
if (existsSync(LINES_PATH)) {
  const rows = readFileSync(LINES_PATH, 'utf8').split('\n').filter(l => l.trim());
  const head = rows.shift().split('\t').map(h => h.trim());
  const ix = k => head.indexOf(k);
  knownLines = rows.map(l => {
    const c = l.split('\t');
    const g = k => (c[ix(k)] || '').trim();
    if (!g('home') || !g('away')) return null;
    return {
      date: g('date'), away: g('away'), home: g('home'),
      spreadHome: num(g('spread_home')), total: num(g('total')),
      mlAway: num(g('ml_away')),
      mlHomeOpen: num(g('ml_home_open')), mlHomeNow: num(g('ml_home_now')),
      openNote: g('open_note'), nowNote: g('now_note')
    };
  }).filter(Boolean);
}

/* ---- 6. Headshots + prior-season finish ----------------------------
   nflverse carries an official NFL CDN headshot on every weekly row, so
   photos cost nothing: one URL per player, no images in the bundle, no
   hotlinking to a third party's site. D/ST have none — they are not
   people — and fall back to a team badge in the UI.

   Prior-season rank is the positional finish by total PPR points across
   the season being built. "RB4 last year" is the single most useful
   thing you can put next to a name on a draft board.
------------------------------------------------------------------- */
const headshots = new Map();
pRows.forEach(r => {
  const name = (r.player_display_name || r.player_name || '').trim();
  const url = (r.headshot_url || '').trim();
  if (name && url && !headshots.has(name)) headshots.set(name, url);
});

/* ---- 7. Elite Week 1 projections -----------------------------------
   ESPN's "Add and Research Players" list is sorted by rostered percentage,
   so it never shows the top ~20 players — they are rostered everywhere and
   therefore never "available". Gibbs, Nacua, Hurts, Chase, McCaffrey,
   Barkley, Burrow and Jefferson had NO projection at all, which is why the
   2026 outlook board looked quarterback-heavy. These come from the league
   player list instead and take precedence where they overlap.
------------------------------------------------------------------- */
const ELITE_PATH = 'data/espn-week1-elite.tsv';
let elite = [];
if (existsSync(ELITE_PATH)) {
  const lines = readFileSync(ELITE_PATH, 'utf8').split('\n').filter(l => l.trim());
  const head = lines.shift().split('\t').map(h => h.trim());
  const at = k => head.indexOf(k);
  elite = lines.map(l => {
    const c = l.split('\t');
    const name = (c[at('name')] || '').trim();
    if (!name) return null;
    return {
      n: name, sn: searchKey(name),
      t: (c[at('team')] || '').trim(),
      p: (c[at('pos')] || '').trim().toUpperCase(),
      opp: (c[at('opp')] || '').trim(),
      proj: r1(num(c[at('proj')])),
      status: (c[at('status')] || '').trim() || null,
      elite: true
    };
  }).filter(Boolean);
}

const keep = m => [...m.values()].filter(p => p.s.length >= MIN_GAMES);
const total = p => p.s.reduce((a, v, i) => a + v + p.r[i], 0);
const sortByTotal = a => a.sort((x, y) => total(y) - total(x));

/* headshot + prior finish onto every player before writing */
function decorate(list) {
  /* positional finish by total PPR points, computed within this list */
  const byPos = {};
  list.forEach(p => (byPos[p.p] = byPos[p.p] || []).push(p));
  Object.values(byPos).forEach(group => {
    group
      .map(p => ({ p, tot: p.s.reduce((a, v, i) => a + v + (p.r[i] || 0), 0) }))
      .sort((a, b) => b.tot - a.tot)
      .forEach((x, i) => {
        x.p.pr = i + 1;                       // prior-season positional rank
        x.p.pt = r1(x.tot);                   // prior-season total points
      });
  });
  list.forEach(p => {
    const url = headshots.get(p.n);
    if (url) p.img = url;
  });
  return list;
}

const out = {
  season: SEASON, source: 'nflverse', license: 'CC-BY 4.0',
  built: new Date().toISOString().slice(0, 10), minGames: MIN_GAMES,
  scoring: { K_SCORING, DST_SCORING },
  schedule: { season: SCHEDULE_SEASON, week: 1, featureDate: FEATURE_DATE, games: sched },
  projections: (() => {
    const byName = {};
    projections.forEach(r => (byName[r.n] = r));
    elite.forEach(e => {
      const hit = byName[e.n];
      if (hit) {
        hit.proj = e.proj;                    // fresher weekly number
        /* keep the existing season fpts/avg — they came from the same
           source and are a full-season view rather than one week */
        hit.opp = e.opp || hit.opp;
        if (e.status) hit.status = e.status;
        hit.elite = true;
      } else {
        /* Top-20 players the availability list never carried. They arrive
           with a WEEKLY projection only, but the draft board ranks on
           season points per game — so leaving fpts at 0 sent every elite
           player to the bottom of the board. ESPN's PROJ is a next-game
           estimate, which is the same quantity as a per-game average, so
           derive the season figures from it and flag them as derived. */
        byName[e.n] = Object.assign({
          fpts: r1(e.proj * 17), avg: e.proj, gp: 17,
          rost: 100, st: 0, derived: true
        }, e);
      }
    });
    const rows = Object.values(byName).sort((a, b) => (b.proj || 0) - (a.proj || 0));
    return { season: '2026', source: 'ESPN (manual)', elite: elite.length, rows };
  })(),
  knownLines,
  players: decorate(sortByTotal(keep(offMap))),
  kickers: decorate(sortByTotal(keep(kMap))),
  defenses: decorate(sortByTotal(keep(dMap))),
};

const { writeFileSync, mkdirSync } = await import('node:fs');
mkdirSync('data', { recursive: true });
const path = `data/fantasy-${SEASON}.json`;
writeFileSync(path, JSON.stringify(out));

const byPos = {};
out.players.forEach(p => byPos[p.p] = (byPos[p.p] || 0) + 1);
console.log(`  offence: ${Object.entries(byPos).map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log(`  kickers: ${out.kickers.length} | defenses: ${out.defenses.length}`);
console.log(`wrote ${path} — ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
console.log(`  elite week-1 projections: ${elite.length}`);
console.log(`  headshots: ${headshots.size} available`);
console.log(`  projections: ${projections.length} players from ESPN 2026`);
console.log(`  known real lines: ${knownLines.length}`);
console.log(`  schedule: ${sched.length} games (${sched.filter(g=>g.date===FEATURE_DATE).length} on ${FEATURE_DATE})`);
console.log(`\ntop 5 D/ST by total: ${out.defenses.slice(0,5).map(d=>d.t+' '+total(d).toFixed(0)).join(', ')}`);
console.log(`top 5 K by total:    ${out.kickers.slice(0,5).map(k=>k.n.split(' ').pop()+' '+total(k).toFixed(0)).join(', ')}`);
