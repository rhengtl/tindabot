// Store-claim decision (P3a, decided 2026-09-15; multi-store rules decided 2026-09-30). Pure: given
// what is on the phone and what the account owns in the cloud, say what may happen to the current
// store. Every outcome is non-destructive. An account may own several stores, so a store on the
// phone never competes with a different one in the cloud: each is kept as its own store.

import type { Store } from '../domain'
import type { StoreRow } from './codec'

export interface LocalStoreInfo {
  store: Store
  /** has any product, customer or event — anything the user could lose */
  populated: boolean
  /** demo store: never uploaded, never claimed */
  localOnly: boolean
  /** another real (non-demo) store exists on this phone besides this one */
  otherRealStores: boolean
}

export interface ClaimInput {
  local: LocalStoreInfo | null
  /** the account's active (non-archived) stores */
  cloudStores: StoreRow[]
  /** `claim_pending` meta: a "use the cloud store" pull that did not finish */
  pendingCloudId: string | null
}

export type ClaimDecision =
  | { kind: 'none'; reason: 'no_local' | 'local_only' }
  /** the phone store is not in the cloud yet → it becomes one of the account's stores */
  | { kind: 'upload'; storeId: string }
  /** same id on both sides → ordinary sync */
  | { kind: 'sync'; storeId: string }
  /** a fresh phone (demo, or its only store still empty) → pull the account's store and switch */
  | { kind: 'pull_switch'; cloudStoreId: string; resume: boolean }

/** Prefer the store matching the phone's id; otherwise the most recently updated one. */
export function pickCloudStore(stores: StoreRow[], localId: string | null): StoreRow | null {
  const same = localId ? stores.find((s) => s.id === localId) : undefined
  if (same) return same
  let best: StoreRow | null = null
  for (const s of stores) if (!best || Date.parse(s.updated_at) > Date.parse(best.updated_at)) best = s
  return best
}

export function decideClaim(input: ClaimInput): ClaimDecision {
  const active = input.cloudStores.filter((s) => !s.archived_at)
  if (input.pendingCloudId && active.some((s) => s.id === input.pendingCloudId)) {
    return { kind: 'pull_switch', cloudStoreId: input.pendingCloudId, resume: true }
  }
  if (!input.local) return { kind: 'none', reason: 'no_local' }
  const local = input.local
  if (active.some((s) => s.id === local.store.id)) return { kind: 'sync', storeId: local.store.id }
  const cloud = pickCloudStore(active, null)
  // Restoring onto a fresh phone: the demo, or a phone whose only store has nothing in it yet.
  // With another real store on the phone, an empty new store was made on purpose: it is uploaded.
  const fresh = local.localOnly || (!local.populated && !local.otherRealStores)
  if (cloud && fresh) return { kind: 'pull_switch', cloudStoreId: cloud.id, resume: false }
  return local.localOnly ? { kind: 'none', reason: 'local_only' } : { kind: 'upload', storeId: local.store.id }
}
