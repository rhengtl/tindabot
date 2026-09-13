// App state — loads the snapshot from Dexie, recomputes derived state after every write.
// All business math lives in domain/; this file only wires storage → domain → UI.

import { create } from 'zustand'
import {
  type DomainEvent,
  type LocalDate,
  type Product,
  type ProductState,
  type ShoppingList,
  type Store,
  type Weekday,
  activeEvents,
  addDays,
  buildExport,
  buildList,
  deriveProduct,
  forProduct,
  isExportFile,
  localTimeMs,
  toISOWithOffset,
  toLocalDate,
  ulid,
} from '../domain'
import type { CatalogItem } from '../catalog/catalog'
import * as repo from '../db/repo'

export type DateChoice = { kind: 'ngayon' } | { kind: 'kahapon' } | { kind: 'date'; date: LocalDate }

export interface PurchaseDraft {
  id: string // generated when the form opened (idempotent submit)
  countId: string // id for the linked COUNT, if natira is given
  product_id: string
  qty_units: number
  total_cost: number | null
  natira: number | null
  when: DateChoice
}

interface AppState {
  loaded: boolean
  onboarded: boolean
  store: Store | null
  products: Product[]
  events: DomainEvent[]
  states: Map<string, ProductState>
  list: ShoppingList | null
  nowMs: number
  deviceId: string
  persisted: boolean

  init(): Promise<void>
  refreshNow(): void
  createStore(name: string, restockDays: Weekday[]): Promise<void>
  updateStore(patch: Partial<Pick<Store, 'name' | 'restock_days' | 'next_trip_override' | 'multipliers'>>): Promise<void>
  addProduct(item: Pick<CatalogItem, 'name' | 'category' | 'unit_label' | 'pack_size' | 'pack_label'>, sellPrice: number | null, natira: number | null): Promise<Product>
  saveProduct(p: Product): Promise<void>
  recordPurchase(d: PurchaseDraft): Promise<void>
  recordCount(id: string, productId: string, qty: number, when: DateChoice): Promise<void>
  recordAdjust(id: string, productId: string, delta: number, reason: 'sira' | 'expired' | 'personal' | 'iba'): Promise<void>
  voidEvent(targetId: string): Promise<void>
  restoreEvent(original: DomainEvent): Promise<void>
  exportJson(): string
  importJson(text: string, mode: 'merge' | 'replace'): Promise<{ added_events: number; updated_products: number; sameStore: boolean }>
  meta(key: string): Promise<string | null>
  setMeta(key: string, value: string): Promise<void>
}

function nowIso(): string {
  return toISOWithOffset(Date.now())
}

/** BLUEPRINT §C backdating rules. */
export function resolveTs(when: DateChoice, kind: 'PURCHASE' | 'COUNT'): string {
  if (when.kind === 'ngayon') return nowIso()
  const date = when.kind === 'kahapon' ? addDays(toLocalDate(Date.now()), -1) : when.date
  return toISOWithOffset(localTimeMs(date, kind === 'COUNT' ? 21 : 12))
}

function derive(store: Store, products: Product[], events: DomainEvent[], nowMs: number) {
  const active = activeEvents(events)
  const states = new Map<string, ProductState>()
  for (const p of products) states.set(p.id, deriveProduct(p, forProduct(active, p.id), nowMs))
  const list = buildList({ store, products, states, nowMs })
  return { states, list }
}

