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

## Data persistence: Supabase

Data is stored in a Supabase Postgres table (`kv_store`) that mirrors the
original key/value storage model this app used as a Claude artifact — one
row per key, JSON value. Two small per-device settings (the remembered login
and which project you last viewed) live in the browser's `localStorage`
instead, since they're device conveniences rather than data that needs to
sync across devices.

**One-time setup:**

1. In your Supabase project, open the SQL Editor and run everything in
   `supabase-schema.sql` (creates the `kv_store` table and its access
   policies).
2. Set these as environment variables in Vercel (Project → Settings →
   Environment Variables) — already declared there:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`

   (These use Next.js's naming convention rather than Vite's `VITE_` prefix,
   but that's fine — `vite.config.js` is configured to expose `NEXT_PUBLIC_`
   vars to the client too, so nothing needed renaming.)
3. For local development, copy `.env.example` to `.env` and fill in the same
   two values (`.env` is already gitignored).

**Security note worth reading:** the RLS policies in `supabase-schema.sql`
are wide open — anyone with the anon key can read or write every row, same
as how "shared" data worked before. That's fine behind the app's own login
screen for an internal team tool, but the anon key ships in the built
JavaScript bundle, so it's not a secret. If this app or its repo ever
becomes public, tighten those policies before that happens.

**Also newly true:** the old ~3.5MB-per-file cap on MOM/meeting-note
uploads was a limit of the artifact's storage, not a Postgres limit —
`jsonb` columns can comfortably hold much larger values. The app's own
upload validation still enforces the old cap; let me know if you want that
raised now that it's backed by Supabase.

## Authentication

The login screen (username/password) is a **client-side gate only** — the
credentials live in the bundled JavaScript, visible to anyone who inspects
the built site. It's fine for keeping casual visitors out, but it is not
real security. For actual access control, this would need to move to
Supabase Auth.
