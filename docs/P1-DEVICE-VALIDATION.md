# P1 device validation — 2026-09-14

Environment: Android Emulator 36.4.10 · AVD `Medium_Phone_API_36.1` (1080×2400 @420dpi) ·
Android 16 (API 36.1, `google_apis_playstore` x86_64 image) · Chrome 134.0.6998.135 ·
production build served by `vite preview` on the LAN (192.168.1.6:4173) and mapped into the
device via `adb reverse` so `http://localhost:4173` is a secure context. Driven with Playwright
over CDP (`adb forward tcp:9222 localabstract:chrome_devtools_remote`) plus adb/uiautomator for
Chrome's native UI (install dialog, launcher, airplane mode, force-stop).

Not a physical phone: WebAPK minting is unavailable on the emulator, so "Add to Home screen"
produced a Chrome-badged shortcut that still launches in standalone mode (`WebappActivity`).

Passed on device: onboarding, catalog (with aliases), add/edit product, Bumili with natira and
backdated (kahapon) purchase, lugi prompt, Bilang mode (packs+loose, 4-digit entry), Bahay list,
Paninda, bakit (Tier A and Tier B), Burahin/Ibalik, export (share sheet intercepted), import ×2
(no duplicates: 58/58/58 events), settings, refresh, close/reopen, app switch, force-stop and
relaunch from the icon in airplane mode, no horizontal scroll, all buttons ≥ 44 px.

Fixed during validation: soft keyboard covered bottom sheets (viewport
`interactive-widget=resizes-content`); catalog search missed "coke"/"canton"/"bigas" (aliases +
normalized multi-term match); inconsistent-count hint was only in bakit (now on the row, per §D);
list rows/nudge/✕ touch targets < 44 px; persist-storage hint wording.

Known: `navigator.storage.persisted()` is false for the shortcut install on this emulator — the
app relies on the monthly export nudge; Chrome grants persistence to WebAPK installs / engaged
sites on real devices. Home-screen icon is a plain amber square (no glyph).

## Physical device (2026-09-14)

realme RMX3710 (realme C55), Android 15 / API 35, 1080×2400 @ 408 dpi, USB debugging. Chrome is
user-disabled on this phone, so the run used **Brave 1.94.121 (Chromium 152.0.7977.83)**. Same
setup: `vite preview --host 0.0.0.0 --port 4173` + `adb reverse tcp:4173 tcp:4173`; real taps via
`adb shell input`, state read via CDP (`adb forward tcp:9222 localabstract:chrome_devtools_remote`).

Passed on the phone: onboarding, catalog search ("coke"), custom 70-char name, Bumili with natira
+ Kahapon + confirmation sum + lugi prompt, Gboard numeric keyboard on ₱/natira fields (viewport
shrinks 794→510 px, focused field stays visible), native date picker on "Ibang araw", Bilang numpad
by real taps, Paninda/detail, Burahin/Ibalik, native `confirm` dialog, export → import ×2
(57/57/57), refresh, Brave close/reopen, app switch (tab state kept), force-stop, offline relaunch
with airplane mode on **and** `adb reverse` removed (SW-served, 11 products / 6 rows intact),
swipe scrolling, no horizontal overflow (423/423) on all tabs, Tier A never red / no on-hand
wording / limitation text in bakit, no-data row shows "?".

Fixed: `.btn.ghost` ("Itinigil na paninda", "Tapos", "Subukan ang demo", "Ipakita") and `.chip`
(restock-day pills) were 40 px tall — raised to the tap size. Service-worker `autoUpdate`
delivered the rebuilt assets to the phone with data intact.

Not verifiable here: Brave offers "Install app" and registers the shortcut as standalone
(`webapp_display_mode=3`), but the realme launcher never places the icon (also when added by
hand), so standalone/WebAPK behaviour and `persisted()` for an installed app remain untested on a
physical phone; in-tab `persisted()` is false. Chrome for Android itself was not exercised
(user-disabled on this phone). The export share sheet was intercepted to capture the file, so the
real share target (Files/Drive/Messenger) was not tested.

## P2 physical validation (2026-09-14)

