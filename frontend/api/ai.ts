// TindaBot AI proxy — BLUEPRINT §F (P3b /ai/parse, P4 /ai/chat; hosted as a Vercel function,
// decided 2026-10-01). POST /api/ai with `{ op: 'parse' | 'chat', ... }`.
//
// What this function owns: the Gemini key, the caller check, the rate limit, and schema-bound
// Gemini calls. What it never does: store anything (images and texts live only for the duration
// of the request and are never logged), compute business numbers, or decide anything — the phone
// shows drafts and saves only on the owner's "I-save", and the assistant's tools run on the phone.
//
// Self-contained on purpose (no imports): it is deployed as-is by Vercel next to the static app.
// Server-only settings, never VITE_-prefixed and never sent to the browser:
//   GEMINI_API_KEY   required
//   GEMINI_MODEL     optional, default `gemini-flash-latest`
//   GEMINI_FALLBACK_MODEL  optional, default `gemini-flash-lite-latest` (`none` = no fallback); used
//                    when the main model stays overloaded / rate-limited after a short retry
//   SUPABASE_URL / SUPABASE_ANON_KEY   optional; default to the app's VITE_SUPABASE_* (the public
//                    project URL and anon key — the caller's own token does the authorizing)

export type Env = Record<string, string | undefined>
type Fetch = typeof fetch

const DEFAULT_MODEL = 'gemini-flash-latest'
const DEFAULT_FALLBACK_MODEL = 'gemini-flash-lite-latest'
/** waits before the 2nd and 3rd attempt on one model when Gemini says 429 / 500 / 503 */
const RETRY_DELAYS_MS = [1200, 3000]
/** everything for one request must fit in the function's 60 s (vercel.json), with room to answer */
const BUDGET_MS = 50_000
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
const MAX_BODY = 4_000_000 // bytes; the phone sends one resized JPEG at most (~0.3–1 MB)
const MAX_TEXT = 2000
const MAX_PRODUCTS = 500
const MAX_DRAFTS = 60
const MAX_SNAPSHOT = 8 * 1024
const MAX_TOOL_RESULT = 4 * 1024
const MAX_HISTORY = 30
const MAX_HISTORY_BYTES = 48 * 1024
export const MAX_ROUND = 3
const UPSTREAM_TIMEOUT_MS = 45_000
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export type Sleep = (ms: number) => Promise<void>
const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export type ErrorCode = 'method' | 'bad_request' | 'too_large' | 'not_configured' | 'auth' | 'rate_limited' | 'busy' | 'upstream' | 'unreadable'

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
const fail = (status: number, error: ErrorCode) => json(status, { error })

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const str = (x: unknown, max: number): string | null => (typeof x === 'string' && x.length <= max ? x : null)
const clip = (x: unknown, max: number): string => (typeof x === 'string' ? x.trim().slice(0, max) : '')
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

// ---------------------------------------------------------------------------------------------
// caller check + rate limit (one round trip: the RPC runs as the caller, so an invalid or expired
// token is rejected by the database API itself)
// ---------------------------------------------------------------------------------------------

async function admit(req: Request, env: Env, fetchImpl: Fetch): Promise<Response | null> {
  const auth = req.headers.get('authorization') ?? ''
  if (!/^Bearer [A-Za-z0-9._-]+$/.test(auth)) return fail(401, 'auth')
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL
  const anon = env.SUPABASE_ANON_KEY ?? env.VITE_SUPABASE_ANON_KEY
  if (!url || !anon || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(url)) return fail(503, 'not_configured')
  let res: Response
  try {
    res = await fetchImpl(`${url}/rest/v1/rpc/ai_quota_hit`, {
      method: 'POST',
      headers: { apikey: anon, authorization: auth, 'content-type': 'application/json' },
      body: '{}',
    })
  } catch {
    return fail(502, 'upstream')
  }
  if (res.status === 401 || res.status === 403) return fail(401, 'auth')
  if (res.status === 404) return fail(503, 'not_configured') // migration 0002 not applied
  if (!res.ok) return fail(502, 'upstream')
  const ok = await res.json().catch(() => null)
  if (ok === true) return null
  if (ok === false) return fail(429, 'rate_limited')
  return fail(502, 'upstream')
}

// ---------------------------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------------------------

