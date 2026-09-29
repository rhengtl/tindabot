// Grouping the active log once per recompute must produce exactly what re-scanning it per product
// and per customer did (BLUEPRINT §B: still a full recompute from the full active list). These
// tests hold the grouped path against the straightforward one over randomized logs, because the
// grouping is an optimization and the only way it can go wrong is by giving a different answer.
import { describe, expect, it } from 'vitest'
import { addDays, localTimeMs, toISOWithOffset, toLocalDate, toMs } from '../calendar'
import { deriveProduct } from '../derive'
import { customerIds, deriveCustomer, deriveCustomers, deriveStoreFinance, ledgerByCustomer, pesos, utangOutstanding } from '../finance'
import { activeEvents, compareEvents, forProduct, stockEventsByProduct } from '../order'
import type { ActiveEvent, DomainEvent, Product, ProductState, Store } from '../types'

const DEV = 'DEV00000000000000000000001'
const STORE = 'S0000000000000000000000001'

/** Deterministic PRNG: the same log every run, but an arbitrary-looking one. */
function rng(seed: number): () => number {
  let x = seed
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    return x / 0x7fffffff
  }
}

function makeProduct(i: number): Product {
  return {
    id: `P${String(i).padStart(24, '0')}`,
    store_id: STORE,
    name: `Item ${i}`,
    category: 'c',
    unit_label: 'pc',
    pack_size: 6 + (i % 5),
    pack_label: 'box',
    sell_price: i % 4 === 0 ? null : 10 + i,
    archived: i % 11 === 10,
    updated_at: '2026-01-01T00:00:00+08:00',
  }
}

const STORE_ROW: Store = {
  id: STORE,
  name: 'Test',
  restock_days: [3],
  next_trip_override: null,
  multipliers: { payday: 1.3, fri_sat: 1.15 },
  updated_at: '2026-01-01T00:00:00+08:00',
}

/** A log with the awkward cases in it: shared timestamps, voids, a duplicate id, unknown ids. */
function makeLog(seed: number, nProducts = 9, nCustomers = 5, nDays = 60) {
  const r = rng(seed)
  const products = Array.from({ length: nProducts }, (_, i) => makeProduct(i))
  const customers = Array.from({ length: nCustomers }, (_, i) => `C${String(i).padStart(24, '0')}`)
  const day0 = addDays(toLocalDate(Date.now()), -nDays)
  const events: DomainEvent[] = []
  let n = 0
  const at = (d: number, h: number) => toISOWithOffset(localTimeMs(addDays(day0, d), h))
  const push = (e: Partial<DomainEvent>, d: number, h: number) => {
    const ts = at(d, h)
    events.push({ id: `E${String(n++).padStart(24, '0')}`, v: 1, store_id: STORE, device_id: DEV, ts, recorded_at: ts, ...e } as DomainEvent)
  }
  for (let d = 0; d < nDays; d++) {
    for (let k = 0; k < 3; k++) {
      const p = products[Math.floor(r() * nProducts)]!
      // the same hour on purpose: the total order must then fall back to typeRank and to id
      if (r() < 0.45) push({ type: 'PURCHASE', product_id: p.id, qty_units: 1 + Math.floor(r() * 24), total_cost: r() < 0.2 ? null : 50 + Math.floor(r() * 300) }, d, 12)
      else if (r() < 0.8) push({ type: 'COUNT', product_id: p.id, qty_on_hand: Math.floor(r() * 30) }, d, 12)
      else push({ type: 'ADJUST', product_id: p.id, delta: r() < 0.5 ? -(1 + Math.floor(r() * 3)) : 1 + Math.floor(r() * 3), reason: 'sira' }, d, 12)
    }
    for (let k = 0; k < 2; k++) {
      const c = r() < 0.1 ? 'CUNKNOWN000000000000000001' : customers[Math.floor(r() * nCustomers)]!
      if (r() < 0.6) push({ type: 'UTANG', customer_id: c, amount: pesos(10 + r() * 200) }, d, 13)
      else push({ type: 'BAYAD', customer_id: c, amount: pesos(5 + r() * 150) }, d, 13)
    }
    // midnight on purpose: a week's prefix ends exactly here, so an off-by-one boundary shows up
    if (r() < 0.35) push({ type: 'UTANG', customer_id: customers[Math.floor(r() * nCustomers)]!, amount: pesos(10 + r() * 90) }, d, 0)
    if (r() < 0.2) push({ type: 'BAYAD', customer_id: customers[Math.floor(r() * nCustomers)]!, amount: pesos(5 + r() * 60) }, d, 0)
    if (r() < 0.2) push({ type: 'EXPENSE', amount: pesos(20 + r() * 400), category: 'kuryente' }, d, 14)
    if (r() < 0.5) push({ type: 'CASH_COUNT', amount: pesos(500 + r() * 5000) }, d, 21)
    if (r() < 0.15 && events.length > 3) push({ type: 'VOID', target: events[Math.floor(r() * events.length)]!.id }, d, 15)
  }
  events.push({ ...events[3]! }) // write-once: a duplicate id must still be ignored
  return { products, events }
}

