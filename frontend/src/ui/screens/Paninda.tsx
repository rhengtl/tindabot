import { useMemo, useState } from 'react'
import { type DomainEvent, type Lang, type Product, type ProductState, compareEvents, templates, toLocalDate, ulid } from '../../domain'
import { useApp } from '../../state/store'
import { Dot, Sheet, fmtNum, useToast } from '../components'
import { useLang, useStrings } from '../i18n'
import type { Strings } from '../strings'

const URGENCY_ORDER = { red: 0, orange: 1, yellow: 2, green: 3, grey: 4 } as const
type U = keyof typeof URGENCY_ORDER

function urgencyOf(st: ProductState | undefined, lineUrgency: U | undefined): U {
  if (lineUrgency) return lineUrgency
  if (!st) return 'grey'
  if (st.tier === 'counts' && st.daily_rate !== null) return 'green'
  return 'grey'
}

function statusText(p: Product, st: ProductState | undefined, S: Strings, lang: Lang): string {
  if (!st) return S.paninda.noData
  if (st.flags.has('dormant')) return S.paninda.dormant
  if (st.flags.has('unclear')) return S.paninda.unclear
  if (st.tier === 'cadence' && st.cadence) {
    const c = st.cadence
    const when = c.rebuy.early === c.rebuy.late ? templates.fmtDate(c.rebuy.mid, lang) : `${templates.fmtDate(c.rebuy.early, lang)}–${templates.fmtDate(c.rebuy.late, lang)}`
    return S.paninda.rebuyWhen(when)
  }
  if (st.tier === 'counts') {
    if (st.flags.has('dead')) return S.paninda.dead
    if (st.flags.has('slow')) return S.paninda.slow
    if (st.daily_rate === null) return `${st.anchor?.qty ?? '?'} ${p.unit_label} (${S.paninda.lastCount})`
    if (st.days_left !== null && st.days_left > 7) return S.paninda.okDays(Math.round(st.days_left))
    if (st.days_left !== null) return S.paninda.daysLeftShort(fmtNum(st.days_left, 0))
  }
  return S.paninda.noData
}

