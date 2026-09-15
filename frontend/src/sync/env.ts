// Cloud configuration — read from Vite env at build time. Fails closed: anything missing or
// malformed means "no cloud in this build" and every sync/auth entry point stays inert.
// Only the project URL and the anon (publishable) key are ever read; nothing privileged exists
// on the client.

export interface CloudEnv {
  url: string
  anonKey: string
}

export function readCloudEnv(env: Record<string, unknown> = import.meta.env as Record<string, unknown>): CloudEnv | null {
  const url = typeof env.VITE_SUPABASE_URL === 'string' ? env.VITE_SUPABASE_URL.trim() : ''
  const anonKey = typeof env.VITE_SUPABASE_ANON_KEY === 'string' ? env.VITE_SUPABASE_ANON_KEY.trim() : ''
  if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(url)) return null
  if (anonKey.length < 20 || /\s/.test(anonKey)) return null
  return { url, anonKey }
}
