// Sync engine (P3a). Single-flight runner over the local Dexie store and a `CloudApi`.
//
// Data-safety rules it enforces (BLUEPRINT "Cloud backup (P3a)"):
//   - never deletes locally or remotely; pulls are add-or-ignore (events) and LWW (records)
//   - sync markers are set only after the server acknowledged the batch
//   - the device switches `current_store` only after a complete initial pull; an interrupted
//     pull is resumed from `claim_pending` + per-store cursors on the next run
//   - several stores per account (2026-09-30): a phone store missing from the cloud is uploaded as
//     its own store, and the account's stores missing from the phone are pulled in as additional
//     local stores without switching; stores are never merged or replaced
//   - a store deleted on this phone is archived in the cloud (never deleted there) and never pulled
//     back; a store archived by another device is not re-uploaded or un-archived here
//   - a `local_only` (demo) store is never pushed, never claimed
//   - clock skew > 5 min is a warning only
//
// Triggers: sign-in, launch, foreground, online, after local writes (debounced), manual.
// Errors back off 10 s → 1 min → 5 min until the next foreground/online/manual trigger.

import type { Customer, Product, Store } from '../domain'
import * as repo from '../db/repo'
import { type AuthApi, type CloudApi, type CloudErrorCode, type CloudUser, CloudError, type JoinResult } from './api'
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
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error'

export interface SyncError {
  code: CloudErrorCode
  detail: string
}

export interface SyncStatus {
  phase: SyncPhase
  user: CloudUser | null
  boundStoreId: string | null
  lastSyncAt: string | null
  pendingEvents: number
  pendingRecords: number
  /** Last failure: `code` is what the UI shows (localized); `detail` is developer text only. */
  error: SyncError | null
  /** device − server, ms; warning when |skew| > SKEW_WARN_MS */
  skewMs: number | null
  skewWarning: boolean
  /** The signed-in user's role in the bound store (household, P5); null until known. */
  role: 'owner' | 'member' | null
}

export type SyncReason = 'init' | 'signin' | 'write' | 'foreground' | 'online' | 'manual' | 'retry'

export interface EngineDeps {
  api: CloudApi
  /** Called after pulled data or a store switch changed what the app should show. */
  onPulled: () => Promise<void>
  onStatus?: (s: SyncStatus) => void
  now?: () => number
  isOnline?: () => boolean
  debounceMs?: number
  backoffMs?: number[]
  /** Backoff for `unavailable` (paused/unreachable project); default 1 min → 5 min → 15 min. */
  unavailableBackoffMs?: number[]
  /** rows per pull page (default PULL_PAGE); tests lower it to exercise multi-page windows */
  pullPage?: number
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
  /** an additional cloud store whose first pull onto this phone has not finished yet */
  adoptPending: (id: string) => `adopt_pending:${id}`,
  /** this store was archived in the cloud (deleted on another device): not uploaded again */
  gone: (id: string) => `cloud_gone:${id}`,
  /** household: this phone's account is a member (not the owner) of the store */
  member: (id: string) => `member_of:${id}`,
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
  role: null,
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
  private readonly unavailableBackoffMs: number[]
  private readonly pullPage: number
  private running: Promise<void> | null = null
  private again: SyncReason | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay: number | null = null
  private failures = 0
  private disposed = false

  constructor(deps: EngineDeps) {
    this.api = deps.api
    this.onPulled = deps.onPulled
    this.onStatus = deps.onStatus ?? (() => {})
    this.now = deps.now ?? (() => Date.now())
    this.isOnline = deps.isOnline ?? (() => (typeof navigator === 'undefined' || navigator.onLine === undefined ? true : navigator.onLine))
    this.debounceMs = deps.debounceMs ?? 2000
    this.backoffMs = deps.backoffMs ?? [10_000, 60_000, 300_000]
    this.unavailableBackoffMs = deps.unavailableBackoffMs ?? [60_000, 300_000, 900_000]
    this.pullPage = deps.pullPage ?? PULL_PAGE
  }

  // ---------- public API ----------

