// Dexie schema — local persistence. Events are write-once by id (add-or-ignore).
// Storage-only sync markers (P3a) live beside the domain fields and are never part of a domain
// object: `loadSnapshot` strips them, so derivation and export files never see them.
//   events.synced_at            — server acknowledged this event (null/absent = still to push)
//   records.synced_updated_at   — the `updated_at` the server last acknowledged (dirty ⇔ ≠ updated_at)
//   stores.local_only           — never synced (demo store)
// None of these are indexed, so adding them needs no schema version bump.

import Dexie, { type EntityTable } from 'dexie'
import type { Customer, DomainEvent, Product, Store } from '../domain'

export type StoredEvent = DomainEvent & { synced_at?: string | null }
export type StoredProduct = Product & { synced_updated_at?: string | null }
export type StoredCustomer = Customer & { synced_updated_at?: string | null }
export type StoredStore = Store & { synced_updated_at?: string | null; local_only?: boolean }

export interface MetaRow {
  key: string
  value: string
}

export class TindaDB extends Dexie {
  stores!: EntityTable<StoredStore, 'id'>
  products!: EntityTable<StoredProduct, 'id'>
  customers!: EntityTable<StoredCustomer, 'id'>
  events!: EntityTable<StoredEvent, 'id'>
  meta!: EntityTable<MetaRow, 'key'>

  constructor() {
    super('tindabot')
    this.version(1).stores({
      stores: 'id',
      products: 'id, store_id',
      events: 'id, store_id, ts, type, [store_id+type]',
      meta: 'key',
    })
    // P2: customers (records, LWW by updated_at). Existing stores are unchanged.
    this.version(2).stores({
      customers: 'id, store_id',
    })
    // The old `last_export_attempt_at` meta row is gone: since exports record a hand-off in
    // `last_backup_at`, nothing writes or reads it any more, so devices upgraded from v2 drop the
    // leftover row. Only that one key is touched; a database that never had it upgrades to nothing.
    this.version(3).upgrade((tx) => tx.table('meta').delete('last_export_attempt_at'))
  }
}

export const db = new TindaDB()
