// P3a — online integration suite against the real Supabase project.
//
// DORMANT BY DEFAULT: it skips itself unless frontend/.env.test.local (git-ignored) provides
// TINDABOT_TEST_USERS=1, the project URL, the anon key and the two dedicated test users. Merely
// existing in the repo, it makes no network call.
//
// Safety rules it enforces on itself:
//   - it refuses to run unless BOTH user emails start with `tindabot-test-` — it can never sign in
//     as a personal account, and RLS means it can never see a store it does not own;
//   - it authenticates with the anon key + signInWithPassword only (never sign-up, never a
//     privileged key) and talks to the server through the production `createCloudApi` wrapper;
//   - every store it creates is named `test-<runId>-…`; it deletes nothing (no client can) and
//     archives its stores when done, so runs are independent; permanent removal is only the manual
//     supabase/scripts/cleanup_test_data.sql.
//
// What it proves on real Postgres (not the in-memory model): trigger-assigned xid/server_seq,
// sync_watermark(), lww_guard(), the owner-membership trigger, every RLS policy, events being
// INSERT+SELECT only, no DELETE path, archive/unarchive authorization, push→reconcile→pull
// convergence, duplicate pushes, pinned pull windows, commit-during-pull, aborted-transaction gaps,
// interrupted resume, cursor invariants, two clients converging, and the claim flows. The
// uncommitted-transaction race needs supabase/scripts/test_helpers.sql (opt-in); those tests skip
// when the helper is absent.

import 'fake-indexeddb/auto'
import { type SupabaseClient, createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Customer, type DomainEvent, type Product, type Store, activeEvents, deriveProduct, forProduct, ulid } from '../../domain'
import { db } from '../../db/db'
import * as repo from '../../db/repo'
import { type CloudApi, type CloudError } from '../api'
import { createCloudApi } from '../cloud'
import { eventToRow, maxSeq, parseCursor, recordToRow, rowToEvent, storeToRow } from '../codec'
import { META, SyncEngine, type SyncStatus } from '../engine'

// ------------------------------------------------------------------------------------------------
// configuration — fails closed
// ------------------------------------------------------------------------------------------------

interface TestConfig {
  url: string
  anonKey: string
  a: { email: string; password: string }
  b: { email: string; password: string }
}

function readTestConfig(env: Record<string, string | undefined>): TestConfig | null {
  if (env.TINDABOT_TEST_USERS !== '1') return null
  const url = (env.TEST_SUPABASE_URL ?? '').trim()
  const anonKey = (env.TEST_SUPABASE_ANON_KEY ?? '').trim()
  const a = { email: (env.TEST_USER_A_EMAIL ?? '').trim(), password: env.TEST_USER_A_PASSWORD ?? '' }
  const b = { email: (env.TEST_USER_B_EMAIL ?? '').trim(), password: env.TEST_USER_B_PASSWORD ?? '' }
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(url) || anonKey.length < 20) return null
  if (!a.email || !b.email || !a.password || !b.password || a.email === b.email) return null
  // Hard rule: only the dedicated test accounts, never a personal one.
  if (!a.email.startsWith('tindabot-test-') || !b.email.startsWith('tindabot-test-')) {
    throw new Error('online tests refuse to run: TEST_USER_*_EMAIL must start with "tindabot-test-"')
  }
  return { url, anonKey, a, b }
}

const cfg = readTestConfig(process.env)
const RUN = ulid()
const DEV = 'DEV0ONLINE0000000000000001'

// ------------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------------

const nowIso = () => new Date().toISOString()
const storeName = (label: string) => `test-${RUN}-${label}`

function mkStore(label: string, id = ulid()): Store {
  return { id, name: storeName(label), restock_days: [3, 6], next_trip_override: null, multipliers: { payday: 1.3, fri_sat: 1.15 }, updated_at: nowIso() }
}
function mkProduct(storeId: string, name = 'Coke', updated = nowIso(), id = ulid()): Product {
  return { id, store_id: storeId, name, category: 'c', unit_label: 'bote', pack_size: 12, pack_label: 'case', sell_price: 75, archived: false, updated_at: updated }
}
function mkCustomer(storeId: string, name = 'Aling Rosa'): Customer {
  return { id: ulid(), store_id: storeId, name, phone: null, archived: false, updated_at: nowIso() }
}
function mkEvent(storeId: string, extra: Record<string, unknown> = {}, id = ulid()): DomainEvent {
  return { id, v: 1, store_id: storeId, device_id: DEV, ts: '2026-09-10T12:00:00+08:00', recorded_at: nowIso(), type: 'CASH_COUNT', amount: 100, ...extra } as DomainEvent
}
function mkCount(storeId: string, productId: string, qty: number, ts: string): DomainEvent {
  return { id: ulid(), v: 1, store_id: storeId, device_id: DEV, ts, recorded_at: nowIso(), type: 'COUNT', product_id: productId, qty_on_hand: qty }
}
function mkPurchase(storeId: string, productId: string, units: number, ts: string): DomainEvent {
  return { id: ulid(), v: 1, store_id: storeId, device_id: DEV, ts, recorded_at: nowIso(), type: 'PURCHASE', product_id: productId, qty_units: units, total_cost: units * 65 }
}

function client(url: string, key: string): SupabaseClient {
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
}

async function signIn(c: SupabaseClient, u: { email: string; password: string }): Promise<string> {
  const { data, error } = await c.auth.signInWithPassword(u)
  if (error || !data.user) throw new Error(`sign-in failed for ${u.email}: ${error?.message ?? 'no user'}`)
  return data.user.id
}

