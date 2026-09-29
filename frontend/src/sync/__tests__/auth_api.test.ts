// The auth wrapper's own rules, with a stand-in for supabase-js: which of its events mean "this is
// who is signed in", which mean "nobody", and which mean nothing at all. The engine reacts to that
// callback alone — a wrong mapping would either stop syncing for a signed-in owner or report a
// signed-out state while a session is alive — and until now only the online suite touched it.
import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { CloudError } from '../api'
import { createAuthApi } from '../cloud'

type Handler = (event: string, session: { user: { id: string; email?: string } } | null) => void

function fakeClient(session: { user: { id: string; email?: string } } | null = null) {
  const handlers: Handler[] = []
  const unsubscribe = vi.fn()
  const signOut = vi.fn(async () => ({ error: null as { message: string; status?: number } | null }))
  const client = {
    auth: {
      getSession: async () => ({ data: { session } }),
      signOut,
      onAuthStateChange(handler: Handler) {
        handlers.push(handler)
        return { data: { subscription: { unsubscribe } } }
      },
    },
  }
  return {
    api: createAuthApi(client as unknown as SupabaseClient),
    emit(event: string, s: { user: { id: string; email?: string } } | null) {
      for (const h of handlers) h(event, s)
    },
    signOut,
    unsubscribe,
    get listeners() {
      return handlers.length
    },
  }
}

const SESSION = { user: { id: 'U1', email: 'owner@example.com' } }

describe('who the app thinks is signed in', () => {
  it('reports the session it finds, and null when there is none', async () => {
    expect(await fakeClient(SESSION).api.currentUser()).toEqual({ id: 'U1', email: 'owner@example.com' })
    expect(await fakeClient(null).api.currentUser()).toBeNull()
  })

  it('a user without an email is still a user', async () => {
    expect(await fakeClient({ user: { id: 'U2' } }).api.currentUser()).toEqual({ id: 'U2', email: null })
  })

  it('every event that carries a live session hands the user over', () => {
    for (const event of ['SIGNED_IN', 'INITIAL_SESSION', 'TOKEN_REFRESHED', 'USER_UPDATED']) {
      const c = fakeClient()
      const seen: Array<{ id: string; email: string | null } | null> = []
      c.api.onChange((u) => seen.push(u))
      c.emit(event, SESSION)
      expect(seen, event).toEqual([{ id: 'U1', email: 'owner@example.com' }])
    }
  })

  it('signing out reports nobody', () => {
    const c = fakeClient()
    const seen: Array<{ id: string } | null> = []
    c.api.onChange((u) => seen.push(u))
    c.emit('SIGNED_IN', SESSION)
    c.emit('SIGNED_OUT', null)
    expect(seen).toEqual([{ id: 'U1', email: 'owner@example.com' }, null])
  })

  it('an initial event with no session reports nobody rather than staying silent', () => {
    const c = fakeClient()
    const seen: Array<{ id: string } | null> = []
    c.api.onChange((u) => seen.push(u))
    c.emit('INITIAL_SESSION', null)
    expect(seen).toEqual([null])
  })

  it('events that say nothing about who is signed in are ignored', () => {
    const c = fakeClient()
    const seen: unknown[] = []
    c.api.onChange((u) => seen.push(u))
    for (const event of ['PASSWORD_RECOVERY', 'MFA_CHALLENGE_VERIFIED', 'SOMETHING_NEW']) c.emit(event, SESSION)
    expect(seen).toEqual([])
  })

  it('the subscription is dropped when the app stops listening', () => {
    const c = fakeClient()
    const stop = c.api.onChange(() => {})
    expect(c.listeners).toBe(1)
    stop()
    expect(c.unsubscribe).toHaveBeenCalledOnce()
  })
})

describe('signing out', () => {
  it('only ends the session on this device — never everywhere the owner is signed in', async () => {
    const c = fakeClient(SESSION)
    await c.api.signOut()
    expect(c.signOut).toHaveBeenCalledWith({ scope: 'local' })
  })

  it('a failure to sign out is reported as a cloud error, not swallowed', async () => {
    const c = fakeClient(SESSION)
    c.signOut.mockResolvedValueOnce({ error: { message: 'network request failed' } })
    await expect(c.api.signOut()).rejects.toBeInstanceOf(CloudError)
    c.signOut.mockResolvedValueOnce({ error: { message: 'network request failed' } })
    // the network is its own category, so the UI says "offline", not "something went wrong"
    await expect(c.api.signOut()).rejects.toMatchObject({ name: 'CloudError', code: 'network' })
  })
})