const isStock = (e: ActiveEvent) => e.type === 'PURCHASE' || e.type === 'COUNT' || e.type === 'ADJUST'
const isLedger = (e: ActiveEvent) => e.type === 'UTANG' || e.type === 'BAYAD'

describe('stockEventsByProduct', () => {
  it('gives every product exactly what forProduct would, over three randomized logs', () => {
    for (const seed of [1, 7, 4242]) {
      const { products, events } = makeLog(seed)
      const active = activeEvents(events)
      const grouped = stockEventsByProduct(active)
      for (const p of products) expect(grouped.get(p.id) ?? []).toEqual(forProduct(active, p.id))
      const inMap = [...grouped.values()].flat()
      expect(inMap).toHaveLength(active.filter(isStock).length)
      expect(inMap.every(isStock)).toBe(true)
    }
  })

  it('a product with no events is absent from the map and derives the same as from an empty list', () => {
    const { events } = makeLog(3)
    const fresh = { ...makeProduct(0), id: 'PZZZZZZZZZZZZZZZZZZZZZZZZ' }
    const active = activeEvents(events)
    const grouped = stockEventsByProduct(active)
    const nowMs = Date.now()
    expect(grouped.has(fresh.id)).toBe(false)
    expect(deriveProduct(fresh, grouped.get(fresh.id) ?? [], nowMs)).toEqual(deriveProduct(fresh, forProduct(active, fresh.id), nowMs))
  })

  it('the whole product loop derives identically either way', () => {
    const { products, events } = makeLog(99, 12)
    const active = activeEvents(events)
    const grouped = stockEventsByProduct(active)
    const nowMs = Date.now()
    const naive = new Map<string, ProductState>()
    const fast = new Map<string, ProductState>()
    for (const p of products) naive.set(p.id, deriveProduct(p, forProduct(active, p.id), nowMs))
    for (const p of products) fast.set(p.id, deriveProduct(p, grouped.get(p.id) ?? [], nowMs))
    expect(fast).toEqual(naive)
  })
})

describe('activeEvents keeps the total order it always had', () => {
  it('matches a plain compareEvents sort — ties, voids and duplicate ids included', () => {
    for (const seed of [2, 11, 555]) {
      const { events } = makeLog(seed)
      const voided = new Set<string>()
      const seen = new Set<string>()
      const nonVoid: ActiveEvent[] = []
      for (const e of events) {
        if (seen.has(e.id)) continue
        seen.add(e.id)
        if (e.type === 'VOID') voided.add(e.target)
        else nonVoid.push(e)
      }
      const expected = nonVoid.filter((e) => !voided.has(e.id)).sort(compareEvents)
      expect(activeEvents(events).map((e) => e.id)).toEqual(expected.map((e) => e.id))
    }
  })
})

