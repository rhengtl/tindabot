function peso(val) {
  if (val == null) return '—'
  return '₱' + val.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatDate(str) {
  if (!str) return '—'
  const d = new Date(str)
  return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })
}

function Tile({ icon, label, value, sub }) {
  return (
    <div style={s.tile}>
      <span style={s.tileIcon}>{icon}</span>
      <div>
        <div style={s.tileValue}>{value}</div>
        <div style={s.tileLabel}>{label}</div>
        {sub && <div style={s.tileSub}>{sub}</div>}
      </div>
    </div>
  )
}

export default function SummaryCard({ stats }) {
  if (!stats) return null
  const { date_range } = stats
  const rangeLabel = date_range
    ? `${formatDate(date_range.from)} – ${formatDate(date_range.to)}`
    : null

  return (
    <div style={s.card}>
      <div style={s.header}>
        <span style={s.title}>📈 Weekly Sales Summary</span>
        {rangeLabel && <span style={s.range}>{rangeLabel}</span>}
      </div>
      <div style={s.grid}>
        <Tile
          icon="💰"
          label="Total Revenue"
          value={peso(stats.total_revenue)}
          sub={stats.total_units_sold != null ? `${stats.total_units_sold.toLocaleString()} units sold` : null}
        />
        <Tile
          icon="🏆"
          label="Top Product"
          value={stats.top_product ?? '—'}
          sub={stats.top_product_units != null ? `${stats.top_product_units} units` : null}
        />
        <Tile
          icon="📦"
          label="Top Category"
          value={stats.top_category ?? '—'}
          sub={stats.top_category_units != null ? `${stats.top_category_units} units` : null}
        />
        <Tile
          icon="🗓️"
          label="Best Day"
          value={formatDate(stats.best_day)}
          sub={stats.best_day_revenue != null ? peso(stats.best_day_revenue) : null}
        />
      </div>
    </div>
  )
}

const s = {
  card: {
    background: '#fff',
    border: '1px solid #eee',
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: '0.75rem',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '0.6rem 1rem',
    background: '#fef3d0',
  },
  title: { fontWeight: 700, fontSize: '0.9rem', color: '#a07000' },
  range: { fontSize: '0.75rem', color: '#b08000' },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: '0px',
  },
  tile: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.6rem',
    padding: '0.7rem 1rem',
    borderTop: '1px solid #f5f5f5',
    borderRight: '1px solid #f5f5f5',
  },
  tileIcon: { fontSize: '1.25rem', marginTop: '0.05rem' },
  tileValue: { fontSize: '0.9rem', fontWeight: 700, color: '#333', lineHeight: 1.2 },
  tileLabel: { fontSize: '0.72rem', color: '#999', marginTop: '0.1rem' },
  tileSub: { fontSize: '0.75rem', color: '#bbb', marginTop: '0.1rem' },
}
