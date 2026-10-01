// Shopping list — BLUEPRINT §E2 (Tier A quantity) and §E4 (Tier B lines, urgency, rounding,
// priority, sections, banner). Pure.

import { rebuyWindowDays } from './cadence'
import {
  MS_PER_DAY,
  addDays,
  dayNumber,
  demand,
  followingTrip,
  isPayday,
  nextTrip,
  noonMs,
  toLocalDate,
  type Multipliers,
} from './calendar'
import { packsFor } from './rounding'
import * as T from './templates'
import type { Lang, LocalDate, ListLine, Product, ProductState, ShoppingList, Store, Urgency } from './types'

export const NEEDS_COUNT_URGENT_DAYS = 7
export const DEFER_PACK_FRACTION = 0.25
export const SLOW_URGENCY_RATE = 0.5
export const RANGE_LOW = 0.7
export const RANGE_HIGH = 1.3
export const CAP_FULL_HISTORY_N = 6
export const WIDE_WINDOW_DAYS = 14

export interface ListInput {
  store: Store
  products: Product[]
  states: Map<string, ProductState>
  nowMs: number
  /** Language of the generated reasons/hints/banner (wording only; quantities are unaffected). */
  lang: Lang
}

function paydayInRange(a: LocalDate, b: LocalDate): boolean {
  for (let n = dayNumber(a); n < dayNumber(b); n++) {
    if (isPayday(addDays(a, n - dayNumber(a)))) return true
  }
  return false
}

export function buildList(input: ListInput): ShoppingList {
  const { store, products, states, nowMs, lang } = input
  const today = toLocalDate(nowMs)
  const next_trip = nextTrip(today, store.restock_days, store.next_trip_override)
  const following = followingTrip(next_trip, store.restock_days)
  const hasSchedule = store.restock_days.length > 0 || store.next_trip_override !== null
  const m = store.multipliers
  const payday_in_horizon = paydayInRange(today, following)

  const lines: ListLine[] = []
  for (const p of products) {
    if (p.archived) continue
    const s = states.get(p.id)
    if (!s) continue
    if (s.tier === 'counts' && s.daily_rate !== null && s.daily_rate > 0) {
      const line = tierBLine(p, s, { today, next_trip, following, m, payday_in_horizon, lang })
      if (line) lines.push(line)
    } else if (s.tier === 'cadence' && s.cadence && !s.cadence.dormant) {
      const line = tierALine(p, s, { today, next_trip, following, m, hasSchedule, payday_in_horizon, lang })
      if (line) lines.push(line)
    }
  }

  const order: Record<ListLine['section'], number> = { bilhin_na: 0, bilhin: 1, wag_muna: 2 }
  lines.sort((a, b) => order[a.section] - order[b.section] || b.priority - a.priority)

  let total = 0
  let unknown = 0
  for (const l of lines) {
    if (l.section === 'wag_muna') continue
    if (l.cost === null) unknown++
    else total += l.cost
  }
  const beforeTrip = lines.filter((l) => l.before_trip).length
  return {
    next_trip,
    following,
    lines,
    total_known_cost: total,
    unknown_cost_count: unknown,
    banner: beforeTrip > 0 && next_trip !== today ? T.banner(beforeTrip, next_trip, today, lang) : null,
  }
}

interface Ctx {
  lang: Lang
  today: LocalDate
  next_trip: LocalDate
  following: LocalDate
  m: Multipliers
  payday_in_horizon: boolean
}

interface TierBCalc {
  need: number
  buffer: number
  at_trip: number
  urgency: Urgency
  units: number
}

/** E4 core, parameterised by rate so the range can be recomputed at 0.7× / 1.3×. */
export function tierBCalc(s: ProductState, rate: number, c: Ctx): TierBCalc {
  const days_since = s.days_since_count ?? 0
  const on_hand = Math.max(0, (s.anchor?.qty ?? 0) + s.net_since_anchor - Math.max(s.sold_since_anchor, rate * days_since))
  const days_left = on_hand / rate
  const need = demand(rate, c.next_trip, c.following, c.m)
  const buffer = Math.max(rate, 0.2 * need)
  const at_trip = on_hand - demand(rate, c.today, c.next_trip, c.m)

  let urgency: Urgency
  if (at_trip < 0 || (days_left <= 1 && rate >= SLOW_URGENCY_RATE)) urgency = 'red'
  else if (at_trip < need) urgency = 'orange'
  else if (at_trip < need + buffer) urgency = 'yellow'
  else urgency = 'green'
  if (rate < SLOW_URGENCY_RATE && urgency === 'red') urgency = 'orange'

  const units = Math.max(0, need + buffer - Math.max(0, at_trip))
  return { need, buffer, at_trip, urgency, units }
}

function tierBPacks(units: number, rate: number, urgency: Urgency, packSize: number): { packs: number; deferred: boolean } {
  if (urgency === 'red' || urgency === 'orange') return { packs: packsFor(units, rate, packSize, 1), deferred: false }
  if (urgency === 'yellow') {
    if (units < DEFER_PACK_FRACTION * packSize) return { packs: 0, deferred: true }
    return { packs: Math.max(1, packsFor(units, rate, packSize, 0)), deferred: false }
  }
  return { packs: 0, deferred: false }
}

