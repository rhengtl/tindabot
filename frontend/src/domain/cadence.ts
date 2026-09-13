// Tier A — purchase throughput. BLUEPRINT §E2.
//
// Throughput = how fast the owner goes through what they buy. It is NOT confirmed sales demand:
// it equals demand only if the leftover at each purchase is roughly constant and every purchase
// is recorded. Tier A never knows current inventory, a stockout date, days left, or surplus.

import { MS_PER_DAY, addDays, dayNumber, daysBetweenMs, toLocalDate, toMs } from './calendar'
import { median } from './samples'
import type { Cadence, LocalDate, PurchaseEvent } from './types'

export const CADENCE_WINDOW_DAYS = 120
export const CADENCE_MIN_N = 3
export const CADENCE_MIN_SPAN_DAYS = 7
export const CADENCE_CYCLES_KEPT = 5
export const UNCLEAR_RATIO = 3
export const DORMANT_AFTER_DAYS = 14

export type CadenceStatus = 'ok' | 'n<3' | 'span<7' | 'unclear'

export interface CadenceResult {
  status: CadenceStatus
  cadence: Cadence | null
  /** merged purchases (same local date summed), chronological */
  merged: { ms: number; date: LocalDate; qty: number }[]
}

export function deriveCadence(purchases: PurchaseEvent[], nowMs: number, today: LocalDate): CadenceResult {
  const windowStart = nowMs - CADENCE_WINDOW_DAYS * MS_PER_DAY
  const inWindow = purchases.filter((p) => toMs(p.ts) >= windowStart).sort((a, b) => toMs(a.ts) - toMs(b.ts))

  // Merge purchases on the same local date: qty summed, ts = first.
  const merged: CadenceResult['merged'] = []
  for (const p of inWindow) {
    const date = toLocalDate(p.ts)
    const last = merged[merged.length - 1]
    if (last && last.date === date) last.qty += p.qty_units
    else merged.push({ ms: toMs(p.ts), date, qty: p.qty_units })
  }

  const n = merged.length
  if (n < CADENCE_MIN_N) return { status: 'n<3', cadence: null, merged }
  const span = daysBetweenMs(merged[0]!.ms, merged[n - 1]!.ms)
  if (span < CADENCE_MIN_SPAN_DAYS) return { status: 'span<7', cadence: null, merged }

  const allCycles: number[] = []
  for (let i = 0; i < n - 1; i++) {
    const gap = daysBetweenMs(merged[i]!.ms, merged[i + 1]!.ms)
    allCycles.push(merged[i]!.qty / gap)
  }
  const cycles = allCycles.slice(-CADENCE_CYCLES_KEPT)

  if (n === CADENCE_MIN_N) {
    const mx = Math.max(...cycles)
    const mn = Math.min(...cycles)
    if (mn <= 0 || mx / mn >= UNCLEAR_RATIO) return { status: 'unclear', cadence: null, merged }
  }

  const throughput = median(cycles)
  const typical_units = median(merged.map((m) => m.qty))
  const last = merged[n - 1]!

  const daysFor = (rate: number) => Math.max(1, last.qty / rate)
  const earlyMs = last.ms + daysFor(Math.max(...cycles)) * MS_PER_DAY
  const midMs = last.ms + daysFor(throughput) * MS_PER_DAY
  const lateMs = last.ms + daysFor(Math.min(...cycles)) * MS_PER_DAY

  const mid = toLocalDate(midMs)
  const dormant = dayNumber(today) > dayNumber(addDays(mid, DORMANT_AFTER_DAYS))

  return {
    status: 'ok',
    merged,
    cadence: {
      throughput,
      typical_units,
      n,
      cycles,
      rebuy: { early: toLocalDate(earlyMs), mid, late: toLocalDate(lateMs), midMs },
      dormant,
    },
  }
}

/** Width of the rebuy window in days. */
export function rebuyWindowDays(c: Cadence): number {
  return dayNumber(c.rebuy.late) - dayNumber(c.rebuy.early)
}

