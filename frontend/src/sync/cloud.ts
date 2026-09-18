// The only file that imports supabase-js. Builds the `CloudApi`/`AuthApi` used by the engine, or
// nothing at all when the build has no cloud configuration (the app then behaves exactly as P2).
// Only the anon key is ever present here; RLS on the server is the security boundary.

import { type SupabaseClient, createClient } from '@supabase/supabase-js'
import { type AuthApi, type CloudApi, type CloudUser, CloudError, type RecordTable } from './api'
import type { EventRow, RecordRow, StoreRow } from './codec'
import { type CloudEnv, readCloudEnv } from './env'

export interface Cloud {
  api: CloudApi
  auth: AuthApi
}

function toCloudError(err: unknown, fallback: string): CloudError {
  const e = err as { message?: string; code?: string; status?: number; name?: string } | null
  const msg = e?.message || fallback
  if (e?.name === 'TypeError' || /fetch|network|Failed to fetch|NetworkError/i.test(msg)) return new CloudError('Walang koneksyon.', 'network')
  if (e?.code === '42501' || e?.status === 401 || e?.status === 403) return new CloudError(msg, 'denied')
  if (e?.name === 'AuthError' || e?.name === 'AuthApiError') return new CloudError(msg, 'auth')
  return new CloudError(msg, 'server')
}

function check<T>(res: { data: T; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw toCloudError(res.error, what)
  return res.data
}

export function createCloudApi(client: SupabaseClient): CloudApi {
  return {
    async serverTime() {
      const data = check(await client.rpc('server_time'), 'server_time')
      if (typeof data !== 'string') throw new CloudError('server_time', 'server')
      return data
    },
    async syncWatermark() {
      const data = check(await client.rpc('sync_watermark'), 'sync_watermark')
      const n = Number(data)
      if (!Number.isSafeInteger(n) || n <= 0) throw new CloudError('sync_watermark', 'server')
      return n
    },
    async listMyStores() {
      const data = check(await client.from('stores').select('id, body, updated_at, server_rev, archived_at, created_by').is('archived_at', null), 'listMyStores')
      return (data ?? []) as StoreRow[]
    },
    async fetchStore(id) {
      const data = check(await client.from('stores').select('id, body, updated_at, server_rev, archived_at, created_by').eq('id', id).maybeSingle(), 'fetchStore')
      return (data as StoreRow | null) ?? null
    },
    async upsertStore(row) {
      // Not a PostgREST upsert: `INSERT … ON CONFLICT` makes Postgres apply the stores SELECT
      // policy (is_member) to the new row, and the owner membership only exists after the
      // insert trigger has run — so a brand-new store would be rejected (42501). Plain insert
      // first; only a duplicate key (23505) means "exists" and becomes the update path.
      const values = { id: row.id, body: row.body, updated_at: row.updated_at }
      const ins = await client.from('stores').insert(values)
      if (!ins.error) return
      if (ins.error.code !== '23505') throw toCloudError(ins.error, 'upsertStore')
      const updated = check(await client.from('stores').update(values).eq('id', row.id).select('id'), 'upsertStore')
      if ((updated ?? []).length > 0) return
      // 0 rows: either lww_guard skipped a stale row (fine, same as the old upsert) or the row is
      // not ours and RLS hid it (the old upsert raised 42501 here — keep that behaviour).
      const visible = await client.from('stores').select('id').eq('id', row.id).maybeSingle()
      if (visible.error) throw toCloudError(visible.error, 'upsertStore')
      if (!visible.data) throw new CloudError('upsertStore: not a member of this store', 'denied')
    },
    async upsertRecords(table, rows) {
      if (rows.length === 0) return
      check(
        await client.from(table).upsert(
          rows.map((r) => ({ id: r.id, store_id: r.store_id, body: r.body, updated_at: r.updated_at })),
          { onConflict: 'id' },
        ),
        `upsert ${table}`,
      )
    },
    async insertEvents(rows) {
      if (rows.length === 0) return
      check(
        await client.from('events').upsert(
          rows.map((r) => ({ id: r.id, store_id: r.store_id, type: r.type, ts: r.ts, body: r.body })),
          { onConflict: 'id', ignoreDuplicates: true },
        ),
        'insertEvents',
      )
    },
    async pullRecords(table: RecordTable, storeId, win, limit) {
      const data = check(
        await client
          .from(table)
          .select('id, store_id, body, updated_at, server_rev, xid')
          .eq('store_id', storeId)
          .gt('xid', win.afterXid)
          .lt('xid', win.beforeXid)
          .gt('server_rev', win.after)
          .order('server_rev', { ascending: true })
          .limit(limit),
        `pull ${table}`,
      )
      return (data ?? []) as RecordRow[]
    },
    async fetchRecords(table: RecordTable, storeId, ids) {
      if (ids.length === 0) return []
      const data = check(await client.from(table).select('id, store_id, body, updated_at, server_rev').eq('store_id', storeId).in('id', ids), `fetch ${table}`)
      return (data ?? []) as RecordRow[]
    },
    async pullEvents(storeId, win, limit) {
      const data = check(
        await client
          .from('events')
          .select('id, store_id, type, ts, body, server_seq, xid')
          .eq('store_id', storeId)
          .gt('xid', win.afterXid)
          .lt('xid', win.beforeXid)
          .gt('server_seq', win.after)
          .order('server_seq', { ascending: true })
          .limit(limit),
        'pullEvents',
      )
      return (data ?? []) as EventRow[]
    },
    async archiveStore(id) {
      check(await client.rpc('archive_store', { sid: id }), 'archive_store')
    },
    async unarchiveStore(id) {
      check(await client.rpc('unarchive_store', { sid: id }), 'unarchive_store')
    },
  }
}

export function createAuthApi(client: SupabaseClient): AuthApi {
  const toUser = (u: { id: string; email?: string } | null | undefined): CloudUser | null => (u ? { id: u.id, email: u.email ?? null } : null)
  return {
    async currentUser() {
      const { data } = await client.auth.getSession()
      return toUser(data.session?.user)
    },
    async signInWithGoogle() {
      // PKCE redirect back to the app's own URL (must be in the project's allowed redirect list).
      const redirectTo = typeof location !== 'undefined' ? `${location.origin}${location.pathname}` : undefined
      const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo } })
      if (error) throw toCloudError(error, 'sign-in')
    },
    async signOut() {
      const { error } = await client.auth.signOut({ scope: 'local' })
      if (error) throw toCloudError(error, 'sign-out')
    },
    onChange(cb) {
      const { data } = client.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') cb(toUser(session?.user))
        else if (event === 'SIGNED_OUT') cb(null)
      })
      return () => data.subscription.unsubscribe()
    },
  }
}

/** Null when the build has no (valid) cloud configuration. */
export function createCloud(env: CloudEnv | null = readCloudEnv()): Cloud | null {
  if (!env) return null
  const client = createClient(env.url, env.anonKey, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  })
  return { api: createCloudApi(client), auth: createAuthApi(client) }
}
