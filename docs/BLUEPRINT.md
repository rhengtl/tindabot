# TindaBot — Rebuild Blueprint (Source of Truth)

Status: **approved 2026-09-13**. This document is the validated specification. Any change to a
rule in §C, §E, or §F must be raised and approved before implementation — do not alter a
validated formula because a UI scenario looks inconvenient.

Locked decisions: full store companion (inventory + utang + cash counts + expenses) · local-first ·
Google sign-in for backup (P3) · Supabase + tiny FastAPI for AI · TypeScript · cash tracking is
**recorded counts only, no inferred revenue**.

---

## A. Product

TindaBot is a **smart listahan** for sari-sari store owners on Android. Before every supplier trip
it answers *ano ang bibilhin, ilan, kailan, at magkano ang dadalhin*, and it keeps the utang
list — from data the owner already has (what they bought, what they saw on the shelf).

Principles:
1. Never require data the owner doesn't naturally have.
2. Partial, irregular, late input is the normal case, not an error.
3. Every number the app shows can be explained in one Taglish sentence.
4. Uncertainty is shown (range, *tantiya*, *bilangin*) — never hidden in a bigger quantity.
5. The AI drafts and answers; it never computes and never saves.

Primary workflow is **per restock trip** (2–3×/week) with an optional count in between. The app
does not chase daily engagement; it earns opens by being right at the moment of buying.

## B. Architecture

```
Phone (PWA): React + TypeScript + Vite + vite-plugin-pwa
  UI (screens, Zustand)  ←  domain/ (pure TS, no IO, Vitest)  ←  Dexie (IndexedDB)
  Supabase JS client (auth + sync, P3)          FastAPI proxy (/ai/parse, /ai/chat, P3–P4)
```

| Layer | Owns | Never does |
|---|---|---|
| `domain/` | Event types, total order, derivation, cadence, list, tubo, templates | Storage, network, React |
| Dexie | Local persistence, sync cursors/markers, device id | Business logic |
| UI | Screens, derived state in memory | Math |
| Supabase | Identity, durable storage, RLS isolation, sync | Derivation, AI |
| FastAPI | Gemini key, JWT check, rate limit, schema-bound Gemini calls | Data storage, business rules |
| Gemini | Photo/text → drafts; answers from snapshot + client tools | Arithmetic, saving, deciding |

Derivation **always recomputes a product/customer from its full active event list** — never
incrementally. `navigator.storage.persist()` is requested on first launch.

## C. Data model

### Records (mutable; last-write-wins by client `updated_at`; server adds `server_updated_at`)

```ts
Store    { id, name, restock_days: Weekday[], next_trip_override: LocalDate|null,
           multipliers: { payday: 1.3, fri_sat: 1.15 }, updated_at }
Product  { id, store_id, name, category, unit_label, pack_size, pack_label,
           sell_price: number|null, archived, updated_at }
Customer { id, store_id, name, phone: string|null, archived, updated_at }   // P2
```

### Events (append-only; write-once by `id`; `add`-or-ignore everywhere)

```ts
Base       { id: ULID, v: 1, store_id, device_id, type, ts: ISO+offset, recorded_at: ISO }
PURCHASE   { product_id, qty_units, total_cost: number|null, supplier?: string }
COUNT      { product_id, qty_on_hand }
ADJUST     { product_id, delta /* negative = removed */, reason: 'sira'|'expired'|'personal'|'iba' }
UTANG      { customer_id, amount, note?: string }                                   // P2
BAYAD      { customer_id, amount }                                                  // P2
EXPENSE    { amount, category: 'kuryente'|'tubig'|'pamasahe'|'load'|'renta'|'iba', note?: string } // P2
CASH_COUNT { amount }                                                               // P2
VOID       { target: EventId }   // target must be a non-VOID event
```

- `qty_units` is always **selling units**, resolved at entry with the product's then-current
  `pack_size`. Later pack-size edits never rewrite history. `pack_label` is display only.
- The event `id` is generated when the form opens and regenerated after each successful save;
  writes use `add` and treat a duplicate key as success. Import and sync pull are add-or-ignore.
- `ts` = when the fact was true (user-editable). `recorded_at` = device write time, **audit only** —
  derivation never reads it.
- Backdated `ts`: linked COUNT (count-at-restock) = its PURCHASE's `ts`; standalone COUNT = chosen
  day **21:00** local; all other backdated events = chosen day **12:00** local.
- **Total order** = `(ts, typeRank, id)` with `typeRank(COUNT) = 0`, every other type = 1.
- **Active set** = non-VOID events with no VOID targeting them. VOID may target only non-VOID
  events (no chains). A VOID arriving before its target is inert until the target arrives.
