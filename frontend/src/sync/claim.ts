// Store-claim decision (P3a, decided 2026-09-15). Pure: given what is on the phone and what the
// account owns in the cloud, say what may happen. Every outcome is non-destructive; the only case
// that touches two populated stores ('ask') requires an explicit user choice made elsewhere.

import type { Store } from '../domain'
import type { StoreRow } from './codec'

export interface LocalStoreInfo {
  store: Store
  /** has any product, customer or event — anything the user could lose */
  populated: boolean
  /** demo store: never uploaded, never claimed */
  localOnly: boolean
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
  /** account owns nothing yet → the phone store becomes the account's store */
  | { kind: 'upload'; storeId: string }
  /** same id on both sides → ordinary sync */
  | { kind: 'sync'; storeId: string }
  /** nothing to lose on the phone (empty or demo) → pull the cloud store and switch to it */
  | { kind: 'pull_switch'; cloudStoreId: string; resume: boolean }
  /** two populated stores → user chooses */
  | { kind: 'ask'; cloud: StoreRow; local: Store }

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
  const cloud = pickCloudStore(active, local.store.id)
  if (!cloud) return local.localOnly ? { kind: 'none', reason: 'local_only' } : { kind: 'upload', storeId: local.store.id }
  if (cloud.id === local.store.id) return { kind: 'sync', storeId: local.store.id }
  if (local.localOnly || !local.populated) return { kind: 'pull_switch', cloudStoreId: cloud.id, resume: false }
  return { kind: 'ask', cloud, local: local.store }
}
