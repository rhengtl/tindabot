import { useState } from 'react'
import { LANGS, type Lang, type Weekday } from '../../domain'
import { loadDemo } from '../../state/demo'
import { useApp } from '../../state/store'
import { useWrite } from '../components'
import { useLang, useStrings } from '../i18n'
import { AddProductSheet } from './AddProduct'

export function Onboarding() {
  const S = useStrings()
  const lang = useLang()
  const setLang = useApp((s) => s.setLang)
  const write = useWrite()
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
    // Onboarding cannot go on without the store actually being written, so a failure keeps the
    // person on this step with the toast rather than moving to a step about a store that does not
    // exist.
    if (!(await write(() => createStore(name.trim() || S.onboarding.defaultStoreName, whenNeeded ? [] : ([...days].sort() as Weekday[]))))) return
    setStep(2)
  }

  async function done() {
    if (!(await write(() => setMeta('onboarded', '1')))) return
    await init()
  }

  return (
    <div className="screen" style={{ paddingTop: 24 }}>
      {/* Language before anything else: someone meeting the app for the first time should be able
          to read the rest of onboarding. Same chips, same setLang() as Iba pa — one preference,
          stored once in Dexie meta; it stays chosen when onboarding finishes. */}
      <div className="chips onboarding-lang" role="group" aria-label={S.lang.title} data-testid="lang-chips">
        {LANGS.map((l: Lang) => (
          <button key={l} type="button" className={`chip ${lang === l ? 'on' : ''}`} data-testid={`lang-${l}`} aria-pressed={lang === l} onClick={() => setLang(l)}>
            {S.lang[l]}
          </button>
        ))}
      </div>

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
            <input aria-label={S.onboarding.storeName} value={name} placeholder={S.onboarding.storeNamePh} onChange={(e) => setName(e.target.value)} autoFocus />
          </div>
          <button type="button" className="btn primary" onClick={() => setStep(1)}>
            {S.onboarding.next}
          </button>
          <button
            type="button"
            className="btn ghost"
            style={{ width: '100%', marginTop: 8 }}
            onClick={async () => {
              if (!(await write(async () => { await loadDemo(); await setMeta('onboarded', '1') }))) return
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
