// Supplier price memory — P5 (decided 2026-10-01). Read-only views over PURCHASE.supplier, which
// has been part of the event since P1. Nothing here changes `unit_cost` (§E5: the latest purchase
// with a cost, whatever the supplier) or any list quantity; it only remembers what each supplier
// charged so the owner can compare and so Bumili can prefill the price for the chosen supplier.

import type { ActiveEvent, PurchaseEvent } from './types'

export interface SupplierPrice {
  /** as the owner last typed it */
  supplier: string
  /** cost per selling unit at that supplier's latest purchase with a cost */
  unit_cost: number
  ts: string
}

/** Trimmed, inner whitespace collapsed; '' when nothing usable is left. */
export function normalizeSupplier(s: string | null | undefined): string {
  return (s ?? '').trim().replace(/\s+/g, ' ')
}

const key = (s: string) => normalizeSupplier(s).toLowerCase()

/**
 * One entry per supplier (case-insensitive) for one product: the latest purchase that has both a
 * supplier and a cost. `purchases` are the product's ACTIVE purchases in total order. Cheapest first,
 * then by supplier name, so the order is stable.
 */
export function supplierPrices(purchases: PurchaseEvent[]): SupplierPrice[] {
  const latest = new Map<string, SupplierPrice>()
  for (const p of purchases) {
    const name = normalizeSupplier(p.supplier)
    if (!name || p.total_cost === null || !(p.qty_units > 0)) continue
    latest.set(key(name), { supplier: name, unit_cost: p.total_cost / p.qty_units, ts: p.ts })
  }
  return [...latest.values()].sort((a, b) => a.unit_cost - b.unit_cost || a.supplier.localeCompare(b.supplier))
}

/** The latest unit cost at one supplier for one product, or null. */
export function lastCostAt(purchases: PurchaseEvent[], supplier: string): number | null {
  const k = key(supplier)
  if (!k) return null
  return supplierPrices(purchases).find((s) => key(s.supplier) === k)?.unit_cost ?? null
}

/** Suppliers named in the store's active purchases, most recently used first (distinct, case-insensitive). */
export function recentSuppliers(active: ActiveEvent[], limit = 6): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = active.length - 1; i >= 0 && out.length < limit; i--) {
    const e = active[i]!
    if (e.type !== 'PURCHASE') continue
    const name = normalizeSupplier(e.supplier)
    if (!name || seen.has(key(name))) continue
    seen.add(key(name))
    out.push(name)
  }
  return out
}
