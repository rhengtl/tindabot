// Property / invariant tests — BLUEPRINT §C, §E. These verify the implementation's behaviour
// under transformations (shuffle, void, backdate, leftover shift, outliers), not just numbers.

import { describe, expect, it } from 'vitest'
import { deriveCadence } from '../cadence'
import { addDays, demand, followingTrip, isPayday, multiplier, nextTrip, toLocalDate, toMs, weekday } from '../calendar'
import { buildExport, mergeImport } from '../export'
import { activeEvents, compareEvents } from '../order'
import { packsFor } from '../rounding'
import { median } from '../samples'
import type { DomainEvent, PurchaseEvent, VoidEvent } from '../types'
import { DEVICE_ID, PRODUCT_ID, STORE_ID, goldens, makeProduct, makeStore, run, runScenario, scenarios, shuffled, toEvents } from './helpers'

const byId = (id: string) => scenarios.find((s) => s.id === id)!
const M = { payday: 1.3, fri_sat: 1.15 }

function ev<T extends DomainEvent['type']>(type: T, ts: string, id: string, extra: object): DomainEvent {
  return { id, v: 1, store_id: STORE_ID, device_id: DEVICE_ID, ts, recorded_at: ts, type, product_id: PRODUCT_ID, ...extra } as DomainEvent
}

// ---------------------------------------------------------------------------------------------
describe('total order and active set', () => {
  it('orders by ts, then COUNT before others, then id', () => {
    const c = ev('COUNT', '2026-05-13T10:00:00+08:00', 'ZZZ', { qty_on_hand: 1 })
    const p = ev('PURCHASE', '2026-05-13T10:00:00+08:00', 'AAA', { qty_units: 1, total_cost: null })
    const later = ev('PURCHASE', '2026-05-13T10:00:01+08:00', '000', { qty_units: 1, total_cost: null })
    expect(compareEvents(c, p)).toBeLessThan(0) // COUNT first despite larger id
    expect(compareEvents(p, later)).toBeLessThan(0)
    const a = ev('PURCHASE', '2026-05-13T10:00:00+08:00', 'A', { qty_units: 1, total_cost: null })
    const b = ev('PURCHASE', '2026-05-13T10:00:00+08:00', 'B', { qty_units: 1, total_cost: null })
    expect(compareEvents(a, b)).toBeLessThan(0)
  })

  it('a linked COUNT at the same ts as its PURCHASE is not double-counted', () => {
    const s = byId('S1')
    const { state } = runScenario(s)
    // anchor is the May 27 count (15); net since anchor is exactly the linked purchase (48)
    expect(state.anchor?.qty).toBe(15)
    expect(state.net_since_anchor).toBe(48)
    // and the sample ending at that count did NOT include the 48
    const last = state.samples[state.samples.length - 1]!
    expect(last.rate).toBeCloseTo((30 + 48 - 15) / 4, 6)
  })

  it('duplicate ids are ignored (write-once); insertion order is irrelevant', () => {
    const s = byId('S1')
    const events = toEvents(s.events)
    const dup = [...events, ...events, ...shuffled(events, 7)]
    const a = activeEvents(events).map((e) => e.id)
    const b = activeEvents(dup).map((e) => e.id)
    expect(b).toEqual(a)
  })

  it('VOID removes its target; VOID arriving before target is inert until it arrives', () => {
    const s = byId('S3_after')
    const events = toEvents(s.events)
    const purchase = events.find((e) => e.type === 'PURCHASE')!
    const v: VoidEvent = { ...ev('VOID', '2026-05-29T09:00:00+08:00', 'V1', {}), target: purchase.id } as VoidEvent
    delete (v as any).product_id
    // void first, target later
    const active = activeEvents([v, ...events])
    expect(active.find((e) => e.id === purchase.id)).toBeUndefined()
    // derived state equals S3_before (the purchase is gone again)
    const before = runScenario(byId('S3_before'))
    const voided = runScenario(s, { events: [v, ...events] })
    expect(voided.state.flags.has('inconsistent')).toBe(true)
    expect(voided.state.daily_rate).toBe(before.state.daily_rate)
    // re-entry with a new id restores the sample
    const reentry: PurchaseEvent = { ...(purchase as PurchaseEvent), id: 'P-NEW' }
    const restored = runScenario(s, { events: [v, ...events, reentry] })
    expect(restored.state.daily_rate).toBeCloseTo(7.5, 6)
  })
})

