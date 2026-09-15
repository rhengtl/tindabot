// P3a — Cloud backup card (Iba pa) and the two-populated-stores choice sheet.
// Pure presentation over the store's `cloud` slice; every action is a store method, and all of
// them are no-ops when the build has no cloud configuration.
import { useState } from 'react'
import { useApp } from '../../state/store'
import { Sheet, useToast } from '../components'
import { exportCurrentStore } from '../exportFile'
import { S } from '../strings'

export function agoLabel(iso: string, nowMs: number): string {
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
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const sync = cloud.sync

  if (!cloud.available) {
    return (
      <>
        <h3>{S.cloud.title}</h3>
        <div className="card muted small">{S.cloud.unavailable}</div>
      </>
    )
  }

  if (!sync.user) {
    return (
      <>
        <h3>{S.cloud.title}</h3>
        <div className="card">
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
  let line: string
  switch (sync.phase) {
    case 'idle':
      line = sync.lastSyncAt ? S.cloud.status.idle(agoLabel(sync.lastSyncAt, nowMs)) : S.cloud.status.idleNever
      break
    case 'syncing':
      line = S.cloud.status.syncing
      break
    case 'offline':
      line = S.cloud.status.offline(pending)
      break
    case 'error':
      line = S.cloud.status.error(sync.error ?? '?')
      break
    case 'local_only':
      line = S.cloud.status.localOnly
      break
    case 'needs_choice':
      line = S.cloud.status.needsChoice
      break
    default:
      line = S.cloud.status.unbound
  }

  return (
    <>
      <h3>{S.cloud.title}</h3>
      <div className="card">
        <div className="muted small">{S.cloud.signedInAs(sync.user.email ?? sync.user.id)}</div>
        <div className={`sync-status ${sync.phase}`} style={{ margin: '8px 0' }}>
          {line}
        </div>
        {sync.phase === 'idle' && pending > 0 && <div className="muted small">{S.cloud.status.pending(pending)}</div>}
        {sync.skewWarning && sync.skewMs !== null && <div className="card flag">{S.cloud.skew(Math.round(Math.abs(sync.skewMs) / 60_000))}</div>}
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn secondary sm" disabled={sync.phase === 'syncing' || sync.phase === 'local_only'} onClick={() => syncNow()}>
            {S.cloud.syncNow}
          </button>
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

/** Mounted app-wide (App.tsx) so the choice is visible whichever tab is open. */
export function ClaimChoiceSheet() {
  const choice = useApp((s) => s.cloud.sync.choice)
  const resolveClaim = useApp((s) => s.resolveClaim)
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  if (!choice) return null
  const onExport = async () => {
    if (await exportCurrentStore()) toast('Na-export.')
  }
  const pick = async (c: 'phone' | 'cloud') => {
    setBusy(true)
    try {
      await resolveClaim(c)
      if (useApp.getState().cloud.sync.phase === 'idle') toast(S.cloud.choice.done)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet open onClose={() => resolveClaim('later')}>
      <h2>{S.cloud.choice.title}</h2>
      <p className="muted">{S.cloud.choice.intro(choice.cloud.name, choice.local.name)}</p>
      <div className="card soft">
        <button type="button" className="btn primary" style={{ width: '100%' }} disabled={busy} onClick={() => pick('phone')}>
          {S.cloud.choice.keepPhone}
        </button>
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          {S.cloud.choice.keepPhoneHint}
        </p>
      </div>
      <div className="card soft">
        <button type="button" className="btn secondary" style={{ width: '100%' }} disabled={busy} onClick={() => pick('cloud')}>
          {S.cloud.choice.useCloud}
        </button>
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          {S.cloud.choice.useCloudHint}
        </p>
      </div>
      <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
        <button type="button" className="btn ghost sm" disabled={busy} onClick={() => onExport()}>
          {S.cloud.choice.exportFirst}
        </button>
        <button type="button" className="btn ghost sm" disabled={busy} onClick={() => resolveClaim('later')}>
          {S.cloud.choice.later}
        </button>
      </div>
    </Sheet>
  )
}
