# TindaBot

A smart *listahan* (shopping and utang list) for **sari-sari store owners** in the Philippines.
Before every trip to the supplier it answers *ano ang bibilhin, ilan, kailan, at magkano ang
dadalhin*: what to buy, how many, when, and how much money to bring. It works it out from what the
owner already knows: what they bought and what they saw left on the shelf.

TindaBot is an installable web app (PWA) built for Android phones. It works **offline and without
an account**; cloud backup and an AI helper are optional extras. The interface is in Taglish by
default, with an English switch.

## Features

**Stock and the shopping list**
- *Home* is the list for the next supplier trip: what to buy now, what can wait, and roughly how much
  money to bring, with an optional budget ("I have ₱…") that fits the list to the cash on hand.
- Every line has a *bakit* (why) sheet that explains the number in one sentence. Uncertain numbers
  are shown as a range or an estimate, and the app asks for a count when its data is stale.
- Record what you **bought** (by pack or piece, with the price and supplier), **count** what is left
  (a quick count mode goes through products one by one), and optionally **tally sales** with taps.
- A bundled catalog of common sari-sari products (search by everyday names such as "coke" or
  "canton"), your own products, CSV import of a product list, and per-supplier price memory.

**Utang and money**
- Customers and their utang, payments, expenses and cash counts; a weekly report of what was recorded,
  kept separate from estimates of sales and profit.

**Your data**
- Everything is stored on the device. JSON export and import for backup or moving to a new phone.
- Several stores on one phone, and a demo store to try the app.
- Optional **Google sign-in with cloud backup and sync** across devices, and **household sharing**: the
  owner gives a one-time invite code so another person's phone records into the same store.

**AI helper (optional, needs sign-in and internet)**
- Turn a **receipt photo** or a typed or dictated note into entries you review and edit; nothing is
  saved until you press save, and photos are not stored.
- **Ask TindaBot** questions about your store. The answers use figures looked up on your phone, and
  any number that could not be checked against your data is marked as unverified. A daily briefing
  works offline.

## Requirements

- **To use:** a modern browser. It is built and tested for Android (Chrome-based browsers); it also
  runs on desktop browsers. iOS has not been tested.
- **To build:** Node.js 22 or newer (developed on Node 24) and npm.
- **Optional:** a Supabase project and a Google OAuth client (cloud backup), a Gemini API key and a
  host for the serverless function (AI helper), Python 3 (to regenerate the test reference data).

## Quick start

```bash
git clone <repository-url>
cd tindabot/frontend
npm ci
npm run dev                       # http://localhost:5173
```

That is the complete app, local-only. For the production build with the service worker (offline
start, installable):

```bash
npm run build
npm run preview                   # http://localhost:4173
```

## Configuration

No configuration is needed to run the app. Cloud backup and the AI helper are switched on by
environment variables. Copy [`frontend/.env.example`](frontend/.env.example) to `frontend/.env.local`
(git-ignored):

| Variable | Used for | Public? |
|---|---|---|
| `VITE_SUPABASE_URL` | cloud backup: your Supabase project URL | yes, it is in the browser bundle |
| `VITE_SUPABASE_ANON_KEY` | cloud backup: the publishable / anon key | yes, Row Level Security protects the data |
| `GEMINI_API_KEY` | AI helper | **no**, server-only secret |
| `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` | AI helper, optional model choice | server-only |

The full setup (Supabase, Google sign-in, database migrations, Gemini, deployment) is in
[docs/SETUP.md](docs/SETUP.md).

## Using it