// ---------------------------------------------------------------------------------------------
describe('shuffle invariance', () => {
  for (const s of scenarios) {
    it(`${s.id} derives identically from shuffled input`, () => {
      const base = runScenario(s)
      for (const seed of [1, 42, 999]) {
        const r = runScenario(s, { events: shuffled(toEvents(s.events), seed) })
        expect(r.state.daily_rate).toBe(base.state.daily_rate)
        expect(r.state.on_hand_est).toBe(base.state.on_hand_est)
        expect([...r.state.flags].sort()).toEqual([...base.state.flags].sort())
        expect(r.state.cadence?.throughput ?? null).toBe(base.state.cadence?.throughput ?? null)
        expect(r.line?.buy_packs ?? null).toBe(base.line?.buy_packs ?? null)
        expect(r.line?.section ?? null).toBe(base.line?.section ?? null)
      }
    })
  }
})

// ---------------------------------------------------------------------------------------------
describe('backdating', () => {
  it('S3: a purchase backdated into the interval repairs the sample (7.5/day)', () => {
    expect(runScenario(byId('S3_before')).state.flags.has('inconsistent')).toBe(true)
    expect(runScenario(byId('S3_after')).state.daily_rate).toBeCloseTo(7.5, 6)
  })

  it('the same purchase dated AFTER the second count lands in since-anchor instead', () => {
    const s = byId('S3_after')
    const events = toEvents(s.events).map((e) =>
      e.type === 'PURCHASE' ? { ...e, ts: '2026-05-21T12:00:00+08:00' } : e,
    )
    const r = runScenario(s, { events })
    expect(r.state.flags.has('inconsistent')).toBe(true) // interval still has no purchase
    expect(r.state.net_since_anchor).toBe(48)
  })

  it('two counts < 1 day apart: the later replaces the anchor, no sample', () => {
    const events = [
      ev('COUNT', '2026-05-10T21:00:00+08:00', 'C1', { qty_on_hand: 20 }),
      ev('COUNT', '2026-05-11T07:00:00+08:00', 'C2', { qty_on_hand: 18 }),
    ]
    const r = run(makeStore([3, 6], null), makeProduct(byId('S1').product), events, toMs('2026-05-12T10:00:00+08:00'))
    expect(r.state.samples.length).toBe(0)
    expect(r.state.anchor?.qty).toBe(18)
  })
})

