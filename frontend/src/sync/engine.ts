// Sync engine (P3a). Single-flight runner over the local Dexie store and a `CloudApi`.
//
// Data-safety rules it enforces (BLUEPRINT "Cloud backup (P3a)"):
//   - never deletes locally or remotely; pulls are add-or-ignore (events) and LWW (records)
//   - sync markers are set only after the server acknowledged the batch
//   - the device switches `current_store` only after a complete initial pull; an interrupted
//     pull is resumed from `claim_pending` + per-store cursors on the next run
//   - two populated stores with different ids are never merged or replaced automatically
//   - a `local_only` (demo) store is never pushed, never claimed
//   - clock skew > 5 min is a warning only
//
// Triggers: sign-in, launch, foreground, online, after local writes (debounced), manual.
// Errors back off 10 s → 1 min → 5 min until the next foreground/online/manual trigger.

import type { Customer, Product, Store } from '../domain'
import * as repo from '../db/repo'
import { type AuthApi, type CloudApi, type CloudUser, CloudError } from './api'
import { type ClaimDecision, decideClaim } from './claim'
import {
  EVENT_PUSH_BATCH,
  PULL_PAGE,
  SKEW_WARN_MS,
  type PullWindow,
  type RecordRow,
  type StoreRow,
  chunk,
  clockSkewMs,
  decodeAll,
  eventToRow,
  formatWindow,
  maxSeq,
  parseCursor,
  parseWindow,
  recordToRow,
  rowToCustomer,
  rowToEvent,
  rowToProduct,
  rowToStore,
  storeToRow,
} from './codec'

export type SyncPhase =
  | 'signed_out'
  /** signed in, but the current store is not (yet) connected to a cloud store */
  | 'unbound'
  /** current store is the demo (never synced) */
  | 'local_only'
  /** two populated stores — waiting for the user's choice */
  | 'needs_choice'
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error'

export interface ClaimChoiceInfo {
  cloud: { id: string; name: string; updated_at: string }
  local: { id: string; name: string }
}

export interface SyncStatus {
  phase: SyncPhase
  user: CloudUser | null
  boundStoreId: string | null
  lastSyncAt: string | null
  pendingEvents: number
  pendingRecords: number
  error: string | null
  /** device − server, ms; warning when |skew| > SKEW_WARN_MS */
  skewMs: number | null
  skewWarning: boolean
  choice: ClaimChoiceInfo | null
}

export type SyncReason = 'init' | 'signin' | 'write' | 'foreground' | 'online' | 'manual' | 'retry' | 'choice'

export interface EngineDeps {
  api: CloudApi
  /** Called after pulled data or a store switch changed what the app should show. */
  onPulled: () => Promise<void>
  onStatus?: (s: SyncStatus) => void
  now?: () => number
  isOnline?: () => boolean
  debounceMs?: number
  backoffMs?: number[]
}

export const META = {
  boundStore: 'cloud_store_id',
  boundUser: 'auth_user_id',
  claimPending: 'claim_pending',
  lastSyncAt: 'last_sync_at',
  lastError: 'last_sync_error',
  skew: 'clock_skew_ms',
  // Cursors hold an xid watermark: every row written by a transaction with a lower or equal id
  // has been pulled. The window keys hold an unfinished pull so it resumes in the same frozen set.
  cursorEvents: (id: string) => `cursor_events:${id}`,
  cursorProducts: (id: string) => `cursor_products:${id}`,
  cursorCustomers: (id: string) => `cursor_customers:${id}`,
  windowEvents: (id: string) => `window_events:${id}`,
  windowProducts: (id: string) => `window_products:${id}`,
  windowCustomers: (id: string) => `window_customers:${id}`,
} as const

const INITIAL: SyncStatus = {
  phase: 'signed_out',
  user: null,
  boundStoreId: null,
  lastSyncAt: null,
  pendingEvents: 0,
  pendingRecords: 0,
  error: null,
  skewMs: null,
  skewWarning: false,
  choice: null,
}

