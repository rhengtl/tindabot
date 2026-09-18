// P3a — OAuth redirect helpers (pure; no supabase-js, no DOM).
//
// After Google sign-in, Supabase sends the browser back to our own URL either with `?code=…`
// (PKCE, exchanged by supabase-js) or with `error`, `error_code`, `error_description` when the
// sign-in failed. supabase-js reports that failure only as the result of `auth.initialize()` —
// it emits no auth-state event and leaves the parameters in the address bar — so the app has to
// look for it explicitly (see `AuthApi.signInRedirectError`).

import type { SignInErrorKind } from './api'

const CALLBACK_PARAMS = ['code', 'access_token', 'error', 'error_code', 'error_description']
const ERROR_PARAMS = ['error', 'error_code', 'error_description']

function paramsOf(href: string): URLSearchParams[] {
  try {
    const url = new URL(href)
    const hash = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
    return [url.searchParams, new URLSearchParams(hash)]
  } catch {
    return []
  }
}

/** True when this page load is the return leg of a sign-in redirect (success or failure). */
export function isSignInCallbackUrl(href: string): boolean {
  return paramsOf(href).some((p) => CALLBACK_PARAMS.some((k) => p.has(k)))
}

/**
 * A short, display-safe description of a failed redirect, or null when the URL carries no error.
 * Only the provider's own description / error code is used — never a token or a code.
 */
export function redirectErrorFromUrl(href: string): string | null {
  for (const p of paramsOf(href)) {
    const description = p.get('error_description')?.trim()
    const code = p.get('error_code')?.trim() || p.get('error')?.trim()
    if (description || code) return safeErrorText(description || code || '')
  }
  return null
}

/**
 * App-level kind of a failed redirect. `cancelled` = the person backed out or Google refused
 * (access_denied / user_cancelled); `exchange` = the URL carried no provider error but the PKCE
 * code exchange failed (verifier missing — different browser — or expired); `provider` = any
 * other provider/server error in the URL.
 */
export function classifyRedirectError(href: string, noUrlError: boolean): SignInErrorKind {
  if (noUrlError) return 'exchange'
  for (const p of paramsOf(href)) {
    const code = `${p.get('error') ?? ''} ${p.get('error_code') ?? ''} ${p.get('error_description') ?? ''}`.toLowerCase()
    if (/access_denied|cancel|denied|consent/.test(code)) return 'cancelled'
  }
  return 'provider'
}

/** Trims and caps an error text so logs never carry a wall of text or anything token-shaped. */
export function safeErrorText(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t) return 'unknown'
  return t.length > 140 ? `${t.slice(0, 139)}…` : t
}

/** The same URL without the error parameters (query and hash), so a reload does not re-report. */
export function stripRedirectErrorParams(href: string): string {
  try {
    const url = new URL(href)
    for (const k of ERROR_PARAMS) url.searchParams.delete(k)
    if (url.hash) {
      const h = new URLSearchParams(url.hash.slice(1))
      for (const k of ERROR_PARAMS) h.delete(k)
      const rest = h.toString()
      url.hash = rest ? `#${rest}` : ''
    }
    return url.toString()
  } catch {
    return href
  }
}
