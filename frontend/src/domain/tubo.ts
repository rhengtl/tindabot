// Unit cost and tubo — BLUEPRINT §E5.

import type { PurchaseEvent } from './types'

/** unit_cost = latest PURCHASE (total order) with a cost: total_cost / qty_units */
export function unitCost(purchasesInOrder: PurchaseEvent[]): number | null {
  for (let i = purchasesInOrder.length - 1; i >= 0; i--) {
    const p = purchasesInOrder[i]!
    if (p.total_cost !== null && p.qty_units > 0) return p.total_cost / p.qty_units
  }
  return null
}

export function tuboPerUnit(sellPrice: number | null, cost: number | null): number | null {
  if (sellPrice === null || cost === null) return null
  return sellPrice - cost
}

export function lugiCheck(sellPrice: number | null, cost: number | null): boolean {
  return sellPrice !== null && cost !== null && cost >= sellPrice
}