interface GeminiPart {
  text?: string
  inlineData?: { mimeType: string; data: string }
  functionCall?: { name: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
  thoughtSignature?: string
  thought?: boolean
}
interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

const modelId = (v: string | undefined) => (v && /^[a-z0-9.-]+$/.test(v) ? v : null)

/**
 * One schema-bound Gemini call. Temporary refusals (429 rate limit, 500/503 overloaded) are retried
 * twice after a short wait; if the main model still refuses, the fallback model gets the same
 * chances (its quota is separate). Chat rounds are self-contained (see toContents), so any round may
 * use either model.
 * The final "busy" carries Gemini's last status as `upstream` (a number; diagnosis only).
 */
async function gemini(
  env: Env,
  fetchImpl: Fetch,
  body: Record<string, unknown>,
  opts: { sleep?: Sleep } = {},
): Promise<{ parts: GeminiPart[]; model: string } | Response> {
  const primary = modelId(env.GEMINI_MODEL) ?? DEFAULT_MODEL
  const fallback = env.GEMINI_FALLBACK_MODEL === 'none' ? null : (modelId(env.GEMINI_FALLBACK_MODEL) ?? DEFAULT_FALLBACK_MODEL)
  const models = [primary, ...(fallback && fallback !== primary ? [fallback] : [])]
  const sleep = opts.sleep ?? realSleep
  const deadline = Date.now() + BUDGET_MS
  let last = 0
  for (const model of models) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        const wait = RETRY_DELAYS_MS[attempt - 1]!
        if (Date.now() + wait > deadline - 8_000) break
        await sleep(wait)
      }
      let res: Response
      try {
        res = await fetchImpl(`${GEMINI_BASE}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'x-goog-api-key': env.GEMINI_API_KEY!, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.max(1_000, Math.min(UPSTREAM_TIMEOUT_MS, deadline - Date.now()))),
        })
      } catch {
        return fail(502, 'upstream') // no answer in time: a retry would not fit either
      }
      if (res.status === 429 || res.status === 500 || res.status === 503) {
        last = res.status
        continue
      }
      if (res.status === 404 && model !== models[models.length - 1]) {
        last = 404 // this model id is unknown (e.g. a retired alias): try the next one
        break
      }
      if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
        // A bad/expired key or an unknown model is a configuration problem, not the caller's.
        return res.status === 400 ? json(502, { error: 'upstream', upstream: 400 }) : json(503, { error: 'not_configured', upstream: res.status })
      }
      if (!res.ok) return json(502, { error: 'upstream', upstream: res.status })
      const data = (await res.json().catch(() => null)) as { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> } | null
      const parts = data?.candidates?.[0]?.content?.parts
      if (!Array.isArray(parts)) return fail(502, 'unreadable')
      return { parts, model }
    }
  }
  return json(503, { error: 'busy', upstream: last })
}

// ---------------------------------------------------------------------------------------------
// op: parse — receipt photo or a typed/dictated note → drafts (never saved here)
// ---------------------------------------------------------------------------------------------

export interface ParseProduct {
  name: string
  pack_label: string
  pack_size: number
  unit_label: string
}
export interface Draft {
  kind: 'purchase' | 'count'
  /** index into the request's products, or -1 for an item the store does not have yet */
  product_index: number
  name_seen: string
  qty: number
  qty_unit: 'pack' | 'unit'
  total_cost: number | null
  supplier: string | null
}

const PARSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    drafts: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: ['purchase', 'count'] },
          product_index: { type: 'INTEGER' },
          name_seen: { type: 'STRING' },
          qty: { type: 'NUMBER' },
          qty_unit: { type: 'STRING', enum: ['pack', 'unit'] },
          total_cost: { type: 'NUMBER', nullable: true },
          supplier: { type: 'STRING', nullable: true },
        },
        required: ['kind', 'product_index', 'name_seen', 'qty', 'qty_unit', 'total_cost', 'supplier'],
      },
    },
    unreadable: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['drafts', 'unreadable'],
}

function parsePrompt(products: ParseProduct[], hasImage: boolean): string {
  const list = products.map((p, i) => `${i}\t${p.name}\t1 ${p.pack_label} = ${p.pack_size} ${p.unit_label}`).join('\n')
  return [
    'You read stock entries for a Philippine sari-sari store. Output JSON only, following the schema.',
    hasImage
      ? 'The input is a photo of a supplier receipt. Every line item is a purchase.'
      : 'The input is the owner\'s note (Taglish or English, maybe dictated). "Bumili/binili/kinuha" = purchase; "natira/may natira/bilang" = count of what is left on the shelf.',
    'Match each item to the store\'s product list below (index, name, pack size). Use product_index -1 when no product clearly matches; never guess a different product.',
    'qty: the number written. qty_unit "pack" when it is in the product\'s pack (case, box, ream, pack of the list), "unit" when single pieces.',
    'total_cost: the line total in pesos for a purchase when it is written; null when not written. Never compute or estimate a price. For a count, null.',
    'supplier: the store/supplier name when it is written (receipt header or note), else null.',
    'Put anything you cannot read with confidence in "unreadable" as short text, instead of guessing. Ignore totals, change, VAT and payment lines.',
    '',
    'Products:',
    list || '(none yet)',
  ].join('\n')
}

export function validDrafts(raw: unknown, nProducts: number): { drafts: Draft[]; unreadable: string[] } | null {
  if (!isObj(raw) || !Array.isArray(raw.drafts) || !Array.isArray(raw.unreadable)) return null
  const drafts: Draft[] = []
  const unreadable = raw.unreadable.filter((u): u is string => typeof u === 'string').map((u) => u.trim().slice(0, 120)).filter(Boolean).slice(0, 20)
  for (const d of raw.drafts.slice(0, MAX_DRAFTS)) {
    if (!isObj(d)) continue
    const kind = d.kind === 'purchase' || d.kind === 'count' ? d.kind : null
    const idx = Number.isInteger(d.product_index) && (d.product_index as number) >= -1 && (d.product_index as number) < nProducts ? (d.product_index as number) : -1
    const qty = finite(d.qty) && d.qty >= 0 && d.qty <= 100_000 ? d.qty : null
    const unit = d.qty_unit === 'pack' || d.qty_unit === 'unit' ? d.qty_unit : null
    const name = clip(d.name_seen, 120)
    if (!kind || qty === null || !unit || (!name && idx < 0)) {
      if (name) unreadable.push(name)
      continue
    }
    const cost = kind === 'purchase' && finite(d.total_cost) && d.total_cost >= 0 && d.total_cost < 10_000_000 ? Math.round(d.total_cost * 100) / 100 : null
    const supplier = clip(d.supplier, 60) || null
    drafts.push({ kind, product_index: idx, name_seen: name, qty, qty_unit: unit, total_cost: cost, supplier })
  }
  return { drafts, unreadable }
}

async function opParse(body: Record<string, unknown>, env: Env, fetchImpl: Fetch, sleep?: Sleep): Promise<Response> {
  const products = Array.isArray(body.products) ? body.products : null
  if (!products || products.length > MAX_PRODUCTS) return fail(400, 'bad_request')
  const ps: ParseProduct[] = []
  for (const p of products) {
    if (!isObj(p) || !str(p.name, 120) || !str(p.pack_label, 40) || !str(p.unit_label, 40) || !finite(p.pack_size)) return fail(400, 'bad_request')
    ps.push({ name: p.name as string, pack_label: p.pack_label as string, pack_size: p.pack_size, unit_label: p.unit_label as string })
  }
  const parts: GeminiPart[] = []
  if (body.image !== undefined) {
    const img = body.image
    if (!isObj(img) || typeof img.mime !== 'string' || !IMAGE_TYPES.has(img.mime) || typeof img.data !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(img.data)) return fail(400, 'bad_request')
    parts.push({ inlineData: { mimeType: img.mime, data: img.data } })
  } else {
    const text = str(body.text, MAX_TEXT)
    if (!text || !text.trim()) return fail(400, 'bad_request')
    parts.push({ text: `Owner's note:\n${text}` })
  }
  parts.push({ text: parsePrompt(ps, body.image !== undefined) })
  const out = await gemini(env, fetchImpl, {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: PARSE_SCHEMA, temperature: 0 },
  }, { sleep })
  if (out instanceof Response) return out
  const text = out.parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return fail(502, 'unreadable')
  }
  const v = validDrafts(raw, ps.length)
  return v ? json(200, v) : fail(502, 'unreadable')
}

