// Dexie persistence under fake-indexeddb: P3a storage-only markers never leak into domain
// objects or export files, records become dirty on edit, pulls apply LWW, nothing is deleted.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { type Customer, type DomainEvent, type Product, buildExport, isExportFile } from '../../domain'
import { db } from '../db'
import * as repo from '../repo'

const MARKERS = ['synced_at', 'synced_updated_at', 'local_only']
const DEV = 'DEV00000000000000000000001'

function product(storeId: string, id: string, updated = '2026-09-01T00:00:00.000Z'): Product {
  return { id, store_id: storeId, name: `P${id}`, category: 'c', unit_label: 'u', pack_size: 12, pack_label: 'p', sell_price: 10, archived: false, updated_at: updated }
}
function customer(storeId: string, id: string, updated = '2026-09-01T00:00:00.000Z'): Customer {
  return { id, store_id: storeId, name: `C${id}`, phone: null, archived: false, updated_at: updated }
}
function event(storeId: string, id: string, extra: Partial<DomainEvent> = {}): DomainEvent {
  return { id, v: 1, store_id: storeId, device_id: DEV, ts: '2026-09-10T12:00:00+08:00', recorded_at: '2026-09-10T12:00:00+08:00', type: 'CASH_COUNT', amount: 100, ...extra } as DomainEvent
}
function deepKeys(x: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(x)) x.forEach((v) => deepKeys(v, out))
  else if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) (out.add(k), deepKeys(v, out))
  return out
}

beforeEach(async () => {
  await db.delete()
  await db.open()
})

describe('repo — sync markers stay in storage', () => {
  it('loadSnapshot strips every marker; export file and JSON contain none', async () => {
    const s = await repo.createStore('Tindahan', [3])
    await repo.setLocalOnly(s.id)
    await repo.saveProduct(product(s.id, 'P1'))
    await repo.saveCustomer(customer(s.id, 'C1'))
    await repo.addEvents([event(s.id, 'E1')], '2026-09-15T00:00:00Z')
    await repo.addEvents([event(s.id, 'E2')])
    await repo.markRecordSynced('products', 'P1', (await db.products.get('P1'))!.updated_at)

    // markers are really there in storage
    expect((await db.stores.get(s.id))!.local_only).toBe(true)
    expect((await db.events.get('E1'))!.synced_at).toBe('2026-09-15T00:00:00Z')
    expect((await db.events.get('E2'))!.synced_at).toBeNull()
    expect((await db.products.get('P1'))!.synced_updated_at).toBeTruthy()

    const snap = (await repo.loadSnapshot(s.id))!
    const keys = deepKeys(snap)
    for (const m of MARKERS) expect(keys.has(m)).toBe(false)
    expect(deepKeys(await repo.currentStore()).has('local_only')).toBe(false)

    const file = buildExport(snap, DEV, '2026-09-15T00:00:00Z')
    const text = JSON.stringify(file)
    for (const m of MARKERS) expect(text.includes(m)).toBe(false)
    expect(isExportFile(JSON.parse(text))).toBe(true)
    expect(deepKeys(await repo.dirtyRecords(s.id)).has('synced_updated_at')).toBe(false)
    expect(deepKeys(await repo.unsyncedEvents(s.id)).has('synced_at')).toBe(false)
  })

  it('a re-import of an export made from a synced store adds nothing and keeps rows synced', async () => {
    const s = await repo.createStore('Tindahan', [3])
    await repo.saveProduct(product(s.id, 'P1'))
    await repo.addEvents([event(s.id, 'E1')], '2026-09-15T00:00:00Z')
    await repo.markRecordSynced('products', 'P1', (await db.products.get('P1'))!.updated_at)
    await repo.markRecordSynced('stores', s.id, (await db.stores.get(s.id))!.updated_at)
    const file = buildExport((await repo.loadSnapshot(s.id))!, DEV, '2026-09-15T00:00:00Z')
    const r = await repo.importFile(JSON.parse(JSON.stringify(file)), 'merge')
    expect(r.added_events).toBe(0)
    expect(await repo.countDirtyRecords(s.id)).toBe(0)
    expect(await repo.countUnsyncedEvents(s.id)).toBe(0)
  })
})

