import { useApp } from '../../state/store'
import { useToast, useWrite } from '../components'
import { useStrings } from '../i18n'

// The stores on this phone (Iba pa): switch to one, delete one, add one. The app works on one
// current store at a time; the others are kept exactly as they are until switched to. Deleting is
// the only destructive step here, so it asks first and says what goes (see repo.deleteStore).
export function StoresCard() {
  const S = useStrings()
  const write = useWrite()
  const toast = useToast()
  const stores = useApp((s) => s.stores)
  const current = useApp((s) => s.store?.id ?? null)
  const switchStore = useApp((s) => s.switchStore)
  const deleteStore = useApp((s) => s.deleteStore)
  const newStore = useApp((s) => s.newStore)
  const openDemo = useApp((s) => s.openDemo)
  const hasDemo = stores.some((st) => st.demo)

  const remove = async (id: string, name: string, member: boolean) => {
    // A shared store is left, not deleted: the owner keeps it (see the sync engine's archiveDeleted).
    if (!window.confirm(member ? S.stores.leaveQ(name) : S.stores.deleteQ(name))) return
    if (await write(() => deleteStore(id))) toast(S.stores.deleted(name))
  }

  return (
    <>
      <h3>{S.stores.title}</h3>
      <div className="card" data-testid="stores">
        {stores.map((st) => (
          <div key={st.id} className="line" data-testid="store-row" style={{ alignItems: 'center' }}>
            <span className="name grow">
              {st.name} {st.member && <span className="badge grey">{S.stores.shared}</span>} {st.id === current && <span className="badge green">{S.stores.current}</span>}
            </span>
            <div className="row">
              {st.id !== current && (
                <button type="button" className="btn secondary sm" data-testid="store-use" onClick={() => write(() => switchStore(st.id))}>
                  {S.stores.use}
                </button>
              )}
              <button type="button" className="btn danger sm" data-testid="store-delete" onClick={() => remove(st.id, st.name, st.member)}>
                {S.stores.delete}
              </button>
            </div>
          </div>
        ))}
        <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn secondary sm" data-testid="store-new" onClick={() => write(() => newStore())}>
            {S.stores.add}
          </button>
          {!hasDemo && (
            <button type="button" className="btn ghost sm" data-testid="store-demo" onClick={() => write(() => openDemo())}>
              {S.ibaPa.demo}
            </button>
          )}
        </div>
      </div>
    </>
  )
}
