# TindaBot — deployment preparation (Vercel + the existing Supabase project)

Owner decisions (2026-09-29): host the frontend on **Vercel**, and **reuse the existing Supabase
project** (the one used for P3a and its tests) for production. There is no separate production
project. This is a personal project, and the owner accepts the shared project. Nothing has been
deployed yet. This file lists what the first deployment needs and how to check it. It contains
**no values**: every URL, key and ID below is a placeholder that the owner supplies.

Setup of the project itself (schema, providers, test users) is in [P3A-SETUP.md](P3A-SETUP.md).

## 1. What gets deployed

A static site: the Vite production build of `frontend/`. There is no server code, no serverless
function, no backend.

| Vercel setting | Value |
|---|---|
| Root Directory | `frontend` |
| Framework preset | Vite (auto-detected) |
| Install command | default (`npm install`, lockfile present; `npm ci` also works) |
| Build command | `npm run build` (runs `vite build`, which also generates the service worker) |
| Output directory | `dist` |
| Node.js version | any current LTS; the build was checked locally on Node 24 |

**No `vercel.json` is needed.** The app has a single route (`/`) and no client router. The OAuth
return comes back to that same page (see §3). Everything else is a static file at a fixed path:
`index.html`, `assets/*`, `sw.js`, `workbox-*.js`, `manifest.webmanifest`, and the icons. Once
the service worker is installed, it serves `index.html` for navigations itself
(`navigateFallback`).

Caching: `sw.js` and `index.html` must not be cached long by the CDN, or updates would stall.
Vercel's default for static files is to revalidate on every request, so the defaults are right.
This is Vercel's documented default and has not yet been checked on a real deployment (§6).

Checked locally on 2026-09-29, simulating Vercel: only the git-tracked `frontend/` files were
used, installed with `npm ci`, with no `.env` file. The variables came from the process
environment, as Vercel supplies them. Results:
- With the two variables set, the output was byte-identical to the local build.
- Without them, it was a local-only build: the Cloud card says cloud backup is not available,
  and the app makes no off-origin requests.

## 2. Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Value | Scope |
|---|---|---|
| `VITE_SUPABASE_URL` | the existing project's URL, `https://<project-ref>.supabase.co`, **no trailing slash, no path** | Production (Preview only if previews should have cloud) |
| `VITE_SUPABASE_ANON_KEY` | the existing project's **publishable** key (`sb_publishable_…`) | same |

Both values are public by nature: Vite inlines them into the JavaScript bundle, and RLS is the
security boundary. Nothing else goes to Vercel:
- no `service_role` / secret key;
- no database password;
- no Google client secret;
- none of the `TEST_*` / `TINDABOT_TEST_USERS` variables from `frontend/.env.test.local`.

Only variables starting with `VITE_` can reach the bundle, and the build-output scan below
confirms which ones do.

**Pitfall:** the app refuses malformed cloud settings and silently builds as local-only
(`frontend/src/sync/env.ts`). A URL with a trailing `/` counts as malformed. This was checked on
2026-09-29: that build showed "Cloud backup is not available in this build". If the deployed Cloud
card says that, check the two variables first.

**Build-output scan** (2026-09-29, `dist/`):
- Present: the project URL and the publishable key, as expected.
- Absent: test passwords, test account emails, `TEST_*` names, `service_role`, `sb_secret_`,
  JWT-shaped strings, Google client-secret shapes, and source maps.
- `localhost` / `127.0.0.1` appear only inside library code: Dexie's debug-mode check, an unused
  `auth-js` default constant, and WebAuthn/Realtime host checks. The app itself has no
  localhost or origin assumption: the OAuth return address is computed from the page's own
  address.

## 3. Supabase (existing project) — what changes for production

**No schema, RLS, function or data change is required.** The migration
(`supabase/migrations/0001_p3a.sql`) contains nothing environment-specific. Access is by store
membership, and anonymous requests can read nothing (checked: HTTP 401 on 2026-09-29).

Manual configuration, all in the dashboard, by the owner:

1. **Authentication → URL Configuration → Redirect URLs:**
   - Add the production origin, e.g. `https://<your-production-domain>/**`.
   - Keep the existing `http://localhost:4173/**` and `http://localhost:5173/**` entries, so
     local testing keeps working.
   - The app sends `redirectTo = <page origin><page path>`. Normally that is the domain root, and
     the `/**` form also covers `/index.html`.
   - Vercel **preview** deployments get a new domain every time. They can sign in only if a
     matching pattern is added as well. Leaving previews out is the safe default: without it, a
     sign-in from a preview returns to the Site URL, not to the preview.
2. **Site URL** — the fallback return address, also used in auth emails. Whether to change it to
   the production origin is an owner decision. If it changes, localhost sign-ins still work as
   long as the localhost entries stay in the Redirect URLs list.
3. **Sign-up policy (owner decision).** Currently the email and Google providers are enabled and
   new sign-ups are allowed (checked 2026-09-29).
   - Anyone holding the public key can create an email/password account through the API. Email
     confirmation is required, and RLS confines such an account to its own stores.
   - [P3A-SETUP.md](P3A-SETUP.md) §1.8 describes turning sign-ups off. Existing users — the owner's
     Google identity and the two test users — keep working. Nobody new can join.
