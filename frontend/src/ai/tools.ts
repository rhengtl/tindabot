// Assistant tools — BLUEPRINT §F. They run ON THE PHONE against the derived state the app already
// holds (the same numbers every screen shows); the model only sees their small JSON results.
// Each result is ≤ 4 KB, schema-checked by construction, and failed/unknown calls return
// `{ error }` so the model says "hindi ko nakuha ang data". `get_customer` is the only path that
// carries a customer name, and only for the name the owner asked about. No tool returns the raw
// event log: `list_events` returns totals.

import {
  type ActiveEvent,
  type Customer,
  type CustomerState,
  type Lang,
  type Product,
  type ProductState,
  type PurchaseEvent,
  type ShoppingList,
  type Store,
  type StoreState,
  MS_PER_DAY,
  diffDays,
  supplierPrices,
  toLocalDate,
  toMs,
} from '../domain'

export const MAX_RESULT_BYTES = 4096
export const MAX_SNAPSHOT_BYTES = 8192

export interface AssistantContext {
  store: Store
  products: Product[]
  states: Map<string, ProductState>
  list: ShoppingList
  finance: StoreState | null
  customers: Customer[]
  customerStates: Map<string, CustomerState>
  /** active events in total order */
  events: ActiveEvent[]
  nowMs: number
  lang: Lang
}

const r1 = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10) / 10)
/** Whole number, as the Paninda and *bakit* screens show stock and days left. */
const r0 = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n))
const r2 = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 100) / 100)

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

/** Exact (folded) name first, then containment either way, then all query words present. */
export function findByName<T extends { name: string }>(items: T[], query: unknown): { one: T } | { many: T[] } | null {
  if (typeof query !== 'string' || !fold(query)) return null
  const q = fold(query)
  const exact = items.filter((x) => fold(x.name) === q)
  if (exact.length === 1) return { one: exact[0]! }
  const contains = items.filter((x) => fold(x.name).includes(q) || q.includes(fold(x.name)))
  if (contains.length === 1) return { one: contains[0]! }
  if (contains.length > 1) return { many: contains }
  const words = q.split(' ').filter((w) => w.length >= 3)
  const all = words.length ? items.filter((x) => words.every((w) => fold(x.name).includes(w))) : []
  if (all.length === 1) return { one: all[0]! }
  return all.length > 1 ? { many: all } : null
}

function fit(result: Record<string, unknown>): Record<string, unknown> {
  return JSON.stringify(result).length <= MAX_RESULT_BYTES ? result : { error: 'too_large' }
}

function productResult(c: AssistantContext, p: Product): Record<string, unknown> {
  const st = c.states.get(p.id)
  const line = c.list.lines.find((l) => l.product_id === p.id)
  const purchases = c.events.filter((e): e is PurchaseEvent => e.type === 'PURCHASE' && e.product_id === p.id)
  const counts = st?.tier === 'counts'
  const out: Record<string, unknown> = {
    found: true,
    name: p.name,
    unit: p.unit_label,
    pack_label: p.pack_label,
    pack_size: p.pack_size,
    stopped: p.archived,
    confidence: st?.confidence ?? 'none',
    // rounded like the screens round them, so an answer quotes the same number the owner sees
    on_hand_est: counts ? r0(st?.on_hand_est) : null,
    days_left: counts ? r0(st?.days_left) : null,
    units_per_day: counts ? r2(st?.daily_rate) : null,
    last_count: st?.anchor ? { qty: st.anchor.qty, days_ago: Math.floor(st.days_since_count ?? 0) } : null,
    tallied_since_count: st && st.sold_since_anchor > 0 ? st.sold_since_anchor : null,
    sell_price: p.sell_price,
    unit_cost: r2(st?.unit_cost),
    tubo_per_unit: r2(st?.tubo_per_unit),
    on_list: line && line.section !== 'wag_muna' ? { packs: line.buy_packs, cost: r1(line.cost), urgent: line.section === 'bilhin_na', reason: line.reason } : null,
    supplier_prices: supplierPrices(purchases).slice(0, 5).map((s) => ({ supplier: s.supplier, unit_cost: r2(s.unit_cost) })),
    needs_count: st?.flags.has('needs_count') ?? false,
  }
  if (st?.tier === 'cadence' && st.cadence) {
    // Tier A knows purchase patterns only: never stock, days left or sales (§E2).
    out.purchase_pattern = { note: 'from purchases only — not sales, not stock', rebuy_early: st.cadence.rebuy.early, rebuy_late: st.cadence.rebuy.late, typical_units: r1(st.cadence.typical_units) }
  }
  return out
}

type Tool = (c: AssistantContext, args: Record<string, unknown>) => Record<string, unknown>

