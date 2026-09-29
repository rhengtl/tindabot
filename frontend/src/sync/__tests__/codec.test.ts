import { describe, expect, it } from 'vitest'
import type { Customer, DomainEvent, Product, Store } from '../../domain'
import {
  chunk,
  clockSkewMs,
  decodeAll,
  eventToRow,
  maxSeq,
  parseCursor,
  recordToRow,
  rowToCustomer,
  rowToEvent,
  rowToProduct,
  rowToStore,
  storeToRow,
} from '../codec'
import { readCloudEnv } from '../env'

const STORE = 'STORE0000000000000000000001'
const base = { v: 1 as const, store_id: STORE, device_id: 'DEV00000000000000000000001', recorded_at: '2026-09-15T10:00:00.123+08:00' }

const EVENTS: DomainEvent[] = [
  { ...base, id: 'E1', type: 'PURCHASE', product_id: 'P1', qty_units: 24, total_cost: 780, ts: '2026-09-14T10:00:00+08:00' },
  { ...base, id: 'E2', type: 'PURCHASE', product_id: 'P1', qty_units: 12, total_cost: null, supplier: 'Puregold', ts: '2026-09-14T10:00:00+08:00' },
  { ...base, id: 'E3', type: 'COUNT', product_id: 'P1', qty_on_hand: 3, ts: '2026-09-14T21:00:00+08:00' },
  { ...base, id: 'E4', type: 'ADJUST', product_id: 'P1', delta: -2, reason: 'sira', ts: '2026-09-14T21:00:00.500+08:00' },
  { ...base, id: 'E5', type: 'UTANG', customer_id: 'C1', amount: 120.5, note: 'bigas, itlog', ts: '2026-09-13T12:00:00+08:00' },
  { ...base, id: 'E6', type: 'UTANG', customer_id: 'C1', amount: 60, ts: '2026-09-13T12:00:00+08:00' },
  { ...base, id: 'E7', type: 'BAYAD', customer_id: 'C1', amount: 100, ts: '2026-09-13T12:00:00-05:00' },
  { ...base, id: 'E8', type: 'EXPENSE', amount: 1250, category: 'kuryente', ts: '2026-09-12T12:00:00Z' },
  { ...base, id: 'E9', type: 'EXPENSE', amount: 60, category: 'pamasahe', note: 'palengke', ts: '2026-09-12T12:00:00+08:00' },
  { ...base, id: 'E10', type: 'CASH_COUNT', amount: 3410.75, ts: '2026-09-14T20:00:00+08:00' },
  { ...base, id: 'E11', type: 'VOID', target: 'E4', ts: '2026-09-15T09:00:00+08:00' },
]

const product: Product = { id: 'P1', store_id: STORE, name: 'Coke 1.5L', category: 'Softdrinks', unit_label: 'bote', pack_size: 12, pack_label: 'case', sell_price: null, archived: false, updated_at: '2026-09-01T00:00:00.000Z' }
const customer: Customer = { id: 'C1', store_id: STORE, name: 'Aling Rosa', phone: null, archived: true, updated_at: '2026-09-02T00:00:00+08:00' }
const store: Store = { id: STORE, name: 'Tindahan', restock_days: [3, 6], next_trip_override: null, multipliers: { payday: 1.3, fri_sat: 1.15 }, updated_at: '2026-09-03T00:00:00+08:00' }

describe('sync codec — byte-exact round trips', () => {
  it('every event type, optional fields and ts offsets survive row → event unchanged', () => {
    for (const e of EVENTS) {
      const row = JSON.parse(JSON.stringify(eventToRow(e))) // through JSON like PostgREST
      expect(row.id).toBe(e.id)
      expect(row.type).toBe(e.type)
      expect(row.ts).toBe(e.ts)
      const back = rowToEvent(row)
      expect(back).toEqual(e)
      expect(JSON.stringify(back)).toBe(JSON.stringify(e))
      expect(Object.keys(back!)).toEqual(Object.keys(e)) // no extra keys, no reordering
    }
  })

  it('records round-trip exactly, including null and offset-form updated_at', () => {
    expect(rowToProduct(JSON.parse(JSON.stringify(recordToRow(product))))).toEqual(product)
    expect(rowToCustomer(JSON.parse(JSON.stringify(recordToRow(customer))))).toEqual(customer)
    expect(rowToStore(JSON.parse(JSON.stringify(storeToRow(store))))).toEqual(store)
    expect(recordToRow(product).updated_at).toBe(product.updated_at)
    expect(storeToRow(store).updated_at).toBe(store.updated_at)
  })

  it('rows are rejected when body disagrees with the row columns or lacks required fields', () => {
    const ok = eventToRow(EVENTS[0]!)
    expect(rowToEvent({ ...ok, id: 'OTHER' })).toBeNull()
    expect(rowToEvent({ ...ok, store_id: 'OTHER' })).toBeNull()
    expect(rowToEvent({ ...ok, type: 'COUNT' })).toBeNull()
    expect(rowToEvent({ ...ok, ts: '2026-09-14T02:00:00Z' })).toBeNull() // same instant, different string
    expect(rowToEvent({ ...ok, body: { ...ok.body, v: 2 } as never })).toBeNull()
    expect(rowToEvent({ ...ok, body: { ...ok.body, type: 'SALE' } as never, type: 'SALE' })).toBeNull()
    expect(rowToEvent({ ...ok, body: null as never })).toBeNull()
    expect(rowToEvent({ ...ok, body: [] as never })).toBeNull()
    const pr = recordToRow(product)
    expect(rowToProduct({ ...pr, id: 'X' })).toBeNull()
    expect(rowToProduct({ ...pr, store_id: 'X' })).toBeNull()
    expect(rowToProduct({ ...pr, body: { ...product, pack_size: '12' } as never })).toBeNull()
    expect(rowToCustomer({ ...recordToRow(customer), body: { id: 'C1', store_id: STORE } as never })).toBeNull()
    const sr = storeToRow(store)
    expect(rowToStore({ ...sr, body: { ...store, restock_days: 'x' } as never })).toBeNull()
    expect(rowToStore({ ...sr, body: { ...store, multipliers: null } as never })).toBeNull()
  })

  it('decodeAll keeps valid rows and counts the bad ones instead of aborting', () => {
    const rows = EVENTS.map(eventToRow)
    rows[3] = { ...rows[3]!, id: 'bad' }
    const r = decodeAll(rows, rowToEvent)
    expect(r.items.length).toBe(EVENTS.length - 1)
    expect(r.skipped).toBe(1)
  })
})

