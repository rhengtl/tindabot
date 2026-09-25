// Export must actually produce a file, and `last_backup_at` must only ever mean a confirmed one.
// Some phones (realme C55 / Brave 1.95) answer canShare({files}) with true, reject share() with
// NotAllowedError and then fail the download silently — found on the device in Step 6 — so a
// refused share falls back to a download that is reported as *started*, a real cancel (AbortError)
// exports nothing, and only a resolved share marks the backup date.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useApp } from '../../state/store'
import { exportCurrentStore } from '../exportFile'

const JSON_TEXT = '{"tindabot":1}'

// The suite runs without a DOM; the few browser bits the export touches are stubbed here.
function define(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}
function stubDom() {
  const clicked: string[] = []
  const dom = { appended: 0, removed: 0, revoked: 0 }
  const a = {
    href: '',
    download: '',
    rel: '',
    click: () => clicked.push(`${a.download}@${a.href}#${dom.appended}`),
    remove: () => { dom.removed++ },
  }
  define('document', { createElement: () => a, body: { appendChild: () => { dom.appended++ } } })
  const URLAny = URL as unknown as { createObjectURL: unknown; revokeObjectURL: unknown }
  URLAny.createObjectURL = () => 'blob:tindabot'
  URLAny.revokeObjectURL = () => { dom.revoked++ }
  return Object.assign(clicked, { dom })
}
function stubShare(share?: (d?: { title?: string }) => Promise<void>) {
  define('navigator', share ? { canShare: () => true, share } : {})
}

describe('exportCurrentStore', () => {
  let saved: string[]
  beforeEach(() => {
    saved = []
    useApp.setState({
      exportJson: () => JSON_TEXT,
      setMeta: (async (k: string, v: string) => { saved.push(`${k}=${v}`) }) as never,
    } as never)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a share the phone accepted is the only confirmed backup', async () => {
    const shared: string[] = []
    stubShare(async (d) => { shared.push(d?.title ?? '') })
    const clicked = stubDom()
    expect(await exportCurrentStore()).toBe('shared')
    expect(shared[0]).toMatch(/^tindabot-\d{4}-\d{2}-\d{2}\.json$/)
    expect(clicked.length).toBe(0) // no download needed
    expect(saved).toEqual([expect.stringMatching(/^last_backup_at=/)])
  })

  it('a refused share falls back to a download, and that is NOT a confirmed backup', async () => {
    stubShare(async () => { throw Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }) })
    const clicked = stubDom()
    expect(await exportCurrentStore()).toBe('download_started')
    expect(clicked[0]).toMatch(/^tindabot-\d{4}-\d{2}-\d{2}\.json@blob:tindabot#1$/) // link in the page when clicked
    expect(clicked.dom.removed).toBe(1)
    expect(clicked.dom.revoked).toBe(0) // not revoked before the download starts
    expect(saved).toEqual([expect.stringMatching(/^last_export_attempt_at=/)]) // attempt only
    expect(saved.join()).not.toContain('last_backup_at')
  })

  it('a cancelled share exports nothing and does not touch any date', async () => {
    stubShare(async () => { throw Object.assign(new Error('Share canceled'), { name: 'AbortError' }) })
    const clicked = stubDom()
    expect(await exportCurrentStore()).toBe('cancelled')
    expect(clicked.length).toBe(0)
    expect(saved).toEqual([])
  })

  it('downloads directly when the browser cannot share files at all — still unconfirmed', async () => {
    stubShare()
    const clicked = stubDom()
    expect(await exportCurrentStore()).toBe('download_started')
    expect(clicked[0]).toMatch(/^tindabot-/)
    expect(saved.join()).not.toContain('last_backup_at')
  })

  it('reports a failure when neither route can be started', async () => {
    define('navigator', { canShare: () => true, share: async () => { throw Object.assign(new Error('nope'), { name: 'NotAllowedError' }) } })
    define('document', { createElement: () => { throw new Error('no DOM') }, body: { appendChild: () => {} } })
    expect(await exportCurrentStore()).toBe('failed')
    expect(saved).toEqual([])
  })
})
