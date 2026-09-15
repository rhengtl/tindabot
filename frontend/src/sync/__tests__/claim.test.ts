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
const local = (id: string, populated: boolean, localOnly = false) => ({ store: store(id), populated, localOnly })

describe('claim decision table (P3a, decided 2026-09-15)', () => {
  it('no cloud store → upload the phone store (never the demo)', () => {
    expect(decideClaim({ local: local('L', true), cloudStores: [], pendingCloudId: null })).toEqual({ kind: 'upload', storeId: 'L' })
    expect(decideClaim({ local: local('L', false), cloudStores: [], pendingCloudId: null })).toEqual({ kind: 'upload', storeId: 'L' })
    expect(decideClaim({ local: local('D', true, true), cloudStores: [], pendingCloudId: null })).toEqual({ kind: 'none', reason: 'local_only' })
  })

  it('same id on both sides → normal sync, whatever else the account owns', () => {
    expect(decideClaim({ local: local('L', true), cloudStores: [row('L')], pendingCloudId: null })).toEqual({ kind: 'sync', storeId: 'L' })
    expect(decideClaim({ local: local('L', true), cloudStores: [row('X', '2026-09-10T00:00:00Z'), row('L')], pendingCloudId: null })).toEqual({ kind: 'sync', storeId: 'L' })
  })

  it('different id, nothing to lose on the phone (empty or demo) → pull and switch, no prompt', () => {
    expect(decideClaim({ local: local('L', false), cloudStores: [row('X')], pendingCloudId: null })).toEqual({ kind: 'pull_switch', cloudStoreId: 'X', resume: false })
    expect(decideClaim({ local: local('D', true, true), cloudStores: [row('X')], pendingCloudId: null })).toEqual({ kind: 'pull_switch', cloudStoreId: 'X', resume: false })
  })

  it('different ids, both populated → ask; never merge, never replace', () => {
    const d = decideClaim({ local: local('L', true), cloudStores: [row('X')], pendingCloudId: null })
    expect(d.kind).toBe('ask')
    if (d.kind === 'ask') {
      expect(d.cloud.id).toBe('X')
      expect(d.local.id).toBe('L')
    }
  })

  it('archived cloud stores are invisible to the decision', () => {
    expect(decideClaim({ local: local('L', true), cloudStores: [row('X', '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z')], pendingCloudId: null })).toEqual({ kind: 'upload', storeId: 'L' })
    // the phone store itself archived in the cloud (another device chose "keep the phone") → upload path un-archives it
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
