import { useEffect, useMemo, useState } from 'react'
import { type ListLine, type Product, addDays, applyBudget, budgetPrefill, isPayday, templates, toLocalDate } from '../../domain'
import { useApp } from '../../state/store'
import { Dot, useToast, useWrite } from '../components'
import { useLang, useStrings } from '../i18n'
import type { Strings } from '../strings'

interface Props {
  onBakit: (productId: string, line: ListLine | null) => void
  onBilang: (only: string[] | null) => void
  onAdd: () => void
}

function qtyLabel(l: ListLine, p: Product, S: Strings): string {
  const unit = p.pack_size === 1 ? p.unit_label : p.pack_label
  if (l.section === 'wag_muna') return '—'
  if (l.range) {
    const [a, b] = l.range
    if (a === 0) return S.bahay.uptoPacks(b, unit)
    return `${a}–${b} ${unit}`
  }
  return `${l.buy_packs} ${unit}`
}

export function Bahay({ onBakit, onBilang, onAdd }: Props) {
  const store = useApp((s) => s.store)
  const products = useApp((s) => s.products)
  const states = useApp((s) => s.states)
  const list = useApp((s) => s.list)
  const nowMs = useApp((s) => s.nowMs)
  const updateStore = useApp((s) => s.updateStore)
  const meta = useApp((s) => s.meta)
  const setMeta = useApp((s) => s.setMeta)
  const lang = useLang()
  const S = useStrings()
  const toast = useToast()
  const write = useWrite()
  const [showWag, setShowWag] = useState(false)
  const [nudgeDismissed, setNudgeDismissed] = useState(true)
  const finance = useApp((s) => s.finance)
  // Budget (§E6): prefilled from the last cash count only when ≤ 2 days old; otherwise empty.
  const prefill = budgetPrefill(finance?.cash_last ?? null, nowMs)
  const [budgetText, setBudgetText] = useState<string | null>(null)
  const budgetStr = budgetText ?? (prefill === null ? '' : String(prefill))
  const budgetN = budgetStr.trim() === '' ? null : Number(budgetStr)
  const budget = useMemo(() => (list && budgetN !== null && budgetN >= 0 ? applyBudget(list, budgetN) : null), [list, budgetN])
  const budgetPacks = useMemo(() => new Map(budget?.lines.map((b) => [b.product_id, b]) ?? []), [budget])

  const today = toLocalDate(nowMs)
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])
  const active = products.filter((p) => !p.archived)

  useEffect(() => {
    meta('nudge_dismissed').then((d) => setNudgeDismissed(d === today))
  }, [meta, today])

  if (!store || !list) return null

  const lines = list.lines
  const sections: Array<[string, ListLine[]]> = [
    [S.bahay.bilhinNa, lines.filter((l) => l.section === 'bilhin_na')],
    [S.bahay.bilhin, lines.filter((l) => l.section === 'bilhin')],
  ]
  const wag = lines.filter((l) => l.section === 'wag_muna')

  // Count nudge: needs_count, tier none without a count, Tier A listed — max 5, once a day.
  const nudgeIds: string[] = []
  for (const p of active) {
    const st = states.get(p.id)
    if (!st) continue
    const line = lines.find((l) => l.product_id === p.id)
    if (line?.needs_count || st.flags.has('needs_count') || (st.tier === 'none' && !st.anchor) || line?.tier === 'cadence') nudgeIds.push(p.id)
  }
  const nudge = nudgeIds.slice(0, 5)

  // Payday flag within 3 days.
  let paydayDay: string | null = null
  for (let i = 0; i <= 3; i++) {
    const d = addDays(today, i)
    if (isPayday(d)) {
      paydayDay = templates.fmtRelative(d, today, lang)
      break
    }
  }

  const goingToday = store.next_trip_override === today

  async function share() {
    const unit = (p: Product) => (p.pack_size === 1 ? p.unit_label : p.pack_label)
    const rows = lines
      .filter((l) => l.section !== 'wag_muna')
      .map((l) => {
        const p = byId.get(l.product_id)!
        return `• ${p.name} — ${l.range ? qtyLabel(l, p, S) : `${l.buy_packs} ${unit(p)}`}${l.cost !== null ? ` (${templates.peso(Math.round(l.cost))})` : ''}`
      })
    const text = [`${S.bahay.title} — ${templates.fmtDate(list!.next_trip, lang)}`, ...rows, `${S.bahay.shareBring}: ${templates.pesoEstimate(list!.total_known_cost)}`, `— ${store!.name} · ${S.appName}`].join('\n')
    try {
      if (navigator.share) await navigator.share({ text })
      else {
        await navigator.clipboard.writeText(text)
        toast(S.common.copied)
      }
    } catch {
      /* cancelled */
    }
  }

  if (active.length === 0) {
    return (
      <div className="empty">
        <div className="ico">🏪</div>
        <div className="bold">{S.bahay.empty}</div>
        <p className="muted" style={{ margin: '6px 0 16px' }}>
          {S.bahay.emptyHint}
        </p>
        <button type="button" className="btn primary" onClick={onAdd}>
          {S.bahay.emptyAdd}
        </button>
      </div>
    )
  }

  return (
    <>
      <div className="tripbar">
        <div className="row between">
          <div>
            <div className="muted small">{S.bahay.trip}</div>
            <div className="bold">{list.next_trip === today ? S.bahay.today : templates.fmtDate(list.next_trip, lang)}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="muted small">{S.bahay.total}</div>
            <div className="bold">{templates.pesoEstimate(list.total_known_cost)}</div>
            {list.unknown_cost_count > 0 && <div className="muted small">{S.bahay.unknownCost(list.unknown_cost_count)}</div>}
          </div>
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button type="button" className="btn secondary sm" onClick={() => write(() => updateStore({ next_trip_override: goingToday ? null : today }))}>
            {goingToday ? S.bahay.cancelGoingToday : S.bahay.goingToday}
          </button>
          <button type="button" className="btn secondary sm" onClick={share} disabled={lines.length === 0}>
            {S.bahay.share}
          </button>
        </div>
        <div className="row" style={{ marginTop: 8, alignItems: 'center' }}>
          <label className="muted small" htmlFor="budget" style={{ whiteSpace: 'nowrap' }}>
            {S.bahay.budget}
          </label>
          <input id="budget" type="number" inputMode="decimal" min={0} placeholder="₱" value={budgetStr} onChange={(e) => setBudgetText(e.target.value)} style={{ maxWidth: 140 }} />
          {budget && lines.length > 0 && <span className="small">{budget.kulang > 0 ? S.bahay.kulang(templates.pesoExact(budget.kulang)) : S.bahay.sapat}</span>}
        </div>
      </div>

      {list.banner && <div className="banner">{list.banner}</div>}
      {paydayDay && <div className="card flag">{S.bahay.paydaySoon(paydayDay)}</div>}

      {nudge.length > 0 && !nudgeDismissed && (
        <div className="card soft row between">
          <button type="button" className="grow" style={{ textAlign: 'left' }} onClick={() => onBilang(nudge)}>
            <span className="bold">{S.bahay.nudge(nudge.map((id) => byId.get(id)!.name).slice(0, 2).join(', '))}</span>
            {nudge.length > 2 && <span className="muted"> +{nudge.length - 2}</span>}
            <span className="cta"> →</span>
          </button>
          <button
            type="button"
            className="muted icon-btn"
            aria-label={S.common.close}
            onClick={() => {
              setMeta('nudge_dismissed', today)
              setNudgeDismissed(true)
            }}
          >
            ✕
          </button>
        </div>
      )}

      {lines.length === 0 && (
        <div className="empty">
          <div className="ico">✅</div>
          <div className="bold">{S.bahay.nothingToBuy}</div>
          <p className="muted" style={{ marginTop: 6 }}>
            {S.bahay.nothingHint}
          </p>
        </div>
      )}

      {sections.map(([title, ls]) =>
        ls.length === 0 ? null : (
          <div key={title}>
            <h3>{title}</h3>
            <div className="card">
              {ls.map((l) => {
                const p = byId.get(l.product_id)!
                return (
                  <div key={l.product_id} className="line">
                    <Dot urgency={l.urgency} />
                    <button type="button" className="grow" style={{ textAlign: 'left' }} onClick={() => onBakit(p.id, l)}>
                      <div className="row between">
                        <span className="name">{p.name}</span>
                        <span className="qty">
                          {qtyLabel(l, p, S)}
                          {l.cost !== null && <span className="muted"> · {templates.peso(Math.round(l.cost))}</span>}
                        </span>
                      </div>
                      <div className="reason">
                        {l.tier === 'cadence' && <span className="badge grey" style={{ marginRight: 6 }}>{S.bahay.tantiya}</span>}
                        {l.reason}
                        {l.hint && <span> {l.hint}</span>}
                        {budgetPacks.get(l.product_id)?.reduced && <span className="budget-hint"> {S.bahay.budgetPacks(budgetPacks.get(l.product_id)!.packs, p.pack_size === 1 ? p.unit_label : p.pack_label)}</span>}
                      </div>
                    </button>
                    {l.needs_count && (
                      <button type="button" className="line-cta" onClick={() => onBilang([p.id])}>
                        {S.bahay.bilanginMuna}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ),
      )}

      {wag.length > 0 && (
        <div>
          <h3>
            <button type="button" className="section-toggle" onClick={() => setShowWag((v) => !v)} style={{ font: 'inherit', color: 'inherit' }}>
              {S.bahay.wagMuna} ({wag.length}) {showWag ? '▲' : '▼'}
            </button>
          </h3>
          {showWag && (
            <div className="card">
              {wag.map((l) => {
                const p = byId.get(l.product_id)!
                return (
                  <div key={l.product_id} className="line">
                    <Dot urgency="yellow" />
                    <button type="button" className="grow" style={{ textAlign: 'left' }} onClick={() => onBakit(p.id, l)}>
                      <div className="name">{p.name}</div>
                      <div className="reason">{l.reason}</div>
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </>
  )
}
