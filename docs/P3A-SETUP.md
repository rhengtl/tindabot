# P3a — Cloud backup setup (one online Supabase project)

Written for the project owner. Nothing here is fabricated: every blank is a value you create in a
dashboard and keep outside the repository. Design: [BLUEPRINT §E7](BLUEPRINT.md).

## Value classification

| Value | Class | Where it goes |
|---|---|---|
| Supabase project ref | **SAFE TO GIVE** | derived from the URL; also `npm run db:link` |
| Supabase project URL | **SAFE TO GIVE** | `frontend/.env.local`, `frontend/.env.test.local` |
| Supabase anon / publishable key | **SAFE TO GIVE** (designed to ship in clients; RLS is the boundary) | `frontend/.env.local`, `frontend/.env.test.local` |
| Test user A / B email | **SAFE TO GIVE** — must start with `tindabot-test-` | `frontend/.env.test.local` |
| Test user A / B password | **PRIVATE / ENTER LOCALLY** | `frontend/.env.test.local` only |
| Google OAuth client ID | **CONSOLE ONLY** (Supabase → Google provider) | never in the repo or the app |
| Google OAuth client secret | **CONSOLE ONLY** | never in the repo, the app, or a chat |
| Supabase database password | **PRIVATE / ENTER LOCALLY** (CLI prompt during `db:link`) | password manager |
| Supabase CLI access token | **PRIVATE** (created by `supabase login`, stored in your user profile) | never in the repo |
| `service_role` / secret key | **NEVER USED** — nothing in P3a needs it | — |

Both `.env` files are git-ignored (`.gitignore` covers `frontend/.env.local` and `frontend/.env.*.local`).
Without them the app runs exactly as P2 and the online test suite skips itself.

## 1. Supabase dashboard

1. **New project** — any name (e.g. `tindabot`), region closest to you. Save the database password
   in your password manager. *Verify:* the project shows "Active".
2. **Postgres version** — Settings → Infrastructure (or Database): must be **15 or newer**
   (`pg_current_xact_id()` / `pg_snapshot_xmin()` need 13+). *Verify:* version shown.
3. **API values** — Settings → API: copy the Project URL and the anon / publishable key.
   Skip the `service_role` / secret key entirely.
4. **Email provider** — Authentication → Providers → Email: leave enabled (needed by the test users).
5. **Test users** — Authentication → Users → Add user → Create new user, twice, **Auto Confirm
   User checked**: `tindabot-test-a@example.com` and `tindabot-test-b@example.com` with two
   different strong passwords. The `tindabot-test-` prefix is required: the suite refuses any other
   account and the cleanup script only ever touches stores owned by such users.
   *Verify:* both appear in the Users list with "Confirmed".
6. **Redirect URLs** — Authentication → URL Configuration: Site URL `http://localhost:4173`;
   Additional Redirect URLs `http://localhost:4173/**` and `http://localhost:5173/**`. *Verify:* saved.
7. **Google provider** — Authentication → Providers → Google → enable → paste Client ID and
   Client secret from section 2 → Save. *Verify:* provider shows "Enabled".
8. *(Optional, after your first successful Google sign-in and step 5)* Authentication → Settings:
   turn off "Allow new users to sign up". Existing users (you and the test users) still sign in.

## 2. Google Cloud console

1. **OAuth consent screen** — External; app name "TindaBot"; your email as support and developer
   contact. Keep it in *Testing* and add your own Google account under **Test users**.
   *Verify:* your account is listed as a test user.
2. **Credentials → Create credentials → OAuth client ID → Web application.** Exactly one authorized
   redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`. *Verify:* the client ID
   and secret are shown; enter them only in Supabase (step 1.7).

## 3. `frontend/.env.local`

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon/publishable key>
```
*Verify:* `npm run build && npx vite preview --port 4173` → Iba pa → the Cloud backup card shows
"Mag-sign in gamit ang Google" instead of "Hindi available…".

## 4. `frontend/.env.test.local`

```
TINDABOT_TEST_USERS=1
TEST_SUPABASE_URL=https://<project-ref>.supabase.co
TEST_SUPABASE_ANON_KEY=<anon/publishable key>
TEST_USER_A_EMAIL=tindabot-test-a@example.com
TEST_USER_A_PASSWORD=<password A>
TEST_USER_B_EMAIL=tindabot-test-b@example.com
TEST_USER_B_PASSWORD=<password B>
```
*Verify:* `npx vitest run src/sync/__tests__/online.test.ts` no longer reports "0 test" (it will
fail until the migration is applied; that is expected).

## 5. CLI login and first migration

```bash
npx --yes supabase@2 login                    # once; opens a browser; token stays in your profile
cd frontend
npm run db:link -- --project-ref <project-ref>   # prompts for the database password
npm run db:push                                # applies supabase/migrations/0001_p3a.sql
```
Alternative: SQL editor → paste the whole of `supabase/migrations/0001_p3a.sql` → Run.

*Verify:* Table editor shows `stores`, `store_members`, `products`, `customers`, `events`, each
marked RLS enabled; Database → Functions lists `sync_watermark`, `server_time`, `archive_store`,
`unarchive_store`, `is_member`, `is_owner`. `link` creates `supabase/config.toml` (no secrets —
fine to keep) and `supabase/.temp/` (git-ignored).

**Optional, only while validating:** paste `supabase/scripts/test_helpers.sql` into the SQL
editor. It adds `test_slow_insert_event` — a member-only function that inserts one ordinary event
and holds its transaction open for ≤ 3 s — which is the only way to reproduce the
uncommitted-transaction race on the real database. The suite skips those tests when it is absent.
Drop it afterwards with the statement at the bottom of that file.

## 6. Running the online suite and cleaning up

```bash
cd frontend
npx vitest run src/sync/__tests__/online.test.ts
```
It signs in only as the two test users, creates stores named `test-<runid>-…`, deletes nothing (no
client can), and archives its stores when done. Remove them for good whenever you like:
`supabase/scripts/cleanup_test_data.sql` in the SQL editor — it deletes only stores that are owned
by `tindabot-test-*` users **and** named `test-…`, inside a transaction that aborts otherwise.
