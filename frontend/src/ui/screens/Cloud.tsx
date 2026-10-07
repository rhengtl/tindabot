// P3a — Cloud backup card (Iba pa).
// Pure presentation over the store's `cloud` slice; every action is a store method, and all of
// them are no-ops when the build has no cloud configuration.
import { useState } from 'react'
import { useApp } from '../../state/store'
import { useToast } from '../components'
import { useStrings } from '../i18n'
import type { Strings } from '../strings'

export function agoLabel(iso: string, nowMs: number, S: Strings): string {
  const ms = Math.max(0, nowMs - Date.parse(iso))
  const min = Math.floor(ms / 60_000)
  if (min < 1) return S.cloud.ago.justNow
  if (min < 60) return S.cloud.ago.minutes(min)
  const h = Math.floor(min / 60)
  if (h < 24) return S.cloud.ago.hours(h)
  return S.cloud.ago.days(Math.floor(h / 24))
}

export function CloudCard() {
  const cloud = useApp((s) => s.cloud)
  const nowMs = useApp((s) => s.nowMs)
  const signInGoogle = useApp((s) => s.signInGoogle)
  const signOutCloud = useApp((s) => s.signOutCloud)
  const syncNow = useApp((s) => s.syncNow)
  const deleteStore = useApp((s) => s.deleteStore)
  const store = useApp((s) => s.store)
  const S = useStrings()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const sync = cloud.sync

  if (!cloud.available) {
    return (
      <>
        <h3>{S.cloud.title}</h3>
        <div className="card muted small" data-testid="cloud-card">{S.cloud.unavailable}</div>
      </>
    )
  }

  if (!sync.user) {
    return (
      <>
        <h3>{S.cloud.title}</h3>
        {cloud.signInError && (
          <div className="card flag" data-testid="signin-error">
            {S.cloud.signInErrors[cloud.signInError.kind]}
          </div>
        )}
        <div className="card" data-testid="cloud-card">
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await signInGoogle() // redirects away; nothing runs after this on success
              } catch {
                toast(S.cloud.signInFailed)
                setBusy(false)
              }
            }}
          >
            {S.cloud.signIn}
          </button>
          <p className="muted small" style={{ marginTop: 8 }}>
            {S.cloud.signInHint}
          </p>
        </div>
      </>
    )
  }

  const pending = sync.pendingEvents + sync.pendingRecords
  // One visual state per situation: the class drives the colour/dot, the text says it in words.
  let tone: string = sync.phase
  let line: string
  switch (sync.phase) {
    case 'idle':
      line = sync.lastSyncAt ? S.cloud.status.idle(agoLabel(sync.lastSyncAt, nowMs, S)) : S.cloud.status.idleNever
      break
    case 'syncing':
      line = S.cloud.status.syncing
      break
    case 'offline':
      line = S.cloud.status.offline(pending)
      break
    case 'error':
      if (sync.error?.code === 'unavailable') {
        tone = 'unavailable'
        line = pending ? S.cloud.status.unavailablePending(pending) : S.cloud.status.unavailable
      } else if (sync.error?.code === 'store_gone') {
        // Deleted on another device (or the owner removed this account): the copy here stays, but
        // there is nothing left to sync it with, so "Sync now" would do nothing. Say so, and offer the
        // one useful action instead.
        tone = 'gone'
        line = S.cloud.status.gone
      } else if (sync.error?.code === 'auth') {
        tone = 'auth'
        line = S.cloud.status.authNeeded
      } else {
        line = S.cloud.status.error(S.cloud.errors[sync.error?.code ?? 'unknown'])
      }
      break
    case 'local_only':
      line = S.cloud.status.localOnly
      break
    default:
      line = S.cloud.status.unbound
  }

  return (
    <>
      <h3>{S.cloud.title}</h3>
      <div className="card" data-testid="cloud-card">
        <div className="muted small">{S.cloud.signedInAs(sync.user.email ?? sync.user.id)}</div>
        <div className={`sync-status ${tone}`} style={{ margin: '8px 0' }} data-testid="sync-status" data-tone={tone}>
          {line}
        </div>
        {sync.phase === 'idle' && pending > 0 && <div className="muted small">{S.cloud.status.pending(pending)}</div>}
        {sync.skewWarning && sync.skewMs !== null && <div className="card flag">{S.cloud.skew(Math.round(Math.abs(sync.skewMs) / 60_000))}</div>}
        {tone === 'gone' && <p className="muted small" data-testid="gone-hint">{S.cloud.goneHint}</p>}
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          {tone === 'gone' && store ? (
            <button
              type="button"
              className="btn danger sm"
              data-testid="gone-delete"
              onClick={async () => {
                if (!window.confirm(S.stores.deleteQ(store.name))) return
                try {
                  await deleteStore(store.id)
                  toast(S.stores.deleted(store.name))
                } catch {
                  toast(S.common.notSaved)
                }
              }}
            >
              {S.cloud.goneDelete}
            </button>
          ) : (
            <button type="button" className="btn secondary sm" disabled={sync.phase === 'syncing' || sync.phase === 'local_only'} onClick={() => syncNow()}>
              {S.cloud.syncNow}
            </button>
          )}
          <button type="button" className="btn ghost sm" onClick={() => signOutCloud()}>
            {S.cloud.signOut}
          </button>
        </div>
        <p className="muted small" style={{ marginTop: 8 }}>
          {S.cloud.signOutHint}
        </p>
      </div>
    </>
  )
}
