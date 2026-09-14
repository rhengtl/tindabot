// P2 record sheet for UTANG / BAYAD / EXPENSE / CASH_COUNT — BLUEPRINT §C, §E6.
// Same shape as Bumili: ids generated on open (idempotent submit), Ngayon/Kahapon/Ibang araw.
import { useEffect, useMemo, useState } from 'react'
import { EXPENSE_CATEGORIES, type Customer, type ExpenseCategory, pesos, templates, toLocalDate, ulid } from '../../domain'
import { type DateChoice, useApp } from '../../state/store'
import { Segment, Sheet, useToast } from '../components'
import { S } from '../strings'

export type PeraKind = 'utang' | 'bayad' | 'gastos' | 'pera'

/** Pesos > 0 with at most 2 decimals (§E6). */
export function parseAmount(raw: string): number | null {
  const t = raw.trim()
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  const v = Number(t)
  return v > 0 ? pesos(v) : null
}

export function PeraSheet({ open, kind, onClose, initialCustomerId }: { open: boolean; kind: PeraKind; onClose: () => void; initialCustomerId?: string | null }) {
  const allCustomers = useApp((s) => s.customers)
  const customerStates = useApp((s) => s.customerStates)
  const addCustomer = useApp((s) => s.addCustomer)
  const recordUtang = useApp((s) => s.recordUtang)
  const recordBayad = useApp((s) => s.recordBayad)
  const recordExpense = useApp((s) => s.recordExpense)
  const recordCashCount = useApp((s) => s.recordCashCount)
  const toast = useToast()

  const [id, setId] = useState(() => ulid())
  const [customerId, setCustomerId] = useState<string | null>(initialCustomerId ?? null)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [category, setCategory] = useState<ExpenseCategory>('iba')
  const [whenKind, setWhenKind] = useState<'ngayon' | 'kahapon' | 'date'>('ngayon')
  const [date, setDate] = useState(toLocalDate(Date.now()))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setId(ulid())
      setCustomerId(initialCustomerId ?? null)
      setSearch('')
      setCreating(false)
      setNewName('')
      setNewPhone('')
      setAmount('')
      setNote('')
      setCategory('iba')
      setWhenKind('ngayon')
      setDate(toLocalDate(Date.now()))
    }
  }, [open, initialCustomerId])

  const needsCustomer = kind === 'utang' || kind === 'bayad'
  const customers = useMemo(() => allCustomers.filter((c) => !c.archived).sort((a, b) => a.name.localeCompare(b.name)), [allCustomers])
  const customer: Customer | undefined = allCustomers.find((c) => c.id === customerId)
  const filtered = customers.filter((c) => c.name.toLowerCase().includes(search.toLowerCase()))
  const amountN = parseAmount(amount)
  const txt = S.pera[kind]

  const before = customer ? customerStates.get(customer.id)?.balance ?? 0 : 0
  let confirm: string | null = null
  if (customer && amountN !== null) {
    if (kind === 'utang') confirm = S.pera.confirmUtang(customer.name, templates.pesoExact(before), templates.pesoExact(amountN), templates.pesoExact(pesos(before + amountN)))
    if (kind === 'bayad') confirm = S.pera.confirmBayad(customer.name, templates.pesoExact(before), templates.pesoExact(amountN), templates.pesoExact(pesos(before - amountN)))
  }

  async function createCustomer() {
    const name = newName.trim()
    if (!name) return
    const c = await addCustomer(name, newPhone.trim() || null)
    setCustomerId(c.id)
    setCreating(false)
  }

  async function save() {
    if (amountN === null || saving) return
    if (needsCustomer && !customer) return
    setSaving(true)
    try {
      const when: DateChoice = whenKind === 'date' ? { kind: 'date', date } : { kind: whenKind }
      const noteN = note.trim() || null
      if (kind === 'utang') await recordUtang({ id, amount: amountN, when, customer_id: customer!.id, note: noteN })
      else if (kind === 'bayad') await recordBayad({ id, amount: amountN, when, customer_id: customer!.id })
      else if (kind === 'gastos') await recordExpense({ id, amount: amountN, when, category, note: noteN })
      else await recordCashCount({ id, amount: amountN, when })
      toast(`Naitala: ${txt.title} ${templates.pesoExact(amountN)}`)
      setId(ulid())
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const canSave = amountN !== null && (!needsCustomer || !!customer) && !saving

  return (
    <Sheet open={open} onClose={onClose}>
      <h2>{txt.title}</h2>

      {needsCustomer && !customer && (
        <>
          <h3>{S.pera.customer}</h3>
          {creating ? (
            <div className="card soft">
              <div className="field">
                <label>{S.pera.customerName}</label>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
              </div>
              <div className="field">
                <label>{S.pera.customerPhone}</label>
                <input type="tel" inputMode="tel" value={newPhone} onChange={(e) => setNewPhone(e.target.value)} />
              </div>
              <div className="row">
                <button type="button" className="btn secondary sm" onClick={() => setCreating(false)}>
                  {S.paninda.cancel}
                </button>
                <button type="button" className="btn primary sm grow" disabled={!newName.trim()} onClick={createCustomer}>
                  {S.paninda.save}
                </button>
              </div>
            </div>
          ) : (
            <>
              <input className="search" placeholder={S.pera.searchCustomer} value={search} onChange={(e) => setSearch(e.target.value)} autoFocus={customers.length > 0} />
              <button type="button" className="cat-row" onClick={() => setCreating(true)}>
                <span>{S.pera.newCustomer}</span>
              </button>
              {filtered.map((c) => {
                const st = customerStates.get(c.id)
                return (
                  <button key={c.id} type="button" className="cat-row" onClick={() => setCustomerId(c.id)}>
                    <span>{c.name}</span>
                    <span className="meta">{st ? templates.pesoExact(st.balance) : '—'}</span>
                  </button>
                )
              })}
            </>
          )}
        </>
      )}

      {(!needsCustomer || customer) && (
        <>
          {customer && (
            <div className="card soft row between">
              <span className="bold">{customer.name}</span>
              <button type="button" className="btn ghost sm" onClick={() => setCustomerId(null)}>
                palitan
              </button>
            </div>
          )}

          <div className="field">
            <label>{txt.amount}</label>
            <input type="number" inputMode="decimal" min={0} step="0.01" placeholder="₱" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus={!!customer || !needsCustomer} />
            {amount.trim() !== '' && amountN === null && <div className="muted small" style={{ marginTop: 4 }}>{S.pera.invalidAmount}</div>}
            {kind === 'pera' && (
              <div className="muted small" style={{ marginTop: 4 }}>
                {S.pera.pera.hint}
              </div>
            )}
            {confirm && (
              <div className="card soft" style={{ marginTop: 8 }}>
                {confirm}
              </div>
            )}
          </div>

          {kind === 'gastos' && (
            <div className="field">
              <label>{S.pera.gastos.category}</label>
              <div className="chips">
                {EXPENSE_CATEGORIES.map((c) => (
                  <button key={c} type="button" className={`chip ${category === c ? 'on' : ''}`} onClick={() => setCategory(c)}>
                    {S.pera.categories[c]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {(kind === 'utang' || kind === 'gastos') && (
            <div className="field">
              <label>{kind === 'utang' ? S.pera.utang.note : S.pera.gastos.note}</label>
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={80} />
            </div>
          )}

          <div className="field">
            <label>{S.pera.when}</label>
            <Segment value={whenKind} options={[['ngayon', S.bumili.ngayon], ['kahapon', S.bumili.kahapon], ['date', S.bumili.ibangAraw]]} onChange={setWhenKind} />
            {whenKind === 'date' && <input type="date" value={date} max={toLocalDate(Date.now())} onChange={(e) => setDate(e.target.value)} style={{ marginTop: 8 }} />}
          </div>

          <button type="button" className="btn primary" onClick={save} disabled={!canSave}>
            {txt.save}
          </button>
        </>
      )}
    </Sheet>
  )
}