// ---------------------------------------------------------------------------------------------
// op: chat — stateless; tools run on the phone; round 3 forces the answer
// ---------------------------------------------------------------------------------------------

export type Turn =
  | { role: 'user'; text: string }
  | { role: 'model'; calls: Array<{ name: string; args: Record<string, unknown>; sig?: string; model?: string }> }
  | { role: 'tool'; results: Array<{ name: string; id: string; result: unknown }> }

export const TOOL_NAMES = ['get_product', 'list_events', 'get_shopping_list', 'get_week_summary', 'get_customer'] as const
const NAME = { type: 'STRING' }
const TOOLS = [
  { name: 'get_product', description: 'One product: stock estimate, rate, days left, confidence, prices, supplier prices, whether it is on the list. Match by name.', parameters: { type: 'OBJECT', properties: { name: NAME }, required: ['name'] } },
  {
    name: 'list_events',
    description: 'Totals (not individual entries) of what was recorded in the last N days (1–90), optionally for one product: purchases, counts, sales tallied, damaged, utang, payments, expenses.',
    parameters: { type: 'OBJECT', properties: { days: { type: 'INTEGER' }, product: { type: 'STRING', nullable: true } }, required: ['days'] },
  },
  { name: 'get_shopping_list', description: 'The current shopping list for the next supplier trip: items, packs, costs, sections, total.', parameters: { type: 'OBJECT', properties: {} } },
  { name: 'get_week_summary', description: 'Recorded money for one week (0 = this week … 3): expenses, purchases, utang given/received, cash count, outstanding; plus the weekly sales/profit estimate.', parameters: { type: 'OBJECT', properties: { weeks_ago: { type: 'INTEGER' } }, required: ['weeks_ago'] } },
  { name: 'get_customer', description: 'One customer\'s utang balance and dates. Only when the owner named the customer.', parameters: { type: 'OBJECT', properties: { name: NAME }, required: ['name'] } },
  {
    name: 'answer',
    description: 'Your final answer to the owner. Every number in `text` must appear in `figures`, copied from a tool result or the snapshot, with its source.',
    parameters: {
      type: 'OBJECT',
      properties: {
        text: { type: 'STRING' },
        figures: {
          type: 'ARRAY',
          items: {
            type: 'OBJECT',
            properties: { label: { type: 'STRING' }, value: { type: 'NUMBER' }, source: { type: 'STRING' } },
            required: ['label', 'value', 'source'],
          },
        },
      },
      required: ['text', 'figures'],
    },
  },
]

