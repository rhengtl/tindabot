// Schema upgrades. A device that exported under the old bookkeeping still carries a
// `last_export_attempt_at` meta row that nothing writes or reads any more (see exportFile.ts);
// opening the database drops it, and leaves every other meta row — `last_backup_at` above all —
// exactly as it was.
import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '../db'
import * as repo from '../repo'

const BACKUP = '2026-09-25T06:35:32.028Z'

/** The database as it was before this upgrade existed, so the upgrade has something to run on. */
async function openLegacy(rows: { key: string; value: string }[]): Promise<void> {
  const old = new Dexie('tindabot')
  old.version(1).stores({ stores: 'id', products: 'id, store_id', events: 'id, store_id, ts, type, [store_id+type]', meta: 'key' })
  old.version(2).stores({ customers: 'id, store_id' })
  await old.open()
  expect(old.verno).toBe(2)
  await old.table('meta').bulkPut(rows)
  old.close()
}

beforeEach(async () => {
  db.close()
  await db.delete()
})

describe('meta cleanup — last_export_attempt_at', () => {
  it('drops the stale key from an existing database and keeps the rest of meta', async () => {
    await openLegacy([
      { key: 'last_export_attempt_at', value: '2026-09-25T06:34:00.000Z' },
      { key: 'last_backup_at', value: BACKUP },
      { key: 'device_id', value: 'DEV00000000000000000000001' },
      { key: 'lang', value: 'en' },
      { key: 'cloud_store_id', value: 'S1' },
    ])

    await db.open()

    expect(await repo.getMeta('last_export_attempt_at')).toBeNull()
    expect(await repo.getMeta('last_backup_at')).toBe(BACKUP)
    expect(await repo.getMeta('device_id')).toBe('DEV00000000000000000000001')
    expect(await repo.getMeta('lang')).toBe('en')
    expect(await repo.getMeta('cloud_store_id')).toBe('S1')
  })

  it('is harmless on a database that never had the key', async () => {
    await openLegacy([{ key: 'last_backup_at', value: BACKUP }])

    await db.open()

    expect(await db.meta.toArray()).toEqual([{ key: 'last_backup_at', value: BACKUP }])
  })

  it('leaves business data alone, and cleans up only on the version step', async () => {
    await db.open()
    const store = await repo.createStore('Tindahan', [3])
    await repo.saveProduct({ id: 'P1', store_id: store.id, name: 'Kape', category: 'c', unit_label: 'u', pack_size: 12, pack_label: 'p', sell_price: 10, archived: false, updated_at: '2026-09-01T00:00:00.000Z' })
    await repo.saveCustomer({ id: 'C1', store_id: store.id, name: 'Aling Nena', phone: null, archived: false, updated_at: '2026-09-01T00:00:00.000Z' })
    await repo.addEvents([{ id: 'E1', v: 1, store_id: store.id, device_id: 'DEV00000000000000000000001', ts: '2026-09-10T12:00:00+08:00', recorded_at: '2026-09-10T12:00:00+08:00', type: 'CASH_COUNT', amount: 100 }])
    await repo.setMeta('last_export_attempt_at', '2026-09-25T06:34:00.000Z')
    await repo.setMeta('last_backup_at', BACKUP)
    db.close()

    await db.open()
    expect(db.verno).toBe(3)
    // Reopening a database that is already current runs no upgrade, so a key written back by hand
    // stays: the cleanup is the one-time upgrade step, and nothing in the app writes this key again.
    expect(await repo.getMeta('last_export_attempt_at')).toBe('2026-09-25T06:34:00.000Z')
    expect(await db.products.count()).toBe(1)
    expect(await db.customers.count()).toBe(1)
    expect(await db.events.count()).toBe(1)
    expect(await db.stores.count()).toBe(1)
    expect(await repo.getMeta('last_backup_at')).toBe(BACKUP)
  })

  it('stays clean when the upgraded database is opened again', async () => {
    await openLegacy([{ key: 'last_export_attempt_at', value: '2026-09-25T06:34:00.000Z' }, { key: 'last_backup_at', value: BACKUP }])

    await db.open()
    const first = await db.meta.toArray()
    db.close()
    await db.open()

    expect(db.verno).toBe(3)
    expect(await db.meta.toArray()).toEqual(first)
    expect(await repo.getMeta('last_export_attempt_at')).toBeNull()
    expect(await repo.getMeta('last_backup_at')).toBe(BACKUP)
  })
})