Same phone and setup (realme C55, Android 15, Brave 1.94 / Chromium 152, `adb reverse`, real taps
and typing via `adb shell input`, state via CDP). Demo store loaded through the app's own confirm.

Passed on the phone: Listahan (total, balances, `sobra ₱X`, archived list), customer detail
timeline with Burahin/Ibalik, Bayad ₱50.25 with Gboard (viewport 794→510, field and confirmation
visible), FIFO oldest-unpaid after payments, overpayment → `sobra ₱60` and excluded from the
store total, edit (long name), Itigil, FAB Utang with inline new customer, ₱35.50 exact, long
note, Kahapon backdating, invalid amounts (0 / 12.345 / 00) blocked, Gastos with category, decimal,
note and *Ibang araw* date, cash counts (prefill 1,000 → 3,410 → empty at 7 d → 3,600 after
Ibalik; a backdated count never overrides a later one), Ulat weeks (Mon–Sun, sums checked by
hand), Tantiya ~₱ rounded to 10 from the 7 Tier B products only, budget greedy order / ≥ 1 pack /
`Kulang ₱Y`, list quantities unchanged by the budget, export → import ×2 (146/146/146) plus a
P1-format file (0 added), reload, background/reopen, app switch, force-stop, offline relaunch with
airplane mode and the USB mapping removed, no horizontal overflow, real swipe scrolling.

Fixed: the "Dala ko ₱" input and the "Wag muna" toggle were 23 px / 18 px tall (now the tap
size); the archived-customer counter said "may utang pa" for a credit balance (now "may balanse
pa"). P1 spots re-checked: Paninda, catalog "coke", Bumili confirmation, Bilang numpad, Bahay
rows.

Not re-tested and unchanged from the P1 limitations above: home-screen install / standalone
(WebAPK) behaviour — the realme launcher still does not place the Brave shortcut; a real
share-sheet target for the export (the share was intercepted to capture the file); Chrome for
Android (user-disabled on this phone). Backdating used real *Kahapon* taps and a programmatically
set `input[type=date]`; the native date picker itself was exercised in P1 only.

## P3a + language physical validation (2026-09-25)

realme RMX3710 (realme C55), Android 15, 1080×2400 @ 408 dpi, **Brave 1.95.104 (Chromium 153)**;
production build (`npm run build`) served by `vite preview --host 127.0.0.1 --port 4173` with
`adb reverse tcp:4173 tcp:4173`; real taps/typing via `adb shell input`, state read over CDP
(`adb forward tcp:9222 localabstract:chrome_devtools_remote`). Only demo/test data on the phone.

Language: Taglish by default on a device with no stored preference (`html lang=tl`, no `meta.lang`
row); the English chip switches every screen instantly without a reload; the choice survives a
reload, a force-stop + relaunch and an offline start; switching back to Taglish is immediate.
English checked on Bahay/Paninda/Listahan/Iba pa, Bakit, Bilang, Bumili, the four Pera sheets, the
Ulat card, the cloud card, the claim-choice sheet and both sign-in/sync error states: no
horizontal overflow (423/423 on every tab), no clipped labels, every tap target ≥ 44 px, and the
focused field stays visible with Gboard open (viewport 794 → 510/476). Business data was
byte-identical across switches (27 products / 164 events; only `meta.lang` was added).

Workflows re-run on the phone in English: add product (custom name), Bumili with natira and the
confirmation sum, Bilang numpad (1 case + 4 bote = 16), product detail + history, Bakit, Utang
₱35.50 and Bayad ₱20 with the running balances, customer history, Gastos (₱0 rejected with the
English message, then ₱120.75), cash count ₱3,410, Ulat.

P3a on the phone (test account `tindabot-test-a@example.com`, store `test-step6-…`, archived
afterwards): signed-in card, claim-choice sheet ("Which store do you want to use?"), *Use the one
in the cloud* → the cloud store and its rows were restored and became current while the phone's own
stores stayed untouched, a count recorded on the phone reached the server (seq 338), an expense
recorded while offline queued as "1 entry is not backed up yet" and went up on reconnect (seq 339),
and sign-out kept every store and entry on the phone. The Google button really does redirect to
Google's account chooser; no account was chosen (the phone's Google accounts are personal), so the
consent step and a real PKCE return remain untested. The signed-in session used for the rest was a
real Supabase session for the test account (email/password, the same path the online suite uses).

