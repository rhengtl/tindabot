import { useCallback, useEffect, useState } from 'react'
import type { ListLine } from '../domain'
import { useApp } from '../state/store'
import { ToastProvider, useToast } from './components'
import { AddProductSheet } from './screens/AddProduct'
import { Bahay } from './screens/Bahay'
import { BakitSheet } from './screens/Bakit'
import { BilangSheet } from './screens/Bilang'
import { BumiliSheet } from './screens/Bumili'
import { ClaimChoiceSheet } from './screens/Cloud'
import { IbaPa } from './screens/IbaPa'
import { Listahan } from './screens/Listahan'
import { type PeraKind, PeraSheet } from './screens/Pera'
import { Onboarding } from './screens/Onboarding'
import { Paninda } from './screens/Paninda'
import { useStrings } from './i18n'

type Tab = 'bahay' | 'paninda' | 'listahan' | 'ibapa'

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}

/**
 * The database could not be opened, so there is nothing to show and nothing to save. Say what
 * happened in the person's own language, name the one thing they can usefully check, and let them
 * try again — the browser's own exception stays in the console. The wording follows the runtime
 * language like every other screen; with no stored preference readable, that is Taglish.
 */
function StorageError() {
  const init = useApp((s) => s.init)
  const S = useStrings()
  const [retrying, setRetrying] = useState(false)
  return (
    <div className="app" data-testid="storage-error">
      <main className="screen">
        <div className="banner">{S.storage.title}</div>
        <div className="card">
          <p>{S.storage.body}</p>
          <p className="muted small">{S.storage.check}</p>
          <button
            type="button"
            className="btn primary"
            disabled={retrying}
            data-testid="storage-retry"
            onClick={async () => {
              setRetrying(true)
              try {
                await init()
              } finally {
                setRetrying(false)
              }
            }}
          >
            {S.storage.retry}
          </button>
        </div>
      </main>
    </div>
  )
}