- **Anchor** = last active COUNT in total order. Invariant: a COUNT at position *p* is the sellable
  stock at that position; every stock event before *p* is reflected in it, every stock event after
  *p* (including same-`ts` events) is not. ADJUST is assumed *not* reflected in the preceding count.
- Corrections: "Burahin" → VOID (timeline shows the row struck through, *Binura*, with *Ibalik* =
  new copy with new id). "I-edit" → VOID + new event (*Binago*). Nothing is ever physically deleted.

### Derived state (memory only, recomputed per product on change)

```ts
ProductState {
  tier: 'none'|'cadence'|'counts', confidence: 'none'|'low'|'mid'|'high',
  anchor: {ts, qty}|null, on_hand_est: number|null, days_since_count: number|null,
  daily_rate: number|null,          // Tier B rate, or throughput in hybrid state
  days_left: number|null,
  cadence: { throughput, typical_units, rebuy: {early, mid, late}, n, cycles }|null,
  unit_cost: number|null, tubo_per_unit: number|null,
  flags: Set<'bago'|'needs_count'|'slow'|'dead'|'inconsistent'|'dormant'|'unclear'|'no_cost'|
             'no_price'|'lugi_check'|'count_mismatch'>
}
ListLine     { product_id, tier, urgency: 'red'|'orange'|'yellow', section: 'bilhin_na'|'bilhin'|'wag_muna',
               buy_packs, buy_units, range?: [packs, packs], cost: number|null, priority, reason, hint? }
CustomerState{ balance, last_utang_ts, last_bayad_ts, oldest_unpaid_ts }               // P2
StoreState   { cash_last: {ts, amount}|null, utang_outstanding, weeks: WeekSummary[] }  // P2
```

## D. UX (P1 scope marked)

Navigation: bottom tabs **Bahay · Paninda · Listahan(P2) · Iba pa** + FAB. P1 FAB: **Bumili · Bilang**;
P2 adds **Utang · Bayad · Gastos · Pera** (decided 2026-09-14, see §E6).

- **Onboarding (P1):** store name → restock days (or *kapag kailangan*) → add paninda from catalog.
- **Bahay = the list (P1).** Sticky bar: next trip (or *Pupunta ako ngayon*), ~total, Share.
  Payday flag (only within 3 days). One count-nudge line (≤5 products: `needs_count`, `tier none`
  without a count, Tier A listed; at most once a day). Sections **Bilhin na** (red) ·
  **Bilhin** (orange, non-deferred yellow, Tier A) · **Wag muna** (deferred, collapsed).
  Row = `name · packs · ₱` / reason. Stale rows: reason becomes *"Bilangin muna →"* and the quantity
  shows as a range. A range whose low end is 0 (the 0.7× rate recomputation lands on a deferred
  yellow line) is shown as *"hanggang N <pack>"* — "up to N", deliberately naming no lower bound,
  because at the low end nothing may be needed yet. The line's recommended `buy_packs` is still
  the base-rate value; the range only communicates uncertainty. Tier A rows use pattern wording only. Tap → *bakit* sheet. Footer: total +
  *"N items walang presyo"*. Empty state: one *Idagdag* button.
- **Paninda (P1):** by urgency then name; slow/dead/dormant/unclear notes; Idagdag via bundled
  catalog (search, categories, free name) → pack size, sell price (optional), *ilan ang natira?*
  (optional COUNT). Detail: state, timeline with Burahin/Ibalik/I-edit, Nasira (ADJUST), Itigil.
- **Bumili (P1):** *"Kanina: …"* strip → product → qty (box/pack toggle) → total ₱ (prefilled from
  last cost; sanity prompt if unit cost ≥ sell price or > 5× catalog hint) → *natira bago dinagdag*
  (optional, linked COUNT) → date *Ngayon / Kahapon / ibang araw* → confirmation
  *"Natira 10 + bagong bili 48 = 58 ngayon"* → Isa pa / I-save.
- **Bilang mode (P1):** stalest first, pad accepts *packs + loose*, Laktawan/Susunod, exit anytime.
- **Iba pa (P1):** I-export / I-import (JSON), Settings (name, restock days, advanced multipliers),
  monthly backup nudge. P2+: Ulat, Listahan, Tanong kay TindaBot, sign-in.
- Concepts the user never sees: confidence levels, derived state, event logs, multipliers (hidden
  under advanced), "forecast". They see *tantiya*, *bilangin*, a range, and *bakit*.