export const useApp = create<AppState>((set, get) => {
  async function reload(nowMs = Date.now()) {
    const store = await repo.currentStore()
    if (!store) {
      set({ loaded: true, store: null, products: [], events: [], states: new Map(), list: null, nowMs })
      return
    }
    const snap = await repo.loadSnapshot(store.id)
    if (!snap) return
    const d = derive(snap.store, snap.products, snap.events, nowMs)
    set({ loaded: true, store: snap.store, products: snap.products, events: snap.events, ...d, nowMs })
  }

  function base(): Pick<DomainEvent, 'v' | 'store_id' | 'device_id' | 'recorded_at'> {
    const s = get()
    return { v: 1, store_id: s.store!.id, device_id: s.deviceId, recorded_at: nowIso() }
  }

  return {
    loaded: false,
    onboarded: false,
    store: null,
    products: [],
    events: [],
    states: new Map(),
    list: null,
    nowMs: Date.now(),
    deviceId: '',
    persisted: false,

    async init() {
      const [deviceId, persisted, onboarded] = await Promise.all([repo.deviceId(), repo.requestPersistentStorage(), repo.getMeta('onboarded')])
      set({ deviceId, persisted, onboarded: onboarded === '1' })
      await reload()
    },

    refreshNow() {
      const s = get()
      if (!s.store) return
      const nowMs = Date.now()
      set({ nowMs, ...derive(s.store, s.products, s.events, nowMs) })
    },

    async createStore(name, restockDays) {
      await repo.createStore(name, restockDays)
      await reload()
    },

    async updateStore(patch) {
      const s = get().store
      if (!s) return
      await repo.saveStore({ ...s, ...patch })
      await reload()
    },

    async addProduct(item, sellPrice, natira) {
      const s = get()
      const p: Product = {
        id: ulid(),
        store_id: s.store!.id,
        name: item.name,
        category: item.category,
        unit_label: item.unit_label,
        pack_size: item.pack_size,
        pack_label: item.pack_label,
        sell_price: sellPrice,
        archived: false,
        updated_at: nowIso(),
      }
      await repo.saveProduct(p)
      if (natira !== null) {
        await repo.addEvents([{ ...base(), id: ulid(), type: 'COUNT', product_id: p.id, qty_on_hand: natira, ts: nowIso() }])
      }
      await reload()
      return p
    },

    async saveProduct(p) {
      await repo.saveProduct(p)
      await reload()
    },

    async recordPurchase(d) {
      const ts = resolveTs(d.when, 'PURCHASE')
      const events: DomainEvent[] = []
      // Linked count-at-restock: same ts as the purchase; COUNT sorts first by type rank.
      if (d.natira !== null) events.push({ ...base(), id: d.countId, type: 'COUNT', product_id: d.product_id, qty_on_hand: d.natira, ts })
      events.push({ ...base(), id: d.id, type: 'PURCHASE', product_id: d.product_id, qty_units: d.qty_units, total_cost: d.total_cost, ts })
      await repo.addEvents(events)
      await reload()
    },

    async recordCount(id, productId, qty, when) {
      await repo.addEvents([{ ...base(), id, type: 'COUNT', product_id: productId, qty_on_hand: qty, ts: resolveTs(when, 'COUNT') }])
      await reload()
    },

    async recordAdjust(id, productId, delta, reason) {
      await repo.addEvents([{ ...base(), id, type: 'ADJUST', product_id: productId, delta, reason, ts: nowIso() }])
      await reload()
    },

    async voidEvent(targetId) {
      const target = get().events.find((e) => e.id === targetId)
      if (!target || target.type === 'VOID') return
      await repo.addEvents([{ ...base(), id: ulid(), type: 'VOID', target: targetId, ts: nowIso() }])
      await reload()
    },

    async restoreEvent(original) {
      if (original.type === 'VOID') return
      const copy = { ...original, id: ulid(), recorded_at: nowIso() } as DomainEvent
      await repo.addEvents([copy])
      await reload()
    },

    exportJson() {
      const s = get()
      const file = buildExport({ store: s.store!, products: s.products, events: s.events }, s.deviceId, nowIso())
      return JSON.stringify(file, null, 1)
    },

    async importJson(text, mode) {
      const parsed: unknown = JSON.parse(text)
      if (!isExportFile(parsed)) throw new Error('Hindi ito TindaBot export file.')
      const cur = get().store
      const sameStore = !!cur && cur.id === parsed.store.id
      if (mode === 'merge' && !sameStore) throw new Error('different_store')
      const r = await repo.importFile(parsed, sameStore ? 'merge' : 'replace')
      await reload()
      return { ...r, sameStore }
    },

    meta: repo.getMeta,
    setMeta: repo.setMeta,
  }
})
