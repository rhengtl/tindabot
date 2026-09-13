// Dexie schema — local persistence. Events are write-once by id (add-or-ignore).
// `synced_at` is a storage-only column (P3); it is never part of the domain event.

import Dexie, { type EntityTable } from 'dexie'
import type { DomainEvent, Product, Store } from '../domain'

export type StoredEvent = DomainEvent & { synced_at?: string | null }

export interface MetaRow {
  key: string
  value: string
}

export class TindaDB extends Dexie {
  stores!: EntityTable<Store, 'id'>
  products!: EntityTable<Product, 'id'>
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
  }
}

export const db = new TindaDB()