- **Language (decided 2026-09-18):** Taglish is the default and the source wording; English is a
  runtime switch under Iba pa → Settings (*Wika / Language*). The choice is a device-local
  preference (Dexie meta `lang`, like `onboarded`) — never store data, never exported, never
  synced. Everything the app itself says follows the switch, including domain-generated wording
  (list reasons/hints, banner, *bakit* footers, dates, day/month names), which takes the language
  as an explicit argument (`domain/templates.ts`); numbers, pesos and business rules do not change.
  Cloud/sign-in failures are shown as app-level categories in the chosen language — raw
  Supabase/PostgREST/Google text never reaches the screen. Outside the app's control and
  therefore not switched: Google's own consent screens, browser/OS prompts, and the installed
  PWA's manifest (`lang: tl`). Stored text stays as entered — catalog categories, unit labels and
  the demo store's sample content are data, not UI. Deferred as minor polish (no decision taken,
  nothing blocked): whether English should say "credit" instead of *utang*, a bilingual manifest
  description, and an English variant of the demo content.
- **Leaving the demo (decided 2026-09-30):** while the demo is the current store, Bahay (at the
  top) and Iba pa show *Demo ito.* with one button.
  - If there is a real (non-demo) store on this phone, the button is *Bumalik sa ‹name› →*. It
    switches back to the most recently updated real store, with no onboarding.
  - Otherwise it is *Simulan ang sariling tindahan →*, which opens onboarding at the store-name
    step.
  - Nothing is deleted: the demo stays on the phone, local-only as before, and every other store
    is untouched.
  - Previously, trying the demo from onboarding left no way to start a real store. Loading the
    demo from Iba pa hid the real store with no way back.

## E. Core logic (all in `domain/`, pure, tested)

### E0. Calendar and shared helpers

```
today            = device local date; derive on open, after each write, at local midnight
payday days      = {15, 16, 30, last day of month, 1}
mult(d)          = max(payday(d) ? 1.3 : 1, Fri/Sat(d) ? 1.15 : 1)
next_trip        = override ?? next restock_day ≥ today ?? today
following        = next restock_day > next_trip ?? next_trip + 7
demand(r, a, b)  = Σ_{d ∈ [a, b)} r · mult(d)          (local dates; demand(r, x, x) = 0)
τ(r)             = 0.5 · r                               (half a day of demand; rounding tolerance)
packs(u, r, floor) = max(floor, ceil((u − τ(r)) / pack_size))
```

### E1. Tier B — counts

```
samples : consecutive active COUNTs c1 → c2 in total order; days = t2 − t1 (fractional)
          days < 1            → c2 replaces the anchor; no sample
          used = q1 + Σ PURCHASE.qty + Σ ADJUST.delta (strictly between in total order) − q2
          used < 0            → flag inconsistent; no sample; anchor = c2
          keep samples whose end is ≤ 90 days ago; if ≥ 3 samples, cap each rate at 3 × median
rate    : Σ rate_i · w_i / Σ w_i,   w_i = days_i · 0.5^(age_days_i / 14)
confidence : none (no rate) | low (< 2 samples or < 14 d history) | mid (2–3 samples, ≥ 14 d)
             | high (≥ 4 samples, ≥ 28 d); −1 level if the newest interval was inconsistent or the
             newest sample ended > 28 d ago. The downgrade floors at `low`: `none` means "no rate",
             so a product that has a rate is never reported as `none` (deliberate, not incidental)
on_hand : max(0, anchor.qty + Σ PURCHASE.qty + Σ ADJUST.delta (strictly after anchor) − rate · days_since)
days_left : on_hand / rate   (no multipliers; informational only)
needs_count : days_since_count > 14, or (urgency ∈ {red, orange} and days_since_count > 7)
slow    : rate < 0.25/day and days_left > 30      dead : rate ≈ 0 over ≥ 30 d and on_hand > 0
```

### E2. Tier A — purchase throughput (cadence)

Tier A estimates **purchase throughput** — how fast the owner goes through what they buy. It equals
sales demand only if the leftover at each purchase is roughly constant and every purchase is
recorded. It is never described as "you sell X per day." It never knows current inventory, a
stockout date, days left, or surplus.

