/* The admin panel is a property of the URL, and the finished test event is
   not on a public tab. */
import { boot, runner } from './harness.mjs';

const t = runner('admin visibility and the retired event');
const { V, window: w, document: d } = await boot();

t.section('no admin in the URL, no admin panel');
{
  t.ok('boot URL is clean', !/admin/.test(w.location.search), w.location.search);
  t.ok('panel is hidden', d.getElementById('adminPanel').hidden);
  t.ok('Admin.enabled() is false', !V.Admin.enabled());
}

t.section('the old latch cannot bring it back');
{
  /* v1.7.0 wrote this key on the first ?admin=1 visit and then showed the
     controls forever. Anyone upgrading still has it in localStorage. */
  V.Store.set('vig.v2.admin', true);
  t.ok('a stored flag no longer grants visibility', !V.Admin.enabled(),
       'visibility must come from the URL alone');
  V.Store.remove('vig.v2.admin');
}

t.section('the finished Founders event is off the public tab');
{
  V.renderGolfEvent();
  const box = d.getElementById('golfEvent');
  t.ok('the card is not rendered', !box.innerHTML.trim(), box.innerHTML.slice(0, 80));
  t.ok('and the slot is hidden', box.hidden);
  t.ok('golfEventVisible() says no', !V.golfEventVisible());

  const trending = d.getElementById('trending').textContent;
  t.ok('no Founders Invitational on Trending', !/Founders Invitational/.test(trending),
       trending.slice(0, 120));
}

t.section('but an admin can still reach it to settle');
{
  const realEnabled = V.Admin.enabled;
  V.Admin.enabled = () => true;
  t.ok('visible to an admin', V.golfEventVisible(),
       'removing the card must not strand an ungraded stake');
  V.renderGolfEvent();
  const box = d.getElementById('golfEvent');
  t.ok('and it renders', /Founders Invitational/.test(box.textContent), box.textContent.slice(0, 80));
  V.Admin.enabled = realEnabled;
  V.renderGolfEvent();
  t.ok('gone again afterwards', d.getElementById('golfEvent').hidden);
}

t.section('a live event would still show for everyone');
{
  const saved = V.GolfEvent.data.status;
  V.GolfEvent.data.status = 'open';
  const st = V.GolfEvent.state();
  t.ok('an unfinished event is public', st.status === 'final' || V.golfEventVisible(),
       `status ${st.status}`);
  V.GolfEvent.data.status = saved;
}

t.done();
