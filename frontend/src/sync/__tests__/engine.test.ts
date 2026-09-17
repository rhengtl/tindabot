// Sync engine against Dexie (fake-indexeddb) and the in-memory cloud. Covers the P3a data-safety
// rules end to end without any online project: claim cases, upload, pull-and-switch after a
// complete pull, resumable interrupted pulls, offline queueing, markers only after ack,
// debounce/single-flight, backoff, clock-skew warning, LWW across devices, VOID across pulls,
// demo exclusion, and derived-state convergence over the golden scenarios.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Customer, type DomainEvent, type Product, type Store, activeEvents, deriveProduct, forProduct, toMs, ulid } from '../../domain'
import { makeProduct, makeStore, run, scenarios, shuffled, toEvents } from '../../domain/__tests__/helpers'
import { db } from '../../db/db'
import * as repo from '../../db/repo'
import { eventToRow, parseCursor, recordToRow, storeToRow } from '../codec'
import { META, type SyncEngine as Engine, type SyncStatus, SyncEngine } from '../engine'
import { FakeCloud } from './fake_cloud'

const DEV = 'DEV00000000000000000000001'
const USER_A = { id: 'user-a', email: 'a@example.com' }
const USER_B = { id: 'user-b', email: 'b@example.com' }

function product(storeId: string, id = ulid(), updated = '2026-09-01T00:00:00.000Z', name = `P${id.slice(-3)}`): Product {
  return { id, store_id: storeId, name, category: 'c', unit_label: 'u', pack_size: 12, pack_label: 'p', sell_price: 10, archived: false, updated_at: updated }
}
function customer(storeId: string, id = ulid(), updated = '2026-09-01T00:00:00.000Z'): Customer {
  return { id, store_id: storeId, name: `C${id.slice(-3)}`, phone: null, archived: false, updated_at: updated }
}
function event(storeId: string, extra: Partial<DomainEvent> = {}, id = ulid()): DomainEvent {
  return { id, v: 1, store_id: storeId, device_id: DEV, ts: '2026-09-10T12:00:00+08:00', recorded_at: '2026-09-10T12:00:00+08:00', type: 'CASH_COUNT', amount: 100, ...extra } as DomainEvent
}
function cloudStore(id: string, name = 'Cloud store', updated = '2026-09-01T00:00:00.000Z'): Store {
  return { id, name, restock_days: [3, 6], next_trip_override: null, multipliers: { payday: 1.3, fri_sat: 1.15 }, updated_at: updated }
}

/** Seeds a store owned by `cloud.user` as another device would have uploaded it. */
async function seedCloud(cloud: FakeCloud, store: Store, products: Product[] = [], customers: Customer[] = [], events: DomainEvent[] = []) {
  await cloud.upsertStore(storeToRow(store))
  await cloud.upsertRecords('products', products.map(recordToRow))
  await cloud.upsertRecords('customers', customers.map(recordToRow))
  await cloud.insertEvents(events.map(eventToRow))
  cloud.calls.length = 0 // seeding is "the other device"; tests inspect this device's calls only
}

/** Lets a debounced (0 ms) write trigger fire, then waits for the run. */
async function settle(h: Harness) {
  await new Promise((r) => setTimeout(r, 2))
  await h.engine.whenIdle()
}
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) // Dexie/fake-indexeddb need real setImmediate

/** A populated local store (the P1/P2 situation before signing in). */
async function seedLocal(name = 'Phone store') {
  const s = await repo.createStore(name, [3])
  const p = product(s.id)
  const c = customer(s.id)
  await repo.saveProduct(p)
  await repo.saveCustomer(c)
  const evs = [event(s.id), event(s.id, { type: 'UTANG', customer_id: c.id, amount: 50 } as never), event(s.id, { type: 'COUNT', product_id: p.id, qty_on_hand: 4 } as never)]
  await repo.addEvents(evs)
  return { store: s, product: p, customer: c, events: evs }
}

interface Harness {
  engine: Engine
  cloud: FakeCloud
  statuses: SyncStatus[]
  pulled: number
  online: boolean
  now: number
}

function harness(cloud: FakeCloud, opts: Partial<{ debounceMs: number; backoffMs: number[]; now: number }> = {}): Harness {
  const h = { cloud, statuses: [] as SyncStatus[], pulled: 0, online: true, now: opts.now ?? Date.parse('2026-09-15T10:00:00Z') } as Harness
  h.engine = new SyncEngine({
    api: cloud,
    onPulled: async () => {
      h.pulled++
    },
    onStatus: (s) => h.statuses.push(s),
    now: () => h.now,
    isOnline: () => h.online,
    debounceMs: opts.debounceMs ?? 0,
    backoffMs: opts.backoffMs,
  })
  return h
}


