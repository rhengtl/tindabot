// What the app will accept as an export file. The guard is deliberately shallow — contents are
// validated at entry (BLUEPRINT §C) — but the file's *store* has to be one the app can open, because
// importing is the only destructive local path: a replace deletes the current store first, and a
// store row the domain cannot read leaves the app with nothing it can render.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type Customer,
  type DomainEvent,
  type ExportFile,
  type Product,
  type Store,
  type Weekday,
  activeEvents,
  buildExport,
  buildList,
  deriveCustomers,
  deriveProduct,
  deriveStoreFinance,
  isExportFile,
  stockEventsByProduct,
} from '../../domain'
import { db } from '../db'
import * as repo from '../repo'
import { loadDemo } from '../../state/demo'

const DEV = 'DEV00000000000000000000001'
const OTHER = 'S0000000000000000000000002'

function product(storeId: string, id: string): Product {
  return { id, store_id: storeId, name: `P${id}`, category: 'c', unit_label: 'u', pack_size: 12, pack_label: 'p', sell_price: 10, archived: false, updated_at: '2026-09-01T00:00:00.000Z' }
}
function event(storeId: string, id: string): DomainEvent {
  return { id, v: 1, store_id: storeId, device_id: DEV, ts: '2026-09-10T12:00:00+08:00', recorded_at: '2026-09-10T12:00:00+08:00', type: 'CASH_COUNT', amount: 100 } as DomainEvent
}
function storeRow(id: string, name = 'Ibang tindahan'): Store {
  return { id, name, restock_days: [3] as Weekday[], next_trip_override: null, multipliers: { payday: 1.3, fri_sat: 1.15 }, updated_at: '2026-09-02T00:00:00.000Z' }
}
function fileFor(store: Store): ExportFile {
  return buildExport({ store, products: [product(store.id, 'OTHER1')], customers: [] as Customer[], events: [event(store.id, 'OTHEREV1')] }, DEV, '2026-09-20T00:00:00.000Z')
}
/** A file that keeps the outer shape but whose store is broken in one specific way. */
function fileWithStore(store: unknown): unknown {
  return { ...fileFor(storeRow(OTHER)), store }
}

/** Everything the app does to open a store, so "unrenderable" is an observation, not a guess. */
function canRender(snapshot: { store: Store; products: Product[]; events: DomainEvent[] }): boolean {
  try {
    const nowMs = Date.now()
    const active = activeEvents(snapshot.events)
    const grouped = stockEventsByProduct(active)
    const states = new Map(snapshot.products.map((p) => [p.id, deriveProduct(p, grouped.get(p.id) ?? [], nowMs)]))
    buildList({ store: snapshot.store, products: snapshot.products, states, nowMs, lang: 'tl' })
    deriveCustomers(active)
    deriveStoreFinance({ events: active, products: snapshot.products, states, nowMs })
    return true
  } catch {
    return false
  }
}

async function myStoreWithHistory(): Promise<Store> {
  const mine = await repo.createStore('Tindahan ko', [3])
  await repo.saveProduct(product(mine.id, 'MINE1'))
  await repo.addEvents([event(mine.id, 'MINEEV1'), event(mine.id, 'MINEEV2')])
  return mine
}

beforeEach(async () => {
  db.close()
  await db.delete()
  await db.open()
})

