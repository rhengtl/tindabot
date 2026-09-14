// P2 Listahan tab — customers and their utang balance (BLUEPRINT §D "Listahan", §E6).
import { useMemo, useState } from 'react'
import { type Customer, type CustomerState, type DomainEvent, compareEvents, daysBetweenMs, templates, toLocalDate, toMs } from '../../domain'
import { useApp } from '../../state/store'
import { Sheet, useToast } from '../components'
import { S } from '../strings'

function balanceLabel(st: CustomerState | undefined): string {
  if (!st || st.balance === 0) return S.listahan.bayadNa
  if (st.balance < 0) return S.listahan.sobra(templates.pesoExact(-st.balance))
  return templates.pesoExact(st.balance)
}

function subLabel(st: CustomerState | undefined, nowMs: number): string {
  if (!st) return S.listahan.noData
  if (st.balance > 0 && st.oldest_unpaid_ts) return S.listahan.oldest(templates.fmtDate(toLocalDate(st.oldest_unpaid_ts)))
  if (st.last_bayad_ts) return S.listahan.lastBayad(Math.floor(daysBetweenMs(toMs(st.last_bayad_ts), nowMs)))
  if (st.last_utang_ts) return S.listahan.lastUtang(Math.floor(daysBetweenMs(toMs(st.last_utang_ts), nowMs)))
  return S.listahan.noData
}

export function Listahan({ onUtang, onBayad }: { onUtang: (customerId: string | null) => void; onBayad: (customerId: string) => void }) {
  const customers = useApp((s) => s.customers)
  const customerStates = useApp((s) => s.customerStates)
  const finance = useApp((s) => s.finance)
  const nowMs = useApp((s) => s.nowMs)
  const [q, setQ] = useState('')
  const [detail, setDetail] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)

  const rows = useMemo(
    () =>
      customers
        .filter((c) => c.archived === showArchived && c.name.toLowerCase().includes(q.toLowerCase()))
        .map((c) => ({ c, st: customerStates.get(c.id) }))
        .sort((a, b) => (b.st?.balance ?? 0) - (a.st?.balance ?? 0) || a.c.name.localeCompare(b.c.name)),
    [customers, customerStates, q, showArchived],
  )
  // Archived customers who still owe stay visible until settled (§E6).
  const archivedOwing = useMemo(() => customers.filter((c) => c.archived && (customerStates.get(c.id)?.balance ?? 0) !== 0).length, [customers, customerStates])

  return (
    <>
      <div className="row between" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>{S.listahan.title}</h2>
        <button type="button" className="btn secondary sm" onClick={() => onUtang(null)}>
          ＋ {S.fab.utang}
        </button>
      </div>
      {finance && (
        <div className="card row between" style={{ marginBottom: 10 }}>
          <span className="muted">{S.listahan.outstanding}</span>
          <span className="bold">{templates.pesoExact(finance.utang_outstanding)}</span>
        </div>
      )}
      {customers.length === 0 ? (
        <div className="empty">
          <div className="ico">📒</div>
          <div className="bold">{S.listahan.empty}</div>
          <p className="muted" style={{ marginTop: 6 }}>
            {S.listahan.emptyHint}
          </p>
        </div>
      ) : (
        <>
          <input className="search" placeholder={S.pera.searchCustomer} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="card">
            {rows.map(({ c, st }) => (
              <div key={c.id} className="line">
                <button type="button" className="grow" style={{ textAlign: 'left' }} onClick={() => setDetail(c.id)}>
                  <div className="row between">
                    <span className="name">{c.name}</span>
                    <span className="qty">{balanceLabel(st)}</span>
                  </div>
                  <div className="reason">{subLabel(st, nowMs)}</div>
                </button>
              </div>
            ))}
            {rows.length === 0 && <div className="muted small">{S.listahan.noData}</div>}
          </div>
        </>
      )}
      {(showArchived || customers.some((c) => c.archived)) && (
        <button type="button" className="btn ghost" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? '‹ Aktibo' : `${S.listahan.archived}${archivedOwing ? ` (${archivedOwing} ${S.listahan.mayBalanse})` : ''} ›`}
        </button>
      )}
      {detail && <CustomerDetail customerId={detail} onClose={() => setDetail(null)} onUtang={onUtang} onBayad={onBayad} />}
    </>
  )
}