/** Raw rows of a store the caller can see (RLS applies), optionally bounded by xid. */
async function rawEvents(c: SupabaseClient, storeId: string, xidLte?: number): Promise<Array<{ id: string; xid: number; server_seq: number; body: DomainEvent }>> {
  let q = c.from('events').select('id, xid, server_seq, body').eq('store_id', storeId)
  if (xidLte !== undefined) q = q.lte('xid', xidLte)
  const { data, error } = await q
  if (error) throw new Error(error.message)
  return (data ?? []) as Array<{ id: string; xid: number; server_seq: number; body: DomainEvent }>
}

const errorOf = async (p: Promise<unknown>): Promise<Error | null> => p.then(() => null, (e: Error) => e)

/** "Device 2": an in-memory client that speaks the same window protocol without Dexie. */
class MemoryDevice {
  events = new Map<string, DomainEvent>()
  cursor = 0
  constructor(
    private readonly api: CloudApi,
    private readonly storeId: string,
    private readonly page: number,
  ) {}
  async push(evs: DomainEvent[]) {
    for (const e of evs) this.events.set(e.id, e)
    await this.api.insertEvents(evs.map(eventToRow))
  }
  async pull() {
    const hi = await this.api.syncWatermark()
    if (hi - 1 <= this.cursor) return
    let after = 0
    for (;;) {
      const rows = await this.api.pullEvents(this.storeId, { afterXid: this.cursor, beforeXid: hi, after }, this.page)
      for (const r of rows) {
        const e = rowToEvent(r)
        if (e && !this.events.has(e.id)) this.events.set(e.id, e)
      }
      if (rows.length === 0) break
      after = maxSeq(rows, 'server_seq')
      if (rows.length < this.page) break
    }
    this.cursor = hi - 1
  }
}

// ------------------------------------------------------------------------------------------------

