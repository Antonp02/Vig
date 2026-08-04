/* Inlines styles.css, config.js, app.js and the JSON/TSV data into a single
   self-contained HTML file. Used for the reviewable preview and as the
   fixture the test suite boots. */
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2] || 'v1.6.5';
let html = readFileSync('index.html', 'utf8');

const inline = (tag, file) => {
  const body = readFileSync(file, 'utf8');
  html = html.replace(tag, `<script>\n${body}\n</script>`);
};

html = html.replace('<link rel="stylesheet" href="styles.css" />',
  `<style>\n${readFileSync('styles.css', 'utf8')}\n</style>`);

const data = {
  VIG_NFL_WEEK1: JSON.parse(readFileSync('data/nfl-2026-week1.json', 'utf8')),
  VIG_GOLF_EVENT: JSON.parse(readFileSync('data/golf-event.json', 'utf8'))
};
html = html.replace('<script src="config.js"></script>',
  `<script>\n${Object.entries(data).map(([k, v]) => `window.${k}=${JSON.stringify(v)};`).join('\n')}\n${readFileSync('config.js', 'utf8')}\n</script>`);

inline('<script src="app.js"></script>', 'app.js');

writeFileSync(`VIG ${version} Preview.html`, html);
console.log(`VIG ${version} Preview.html  (${(html.length / 1024).toFixed(0)} KB)`);
