import { useState } from 'react'

const URGENCY = {
  critical: { color: '#ef4444', bg: '#fef2f2', badge: '🔴 URGENT',  maxDays: 1 },
  soon:     { color: '#f97316', bg: '#fff7ed', badge: '🟠 SOON',    maxDays: 3 },
  watch:    { color: '#eab308', bg: '#fefce8', badge: '🟡 WATCH',   maxDays: 7 },
  ok:       { color: '#22c55e', bg: '#f0fdf4', badge: '🟢 OK',      maxDays: Infinity },
}

function tier(days) {
  if (days === undefined || days === null) return null
  if (days <= 1)  return URGENCY.critical
  if (days <= 3)  return URGENCY.soon
  if (days <= 7)  return URGENCY.watch
  return URGENCY.ok
}

function Card({ f }) {
  const t = tier(f.days_until_stockout)
  return (
    <div style={{ ...styles.card, background: t?.bg ?? '#fafafa', borderLeft: `4px solid ${t?.color ?? '#ddd'}` }}>
      <div style={styles.cardTop}>
        <div>
          <span style={styles.productName}>{f.product}</span>
          {t && <span style={{ ...styles.badge, color: t.color }}>{t.badge}</span>}
        </div>
        {f.days_until_stockout != null &&
          <span style={{ ...styles.days, color: t?.color }}>
            ~{f.days_until_stockout} days
          </span>
        }
      </div>
      <div style={styles.cardMeta}>
        <span>📦 {f.current_stock != null ? `${f.current_stock} units left` : 'No stock count'}</span>
        <span>📈 {f.avg_daily_sales} units/day avg</span>
      </div>
    </div>
  )
}

export default function ForecastPanel({ forecasts, onReset }) {
  const [collapsed, setCollapsed] = useState(true)
  const tracked  = forecasts.filter(f => f.days_until_stockout != null)
  const untracked = forecasts.filter(f => f.days_until_stockout == null)

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.panelTitle}>📊 Inventory Forecast</span>
        <div style={styles.headerActions}>
          <button style={styles.iconBtn} onClick={() => setCollapsed(c => !c)}>
            {collapsed ? '▼ Show details' : '▲ Hide'}
          </button>
          <button style={styles.iconBtn} onClick={onReset} title="Upload new data">↩ New</button>
        </div>
      </div>

      {!collapsed && (
        <>
          {tracked.length > 0 && (
            <div style={styles.list}>
              {tracked.map(f => <Card key={f.product} f={f} />)}
            </div>
          )}
          {untracked.length > 0 && (
            <details style={styles.details}>
              <summary style={styles.summary}>
                {untracked.length} products without stock count (click to see)
              </summary>
              <div style={{ ...styles.list, marginTop: '0.4rem' }}>
                {untracked.map(f => <Card key={f.product} f={f} />)}
              </div>
            </details>
          )}
          {tracked.length === 0 && untracked.length === 0 &&
            <p style={{ color: '#aaa', fontSize: '0.85rem', padding: '0.5rem' }}>No forecast data yet.</p>
          }
        </>
      )}
    </div>
  )
}

const styles = {
  panel: { background: '#fff', border: '1px solid #eee', borderRadius: 12, overflow: 'hidden', marginBottom: '0.75rem' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 1rem', background: '#fef3d0' },
  panelTitle: { fontWeight: 700, fontSize: '0.9rem', color: '#a07000' },
  headerActions: { display: 'flex', gap: '0.5rem' },
  iconBtn: { background: 'none', border: 'none', cursor: 'pointer', color: '#a07000', fontSize: '0.82rem', padding: '0.1rem 0.3rem' },
  list: { display: 'flex', flexDirection: 'column', gap: '0.4rem', padding: '0.6rem' },
  card: { borderRadius: 8, padding: '0.5rem 0.75rem' },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.2rem' },
  productName: { fontSize: '0.88rem', fontWeight: 600, color: '#333', marginRight: '0.5rem' },
  badge: { fontSize: '0.72rem', fontWeight: 700 },
  days: { fontSize: '1rem', fontWeight: 800, whiteSpace: 'nowrap' },
  cardMeta: { display: 'flex', gap: '1rem', fontSize: '0.78rem', color: '#777' },
  details: { padding: '0 0.6rem 0.6rem' },
  summary: { fontSize: '0.82rem', color: '#999', cursor: 'pointer', padding: '0.3rem 0' },
}