function describe(err: unknown): string {
  if (err instanceof CloudError) return err.message
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

export class SyncEngine {
  status: SyncStatus = { ...INITIAL }
  private readonly api: CloudApi
  private readonly onPulled: () => Promise<void>
  private readonly onStatus: (s: SyncStatus) => void
  private readonly now: () => number
  private readonly isOnline: () => boolean
  private readonly debounceMs: number
  private readonly backoffMs: number[]
  private running: Promise<void> | null = null
  private again: SyncReason | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private disposed = false
  private choiceDeferred = false

  constructor(deps: EngineDeps) {
    this.api = deps.api
    this.onPulled = deps.onPulled
    this.onStatus = deps.onStatus ?? (() => {})
    this.now = deps.now ?? (() => Date.now())
    this.isOnline = deps.isOnline ?? (() => (typeof navigator === 'undefined' || navigator.onLine === undefined ? true : navigator.onLine))
    this.debounceMs = deps.debounceMs ?? 2000
    this.backoffMs = deps.backoffMs ?? [10_000, 60_000, 300_000]
  }

  // ---------- public API ----------

  /** Sign-in / sign-out / session restore. */
  setUser(user: CloudUser | null): void {
    const changed = user?.id !== this.status.user?.id
    this.patch({ user })
    if (!user) {
      this.clearTimers()
      this.patch({ phase: 'signed_out', choice: null, boundStoreId: null, error: null })
      return
    }
    if (changed) this.requestSync('signin')
  }

  /** Coalesced trigger. Writes are debounced; everything else runs as soon as possible. */
  requestSync(reason: SyncReason): void {
    if (this.disposed || !this.status.user) return
    if (reason !== 'write' && reason !== 'retry') {
      this.failures = 0
      this.clearRetry()
    }
    if (reason === 'write') {
      if (this.debounceTimer) clearTimeout(this.debounceTimer)
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null
        void this.start(reason)
      }, this.debounceMs)
      return
    }
    void this.start(reason)
  }

  /** Manual "I-sync ngayon": runs immediately and resolves when the run is over. */
  async syncNow(): Promise<void> {
    if (this.disposed || !this.status.user) return
    this.failures = 0
    this.clearTimers()
    await this.start('manual')
    await this.whenIdle()
  }

  /** The user's answer to the two-populated-stores sheet. */
  async resolveClaim(choice: 'phone' | 'cloud' | 'later'): Promise<void> {
    const info = this.status.choice
    if (!info) return
    this.patch({ choice: null })
    if (choice === 'later') {
      // Stay unbound; only a manual sync or a new sign-in asks again (writes never re-open the sheet).
      this.choiceDeferred = true
      this.patch({ phase: 'unbound' })
      return
    }
    this.choiceDeferred = false
    await this.startExclusive('choice', async () => {
      try {
        if (choice === 'phone') {
          // Archive first: if the upload fails afterwards the account simply has no active store
          // and the next run resumes the upload. Archiving is a flag; nothing is deleted.
          await this.api.archiveStore(info.cloud.id)
          await this.bindLocal(info.local.id, this.status.user!.id)
        } else {
          await this.pullSwitch(info.cloud.id)
        }
        await this.sync()
      } catch (err) {
        await this.fail(err)
      }
    })
  }

  /** Resolves when no run is in progress (follow-up runs included). */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running
  }

  dispose(): void {
    this.disposed = true
    this.clearTimers()
  }

  // ---------- run loop ----------

  private patch(p: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...p }
    this.onStatus(this.status)
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private clearTimers(): void {
    this.clearRetry()
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = null
  }

  private start(reason: SyncReason): Promise<void> {
    return this.startExclusive(reason, () => this.run(reason))
  }

  /** Single-flight: a request that arrives during a run schedules exactly one follow-up run. */
  private startExclusive(reason: SyncReason, body: () => Promise<void>): Promise<void> {
    if (this.running) {
      this.again = reason
      return this.running
    }
    this.running = (async () => {
      try {
        await body()
      } finally {
        this.running = null
        const next = this.again
        this.again = null
        if (next && !this.disposed && this.status.user) void this.start(next)
      }
    })()
    return this.running
  }

  private async run(reason: SyncReason): Promise<void> {
    const user = this.status.user
    if (!user) return
    if (reason === 'manual' || reason === 'signin') this.choiceDeferred = false
    try {
      const cur = await repo.getMeta('current_store')
      if (!cur) {
        this.patch({ phase: 'unbound', boundStoreId: null })
        return
      }
      if (await repo.isLocalOnly(cur)) {
        // The demo is never pushed. Discovery still runs on sign-in / launch / manual so an
        // account that owns a store switches to it (and a pending pull resumes); ordinary
        // write triggers stay local.
        const pending = await repo.getMeta(META.claimPending)
        if (!pending && reason !== 'signin' && reason !== 'manual' && reason !== 'init' && reason !== 'choice') {
          this.patch({ phase: 'local_only', boundStoreId: null, choice: null })
          return
        }
      }
      let bound = await repo.getMeta(META.boundStore)
      const boundUser = await repo.getMeta(META.boundUser)
      if (bound && boundUser !== user.id) bound = null // another account: never reuse the binding
      const pending = await repo.getMeta(META.claimPending)
      if (!bound || bound !== cur || pending) {
        if (this.choiceDeferred && !pending) {
          this.patch({ phase: 'unbound', boundStoreId: null })
          return
        }
        const proceed = await this.discover(cur, user)
        if (!proceed) return
      } else {
        this.patch({ boundStoreId: bound })
      }
      await this.sync()
    } catch (err) {
      await this.fail(err)
    }
  }

  private async fail(err: unknown): Promise<void> {
    const msg = describe(err)
    await repo.setMeta(META.lastError, msg).catch(() => {})
    const counts = await this.pendingCounts()
    if (!this.isOnline() || (err instanceof CloudError && err.code === 'network')) {
      this.patch({ phase: 'offline', error: null, ...counts })
      return
    }
    this.patch({ phase: 'error', error: msg, ...counts })
    this.failures++
    const delay = this.backoffMs[Math.min(this.failures, this.backoffMs.length) - 1] ?? this.backoffMs[this.backoffMs.length - 1] ?? 60_000
    this.clearRetry()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.disposed) void this.start('retry')
    }, delay)
  }

  private async pendingCounts(): Promise<{ pendingEvents: number; pendingRecords: number }> {
    const cur = await repo.getMeta('current_store')
    if (!cur) return { pendingEvents: 0, pendingRecords: 0 }
    const [pendingEvents, pendingRecords] = await Promise.all([repo.countUnsyncedEvents(cur), repo.countDirtyRecords(cur)])
    return { pendingEvents, pendingRecords }
  }

  // ---------- discovery / claim ----------

  /** Returns true when a bound store is ready for a normal sync. */
  private async discover(cur: string, user: CloudUser): Promise<boolean> {
    if (!this.isOnline()) {
      this.patch({ phase: 'offline', error: null, ...(await this.pendingCounts()) })
      return false
    }
    this.patch({ phase: 'syncing', error: null })
    const cloudStores = await this.api.listMyStores()
    const snap = await repo.loadSnapshot(cur)
    const counts = await repo.countStoreData(cur)
    const decision = decideClaim({
      local: snap ? { store: snap.store, populated: counts.products + counts.customers + counts.events > 0, localOnly: await repo.isLocalOnly(cur) } : null,
      cloudStores,
      pendingCloudId: await repo.getMeta(META.claimPending),
    })
    return this.act(decision, user)
  }

  private async act(d: ClaimDecision, user: CloudUser): Promise<boolean> {
    switch (d.kind) {
      case 'none':
        this.patch({ phase: d.reason === 'local_only' ? 'local_only' : 'unbound', boundStoreId: null })
        return false
      case 'sync':
        await this.bind(d.storeId, user.id)
        return true
      case 'upload':
        await this.bindLocal(d.storeId, user.id)
        return true
      case 'pull_switch':
        await this.pullSwitch(d.cloudStoreId)
        return true
      case 'ask': {
        const name = rowToStore(d.cloud)?.name ?? d.cloud.id
        this.patch({
          phase: 'needs_choice',
          boundStoreId: null,
          choice: { cloud: { id: d.cloud.id, name, updated_at: d.cloud.updated_at }, local: { id: d.local.id, name: d.local.name } },
        })
        return false
      }
    }
  }

  private async bind(storeId: string, userId: string): Promise<void> {
    await repo.setMeta(META.boundStore, storeId)
    await repo.setMeta(META.boundUser, userId)
    this.patch({ boundStoreId: storeId, choice: null })
  }

  /**
   * Make the phone's store the account's store. If the cloud already has the row (e.g. archived by
   * a "keep the phone" choice on another device) it is un-archived; if it has none, the row is
   * created here so products/customers/events can reference it. Cursors restart from 0 when the
   * server knows nothing about the store.
   */
  private async bindLocal(storeId: string, userId: string): Promise<void> {
    const local = await repo.loadSnapshot(storeId)
    if (!local) throw new CloudError('store not found', 'unknown')
    const remote = await this.api.fetchStore(storeId)
    if (!remote) {
      await this.api.upsertStore(storeToRow(local.store))
      await repo.markRecordSynced('stores', storeId, local.store.updated_at)
      await repo.setMeta(META.cursorEvents(storeId), '0')
      await repo.setMeta(META.cursorProducts(storeId), '0')
      await repo.setMeta(META.cursorCustomers(storeId), '0')
    } else if (remote.archived_at) {
      await this.api.unarchiveStore(storeId)
    }
    await this.bind(storeId, userId)
  }

  /**
   * "Gamitin ang nasa cloud": pull the cloud store completely into Dexie as an additional local
   * store, then switch. The previous local store is left untouched. `claim_pending` + cursors make
   * an interrupted pull resumable; nothing is switched until the pull completed.
   */
  private async pullSwitch(cloudStoreId: string): Promise<void> {
    await repo.setMeta(META.claimPending, cloudStoreId)
    this.patch({ phase: 'syncing', error: null })
    const row = await this.api.fetchStore(cloudStoreId)
    const store = row && !row.archived_at ? rowToStore(row) : null
    if (!store) {
      await repo.deleteMeta(META.claimPending)
      throw new CloudError('Hindi na available ang tindahan sa cloud.', 'server')
    }
    await repo.applyPulledRecords({ store })
    const watermark = await this.api.syncWatermark()
    await this.pullRecords(cloudStoreId, watermark)
    await this.pullEvents(cloudStoreId, watermark)
    await repo.setCurrentStore(cloudStoreId)
    await this.bind(cloudStoreId, this.status.user!.id)
    await repo.deleteMeta(META.claimPending)
    await this.onPulled()
  }

  // ---------- sync proper ----------

  private async sync(): Promise<void> {
    const storeId = this.status.boundStoreId
    if (!storeId) return
    if (!this.isOnline()) {
      this.patch({ phase: 'offline', error: null, ...(await this.pendingCounts()) })
      return
    }
    this.patch({ phase: 'syncing', error: null })

    const skewMs = clockSkewMs(this.now(), await this.api.serverTime())
    if (skewMs !== null) await repo.setMeta(META.skew, String(skewMs))
    this.patch({ skewMs, skewWarning: skewMs !== null && Math.abs(skewMs) > SKEW_WARN_MS })

    const remote = await this.api.fetchStore(storeId)
    if (!remote || remote.archived_at) {
      // Archived: another device chose "keep the phone" with a different store. Missing: the
      // server no longer knows the store. Either way unbind and let the next run discover again
      // (which asks the user when both stores are populated, and never deletes anything).
      await repo.deleteMeta(META.boundStore)
      this.patch({ phase: 'unbound', boundStoreId: null })
      this.again = 'retry'
      return
    }

    let changed = await this.pushRecords(storeId)
    await this.pushEvents(storeId)

    // One high-water mark for the whole run: taken AFTER the push so this device's own writes are
    // inside it, and shared by both pulls.
    const watermark = await this.api.syncWatermark()
    const remoteStore = rowToStore(remote)
    if (remoteStore) changed = (await repo.applyPulledRecords({ store: remoteStore })).applied > 0 || changed
    changed = (await this.pullRecords(storeId, watermark)) || changed
    changed = (await this.pullEvents(storeId, watermark)) || changed
    if (changed) await this.onPulled()

    const at = new Date(this.now()).toISOString()
    await repo.setMeta(META.lastSyncAt, at)
    await repo.deleteMeta(META.lastError)
    this.failures = 0
    this.patch({ phase: 'idle', lastSyncAt: at, error: null, ...(await this.pendingCounts()) })
  }

  /**
   * Pushes dirty records, then reconciles the pushed ids with the server copy: a row the LWW
   * guard rejected (older `updated_at`, e.g. a device clock behind another device) is replaced
   * locally by the newer cloud row instead of silently diverging. Returns true when a local row
   * changed.
   */
  private async pushRecords(storeId: string): Promise<boolean> {
    const dirty = await repo.dirtyRecords(storeId)
    let changed = false
    if (dirty.store) {
      await this.api.upsertStore(storeToRow(dirty.store))
      await repo.markRecordSynced('stores', storeId, dirty.store.updated_at)
      const after = await this.api.fetchStore(storeId)
      const st = after && !after.archived_at ? rowToStore(after) : null
      if (st) changed = (await repo.applyPulledRecords({ store: st })).applied > 0 || changed
    }
    changed = (await this.pushTable('products', storeId, dirty.products, rowToProduct, (items) => ({ products: items as Product[] }))) || changed
    changed = (await this.pushTable('customers', storeId, dirty.customers, rowToCustomer, (items) => ({ customers: items as Customer[] }))) || changed
    return changed
  }

  private async pushTable<T extends Product | Customer>(
    table: 'products' | 'customers',
    storeId: string,
    recs: T[],
    decode: (r: RecordRow) => T | null,
    wrap: (items: T[]) => repo.PulledRecords,
  ): Promise<boolean> {
    let changed = false
    for (const batch of chunk(recs, EVENT_PUSH_BATCH)) {
      await this.api.upsertRecords(table, batch.map(recordToRow))
      for (const r of batch) await repo.markRecordSynced(table, r.id, r.updated_at)
      const rows = await this.api.fetchRecords(table, storeId, batch.map((r) => r.id))
      const { items } = decodeAll(rows, decode)
      const r = await repo.applyPulledRecords(wrap(items.filter((x) => x.store_id === storeId)))
      changed = changed || r.applied > 0
    }
    return changed
  }

  private async pushEvents(storeId: string): Promise<void> {
    const pending = await repo.unsyncedEvents(storeId)
    for (const batch of chunk(pending, EVENT_PUSH_BATCH)) {
      await this.api.insertEvents(batch.map(eventToRow))
      await repo.markEventsSynced(
        batch.map((e) => e.id),
        new Date(this.now()).toISOString(),
      )
    }
  }

  /** Returns true when anything new was applied. */
  private async pullRecords(storeId: string, watermark: number): Promise<boolean> {
    const a = await this.pullTable(storeId, 'products', watermark, rowToProduct, (items) => ({ products: items }))
    const b = await this.pullTable(storeId, 'customers', watermark, rowToCustomer, (items) => ({ customers: items }))
    return a || b
  }

  private async pullTable<T extends Product | Customer>(
    storeId: string,
    table: 'products' | 'customers',
    watermark: number,
    decode: (r: RecordRow) => T | null,
    wrap: (items: T[]) => repo.PulledRecords,
  ): Promise<boolean> {
    return this.pullWindowed(
      table === 'products' ? META.cursorProducts(storeId) : META.cursorCustomers(storeId),
      table === 'products' ? META.windowProducts(storeId) : META.windowCustomers(storeId),
      watermark,
      (win) => this.api.pullRecords(table, storeId, win, PULL_PAGE),
      async (rows) => {
        const { items } = decodeAll(rows, decode)
        const r = await repo.applyPulledRecords(wrap(items.filter((x) => x.store_id === storeId)))
        return { changed: r.applied > 0, last: maxSeq(rows, 'server_rev') }
      },
    )
  }

  private async pullEvents(storeId: string, watermark: number): Promise<boolean> {
    return this.pullWindowed(
      META.cursorEvents(storeId),
      META.windowEvents(storeId),
      watermark,
      (win) => this.api.pullEvents(storeId, win, PULL_PAGE),
      async (rows) => {
        const { items } = decodeAll(rows, rowToEvent)
        const added = await repo.addEvents(
          items.filter((e) => e.store_id === storeId),
          new Date(this.now()).toISOString(),
        )
        return { changed: added > 0, last: maxSeq(rows, 'server_seq') }
      },
    )
  }

  /**
   * Window-bounded pull (see `PullWindow`). The cursor advances only to `hi - 1` once the whole
   * frozen window `(cursor, hi)` has been drained, so it can never pass a row whose transaction
   * had not committed when `hi` was taken. Rows committed during the pull have a higher xid, fall
   * outside the window, and are picked up by the next run — never skipped, never lost.
   * An interrupted pull keeps `hi` and the page cursor in meta and resumes in the same set;
   * re-reading part of it is harmless (events are add-or-ignore, records are LWW).
   */
  private async pullWindowed<R>(
    cursorKey: string,
    windowKey: string,
    watermark: number,
    fetch: (win: PullWindow) => Promise<R[]>,
    apply: (rows: R[]) => Promise<{ changed: boolean; last: number }>,
  ): Promise<boolean> {
    let cursor = parseCursor(await repo.getMeta(cursorKey))
    let pending = parseWindow(await repo.getMeta(windowKey))
    let changed = false
    for (;;) {
      const hi = pending?.hi ?? watermark
      if (hi - 1 <= cursor) {
        if (pending) await repo.deleteMeta(windowKey)
        break
      }
      let after = pending?.seq ?? 0
      for (;;) {
        const rows = await fetch({ afterXid: cursor, beforeXid: hi, after })
        if (rows.length === 0) break
        const r = await apply(rows)
        changed = changed || r.changed
        after = Math.max(after, r.last)
        await repo.setMeta(windowKey, formatWindow(hi, after))
        if (rows.length < PULL_PAGE) break
      }
      cursor = hi - 1
      await repo.setMeta(cursorKey, String(cursor))
      await repo.deleteMeta(windowKey)
      pending = null
      if (watermark - 1 <= cursor) break // a resumed older window may leave newer data for this pass
    }
    return changed
  }
}

/** Wires auth changes into the engine. Returns an unsubscribe. */
export function connectAuth(auth: AuthApi, engine: SyncEngine): () => void {
  return auth.onChange((user) => engine.setUser(user))
}

export type { StoreRow }
