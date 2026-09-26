// A Supabase project paused for inactivity (or an API gateway that cannot reach it) is its own
// app-level state: the phone is online, the session is fine, nothing is denied — the cloud simply
// is not answering. It must stay distinct from offline / auth / denied / server, must not touch
// anything local, must keep queued work queued, and must converge once the cloud is back.
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../db/db'
import * as repo from '../../db/repo'
import { strings } from '../../ui/strings'
import { CloudError, type CloudErrorCode } from '../api'
import { toCloudError } from '../cloud'
import { META, SyncEngine } from '../engine'
import { FakeCloud } from './fake_cloud'

const RAW_PAUSED = '{"message":"Project is paused. Restore it from the Supabase dashboard."}'

describe('classification: unavailable vs everything else', () => {
  const cases: Array<[string, unknown, CloudErrorCode]> = [
    ['paused project (540)', { message: RAW_PAUSED, status: 540 }, 'unavailable'],
    ['gateway cannot reach the project (502)', { message: 'Bad Gateway', status: 502 }, 'unavailable'],
    ['service unavailable (503)', { message: 'no healthy upstream', status: 503 }, 'unavailable'],
    ['gateway timeout (504)', { message: 'upstream request timeout', status: 504 }, 'unavailable'],
    ['postgres starting up (57P03)', { message: 'the database system is starting up', code: '57P03' }, 'unavailable'],
    ['PostgREST cannot reach the database', { message: 'Could not query the database', code: 'PGRST002' }, 'unavailable'],
    ['paused said in words', { message: 'project is paused' }, 'unavailable'],
    // ...and the categories it must not swallow
    ['phone has no connection', new TypeError('Failed to fetch'), 'network'],
    ['supabase-js retryable fetch error', { name: 'AuthRetryableFetchError', message: 'Failed to fetch' }, 'network'],
    ['expired session (401)', { message: 'JWT expired', status: 401 }, 'auth'],
    ['auth api error', { name: 'AuthApiError', message: 'Invalid Refresh Token', status: 400 }, 'auth'],
    ['PostgREST auth (PGRST301)', { message: 'JWSError', code: 'PGRST301' }, 'auth'],
    ['RLS denial (42501)', { message: 'new row violates row-level security policy', code: '42501' }, 'denied'],
    ['forbidden (403)', { message: 'forbidden', status: 403 }, 'denied'],
    ['ordinary server failure', { message: 'relation "public.nope" does not exist', code: 'PGRST205' }, 'server'],
    ['unrecognisable', { foo: 1 }, 'server'],
  ]
  for (const [name, raw, code] of cases) {
    it(`${name} -> ${code}`, () => {
      const e = toCloudError(raw, 'listMyStores')
      expect(e).toBeInstanceOf(CloudError)
      expect(e.code).toBe(code)
      expect(e.message.startsWith('listMyStores: ')).toBe(true)
    })
  }

  it('a paused project answering an auth call is still "unavailable", not "sign in again"', () => {
    // supabase-js wraps the gateway reply in an AuthApiError; the status is what decides.
    expect(toCloudError({ name: 'AuthApiError', message: RAW_PAUSED, status: 540 }, 'currentUser').code).toBe('unavailable')
    // a genuine auth failure from a healthy project still reads as auth
    expect(toCloudError({ name: 'AuthApiError', message: 'Invalid Refresh Token', status: 401 }, 'currentUser').code).toBe('auth')
  })
})

describe('what the person is told', () => {
  it('both languages have their own wording, and none of it is the provider text', () => {
    for (const lang of ['tl', 'en'] as const) {
      const S = strings(lang)
      for (const text of [S.cloud.status.unavailable, S.cloud.status.unavailablePending(2), S.cloud.status.authNeeded, S.cloud.errors.unavailable]) {
        expect(text.length).toBeGreaterThan(10)
        expect(text).not.toMatch(/supabase|postgrest|540|502|dashboard|JWT/i)
      }
    }
    expect(strings('tl').cloud.status.unavailable).not.toBe(strings('en').cloud.status.unavailable)
    // the point of the message: the list is safe on the phone
    expect(strings('tl').cloud.status.unavailable).toMatch(/phone/i)
    expect(strings('en').cloud.status.unavailable).toMatch(/safe on this phone/i)
    // and it is not the same state as offline, needing a sign-in, or a server failure
    const S = strings('en')
    const lines = new Set([S.cloud.status.unavailable, S.cloud.status.offline(0), S.cloud.status.authNeeded, S.cloud.status.error(S.cloud.errors.server)])
    expect(lines.size).toBe(4)
  })
})

