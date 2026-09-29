// A sheet must take the back press that would otherwise close the tab, and give it back the moment
// it closes by any other route. The rule is exercised against a fake browser that keeps a real
// history stack — entries, a current position, and pops delivered asynchronously the way the browser
// delivers them — so "leaves the app" is an observable outcome here, not a guess.
import { describe, expect, it } from 'vitest'
import { type HistoryPort, createSheetHistory } from '../sheetHistory'

function fakeBrowser() {
  const listeners = new Set<() => void>()
  let entries = 1 // the app's own entry
  let index = 0
  let leftTheApp = 0
  let urlChanges = 0
  const pending: Array<() => void> = []
  const port: HistoryPort = {
    push() {
      entries = index + 2 // anything ahead is dropped, as in a browser
      index += 1
    },
    back() {
      // the browser delivers popstate on a later task, never inside back()
      pending.push(() => {
        if (index === 0) {
          leftTheApp++
          return
        }
        index -= 1
        for (const l of [...listeners]) l()
      })
    },
    onPop(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {
    port,
    /** The person pressing back on the phone. */
    pressBack() {
      if (index === 0) {
        leftTheApp++ // nothing left to go back to: the tab closes
        return
      }
      index -= 1
      for (const l of [...listeners]) l()
    },
    /** Runs whatever the browser had queued (our own back() calls). */
    async settle() {
      while (pending.length) pending.shift()!()
      await Promise.resolve()
    },
    changeUrl() {
      urlChanges++
    },
    get entries() {
      return entries
    },
    get index() {
      return index
    },
    get leftTheApp() {
      return leftTheApp
    },
    get urlChanges() {
      return urlChanges
    },
  }
}

function openSheet(history: ReturnType<typeof createSheetHistory>) {
  let closed = 0
  const release = history.open(() => {
    closed++
  })
  return { release, closedCount: () => closed }
}

describe('a sheet and the back press', () => {
  it('opening one adds exactly one history entry, and nothing else', () => {
    const browser = fakeBrowser()
    const history = createSheetHistory(browser.port)
    const before = browser.entries

    openSheet(history)

    expect(browser.entries).toBe(before + 1)
    expect(browser.index).toBe(1)
    expect(history.depth).toBe(1)
    expect(browser.urlChanges).toBe(0) // the sheet is app state, never a URL
  })

  it('back closes the sheet instead of leaving the app', () => {
    const browser = fakeBrowser()
    const history = createSheetHistory(browser.port)
    const sheet = openSheet(history)

    browser.pressBack()

    expect(sheet.closedCount()).toBe(1)
    expect(browser.leftTheApp).toBe(0)
    expect(history.depth).toBe(0)
    expect(browser.index).toBe(0) // back at the app's own entry
  })

  it('closing it with its own buttons takes the entry back out, so the next back leaves as before', async () => {
    const browser = fakeBrowser()
    const history = createSheetHistory(browser.port)
    const sheet = openSheet(history)

    sheet.release() // the sheet's Save / X / backdrop
    await browser.settle()

    expect(sheet.closedCount()).toBe(0) // it was already closing; it is not closed twice
    expect(history.depth).toBe(0)
    expect(browser.index).toBe(0)

    browser.pressBack()
    expect(browser.leftTheApp).toBe(1) // root behaviour, exactly as before this existed
  })

  it('a back press that already closed the sheet is not undone a second time', async () => {
    const browser = fakeBrowser()
    const history = createSheetHistory(browser.port)
    const sheet = openSheet(history)

    browser.pressBack() // the sheet closes…
    sheet.release() // …and React then unmounts it, releasing as usual
    await browser.settle()

    expect(sheet.closedCount()).toBe(1)
    expect(history.depth).toBe(0)
    expect(browser.index).toBe(0)
    expect(browser.leftTheApp).toBe(0) // the release must not have gone back a second time
  })

  it('open, close, open again: the stack does not grow', async () => {
    const browser = fakeBrowser()
    const history = createSheetHistory(browser.port)

    for (let i = 0; i < 5; i++) {
      const sheet = openSheet(history)
      expect(browser.index).toBe(1)
      sheet.release()
      await browser.settle()
      expect(browser.index).toBe(0)
      expect(history.depth).toBe(0)
    }
    expect(browser.entries).toBe(2) // the app's entry plus one reusable sheet entry
    expect(browser.leftTheApp).toBe(0)
  })

  it('the same holds when back is what closes them, over and over', () => {
    const browser = fakeBrowser()
    const history = createSheetHistory(browser.port)

    for (let i = 0; i < 5; i++) {
      const sheet = openSheet(history)
      browser.pressBack()
      expect(sheet.closedCount()).toBe(1)
      expect(history.depth).toBe(0)
      expect(browser.index).toBe(0)
    }
    expect(browser.leftTheApp).toBe(0)
  })

  it('with no sheet open it listens to nothing, and back belongs to the app as before', () => {
    const browser = fakeBrowser()
    const history = createSheetHistory(browser.port)
    expect(history.listening).toBe(false)

    browser.pressBack()

    expect(browser.leftTheApp).toBe(1)
    expect(history.depth).toBe(0)
    expect(history.listening).toBe(false)
  })

  it('stops listening once the last sheet is gone, by either route', async () => {
    const browser = fakeBrowser()
    const history = createSheetHistory(browser.port)

    const byBack = openSheet(history)
    expect(history.listening).toBe(true)
    browser.pressBack()
    expect(byBack.closedCount()).toBe(1)
    expect(history.listening).toBe(false)

    const byButton = openSheet(history)
    expect(history.listening).toBe(true)
    byButton.release()
    await browser.settle()
    expect(history.listening).toBe(false)
  })

  it('a sheet opened on top of another is the one back closes, and the one underneath survives', () => {
    const browser = fakeBrowser()
    const history = createSheetHistory(browser.port)
    const under = openSheet(history)
    const over = openSheet(history)
    expect(browser.index).toBe(2)

    browser.pressBack()

    expect(over.closedCount()).toBe(1)
    expect(under.closedCount()).toBe(0)
    expect(history.depth).toBe(1)

    browser.pressBack()

    expect(under.closedCount()).toBe(1)
    expect(history.depth).toBe(0)
    expect(browser.leftTheApp).toBe(0)
  })

  it('going back past the app own history closes no sheet and is not swallowed', () => {
    const browser = fakeBrowser()
    const history = createSheetHistory(browser.port)
    openSheet(history)

    browser.pressBack() // closes the sheet
    browser.pressBack() // nothing of ours left: the app leaves, as it always did

    expect(browser.leftTheApp).toBe(1)
    expect(history.depth).toBe(0)
  })
})
