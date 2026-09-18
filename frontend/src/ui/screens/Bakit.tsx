import { type ListLine, type Product, type ProductState, demand, templates } from '../../domain'
import { useApp } from '../../state/store'
import { Sheet, fmtNum } from '../components'
import { useLang, useStrings } from '../i18n'

/** The "bakit?" sheet: one plain explanation, and the accepted limitations kept visible. */
export function BakitSheet({ product, state, line, onClose }: { product: Product | null; state: ProductState | null; line: ListLine | null; onClose: () => void }) {
  const list = useApp((s) => s.list)
  const store = useApp((s) => s.store)
  const S = useStrings()
  const lang = useLang()
  if (!product || !state) return null
  const c = state.cadence
  const isCadence = state.tier === 'cadence'
  const rate = state.daily_rate

  return (
    <Sheet open onClose={onClose}>
      <h2>{S.bakit.title}</h2>
      <div className="card">
        <div className="bold" style={{ marginBottom: 8 }}>
          {product.name}
        </div>
        <div className="kv">
          {!isCadence && (
            <>
              <span className="k">{S.bakit.natira}</span>
              <span>{state.on_hand_est === null ? S.paninda.unknown : `${Math.round(state.on_hand_est)} ${product.unit_label}`}</span>
              <span className="k">{S.bakit.lastCount}</span>
              <span>{state.days_since_count === null ? '—' : S.bakit.lastCountAgo(Math.floor(state.days_since_count), String(state.anchor?.qty ?? '?'), product.unit_label)}</span>
              {rate !== null && (
                <>
                  <span className="k">{S.bakit.rate}</span>
                  <span>
                    ~{fmtNum(rate)} {product.unit_label} {S.bakit.perDay}
                  </span>
                </>
              )}
              {state.days_left !== null && (
                <>
                  <span className="k">{S.bakit.daysLeft}</span>
                  <span>~{S.common.days(Number(fmtNum(state.days_left, 0)))}</span>
                </>
              )}
            </>
          )}
          {isCadence && c && (
            <>
              <span className="k">{S.bakit.throughput}</span>
              <span>{S.bakit.throughputIn(fmtNum(c.typical_units, 0), product.unit_label, fmtNum(c.typical_units / c.throughput, 0))}</span>
              <span className="k">{S.paninda.rebuy}</span>
              <span>
                {c.rebuy.early === c.rebuy.late ? templates.fmtDate(c.rebuy.mid, lang) : `${templates.fmtDate(c.rebuy.early, lang)} – ${templates.fmtDate(c.rebuy.late, lang)}`}
              </span>
            </>
          )}
          {rate !== null && list && store && !isCadence && (
            <>
              <span className="k">{S.bakit.need}</span>
              <span>
                ~{fmtNum(demand(rate, list.next_trip, list.following, store.multipliers), 0)} {product.unit_label}
              </span>
            </>
          )}
          {state.unit_cost !== null && (
            <>
              <span className="k">{S.bakit.cost}</span>
              <span>{templates.peso(Math.round(state.unit_cost * 100) / 100)}</span>
            </>
          )}
          {state.tubo_per_unit !== null && (
            <>
              <span className="k">{S.bakit.tubo}</span>
              <span>{state.tubo_per_unit < 0 ? '⚠ ' : ''}{templates.peso(Math.round(state.tubo_per_unit * 100) / 100)}</span>
            </>
          )}
          <span className="k">{S.bakit.tantiya}</span>
          <span>{S.bakit.confidence[state.confidence]}</span>
        </div>
      </div>
      {line && (
        <div className="card soft">
          <div className="bold">
            {line.buy_packs} {product.pack_size === 1 ? product.unit_label : product.pack_label}
            {product.pack_size > 1 ? ` (${line.buy_packs * product.pack_size} ${product.unit_label})` : ''}
          </div>
          <div className="small" style={{ marginTop: 4 }}>
            {line.reason}
          </div>
          {line.hint && <div className="small muted" style={{ marginTop: 4 }}>{line.hint}</div>}
        </div>
      )}
      <p className="muted small" style={{ lineHeight: 1.45 }}>
        {isCadence ? templates.bakitTierA(lang) : templates.bakitTierBStale(lang)}
      </p>
      {state.flags.has('count_mismatch') && <div className="card flag">{S.bakit.flagInconsistent}</div>}
      {state.flags.has('inconsistent') && <div className="card flag">{S.bakit.flagMissingPurchase}</div>}
      {state.flags.has('lugi_check') && <div className="card flag">{S.bakit.flagLugi}</div>}
    </Sheet>
  )
}
