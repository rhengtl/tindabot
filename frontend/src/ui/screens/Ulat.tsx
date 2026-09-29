// P2 Ulat — BLUEPRINT §E5/§E6: Naitala (exact pesos) vs Tantiya (~₱, rounded to 10).
import { useMemo, useState } from 'react'
import { type DomainEvent, compareEvents, roundTo10, templates, toLocalDate } from '../../domain'
import { useApp } from '../../state/store'
import { Sheet, useWrite } from '../components'
import { useLang, useStrings } from '../i18n'

export function UlatCard({ onGastos, onPera }: { onGastos: () => void; onPera: () => void }) {
  const finance = useApp((s) => s.finance)
  const S = useStrings()
  const lang = useLang()
  const [history, setHistory] = useState(false)
  if (!finance) return null
  const t = finance.tantiya

  return (
    <>
      <h3>{S.ulat.title}</h3>
      <div className="card">
        <div className="muted small bold" style={{ marginBottom: 6 }}>
          {S.ulat.naitala}
        </div>
        <div className="kv">
          <span className="k">{S.ulat.cashLast}</span>
          <span className="bold">{finance.cash_last ? `${templates.pesoExact(finance.cash_last.amount)} · ${templates.fmtDate(toLocalDate(finance.cash_last.ts), lang)}` : S.ulat.cashNone}</span>
          <span className="k">{S.ulat.utangOutstanding}</span>
          <span className="bold">{templates.pesoExact(finance.utang_outstanding)}</span>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button type="button" className="btn secondary sm" onClick={onPera}>
            {S.fab.pera}
          </button>
          <button type="button" className="btn secondary sm" onClick={onGastos}>
            {S.fab.gastos}
          </button>
          <button type="button" className="btn ghost sm" onClick={() => setHistory(true)}>
            {S.listahan.history}
          </button>
        </div>

        {t.products > 0 && (
          <>
            <div className="muted small bold" style={{ margin: '14px 0 6px' }}>
              {S.ulat.tantiya}
            </div>
            <div className="kv">
              <span className="k">{S.ulat.bentaWeek}</span>
              <span>~{templates.pesoExact(roundTo10(t.benta))}</span>
              <span className="k">{S.ulat.tuboWeek}</span>
              <span>~{templates.pesoExact(roundTo10(t.tubo))}</span>
            </div>
            <p className="muted small" style={{ marginTop: 6 }}>
              {S.ulat.tantiyaHint(t.products, t.skipped)}
            </p>
          </>
        )}

        {finance.weeks.map((w, i) => (
          <div key={w.start} style={{ marginTop: 14 }}>
            <div className="muted small bold" style={{ marginBottom: 6 }}>
              {i === 0 ? S.ulat.thisWeek : i === 1 ? S.ulat.lastWeek : S.ulat.weeksAgo(i)} · {templates.fmtDate(w.start, lang)}–{templates.fmtDate(w.end, lang)}
            </div>
            <div className="kv">
              <span className="k">{S.ulat.gastos}</span>
              <span>{templates.pesoExact(w.gastos)}</span>
              <span className="k">{S.ulat.nabili}</span>
              <span>{templates.pesoExact(w.nabili)}</span>
              <span className="k">{S.ulat.utangGiven}</span>
              <span>{templates.pesoExact(w.utang_given)}</span>
              <span className="k">{S.ulat.utangReceived}</span>
              <span>{templates.pesoExact(w.utang_received)}</span>
              <span className="k">{S.ulat.cashCount}</span>
              <span>{w.cash_count === null ? '—' : templates.pesoExact(w.cash_count)}</span>
              <span className="k">{S.ulat.outstandingEnd}</span>
              <span>{templates.pesoExact(w.outstanding_end)}</span>
            </div>
          </div>
        ))}
      </div>
      {history && <FinanceHistory onClose={() => setHistory(false)} />}
    </>
  )
}

function FinanceHistory({ onClose }: { onClose: () => void }) {
  const events = useApp((s) => s.events)
  const voidEvent = useApp((s) => s.voidEvent)
  const restoreEvent = useApp((s) => s.restoreEvent)
  const S = useStrings()
  const lang = useLang()
  const write = useWrite()
  const timeline = useMemo(() => {
    const voids = new Set(events.filter((e) => e.type === 'VOID').map((e) => (e as { target: string }).target))
    return events
      .filter((e) => e.type === 'EXPENSE' || e.type === 'CASH_COUNT')
      .sort((a, b) => compareEvents(b, a))
      .map((e) => ({ e, voided: voids.has(e.id) }))
  }, [events])

  function describe(e: DomainEvent): string {
    if (e.type === 'EXPENSE') return `${S.fab.gastos} ${templates.pesoExact(e.amount)} · ${S.pera.categories[e.category]}${e.note ? ` · ${e.note}` : ''}`
    if (e.type === 'CASH_COUNT') return `${S.ulat.cashCount}: ${templates.pesoExact(e.amount)}`
    return e.type
  }

  return (
    <Sheet open onClose={onClose}>
      <h2>{S.ulat.history}</h2>
      <div className="card timeline">
        {timeline.length === 0 && <div className="muted small">{S.ulat.noHistory}</div>}
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
              <button type="button" className="btn ghost sm" onClick={() => write(() => restoreEvent(e))}>
                {S.paninda.ibalik}
              </button>
            ) : (
              <button type="button" className="btn ghost sm" onClick={() => write(() => voidEvent(e.id))}>
                {S.paninda.burahin}
              </button>
            )}
          </div>
        ))}
      </div>
    </Sheet>
  )
}
