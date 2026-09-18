import { useState } from 'react'
import type { Weekday } from '../../domain'
import { loadDemo } from '../../state/demo'
import { useApp } from '../../state/store'
import { useStrings } from '../i18n'
import { AddProductSheet } from './AddProduct'

export function Onboarding() {
  const S = useStrings()
  const createStore = useApp((s) => s.createStore)
  const init = useApp((s) => s.init)
  const store = useApp((s) => s.store)
  const products = useApp((s) => s.products)
  const setMeta = useApp((s) => s.setMeta)
  const [step, setStep] = useState(store ? 2 : 0)
  const [name, setName] = useState('')
  const [days, setDays] = useState<Set<Weekday>>(new Set([3, 6]))
  const [whenNeeded, setWhenNeeded] = useState(false)
  const [adding, setAdding] = useState(false)

  const toggle = (d: Weekday) => {
    const s = new Set(days)
    if (s.has(d)) s.delete(d)
    else s.add(d)
    setDays(s)
    setWhenNeeded(false)
  }

  async function finishStore() {
    await createStore(name.trim() || S.onboarding.defaultStoreName, whenNeeded ? [] : ([...days].sort() as Weekday[]))
    setStep(2)
  }

  async function done() {
    await setMeta('onboarded', '1')
    await init()
  }

  return (
    <div className="screen" style={{ paddingTop: 24 }}>
      <div className="step-dots">
        {[0, 1, 2].map((i) => (
          <span key={i} className={i <= step ? 'on' : ''} />
        ))}
      </div>

      {step === 0 && (
        <>
          <div style={{ textAlign: 'center', fontSize: '3rem' }}>🏪</div>
          <h2 style={{ textAlign: 'center' }}>{S.onboarding.welcome}</h2>
          <p className="muted" style={{ textAlign: 'center', marginBottom: 20, lineHeight: 1.5 }}>
            {S.onboarding.intro}
          </p>
          <div className="field">
            <label>{S.onboarding.storeName}</label>
            <input value={name} placeholder={S.onboarding.storeNamePh} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <button type="button" className="btn primary" onClick={() => setStep(1)}>
            {S.onboarding.next}
          </button>
          <button
            type="button"
            className="btn ghost"
            style={{ width: '100%', marginTop: 8 }}
            onClick={async () => {
              await loadDemo()
              await setMeta('onboarded', '1')
              await init()
            }}
          >
            {S.ibaPa.demo}
          </button>
        </>
      )}

      {step === 1 && (
        <>
          <h2>{S.onboarding.restockQ}</h2>
          <p className="muted" style={{ marginBottom: 14 }}>
            {S.onboarding.restockHint}
          </p>
          <div className="chips" style={{ marginBottom: 20 }}>
            {S.daysLong.map((d, i) => (
              <button key={d} type="button" className={`chip ${!whenNeeded && days.has(i as Weekday) ? 'on' : ''}`} onClick={() => toggle(i as Weekday)}>
                {d}
              </button>
            ))}
            <button type="button" className={`chip ${whenNeeded ? 'on' : ''}`} onClick={() => setWhenNeeded(true)}>
              {S.onboarding.whenNeeded}
            </button>
          </div>
          <button type="button" className="btn primary" onClick={finishStore} disabled={!whenNeeded && days.size === 0}>
            {S.onboarding.next}
          </button>
        </>
      )}

      {step === 2 && (
        <>
          <h2>{S.onboarding.addProducts}</h2>
          <p className="muted" style={{ marginBottom: 14 }}>
            {S.onboarding.addHint}
          </p>
          <div className="card">
            {products.length === 0 && <div className="muted small">{S.bahay.empty}</div>}
            {products.map((p) => (
              <div key={p.id} className="line">
                <span className="name">{p.name}</span>
              </div>
            ))}
          </div>
          <button type="button" className="btn secondary" style={{ width: '100%', marginBottom: 10 }} onClick={() => setAdding(true)}>
            ＋ {S.paninda.add}
          </button>
          <button type="button" className="btn primary" onClick={done}>
            {products.length > 0 ? S.onboarding.finish : S.onboarding.skip}
          </button>
          <AddProductSheet open={adding} onClose={() => setAdding(false)} />
        </>
      )}
    </div>
  )
}
