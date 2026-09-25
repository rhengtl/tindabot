// The rules behind the sheet drag: follow the finger down, resist upward, dismiss only on a
// deliberate pull or a flick. Kept pure so it is tested here; the wiring (which element takes the
// gesture, what scrolls) is covered by the browser and device runs.
import { describe, expect, it } from 'vitest'
import { DISMISS_FRACTION, MAX_UP_PX, MIN_DISMISS_PX, dismissThreshold, dragOffset, shouldDismiss } from '../sheetDrag'

const TALL = 600 // a full-height sheet on a phone
const SHORT = 180 // a small confirmation sheet

describe('how far the sheet is drawn', () => {
  it('follows the finger one-to-one downwards', () => {
    for (const dy of [1, 20, 120, 400]) expect(dragOffset(dy)).toBe(dy)
  })

  it('resists upwards and never runs away with it', () => {
    expect(dragOffset(-40)).toBe(-10)
    expect(dragOffset(-400)).toBe(-MAX_UP_PX)
    expect(dragOffset(0)).toBe(0)
  })
})

describe('when the sheet is dismissed', () => {
  it('a quarter of the sheet is enough, less is not', () => {
    expect(dismissThreshold(TALL)).toBe(TALL * DISMISS_FRACTION)
    expect(shouldDismiss({ dy: TALL * DISMISS_FRACTION, ms: 900, sheetHeight: TALL })).toBe(true)
    expect(shouldDismiss({ dy: TALL * DISMISS_FRACTION - 1, ms: 900, sheetHeight: TALL })).toBe(false)
  })

  it('a small sheet still needs a deliberate pull', () => {
    expect(dismissThreshold(SHORT)).toBe(MIN_DISMISS_PX)
    expect(shouldDismiss({ dy: 50, ms: 900, sheetHeight: SHORT })).toBe(false)
    expect(shouldDismiss({ dy: MIN_DISMISS_PX, ms: 900, sheetHeight: SHORT })).toBe(true)
  })

  it('a quick flick down counts even when short', () => {
    expect(shouldDismiss({ dy: 40, ms: 60, sheetHeight: TALL })).toBe(true) // 0.67 px/ms
    expect(shouldDismiss({ dy: 40, ms: 400, sheetHeight: TALL })).toBe(false) // same distance, slow
    expect(shouldDismiss({ dy: 20, ms: 20, sheetHeight: TALL })).toBe(false) // too small to be meant
  })

  it('a tap never dismisses, and neither does any upward drag', () => {
    expect(shouldDismiss({ dy: 0, ms: 0, sheetHeight: TALL })).toBe(false)
    expect(shouldDismiss({ dy: 0, ms: 120, sheetHeight: TALL })).toBe(false)
    for (const dy of [-5, -80, -500]) {
      expect(shouldDismiss({ dy, ms: 100, sheetHeight: TALL })).toBe(false)
      expect(shouldDismiss({ dy, ms: 1200, sheetHeight: SHORT })).toBe(false)
    }
  })
})
