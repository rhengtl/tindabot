# P3a — Cloud backup setup (one online Supabase project)

Written for the project owner. Nothing here is fabricated: every `<placeholder>` is a value you
create in a dashboard and keep outside the repository. Decisions: [BLUEPRINT §E7](BLUEPRINT.md).

## What the frontend needs (and nothing more)

| Value | Where it goes | Why it is safe there |
|---|---|---|
| Project URL `https://<ref>.supabase.co` | `frontend/.env.local` → `VITE_SUPABASE_URL` | public |
| anon / publishable key | `frontend/.env.local` → `VITE_SUPABASE_ANON_KEY` | designed to ship in clients; RLS is the boundary |

`frontend/.env.local` is git-ignored. When both values are absent or malformed the app behaves
exactly as P2 (the Cloud card says "Hindi available…").

**Never** in the frontend, the repo, or a message to Claude: the `service_role` key, the database
password, your Supabase personal access token, the Google OAuth client secret.

## 1. Create the project

1. supabase.com → New project → name `tindabot`, region closest to you. Save the **database
   password** in your password manager (only migrations need it).
2. Project Settings → API: note the **Project URL** and the **anon / publishable** key.

## 2. Apply the schema

Option A (CLI, recommended — keeps `supabase/migrations/` as the source of truth):

```bash
npx --yes supabase@2 login                       # once; stores a token in your user profile
cd frontend
npm run db:link -- --project-ref <ref>           # asks for the database password
npm run db:push                                   # applies supabase/migrations/0001_p3a.sql
```

The first `link` creates `supabase/config.toml` (commit it; it holds no secrets — the project ref
is public) and `supabase/.temp/` (git-ignored).

Option B: SQL editor → paste the whole `supabase/migrations/0001_p3a.sql` → Run.

Either way, afterwards Table editor shows `stores`, `store_members`, `products`, `customers`,
`events`, all with RLS enabled, and Database → Functions lists `sync_watermark`, `server_time`,
`archive_store`, `unarchive_store`, `is_member`, `is_owner`.

`sync_watermark()` is what makes pulls safe against Postgres' commit-order race (BLUEPRINT §E7
"Pull windows"); it returns only a transaction counter, no data.

## 3. Google sign-in

1. Google Cloud Console → a project (any) → **APIs & Services → OAuth consent screen**:
   External, app name "TindaBot", your email as support and developer contact. While the app is in
   *Testing*, add your Google account under **Test users** (enough for validation).
2. **Credentials → Create credentials → OAuth client ID → Web application**.
   Authorized redirect URI: `https://<ref>.supabase.co/auth/v1/callback`.
   Copy the **Client ID** and **Client secret**.
3. Supabase → Authentication → Providers → **Google** → enable → paste Client ID and Client secret
   → Save. The secret lives only in Supabase.

## 4. Redirect URLs (Authentication → URL Configuration)

- Site URL: `http://localhost:4173`
- Additional Redirect URLs: `http://localhost:4173/**`, `http://localhost:5173/**`
- Add the production origin later when there is one.

The phone reaches `localhost:4173` through `adb reverse tcp:4173 tcp:4173`, so the same entries
cover the physical realme validation.

## 5. Test users (automated RLS/integration tests only)

Authentication → Providers → **Email** stays enabled (default). Then Authentication → Users →
**Add user → Create new user** twice, with **Auto Confirm User** checked:

- `tindabot-test-a@example.com` — a strong password you choose
- `tindabot-test-b@example.com` — a different strong password

These are pre-created, so "Confirm email" can stay on and the tests only ever sign in; they never
sign up. Keep the `tindabot-test-` prefix — the cleanup script relies on it.

## 6. Local files

`frontend/.env.local` (git-ignored):

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon/publishable key>
```

`frontend/.env.test.local` (git-ignored; only when you want the online test suite to run):

```
TINDABOT_TEST_USERS=1
TEST_SUPABASE_URL=https://<ref>.supabase.co
TEST_SUPABASE_ANON_KEY=<anon/publishable key>
TEST_USER_A_EMAIL=tindabot-test-a@example.com
TEST_USER_A_PASSWORD=<password A>
TEST_USER_B_EMAIL=tindabot-test-b@example.com
TEST_USER_B_PASSWORD=<password B>
```

## 7. How the automated tests stay away from your data

- They authenticate with the anon key + `signInWithPassword` as the two test users only. Every
  read and write goes through RLS exactly like the app; the suite includes the cross-account
  isolation checks (user B cannot see or touch user A's store — and neither can see yours).
- Each run creates fresh stores named `test-<runid>-…`. Tests delete nothing (there is no DELETE
  privilege for any client).
- The suite is skipped entirely unless `TINDABOT_TEST_USERS=1` and both users' credentials are
  present.
- Cleanup is manual and explicit: `supabase/scripts/cleanup_test_data.sql`, run by you in the SQL
  editor. It deletes only stores created by the two test users **and** named `test-…`, inside a
  transaction that aborts if either condition fails, so it can never reach your store.

## 8. Running it

```bash
cd frontend
npm run build && npx vite preview --port 4173    # then open http://localhost:4173 → Iba pa → Cloud backup
```
