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
row per key, JSON value. Which project you last viewed is remembered in the
browser's `localStorage` (a per-device convenience, not synced data); your
login session itself is managed by Supabase Auth, which persists it in
`localStorage` under its own key automatically.

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
were originally wide open. `supabase-auth-schema.sql` (below) locks
`kv_store` down to approved, authenticated users only — run that migration
before relying on this for anything sensitive.

**Also newly true:** the old ~3.5MB-per-file cap on MOM/meeting-note
uploads was a limit of the artifact's storage, not a Postgres limit —
`jsonb` columns can comfortably hold much larger values. The app's own
upload validation still enforces the old cap; let me know if you want that
raised now that it's backed by Supabase.

## Authentication: sign-up with admin approval

Real accounts now, via Supabase Auth — anyone can sign up with email +
password, but they can't actually use the app until an admin approves them.
`ganesh.hari.94@gmail.com` is auto-approved and made admin the moment that
address signs up (see the migration below), so there's always at least one
account able to approve everyone else.

**One-time setup, in order:**

1. Run `supabase-schema.sql` first if you haven't already (creates `kv_store`).
2. Run `supabase-auth-schema.sql` in the SQL Editor. This creates the
   `profiles` table, auto-creates a profile row on every signup (approved +
   admin automatically if the email matches `ganesh.hari.94@gmail.com`), and
   replaces `kv_store`'s wide-open policies with ones that require
   `profiles.approved = true`.
   - **If `ganesh.hari.94@gmail.com` already has an account** from before
     this migration existed, its profile wasn't created by the trigger (the
     trigger only fires on new signups). Run the backfill query at the
     bottom of `supabase-auth-schema.sql` once to fix that account.
3. In Supabase Dashboard → Authentication → Providers → Email, check whether
   "Confirm email" is on. Either setting works with this app (approval still
   gates real access either way) — if it's on, users get a Supabase
   confirmation email *in addition to* needing admin approval.
4. Deploy the notification Edge Function and set its secret:
   ```bash
   supabase functions deploy notify-signup
   supabase secrets set RESEND_API_KEY=your-resend-api-key
   supabase secrets set APP_URL=https://your-app.vercel.app   # optional
   ```
   You'll need a free [Resend](https://resend.com) account for the API key.
   Using Resend's default `onboarding@resend.dev` sender without a verified
   domain only works for sending **to the email address the Resend account
   itself was created with** — so create the Resend account using
   `ganesh.hari.94@gmail.com` and this will work with zero extra setup. If
   you want the app able to email a different admin later, verify a sending
   domain in Resend first.

**How it works day to day:** someone signs up → a `profiles` row is created
(unapproved) → the `notify-signup` function emails
`ganesh.hari.94@gmail.com` → they sign in and open the **Admin** link in the
header → approve or revoke from there. Approval takes effect immediately;
no re-signup needed.

**Worth knowing:** if the email notification fails for any reason (Resend
not configured yet, secret missing, etc.), signup itself still succeeds —
the new account just won't be visible to the admin except by checking the
Admin tab directly. It's not a silent data loss, just a missed nudge.

## AI Insights (optional)

The **Insights** tab lets you ask questions about the current project
("what's overdue?", "how's manpower trending?") and get a quick answer from
Google's Gemini API (free tier — no billing needed). A compact text summary
of the project (activity status breakdown, overdue items, manpower trend,
procurement delays — not raw file uploads or full record dumps) is built
client-side and sent along with your question.

**One-time setup:**

1. Create a free API key at
   [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — no
   credit card required.
2. Deploy the Edge Function and set the secret (same pattern as
   `notify-signup` — via the Supabase dashboard's function editor, or CLI):
   ```bash
   supabase functions deploy ai-insights
   supabase secrets set GEMINI_API_KEY=your-gemini-api-key
   ```

**Worth knowing about the free tier, stated plainly:**
- **Rate limits, not dollar limits.** The free tier caps requests per day
  (roughly a few hundred to low thousands depending on Google's current
  limits for `gemini-2.5-flash` — check your actual quota in AI Studio) —
  it doesn't bill you if you go over, it just stops answering until the
  limit resets.
- **Google may use free-tier prompts to improve their models.** This is
  documented Google policy, not a guess. The data sent is a summary (status
  counts, overdue items, trends) rather than raw uploaded files, but it's
  still your project's data — decide if that's an acceptable tradeoff for
  $0 cost. Attaching a billing account removes this and switches to paid,
  metered pricing instead.
- If usage ever needs to scale beyond casual use, that's the point to
  revisit — either accept paid Gemini pricing or swap back to another
  provider (the Edge Function is a thin, swappable wrapper either way).

**If the key is missing or invalid**, the Insights tab shows the actual
error message returned by the function rather than failing silently.