describe('customer ledgers', () => {
  it('deriveCustomers equals deriveCustomer per id, with the same ids in the same order', () => {
    for (const seed of [5, 23]) {
      const active = activeEvents(makeLog(seed).events)
      const fast = deriveCustomers(active)
      const ids = customerIds(active)
      expect([...fast.keys()]).toEqual(ids)
      for (const id of ids) expect(fast.get(id)).toEqual(deriveCustomer(id, active))
    }
  })

  it('a customer with no ledger is absent from the map and still derives a zero state on its own', () => {
    const active = activeEvents(makeLog(6).events)
    expect(deriveCustomers(active).has('CNOBODY0000000000000000001')).toBe(false)
    expect(deriveCustomer('CNOBODY0000000000000000001', active)).toEqual({
      customer_id: 'CNOBODY0000000000000000001',
      balance: 0,
      total_utang: 0,
      total_bayad: 0,
      last_utang_ts: null,
      last_bayad_ts: null,
      oldest_unpaid_ts: null,
    })
  })

  it('ledgerByCustomer holds every utang and bayad exactly once, in total order', () => {
    const active = activeEvents(makeLog(8).events)
    const ledgers = ledgerByCustomer(active)
    expect([...ledgers.values()].flat()).toHaveLength(active.filter(isLedger).length)
    for (const own of ledgers.values()) expect(own.map((e) => e.id)).toEqual(own.slice().sort(compareEvents).map((e) => e.id))
  })

  it('utangOutstanding equals the per-customer sum it replaced', () => {
    for (const seed of [4, 77]) {
      const active = activeEvents(makeLog(seed).events)
      let naive = 0
      for (const id of customerIds(active)) naive = pesos(naive + Math.max(0, deriveCustomer(id, active).balance))
      expect(utangOutstanding(active)).toBe(naive)
    }
  })
})

describe('weekly summaries', () => {
  it("each week's outstanding_end still equals the outstanding over that week's own prefix", () => {
    const { products, events } = makeLog(31, 10)
    const active = activeEvents(events)
    const nowMs = Date.now()
    const grouped = stockEventsByProduct(active)
    const states = new Map<string, ProductState>()
    for (const p of products) states.set(p.id, deriveProduct(p, grouped.get(p.id) ?? [], nowMs))
    const finance = deriveStoreFinance({ events: active, products, states, nowMs })
    expect(finance.weeks).toHaveLength(4)
    let seenNonZero = false
    for (const w of finance.weeks) {
      const endMs = localTimeMs(addDays(w.end, 1), 0)
      const prefix = active.filter((e) => toMs(e.ts) < endMs)
      let naive = 0
      for (const id of customerIds(prefix)) naive = pesos(naive + Math.max(0, deriveCustomer(id, prefix).balance))
      expect(w.outstanding_end).toBe(naive)
      if (naive > 0) seenNonZero = true
    }
    expect(seenNonZero).toBe(true) // the fixture must actually exercise outstanding utang
    expect(finance.utang_outstanding).toBe(utangOutstanding(active))
    expect(STORE_ROW.id).toBe(STORE)
  })
})

describe('grouping once is what makes a store-sized recompute affordable', () => {
  // Not a benchmark — the reason these helpers exist, kept honest. Re-scanning the log for each
  // product and each customer costs products x events, which a store only feels after months of
  // use; grouping walks it once. The two paths are timed against each other in the same process,
  // never against the clock, so a slow machine cannot fail this.
  function grouped(products: Product[], active: ActiveEvent[], nowMs: number): void {
    const byProduct = stockEventsByProduct(active)
    const states = new Map<string, ProductState>()
    for (const p of products) states.set(p.id, deriveProduct(p, byProduct.get(p.id) ?? [], nowMs))
    deriveCustomers(active)
    deriveStoreFinance({ events: active, products, states, nowMs })
  }

  function rescanned(products: Product[], active: ActiveEvent[], nowMs: number): void {
    const states = new Map<string, ProductState>()
    for (const p of products) states.set(p.id, deriveProduct(p, forProduct(active, p.id), nowMs))
    for (const id of customerIds(active)) deriveCustomer(id, active)
    // the store total plus each of the four weeks used to walk the whole log per customer
    for (let pass = 0; pass < 5; pass++) {
      let total = 0
      for (const id of customerIds(active)) total = pesos(total + Math.max(0, deriveCustomer(id, active).balance))
      expect(total).toBeGreaterThanOrEqual(0)
    }
    deriveStoreFinance({ events: active, products, states, nowMs })
  }

  function medianMs(fn: () => void): number {
    fn() // warm up, so compilation is not what gets measured
    const runs = [0, 0, 0].map(() => {
      const t0 = performance.now()
      fn()
      return performance.now() - t0
    })
    return runs.sort((a, b) => a - b)[1]!
  }

  it('costs a fraction of re-scanning the log per product and per customer', () => {
    const { products, events } = makeLog(17, 120, 30, 365)
    expect(events.length).toBeGreaterThan(2000)
    const active = activeEvents(events)
    const nowMs = Date.now()
    const fast = medianMs(() => grouped(products, active, nowMs))
    const slow = medianMs(() => rescanned(products, active, nowMs))
    expect(slow / fast).toBeGreaterThan(2)
  })
})