Offline: with `adb reverse` removed and Brave force-stopped, the app still started from its service
worker, showed all data, recorded a cash count and survived a reload — no server, no cloud.

Fixed during this run: **Export did nothing on this phone.** `navigator.canShare({files})` answers
true and `navigator.share` then rejects with `NotAllowedError`, which the app swallowed as
"cancelled". The export now falls back to a download (only a real `AbortError` means cancelled),
and the download link is placed in the document with the blob URL revoked later — four tests in
`src/ui/__tests__/export_file.test.ts` cover it.

Still not working on this phone (browser/device level, outside the app): Brave refuses file shares
(`NotAllowedError`). Every download attempted during this run also ended as "1 download failed" —
**that part was later traced to the harness, not to the device; see the 2026-09-28 section below.**
The list *text* share works (the Android chooser opens). Home-screen install /
standalone behaviour is unchanged from P1/P2: Brave offers it, the realme launcher never places
the icon.

## Cloud-resilience + UI pass validation (2026-09-25)

Same phone and setup as above (realme C55, Android 15, Brave 1.95.104, `vite preview` +
`adb reverse`, real taps via `adb shell input`, state over CDP). Desktop widths were checked
headlessly against the same build (Chromium 1280×720, 1366×768, 1440×900, 1920×1080) together with
360×800 / 393×852 / 412×915 mobile widths, in both languages.

Cloud unavailable: with every `/rest/v1/` call answered the way a paused project answers (540), the
phone showed the new state — "Pansamantalang wala ang cloud backup. 10 entry ang naka-antay —
ligtas lahat sa phone." / "Cloud backup is unavailable right now. 10 entries are waiting — all safe
on this phone." — with no provider text, a yellow status pill, and the app fully usable: a ₱1,875
cash count recorded during the outage landed locally and joined the queue (164 → 165 events).
Lifting the interception and tapping *Sync now* converged to "Backed up · last sync just now" with
nothing lost or re-entered. The same path was also verified end-to-end headlessly (paused → queue →
recovery) and by unit tests.

Export bookkeeping: tapping *I-export* on the phone reached the download route (the share was
refused) and reported it as started rather than as a finished backup. The bookkeeping this run
recorded — `last_backup_at` untouched, `last_export_attempt_at` written — was the semantics in force
at the time; it was replaced on 2026-09-28 (see below) once the download itself was shown to work.

UI pass: all four tabs and the sheets were re-checked in Taglish and English — no horizontal
overflow (423/423), nothing outside the screen, every tap target ≥ 44 px, no clipped labels, every
button with an accessible name, and the expense sheet plus its focused field staying above Gboard
(viewport 794 → 510). Language still switches instantly, survives a reload and a force-stop, and no
local data changed (27 products / 165 events). Desktop: the app keeps its single centred column
(620 px at ≥ 1024 px) framed against the page, sheets open centred as dialogs, and the FAB moves
outside the column above 900 px.

Known and unchanged: Brave on this phone refuses file shares; home-screen install / standalone still
does not happen on the realme launcher; the FAB overlaps list content while scrolling (ordinary FAB
behaviour on the phone). (The download claim in this paragraph was corrected on 2026-09-28 — see the
export diagnosis section below.)

## Sheet drag + Show/Hide (2026-09-25, same phone)

The handle on top of every sheet was decorative — there was no gesture code in the app at all.
The shared `Sheet` now takes a pointer drag on the grip only: the sheet follows the finger down,
resists upward (÷4, capped at 24 px), and on release closes past `max(64 px, 25 % of the sheet)` or
a flick (≥ 32 px at ≥ 0.5 px/ms), otherwise springs back. Content scrolling, forms and the keyboard
are untouched because only the grip has `touch-action: none`.

