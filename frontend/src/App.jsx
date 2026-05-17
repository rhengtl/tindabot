import { useState, useRef, useEffect } from 'react'

const API = ''  // proxied via vite

export default function App() {
  const [messages, setMessages] = useState([
    { role: 'bot', text: 'Hoy! Welcome sa TindaBot! 🛒 Ako ang iyong sari-sari store assistant. Tanong ka lang — laban tayo!' }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [salesLoaded, setSalesLoaded] = useState(false)
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function sendMessage(e) {
    e.preventDefault()
    if (!input.trim() || loading) return

    const userMsg = input.trim()
    setInput('')
    setMessages(prev => [...prev, { role: 'user', text: userMsg }])
    setLoading(true)

    try {
      const res = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, { role: 'bot', text: data.reply }])
    } catch {
      setMessages(prev => [...prev, { role: 'bot', text: 'Ay, may error po. Try ulit mamaya!' }])
    } finally {
      setLoading(false)
    }
  }

  async function loadSales() {
    try {
      const res = await fetch(`${API}/load-sales`, { method: 'POST' })
      const data = await res.json()
      setSalesLoaded(true)
      setMessages(prev => [...prev, {
        role: 'bot',
        text: `Sales data na-load na! ${data.rows} rows, columns: ${data.columns.join(', ')}. Tanong ka na!`
      }])
    } catch {
      setMessages(prev => [...prev, { role: 'bot', text: 'Hindi ma-load ang sales data. Check mo ang backend.' }])
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: '1rem', gap: '0.75rem' }}>
      <header style={{ textAlign: 'center', borderBottom: '2px solid #f0a500', paddingBottom: '0.5rem' }}>
        <h1 style={{ fontSize: '1.5rem', color: '#c47a00' }}>🏪 TindaBot</h1>
        <p style={{ fontSize: '0.85rem', color: '#888' }}>Sari-Sari Store AI Assistant · Powered by Gemini 2.5 Flash</p>
        <button
          onClick={loadSales}
          disabled={salesLoaded}
          style={{
            marginTop: '0.5rem', padding: '0.3rem 0.8rem',
            background: salesLoaded ? '#ccc' : '#f0a500', border: 'none',
            borderRadius: '8px', cursor: salesLoaded ? 'default' : 'pointer',
            fontSize: '0.8rem', color: '#fff', fontWeight: 'bold'
          }}
        >
          {salesLoaded ? '✅ Sales Data Loaded' : '📊 Load Weekly Sales CSV'}
        </button>
      </header>

      <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
        {messages.map((m, i) => (
          <div key={i} style={{
            alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
            background: m.role === 'user' ? '#f0a500' : '#fff',
            color: m.role === 'user' ? '#fff' : '#333',
            padding: '0.6rem 1rem',
            borderRadius: m.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
            maxWidth: '75%',
            boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
            whiteSpace: 'pre-wrap',
            fontSize: '0.9rem',
          }}>
            {m.text}
          </div>
        ))}
        {loading && (
          <div style={{ alignSelf: 'flex-start', color: '#aaa', fontSize: '0.85rem', padding: '0.4rem 1rem' }}>
            TindaBot is typing...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={sendMessage} style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Tanong mo si TindaBot..."
          disabled={loading}
          style={{
            flex: 1, padding: '0.6rem 1rem', borderRadius: '24px',
            border: '1px solid #ddd', fontSize: '0.9rem', outline: 'none'
          }}
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          style={{
            padding: '0.6rem 1.2rem', background: '#f0a500', color: '#fff',
            border: 'none', borderRadius: '24px', fontWeight: 'bold',
            cursor: loading ? 'default' : 'pointer'
          }}
        >
          Send
        </button>
      </form>
    </div>
  )
}
