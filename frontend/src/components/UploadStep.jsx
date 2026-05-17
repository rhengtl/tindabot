import { useState, useRef } from 'react'

export default function UploadStep({ onUploaded }) {
  const [dragging, setDragging] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef()

  async function handleFile(file) {
    if (!file) return
    setError(null)
    setLoading(true)
    const formData = new FormData()
    formData.append('file', file)
    try {
      const res = await fetch('/load-sales', { method: 'POST', body: formData })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail)
      onUploaded(data.products, data.rows)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  function onDrop(e) {
    e.preventDefault()
    setDragging(false)
    handleFile(e.dataTransfer.files[0])
  }

  return (
    <div style={styles.wrapper}>
      <div style={styles.icon}>🏪</div>
      <h2 style={styles.title}>Welcome to TindaBot</h2>
      <p style={styles.subtitle}>Upload your weekly sales CSV to get started.</p>

      <div
        style={{ ...styles.dropzone, borderColor: dragging ? '#f0a500' : '#ddd', background: dragging ? '#fffbef' : '#fafafa' }}
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current.click()}
      >
        <input ref={inputRef} type="file" accept=".csv" style={{ display: 'none' }} onChange={e => handleFile(e.target.files[0])} />
        {loading
          ? <p style={styles.hint}>⏳ Loading your data...</p>
          : <>
              <p style={styles.dropIcon}>📂</p>
              <p style={styles.dropText}>Drag & drop your CSV here, or <span style={styles.link}>browse</span></p>
              <p style={styles.hint}>Required columns: <code>date</code>, <code>product</code>, <code>units_sold</code></p>
            </>
        }
      </div>

      {error && <p style={styles.error}>⚠ {error}</p>}

      <p style={styles.sample}>
        Don't have a file yet? <button style={styles.sampleBtn} onClick={() => onUploaded(null, null, true)}>Use sample data</button>
      </p>
    </div>
  )
}

const styles = {
  wrapper: { textAlign: 'center', padding: '2rem 1rem', maxWidth: 480, margin: '0 auto' },
  icon: { fontSize: '3rem', marginBottom: '0.5rem' },
  title: { fontSize: '1.6rem', color: '#c47a00', marginBottom: '0.25rem' },
  subtitle: { color: '#666', marginBottom: '1.5rem' },
  dropzone: {
    border: '2px dashed', borderRadius: 12, padding: '2rem 1.5rem',
    cursor: 'pointer', transition: 'all 0.2s', marginBottom: '1rem',
  },
  dropIcon: { fontSize: '2rem', margin: '0 0 0.5rem' },
  dropText: { fontSize: '0.95rem', color: '#444', marginBottom: '0.4rem' },
  hint: { fontSize: '0.8rem', color: '#999' },
  link: { color: '#f0a500', textDecoration: 'underline' },
  error: { color: '#ef4444', fontSize: '0.88rem', marginTop: '0.5rem' },
  sample: { fontSize: '0.85rem', color: '#888', marginTop: '0.5rem' },
  sampleBtn: {
    background: 'none', border: 'none', color: '#f0a500',
    cursor: 'pointer', textDecoration: 'underline', fontSize: '0.85rem', padding: 0,
  },
}
