/* Run every suite. `node tests/run.mjs` */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const suites = readdirSync(here)
  .filter(f => f.endsWith('.mjs') && !['run.mjs', 'harness.mjs'].includes(f));

let total = 0, failed = 0;
for (const s of suites) {
  const r = spawnSync('node', [join(here, s)], { encoding: 'utf8', timeout: 300000 });
  const last = (r.stdout || '').trim().split('\n').pop() || '';
  const m = last.match(/(\d+) passed, (\d+) failed/);
  if (!m) { console.log(`${s.padEnd(18)} CRASHED`); failed++; continue; }
  total += Number(m[1]);
  if (Number(m[2])) { failed += Number(m[2]); console.log(`${s.padEnd(18)} ${m[2]} FAILED`); }
  else console.log(`${s.padEnd(18)} ${m[1]} ok`);
}
console.log(`\n${total} assertions${failed ? `, ${failed} FAILING` : ', all green'}`);
process.exit(failed ? 1 : 0);