describe('sync codec — cursors and batching', () => {
  it('parseCursor fails closed to 0 on anything that is not a non-negative safe integer', () => {
    expect(parseCursor(null)).toBe(0)
    expect(parseCursor(undefined)).toBe(0)
    expect(parseCursor('')).toBe(0)
    expect(parseCursor('abc')).toBe(0)
    expect(parseCursor('-5')).toBe(0)
    expect(parseCursor('1.5')).toBe(0)
    expect(parseCursor('42')).toBe(42)
    expect(parseCursor(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('maxSeq picks the highest sequence in a page and 0 for an empty page', () => {
    expect(maxSeq([], 'server_seq')).toBe(0)
    expect(maxSeq([{ server_seq: 3 }, { server_seq: 10 }, { server_seq: 7 }], 'server_seq')).toBe(10)
    expect(maxSeq([{ server_rev: 5 }, {}], 'server_rev')).toBe(5)
  })

  it('chunk splits into batches without losing or duplicating items', () => {
    const items = Array.from({ length: 1203 }, (_, i) => i)
    const parts = chunk(items, 500)
    expect(parts.map((p) => p.length)).toEqual([500, 500, 203])
    expect(parts.flat()).toEqual(items)
    expect(chunk([], 500)).toEqual([])
  })

  it('clockSkewMs is device minus server; unparsable server time gives null', () => {
    expect(clockSkewMs(Date.parse('2026-09-15T10:05:00Z'), '2026-09-15T10:00:00+00:00')).toBe(5 * 60_000)
    expect(clockSkewMs(Date.parse('2026-09-15T09:59:00Z'), '2026-09-15T10:00:00.123456+00:00')).toBeCloseTo(-60_123, -1)
    expect(clockSkewMs(0, 'nope')).toBeNull()
  })
})

describe('cloud env — fails closed', () => {
  it('returns null unless both a https URL and a plausible anon key are present', () => {
    expect(readCloudEnv({})).toBeNull()
    expect(readCloudEnv({ VITE_SUPABASE_URL: 'https://abc.supabase.co' })).toBeNull()
    expect(readCloudEnv({ VITE_SUPABASE_URL: 'http://abc.supabase.co', VITE_SUPABASE_ANON_KEY: 'x'.repeat(40) })).toBeNull()
    expect(readCloudEnv({ VITE_SUPABASE_URL: 'https://abc.supabase.co', VITE_SUPABASE_ANON_KEY: 'short' })).toBeNull()
    expect(readCloudEnv({ VITE_SUPABASE_URL: 'https://abc.supabase.co', VITE_SUPABASE_ANON_KEY: 'has space '.repeat(4) })).toBeNull()
    expect(readCloudEnv({ VITE_SUPABASE_URL: 'https://abc.supabase.co/', VITE_SUPABASE_ANON_KEY: 'x'.repeat(40) })).toBeNull()
    expect(readCloudEnv({ VITE_SUPABASE_URL: ' https://abc.supabase.co ', VITE_SUPABASE_ANON_KEY: ` ${'k'.repeat(40)} ` })).toEqual({ url: 'https://abc.supabase.co', anonKey: 'k'.repeat(40) })
  })

  // Referencing `import.meta.env` as an object makes Vite inline every VITE_* variable of the build
  // into the public bundle — including ones the host adds on its own (Vercel's commit author, commit
  // message and repository ids reached the first hosted bundle this way). Only named reads of the two
  // cloud settings may appear anywhere in the app's source.
  it('the app source reads only the two cloud settings from the build environment, by name', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) {
          if (name !== '__tests__') walk(p)
        } else if (/\.tsx?$/.test(name)) files.push(p)
      }
    }
    walk(root)
    const reads: string[] = []
    for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/import\.meta\.env(\.[A-Za-z_]\w*)?/g)) reads.push(m[0])
    expect(reads.length).toBeGreaterThan(0)
    expect([...new Set(reads)].sort()).toEqual(['import.meta.env.VITE_SUPABASE_ANON_KEY', 'import.meta.env.VITE_SUPABASE_URL'])
  })
})
