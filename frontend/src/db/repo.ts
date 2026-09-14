// Repository — the only place that touches Dexie. Enforces write-once events and
// records-LWW semantics from BLUEPRINT §C.

import Dexie from 'dexie'
import { type Customer, type DomainEvent, type ExportFile, type Product, type Snapshot, type Store, mergeImport, ulid } from '../domain'
import { db, type StoredEvent } from './db'

export async function getMeta(key: string): Promise<string | null> {
  const row = await db.meta.get(key)
  return row?.value ?? null
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value })
}

/** Device id is created once per install. */
export async function deviceId(): Promise<string> {
  let id = await getMeta('device_id')
  if (!id) {
    id = ulid()
    await setMeta('device_id', id)
  }
  return id
}

export async function currentStore(): Promise<Store | null> {
  const id = await getMeta('current_store')
  if (!id) return null
  return (await db.stores.get(id)) ?? null
}

export async function createStore(name: string, restockDays: Store['restock_days']): Promise<Store> {
  const store: Store = {
    id: ulid(),
    name,
    restock_days: restockDays,
    next_trip_override: null,
    multipliers: { payday: 1.3, fri_sat: 1.15 },
    updated_at: new Date().toISOString(),
  }
  await db.stores.put(store)
  await setMeta('current_store', store.id)
  return store
}

export async function saveStore(store: Store): Promise<void> {
  await db.stores.put({ ...store, updated_at: new Date().toISOString() })
}

export async function saveProduct(p: Product): Promise<void> {
  await db.products.put({ ...p, updated_at: new Date().toISOString() })
}

export async function saveCustomer(c: Customer): Promise<void> {
  await db.customers.put({ ...c, updated_at: new Date().toISOString() })
}

/**
 * Write-once: a duplicate id is treated as success (idempotent form submits, re-imports, sync
 * pulls). Never overwrites.
 */
export async function addEvents(events: DomainEvent[]): Promise<number> {
  let added = 0
  await db.transaction('rw', db.events, async () => {
    for (const e of events) {
      try {
        await db.events.add({ ...e, synced_at: null })
        added++
      } catch (err) {
        if (err instanceof Dexie.ConstraintError || (err as { name?: string })?.name === 'ConstraintError') continue
        throw err
      }
    }
  })
  return added
}

export async function loadSnapshot(storeId: string): Promise<Snapshot | null> {
  const store = await db.stores.get(storeId)
  if (!store) return null
  const products = await db.products.where('store_id').equals(storeId).toArray()
  const customers = await db.customers.where('store_id').equals(storeId).toArray()
  const rows = await db.events.where('store_id').equals(storeId).toArray()
  const events = rows.map((r) => {
    const { synced_at: _s, ...e } = r as StoredEvent
    return e as DomainEvent
  })
  return { store, products, customers, events }
}

/** Import into the current store (same id) or replace the current store entirely. */
export async function importFile(file: ExportFile, mode: 'merge' | 'replace'): Promise<{ added_events: number; updated_products: number; updated_customers: number }> {
  const customers = file.customers ?? [] // P1 export files have an empty (or missing) customers array
  if (mode === 'replace') {
    await db.transaction('rw', [db.stores, db.products, db.customers, db.events, db.meta], async () => {
      const cur = await getMeta('current_store')
      if (cur) {
        await db.products.where('store_id').equals(cur).delete()
        await db.customers.where('store_id').equals(cur).delete()
        await db.events.where('store_id').equals(cur).delete()
        await db.stores.delete(cur)
      }
      await db.stores.put(file.store)
      await db.products.bulkPut(file.products)
      await db.customers.bulkPut(customers)
      await setMeta('current_store', file.store.id)
    })
    const added = await addEvents(file.events)
    return { added_events: added, updated_products: file.products.length, updated_customers: customers.length }
  }
  const existing = await loadSnapshot(file.store.id)
  if (!existing) throw new Error('store not found')
  const merged = mergeImport(existing, file)
  await db.transaction('rw', [db.stores, db.products, db.customers], async () => {
    if (merged.store_updated) await db.stores.put(merged.snapshot.store)
    await db.products.bulkPut(merged.snapshot.products)
    await db.customers.bulkPut(merged.snapshot.customers)
  })
  const added = await addEvents(file.events)
  return { added_events: added, updated_products: merged.updated_products, updated_customers: merged.updated_customers }
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage && navigator.storage.persist) {
      if (await navigator.storage.persisted()) return true
      return await navigator.storage.persist()
    }
  } catch {
    /* ignore */
  }
  return false
}