4. **Advisors** — review Database → Security Advisor and Performance Advisor. They could not be
   read from here (no dashboard access, and no privileged credential is used).
5. **Plan limits** — a free-plan project pauses after about a week without activity. The app
   handles that state (P3A-SETUP §5b), but backups stop while it is paused. Backup coverage
   depends on the plan; check it before relying on the cloud copy as the only backup.

## 4. Google OAuth — what changes for production

- **Nothing mandatory.** The Google OAuth client's only authorized redirect URI is the Supabase
  callback, `https://<project-ref>.supabase.co/auth/v1/callback`. That does not change, because
  the project does not change. The production origin is allow-listed in Supabase (§3.1), not in
  Google.
- **Consent screen:** per P3A-SETUP §2 it was set up in *Testing* with the owner's account as a test
  user. In Testing, only listed test users can sign in with Google. For a personal project that is
  a working restriction, not a blocker. Publishing the consent screen is an owner decision.
- The client ID and secret stay only in the Supabase Google provider settings. They are never in
  Vercel, the repo, or the bundle.

## 5. Sharing one project between production and tests — consequences

Checked read-only on 2026-09-29:
- Test account A owns 232 stores and test account B owns 34. All are named `test-…` and all are
  archived; neither has an active store.
- The optional helper `test_slow_insert_event` is **not** installed.
- The owner's Google account owned one active store, *Google claim check* (created by the P3a
  claim/upload verification). It has since been archived; see item 5.

1. **Isolation holds through RLS.** Test users see only test stores, and the owner's account sees
   only its own store. Neither the app nor the tests can delete anything.
2. **The online suite writes to the production database.** It only creates and archives `test-…`
   stores under the test users. Rows accumulate until the cleanup script is run, and they count
   against plan quotas. The global `sync_watermark()` is shared, so while the optional slow-insert
   helper is installed, a running test can briefly delay other users' pulls (delay only, never
   loss). Keep that helper uninstalled outside validation.
3. **The cleanup script runs as the project owner, with DELETE, on production data.**
   - It is scoped three ways: stores created by `tindabot-test-*` users, named `test-…`, and it
     aborts on any mismatch.
   - It is safe as written. Editing it before running it is the risk.
4. **The test users are real accounts in the production project.** Their passwords live only in
   `frontend/.env.test.local` on the owner's machine. If they leaked, the exposure would be the test
   stores only.
5. **The *Google claim check* store affects the first production sign-in.** The claim logic
   (`frontend/src/sync/claim.ts`) works like this:
   - A new production device starts empty, because browser data is per origin: nothing from
     `localhost` carries over.
   - When the owner signs in with Google while the local store has no products, customers or
     entries yet, or is the demo, the app **automatically pulls *Google claim check* and switches
     to it**. The local store is left untouched, but the owner lands in the verification store.
   - If the local store already has entries, the app asks which store to keep. Keeping the phone's
     store archives *Google claim check* (a flag; nothing is deleted).
   - **Resolved 2026-09-29 (owner decision): archived.** How it was done:
     - It used the app's own owner-only `archive_store` call (the one behind "Keep the phone's
       store") with the owner's own Google session. No admin key was used, and RLS and the owner
       check applied. The store was identified by name, creator and owner membership first.
     - The app was signed out **before** archiving. That matters because a signed-in device still
       holding a store re-uploads and un-archives it.
     - Only `archived_at` changed (plus the `server_rev` bump every update gets). Its 2 products,
       1 customer, 8 events and the membership row are byte-identical.
     - The owner's account now has **no active store**. So a first production sign-in with the
       demo, or with a store that has no entries yet, uploads nothing and pulls nothing. A store
       with entries becomes the account's store.
     - **Do not sign in again in the throwaway Edge profile used for the P3a verification.** Its
       `localhost` origin still holds that store and would un-archive it.
   - Test isolation re-checked after the archive: the test accounts still see only their own
     archived `test-…` stores (232 and 34); cross-account reads of stores, products and events
     return nothing; anonymous reads get HTTP 401.
6. **Moving existing local data** (e.g. the phone's validation data on `localhost`) to the
   production origin would mean an export on the old origin and an import on the new one. The
   import keeps the store's id. That has not been planned or tested, and it is not proposed here.

## 6. Checks that need the real deployment (not yet done)

None of these can be verified locally. Deployment-ready is not established until they pass.

1. Production URL on desktop: loads over HTTPS, no console errors, service worker registered,
   offline reload works, and response headers for `sw.js` / `index.html` revalidate.
2. **Production OAuth:**
   - Google sign-in from the production origin returns to it with a clean address bar, and the
     card shows signed in.
   - Expect the claim behaviour described in §5.5.
   - Sign-out keeps local data.
3. Phone (Brave on the test phone; Chrome stays disabled):
   - install (Add to Home screen / WebAPK) and launch standalone;
   - offline launch;
   - `navigator.storage.persisted()` for the installed app;
   - back button in standalone mode;
   - **Google sign-in started from the installed app** — whether the OAuth return lands back in
     the app or in a browser tab is unverified.
4. Update path: redeploy a changed build, and an open app picks it up on its next reload.
5. Cloud Card on the deployed build is not "not available" (catches the env pitfall in §2).
