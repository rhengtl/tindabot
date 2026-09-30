// Leaving the demo. Trying the demo used to be one-way: onboarding was marked done and the demo
// became the current store, with nothing in the app to start a real store. And opening the demo from
// Iba pa hid the real store with no way back. Leaving now goes back to the real store on this phone
// when there is one, and to onboarding otherwise. Either way nothing is deleted: the demo stays
// exactly as it was, and so does every other store.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/db'
import * as repo from '../../db/repo'
import { loadDemo } from '../demo'
import { useApp } from '../store'

async function fresh() {
  await db.delete()
  await db.open()
  useApp.setState({ lang: 'tl', loaded: false, store: null, demo: false, demoExit: null, onboarded: false })
}

async function eventCount(storeId: string): Promise<number> {
  return (await repo.loadSnapshot(storeId))!.events.length
}

async function realStoreWithAnEntry(name: string, updatedAt?: string) {
  const s = await repo.createStore(name, [3])
  if (updatedAt) await db.stores.put({ ...s, updated_at: updatedAt })
  const base = { v: 1 as const, store_id: s.id, device_id: 'DEV0DEMOEXIT00000000000001', recorded_at: '2026-09-10T00:00:00.000Z' }
  await repo.addEvents([{ ...base, id: `E${s.id.slice(1)}`, type: 'EXPENSE', amount: 50, category: 'iba', ts: '2026-09-10T08:00:00+08:00' }])
  return s
}

describe('leaving the demo', () => {
  beforeEach(fresh)

  it('from the onboarding demo, with no real store: onboarding starts over and the demo is kept', async () => {
    // what "Subukan ang demo" on onboarding does
    await loadDemo()
    await repo.setMeta('onboarded', '1')
    await useApp.getState().init()
    const demoId = useApp.getState().store!.id
    const demoEvents = await eventCount(demoId)
    expect(useApp.getState().demo).toBe(true)
    expect(useApp.getState().demoExit).toBeNull() // nothing to go back to: the button starts a store

    await useApp.getState().leaveDemo()

    const s = useApp.getState()
    expect(s.store).toBeNull() // App shows onboarding: no store…
    expect(s.onboarded).toBe(false) // …and onboarding not done, so it starts at the store name
    expect(s.demo).toBe(false)
    expect(await repo.getMeta('current_store')).toBeNull()
    expect(await repo.getMeta('onboarded')).toBe('0')
    expect(await repo.isLocalOnly(demoId)).toBe(true) // the demo is still there, still a demo
    expect(await eventCount(demoId)).toBe(demoEvents)

    // finishing onboarding as usual gives a real store that the app now uses
    await useApp.getState().createStore('Tindahan ko', [3, 6])
    await repo.setMeta('onboarded', '1')
    await useApp.getState().init()
    expect(useApp.getState().store!.name).toBe('Tindahan ko')
    expect(useApp.getState().demo).toBe(false)
    expect(useApp.getState().onboarded).toBe(true)
    expect(await eventCount(demoId)).toBe(demoEvents)
  })

  it('onboarding never sees "not onboarded" while a store is still loaded (it would open at the products step)', async () => {
    await loadDemo()
    await repo.setMeta('onboarded', '1')
    await useApp.getState().init()
    const seen: Array<{ onboarded: boolean; store: boolean }> = []
    const stop = useApp.subscribe((s) => seen.push({ onboarded: s.onboarded, store: s.store !== null }))

    await useApp.getState().leaveDemo()
    stop()

    expect(seen.some((s) => !s.onboarded && s.store)).toBe(false)
    expect(seen.at(-1)).toEqual({ onboarded: false, store: false })
  })

  it('with a real store on the phone (demo opened from Iba pa): goes straight back to it', async () => {
    const real = await realStoreWithAnEntry('Tindahan ni Test')
    await repo.setMeta('onboarded', '1')
    await useApp.getState().init()
    // what the demo button in Iba pa → advanced does
    await loadDemo()
    await useApp.getState().init()
    const demoId = useApp.getState().store!.id
    const demoEvents = await eventCount(demoId)
    expect(useApp.getState().demo).toBe(true)
    expect(useApp.getState().demoExit).toEqual({ id: real.id, name: 'Tindahan ni Test' })

    await useApp.getState().leaveDemo()

    const s = useApp.getState()
    expect(s.store!.id).toBe(real.id)
    expect(s.demo).toBe(false)
    expect(s.demoExit).toBeNull()
    expect(s.onboarded).toBe(true) // no onboarding: the real store is already set up
    expect(await repo.getMeta('onboarded')).toBe('1')
    expect(s.events).toHaveLength(1) // the real store's own entry, untouched
    expect(await eventCount(demoId)).toBe(demoEvents) // the demo, untouched
  })

  it('with several real stores, goes back to the most recently updated one', async () => {
    await realStoreWithAnEntry('Luma', '2026-08-01T00:00:00.000Z')
    const newer = await realStoreWithAnEntry('Bago', '2026-09-20T00:00:00.000Z')
    await realStoreWithAnEntry('Gitna', '2026-09-01T00:00:00.000Z')
    await repo.setMeta('onboarded', '1')
    await loadDemo() // a demo is never a candidate, even though it is the newest store
    await useApp.getState().init()
    expect(useApp.getState().demoExit).toEqual({ id: newer.id, name: 'Bago' })
  })

  it('does nothing when the current store is not the demo', async () => {
    const real = await realStoreWithAnEntry('Tindahan ni Test')
    await repo.setMeta('onboarded', '1')
    await useApp.getState().init()
    expect(useApp.getState().demo).toBe(false)

    await useApp.getState().leaveDemo()

    expect(useApp.getState().store!.id).toBe(real.id)
    expect(await repo.getMeta('current_store')).toBe(real.id)
    expect(await repo.getMeta('onboarded')).toBe('1')
  })
})