Validated with injected touch events (`input motionevent`, sampling the sheet mid-drag) on all
twelve surfaces that show the grip — Bumili picker and form, Bilang, Pera ×4 (utang/bayad/gastos/
pera), AddProduct, Paninda detail, Bakit (stacked on the detail sheet), Listahan customer, Ulat
history: each followed the finger within a pixel, dismissed past the threshold, sprang back from a
40 px pull, and survived a 120 px upward drag. A real swipe inside a sheet body still scrolls it
(AddProduct 0 → 355 px, Ulat 0 → 582 px) with no sheet movement; a sheet whose field had the
keyboard open still drags away; the backdrop still closes sheets; Escape still closes them on
desktop.

Two defects found during this pass and fixed:
- **`max-height: 92vh` is the toolbar-hidden height on Android**, so the tallest sheet (Ulat
  history, 826 px) started 32 px above the visible viewport and its grip could not be touched.
  Now `92dvh` where supported: the same sheet is 731 px with its top at 64 px.
- **A drag that ended over a control tapped it** — releasing over the "Kailan mo binili?" row
  selected *Ibang araw* and opened Android's date picker. A drag of more than 8 px now swallows
  the click that follows.

Desktop (1280/1366/1440): the sheet stays a centred dialog, the grip is hidden there (a bottom-sheet
affordance has no meaning for a centred dialog), a mouse drag from the top edge does nothing, and
Escape still closes it.

Show/Hide in *Iba pa → Advanced* was plain underlined text; it is now the same disclosure
convention as the "Wag muna" section on Bahay — a filled `btn secondary sm` with the state word and
a ▼/▲ arrow, `aria-expanded` + `aria-controls`, 44 px tall, in both languages ("Ipakita ▼" /
"Itago ▲", "Show ▼" / "Hide ▲"). Verified with real taps on the phone and with the keyboard on
desktop.

## Google sign-in — the real consent round trip (2026-09-28, desktop localhost preview)

Owner-run manual test. This is the one part of P3a that cannot be automated: a real Google account
has to be chosen and consent granted, and faking the flow was ruled out. Environment: the production
build (`npm run build`) served by `vite preview --host 127.0.0.1 --port 4173` and opened at
`http://localhost:4173/` in a **private window on the desktop** — a fresh storage partition, so no
existing store could be claimed. The browser brand was not recorded. **Option 1**: the current store
was the `local_only` demo, so by design nothing could be uploaded.

Checked non-interactively first: the project answered (Google provider enabled, new signups not
disabled); the built bundle inlines only the project URL and the anon key; the Cloud card offers
*Mag-sign in gamit ang Google*; clicking it really navigates to Google's account chooser with
`response_type=code`, scope `email profile` and `redirect_uri` = the project's `/auth/v1/callback`,
with a PKCE code-verifier written to storage before leaving; and the return leg's failure branch
works (a provider `access_denied` shows the cancelled message and the parameters are stripped).

Verified by the owner in one pass: Google showed its **consent screen**; the browser came back to
`http://localhost:4173/` with a **clean address bar** — no `code`, no `error`, no fragment, i.e.
supabase-js exchanged the code and removed it; the Cloud card showed **`Naka-sign in: <the owner's
Google address>`** together with **`Demo — hindi naka-sync sa cloud.`**; no error text anywhere;
*Mag-sign out* returned the card to *Mag-sign in gamit ang Google*; and after a reload the demo store
and all its rows were still present. The whole chain is therefore manually verified: account
selection → consent → Supabase callback → PKCE exchange → authenticated session in the app →
sign-out with local data intact.

Deliberately **not** covered by this run, by owner decision (Option 2 was not performed): **claim and
upload under a Google identity remain unverified.** Everything downstream of the session — the claim
decision, the first upload, push/pull, the choice sheet — is still verified only with the
email/password test accounts (2026-09-25 section above), never under a Google-created user. No cloud
rows were created here: no store, no products, no events. The only server-side effect is that the
owner's own Google identity now exists as a user in the project.

Still open from this area: the stale-`?code=` edge case (a return with no matching PKCE verifier —
different browser or cleared storage — is silently ignored by `@supabase/auth-js`, so the app shows
no message and the parameter stays in the address bar). Deferred deliberately; it produces no session
and touches nothing.

## Export / download diagnosis (2026-09-28, same phone)

realme RMX3710 (realme C55), Android 15, **Brave 1.95.104** (UA Chrome/153), 1080×2400 @ 408 dpi
(423 × 794 CSS px). Diagnosis only; the app was not modified during it.

