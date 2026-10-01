import { useRef, useState } from 'react'
import { CSV_TEMPLATE, type ProductCsvResult, productsFromCsv } from '../../domain'
import { useApp } from '../../state/store'
import { useToast, useWrite } from '../components'
import { useStrings } from '../i18n'

// P5 CSV import (decided 2026-10-01): products only, from a spreadsheet. Shows what will be added
// and what is left out (bad rows, names the store already has) before anything is written; existing
// products are never changed.
export function CsvImportCard() {
  const S = useStrings()
  const toast = useToast()
  const write = useWrite()
  const products = useApp((s) => s.products)
  const importProducts = useApp((s) => s.importProducts)
  const fileRef = useRef<HTMLInputElement>(null)
  const [result, setResult] = useState<ProductCsvResult | null>(null)

  const have = new Set(products.map((p) => p.name.trim().toLowerCase()))
  const fresh = result ? result.rows.filter((r) => !have.has(r.name.toLowerCase())) : []
  const existing = result ? result.rows.filter((r) => have.has(r.name.toLowerCase())) : []

  async function onFile(f: File | undefined) {
    if (!f) return
    try {
      setResult(productsFromCsv(await f.text()))
    } catch {
      toast(S.csv.failed)
    }
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([CSV_TEMPLATE], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'tindabot-paninda.csv'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function add() {
    let n = 0
    if (!(await write(async () => (n = await importProducts(fresh))))) return
    toast(S.csv.added(n))
    setResult(null)
  }

  return (
    <div className="card" data-testid="csv">
      <div className="bold">{S.csv.title}</div>
      <p className="muted small" style={{ margin: '6px 0 10px' }}>
        {S.csv.hint}
      </p>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button type="button" className="btn secondary sm" onClick={() => fileRef.current?.click()}>
          {S.csv.choose}
        </button>
        <button type="button" className="btn ghost sm" onClick={downloadTemplate}>
          {S.csv.template}
        </button>
      </div>
      <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" style={{ display: 'none' }} data-testid="csv-file" onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
      {result && !result.header_ok && <div className="card flag small" style={{ marginTop: 8 }}>{S.csv.noHeader}</div>}
      {result && result.header_ok && (
        <div style={{ marginTop: 10 }} data-testid="csv-preview">
          <div className="bold">{S.csv.ready(fresh.length)}</div>
          <div className="muted small">{fresh.slice(0, 8).map((r) => r.name).join(', ')}{fresh.length > 8 ? ` +${fresh.length - 8}` : ''}</div>
          {(result.errors.length > 0 || existing.length > 0) && (
            <div className="small" style={{ marginTop: 6 }}>
              <span className="muted">{S.csv.skipped} </span>
              {[...existing.map((r) => `${S.csv.line(r.line)}: ${S.csv.exists}`), ...result.errors.map((e) => `${S.csv.line(e.line)}: ${S.csv.errors[e.reason]}`)].slice(0, 10).join(' · ')}
            </div>
          )}
          <button type="button" className="btn primary" style={{ marginTop: 10 }} data-testid="csv-add" disabled={fresh.length === 0} onClick={add}>
            {S.csv.add(fresh.length)}
          </button>
        </div>
      )}
    </div>
  )
}