```
applies  : product has no Tier B samples and no anchor (see E3 for precedence)
window   : PURCHASEs ≤ 120 d, same local date merged (qty summed, ts = first); n = count
eligible : n ≥ 3 and span(first → last) ≥ 7 d
cycles   : qty_i / gap_i for i = 0..n−2 (gap in fractional days); keep the last 5
           n = 3 and max/min ≥ 3 → tier none, flag unclear
throughput = median(cycles)      typical = median(qty over window)      confidence = low
rebuy    : early = last + max(1, qty_last / max(cycles))
           mid   = last + max(1, qty_last / median(cycles))
           late  = last + max(1, qty_last / min(cycles))
dormant  : today > mid + 14 d → unlisted; Paninda note "Matagal nang hindi nabibili — nagbebenta ka
           pa ba?" + [Bilangin] [Itigil]
listed   : rebuy.mid < following (strict) and not dormant; urgency = orange (never red); section bilhin
quantity : with restock_days or override:
             carry = throughput · max(0, days(next_trip, rebuy.mid))         (internal only, never shown)
             units = max(0, demand(throughput, next_trip, following) − carry)
             cap   = typical · (n ≥ 6 ? 2 : 1)
             packs = clamp(packs(units, throughput, 1), 1, ceil(cap / pack_size))
           no schedule:
             packs = ceil(typical / pack_size);  hint = ceil(throughput · 7 / pack_size) "para umabot ng 1 linggo"
hints    : payday ∈ [today, following) → "katapusan — baka kulangin"
           late − early > 14 d → "hindi pa regular ang bili mo" (instead of a date range)
display  : on_hand_est, days_left = null. Wording: "karaniwan kang bumibili ulit mga <early>–<late>",
           "naubos mo ang <typical> sa ~<typical/throughput> araw". Bakit: "Hindi ko alam ang natira —
           bilangin mo para mas tumpak. Kung madalas kang maubusan, hindi ito makikita sa bili mo."
```

### E3. Precedence when counts exist

```
samples ≥ 2                        → Tier B rate
samples = 1                        → Tier B rate, unless it differs > 3× from throughput (when
                                     throughput exists) → keep throughput, flag count_mismatch
                                     ("hindi tugma ang bilang sa dalas ng bili — tama ba?")
samples = 0, anchor, throughput    → tier 'counts' (hybrid): rate = throughput, on_hand from the real
                                     anchor, confidence low
samples = 0, anchor, no throughput → show "N (huling bilang)"; no rate; unlisted
no anchor                          → Tier A
```

### E4. Shopping list (Tier B lines)

```
need     = demand(rate, next_trip, following)
buffer   = max(1 day of rate, 0.2 · need)
at_trip  = on_hand − demand(rate, today, next_trip)
urgency  : red    if at_trip < 0 or (days_left ≤ 1 and rate ≥ 0.5)
           orange if at_trip < need
           yellow if at_trip < need + buffer
           green  otherwise → buy 0, unlisted
           rate < 0.5/day → cap at orange; precedence red > orange > yellow
units    = max(0, need + buffer − max(0, at_trip))
packs    = packs(units, rate, floor = urgency ∈ {red, orange} ? 1 : 0)
yellow   : units < 0.25 · pack_size → section wag_muna ("sa susunod na"); else max(1, packs)
range    : if confidence low or needs_count → recompute with rate·0.7 and rate·1.3
cost     = packs · pack_size · unit_cost   (null → "?", excluded from total, counted as walang presyo)
priority = max(0, need − at_trip) · (tubo_per_unit ?? sell_price ?? 1)
Tier A priority = units · (tubo_per_unit ?? sell_price ?? 1)
banner   : any Tier B line with at_trip < 0 → "N items mauubos bago ang <trip> — bumili ka na bukas?"
sections : bilhin_na = red · bilhin = orange, non-deferred yellow, Tier A · wag_muna = deferred yellow
sort     : within section by priority desc
```

Rounding rationale: τ is half the minimum buffer, expressed in the store's own unit (a day of
demand). Tier B can never under-cover `need`: `packs·pack_size ≥ units − τ = shortfall + buffer − τ
≥ shortfall + 0.5 day`. Floors guarantee red/orange/Tier A lines never round to zero.

### E5. Tubo, Ulat (P2), Budget (P2)

```
unit_cost      = latest PURCHASE with a cost: total_cost / qty_units
tubo_per_unit  = sell_price − unit_cost;  lugi_check if unit_cost ≥ sell_price (both known)
Ulat  Naitala  = gastos, nabili, utang given/received/outstanding, cash count (exact pesos)
      Tantiya  = benta Σ rate·7·sell_price, tubo Σ rate·7·tubo — rounded to ₱10 with "~"
Budget         : prefill last CASH_COUNT ≤ 2 d old; greedy by section then priority; shrink packs
                 to ≥ 1; leftovers "kulang ₱Y". Utang never enters the budget.
```

### E6. Pera at Utang (P2 — decided 2026-09-14, additions only)

