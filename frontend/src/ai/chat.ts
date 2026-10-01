// "Tanong kay TindaBot" — the client half of /ai/chat (BLUEPRINT §F). The proxy is stateless: this
// loop keeps the turns, runs the model's tool calls on the phone (tools.ts), and sends the results
// back, at most rounds 0..3 (round 3 forces an answer). Every figure in the answer is checked
// against the tool result or snapshot it names; anything that does not check out is labelled
// "hindi verified" by the UI. Pure apart from the injected `call`.

import { type AssistantContext, buildSnapshot, runTool } from './tools'

export const MAX_ROUND = 3

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'model'; calls: Array<{ name: string; args: Record<string, unknown>; sig?: string; model?: string }> }
  | { role: 'tool'; results: Array<{ name: string; id: string; result: unknown }> }

export type ChatReply =
  | { kind: 'tools'; calls: Array<{ name: string; args: Record<string, unknown>; sig?: string; model?: string }> }
  | { kind: 'answer'; text: string; figures: Array<{ label: string; value: number; source: string }> }

export interface CheckedFigure {
  label: string
  value: number
  source: string
  verified: boolean
}

export interface Answer {
  text: string
  figures: CheckedFigure[]
  /** a peso amount or decimal in the text that matches no verified figure */
  unverifiedInText: boolean
  /** tool names used, in order (shown as "tiningnan: …") */
  looked: string[]
}

export type ChatCall = (body: { op: 'chat'; history: Turn[]; snapshot: Record<string, unknown>; round: number; lang: string }) => Promise<ChatReply>

/** Resolves "r2.lines.0.cost" / "snapshot.list.total_known_cost" to a number, or null. */
export function resolveSource(source: string, results: Record<string, unknown>, snapshot: Record<string, unknown>): number | null {
  const [head, ...path] = source.split('.')
  let cur: unknown = head === 'snapshot' ? snapshot : head ? results[head] : undefined
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[k]
  }
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : null
}

/** Same number as shown: exact, or the rounding a sentence would use (≤ 0.5, or ≤ 1 % for big pesos). */
export function sameNumber(said: number, actual: number): boolean {
  return Math.abs(said - actual) <= Math.max(0.5, 0.01 * Math.abs(actual))
}

export function checkFigures(figures: Array<{ label: string; value: number; source: string }>, results: Record<string, unknown>, snapshot: Record<string, unknown>): CheckedFigure[] {
  return figures.map((f) => {
    const actual = resolveSource(f.source, results, snapshot)
    return { ...f, verified: actual !== null && sameNumber(f.value, actual) }
  })
}

/** Peso amounts and decimals written in the answer text. Whole numbers are left alone (dates, counts in words). */
export function numbersInText(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/₱\s?([\d,]+(?:\.\d+)?)|(\d+\.\d+)/g)) {
    const n = Number((m[1] ?? m[2] ?? '').replace(/,/g, ''))
    if (Number.isFinite(n)) out.push(n)
  }
  return out
}

export async function ask(question: string, ctx: AssistantContext, call: ChatCall, context: Array<{ q: string; a: string }> = []): Promise<Answer> {
  const snapshot = buildSnapshot(ctx)
  const prior = context.slice(-2).map((x) => `Q: ${x.q}\nA: ${x.a}`).join('\n')
  const history: Turn[] = [{ role: 'user', text: prior ? `${prior}\n\nNew question: ${question}` : question }]
  const results: Record<string, unknown> = {}
  const looked: string[] = []
  let n = 0
  for (let round = 0; round <= MAX_ROUND; round++) {
    const reply = await call({ op: 'chat', history, snapshot, round, lang: ctx.lang })
    if (reply.kind === 'answer') {
      const figures = checkFigures(reply.figures, results, snapshot)
      const ok = figures.filter((f) => f.verified).map((f) => f.value)
      const unverifiedInText = numbersInText(reply.text).some((x) => !ok.some((v) => sameNumber(x, v)))
      return { text: reply.text, figures, unverifiedInText, looked }
    }
    if (round === MAX_ROUND) break // the proxy forces `answer` at round 3; a tool request here is a protocol error
    history.push({ role: 'model', calls: reply.calls })
    history.push({
      role: 'tool',
      results: reply.calls.map((c) => {
        const id = `r${++n}`
        const result = runTool(ctx, c.name, c.args)
        results[id] = result
        looked.push(c.name)
        return { name: c.name, id, result }
      }),
    })
  }
  throw new Error('no answer')
}
