// The cloud contract the sync engine and claim flow depend on. `cloud.ts` implements it with
// supabase-js; tests implement it in memory (mirroring the server-side rules: write-once events,
// LWW guard on records, membership). Nothing here can delete data — the interface has no delete.

import type { EventRow, RecordRow, StoreRow } from './codec'

export type RecordTable = 'products' | 'customers'

export interface CloudApi {
  /** Server `now()` as ISO — clock-skew check only. */
  serverTime(): Promise<string>
  /** Active (non-archived) stores the signed-in user is a member of. */
  listMyStores(): Promise<StoreRow[]>
  /** One store row (archived included) or null when unknown/not visible. */
  fetchStore(id: string): Promise<StoreRow | null>
  /** Upsert; the server ignores stale `updated_at` (LWW guard) and forces `created_by`. */
  upsertStore(row: StoreRow): Promise<void>
  upsertRecords(table: RecordTable, rows: RecordRow[]): Promise<void>
  /** Insert-or-ignore by id (write-once). */
  insertEvents(rows: EventRow[]): Promise<void>
  pullRecords(table: RecordTable, storeId: string, afterRev: number, limit: number): Promise<RecordRow[]>
  /** Current server copies of specific records (after a push, to reconcile rows the LWW guard rejected). */
  fetchRecords(table: RecordTable, storeId: string, ids: string[]): Promise<RecordRow[]>
  pullEvents(storeId: string, afterSeq: number, limit: number): Promise<EventRow[]>
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
