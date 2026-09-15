// App state — loads the snapshot from Dexie, recomputes derived state after every write.
// All business math lives in domain/; this file only wires storage → domain → UI.

import { create } from 'zustand'
import {
  type Customer,
  type CustomerState,
  type DomainEvent,
  type ExpenseCategory,
  type LocalDate,
  type Product,
  type ProductState,
  type ShoppingList,
  type Store,
  type StoreState,
  type Weekday,
  activeEvents,
  addDays,
  buildExport,
  buildList,
  customerIds,
  deriveCustomer,
  deriveProduct,
  deriveStoreFinance,
  forProduct,
  isExportFile,
  localTimeMs,
  toISOWithOffset,
  toLocalDate,
  ulid,
} from '../domain'
import type { CatalogItem } from '../catalog/catalog'
import * as repo from '../db/repo'
import { type Cloud, type SyncEngine as SyncEngineT, type SyncReason, type SyncStatus, createCloud } from '../sync'
import { SyncEngine } from '../sync/engine'

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

/** P2 finance drafts — ids generated when the form opens (idempotent submit). */
export interface FinanceDraft {
  id: string
  amount: number
  when: DateChoice
}

interface AppState {
  loaded: boolean
  onboarded: boolean
  store: Store | null
  products: Product[]
  customers: Customer[]
  events: DomainEvent[]
  states: Map<string, ProductState>
  customerStates: Map<string, CustomerState>
  finance: StoreState | null
  list: ShoppingList | null
  nowMs: number
  deviceId: string
  persisted: boolean
  /** P3a — absent configuration means `available: false` and every cloud action is a no-op. */
  cloud: { available: boolean; sync: SyncStatus }

  init(): Promise<void>
  refreshNow(): void
  createStore(name: string, restockDays: Weekday[]): Promise<void>
  updateStore(patch: Partial<Pick<Store, 'name' | 'restock_days' | 'next_trip_override' | 'multipliers'>>): Promise<void>
  addProduct(item: Pick<CatalogItem, 'name' | 'category' | 'unit_label' | 'pack_size' | 'pack_label'>, sellPrice: number | null, natira: number | null): Promise<Product>
  saveProduct(p: Product): Promise<void>
  recordPurchase(d: PurchaseDraft): Promise<void>
  recordCount(id: string, productId: string, qty: number, when: DateChoice): Promise<void>
  recordAdjust(id: string, productId: string, delta: number, reason: 'sira' | 'expired' | 'personal' | 'iba'): Promise<void>
  addCustomer(name: string, phone: string | null): Promise<Customer>
  saveCustomer(c: Customer): Promise<void>
  recordUtang(d: FinanceDraft & { customer_id: string; note: string | null }): Promise<void>
  recordBayad(d: FinanceDraft & { customer_id: string }): Promise<void>
  recordExpense(d: FinanceDraft & { category: ExpenseCategory; note: string | null }): Promise<void>
  recordCashCount(d: FinanceDraft): Promise<void>
  voidEvent(targetId: string): Promise<void>
  restoreEvent(original: DomainEvent): Promise<void>
  exportJson(): string
  importJson(text: string, mode: 'merge' | 'replace'): Promise<{ added_events: number; updated_products: number; updated_customers: number; sameStore: boolean }>
  meta(key: string): Promise<string | null>
  setMeta(key: string, value: string): Promise<void>
  // P3a cloud backup
  signInGoogle(): Promise<void>
  signOutCloud(): Promise<void>
  syncNow(): Promise<void>
  requestSync(reason: SyncReason): void
  resolveClaim(choice: 'phone' | 'cloud' | 'later'): Promise<void>
}

const SYNC_INITIAL: SyncStatus = {
  phase: 'signed_out',
  user: null,
  boundStoreId: null,
  lastSyncAt: null,
  pendingEvents: 0,
  pendingRecords: 0,
  error: null,
  skewMs: null,
  skewWarning: false,
  choice: null,
}

