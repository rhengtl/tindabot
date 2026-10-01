import { useMemo, useState } from 'react'
import { type Answer, type ChatReply, ask } from '../../ai/chat'
import { AiError, callAi } from '../../ai/client'
import type { AssistantContext } from '../../ai/tools'
import { activeEvents, briefing } from '../../domain'
import { useApp } from '../../state/store'
import { Sheet } from '../components'
import { useStrings } from '../i18n'

// P4 "Tanong kay TindaBot" (BLUEPRINT §F). The briefing at the top is deterministic and offline
// (domain/briefing.ts) and never leaves the phone. Questions go to /ai/chat; the model's tool calls
// run here against the same derived state every screen shows, and each number in an answer is
// checked against the tool result it came from — anything unchecked is labelled "hindi verified".

interface Exchange {
  q: string
  a: Answer | null
  error: string | null
}

export function AskSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useApp()
  const S = useStrings()
  const [question, setQuestion] = useState('')
  const [log, setLog] = useState<Exchange[]>([])
  const [busy, setBusy] = useState(false)
  const signedIn = !!s.cloud.sync.user

  const lines = useMemo(
    () => (s.list ? briefing({ nowMs: s.nowMs, lang: s.lang, products: s.products, states: s.states, list: s.list, finance: s.finance, customers: s.customers, customerStates: s.customerStates }) : []),
    [s.nowMs, s.lang, s.products, s.states, s.list, s.finance, s.customers, s.customerStates],
  )

  async function send(q: string) {
    const text = q.trim()
    if (!text || busy || !s.store || !s.list) return
    setBusy(true)
    setQuestion('')
    setLog((l) => [...l, { q: text, a: null, error: null }])
    const ctx: AssistantContext = { store: s.store, products: s.products, states: s.states, list: s.list, finance: s.finance, customers: s.customers, customerStates: s.customerStates, events: activeEvents(s.events), nowMs: s.nowMs, lang: s.lang }
    const prior = log.filter((x) => x.a).map((x) => ({ q: x.q, a: x.a!.text }))
    try {
      const a = await ask(text, ctx, (body) => callAi<ChatReply>(body, s.aiToken), prior)
      setLog((l) => l.map((x, i) => (i === l.length - 1 ? { ...x, a } : x)))
    } catch (e) {
      const msg = S.ai.errors[e instanceof AiError ? e.code : 'failed']
      setLog((l) => l.map((x, i) => (i === l.length - 1 ? { ...x, error: msg } : x)))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet open={open} onClose={onClose}>
      <h2>{S.ask.title}</h2>
      <div className="card soft" data-testid="briefing">
        <div className="muted small bold">{S.ask.briefing}</div>
        {lines.map((l) => (
          <p key={l} style={{ margin: '4px 0' }}>
            {l}
          </p>
        ))}
      </div>

      {log.map((x, i) => (
        <div key={i} data-testid="exchange">
          <div className="bubble me">{x.q}</div>
          {x.a ? (
            <div className="bubble bot">
              <div>{x.a.text}</div>
              {x.a.figures.some((f) => !f.verified) && (
                <div className="small" style={{ marginTop: 4 }}>
                  {x.a.figures.filter((f) => !f.verified).map((f) => (
                    <span key={f.label + f.source} className="badge orange" style={{ marginRight: 4 }}>
                      {f.label}: {f.value} — {S.ask.unverified}
                    </span>
                  ))}
                </div>
              )}
              {x.a.unverifiedInText && <div className="small flag-text">{S.ask.unverifiedText}</div>}
              {x.a.looked.length > 0 && <div className="muted small">{S.ask.looked([...new Set(x.a.looked)].map((t) => S.ask.tools[t] ?? t).join(', '))}</div>}
            </div>
          ) : x.error ? (
            <div className="bubble bot flag-text" data-testid="ai-error">
              {x.error}
            </div>
          ) : (
            <div className="bubble bot muted">{S.ask.thinking}</div>
          )}
        </div>
      ))}

      {!signedIn ? (
        <div className="card soft small">{S.ai.signInFirst}</div>
      ) : (
        <>
          {log.length === 0 && (
            <div className="chips" style={{ margin: '8px 0' }}>
              {S.ask.examples.map((e) => (
                <button key={e} type="button" className="chip" onClick={() => send(e)} disabled={busy}>
                  {e}
                </button>
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <input
              className="grow"
              aria-label={S.ask.title}
              data-testid="ask-input"
              maxLength={500}
              placeholder={S.ask.placeholder}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send(question)}
            />
            <button type="button" className="btn primary" style={{ width: 'auto' }} data-testid="ask-send" disabled={busy || !question.trim()} onClick={() => send(question)}>
              {S.ask.send}
            </button>
          </div>
          <p className="muted small">{S.ask.note}</p>
        </>
      )}
    </Sheet>
  )
}
