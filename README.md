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
npm test           # 215 tests: domain vs reference oracles, Dexie markers, sync engine (in-memory cloud)
npm run typecheck
npm run build && npx vite preview   # production build with service worker (offline)
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
frontend/src/ui/           screens (Bahay, Paninda, Bumili, Bilang, Bakit, Listahan, Pera, Iba pa, Onboarding)
supabase/migrations/       P3a schema, triggers, RLS (apply with `npm run db:push` or the SQL editor)
supabase/scripts/          manual cleanup of automated-test data (run in the SQL editor only)
```

## Cloud backup (P3a)

Optional. Without `frontend/.env.local` the app runs exactly as before (no sign-in, no sync).
Setup steps and what goes where: [docs/P3A-SETUP.md](docs/P3A-SETUP.md). Only the project URL
and the anon key ever reach the frontend; RLS is the security boundary.

Phase 1 (local-only) is implemented. P2–P5 (utang/cash, cloud sync + receipt camera, assistant,
household) follow the blueprint roadmap.
