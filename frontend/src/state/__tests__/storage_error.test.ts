// The local database cannot be opened. Before this, `init()` rejected and the app sat on its
// loading dots for good; now the failure is a state the UI can speak about and retry. These tests
// drive the two ways the browser refuses that were reproduced against the production build:
// IndexedDB missing entirely, and `indexedDB.open` throwing a SecurityError (site data blocked).
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../db/db'
import * as repo from '../../db/repo'
import { TL, EN } from '../../ui/strings'
import { useApp } from '../store'

// Dexie copies the IndexedDB factory onto the instance when the module loads, so the refusal has to
// be installed there: replacing the global would leave this database untouched and prove nothing.
// Doing it this way makes Dexie raise the very errors the built app raised in the browser —
// `MissingAPIError: IndexedDB API missing` and the browser's own `SecurityError`.
const deps = db as unknown as { _deps: { indexedDB: IDBFactory } }
const realFactory = deps._deps.indexedDB

/** The browser refusing storage, in the two ways that were reproduced against the production build. */
function cutOffStorage(how: 'missing' | 'denied') {
  db.close() // a connection already open would keep working; the refusal is about opening one
  deps._deps.indexedDB =
    how === 'missing'
      ? (undefined as unknown as IDBFactory)
      : ({
          ...realFactory,
          open: () => {
            throw new DOMException('access to the Indexed Database API is denied in this context.', 'SecurityError')
          },
        } as unknown as IDBFactory)
}

function restoreStorage() {
  deps._deps.indexedDB = realFactory
}

beforeEach(async () => {
  restoreStorage()
  db.close()
  await db.delete()
  await db.open()
  useApp.setState({ loaded: false, storageError: false, store: null, lang: 'tl' })
})

afterEach(() => {
  restoreStorage()
  vi.restoreAllMocks()
})

describe('the local database cannot be opened', () => {
  for (const how of ['missing', 'denied'] as const) {
    it(`reports a storage failure instead of loading forever when IndexedDB is ${how}`, async () => {
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      cutOffStorage(how)

      await expect(useApp.getState().init()).resolves.toBeUndefined() // never rejects at the UI

      expect(useApp.getState().storageError).toBe(true)
      expect(useApp.getState().loaded).toBe(false) // …and the loading state is not what is shown
      // the reason is available for diagnosis, and only there
      expect(logged).toHaveBeenCalled()
      expect(String(logged.mock.calls[0]![0])).toContain('local database unavailable')
    })
  }

  it('a retry after the browser lets the database open again loads the store normally', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = await repo.createStore('Tindahan ni Test', [3])
    cutOffStorage('denied')
    await useApp.getState().init()
    expect(useApp.getState().storageError).toBe(true)

    restoreStorage() // the person allows site data, then taps "Subukan muli"
    await useApp.getState().init()

    expect(useApp.getState().storageError).toBe(false)
    expect(useApp.getState().loaded).toBe(true)
    expect(useApp.getState().store?.id).toBe(store.id)
    expect(useApp.getState().store?.name).toBe('Tindahan ni Test')
  })

  it('a normal start reports no storage failure at all', async () => {
    await repo.createStore('Tindahan ni Test', [3])
    await useApp.getState().init()
    expect(useApp.getState().storageError).toBe(false)
    expect(useApp.getState().loaded).toBe(true)
  })

  it('says what happened in both languages, and never shows the browser error', () => {
    for (const S of [TL, EN]) {
      expect(S.storage.title.length).toBeGreaterThan(8)
      expect(S.storage.body).toMatch(/TindaBot/)
      expect(S.storage.retry.length).toBeGreaterThan(3)
      // the one practical thing to check: site data / cookies, and private browsing
      expect(S.storage.check).toMatch(/cookies/i)
      expect(S.storage.check).toMatch(/private|incognito/i)
      for (const text of [S.storage.title, S.storage.body, S.storage.check, S.storage.retry]) {
        expect(text).not.toMatch(/IndexedDB|DatabaseClosedError|SecurityError|DOMException/)
      }
    }
    expect(TL.storage.title).not.toBe(EN.storage.title)
    expect(TL.storage.check).not.toBe(EN.storage.check)
  })
})
