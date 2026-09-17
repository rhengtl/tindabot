// Pure codec between local objects and cloud rows (BLUEPRINT §G P3, decided P3a).
// Every row carries the full local object verbatim in `body`, so events and records round-trip
// byte-exact (ISO `ts` strings with offsets, optional fields such as `note`/`supplier`). The
// extracted columns exist only for indexing and policies. No IO here.

import type { Customer, DomainEvent, Product, Store } from '../domain'

/**
 * A pull window. `server_seq`/`server_rev` are allocated when a transaction writes, not when it
 * commits, so a row with a LOWER sequence can become visible AFTER a higher one — reading by
 * sequence alone could step over a row that had not committed yet and never come back for it.
 * Every row therefore also carries `xid`, the id of the transaction that wrote it, and the server
 * reports the lowest still-running transaction (`sync_watermark`). Restricting a pull to
 * `xid < watermark` means every transaction in the window had already finished when the watermark
 * was taken: the window is a frozen set that can never grow, so paging through it is complete and
 * the cursor may advance to `watermark - 1` once it is drained.
 */
export interface PullWindow {
  /** exclusive lower bound — every row with xid ≤ this is already local */
  afterXid: number
  /** exclusive upper bound — the run's committed high-water mark */
  beforeXid: number
  /** keyset page cursor inside the window: server_seq (events) or server_rev (records) */
  after: number
}

/** An unfinished window, persisted so an interrupted pull resumes in the same frozen set. */
export interface PendingWindow {
  hi: number
  seq: number
}

export function formatWindow(hi: number, seq: number): string {
  return JSON.stringify({ hi, seq })
}

export function parseWindow(raw: string | null | undefined): PendingWindow | null {
  if (!raw) return null
  try {
    const o: unknown = JSON.parse(raw)
    if (!o || typeof o !== 'object') return null
    const { hi, seq } = o as Record<string, unknown>
    if (!Number.isSafeInteger(hi) || !Number.isSafeInteger(seq)) return null
    if ((hi as number) <= 0 || (seq as number) < 0) return null
    return { hi: hi as number, seq: seq as number }
  } catch {
    return null
  }
}

export interface StoreRow {
  id: string
  body: Store
  updated_at: string
  /** Set by the server; absent on rows the client builds. */
  server_rev?: number
  archived_at?: string | null
  created_by?: string
}

export interface RecordRow<T = Product | Customer> {
  id: string
  store_id: string
  body: T
  updated_at: string
  server_rev?: number
  /** transaction that wrote the row (server-assigned) */
  xid?: number
}

export interface EventRow {
  id: string
  store_id: string
  type: string
  ts: string
  body: DomainEvent
  server_seq?: number
  /** transaction that wrote the row (server-assigned) */
  xid?: number
}

const EVENT_TYPES = new Set(['PURCHASE', 'COUNT', 'ADJUST', 'UTANG', 'BAYAD', 'EXPENSE', 'CASH_COUNT', 'VOID'])

export function storeToRow(s: Store): StoreRow {
  return { id: s.id, body: s, updated_at: s.updated_at }
}

export function recordToRow<T extends Product | Customer>(r: T): RecordRow<T> {
  return { id: r.id, store_id: r.store_id, body: r, updated_at: r.updated_at }
}

export function eventToRow(e: DomainEvent): EventRow {
  return { id: e.id, store_id: e.store_id, type: e.type, ts: e.ts, body: e }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x)
}

/**
 * Decoders return null for rows whose body does not agree with the row's own columns or lacks the
 * fields the domain relies on. Callers skip such rows; a bad row must never abort a pull.
 */
export function rowToStore(row: StoreRow): Store | null {
  const b = row.body as unknown
  if (!isObj(b) || b.id !== row.id || typeof b.name !== 'string' || !Array.isArray(b.restock_days) || typeof b.updated_at !== 'string' || !isObj(b.multipliers)) return null
  return b as unknown as Store
}

export function rowToProduct(row: RecordRow): Product | null {
  const b = row.body as unknown
  if (!isObj(b) || b.id !== row.id || b.store_id !== row.store_id || typeof b.name !== 'string' || typeof b.pack_size !== 'number' || typeof b.updated_at !== 'string') return null
  return b as unknown as Product
}

export function rowToCustomer(row: RecordRow): Customer | null {
  const b = row.body as unknown
  if (!isObj(b) || b.id !== row.id || b.store_id !== row.store_id || typeof b.name !== 'string' || typeof b.updated_at !== 'string') return null
  return b as unknown as Customer
}

export function rowToEvent(row: EventRow): DomainEvent | null {
  const b = row.body as unknown
  if (!isObj(b) || b.id !== row.id || b.store_id !== row.store_id || b.v !== 1) return null
  if (typeof b.type !== 'string' || !EVENT_TYPES.has(b.type) || b.type !== row.type) return null
  if (typeof b.ts !== 'string' || b.ts !== row.ts || typeof b.recorded_at !== 'string' || typeof b.device_id !== 'string') return null
  return b as unknown as DomainEvent
}

/** Decodes a page, keeping the valid ones and counting the rest. */
export function decodeAll<R, T>(rows: R[], decode: (r: R) => T | null): { items: T[]; skipped: number } {
  const items: T[] = []
  let skipped = 0
  for (const r of rows) {
    const t = decode(r)
    if (t) items.push(t)
    else skipped++
  }
  return { items, skipped }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// ---------- cursors (integers persisted as strings in Dexie meta) ----------

export function parseCursor(raw: string | null | undefined): number {
  const n = raw == null ? NaN : Number(raw)
  return Number.isSafeInteger(n) && n >= 0 ? n : 0
}

/** Highest server sequence seen in a page (0 when the page is empty). */
export function maxSeq(rows: Array<{ server_seq?: number } | { server_rev?: number }>, key: 'server_seq' | 'server_rev'): number {
  let m = 0
  for (const r of rows) {
    const v = (r as Record<string, unknown>)[key]
    if (typeof v === 'number' && v > m) m = v
  }
  return m
}

export const EVENT_PUSH_BATCH = 500
export const PULL_PAGE = 500
export const SKEW_WARN_MS = 5 * 60_000

/** Positive = device clock ahead of the server. */
export function clockSkewMs(deviceNowMs: number, serverNowIso: string): number | null {
  const s = Date.parse(serverNowIso)
  return Number.isFinite(s) ? deviceNowMs - s : null
}