const TOOLS: Record<string, Tool> = {
  get_product(c, args) {
    const hit = findByName(c.products, args.name)
    if (!hit) return { found: false }
    if ('many' in hit) return { found: false, candidates: hit.many.slice(0, 8).map((p) => p.name) }
    return productResult(c, hit.one)
  },

  list_events(c, args) {
    const days = Number.isInteger(args.days) ? Math.min(90, Math.max(1, args.days as number)) : null
    if (days === null) return { error: 'bad_args' }
    let product: Product | null = null
    if (typeof args.product === 'string' && args.product.trim()) {
      const hit = findByName(c.products, args.product)
      if (!hit) return { found: false }
      if ('many' in hit) return { found: false, candidates: hit.many.slice(0, 8).map((p) => p.name) }
      product = hit.one
    }
    const since = c.nowMs - days * MS_PER_DAY
    const t = { purchases: 0, units_bought: 0, cost_recorded: 0, counts: 0, units_tallied: 0, units_damaged: 0, utang_given: 0, payments: 0, expenses: 0 }
    for (const e of c.events) {
      if (toMs(e.ts) < since || toMs(e.ts) > c.nowMs) continue
      if ('product_id' in e && product && e.product_id !== product.id) continue
      if (!('product_id' in e) && product) continue
      if (e.type === 'PURCHASE') {
        t.purchases++
        t.units_bought += e.qty_units
        t.cost_recorded += e.total_cost ?? 0
      } else if (e.type === 'COUNT') t.counts++
      else if (e.type === 'SALE') t.units_tallied += e.qty_units
      else if (e.type === 'ADJUST' && e.delta < 0) t.units_damaged += -e.delta
      else if (e.type === 'UTANG') t.utang_given += e.amount
      else if (e.type === 'BAYAD') t.payments += e.amount
      else if (e.type === 'EXPENSE') t.expenses += e.amount
    }
    const out: Record<string, unknown> = { days, product: product?.name ?? null, ...t, cost_recorded: r2(t.cost_recorded), utang_given: r2(t.utang_given), payments: r2(t.payments), expenses: r2(t.expenses) }
    if (product) for (const k of ['utang_given', 'payments', 'expenses']) delete out[k]
    return out
  },

  get_shopping_list(c) {
    const byId = new Map(c.products.map((p) => [p.id, p]))
    const lines = c.list.lines
      .filter((l) => l.section !== 'wag_muna')
      .map((l) => {
        const p = byId.get(l.product_id)
        return { name: p?.name ?? '?', packs: l.buy_packs, pack_label: p ? (p.pack_size === 1 ? p.unit_label : p.pack_label) : '', cost: r1(l.cost), urgent: l.section === 'bilhin_na', estimate_only: l.tier === 'cadence' }
      })
    const base = { next_trip: c.list.next_trip, following_trip: c.list.following, total_known_cost: r1(c.list.total_known_cost), items_without_price: c.list.unknown_cost_count, item_count: lines.length }
    let shown = lines
    while (shown.length > 0 && JSON.stringify({ ...base, lines: shown }).length > MAX_RESULT_BYTES - 40) shown = shown.slice(0, -1)
    return { ...base, lines: shown, ...(shown.length < lines.length ? { truncated: true } : {}) }
  },

  get_week_summary(c, args) {
    const k = Number.isInteger(args.weeks_ago) ? (args.weeks_ago as number) : -1
    const w = c.finance?.weeks[k]
    if (!c.finance || !w) return { error: 'bad_args' }
    return {
      week_start: w.start,
      week_end: w.end,
      expenses: r2(w.gastos),
      purchases_cost: r2(w.nabili),
      utang_given: r2(w.utang_given),
      utang_received: r2(w.utang_received),
      cash_count: r2(w.cash_count),
      utang_outstanding_end: r2(w.outstanding_end),
      // weekly estimate from counted products only (§E5), rounded like the Ulat screen does
      estimate_weekly_sales: Math.round(c.finance.tantiya.benta / 10) * 10,
      estimate_weekly_profit: Math.round(c.finance.tantiya.tubo / 10) * 10,
      estimate_based_on_products: c.finance.tantiya.products,
    }
  },

  get_customer(c, args) {
    const hit = findByName(c.customers, args.name)
    if (!hit) return { found: false }
    if ('many' in hit) return { found: false, several: hit.many.length } // never lists other customers' names
    const cu = hit.one
    const st = c.customerStates.get(cu.id)
    const today = toLocalDate(c.nowMs)
    const day = (ts: string | null | undefined) => (ts ? toLocalDate(toMs(ts)) : null)
    return {
      found: true,
      name: cu.name,
      balance: r2(st?.balance ?? 0),
      total_utang: r2(st?.total_utang ?? 0),
      total_paid: r2(st?.total_bayad ?? 0),
      oldest_unpaid_days: st?.oldest_unpaid_ts ? diffDays(day(st.oldest_unpaid_ts)!, today) : null,
      last_utang: day(st?.last_utang_ts),
      last_payment: day(st?.last_bayad_ts),
    }
  },
}

export function runTool(c: AssistantContext, name: string, args: unknown): Record<string, unknown> {
  const tool = TOOLS[name]
  if (!tool || !args || typeof args !== 'object' || Array.isArray(args)) return { error: 'bad_args' }
  try {
    return fit(tool(c, args as Record<string, unknown>))
  } catch {
    return { error: 'failed' }
  }
}

/** What the model sees up front (≤ 8 KB): the store's shape and product names — no customer names. */
export function buildSnapshot(c: AssistantContext): Record<string, unknown> {
  const active = c.products.filter((p) => !p.archived)
  const buy = c.list.lines.filter((l) => l.section !== 'wag_muna')
  const base = {
    store: c.store.name,
    today: toLocalDate(c.nowMs),
    next_trip: c.list.next_trip,
    product_count: active.length,
    customer_count: c.customers.filter((x) => !x.archived).length,
    list: { items: buy.length, urgent: buy.filter((l) => l.section === 'bilhin_na').length, total_known_cost: r1(c.list.total_known_cost) },
    utang_outstanding: r2(c.finance?.utang_outstanding ?? 0),
    last_cash_count: c.finance?.cash_last ? { amount: c.finance.cash_last.amount, date: toLocalDate(toMs(c.finance.cash_last.ts)) } : null,
  }
  let names = active.map((p) => p.name)
  while (names.length > 0 && JSON.stringify({ ...base, products: names }).length > MAX_SNAPSHOT_BYTES - 40) names = names.slice(0, -1)
  return { ...base, products: names, ...(names.length < active.length ? { products_truncated: true } : {}) }
}
