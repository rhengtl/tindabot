// Total order and active set — BLUEPRINT §C.
// Total order = (ts, typeRank, id) with typeRank(COUNT) = 0, everything else = 1.
// Active set = non-VOID events with no VOID targeting them. Both are pure functions of the
// event *set*, so the result never depends on insertion order.

import { toMs } from './calendar'
import type { ActiveEvent, DomainEvent, EventId, StockEvent } from './types'

export function typeRank(e: DomainEvent): 0 | 1 {
  return e.type === 'COUNT' ? 0 : 1
}

export function compareEvents(a: DomainEvent, b: DomainEvent): number {
  const ta = toMs(a.ts)
  const tb = toMs(b.ts)
  if (ta !== tb) return ta - tb
  const ra = typeRank(a)
  const rb = typeRank(b)
  if (ra !== rb) return ra - rb
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Resolve VOIDs. A VOID may only target a non-VOID event; a VOID whose target is absent is kept
 * (inert) and applies once the target arrives. Returns active non-VOID events, sorted by total order.
 */
export function activeEvents(events: Iterable<DomainEvent>): ActiveEvent[] {
  const voided = new Set<EventId>()
  const seen = new Set<EventId>()
  const nonVoid: ActiveEvent[] = []
  for (const e of events) {
    if (seen.has(e.id)) continue // write-once: duplicates by id are ignored
    seen.add(e.id)
    if (e.type === 'VOID') voided.add(e.target)
    else nonVoid.push(e)
  }
  return nonVoid.filter((e) => !voided.has(e.id)).sort(compareEvents)
}

export function isStockEvent(e: ActiveEvent): e is StockEvent {
  return e.type === 'PURCHASE' || e.type === 'COUNT' || e.type === 'ADJUST'
}

export function forProduct(events: ActiveEvent[], productId: string): StockEvent[] {
  return events.filter((e): e is StockEvent => isStockEvent(e) && e.product_id === productId)
}