beforeEach(async () => {
  await db.delete()
  await db.open()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('claim: account has no store → upload the phone store', () => {
  it('uploads store, records and events once; marks everything synced; binds and advances cursors', async () => {
    const local = await seedLocal()
    const cloud = new FakeCloud(USER_A.id)
    const h = harness(cloud)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()

    expect(h.engine.status.phase).toBe('idle')
    expect(h.engine.status.boundStoreId).toBe(local.store.id)
    expect(cloud.stores.get(local.store.id)?.created_by).toBe(USER_A.id)
    expect(cloud.members.get(local.store.id)?.has(USER_A.id)).toBe(true)
    const stored = (await repo.loadSnapshot(local.store.id))!
    expect(cloud.products.get(local.product.id)?.body).toEqual(stored.products[0])
    expect(cloud.customers.get(local.customer.id)?.body).toEqual(stored.customers[0])
    expect(cloud.eventsOf(local.store.id).map((e) => e.body)).toEqual(expect.arrayContaining(local.events))
    expect(cloud.eventsOf(local.store.id).length).toBe(3)
    expect(await repo.countUnsyncedEvents(local.store.id)).toBe(0)
    expect(await repo.countDirtyRecords(local.store.id)).toBe(0)
    expect(await repo.getMeta(META.boundStore)).toBe(local.store.id)
    expect(await repo.getMeta(META.boundUser)).toBe(USER_A.id)
    // the cursor is an xid watermark: everything committed before this run is accounted for, and
    // no window is left open
    expect(parseCursor(await repo.getMeta(META.cursorEvents(local.store.id)))).toBe(cloud.server.watermark() - 1)
    expect(await repo.getMeta(META.windowEvents(local.store.id))).toBeNull()
    expect(await repo.getMeta(META.lastSyncAt)).toBe('2026-09-15T10:00:00.000Z')
    expect(h.pulled).toBe(0) // nothing new came back

    // local data untouched and marker-free
    const snap = (await repo.loadSnapshot(local.store.id))!
    expect(snap.events).toEqual(expect.arrayContaining(local.events))
    expect(JSON.stringify(snap)).not.toMatch(/synced_at|synced_updated_at|local_only/)

    // a second run pushes nothing
    const calls = cloud.calls.length
    await h.engine.syncNow()
    expect(cloud.calls.slice(calls)).not.toContain('insertEvents')
    expect(cloud.calls.slice(calls)).not.toContain('upsert:products')
    expect(cloud.eventsOf(local.store.id).length).toBe(3)
  })

  it('later writes are pushed after the debounce as one run, and duplicates are ignored server-side', async () => {
    fakeTimers()
    const local = await seedLocal()
    const cloud = new FakeCloud(USER_A.id)
    const h = harness(cloud, { debounceMs: 2000 })
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    const before = cloud.calls.length

    await repo.addEvents([event(local.store.id), event(local.store.id)])
    h.engine.requestSync('write')
    await vi.advanceTimersByTimeAsync(1000)
    await repo.addEvents([event(local.store.id)])
    h.engine.requestSync('write') // resets the debounce window
    await vi.advanceTimersByTimeAsync(1500)
    expect(cloud.calls.slice(before)).toEqual([]) // still within the window
    await vi.advanceTimersByTimeAsync(600)
    await h.engine.whenIdle()
    expect(cloud.calls.slice(before).filter((c) => c === 'insertEvents').length).toBe(1)
    expect(cloud.eventsOf(local.store.id).length).toBe(6)
    expect(await repo.countUnsyncedEvents(local.store.id)).toBe(0)

    // re-pushing the same ids (e.g. after a lost ack) changes nothing
    await db.events.where('store_id').equals(local.store.id).modify({ synced_at: null })
    await h.engine.syncNow()
    expect(cloud.eventsOf(local.store.id).length).toBe(6)
    expect(await repo.countUnsyncedEvents(local.store.id)).toBe(0)
  })

  it('marks events synced only after the server acknowledged; a failed batch is retried once, never duplicated', async () => {
    const local = await seedLocal()
    const cloud = new FakeCloud(USER_A.id)
    const h = harness(cloud, { backoffMs: [10, 20, 30] })
    cloud.failOn = 'insertEvents'
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    expect(h.engine.status.phase).toBe('error')
    expect(h.engine.status.error).toMatch(/injected failure/)
    expect(await repo.countUnsyncedEvents(local.store.id)).toBe(3)
    expect(cloud.eventsOf(local.store.id).length).toBe(0)
    expect(cloud.products.size).toBe(1) // records before events were acknowledged and stay marked
    expect(await repo.countDirtyRecords(local.store.id)).toBe(0)

    await new Promise((r) => setTimeout(r, 30)) // backoff retry
    await h.engine.whenIdle()
    expect(h.engine.status.phase).toBe('idle')
    expect(cloud.eventsOf(local.store.id).length).toBe(3)
    expect(await repo.countUnsyncedEvents(local.store.id)).toBe(0)
  })
})

describe('claim: same store id on both sides → ordinary sync', () => {
  it('pulls what the other device uploaded and pushes what is local; both sides hold the union', async () => {
    const local = await seedLocal()
    const cloud = new FakeCloud(USER_A.id)
    const cloudProduct = product(local.store.id, ulid(), '2026-09-02T00:00:00.000Z', 'from other device')
    const cloudEvent = event(local.store.id, { type: 'EXPENSE', amount: 60, category: 'load' } as never)
    await seedCloud(cloud, { ...local.store, name: 'renamed on other device', updated_at: '2030-01-01T00:00:00.000Z' }, [cloudProduct], [], [cloudEvent])

    const h = harness(cloud)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    expect(h.engine.status.phase).toBe('idle')
    expect(h.pulled).toBe(1)
    const snap = (await repo.loadSnapshot(local.store.id))!
    expect(snap.store.name).toBe('renamed on other device') // newer store record wins
    expect(snap.products.map((p) => p.id).sort()).toEqual([local.product.id, cloudProduct.id].sort())
    expect(snap.events.length).toBe(4)
    expect(snap.events.find((e) => e.id === cloudEvent.id)).toEqual(cloudEvent)
    expect(cloud.eventsOf(local.store.id).length).toBe(4)
    expect(await repo.countUnsyncedEvents(local.store.id)).toBe(0)
    expect(await repo.countDirtyRecords(local.store.id)).toBe(0)
    expect((await repo.currentStore())!.id).toBe(local.store.id)
  })

  it('record LWW across devices: newer local edit wins in the cloud, newer cloud edit wins locally', async () => {
    const local = await seedLocal()
    const cloud = new FakeCloud(USER_A.id)
    const h = harness(cloud)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()

    // other device edits the customer with a newer timestamp; this device edits the product later than the cloud copy
    const remoteCustomer = { ...local.customer, name: 'remote wins', updated_at: '2030-01-01T00:00:00.000Z' }
    await cloud.upsertRecords('customers', [recordToRow(remoteCustomer)])
    await cloud.upsertRecords('products', [recordToRow({ ...local.product, name: 'stale remote', updated_at: '2026-09-02T00:00:00.000Z' })])
    await repo.saveProduct({ ...local.product, name: 'local wins' }) // stamps now → newest
    await h.engine.syncNow()

    const snap = (await repo.loadSnapshot(local.store.id))!
    expect(snap.customers[0]!.name).toBe('remote wins')
    expect(snap.products[0]!.name).toBe('local wins')
    expect((cloud.products.get(local.product.id)!.body as Product).name).toBe('local wins')
    expect((cloud.customers.get(local.customer.id)!.body as Customer).name).toBe('remote wins')
    expect(await repo.countDirtyRecords(local.store.id)).toBe(0)

    // a stale local edit (older updated_at than the cloud, e.g. a phone clock behind) is ignored by
    // the server and reconciled locally right after the push instead of diverging
    await db.products.put({ ...local.product, name: 'ancient', updated_at: '2020-01-01T00:00:00.000Z', synced_updated_at: null })
    await h.engine.syncNow()
    expect((cloud.products.get(local.product.id)!.body as Product).name).toBe('local wins')
    expect((await repo.loadSnapshot(local.store.id))!.products[0]!.name).toBe('local wins')
    expect(await repo.countDirtyRecords(local.store.id)).toBe(0)
  })

  it('a VOID pulled before its target is inert and applies once the target arrives in a later pull', async () => {
    const local = await seedLocal()
    const cloud = new FakeCloud(USER_A.id)
    const h = harness(cloud)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()

    const target = event(local.store.id, { type: 'COUNT', product_id: local.product.id, qty_on_hand: 9 } as never)
    const voidEv = event(local.store.id, { type: 'VOID', target: target.id, ts: '2026-09-11T12:00:00+08:00' } as never)
    await cloud.insertEvents([eventToRow(voidEv)])
    await h.engine.syncNow()
    let snap = (await repo.loadSnapshot(local.store.id))!
    expect(snap.events.some((e) => e.id === voidEv.id)).toBe(true)
    expect(activeEvents(snap.events).some((e) => e.id === target.id)).toBe(false)
    const before = deriveProduct(local.product, forProduct(activeEvents(snap.events), local.product.id), h.now)

    await cloud.insertEvents([eventToRow(target)])
    await h.engine.syncNow()
    snap = (await repo.loadSnapshot(local.store.id))!
    expect(snap.events.some((e) => e.id === target.id)).toBe(true)
    expect(activeEvents(snap.events).some((e) => e.id === target.id)).toBe(false) // voided
    const after = deriveProduct(local.product, forProduct(activeEvents(snap.events), local.product.id), h.now)
    expect(after.anchor).toEqual(before.anchor)
  })
})

describe('claim: nothing to lose on the phone → pull the cloud store and switch', () => {
  it('switches only after a complete pull; the previous local store stays in Dexie untouched', async () => {
    const local = await repo.createStore('Fresh phone', [3]) // empty
    const cloud = new FakeCloud(USER_A.id)
    const X = cloudStore('X0000000000000000000000001', 'Cloud store')
    const products = Array.from({ length: 1203 }, (_, i) => product(X.id, ulid(), '2026-09-01T00:00:00.000Z', `P${i}`))
    const customers = [customer(X.id), customer(X.id)]
    const events = Array.from({ length: 1101 }, () => event(X.id))
    await seedCloud(cloud, X, products, customers, events)

    const h = harness(cloud)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    expect(h.engine.status.phase).toBe('idle')
    expect((await repo.currentStore())!.id).toBe(X.id)
    expect(await repo.getMeta(META.claimPending)).toBeNull()
    const snap = (await repo.loadSnapshot(X.id))!
    expect(snap.products.length).toBe(1203)
    expect(snap.customers.length).toBe(2)
    expect(snap.events.length).toBe(1101)
    expect(await repo.countUnsyncedEvents(X.id)).toBe(0)
    expect(await repo.countDirtyRecords(X.id)).toBe(0)
    expect(await repo.storeExists(local.id)).toBe(true) // old store kept
    expect(h.pulled).toBeGreaterThanOrEqual(1)
    expect(cloud.calls.filter((c) => c === 'insertEvents')).toEqual([]) // nothing pushed from the empty phone store
    expect(cloud.eventsOf(X.id).length).toBe(1101)
  })

  it('the demo store never syncs; signing in with the demo current pulls the cloud store and leaves the demo alone', async () => {
    const demo = await repo.createStore('Demo', [3])
    await repo.setLocalOnly(demo.id)
    await repo.saveProduct(product(demo.id))
    await repo.addEvents([event(demo.id)])
    const cloud = new FakeCloud(USER_A.id)

    // no cloud store yet: nothing is uploaded, ever
    const h = harness(cloud)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    expect(h.engine.status.phase).toBe('local_only')
    expect(cloud.stores.size).toBe(0)
    expect(cloud.calls).not.toContain('upsertStore')
    await repo.addEvents([event(demo.id)])
    await h.engine.syncNow()
    expect(cloud.events.size).toBe(0)

    // the account has a store: a write trigger stays local, a manual sync (or launch) switches to
    // it; the demo stays local and unchanged
    const X = cloudStore('X0000000000000000000000002')
    await seedCloud(cloud, X, [product(X.id)], [], [event(X.id)])
    h.engine.requestSync('write')
    await settle(h)
    expect((await repo.currentStore())!.id).toBe(demo.id)
    expect(h.engine.status.phase).toBe('local_only')
    await h.engine.syncNow()
    expect((await repo.currentStore())!.id).toBe(X.id)
    expect(h.engine.status.phase).toBe('idle')
    expect(cloud.events.size).toBe(1)
    expect((await repo.loadSnapshot(demo.id))!.events.length).toBe(2)
    expect(await repo.isLocalOnly(demo.id)).toBe(true)
  })

  it('an interrupted pull never switches the store and resumes on the next run without duplicating anything', async () => {
    const local = await repo.createStore('Fresh phone', [3])
    const cloud = new FakeCloud(USER_A.id)
    const X = cloudStore('X0000000000000000000000003')
    const events = Array.from({ length: 700 }, () => event(X.id))
    await seedCloud(cloud, X, [product(X.id)], [customer(X.id)], events)

    const h = harness(cloud, { backoffMs: [5] })
    cloud.failOn = 'pullEvents' // first page of events fails, records already applied
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    expect(h.engine.status.phase).toBe('error')
    expect((await repo.currentStore())!.id).toBe(local.id) // NOT switched
    expect(await repo.getMeta(META.claimPending)).toBe(X.id)
    expect(await repo.getMeta(META.boundStore)).toBeNull()

    // a second interruption in the middle of the events (second page)
    cloud.failOn = null
    let pullCalls = 0
    const orig = cloud.pullEvents.bind(cloud)
    cloud.pullEvents = async (...args) => {
      if (++pullCalls === 2) throw new Error('mid-pull crash')
      return orig(...args)
    }
    await new Promise((r) => setTimeout(r, 10))
    await h.engine.whenIdle()
    expect((await repo.currentStore())!.id).toBe(local.id)
    expect(await repo.getMeta(META.claimPending)).toBe(X.id)
    const partial = (await repo.loadSnapshot(X.id))!.events.length
    expect(partial).toBe(500)

    // resume (a manual sync, or the next launch) completes and switches
    await h.engine.syncNow()
    expect(h.engine.status.phase).toBe('idle')
    expect((await repo.currentStore())!.id).toBe(X.id)
    expect(await repo.getMeta(META.claimPending)).toBeNull()
    expect((await repo.loadSnapshot(X.id))!.events.length).toBe(700)
    expect(await db.events.count()).toBe(700)
    expect(cloud.eventsOf(X.id).length).toBe(700)
  })
})

describe('claim: two populated stores → explicit choice', () => {
  async function askSetup() {
    const local = await seedLocal('Phone store')
    const cloud = new FakeCloud(USER_A.id)
    const X = cloudStore('X0000000000000000000000004', 'Cloud store')
    const xEvents = [event(X.id), event(X.id)]
    await seedCloud(cloud, X, [product(X.id)], [customer(X.id)], xEvents)
    const h = harness(cloud)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    expect(h.engine.status.phase).toBe('needs_choice')
    expect(h.engine.status.choice).toEqual({ cloud: { id: X.id, name: 'Cloud store', updated_at: X.updated_at }, local: { id: local.store.id, name: 'Phone store' } })
    // nothing moved in either direction while waiting
    expect(cloud.calls.filter((c) => c !== 'listMyStores')).toEqual([])
    expect(await repo.countUnsyncedEvents(local.store.id)).toBe(3)
    return { local, cloud, X, xEvents, h }
  }

  it('"Panatilihin ang nasa phone": archives the cloud store (kept, not deleted) and uploads the phone store', async () => {
    const { local, cloud, X, xEvents, h } = await askSetup()
    await h.engine.resolveClaim('phone')
    expect(h.engine.status.phase).toBe('idle')
    expect(cloud.stores.get(X.id)!.archived_at).toBeTruthy()
    expect(cloud.eventsOf(X.id).length).toBe(xEvents.length) // archived store data intact
    expect(cloud.stores.get(local.store.id)!.archived_at).toBeNull()
    expect(cloud.eventsOf(local.store.id).length).toBe(3)
    expect((await repo.currentStore())!.id).toBe(local.store.id)
    expect(await repo.getMeta(META.boundStore)).toBe(local.store.id)
    expect((await cloud.listMyStores()).map((s) => s.id)).toEqual([local.store.id]) // exactly one active store
    expect(await repo.storeExists(X.id)).toBe(false) // never pulled
  })

  it('"Gamitin ang nasa cloud": switches to the cloud store after a full pull; the phone store stays in Dexie and is never uploaded', async () => {
    const { local, cloud, X, h } = await askSetup()
    await h.engine.resolveClaim('cloud')
    expect(h.engine.status.phase).toBe('idle')
    expect((await repo.currentStore())!.id).toBe(X.id)
    expect((await repo.loadSnapshot(X.id))!.events.length).toBe(2)
    expect(await repo.storeExists(local.store.id)).toBe(true)
    expect((await repo.loadSnapshot(local.store.id))!.events.length).toBe(3)
    expect(cloud.stores.has(local.store.id)).toBe(false)
    expect(cloud.stores.get(X.id)!.archived_at).toBeNull()
    expect(h.pulled).toBeGreaterThanOrEqual(1)
  })

  it('"Mamaya na": stays unbound; local writes do not re-open the choice, a manual sync does', async () => {
    const { local, cloud, h } = await askSetup()
    await h.engine.resolveClaim('later')
    expect(h.engine.status.phase).toBe('unbound')
    expect(h.engine.status.choice).toBeNull()
    const calls = cloud.calls.length
    await repo.addEvents([event(local.store.id)])
    h.engine.requestSync('write')
    await settle(h)
    expect(h.engine.status.phase).toBe('unbound')
    expect(cloud.calls.length).toBe(calls)
    await h.engine.syncNow()
    expect(h.engine.status.phase).toBe('needs_choice')
  })

  it('when another device archived the bound store, the next sync unbinds and asks again instead of pushing into an archived store', async () => {
    const local = await seedLocal()
    const cloud = new FakeCloud(USER_A.id)
    const h = harness(cloud)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    expect(h.engine.status.phase).toBe('idle')

    // other device: "keep the phone" with its own store Y
    await cloud.archiveStore(local.store.id)
    const Y = cloudStore('Y0000000000000000000000001', 'Other phone')
    await seedCloud(cloud, Y, [product(Y.id)], [], [event(Y.id)])

    await repo.addEvents([event(local.store.id)])
    await h.engine.syncNow()
    expect(h.engine.status.phase).toBe('needs_choice')
    expect(h.engine.status.choice?.cloud.id).toBe(Y.id)
    expect(cloud.eventsOf(local.store.id).length).toBe(3) // the new event was not pushed into the archived store
    await h.engine.resolveClaim('phone')
    expect(cloud.stores.get(local.store.id)!.archived_at).toBeNull() // un-archived
    expect(cloud.stores.get(Y.id)!.archived_at).toBeTruthy()
    expect(cloud.eventsOf(local.store.id).length).toBe(4)
  })
})

describe('triggers, offline, backoff, skew, sign-out, other account', () => {
  it('offline: queues writes with a pending count, pushes everything once online', async () => {
    const local = await seedLocal()
    const cloud = new FakeCloud(USER_A.id)
    const h = harness(cloud)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()

    h.online = false
    await repo.addEvents([event(local.store.id), event(local.store.id)])
    await repo.saveProduct({ ...local.product, name: 'offline edit' })
    h.engine.requestSync('write')
    await settle(h)
    expect(h.engine.status.phase).toBe('offline')
    expect(h.engine.status.pendingEvents).toBe(2)
    expect(h.engine.status.pendingRecords).toBe(1)
    expect(cloud.eventsOf(local.store.id).length).toBe(3)

    h.online = true
    h.engine.requestSync('online')
    await h.engine.whenIdle()
    expect(h.engine.status.phase).toBe('idle')
    expect(h.engine.status.pendingEvents).toBe(0)
    expect(cloud.eventsOf(local.store.id).length).toBe(5)
    expect((cloud.products.get(local.product.id)!.body as Product).name).toBe('offline edit')
  })

  it('a network error mid-run is reported as offline, not as an error, and retried on the next trigger', async () => {
    const local = await seedLocal()
    const cloud = new FakeCloud(USER_A.id)
    const h = harness(cloud)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    cloud.offline = true
    await repo.addEvents([event(local.store.id)])
    await h.engine.syncNow()
    expect(h.engine.status.phase).toBe('offline')
    expect(h.engine.status.error).toBeNull()
    cloud.offline = false
    h.engine.requestSync('foreground')
    await h.engine.whenIdle()
    expect(h.engine.status.phase).toBe('idle')
    expect(cloud.eventsOf(local.store.id).length).toBe(4)
  })

  it('server errors back off 10 s → 1 min → 5 min and a foreground trigger runs immediately', async () => {
    fakeTimers()
    await seedLocal()
    const cloud = new FakeCloud(USER_A.id)
    const h = harness(cloud)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    const runs = () => cloud.calls.filter((c) => c === 'serverTime').length

    cloud.failNext = 'boom'
    await h.engine.syncNow()
    expect(h.engine.status.phase).toBe('error')
    const n = runs()
    cloud.failNext = 'boom'
    await vi.advanceTimersByTimeAsync(9_999)
    expect(runs()).toBe(n)
    await vi.advanceTimersByTimeAsync(2)
    await h.engine.whenIdle()
    expect(runs()).toBe(n + 1) // 10 s retry (failed again)
    cloud.failNext = 'boom'
    await vi.advanceTimersByTimeAsync(60_001)
    await h.engine.whenIdle()
    expect(runs()).toBe(n + 2) // 1 min
    await vi.advanceTimersByTimeAsync(299_000)
    expect(runs()).toBe(n + 2)
    h.engine.requestSync('foreground') // resets backoff, runs now
    await h.engine.whenIdle()
    expect(runs()).toBe(n + 3)
    expect(h.engine.status.phase).toBe('idle')
    await vi.advanceTimersByTimeAsync(600_000)
    expect(runs()).toBe(n + 3) // no stray retries after success
  })

  it('single-flight: triggers during a run coalesce into exactly one follow-up run', async () => {
    const local = await seedLocal()
    const cloud = new FakeCloud(USER_A.id)
    const h = harness(cloud)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    const runs = () => cloud.calls.filter((c) => c === 'serverTime').length
    const n = runs()
    const p = h.engine.syncNow()
    await repo.addEvents([event(local.store.id)])
    h.engine.requestSync('foreground')
    h.engine.requestSync('online')
    h.engine.requestSync('manual')
    await p
    await h.engine.whenIdle()
    expect(runs()).toBe(n + 2)
    expect(cloud.eventsOf(local.store.id).length).toBe(4)
  })

  it('clock skew beyond 5 minutes warns and never blocks the sync', async () => {
    const local = await seedLocal()
    const cloud = new FakeCloud(USER_A.id)
    const h = harness(cloud)
    cloud.serverNow = () => new Date(h.now - 6 * 60_000).toISOString()
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    expect(h.engine.status.phase).toBe('idle')
    expect(h.engine.status.skewWarning).toBe(true)
    expect(h.engine.status.skewMs).toBe(6 * 60_000)
    expect(await repo.getMeta(META.skew)).toBe(String(6 * 60_000))
    expect(cloud.eventsOf(local.store.id).length).toBe(3)
    cloud.serverNow = () => new Date(h.now - 4 * 60_000).toISOString()
    await h.engine.syncNow()
    expect(h.engine.status.skewWarning).toBe(false)
  })

  it('sign-out stops syncing and keeps every local row; sign-in again resumes on the same binding', async () => {
    const local = await seedLocal()
    const cloud = new FakeCloud(USER_A.id)
    const h = harness(cloud)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    const before = await db.events.count()
    h.engine.setUser(null)
    expect(h.engine.status.phase).toBe('signed_out')
    await repo.addEvents([event(local.store.id)])
    h.engine.requestSync('write')
    await settle(h)
    expect(cloud.eventsOf(local.store.id).length).toBe(3)
    expect(await db.events.count()).toBe(before + 1)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    expect(h.engine.status.phase).toBe('idle')
    expect(cloud.eventsOf(local.store.id).length).toBe(4)
  })

  it('a different account never reuses the binding; RLS-style visibility keeps it out of the other store', async () => {
    const local = await seedLocal()
    const cloud = new FakeCloud(USER_A.id)
    const h = harness(cloud)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    h.engine.dispose()

    // account B on the same phone (same local store), B owns nothing in the cloud
    const hb = harness(cloud.as(USER_B.id))
    hb.engine.setUser(USER_B)
    await hb.engine.whenIdle()
    // upload attempt hits an existing row B cannot see/update → denied error; nothing changes for A's store
    expect(hb.engine.status.phase).toBe('error')
    expect(cloud.stores.get(local.store.id)!.created_by).toBe(USER_A.id)
    expect(cloud.members.get(local.store.id)!.has(USER_B.id)).toBe(false)
    expect(await repo.getMeta(META.boundUser)).toBe(USER_A.id)
    expect((await repo.loadSnapshot(local.store.id))!.events.length).toBe(3)
  })
})

describe('pull windows: an event can never be skipped by the cursor', () => {
  /** A bound, already-synced device sharing a store with a second device. */
  async function bound() {
    const local = await seedLocal()
    const cloud = new FakeCloud(USER_A.id)
    const h = harness(cloud)
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    expect(h.engine.status.phase).toBe('idle')
    return { local, cloud, h }
  }
  const localEventIds = async (storeId: string) => (await repo.loadSnapshot(storeId))!.events.map((e) => e.id).sort()

  it('the race: a lower server_seq that commits later is not stepped over', async () => {
    const { local, cloud, h } = await bound()
    const sid = local.store.id
    const cursorBefore = parseCursor(await repo.getMeta(META.cursorEvents(sid)))

    // Device B starts writing E_slow (gets the lower sequence) but has not committed yet…
    const slow = cloud.begin()
    const eSlow = event(sid)
    await slow.insertEvents([eventToRow(eSlow)])
    // …while device C writes and commits E_fast, which therefore has a HIGHER sequence.
    const eFast = event(sid)
    await cloud.insertEvents([eventToRow(eFast)])
    expect(cloud.events.get(eSlow.id)!.server_seq).toBeLessThan(cloud.events.get(eFast.id)!.server_seq)

    // This is the defect the window removes: reading by sequence alone (no xid bound) returns the
    // later row only, so a cursor advanced to its server_seq would never come back for E_slow.
    const bySequenceOnly = await cloud.pullEvents(sid, { afterXid: 0, beforeXid: Number.MAX_SAFE_INTEGER, after: 0 }, 500)
    expect(bySequenceOnly.map((r) => r.id)).toContain(eFast.id)
    expect(bySequenceOnly.map((r) => r.id)).not.toContain(eSlow.id)
    expect(bySequenceOnly[bySequenceOnly.length - 1]!.server_seq).toBeGreaterThan(cloud.events.get(eSlow.id)!.server_seq)

    // The real pull: the watermark sits at the uncommitted transaction, so the cursor does not move
    // past it and neither event is consumed yet.
    await h.engine.syncNow()
    expect(h.engine.status.phase).toBe('idle')
    expect(await localEventIds(sid)).toEqual(local.events.map((e) => e.id).sort())
    expect(parseCursor(await repo.getMeta(META.cursorEvents(sid)))).toBe(cursorBefore)

    // Once it commits, both arrive — nothing was lost, only delayed.
    slow.commit()
    await h.engine.syncNow()
    expect(await localEventIds(sid)).toEqual([...local.events.map((e) => e.id), eSlow.id, eFast.id].sort())
    expect(parseCursor(await repo.getMeta(META.cursorEvents(sid)))).toBe(cloud.server.watermark() - 1)
    expect(await repo.getMeta(META.windowEvents(sid))).toBeNull()
  })

  it('the same guarantee covers record pulls (products/customers)', async () => {
    const { local, cloud, h } = await bound()
    const sid = local.store.id
    const cursorBefore = parseCursor(await repo.getMeta(META.cursorProducts(sid)))

    const slow = cloud.begin()
    const pSlow = product(sid, ulid(), '2027-01-01T00:00:00.000Z', 'slow')
    await slow.upsertRecords('products', [recordToRow(pSlow)])
    const pFast = product(sid, ulid(), '2027-01-01T00:00:00.000Z', 'fast')
    await cloud.upsertRecords('products', [recordToRow(pFast)])
    expect(cloud.products.get(pSlow.id)!.server_rev).toBeLessThan(cloud.products.get(pFast.id)!.server_rev)

    await h.engine.syncNow()
    let names = (await repo.loadSnapshot(sid))!.products.map((x) => x.name)
    expect(names).not.toContain('fast')
    expect(names).not.toContain('slow')
    expect(parseCursor(await repo.getMeta(META.cursorProducts(sid)))).toBe(cursorBefore)

    slow.commit()
    await h.engine.syncNow()
    names = (await repo.loadSnapshot(sid))!.products.map((x) => x.name)
    expect(names).toContain('slow')
    expect(names).toContain('fast')
  })

  it('an aborted transaction leaves a sequence gap but never stalls the cursor', async () => {
    const { local, cloud, h } = await bound()
    const sid = local.store.id
    const doomed = cloud.begin()
    await doomed.insertEvents([eventToRow(event(sid))])
    doomed.rollback() // rows gone, sequence numbers spent
    const kept = event(sid)
    await cloud.insertEvents([eventToRow(kept)])

    await h.engine.syncNow()
    expect(await localEventIds(sid)).toContain(kept.id)
    expect(parseCursor(await repo.getMeta(META.cursorEvents(sid)))).toBe(cloud.server.watermark() - 1)
    expect((await repo.loadSnapshot(sid))!.events.length).toBe(local.events.length + 1)
  })

  it('an event committed while a pull is running is outside the window and arrives on the next run', async () => {
    const { local, cloud, h } = await bound()
    const sid = local.store.id
    const early = event(sid)
    await cloud.insertEvents([eventToRow(early)])

    // commit a second event from another device in the middle of this run's pull
    const late = event(sid)
    const orig = cloud.pullEvents.bind(cloud)
    let calls = 0
    cloud.pullEvents = async (...args) => {
      const rows = await orig(...args)
      if (++calls === 1) await cloud.insertEvents([eventToRow(late)])
      return rows
    }
    await h.engine.syncNow()
    const after = await localEventIds(sid)
    expect(after).toContain(early.id)
    expect(after).not.toContain(late.id) // higher xid than this run's watermark
    const cursor = parseCursor(await repo.getMeta(META.cursorEvents(sid)))
    expect(cursor).toBeLessThan(cloud.events.get(late.id)!.xid) // cursor never passed it

    cloud.pullEvents = orig
    await h.engine.syncNow()
    expect(await localEventIds(sid)).toContain(late.id)
  })

  it('an interrupted pull resumes in the same frozen window and still ends up complete', async () => {
    const localStore = await repo.createStore('Fresh phone', [3])
    const cloud = new FakeCloud(USER_A.id)
    const X = cloudStore('X0000000000000000000000009')
    const first = Array.from({ length: 700 }, () => event(X.id))
    await seedCloud(cloud, X, [product(X.id)], [], first)
    const h = harness(cloud, { backoffMs: [5] })

    // fail on the second page, so a window is left half-consumed
    const orig = cloud.pullEvents.bind(cloud)
    let calls = 0
    cloud.pullEvents = async (...args) => {
      if (++calls === 2) throw new Error('connection lost mid-pull')
      return orig(...args)
    }
    h.engine.setUser(USER_A)
    await h.engine.whenIdle()
    expect((await repo.currentStore())!.id).toBe(localStore.id) // not switched
    const pending = JSON.parse((await repo.getMeta(META.windowEvents(X.id)))!)
    expect(pending.seq).toBe(500)
    const frozenHi = pending.hi

    // more events commit before the resume: they must NOT be inside the pinned window
    const later = Array.from({ length: 3 }, () => event(X.id))
    await cloud.insertEvents(later.map(eventToRow))
    for (const e of later) expect(cloud.events.get(e.id)!.xid).toBeGreaterThanOrEqual(frozenHi)

    cloud.pullEvents = orig
    await h.engine.syncNow()
    expect(h.engine.status.phase).toBe('idle')
    expect((await repo.currentStore())!.id).toBe(X.id)
    const snap = (await repo.loadSnapshot(X.id))!
    expect(snap.events.length).toBe(703) // the frozen window plus the newer window, each exactly once
    expect(await db.events.count()).toBe(703)
    expect(await repo.getMeta(META.windowEvents(X.id))).toBeNull()
    expect(parseCursor(await repo.getMeta(META.cursorEvents(X.id)))).toBe(cloud.server.watermark() - 1)
  })

  it('a lost window marker only costs a re-read: add-or-ignore keeps the result identical', async () => {
    const { local, cloud, h } = await bound()
    const sid = local.store.id
    const extra = Array.from({ length: 3 }, () => event(sid))
    await cloud.insertEvents(extra.map(eventToRow))
    await h.engine.syncNow()
    const before = await localEventIds(sid)

    // rewind the cursor as if the window/cursor state had been lost
    await repo.setMeta(META.cursorEvents(sid), '0')
    await h.engine.syncNow()
    expect(await localEventIds(sid)).toEqual(before)
    expect(await db.events.count()).toBe(before.length)
    expect(await repo.countUnsyncedEvents(sid)).toBe(0) // re-pulled rows stay marked as synced
  })
})

describe('convergence: golden scenarios split across two devices', () => {
  for (const s of scenarios.slice(0, 12)) {
    it(`${s.id}: this device + the cloud copy of the other device derive the same state`, async () => {
      const store = makeStore(s.store.restock_days, s.store.next_trip_override)
      const prod = makeProduct(s.product)
      const all = toEvents(s.events)
      const nowMs = toMs(s.now)
      const expected = run(store, prod, all, nowMs)

      // this device: local store with the same id, half the events; cloud: the other half
      await db.stores.put(store)
      await repo.setMeta('current_store', store.id)
      await repo.saveProduct(prod)
      const order = shuffled(all, s.id.length * 7919)
      const mine = order.filter((_, i) => i % 2 === 0)
      const theirs = order.filter((_, i) => i % 2 === 1)
      await repo.addEvents(mine)
      const cloud = new FakeCloud(USER_A.id)
      await seedCloud(cloud, store, [], [], theirs)

      const h = harness(cloud)
      h.engine.setUser(USER_A)
      await h.engine.whenIdle()
      expect(h.engine.status.phase).toBe('idle')

      const snap = (await repo.loadSnapshot(store.id))!
      expect(snap.events.length).toBe(all.length)
      const got = run(store, prod, snap.events, nowMs)
      expect({ ...got.state, flags: [...got.state.flags].sort() }).toEqual({ ...expected.state, flags: [...expected.state.flags].sort() })
      expect(got.line).toEqual(expected.line)
      // the cloud holds the union too
      const cloudEvents = cloud.eventsOf(store.id).map((r) => r.body)
      expect(run(store, prod, cloudEvents, nowMs).line).toEqual(expected.line)
      expect(cloudEvents.length).toBe(all.length)
    })
  }
})