function Shell() {
  const loaded = useApp((s) => s.loaded)
  const storageError = useApp((s) => s.storageError)
  const store = useApp((s) => s.store)
  const init = useApp((s) => s.init)
  const refreshNow = useApp((s) => s.refreshNow)
  const requestSync = useApp((s) => s.requestSync)
  const onboarded = useApp((s) => s.onboarded)
  const signInError = useApp((s) => s.cloud.signInError)
  const S = useStrings()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('bahay')
  const [fab, setFab] = useState(false)
  const [bumili, setBumili] = useState<{ open: boolean; productId: string | null }>({ open: false, productId: null })
  const [bilang, setBilang] = useState<{ open: boolean; only: string[] | null }>({ open: false, only: null })
  const [adding, setAdding] = useState(false)
  const [bakit, setBakit] = useState<{ productId: string; line: ListLine | null } | null>(null)
  const [pera, setPera] = useState<{ open: boolean; kind: PeraKind; customerId: string | null }>({ open: false, kind: 'utang', customerId: null })

  useEffect(() => {
    init()
  }, [init])

  // A failed Google sign-in lands back here on whatever tab was open: say so once (the Cloud card
  // in "Iba pa" keeps the message until the next attempt).
  // The provider's own text stays in the console; the person sees the app's wording for the kind.
  useEffect(() => {
    if (!signInError) return
    console.warn('[tindabot] sign-in redirect failed:', signInError.kind, '—', signInError.detail)
    toast(S.cloud.signInErrors[signInError.kind])
  }, [signInError, toast, S])

  // "today" changes: re-derive on focus/visibility and at local midnight. P3a: foreground and
  // regained connectivity also trigger a sync (no-ops when signed out / unconfigured).
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible') return
      refreshNow()
      requestSync('foreground')
    }
    const onOnline = () => requestSync('online')
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', onOnline)
    const t = window.setInterval(refreshNow, 60_000)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onOnline)
      window.clearInterval(t)
    }
  }, [refreshNow, requestSync])

  const openBakit = useCallback((productId: string, line: ListLine | null = null) => setBakit({ productId, line }), [])
  const openBilang = useCallback((only: string[] | null) => setBilang({ open: true, only }), [])
  const openBumili = useCallback((productId: string | null = null) => setBumili({ open: true, productId }), [])
  const openPera = useCallback((kind: PeraKind, customerId: string | null = null) => setPera({ open: true, kind, customerId }), [])

  if (storageError) return <StorageError />
  if (!loaded) return <div className="empty">…</div>
  if (!store || !onboarded) return <Onboarding />

  const states = useApp.getState().states
  const products = useApp.getState().products
  const bakitProduct = bakit ? products.find((p) => p.id === bakit.productId) ?? null : null
  const bakitState = bakit ? states.get(bakit.productId) ?? null : null
  const bakitLine = bakit ? (bakit.line ?? useApp.getState().list?.lines.find((l) => l.product_id === bakit.productId) ?? null) : null

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>🏪 {store.name}</h1>
          <div className="sub">{S.tagline}</div>
        </div>
      </header>

      <main className="screen">
        {tab === 'bahay' && <Bahay onBakit={openBakit} onBilang={openBilang} onAdd={() => setAdding(true)} />}
        {tab === 'paninda' && <Paninda onAdd={() => setAdding(true)} onBakit={(id) => openBakit(id)} onBumili={(id) => openBumili(id)} onBilang={openBilang} />}
        {tab === 'listahan' && <Listahan onUtang={(id) => openPera('utang', id)} onBayad={(id) => openPera('bayad', id)} />}
        {tab === 'ibapa' && <IbaPa onGastos={() => openPera('gastos')} onPera={() => openPera('pera')} />}
      </main>

      <button type="button" className="fab" aria-label={S.fab.open} data-testid="fab" onClick={() => setFab(true)}>
        ＋
      </button>
      {fab && (
        <div className="fab-menu" onClick={() => setFab(false)}>
          <div className="panel" onClick={(e) => e.stopPropagation()}>
            <div className="grid">
              <button
                type="button"
                onClick={() => {
                  setFab(false)
                  openBumili()
                }}
              >
                🛒 {S.fab.bumili}
              </button>
              <button
                type="button"
                onClick={() => {
                  setFab(false)
                  openBilang(null)
                }}
              >
                🔢 {S.fab.bilang}
              </button>
              {(
                [
                  ['utang', '📒', S.fab.utang],
                  ['bayad', '💵', S.fab.bayad],
                  ['gastos', '🧾', S.fab.gastos],
                  ['pera', '🪙', S.fab.pera],
                ] as Array<[PeraKind, string, string]>
              ).map(([k, ico, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => {
                    setFab(false)
                    openPera(k)
                  }}
                >
                  {ico} {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <nav className="tabbar">
        {(
          [
            ['bahay', '🏠', S.tabs.bahay],
            ['paninda', '📦', S.tabs.paninda],
            ['listahan', '📒', S.tabs.listahan],
            ['ibapa', '⋯', S.tabs.ibaPa],
          ] as Array<[Tab, string, string]>
        ).map(([t, ico, label]) => (
          <button key={t} type="button" className={tab === t ? 'active' : ''} data-testid={`tab-${t}`} onClick={() => setTab(t)}>
            <span className="ico">{ico}</span>
            {label}
          </button>
        ))}
      </nav>

      <BumiliSheet open={bumili.open} initialProductId={bumili.productId} onClose={() => setBumili({ open: false, productId: null })} />
      <BilangSheet open={bilang.open} only={bilang.only} onClose={() => setBilang({ open: false, only: null })} />
      <AddProductSheet open={adding} onClose={() => setAdding(false)} />
      <PeraSheet open={pera.open} kind={pera.kind} initialCustomerId={pera.customerId} onClose={() => setPera((p) => ({ ...p, open: false }))} />
      {bakit && <BakitSheet product={bakitProduct} state={bakitState} line={bakitLine} onClose={() => setBakit(null)} />}
      <ClaimChoiceSheet />
    </div>
  )
}