describe('repo — dirty tracking', () => {
  it('new records are dirty; acknowledged records are clean; an edit makes them dirty again', async () => {
    const s = await repo.createStore('Tindahan', [3])
    expect(await repo.countDirtyRecords(s.id)).toBe(1) // the store row itself
    await repo.saveProduct(product(s.id, 'P1'))
    await repo.saveCustomer(customer(s.id, 'C1'))
    const d = await repo.dirtyRecords(s.id)
    expect(d.store?.id).toBe(s.id)
    expect(d.products.map((p) => p.id)).toEqual(['P1'])
    expect(d.customers.map((c) => c.id)).toEqual(['C1'])

    for (const p of d.products) await repo.markRecordSynced('products', p.id, p.updated_at)
    for (const c of d.customers) await repo.markRecordSynced('customers', c.id, c.updated_at)
    await repo.markRecordSynced('stores', s.id, d.store!.updated_at)
    expect(await repo.countDirtyRecords(s.id)).toBe(0)

    await new Promise((r) => setTimeout(r, 2)) // updated_at has ms resolution
    await repo.saveProduct({ ...d.products[0]!, sell_price: 99 })
    const d2 = await repo.dirtyRecords(s.id)
    expect(d2.products.map((p) => p.id)).toEqual(['P1'])
    expect(d2.store).toBeNull()
    expect(d2.customers).toEqual([])
    // the edit kept the old marker (still stored) but the row is dirty because updated_at moved on
    const row = (await db.products.get('P1'))!
    expect(row.synced_updated_at).toBe(d.products[0]!.updated_at)
    expect(repo.isDirty(row)).toBe(true)
  })

  it('markRecordSynced only acknowledges the exact updated_at that was pushed (edit during push stays dirty)', async () => {
    const s = await repo.createStore('Tindahan', [3])
    await repo.saveProduct(product(s.id, 'P1'))
    const pushed = (await db.products.get('P1'))!.updated_at
    await new Promise((r) => setTimeout(r, 2))
    await repo.saveProduct(product(s.id, 'P1')) // edit lands while the push is in flight
    await repo.markRecordSynced('products', 'P1', pushed)
    expect(repo.isDirty((await db.products.get('P1'))!)).toBe(true)
  })

  it('events: unsynced selection, ordering by id, acknowledgement, add-or-ignore keeps the first marker', async () => {
    const s = await repo.createStore('Tindahan', [3])
    await repo.addEvents([event(s.id, 'E3'), event(s.id, 'E1')])
    await repo.addEvents([event(s.id, 'E2')], '2026-09-15T00:00:00Z')
    expect((await repo.unsyncedEvents(s.id)).map((e) => e.id)).toEqual(['E1', 'E3'])
    expect((await repo.unsyncedEvents(s.id, 1)).map((e) => e.id)).toEqual(['E1'])
    expect(await repo.countUnsyncedEvents(s.id)).toBe(2)
    // a pulled copy of a local unsynced event does not overwrite it (still to push) and vice versa
    expect(await repo.addEvents([event(s.id, 'E1', { amount: 999 } as never)], '2026-09-15T00:00:00Z')).toBe(0)
    expect((await db.events.get('E1'))!.synced_at).toBeNull()
    expect((await db.events.get('E1') as { amount: number }).amount).toBe(100)
    await repo.markEventsSynced(['E1', 'E3'], '2026-09-15T01:00:00Z')
    expect(await repo.countUnsyncedEvents(s.id)).toBe(0)
    expect(await db.events.count()).toBe(3)
  })

  it('import-merge marks changed records dirty and leaves unchanged ones clean', async () => {
    const s = await repo.createStore('Tindahan', [3])
    await repo.saveProduct(product(s.id, 'P1'))
    await repo.saveProduct(product(s.id, 'P2'))
    for (const p of (await repo.dirtyRecords(s.id)).products) await repo.markRecordSynced('products', p.id, p.updated_at)
    await repo.markRecordSynced('stores', s.id, (await db.stores.get(s.id))!.updated_at)
    const snap = (await repo.loadSnapshot(s.id))!
    const file = buildExport(snap, DEV, '2026-09-15T00:00:00Z')
    file.products = file.products.map((p) => (p.id === 'P2' ? { ...p, name: 'renamed', updated_at: '2030-01-01T00:00:00.000Z' } : p))
    await repo.importFile(file, 'merge')
    const d = await repo.dirtyRecords(s.id)
    expect(d.products.map((p) => p.id)).toEqual(['P2'])
    expect(d.store).toBeNull()
  })
})

