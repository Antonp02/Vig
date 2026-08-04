/* Boots the built preview in jsdom and hands back the debug handle.
   Committed to the repo deliberately: the suite was lost once because it
   lived only in a scratch directory. */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function boot({ version = 'v1.6.5', wait = 1500 } = {}) {
  const html = readFileSync(join(root, `VIG ${version} Preview.html`), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://antonp02.github.io/Vig/',
    pretendToBeVisual: true,
    beforeParse(w) {
      w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      w.scrollTo = () => {};
      w.fetch = () => Promise.reject(new Error('offline in tests'));
      Object.defineProperty(w.navigator, 'serviceWorker', {
        configurable: true,
        value: { register: () => Promise.resolve({ addEventListener() {} }), addEventListener() {} }
      });
    }
  });
  return new Promise(res => setTimeout(() => {
    dom.window.document.querySelectorAll('*').forEach(e => {
      if (!e.scrollIntoView) e.scrollIntoView = () => {};
    });
    res({ dom, window: dom.window, document: dom.window.document, V: dom.window.VIG });
  }, wait));
}

export function runner(title) {
  let pass = 0, fail = 0;
  console.log(`\n### ${title}`);
  return {
    section: t => console.log(`\n=== ${t} ===`),
    ok(label, cond, detail = '') {
      if (cond) { pass++; console.log(`  ok   ${label}`); }
      else { fail++; console.log(`  FAIL ${label}${detail ? `  -> ${detail}` : ''}`); }
    },
    eq(label, actual, expected) {
      this.ok(label, Object.is(actual, expected) || actual === expected, `got ${actual}, want ${expected}`);
    },
    done() {
      console.log(`\n${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    }
  };
}

/* A ticket at a known price, with the projection the book would quote. */
export function ticket(V, over) {
  const stake = over.stake ?? 100, odds = over.odds ?? 250;
  return Object.assign({
    id: `T-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'parlay', status: 'open', stake, odds,
    returnAmount: V.round2(stake * V.decimalOdds(odds)),
    legs: [{ title: 'a pick', odds }]
  }, over);
}
