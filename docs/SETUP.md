# Setting up your own TindaBot

TindaBot works with **no setup at all**: build it and it runs fully on the device, offline, with no
account. Everything in this guide is optional and adds:

| Part | Adds | Needs |
|---|---|---|
| Cloud backup and sync | Google sign-in, backup, several devices, household sharing | a Supabase project and a Google OAuth client |
| AI helper | reading receipt photos and notes, answering questions about the store | cloud backup (for sign-in), a Gemini API key, and a host that runs the serverless function in `frontend/api/` (the project is set up for Vercel) |
| Online test suite | integration tests against a real Supabase project | two dedicated test accounts in that project |

Never put a secret in the repository. The only Supabase values the app uses are the project URL and
the publishable (anon) key, which are public by design: Row Level Security is the security boundary.
The `service_role` / secret key, the database password and the Google client secret are never used by
the app and never go into an `.env` file.

## 1. Run it locally (no setup)

```bash
cd frontend
npm ci
npm run dev            # http://localhost:5173
```

Without `frontend/.env.local` the Cloud card says cloud backup is not available in this build, and
every other feature works.

## 2. Supabase project

1. **Create a project.** Postgres must be **15 or newer**. Keep the database password in a password
   manager; the app never needs it.
2. **API values:** Project Settings → API. Copy the **Project URL** and the **publishable / anon
   key**. Do not use the `service_role` / secret key anywhere.
3. **Apply the migrations**, in order, either in the SQL editor (paste the whole file, Run) or with
   the Supabase CLI:
   - `supabase/migrations/0001_p3a.sql`: stores, members, products, customers, events, Row Level
     Security, sync functions.
   - `supabase/migrations/0002_p4p5.sql`: AI rate limit and household invites (additions only).

   ```bash
   npx --yes supabase@2 login                        # once; the token stays in your user profile
   cd frontend
   npm run db:link -- --project-ref <project-ref>     # asks for the database password
   npm run db:push
   ```

   *Check:* the Table editor shows `stores`, `store_members`, `products`, `customers`, `events`,
   `ai_calls`, `store_invites` and `invite_attempts`, each with RLS enabled.
4. **Google provider:** Authentication → Providers → Google → enable, then paste the client ID and
   secret from section 3. They stay in Supabase only.
5. **URL configuration:** Authentication → URL Configuration.
   - **Site URL:** your production address (for example `https://<your-domain>`).
   - **Redirect URLs:** `https://<your-domain>/**`, plus `http://localhost:5173/**` and
     `http://localhost:4173/**` for local development and preview.
   - The app always returns to the page it was opened from, so that address must be listed.
     Vercel preview deployments get a new address each time and cannot sign in unless you add a
     pattern for them.
6. **Who can sign up.** By default anyone can create an account in a Supabase project, and every
   account gets its own isolated stores and its own AI quota. To limit it, turn off *Allow new users
   to sign up* (Authentication → Settings) after your own first sign-in. Existing accounts keep
   working, but nobody new can join, including a future household member.
   The Email provider is only needed for the online test suite's email/password test accounts.

## 3. Google OAuth client

In the Google Cloud console:

1. **OAuth consent screen:** External, app name "TindaBot". While it is in *Testing*, only the
   Google accounts listed under **Test users** can sign in. Publish it if anyone else should be able
   to.
2. **Credentials → Create credentials → OAuth client ID → Web application.** Add exactly one
   authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`. Enter the client
   ID and secret only in Supabase (section 2.4).

## 4. Local configuration

Copy `frontend/.env.example` to `frontend/.env.local` (git-ignored) and fill in:

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<publishable key>
```

- The URL must have **no trailing slash and no path**. A malformed value is refused, and the build
  silently becomes local-only ("Cloud backup is not available in this build").
- Only variables starting with `VITE_` reach the browser bundle, and the app reads exactly these
  two by name.

*Check:* `npm run build && npm run preview`, then More → the Cloud backup card offers *Sign in with
Google*.