// ---------------------------------------------------------------------------------------------
describe('Tier A invariants', () => {
  const nowMs = toMs('2026-05-29T10:00:00+08:00')
  const today = toLocalDate(nowMs)

  it('cycle rates are invariant to the leftover kept at each purchase (the same purchases → same throughput)', () => {
    // Two owners with identical purchase histories but different habitual leftovers produce
    // identical cycle rates by construction: the model only sees purchases.
    const p = byId('A1')
    const base = deriveCadence(toEvents(p.events) as PurchaseEvent[], nowMs, today)
    expect(base.cadence?.throughput).toBeCloseTo(3.0, 9)
    // Shifting every purchase by +1 day (same gaps) leaves the cycle rates unchanged
    const shifted = (toEvents(p.events) as PurchaseEvent[]).map((e) => ({ ...e, ts: '2026-05-' + String(Number(e.ts.slice(8, 10)) + 1).padStart(2, '0') + e.ts.slice(10) }))
    const r2 = deriveCadence(shifted, nowMs, today)
    expect(r2.cadence?.cycles).toEqual(base.cadence?.cycles)
  })

  it('units guard: 1,1,1,5,1 boxes of 24 → throughput 6.0 units/day = 0.25 box/day', () => {
    const s = byId('units_guard')
    const { state } = runScenario(s)
    expect(state.cadence?.throughput).toBeCloseTo(6.0, 9)
    expect(state.cadence!.throughput / s.product.pack_size).toBeCloseTo(0.25, 9)
    expect(state.cadence?.cycles).toEqual([6, 6, 6, 6])
  })

  it('Tier A lines are never red, always in bilhin, and never exceed the cap', () => {
    for (const s of scenarios.filter((x) => x.kind === 'tierA')) {
      const { state, line } = runScenario(s)
      if (!line) continue
      expect(line.tier).toBe('cadence')
      expect(line.urgency).toBe('orange')
      expect(line.section).toBe('bilhin')
      const capMult = state.cadence!.n >= 6 ? 2 : 1
      const capPacks = Math.ceil((state.cadence!.typical_units * capMult) / s.product.pack_size)
      expect(line.buy_packs).toBeLessThanOrEqual(Math.max(capPacks, Math.ceil(state.cadence!.typical_units / s.product.pack_size)))
      expect(line.buy_packs).toBeGreaterThanOrEqual(1)
      // never claims stock
      expect(state.on_hand_est).toBeNull()
      expect(state.days_left).toBeNull()
      expect(line.reason).not.toMatch(/nabebenta|natira ay|mauubos/i)
      expect(line.reason).toMatch(/hindi ko alam ang natira/)
    }
  })

  it('listed ⇔ rebuy.mid < following and not dormant', () => {
    for (const s of scenarios.filter((x) => x.kind === 'tierA')) {
      const { state, list, line } = runScenario(s)
      const c = state.cadence
      if (!c || state.tier !== 'cadence') {
        expect(line).toBeUndefined()
        continue
      }
      const expected = c.rebuy.mid < list.following && !c.dormant
      expect(line !== undefined).toBe(expected)
    }
  })

  it('n = 3 with cycle ratio ≥ 3 is unclear; < 3 is eligible', () => {
    expect(runScenario(byId('adv_k')).state.cadence_status).toBe('unclear')
    expect(runScenario(byId('adv_l')).state.cadence_status).toBe('unclear')
    expect(runScenario(byId('adv_j')).state.cadence_status).toBe('ok')
  })

  it('same-day purchases are merged into one', () => {
    const { state } = runScenario(byId('adv_i'))
    expect(state.cadence?.n).toBe(5)
    expect(state.cadence?.cycles.length).toBe(4)
  })
})

// ---------------------------------------------------------------------------------------------
describe('median and outliers', () => {
  it('median of odd/even lists', () => {
    expect(median([3])).toBe(3)
    expect(median([2, 3, 4])).toBe(3)
    expect(median([2, 3, 4, 5])).toBe(3.5)
    expect(median([5, 2, 3, 4])).toBe(3.5)
  })

  it('a single 10× outlier at any position moves the median at most one order statistic and never above max(base)', () => {
    const bases = [[2, 3, 4], [2, 3, 4, 5], [3, 3, 3], [3, 3, 3, 3], [2, 3, 4, 5, 6]]
    for (const base of bases) {
      const sorted = base.slice().sort((a, b) => a - b)
      for (let pos = 0; pos <= base.length; pos++) {
        const withOutlier = [...base.slice(0, pos), 10 * Math.max(...base), ...base.slice(pos)]
        const m = median(withOutlier)
        expect(m).toBeLessThanOrEqual(Math.max(...base))
        expect(m).toBeGreaterThanOrEqual(median(base))
        // at most one order statistic: m ≤ the next value above the base median
        const above = sorted.filter((x) => x > median(base))
        const bound = above.length ? above[0]! : Math.max(...base)
        expect(m).toBeLessThanOrEqual(Math.max(bound, median(base)))
      }
    }
  })

  it('Tier B: 3× median cap applies with ≥ 3 samples', () => {
    const events = [
      ev('COUNT', '2026-05-01T21:00:00+08:00', 'C1', { qty_on_hand: 100 }),
      ev('COUNT', '2026-05-05T21:00:00+08:00', 'C2', { qty_on_hand: 88 }), // 3/day
      ev('COUNT', '2026-05-09T21:00:00+08:00', 'C3', { qty_on_hand: 76 }), // 3/day
      ev('COUNT', '2026-05-13T21:00:00+08:00', 'C4', { qty_on_hand: 0 }), // 19/day → capped at 9
    ]
    const r = run(makeStore([], null), makeProduct(byId('S4_stale').product), events, toMs('2026-05-14T10:00:00+08:00'))
    const capped = r.state.samples.map((s) => s.cappedRate)
    expect(capped).toEqual([3, 3, 9])
  })
})

