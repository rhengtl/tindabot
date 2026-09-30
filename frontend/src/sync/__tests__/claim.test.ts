import { describe, expect, it } from 'vitest'
import type { Store } from '../../domain'
import { decideClaim, pickCloudStore } from '../claim'
import type { StoreRow } from '../codec'

function store(id: string, updated = '2026-09-01T00:00:00Z'): Store {
  return { id, name: `Store ${id}`, restock_days: [3], next_trip_override: null, multipliers: { payday: 1.3, fri_sat: 1.15 }, updated_at: updated }
}
function row(id: string, updated = '2026-09-01T00:00:00Z', archived: string | null = null): StoreRow {
  return { id, body: store(id, updated), updated_at: updated, archived_at: archived }
}
const local = (id: string, populated: boolean, localOnly = false, otherRealStores = false) => ({ store: store(id), populated, localOnly, otherRealStores })

describe('claim decision table (P3a, decided 2026-09-15; multi-store 2026-09-30)', () => {
  it('no cloud store → upload the phone store (never the demo)', () => {
    expect(decideClaim({ local: local('L', true), cloudStores: [], pendingCloudId: null })).toEqual({ kind: 'upload', storeId: 'L' })
    expect(decideClaim({ local: local('L', false), cloudStores: [], pendingCloudId: null })).toEqual({ kind: 'upload', storeId: 'L' })
    expect(decideClaim({ local: local('D', true, true), cloudStores: [], pendingCloudId: null })).toEqual({ kind: 'none', reason: 'local_only' })
  })

  it('same id on both sides → normal sync, whatever else the account owns', () => {
    expect(decideClaim({ local: local('L', true), cloudStores: [row('L')], pendingCloudId: null })).toEqual({ kind: 'sync', storeId: 'L' })
    expect(decideClaim({ local: local('L', true), cloudStores: [row('X', '2026-09-10T00:00:00Z'), row('L')], pendingCloudId: null })).toEqual({ kind: 'sync', storeId: 'L' })
  })

  it('a fresh phone (the demo, or its only store still empty) → pull the account’s store and switch, no prompt', () => {
    expect(decideClaim({ local: local('L', false), cloudStores: [row('X')], pendingCloudId: null })).toEqual({ kind: 'pull_switch', cloudStoreId: 'X', resume: false })
    expect(decideClaim({ local: local('D', true, true), cloudStores: [row('X')], pendingCloudId: null })).toEqual({ kind: 'pull_switch', cloudStoreId: 'X', resume: false })
    // several cloud stores: the most recently updated one
    expect(decideClaim({ local: local('L', false), cloudStores: [row('X', '2026-09-01T00:00:00Z'), row('Y', '2026-09-09T00:00:00Z')], pendingCloudId: null })).toEqual({ kind: 'pull_switch', cloudStoreId: 'Y', resume: false })
  })

  it('different ids, phone store populated → it is uploaded as another store of the account; nothing is asked, merged or replaced', () => {
    expect(decideClaim({ local: local('L', true), cloudStores: [row('X')], pendingCloudId: null })).toEqual({ kind: 'upload', storeId: 'L' })
    expect(decideClaim({ local: local('L', true, false, true), cloudStores: [row('X'), row('Y')], pendingCloudId: null })).toEqual({ kind: 'upload', storeId: 'L' })
  })

  it('an empty store made next to other stores on the phone is uploaded, not swapped for a cloud store', () => {
    expect(decideClaim({ local: local('N', false, false, true), cloudStores: [row('X')], pendingCloudId: null })).toEqual({ kind: 'upload', storeId: 'N' })
  })

  it('archived cloud stores are invisible to the decision', () => {
    expect(decideClaim({ local: local('L', true), cloudStores: [row('X', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z')], pendingCloudId: null })).toEqual({ kind: 'upload', storeId: 'L' })
    // the phone store itself archived in the cloud (deleted on another device) → the upload path finds
    // it archived and stops syncing it there, without un-archiving (engine: cloud_gone)
    expect(decideClaim({ local: local('L', true), cloudStores: [row('L', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z')], pendingCloudId: null })).toEqual({ kind: 'upload', storeId: 'L' })
  })

  it('an unfinished "use the cloud store" pull resumes before anything else, even over a populated local store', () => {
    expect(decideClaim({ local: local('L', true), cloudStores: [row('X')], pendingCloudId: 'X' })).toEqual({ kind: 'pull_switch', cloudStoreId: 'X', resume: true })
    // but not when that cloud store is gone or archived
    expect(decideClaim({ local: local('L', true), cloudStores: [row('X', '2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z')], pendingCloudId: 'X' }).kind).toBe('upload')
    expect(decideClaim({ local: local('L', true), cloudStores: [], pendingCloudId: 'X' })).toEqual({ kind: 'upload', storeId: 'L' })
  })

  it('no local store → nothing to do', () => {
    expect(decideClaim({ local: null, cloudStores: [row('X')], pendingCloudId: null })).toEqual({ kind: 'none', reason: 'no_local' })
  })

  it('pickCloudStore prefers the matching id, else the most recently updated', () => {
    const a = row('A', '2026-09-01T00:00:00Z')
    const b = row('B', '2026-09-05T00:00:00Z')
    expect(pickCloudStore([a, b], 'A')?.id).toBe('A')
    expect(pickCloudStore([a, b], 'Z')?.id).toBe('B')
    expect(pickCloudStore([a, b], null)?.id).toBe('B')
    expect(pickCloudStore([], 'A')).toBeNull()
  })
})
