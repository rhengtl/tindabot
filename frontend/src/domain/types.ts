// Domain types — see docs/BLUEPRINT.md §C. Pure data; no IO.

export type ULID = string
export type EventId = ULID
export type ISODateTime = string // ISO 8601 with offset, e.g. 2026-05-13T10:00:00+08:00
export type LocalDate = string // YYYY-MM-DD in the device's local calendar
/** 0 = Sunday … 6 = Saturday (JavaScript convention). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

// ---------- Records (mutable, last-write-wins by updated_at) ----------

export interface Store {
  id: ULID
  name: string
  restock_days: Weekday[]
  next_trip_override: LocalDate | null
  multipliers: { payday: number; fri_sat: number }
  updated_at: ISODateTime
}

export interface Product {
  id: ULID
  store_id: ULID
  name: string
  category: string
  unit_label: string
  pack_size: number
  pack_label: string
  sell_price: number | null
  archived: boolean
  updated_at: ISODateTime
}

/** P2 — BLUEPRINT §C. */
export interface Customer {
  id: ULID
  store_id: ULID
  name: string
  phone: string | null
  archived: boolean
  updated_at: ISODateTime
}

// ---------- Events (append-only, write-once by id) ----------

export type AdjustReason = 'sira' | 'expired' | 'personal' | 'iba'
export type ExpenseCategory = 'kuryente' | 'tubig' | 'pamasahe' | 'load' | 'renta' | 'iba'
export const EXPENSE_CATEGORIES: ExpenseCategory[] = ['kuryente', 'tubig', 'pamasahe', 'load', 'renta', 'iba']

interface EventBase {
  id: EventId
  v: 1
  store_id: ULID
  device_id: ULID
  /** When the fact was true. User-editable. Drives the total order. */
  ts: ISODateTime
  /** When the device wrote it. Audit only — derivation never reads this. */
  recorded_at: ISODateTime
}

export interface PurchaseEvent extends EventBase {
  type: 'PURCHASE'
  product_id: ULID
  /** Always selling units, resolved at entry with the then-current pack_size. */
  qty_units: number
  total_cost: number | null
  supplier?: string
}
export interface CountEvent extends EventBase {
  type: 'COUNT'
  product_id: ULID
  qty_on_hand: number
}
export interface AdjustEvent extends EventBase {
  type: 'ADJUST'
  product_id: ULID
  /** Negative = removed from sellable stock. */
  delta: number
  reason: AdjustReason
}
export interface VoidEvent extends EventBase {
  type: 'VOID'
  /** Must reference a non-VOID event. */
  target: EventId
}

// P2 finance events — BLUEPRINT §C / §E6. Amounts are pesos > 0 (validated at entry only).
export interface UtangEvent extends EventBase {
  type: 'UTANG'
  customer_id: ULID
  amount: number
  note?: string
}
export interface BayadEvent extends EventBase {
  type: 'BAYAD'
  customer_id: ULID
  amount: number
}
export interface ExpenseEvent extends EventBase {
  type: 'EXPENSE'
  amount: number
  category: ExpenseCategory
  note?: string
}
export interface CashCountEvent extends EventBase {
  type: 'CASH_COUNT'
  amount: number
}

export type StockEvent = PurchaseEvent | CountEvent | AdjustEvent
export type FinanceEvent = UtangEvent | BayadEvent | ExpenseEvent | CashCountEvent
/** Every non-VOID event. */
export type ActiveEvent = StockEvent | FinanceEvent
export type DomainEvent = ActiveEvent | VoidEvent
export type EventType = DomainEvent['type']

// ---------- Derived state (memory only) ----------

export type Tier = 'none' | 'cadence' | 'counts'
export type Confidence = 'none' | 'low' | 'mid' | 'high'
export type Urgency = 'red' | 'orange' | 'yellow' | 'green'
export type Section = 'bilhin_na' | 'bilhin' | 'wag_muna'

