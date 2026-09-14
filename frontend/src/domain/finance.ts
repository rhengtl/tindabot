// P2 finance derivation — BLUEPRINT §E6. Pure; always a full recompute from the ACTIVE events in
// total order (see order.ts). Cash is recorded counts only — nothing here infers revenue.

import { MS_PER_DAY, addDays, dayNumber, fromDayNumber, localTimeMs, toLocalDate, toMs, weekday } from './calendar'
import type {
  ActiveEvent,
  BudgetLine,
  BudgetResult,
  CashCountEvent,
  CustomerState,
  ISODateTime,
  ListLine,
  LocalDate,
  Product,
  ProductState,
  ShoppingList,
  StoreState,
  WeekSummary,
} from './types'

export const WEEKS_SHOWN = 4
export const CASH_PREFILL_MAX_DAYS = 2

/** Two-decimal peso arithmetic without float drift (amounts are validated to ≤ 2 decimals). */
export function pesos(v: number): number {
  return Math.round(v * 100) / 100 + 0 // + 0 normalizes -0
}

/**
 * @param events ACTIVE events in total order (any customer / type; filtered here)
 */
export function deriveCustomer(customerId: string, events: ActiveEvent[]): CustomerState {
  let totalUtang = 0
  let totalBayad = 0
  let lastUtang: ISODateTime | null = null
  let lastBayad: ISODateTime | null = null
  const utangs: Array<{ ts: ISODateTime; amount: number }> = []
  for (const e of events) {
    if (e.type === 'UTANG' && e.customer_id === customerId) {
      totalUtang = pesos(totalUtang + e.amount)
      lastUtang = e.ts
      utangs.push({ ts: e.ts, amount: e.amount })
    } else if (e.type === 'BAYAD' && e.customer_id === customerId) {
      totalBayad = pesos(totalBayad + e.amount)
      lastBayad = e.ts
    }
  }
  const balance = pesos(totalUtang - totalBayad)
  // FIFO: every payment covers the oldest utang first, whenever it was made.
  let oldest: ISODateTime | null = null
  if (balance > 0) {
    let cum = 0
    for (const u of utangs) {
      cum = pesos(cum + u.amount)
      if (cum > totalBayad) {
        oldest = u.ts
        break
      }
    }
  }
  return {
    customer_id: customerId,
    balance,
    total_utang: totalUtang,
    total_bayad: totalBayad,
    last_utang_ts: lastUtang,
    last_bayad_ts: lastBayad,
    oldest_unpaid_ts: oldest,
  }
}

/** Every customer id that has an active UTANG/BAYAD (archived and unknown customers included). */
export function customerIds(events: ActiveEvent[]): string[] {
  const ids = new Set<string>()
  for (const e of events) if (e.type === 'UTANG' || e.type === 'BAYAD') ids.add(e.customer_id)
  return [...ids]
}

/** Σ max(0, balance) over every customer with events. */
export function utangOutstanding(events: ActiveEvent[]): number {
  let total = 0
  for (const id of customerIds(events)) total = pesos(total + Math.max(0, deriveCustomer(id, events).balance))
  return total
}

/** Monday of the week containing `date` (weeks run Monday → Sunday, local calendar). */
export function weekStart(date: LocalDate): LocalDate {
  const w = weekday(date) // 0 = Sunday
  return addDays(date, -((w + 6) % 7))
}