function tierBLine(p: Product, s: ProductState, c: Ctx): ListLine | null {
  const rate = s.daily_rate!
  const base = tierBCalc(s, rate, c)
  if (base.urgency === 'green') return null
  const urgency = base.urgency
  const { packs, deferred } = tierBPacks(base.units, rate, urgency, p.pack_size)
  const days_since = s.days_since_count ?? 0
  const needs_count =
    s.flags.has('needs_count') || ((urgency === 'red' || urgency === 'orange') && days_since > NEEDS_COUNT_URGENT_DAYS)

  let range: [number, number] | null = null
  if ((s.confidence === 'low' || needs_count) && !deferred) {
    const lo = tierBCalc(s, rate * RANGE_LOW, c)
    const hi = tierBCalc(s, rate * RANGE_HIGH, c)
    const pl = tierBPacks(lo.units, rate * RANGE_LOW, lo.urgency === 'green' ? 'yellow' : lo.urgency, p.pack_size).packs
    const ph = tierBPacks(hi.units, rate * RANGE_HIGH, hi.urgency === 'green' ? 'yellow' : hi.urgency, p.pack_size).packs
    const a = Math.min(pl, ph, packs)
    const b = Math.max(pl, ph, packs)
    range = a === b ? null : [a, b]
  }

  const value = s.tubo_per_unit ?? p.sell_price ?? 1
  const priority = Math.max(0, base.need - base.at_trip) * value
  const cost = s.unit_cost === null || packs === 0 ? null : packs * p.pack_size * s.unit_cost

  const reason = T.tierBReason({
    urgency,
    before_trip: base.at_trip < 0,
    next_trip: c.next_trip,
    today: c.today,
    days_left: s.days_left,
    days_since_count: days_since,
    needs_count,
    payday_in_horizon: c.payday_in_horizon,
    deferred,
    slow: rate < SLOW_URGENCY_RATE,
    inconsistent: s.flags.has('inconsistent'),
  }, c.lang)

  return {
    product_id: p.id,
    tier: 'counts',
    urgency,
    section: deferred ? 'wag_muna' : urgency === 'red' ? 'bilhin_na' : 'bilhin',
    buy_packs: packs,
    buy_units: base.units,
    range,
    cost,
    priority,
    reason,
    hint: null,
    before_trip: base.at_trip < 0,
    needs_count,
  }
}

interface CtxA extends Ctx {
  hasSchedule: boolean
}

export interface TierAQuantity {
  listed: boolean
  carry: number
  units: number
  cap_packs: number
  packs: number
  weekly_hint_packs: number | null
}

/** E2 quantity rules. Exported so tests can assert the intermediate numbers. */
export function tierAQuantity(p: Product, s: ProductState, c: CtxA): TierAQuantity {
  const cad = s.cadence!
  const listed = dayNumber(cad.rebuy.mid) < dayNumber(c.following) && !cad.dormant
  const thr = cad.throughput
  if (!c.hasSchedule) {
    const packs = Math.ceil(cad.typical_units / p.pack_size)
    return { listed, carry: 0, units: cad.typical_units, cap_packs: packs, packs, weekly_hint_packs: Math.ceil((thr * 7) / p.pack_size) }
  }
  const carry = thr * Math.max(0, (cad.rebuy.midMs - noonMs(c.next_trip)) / MS_PER_DAY)
  const units = Math.max(0, demand(thr, c.next_trip, c.following, c.m) - carry)
  const cap_units = cad.typical_units * (cad.n >= CAP_FULL_HISTORY_N ? 2 : 1)
  const cap_packs = Math.ceil(cap_units / p.pack_size)
  const packs = Math.min(Math.max(1, packsFor(units, thr, p.pack_size, 1)), cap_packs)
  return { listed, carry, units, cap_packs, packs, weekly_hint_packs: null }
}

function tierALine(p: Product, s: ProductState, c: CtxA): ListLine | null {
  const cad = s.cadence!
  const q = tierAQuantity(p, s, c)
  if (!q.listed) return null
  const value = s.tubo_per_unit ?? p.sell_price ?? 1
  const cost = s.unit_cost === null ? null : q.packs * p.pack_size * s.unit_cost
  const typicalPacks = Math.max(1, Math.round(cad.typical_units / p.pack_size))
  const label = (n: number) => (p.pack_size === 1 ? `${n} ${p.unit_label}` : `${n} ${p.pack_label}`)
  const reasonInput: T.TierAReasonInput = {
    today: c.today,
    next_trip: c.next_trip,
    rebuy_early: cad.rebuy.early,
    rebuy_mid: cad.rebuy.mid,
    rebuy_late: cad.rebuy.late,
    window_wide: rebuyWindowDays(cad) > WIDE_WINDOW_DAYS,
    typical_label: label(typicalPacks),
    cycle_days: cad.typical_units / cad.throughput,
    no_schedule: !c.hasSchedule,
    weekly_hint_label: q.weekly_hint_packs === null ? null : label(q.weekly_hint_packs),
    payday_in_horizon: c.payday_in_horizon,
    cap_reached: q.packs >= q.cap_packs,
  }
  return {
    product_id: p.id,
    tier: 'cadence',
    urgency: 'orange',
    section: 'bilhin',
    buy_packs: q.packs,
    buy_units: q.units,
    range: null,
    cost,
    priority: q.units * value,
    reason: T.tierAReason(reasonInput, c.lang),
    hint: T.tierAHint(reasonInput, c.lang),
    before_trip: false,
    needs_count: false,
  }
}