function chatSystem(lang: 'tl' | 'en'): string {
  return [
    'You are TindaBot, a helper for a Philippine sari-sari store owner. You answer questions about THEIR store only, using the snapshot and the tools.',
    lang === 'tl' ? 'Answer in natural Taglish, warm and short (at most 4 sentences).' : 'Answer in simple English, warm and short (at most 4 sentences).',
    'Rules:',
    '- You never compute, estimate or invent a number. Every number you say must be copied from a tool result or the snapshot, and listed in `figures` with `source` = "<result id>.<field>" (for example "r1.on_hand_est") or "snapshot.<field>".',
    '- Mirror the confidence the tools report: "low" → say it is an estimate (tantiya); "none" or a null value → give no number and suggest counting the stock (bilangin).',
    '- When a tool finds nothing, say "wala sa listahan ko" (or "not in my list"). Do not guess.',
    '- Use get_customer only when the owner named that customer. Never ask for customer names.',
    '- You cannot save, change or delete anything; if asked, tell the owner which screen to use (Bumili, Bilang, Utang, Bayad, Gastos).',
    '- Finish by calling `answer`.',
  ].join('\n')
}

/**
 * Each round is ONE plain user message: the snapshot, the owner's question(s), and every tool result
 * looked up so far (by id, so the answer can cite `r1.field`). The earlier rounds are deliberately not
 * replayed as Gemini function-call turns: those would need Gemini's thought signatures, which only the
 * model that made them accepts, and then a busy model could not hand a later round to the fallback
 * model (first live test, 2026-10-01: round 1 kept failing with 503 on the busy main model).
 */
function toContents(history: Turn[], snapshot: unknown): GeminiContent[] | null {
  const questions: string[] = []
  const looked: string[] = []
  for (const t of history) {
    if (!isObj(t)) return null
    if (t.role === 'user') {
      const text = str(t.text, MAX_TEXT)
      if (!text) return null
      questions.push(text)
    } else if (t.role === 'model') {
      if (!Array.isArray(t.calls) || t.calls.length === 0 || t.calls.length > 5) return null
      for (const c of t.calls) if (!isObj(c) || !(TOOL_NAMES as readonly string[]).includes(c.name as string) || !isObj(c.args)) return null
    } else if (t.role === 'tool') {
      if (!Array.isArray(t.results) || t.results.length === 0 || t.results.length > 5) return null
      for (const r of t.results) {
        if (!isObj(r) || !(TOOL_NAMES as readonly string[]).includes(r.name as string) || !str(r.id, 8) || !/^r\d+$/.test(r.id as string)) return null
        const json = JSON.stringify(r.result ?? null)
        if (json.length > MAX_TOOL_RESULT) return null
        looked.push(`${r.id} = ${r.name} → ${json}`)
      }
    } else return null
  }
  if (questions.length === 0) return null
  const text = [
    `Snapshot of the store (JSON):\n${JSON.stringify(snapshot)}`,
    `Owner's question:\n${questions.join('\n')}`,
    looked.length
      ? `Results already looked up on the owner's phone (cite them as "<id>.<field>"; do not ask for them again):\n${looked.join('\n')}`
      : 'Nothing has been looked up yet.',
  ].join('\n\n')
  return [{ role: 'user', parts: [{ text }] }]
}