  /** Sign-in / sign-out / session restore. */
  setUser(user: CloudUser | null): void {
    const changed = user?.id !== this.status.user?.id
    this.patch({ user })
    if (!user) {
      this.clearTimers()
      this.patch({ phase: 'signed_out', boundStoreId: null, error: null, role: null })
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

  /**
   * Household: redeem an invite code, then pull the joined store onto this phone (without
   * switching — the caller decides). The code is checked by the server; nothing local changes when
   * it is refused.
   */
  async join(code: string): Promise<JoinResult> {
    if (this.disposed || !this.status.user) throw new CloudError('not signed in', 'auth')
    const r = await this.api.joinStore(code)
    if ('storeId' in r) {
      await this.whenIdle()
      await this.startExclusive('manual', async () => {
        try {
          await this.adoptMissing()
        } catch (err) {
          await this.fail(err)
          throw err
        }
      })
    }
    return r
  }

  /** Delay of the retry currently scheduled after a failure (null when none is pending). */
  get nextRetryDelayMs(): number | null {
    return this.retryTimer ? this.retryDelay : null
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
    try {
      // Stores deleted on this phone leave the account's active list first, so nothing below can
      // pull them back.
      if (this.isOnline()) await this.archiveDeleted()
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
        if (!pending && reason !== 'signin' && reason !== 'manual' && reason !== 'init') {
          this.patch({ phase: 'local_only', boundStoreId: null })
          return
        }
      }
      if (await repo.getMeta(META.gone(cur))) {
        // Archived in the cloud, i.e. deleted on another device: this copy stays on the phone and
        // is not uploaded or un-archived again. Nothing to retry.
        this.patch({ phase: 'error', error: { code: 'store_gone', detail: 'store archived in the cloud' }, boundStoreId: null })
        return
      }
      let bound = await repo.getMeta(META.boundStore)
      const boundUser = await repo.getMeta(META.boundUser)
      if (bound && boundUser !== user.id) bound = null // another account: never reuse the binding
      const pending = await repo.getMeta(META.claimPending)
      if (!bound || bound !== cur || pending) {
        const proceed = await this.discover(cur, user)
        if (!proceed) return
      } else {
        this.patch({ boundStoreId: bound })
      }
      await this.sync()
      // The account's other stores: pulled in on launch, sign-in, foreground and manual runs, not
      // after every local write.
      if (reason !== 'write') await this.adoptMissing()
    } catch (err) {
      await this.fail(err)
    }
  }

  /** Archives, in the cloud, every store deleted on this phone (queued while offline or signed out). */
  private async archiveDeleted(): Promise<void> {
    for (const id of await repo.deletedStoreIds()) {
      try {
        await this.api.archiveStore(id)
      } catch (err) {
        // Not the account's own store: a household member leaves it instead (the owner's store and
        // every entry stay). Never uploaded: nothing in the cloud to hide.
        if (!(err instanceof CloudError && (err.code === 'denied' || err.code === 'store_gone'))) throw err
        try {
          await this.api.leaveStore(id)
        } catch (leaveErr) {
          if (!(leaveErr instanceof CloudError && (leaveErr.code === 'denied' || leaveErr.code === 'store_gone' || leaveErr.code === 'server'))) throw leaveErr
        }
      }
      await repo.forgetDeletedStore(id)
    }
  }

  /**
   * Every active store of the account that is not (completely) on this phone is pulled in as an
   * additional local store, without switching to it. A pull interrupted half-way is finished on a
   * later run (`adopt_pending`); stores deleted on this phone are never pulled back.
   */
  private async adoptMissing(): Promise<void> {
    const cur = await repo.getMeta('current_store')
    const deleted = new Set(await repo.deletedStoreIds())
    let changed = false
    for (const row of await this.api.listMyStores()) {
      if (row.archived_at || row.id === cur || deleted.has(row.id)) continue
      const unfinished = await repo.getMeta(META.adoptPending(row.id))
      if (!unfinished && (await repo.storeExists(row.id))) continue
      const store = rowToStore(row)
      if (!store) continue
      await repo.setMeta(META.adoptPending(row.id), '1')
      await repo.applyPulledRecords({ store })
      await this.pullStoreData(row.id)
      await repo.deleteMeta(META.adoptPending(row.id))
      changed = true
    }
    if (changed) await this.onPulled()
  }

  /** Pulls a store's records and events up to one fresh watermark (resumable through its cursors). */
  private async pullStoreData(storeId: string): Promise<void> {
    const watermark = await this.api.syncWatermark()
    await this.pullRecords(storeId, watermark)
    await this.pullEvents(storeId, watermark)
  }

  private async fail(err: unknown): Promise<void> {
    const msg = describe(err)
    await repo.setMeta(META.lastError, msg).catch(() => {})
    const counts = await this.pendingCounts()
    if (!this.isOnline() || (err instanceof CloudError && err.code === 'network')) {
      this.patch({ phase: 'offline', error: null, ...counts })
      return
    }
    const code = err instanceof CloudError ? err.code : 'unknown'
    this.patch({ phase: 'error', error: { code, detail: msg }, ...counts })
    this.failures++
    // Nothing local is touched here: queued events and records stay queued and the next run
    // (foreground, online, manual, or this timer) pushes them.
    const ladder = code === 'unavailable' ? this.unavailableBackoffMs : this.backoffMs
    const delay = ladder[Math.min(this.failures, ladder.length) - 1] ?? ladder[ladder.length - 1] ?? 60_000
    this.retryDelay = delay
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
      local: snap
        ? {
            store: snap.store,
            populated: counts.products + counts.customers + counts.events > 0,
            localOnly: await repo.isLocalOnly(cur),
            otherRealStores: (await repo.latestRealStore(cur)) !== null,
          }
        : null,
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
    }
  }

