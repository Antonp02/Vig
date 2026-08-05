/* VIG service worker
   ---------------------------------------------------------------
   Strategy is deliberately NOT cache-first for code.

   A cache-first shell pins every installed user to whatever build they
   first loaded, and only releases them when CACHE_NAME is bumped. Forget
   that once during a deploy and your friends are stuck on an old version
   with no way for you to push a fix. Worse, precaching index.html but not
   app.js serves old markup against new code — which is exactly the
   mismatch the boot-error banner exists to catch.

   So:
     documents, JS, CSS   -> network first, cache as a fallback
     icons, manifest, data-> cache first, refreshed in the background
     /api/*               -> never cached, it is live odds
--------------------------------------------------------------- */
const VERSION = 'v1.6.7';
const SHELL = `vig-shell-${VERSION}`;
const ASSETS = `vig-assets-${VERSION}`;

/* Enough to boot offline. Everything else fills in as it is used. */
const PRECACHE = [
  './', './index.html', './app.js', './styles.css', './config.js',
  './manifest.webmanifest',
  './data/fantasy-2025.json', './data/golf-event.json', './data/nfl-2026-week1.json',
  './icons/icon-192.png', './icons/icon-512.png',
  './icons/apple-touch-icon.png', './icons/favicon-32.png',
  './assets/vig-lockup.png', './assets/vig-mark.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL)
      /* individual puts so one 404 cannot fail the whole install */
      .then(cache => Promise.allSettled(PRECACHE.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL && k !== ASSETS).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

const isAsset = url =>
  /\/(icons)\//.test(url.pathname) ||
  /\.(png|svg|ico|webmanifest)$/.test(url.pathname) ||
  /\/data\/.*\.json$/.test(url.pathname);

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // let third parties through
  if (url.pathname.startsWith('/api/')) return;      // live odds, never cached

  if (isAsset(url)) {
    /* cache first, but quietly refresh so a new build lands next visit */
    event.respondWith(
      caches.open(ASSETS).then(cache =>
        cache.match(req).then(hit => {
          const net = fetch(req).then(res => {
            if (res && res.ok) cache.put(req, res.clone());
            return res;
          }).catch(() => hit);
          return hit || net;
        })
      )
    );
    return;
  }

  /* documents, JS and CSS: always try the network so a deploy is live
     immediately; fall back to the cached copy only when offline */
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('./index.html')))
  );
});
