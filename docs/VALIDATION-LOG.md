# Validation log

A dated record of how each phase was checked on real devices and on the hosted deployment, kept
as evidence alongside the automated tests. "The owner" is the project maintainer; every cloud test
used dedicated `tindabot-test-*@example.com` accounts or a throwaway local store. Findings that
still affect users are summarised under *Limitations* in the README.

## P1 device validation (2026-09-14)

Environment: Android Emulator 36.4.10 · AVD `Medium_Phone_API_36.1` (1080×2400 @420dpi) ·
Android 16 (API 36.1, `google_apis_playstore` x86_64 image) · Chrome 134.0.6998.135 ·
production build served by `vite preview` on the local network and mapped into the
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
upload under a Google identity remain unverified.** (Verified afterwards, 2026-09-29; see the claim
and upload section below.) Everything downstream of the session — the claim
decision, the first upload, push/pull, the choice sheet — is still verified only with the
email/password test accounts (2026-09-25 section above), never under a Google-created user. No cloud
rows were created here: no store, no products, no events. The only server-side effect is that the
owner's own Google identity now exists as a user in the project.

Still open from this area: the stale-`?code=` edge case (a return with no matching PKCE verifier —
different browser or cleared storage — is silently ignored by `@supabase/auth-js`, so the app shows
no message and the parameter stays in the address bar). Deferred deliberately; it produces no session
and touches nothing.

## Claim and upload under a Google identity (2026-09-29, desktop localhost preview)

