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

## Reports

The **Reports** tab takes a snapshot of the current project, stamped with the time it was taken (use *Refresh report* for a new one). It has three sections:

1. **Manpower:** daily and monthly manpower charts, each with its day-over-day / month-over-month change.
2. **Pending activities:** every activity not yet completed, most urgent first, as a progress bar showing the percentage of its total scope completed ("n/a" where no total scope was entered).
3. **Pending procurement:** every lot not yet delivered (plus items with no lots yet), with quantity, location, status, expected vs actual dates for each stage, and the latest update.

Three ways to take it away:

- **Print / Save as PDF:** prints just the report (landscape A4). Choose "Save as PDF" as the printer.
- **Download Excel:** the data behind each section on four sheets (daily manpower, monthly manpower, pending activities, pending procurement). Charts can't be placed inside the file.
- **Download PowerPoint:** a 16:9 deck with a cover, manpower charts, the activity progress bars and the procurement table (long lists continue over several slides).

The PowerPoint is built in the browser with [PptxGenJS](https://github.com/gitbrent/PptxGenJS), which is listed in `package.json` and only downloaded when the button is clicked. After pulling this change, run `npm install` (and commit the updated `package-lock.json` if your repo has one).

## AI Insights (optional)

The **Insights** tab lets you ask questions about the current project ("what's overdue?", "how's manpower trending?", "which lots are delayed?") and get an answer from Google's Gemini API (free tier, no billing needed).

**What the AI sees.** Every question is sent together with the project's *complete* data model, built in the browser from what is already loaded:

- all activities (dates, scope, computed status, delay days, discipline, area, notes)
- manpower for every logged day, by discipline and by subcontractor
- every daily-log entry, with its sub-activities nested underneath
- procurement items with their lots, dates, statuses and dated updates
- the project's disciplines, areas and subcontractors
- meeting records (date, description, file name only; **the contents of the uploaded files are not sent**)

Other projects' data is never included.

**Size limit.** The data is capped at about 600,000 characters (roughly 150K tokens, enough for around 2,000 daily-log entries alongside everything else) per question (`MAX_CONTEXT_CHARS` in `src/App.jsx`). If a project outgrows that, the *oldest* daily-log and manpower history is dropped first. Activities, procurement and everything else are always sent in full, and the Insights tab says so under the answer.

**Long answers.** The Edge Function allows up to 8,192 output tokens (it was 500, which cut longer answers off). The answer box scrolls for long answers and shows a notice if the model still reaches the limit. A request is also given up after 120 seconds with a clear message, instead of a generic gateway error.

**One-time setup:**

1. Create a free API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey), no credit card required.
2. Deploy the Edge Function and set the secret (same pattern as `notify-signup`, via the Supabase dashboard's function editor or the CLI):
   ```bash
   supabase functions deploy ai-insights
   supabase secrets set GEMINI_API_KEY=your-gemini-api-key
   ```
   After changing `supabase/functions/ai-insights/index.ts`, redeploy it; the app code and the function are deployed separately.

**Worth knowing about the free tier, stated plainly:**

- **Rate limits, not dollar limits.** The free tier caps requests and tokens per minute and per day (check your actual quota in AI Studio). Going over doesn't bill you; the AI simply stops answering until the limit resets. Because each question now carries the whole project, a few questions in quick succession can reach the per-minute token limit on a large project.
- **Google may use free-tier prompts to improve their models.** This is documented Google policy, not a guess. Because the *full* project data is sent (activity names and notes, subcontractor and supplier names, meeting descriptions), not just a summary, decide whether that is acceptable for this project. Attaching a billing account to the key turns that off and switches to metered pricing.
- If usage grows beyond casual use, revisit the provider choice; the Edge Function is a thin, swappable wrapper.

**If the key is missing or invalid**, the Insights tab shows the actual error returned by the function instead of failing silently.