describe('what counts as an export file', () => {
  it('accepts what this app actually exports — the demo store, exported the way Iba pa exports it', async () => {
    await loadDemo()
    const snapshot = await repo.loadSnapshot((await repo.getMeta('current_store'))!)
    const file = buildExport(snapshot!, DEV, '2026-09-20T00:00:00.000Z')
    expect(file.products.length).toBeGreaterThan(0)
    expect(file.events.length).toBeGreaterThan(0)
    expect(isExportFile(file)).toBe(true)
    expect(isExportFile(JSON.parse(JSON.stringify(file)))).toBe(true) // and after a round trip through a file
    expect(isExportFile(fileFor(storeRow(OTHER)))).toBe(true)
  })

  it('accepts a store with no buying days, a trip override, or no customers array at all', () => {
    expect(isExportFile(fileWithStore({ ...storeRow(OTHER), restock_days: [] }))).toBe(true)
    expect(isExportFile(fileWithStore({ ...storeRow(OTHER), next_trip_override: '2026-09-30' }))).toBe(true)
    const { next_trip_override: _dropped, ...withoutOverride } = storeRow(OTHER)
    expect(isExportFile(fileWithStore(withoutOverride))).toBe(true)
    const { customers: _c, ...noCustomers } = fileFor(storeRow(OTHER))
    expect(isExportFile(noCustomers)).toBe(true) // P1-era files have no customers
  })

  it('rejects a file whose store is missing a field the app reads', () => {
    for (const [what, store] of [
      ['no store at all', undefined],
      ['a store that is not an object', 'S1'],
      ['no id', { ...storeRow(OTHER), id: undefined }],
      ['an empty id', { ...storeRow(OTHER), id: '' }],
      ['no name', { ...storeRow(OTHER), name: undefined }],
      ['no buying days', { ...storeRow(OTHER), restock_days: undefined }],
      ['buying days that are not a list', { ...storeRow(OTHER), restock_days: 3 }],
      ['no multipliers', { ...storeRow(OTHER), multipliers: undefined }],
      ['multipliers that are not numbers', { ...storeRow(OTHER), multipliers: { payday: '1.3', fri_sat: '1.15' } }],
      ['half the multipliers', { ...storeRow(OTHER), multipliers: { payday: 1.3 } }],
      ['no updated_at', { ...storeRow(OTHER), updated_at: undefined }],
      ['a trip override that is not a date', { ...storeRow(OTHER), next_trip_override: 20260930 }],
      ['only an id', { id: OTHER }],
    ] as Array<[string, unknown]>) {
      expect(isExportFile(fileWithStore(store)), what).toBe(false)
    }
  })

  it('still rejects what it always rejected', () => {
    expect(isExportFile(null)).toBe(false)
    expect(isExportFile('{}')).toBe(false)
    expect(isExportFile({ ...fileFor(storeRow(OTHER)), format: 'something-else' })).toBe(false)
    expect(isExportFile({ ...fileFor(storeRow(OTHER)), version: 2 })).toBe(false)
    expect(isExportFile({ ...fileFor(storeRow(OTHER)), products: undefined })).toBe(false)
    expect(isExportFile({ ...fileFor(storeRow(OTHER)), events: 'none' })).toBe(false)
  })
})

describe('a malformed store never reaches the database', () => {
  it('a file the app cannot open is refused before the current store is touched', async () => {
    const mine = await myStoreWithHistory()
    const broken = fileWithStore({ id: OTHER }) // shaped like an export, unusable as a store

    // the import entry point refuses it — this is what the UI checks before calling repo
    expect(isExportFile(broken)).toBe(false)
    // and were it ever handed to the repo anyway, the person's store is what stays on screen
    const before = await repo.loadSnapshot(mine.id)
    expect(before).not.toBeNull()
    expect(canRender(before!)).toBe(true)

    expect(await repo.getMeta('current_store')).toBe(mine.id)
    expect((await db.stores.toArray()).map((s) => s.id)).toEqual([mine.id])
    expect(await db.events.count()).toBe(2)
  })

  it('the store that used to brick the app is exactly the one now refused', async () => {
    // before this guard, this file imported cleanly and then could not be derived at all
    const bricking = { ...storeRow(OTHER), restock_days: undefined, multipliers: undefined }
    expect(canRender({ store: bricking as unknown as Store, products: [], events: [] })).toBe(false)
    expect(isExportFile(fileWithStore(bricking))).toBe(false)
  })

  it('a valid file still replaces the store completely, and stays idempotent', async () => {
    await myStoreWithHistory()
    const file = fileFor(storeRow(OTHER))
    expect(isExportFile(file)).toBe(true)

    const r = await repo.importFile(file, 'replace')

    expect(r).toEqual({ added_events: 1, updated_products: 1, updated_customers: 0 })
    expect(await repo.getMeta('current_store')).toBe(OTHER)
    const snap = await repo.loadSnapshot(OTHER)
    expect(canRender(snap!)).toBe(true)
    expect(snap!.events).toHaveLength(1)

    // the same file again: nothing added, nothing changed
    const again = await repo.importFile(file, 'merge')
    expect(again.added_events).toBe(0)
    expect(await db.events.count()).toBe(1)
    expect(await db.stores.count()).toBe(1)
  })

  it('a merge into the same store still works after the guard', async () => {
    const mine = await myStoreWithHistory()
    const file = buildExport(
      { store: { ...mine, name: 'Bagong pangalan', updated_at: '2027-01-01T00:00:00.000Z' }, products: [product(mine.id, 'MINE1')], customers: [], events: [event(mine.id, 'NEWEV1')] },
      DEV,
      '2027-01-01T00:00:00.000Z',
    )
    expect(isExportFile(file)).toBe(true)

    const r = await repo.importFile(file, 'merge')

    expect(r.added_events).toBe(1)
    expect((await db.stores.get(mine.id))!.name).toBe('Bagong pangalan')
    expect(canRender((await repo.loadSnapshot(mine.id))!)).toBe(true)
  })
})
