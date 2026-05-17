import { useState, useRef, useEffect } from 'react'
import Markdown from 'react-markdown'

const WELCOME = 'Hoy, ready na tayo! 🛒 Tanong mo na — kailan mauubos ang stock, anong i-restock, o kahit anong gusto mong malaman tungkol sa tindahan mo!'

export default function ChatPanel() {
  const [messages, setMessages] = useState([{ role: 'bot', text: WELCOME }])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef()

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send(e) {
    e.preventDefault()
    const text = input.trim()
    if (!text || loading) return
    setInput('')
    setMessages(prev => [...prev, { role: 'user', text }])
    setLoading(true)
    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      const data = await res.json()
      setMessages(prev => [...prev, { role: 'bot', text: data.reply }])
    } catch {
      setMessages(prev => [...prev, { role: 'bot', text: 'Ay, may error po. Try ulit?' }])
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={styles.wrapper}>
      <div style={styles.messages}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
            <div style={{ ...styles.bubble, ...(m.role === 'user' ? styles.userBubble : styles.botBubble) }}>
              {m.role === 'user'
                ? m.text
                : <Markdown components={mdComponents}>{m.text}</Markdown>
              }
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div style={{ ...styles.bubble, ...styles.botBubble, color: '#bbb' }}>TindaBot is typing...</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={send} style={styles.form}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Tanong mo si TindaBot..."
          disabled={loading}
          style={styles.input}
        />
        <button type="submit" disabled={loading || !input.trim()} style={styles.sendBtn}>
          Send
        </button>
      </form>
    </div>
  )
}

const mdComponents = {
  p:      ({ children }) => <p style={{ margin: '0.2rem 0', lineHeight: 1.55 }}>{children}</p>,
  strong: ({ children }) => <strong style={{ fontWeight: 700 }}>{children}</strong>,
  em:     ({ children }) => <em style={{ fontStyle: 'italic' }}>{children}</em>,
  ul:     ({ children }) => <ul style={{ margin: '0.3rem 0', paddingLeft: '1.2rem' }}>{children}</ul>,
  ol:     ({ children }) => <ol style={{ margin: '0.3rem 0', paddingLeft: '1.2rem' }}>{children}</ol>,
  li:     ({ children }) => <li style={{ margin: '0.15rem 0' }}>{children}</li>,
  code:   ({ children }) => <code style={{ background: '#f3f3f3', borderRadius: 4, padding: '0.1rem 0.3rem', fontSize: '0.85em' }}>{children}</code>,
}

const styles = {
  wrapper: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
  messages: { flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.4rem', padding: '0.5rem 0' },
  bubble: { maxWidth: '78%', padding: '0.55rem 0.9rem', borderRadius: 14, fontSize: '0.9rem', lineHeight: 1.5 },
  userBubble: { background: '#f0a500', color: '#fff', borderRadius: '14px 14px 4px 14px', whiteSpace: 'pre-wrap' },
  botBubble:  { background: '#fff', color: '#333', border: '1px solid #eee', borderRadius: '14px 14px 14px 4px' },
  form: { display: 'flex', gap: '0.5rem', paddingTop: '0.5rem' },
  input: {
    flex: 1, padding: '0.6rem 1rem', borderRadius: 24,
    border: '1px solid #ddd', fontSize: '0.9rem', outline: 'none',
  },
  sendBtn: {
    padding: '0.6rem 1.2rem', background: '#f0a500', color: '#fff',
    border: 'none', borderRadius: 24, fontWeight: 700, cursor: 'pointer',
  },
}