// ---------------------------------------------------------------------------------------------
describe('rounding τ = half a day of demand', () => {
  it('pack 12, rate 3 boundaries', () => {
    const cases: Array<[number, number]> = [
      [10.4, 1], [12, 1], [12.1, 1], [13.5, 1], [13.51, 2],
      [24, 2], [25.5, 2], [25.51, 3], [36, 3], [37.5, 3], [37.51, 4],
    ]
    for (const [u, p] of cases) expect(packsFor(u, 3, 12, 1)).toBe(p)
  })
  it('floor guarantees ≥ 1 for red/orange/Tier A', () => {
    expect(packsFor(0.2, 0.2, 12, 1)).toBe(1)
    expect(packsFor(0, 3, 12, 1)).toBe(1)
    expect(packsFor(0, 3, 12, 0)).toBe(0)
  })
  it('Tier B never under-covers need: packs·pack ≥ need − max(0, at_trip)', () => {
    for (const s of scenarios.filter((x) => x.kind === 'tierB')) {
      const g = goldens[s.id]!
      if (!g.listed || g.deferred) continue
      const { line } = runScenario(s)
      const shortfall = Math.max(0, g.need - Math.max(0, g.at_trip))
      expect(line!.buy_packs * s.product.pack_size).toBeGreaterThanOrEqual(shortfall - 1e-9)
    }
  })
})

// ---------------------------------------------------------------------------------------------
describe('calendar', () => {
  it('payday set {15, 16, 30, last, 1}', () => {
    expect(isPayday('2026-05-15')).toBe(true)
    expect(isPayday('2026-05-16')).toBe(true)
    expect(isPayday('2026-05-30')).toBe(true)
    expect(isPayday('2026-05-31')).toBe(true)
    expect(isPayday('2026-06-01')).toBe(true)
    expect(isPayday('2026-05-29')).toBe(false)
    expect(isPayday('2026-02-28')).toBe(true)
    expect(isPayday('2026-02-27')).toBe(false)
  })
  it('multipliers combine by max', () => {
    expect(multiplier('2026-05-30', M)).toBe(1.3) // Sat + 30th
    expect(multiplier('2026-05-29', M)).toBe(1.15) // Fri
    expect(multiplier('2026-06-02', M)).toBe(1)
    expect(weekday('2026-05-30')).toBe(6)
  })
  it('demand(3, Sat 30, Wed Jun 3) = 3 × 4.9', () => {
    expect(demand(3, '2026-05-30', '2026-06-03', M)).toBeCloseTo(14.7, 9)
    expect(demand(3, '2026-05-30', '2026-05-30', M)).toBe(0)
  })
  it('next_trip / following', () => {
    expect(nextTrip('2026-05-29', [3, 6], null)).toBe('2026-05-30')
    expect(followingTrip('2026-05-30', [3, 6])).toBe('2026-06-03')
    expect(nextTrip('2026-05-29', [], null)).toBe('2026-05-29')
    expect(followingTrip('2026-05-29', [])).toBe('2026-06-05')
    expect(nextTrip('2026-05-29', [], '2026-06-12')).toBe('2026-06-12')
    expect(followingTrip('2026-06-12', [])).toBe('2026-06-19')
    expect(addDays('2026-05-31', 1)).toBe('2026-06-01')
  })
})

