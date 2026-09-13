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

// ---------- Events (append-only, write-once by id) ----------

export type AdjustReason = 'sira' | 'expired' | 'personal' | 'iba'

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

export type StockEvent = PurchaseEvent | CountEvent | AdjustEvent
export type DomainEvent = StockEvent | VoidEvent
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

export interface TripContext {
  today: LocalDate
  next_trip: LocalDate
  following: LocalDate
}
