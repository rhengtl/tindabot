// Tier B — counts. BLUEPRINT §E1. Pure function over a product's active events in total order.

import { MS_PER_DAY, daysBetweenMs, toMs } from './calendar'
import type { Confidence, ISODateTime, Sample, StockEvent } from './types'

export const SAMPLE_WINDOW_DAYS = 90
export const HALF_LIFE_DAYS = 14
export const CAP_MULTIPLE = 3
export const NEWEST_SAMPLE_STALE_DAYS = 28

export interface TierB {
  anchor: { ts: ISODateTime; ms: number; qty: number } | null
  /** Reliable samples inside the 90-day window, in chronological order, with caps applied. */
  samples: Sample[]
  /** True when the interval ending at the current anchor had used < 0. */
  inconsistentLatest: boolean
  /** Σ PURCHASE.qty + Σ ADJUST.delta strictly after the anchor in total order. */
  netSinceAnchor: number
  rate: number | null
  confidence: Confidence
  /** Days from the earliest kept sample's start to now (null when no samples). */
  historyDays: number | null
}

export function median(xs: number[]): number {
  if (xs.length === 0) throw new Error('median of empty list')
  const s = xs.slice().sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/**
 * Walk the product's events (already active + sorted by total order) and build the samples.
 * Invariant: a COUNT is the sellable stock at its position; events strictly between two counts
 * belong to that interval; events strictly after the anchor are "since anchor".
 */
export function deriveTierB(events: StockEvent[], nowMs: number): TierB {
  let anchor: TierB['anchor'] = null
  let net = 0 // purchases + adjusts since the current anchor
  let inconsistentLatest = false
  const raw: Sample[] = []

  for (const e of events) {
    if (e.type === 'PURCHASE') {
      net += e.qty_units
    } else if (e.type === 'ADJUST') {
      net += e.delta
    } else {
      const ms = toMs(e.ts)
      if (anchor) {
        const days = daysBetweenMs(anchor.ms, ms)
        if (days < 1) {
          // c2 replaces the anchor; the interval yields no sample. Events between are
          // reflected in c2, so the accumulator is dropped.
        } else {
          const used = anchor.qty + net - e.qty_on_hand
          if (used < 0) {
            inconsistentLatest = true
          } else {
            inconsistentLatest = false
            const rate = used / days
            raw.push({ rate, days, startMs: anchor.ms, endMs: ms, cappedRate: rate })
          }
        }
      }
      anchor = { ts: e.ts, ms, qty: e.qty_on_hand }
      net = 0
    }
  }

  // 90-day window on the sample end.
  const windowStart = nowMs - SAMPLE_WINDOW_DAYS * MS_PER_DAY
  const kept = raw.filter((s) => s.endMs >= windowStart)

  // 3× median cap when there are at least 3 samples.
  if (kept.length >= CAP_MULTIPLE) {
    const cap = CAP_MULTIPLE * median(kept.map((s) => s.rate))
    for (const s of kept) s.cappedRate = Math.min(s.rate, cap)
  }

  let rate: number | null = null
  let historyDays: number | null = null
  if (kept.length > 0) {
    let sw = 0
    let srw = 0
    for (const s of kept) {
      const age = daysBetweenMs(s.endMs, nowMs)
      const w = s.days * Math.pow(0.5, age / HALF_LIFE_DAYS)
      sw += w
      srw += s.cappedRate * w
    }
    rate = srw / sw
    const firstStart = Math.min(...kept.map((s) => s.startMs))
    historyDays = daysBetweenMs(firstStart, nowMs)
  }

  const confidence = tierBConfidence(kept, historyDays, inconsistentLatest, nowMs)

  return { anchor, samples: kept, inconsistentLatest, netSinceAnchor: net, rate, confidence, historyDays }
}

const LEVELS: Confidence[] = ['none', 'low', 'mid', 'high']

export function tierBConfidence(
  samples: Sample[],
  historyDays: number | null,
  inconsistentLatest: boolean,
  nowMs: number,
): Confidence {
  if (samples.length === 0 || historyDays === null) return 'none'
  let level: Confidence
  if (samples.length < 2 || historyDays < 14) level = 'low'
  else if (samples.length >= 4 && historyDays >= 28) level = 'high'
  else level = 'mid'
  const newestEnd = Math.max(...samples.map((s) => s.endMs))
  const newestAge = daysBetweenMs(newestEnd, nowMs)
  if (inconsistentLatest || newestAge > NEWEST_SAMPLE_STALE_DAYS) {
    const i = LEVELS.indexOf(level)
    level = LEVELS[Math.max(1, i - 1)]! // never below 'low' while a rate exists
  }
  return level
}
