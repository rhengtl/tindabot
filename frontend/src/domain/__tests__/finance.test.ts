// P2 finance — BLUEPRINT §E6. Goldens come from tools/finance_reference.py (independent Python).
import { describe, expect, it } from 'vitest'
import { toMs } from '../calendar'
import { deriveProduct } from '../derive'
import { buildExport, mergeImport } from '../export'
import { applyBudget, budgetPrefill, deriveCustomer, deriveStoreFinance, pesos, roundTo10, utangOutstanding, weekStart } from '../finance'
import { buildList } from '../list'
import { activeEvents, forProduct } from '../order'
import type { Customer, DomainEvent, ListLine, Product, ProductState, ShoppingList, VoidEvent } from '../types'
import financeJson from './finance_scenarios.json'
import { DEVICE_ID, PRODUCT_ID, STORE_ID, makeProduct, makeStore, scenarios as p1Scenarios, toEvents } from './helpers'

const byId = (id: string) => p1Scenarios.find((s) => s.id === id)!

interface FinanceScenario {
  id: string
  note: string
  now: string
  events: Array<Record<string, unknown> & { id: string; type: string; ts: string }>
  rates: Array<{ tier: string; rate: number | null; sell_price: number | null; tubo: number | null }>
  budget?: number
  lines?: Array<Pick<ListLine, 'product_id' | 'section' | 'priority' | 'buy_packs' | 'cost'>>
  total_known_cost?: number
  expect: {
    customers: Record<string, any>
    store: any
    budget?: any
  }
}
const scenarios = (financeJson as { scenarios: FinanceScenario[] }).scenarios
const sc = (id: string) => scenarios.find((s) => s.id === id)!

function fin(raw: FinanceScenario['events']): DomainEvent[] {
  return raw.map((e) => ({ ...(e as object), v: 1, store_id: STORE_ID, device_id: DEVICE_ID, recorded_at: e.ts })) as DomainEvent[]
}

/** Product states standing in for the scenario's `rates` (only the fields tantiya reads). */
function fakeStates(rates: FinanceScenario['rates']): { products: Product[]; states: Map<string, ProductState> } {
  const products: Product[] = []
  const states = new Map<string, ProductState>()
  rates.forEach((r, i) => {
    const id = `P${i}`
    products.push({ ...makeProduct({ pack_size: 1, sell_price: r.sell_price, unit_label: 'u', pack_label: 'p' }, id) })
    states.set(id, { tier: r.tier as ProductState['tier'], daily_rate: r.rate, tubo_per_unit: r.tubo } as ProductState)
  })
  return { products, states }
}

