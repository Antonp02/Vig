/* The home page leads with football, and no price ever claims to be live
   when it isn't. */
import { boot, runner } from './harness.mjs';

const t = runner('home board and feed provenance');
const { V, document: d } = await boot();
await V.RealBoard.load();
await V.GolfOutrights.load();
V.GolfOutrights.install();
V.renderTrendingPicks();
V.renderOtherSports();

t.section('Popular mock picks is football');
{
  const rows = [...d.querySelectorAll('#trendingPicks .pick-row')];
  t.ok('four picks', rows.length === 4, String(rows.length));
  const text = rows.map(r => r.textContent).join(' | ');
  t.ok('no tennis outright', !/Alcaraz|Sinner|Gauff|US Open|Masters/i.test(text), text.slice(0, 140));
  t.ok('no fantasy prop', !/fantasy matchup|fantasy pts/i.test(text), text.slice(0, 140));
  t.ok('every pick is an NFL moneyline', /moneyline/i.test(text) && rows.every(r => /moneyline/i.test(r.textContent)),
       text.slice(0, 160));
  t.ok('and they are real board teams',
       /Raiders|Texans|49ers|Chargers|Jets|Steelers|Panthers|Jaguars|Packers|Broncos|Commanders|Lions|Bills|Browns|Ravens|Vikings|Falcons|Colts|Giants|Dolphins/.test(text),
       text.slice(0, 160));
}

t.section('picks lead with the soonest kickoff');
{
  const first = d.querySelector('#trendingPicks .pick-row');
  t.ok('Thursday night game is first', /Raiders|Texans/.test(first.textContent),
       first.textContent.replace(/\s+/g, ' ').slice(0, 90));
}

t.section('Other sports shows the real outright board');
{
  const box = d.querySelector('#otherSports');
  const text = box ? box.textContent : '';
  t.ok('no stale Open Championship prices', !/\+450|\+900|\+8000/.test(text), text.slice(0, 120));
  t.ok('shows the current field', /Scottie Scheffler/.test(text), text.slice(0, 120));
  t.ok('at the current price', /\+300/.test(text), text.slice(0, 120));
  t.ok('no invented movement arrows', !/[▲▼]/.test(text), text.slice(0, 120));
  const head = d.querySelector('#otherSportsEvent');
  t.ok('names the event', head && /BMW/.test(head.textContent), head ? head.textContent : 'missing');
}

t.section('the snapshot is labelled exactly as specified');
{
  const st = V.GolfOutrights.statusLine();
  t.eq('tone is snapshot, not live', st.tone, 'snapshot');
  t.eq('the book is named', st.label, 'FanDuel snapshot');
  t.eq('with the stated timestamp', st.text, 'Updated Aug. 19, 2026 at 11:42 p.m. ET');
  t.eq('the market is titled in full', V.GolfOutrights.marketLabel(), 'BMW Championship — Winner');

  const mini = d.querySelector('#otherSports .feed-note-mini');
  t.ok('the home card names the book', mini && /FanDuel snapshot/.test(mini.textContent),
       mini ? mini.textContent : 'missing');
  t.ok('and carries the timestamp', mini && /Aug\. 19, 2026 at 11:42 p\.m\. ET/.test(mini.textContent),
       mini ? mini.textContent : 'missing');
}

t.section('nothing anywhere calls the snapshot live');
{
  /* The whole point. If the word "live" ever attaches to these prices this
     fails, whatever else changed. */
  V.switchView('trending');
  V.renderTrending();
  V.renderOtherSports();
  const golfPanels = [...d.querySelectorAll('.trending-panel')]
    .filter(p => /BMW Championship/.test(p.textContent));
  t.ok('the golf panel rendered', golfPanels.length === 1,
       `${golfPanels.length}; boards=${(d.querySelectorAll('.trending-panel')||[]).length}`);
  const text = golfPanels[0].textContent + ' ' + d.querySelector('#otherSports').textContent;
  t.ok('no "live" claim', !/\blive\b/i.test(text), text.replace(/\s+/g, ' ').slice(0, 180));
  t.ok('no "live feed" badge', !d.querySelector('.feed-live'));
  t.ok('the snapshot badge is present', !!d.querySelector('.feed-snapshot'));
  t.eq('the panel title is the full market name',
       golfPanels[0].querySelector('h2').textContent, 'BMW Championship — Winner');
}

t.section('a supported feed can replace the snapshot without code changes');
{
  const saved = JSON.parse(JSON.stringify(V.GolfOutrights.data.provenance));
  V.GolfOutrights.data.provenance = {
    kind: 'feed', label: 'Live feed', displayUpdated: 'Updated just now', isLive: true
  };
  const st = V.GolfOutrights.statusLine();
  t.eq('flipping isLive is all it takes', st.tone, 'live');
  t.eq('and the label follows the data', st.label, 'Live feed');
  V.GolfOutrights.data.provenance = saved;
  t.eq('restored to snapshot', V.GolfOutrights.statusLine().tone, 'snapshot');
}

t.section('the reset line agrees with the code');
{
  const html = d.documentElement.outerHTML;
  t.ok('no stale 2:00 AM PT copy', !/2:00 AM PT/.test(html));
  t.ok('says Tuesday 4:00 AM ET', /4:00 AM ET/.test(html));
}

t.done();
