// The error boundary: raw supabase-js / PostgREST / Postgres / provider failures become app-level
// categories, and only the category's localized text reaches the screen. Developer detail stays
// in `message`/`detail`.
import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { strings } from '../../ui/strings'
import { CloudError, type CloudErrorCode } from '../api'
import { toCloudError } from '../cloud'
import * as repo from '../../db/repo'
import { SyncEngine } from '../engine'
import { FakeCloud } from './fake_cloud'

const RAW = 'new row violates row-level security policy for table "stores"'

describe('toCloudError: categories from raw failures', () => {
  const cases: Array<[string, unknown, CloudErrorCode]> = [
    ['fetch TypeError', Object.assign(new TypeError('Failed to fetch'), {}), 'network'],
    ['network in message', { message: 'NetworkError when attempting to fetch resource.' }, 'network'],
    ['connection reset', { message: 'read ECONNRESET' }, 'network'],
    ['AuthApiError', { name: 'AuthApiError', message: 'Invalid Refresh Token', status: 400 }, 'auth'],
    ['HTTP 401', { message: 'JWT expired', status: 401 }, 'auth'],
    ['PGRST301', { message: 'JWSError', code: 'PGRST301' }, 'auth'],
    ['RLS 42501', { message: RAW, code: '42501' }, 'denied'],
    ['HTTP 403', { message: 'forbidden', status: 403 }, 'denied'],
    ['PostgREST schema error', { message: 'relation "public.nope" does not exist', code: 'PGRST205' }, 'server'],
    ['unknown shape', { foo: 1 }, 'server'],
    ['null', null, 'server'],
  ]
  for (const [name, raw, code] of cases) {
    it(`${name} → ${code}`, () => {
      const e = toCloudError(raw, 'upsertStore')
      expect(e).toBeInstanceOf(CloudError)
      expect(e.code).toBe(code)
      expect(e.message.startsWith('upsertStore: ')).toBe(true) // developer detail keeps the operation
    })
  }
})

describe('localized user text per category (never the raw message)', () => {
  const codes: CloudErrorCode[] = ['network', 'auth', 'denied', 'store_gone', 'server', 'unknown']
  it('tl and en both map every category to app wording', () => {
    for (const code of codes) {
      const tl = strings('tl').cloud.status.error(strings('tl').cloud.errors[code])
      const en = strings('en').cloud.status.error(strings('en').cloud.errors[code])
      expect(tl.startsWith('Hindi na-sync: ')).toBe(true)
      expect(en.startsWith('Not synced: ')).toBe(true)
      expect(tl).not.toBe(en)
      expect(tl).not.toContain(RAW)
      expect(en).not.toContain(RAW)
    }
    expect(strings('en').cloud.errors.denied).toBe('the cloud refused (different account?)')
    expect(strings('tl').cloud.errors.network).toBe('walang koneksyon')
    expect(strings('en').cloud.errors.store_gone).toBe('the store is no longer available in the cloud')
  })
  it('sign-in redirect kinds map in both languages', () => {
    for (const kind of ['cancelled', 'exchange', 'provider'] as const) {
      expect(strings('tl').cloud.signInErrors[kind]).not.toBe(strings('en').cloud.signInErrors[kind])
      expect(strings('en').cloud.signInErrors[kind]).toMatch(/sign-in/i)
    }
  })
})

describe('engine status carries the category, the detail stays developer-only', () => {
  it('a server failure becomes { code, detail }; the offline path stays "offline" with no error', async () => {
    await repo.createStore('test-errors', [3]) // a bound local store makes the engine talk to the cloud
    const cloud = new FakeCloud('u1')
    const engine = new SyncEngine({ api: cloud, onPulled: async () => {}, onStatus: () => {}, debounceMs: 0, backoffMs: [60_000] })
    cloud.failNext = 'listMyStores: permission denied for table stores'
    engine.setUser({ id: 'u1', email: 'tindabot-test-a@example.com' })
    await engine.whenIdle()
    expect(engine.status.phase).toBe('error')
    expect(engine.status.error).toEqual({ code: 'server', detail: 'listMyStores: permission denied for table stores' })
    // what the screen shows, in either language, is the category text only — never the detail
    for (const lang of ['tl', 'en'] as const) {
      const shown = strings(lang).cloud.status.error(strings(lang).cloud.errors[engine.status.error!.code])
      expect(shown).not.toContain('permission denied')
    }
    expect(strings('en').cloud.status.error(strings('en').cloud.errors[engine.status.error!.code])).toBe('Not synced: cloud problem — will retry')
    engine.dispose()

    const cloud2 = new FakeCloud('u1')
    const engine2 = new SyncEngine({ api: cloud2, onPulled: async () => {}, onStatus: () => {}, debounceMs: 0, backoffMs: [60_000] })
    cloud2.offline = true
    engine2.setUser({ id: 'u1', email: 'tindabot-test-a@example.com' })
    await engine2.whenIdle()
    expect(engine2.status.phase).toBe('offline')
    expect(engine2.status.error).toBeNull()
    engine2.dispose()
  })
})
