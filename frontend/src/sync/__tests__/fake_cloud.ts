// In-memory CloudApi that mirrors the server rules in supabase/migrations/0001_p3a.sql:
// write-once events, LWW guard on records, created_by forced to the caller, owner membership on
// store insert, archived flag via RPC only, per-row server_rev / server_seq sequences, membership
// visibility. Used by the engine/claim tests so they run without any online project.
//
// It also models Postgres MVCC well enough to reproduce the pull race: a write allocates its
// sequence number AND a transaction id immediately, but the row stays invisible until the
// transaction commits — so a row with a LOWER sequence can appear AFTER a higher one.
// `syncWatermark()` returns the lowest running transaction id (pg_snapshot_xmin), and reads only
// see committed rows. `begin()` opens an explicit transaction; every other write auto-commits.
//
// Failure injection: `offline` (network errors), `failNext` and `failOn` (one server error).

import { type CloudApi, CloudError, type RecordTable } from '../api'
import type { EventRow, PullWindow, RecordRow, StoreRow } from '../codec'

interface Versioned {
  xid: number
  committed: boolean
}
interface FakeStoreRow extends StoreRow, Versioned {
  server_rev: number
  created_by: string
  archived_at: string | null
}
type FakeRecordRow = RecordRow & Versioned & { server_rev: number }
type FakeEventRow = EventRow & Versioned & { server_seq: number }

/** Shared server state so several `FakeCloud` views (one per account) see the same rows. */
export class FakeServer {
  stores = new Map<string, FakeStoreRow>()
  members = new Map<string, Set<string>>() // store_id → user ids (all owners in P3a)
  products = new Map<string, FakeRecordRow>()
  customers = new Map<string, FakeRecordRow>()
  events = new Map<string, FakeEventRow>()
  rev = 0
  seq = 0
  nextXid = 1
  /** transactions that have written but not finished — exactly what holds the watermark down */
  active = new Set<number>()
  offline = false
  failNext: string | null = null
  /** throw once when this call name comes up (e.g. 'pullEvents', 'insertEvents') */
  failOn: string | null = null
  calls: string[] = []
  /** server clock override (ISO) for skew tests */
  serverNow: (() => string) | null = null

  /** pg_snapshot_xmin: the lowest still-running transaction id. */
  watermark(): number {
    let min = this.nextXid
    for (const x of this.active) if (x < min) min = x
    return min
  }

  eventsOf(storeId: string) {
    return [...this.events.values()].filter((e) => e.store_id === storeId && e.committed)
  }
}

/** An open transaction: its rows are written but invisible until commit(). */
export class FakeTx {
  readonly xid: number
  private readonly rows: Versioned[] = []
  private readonly undo: Array<() => void> = []

  constructor(
    private readonly cloud: FakeCloud,
    private readonly server: FakeServer,
  ) {
    this.xid = server.nextXid++
    server.active.add(this.xid)
  }

  /** @internal — called by FakeCloud for every row it writes inside this transaction. */
  track(row: Versioned, undo: () => void): void {
    this.rows.push(row)
    this.undo.push(undo)
  }

  async insertEvents(rows: EventRow[]): Promise<void> {
    await this.cloud.insertEvents(rows, this)
  }
  async upsertRecords(table: RecordTable, rows: RecordRow[]): Promise<void> {
    await this.cloud.upsertRecords(table, rows, this)
  }

  commit(): void {
    for (const r of this.rows) r.committed = true
    this.server.active.delete(this.xid)
  }

