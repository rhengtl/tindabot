// Repository — the only place that touches Dexie. Enforces write-once events and
// records-LWW semantics from BLUEPRINT §C. P3a adds storage-only sync markers (see db.ts);
// every read that hands rows to the domain or to export strips them.

import Dexie, { type EntityTable } from 'dexie'
import { type Customer, type DomainEvent, type ExportFile, type Product, type Snapshot, type Store, mergeImport, ulid } from '../domain'
import { type StoredCustomer, type StoredEvent, type StoredProduct, type StoredStore, db } from './db'

/**
 * Opens the database, or rejects with the browser's own reason when it will not allow it (site data
 * blocked, no IndexedDB, a corrupted profile). Safe to call when it is already open, which is why
 * `init()` can use it both on the first launch and on a retry.
 */
export async function openDatabase(): Promise<void> {
  if (!db.isOpen()) await db.open()
}

/**
 * Drops the connection. Dexie keeps a failed open on the instance and will not auto-open a closed
 * one, so a retry after the browser starts allowing storage again has to close it first and then
 * open it explicitly. Harmless when the database was never open.
 */
export function closeDatabase(): void {
  db.close()
}

export async function getMeta(key: string): Promise<string | null> {
  const row = await db.meta.get(key)
  return row?.value ?? null
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value })
}

