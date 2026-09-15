// In-memory CloudApi that mirrors the server rules in supabase/migrations/0001_p3a.sql:
// write-once events, LWW guard on records, created_by forced to the caller, owner membership on
// store insert, archived flag via RPC only, per-row server_rev / server_seq sequences, membership
// visibility. Used by the engine/claim tests so they run without any online project.
// Failure injection: `offline` (network errors) and `failNext` (one server error).

import { type CloudApi, CloudError, type RecordTable } from '../api'
import type { EventRow, RecordRow, StoreRow } from '../codec'

interface FakeStoreRow extends StoreRow {
  server_rev: number
  created_by: string
  archived_at: string | null
}

/** Shared server state so several `FakeCloud` views (one per account) see the same rows. */
export class FakeServer {
  stores = new Map<string, FakeStoreRow>()
  members = new Map<string, Set<string>>() // store_id → user ids (all owners in P3a)
  products = new Map<string, RecordRow & { server_rev: number }>()
  customers = new Map<string, RecordRow & { server_rev: number }>()
  events = new Map<string, EventRow & { server_seq: number }>()
  rev = 0
  seq = 0
  offline = false
  failNext: string | null = null
  /** throw once when this call name comes up (e.g. 'pullEvents', 'insertEvents') */
  failOn: string | null = null
  calls: string[] = []
  /** server clock override (ISO) for skew tests */
  serverNow: (() => string) | null = null

  eventsOf(storeId: string) {
    return [...this.events.values()].filter((e) => e.store_id === storeId)
  }
}

export class FakeCloud implements CloudApi {
  readonly server: FakeServer
  user: string

  constructor(user: string, server = new FakeServer()) {
    this.user = user
    this.server = server
  }

  /** Same cloud seen by another account. */
  as(user: string): FakeCloud {
    return new FakeCloud(user, this.server)
  }

  get stores() {
    return this.server.stores
  }
  get members() {
    return this.server.members
  }
  get products() {
    return this.server.products
  }
  get customers() {
    return this.server.customers
  }
  get events() {
    return this.server.events
  }
  get calls() {
    return this.server.calls
  }
  set offline(v: boolean) {
    this.server.offline = v
  }
  get offline() {
    return this.server.offline
  }
  set failNext(v: string | null) {
    this.server.failNext = v
  }
  set failOn(v: string | null) {
    this.server.failOn = v
  }
  set serverNow(v: (() => string) | null) {
    this.server.serverNow = v
  }
  eventsOf(storeId: string) {
    return this.server.eventsOf(storeId)
  }

  private guard(what: string) {
    const st = this.server
    st.calls.push(what)
    if (st.offline) throw new CloudError('Walang koneksyon.', 'network')
    if (st.failNext) {
      const m = st.failNext
      st.failNext = null
      throw new CloudError(m, 'server')
    }
    if (st.failOn === what) {
      st.failOn = null
      throw new CloudError(`injected failure: ${what}`, 'server')
    }
  }

  private isMember(storeId: string): boolean {
    return this.members.get(storeId)?.has(this.user) ?? false
  }

  async serverTime(): Promise<string> {
    this.guard('serverTime')
    return this.server.serverNow ? this.server.serverNow() : new Date().toISOString()
  }

  async listMyStores(): Promise<StoreRow[]> {
    this.guard('listMyStores')
    return [...this.stores.values()].filter((s) => !s.archived_at && this.isMember(s.id)).map((s) => ({ ...s }))
  }

  async fetchStore(id: string): Promise<StoreRow | null> {
    this.guard('fetchStore')
    const s = this.stores.get(id)
    return s && this.isMember(id) ? { ...s } : null
  }

  async upsertStore(row: StoreRow): Promise<void> {
    this.guard('upsertStore')
    const cur = this.stores.get(row.id)
    if (!cur) {
      this.stores.set(row.id, { id: row.id, body: row.body, updated_at: row.updated_at, server_rev: ++this.server.rev, created_by: this.user, archived_at: null })
      this.members.set(row.id, new Set([this.user])) // owner trigger
      return
    }
    if (!this.isMember(row.id)) throw new CloudError('permission denied', 'denied')
    if (Date.parse(row.updated_at) <= Date.parse(cur.updated_at)) return // lww_guard: RETURN NULL
    this.stores.set(row.id, { ...cur, body: row.body, updated_at: row.updated_at, server_rev: ++this.server.rev })
  }

  async upsertRecords(table: RecordTable, rows: RecordRow[]): Promise<void> {
    this.guard(`upsert:${table}`)
    const t = this[table]
    for (const r of rows) {
      if (!this.isMember(r.store_id)) throw new CloudError('permission denied', 'denied')
      const cur = t.get(r.id)
      if (cur && Date.parse(r.updated_at) <= Date.parse(cur.updated_at)) continue
      t.set(r.id, { id: r.id, store_id: r.store_id, body: r.body, updated_at: r.updated_at, server_rev: ++this.server.rev })
    }
  }

  async insertEvents(rows: EventRow[]): Promise<void> {
    this.guard('insertEvents')
    for (const r of rows) {
      if (!this.isMember(r.store_id)) throw new CloudError('permission denied', 'denied')
      if (this.events.has(r.id)) continue // ON CONFLICT DO NOTHING
      this.events.set(r.id, { id: r.id, store_id: r.store_id, type: r.type, ts: r.ts, body: r.body, server_seq: ++this.server.seq })
    }
  }

  async pullRecords(table: RecordTable, storeId: string, afterRev: number, limit: number): Promise<RecordRow[]> {
    this.guard(`pull:${table}`)
    if (!this.isMember(storeId)) return []
    return [...this[table].values()]
      .filter((r) => r.store_id === storeId && r.server_rev > afterRev)
      .sort((a, b) => a.server_rev - b.server_rev)
      .slice(0, limit)
      .map((r) => ({ ...r }))
  }

  async fetchRecords(table: RecordTable, storeId: string, ids: string[]): Promise<RecordRow[]> {
    this.guard(`fetch:${table}`)
    if (!this.isMember(storeId)) return []
    const want = new Set(ids)
    return [...this[table].values()].filter((r) => r.store_id === storeId && want.has(r.id)).map((r) => ({ ...r }))
  }

  async pullEvents(storeId: string, afterSeq: number, limit: number): Promise<EventRow[]> {
    this.guard('pullEvents')
    if (!this.isMember(storeId)) return []
    return [...this.events.values()]
      .filter((e) => e.store_id === storeId && e.server_seq > afterSeq)
      .sort((a, b) => a.server_seq - b.server_seq)
      .slice(0, limit)
      .map((e) => ({ ...e }))
  }

  async archiveStore(id: string): Promise<void> {
    this.guard('archiveStore')
    const s = this.stores.get(id)
    if (!s || !this.isMember(id)) throw new CloudError('not owner', 'denied')
    s.archived_at = s.archived_at ?? new Date().toISOString()
  }

  async unarchiveStore(id: string): Promise<void> {
    this.guard('unarchiveStore')
    const s = this.stores.get(id)
    if (!s || !this.isMember(id)) throw new CloudError('not owner', 'denied')
    s.archived_at = null
  }
}