export function Paninda({ onAdd, onBakit, onBumili, onBilang }: { onAdd: () => void; onBakit: (id: string) => void; onBumili: (id: string) => void; onBilang: (ids: string[]) => void }) {
  const products = useApp((s) => s.products)
  const states = useApp((s) => s.states)
  const list = useApp((s) => s.list)
  const S = useStrings()
  const lang = useLang()
  const [q, setQ] = useState('')
  const [detail, setDetail] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const rows = useMemo(() => {
    const lineU = new Map(list?.lines.map((l) => [l.product_id, l.urgency as U]) ?? [])
    return products
      .filter((p) => p.archived === showArchived && p.name.toLowerCase().includes(q.toLowerCase()))
      .map((p) => ({ p, st: states.get(p.id), u: urgencyOf(states.get(p.id), lineU.get(p.id)) }))
      .sort((a, b) => URGENCY_ORDER[a.u] - URGENCY_ORDER[b.u] || a.p.name.localeCompare(b.p.name))
  }, [products, states, list, q, showArchived])

  return (
    <>
      <div className="row between" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{S.paninda.title}</h2>
        <button type="button" className="btn secondary sm" onClick={onAdd}>
          ＋ {S.paninda.add}
        </button>
      </div>
      <input className="search" placeholder={S.paninda.search} value={q} onChange={(e) => setQ(e.target.value)} />
      {rows.length === 0 && !showArchived && (
        <div className="empty">
          <div className="ico">📦</div>
          <div className="bold">{S.bahay.empty}</div>
        </div>
      )}
      <div className="card">
        {rows.map(({ p, st, u }) => (
          <div key={p.id} className="line">
            <Dot urgency={u} />
            <button type="button" className="grow" style={{ textAlign: 'left' }} onClick={() => setDetail(p.id)}>
              <div className="row between">
                <span className="name">{p.name}</span>
                <span className="qty">
                  {st?.tier === 'counts' && st.on_hand_est !== null ? `${Math.round(st.on_hand_est)} ${p.unit_label}` : S.paninda.unknown}
                </span>
              </div>
              <div className="reason">{statusText(p, st, S, lang)}</div>
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="btn ghost" onClick={() => setShowArchived((v) => !v)}>
        {showArchived ? S.paninda.activeTab : S.paninda.archivedTab}
      </button>
      {detail && (
        <ProductDetail
          productId={detail}
          onClose={() => setDetail(null)}
          onBakit={onBakit}
          onBumili={onBumili}
          onBilang={onBilang}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------------------------

function ProductDetail({ productId, onClose, onBakit, onBumili, onBilang }: { productId: string; onClose: () => void; onBakit: (id: string) => void; onBumili: (id: string) => void; onBilang: (ids: string[]) => void }) {
  const product = useApp((s) => s.products.find((p) => p.id === productId))
  const state = useApp((s) => s.states.get(productId))
  const events = useApp((s) => s.events)
  const saveProduct = useApp((s) => s.saveProduct)
  const voidEvent = useApp((s) => s.voidEvent)
  const restoreEvent = useApp((s) => s.restoreEvent)
  const recordAdjust = useApp((s) => s.recordAdjust)
  const S = useStrings()
  const lang = useLang()
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Product | null>(null)
  const [nasira, setNasira] = useState<string | null>(null)

  const timeline = useMemo(() => {
    const voids = new Map(events.filter((e) => e.type === 'VOID').map((e) => [(e as { target: string }).target, e]))
    return events
      .filter((e) => e.type !== 'VOID' && (e as { product_id?: string }).product_id === productId)
      .sort((a, b) => compareEvents(b, a))
      .map((e) => ({ e, voided: voids.has(e.id) }))
  }, [events, productId])

  if (!product) return null

  function describe(e: DomainEvent): string {
    const u = product!.unit_label
    if (e.type === 'PURCHASE') return `${S.paninda.histPurchase(e.qty_units, u)}${e.total_cost !== null ? ` · ${templates.peso(e.total_cost)}` : ''}`
    if (e.type === 'COUNT') return S.paninda.histCount(e.qty_on_hand, u)
    if (e.type === 'ADJUST') return `${S.paninda.adjustReason[e.reason] ?? S.paninda.adjustReason.iba}: ${e.delta} ${u}`
    return e.type
  }

  return (
    <Sheet open onClose={onClose}>
      <h2>{product.name}</h2>
      <div className="card">
        <div className="kv">
          <span className="k">{S.paninda.natira}</span>
          <span className="bold">{state?.tier === 'counts' && state.on_hand_est !== null ? `${Math.round(state.on_hand_est)} ${product.unit_label}` : S.paninda.unknown}</span>
          <span className="k">Status</span>
          <span>{statusText(product, state, S, lang)}</span>
          <span className="k">{S.paninda.pack}</span>
          <span>
            1 {product.pack_label} = {product.pack_size} {product.unit_label}
          </span>
          <span className="k">{S.paninda.price}</span>
          <span>{product.sell_price === null ? '—' : templates.peso(product.sell_price)}</span>
        </div>
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn secondary sm" onClick={() => onBakit(product.id)}>
            {S.bahay.bakit}
          </button>
          <button type="button" className="btn secondary sm" onClick={() => onBumili(product.id)}>
            {S.fab.bumili}
          </button>
          <button type="button" className="btn secondary sm" onClick={() => onBilang([product.id])}>
            {S.fab.bilang}
          </button>
          <button type="button" className="btn secondary sm" onClick={() => setNasira('')}>
            {S.paninda.nasira}
          </button>
          <button
            type="button"
            className="btn secondary sm"
            onClick={() => {
              setDraft({ ...product })
              setEditing(true)
            }}
          >
            {S.paninda.edit}
          </button>
          <button
            type="button"
            className={`btn sm ${product.archived ? 'secondary' : 'danger'}`}
            onClick={async () => {
              await saveProduct({ ...product, archived: !product.archived })
              toast(product.archived ? S.paninda.ibalikSaListahan : S.paninda.itigil)
              onClose()
            }}
          >
            {product.archived ? S.paninda.ibalikSaListahan : S.paninda.itigil}
          </button>
        </div>
      </div>

      {nasira !== null && (
        <div className="card soft">
          <div className="field">
            <label>Ilan ang nasira / expired? ({product.unit_label})</label>
            <input type="number" inputMode="numeric" min={1} value={nasira} onChange={(e) => setNasira(e.target.value)} autoFocus />
          </div>
          <div className="row">
            <button type="button" className="btn secondary sm" onClick={() => setNasira(null)}>
              {S.paninda.cancel}
            </button>
            <button
              type="button"
              className="btn primary sm grow"
              disabled={!(Number(nasira) > 0)}
              onClick={async () => {
                await recordAdjust(ulid(), product.id, -Math.round(Number(nasira)), 'sira')
                setNasira(null)
                toast(S.paninda.nasiraSaved)
              }}
            >
              {S.paninda.save}
            </button>
          </div>
        </div>
      )}

      {editing && draft && (
        <div className="card soft">
          <div className="field">
            <label>{S.common.name}</label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="row">
            <div className="field grow">
              <label>{S.paninda.unitLabel}</label>
              <input value={draft.unit_label} onChange={(e) => setDraft({ ...draft, unit_label: e.target.value })} />
            </div>
            <div className="field grow">
              <label>{S.paninda.packLabel}</label>
              <input value={draft.pack_label} onChange={(e) => setDraft({ ...draft, pack_label: e.target.value })} />
            </div>
          </div>
          <div className="row">
            <div className="field grow">
              <label>{S.paninda.packSize} {draft.pack_label}</label>
              <input type="number" inputMode="numeric" min={1} value={draft.pack_size} onChange={(e) => setDraft({ ...draft, pack_size: Number(e.target.value) })} />
            </div>
            <div className="field grow">
              <label>{S.paninda.sellPrice}</label>
              <input type="number" inputMode="decimal" value={draft.sell_price ?? ''} onChange={(e) => setDraft({ ...draft, sell_price: e.target.value === '' ? null : Number(e.target.value) })} />
            </div>
          </div>
          <div className="row">
            <button type="button" className="btn secondary sm" onClick={() => setEditing(false)}>
              {S.paninda.cancel}
            </button>
            <button
              type="button"
              className="btn primary sm grow"
              onClick={async () => {
                await saveProduct({ ...draft, pack_size: Math.max(1, Math.round(draft.pack_size)) })
                setEditing(false)
                toast(S.common.saved)
              }}
            >
              {S.paninda.save}
            </button>
          </div>
        </div>
      )}

      <h3>{S.paninda.timeline}</h3>
      <div className="card timeline">
        {timeline.length === 0 && <div className="muted small">{S.paninda.noData}</div>}
        {timeline.map(({ e, voided }) => (
          <div key={e.id} className={`ev ${voided ? 'voided' : ''}`}>
            <span>
              <div>{describe(e)}</div>
              <div className="muted small">
                {templates.fmtDate(toLocalDate(e.ts), lang)}
                {toLocalDate(e.ts) !== toLocalDate(e.recorded_at) ? ` · ${S.common.recorded} ${templates.fmtDate(toLocalDate(e.recorded_at), lang)}` : ''}
                {voided ? ` · ${S.paninda.binura}` : ''}
              </div>
            </span>
            {voided ? (
              <button type="button" className="btn ghost sm" onClick={() => restoreEvent(e)}>
                {S.paninda.ibalik}
              </button>
            ) : (
              <button type="button" className="btn ghost sm" onClick={() => voidEvent(e.id)}>
                {S.paninda.burahin}
              </button>
            )}
          </div>
        ))}
      </div>
    </Sheet>
  )
}
