import { useEffect, useRef, useState } from 'react'
import { LANGS, type Lang, type Weekday } from '../../domain'
import { useApp } from '../../state/store'
import { useToast, useWrite } from '../components'
import { importFailureKind } from '../write'
import { exportCurrentStore } from '../exportFile'
import { useLang, useStrings } from '../i18n'
import { CloudCard } from './Cloud'
import { CsvImportCard } from './CsvImport'
import { HouseholdCard } from './Household'
import type { ScanMode } from './Scan'
import { DemoExit } from './DemoExit'
import { StoresCard } from './Stores'
import { UlatCard } from './Ulat'

export function IbaPa({ onGastos, onPera, onAsk, onScan }: { onGastos: () => void; onPera: () => void; onAsk: () => void; onScan: (mode: ScanMode) => void }) {
  const store = useApp((s) => s.store)
  // Household member: the store row (name, days, multipliers) is the owner's (BLUEPRINT §E7).
  const member = useApp((s) => s.member)
  const persisted = useApp((s) => s.persisted)
  const updateStore = useApp((s) => s.updateStore)
  const importJson = useApp((s) => s.importJson)
  const meta = useApp((s) => s.meta)
  const setLang = useApp((s) => s.setLang)
  const lang = useLang()
  const S = useStrings()
  const toast = useToast()
  const write = useWrite()
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
    // Both routes that got the file out of the app count as a backup date; the wording keeps the
    // difference honest, because only the browser knows where a download finally lands.
    const outcome = await exportCurrentStore()
    if (outcome === 'shared' || outcome === 'download_started') {
      setLastBackup(new Date().toISOString())
      toast(outcome === 'shared' ? S.common.exported : S.ibaPa.exportStarted)
    } else if (outcome === 'failed') {
      toast(S.ibaPa.exportFailed)
    }
  }

  async function doImport(f: File) {
    const text = await f.text()
    const reportFailure = (e: unknown) => {
      console.error('[tindabot] import failed:', e) // the reason for diagnosis; the toast for the person
      toast(importFailureKind(e) === 'not_export_file' ? S.ibaPa.importNotExport : S.ibaPa.importFailed)
    }
    try {
      const r = await importJson(text, 'merge')
      toast(S.ibaPa.imported(r.added_events))
      return
    } catch (e) {
      if (importFailureKind(e) !== 'different_store') return reportFailure(e)
    }
    // Replacing is the destructive path, so it reports its own failures too: the import itself rolls
    // back as one transaction (see repo.importFile), and the person is told it did not happen.
    if (!window.confirm(S.ibaPa.importReplaceQ)) return
    try {
      const r = await importJson(text, 'replace')
      toast(S.ibaPa.imported(r.added_events))
    } catch (e) {
      reportFailure(e)
    }
  }

  const toggleDay = (d: Weekday) => {
    const set = new Set(store!.restock_days)
    if (set.has(d)) set.delete(d)
    else set.add(d)
    void write(() => updateStore({ restock_days: [...set].sort() as Weekday[] }))
  }

  const backupOld = !lastBackup || Date.now() - Date.parse(lastBackup) > 30 * 86_400_000

  return (
    <>
      <h2>{S.ibaPa.title}</h2>

      <DemoExit hint />

      <StoresCard />

      {backupOld && <div className="card flag">{S.ibaPa.backupNudge}</div>}

      <h3>{S.ibaPa.katulong}</h3>
      <div className="card" data-testid="katulong">
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="btn secondary sm" data-testid="open-ask" onClick={onAsk}>
            💬 {S.ask.title}
          </button>
          <button type="button" className="btn secondary sm" onClick={() => onScan('photo')}>
            📷 {S.scan.title}
          </button>
          <button type="button" className="btn secondary sm" onClick={() => onScan('text')}>
            ✍️ {S.scan.textTitle}
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          {S.ibaPa.katulongHint}
        </p>
      </div>

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
        {member && <p className="muted small" data-testid="member-note">{S.ibaPa.memberNote}</p>}
        <div className="field">
          <label>{S.ibaPa.storeName}</label>
          <input aria-label={S.ibaPa.storeName} disabled={member} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { if (name.trim() && name !== store.name) void write(() => updateStore({ name: name.trim() })) }} />
        </div>
        <div className="field">
          <label>{S.ibaPa.restockDays}</label>
          <div className="chips">
            {S.days.map((d, i) => (
              <button key={d} type="button" disabled={member} className={`chip ${store.restock_days.includes(i as Weekday) ? 'on' : ''}`} onClick={() => toggleDay(i as Weekday)}>
                {d}
              </button>
            ))}
            <button type="button" disabled={member} className={`chip ${store.restock_days.length === 0 ? 'on' : ''}`} onClick={() => write(() => updateStore({ restock_days: [] }))}>
              {S.onboarding.whenNeeded}
            </button>
          </div>
        </div>
      </div>

      <UlatCard onGastos={onGastos} onPera={onPera} />

      <CloudCard />

      <HouseholdCard />

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
      <CsvImportCard />

      <h3>{S.ibaPa.advanced}</h3>
      <div className="card">
        {/* Same disclosure convention as the "Wag muna" section on Bahay: the arrow says which
            way it goes, the word says the state. */}
        <button
          type="button"
          className="btn secondary sm disclosure"
          data-testid="advanced-toggle"
          aria-expanded={showAdvanced}
          aria-controls="advanced-settings"
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? S.common.hide : S.common.show} <span aria-hidden="true">{showAdvanced ? '▲' : '▼'}</span>
        </button>
        {showAdvanced && (
          <div id="advanced-settings">
            <div className="field">
              <label style={{ marginTop: 6 }}>{S.ibaPa.payday} (×)</label>
              <input aria-label={`${S.ibaPa.payday} (×)`} disabled={member} type="number" step="0.05" min={1} max={2} value={store.multipliers.payday} onChange={(e) => write(() => updateStore({ multipliers: { ...store.multipliers, payday: Number(e.target.value) || 1 } }))} />
            </div>
            <div className="field">
              <label>{S.ibaPa.friSat} (×)</label>
              <input aria-label={`${S.ibaPa.friSat} (×)`} disabled={member} type="number" step="0.05" min={1} max={2} value={store.multipliers.fri_sat} onChange={(e) => write(() => updateStore({ multipliers: { ...store.multipliers, fri_sat: Number(e.target.value) || 1 } }))} />
            </div>
          </div>
        )}
      </div>

      <h3>{S.ibaPa.about}</h3>
      <div className="card muted small">{S.ibaPa.aboutText}</div>
    </>
  )
}