describe.skipIf(!cfg)('online Supabase — dedicated test users only', () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

  let cA: SupabaseClient, cA2: SupabaseClient, cB: SupabaseClient
  let uidA = '', uidB = ''
  let apiA: CloudApi, apiA2: CloudApi, apiB: CloudApi
  let hasHelper = false
  const created: string[] = [] // store ids created by this run (archived at the end)

  async function archiveActive(api: CloudApi) {
    for (const s of await api.listMyStores()) await api.archiveStore(s.id)
  }

  beforeAll(async () => {
    const { url, anonKey, a, b } = cfg!
    cA = client(url, anonKey)
    cA2 = client(url, anonKey)
    cB = client(url, anonKey)
    uidA = await signIn(cA, a)
    await signIn(cA2, a)
    uidB = await signIn(cB, b)
    expect(uidA).not.toBe(uidB)
    apiA = createCloudApi(cA)
    apiA2 = createCloudApi(cA2)
    apiB = createCloudApi(cB)
    // Leftovers from an interrupted run would change the claim decisions: archive them first
    // (owner-only, non-destructive; the manual cleanup script removes them for good).
    await archiveActive(apiA)
    await archiveActive(apiB)
    const probe = await cA.rpc('test_slow_insert_event', { ev: { id: 'probe', store_id: 'none', type: 'X', ts: 'x' }, hold_ms: 0 })
    // 42501 = helper present but "not a member" for a bogus store (expected); PGRST202 = absent.
    hasHelper = probe.error?.code !== 'PGRST202'
  })

  afterAll(async () => {
    for (const id of created) await apiA.archiveStore(id).catch(() => {})
    await archiveActive(apiB).catch(() => {})
    await Promise.all([cA.auth.signOut(), cA2.auth.signOut(), cB.auth.signOut()])
  })

  async function seedStore(api: CloudApi, label: string, store = mkStore(label)) {
    await api.upsertStore(storeToRow(store))
    created.push(store.id)
    return store
  }

  // ============================================================================================
  // 1. schema, triggers, RLS — raw checks
  // ============================================================================================

  describe('schema and policies', () => {
    it('sync_watermark() and server_time() behave as the design assumes', async () => {
      const w1 = await apiA.syncWatermark()
      expect(Number.isSafeInteger(w1) && w1 > 0).toBe(true)
      const w2 = await apiA.syncWatermark()
      expect(w2).toBeGreaterThanOrEqual(w1) // xmin never goes backwards
      expect(Number.isFinite(Date.parse(await apiA.serverTime()))).toBe(true)
      // watermark is invoker-callable but reveals nothing; B gets the same kind of number
      expect(Number.isSafeInteger(await apiB.syncWatermark())).toBe(true)
    })

    it('store insert: created_by/archived_at are server-forced; owner membership is created by trigger and invisible to others', async () => {
      const s = mkStore('owner')
      created.push(s.id)
      // a client trying to choose the owner or start archived is overridden
      const { error } = await cA.from('stores').insert({ id: s.id, body: s, updated_at: s.updated_at, created_by: uidB, archived_at: nowIso() })
      expect(error).toBeNull()
      const row = await apiA.fetchStore(s.id)
      expect(row?.created_by).toBe(uidA)
      expect(row?.archived_at).toBeNull()

      const mine = await cA.from('store_members').select('store_id, user_id, role').eq('store_id', s.id)
      expect(mine.data).toEqual([{ store_id: s.id, user_id: uidA, role: 'owner' }])
      const theirs = await cB.from('store_members').select('store_id').eq('store_id', s.id)
      expect(theirs.data).toEqual([])
      // clients cannot write memberships at all (owner-only in P3a; households later)
      const ins = await cA.from('store_members').insert({ store_id: s.id, user_id: uidB, role: 'member' })
      expect(ins.error?.code).toBe('42501')
      expect((await cB.from('store_members').select('store_id').eq('store_id', s.id)).data).toEqual([])
    })

    it('upsertStore: creates a brand-new store (owner membership by trigger) and updates an existing one', async () => {
      // Regression: a PostgREST upsert (INSERT … ON CONFLICT) of a NEW store is rejected by RLS on
      // real Postgres (the SELECT policy is applied before the owner membership exists), so the
      // client must insert first and only fall back to update on a duplicate key.
      const s = mkStore('upsert-new')
      created.push(s.id)
      await apiA.upsertStore(storeToRow(s)) // must not throw
      const row = await apiA.fetchStore(s.id)
      expect(row?.body).toEqual(s)
      expect(row?.created_by).toBe(uidA)
      expect(row?.archived_at).toBeNull()
      expect((await cA.from('store_members').select('user_id, role').eq('store_id', s.id)).data).toEqual([{ user_id: uidA, role: 'owner' }])
      expect((await apiA.listMyStores()).map((x) => x.id)).toContain(s.id)

      // existing store: newer updated_at is applied through the same call
      const renamed = { ...s, name: storeName('upsert-renamed'), updated_at: new Date(Date.now() + 2_000).toISOString() }
      await apiA.upsertStore(storeToRow(renamed))
      const after = await apiA.fetchStore(s.id)
      expect(after?.body).toEqual(renamed)
      expect(after?.server_rev).toBeGreaterThan(row!.server_rev ?? Infinity)
      // stale updated_at: silently kept as is (lww_guard), still no error
      await apiA.upsertStore(storeToRow({ ...s, name: storeName('upsert-stale') }))
      expect((await apiA.fetchStore(s.id))?.body).toEqual(renamed)
      // someone else's store: a real error, not swallowed as "exists"
      const sB = await seedStore(apiB, 'upsert-B')
      const err = await errorOf(apiA.upsertStore(storeToRow({ ...sB, updated_at: new Date(Date.now() + 5_000).toISOString() })))
      expect((err as CloudError | null)?.code).toBe('denied')
      expect((await apiB.fetchStore(sB.id))?.body).toEqual(sB)
    })

    it('events: xid and server_seq are trigger-assigned (client values ignored); one request = one transaction', async () => {
      const s = await seedStore(apiA, 'xid')
      const e1 = mkEvent(s.id)
      const e2 = mkEvent(s.id)
      const { error } = await cA.from('events').insert([
        { id: e1.id, store_id: s.id, type: e1.type, ts: e1.ts, body: e1, server_seq: 987654321, xid: 1 },
        { id: e2.id, store_id: s.id, type: e2.type, ts: e2.ts, body: e2, server_seq: 987654322, xid: 1 },
      ])
      expect(error).toBeNull()
      const rows = await rawEvents(cA, s.id)
      const r1 = rows.find((r) => r.id === e1.id)!
      const r2 = rows.find((r) => r.id === e2.id)!
      expect(r1.server_seq).not.toBe(987654321)
      expect(r2.server_seq).toBe(r1.server_seq + 1) // consecutive within one request
      expect(r1.xid).toBeGreaterThan(1)
      expect(r1.xid).toBe(r2.xid) // same transaction
      const e3 = mkEvent(s.id)
      await apiA.insertEvents([eventToRow(e3)])
      const r3 = (await rawEvents(cA, s.id)).find((r) => r.id === e3.id)!
      expect(r3.xid).toBeGreaterThan(r1.xid) // a later transaction has a higher id
      expect(await apiA.syncWatermark()).toBeGreaterThan(r3.xid) // and once committed it is below the watermark
    })

    it('events are INSERT + SELECT only; no client can delete records or stores', async () => {
      const s = await seedStore(apiA, 'immutable')
      const e = mkEvent(s.id)
      await apiA.insertEvents([eventToRow(e)])
      const p = mkProduct(s.id)
      await apiA.upsertRecords('products', [recordToRow(p)])

      expect((await cA.from('events').update({ type: 'HACK' }).eq('id', e.id)).error?.code).toBe('42501')
      expect((await cA.from('events').delete().eq('id', e.id)).error?.code).toBe('42501')
      expect((await cA.from('products').delete().eq('id', p.id)).error?.code).toBe('42501')
      expect((await cA.from('customers').delete().eq('store_id', s.id)).error?.code).toBe('42501')
      expect((await cA.from('stores').delete().eq('id', s.id)).error?.code).toBe('42501')
      expect((await cA.from('store_members').delete().eq('store_id', s.id)).error?.code).toBe('42501')
      // nothing changed
      expect((await rawEvents(cA, s.id)).map((r) => r.body)).toEqual([e])
      expect((await apiA.fetchRecords('products', s.id, [p.id])).length).toBe(1)
      expect(await apiA.fetchStore(s.id)).not.toBeNull()
    })

    it('duplicate pushes are idempotent: same id again changes nothing, and only ON CONFLICT protects it', async () => {
      const s = await seedStore(apiA, 'dup')
      const e = mkEvent(s.id, { amount: 100 })
      await apiA.insertEvents([eventToRow(e)])
      const forged = { ...e, amount: 999 } as DomainEvent
      await apiA.insertEvents([eventToRow(forged), eventToRow(e)]) // no error, ignored
      const rows = await rawEvents(cA, s.id)
      expect(rows.length).toBe(1)
      expect((rows[0]!.body as { amount: number }).amount).toBe(100)
      // a plain insert of an existing id is a real unique violation — the write-once guarantee is the key itself
      const plain = await cA.from('events').insert({ id: e.id, store_id: s.id, type: e.type, ts: e.ts, body: forged })
      expect(plain.error?.code).toBe('23505')
    })

    it('lww_guard: stale or equal updated_at is silently ignored; newer is applied and re-versioned', async () => {
      const s = await seedStore(apiA, 'lww')
      const p = mkProduct(s.id, 'v1', '2026-09-01T00:00:00.000Z')
      await apiA.upsertRecords('products', [recordToRow(p)])
      const rawXid = async () => (await cA.from('products').select('xid').eq('id', p.id).single()).data!.xid as number
      const [before] = await apiA.fetchRecords('products', s.id, [p.id])
      const xidBefore = await rawXid()
      await apiA.upsertRecords('products', [recordToRow({ ...p, name: 'stale', updated_at: '2026-08-01T00:00:00.000Z' })])
      await apiA.upsertRecords('products', [recordToRow({ ...p, name: 'equal' })])
      let [after] = await apiA.fetchRecords('products', s.id, [p.id])
      expect((after!.body as Product).name).toBe('v1')
      expect(after!.server_rev).toBe(before!.server_rev)
      await apiA.upsertRecords('products', [recordToRow({ ...p, name: 'newer', updated_at: '2026-09-02T00:00:00.000Z' })])
      ;[after] = await apiA.fetchRecords('products', s.id, [p.id])
      expect((after!.body as Product).name).toBe('newer')
      expect(after!.server_rev).toBeGreaterThan(before!.server_rev!)
      expect(await rawXid()).toBeGreaterThan(xidBefore) // re-stamped with the updating transaction

      // store row: same guard, and archived_at/created_by cannot be changed through an upsert
      await apiA.archiveStore(s.id)
      const { error } = await cA.from('stores').upsert({ id: s.id, body: { ...s, name: storeName('lww2') }, updated_at: new Date(Date.now() + 60_000).toISOString(), archived_at: null, created_by: uidB }, { onConflict: 'id' })
      expect(error).toBeNull()
      const row = await apiA.fetchStore(s.id)
      expect((row!.body as Store).name).toBe(storeName('lww2')) // newer body accepted …
      expect(row!.archived_at).not.toBeNull() // … but the flag stays
      expect(row!.created_by).toBe(uidA)
    })

    it('archive/unarchive: owner only; archived stores leave the active list but keep every row', async () => {
      const s = await seedStore(apiA, 'archive')
      const e = mkEvent(s.id)
      await apiA.insertEvents([eventToRow(e)])
      expect((await errorOf(apiB.archiveStore(s.id)))?.message).toMatch(/owner|denied|permission/i)
      expect((await apiA.listMyStores()).some((x) => x.id === s.id)).toBe(true)
      await apiA.archiveStore(s.id)
      expect((await apiA.listMyStores()).some((x) => x.id === s.id)).toBe(false)
      expect((await apiA.fetchStore(s.id))?.archived_at).toBeTruthy()
      expect((await rawEvents(cA, s.id)).map((r) => r.id)).toEqual([e.id]) // nothing deleted
      expect((await errorOf(apiB.unarchiveStore(s.id)))?.message).toMatch(/owner|denied|permission/i)
      await apiA.unarchiveStore(s.id)
      expect((await apiA.fetchStore(s.id))?.archived_at).toBeNull()
      expect((await apiA.listMyStores()).some((x) => x.id === s.id)).toBe(true)
    })

    it('cross-account isolation: B sees nothing of A and cannot write into A’s store', async () => {
      const s = await seedStore(apiA, 'iso')
      const e = mkEvent(s.id)
      const p = mkProduct(s.id)
      await apiA.insertEvents([eventToRow(e)])
      await apiA.upsertRecords('products', [recordToRow(p)])
      const w = await apiB.syncWatermark()

      expect((await apiB.listMyStores()).some((x) => x.id === s.id)).toBe(false)
      expect(await apiB.fetchStore(s.id)).toBeNull()
      expect(await apiB.pullEvents(s.id, { afterXid: 0, beforeXid: w + 1_000_000, after: 0 }, 10)).toEqual([])
      expect(await apiB.pullRecords('products', s.id, { afterXid: 0, beforeXid: w + 1_000_000, after: 0 }, 10)).toEqual([])
      expect(await apiB.fetchRecords('products', s.id, [p.id])).toEqual([])
      expect(await rawEvents(cB, s.id)).toEqual([])

      expect(await errorOf(apiB.insertEvents([eventToRow(mkEvent(s.id))]))).not.toBeNull()
      expect(await errorOf(apiB.upsertRecords('products', [recordToRow(mkProduct(s.id, 'B'))]))).not.toBeNull()
      expect(await errorOf(apiB.upsertRecords('customers', [recordToRow(mkCustomer(s.id))]))).not.toBeNull()
      expect(await errorOf(apiB.upsertStore(storeToRow({ ...s, name: 'hijack', updated_at: new Date(Date.now() + 60_000).toISOString() })))).not.toBeNull()

      // A's data is exactly as before
      expect((await rawEvents(cA, s.id)).map((r) => r.id)).toEqual([e.id])
      expect((await apiA.fetchStore(s.id))!.body).toEqual(s)
      expect((await apiA.fetchRecords('products', s.id, [p.id]))[0]!.body).toEqual(p)
    })

    it('an aborted transaction leaves a sequence gap and no row', async () => {
      const s = await seedStore(apiA, 'gap')
      const sB = await seedStore(apiB, 'gapB')
      const ok1 = mkEvent(s.id)
      await apiA.insertEvents([eventToRow(ok1)])
      const seq1 = (await rawEvents(cA, s.id))[0]!.server_seq
      // one request, two rows: the second violates RLS → the whole transaction rolls back
      const lost = mkEvent(s.id)
      const err = await errorOf(apiA.insertEvents([eventToRow(lost), eventToRow(mkEvent(sB.id))]))
      expect(err).not.toBeNull()
      expect((await rawEvents(cA, s.id)).map((r) => r.id)).toEqual([ok1.id])
      const ok2 = mkEvent(s.id)
      await apiA.insertEvents([eventToRow(ok2)])
      const seq2 = (await rawEvents(cA, s.id)).find((r) => r.id === ok2.id)!.server_seq
      expect(seq2).toBeGreaterThan(seq1 + 1) // the aborted rows' numbers were spent
    })
  })

  // ============================================================================================
  // 2. the engine over the real API (this process = device 1 with Dexie; A2 = other device)
  // ============================================================================================

  describe('sync engine against the real project', () => {
    let statuses: SyncStatus[] = []
    let pulled = 0
    function engine(api: CloudApi, page = 3, backoffMs: number[] = [50]): SyncEngine {
      statuses = []
      pulled = 0
      return new SyncEngine({
        api,
        onPulled: async () => {
          pulled++
        },
        onStatus: (s) => statuses.push(s),
        debounceMs: 0,
        backoffMs,
        pullPage: page,
      })
    }
    const user = () => ({ id: uidA, email: cfg!.a.email })

    /** INVARIANT: every row of the store with xid ≤ the local cursor is present locally. */
    async function assertCursorInvariant(storeId: string) {
      const cursor = parseCursor(await repo.getMeta(META.cursorEvents(storeId)))
      expect(await repo.getMeta(META.windowEvents(storeId))).toBeNull()
      const server = await rawEvents(cA, storeId, cursor)
      const local = new Set((await repo.loadSnapshot(storeId))!.events.map((e) => e.id))
      expect(server.filter((r) => !local.has(r.id)).map((r) => r.id)).toEqual([])
      expect(cursor).toBeLessThan(await apiA.syncWatermark())
      return cursor
    }

    async function localStore(label: string) {
      const s = await repo.createStore(storeName(label), [3])
      created.push(s.id)
      return s
    }

    beforeEach(async () => {
      await db.delete()
      await db.open()
      await archiveActive(apiA) // every engine test starts with A owning no active store
    })

    it('demo store: never uploaded, even when signed in', async () => {
      const demo = await localStore('demo')
      await repo.setLocalOnly(demo.id)
      await repo.addEvents([mkEvent(demo.id)])
      const eng = engine(apiA)
      eng.setUser(user())
      await eng.whenIdle()
      expect(eng.status.phase).toBe('local_only')
      expect(await apiA.fetchStore(demo.id)).toBeNull()
      expect(await apiA.listMyStores()).toEqual([])
      eng.dispose()
    })

    it('claim (no cloud store): uploads the phone store once; cursor invariant holds', async () => {
      const s = await localStore('upload')
      const p = mkProduct(s.id)
      const c = mkCustomer(s.id)
      await repo.saveProduct(p)
      await repo.saveCustomer(c)
      const evs = [mkEvent(s.id), mkCount(s.id, p.id, 4, '2026-09-10T21:00:00+08:00'), mkEvent(s.id, { type: 'UTANG', customer_id: c.id, amount: 50 })]
      await repo.addEvents(evs)
      const eng = engine(apiA)
      eng.setUser(user())
      await eng.whenIdle()
      expect(eng.status.phase).toBe('idle')
      expect(eng.status.error).toBeNull()
      expect((await apiA.listMyStores()).map((x) => x.id)).toEqual([s.id])
      expect((await apiA.fetchStore(s.id))?.created_by).toBe(uidA)
      expect((await rawEvents(cA, s.id)).map((r) => r.body).sort((a, b) => a.id.localeCompare(b.id))).toEqual(evs.slice().sort((a, b) => a.id.localeCompare(b.id)))
      expect((await apiA.fetchRecords('products', s.id, [p.id]))[0]!.body).toEqual((await repo.loadSnapshot(s.id))!.products[0])
      expect(await repo.countUnsyncedEvents(s.id)).toBe(0)
      expect(await repo.countDirtyRecords(s.id)).toBe(0)
      await assertCursorInvariant(s.id)
      // a second run pushes nothing new and keeps the count
      await eng.syncNow()
      expect((await rawEvents(cA, s.id)).length).toBe(3)
      expect(JSON.stringify(await repo.loadSnapshot(s.id))).not.toMatch(/synced_at|synced_updated_at|local_only/)
      eng.dispose()
    })

    it('same store id on both sides: normal sync, union on both sides, no prompt', async () => {
      const s = await localStore('same')
      const p = mkProduct(s.id)
      await repo.saveProduct(p)
      const mine = [mkPurchase(s.id, p.id, 24, '2026-09-08T10:00:00+08:00'), mkCount(s.id, p.id, 20, '2026-09-08T10:00:00+08:00')]
      await repo.addEvents(mine)
      // the other device already uploaded the same store with its own rows
      await apiA2.upsertStore(storeToRow({ ...s, name: storeName('same-renamed'), updated_at: new Date(Date.now() + 5_000).toISOString() }))
      const theirs = [mkCount(s.id, p.id, 9, '2026-09-12T21:00:00+08:00'), mkEvent(s.id, { type: 'EXPENSE', amount: 60, category: 'load' })]
      await apiA2.upsertRecords('products', [recordToRow(p)])
      await apiA2.insertEvents(theirs.map(eventToRow))

      const eng = engine(apiA)
      eng.setUser(user())
      await eng.whenIdle()
      expect(eng.status.phase).toBe('idle')
      const snap = (await repo.loadSnapshot(s.id))!
      expect(snap.store.name).toBe(storeName('same-renamed'))
      expect(snap.events.map((e) => e.id).sort()).toEqual([...mine, ...theirs].map((e) => e.id).sort())
      expect((await rawEvents(cA, s.id)).length).toBe(4)
      expect(pulled).toBe(1)
      await assertCursorInvariant(s.id)
      eng.dispose()
    })

    it('push → reconcile → pull: a stale local record edit is replaced by the newer cloud copy', async () => {
      const s = await localStore('lww-engine')
      const p = mkProduct(s.id, 'local-v1')
      await repo.saveProduct(p)
      const eng = engine(apiA)
      eng.setUser(user())
      await eng.whenIdle()
      // other device edits later than us; we then write an edit with an OLD clock
      const remote = { ...p, name: 'remote-newer', updated_at: new Date(Date.now() + 60_000).toISOString() }
      await apiA2.upsertRecords('products', [recordToRow(remote)])
      await db.products.put({ ...p, name: 'stale-local', updated_at: '2020-01-01T00:00:00.000Z', synced_updated_at: null })
      await eng.syncNow()
      expect((await repo.loadSnapshot(s.id))!.products[0]!.name).toBe('remote-newer')
      expect(((await apiA.fetchRecords('products', s.id, [p.id]))[0]!.body as Product).name).toBe('remote-newer')
      expect(await repo.countDirtyRecords(s.id)).toBe(0)
      eng.dispose()
    })

    it('pinned windows: rows committed during a multi-page pull are outside the window and arrive next run', async () => {
      const s = await localStore('window')
      const eng = engine(apiA, 3)
      eng.setUser(user())
      await eng.whenIdle()
      const batch = Array.from({ length: 8 }, () => mkEvent(s.id))
      await apiA2.insertEvents(batch.map(eventToRow))
      const late = mkEvent(s.id)
      const orig = apiA.pullEvents.bind(apiA)
      let calls = 0
      apiA.pullEvents = async (...args) => {
        const rows = await orig(...args)
        if (++calls === 1) await apiA2.insertEvents([eventToRow(late)])
        return rows
      }
      await eng.syncNow()
      apiA.pullEvents = orig
      const ids = (await repo.loadSnapshot(s.id))!.events.map((e) => e.id)
      for (const e of batch) expect(ids).toContain(e.id)
      expect(ids).not.toContain(late.id)
      const cursor = await assertCursorInvariant(s.id)
      const lateRow = (await rawEvents(cA, s.id)).find((r) => r.id === late.id)!
      expect(cursor).toBeLessThan(lateRow.xid)
      await eng.syncNow()
      expect((await repo.loadSnapshot(s.id))!.events.map((e) => e.id)).toContain(late.id)
      await assertCursorInvariant(s.id)
      eng.dispose()
    })

    it('interrupted pull: the window is pinned in meta and the resume ends complete', async () => {
      const fresh = await localStore('fresh') // empty → pull-and-switch
      const X = await seedStore(apiA2, 'X-resume')
      const first = Array.from({ length: 7 }, () => mkEvent(X.id))
      await apiA2.insertEvents(first.map(eventToRow))
      const eng = engine(apiA, 3, [60_000]) // no automatic retry while we inspect the half-done state
      const orig = apiA.pullEvents.bind(apiA)
      let calls = 0
      const trace: string[] = []
      apiA.pullEvents = async (...args) => {
        if (++calls === 2) {
          trace.push(`call ${calls}: window ${JSON.stringify(args[1])} → connection lost`)
          throw new Error('connection lost mid-pull')
        }
        const rows = await orig(...args)
        trace.push(`call ${calls}: window ${JSON.stringify(args[1])} → seq [${rows.map((r) => r.server_seq).join(',')}]`)
        return rows
      }
      eng.setUser(user())
      await eng.whenIdle()
      expect(eng.status.phase).toBe('error')
      expect((await repo.currentStore())!.id).toBe(fresh.id) // NOT switched
      const pending = JSON.parse((await repo.getMeta(META.windowEvents(X.id)))!)
      expect(pending.seq).toBeGreaterThan(0)
      const localBefore = await db.events.where('store_id').equals(X.id).count()
      console.info('[resume] persisted window', pending, 'local rows before resume', localBefore, 'cursor', await repo.getMeta(META.cursorEvents(X.id)))
      const laterRows = Array.from({ length: 2 }, () => mkEvent(X.id))
      await apiA2.insertEvents(laterRows.map(eventToRow))
      for (const r of await rawEvents(cA, X.id)) if (laterRows.some((l) => l.id === r.id)) expect(r.xid).toBeGreaterThanOrEqual(pending.hi)

      const laterXids = (await rawEvents(cA, X.id)).filter((r) => laterRows.some((l) => l.id === r.id)).map((r) => r.xid)
      apiA.pullEvents = async (...args) => {
        const rows = await orig(...args)
        trace.push(`resume call: window ${JSON.stringify(args[1])} → seq [${rows.map((r) => r.server_seq).join(',')}]`)
        return rows
      }
      eng.dispose()
      const eng2 = engine(apiA, 3) // "next launch"
      eng2.setUser(user())
      await eng2.whenIdle()
      apiA.pullEvents = orig
      console.info('[resume] later rows xid', laterXids, ...trace, 'cursor after resume', await repo.getMeta(META.cursorEvents(X.id)), 'window after', await repo.getMeta(META.windowEvents(X.id)))
      expect(eng2.status.phase).toBe('idle')
      expect((await repo.currentStore())!.id).toBe(X.id)
      expect((await repo.loadSnapshot(X.id))!.events.length).toBe(9)
      expect(await db.events.where('store_id').equals(X.id).count()).toBe(9)
      await assertCursorInvariant(X.id)
      eng2.dispose()
    })

    it('the race on real Postgres: an uncommitted lower-sequence row is never stepped over (needs test_helpers.sql)', async (ctx) => {
      if (!hasHelper) return ctx.skip()
      const s = await localStore('race')
      const eng = engine(apiA)
      eng.setUser(user())
      await eng.whenIdle()
      const cursor0 = await assertCursorInvariant(s.id)

      // Establish the interleaving: slow starts (allocates xid + seq), then fast commits.
      let slowRow: { server_seq: number; xid: number } | null = null
      let slowDone: Promise<unknown> = Promise.resolve()
      let fast: DomainEvent | null = null
      let slow: DomainEvent | null = null
      const HOLD_MS = 3000
      for (let attempt = 0; attempt < 3 && !slowRow; attempt++) {
        slow = mkEvent(s.id, { note: 'slow' })
        const t0 = Date.now()
        slowDone = Promise.resolve(cA2.rpc('test_slow_insert_event', { ev: slow, hold_ms: HOLD_MS }))
        await new Promise((r) => setTimeout(r, 700)) // let the request reach the server and take its xid
        fast = mkEvent(s.id, { note: 'fast' })
        await apiA2.insertEvents([eventToRow(fast)])
        const watermarkWhileSlow = await apiA.syncWatermark()
        const visible = await rawEvents(cA, s.id)
        const fastRow = visible.find((r) => r.id === fast!.id)!
        const slowVisibleEarly = visible.some((r) => r.id === slow!.id)
        await eng.syncNow()
        const syncedBeforeCommit = Date.now() - t0 < HOLD_MS - 300
        const localIds = (await repo.loadSnapshot(s.id))!.events.map((e) => e.id)
        const cursorDuring = parseCursor(await repo.getMeta(META.cursorEvents(s.id)))
        const res = (await slowDone) as { data: Array<{ server_seq: number; xid: number }> | null; error: { message: string } | null }
        if (res.error) throw new Error(res.error.message)
        const got = res.data?.[0] ?? null
        // interleaving not achieved (slow had not started before fast, or the hold ended before our
        // pull finished) → this attempt proves nothing; try again
        if (!got || got.server_seq > fastRow.server_seq || !syncedBeforeCommit) continue
        slowRow = got
        console.info('[race] attempt', attempt, { cursor0, slow: got, fast: { xid: fastRow.xid, server_seq: fastRow.server_seq }, watermarkWhileSlow, slowVisibleEarly, cursorDuring, localHasFast: localIds.includes(fast!.id) })
        expect(slowVisibleEarly).toBe(false) // during the hold the slow row was invisible …
        expect(watermarkWhileSlow).toBeLessThanOrEqual(slowRow.xid) // … and the watermark sat at/below its transaction
        expect(localIds).not.toContain(slow!.id)
        expect(cursorDuring).toBeLessThan(slowRow.xid) // the cursor never passed the in-flight transaction
        expect(cursorDuring).toBeGreaterThanOrEqual(cursor0)
        expect(fastRow.xid).toBeGreaterThan(slowRow.xid) // the committed-first row belongs to the LATER transaction
        expect(localIds).not.toContain(fast!.id) // and was therefore held back too, rather than skipped past
      }
      expect(slowRow, 'could not establish slow-before-fast ordering in 3 attempts').not.toBeNull()

      // after commit: both arrive, the invariant holds, nothing was lost
      await eng.syncNow()
      const ids = (await repo.loadSnapshot(s.id))!.events.map((e) => e.id)
      expect(ids).toContain(slow!.id)
      expect(ids).toContain(fast!.id)
      console.info('[race] after commit: cursor', await assertCursorInvariant(s.id), 'watermark', await apiA.syncWatermark())
      eng.dispose()
    })

    it('an aborted transaction gap does not stall the cursor', async () => {
      const s = await localStore('gap-engine')
      const sB = await seedStore(apiB, 'gapB2')
      const eng = engine(apiA)
      eng.setUser(user())
      await eng.whenIdle()
      expect(await errorOf(apiA2.insertEvents([eventToRow(mkEvent(s.id)), eventToRow(mkEvent(sB.id))]))).not.toBeNull()
      const kept = mkEvent(s.id)
      await apiA2.insertEvents([eventToRow(kept)])
      await eng.syncNow()
      expect((await repo.loadSnapshot(s.id))!.events.map((e) => e.id)).toContain(kept.id)
      await assertCursorInvariant(s.id)
      eng.dispose()
    })

    it('two clients converge to the same event set and the same derived state', async () => {
      const s = await localStore('converge')
      const p = mkProduct(s.id)
      await repo.saveProduct(p)
      const mine = [mkPurchase(s.id, p.id, 24, '2026-09-01T10:00:00+08:00'), mkCount(s.id, p.id, 6, '2026-09-01T10:00:00+08:00'), mkCount(s.id, p.id, 18, '2026-09-05T21:00:00+08:00')]
      await repo.addEvents(mine)
      const eng = engine(apiA, 2)
      eng.setUser(user())
      await eng.whenIdle()

      const other = new MemoryDevice(apiA2, s.id, 2)
      await other.push([mkPurchase(s.id, p.id, 12, '2026-09-06T10:00:00+08:00'), mkCount(s.id, p.id, 3, '2026-09-06T10:00:00+08:00'), mkCount(s.id, p.id, 11, '2026-09-09T21:00:00+08:00')])
      await other.pull()
      await eng.syncNow()
      await other.pull()

      const local = (await repo.loadSnapshot(s.id))!.events
      const nowMs = Date.parse('2026-09-10T08:00:00+08:00')
      const a = deriveProduct(p, forProduct(activeEvents(local), p.id), nowMs)
      const b = deriveProduct(p, forProduct(activeEvents([...other.events.values()]), p.id), nowMs)
      expect(local.map((e) => e.id).sort()).toEqual([...other.events.keys()].sort())
      expect(local.length).toBe(6)
      expect({ ...a, flags: [...a.flags].sort() }).toEqual({ ...b, flags: [...b.flags].sort() })
      expect(a.tier).toBe('counts')
      await assertCursorInvariant(s.id)
      eng.dispose()
    })

    it('several stores: a populated phone store and a different cloud store are both kept — the phone one uploaded, the cloud one pulled in; nothing switches', async () => {
      const L = await localStore('L-multi')
      await repo.saveProduct(mkProduct(L.id))
      const lEvents = [mkEvent(L.id), mkEvent(L.id)]
      await repo.addEvents(lEvents)
      const X = await seedStore(apiA2, 'X-multi')
      const xEvents = [mkEvent(X.id), mkEvent(X.id), mkEvent(X.id)]
      await apiA2.insertEvents(xEvents.map(eventToRow))
      const xProduct = mkProduct(X.id, 'x-product')
      await apiA2.upsertRecords('products', [recordToRow(xProduct)])

      const eng = engine(apiA)
      eng.setUser(user())
      await eng.whenIdle()
      expect(eng.status.phase).toBe('idle')
      expect((await repo.currentStore())!.id).toBe(L.id)
      expect((await apiA.listMyStores()).map((x) => x.id).sort()).toEqual([L.id, X.id].sort())
      expect((await rawEvents(cA, L.id)).map((r) => r.id).sort()).toEqual(lEvents.map((e) => e.id).sort())
      expect((await rawEvents(cA, X.id)).map((r) => r.id).sort()).toEqual(xEvents.map((e) => e.id).sort()) // untouched
      const x = (await repo.loadSnapshot(X.id))!
      expect(x.events.map((e) => e.id).sort()).toEqual(xEvents.map((e) => e.id).sort())
      expect(x.products.map((p) => p.id)).toEqual([xProduct.id])
      await assertCursorInvariant(L.id)
      await assertCursorInvariant(X.id)
      eng.dispose()
    })

    it('deleting a store on the phone archives it in the cloud (every row kept) and it is never pulled back', async () => {
      const L = await localStore('L-keep')
      await repo.addEvents([mkEvent(L.id)])
      const X = await seedStore(apiA2, 'X-delete')
      const xEvents = [mkEvent(X.id), mkEvent(X.id)]
      await apiA2.insertEvents(xEvents.map(eventToRow))
      const eng = engine(apiA)
      eng.setUser(user())
      await eng.whenIdle()
      expect(await repo.storeExists(X.id)).toBe(true)

      await repo.deleteStore(X.id)
      await eng.syncNow()
      expect(eng.status.phase).toBe('idle')
      expect((await apiA.fetchStore(X.id))?.archived_at).toBeTruthy()
      expect((await rawEvents(cA, X.id)).map((r) => r.id).sort()).toEqual(xEvents.map((e) => e.id).sort()) // archived, not deleted
      expect((await apiA.listMyStores()).map((s) => s.id)).toEqual([L.id])
      expect(await repo.storeExists(X.id)).toBe(false)
      expect(await repo.deletedStoreIds()).toEqual([])
      eng.dispose()
    })

    it('a store archived by another client (deleted there) is neither un-archived nor re-uploaded; the phone keeps its copy', async () => {
      const L = await localStore('L-gone')
      await repo.addEvents([mkEvent(L.id)])
      const eng = engine(apiA)
      eng.setUser(user())
      await eng.whenIdle()
      expect(eng.status.phase).toBe('idle')

      await apiA2.archiveStore(L.id)
      await repo.addEvents([mkEvent(L.id)])
      await eng.syncNow()
      expect(eng.status.phase).toBe('error')
      expect(eng.status.error?.code).toBe('store_gone')
      expect((await apiA.fetchStore(L.id))?.archived_at).toBeTruthy()
      expect((await rawEvents(cA, L.id)).length).toBe(1) // the later entry was not pushed
      expect((await repo.loadSnapshot(L.id))!.events.length).toBe(2)
      eng.dispose()
    })
  })
})