## 5. AI helper (optional)

1. Create a Gemini API key in Google AI Studio.
2. Set the server-only variables. They must **not** start with `VITE_`, so they never reach the
   browser:

   | Variable | Required | Meaning |
   |---|---|---|
   | `GEMINI_API_KEY` | yes | the Gemini key (secret) |
   | `GEMINI_MODEL` | no | main model; default `gemini-flash-latest` |
   | `GEMINI_FALLBACK_MODEL` | no | light model; default `gemini-flash-lite-latest`; `none` turns it off |

3. Migration `0002` must be applied: the function checks each caller's own Supabase session through
   `ai_quota_hit()`, which also enforces the limit of 30 calls per minute and 300 per day per account.

Locally, put the variables in `frontend/.env.local`. `npm run dev` then serves `POST /api/ai` from
`frontend/api/ai.ts`. `npm run preview` has no function, and the app says the AI is not set up.

Receipts and notes go to the main model first; questions go to the light model first. A model that
is busy (429/500/503) is retried and then replaced by the other one, and a model that is too slow is
abandoned for the other one. The function never stores or logs what is sent to it; the database
keeps only the time of each call, for two days, to enforce the limit.

## 6. Deploy to Vercel

| Vercel setting | Value |
|---|---|
| Root Directory | `frontend` |
| Framework preset | Vite (auto-detected) |
| Build command | `npm run build` (also generates the service worker) |
| Output directory | `dist` |
| Environment variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`; for the AI also `GEMINI_API_KEY` (and optionally the two model variables) |

- `frontend/vercel.json` only gives the AI function a 60-second time limit. The app itself is a static
  build with a single page and no client-side router.
- Vercel's default caching (revalidate on every request) is correct for `index.html` and `sw.js`,
  so updates reach installed apps on their next reload.
- Add the production address to the Supabase redirect URLs (section 2.5).

*Checks after deploying:* the page loads over HTTPS and works offline after a reload; More → Cloud
backup offers *Sign in with Google*; `POST /api/ai` without a token answers `401 {"error":"auth"}`;
a signed-in question in *Ask TindaBot* gets an answer.

## 7. Online test suite (maintainers)

`npm test` includes `frontend/src/sync/__tests__/online.test.ts`, which **skips itself** unless
`frontend/.env.test.local` exists. To enable it:

1. In the Supabase project, create two email/password users (Authentication → Users → Add user, *Auto
   Confirm*) whose addresses start with `tindabot-test-`, for example
   `tindabot-test-a@example.com` and `tindabot-test-b@example.com`. The suite refuses any other
   account.
2. Copy `frontend/.env.test.example` to `frontend/.env.test.local` (git-ignored) and fill it in. The
   passwords stay on your machine only.
3. Run it: `npx vitest run src/sync/__tests__/online.test.ts`.

What it does to the project: it signs in only as the two test users, creates stores named
`test-<run>-…`, and archives them when done. Clients cannot delete anything, so the rows accumulate.
Remove them with `supabase/scripts/cleanup_test_data.sql`. Run it in the SQL editor with the default
`postgres` role. It deletes only stores that were created by `tindabot-test-*` users **and** are named
`test-…`, in one block that aborts and deletes nothing if any check fails. Using a separate Supabase
project for tests keeps these rows out of real data.

One race test also needs `supabase/scripts/test_helpers.sql`. Install it only while validating and
drop it afterwards (the statement is at the bottom of that file); the test skips itself without it.

## 8. Running it

- **Free Supabase plan:** a project without activity for about a week is paused. The app treats that
  as a normal state: it keeps working on the device, queues new entries, and uploads them once the
  project is resumed in the dashboard. It never sends keep-alive traffic.
- **Gemini free tier:** when the quota runs out the app says the AI is busy; everything else is
  unaffected.
- **Backups:** the app also offers a JSON export (More → Export), which works without any account.