All four finance events are ordinary events: write-once, VOID-able, `typeRank = 1`, backdated
`ts` = chosen day 12:00. Amounts are pesos `> 0` with at most 2 decimals, validated at entry only;
derivation trusts stored events. Derivation recomputes a customer / the store from the full
active event list (total order), never incrementally.

```
CustomerState  balance          = Σ UTANG.amount − Σ BAYAD.amount   (negative allowed = sobra/advance,
                                  shown as "sobra ₱X", never hidden)
               oldest_unpaid_ts = ts of the first UTANG (total order) whose cumulative UTANG sum
                                  exceeds Σ BAYAD (FIFO: every payment covers the oldest utang first,
                                  regardless of when it was made); null when balance ≤ 0
               last_utang_ts / last_bayad_ts = latest active event of each type, or null
StoreState     cash_last        = latest active CASH_COUNT {ts, amount} or null (counts only — no
                                  inferred revenue, no cash delta)
               utang_outstanding= Σ max(0, balance) over EVERY customer with events, archived included
                                  (overpayments never offset other customers' debt)
               weeks[4]         = Monday 00:00 local → Sunday, current week first; per week:
                                  gastos = Σ EXPENSE, nabili = Σ PURCHASE.total_cost (non-null),
                                  utang_given = Σ UTANG, utang_received = Σ BAYAD,
                                  cash_count = last CASH_COUNT amount dated in the week or null,
                                  outstanding_end = utang_outstanding using events with ts ≤ week end
               tantiya          = { benta: Σ rate·7·sell_price, tubo: Σ rate·7·tubo_per_unit }
                                  over products with tier = counts and daily_rate > 0 only (Tier A
                                  throughput is excluded — not confirmed sales); products lacking
                                  sell_price / tubo are skipped and counted; UI shows ~₱ rounded to 10
Budget         input = "Dala ko ₱" on Bahay, prefilled from cash_last only if ≤ 2 d old, else empty;
                       lines in bilhin_na then bilhin, by priority desc; unknown-cost lines skipped;
                       packs = max(1, min(buy_packs, floor(remaining / cost_per_pack))), remaining −= spend
                       (may go negative — every listed line keeps ≥ 1 pack);
                       kulang = max(0, total_known_cost − budget). Utang never enters the budget.
Customer       archiving keeps events and balance; an archived customer with balance ≠ 0 stays
                       visible in a collapsed list until settled.
Paalala        deferred — not defined in P2.
```

### E7. Cloud backup (P3a — decided 2026-09-15, additions only; no `domain/` change)

