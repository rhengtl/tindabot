// A write that failed used to be silent: the sheet stayed open and the person was told nothing.
// `guardedWrite` is the one place that decides what happens instead — the caller's success path is
// skipped and the app's own "not saved" wording is shown, never the browser's error text.
import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/db'
import * as repo from '../../db/repo'
import { EN, TL } from '../strings'
import { guardedWrite } from '../write'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('guardedWrite', () => {
  it('reports a write that succeeded, and says nothing to the person', async () => {
    const fail = vi.fn()
    const ok = await guardedWrite(async () => 'written', fail)
    expect(ok).toBe(true)
    expect(fail).not.toHaveBeenCalled()
  })

  it('reports a write that failed exactly once, and never throws at the caller', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fail = vi.fn()
    const ok = await guardedWrite(async () => {
      throw new Error('DatabaseClosedError')
    }, fail)
    expect(ok).toBe(false)
    expect(fail).toHaveBeenCalledTimes(1)
    // the reason is for the console only
    expect(logged).toHaveBeenCalledOnce()
    expect(String(logged.mock.calls[0]![0])).toContain('local write failed')
  })

  it('a real Dexie write that cannot reach a closed database is reported as a failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await db.delete()
    await db.open()
    const store = await repo.createStore('Tindahan ni Test', [3])
    const messages: string[] = []
    const say = (m: string) => messages.push(m)

    const good = await guardedWrite(() => repo.addEvents([{ id: 'E0000000000000000000000001', v: 1, store_id: store.id, device_id: 'DEV00000000000000000000001', ts: '2026-09-10T12:00:00+08:00', recorded_at: '2026-09-10T12:00:00+08:00', type: 'CASH_COUNT', amount: 100 }]), () => say(TL.common.notSaved))
    expect(good).toBe(true)
    expect(messages).toEqual([])
    expect(await db.events.count()).toBe(1)

    repo.closeDatabase() // the browser revoking storage mid-session looks like this from here
    const bad = await guardedWrite(() => repo.addEvents([{ id: 'E0000000000000000000000002', v: 1, store_id: store.id, device_id: 'DEV00000000000000000000001', ts: '2026-09-10T12:05:00+08:00', recorded_at: '2026-09-10T12:05:00+08:00', type: 'CASH_COUNT', amount: 200 }]), () => say(TL.common.notSaved))
    expect(bad).toBe(false)
    expect(messages).toEqual([TL.common.notSaved]) // the failure toast, and no "Naitala"

    await repo.openDatabase()
    expect(await db.events.count()).toBe(1) // the failed write left nothing behind
  })
})

describe('the wording a failed write shows', () => {
  it('is the approved sentence in both languages', () => {
    expect(TL.common.notSaved).toBe('Hindi na-save. Subukan ulit.')
    expect(EN.common.notSaved).toBe('Not saved. Please try again.')
  })

  it('never carries a browser error, a class name or a stack', () => {
    for (const text of [TL.common.notSaved, EN.common.notSaved]) {
      expect(text).not.toMatch(/Error|IndexedDB|Dexie|at \w+\(/)
      expect(text.length).toBeLessThan(60)
    }
  })

  it('stays distinct from the success wording it replaces', () => {
    for (const S of [TL, EN]) {
      expect(S.common.notSaved).not.toBe(S.common.saved)
      expect(S.common.notSaved).not.toBe(S.common.recordedToast('x'))
      expect(S.common.notSaved).not.toBe(S.common.addedToast('x'))
    }
  })
})

// Screens are not rendered by this suite (no jsdom, by project rule), so the one thing that can
// quietly come back — a screen that writes without the guard, and therefore fails in silence again —
// is checked where it is visible: in the source of the screens themselves.
describe('every screen that writes goes through the guard', () => {
  const WRITE_ACTIONS = [
    'recordPurchase',
    'recordCount',
    'recordAdjust',
    'recordUtang',
    'recordBayad',
    'recordExpense',
    'recordCashCount',
    'saveProduct',
    'saveCustomer',
    'addProduct',
    'addCustomer',
    'updateStore',
    'createStore',
    'voidEvent',
    'restoreEvent',
    'loadDemo',
  ]

  it('holds for all of them', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const dir = new URL('../screens/', import.meta.url)
    const offenders: string[] = []
    let checked = 0
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.tsx'))) {
      const src = readFileSync(new URL(file, dir), 'utf8')
      const writes = WRITE_ACTIONS.filter((a) => src.includes(`${a}(`))
      if (writes.length === 0) continue
      checked++
      if (!src.includes('useWrite()')) offenders.push(`${file} writes (${writes.join(', ')}) without useWrite()`)
    }
    expect(offenders).toEqual([])
    expect(checked).toBeGreaterThanOrEqual(9) // the screens that write today
  })
})