export async function deleteMeta(key: string): Promise<void> {
  await db.meta.delete(key)
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

// ---------- marker stripping ----------

function stripStore(row: StoredStore): Store {
  const { synced_updated_at: _s, local_only: _l, ...store } = row
  return store
}
function stripProduct(row: StoredProduct): Product {
  const { synced_updated_at: _s, ...p } = row
  return p
}
function stripCustomer(row: StoredCustomer): Customer {
  const { synced_updated_at: _s, ...c } = row
  return c
}
function stripEvent(row: StoredEvent): DomainEvent {
  const { synced_at: _s, ...e } = row
  return e as DomainEvent
}

export async function currentStore(): Promise<Store | null> {
  const id = await getMeta('current_store')
  if (!id) return null
  const row = await db.stores.get(id)
  return row ? stripStore(row) : null
}

export async function setCurrentStore(id: string): Promise<void> {
  if (!(await db.stores.get(id))) throw new Error('store not found')
  await setMeta('current_store', id)
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

/** Local edits stamp `updated_at` and keep the previous sync marker, which makes the row dirty. */
export async function saveStore(store: Store): Promise<void> {
  await db.transaction('rw', db.stores, async () => {
    const prev = await db.stores.get(store.id)
    await db.stores.put({ ...prev, ...store, updated_at: new Date().toISOString() })
  })
}

export async function saveProduct(p: Product): Promise<void> {
  await db.transaction('rw', db.products, async () => {
    const prev = await db.products.get(p.id)
    await db.products.put({ ...prev, ...p, updated_at: new Date().toISOString() })
  })
}

export async function saveCustomer(c: Customer): Promise<void> {
  await db.transaction('rw', db.customers, async () => {
    const prev = await db.customers.get(c.id)
    await db.customers.put({ ...prev, ...c, updated_at: new Date().toISOString() })
  })
}

/**
 * Write-once: a duplicate id is treated as success (idempotent form submits, re-imports, sync
 * pulls). Never overwrites. `syncedAt` is set only for events that came from the server.
 */
export async function addEvents(events: DomainEvent[], syncedAt: string | null = null): Promise<number> {
  let added = 0
  await db.transaction('rw', db.events, async () => {
    for (const e of events) {
      try {
        await db.events.add({ ...e, synced_at: syncedAt })
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
  const products = (await db.products.where('store_id').equals(storeId).toArray()).map(stripProduct)
  const customers = (await db.customers.where('store_id').equals(storeId).toArray()).map(stripCustomer)
  const events = (await db.events.where('store_id').equals(storeId).toArray()).map(stripEvent)
  return { store: stripStore(store), products, customers, events }
}

/**
 * Import into the current store (same id) or replace the current store entirely. Never used by sync.
 *
 * One transaction covers the whole import, events included: an import that is interrupted — the tab
 * closed, storage refused halfway, the phone out of space — must leave the database exactly as it
 * was. In `replace` mode that is what stands between an interruption and real loss, because the
 * first thing this does is delete the store being replaced.
 */
export async function importFile(file: ExportFile, mode: 'merge' | 'replace'): Promise<{ added_events: number; updated_products: number; updated_customers: number }> {
  const customers = file.customers ?? [] // P1 export files have an empty (or missing) customers array
  const tables = [db.stores, db.products, db.customers, db.events, db.meta]
  if (mode === 'replace') {
    let added = 0
    await db.transaction('rw', tables, async () => {
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
      added = await addEvents(file.events) // nested in this transaction, not a second one
    })
    return { added_events: added, updated_products: file.products.length, updated_customers: customers.length }
  }
  const existing = await loadSnapshot(file.store.id)
  if (!existing) throw new Error('store not found')
  const merged = mergeImport(existing, file)
  let added = 0
  await db.transaction('rw', tables, async () => {
    // Imported records replace the domain fields but keep the row's sync marker, so a record that
    // changed through the import becomes dirty and is pushed.
    if (merged.store_updated) await saveRecordKeepingMarker(marked<Store>(db.stores), merged.snapshot.store)
    for (const p of merged.snapshot.products) await saveRecordKeepingMarker(marked<Product>(db.products), p)
    for (const c of merged.snapshot.customers) await saveRecordKeepingMarker(marked<Customer>(db.customers), c)
    added = await addEvents(file.events)
  })
  return { added_events: added, updated_products: merged.updated_products, updated_customers: merged.updated_customers }
}

type Marked<T> = T & { synced_updated_at?: string | null }
/** The two table methods the marker helpers need; lets one generic helper serve all three record tables. */
interface MarkedTable<T> {
  get(key: string): PromiseLike<Marked<T> | undefined>
  put(row: Marked<T>): PromiseLike<unknown>
}
function marked<T extends { id: string; updated_at: string }>(table: EntityTable<Marked<T>, 'id'>): MarkedTable<T> {
  return table as unknown as MarkedTable<T>
}

async function saveRecordKeepingMarker<T extends { id: string; updated_at: string }>(table: MarkedTable<T>, rec: T): Promise<void> {
  const prev = await table.get(rec.id)
  if (prev && prev.updated_at === rec.updated_at) return
  await table.put({ ...rec, synced_updated_at: prev?.synced_updated_at ?? null })
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

// =============================================================================================
// P3a sync support. Markers are written only here; nothing below deletes anything.
// =============================================================================================

export function isDirty(row: { updated_at: string; synced_updated_at?: string | null }): boolean {
  return row.synced_updated_at !== row.updated_at
}

export async function isLocalOnly(storeId: string): Promise<boolean> {
  return (await db.stores.get(storeId))?.local_only === true
}

/** Marks a store as never-synced (demo). Irreversible by design: a demo store is never uploaded. */
export async function setLocalOnly(storeId: string): Promise<void> {
  await db.stores.where('id').equals(storeId).modify({ local_only: true })
}

export async function storeExists(storeId: string): Promise<boolean> {
  return !!(await db.stores.get(storeId))
}

/** "Populated" for the claim rules: anything the user could lose. */
export async function countStoreData(storeId: string): Promise<{ products: number; customers: number; events: number }> {
  const [products, customers, events] = await Promise.all([
    db.products.where('store_id').equals(storeId).count(),
    db.customers.where('store_id').equals(storeId).count(),
    db.events.where('store_id').equals(storeId).count(),
  ])
  return { products, customers, events }
}

export interface DirtyRecords {
  store: Store | null
  products: Product[]
  customers: Customer[]
}

/** Records whose latest local edit the server has not acknowledged. */
export async function dirtyRecords(storeId: string): Promise<DirtyRecords> {
  const store = await db.stores.get(storeId)
  const products = (await db.products.where('store_id').equals(storeId).toArray()).filter(isDirty).map(stripProduct)
  const customers = (await db.customers.where('store_id').equals(storeId).toArray()).filter(isDirty).map(stripCustomer)
  return { store: store && isDirty(store) ? stripStore(store) : null, products, customers }
}

export async function countDirtyRecords(storeId: string): Promise<number> {
  const d = await dirtyRecords(storeId)
  return (d.store ? 1 : 0) + d.products.length + d.customers.length
}

/** Events not yet acknowledged by the server, in id (ULID ≈ creation) order. */
export async function unsyncedEvents(storeId: string, limit = Infinity): Promise<DomainEvent[]> {
  const rows = await db.events
    .where('store_id')
    .equals(storeId)
    .filter((e) => e.synced_at == null)
    .toArray()
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return (limit === Infinity ? rows : rows.slice(0, limit)).map(stripEvent)
}

export async function countUnsyncedEvents(storeId: string): Promise<number> {
  return db.events
    .where('store_id')
    .equals(storeId)
    .filter((e) => e.synced_at == null)
    .count()
}

export async function markEventsSynced(ids: string[], syncedAt: string): Promise<void> {
  await db.events.where('id').anyOf(ids).modify({ synced_at: syncedAt })
}

type RecordTable = 'stores' | 'products' | 'customers'

/**
 * Marks a record as acknowledged for exactly the `updated_at` that was pushed. A local edit that
 * landed while the push was in flight keeps the row dirty.
 */
export async function markRecordSynced(table: RecordTable, id: string, updatedAt: string): Promise<void> {
  const t = db[table] as EntityTable<{ id: string; updated_at: string; synced_updated_at?: string | null }, 'id'>
  await t
    .where('id')
    .equals(id)
    .modify((row) => {
      if (row.updated_at === updatedAt) row.synced_updated_at = updatedAt
    })
}

export interface PulledRecords {
  store?: Store | null
  products?: Product[]
  customers?: Customer[]
}

/**
 * Applies records pulled from the server with the §C LWW rule: newer `updated_at` wins, equal is
 * the same record (mark it synced), older local rows are replaced, newer local rows are kept
 * (they are dirty and will be pushed). Nothing is deleted. Cloud rows are never `local_only`.
 */
export async function applyPulledRecords(pulled: PulledRecords): Promise<{ applied: number }> {
  let applied = 0
  await db.transaction('rw', [db.stores, db.products, db.customers], async () => {
    const apply = async <T extends { id: string; updated_at: string }>(table: MarkedTable<T>, rec: T) => {
      const prev = await table.get(rec.id)
      if (!prev) {
        await table.put({ ...rec, synced_updated_at: rec.updated_at })
        applied++
        return
      }
      const cmp = Date.parse(rec.updated_at) - Date.parse(prev.updated_at)
      if (cmp > 0) {
        await table.put({ ...prev, ...rec, synced_updated_at: rec.updated_at })
        applied++
      } else if (cmp === 0 && prev.synced_updated_at !== prev.updated_at) {
        await table.put({ ...prev, synced_updated_at: prev.updated_at })
      }
    }
    if (pulled.store) await apply(marked<Store>(db.stores), pulled.store)
    for (const p of pulled.products ?? []) await apply(marked<Product>(db.products), p)
    for (const c of pulled.customers ?? []) await apply(marked<Customer>(db.customers), c)
  })
  return { applied }
}
