// Demo store: a small sari-sari store with three weeks of realistic entries, dated relative
// to today so the list is always live. Products cover Tier B (count-at-restock), Tier A
// (purchases only), hybrid (one count), and no-data cases.

import { type Customer, type DomainEvent, type Product, addDays, localTimeMs, toISOWithOffset, toLocalDate, ulid } from '../domain'
import * as repo from '../db/repo'

interface Spec {
  name: string
  category: string
  unit: string
  pack: number
  packLabel: string
  sell: number | null
  costPerUnit: number
  /** day offsets (negative = days ago) of purchases; qty in packs */
  purchases: Array<[number, number]>
  /** day offsets of counts with natira (units); if same day as a purchase → linked count-at-restock */
  counts: Array<[number, number]>
}

const SPECS: Spec[] = [
  { name: 'Lucky Me Pancit Canton Original', category: 'Noodles', unit: 'pack', pack: 24, packLabel: 'box', sell: 16, costPerUnit: 13.75,
    purchases: [[-16, 2], [-13, 2], [-9, 2], [-6, 2], [-2, 2]], counts: [[-16, 10], [-13, 22], [-9, 19], [-6, 30], [-2, 15]] },
  { name: 'Coca-Cola 1.5L', category: 'Softdrinks', unit: 'bote', pack: 12, packLabel: 'case', sell: 75, costPerUnit: 65,
    purchases: [[-23, 1], [-19, 1], [-15, 1], [-11, 1], [-7, 1], [-3, 1]], counts: [] },
  { name: 'Sprite 1.5L', category: 'Softdrinks', unit: 'bote', pack: 12, packLabel: 'case', sell: 75, costPerUnit: 65,
    purchases: [[-31, 1], [-18, 1]], counts: [[-38, 44], [-32, 26], [-19, 20]] },
  { name: 'Sinandomeng Rice (1kg)', category: 'Bigas', unit: 'kilo', pack: 25, packLabel: 'sako', sell: 60, costPerUnit: 52,
    purchases: [[-14, 1], [-7, 1]], counts: [[-14, 6], [-7, 8], [-1, 12]] },
  { name: 'Century Tuna Hot & Spicy 155g', category: 'De lata', unit: 'lata', pack: 24, packLabel: 'box', sell: 45, costPerUnit: 38,
    purchases: [[-20, 1], [-10, 1]], counts: [[-20, 5], [-10, 3], [-1, 14]] },
  { name: 'Ligo Sardines Tomato Sauce 155g', category: 'De lata', unit: 'lata', pack: 50, packLabel: 'box', sell: 26, costPerUnit: 22,
    purchases: [[-40, 1]], counts: [[-40, 4], [-10, 22], [-1, 18]] },
  { name: 'Eden Cheese 160g', category: 'Kape at gatas', unit: 'piraso', pack: 12, packLabel: 'box', sell: 97, costPerUnit: 85,
    purchases: [[-59, 1]], counts: [[-59, 2], [-29, 12], [-1, 8]] },
  { name: 'Kopiko Brown Coffee', category: 'Kape at gatas', unit: 'sachet', pack: 30, packLabel: 'pack', sell: 9, costPerUnit: 7,
    purchases: [[-12, 2], [-8, 2], [-4, 2], [-1, 2]], counts: [] },
  { name: 'Safeguard 55g', category: 'Sabon at shampoo', unit: 'bar', pack: 12, packLabel: 'pack', sell: 28, costPerUnit: 22,
    purchases: [[-5, 1]], counts: [[-5, 3]] },
  { name: 'Itlog (piraso)', category: 'Itlog at iba pa', unit: 'piraso', pack: 30, packLabel: 'tray', sell: 10, costPerUnit: 8,
    purchases: [[-9, 2], [-6, 2], [-3, 2]], counts: [[-9, 4], [-6, 9], [-3, 6]] },
  { name: 'Bear Brand Powdered Milk 33g', category: 'Kape at gatas', unit: 'sachet', pack: 24, packLabel: 'box', sell: 14, costPerUnit: 11,
    purchases: [], counts: [] },
]

/** Opens the demo: the one already on this device if there is one, otherwise a new one. */
export async function openDemo(): Promise<void> {
  const existing = await repo.demoStoreId()
  if (existing) await repo.setCurrentStore(existing)
  else await loadDemo()
}

