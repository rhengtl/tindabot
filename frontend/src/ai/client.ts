// Phone side of the AI proxy (BLUEPRINT §F; server: frontend/api/ai.ts). The only file that talks to
// /api/ai. It sends the signed-in user's access token (never a key: the Gemini key exists only on
// the server) and turns every failure into one app-level code the UI words in its own language.

export type AiErrorCode = 'signed_out' | 'offline' | 'auth' | 'rate_limited' | 'busy' | 'not_configured' | 'too_large' | 'failed'

export class AiError extends Error {
  constructor(public readonly code: AiErrorCode) {
    super(code)
    this.name = 'AiError'
  }
}

export type TokenSource = () => Promise<string | null>

export const AI_ENDPOINT = '/api/ai'

/** POSTs one op to the proxy. `fetchImpl` is injectable for tests. */
export async function callAi<T>(body: Record<string, unknown>, token: TokenSource, fetchImpl: typeof fetch = fetch): Promise<T> {
  const t = await token()
  if (!t) throw new AiError('signed_out')
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new AiError('offline')
  let res: Response
  try {
    res = await fetchImpl(AI_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: JSON.stringify(body) })
  } catch {
    throw new AiError('offline')
  }
  if (res.ok) {
    const data = (await res.json().catch(() => null)) as T | null
    if (data === null) throw new AiError('failed')
    return data
  }
  const err = ((await res.json().catch(() => null)) as { error?: string } | null)?.error
  if (res.status === 401 || err === 'auth') throw new AiError('auth')
  if (res.status === 429 || err === 'rate_limited') throw new AiError('rate_limited')
  if (err === 'busy') throw new AiError('busy')
  if (err === 'not_configured' || res.status === 404) throw new AiError('not_configured') // 404: no function deployed (e.g. plain `vite preview`)
  if (res.status === 413 || err === 'too_large') throw new AiError('too_large')
  throw new AiError('failed')
}