// One cloud client + engine per page; created lazily on the first init() when configured.
let cloud: Cloud | null = null
let engine: SyncEngineT | null = null
let initialized = false

function nowIso(): string {
  return toISOWithOffset(Date.now())
}

/** BLUEPRINT §C backdating rules. */
export function resolveTs(when: DateChoice, kind: 'PURCHASE' | 'COUNT' | 'FINANCE'): string {
  if (when.kind === 'ngayon') return nowIso()
  const date = when.kind === 'kahapon' ? addDays(toLocalDate(Date.now()), -1) : when.date
  return toISOWithOffset(localTimeMs(date, kind === 'COUNT' ? 21 : 12))
}

function derive(store: Store, products: Product[], events: DomainEvent[], nowMs: number) {
  const active = activeEvents(events)
  const states = new Map<string, ProductState>()
  for (const p of products) states.set(p.id, deriveProduct(p, forProduct(active, p.id), nowMs))
  const list = buildList({ store, products, states, nowMs })
  const customerStates = new Map<string, CustomerState>()
  for (const id of customerIds(active)) customerStates.set(id, deriveCustomer(id, active))
  const finance = deriveStoreFinance({ events: active, products, states, nowMs })
  return { states, list, customerStates, finance }
}

export const useApp = create<AppState>((set, get) => {
  async function reload(nowMs = Date.now()) {
    const store = await repo.currentStore()
    if (!store) {
      set({ loaded: true, store: null, products: [], customers: [], events: [], states: new Map(), customerStates: new Map(), finance: null, list: null, nowMs })
      return
    }
    const snap = await repo.loadSnapshot(store.id)
    if (!snap) return
    const d = derive(snap.store, snap.products, snap.events, nowMs)
    set({ loaded: true, store: snap.store, products: snap.products, customers: snap.customers, events: snap.events, ...d, nowMs })
  }

  /** After a local write: recompute, then let the engine push (debounced). Pulls call reload() only. */
  async function commit() {
    await reload()
    engine?.requestSync('write')
  }

  function ensureEngine() {
    if (engine || cloud) return
    cloud = createCloud()
    if (!cloud) return
    engine = new SyncEngine({
      api: cloud.api,
      onPulled: () => reload(),
      onStatus: (sync) => set({ cloud: { available: true, sync } }),
    })
    set({ cloud: { available: true, sync: engine.status } })
    cloud.auth.onChange((user) => engine?.setUser(user))
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
    customers: [],
    events: [],
    states: new Map(),
    customerStates: new Map(),
    finance: null,
    list: null,
    nowMs: Date.now(),
    deviceId: '',
    persisted: false,
    cloud: { available: false, sync: SYNC_INITIAL },

    async init() {
      const [deviceId, persisted, onboarded] = await Promise.all([repo.deviceId(), repo.requestPersistentStorage(), repo.getMeta('onboarded')])
      set({ deviceId, persisted, onboarded: onboarded === '1' })
      await reload()
      ensureEngine()
      // First launch: evaluate the cloud binding (may resume a pending claim). A re-init after
      // "Subukan ang demo" only re-checks locally, so the demo is not switched away automatically.
      engine?.requestSync(initialized ? 'write' : 'init')
      initialized = true
    },

    refreshNow() {
      const s = get()
      if (!s.store) return
      const nowMs = Date.now()
      set({ nowMs, ...derive(s.store, s.products, s.events, nowMs) })
    },

    async createStore(name, restockDays) {
      await repo.createStore(name, restockDays)
      await commit()
    },

    async updateStore(patch) {
      const s = get().store
      if (!s) return
      await repo.saveStore({ ...s, ...patch })
      await commit()
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
      await commit()
      return p
    },

    async saveProduct(p) {
      await repo.saveProduct(p)
      await commit()
    },

    async recordPurchase(d) {
      const ts = resolveTs(d.when, 'PURCHASE')
      const events: DomainEvent[] = []
      // Linked count-at-restock: same ts as the purchase; COUNT sorts first by type rank.
      if (d.natira !== null) events.push({ ...base(), id: d.countId, type: 'COUNT', product_id: d.product_id, qty_on_hand: d.natira, ts })
      events.push({ ...base(), id: d.id, type: 'PURCHASE', product_id: d.product_id, qty_units: d.qty_units, total_cost: d.total_cost, ts })
      await repo.addEvents(events)
      await commit()
    },

    async recordCount(id, productId, qty, when) {
      await repo.addEvents([{ ...base(), id, type: 'COUNT', product_id: productId, qty_on_hand: qty, ts: resolveTs(when, 'COUNT') }])
      await commit()
    },

    async recordAdjust(id, productId, delta, reason) {
      await repo.addEvents([{ ...base(), id, type: 'ADJUST', product_id: productId, delta, reason, ts: nowIso() }])
      await commit()
    },

    async addCustomer(name, phone) {
      const c: Customer = { id: ulid(), store_id: get().store!.id, name, phone, archived: false, updated_at: nowIso() }
      await repo.saveCustomer(c)
      await commit()
      return c
    },

    async saveCustomer(c) {
      await repo.saveCustomer(c)
      await commit()
    },

    async recordUtang(d) {
      await repo.addEvents([{ ...base(), id: d.id, type: 'UTANG', customer_id: d.customer_id, amount: d.amount, ...(d.note ? { note: d.note } : {}), ts: resolveTs(d.when, 'FINANCE') }])
      await commit()
    },

    async recordBayad(d) {
      await repo.addEvents([{ ...base(), id: d.id, type: 'BAYAD', customer_id: d.customer_id, amount: d.amount, ts: resolveTs(d.when, 'FINANCE') }])
      await commit()
    },

    async recordExpense(d) {
      await repo.addEvents([{ ...base(), id: d.id, type: 'EXPENSE', amount: d.amount, category: d.category, ...(d.note ? { note: d.note } : {}), ts: resolveTs(d.when, 'FINANCE') }])
      await commit()
    },

    async recordCashCount(d) {
      await repo.addEvents([{ ...base(), id: d.id, type: 'CASH_COUNT', amount: d.amount, ts: resolveTs(d.when, 'FINANCE') }])
      await commit()
    },

    async voidEvent(targetId) {
      const target = get().events.find((e) => e.id === targetId)
      if (!target || target.type === 'VOID') return
      await repo.addEvents([{ ...base(), id: ulid(), type: 'VOID', target: targetId, ts: nowIso() }])
      await commit()
    },

    async restoreEvent(original) {
      if (original.type === 'VOID') return
      const copy = { ...original, id: ulid(), recorded_at: nowIso() } as DomainEvent
      await repo.addEvents([copy])
      await commit()
    },

    exportJson() {
      const s = get()
      const file = buildExport({ store: s.store!, products: s.products, customers: s.customers, events: s.events }, s.deviceId, nowIso())
      return JSON.stringify(file, null, 1)
    },

    async importJson(text, mode) {
      const parsed: unknown = JSON.parse(text)
      if (!isExportFile(parsed)) throw new Error('Hindi ito TindaBot export file.')
      const cur = get().store
      const sameStore = !!cur && cur.id === parsed.store.id
      if (mode === 'merge' && !sameStore) throw new Error('different_store')
      const r = await repo.importFile(parsed, sameStore ? 'merge' : 'replace')
      await commit()
      return { ...r, sameStore }
    },

    meta: repo.getMeta,
    setMeta: repo.setMeta,

    async signInGoogle() {
      if (!cloud) return
      await cloud.auth.signInWithGoogle()
    },

    async signOutCloud() {
      if (!cloud) return
      await cloud.auth.signOut() // local data untouched; sync simply stops
      engine?.setUser(null)
    },

    async syncNow() {
      await engine?.syncNow()
    },

    requestSync(reason) {
      engine?.requestSync(reason)
    },

    async resolveClaim(choice) {
      await engine?.resolveClaim(choice)
    },
  }
})
