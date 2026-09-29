// An import is all or nothing. It used to be written in two transactions — records first, events
// after — so an interruption in between left the database half-imported. In `replace` mode that was
// worse than half: the store being replaced is deleted first, so an interruption destroyed it and
// imported no history in its place. These tests interrupt an import at exactly that point.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { type Customer, type DomainEvent, type ExportFile, type Product, type Store, type Weekday, buildExport } from '../../domain'
import { db } from '../db'
import * as repo from '../repo'

const DEV = 'DEV00000000000000000000001'
const OTHER_STORE = 'S0000000000000000000000002'

function product(storeId: string, id: string, name = `P${id}`, updated = '2026-09-01T00:00:00.000Z'): Product {
  return { id, store_id: storeId, name, category: 'c', unit_label: 'u', pack_size: 12, pack_label: 'p', sell_price: 10, archived: false, updated_at: updated }
}
function event(storeId: string, id: string): DomainEvent {
  return { id, v: 1, store_id: storeId, device_id: DEV, ts: '2026-09-10T12:00:00+08:00', recorded_at: '2026-09-10T12:00:00+08:00', type: 'CASH_COUNT', amount: 100 } as DomainEvent
}
function store(id: string, name: string, updated: string): Store {
  return { id, name, restock_days: [3] as Weekday[], next_trip_override: null, multipliers: { payday: 1.3, fri_sat: 1.15 }, updated_at: updated }
}

/**
 * Event writes stop working from here on — what the tab being closed, or storage giving up, looks
 * like from the database's side at the moment the records are already in.
 */
function interruptEventWrites(): () => void {
  const proto = IDBObjectStore.prototype as unknown as { add: (...a: unknown[]) => unknown }
  const real = proto.add
  proto.add = function (this: IDBObjectStore, ...args: unknown[]) {
    if (this.name === 'events') throw new DOMException('interrupted', 'UnknownError')
    return real.apply(this, args)
  }
  return () => {
    proto.add = real
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

describe('an interrupted import changes nothing', () => {
  it('replace: the store it was about to replace survives untouched', async () => {
    const mine = await myStoreWithHistory()
    const file: ExportFile = buildExport(
      { store: store(OTHER_STORE, 'Ibang tindahan', '2026-09-02T00:00:00.000Z'), products: [product(OTHER_STORE, 'OTHER1')], customers: [] as Customer[], events: [event(OTHER_STORE, 'OTHEREV1'), event(OTHER_STORE, 'OTHEREV2')] },
      DEV,
      '2026-09-20T00:00:00.000Z',
    )

    const heal = interruptEventWrites()
    await expect(repo.importFile(file, 'replace')).rejects.toThrow()
    heal()

    expect(await repo.getMeta('current_store')).toBe(mine.id) // still their store
    expect((await db.stores.toArray()).map((s) => s.id)).toEqual([mine.id])
    expect((await db.products.toArray()).map((p) => p.id)).toEqual(['MINE1'])
    expect((await db.events.toArray()).map((e) => e.id).sort()).toEqual(['MINEEV1', 'MINEEV2'])
  })

  it('merge: no record is left updated without the events that came with it', async () => {
    const mine = await myStoreWithHistory()
    const file: ExportFile = buildExport(
      {
        store: { ...store(mine.id, 'Pinalitan ang pangalan', '2027-01-01T00:00:00.000Z'), restock_days: mine.restock_days },
        products: [product(mine.id, 'MINE1', 'Bagong pangalan', '2027-01-01T00:00:00.000Z')],
        customers: [],
        events: [event(mine.id, 'NEWEV1')],
      },
      DEV,
      '2027-01-01T00:00:00.000Z',
    )

    const heal = interruptEventWrites()
    await expect(repo.importFile(file, 'merge')).rejects.toThrow()
    heal()

    expect((await db.stores.get(mine.id))!.name).toBe('Tindahan ko')
    expect((await db.products.get('MINE1'))!.name).toBe('PMINE1')
    expect((await db.events.toArray()).map((e) => e.id).sort()).toEqual(['MINEEV1', 'MINEEV2'])
  })

  it('and the same import succeeds completely once the interruption is over', async () => {
    const mine = await myStoreWithHistory()
    const file: ExportFile = buildExport(
      {
        store: { ...store(mine.id, 'Pinalitan ang pangalan', '2027-01-01T00:00:00.000Z'), restock_days: mine.restock_days },
        products: [product(mine.id, 'MINE1', 'Bagong pangalan', '2027-01-01T00:00:00.000Z')],
        customers: [],
        events: [event(mine.id, 'NEWEV1')],
      },
      DEV,
      '2027-01-01T00:00:00.000Z',
    )
    const heal = interruptEventWrites()
    await expect(repo.importFile(file, 'merge')).rejects.toThrow()
    heal()

    const r = await repo.importFile(file, 'merge')

    expect(r.added_events).toBe(1)
    expect((await db.stores.get(mine.id))!.name).toBe('Pinalitan ang pangalan')
    expect((await db.products.get('MINE1'))!.name).toBe('Bagong pangalan')
    expect((await db.events.toArray()).map((e) => e.id).sort()).toEqual(['MINEEV1', 'MINEEV2', 'NEWEV1'])
    // and a second run of the same file still adds nothing (write-once by id, inside one transaction)
    const again = await repo.importFile(file, 'merge')
    expect(again.added_events).toBe(0)
    expect(await db.events.count()).toBe(3)
  })

  it('a successful replace brings the whole file across in one go', async () => {
    await myStoreWithHistory()
    const file: ExportFile = buildExport(
      { store: store(OTHER_STORE, 'Ibang tindahan', '2026-09-02T00:00:00.000Z'), products: [product(OTHER_STORE, 'OTHER1')], customers: [] as Customer[], events: [event(OTHER_STORE, 'OTHEREV1'), event(OTHER_STORE, 'OTHEREV2')] },
      DEV,
      '2026-09-20T00:00:00.000Z',
    )

    const r = await repo.importFile(file, 'replace')

    expect(r).toEqual({ added_events: 2, updated_products: 1, updated_customers: 0 })
    expect(await repo.getMeta('current_store')).toBe(OTHER_STORE)
    expect((await db.stores.toArray()).map((s) => s.id)).toEqual([OTHER_STORE])
    expect((await db.events.toArray()).map((e) => e.id).sort()).toEqual(['OTHEREV1', 'OTHEREV2'])
    expect(await db.products.count()).toBe(1)
  })
})