describe('repo — applying pulled records (LWW, never delete)', () => {
  it('new rows are added clean; newer wins; older is kept and stays dirty; equal is acknowledged', async () => {
    const s = await repo.createStore('Tindahan', [3])
    await repo.saveProduct(product(s.id, 'OLD', '2026-09-01T00:00:00.000Z')) // saveProduct stamps now → newer than cloud
    const localNewer = (await db.products.get('OLD'))!
    await db.products.put({ ...product(s.id, 'EQ', '2026-09-05T00:00:00.000Z'), synced_updated_at: null })
    await db.products.put({ ...product(s.id, 'STALE', '2026-09-01T00:00:00.000Z'), synced_updated_at: '2026-09-01T00:00:00.000Z' })

    const r = await repo.applyPulledRecords({
      products: [
        product(s.id, 'NEW', '2026-09-02T00:00:00.000Z'),
        { ...product(s.id, 'OLD', '2026-09-01T00:00:00.000Z'), name: 'cloud-old' },
        { ...product(s.id, 'EQ', '2026-09-05T00:00:00.000Z'), name: 'PEQ' },
        { ...product(s.id, 'STALE', '2026-09-06T00:00:00.000Z'), name: 'cloud-newer' },
      ],
      customers: [customer(s.id, 'C9')],
    })
    expect(r.applied).toBe(3) // NEW, STALE, C9
    const rows = Object.fromEntries((await db.products.toArray()).map((p) => [p.id, p]))
    expect(rows.NEW!.synced_updated_at).toBe('2026-09-02T00:00:00.000Z')
    expect(rows.OLD!.name).toBe(localNewer.name) // local newer kept …
    expect(repo.isDirty(rows.OLD!)).toBe(true) // … and still to be pushed
    expect(rows.EQ!.synced_updated_at).toBe('2026-09-05T00:00:00.000Z') // same record → acknowledged
    expect(rows.STALE!.name).toBe('cloud-newer')
    expect(repo.isDirty(rows.STALE!)).toBe(false)
    expect(await db.products.count()).toBe(4)
    expect((await db.customers.get('C9'))!.synced_updated_at).toBe('2026-09-01T00:00:00.000Z')
  })

  it('a pulled store row creates a second local store without touching the current one', async () => {
    const a = await repo.createStore('Phone', [3])
    await repo.saveProduct(product(a.id, 'P1'))
    const cloudStore = { ...a, id: 'CLOUD0000000000000000000001', name: 'Cloud', updated_at: '2026-09-01T00:00:00.000Z' }
    await repo.applyPulledRecords({ store: cloudStore })
    expect(await repo.storeExists(cloudStore.id)).toBe(true)
    expect((await repo.currentStore())!.id).toBe(a.id)
    await repo.setCurrentStore(cloudStore.id)
    expect((await repo.currentStore())!.name).toBe('Cloud')
    expect((await repo.loadSnapshot(a.id))!.products.length).toBe(1) // old store intact
    await expect(repo.setCurrentStore('NOPE')).rejects.toThrow()
  })

  it('countStoreData / isLocalOnly', async () => {
    const s = await repo.createStore('T', [])
    expect(await repo.countStoreData(s.id)).toEqual({ products: 0, customers: 0, events: 0 })
    expect(await repo.isLocalOnly(s.id)).toBe(false)
    await repo.setLocalOnly(s.id)
    expect(await repo.isLocalOnly(s.id)).toBe(true)
    await repo.saveStore({ ...s, name: 'renamed' })
    expect(await repo.isLocalOnly(s.id)).toBe(true) // edits keep storage-only flags
    expect((await repo.currentStore())!.name).toBe('renamed')
  })
})
