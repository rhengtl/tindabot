// Golden tests: every validated scenario (BLUEPRINT §I) compared number-for-number against the
// independent Python reference oracle (tools/reference_model.py → goldens.json).

import { describe, expect, it } from 'vitest'
import { goldens, runScenario, scenarios } from './helpers'

const close = (a: number | null | undefined, b: number | null | undefined, digits = 6) => {
  if (b === null || b === undefined) expect(a).toBeNull()
  else expect(a).toBeCloseTo(b, digits)
}

describe('validated scenarios vs reference oracle', () => {
  for (const s of scenarios) {
    it(`${s.id} — ${s.note}`, () => {
      const g = goldens[s.id]!
      const { state, list, line } = runScenario(s)

      // ---- derived state ----
      expect(state.tier).toBe(g.tier)
      expect(state.confidence).toBe(g.confidence)
      close(state.daily_rate, g.rate)
      close(state.on_hand_est, g.on_hand)
      close(state.days_since_count, g.days_since_count)
      close(state.days_left, g.days_left)
      close(state.unit_cost, g.unit_cost)
      close(state.tubo_per_unit, g.tubo)
      expect([...state.flags].sort()).toEqual(g.flags)
      expect(state.cadence_status).toBe(g.cadence_status)
      expect(state.samples.map((x) => [x.rate, x.days, x.cappedRate])).toEqual(
        expect.arrayContaining(g.samples.map((x: any) => [expect.closeTo(x.rate, 6), expect.closeTo(x.days, 6), expect.closeTo(x.capped, 6)])),
      )
      expect(state.samples.length).toBe(g.samples.length)

      // ---- cadence ----
      if (g.cadence) {
        expect(state.cadence).not.toBeNull()
        const c = state.cadence!
        close(c.throughput, g.cadence.throughput)
        close(c.typical_units, g.cadence.typical)
        expect(c.n).toBe(g.cadence.n)
        expect(c.cycles.length).toBe(g.cadence.cycles.length)
        c.cycles.forEach((x, i) => close(x, g.cadence.cycles[i]))
        expect([c.rebuy.early, c.rebuy.mid, c.rebuy.late]).toEqual(g.cadence.rebuy)
        expect(c.dormant).toBe(g.cadence.dormant)
      } else {
        expect(state.cadence).toBeNull()
      }

      // ---- trip + list ----
      expect(list.next_trip).toBe(g.next_trip)
      expect(list.following).toBe(g.following)
      expect(line !== undefined).toBe(g.listed)
      if (g.listed && line) {
        expect(line.buy_packs).toBe(g.packs)
        expect(line.section).toBe(g.section)
        expect(line.urgency).toBe(g.urgency)
        close(line.cost, g.cost)
        if (g.tier === 'cadence') {
          close(line.buy_units, g.units)
          expect(line.urgency).toBe('orange') // Tier A is permanently non-red
          expect(line.range).toBeNull()
        } else {
          close(line.buy_units, g.units)
          close(line.priority, g.priority)
          expect(line.before_trip).toBe(g.before_trip)
          expect(line.needs_count).toBe(g.needs_count)
          expect(line.range).toEqual(g.range)
        }
      }
    })
  }
})

describe('Tier A intermediate numbers (carry, cap, units)', () => {
  for (const s of scenarios.filter((x) => x.kind === 'tierA')) {
    const g = goldens[s.id]!
    if (!g.listed) continue
    it(`${s.id} carry/cap/units`, async () => {
      const { tierAQuantity } = await import('../list')
      const { makeProduct, makeStore } = await import('./helpers')
      const { toLocalDate, toMs, nextTrip, followingTrip } = await import('../calendar')
      const { state } = runScenario(s)
      const store = makeStore(s.store.restock_days, s.store.next_trip_override)
      const today = toLocalDate(toMs(s.now))
      const nt = nextTrip(today, store.restock_days, store.next_trip_override)
      const fo = followingTrip(nt, store.restock_days)
      const q = tierAQuantity(makeProduct(s.product), state, {
        today,
        next_trip: nt,
        following: fo,
        m: store.multipliers,
        hasSchedule: store.restock_days.length > 0 || store.next_trip_override !== null,
        payday_in_horizon: false,
      })
      expect(q.listed).toBe(true)
      expect(q.carry).toBeCloseTo(g.carry, 6)
      expect(q.units).toBeCloseTo(g.units, 6)
      expect(q.cap_packs).toBe(g.cap_packs)
      expect(q.packs).toBe(g.packs)
      expect(q.weekly_hint_packs).toBe(g.weekly_hint ?? null)
    })
  }
})
