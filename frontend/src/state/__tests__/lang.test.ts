// Language preference in the app store: Taglish by default, switchable at runtime, persisted in
// Dexie meta (device-local, never in store data or exports), safe against bad stored values, and
// changing it re-words derived output without touching any business data.
import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/db'
import * as repo from '../../db/repo'
import { buildExport } from '../../domain'
import { META_LANG, parseLang, useApp } from '../store'

async function fresh() {
  await db.delete()
  await db.open()
  useApp.setState({ lang: 'tl', loaded: false, store: null })
}

async function seed() {
  const s = await repo.createStore('Tindahan ni Test', [3])
  const p = { id: 'P0000000000000000000000001', store_id: s.id, name: 'Coke', category: 'c', unit_label: 'bote', pack_size: 12, pack_label: 'case', sell_price: 75, archived: false, updated_at: '2026-09-10T00:00:00.000Z' }
  await repo.saveProduct(p)
  const base = { v: 1 as const, store_id: s.id, device_id: 'DEV0LANG000000000000000001', recorded_at: '2026-09-10T00:00:00.000Z' }
  await repo.addEvents([
    { ...base, id: 'E0000000000000000000000001', type: 'PURCHASE', product_id: p.id, qty_units: 24, total_cost: 1560, ts: '2026-09-01T10:00:00+08:00' },
    { ...base, id: 'E0000000000000000000000002', type: 'COUNT', product_id: p.id, qty_on_hand: 24, ts: '2026-09-01T10:00:00+08:00' },
    { ...base, id: 'E0000000000000000000000003', type: 'COUNT', product_id: p.id, qty_on_hand: 4, ts: '2026-09-15T21:00:00+08:00' },
  ])
  return s
}

describe('language state', () => {
  beforeEach(fresh)

  it('parseLang: known values pass, anything else falls back to Taglish', () => {
    expect(parseLang('tl')).toBe('tl')
    expect(parseLang('en')).toBe('en')
    for (const bad of [null, undefined, '', 'fr', 'EN', 'english', '1', '{}']) expect(parseLang(bad)).toBe('tl')
  })

  it('defaults to Taglish on a fresh install (no meta row)', async () => {
    await useApp.getState().init()
    expect(useApp.getState().lang).toBe('tl')
    expect(await repo.getMeta(META_LANG)).toBeNull() // nothing written until the person chooses
  })

  it('switching to English and back takes effect immediately and notifies subscribers', async () => {
    await seed()
    await useApp.getState().init()
    const seen: string[] = []
    const unsub = useApp.subscribe((s) => seen.push(s.lang))
    await useApp.getState().setLang('en')
    expect(useApp.getState().lang).toBe('en')
    expect(await repo.getMeta(META_LANG)).toBe('en')
    await useApp.getState().setLang('tl')
    expect(useApp.getState().lang).toBe('tl')
    expect(await repo.getMeta(META_LANG)).toBe('tl')
    unsub()
    expect(seen).toEqual(['en', 'tl'])
  })

  it('persists across re-initialisation (app restart), and a corrupt stored value falls back', async () => {
    await seed()
    await useApp.getState().init()
    await useApp.getState().setLang('en')
    useApp.setState({ lang: 'tl', loaded: false }) // simulate a cold start with the module state gone
    await useApp.getState().init()
    expect(useApp.getState().lang).toBe('en')

    await repo.setMeta(META_LANG, 'klingon')
    useApp.setState({ lang: 'en', loaded: false })
    await useApp.getState().init()
    expect(useApp.getState().lang).toBe('tl')
  })

  it('setLang re-words derived output only; store, products, events and the export are unchanged', async () => {
    const s = await seed()
    await useApp.getState().init()
    const before = useApp.getState()
    const exportBefore = JSON.stringify(buildExport({ store: before.store!, products: before.products, customers: before.customers, events: before.events }, 'd', 't'))
    const lineTl = before.list!.lines.find((l) => l.product_id === 'P0000000000000000000000001')!
    await useApp.getState().setLang('en')
    const after = useApp.getState()
    const lineEn = after.list!.lines.find((l) => l.product_id === 'P0000000000000000000000001')!
    expect(lineEn.reason).not.toBe(lineTl.reason)
    expect(lineTl.reason).toMatch(/[Bb]ilangin|[Kk]ailangan|[Mm]auubos|[Pp]wede|[Ss]apat/)
    expect(lineEn.reason).toMatch(/[Cc]ount|[Nn]eeded|run out|[Cc]an be|[Ee]nough/)
    const { reason: _r1, hint: _h1, ...restTl } = lineTl
    const { reason: _r2, hint: _h2, ...restEn } = lineEn
    expect(restEn).toEqual(restTl) // quantities, urgency, section, cost… identical
    expect(after.store).toEqual(before.store)
    expect(after.products).toEqual(before.products)
    expect(after.events).toEqual(before.events)
    expect(JSON.stringify(buildExport({ store: after.store!, products: after.products, customers: after.customers, events: after.events }, 'd', 't'))).toBe(exportBefore)
    expect(exportBefore).not.toContain('"lang"') // the preference is not business data
    // and nothing in Dexie changed except the meta row
    expect((await repo.loadSnapshot(s.id))!.events.length).toBe(3)
    expect(await repo.getMeta(META_LANG)).toBe('en')
  })

  it('ignores unknown languages and no-ops on the current one', async () => {
    await useApp.getState().init()
    await useApp.getState().setLang('xx' as never)
    expect(useApp.getState().lang).toBe('tl')
    expect(await repo.getMeta(META_LANG)).toBeNull()
  })
})
