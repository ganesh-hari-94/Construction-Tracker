# Construction Site Tracker

A multi-project construction management app — manpower, activities, daily
progress, procurement, and a timeline/Gantt view — built with React,
Tailwind CSS, Recharts, and Lucide icons.

## Running locally

```bash
npm install
npm run dev
```

Then open the local URL Vite prints (usually http://localhost:5173).

## Building for production

```bash
npm run build
```

Outputs a static site to `dist/` — this can be deployed to Vercel, Netlify,
GitHub Pages, or any static host.

## Pushing to GitHub

```bash
git init
git add .
git commit -m "Initial commit: construction site tracker"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

Then connect the repo to Vercel or Netlify for automatic deploys on every
push, or run `npm run build` yourself and upload the `dist/` folder anywhere
that serves static files.

## Important: data persistence

This app was originally built as a Claude artifact, where all data (projects,
activities, manpower entries, procurement, etc.) was saved through Claude's
built-in `window.storage` API. That API **does not exist outside Claude** —
`src/App.jsx` calls it defensively (wrapped in try/catch), so the app will
still run and won't crash, but **nothing will persist between page reloads**
until it's wired to a real backend.

To make data persist for real, replace the `safeGet` / `safeSet` /
`safeDelete` functions near the top of `src/App.jsx` with calls to an actual
database. The two easiest options:

- **Supabase** — free tier, Postgres-backed, minimal setup, good fit given
  this app's per-project/per-collection data shape.
- **Firebase Firestore** — similarly quick to wire up, real-time sync
  included if you want live multi-user updates.

Every place data is loaded or saved goes through those three functions and
a fixed set of storage keys (see `PROJECT_DATA_KEYS` and the various
`save*` functions in `App.jsx`), so the swap is localized — you won't need
to touch the UI components themselves.

## Authentication

The login screen (username/password) is a **client-side gate only** — the
credentials live in the bundled JavaScript, visible to anyone who inspects
the built site. It's fine for keeping casual visitors out, but it is not
real security. For actual access control, this would need to move to a
backend (e.g. Supabase Auth) alongside the persistence work above.
