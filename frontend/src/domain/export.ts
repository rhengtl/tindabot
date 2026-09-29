// Export / import format — BLUEPRINT §C and local-first lifecycle.
// Events are write-once by id (add-or-ignore); records are last-write-wins by updated_at.
// Importing the same file twice must be a no-op.

import type { Customer, DomainEvent, ISODateTime, Product, Store, ULID } from './types'

export interface ExportFile {
  format: 'tindabot-export'
  version: 1
  exported_at: ISODateTime
  device_id: ULID
  store: Store
  products: Product[]
  customers: Customer[]
  events: DomainEvent[]
}

export interface Snapshot {
  store: Store
  products: Product[]
  customers: Customer[]
  events: DomainEvent[]
}

export function buildExport(s: Snapshot, deviceId: ULID, exportedAt: ISODateTime): ExportFile {
  return {
    format: 'tindabot-export',
    version: 1,
    exported_at: exportedAt,
    device_id: deviceId,
    store: s.store,
    products: s.products.slice(),
    customers: s.customers.slice(),
    events: s.events.slice(), // synced_at is a storage column and is never part of an event
  }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x)
}

/**
 * The store the file carries must be a store this app can actually open: `restock_days` and
 * `multipliers` decide every trip and quantity (list.ts), `name` is the header, `updated_at` decides
 * import LWW, and `id` is what merge-or-replace is chosen on. The same fields the cloud decoder
 * insists on (sync/codec.ts `rowToStore`), for the same reason — a row missing them cannot be
 * derived — plus the two multipliers, which are read by number. `next_trip_override` may be absent
 * or null: nothing breaks without it.
 *
 * Contents beyond the store are deliberately not validated here: amounts and quantities are checked
 * at entry (BLUEPRINT §C), and events the domain does not recognise are simply never derived.
 */
function isStoreShape(x: unknown): boolean {
  if (!isObj(x)) return false
  const m = x.multipliers
  return (
    typeof x.id === 'string' &&
    x.id.length > 0 &&
    typeof x.name === 'string' &&
    Array.isArray(x.restock_days) &&
    typeof x.updated_at === 'string' &&
    isObj(m) &&
    typeof m.payday === 'number' &&
    typeof m.fri_sat === 'number' &&
    (x.next_trip_override === undefined || x.next_trip_override === null || typeof x.next_trip_override === 'string')
  )
}

export function isExportFile(x: unknown): x is ExportFile {
  if (!x || typeof x !== 'object') return false
  const f = x as Partial<ExportFile>
  return f.format === 'tindabot-export' && f.version === 1 && isStoreShape(f.store) && Array.isArray(f.products) && Array.isArray(f.events) && (f.customers === undefined || Array.isArray(f.customers))
}

export interface MergeResult {
  snapshot: Snapshot
  added_events: number
  updated_products: number
  updated_customers: number
  store_updated: boolean
}

function newer(a: { updated_at: ISODateTime }, b: { updated_at: ISODateTime }): boolean {
  return Date.parse(a.updated_at) > Date.parse(b.updated_at)
}

/**
 * Merge an export into an existing snapshot of the SAME store. Callers must check
 * `file.store.id === existing.store.id` first and ask the user before replacing a different store.
 */
export function mergeImport(existing: Snapshot, file: ExportFile): MergeResult {
  if (file.store.id !== existing.store.id) throw new Error('mergeImport: different store')

  const eventIds = new Set(existing.events.map((e) => e.id))
  const events = existing.events.slice()
  let added = 0
  for (const e of file.events) {
    if (eventIds.has(e.id)) continue
    eventIds.add(e.id)
    events.push(e)
    added++
  }

  const byId = new Map(existing.products.map((p) => [p.id, p]))
  let updated = 0
  for (const p of file.products) {
    const cur = byId.get(p.id)
    if (!cur) {
      byId.set(p.id, p)
      updated++
    } else if (newer(p, cur)) {
      byId.set(p.id, p)
      updated++
    }
  }

  const custById = new Map(existing.customers.map((c) => [c.id, c]))
  let updatedCustomers = 0
  for (const c of file.customers ?? []) {
    const cur = custById.get(c.id)
    if (!cur || newer(c, cur)) {
      custById.set(c.id, c)
      updatedCustomers++
    }
  }

  const store = newer(file.store, existing.store) ? file.store : existing.store
  return {
    snapshot: { store, products: [...byId.values()], customers: [...custById.values()], events },
    added_events: added,
    updated_products: updated,
    updated_customers: updatedCustomers,
    store_updated: store !== existing.store,
  }
}
