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

  // ---- Household (P5, migration 0002 — decided 2026-10-01). Membership only; no business data. ----
  /** Owner only: a one-time code (valid 24 h) that replaces any unused code of the store. */
  createInvite(storeId: string): Promise<{ code: string; expires_at: string }>
  /** Any signed-in user: becomes a `member` of the code's store. */
  joinStore(code: string): Promise<JoinResult>
  /** Members of a store (owner first), for any member of it. */
  listMembers(storeId: string): Promise<Member[]>
  /** Owner only: the member loses access; every entry they recorded stays. */
  removeMember(storeId: string, userId: string): Promise<void>
  /** Member only: leaves the store (the owner deletes/archives instead). */
  leaveStore(storeId: string): Promise<void>
}

export type JoinResult = { storeId: string } | { error: 'invalid' | 'too_many' | 'own' }

export interface Member {
  user_id: string
  email: string | null
  role: 'owner' | 'member'
  joined_at: string
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
   * error in the URL, or the PKCE code exchange failed). `kind` is what the UI shows (localized);
   * `detail` is display-safe developer text (provider description or supabase-js message, never a
   * token or code) meant for logging only. supabase-js reports this only through
   * `auth.initialize()`, never as an auth-state event.
   */
  signInRedirectError(): Promise<SignInError | null>
  signOut(): Promise<void>
  /** The signed-in user's current access token (for the AI proxy), or null when signed out. */
  accessToken(): Promise<string | null>
  /** Fires with the user on sign-in/restore and null on sign-out. Returns an unsubscribe. */
  onChange(cb: (user: CloudUser | null) => void): () => void
}

/**
 * App-level failure categories. The UI maps these to localized text; `message` is developer detail.
 * `unavailable` is the cloud answering "not right now" — a project paused for inactivity (540) or
 * an API gateway that cannot reach it (502/503/504, 57P03). It is not `network` (the phone has no
 * connection), not `auth` (the session is the problem) and not `server` (the request itself failed).
 */
export type CloudErrorCode = 'network' | 'unavailable' | 'auth' | 'denied' | 'store_gone' | 'server' | 'unknown'

/** Why a Google sign-in redirect came back without a session. */
export type SignInErrorKind = 'cancelled' | 'exchange' | 'provider'
export interface SignInError {
  kind: SignInErrorKind
  detail: string
}

export class CloudError extends Error {
  constructor(
    message: string,
    public readonly code: CloudErrorCode = 'unknown',
  ) {
    super(message)
    this.name = 'CloudError'
  }
}
