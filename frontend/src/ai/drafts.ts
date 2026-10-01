// /ai/parse drafts → editable rows (BLUEPRINT §F). Pure. The AI only proposes; the owner edits each
// row and nothing is written until "I-save". Quantities become selling units here with the
// product's CURRENT pack size (the same rule as Bumili, §C), and every saved row becomes an
// ordinary PURCHASE or COUNT event.

import type { Product } from '../domain'

/** What the proxy returns (validated again here: the phone never trusts a network reply). */
export interface ParsedDraft {
  kind: 'purchase' | 'count'
  product_index: number
  name_seen: string
  qty: number
  qty_unit: 'pack' | 'unit'
  total_cost: number | null
  supplier: string | null
}
export interface ParseReply {
  drafts: ParsedDraft[]
  unreadable: string[]
}

export interface DraftRow {
  key: string
  kind: 'purchase' | 'count'
  /** null = not matched to a product yet: the owner picks one or skips the row */
  product_id: string | null
  name_seen: string
  qty: number
  qty_unit: 'pack' | 'unit'
  total_cost: number | null
  supplier: string | null
  include: boolean
}

/** The product list sent with a parse request: names and pack sizes only, indexed. */
export function parseProducts(products: Product[]): { list: Array<{ name: string; pack_label: string; pack_size: number; unit_label: string }>; ids: string[] } {
  const active = products.filter((p) => !p.archived)
  return {
    list: active.map((p) => ({ name: p.name, pack_label: p.pack_label, pack_size: p.pack_size, unit_label: p.unit_label })),
    ids: active.map((p) => p.id),
  }
}

export function isParseReply(x: unknown): x is ParseReply {
  if (!x || typeof x !== 'object') return false
  const r = x as Partial<ParseReply>
  return Array.isArray(r.drafts) && Array.isArray(r.unreadable)
}

/** Reply → rows. Unmatched rows start unticked; malformed entries become "unreadable" text. */
export function toRows(reply: ParseReply, ids: string[]): { rows: DraftRow[]; unreadable: string[] } {
  const rows: DraftRow[] = []
  const unreadable = reply.unreadable.filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim())
  reply.drafts.forEach((d, i) => {
    const ok = d && (d.kind === 'purchase' || d.kind === 'count') && Number.isFinite(d.qty) && d.qty >= 0 && (d.qty_unit === 'pack' || d.qty_unit === 'unit')
    if (!ok) {
      if (d && typeof d.name_seen === 'string' && d.name_seen.trim()) unreadable.push(d.name_seen.trim())
      return
    }
    const id = Number.isInteger(d.product_index) && d.product_index >= 0 ? (ids[d.product_index] ?? null) : null
    rows.push({
      key: `d${i}`,
      kind: d.kind,
      product_id: id,
      name_seen: typeof d.name_seen === 'string' ? d.name_seen : '',
      qty: d.qty,
      qty_unit: d.qty_unit,
      total_cost: d.kind === 'purchase' && typeof d.total_cost === 'number' && Number.isFinite(d.total_cost) && d.total_cost >= 0 ? d.total_cost : null,
      supplier: typeof d.supplier === 'string' && d.supplier.trim() ? d.supplier.trim() : null,
      include: id !== null && d.qty > 0,
    })
  })
  return { rows, unreadable }
}

/** Selling units for a row, or null when it cannot be saved (no product, no positive whole quantity). */
export function rowUnits(row: DraftRow, product: Product | undefined): number | null {
  if (!product) return null
  const units = row.qty_unit === 'pack' ? row.qty * product.pack_size : row.qty
  if (!Number.isFinite(units)) return null
  const n = Math.round(units)
  if (Math.abs(units - n) > 1e-9) return null // a fraction of a selling unit is not a quantity
  if (row.kind === 'purchase' ? n <= 0 : n < 0) return null
  return n
}

/** The rows that will be written on "I-save" (ticked and valid), in order. */
export function savable(rows: DraftRow[], products: Map<string, Product>): Array<{ row: DraftRow; units: number }> {
  const out: Array<{ row: DraftRow; units: number }> = []
  for (const row of rows) {
    if (!row.include || !row.product_id) continue
    const units = rowUnits(row, products.get(row.product_id))
    if (units === null) continue
    out.push({ row, units })
  }
  return out
}
