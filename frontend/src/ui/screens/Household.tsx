import { useCallback, useEffect, useState } from 'react'
import type { Member } from '../../sync/api'
import { useApp } from '../../state/store'
import { useToast, useWrite } from '../components'
import { useStrings } from '../i18n'

// P5 household (decided 2026-10-01; BLUEPRINT §E7 *Household*). The owner makes a one-time code;
// another signed-in person enters it on their phone and the store appears there as a shared store.
// Both record entries; only the owner changes the store's settings, removes a member, or deletes
// the store in the cloud. Membership is all that changes here — no business data.
export function HouseholdCard() {
  const S = useStrings()
  const toast = useToast()
  const write = useWrite()
  const available = useApp((s) => s.cloud.available)
  const user = useApp((s) => s.cloud.sync.user)
  const bound = useApp((s) => s.cloud.sync.boundStoreId)
  const store = useApp((s) => s.store)
  const demo = useApp((s) => s.demo)
  const member = useApp((s) => s.member)
  const createInvite = useApp((s) => s.createInvite)
  const joinStore = useApp((s) => s.joinStore)
  const listMembers = useApp((s) => s.listMembers)
  const removeMember = useApp((s) => s.removeMember)
  const [invite, setInvite] = useState<{ code: string; expires_at: string } | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const inCloud = !!store && bound === store.id

  const refresh = useCallback(async () => {
    if (!user || !inCloud) return setMembers([])
    try {
      setMembers(await listMembers())
    } catch {
      setMembers([])
    }
  }, [user, inCloud, listMembers])

  useEffect(() => {
    setInvite(null)
    setMsg(null)
    void refresh()
  }, [refresh, store?.id])

  if (!available || !store) return null

  async function makeInvite() {
    setBusy(true)
    setMsg(null)
    try {
      setInvite(await createInvite())
    } catch {
      setMsg(inCloud ? S.household.failed : S.household.notReady)
    } finally {
      setBusy(false)
    }
  }

  async function join() {
    if (!code.trim()) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await joinStore(code.trim())
      if ('error' in r) setMsg(S.household.joinErrors[r.error])
      else {
        setCode('')
        toast(S.household.joined(useApp.getState().store?.name ?? ''))
      }
    } catch {
      setMsg(S.household.failed)
    } finally {
      setBusy(false)
    }
  }

  async function remove(m: Member) {
    if (!window.confirm(S.household.removeQ(m.email ?? S.household.member))) return
    if (await write(() => removeMember(m.user_id))) {
      toast(S.household.removed)
      await refresh()
    }
  }

  const until = invite ? new Date(invite.expires_at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : ''

  return (
    <>
      <h3>{S.household.title}</h3>
      <div className="card" data-testid="household">
        <p className="muted small" style={{ marginTop: 0 }}>
          {S.household.hint}
        </p>
        {!user ? (
          <p className="small">{S.household.signInFirst}</p>
        ) : (
          <>
            {demo ? (
              <p className="small">{S.household.demo}</p>
            ) : member ? (
              <p className="small">{S.ibaPa.memberNote}</p>
            ) : invite ? (
              <div className="card soft" data-testid="invite">
                <div className="muted small">{S.household.code}</div>
                <div className="invite-code" data-testid="invite-code">
                  {invite.code}
                </div>
                <p className="small">{S.household.codeHint(until)}</p>
                <button
                  type="button"
                  className="btn secondary sm"
                  onClick={() => navigator.clipboard?.writeText(invite.code).then(() => toast(S.household.copied)).catch(() => {})}
                >
                  {S.household.copy}
                </button>
              </div>
            ) : (
              <button type="button" className="btn secondary" data-testid="invite-make" disabled={busy} onClick={makeInvite}>
                {S.household.invite}
              </button>
            )}

            {members.length > 1 && (
              <>
                <div className="muted small bold" style={{ marginTop: 12 }}>
                  {S.household.members}
                </div>
                {members.map((m) => (
                  <div key={m.user_id} className="line" style={{ alignItems: 'center' }} data-testid="member-row">
                    <span className="grow small">
                      {m.email ?? '—'} <span className="badge grey">{m.role === 'owner' ? S.household.owner : S.household.member}</span>{' '}
                      {m.user_id === user.id && <span className="badge green">{S.household.you}</span>}
                    </span>
                    {!member && m.role === 'member' && (
                      <button type="button" className="btn danger sm" onClick={() => remove(m)}>
                        {S.household.remove}
                      </button>
                    )}
                  </div>
                ))}
              </>
            )}

            <div className="muted small bold" style={{ marginTop: 14 }}>
              {S.household.join}
            </div>
            <div className="row" style={{ marginTop: 6 }}>
              <input
                className="grow"
                aria-label={S.household.joinPlaceholder}
                data-testid="join-code"
                placeholder={S.household.joinPlaceholder}
                autoCapitalize="characters"
                maxLength={16}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button type="button" className="btn primary" style={{ width: 'auto' }} data-testid="join-btn" disabled={busy || !code.trim()} onClick={join}>
                {S.household.joinBtn}
              </button>
            </div>
          </>
        )}
        {msg && (
          <div className="card flag small" style={{ marginTop: 8 }} data-testid="household-msg">
            {msg}
          </div>
        )}
      </div>
    </>
  )
}
