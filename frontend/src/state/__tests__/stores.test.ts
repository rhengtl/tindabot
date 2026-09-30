// Several stores on one phone (decided 2026-09-30): the list, switching, adding, deleting, and the
// demo opened at most once. The app always works on one current store; every action here leaves the
// other stores exactly as they were, except the one being deleted.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/db'
import * as repo from '../../db/repo'
import { useApp } from '../store'

async function fresh() {
  await db.delete()
  await db.open()
  useApp.setState({ lang: 'tl', loaded: false, store: null, demo: false, demoExit: null, stores: [], onboarded: false })
}

async function storeWith(name: string, entries: number, updatedAt?: string) {
  const s = await repo.createStore(name, [3])
  if (updatedAt) await db.stores.put({ ...s, updated_at: updatedAt })
  const base = { v: 1 as const, store_id: s.id, device_id: 'DEV0STORES0000000000000001', recorded_at: '2026-09-10T00:00:00.000Z' }
  await repo.addEvents(
    Array.from({ length: entries }, (_, i) => ({ ...base, id: `E${s.id.slice(1, 22)}${String(i).padStart(4, '0')}`, type: 'EXPENSE' as const, amount: 10 + i, category: 'iba' as const, ts: '2026-09-10T08:00:00+08:00' })),
  )
  return s
}

async function startApp() {
  await repo.setMeta('onboarded', '1')
  await useApp.getState().init()
}

const count = async (storeId: string) => (await repo.loadSnapshot(storeId))?.events.length ?? null

describe('stores on this phone', () => {
  beforeEach(fresh)

  it('lists every store, real ones by name and the demo last, and marks nothing else', async () => {
    await storeWith('Tindahan B', 1)
    await storeWith('Tindahan A', 1)
    await startApp()
    await useApp.getState().openDemo()
    expect(useApp.getState().stores.map((s) => [s.name, s.demo])).toEqual([
      ['Tindahan A', false],
      ['Tindahan B', false],
      ['Tindahan ni Aling Nena (demo)', true],
    ])
  })

  it('switching makes another store current and leaves both stores’ data as they were', async () => {
    const a = await storeWith('A', 2)
    const b = await storeWith('B', 3) // current
    await startApp()
    expect(useApp.getState().store!.id).toBe(b.id)

    await useApp.getState().switchStore(a.id)
    expect(useApp.getState().store!.id).toBe(a.id)
    expect(useApp.getState().events).toHaveLength(2)
    expect(await repo.getMeta('current_store')).toBe(a.id)
    expect(await count(b.id)).toBe(3)
  })

  it('a new store goes through onboarding; every existing store stays, and switching back from onboarding ends it', async () => {
    const a = await storeWith('A', 2)
    await startApp()

    await useApp.getState().newStore()
    expect(useApp.getState().store).toBeNull()
    expect(useApp.getState().onboarded).toBe(false)
    expect(await count(a.id)).toBe(2)

    // "← Bumalik sa A" on onboarding
    await useApp.getState().switchStore(a.id)
    expect(useApp.getState().store!.id).toBe(a.id)
    expect(useApp.getState().onboarded).toBe(true)
    expect(await repo.getMeta('onboarded')).toBe('1')
  })

  it('deleting another store removes only that store', async () => {
    const a = await storeWith('A', 2)
    const b = await storeWith('B', 3) // current
    await startApp()

    await useApp.getState().deleteStore(a.id)
    expect(await repo.storeExists(a.id)).toBe(false)
    expect(await db.events.where('store_id').equals(a.id).count()).toBe(0)
    expect(useApp.getState().store!.id).toBe(b.id)
    expect(useApp.getState().stores.map((s) => s.name)).toEqual(['B'])
    expect(await count(b.id)).toBe(3)
    expect(await repo.deletedStoreIds()).toEqual([a.id]) // queued for archiving in the cloud
  })

  it('deleting the current store switches to the most recently updated remaining store', async () => {
    const older = await storeWith('Older', 1, '2026-08-01T00:00:00.000Z')
    const newer = await storeWith('Newer', 1, '2026-09-20T00:00:00.000Z')
    const cur = await storeWith('Current', 2)
    await startApp()
    expect(useApp.getState().store!.id).toBe(cur.id)

    await useApp.getState().deleteStore(cur.id)
    expect(useApp.getState().store!.id).toBe(newer.id)
    expect(useApp.getState().onboarded).toBe(true)
    expect(await count(older.id)).toBe(1)
  })

  it('deleting the only real store opens onboarding (never at the products step); the demo is not a fallback', async () => {
    const only = await storeWith('Only', 2)
    await startApp()
    await useApp.getState().openDemo()
    await useApp.getState().switchStore(only.id)
    const seen: Array<{ onboarded: boolean; store: boolean }> = []
    const stop = useApp.subscribe((s) => seen.push({ onboarded: s.onboarded, store: s.store !== null }))

    await useApp.getState().deleteStore(only.id)
    stop()
    expect(useApp.getState().store).toBeNull()
    expect(useApp.getState().onboarded).toBe(false)
    expect(seen.some((s) => !s.onboarded && s.store)).toBe(false)
    expect(await repo.demoStoreId()).not.toBeNull() // the demo is still there
  })

  it('deleting the demo leaves nothing to archive in the cloud', async () => {
    const real = await storeWith('Real', 1)
    await startApp()
    await useApp.getState().openDemo()
    const demoId = useApp.getState().store!.id

    await useApp.getState().deleteStore(demoId)
    expect(await repo.storeExists(demoId)).toBe(false)
    expect(await repo.deletedStoreIds()).toEqual([])
    expect(useApp.getState().store!.id).toBe(real.id)
  })

  it('the demo is opened at most once: opening it again goes back to the same demo', async () => {
    await storeWith('Real', 1)
    await startApp()
    await useApp.getState().openDemo()
    const first = useApp.getState().store!.id
    await useApp.getState().leaveDemo()
    await useApp.getState().openDemo()
    expect(useApp.getState().store!.id).toBe(first)
    expect(useApp.getState().stores.filter((s) => s.demo)).toHaveLength(1)
  })

  it('opening the demo from a fresh onboarding finishes onboarding', async () => {
    await useApp.getState().init()
    expect(useApp.getState().onboarded).toBe(false)
    await useApp.getState().openDemo()
    expect(useApp.getState().demo).toBe(true)
    expect(useApp.getState().onboarded).toBe(true)
    expect(await repo.getMeta('onboarded')).toBe('1')
  })
})
