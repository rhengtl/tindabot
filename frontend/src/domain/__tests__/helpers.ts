import { toMs } from '../calendar'
import { deriveProduct } from '../derive'
import { buildList } from '../list'
import { activeEvents, forProduct } from '../order'
import type { DomainEvent, ListLine, Product, ProductState, ShoppingList, Store, Weekday } from '../types'
import goldensJson from './goldens.json'
import scenariosJson from './scenarios.json'

export interface Scenario {
  id: string
  kind: 'tierA' | 'tierB'
  note: string
  now: string
  store: { restock_days: number[]; next_trip_override: string | null }
  product: { pack_size: number; sell_price: number | null; unit_label: string; pack_label: string }
  events: Array<Record<string, unknown> & { id: string; type: string; ts: string }>
}

export const scenarios = (scenariosJson as { scenarios: Scenario[] }).scenarios
export const goldens = goldensJson as Record<string, Record<string, any>>

export const STORE_ID = 'STORE0000000000000000000001'
export const DEVICE_ID = 'DEVICE000000000000000000001'
export const PRODUCT_ID = 'PROD00000000000000000000001'

export function makeStore(restockDays: number[], override: string | null): Store {
  return {
    id: STORE_ID,
    name: 'Test',
    restock_days: restockDays as Weekday[],
    next_trip_override: override,
    multipliers: { payday: 1.3, fri_sat: 1.15 },
    updated_at: '2026-01-01T00:00:00+08:00',
  }
}

export function makeProduct(p: Scenario['product'], id = PRODUCT_ID): Product {
  return {
    id,
    store_id: STORE_ID,
    name: 'Item',
    category: 'test',
    unit_label: p.unit_label,
    pack_size: p.pack_size,
    pack_label: p.pack_label,
    sell_price: p.sell_price,
    archived: false,
    updated_at: '2026-01-01T00:00:00+08:00',
  }
}

export function toEvents(raw: Scenario['events'], productId = PRODUCT_ID): DomainEvent[] {
  return raw.map((e) => ({
    ...(e as object),
    v: 1,
    store_id: STORE_ID,
    device_id: DEVICE_ID,
    recorded_at: e.ts,
    ...(e.type === 'VOID' ? {} : { product_id: productId }),
  })) as DomainEvent[]
}

export interface RunResult {
  state: ProductState
  list: ShoppingList
  line: ListLine | undefined
}

export function runScenario(s: Scenario, overrides?: { events?: DomainEvent[]; now?: string }): RunResult {
  const store = makeStore(s.store.restock_days, s.store.next_trip_override)
  const product = makeProduct(s.product)
  const events = overrides?.events ?? toEvents(s.events)
  const nowMs = toMs(overrides?.now ?? s.now)
  return run(store, product, events, nowMs)
}

export function run(store: Store, product: Product, events: DomainEvent[], nowMs: number): RunResult {
  const active = forProduct(activeEvents(events), product.id)
  const state = deriveProduct(product, active, nowMs)
  const list = buildList({ store, products: [product], states: new Map([[product.id, state]]), nowMs })
  return { state, list, line: list.lines.find((l) => l.product_id === product.id) }
}

export function shuffled<T>(xs: T[], seed: number): T[] {
  // deterministic LCG shuffle
  const out = xs.slice()
  let s = seed >>> 0
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}
