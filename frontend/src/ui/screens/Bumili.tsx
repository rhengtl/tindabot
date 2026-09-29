import { useEffect, useMemo, useState } from 'react'
import { CATALOG } from '../../catalog/catalog'
import { type Product, templates, toLocalDate, ulid } from '../../domain'
import { useApp, type DateChoice } from '../../state/store'
import { Segment, Sheet, useToast, useWrite } from '../components'
import { useStrings } from '../i18n'

const HIGH_COST_FACTOR = 5

export function BumiliSheet({ open, onClose, initialProductId }: { open: boolean; onClose: () => void; initialProductId?: string | null }) {
  const allProducts = useApp((s) => s.products)
  const products = useMemo(() => allProducts.filter((p) => !p.archived), [allProducts])
  const states = useApp((s) => s.states)
  const events = useApp((s) => s.events)
  const recordPurchase = useApp((s) => s.recordPurchase)
  const S = useStrings()
  const toast = useToast()
  const write = useWrite()

  const [ids, setIds] = useState(() => ({ id: ulid(), countId: ulid() }))
  const [productId, setProductId] = useState<string | null>(initialProductId ?? null)
  const [mode, setMode] = useState<'pack' | 'unit'>('pack')
  const [qty, setQty] = useState('1')
  const [cost, setCost] = useState('')
  const [costTouched, setCostTouched] = useState(false)
  const [natira, setNatira] = useState('')
  const [whenKind, setWhenKind] = useState<'ngayon' | 'kahapon' | 'date'>('ngayon')
  const [date, setDate] = useState(toLocalDate(Date.now()))
  const [saving, setSaving] = useState(false)
  const [search, setSearch] = useState('')

  useEffect(() => {
    if (open) {
      setIds({ id: ulid(), countId: ulid() })
      setProductId(initialProductId ?? null)
      setMode('pack')
      setQty('1')
      setCost('')
      setCostTouched(false)
      setNatira('')
      setWhenKind('ngayon')
      setSearch('')
    }
  }, [open, initialProductId])

  const product: Product | undefined = products.find((p) => p.id === productId)
  const state = product ? states.get(product.id) : undefined

  const recent = useMemo(() => {
    const seen = new Set<string>()
    const out: Product[] = []
    for (const e of [...events].reverse()) {
      if (e.type !== 'PURCHASE' || seen.has(e.product_id)) continue
      seen.add(e.product_id)
      const p = products.find((x) => x.id === e.product_id)
      if (p) out.push(p)
      if (out.length >= 6) break
    }
    return out
  }, [events, products])

  const qtyUnits = product ? Math.max(0, Math.round(Number(qty) || 0)) * (mode === 'pack' ? product.pack_size : 1) : 0

  // Prefill cost from the last known unit cost.
  useEffect(() => {
    if (!product || costTouched) return
    const uc = state?.unit_cost ?? null
    if (uc !== null && qtyUnits > 0) setCost(String(Math.round(uc * qtyUnits)))
    else setCost('')
  }, [product, qtyUnits, state, costTouched])

  const totalCost = cost.trim() === '' ? null : Number(cost)
  const unitCost = totalCost !== null && qtyUnits > 0 ? totalCost / qtyUnits : null
  const catalogHint = product ? CATALOG.find((c) => c.name === product.name)?.cost_hint ?? null : null
  let warning: string | null = null
  if (unitCost !== null && product) {
    if (product.sell_price !== null && unitCost >= product.sell_price) warning = S.bumili.lugi(templates.peso(unitCost), templates.peso(product.sell_price))
    else if (catalogHint !== null && unitCost > HIGH_COST_FACTOR * catalogHint) warning = S.bumili.highCost(templates.peso(unitCost))
  }

  const natiraN = natira.trim() === '' ? null : Math.max(0, Math.round(Number(natira)))

  async function save(again: boolean) {
    if (!product || qtyUnits <= 0 || saving) return
    setSaving(true)
    try {
      const when: DateChoice = whenKind === 'date' ? { kind: 'date', date } : { kind: whenKind }
      if (!(await write(() => recordPurchase({ id: ids.id, countId: ids.countId, product_id: product.id, qty_units: qtyUnits, total_cost: totalCost, natira: natiraN, when })))) return
      toast(S.common.recordedToast(`${product.name} — ${qtyUnits} ${product.unit_label}`))
      // new ids for the next submit (write-once)
      setIds({ id: ulid(), countId: ulid() })
      if (again) {
        setProductId(null)
        setQty('1')
        setCost('')
        setCostTouched(false)
        setNatira('')
      } else onClose()
    } finally {
      setSaving(false)
    }
  }

  const filtered = products.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <Sheet open={open} onClose={onClose}>
      <h2>{S.bumili.title}</h2>
      {!product ? (
        <>
          {recent.length > 0 && (
            <>
              <h3>{S.bumili.kanina}</h3>
              <div className="chips" style={{ marginBottom: 10 }}>
                {recent.map((p) => (
                  <button key={p.id} type="button" className="chip" onClick={() => setProductId(p.id)}>
                    {p.name}
                  </button>
                ))}
              </div>
            </>
          )}
          <h3>{S.bumili.product}</h3>
          <input className="search" aria-label={S.paninda.search} placeholder={S.paninda.search} value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
          {filtered.map((p) => (
            <button key={p.id} type="button" className="cat-row" onClick={() => setProductId(p.id)}>
              <span>{p.name}</span>
              <span className="meta">
                1 {p.pack_label} = {p.pack_size} {p.unit_label}
              </span>
            </button>
          ))}
          {products.length === 0 && <p className="muted">{S.bahay.emptyHint}</p>}
        </>
      ) : (
        <>
          <div className="card soft row between">
            <span className="bold">{product.name}</span>
            <button type="button" className="btn ghost sm" onClick={() => setProductId(null)}>
              {S.common.change}
            </button>
          </div>

          <div className="field">
            <label>{S.bumili.qty}</label>
            <div className="row">
              <input aria-label={S.bumili.qty} type="number" inputMode="numeric" min={0} value={qty} onChange={(e) => setQty(e.target.value)} style={{ maxWidth: 110 }} />
              <div className="grow">
                <Segment value={mode} options={[['pack', product.pack_label], ['unit', product.unit_label]]} onChange={setMode} />
              </div>
            </div>
            {mode === 'pack' && product.pack_size > 1 && (
              <div className="muted" style={{ marginTop: 6 }}>
                = {qtyUnits} {product.unit_label}
              </div>
            )}
          </div>

          <div className="field">
            <label>{S.bumili.totalCost}</label>
            <input aria-label={S.bumili.totalCost}
              type="number"
              inputMode="decimal"
              placeholder="₱"
              value={cost}
              onChange={(e) => {
                setCost(e.target.value)
                setCostTouched(true)
              }}
            />
            <div className="muted small" style={{ marginTop: 4 }}>
              {S.bumili.totalHint}
            </div>
            {warning && <div className="card flag" style={{ marginTop: 8 }}>{warning}</div>}
          </div>

          <div className="field">
            <label>{S.bumili.natira}</label>
            <input aria-label={S.bumili.natira} type="number" inputMode="numeric" min={0} placeholder={product.unit_label} value={natira} onChange={(e) => setNatira(e.target.value)} />
            <div className="muted small" style={{ marginTop: 4 }}>
              {S.bumili.natiraHint}
            </div>
            {natiraN !== null && qtyUnits > 0 && (
              <div className="card soft" style={{ marginTop: 8 }}>
                {S.bumili.confirm(natiraN, qtyUnits, natiraN + qtyUnits, product.unit_label)}
              </div>
            )}
          </div>

          <div className="field">
            <label>{S.bumili.when}</label>
            <Segment value={whenKind} options={[['ngayon', S.bumili.ngayon], ['kahapon', S.bumili.kahapon], ['date', S.bumili.ibangAraw]]} onChange={setWhenKind} />
            {whenKind === 'date' && <input aria-label={S.bumili.when} type="date" value={date} max={toLocalDate(Date.now())} onChange={(e) => setDate(e.target.value)} style={{ marginTop: 8 }} />}
          </div>

          <div className="row">
            <button type="button" className="btn secondary" onClick={() => save(true)} disabled={saving || qtyUnits <= 0}>
              {S.bumili.saveAdd}
            </button>
            <button type="button" className="btn primary grow" onClick={() => save(false)} disabled={saving || qtyUnits <= 0}>
              {S.bumili.save}
            </button>
          </div>
        </>
      )}
    </Sheet>
  )
}