function summarizeWeek(start: LocalDate, events: ActiveEvent[]): WeekSummary {
  const end = addDays(start, 6)
  const startMs = localTimeMs(start, 0)
  const endMs = localTimeMs(addDays(end, 1), 0) // exclusive
  let gastos = 0
  let nabili = 0
  let given = 0
  let received = 0
  let cash: number | null = null
  const upToEnd: ActiveEvent[] = []
  for (const e of events) {
    const ms = toMs(e.ts)
    if (ms < endMs) upToEnd.push(e)
    if (ms < startMs || ms >= endMs) continue
    if (e.type === 'EXPENSE') gastos = pesos(gastos + e.amount)
    else if (e.type === 'PURCHASE' && e.total_cost !== null) nabili = pesos(nabili + e.total_cost)
    else if (e.type === 'UTANG') given = pesos(given + e.amount)
    else if (e.type === 'BAYAD') received = pesos(received + e.amount)
    else if (e.type === 'CASH_COUNT') cash = e.amount // events are in total order → last wins
  }
  return { start, end, gastos, nabili, utang_given: given, utang_received: received, cash_count: cash, outstanding_end: utangOutstanding(upToEnd) }
}

export interface StoreFinanceInput {
  /** ACTIVE events in total order */
  events: ActiveEvent[]
  products: Product[]
  states: Map<string, ProductState>
  nowMs: number
}

export function deriveStoreFinance({ events, products, states, nowMs }: StoreFinanceInput): StoreState {
  let cashLast: CashCountEvent | null = null
  for (const e of events) if (e.type === 'CASH_COUNT') cashLast = e
  const thisMonday = weekStart(toLocalDate(nowMs))
  const weeks: WeekSummary[] = []
  for (let i = 0; i < WEEKS_SHOWN; i++) weeks.push(summarizeWeek(fromDayNumber(dayNumber(thisMonday) - 7 * i), events))

  let benta = 0
  let tubo = 0
  let included = 0
  let skipped = 0
  for (const p of products) {
    if (p.archived) continue
    const s = states.get(p.id)
    if (!s || s.tier !== 'counts' || s.daily_rate === null || s.daily_rate <= 0) continue
    if (p.sell_price === null || s.tubo_per_unit === null) {
      skipped++
      continue
    }
    included++
    benta += s.daily_rate * 7 * p.sell_price
    tubo += s.daily_rate * 7 * s.tubo_per_unit
  }
  return {
    cash_last: cashLast ? { ts: cashLast.ts, amount: cashLast.amount } : null,
    utang_outstanding: utangOutstanding(events),
    weeks,
    tantiya: { benta, tubo, products: included, skipped },
  }
}

/** Budget prefill: the last cash count only when ≤ 2 days old, else null. */
export function budgetPrefill(cashLast: StoreState['cash_last'], nowMs: number): number | null {
  if (!cashLast) return null
  return (nowMs - toMs(cashLast.ts)) / MS_PER_DAY <= CASH_PREFILL_MAX_DAYS ? cashLast.amount : null
}

/** Tantiya display rounding: nearest ₱10. */
export function roundTo10(v: number): number {
  return Math.round(v / 10) * 10
}

const SECTION_ORDER: Record<ListLine['section'], number> = { bilhin_na: 0, bilhin: 1, wag_muna: 2 }

/**
 * Greedy budget (BLUEPRINT §E6): bilhin_na then bilhin, by priority desc; unknown-cost lines are
 * skipped; every processed line keeps ≥ 1 pack; remaining may go negative.
 */
export function applyBudget(list: ShoppingList, budget: number): BudgetResult {
  const lines = list.lines
    .filter((l) => l.section !== 'wag_muna' && l.cost !== null && l.buy_packs > 0)
    .sort((a, b) => SECTION_ORDER[a.section] - SECTION_ORDER[b.section] || b.priority - a.priority || (a.product_id < b.product_id ? -1 : 1))
  let remaining = budget
  let spent = 0
  const out: BudgetLine[] = []
  for (const l of lines) {
    const perPack = l.cost! / l.buy_packs
    const affordable = Math.floor(remaining / perPack + 1e-9)
    const packs = Math.max(1, Math.min(l.buy_packs, affordable))
    const spend = pesos(packs * perPack)
    remaining -= spend
    spent = pesos(spent + spend)
    out.push({ product_id: l.product_id, packs, reduced: packs < l.buy_packs, spend })
  }
  return { budget, lines: out, kulang: Math.max(0, pesos(list.total_known_cost - budget)), spent }
}
