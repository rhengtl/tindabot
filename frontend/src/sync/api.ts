// The cloud contract the sync engine and claim flow depend on. `cloud.ts` implements it with
// supabase-js; tests implement it in memory (mirroring the server-side rules: write-once events,
// LWW guard on records, membership). Nothing here can delete data — the interface has no delete.

import type { EventRow, PullWindow, RecordRow, StoreRow } from './codec'

export type RecordTable = 'products' | 'customers'

export interface CloudApi {
  /** Server `now()` as ISO — clock-skew check only. */
  serverTime(): Promise<string>
  /**
   * The lowest transaction id still running on the server. Every transaction with a lower id has
   * finished, so rows with `xid < watermark` are exactly the rows that can never appear later.
   */
  syncWatermark(): Promise<number>
  /** Active (non-archived) stores the signed-in user is a member of. */
  listMyStores(): Promise<StoreRow[]>
  /** One store row (archived included) or null when unknown/not visible. */
  fetchStore(id: string): Promise<StoreRow | null>
  /** Upsert; the server ignores stale `updated_at` (LWW guard) and forces `created_by`. */
  upsertStore(row: StoreRow): Promise<void>
  upsertRecords(table: RecordTable, rows: RecordRow[]): Promise<void>
  /** Insert-or-ignore by id (write-once). */
  insertEvents(rows: EventRow[]): Promise<void>
  pullRecords(table: RecordTable, storeId: string, win: PullWindow, limit: number): Promise<RecordRow[]>
  /** Current server copies of specific records (after a push, to reconcile rows the LWW guard rejected). */
  fetchRecords(table: RecordTable, storeId: string, ids: string[]): Promise<RecordRow[]>
  pullEvents(storeId: string, win: PullWindow, limit: number): Promise<EventRow[]>
  /** Owner-only RPCs; non-destructive flags on the store row. */
  archiveStore(id: string): Promise<void>
  unarchiveStore(id: string): Promise<void>
}

export interface CloudUser {
  id: string
  email: string | null
}

export interface AuthApi {
  currentUser(): Promise<CloudUser | null>
  signInWithGoogle(): Promise<void>
  /**
   * Non-null when this page load is the return leg of a sign-in redirect that failed (provider
   * error in the URL, or the PKCE code exchange failed). Display-safe text, never a token.
   * supabase-js reports this only through `auth.initialize()`, never as an auth-state event.
   */
  signInRedirectError(): Promise<string | null>
  signOut(): Promise<void>
  /** Fires with the user on sign-in/restore and null on sign-out. Returns an unsubscribe. */
  onChange(cb: (user: CloudUser | null) => void): () => void
}

export class CloudError extends Error {
  constructor(
    message: string,
    public readonly code: 'network' | 'auth' | 'denied' | 'server' | 'unknown' = 'unknown',
  ) {
    super(message)
    this.name = 'CloudError'
  }
}
