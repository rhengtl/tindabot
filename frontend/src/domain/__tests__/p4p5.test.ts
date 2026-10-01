// P4/P5 local pieces (decided 2026-10-01): tally (SALE) properties, supplier price memory, product
// CSV parsing and the deterministic briefing. Golden numbers for the tally live in scenarios.json
// (SALE_* — computed by tools/reference_model.py).

import { describe, expect, it } from 'vitest'
import { briefing } from '../briefing'
import { toMs } from '../calendar'
import { CSV_TEMPLATE, parseCsv, productsFromCsv } from '../csv'
import { lastCostAt, normalizeSupplier, recentSuppliers, supplierPrices } from '../suppliers'
import type { CustomerState, DomainEvent, Product, PurchaseEvent, SaleEvent, StoreState } from '../types'
import { DEVICE_ID, PRODUCT_ID, STORE_ID, run, runScenario, scenarios, toEvents, makeProduct, makeStore } from './helpers'

const S1 = scenarios.find((s) => s.id === 'S1')!
const sale = (id: string, ts: string, qty: number): SaleEvent => ({ id, v: 1, store_id: STORE_ID, device_id: DEVICE_ID, recorded_at: ts, ts, type: 'SALE', product_id: PRODUCT_ID, qty_units: qty })

describe('tally (SALE, additive)', () => {
  const base = runScenario(S1)
  it('a tally never raises the stock estimate, whatever its size', () => {
    for (const q of [0, 1, 5, 20, 27, 28, 40, 63, 200]) {
      const r = runScenario(S1, { events: [...toEvents(S1.events), sale(`x${q}`, '2026-05-28T15:00:00+08:00', q)] })
      expect(r.state.on_hand_est!).toBeLessThanOrEqual(base.state.on_hand_est! + 1e-9)
      expect(r.state.daily_rate).toBe(base.state.daily_rate) // never part of the rate
      expect(r.state.samples.length).toBe(base.state.samples.length)
    }
  })
  it('a partial tally (below rate × days) changes nothing; above it, on-hand = count + bought − tallied', () => {
    const r = runScenario(S1, { events: [...toEvents(S1.events), sale('a', '2026-05-28T15:00:00+08:00', 10)] })
    expect(r.state.on_hand_est).toBeCloseTo(base.state.on_hand_est!, 9)
    expect(r.line?.buy_packs).toBe(base.line?.buy_packs)
    const big = runScenario(S1, { events: [...toEvents(S1.events), sale('b', '2026-05-28T15:00:00+08:00', 50)] })
    expect(big.state.on_hand_est).toBeCloseTo(15 + 48 - 50, 9)
    expect(big.state.sold_since_anchor).toBe(50)
  })
  it('a new count resets the tally (the count already reflects every sale before it)', () => {
    const ev = [...toEvents(S1.events), sale('c', '2026-05-28T15:00:00+08:00', 50), { ...toEvents([{ id: 'k', type: 'COUNT', ts: '2026-05-28T21:00:00+08:00', qty_on_hand: 30 }])[0]! }]
    const r = runScenario(S1, { events: ev as DomainEvent[] })
    expect(r.state.sold_since_anchor).toBe(0)
    expect(r.state.anchor?.qty).toBe(30)
  })
  it('a tally without any count stays out of the stock estimate (no anchor → no on-hand)', () => {
    const product = makeProduct(S1.product)
    const r = run(makeStore([3, 6], null), product, [sale('d', '2026-05-28T15:00:00+08:00', 5)], toMs(S1.now))
    expect(r.state.on_hand_est).toBeNull()
    expect(r.state.tier).toBe('none')
  })
})

const purchase = (id: string, ts: string, qty: number, cost: number | null, supplier?: string): PurchaseEvent => ({
  id, v: 1, store_id: STORE_ID, device_id: DEVICE_ID, recorded_at: ts, ts, type: 'PURCHASE', product_id: PRODUCT_ID, qty_units: qty, total_cost: cost, ...(supplier !== undefined ? { supplier } : {}),
})

describe('supplier price memory', () => {
  const ps = [
    purchase('1', '2026-05-01T12:00:00+08:00', 12, 780, 'Puregold'),
    purchase('2', '2026-05-05T12:00:00+08:00', 12, 816, ' tindahan  ni Mang Ben '),
    purchase('3', '2026-05-09T12:00:00+08:00', 12, 756, 'puregold'),
    purchase('4', '2026-05-12T12:00:00+08:00', 12, null, 'Alfamart'),
    purchase('5', '2026-05-13T12:00:00+08:00', 12, 800),
  ]
  it('keeps the latest priced purchase per supplier (case/space-insensitive), cheapest first', () => {
    expect(supplierPrices(ps)).toEqual([
      { supplier: 'puregold', unit_cost: 63, ts: '2026-05-09T12:00:00+08:00' },
      { supplier: 'tindahan ni Mang Ben', unit_cost: 68, ts: '2026-05-05T12:00:00+08:00' },
    ])
    expect(lastCostAt(ps, 'PUREGOLD ')).toBe(63)
    expect(lastCostAt(ps, 'Alfamart')).toBeNull() // bought there, but never with a price
    expect(lastCostAt(ps, '')).toBeNull()
  })
  it('lists suppliers most recently used first, without duplicates', () => {
    expect(recentSuppliers(ps)).toEqual(['Alfamart', 'puregold', 'tindahan ni Mang Ben'])
    expect(recentSuppliers(ps, 1)).toEqual(['Alfamart'])
    expect(normalizeSupplier('  a   b ')).toBe('a b')
  })
})

