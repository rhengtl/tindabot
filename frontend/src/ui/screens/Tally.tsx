import { useEffect, useMemo, useState } from 'react'
import { productMatches } from '../../catalog/catalog'
import { type Product, ulid } from '../../domain'
import { useApp } from '../../state/store'
import { Sheet, useToast, useWrite } from '../components'
import { useStrings } from '../i18n'

// P5 tally (decided 2026-10-01): tap a product per sale, save once. Each product's taps become one
// SALE event with ts = now. A tally is a confirmed minimum of what left the shelf (BLUEPRINT §E1),
// so a partial tally never hurts the estimate. Products with recent sales/purchases come first.
export function TallySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const allProducts = useApp((s) => s.products)
  const events = useApp((s) => s.events)
  const recordSales = useApp((s) => s.recordSales)
  const S = useStrings()
  const toast = useToast()
  const write = useWrite()
  const [taps, setTaps] = useState<Map<string, number>>(new Map())
  const [ids, setIds] = useState<Map<string, string>>(new Map())
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setTaps(new Map())
      setIds(new Map())
      setSearch('')
    }
  }, [open])

  const products = useMemo(() => {
    const recent = new Map<string, number>()
    events.forEach((e, i) => {
      if (e.type === 'SALE' || e.type === 'PURCHASE') recent.set(e.product_id, i) // later entries win
    })
    return allProducts.filter((p) => !p.archived).sort((a, b) => (recent.get(b.id) ?? -1) - (recent.get(a.id) ?? -1) || a.name.localeCompare(b.name))
  }, [allProducts, events])

  const total = [...taps.values()].reduce((a, b) => a + b, 0)
  const bump = (p: Product, d: number) => {
    setTaps((m) => {
      const next = new Map(m)
      const v = Math.max(0, (next.get(p.id) ?? 0) + d)
      if (v === 0) next.delete(p.id)
      else next.set(p.id, v)
      return next
    })
    // event ids are fixed when a product is first tapped (write-once, idempotent save)
    setIds((m) => (m.has(p.id) ? m : new Map(m).set(p.id, ulid())))
  }

  const close = () => {
    if (total > 0 && !window.confirm(S.tally.unsavedQ)) return
    onClose()
  }

  async function save() {
    if (total === 0 || saving) return
    setSaving(true)
    try {
      const lines = [...taps.entries()].map(([product_id, qty_units]) => ({ id: ids.get(product_id) ?? ulid(), product_id, qty_units }))
      if (!(await write(() => recordSales(lines)))) return
      toast(S.tally.saved(total))
      setTaps(new Map())
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const shown = products.filter((p) => productMatches(p.name, search))

  return (
    <Sheet open={open} onClose={close}>
      <h2>{S.tally.title}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>
        {S.tally.hint}
      </p>
      <input className="search" aria-label={S.paninda.search} placeholder={S.paninda.search} value={search} onChange={(e) => setSearch(e.target.value)} />
      <div className="card" data-testid="tally-list">
        {shown.map((p) => {
          const n = taps.get(p.id) ?? 0
          return (
            <div key={p.id} className="line" style={{ alignItems: 'center' }}>
              <button type="button" className="grow" style={{ textAlign: 'left' }} data-testid="tally-tap" onClick={() => bump(p, 1)}>
                <span className="name">{p.name}</span>
                <span className="muted small"> · {p.unit_label}</span>
              </button>
              {n > 0 && (
                <>
                  <span className="bold" data-testid="tally-n" style={{ minWidth: 28, textAlign: 'right' }}>
                    {n}
                  </span>
                  <button type="button" className="btn ghost sm" aria-label={S.tally.minus} onClick={() => bump(p, -1)}>
                    −
                  </button>
                </>
              )}
              <button type="button" className="btn secondary sm" aria-label={`+1 ${p.name}`} onClick={() => bump(p, 1)}>
                +1
              </button>
            </div>
          )
        })}
        {products.length === 0 && <p className="muted">{S.bahay.emptyHint}</p>}
        {products.length > 0 && shown.length === 0 && <p className="muted">{S.common.noMatch}</p>}
      </div>
      <button type="button" className="btn primary" style={{ width: '100%' }} data-testid="tally-save" disabled={total === 0 || saving} onClick={save}>
        {S.tally.save} · {S.tally.count(total)}
      </button>
    </Sheet>
  )
}
