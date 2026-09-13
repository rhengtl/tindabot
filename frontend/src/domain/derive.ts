// Product derivation — BLUEPRINT §E1–E3. Always a full recompute from the product's active
// events in total order; never incremental.

import { deriveCadence } from './cadence'
import { daysBetweenMs, toLocalDate } from './calendar'
import { deriveTierB } from './samples'
import { lugiCheck, tuboPerUnit, unitCost } from './tubo'
import type { Product, ProductFlag, ProductState, PurchaseEvent, StockEvent } from './types'

export const NEEDS_COUNT_STALE_DAYS = 14
export const SLOW_RATE = 0.25
export const SLOW_DAYS_LEFT = 30
export const DEAD_RATE = 0.01
export const DEAD_HISTORY_DAYS = 30
export const MISMATCH_RATIO = 3

/**
 * @param events the product's ACTIVE events sorted by total order (see order.ts)
 */
export function deriveProduct(product: Product, events: StockEvent[], nowMs: number): ProductState {
  const today = toLocalDate(nowMs)
  const purchases = events.filter((e): e is PurchaseEvent => e.type === 'PURCHASE')
  const b = deriveTierB(events, nowMs)
  const c = deriveCadence(purchases, nowMs, today)
  const flags = new Set<ProductFlag>()

  const cost = unitCost(purchases)
  const tubo = tuboPerUnit(product.sell_price, cost)
  if (cost === null) flags.add('no_cost')
  if (product.sell_price === null) flags.add('no_price')
  if (lugiCheck(product.sell_price, cost)) flags.add('lugi_check')
  if (events.length === 0) flags.add('bago')
  if (b.inconsistentLatest) flags.add('inconsistent')
  if (c.status === 'unclear') flags.add('unclear')

  const throughput = c.cadence?.throughput ?? null

  // ---- E3 precedence ----
  let tier: ProductState['tier']
  let rate: number | null
  let confidence: ProductState['confidence']
  const nSamples = b.samples.length

  if (nSamples >= 2) {
    tier = 'counts'
    rate = b.rate
    confidence = b.confidence
  } else if (nSamples === 1) {
    tier = 'counts'
    const sampleRate = b.rate!
    if (throughput !== null && throughput > 0 && (sampleRate / throughput > MISMATCH_RATIO || throughput / sampleRate > MISMATCH_RATIO)) {
      rate = throughput
      confidence = 'low'
      flags.add('count_mismatch')
    } else {
      rate = sampleRate
      confidence = b.confidence // 'low' by construction (1 sample)
    }
  } else if (b.anchor) {
    tier = 'counts'
    if (throughput !== null) {
      rate = throughput // hybrid: real anchor, throughput rate
      confidence = 'low'
    } else {
      rate = null
      confidence = 'none'
    }
  } else if (c.cadence) {
    tier = 'cadence'
    rate = null
    confidence = 'low'
    if (c.cadence.dormant) flags.add('dormant')
  } else {
    tier = 'none'
    rate = null
    confidence = 'none'
  }

  // ---- on-hand (Tier B / hybrid only) ----
  let on_hand: number | null = null
  let days_since: number | null = null
  let days_left: number | null = null
  if (b.anchor) {
    days_since = daysBetweenMs(b.anchor.ms, nowMs)
    const depletion = rate !== null ? rate * days_since : 0
    on_hand = Math.max(0, b.anchor.qty + b.netSinceAnchor - depletion)
    if (rate !== null && rate > 0) days_left = on_hand / rate
    if (days_since > NEEDS_COUNT_STALE_DAYS) flags.add('needs_count')
    if (rate !== null) {
      if (rate < SLOW_RATE && days_left !== null && days_left > SLOW_DAYS_LEFT) flags.add('slow')
      if (rate < DEAD_RATE && (b.historyDays ?? 0) >= DEAD_HISTORY_DAYS && on_hand > 0) flags.add('dead')
    }
  }

  return {
    product_id: product.id,
    tier,
    confidence,
    anchor: b.anchor ? { ts: b.anchor.ts, qty: b.anchor.qty } : null,
    anchor_ms: b.anchor?.ms ?? null,
    net_since_anchor: b.netSinceAnchor,
    on_hand_est: on_hand,
    days_since_count: days_since,
    daily_rate: rate,
    days_left,
    cadence: c.cadence,
    cadence_status: c.status,
    samples: b.samples,
    unit_cost: cost,
    tubo_per_unit: tubo,
    flags,
  }
}
