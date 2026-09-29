import { useMemo, useState } from 'react'
import { CATALOG, CATEGORIES, searchCatalog, type CatalogItem } from '../../catalog/catalog'
import { useApp } from '../../state/store'
import { Sheet, useToast, useWrite } from '../components'
import { useStrings } from '../i18n'

type Draft = Pick<CatalogItem, 'name' | 'category' | 'unit_label' | 'pack_size' | 'pack_label'>

export function AddProductSheet({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded?: () => void }) {
  const products = useApp((s) => s.products)
  const addProduct = useApp((s) => s.addProduct)
  const S = useStrings()
  const toast = useToast()
  const write = useWrite()
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [sell, setSell] = useState('')
  const [natira, setNatira] = useState('')
  const [saving, setSaving] = useState(false)

  const existing = useMemo(() => new Set(products.filter((p) => !p.archived).map((p) => p.name.toLowerCase())), [products])
  const results = useMemo(() => {
    const base = q ? searchCatalog(q) : cat ? CATALOG.filter((c) => c.category === cat) : CATALOG
    return base
  }, [q, cat])

  function reset() {
    setQ('')
    setCat(null)
    setDraft(null)
    setSell('')
    setNatira('')
  }

  async function save() {
    if (!draft || saving) return
    if (!draft.name.trim()) return
    setSaving(true)
    try {
      const ok = await write(() =>
        addProduct(
          { ...draft, name: draft.name.trim(), pack_size: Math.max(1, Math.round(draft.pack_size)) },
          sell.trim() === '' ? null : Number(sell),
          natira.trim() === '' ? null : Math.max(0, Math.round(Number(natira))),
        ),
      )
      if (!ok) return
      toast(S.common.addedToast(draft.name))
      reset()
      onAdded?.()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet
      open={open}
      onClose={() => {
        reset()
        onClose()
      }}
    >
      {!draft ? (
        <>
          <h2>{S.paninda.add}</h2>
          <input className="search" aria-label={S.paninda.search} placeholder={S.paninda.search} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          {!q && (
            <div className="chips" style={{ marginBottom: 10 }}>
              <button type="button" className={`chip ${cat === null ? 'on' : ''}`} onClick={() => setCat(null)}>
                Lahat
              </button>
              {CATEGORIES.map((c) => (
                <button key={c} type="button" className={`chip ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}>
                  {c}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="cat-row"
            onClick={() => setDraft({ name: q, category: cat ?? 'Iba pa', unit_label: 'piraso', pack_size: 12, pack_label: 'box' })}
          >
            <span className="bold">＋ {S.paninda.customName}</span>
          </button>
          {results.map((c) => {
            const has = existing.has(c.name.toLowerCase())
            return (
              <button key={c.name} type="button" className="cat-row" disabled={has} onClick={() => setDraft({ ...c })}>
                <span>
                  <div className={has ? 'muted' : ''}>{c.name}</div>
                  <div className="meta">
                    {c.category} · 1 {c.pack_label} = {c.pack_size} {c.unit_label}
                  </div>
                </span>
                {has ? <span className="badge grey">{S.paninda.inList}</span> : <span className="badge green">＋</span>}
              </button>
            )
          })}
        </>
      ) : (
        <>
          <h2>{draft.name || S.paninda.customName}</h2>
          <div className="field">
            <label>{S.common.name}</label>
            <input aria-label={S.common.name} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="row">
            <div className="field grow">
              <label>{S.paninda.unitLabel}</label>
              <input aria-label={S.paninda.unitLabel} value={draft.unit_label} onChange={(e) => setDraft({ ...draft, unit_label: e.target.value })} />
            </div>
            <div className="field grow">
              <label>{S.paninda.packLabel}</label>
              <input aria-label={S.paninda.packLabel} value={draft.pack_label} onChange={(e) => setDraft({ ...draft, pack_label: e.target.value })} />
            </div>
          </div>
          <div className="field">
            <label>
              {S.paninda.packSize} {draft.pack_label}?
            </label>
            <input aria-label={`${S.paninda.packSize} ${draft.pack_label}?`} type="number" inputMode="numeric" min={1} value={draft.pack_size} onChange={(e) => setDraft({ ...draft, pack_size: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>
              {S.paninda.sellPrice} ({S.paninda.optional})
            </label>
            <input aria-label={`${S.paninda.sellPrice} (${S.paninda.optional})`} type="number" inputMode="decimal" placeholder="₱" value={sell} onChange={(e) => setSell(e.target.value)} />
          </div>
          <div className="field">
            <label>
              {S.paninda.natiraQ} ({S.paninda.optional})
            </label>
            <input aria-label={`${S.paninda.natiraQ} (${S.paninda.optional})`} type="number" inputMode="numeric" placeholder={draft.unit_label} value={natira} onChange={(e) => setNatira(e.target.value)} />
          </div>
          <div className="row">
            <button type="button" className="btn secondary" onClick={() => setDraft(null)}>
              {S.common.back}
            </button>
            <button type="button" className="btn primary grow" onClick={save} disabled={saving || !draft.name.trim()}>
              {S.paninda.save}
            </button>
          </div>
        </>
      )}
    </Sheet>
  )
}