// ---------------------------------------------------------------------------------------------

function CustomerDetail({ customerId, onClose, onUtang, onBayad }: { customerId: string; onClose: () => void; onUtang: (id: string) => void; onBayad: (id: string) => void }) {
  const customer = useApp((s) => s.customers.find((c) => c.id === customerId))
  const state = useApp((s) => s.customerStates.get(customerId))
  const events = useApp((s) => s.events)
  const nowMs = useApp((s) => s.nowMs)
  const saveCustomer = useApp((s) => s.saveCustomer)
  const voidEvent = useApp((s) => s.voidEvent)
  const restoreEvent = useApp((s) => s.restoreEvent)
  const toast = useToast()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Customer | null>(null)

  const timeline = useMemo(() => {
    const voids = new Map(events.filter((e) => e.type === 'VOID').map((e) => [(e as { target: string }).target, e]))
    return events
      .filter((e) => (e.type === 'UTANG' || e.type === 'BAYAD') && e.customer_id === customerId)
      .sort((a, b) => compareEvents(b, a))
      .map((e) => ({ e, voided: voids.has(e.id) }))
  }, [events, customerId])

  if (!customer) return null

  function describe(e: DomainEvent): string {
    if (e.type === 'UTANG') return `Utang ${templates.pesoExact(e.amount)}${e.note ? ` · ${e.note}` : ''}`
    if (e.type === 'BAYAD') return `Bayad ${templates.pesoExact(e.amount)}`
    return e.type
  }

  return (
    <Sheet open onClose={onClose}>
      <h2>{customer.name}</h2>
      <div className="card">
        <div className="kv">
          <span className="k">{S.listahan.outstanding}</span>
          <span className="bold">{balanceLabel(state)}</span>
          <span className="k">Status</span>
          <span>{subLabel(state, nowMs)}</span>
          {customer.phone && (
            <>
              <span className="k">Cellphone</span>
              <span>{customer.phone}</span>
            </>
          )}
        </div>
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn secondary sm" onClick={() => onUtang(customer.id)}>
            {S.fab.utang}
          </button>
          <button type="button" className="btn secondary sm" onClick={() => onBayad(customer.id)}>
            {S.fab.bayad}
          </button>
          <button
            type="button"
            className="btn secondary sm"
            onClick={() => {
              setDraft({ ...customer })
              setEditing(true)
            }}
          >
            {S.listahan.edit}
          </button>
          <button
            type="button"
            className={`btn sm ${customer.archived ? 'secondary' : 'danger'}`}
            onClick={async () => {
              await saveCustomer({ ...customer, archived: !customer.archived })
              toast(customer.archived ? S.listahan.ibalik : S.listahan.itigil)
              onClose()
            }}
          >
            {customer.archived ? S.listahan.ibalik : S.listahan.itigil}
          </button>
        </div>
      </div>

      {editing && draft && (
        <div className="card soft">
          <div className="field">
            <label>{S.pera.customerName}</label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </div>
          <div className="field">
            <label>{S.pera.customerPhone}</label>
            <input type="tel" inputMode="tel" value={draft.phone ?? ''} onChange={(e) => setDraft({ ...draft, phone: e.target.value.trim() || null })} />
          </div>
          <div className="row">
            <button type="button" className="btn secondary sm" onClick={() => setEditing(false)}>
              {S.paninda.cancel}
            </button>
            <button
              type="button"
              className="btn primary sm grow"
              disabled={!draft.name.trim()}
              onClick={async () => {
                await saveCustomer({ ...draft, name: draft.name.trim() })
                setEditing(false)
                toast('Na-save.')
              }}
            >
              {S.paninda.save}
            </button>
          </div>
        </div>
      )}

      <h3>{S.listahan.history}</h3>
      <div className="card timeline">
        {timeline.length === 0 && <div className="muted small">{S.listahan.noData}</div>}
        {timeline.map(({ e, voided }) => (
          <div key={e.id} className={`ev ${voided ? 'voided' : ''}`}>
            <span>
              <div>{describe(e)}</div>
              <div className="muted small">
                {templates.fmtDate(toLocalDate(e.ts))}
                {toLocalDate(e.ts) !== toLocalDate(e.recorded_at) ? ` · naitala ${templates.fmtDate(toLocalDate(e.recorded_at))}` : ''}
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
