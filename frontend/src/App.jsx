import { useState } from 'react'
import UploadStep from './components/UploadStep'
import InventoryStep from './components/InventoryStep'
import ForecastPanel from './components/ForecastPanel'
import SummaryCard from './components/SummaryCard'
import ChatPanel from './components/ChatPanel'

const STEPS = ['Upload', 'Inventory', 'Forecast', 'Chat']

function ProgressBar({ current }) {
  return (
    <div style={pb.bar}>
      {STEPS.map((label, i) => {
        const done    = i < current
        const active  = i === current
        return (
          <div key={label} style={pb.item}>
            <div style={{ ...pb.circle, background: done || active ? '#f0a500' : '#e0e0e0', color: done || active ? '#fff' : '#aaa' }}>
              {done ? '✓' : i + 1}
            </div>
            <span style={{ ...pb.label, color: active ? '#c47a00' : done ? '#f0a500' : '#bbb' }}>{label}</span>
            {i < STEPS.length - 1 && <div style={{ ...pb.line, background: done ? '#f0a500' : '#e0e0e0' }} />}
          </div>
        )
      })}
    </div>
  )
}

const SAMPLE_INVENTORY = {
  'Lucky Me Pancit Canton Original': 40,
  'Lucky Me Chicken Flavor': 30,
  'Sinandomeng Rice (1kg)': 80,
  'Coca-Cola 1.5L': 15,
  'Sprite 1.5L': 20,
  'Royal Tru-Orange 1.5L': 12,
  'Century Tuna Hot & Spicy': 50,
  'Argentina Corned Beef 150g': 24,
  'Ligo Sardines in Tomato Sauce': 10,
  'Eden Cheese 160g': 18,
}

export default function App() {
  const [step, setStep]           = useState(0)   // 0=upload 1=inventory 2=forecasting 3=chat
  const [products, setProducts]   = useState([])
  const [forecasts, setForecasts] = useState([])
  const [summary, setSummary]     = useState(null)
  const [forecastError, setForecastError] = useState(null)
  const [forecasting, setForecasting]     = useState(false)

  async function fetchSummary() {
    try {
      const res = await fetch('/sales-summary')
      if (res.ok) setSummary(await res.json())
    } catch { /* non-critical, silently ignore */ }
  }

  function handleUploaded(productList, _rows, isSample = false) {
    if (isSample) { handleSample(); return }
    setProducts(productList)
    fetchSummary()
    setStep(1)
  }

  async function handleSample() {
    try {
      const csvRes = await fetch('/weekly_sales.csv')
      const text = await csvRes.text()
      const blob = new Blob([text], { type: 'text/csv' })
      const form = new FormData()
      form.append('file', blob, 'weekly_sales.csv')
      const res = await fetch('/load-sales', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail)
      setProducts(data.products)
      fetchSummary()
      setStep(1)
    } catch {
      setProducts(Object.keys(SAMPLE_INVENTORY))
      setStep(1)
    }
  }

  async function handleRunForecast(inventory) {
    setForecasting(true)
    setForecastError(null)
    setStep(2)
    try {
      const res = await fetch('/forecast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inventory, days_ahead: 7 }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail)
      setForecasts(data.forecasts)
      setStep(3)
    } catch (e) {
      setForecastError(e.message)
      setStep(1)
    } finally {
      setForecasting(false)
    }
  }

  function handleSkip() {
    setForecasts([])
    setStep(3)
  }

  function handleReset() {
    setStep(0)
    setProducts([])
    setForecasts([])
    setSummary(null)
    setForecastError(null)
  }

  return (
    <div style={app.root}>
      <header style={app.header}>
        <span style={app.logo}>🏪 TindaBot</span>
        <span style={app.tagline}>Sari-Sari Store AI · Gemini 2.5 Flash</span>
      </header>

      <ProgressBar current={step === 2 ? 2 : step} />

      <main style={app.main}>

        {step === 0 && (
          <UploadStep onUploaded={handleUploaded} />
        )}

        {step === 1 && (
          <>
            {forecastError && <p style={app.error}>⚠ {forecastError}</p>}
            <InventoryStep
              products={products}
              onRunForecast={handleRunForecast}
              onSkip={handleSkip}
              loading={forecasting}
            />
          </>
        )}

        {step === 2 && (
          <div style={app.centered}>
            <p style={app.loadingIcon}>⏳</p>
            <p style={app.loadingText}>Running Prophet forecast for {products.length} products...</p>
            <p style={app.loadingHint}>This usually takes 5–10 seconds.</p>
          </div>
        )}

        {step === 3 && (
          <div style={app.chatLayout}>
            <SummaryCard stats={summary} />
            {forecasts.length > 0 && (
              <ForecastPanel forecasts={forecasts} onReset={handleReset} />
            )}
            <ChatPanel />
          </div>
        )}

      </main>
    </div>
  )
}

const app = {
  root: { display: 'flex', flexDirection: 'column', height: '100vh', maxWidth: 680, margin: '0 auto', padding: '0 1rem' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 0', borderBottom: '2px solid #f0a500' },
  logo: { fontWeight: 800, fontSize: '1.1rem', color: '#c47a00' },
  tagline: { fontSize: '0.75rem', color: '#aaa' },
  main: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, paddingTop: '1rem' },
  chatLayout: { flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 },
  centered: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' },
  loadingIcon: { fontSize: '3rem' },
  loadingText: { fontSize: '1rem', fontWeight: 600, color: '#555' },
  loadingHint: { fontSize: '0.83rem', color: '#aaa' },
  error: { color: '#ef4444', fontSize: '0.88rem', textAlign: 'center', marginBottom: '0.5rem' },
}

const pb = {
  bar: { display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0.75rem 0', gap: 0 },
  item: { display: 'flex', alignItems: 'center', gap: 0 },
  circle: { width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: 700 },
  label: { fontSize: '0.72rem', fontWeight: 600, margin: '0 0.3rem', whiteSpace: 'nowrap' },
  line: { width: 32, height: 2 },
}