describe('product CSV', () => {
  it('reads the template', () => {
    const r = productsFromCsv(CSV_TEMPLATE)
    expect(r.header_ok).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.rows).toEqual([
      { line: 2, name: 'Coke Mismo 290ml', category: 'Softdrinks', unit_label: 'bote', pack_size: 12, pack_label: 'case', sell_price: 20, natira: 8 },
      { line: 3, name: 'Lucky Me Pancit Canton Original', category: 'Noodles', unit_label: 'pack', pack_size: 24, pack_label: 'box', sell_price: 16, natira: null },
    ])
  })
  it('handles quotes, CRLF, a BOM, semicolons, Taglish headers and defaults', () => {
    const text = '﻿Pangalan;Presyo;Laman\r\n"Kape ""3-in-1""";₱8.50;\r\n\r\nSabon;12;6\r\n'
    const r = productsFromCsv(text)
    expect(r.rows.map((x) => [x.line, x.name, x.sell_price, x.pack_size, x.pack_label, x.unit_label, x.category])).toEqual([
      [2, 'Kape "3-in-1"', 8.5, 1, 'piraso', 'piraso', 'Itlog at iba pa'],
      [4, 'Sabon', 12, 6, 'pack', 'piraso', 'Itlog at iba pa'],
    ])
  })
  it('reports bad rows by line and keeps the good ones', () => {
    const r = productsFromCsv('name,pack_size,sell_price,natira\n,1,1,1\nA,0,1,1\nB,2,abc,1\nC,2,5,-1\nD,2,5,1\nd,3,5,1\nE,1,1.005,\n')
    expect(r.rows.map((x) => x.name)).toEqual(['D'])
    expect(r.errors).toEqual([
      { line: 2, reason: 'no_name' },
      { line: 3, reason: 'bad_pack_size' },
      { line: 4, reason: 'bad_price' },
      { line: 5, reason: 'bad_natira' },
      { line: 7, reason: 'duplicate' },
      { line: 8, reason: 'bad_price' },
    ])
  })
  it('refuses a file without a name column', () => {
    expect(productsFromCsv('a,b\n1,2\n').header_ok).toBe(false)
    expect(productsFromCsv('').header_ok).toBe(false)
  })
  it('a newline inside quotes stays in the cell', () => {
    expect(parseCsv('a,b\n"x\ny",z\n')).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['x\ny', 'z'] },
    ])
  })
})

describe('briefing (deterministic, offline)', () => {
  const nowMs = toMs('2026-05-29T10:00:00+08:00')
  const coke: Product = { ...makeProduct(S1.product), name: 'Lucky Me' }
  const r = runScenario(S1)
  const finance: StoreState = {
    cash_last: { ts: '2026-05-28T20:00:00+08:00', amount: 3250.5 },
    utang_outstanding: 450,
    weeks: [],
    tantiya: { benta: 0, tubo: 0, products: 0, skipped: 0 },
  }
  const cs: CustomerState = { customer_id: 'c1', balance: 450, total_utang: 450, total_bayad: 0, last_utang_ts: '2026-05-10T12:00:00+08:00', last_bayad_ts: null, oldest_unpaid_ts: '2026-05-10T12:00:00+08:00' }
  const input = { nowMs, products: [coke], states: new Map([[coke.id, r.state]]), list: r.list, finance, customers: [{ id: 'c1', name: 'Aling Rosa' }], customerStates: new Map([['c1', cs]]) }

  it('Taglish', () => {
    expect(briefing({ ...input, lang: 'tl' })).toEqual([
      `Biyahe bukas: 1 bibilhin, dalhin ~₱${Math.round(r.list.total_known_cost / 10) * 10}.`,
      'Utang na hindi pa bayad: ₱450 (1 tao). Pinakamatagal: Aling Rosa, 19 araw.',
      'Huling bilang ng pera: ₱3,250.50 (kahapon).',
    ])
  })
  it('English mirrors it', () => {
    expect(briefing({ ...input, lang: 'en' })).toEqual([
      `Trip tomorrow: 1 to buy, bring ~₱${Math.round(r.list.total_known_cost / 10) * 10}.`,
      'Unpaid utang: ₱450 (1 person). Oldest: Aling Rosa, 19 days.',
      'Last cash count: ₱3,250.50 (yesterday).',
    ])
  })
  it('no products → one line asking to add some', () => {
    expect(briefing({ ...input, products: [], lang: 'tl' })).toEqual(['Magdagdag ng paninda para makapagsimula ang listahan.'])
  })
})
