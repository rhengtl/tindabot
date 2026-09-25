// Geometry of the bottom-sheet drag, kept pure so the behaviour can be tested without a DOM.
// The sheet follows the finger downwards, resists upwards (it is already open, there is nowhere
// to go), and is dismissed either by dragging past a share of its own height or by a quick flick.

/** Upward movement is divided by this and clamped, so an upward swipe never dismisses. */
export const UP_RESISTANCE = 4
export const MAX_UP_PX = 24
/** A short sheet still needs a deliberate pull; a tall one is dismissed at a quarter of itself. */
export const MIN_DISMISS_PX = 64
export const DISMISS_FRACTION = 0.25
/** A flick counts even when short: px per ms, with a floor so a tap can never dismiss. */
export const FLICK_VELOCITY = 0.5
export const FLICK_MIN_PX = 32

/** How far the sheet is drawn for a finger that has moved `dy` from where it grabbed. */
export function dragOffset(dy: number): number {
  if (dy <= 0) return Math.max(-MAX_UP_PX, dy / UP_RESISTANCE)
  return dy
}

export function dismissThreshold(sheetHeight: number): number {
  return Math.max(MIN_DISMISS_PX, sheetHeight * DISMISS_FRACTION)
}

export function shouldDismiss({ dy, ms, sheetHeight }: { dy: number; ms: number; sheetHeight: number }): boolean {
  if (dy <= 0) return false
  if (dy >= dismissThreshold(sheetHeight)) return true
  const velocity = ms > 0 ? dy / ms : 0
  return dy >= FLICK_MIN_PX && velocity >= FLICK_VELOCITY
}