// ---------------------------------------------------------------------------------------------
describe('export / import', () => {
  it('round-trips all events and is idempotent (importing twice adds nothing)', () => {
    const s = byId('S3_after')
    const store = makeStore([3, 6], null)
    const product = makeProduct(s.product)
    const events = toEvents(s.events)
    const v: VoidEvent = { ...(ev('VOID', '2026-05-29T09:00:00+08:00', 'V1', {}) as any), target: events[0]!.id }
    const all: DomainEvent[] = [...events, v]
    const file = buildExport({ store, products: [product], customers: [], events: all }, DEVICE_ID, '2026-05-29T10:00:00+08:00')
    const json = JSON.parse(JSON.stringify(file))
    // import into an empty store with the same id
    const empty = { store: { ...store, updated_at: '2025-01-01T00:00:00+08:00' }, products: [], customers: [], events: [] }
    const m1 = mergeImport(empty, json)
    expect(m1.added_events).toBe(all.length)
    expect(m1.snapshot.events.map((e) => e.id).sort()).toEqual(all.map((e) => e.id).sort())
    expect(m1.snapshot.events.every((e) => (e as any).recorded_at && (e as any).device_id && (e as any).v === 1)).toBe(true)
    // derived state identical before/after round trip
    const before = run(store, product, all, toMs(s.now))
    const after = run(m1.snapshot.store, m1.snapshot.products[0]!, m1.snapshot.events, toMs(s.now))
    expect(after.state).toEqual(before.state)
    // second import: no-op
    const m2 = mergeImport(m1.snapshot, json)
    expect(m2.added_events).toBe(0)
    expect(m2.updated_products).toBe(0)
    expect(m2.snapshot.events.length).toBe(all.length)
  })
  it('refuses a different store id', () => {
    const store = makeStore([], null)
    const file = buildExport({ store: { ...store, id: 'OTHER' }, products: [], customers: [], events: [] }, DEVICE_ID, '2026-01-01T00:00:00+08:00')
    expect(() => mergeImport({ store, products: [], customers: [], events: [] }, file)).toThrow()
  })
})

// ---------------------------------------------------------------------------------------------
describe('Tier A → Tier B transition', () => {
  it('T1 hybrid: first count gives a real on-hand with the throughput rate, no jump in quantity', () => {
    const a = runScenario(byId('A1'))
    const t1 = runScenario(byId('T1_hybrid'))
    expect(t1.state.tier).toBe('counts')
    expect(t1.state.samples.length).toBe(0)
    expect(t1.state.daily_rate).toBeCloseTo(a.state.cadence!.throughput, 9)
    expect(t1.state.confidence).toBe('low')
    expect(t1.state.on_hand_est).not.toBeNull()
    expect(t1.line?.buy_packs).toBe(1)
  })
  it('T2: second count → single sample (3.5), Tier B rate', () => {
    const t2 = runScenario(byId('T2_one_sample'))
    expect(t2.state.samples.length).toBe(1)
    expect(t2.state.daily_rate).toBeCloseTo(3.5, 9)
    expect(t2.state.flags.has('count_mismatch')).toBe(false)
  })
  it('T3: single sample > 3× off throughput → keep throughput and flag count_mismatch', () => {
    const t3 = runScenario(byId('T3_mismatch'))
    expect(t3.state.samples.length).toBe(1)
    expect(t3.state.samples[0]!.rate).toBe(0)
    expect(t3.state.daily_rate).toBeCloseTo(3.0, 9)
    expect(t3.state.flags.has('count_mismatch')).toBe(true)
  })
  it('precedence: ≥ 2 samples always wins over throughput', () => {
    const s1 = runScenario(byId('S1'))
    expect(s1.state.cadence).not.toBeNull()
    expect(s1.state.daily_rate).not.toBeCloseTo(s1.state.cadence!.throughput, 3)
    expect(s1.state.tier).toBe('counts')
  })
})