P3a = Google sign-in + Supabase backup/sync of the existing data model. `/ai/parse` and the
receipt camera are P3b. Local-first behaviour is unchanged: the app works fully without a
network and without any cloud configuration (`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
absent → the Cloud card says so and every sync entry point is inert).

```
Cloud rows     stores{id, body, updated_at, server_rev, created_by, archived_at}
               products/customers{id, store_id, body, updated_at, server_rev, xid}
               events{id, store_id, type, ts, body, server_seq, xid}
               body = the local object verbatim (byte-exact round trip, `ts` string untouched);
               xid = the transaction that wrote the row (server-assigned; see Pull windows).
Server rules   RLS by store_members (owner trigger on store insert; clients never write members);
               events INSERT+SELECT only (server owns server_seq and xid); records
               SELECT/INSERT/UPDATE with lww_guard() (NEW.updated_at <= OLD.updated_at → skipped);
               no DELETE anywhere; archived_at only via owner-only archive_store()/
               unarchive_store() RPCs; server_time() for skew; sync_watermark() for pull windows.
Local markers  storage-only, never in domain objects or export files: events.synced_at,
               records.synced_updated_at (dirty ⇔ ≠ updated_at), stores.local_only (demo).
Sync run       single-flight: push dirty records (then re-fetch them: a row the server rejected
               as stale is replaced locally by the newer cloud copy), push unsynced events in
               batches of 500 (insert-or-ignore), take one sync_watermark() for the run, pull the
               store row + records + events through pull windows (add-or-ignore / LWW), then full
               recompute (reload). Markers are set only after the server acknowledged. Existing
               event order, VOID semantics and record LWW are authoritative — sync adds no merge
               rule.
Pull windows   (decided 2026-09-17, replaces the plain server_seq cursor.)
               Sequence numbers are allocated when a transaction WRITES, not when it commits, so a
               row with a lower server_seq can become visible after a higher one; a cursor that
               followed server_seq alone could step over the slower row and never return to it.
               Every row therefore carries `xid` (its writing transaction) and the server exposes
               sync_watermark() = pg_snapshot_xmin(pg_current_snapshot()) = the lowest transaction
               still running. Postgres guarantees every lower-numbered transaction has already
               finished, so the set {xid < watermark} is frozen: it can never gain a member.
               A pull consumes exactly that window — `xid > cursor and xid < watermark`, paged by
               server_seq/server_rev — and only when the window is drained does the cursor advance
               to `watermark − 1`. Rows committed during the pull have a higher xid, sit outside
               the window, and are taken by the next run. INVARIANT: once cursor_events advances,
               every event with xid ≤ cursor was visible to that pull.
               An unfinished window is kept in meta (`window_events:<id>` = {hi, seq}) so a resumed
               pull continues in the same frozen set; losing it only costs a re-read (add-or-ignore).
               Cost: an in-flight write anywhere in the database holds the watermark down, so new
               rows can be a moment late (never lost), and each event this device uploads is
               downloaded back once.
Triggers       sign-in, launch, foreground, online, local write (2 s debounce), manual button.
               Errors back off 10 s → 1 min → 5 min; network errors show as "Offline — N entry
               ang hindi pa naka-backup", never as errors.
Failure kinds  (decided 2026-09-25.) Every raw supabase-js / PostgREST / Postgres failure becomes
               one app-level code in `toCloudError`, and only its localized wording is shown:
               network (phone has no connection) · unavailable (the project itself is not
               answering: 540 = paused by inactivity on the free plan, 502/503/504 from the API
               gateway, 57P03/08006/PGRST002) · auth (session) · denied (RLS) · store_gone ·
               server · unknown. The status codes are read before the auth codes, so a paused
               project answering an auth call never reads as "sign in again".
Cloud paused   An unavailable cloud is a normal state, not an error to recover from: the phone
               stays fully usable, every write lands in Dexie and stays queued, nothing local is
               invalidated or deleted, and the card says so ("Pansamantalang wala ang cloud
               backup… ligtas ang listahan sa phone"). Retries back off 1 min → 5 min → 15 min
               (a paused project comes back on the owner's schedule, so the phone does not keep
               waking its radio), and any ordinary trigger — foreground, online, manual — converges
               through the same sync run. The app never generates traffic just to keep a project
               from pausing.
Clock skew     |device − server| > 5 min → warning line only; sync never blocks.
Claim (on sign-in / launch / switching to a store not yet bound / manual). Multi-store rules
               decided 2026-09-30; they replace the 2026-09-15 two-store choice sheet:
               same id in the cloud     → normal sync
               fresh phone (the demo, or its only store still empty) and the account has stores
                                        → pull the most recently updated one completely, then
                                          switch to it
               otherwise (a real store not in the cloud) → upload it as one more store of the
                                          account; a store on the phone never competes with a
                                          different one in the cloud, nothing is asked, merged or
                                          replaced
               The account's other active stores that are not (completely) on the phone are pulled
               in as additional local stores, without switching (`adopt_pending:<id>` resumes an
               interrupted one); only the current store syncs continuously, the others when
               switched to. Switching current_store after a pull happens only once it is complete;
               `claim_pending` + per-store cursors and windows resume an interrupted pull. A bound
               store found archived/missing on the server → unbind and re-run the claim. A
               different account never reuses this device's binding.
Stores         (decided 2026-09-30.) Iba pa → *Mga tindahan* lists every store on the phone:
               *Gamitin* (switch), *Burahin* (delete, after a confirmation naming the store and what
               goes), *＋ Bagong tindahan* (onboarding for another store, with *← Bumalik sa ‹name›*
               until it exists), *Subukan ang demo* (at most one demo on a phone).
Delete         removes the store's row, products, customers, events and per-store sync state from
               the phone in one transaction. In the cloud it is ARCHIVED through archive_store()
               (every row kept — clients have no DELETE), queued as `store_deleted:<id>` until online
               and signed in, and never pulled back. Deleting the current store switches to the most
               recently updated remaining real store, else onboarding. The demo was never in the
               cloud. A store archived by another device is not un-archived or re-uploaded here: the
               phone keeps its copy, stops syncing it (`cloud_gone:<id>`) and says the store is no
               longer available in the cloud.
Demo           local_only: never pushed, never claimed; signing in with the demo current switches
               to the account's cloud store if one exists.
Membership     owner-only in P3a; store_members has `role` for households later (P5).
Sign-out       stops sync; local data untouched; signing in again resumes on the same binding.
Never          sync never deletes anything locally; the destructive local paths are importFile
               ('replace') and deleting a store, both only on the person's explicit confirmation;
               no service-role key, DB password, access token or OAuth secret in the client.
```

## F. AI boundaries (P3–P4)

- `/ai/parse`: image or text + product names/pack sizes → `{ drafts[], unreadable[] }` via response
  schema; client shows editable drafts; save only on *I-save*; images discarded, never stored.
- `/ai/chat`: stateless proxy. Client sends `{ history, snapshot (≤ 8 KB), round (0..3) }`. Tools run
  **on the client** against Dexie: `get_product`, `list_events` (returns totals), `get_shopping_list`,
  `get_week_summary`, `get_customer` (only path carrying customer names). Round 3 forces a text
  answer. Tool results ≤ 4 KB, schema-checked; malformed/failed → `{error}` → "hindi ko nakuha ang
  data". Response `{ text, figures[{label, value, source}] }`; the client verifies each figure against
  its source and labels unverified numbers *"hindi verified"*. Prompt: mirror confidence wording; no
  number for `none`; *"wala sa listahan ko"* when nothing found. Rate limit 30/min, 300/day.
- Briefing: templated, deterministic, offline (`domain/briefing.ts`).
- Gemini never computes, saves, sees the raw event log, sees names unasked, or runs offline.

## G. Roadmap

- **P1 Bahay** (local, offline, no account) — `domain/` + tests first (reference oracle, goldens,
  property tests), then Dexie + persist + catalog, onboarding, Bahay, Paninda + detail + Nasira,
  Bumili, Bilang mode, *bakit*, Share, export/import, backup nudge, settings, demo store.
  **Done when** the validated scenarios behave as specified on an Android phone in airplane mode
  after a refresh.
- **P2 Listahan at Pera** (local): UTANG/BAYAD/EXPENSE/CASH_COUNT, Customers, Listahan + Paalala,
  budget mode, Ulat.
- **P3 Cloud at Kamera:** Supabase (`stores`, `store_members`, `products`, `customers`, `events` with
  `server_seq`), RLS by membership, events INSERT-only, records no DELETE, owner trigger, Google
  sign-in claiming the local store, push/pull, clock-skew warning, `/ai/parse`, receipt camera.
  Split (decided 2026-09-15): **P3a** = sign-in + backup/sync (§E7); **P3b** = `/ai/parse` +
  receipt camera.
- **P4 Katulong:** Ilista text/voice via parse, `/ai/chat` with client tools, briefing card.
- **P5 Abot:** household second device, push via Edge Function running `domain/`, supplier price
  memory, CSV import, tally (`SALE`, additive), English toggle, multi-store. (Multi-store on one
  account was brought forward and done on 2026-09-30, see §E7 *Stores*/*Delete*; the English toggle
  was done in P3a, see *Language*.)

## H. Migration / reuse

Reused (adapted): urgency colours, Taglish stockout strings, persona prompt, `peso()`, markdown
bubble, sample CSV → demo events, Vite/React scaffold. Discarded: `backend/main.py`,
`backend/forecaster.py`, wizard components, `SummaryCard`, Prophet/pandas deps, notebooks.
Branch `rebuild`; `main` stays runnable until P1's done-when.

## I. Validated scenarios (test goldens)

Constants: Coke case = 12 @ ₱780, sells ₱75. Today Fri 2026-05-29. Restock Wed & Sat → next trip
Sat 30, following Wed Jun 3; horizon multipliers 1.3, 1.3, 1.3, 1.0 (factor 4.9).

| Scenario | Cycles → throughput | rebuy e/m/l | Listed | Packs |
|---|---|---|---|---|
| a. 2 cases every 8 d (1 case always left) | 3,3,3 → 3.0 | Jun 3 ×3 | no (mid = following) | — |
| b. other supplier one cycle | 3,1.5,3,3,3 → 3.0 | May 30 / May 30 / Jun 3 | yes | 2 |
| c. closed 6 days | 3,3,1.2,3,3 → 3.0 | Jun 1 / Jun 1 / Jun 7 | yes | 1 (carry 6) |
| d. demand doubles, 2 new cycles | 3,3,6,6,6 → 6.0 | May 30 / May 30 / Jun 1 | yes | 2 (cap) |
| d2. doubles, 3 new cycles | 6×5 → 6.0 | May 30 | yes | 2 (cap) |
| e. halves, 2 new cycles | 3,3,3,1.5,1.5 → 3.0 | Jun 2 / Jun 2 / Jun 6 | yes | 1 (carry 9) |
| f. slow irregular (box 24) | 1.2,0.69,1.2 → 1.2 | Jun 18 / Jun 18 / Jul 3 | no | — |
| g. promo 3 cases last | 3×4 → 3.0 | Jun 3 | no | — |
| h. pack 24→30 | 3,3,3 → 3.0 | Jun 7 | no | — |
| i. 3 late entries dated today | 3,3,3,0.8 → 3.0 | Jun 10 / Jun 10 / Jul 13 | no | — |
| j. n=3 span 7 d (gaps 3,4) | 4,3 → 3.5 | Jun 1 / Jun 1 / Jun 2 | yes | 1 |
| k. n=3 cycle exactly 3× | 3, 9 | — | unclear | — |
| l. n=3 cycle 3.1× | 3, 9.25 | — | unclear | — |
| A1 regular n=6 | 3.0 | May 30 | yes | 2 |
| A1 n=5 | 3.0 | May 30 | yes | 1 (cap 1×) |
| A9 no schedule | 3.0 | May 30 | yes | 1, hint 2 |
| trips daily | 3.0 | May 30 | no today | — |
| trips every 2 d | 3.0 | May 30 | yes | 1 |
| trips every 7 d (Sat) | 3.0 | May 30 | yes | 2 |
| override Jun 12 | 3.0 | May 30 | yes | 2 |
| payday after trip (today Jun 8, Wed/Sat) | 3.0 | Jun 8 | yes | 1 |

**Transition goldens.** T1 (A1 history + linked COUNT 4 / PURCHASE 12 on May 30, now Jun 1):
hybrid — tier counts, no samples, rate = throughput 3.0, on-hand from the real anchor, 1 case.
T2 (+ linked COUNT 2 / PURCHASE 12 on Jun 3, now Jun 3 11:00): one sample (4+12−2)/4 = 3.5 →
Tier B rate 3.5, no mismatch. **T3** (A1 + COUNT 4 / PURCHASE 12 on May 30, then COUNT **16** /
PURCHASE 12 on Jun 3 — the owner included the new case in the Jun 3 count): sample
(4+12−16)/4 = 0/day → > 3× off throughput → `count_mismatch`, rate stays 3.0. *An earlier draft
of this scenario used COUNT 16 on May 30 and COUNT 14 on Jun 3, which yields (16+12−14)/4 =
3.5/day — only a 1.2× deviation, which the guard correctly does not flag; that data tested
nothing. The guard fires only when a single sample deviates > 3× from throughput.*

Tier B: **S1** Lucky Me (box 24 @ ₱330, ₱16): samples 12.00, 12.75, 12.33, 15.75; weights 1.576,
2.562, 2.229, 3.623 → rate 13.63 (mid); on-hand 35.7; at_trip 20.1; need 66.8; buffer 13.63;
units 60.3 → 3 box ₱990; orange; priority 105. **S3** inconsistent then backdated fix → 7.5/day.
**S4** Sprite (events: COUNT 44 Apr 20, COUNT 26 Apr 26, PURCHASE 36 Apr 28, COUNT 20 May 10,
PURCHASE 12 May 13 → two 3.0/day samples, mid): on-hand 0, at_trip −3.45 red, needs_count,
units 17.7 → 2, range 1–2. **After COUNT 9 on May 29 09:00** the rules add a third sample
(20+12−9)/18.5 d = 1.24/day; the recency-weighted rate becomes **1.72/day** (not 3.0 — the
earlier prose held the rate fixed for exposition), at_trip 7.0, need 8.4, buffer 1.7 → units 3.1
→ **1 case**, orange. The illustrative "12.15 → 1" figure assumed a fixed rate and is superseded
by the golden. **S6** Eden rate 0.2: on-hand 40
→ green unlisted, slow; on-hand 0 → red capped orange → 1 box. Rounding (pack 12, rate 3):
13.5 → 1, 13.51 → 2, 25.5 → 2, 25.51 → 3, 37.5 → 3, 37.51 → 4.

## J. Accepted limitations (must stay visible in *bakit*/help wording)

1. Unrecorded stock makes Tier A early by `Δstock / throughput` days; bounded (never red, ≤ 1–2×
   habit); fixed by one count.
2. A store that habitually runs out is told its habit, not its demand — purchase history cannot see
   lost sales. Only counts can.
3. Late entries dated "today" push Tier A late by roughly the true age of the merged purchases.
4. Demand shifts lag up to 3 cycles; a halving shows as an early nudge for one or two cycles.
5. With fewer than 6 purchases Tier A never exceeds habit; payday is only a hint.
6. Tier B: a purchase entered with the wrong date distorts two samples in opposite directions.