describe('the engine while the cloud is unavailable', () => {
  /** Every engine these tests build, so teardown can stop it even if an assertion threw first. */
  const liveEngines: SyncEngine[] = []
  /** Builds an engine and registers it in one step, so none can be forgotten. */
  function engineFor(deps: ConstructorParameters<typeof SyncEngine>[0]): SyncEngine {
    const engine = new SyncEngine(deps)
    liveEngines.push(engine)
    return engine
  }

  beforeEach(async () => {
    await db.delete()
    await db.open()
  })
  afterEach(async () => {
    // Disposing inside the test body is skipped whenever an assertion throws before it, and the
    // engine's retry timer (10 min here) would then outlive the test and run against the database
    // the next beforeEach deletes. Teardown is the only place that happens unconditionally, and
    // waiting for whenIdle() keeps a run that is still finishing from meeting db.delete().
    for (const e of liveEngines) e.dispose()
    for (const e of liveEngines) await e.whenIdle()
    liveEngines.length = 0
  })

  it('keeps local data and the queue, then converges when the cloud comes back', async () => {
    const store = await repo.createStore('test-unavailable', [3])
    const base = { v: 1 as const, store_id: store.id, device_id: 'DEV0UNAVAIL0000000000000001', recorded_at: '2026-09-25T00:00:00.000Z' }
    await repo.addEvents([{ ...base, id: 'E0000000000000000000UNAV01', type: 'CASH_COUNT', amount: 1000, ts: '2026-09-25T10:00:00+08:00' }])

    const cloud = new FakeCloud('u1')
    const statuses: string[] = []
    const engine = engineFor({
      api: cloud,
      onPulled: async () => {},
      onStatus: (s) => statuses.push(`${s.phase}:${s.error?.code ?? '-'}`),
      debounceMs: 0,
      backoffMs: [60_000],
      unavailableBackoffMs: [600_000],
    })
    cloud.failNext = 'listMyStores: the cloud is not answering'
    cloud.failNextCode = 'unavailable'
    engine.setUser({ id: 'u1', email: 'tindabot-test-a@example.com' })
    await engine.whenIdle()

    expect(engine.status.phase).toBe('error')
    expect(engine.status.error?.code).toBe('unavailable')
    expect(statuses).toContain('error:unavailable')
    // nothing local was touched, and the entry is still waiting to go up
    const snap = await repo.loadSnapshot(store.id)
    expect(snap!.events.length).toBe(1)
    expect(snap!.store.name).toBe('test-unavailable')
    expect(await repo.countUnsyncedEvents(store.id)).toBe(1)
    expect(engine.status.pendingEvents).toBe(1)
    expect(await repo.getMeta(META.lastError)).toContain('not answering')

    // a write during the outage still lands locally and stays queued
    await repo.addEvents([{ ...base, id: 'E0000000000000000000UNAV02', type: 'CASH_COUNT', amount: 900, ts: '2026-09-25T11:00:00+08:00' }])
    expect(await repo.countUnsyncedEvents(store.id)).toBe(2)

    // the cloud comes back: an ordinary trigger converges, nothing is re-initialised
    engine.requestSync('foreground')
    await engine.whenIdle()
    expect(engine.status.phase).toBe('idle')
    expect(engine.status.error).toBeNull()
    expect(await repo.countUnsyncedEvents(store.id)).toBe(0)
    expect(cloud.eventsOf(store.id).length).toBe(2)
    const local = await repo.loadSnapshot(store.id)
    expect(local!.events.length).toBe(2) // and nothing was lost or duplicated locally
  })

  it('waits longer before retrying an unavailable cloud than an ordinary failure', async () => {
    await repo.createStore('test-unavailable-backoff', [3])
    const run = async (code: CloudErrorCode) => {
      const cloud = new FakeCloud('u1')
      const engine = engineFor({ api: cloud, onPulled: async () => {}, debounceMs: 0, backoffMs: [10_000], unavailableBackoffMs: [600_000] })
      cloud.failNext = 'listMyStores: injected'
      cloud.failNextCode = code
      engine.setUser({ id: 'u1', email: 'tindabot-test-a@example.com' })
      await engine.whenIdle()
      // read before teardown disposes it: dispose() clears the very timer this asserts on
      return { code: engine.status.error?.code, delay: engine.nextRetryDelayMs }
    }
    expect(await run('unavailable')).toEqual({ code: 'unavailable', delay: 600_000 })
    expect(await run('server')).toEqual({ code: 'server', delay: 10_000 })
  })
})