export async function loadDemo(): Promise<void> {
  const deviceId = await repo.deviceId()
  const store = await repo.createStore('Tindahan ni Aling Nena (demo)', [3, 6])
  await repo.setLocalOnly(store.id) // P3a: the demo never syncs and is never claimed
  const today = toLocalDate(Date.now())
  const at = (offset: number, hour: number) => toISOWithOffset(localTimeMs(addDays(today, offset), hour))
  const now = toISOWithOffset(Date.now())
  const events: DomainEvent[] = []
  const products: Product[] = []
  for (const s of SPECS) {
    const p: Product = {
      id: ulid(),
      store_id: store.id,
      name: s.name,
      category: s.category,
      unit_label: s.unit,
      pack_size: s.pack,
      pack_label: s.packLabel,
      sell_price: s.sell,
      archived: false,
      updated_at: now,
    }
    products.push(p)
    const base = { v: 1 as const, store_id: store.id, device_id: deviceId, recorded_at: now }
    const purchaseDays = new Set(s.purchases.map(([d]) => d))
    for (const [d, natira] of s.counts) {
      // linked count-at-restock shares the purchase's ts (10:00); standalone counts are at 21:00
      events.push({ ...base, id: ulid(), type: 'COUNT', product_id: p.id, qty_on_hand: natira, ts: at(d, purchaseDays.has(d) ? 10 : 21) })
    }
    for (const [d, packs] of s.purchases) {
      const qty = packs * s.pack
      events.push({ ...base, id: ulid(), type: 'PURCHASE', product_id: p.id, qty_units: qty, total_cost: Math.round(qty * s.costPerUnit), ts: at(d, 10) })
    }
  }
  for (const p of products) await repo.saveProduct(p)

  // P2: customers, utang/bayad, gastos, cash counts (relative dates)
  const base = { v: 1 as const, store_id: store.id, device_id: deviceId, recorded_at: now }
  const custs: Array<[string, string | null, Array<['UTANG' | 'BAYAD', number, number, string?]>]> = [
    ['Aling Rosa', '0917 555 0101', [['UTANG', -12, 120, 'bigas, itlog'], ['UTANG', -6, 85, 'canton, coke'], ['BAYAD', -4, 100], ['UTANG', -1, 60, 'load']]],
    ['Mang Ben', null, [['UTANG', -20, 250, 'sigarilyo'], ['BAYAD', -15, 250], ['UTANG', -3, 40]]],
    ['Ate Joy', null, [['UTANG', -9, 75], ['BAYAD', -8, 100]]],
    ['Kuya Dan', null, [['UTANG', -35, 300, 'gatas, sardinas'], ['BAYAD', -30, 50]]],
  ]
  for (const [name, phone, rows] of custs) {
    const c: Customer = { id: ulid(), store_id: store.id, name, phone, archived: false, updated_at: now }
    await repo.saveCustomer(c)
    for (const [type, d, amount, note] of rows) {
      if (type === 'UTANG') events.push({ ...base, id: ulid(), type, customer_id: c.id, amount, ...(note ? { note } : {}), ts: at(d, 12) })
      else events.push({ ...base, id: ulid(), type, customer_id: c.id, amount, ts: at(d, 12) })
    }
  }
  const gastos: Array<[number, number, 'kuryente' | 'tubig' | 'pamasahe' | 'load' | 'renta' | 'iba', string?]> = [
    [-13, 1250, 'kuryente'], [-10, 60, 'pamasahe', 'palengke'], [-6, 60, 'pamasahe', 'palengke'], [-5, 100, 'load'], [-2, 60, 'pamasahe', 'palengke'],
  ]
  for (const [d, amount, category, note] of gastos) events.push({ ...base, id: ulid(), type: 'EXPENSE', amount, category, ...(note ? { note } : {}), ts: at(d, 12) })
  for (const [d, amount] of [[-14, 3200], [-7, 2850], [-1, 3410]] as Array<[number, number]>) events.push({ ...base, id: ulid(), type: 'CASH_COUNT', amount, ts: at(d, 20) })

  await repo.addEvents(events)
}