**The earlier "every download fails" conclusion was wrong.** Brave on this phone is set to ask where
to save each file: a modal *"Choose where to download"* (filename · Downloads · Don't show again ·
Cancel · **Download**) appears and waits. It is drawn inside Brave's own activity, so the window
focus never changes and the automated harness never saw it, never answered it, and the pending
download was then cancelled — which is what produced "1 download failed". A second artefact: while
a debugger is attached over CDP the dialog does not appear at all and the download fails instantly,
so download checks must be run with nothing attached.

Answering the prompt saves the file. Measured here: `http` + `Content-Disposition`, `blob:`, `data:`,
a download 1.5 s after the tap, and the app's own share→reject→download sequence all saved. The app's
*I-export* produced **`/sdcard/Download/tindabot-2026-09-28.json`, 38,104 bytes**, valid JSON with
`format, version, exported_at, device_id, store, products, customers, events` for the demo store
(12 products / 101 events). Brave's own history shows 16 successful downloads on this device,
the most recent a 29 MB file on 2026-09-26. Storage: 144 GB free; `/sdcard/Download` writable.

**Still true:** `navigator.share({files})` answers `canShare` with `true` and then rejects with
`NotAllowedError: Permission denied`, reproduced with *and* without a debugger attached. Text sharing
works. `navigator.storage.persisted()` is still `false` (2,211 KiB used of a 2,048 MiB quota) — a
separate durability observation, unrelated to the export path.