1. Open the app and pick a language. Name the store, choose your usual restock days (or "when
   needed"), and add products from the catalog. You can also try the demo store first.
2. Use the **＋** button to record what happens: *Bought*, *Count*, *Utang*, *Payment*, *Expense*,
   *Cash*, *Sales*, and with the AI *Receipt*, *Write* and *Ask*.
3. Before going to the supplier, open *Home*. Share the list or set a budget.
4. On a phone, use the browser's *Add to Home screen* / *Install* to get an app icon.
5. Back up regularly with More → *Export*, or sign in with Google under More → *Cloud backup*.

## Development

```bash
cd frontend
npm run typecheck
npm test                          # the whole suite
npx vitest run --exclude "**/online.test.ts"   # offline tests only
npm run build
```

- The tests cover the business rules against an independent reference model, the local database,
  the sync engine (against an in-memory cloud), the AI proxy and drafts, and the UI wording.
- `src/sync/__tests__/online.test.ts` runs against a real Supabase project and **skips itself**
  unless `frontend/.env.test.local` exists (see [`frontend/.env.test.example`](frontend/.env.test.example)
  and [docs/SETUP.md §7](docs/SETUP.md)).
- **Reference model:** `tools/` holds an independent Python implementation of the formulas that
  generates the expected numbers the TypeScript tests check. After changing a scenario or a rule:

  ```bash
  python tools/make_scenarios.py      # → frontend/src/domain/__tests__/scenarios.json
  python tools/reference_model.py     # → frontend/src/domain/__tests__/goldens.json
  python tools/finance_reference.py   # → frontend/src/domain/__tests__/finance_scenarios.json
  ```

- **Specification:** [docs/BLUEPRINT.md](docs/BLUEPRINT.md) is the source of truth for every rule the
  app applies. A change to a business rule starts there, then the reference model, then the code.

## Architecture

```
frontend/
  src/domain/    pure TypeScript business rules: events, ordering, stock estimates, shopping list,
                 profit, utang and cash (no I/O, fully unit-tested)
  src/db/        local storage in IndexedDB (Dexie); entries are write-once events
  src/state/     app state (Zustand) and the demo store
  src/sync/      optional cloud backup: Supabase auth and a push/pull sync engine
  src/ai/        phone side of the AI helper: request client, drafts, assistant tools
  src/ui/        screens, Taglish and English wording
  src/catalog/   bundled product catalog
  api/ai.ts      the AI proxy, a serverless function: checks the caller, rate-limits, calls Gemini
supabase/
  migrations/    database schema, Row Level Security, sync and household functions
  scripts/       SQL for maintaining the online test suite (run by hand)
tools/           Python reference model for the test data
docs/            specification, setup guide, validation log
```

- **Local-first.** Every entry is an append-only event on the device. All numbers are recomputed from
  those events, so nothing depends on being online.
- **Cloud backup** stores the same events in Supabase. Access is enforced by Row Level Security per
  store membership; clients can insert and read but never delete.
- **The AI never decides or saves.** It drafts entries for the owner to confirm, and answers questions
  only with figures looked up on the phone. The Gemini key stays in the serverless function.

## Deployment

The app is a static Vite build plus one serverless function, set up for Vercel (root directory
`frontend`). Without the function and the environment variables it still deploys as a fully working
local-only app. Steps and checks: [docs/SETUP.md §6](docs/SETUP.md).

## Limitations

- **The numbers are only as good as the entries.** Purchases alone give pattern-based estimates;
  counts make them accurate. The specific limitations are listed in
  [docs/BLUEPRINT.md §J](docs/BLUEPRINT.md) and explained in the app's *bakit* sheets.
- **Data lives in the browser.** Clearing site data removes it. Browsers may not guarantee persistent
  storage (especially in a tab rather than an installed app), so export regularly or use cloud backup.
- **Export on some browsers:** where the browser refuses to share a file (seen on Brave for
  Android), the export falls back to a download, and the app cannot confirm that the file was saved.
- **AI helper:** needs internet, sign-in, and Gemini quota; each account is limited to 30 requests per
  minute and 300 per day.
- **Google sign-in:** while the Google consent screen is in *Testing* mode, only listed test users can
  sign in.
- **Supabase free plan:** an idle project is paused after about a week. The app keeps working and
  syncs again after the project is resumed.
- No push notifications. Pesos only; the catalog is Philippine products.

More detail on what was tested, and on which devices, is in
[docs/VALIDATION-LOG.md](docs/VALIDATION-LOG.md).

## Contributing

Bug reports and suggestions are welcome as GitHub issues. Pull requests are not being accepted at
this time. Please do not post keys, passwords or personal data in an issue.

## License

[MIT](LICENSE) © 2026 RhenGTL. Product names in the bundled catalog are trademarks of their
respective owners and are used only to identify the products.