export type ChatOut =
  | { kind: 'tools'; calls: Array<{ name: string; args: Record<string, unknown>; sig?: string; model?: string }> }
  | { kind: 'answer'; text: string; figures: Array<{ label: string; value: number; source: string }> }

export function readChatParts(parts: GeminiPart[], round: number, model?: string): ChatOut | null {
  const calls = parts.filter((p) => p.functionCall && typeof p.functionCall.name === 'string')
  const answer = calls.find((p) => p.functionCall!.name === 'answer')
  if (answer) {
    const a = answer.functionCall!.args ?? {}
    const text = clip(a.text, 2000)
    if (!text) return null
    const figures = (Array.isArray(a.figures) ? a.figures : [])
      .filter((f): f is { label: string; value: number; source: string } => isObj(f) && typeof f.label === 'string' && finite(f.value) && typeof f.source === 'string')
      .slice(0, 12)
      .map((f) => ({ label: f.label.slice(0, 80), value: f.value, source: f.source.slice(0, 120) }))
    return { kind: 'answer', text, figures }
  }
  const tools = calls.filter((p) => (TOOL_NAMES as readonly string[]).includes(p.functionCall!.name)).slice(0, 5)
  if (tools.length > 0 && round < MAX_ROUND) {
    return {
      kind: 'tools',
      calls: tools.map((p) => ({ name: p.functionCall!.name, args: isObj(p.functionCall!.args) ? p.functionCall!.args : {}, ...(p.thoughtSignature ? { sig: p.thoughtSignature } : {}), ...(model ? { model } : {}) })),
    }
  }
  // A plain-text reply (no call) is still an answer, with no verifiable figures.
  const text = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('').trim()
  return text ? { kind: 'answer', text: text.slice(0, 2000), figures: [] } : null
}

async function opChat(body: Record<string, unknown>, env: Env, fetchImpl: Fetch, sleep?: Sleep): Promise<Response> {
  const round = body.round
  if (!Number.isInteger(round) || (round as number) < 0 || (round as number) > MAX_ROUND) return fail(400, 'bad_request')
  const lang = body.lang === 'en' ? 'en' : 'tl'
  if (!isObj(body.snapshot) || JSON.stringify(body.snapshot).length > MAX_SNAPSHOT) return fail(400, 'bad_request')
  if (!Array.isArray(body.history) || body.history.length === 0 || body.history.length > MAX_HISTORY || JSON.stringify(body.history).length > MAX_HISTORY_BYTES) return fail(400, 'bad_request')
  const contents = toContents(body.history as Turn[], body.snapshot)
  if (!contents) return fail(400, 'bad_request')
  const last = round === MAX_ROUND
  const out = await gemini(env, fetchImpl, {
    systemInstruction: { parts: [{ text: chatSystem(lang) }] },
    contents,
    tools: [{ functionDeclarations: TOOLS }],
    toolConfig: { functionCallingConfig: last ? { mode: 'ANY', allowedFunctionNames: ['answer'] } : { mode: 'ANY' } },
    generationConfig: { temperature: 0.2 },
  }, { sleep })
  if (out instanceof Response) return out
  const r = readChatParts(out.parts, round as number, out.model)
  return r ? json(200, r) : fail(502, 'unreadable')
}

// ---------------------------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------------------------

export async function handle(req: Request, env: Env, fetchImpl: Fetch = fetch, sleep: Sleep = realSleep): Promise<Response> {
  if (req.method !== 'POST') return fail(405, 'method')
  if (!env.GEMINI_API_KEY) return fail(503, 'not_configured')
  const len = Number(req.headers.get('content-length') ?? '0')
  if (len > MAX_BODY) return fail(413, 'too_large')
  const denied = await admit(req, env, fetchImpl)
  if (denied) return denied
  let text: string
  try {
    text = await req.text()
  } catch {
    return fail(400, 'bad_request')
  }
  if (text.length > MAX_BODY) return fail(413, 'too_large')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return fail(400, 'bad_request')
  }
  if (!isObj(body)) return fail(400, 'bad_request')
  if (body.op === 'parse') return opParse(body, env, fetchImpl, sleep)
  if (body.op === 'chat') return opChat(body, env, fetchImpl, sleep)
  return fail(400, 'bad_request')
}

/** Vercel Node.js runtime (Web-standard signature). */
export function POST(request: Request): Promise<Response> {
  return handle(request, process.env)
}