function shuffled<T>(a: T[], seed: number): T[] {
  const out = a.slice()
  let s = seed
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

describe('finance goldens (Python reference)', () => {
  for (const s of scenarios) {
    it(`${s.id}: ${s.note}`, () => {
      const active = activeEvents(fin(s.events))
      for (const [cid, exp] of Object.entries(s.expect.customers)) {
        expect(deriveCustomer(cid, active)).toEqual(exp)
      }
      const { products, states } = fakeStates(s.rates)
      const st = deriveStoreFinance({ events: active, products, states, nowMs: toMs(s.now) })
      const { budget_prefill, ...expStore } = s.expect.store
      expect({ ...st, tantiya: { ...st.tantiya, benta: pesos(st.tantiya.benta), tubo: pesos(st.tantiya.tubo) } }).toEqual({
        ...expStore,
        tantiya: { ...expStore.tantiya, benta: pesos(expStore.tantiya.benta), tubo: pesos(expStore.tantiya.tubo) },
      })
      expect(budgetPrefill(st.cash_last, toMs(s.now))).toBe(budget_prefill)
      if (s.budget !== undefined) {
        const list = { lines: s.lines as ListLine[], total_known_cost: s.total_known_cost! } as ShoppingList
        expect(applyBudget(list, s.budget)).toEqual(s.expect.budget)
      }
    })
  }
})

describe('finance invariants', () => {
  it('every scenario derives identically from shuffled input (order invariance)', () => {
    for (const s of scenarios) {
      const base = fin(s.events)
      const ref = activeEvents(base)
      const refCustomers = Object.keys(s.expect.customers).map((c) => deriveCustomer(c, ref))
      for (const seed of [1, 7, 42]) {
        const act = activeEvents(shuffled(base, seed))
        expect(act.map((e) => e.id)).toEqual(ref.map((e) => e.id))
        expect(Object.keys(s.expect.customers).map((c) => deriveCustomer(c, act))).toEqual(refCustomers)
        expect(utangOutstanding(act)).toBe(utangOutstanding(ref))
      }
    }
  })

  it('VOID of a BAYAD restores the debt; VOID is inert until its target exists; a copy with a new id restores', () => {
    const s = sc('F1_fifo')
    const events = fin(s.events)
    const bayad = events.find((e) => e.type === 'BAYAD')!
    const v: VoidEvent = { id: 'V0001', v: 1, store_id: STORE_ID, device_id: DEVICE_ID, type: 'VOID', target: bayad.id, ts: '2026-09-12T12:00:00+08:00', recorded_at: '2026-09-12T12:00:00+08:00' }
    const c1 = deriveCustomer('CUST0000000000000000000001', activeEvents([...events, v]))
    expect(c1.balance).toBe(150)
    expect(c1.oldest_unpaid_ts).toBe('2026-09-01T12:00:00+08:00')
    expect(c1.last_bayad_ts).toBeNull()
    // VOID before target: inert
    const without = events.filter((e) => e.id !== bayad.id)
    expect(deriveCustomer('CUST0000000000000000000001', activeEvents([v, ...without])).balance).toBe(150)
    // Ibalik = new copy with a new id → back to the golden
    const copy = { ...bayad, id: 'COPY01' }
    expect(deriveCustomer('CUST0000000000000000000001', activeEvents([...events, v, copy])).balance).toBe(s.expect.customers['CUST0000000000000000000001'].balance)
  })

  it('a VOID targeting a VOID changes nothing', () => {
    const s = sc('F4_void')
    const events = fin(s.events)
    const vv: VoidEvent = { id: 'V0002', v: 1, store_id: STORE_ID, device_id: DEVICE_ID, type: 'VOID', target: events.find((e) => e.type === 'VOID')!.id, ts: '2026-09-13T12:00:00+08:00', recorded_at: '2026-09-13T12:00:00+08:00' }
    expect(deriveCustomer('CUST0000000000000000000001', activeEvents([...events, vv]))).toEqual(s.expect.customers['CUST0000000000000000000001'])
  })

  it('replay: deriving after each event in total order ends at the full-list result', () => {
    const s = sc('F6_outstanding')
    const all = activeEvents(fin(s.events))
    let last = 0
    for (let n = 1; n <= all.length; n++) last = utangOutstanding(all.slice(0, n))
    expect(last).toBe(s.expect.store.utang_outstanding)
  })

  it('finance events never touch product derivation', () => {
    const p = byId('S3_after')
    const product = makeProduct(p.product)
    const stock = toEvents(p.events)
    const money = fin(sc('F7_weeks').events).filter((e) => e.type !== 'PURCHASE')
    const a = deriveProduct(product, forProduct(activeEvents(stock), PRODUCT_ID), toMs(p.now))
    const b = deriveProduct(product, forProduct(activeEvents([...money, ...stock]), PRODUCT_ID), toMs(p.now))
    expect(b).toEqual(a)
  })

  it('weekStart is the Monday of the week', () => {
    expect(weekStart('2026-09-14')).toBe('2026-09-14') // Monday
    expect(weekStart('2026-09-20')).toBe('2026-09-14') // Sunday
    expect(weekStart('2026-09-13')).toBe('2026-09-07') // Sunday of the previous week
  })

  it('pesos() keeps two decimals exact; roundTo10 rounds half up', () => {
    expect(pesos(0.1 + 0.2)).toBe(0.3)
    expect(pesos(10.1 + 20.2 - 30.3)).toBe(0)
    expect(roundTo10(1631)).toBe(1630)
    expect(roundTo10(1635)).toBe(1640)
    expect(roundTo10(222.25)).toBe(220)
  })

  it('tantiya excludes Tier A (cadence) products and counts skipped ones', () => {
    const { products, states } = fakeStates([
      { tier: 'cadence', rate: 5, sell_price: 100, tubo: 50 }, // even with a rate field, tier A is excluded
      { tier: 'counts', rate: 2, sell_price: 10, tubo: null },
      { tier: 'counts', rate: 0, sell_price: 10, tubo: 1 },
    ])
    const st = deriveStoreFinance({ events: [], products, states, nowMs: toMs('2026-09-14T15:00:00+08:00') })
    expect(st.tantiya).toEqual({ benta: 0, tubo: 0, products: 0, skipped: 1 })
    expect(st.cash_last).toBeNull()
    expect(st.utang_outstanding).toBe(0)
    expect(st.weeks).toHaveLength(4)
  })

  it('budget on a real shopping list: prefers bilhin_na by priority, keeps ≥ 1 pack, kulang = total − budget', () => {
    const s = byId('S1')
    const store = makeStore(s.store.restock_days, s.store.next_trip_override)
    const product = makeProduct(s.product)
    const state = deriveProduct(product, forProduct(activeEvents(toEvents(s.events)), PRODUCT_ID), toMs(s.now))
    const list = buildList({ store, products: [product], states: new Map([[PRODUCT_ID, state]]), nowMs: toMs(s.now), lang: 'tl' })
    expect(list.lines).toHaveLength(1)
    const line = list.lines[0]!
    expect(line.cost).not.toBeNull()
    const full = applyBudget(list, line.cost! + 1)
    expect(full.lines[0]).toEqual({ product_id: PRODUCT_ID, packs: line.buy_packs, reduced: false, spend: pesos(line.cost!) })
    expect(full.kulang).toBe(0)
    const tight = applyBudget(list, 1)
    expect(tight.lines[0]!.packs).toBe(1)
    expect(tight.kulang).toBe(pesos(line.cost! - 1))
    const none = applyBudget(list, 0)
    expect(none.lines[0]!.packs).toBe(1) // never below one pack
  })
})

describe('export / import with customers', () => {
  it('round-trips customers + finance events; second import is a no-op; older customer record does not overwrite', () => {
    const store = makeStore([3, 6], null)
    const customers: Customer[] = [
      { id: 'CUST0000000000000000000001', store_id: STORE_ID, name: 'Aling Nena', phone: null, archived: false, updated_at: '2026-09-10T00:00:00+08:00' },
      { id: 'CUST0000000000000000000002', store_id: STORE_ID, name: 'Mang Ben', phone: '0917', archived: true, updated_at: '2026-09-11T00:00:00+08:00' },
    ]
    const events = fin(sc('F6_outstanding').events)
    const file = JSON.parse(JSON.stringify(buildExport({ store, products: [], customers, events }, DEVICE_ID, '2026-09-14T10:00:00+08:00')))
    const empty = { store: { ...store, updated_at: '2025-01-01T00:00:00+08:00' }, products: [], customers: [], events: [] }
    const m1 = mergeImport(empty, file)
    expect(m1.added_events).toBe(events.length)
    expect(m1.updated_customers).toBe(2)
    expect(m1.snapshot.customers).toEqual(customers)
    expect(utangOutstanding(activeEvents(m1.snapshot.events))).toBe(230)
    const m2 = mergeImport(m1.snapshot, file)
    expect(m2.added_events).toBe(0)
    expect(m2.updated_customers).toBe(0)
    // an older copy of a customer never wins
    const stale = { ...file, customers: [{ ...customers[0], name: 'OLD', updated_at: '2026-01-01T00:00:00+08:00' }] }
    const m3 = mergeImport(m1.snapshot, stale)
    expect(m3.updated_customers).toBe(0)
    expect(m3.snapshot.customers.find((c) => c.id === customers[0]!.id)!.name).toBe('Aling Nena')
  })

  it('a P1 export file (customers: []) still imports', () => {
    const store = makeStore([], null)
    const file = JSON.parse(JSON.stringify(buildExport({ store, products: [], customers: [], events: [] }, DEVICE_ID, '2026-09-14T10:00:00+08:00')))
    delete file.customers
    const m = mergeImport({ store, products: [], customers: [], events: [] }, file)
    expect(m.updated_customers).toBe(0)
    expect(m.snapshot.customers).toEqual([])
  })
})