Owner-approved ("Option 2"), closing the gap left above. The demo store could not be the source: it
is `local_only` and by design is never uploaded or claimed (`claim.ts`, decided 2026-09-15). The
phone's validation store was not usable either: it is tied to the email/password test accounts
from the earlier phone runs, and it had to stay untouched. (A read-only check on 2026-09-29 found
that the test accounts own only `test-…` stores, all archived. So whether that phone store still
has an active cloud copy was not established.) By owner decision, a **fresh, clearly labelled
store** was used instead.
Environment: the production build served by `vite preview` at `http://localhost:4173/`, opened in
desktop Edge 154 with a separate, empty throwaway profile (not the owner's browser profile).

Before sign-in, through the normal UI: onboarding created a real store, *Google claim check*. It got
2 catalog products with starting counts, 1 purchase with natira, 1 customer with 1 utang and 1
bayad, and 1 expense: 2 products, 1 customer, 7 events (3 COUNT, PURCHASE, UTANG, BAYAD, EXPENSE),
none synced. The owner then signed in with their real Google account (consent screen) in that
window. Nothing was faked and no step was bypassed. The app took its own path: the account owned no
cloud store, so the decision was `upload`, with no choice sheet.

Observed (IndexedDB read directly; the cloud read with the app's own session inside the page, so RLS
applied exactly as for the app; only counts and comparisons were printed, never a token, the email
or the user id):

| Check | Result |
|---|---|
| Return from Google | address bar clean (no `code`, no fragment); session provider `google` |
| Local store after sign-in | same store id, same product/customer/event ids as before |
| Local markers | `cloud_store_id` = current store; `auth_user_id` = the session's user; `claim_pending` absent; `last_sync_error` absent; `last_sync_at` set; three cursors set; 0 unsynced events, 0 dirty records |
| Cloud store | exactly 1 visible and active; `created_by` = the session user; one membership, role `owner`, the session user |
| Cloud rows | products 2/2, customers 1/1, events 7/7; id sets identical to local; no missing, no extra, no duplicate ids |
| Cloud contents | every row's `body` equals the local object (storage-only markers removed); event `type`/`ts`/`store_id` columns and record `updated_at` match: 0 mismatches |
| Further syncs | focus-triggered runs, then a manual *Sync now*: `last_sync_at` advanced and cloud counts stayed 7/7 |
| A new entry after binding | 1 expense added → pushed once: events 8/8, ids identical, 0 content mismatches |
| Reload | same store, still bound to it and to the same user, status *Backed up*, cloud still 8/8 |
| Sign-out | one `logout` request with `scope=local`; session gone from storage; card back to *Sign in with Google*; store, 2 products, 1 customer and 8 events unchanged (identical ids), also after a reload; onboarding not shown |

The card showed *Syncing…* briefly several times. Each time it was a run started when the probe
attached to the tab (sync on focus), and it settled to *Backed up* within seconds. No page errors.

After sign-out the binding markers (`cloud_store_id`, `auth_user_id`, cursors) are kept, which is the
existing behaviour. The engine reuses them only for the same user; another account discovers
again. Not exercised here: the choice sheet under a Google identity, and a second device pulling
this store.

Left in place: the owner's Google account now owns one active cloud store, *Google claim check*,
with 2 products, 1 customer and 8 events. It was not deleted, and the test-account cleanup script
does not apply to it. When the owner later signs in with a populated real store, the app will ask
which store to keep. Keeping the phone's store archives this one (a flag; nothing is deleted).

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

## Data integrity under interruption — import (2026-09-29)

An import used to be written in two transactions: the records first, the events after. An
interruption in between — the tab closed, the device out of space, storage revoked — left it half
applied. In `replace` mode (BLUEPRINT §E: the only destructive local path) that was worse than half,
because the first thing it does is delete the store being replaced: reproduced with event writes made
to fail at exactly that point, the person's store, product and both events were **gone** and the
imported store arrived with no history at all. Merge mode left records updated with the imported
events missing.

**Fixed:** the whole import, events included, now runs in one transaction (`repo.importFile`), so an
interrupted import leaves the database exactly as it was. Re-importing the same file afterwards
completes normally and stays idempotent (write-once by event id inside that one transaction).

A second, separate defect surfaced in the same run: the *replace* branch of Iba pa's import ran inside
the merge branch's `catch` with no error handling of its own, so when the destructive import failed the
person was told **nothing**. It now reports the existing *"Hindi na-import ang file." / "The file could
not be imported."* message, with the reason in the console.

Verified through the built app on the throwaway origin: a store with two recorded cash counts, an
import of a file from a different store, event writes failing partway → their store, history and
current-store pointer all unchanged, the failure toast shown, the app still usable, and the same file
importing completely once writes worked again (`stores: ["Someone Else Store"], events: 2`). Covered by
`src/db/__tests__/import_atomic.test.ts` (4 tests) plus the import-message mapping in
`src/ui/__tests__/write_guard.test.ts`.

**Import validation (owner decision, 2026-09-29):** `isExportFile` now also requires the file's *store*
to be one the app can open — `id`, `name`, `restock_days`, `multipliers.payday`, `multipliers.fri_sat`
and `updated_at`, with `next_trip_override` optional. These are the fields derivation and the screens
actually read (`list.ts`, Bahay, Iba pa), and they are the same ones the cloud decoder insists on
(`sync/codec.ts` `rowToStore`). The check runs in `importJson` before `repo.importFile`, so a file the
app could not open is refused **before** replace mode deletes anything, and it reuses the existing
*"Hindi ito TindaBot export file." / "This is not a TindaBot export file."* message. Contents beyond the
store are still not validated: amounts and quantities are checked at entry (BLUEPRINT §C), and events
the domain does not recognise are simply never derived.

Verified through the built app on the throwaway origin: a malformed export is refused with that
message and leaves the store, its history and the current-store pointer untouched, and the app still
opens their store after a reload; a good file interrupted partway rolls back completely and reports
*"The file could not be imported."*; the same file uninterrupted imports completely (*"Imported: 2 new
entries."*) and opens; importing it again duplicates nothing.

**Left unchanged by decision:** a data-shape failure still reports through the shared storage-error
screen rather than a screen of its own, and multi-tab freshness is untouched — a second tab still does
not learn about the first tab's writes, and refocus re-derives from memory rather than re-reading the
log, which keeps the accepted ~1.3 s read out of the refocus path.

## Release lifecycle — a new version reaching an open app (2026-09-29)

How every future fix reaches a phone had never been exercised end to end, so two consecutive
production builds were served from a throwaway origin and swapped underneath a running session
(version A `index-4oz9MP1k.js`, version B `index-D1bOUZbQ.js`, distinguishable in the page).

The service worker is Workbox `generateSW` with `skipWaiting`, `clientsClaim` and
`cleanupOutdatedCaches`, and the injected `registerSW.js` only registers — **it never reloads the
page**. Measured behaviour, all as intended:

| Moment | What happens |
|---|---|
| Version B released while the app is open | The new worker installs, precaches B and drops A from the cache, and takes control — **the open page is not reloaded from under the person** and keeps running A |
| Recording during that window | Still works; their entries are untouched (verified before and after the swap) |
| Next reload | Version B, confirmed by both the bundle hash and the new code running |
| Offline immediately after the update | The app starts on B from the precache, shows their entries, and records new ones |

Consequence worth knowing rather than fixing: a person keeps the version they loaded until they
reload, and the old bundle is evicted from the cache as soon as the new worker activates. With one
bundle and no code splitting, nothing the running page needs is fetched again, so this window is
harmless today; it would stop being harmless if the app were ever split into lazily loaded chunks.

## Everyday interruptions (2026-09-29)

Driven through the built app, with the entry sheets:

| Interruption | Result |
|---|---|
| Reload with a half-filled sheet | The app comes back up; the unsaved entry is simply gone, never half-written |
| Double tap on save | Exactly one entry recorded (the `saving` guard plus write-once by event id) |
| Reload the instant after tapping save | The entry is either fully there or not at all; nothing else damaged |
| The same amount entered again on purpose | Kept — a fresh id per sheet opening, so deliberate repeats are not swallowed |
| **The phone's back button with a sheet open** | First press dismisses the keyboard (Android's own behaviour). The next press **closes the tab and drops to the launcher** — the app never takes a back press, because no sheet pushes a history entry (`history.length` was 1) |

Nothing was corrupted by any of these, but an open sheet was lost with the tab.

**Fixed (owner decision, 2026-09-29): a bottom sheet now takes the back press.** The shared `Sheet`
component adds one history entry when it opens and hands it back when it closes by any other route,
so back dismisses the sheet; with no sheet open nothing is registered and back is the browser
navigation it always was. The URL never changes, tabs get no history entries, and the OAuth callback's
`replaceState` is untouched. The rule itself lives in `src/ui/sheetHistory.ts` behind a small port, so
it is tested without a DOM (`src/ui/__tests__/sheet_history.test.ts`, 10 tests).

Verified on the phone against the production build: opening the cash sheet gives it its own history
entry; the first back press still dismisses the keyboard (Android's own behaviour) and the next closes
the sheet with the app still on screen in Brave; reopening behaves the same; closing with the sheet's
own backdrop hands the entry back; and with no sheet open, back is again ordinary browser navigation
(it left the page). Headlessly on the built app, 17 further checks: exactly one entry per opening,
no further entries while typing in it, four open/back cycles leaving the history where it started,
tab switches adding no entries, and a reload with a sheet open coming back with no sheet and no stale
marker.

**Edge cases worth knowing:** a reload while a sheet is open leaves one spent entry behind — its marker
is cleared at startup, so nothing mistakes it for an open sheet, but that first screen needs one extra
back press. And the FAB's quick-action panel is not a `Sheet`, so it does not consume back; the
back press there still leaves the app.

## Release-readiness audit (2026-09-29)

Checked against the tests and the code rather than against this document. Three areas had claims with
no direct evidence behind them; all three were verified now.

**The client carries nothing privileged.** The production build was scanned (648,872 characters of
js/html/css/json): it contains the project URL and the publishable key from `frontend/.env.local` and
nothing else from any env file — no test-account email or password, no `service_role`, no
`client_secret`, no private key, and no JWT of any kind. The key in the build is a publishable
(`sb_publishable_…`) key, not a secret one. The only occurrences of the word "password" are
supabase-js' own identifiers (`weak_password`, the `signInWithPassword` body), and the only
`sb_publishable_` mention in a build without configuration is the library's own prefix check. Both
env files are git-ignored and untracked.

**A build with no cloud configuration really is local-only.** Built with the env vars empty: the
output contains no supabase host and no key at all, and the app onboards, records a cash count, and
offers export/import as usual, while the cloud card reads *"Cloud backup is not available in this
build. Everything still works on your phone."*, no sign-in appears anywhere, and the page makes no
request off its own origin.

**The auth wrapper's own rules are now covered offline** (`src/sync/__tests__/auth_api.test.ts`, 9
tests): which supabase-js events mean "this is who is signed in" (`SIGNED_IN`, `INITIAL_SESSION`,
`TOKEN_REFRESHED`, `USER_UPDATED`), which mean nobody (`SIGNED_OUT`, and an initial event with no
session), which are ignored, that the subscription is dropped when the app stops listening, that
signing out uses `scope: 'local'` so it never ends the owner's sessions elsewhere, and that a failed
sign-out surfaces as a `CloudError` with the right category instead of being swallowed. Until now
only the online suite touched this path.

## Leaving the demo, and several stores per phone and account (2026-09-30)

Owner decisions of 2026-09-30, recorded in BLUEPRINT (*Leaving the demo*; §E7 *Claim*, *Stores*,
*Delete*). The two-store **claim-choice sheet** described in earlier sections of this log
("Which store do you want to use?", *Panatilihin ang nasa phone* / *Gamitin ang nasa cloud*) **no
longer exists**. Those entries are kept as the record of what was verified at the time.

What changed:
- **Leaving the demo:** *Demo ito.* on Bahay and Iba pa, with *Simulan ang sariling tindahan* when
  the phone has no real store, else *Bumalik sa ‹name›*.
- **Stores list** in Iba pa: switch, delete with confirmation, add (onboarding with a way back),
  and at most one demo.
- **Sync:**
  - A real store missing from the cloud is uploaded as one more store of the account.
  - The account's other stores are pulled in without switching.
  - A deleted store is archived in the cloud (queued while offline) and never pulled back.
  - A store archived elsewhere is not re-uploaded.

Verified:
- Offline suite: 375 tests. New or updated:
  - `claim.test.ts`: 9;
  - `engine.test.ts`: 41, including 7 multi-store scenarios;
  - `stores.test.ts`: 9;
  - `demo_exit.test.ts`: 5.
- Mutation checks: pulling deleted stores back, not archiving them, un-archiving a store deleted
  elsewhere, and opening onboarding at the products step. Each made a test fail.
- **Online suite against the real project, test accounts only:** 21 passed, 1 skipped (the
  race test needs the optional `test_helpers.sql`, which is not installed). This includes three new
  multi-store tests: both stores are kept, delete archives in the cloud with every row kept, and a
  store archived by another client is neither un-archived nor re-uploaded.
- **Real UI** on the local production preview (fresh storage, 360 px, headless Chromium):
  - create two stores, and back out of a third onboarding;
  - switch;
  - open the demo once;
  - delete another store and then the current one; with only the demo left, onboarding opens at
    the store-name step;
  - "Subukan ang demo" reopens the same demo.

  No overflow and no page errors. The leaving-the-demo flows were also checked in English.

## P3b / P4 / P5 on the validation phone (2026-10-01 → 2026-10-07)

Installed app (Brave home-screen shortcut, realme C55), signed in with the owner's Google account,
in a store named "Testing" that the owner created for this and deletes afterwards. Driven over adb
DevTools; the AI calls went to real Gemini through the deployed `/api/ai`.

Verified on the phone:
- **Supplier prices:** Coca-Cola bought at Puregold ₱600 and Alfamart ₱648 per case. The product shows
  Puregold ₱50 / Alfamart ₱54 per bote, and in Bumili the Puregold chip prefilled ₱600 instead of the
  latest ₱648.
- **Tally:** 3 Lucky Me sales; stock 30 → 27; *bakit* shows the tallied sales.
- **CSV import:** 2 products added (a `natira` became a count); importing again added none.
- **Utang and money:** utang ₱150, payment ₱50, expense ₱30, cash count ₱1,000; the Utang list and the
  weekly report agree (bought ₱1,248 = ₱600 + ₱648).
- **Isulat (note):** read in 14–21 s. "natira 15 Century Tuna" became a count; an ambiguous
  "Coca-Cola" (the store has two Coke products) stayed unticked until a product was picked; the
  picked row saved as 2 case = 24 bote, ₱1,200, Puregold.
- **Resibo (photo):** a 3-line receipt image read in 19 s; every line matched the right product,
  pack quantity and total (Kopiko 20 sachet ₱160, Lucky Me 24 pack ₱336, Coke Mismo 12 bote ₱216).
- **Tanong:** after the fixes below, answers in 3–4 s and correct: Coca-Cola left (the latest count),
  Test Suki's balance ₱100, Puregold cheaper than Alfamart (₱50 vs ₱54).
- **Household:** the phone made an invite code; test account B joined, saw the store, recorded a sale
  that reached the phone on sync, and could neither rename nor archive the store. The owner removed
  B from the phone; B then saw nothing of the store and the used code was refused.

Found on the phone and fixed:
- **Bilang skipped a product** (since P1): the queue re-sorted after every saved count, so "Susunod"
  skipped one product and showed another twice. The order is now fixed when the sheet opens; checked
  on the phone with 5 products, each counted once. Its closing toast also said one fewer than counted.
- **Assistant timeouts:** the main Gemini model ("thinking") kept the answer round past the time limit,
  and a busy model could not hand a later round to another model. Rounds are now self-contained, a
  slow or busy model hands over to the other, and questions use the light model first.
- **Assistant wording:** internal words ("confidence") reached the owner, a decimal inside a product
  name ("1.5L") raised a false "hindi verified", and replies ignored the app's language. Fixed in the
  prompt and in the figure check; on the phone (2026-10-07) English questions — and a Taglish one —
  were answered in English with the app set to English. A later answer still said "my confidence is
  low", so the rule now names that phrasing too.
- **Supplier names from receipts:** "PUREGOLD PRICE CLUB" was saved apart from the owner's "Puregold".
  A read supplier that clearly is a known one is now mapped to it, and the review has an editable
  supplier field. On the phone the first version kept "PUREGOLD PRICE CLUB", because that exact name
  had been saved once by the earlier receipt test; when several known names fit, the one the others
  contain ("Puregold") now wins. Checked on the phone with real Gemini: all three receipt rows showed "Puregold".
- **Assistant numbers:** answers quoted "20.8 sachets" / "5.9 days" (the lookups carried one decimal
  while the screens show whole numbers). Stock and days left are now rounded in the lookups exactly
  as Paninda and *bakit* round them.
- **A store deleted on another device:** after the owner deleted "Testing" from the PC, the phone said
  "the store is no longer available in the cloud" — as designed (the copy stays, nothing re-uploads) —
  but still offered "Sync now", which then did nothing. The card now explains the situation and offers
  "Delete from this phone" instead (checked in a local browser: message shown, no Sync now, deleting
  the only store opens onboarding).
- **Cleanup script:** run in the SQL editor it failed with `relation "_test_users" does not exist`
  (temporary tables across statements). Rewritten as one block with no temporary tables; it now also
  refuses to run under a restricted role, and removes the test users' 0002 rows.

Two-device sync was then checked by the owner: signed in on the PC browser and deleted "Testing"
there; the phone picked that up as described above.

Push notifications are out of scope (BLUEPRINT §G).

## Hosted deployment checks (2026-09-29 → 2026-09-30)

None of these can be verified locally. The checklist is kept as written; results follow it.

1. Production URL on desktop: loads over HTTPS, no console errors, service worker registered,
   offline reload works, and response headers for `sw.js` / `index.html` revalidate.
2. **Production OAuth:**
   - Google sign-in from the production origin returns to it with a clean address bar, and the
     card shows signed in.
   - Expect the claim behaviour of BLUEPRINT §E7.
   - Sign-out keeps local data.
3. Phone (Brave on the test phone; Chrome stays disabled):
   - install (Add to Home screen / WebAPK) and launch standalone;
   - offline launch;
   - `navigator.storage.persisted()` for the installed app;
   - back button in standalone mode;
   - **Google sign-in started from the installed app** — whether the OAuth return lands back in
     the app or in a browser tab (verified 2026-09-30: it lands in the app; see the results below).
4. Update path: redeploy a changed build, and an open app picks it up on its next reload.
5. Cloud Card on the deployed build is not "not available" (catches the configuration pitfall in SETUP.md §4).

### Results, 2026-09-29 (`tindabot.vercel.app`, commit `179e6fe`)

**What was deployed.** The hosted `index-B5a79SV4.js` is byte-identical to a local build of that
commit. `index.html`, `sw.js` and `icon.svg` differ only in line endings (Vercel builds on Linux).
`/`, `index.html`, `sw.js`, `manifest.webmanifest` and `registerSW.js` are served with
`Cache-Control: public, max-age=0, must-revalidate`, over HSTS. Unknown paths return 404.

**Desktop** (Edge 154, throwaway profile, demo store) — all PASS:
- HTTPS load; app shell; no page or console errors.
- Cloud available: *Sign in with Google*, not the local-only fallback.
- No off-origin requests before sign-in.
- Service worker active and controlling; manifest valid; the browser reports no installability
  errors.
- Offline reload starts the app.
- Update: an open tab on the first deployment got the redeploy on its **second** reload. The
  first reload installed the new worker and swapped the cached bundle; the demo data was kept and
  the old bundle evicted.
- `persisted()` is `false` in a tab.
- **Real Google sign-in from the hosted origin:**
  - It returned to `tindabot.vercel.app` with a clean address bar and a Google-provider session;
    the card showed *Signed in* and *Demo — not synced*.
  - The demo was not bound, and no cloud store was created: the account still has only the
    archived *Google claim check*.
  - Sign-out removed the session; local data was identical, also after a reload.
- The redirect allow-list entry for the domain is therefore confirmed in practice.

**Cloud sync on the hosted origin** (test account A only; two fresh headless browser profiles as
two devices; store `test-hosted-mumo8ew0`) — all PASS:
- Device 1 uploaded, and its rows equal the cloud's.
- Device 2 (demo) signed in and pulled the store, switching to it.
- One entry on each device, then syncs: 4 events on both devices and in the cloud, identical ids,
  no duplicates, nothing pending.
- Test account B got nothing reading A's store, and HTTP 403 inserting into it or archiving it.
- Both devices were closed, then the store was archived. A is back to no active store (233
  archived `test-…` stores); the cleanup script can remove it later.

**Phone** (realme C55, Brave; Chrome still disabled; hosted origin only — the `localhost`
validation data was not touched):

| Check | Result |
|---|---|
| HTTPS load, app shell, cloud available, SW active/controlling, manifest valid, no installability errors, offline reload, no off-origin requests, no errors | PASS |
| `persisted()` in a tab | `false` (recorded; unchanged from before) |
| Back button (tab): the first back dismisses the keyboard, the next closes the sheet, the app stays, and the entry is handed back; root back leaves the page | PASS |
| Install | Brave's *Install and create shortcut → Install* → the launcher's *Add to Home screen* → *Add*. Android lists the shortcut as **pinned**: Brave web-app mode, display standalone, scope = the hosted origin. No WebAPK package. |
| Icon on the home screen | First attempt: **not found** by the owner, although the realme launcher (15.4.30) listed the shortcut as pinned and Brave holds `INSTALL_SHORTCUT`. Resolved 2026-09-30: in the launcher's *Add to Home screen* dialog, **touch and hold the icon and drag it onto the home screen** instead of tapping *Add*. Then it is visible. |
| Icon artwork | **Defect found and fixed** (commit `a2875b7`): `icon-192.png` and `icon-512.png` had been plain orange squares (2 colours) without the 🏪 of `icon.svg`, so the launcher showed a plain tile. They were re-rendered from `icon.svg` (same design and names; no manifest or code change) and redeployed, and the shortcut was removed and re-added. The owner confirmed the icon now looks right. |

**Installed app, launched by tapping the real icon** (2026-09-30, after the icon fix) — all observed:

| Check | Result |
|---|---|
| Launch | PASS: Android's foreground activity is Brave's `WebappActivity` (web-app task), not a tab |
| Standalone | PASS: `display-mode: standalone` true; no address bar or Brave toolbar in the window; the status bar takes the theme colour; origin `https://tindabot.vercel.app`, current bundle |
| Service worker | PASS: controls the page |
| `persisted()` | `false` on the first launch; **`true`** after a full close (swiped from Recents) and reopen from the icon. The app requests persistence at every start, and Brave granted it for the installed app. |
| Close / reopen | PASS: new web-app task, freshly loaded; store, product/customer/event counts and event ids, language and onboarding identical to the baseline; no storage-error or local-only fallback |
| Back | PASS: the first back dismisses the keyboard; the next closes the sheet and the app stays; this holds on a repeat; closing a sheet with its own control hands its entry back. **Root back:** from a fresh start it closes the app to the home screen. Immediately after the sheet test (one forward history entry left from the sheet), the first root back instead reloaded the app at its start screen, and the next one closed it. That reload is Brave web-app behaviour; its cause was not established. No data was involved. |
| Google sign-in started in the app | PASS (owner's Google account, demo store): the owner saw the return land **in the TindaBot app itself**. Afterwards: standalone page, no `code`/error/fragment, provider `google`, demo not bound, no sync error, cloud still only the archived *Google claim check*, no Google/Supabase pages left open. The session also survived Brave being stopped by Android and the app being reopened from the icon. |
| Sign-out in the app | PASS: session removed; data identical (event ids included), also after a reload |
| Real Google sign-in in a Brave tab | PASS: returned to the hosted origin with a clean address and a Google session; demo not uploaded; account still only the archived store; sign-out kept local data, also after a reload |
