import { useEffect, useMemo, useState } from 'react'
import { type Product, ulid } from '../../domain'
import { useApp } from '../../state/store'
import { NumberPad, Sheet, useToast, useWrite } from '../components'
import { useStrings } from '../i18n'

/** Full-screen count mode: stalest first, packs + loose pad, skip/next, exit anytime. */
export function BilangSheet({ open, onClose, only }: { open: boolean; onClose: () => void; only?: string[] | null }) {
  const allProducts = useApp((s) => s.products)
  const products = useMemo(() => allProducts.filter((p) => !p.archived), [allProducts])
  const states = useApp((s) => s.states)
  const recordCount = useApp((s) => s.recordCount)
  const S = useStrings()
  const toast = useToast()
  const write = useWrite()

  const queue = useMemo(() => {
    const list = (only ? products.filter((p) => only.includes(p.id)) : products).slice()
    const stale = (p: Product) => states.get(p.id)?.days_since_count ?? Number.POSITIVE_INFINITY
    list.sort((a, b) => stale(b) - stale(a))
    return list
  }, [products, states, only])

  const [idx, setIdx] = useState(0)
  const [packs, setPacks] = useState('')
  const [loose, setLoose] = useState('')
  const [field, setField] = useState<'packs' | 'loose'>('loose')
  const [done, setDone] = useState(0)
  const [id, setId] = useState(ulid())

  useEffect(() => {
    if (open) {
      setIdx(0)
      setPacks('')
      setLoose('')
      setField('loose')
      setDone(0)
      setId(ulid())
    }
  }, [open])

  const p = queue[idx]
  const st = p ? states.get(p.id) : undefined
  const total = p ? (Number(packs) || 0) * p.pack_size + (Number(loose) || 0) : 0
  const hasPacks = !!p && p.pack_size > 1

  function next() {
    setPacks('')
    setLoose('')
    setField('loose')
    setId(ulid())
    if (idx + 1 >= queue.length) {
      toast(S.bilang.done(done))
      onClose()
    } else setIdx(idx + 1)
  }

  async function save() {
    if (!p) return
    // A count that did not reach the database must not be counted as done, and must not move the
    // queue on: the person stays on this product with the failure toast in front of them.
    if (!(await write(() => recordCount(id, p.id, total, { kind: 'ngayon' })))) return
    setDone((d) => d + 1)
    next()
  }

  return (
    <Sheet open={open} onClose={onClose}>
      <h2>
        {S.bilang.title} · {Math.min(idx + 1, queue.length)}/{queue.length}
      </h2>
      {!p ? (
        <p className="muted">{S.bilang.nothing}</p>
      ) : (
        <>
          <div className="card soft">
            <div className="bold" style={{ fontSize: '1.15rem' }}>
              {p.name}
            </div>
            <div className="muted small">
              {st?.days_since_count != null ? S.bilang.lastCount(Math.floor(st.days_since_count)) : S.paninda.noData}
              {st?.anchor ? ` · ${st.anchor.qty} ${p.unit_label}` : ''}
            </div>
          </div>
          <p className="muted small">{S.bilang.hint}</p>

          <div className="numdisplay">
            {total} <span className="unit">{p.unit_label}</span>
          </div>
          {hasPacks && (
            <div className="segment" style={{ marginBottom: 6 }}>
              <button type="button" className={field === 'packs' ? 'on' : ''} onClick={() => setField('packs')}>
                {packs || 0} {p.pack_label}
              </button>
              <button type="button" className={field === 'loose' ? 'on' : ''} onClick={() => setField('loose')}>
                + {loose || 0} {p.unit_label}
              </button>
            </div>
          )}
          <NumberPad value={field === 'packs' ? packs : loose} onChange={field === 'packs' ? setPacks : setLoose} />

          <div className="row">
            <button type="button" className="btn secondary" onClick={next}>
              {S.bilang.laktawan}
            </button>
            <button type="button" className="btn primary grow" onClick={save} disabled={packs === '' && loose === ''}>
              {S.bilang.susunod} ✓
            </button>
          </div>
          <button type="button" className="btn ghost" style={{ width: '100%', marginTop: 6 }} onClick={onClose}>
            {S.bilang.tapos}
          </button>
        </>
      )}
    </Sheet>
  )
}
