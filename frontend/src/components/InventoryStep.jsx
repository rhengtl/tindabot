export default function InventoryStep({ products, onRunForecast, onSkip, loading }) {
  function handleSubmit(e) {
    e.preventDefault()
    const form = new FormData(e.target)
    const inventory = {}
    for (const product of products) {
      const val = parseInt(form.get(product), 10)
      if (!isNaN(val) && val > 0) inventory[product] = val
    }
    onRunForecast(inventory)
  }

  return (
    <div style={styles.wrapper}>
      <h2 style={styles.title}>Current Stock Levels</h2>
      <p style={styles.subtitle}>
        Enter how many units you have right now. TindaBot will tell you when each product runs out.
        Leave blank for products you don't want to track.
      </p>

      <form onSubmit={handleSubmit}>
        <div style={styles.table}>
          <div style={styles.headerRow}>
            <span>Product</span>
            <span style={{ textAlign: 'right' }}>Units in stock</span>
          </div>
          {products.map(product => (
            <div key={product} style={styles.row}>
              <label style={styles.label} htmlFor={product}>{product}</label>
              <input
                id={product}
                name={product}
                type="number"
                min="0"
                placeholder="0"
                style={styles.input}
              />
            </div>
          ))}
        </div>

        <div style={styles.actions}>
          <button type="submit" disabled={loading} style={styles.primaryBtn}>
            {loading ? '⏳ Running forecast...' : '📊 Run Forecast'}
          </button>
          <button type="button" onClick={onSkip} style={styles.skipBtn}>
            Skip — just chat about sales
          </button>
        </div>
      </form>
    </div>
  )
}

const styles = {
  wrapper: { maxWidth: 540, margin: '0 auto', padding: '1.5rem 1rem' },
  title: { fontSize: '1.3rem', color: '#c47a00', marginBottom: '0.3rem' },
  subtitle: { fontSize: '0.88rem', color: '#666', marginBottom: '1.25rem', lineHeight: 1.5 },
  table: { border: '1px solid #eee', borderRadius: 10, overflow: 'hidden', marginBottom: '1.25rem' },
  headerRow: {
    display: 'flex', justifyContent: 'space-between',
    padding: '0.5rem 1rem', background: '#fef3d0',
    fontSize: '0.78rem', fontWeight: 600, color: '#a07000', textTransform: 'uppercase', letterSpacing: '0.04em',
  },
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '0.55rem 1rem', borderTop: '1px solid #f0f0f0', background: '#fff',
  },
  label: { fontSize: '0.9rem', color: '#333', flex: 1, paddingRight: '1rem' },
  input: {
    width: 90, padding: '0.3rem 0.5rem', border: '1px solid #ddd',
    borderRadius: 6, fontSize: '0.9rem', textAlign: 'right',
  },
  actions: { display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'center' },
  primaryBtn: {
    width: '100%', padding: '0.7rem', background: '#f0a500', color: '#fff',
    border: 'none', borderRadius: 10, fontWeight: 700, fontSize: '0.95rem',
    cursor: 'pointer',
  },
  skipBtn: {
    background: 'none', border: 'none', color: '#aaa',
    cursor: 'pointer', fontSize: '0.83rem', textDecoration: 'underline',
  },
}
