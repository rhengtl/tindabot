import { useEffect, useRef, useState } from 'react'
import { LANGS, type Lang, type Weekday } from '../../domain'
import { loadDemo } from '../../state/demo'
import { useApp } from '../../state/store'
import { useToast } from '../components'
import { exportCurrentStore } from '../exportFile'
import { useLang, useStrings } from '../i18n'
import { CloudCard } from './Cloud'
import { UlatCard } from './Ulat'

export function IbaPa({ onGastos, onPera }: { onGastos: () => void; onPera: () => void }) {
  const store = useApp((s) => s.store)
  const persisted = useApp((s) => s.persisted)
  const updateStore = useApp((s) => s.updateStore)
  const importJson = useApp((s) => s.importJson)
  const init = useApp((s) => s.init)
  const meta = useApp((s) => s.meta)
  const setLang = useApp((s) => s.setLang)
  const lang = useLang()
  const S = useStrings()
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState(store?.name ?? '')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [lastBackup, setLastBackup] = useState<string | null>(null)

  useEffect(() => {
    setName(store?.name ?? '')
  }, [store?.name])
  useEffect(() => {
    meta('last_backup_at').then(setLastBackup)
  }, [meta])

  if (!store) return null

  async function doExport() {
    if (await exportCurrentStore()) {
      setLastBackup(new Date().toISOString())
      toast(S.common.exported)
    }
  }

  async function doImport(f: File) {
    const text = await f.text()
    try {
      const r = await importJson(text, 'merge')
      toast(S.ibaPa.imported(r.added_events))
    } catch (e) {
      if ((e as Error).message === 'different_store') {
        if (window.confirm(S.ibaPa.importReplaceQ)) {
          const r = await importJson(text, 'replace')
          toast(S.ibaPa.imported(r.added_events))
        }
      } else toast((e as Error).message === 'not_export_file' ? S.ibaPa.importNotExport : S.ibaPa.importFailed)
    }
  }

  const toggleDay = (d: Weekday) => {
    const set = new Set(store!.restock_days)
    if (set.has(d)) set.delete(d)
    else set.add(d)
    updateStore({ restock_days: [...set].sort() as Weekday[] })
  }

  const backupOld = !lastBackup || Date.now() - Date.parse(lastBackup) > 30 * 86_400_000

  return (
    <>
      <h2>{S.ibaPa.title}</h2>

      {backupOld && <div className="card flag">{S.ibaPa.backupNudge}</div>}

      <h3>{S.ibaPa.settings}</h3>
      <div className="card">
        <div className="field">
          <label>{S.lang.title}</label>
          <div className="chips" data-testid="lang-chips">
            {LANGS.map((l: Lang) => (
              <button key={l} type="button" className={`chip ${lang === l ? 'on' : ''}`} data-testid={`lang-${l}`} aria-pressed={lang === l} onClick={() => setLang(l)}>
                {S.lang[l]}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label>{S.ibaPa.storeName}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== store.name && updateStore({ name: name.trim() })} />
        </div>
        <div className="field">
          <label>{S.ibaPa.restockDays}</label>
          <div className="chips">
            {S.days.map((d, i) => (
              <button key={d} type="button" className={`chip ${store.restock_days.includes(i as Weekday) ? 'on' : ''}`} onClick={() => toggleDay(i as Weekday)}>
                {d}
              </button>
            ))}
            <button type="button" className={`chip ${store.restock_days.length === 0 ? 'on' : ''}`} onClick={() => updateStore({ restock_days: [] })}>
              {S.onboarding.whenNeeded}
            </button>
          </div>
        </div>
      </div>

      <UlatCard onGastos={onGastos} onPera={onPera} />

      <CloudCard />

      <h3>{S.ibaPa.backup}</h3>
      <div className="card">
        <button type="button" className="btn primary" onClick={doExport}>
          {S.ibaPa.export}
        </button>
        <p className="muted small" style={{ margin: '8px 0 14px' }}>
          {S.ibaPa.exportHint}
        </p>
        <button type="button" className="btn secondary" style={{ width: '100%' }} onClick={() => fileRef.current?.click()}>
          {S.ibaPa.import}
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && doImport(e.target.files[0])} />
        <p className="muted small" style={{ marginTop: 8 }}>
          {S.ibaPa.importHint}
        </p>
        <p className="muted small" style={{ marginTop: 8 }}>
          {S.ibaPa.persisted(persisted)}
        </p>
      </div>

      <h3>{S.ibaPa.advanced}</h3>
      <div className="card">
        <button type="button" className="btn ghost" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? S.common.hide : S.common.show}
        </button>
        {showAdvanced && (
          <>
            <div className="field">
              <label>{S.ibaPa.payday} (×)</label>
              <input type="number" step="0.05" min={1} max={2} value={store.multipliers.payday} onChange={(e) => updateStore({ multipliers: { ...store.multipliers, payday: Number(e.target.value) || 1 } })} />
            </div>
            <div className="field">
              <label>{S.ibaPa.friSat} (×)</label>
              <input type="number" step="0.05" min={1} max={2} value={store.multipliers.fri_sat} onChange={(e) => updateStore({ multipliers: { ...store.multipliers, fri_sat: Number(e.target.value) || 1 } })} />
            </div>
            <button
              type="button"
              className="btn danger sm"
              onClick={async () => {
                if (!window.confirm(S.ibaPa.demoHint)) return
                await loadDemo()
                await init()
                toast(S.ibaPa.demoLoaded)
              }}
            >
              {S.ibaPa.demo}
            </button>
          </>
        )}
      </div>

      <h3>{S.ibaPa.about}</h3>
      <div className="card muted small">{S.ibaPa.aboutText}</div>
    </>
  )
}
