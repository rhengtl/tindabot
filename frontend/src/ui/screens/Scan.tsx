import { useEffect, useMemo, useRef, useState } from 'react'
import { AiError, callAi } from '../../ai/client'
import { type DraftRow, isParseReply, parseProducts, rowUnits, savable, toRows } from '../../ai/drafts'
import { templates, toLocalDate, ulid } from '../../domain'
import { type DateChoice, useApp } from '../../state/store'
import { Segment, Sheet, useToast, useWrite } from '../components'
import { useStrings } from '../i18n'

// P3b receipt camera + P4 "Ilista" by text/voice (BLUEPRINT §F /ai/parse). The photo or note goes to
// the proxy once, comes back as drafts, and NOTHING is written until the owner presses "I-save".
// The photo is resized on the phone, sent, and dropped: it is never stored here or on the server.

export type ScanMode = 'photo' | 'text'

const MAX_SIDE = 1600

/** Downscales a photo to ≤ 1600 px on the long side as JPEG (receipts stay readable; uploads stay small). */
async function prepareImage(file: File): Promise<{ mime: string; data: string }> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close?.()
  const url = canvas.toDataURL('image/jpeg', 0.8)
  return { mime: 'image/jpeg', data: url.slice(url.indexOf(',') + 1) }
}

type SpeechCtor = new () => { lang: string; interimResults: boolean; onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void; onend: () => void; onerror: () => void; start: () => void; stop: () => void }
function speechRecognition(): SpeechCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function ScanSheet({ open, mode, onClose }: { open: boolean; mode: ScanMode; onClose: () => void }) {
  const products = useApp((s) => s.products)
  const lang = useApp((s) => s.lang)
  const aiToken = useApp((s) => s.aiToken)
  const signedIn = useApp((s) => !!s.cloud.sync.user)
  const recordEntries = useApp((s) => s.recordEntries)
  const S = useStrings()
  const toast = useToast()
  const write = useWrite()
  const cameraRef = useRef<HTMLInputElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<DraftRow[] | null>(null)
  const [ids, setIds] = useState<Record<string, string>>({})
  const [unreadable, setUnreadable] = useState<string[]>([])
  const [whenKind, setWhenKind] = useState<'ngayon' | 'kahapon' | 'date'>('ngayon')
  const [date, setDate] = useState(toLocalDate(Date.now()))
  const [listening, setListening] = useState(false)
  const Speech = typeof window !== 'undefined' ? speechRecognition() : null

  useEffect(() => {
    if (!open) return
    setText('')
    setRows(null)
    setUnreadable([])
    setError(null)
    setWhenKind('ngayon')
  }, [open, mode])

  const active = useMemo(() => products.filter((p) => !p.archived), [products])
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])
  const toSave = rows ? savable(rows, byId) : []

  async function read(input: { image?: { mime: string; data: string }; text?: string }) {
    setBusy(true)
    setError(null)
    try {
      const { list, ids: productIds } = parseProducts(active)
      const reply = await callAi<unknown>({ op: 'parse', ...input, products: list, lang }, aiToken)
      if (!isParseReply(reply)) throw new AiError('failed')
      const r = toRows(reply, productIds)
      setRows(r.rows)
      setUnreadable(r.unreadable)
      setIds(Object.fromEntries(r.rows.map((x) => [x.key, ulid()]))) // write-once ids for this review
    } catch (e) {
      setError(S.ai.errors[e instanceof AiError ? e.code : 'failed'])
    } finally {
      setBusy(false)
    }
  }

  async function onFile(f: File | undefined) {
    if (!f) return
    try {
      await read({ image: await prepareImage(f) })
    } catch {
      setError(S.ai.errors.failed)
    }
  }

  function listen() {
    if (!Speech) return
    const r = new Speech()
    r.lang = lang === 'tl' ? 'fil-PH' : 'en-PH'
    r.interimResults = false
    r.onresult = (e) => setText((t) => `${t}${t ? ' ' : ''}${e.results[0]?.[0]?.transcript ?? ''}`.trim())
    r.onend = () => setListening(false)
    r.onerror = () => setListening(false)
    setListening(true)
    r.start()
  }

  const patch = (key: string, p: Partial<DraftRow>) => setRows((rs) => rs && rs.map((r) => (r.key === key ? { ...r, ...p } : r)))

  async function save() {
    if (toSave.length === 0) return
    const when: DateChoice = whenKind === 'date' ? { kind: 'date', date } : { kind: whenKind }
    const entries = toSave.map(({ row, units }) => ({ id: ids[row.key] ?? ulid(), kind: row.kind, product_id: row.product_id!, qty_units: units, total_cost: row.kind === 'purchase' ? row.total_cost : null, supplier: row.supplier }))
    if (!(await write(() => recordEntries(entries, when)))) return
    toast(S.scan.saved(entries.length))
    onClose()
  }

  return (
    <Sheet open={open} onClose={onClose}>
      <h2>{mode === 'photo' ? S.scan.title : S.scan.textTitle}</h2>
      {!signedIn ? (
        <div className="card soft small">{S.ai.signInFirst}</div>
      ) : rows === null ? (
        mode === 'photo' ? (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              {S.scan.imageNote}
            </p>
            <div className="row">
              <button type="button" className="btn primary grow" disabled={busy} data-testid="scan-camera" onClick={() => cameraRef.current?.click()}>
                {busy ? S.scan.reading : S.scan.take}
              </button>
              <button type="button" className="btn secondary" disabled={busy} onClick={() => galleryRef.current?.click()}>
                {S.scan.choose}
              </button>
            </div>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
            <input ref={galleryRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = '' }} />
          </>
        ) : (
          <>
            <p className="muted small" style={{ marginTop: 0 }}>
              {S.scan.textHint}
            </p>
            <textarea aria-label={S.scan.textTitle} data-testid="scan-text" rows={4} maxLength={2000} placeholder={S.scan.textPlaceholder} value={text} onChange={(e) => setText(e.target.value)} style={{ width: '100%' }} />
            <div className="row" style={{ marginTop: 8 }}>
              {Speech && (
                <button type="button" className="btn secondary" disabled={busy || listening} onClick={listen}>
                  {listening ? S.scan.listening : S.scan.mic}
                </button>
              )}
              <button type="button" className="btn primary grow" data-testid="scan-read" disabled={busy || !text.trim()} onClick={() => read({ text: text.trim() })}>
                {busy ? S.scan.reading : S.scan.read}
              </button>
            </div>
          </>
        )
      ) : (
        <>
          <h3>{S.scan.review}</h3>
          {rows.length === 0 && <p className="muted">{S.scan.none}</p>}
          {rows.map((r) => {
            const p = r.product_id ? byId.get(r.product_id) : undefined
            const units = rowUnits(r, p)
            return (
              <div key={r.key} className="card soft" data-testid="draft-row">
                <div className="row between" style={{ alignItems: 'center' }}>
                  <label className="row" style={{ alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={r.include} onChange={(e) => patch(r.key, { include: e.target.checked })} />
                    <span className="badge grey">{r.kind === 'purchase' ? S.scan.kindPurchase : S.scan.kindCount}</span>
                  </label>
                  <span className="muted small">"{r.name_seen}"</span>
                </div>
                <select aria-label={S.scan.pick} value={r.product_id ?? ''} onChange={(e) => patch(r.key, { product_id: e.target.value || null, include: !!e.target.value })} style={{ width: '100%', marginTop: 6 }}>
                  <option value="">{r.product_id ? S.scan.pick : S.scan.notInStore(r.name_seen)}</option>
                  {active.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
                <div className="row" style={{ marginTop: 6, alignItems: 'center' }}>
                  <input aria-label={S.scan.qty} type="number" inputMode="decimal" min={0} value={r.qty} onChange={(e) => patch(r.key, { qty: Number(e.target.value) })} style={{ maxWidth: 80 }} />
                  {p && (
                    <div className="grow">
                      <Segment value={r.qty_unit} options={[['pack', p.pack_label], ['unit', p.unit_label]]} onChange={(v) => patch(r.key, { qty_unit: v })} />
                    </div>
                  )}
                  {r.kind === 'purchase' && (
                    <input aria-label={S.scan.total} type="number" inputMode="decimal" min={0} placeholder={S.scan.total} value={r.total_cost ?? ''} onChange={(e) => patch(r.key, { total_cost: e.target.value === '' ? null : Number(e.target.value) })} style={{ maxWidth: 100 }} />
                  )}
                </div>
                {p && units !== null && (
                  <div className="muted small" style={{ marginTop: 4 }}>
                    = {units} {p.unit_label}
                    {r.kind === 'purchase' && r.total_cost !== null && units > 0 && ` · ${templates.peso(r.total_cost / units)} / ${p.unit_label}`}
                    {r.supplier && ` · ${r.supplier}`}
                  </div>
                )}
              </div>
            )
          })}
          {unreadable.length > 0 && (
            <div className="card flag small">
              {S.scan.unreadable} {unreadable.join(', ')}
            </div>
          )}
          <div className="field">
            <label>{S.scan.when}</label>
            <Segment value={whenKind} options={[['ngayon', S.bumili.ngayon], ['kahapon', S.bumili.kahapon], ['date', S.bumili.ibangAraw]]} onChange={setWhenKind} />
            {whenKind === 'date' && <input aria-label={S.scan.when} type="date" value={date} max={toLocalDate(Date.now())} onChange={(e) => setDate(e.target.value)} style={{ marginTop: 8 }} />}
          </div>
          <div className="row">
            <button type="button" className="btn secondary" onClick={() => setRows(null)}>
              {S.scan.again}
            </button>
            <button type="button" className="btn primary grow" data-testid="scan-save" disabled={toSave.length === 0} onClick={save}>
              {S.scan.save(toSave.length)}
            </button>
          </div>
        </>
      )}
      {error && (
        <div className="card flag small" data-testid="ai-error" style={{ marginTop: 8 }}>
          {error}
        </div>
      )}
    </Sheet>
  )
}