  private async bind(storeId: string, userId: string): Promise<void> {
    await repo.setMeta(META.boundStore, storeId)
    await repo.setMeta(META.boundUser, userId)
    this.patch({ boundStoreId: storeId })
  }

  /**
   * Make the phone's store one of the account's stores. If the cloud has no row, it is created here
   * so products/customers/events can reference it, and cursors restart from 0. If the row is
   * archived, the store was deleted on another device: it is not un-archived, and this phone stops
   * syncing it (`cloud_gone`) while keeping its copy.
   */
  private async bindLocal(storeId: string, userId: string): Promise<void> {
    const local = await repo.loadSnapshot(storeId)
    if (!local) throw new CloudError('store not found', 'unknown')
    const remote = await this.api.fetchStore(storeId)
    if (!remote) {
      try {
        await this.api.upsertStore(storeToRow(local.store))
      } catch (err) {
        // The id exists in the cloud but this account cannot see it: a household member who was
        // removed (or left on another phone). The copy stays here; it is not uploaded again.
        if (err instanceof CloudError && err.code === 'denied') {
          await repo.setMeta(META.gone(storeId), new Date(this.now()).toISOString())
          throw new CloudError('store no longer shared with this account', 'store_gone')
        }
        throw err
      }
      await repo.markRecordSynced('stores', storeId, local.store.updated_at)
      await repo.setMeta(META.cursorEvents(storeId), '0')
      await repo.setMeta(META.cursorProducts(storeId), '0')
      await repo.setMeta(META.cursorCustomers(storeId), '0')
    } else if (remote.archived_at) {
      await repo.setMeta(META.gone(storeId), new Date(this.now()).toISOString())
      throw new CloudError('store archived in the cloud', 'store_gone')
    }
    await this.bind(storeId, userId)
  }

  /**
   * A fresh phone (demo, or its only store still empty): pull the account's store completely into
   * Dexie as an additional local store, then switch. The previous local store is left untouched.
   * `claim_pending` + cursors make an interrupted pull resumable; nothing is switched until the pull
   * completed.
   */
  private async pullSwitch(cloudStoreId: string): Promise<void> {
    await repo.setMeta(META.claimPending, cloudStoreId)
    this.patch({ phase: 'syncing', error: null })
    const row = await this.api.fetchStore(cloudStoreId)
    const store = row && !row.archived_at ? rowToStore(row) : null
    if (!store) {
      await repo.deleteMeta(META.claimPending)
      throw new CloudError('cloud store archived or missing', 'store_gone')
    }
    await repo.applyPulledRecords({ store })
    await this.pullStoreData(cloudStoreId)
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

    const member = !!remote.created_by && remote.created_by !== this.status.user?.id
    if (member) await repo.setMeta(META.member(storeId), '1')
    else await repo.deleteMeta(META.member(storeId))
    this.patch({ role: member ? 'member' : 'owner' })

    let changed = await this.pushRecords(storeId, member)
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
  private async pushRecords(storeId: string, member = false): Promise<boolean> {
    const dirty = await repo.dirtyRecords(storeId)
    let changed = false
    if (dirty.store && member) {
      // Only the owner may change the shared store row (RLS). A member's change to it — the
      // "pupunta ako ngayon" trip override — stays on this phone and is not queued forever.
      await repo.markRecordSynced('stores', storeId, dirty.store.updated_at)
    } else if (dirty.store) {
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
      (win) => this.api.pullRecords(table, storeId, win, this.pullPage),
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
      (win) => this.api.pullEvents(storeId, win, this.pullPage),
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
        if (rows.length < this.pullPage) break
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