  /** Aborted transaction: the rows never become visible, but their sequence numbers are spent. */
  rollback(): void {
    for (const u of this.undo) u()
    this.server.active.delete(this.xid)
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

  /** Opens an explicit transaction whose writes stay invisible until commit(). */
  begin(): FakeTx {
    return new FakeTx(this, this.server)
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

  /** Runs `body` in `tx`, or in a transaction of its own that commits immediately. */
  private inTx<T>(tx: FakeTx | undefined, body: (tx: FakeTx) => T): T {
    if (tx) return body(tx)
    const own = this.begin()
    try {
      const out = body(own)
      own.commit()
      return out
    } catch (err) {
      own.rollback()
      throw err
    }
  }

  async serverTime(): Promise<string> {
    this.guard('serverTime')
    return this.server.serverNow ? this.server.serverNow() : new Date().toISOString()
  }

  async syncWatermark(): Promise<number> {
    this.guard('syncWatermark')
    return this.server.watermark()
  }

  async listMyStores(): Promise<StoreRow[]> {
    this.guard('listMyStores')
    return [...this.stores.values()].filter((s) => s.committed && !s.archived_at && this.isMember(s.id)).map((s) => ({ ...s }))
  }

  async fetchStore(id: string): Promise<StoreRow | null> {
    this.guard('fetchStore')
    const s = this.stores.get(id)
    return s && s.committed && this.isMember(id) ? { ...s } : null
  }

  async upsertStore(row: StoreRow, tx?: FakeTx): Promise<void> {
    this.guard('upsertStore')
    this.inTx(tx, (t) => {
      const cur = this.stores.get(row.id)
      if (!cur) {
        const fresh: FakeStoreRow = {
          id: row.id,
          body: row.body,
          updated_at: row.updated_at,
          server_rev: ++this.server.rev,
          created_by: this.user,
          archived_at: null,
          xid: t.xid,
          committed: false,
        }
        this.stores.set(row.id, fresh)
        this.members.set(row.id, new Set([this.user])) // owner trigger
        t.track(fresh, () => {
          this.stores.delete(row.id)
          this.members.delete(row.id)
        })
        return
      }
      if (!this.isMember(row.id)) throw new CloudError('permission denied', 'denied')
      if (Date.parse(row.updated_at) <= Date.parse(cur.updated_at)) return // lww_guard: RETURN NULL
      const prev = { ...cur }
      Object.assign(cur, { body: row.body, updated_at: row.updated_at, server_rev: ++this.server.rev, xid: t.xid, committed: false })
      t.track(cur, () => Object.assign(cur, prev))
    })
  }

  async upsertRecords(table: RecordTable, rows: RecordRow[], tx?: FakeTx): Promise<void> {
    this.guard(`upsert:${table}`)
    this.inTx(tx, (t) => {
      const store = this[table]
      for (const r of rows) {
        if (!this.isMember(r.store_id)) throw new CloudError('permission denied', 'denied')
        const cur = store.get(r.id)
        if (cur && Date.parse(r.updated_at) <= Date.parse(cur.updated_at)) continue
        if (cur) {
          const prev = { ...cur }
          Object.assign(cur, { body: r.body, updated_at: r.updated_at, server_rev: ++this.server.rev, xid: t.xid, committed: false })
          t.track(cur, () => Object.assign(cur, prev))
        } else {
          const fresh: FakeRecordRow = { id: r.id, store_id: r.store_id, body: r.body, updated_at: r.updated_at, server_rev: ++this.server.rev, xid: t.xid, committed: false }
          store.set(r.id, fresh)
          t.track(fresh, () => store.delete(r.id))
        }
      }
    })
  }

  async insertEvents(rows: EventRow[], tx?: FakeTx): Promise<void> {
    this.guard('insertEvents')
    this.inTx(tx, (t) => {
      for (const r of rows) {
        if (!this.isMember(r.store_id)) throw new CloudError('permission denied', 'denied')
        if (this.events.has(r.id)) continue // ON CONFLICT DO NOTHING
        const fresh: FakeEventRow = { id: r.id, store_id: r.store_id, type: r.type, ts: r.ts, body: r.body, server_seq: ++this.server.seq, xid: t.xid, committed: false }
        this.events.set(r.id, fresh)
        t.track(fresh, () => this.events.delete(r.id))
      }
    })
  }

  async pullRecords(table: RecordTable, storeId: string, win: PullWindow, limit: number): Promise<RecordRow[]> {
    this.guard(`pull:${table}`)
    if (!this.isMember(storeId)) return []
    return [...this[table].values()]
      .filter((r) => r.committed && r.store_id === storeId && r.xid > win.afterXid && r.xid < win.beforeXid && r.server_rev > win.after)
      .sort((a, b) => a.server_rev - b.server_rev)
      .slice(0, limit)
      .map((r) => ({ ...r }))
  }

  async fetchRecords(table: RecordTable, storeId: string, ids: string[]): Promise<RecordRow[]> {
    this.guard(`fetch:${table}`)
    if (!this.isMember(storeId)) return []
    const want = new Set(ids)
    return [...this[table].values()].filter((r) => r.committed && r.store_id === storeId && want.has(r.id)).map((r) => ({ ...r }))
  }

  async pullEvents(storeId: string, win: PullWindow, limit: number): Promise<EventRow[]> {
    this.guard('pullEvents')
    if (!this.isMember(storeId)) return []
    return [...this.events.values()]
      .filter((e) => e.committed && e.store_id === storeId && e.xid > win.afterXid && e.xid < win.beforeXid && e.server_seq > win.after)
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
