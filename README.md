# TindaBot

A smart *listahan* for sari-sari store owners. Before every supplier trip it answers
*ano ang bibilhin, ilan, kailan, at magkano ang dadalhin* — from what the owner bought and what
they saw on the shelf. Local-first PWA; no account or internet needed.

The approved specification is [docs/BLUEPRINT.md](docs/BLUEPRINT.md). Business rules live only in
`frontend/src/domain/` and must not be changed without updating the blueprint.

## Run

```bash
cd frontend
npm install
npm run dev        # http://localhost:5173
npm test           # 357 offline tests: domain vs reference oracles, grouped-derivation equivalence, Dexie markers, schema upgrades, unopenable-storage, failed-write, import validation and interrupted-import handling, sheet back-button history, auth event mapping, build-env exposure, sync engine (in-memory cloud), OAuth redirect errors, cloud-unavailable handling, language/strings, export/backup, sheet drag
npm run typecheck
npm run build && npx vite preview   # production build with service worker (offline)
```

`npm test` runs every `*.test.ts`, and that includes the online integration suite whenever
`frontend/.env.test.local` exists (`TINDABOT_TEST_USERS=1` + the test-project settings): on such a
machine `npm test` talks to the real Supabase project and signs in as the `tindabot-test-*`
accounts. To stay offline, or to run the online suite on purpose:

```bash
npx vitest run --exclude "**/online.test.ts"        # offline only (357 tests)
npx vitest run src/sync/__tests__/online.test.ts    # online suite, deliberately (needs .env.test.local)
```

## Reference oracle

`tools/reference_model.py` is an independent Python implementation of the blueprint's formulas.
It generates the golden numbers the TypeScript tests assert against:

```bash
python tools/make_scenarios.py     # writes frontend/src/domain/__tests__/scenarios.json
python tools/reference_model.py    # writes frontend/src/domain/__tests__/goldens.json
python tools/finance_reference.py  # P2 (§E6): writes frontend/src/domain/__tests__/finance_scenarios.json
```

Change a scenario or a rule → regenerate goldens → run `npm test`.

## Layout

```
docs/BLUEPRINT.md          source of truth
tools/                     reference oracle + scenario generator
frontend/src/domain/       pure TS: events, total order, Tier A/B, list, rounding, export
frontend/src/db/           Dexie persistence (write-once events, storage-only sync markers)
frontend/src/sync/         P3a cloud backup: env (fails closed), codec, claim rules, engine, supabase-js wrapper
frontend/src/state/        Zustand store, demo seed
frontend/src/catalog/      bundled PH sari-sari catalog
frontend/src/ui/           screens (Bahay, Paninda, Bumili, Bilang, Bakit, Listahan, Pera, Iba pa, Onboarding);
                           strings.ts = Taglish (default) + English, switched at runtime via i18n.ts / Iba pa
supabase/migrations/       P3a schema, triggers, RLS (apply with `npm run db:push` or the SQL editor)
supabase/scripts/          manual cleanup of automated-test data (run in the SQL editor only)
```

## Cloud backup (P3a)

Optional. Without `frontend/.env.local` the app runs exactly as before (no sign-in, no sync).
Setup steps and what goes where: [docs/P3A-SETUP.md](docs/P3A-SETUP.md). Only the project URL
and the anon key ever reach the frontend; RLS is the security boundary.

P1 (local-only listahan) and P2 (utang/cash) are implemented and device-validated. P3a (Google
sign-in + cloud backup/sync) is implemented, integration-tested against the online project and
validated on the phone (restore, push, offline queue, a paused/unavailable cloud, sign-out; see
[docs/P1-DEVICE-VALIDATION.md](docs/P1-DEVICE-VALIDATION.md)). The real Google round trip — consent
screen, callback, PKCE exchange, signed-in session, sign-out with local data intact — was verified
manually on the desktop localhost preview build with the `local_only` demo store current, so no
cloud rows were created. Claiming and uploading a store under a Google identity was verified on
2026-09-29 on the same kind of preview. Deployment (Vercel + the existing Supabase project) is being
prepared, not done: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Known device limitation: on the validation
phone (realme C55 / Brave 1.95) the browser refuses *file* shares (`NotAllowedError`), so the export
falls back to a download; that download works — a real export file was produced and read back on the
phone on 2026-09-28 — but Brave asks where to save it, and a web page cannot see how that prompt
ends. `last_backup_at` therefore means "the export was handed over", never "the file is provably on
disk", and the app says so in words. P3b (receipt camera + `/ai/parse`),
P4 (assistant) and P5 (household) follow the blueprint roadmap.
