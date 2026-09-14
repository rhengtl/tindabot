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
npm test           # domain tests (157) against the reference oracles
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
frontend/src/db/           Dexie persistence (write-once events)
frontend/src/state/        Zustand store, demo seed
frontend/src/catalog/      bundled PH sari-sari catalog
frontend/src/ui/           screens (Bahay, Paninda, Bumili, Bilang, Bakit, Iba pa, Onboarding)
```

Phase 1 (local-only) is implemented. P2–P5 (utang/cash, cloud sync + receipt camera, assistant,
household) follow the blueprint roadmap.
