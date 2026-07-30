# Deploying VIG

Two options. Vercel is the one the project was planned around, and the only one
where `api/odds.js` works.

---

## Option A — GitHub + Vercel (recommended)

### 1. Push to GitHub

Run these from inside the folder that contains `index.html`, **not** its parent.
GitHub Pages and Vercel both expect `index.html` at the repo root.

```bash
cd vig-v1.1
git init
git add .
git commit -m "VIG v1.1"
```

Then create the remote. With the GitHub CLI:

```bash
gh repo create vig --private --source=. --push
```

Or manually — create an empty repo at github.com/new (no README, no
.gitignore, it will conflict), then:

```bash
git remote add origin https://github.com/<you>/vig.git
git branch -M main
git push -u origin main
```

### 2. Connect Vercel

Either from the terminal:

```bash
npx vercel          # preview URL
npx vercel --prod   # stable production URL
```

Or at vercel.com → Add New → Project → import the repo. No build settings to
change; it detects a static site with an `api/` directory automatically.

### What you get

- `https://vig-<hash>.vercel.app` immediately, and a stable production URL.
- **Every push gets its own preview URL**, so you can text a friend one version
  while working on the next.
- The serverless function in `api/` is live. It stays inert until you add
  `ODDS_API_KEY` under Settings → Environment Variables.
- https, which matters: `localStorage` persists properly and the error banner's
  copy-to-clipboard needs a secure context.

---

## Option B — GitHub Pages only

Free and slightly simpler, but **serverless functions do not run**, so
`api/odds.js` is dead. Fine while all odds are simulated.

1. Push to GitHub as above.
2. Repo → Settings → Pages → Source: `main`, folder `/ (root)`.
3. Wait a minute for `https://<you>.github.io/vig/`.

One caveat: Pages serves from a subpath (`/vig/`), and `DataSource.endpoint` is
the absolute path `/api/odds`. On Pages that resolves to the domain root and
404s. It fails gracefully — the app catches it, falls back to the simulated
board and shows a red feed pill — but the live toggle will never work there.
The player data fetch is a relative path so it is unaffected.

---

## Do not text the HTML file

iOS Messages opens `.html` attachments in Quick Look, which renders HTML and CSS
but **does not execute JavaScript**. The page appears correct and nothing is
clickable — including the error banner, which JavaScript populates. Send a link,
not a file.

---

## Updating later

```bash
node scripts/build-fantasy-data.mjs 2025   # refresh player data
git add -A && git commit -m "…" && git push
```

Vercel redeploys on push. To automate the data refresh in season, add a Vercel
Cron that runs the build step, or run it locally each week and commit the JSON.

## Before it is public

`.gitignore` already excludes `.env`. Keep it that way — a committed API key is
public forever, even after a force push, because GitHub retains orphaned objects.
