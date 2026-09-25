import { createContext, useCallback, useContext, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { dragOffset, shouldDismiss } from './sheetDrag'

// ---------- Sheet (bottom modal) ----------
// The grip at the top is the drag area: pull it down and the sheet follows the finger, release
// past the threshold and it closes. Only the grip takes the gesture, so lists, forms and the
// keyboard inside the sheet keep scrolling and behaving normally. Dragging is an extra way out —
// the backdrop, Escape and each sheet's own buttons still close it — so the grip stays decorative
// for assistive technology. On desktop the sheet is a centred dialog and the grip is hidden (CSS).
export function Sheet({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; startY: number; startMs: number; dy: number } | null>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null

  const draw = (dy: number | null) => {
    const el = sheetRef.current
    if (!el) return
    el.style.transition = dy === null ? '' : 'none'
    el.style.transform = dy === null ? '' : `translateY(${dragOffset(dy)}px)`
  }
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button > 0) return // right/middle click is not a drag
    // Deliberately no blur() here: hiding the keyboard mid-gesture makes Android cancel the touch
    // stream, and sheets that focus a field on open (Bumili, AddProduct, Pera) then never finish
    // the drag. The keyboard goes away by itself when the sheet closes.
    drag.current = { id: e.pointerId, startY: e.clientY, startMs: e.timeStamp, dy: 0 }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    draw(0)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    d.dy = e.clientY - d.startY
    draw(d.dy)
  }
  /** After a real drag, swallow the click the browser sends to whatever is under the finger —
   *  otherwise releasing over a button (e.g. "Ibang araw") taps it. */
  const swallowNextClick = () => {
    const el = sheetRef.current
    if (!el) return
    const stop = (ev: Event) => {
      ev.stopPropagation()
      ev.preventDefault()
    }
    el.addEventListener('click', stop, { capture: true, once: true })
    // if no click follows (the usual case on desktop), drop the listener again
    window.setTimeout(() => el.removeEventListener('click', stop, { capture: true } as EventListenerOptions), 400)
  }
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    if (Math.abs(d.dy) > 8) swallowNextClick()
    const height = sheetRef.current?.getBoundingClientRect().height ?? 0
    if (shouldDismiss({ dy: d.dy, ms: Math.max(0, e.timeStamp - d.startMs), sheetHeight: height })) {
      draw(null)
      onClose()
      return
    }
    draw(null) // springs back to the open position
  }

  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" ref={sheetRef} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div
          className="sheet-grip"
          data-testid="sheet-grip"
          aria-hidden="true"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div className="handle" />
        </div>
        {children}
      </div>
    </div>
  )
}

// ---------- Toast ----------
const ToastCtx = createContext<(msg: string) => void>(() => {})
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null)
  const timer = useRef<number | null>(null)
  const show = useCallback((m: string) => {
    setMsg(m)
    if (timer.current !== null) window.clearTimeout(timer.current) // a newer toast keeps its full duration
    timer.current = window.setTimeout(() => setMsg(null), 2600)
  }, [])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast">{msg}</div>}
    </ToastCtx.Provider>
  )
}
export const useToast = () => useContext(ToastCtx)

// ---------- Number pad ----------
export function NumberPad({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const press = (k: string) => {
    if (k === '⌫') onChange(value.slice(0, -1))
    else if (k === 'C') onChange('')
    else if (value.length < 6) onChange(value === '0' ? k : value + k)
  }
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫']
  return (
    <div className="numpad">
      {keys.map((k) => (
        <button key={k} type="button" onClick={() => press(k)} aria-label={k}>
          {k}
        </button>
      ))}
    </div>
  )
}

// ---------- Segmented control ----------
export function Segment<T extends string>({ value, options, onChange }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="segment">
      {options.map(([v, label]) => (
        <button key={v} type="button" className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

export function Dot({ urgency }: { urgency: 'red' | 'orange' | 'yellow' | 'green' | 'grey' }) {
  return <span className={`dot ${urgency}`} />
}

export function fmtNum(n: number, digits = 1): string {
  const r = Math.round(n * 10 ** digits) / 10 ** digits
  return Number.isInteger(r) ? String(r) : r.toFixed(digits)
}