export type ProductFlag =
  | 'bago'
  | 'needs_count'
  | 'slow'
  | 'dead'
  | 'inconsistent'
  | 'dormant'
  | 'unclear'
  | 'no_cost'
  | 'no_price'
  | 'lugi_check'
  | 'count_mismatch'

export interface Sample {
  rate: number
  days: number
  /** ms epoch of the interval start (c1.ts) and end (c2.ts) */
  startMs: number
  endMs: number
  /** rate after the 3x median cap (equals rate when uncapped) */
  cappedRate: number
}

export interface Cadence {
  /** units/day the owner goes through what they buy. NOT confirmed sales demand. */
  throughput: number
  typical_units: number
  n: number
  cycles: number[]
  rebuy: { early: LocalDate; mid: LocalDate; late: LocalDate; midMs: number }
  dormant: boolean
}

export interface ProductState {
  product_id: ULID
  tier: Tier
  confidence: Confidence
  anchor: { ts: ISODateTime; qty: number } | null
  anchor_ms: number | null
  /** Σ PURCHASE.qty + Σ ADJUST.delta strictly after the anchor (0 when no anchor). */
  net_since_anchor: number
  on_hand_est: number | null
  days_since_count: number | null
  daily_rate: number | null
  days_left: number | null
  cadence: Cadence | null
  /** Tier A-eligibility reason when cadence is null or unusable. */
  cadence_status: 'ok' | 'n<3' | 'span<7' | 'unclear' | null
  samples: Sample[]
  unit_cost: number | null
  tubo_per_unit: number | null
  flags: Set<ProductFlag>
}

export interface ListLine {
  product_id: ULID
  tier: 'cadence' | 'counts'
  urgency: Exclude<Urgency, 'green'>
  section: Section
  buy_packs: number
  buy_units: number
  range: [number, number] | null
  cost: number | null
  priority: number
  reason: string
  hint: string | null
  /** Tier B only: true when at_trip < 0 */
  before_trip: boolean
  /** Tier B only: days_since_count > 14, or (red/orange and > 7) */
  needs_count: boolean
}

export interface ShoppingList {
  next_trip: LocalDate
  following: LocalDate
  lines: ListLine[]
  total_known_cost: number
  unknown_cost_count: number
  banner: string | null
}

// ---------- P2 derived finance state (memory only) — BLUEPRINT §E6 ----------

export interface CustomerState {
  customer_id: ULID
  /** Σ UTANG − Σ BAYAD; negative = sobra (advance). */
  balance: number
  total_utang: number
  total_bayad: number
  last_utang_ts: ISODateTime | null
  last_bayad_ts: ISODateTime | null
  /** FIFO: first UTANG whose cumulative sum exceeds Σ BAYAD; null when balance ≤ 0. */
  oldest_unpaid_ts: ISODateTime | null
}

export interface WeekSummary {
  /** Monday of the week (local). */
  start: LocalDate
  /** Sunday of the week (local). */
  end: LocalDate
  gastos: number
  nabili: number
  utang_given: number
  utang_received: number
  cash_count: number | null
  /** utang_outstanding using events with ts ≤ end of the week. */
  outstanding_end: number
}

export interface StoreState {
  cash_last: { ts: ISODateTime; amount: number } | null
  utang_outstanding: number
  weeks: WeekSummary[]
  tantiya: {
    /** Σ rate·7·sell_price over Tier B products with a rate; exact, UI rounds to ₱10. */
    benta: number
    tubo: number
    /** products included / skipped for lack of sell_price or cost */
    products: number
    skipped: number
  }
}

export interface BudgetLine {
  product_id: ULID
  /** packs affordable in greedy order (≥ 1 for every listed line with a known cost) */
  packs: number
  /** true when packs < the line's buy_packs */
  reduced: boolean
  spend: number
}

export interface BudgetResult {
  budget: number
  lines: BudgetLine[]
  /** max(0, total_known_cost − budget) */
  kulang: number
  spent: number
}

export interface TripContext {
  today: LocalDate
  next_trip: LocalDate
  following: LocalDate
}