**Semantics decided from this (2026-09-28):** `last_backup_at` is written when the app has handed the
export over — a resolved `navigator.share` **or** a download it successfully started. The app never
claims the file reached disk: a web page cannot observe where a download lands or how the browser's
save prompt ends, and the toast says so ("Ipinasa na sa browser — baka tanungin ka pa nito kung saan
i-save." / "Handed to your browser — it may still ask you where to save it."). A route that could not
be started marks nothing. Covered by six tests in `src/ui/__tests__/export_file.test.ts`.

The old `last_export_attempt_at` meta key is no longer written by anything. Devices that exported
under the earlier bookkeeping still carry the row, so Dexie schema version 3 deletes that one key
while it opens the database — no other meta value, and no business data, is touched. Covered by
`src/db/__tests__/migration.test.ts`.

## Years of data — recompute cost on the phone (2026-09-28, realme C55 / Brave)

Every write recomputes the whole store from its full active event log (BLUEPRINT §B). Until now
that was only ever measured on the validation store's 165 events, so a store's second and third
year were unverified. Measured on a **throwaway origin** (`127.0.0.1:4173`, its own storage; the
validation store on `localhost:4173` was not used for this) seeded with a fixture of **200 products,
40 customers and 19,585 events ≈ two years** of daily use:

| | before | after |
|---|---|---|
| open the app → first cards on Bahay | 3,264 ms | **1,981 ms** |
| longest main-thread block (the recompute) | 1,705 ms | **433 ms** |

Every save blocks on the same recompute, so that block was also the per-tap freeze. The cause was
not the recompute itself but how it read the log: it was re-scanned once per product and, in the
weekly summaries, once per customer per week. Desktop measurements of the same fixture sizes:

| fixture | recompute before | after |
|---|---|---|
| 60 products, 4 months (3.2k events) | 37 ms | 14 ms |
| 120 products, 1 year (9.8k events) | 85 ms | 32 ms |
| 200 products, 2 years (19.6k events) | 383 ms | 46 ms |
| 300 products, 3 years (29.4k events) | 634 ms | 123 ms |

The fix groups the active log by product and by customer once per recompute (`stockEventsByProduct`,
`ledgerByCustomer` / `deriveCustomers`) and parses each timestamp once when sorting. The rule itself
is unchanged — still a full recompute from the full active list, never incremental — and the outputs
are identical: `src/domain/__tests__/grouping.test.ts` holds the grouped path against the scanning
one over randomized logs, and on the phone every screen of the real validation store (165 events,
27 products, 5 customers) rendered byte-identical text before and after, with no page errors.

### Accepted after the fix — measured, decided, not blockers (owner decision, 2026-09-29)

Two costs were measured at the same ~19,585-event / 200-product scale on the same realme C55 and
are **accepted as they stand**. Both are correct, neither loses data, and neither is a release
blocker; both remain candidates for a future optimisation if a real store ever reports the wait.

| Measured | At that scale | Decision |
|---|---|---|
| Opening the app | **~2 s** to the first cards | **Leave as is.** |
| — of which the IndexedDB read of the whole event log | **~1.3 s** (derivation is no longer the cost) | **Leave as is:** no cached derived snapshot, no windowed event loading. The full active event log stays the single source of truth and every recompute keeps reading all of it. |
| Loading / importing the 19,585-row fixture into the phone's IndexedDB | **~7.6 s** | **Leave as is:** no chunked import, no progress UI. Import stays exactly as it is — correct, idempotent, and slow on a very large file. |

Recorded as accepted limitations and future optimisation/UX candidates. Nothing in this repository
is approved for architectural remediation of either one: a cached snapshot, windowed loading,
chunked import or import progress would each need the owner's explicit approval first.

## Startup failure modes — what a person sees when the local database will not open (2026-09-29)

Verified headlessly against the production build (Chromium, three fresh contexts per case), because
the app's whole promise rests on that database and a schema upgrade now exists that could be met by
an older cached bundle. No code was changed for this; one case is an open question for the owner.

| Case | What happens | Verdict |
|---|---|---|
| The database is at a **higher version** than the running bundle (a cached older bundle after an upgrade) | Dexie opens it anyway; the store and its data render normally (verified with a real store row and an IndexedDB version far above the schema) | **Safe** — the v3 upgrade creates no downgrade hazard |
| **Two tabs** across the upgrade: an older tab holds version 2 open while a new tab must upgrade | The new tab shows the loading ellipsis while IndexedDB blocks the upgrade, then **recovers by itself** the moment the other tab closes — no reload needed, upgrade completes, the stale meta key is dropped as designed | **Safe** — transient and self-healing |
| A **write fails** mid-session (storage full, storage revoked) | Was silent: no false "saved", but nothing said either. **Fixed 2026-09-29** — a failed write now shows *"Hindi na-save. Subukan ulit." / "Not saved. Please try again."*, the success toast is skipped, and the browser's error goes to the console | **Fixed** |
| **IndexedDB is denied or missing** (site data blocked for the origin, some embedded/WebView contexts, a corrupted profile) | Was the loading ellipsis `…` **forever**, with an unhandled `DatabaseClosedError` and nothing to act on. **Fixed 2026-09-29** — an error screen explains that the local storage cannot be opened, names the one thing to check (allow site data and cookies; no private/incognito browsing) and offers *Subukan muli / Try again*, which really re-opens the database | **Fixed** |

### How the two failures are handled (2026-09-29, owner-approved)

`init()` opens the database explicitly (`repo.openDatabase()`) and treats a refusal as state, not as a
rejected promise: it logs the browser's exception to the console, closes the connection — Dexie keeps
a failed open on the instance and will not auto-open a closed one, so a retry must start clean — and
sets `storageError`, which the UI shows instead of the loading dots. *Retry* simply calls `init()`
again and succeeds as soon as the browser allows storage, with the existing successful start
untouched. Writes go through one guard (`src/ui/write.ts`, used as `useWrite()` in every screen that
writes): it awaits the write, skips the caller's success toast on failure, shows the app's own "not
saved" wording, and puts the reason in the console only.

Verified against the production build: both refusals render the error screen with no endless dots and
no browser error text on screen; *Retry* recovers once storage is allowed and stays usable when it is
still refused; a healthy start and a full onboarding are unaffected; and, with the storage layer made
to refuse writes, a recorded cash count produces the failure toast in Taglish and in English while a
healthy one still produces *"Naitala…" / "Recorded…"*.

One write is deliberately **not** guarded: dismissing the monthly backup nudge (a device preference
written by `setMeta('nudge_dismissed', …)` on Bahay). A toast there would be noise, and the only
consequence of a failure is that the nudge reappears. Separately, clearing site data while the app is
open does not fail writes at all — Dexie recreates the database and later writes land in the new,
empty one; the app shows onboarding on the next reload. That is a different scenario from these two
and was not part of this change.
