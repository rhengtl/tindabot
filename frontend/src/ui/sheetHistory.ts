// Back is how people dismiss things on Android. A bottom sheet is not a page, so the browser knows
// nothing about it: with a sheet open, a back press used to close the tab and leave the app
// altogether (verified on the phone, 2026-09-29), taking a half-filled entry with it.
//
// So each opening adds one history entry and each closing takes it back out: back dismisses the
// sheet, and with no sheet open nothing is registered and back does exactly what it always did. The
// URL never changes — the sheet stays app state, not a route — and tabs are untouched.
//
// The browser lives behind a small port so the rule itself can be tested without a DOM.

export interface HistoryPort {
  /** Adds one same-document entry. Must not change the URL. */
  push(): void
  /** Goes back one entry. The resulting pop arrives through the `onPop` listener, as the browser's does. */
  back(): void
  /** Subscribes to back/forward navigation; returns the unsubscribe. */
  onPop(listener: () => void): () => void
}

export interface SheetHistory {
  /** Registers a sheet that has just opened; returns the release to call when it closes by any other route. */
  open(close: () => void): () => void
  /** How many sheets are currently holding an entry (tests and diagnostics). */
  readonly depth: number
  /** Whether anything is listening for back presses right now (tests and diagnostics). */
  readonly listening: boolean
}

interface Entry {
  close: () => void
}

export function createSheetHistory(port: HistoryPort): SheetHistory {
  const stack: Entry[] = []
  let unsubscribe: (() => void) | null = null
  /** Pops this module asked for itself (a sheet closed by its own buttons) close nothing. */
  let selfPops = 0

  function stopListening() {
    unsubscribe?.()
    unsubscribe = null
  }

  function onPop() {
    if (selfPops > 0) {
      selfPops--
      if (stack.length === 0) stopListening()
      return
    }
    const entry = stack.pop()
    if (stack.length === 0) stopListening()
    // No entry of ours means the person went back past the app's own history: leave it alone.
    entry?.close()
  }

  function release(entry: Entry) {
    const at = stack.indexOf(entry)
    if (at === -1) return // a back press already consumed it
    stack.splice(at, 1)
    selfPops++
    port.back() // take our entry out again, so the next back press is the app's own
  }

  return {
    open(close: () => void): () => void {
      const entry: Entry = { close }
      port.push()
      stack.push(entry)
      if (!unsubscribe) unsubscribe = port.onPop(onPop)
      return () => release(entry)
    },
    get depth() {
      return stack.length
    },
    get listening() {
      return unsubscribe !== null
    },
  }
}

/** Marks the entries this module pushes, so a leftover one after a reload can be recognised. */
export const SHEET_HISTORY_MARKER = 'tindabotSheet'

/** The real browser, wired so that pushing an entry never touches the URL or the rest of `history.state`. */
export const browserHistoryPort: HistoryPort = {
  push() {
    const state = (history.state ?? {}) as Record<string, unknown>
    history.pushState({ ...state, [SHEET_HISTORY_MARKER]: true }, '')
  },
  back() {
    history.back()
  },
  onPop(listener) {
    window.addEventListener('popstate', listener)
    return () => window.removeEventListener('popstate', listener)
  },
}

/**
 * A reload with a sheet open leaves one of our entries behind, pointing at the same page. The entry
 * itself cannot be removed, but its marker can, so nothing later mistakes it for an open sheet; the
 * only consequence is one extra back press on that first screen.
 */
export function forgetStaleSheetEntry(): void {
  const state = (history.state ?? {}) as Record<string, unknown>
  if (!state[SHEET_HISTORY_MARKER]) return
  const { [SHEET_HISTORY_MARKER]: _stale, ...rest } = state
  history.replaceState(rest, '')
}

export const sheetHistory = createSheetHistory(browserHistoryPort)
