import { useCallback, useEffect, useState } from 'react'
import type { ListLine } from '../domain'
import { useApp } from '../state/store'
import { ToastProvider } from './components'
import { AddProductSheet } from './screens/AddProduct'
import { Bahay } from './screens/Bahay'
import { BakitSheet } from './screens/Bakit'
import { BilangSheet } from './screens/Bilang'
import { BumiliSheet } from './screens/Bumili'
import { IbaPa } from './screens/IbaPa'
import { Onboarding } from './screens/Onboarding'
import { Paninda } from './screens/Paninda'
import { S } from './strings'

type Tab = 'bahay' | 'paninda' | 'ibapa'

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}

function Shell() {
  const loaded = useApp((s) => s.loaded)
  const store = useApp((s) => s.store)
  const init = useApp((s) => s.init)
  const refreshNow = useApp((s) => s.refreshNow)
  const onboarded = useApp((s) => s.onboarded)
  const [tab, setTab] = useState<Tab>('bahay')
  const [fab, setFab] = useState(false)
  const [bumili, setBumili] = useState<{ open: boolean; productId: string | null }>({ open: false, productId: null })
  const [bilang, setBilang] = useState<{ open: boolean; only: string[] | null }>({ open: false, only: null })
  const [adding, setAdding] = useState(false)
  const [bakit, setBakit] = useState<{ productId: string; line: ListLine | null } | null>(null)

  useEffect(() => {
    init()
  }, [init])

  // "today" changes: re-derive on focus/visibility and at local midnight.
  useEffect(() => {
    const onVis = () => document.visibilityState === 'visible' && refreshNow()
    document.addEventListener('visibilitychange', onVis)
    const t = window.setInterval(refreshNow, 60_000)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.clearInterval(t)
    }
  }, [refreshNow])

  const openBakit = useCallback((productId: string, line: ListLine | null = null) => setBakit({ productId, line }), [])
  const openBilang = useCallback((only: string[] | null) => setBilang({ open: true, only }), [])
  const openBumili = useCallback((productId: string | null = null) => setBumili({ open: true, productId }), [])

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
        {tab === 'ibapa' && <IbaPa />}
      </main>

      <button type="button" className="fab" aria-label="Ilista" onClick={() => setFab(true)}>
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
            </div>
          </div>
        </div>
      )}

      <nav className="tabbar">
        {(
          [
            ['bahay', '🏠', S.tabs.bahay],
            ['paninda', '📦', S.tabs.paninda],
            ['ibapa', '⋯', S.tabs.ibaPa],
          ] as Array<[Tab, string, string]>
        ).map(([t, ico, label]) => (
          <button key={t} type="button" className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            <span className="ico">{ico}</span>
            {label}
          </button>
        ))}
      </nav>

      <BumiliSheet open={bumili.open} initialProductId={bumili.productId} onClose={() => setBumili({ open: false, productId: null })} />
      <BilangSheet open={bilang.open} only={bilang.only} onClose={() => setBilang({ open: false, only: null })} />
      <AddProductSheet open={adding} onClose={() => setAdding(false)} />
      {bakit && <BakitSheet product={bakitProduct} state={bakitState} line={bakitLine} onClose={() => setBakit(null)} />}
    </div>
  )
}
