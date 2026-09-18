// P3a — a failed Google sign-in redirect must be surfaced, and never leak a token or a code.
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuthApi } from '../cloud'
import { classifyRedirectError, isSignInCallbackUrl, redirectErrorFromUrl, safeErrorText, stripRedirectErrorParams } from '../redirect'

const APP = 'https://tindabot.example/app/'

describe('redirect helpers (pure)', () => {
  it('recognises the return leg of a sign-in redirect, in the query or the hash', () => {
    expect(isSignInCallbackUrl(`${APP}?code=abc`)).toBe(true)
    expect(isSignInCallbackUrl(`${APP}?error=access_denied`)).toBe(true)
    expect(isSignInCallbackUrl(`${APP}#error=server_error&error_description=x`)).toBe(true)
    expect(isSignInCallbackUrl(`${APP}#access_token=t&refresh_token=r`)).toBe(true)
    expect(isSignInCallbackUrl(APP)).toBe(false)
    expect(isSignInCallbackUrl(`${APP}?tab=ibapa`)).toBe(false)
    expect(isSignInCallbackUrl('not a url')).toBe(false)
  })

  it('reads the provider description (or code) from the query or the hash, never a token', () => {
    expect(redirectErrorFromUrl(`${APP}?error=access_denied&error_code=user_cancelled&error_description=User+cancelled+the+login`)).toBe('User cancelled the login')
    expect(redirectErrorFromUrl(`${APP}#error=server_error&error_code=unexpected_failure`)).toBe('unexpected_failure')
    expect(redirectErrorFromUrl(`${APP}?error=access_denied`)).toBe('access_denied')
    expect(redirectErrorFromUrl(`${APP}?code=abc`)).toBeNull()
    expect(redirectErrorFromUrl(`${APP}#access_token=secret&refresh_token=secret2`)).toBeNull()
    expect(redirectErrorFromUrl(APP)).toBeNull()
  })

  it('classifies the failure into an app-level kind (what the UI shows)', () => {
    expect(classifyRedirectError(`${APP}?error=access_denied&error_code=user_cancelled&error_description=User+cancelled+the+login`, false)).toBe('cancelled')
    expect(classifyRedirectError(`${APP}#error=access_denied`, false)).toBe('cancelled')
    expect(classifyRedirectError(`${APP}?error=server_error&error_code=unexpected_failure&error_description=Unable+to+exchange+external+code`, false)).toBe('provider')
    expect(classifyRedirectError(`${APP}?code=abc`, true)).toBe('exchange')
  })

  it('caps and normalises error text', () => {
    expect(safeErrorText('  a \n b  ')).toBe('a b')
    expect(safeErrorText('')).toBe('unknown')
    expect(safeErrorText('x'.repeat(300))).toHaveLength(140)
    expect(safeErrorText('x'.repeat(300)).endsWith('…')).toBe(true)
  })

  it('strips only the error parameters and keeps everything else', () => {
    expect(stripRedirectErrorParams(`${APP}?tab=ibapa&error=access_denied&error_code=x&error_description=y`)).toBe(`${APP}?tab=ibapa`)
    expect(stripRedirectErrorParams(`${APP}#error=server_error&error_description=z&keep=1`)).toBe(`${APP}#keep=1`)
    expect(stripRedirectErrorParams(`${APP}#error=server_error`)).toBe(APP)
    expect(stripRedirectErrorParams(`${APP}?code=abc`)).toBe(`${APP}?code=abc`)
    expect(stripRedirectErrorParams('not a url')).toBe('not a url')
  })
})

describe('AuthApi.signInRedirectError (supabase-js initialize() result)', () => {
  const replaced: string[] = []
  function browserAt(href: string) {
    vi.stubGlobal('location', { href })
    vi.stubGlobal('history', {
      state: null,
      replaceState: (_s: unknown, _t: string, url: string) => {
        replaced.push(url)
        ;(globalThis as { location: { href: string } }).location.href = url
      },
    })
  }
  function clientWith(initialize: () => Promise<{ error: { message: string } | null }>): SupabaseClient {
    return { auth: { initialize } } as unknown as SupabaseClient
  }
  afterEach(() => {
    vi.unstubAllGlobals()
    replaced.length = 0
  })

  it('is null on an ordinary page load, without even asking supabase-js', async () => {
    browserAt(APP)
    const initialize = vi.fn(async () => ({ error: null }))
    expect(await createAuthApi(clientWith(initialize)).signInRedirectError()).toBeNull()
    expect(initialize).not.toHaveBeenCalled()
  })

  it('is null on a successful PKCE return (supabase-js reported no error)', async () => {
    browserAt(`${APP}?code=abc`)
    expect(await createAuthApi(clientWith(async () => ({ error: null }))).signInRedirectError()).toBeNull()
    expect(replaced).toEqual([])
  })

  it('reports a provider error from the URL and removes it from the address bar', async () => {
    browserAt(`${APP}?error=access_denied&error_code=user_cancelled&error_description=User+cancelled+the+login`)
    const api = createAuthApi(clientWith(async () => ({ error: { message: 'User cancelled the login' } })))
    expect(await api.signInRedirectError()).toEqual({ kind: 'cancelled', detail: 'User cancelled the login' })
    expect(replaced).toEqual([APP])
    // second look at the (now clean) URL: nothing to report
    expect(await api.signInRedirectError()).toBeNull()
  })

  it('reports a failed PKCE code exchange using supabase-js’ message, never the code itself', async () => {
    browserAt(`${APP}?code=super-secret-code`)
    const api = createAuthApi(clientWith(async () => ({ error: { message: 'invalid request: both auth code and code verifier should be non-empty' } })))
    const res = await api.signInRedirectError()
    expect(res).toEqual({ kind: 'exchange', detail: 'invalid request: both auth code and code verifier should be non-empty' })
    expect(JSON.stringify(res)).not.toContain('super-secret-code')
    expect(replaced).toEqual([]) // no error params to strip; supabase-js owns `code`
  })
})
