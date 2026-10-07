// P3b/P4 AI (decided 2026-10-01): the Vercel proxy (frontend/api/ai.ts) against an injected fetch
// standing in for Supabase and Gemini, and the phone side (client, drafts, tools, chat loop).
// No network and no key: the real Gemini round trip is checked by hand on the preview/hosted app.

import { describe, expect, it } from 'vitest'
import { handle, readChatParts, validDrafts } from '../../../api/ai'
import { type ActiveEvent, type Customer, type CustomerState, type Product, type StoreState, activeEvents, buildList, deriveProduct, stockEventsByProduct, toMs } from '../../domain'
import { DEVICE_ID, STORE_ID, makeStore } from '../../domain/__tests__/helpers'
import { AiError, callAi } from '../client'
import { type ChatCall, ask, checkFigures, numbersInText } from '../chat'
import { matchSupplier, rowUnits, savable, toRows } from '../drafts'
import { type AssistantContext, MAX_RESULT_BYTES, buildSnapshot, findByName, runTool } from '../tools'

// ------------------------------------------------------------------------------------------------
// proxy
// ------------------------------------------------------------------------------------------------

const ENV = { GEMINI_API_KEY: 'test-key-not-real', VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_ANON_KEY: 'anon-key-placeholder-xxxxxxxx' }

interface Seen {
  url: string
  init: RequestInit
}
function fakeFetch(opts: { quota?: unknown; quotaStatus?: number; gemini?: unknown; geminiStatus?: number } = {}) {
  const seen: Seen[] = []
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, init })
    if (url.includes('/rest/v1/rpc/ai_quota_hit')) return new Response(JSON.stringify(opts.quota ?? true), { status: opts.quotaStatus ?? 200 })
    return new Response(JSON.stringify(opts.gemini ?? {}), { status: opts.geminiStatus ?? 200 })
  }) as unknown as typeof fetch
  return { f, seen }
}
const req = (body: unknown, auth: string | null = 'Bearer abc.def.ghi', method = 'POST') =>
  new Request('https://app.example/api/ai', { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
const noSleep = async () => {}
const geminiText = (obj: unknown) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] })
const PRODUCTS = [{ name: 'Coke Mismo', pack_label: 'case', pack_size: 12, unit_label: 'bote' }]

describe('AI proxy (api/ai.ts)', () => {
  it('refuses without a key, without a token, with a bad token, over the limit — before calling Gemini', async () => {
    const parse = { op: 'parse', text: 'bumili 2 case coke 1560', products: PRODUCTS }
    let { f, seen } = fakeFetch()
    expect((await handle(req(parse), { ...ENV, GEMINI_API_KEY: undefined }, f)).status).toBe(503)
    expect((await handle(req(parse, null), ENV, f)).status).toBe(401)
    expect((await handle(req(parse, 'Bearer bad token!'), ENV, f)).status).toBe(401)
    expect(seen.length).toBe(0)
    ;({ f, seen } = fakeFetch({ quotaStatus: 401 }))
    expect((await handle(req(parse), ENV, f)).status).toBe(401)
    ;({ f, seen } = fakeFetch({ quota: false }))
    const limited = await handle(req(parse), ENV, f)
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'rate_limited' })
    expect(seen.map((s) => s.url.includes('generativelanguage'))).toEqual([false])
    ;({ f } = fakeFetch({ quotaStatus: 404 }))
    expect(await (await handle(req(parse), ENV, f)).json()).toEqual({ error: 'not_configured' }) // migration 0002 missing
    expect((await handle(req(parse, 'Bearer x', 'GET'), ENV, f)).status).toBe(405)
  })

  it('parse: forwards the caller token to the quota check only, the key to Gemini only, and returns validated drafts', async () => {
    const out = { drafts: [{ kind: 'purchase', product_index: 0, name_seen: 'coke', qty: 2, qty_unit: 'pack', total_cost: 1560, supplier: 'Puregold' }], unreadable: [] }
    const { f, seen } = fakeFetch({ gemini: geminiText(out) })
    const res = await handle(req({ op: 'parse', text: 'bumili 2 case coke 1560 sa puregold', products: PRODUCTS }), ENV, f)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(out)
    const [quota, gem] = seen
    expect((quota!.init.headers as Record<string, string>).authorization).toBe('Bearer abc.def.ghi')
    expect(JSON.stringify(quota!.init.headers)).not.toContain('test-key-not-real')
    expect((gem!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key-not-real')
    expect(JSON.stringify(gem!.init.headers)).not.toContain('abc.def.ghi')
    expect(gem!.url).toContain('/gemini-flash-latest:generateContent')
    const body = JSON.parse(String(gem!.init.body))
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(body.contents[0].parts[1].text).toContain('0\tCoke Mismo\t1 case = 12 bote')
  })

  it('parse: an image goes through as inline data; bad images and oversize bodies are refused', async () => {
    const { f, seen } = fakeFetch({ gemini: geminiText({ drafts: [], unreadable: ['blurry'] }) })
    const ok = await handle(req({ op: 'parse', image: { mime: 'image/jpeg', data: 'AAAA' }, products: PRODUCTS }), ENV, f)
    expect(await ok.json()).toEqual({ drafts: [], unreadable: ['blurry'] })
    expect(JSON.parse(String(seen[1]!.init.body)).contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } })
    expect((await handle(req({ op: 'parse', image: { mime: 'image/gif', data: 'AAAA' }, products: PRODUCTS }), ENV, f)).status).toBe(400)
    expect((await handle(req({ op: 'parse', image: { mime: 'image/jpeg', data: 'not base64!' }, products: PRODUCTS }), ENV, f)).status).toBe(400)
    expect((await handle(req({ op: 'parse', text: 'x'.repeat(2001), products: PRODUCTS }), ENV, f)).status).toBe(400)
    const huge = new Request('https://app.example/api/ai', { method: 'POST', headers: { authorization: 'Bearer a', 'content-length': '5000000' }, body: '{}' })
    expect((await handle(huge, ENV, f)).status).toBe(413)
  })

  it('parse: Gemini output is never trusted — bad entries dropped or moved to unreadable, indexes bounded, prices never invented for counts', () => {
    const v = validDrafts(
      {
        drafts: [
          { kind: 'purchase', product_index: 7, name_seen: 'Sprite', qty: 1, qty_unit: 'pack', total_cost: 780, supplier: null },
          { kind: 'count', product_index: 0, name_seen: 'coke', qty: 5, qty_unit: 'unit', total_cost: 99, supplier: null },
          { kind: 'sale', product_index: 0, name_seen: 'mystery', qty: 1, qty_unit: 'unit', total_cost: null, supplier: null },
          { kind: 'purchase', product_index: 0, name_seen: 'neg', qty: -2, qty_unit: 'pack', total_cost: null, supplier: null },
        ],
        unreadable: ['  smudge  ', 3],
      },
      1,
    )
    expect(v).toEqual({
      drafts: [
        { kind: 'purchase', product_index: -1, name_seen: 'Sprite', qty: 1, qty_unit: 'pack', total_cost: 780, supplier: null },
        { kind: 'count', product_index: 0, name_seen: 'coke', qty: 5, qty_unit: 'unit', total_cost: null, supplier: null },
      ],
      unreadable: ['smudge', 'mystery', 'neg'],
    })
    expect(validDrafts({ drafts: 'x' }, 1)).toBeNull()
  })

  it('Gemini failures map to app codes; a non-JSON reply is "unreadable"', async () => {
    const parse = { op: 'parse', text: 'x', products: PRODUCTS }
    expect(await (await handle(req(parse), ENV, fakeFetch({ geminiStatus: 429 }).f, noSleep)).json()).toEqual({ error: 'busy', upstream: 429 })
    expect(await (await handle(req(parse), ENV, fakeFetch({ geminiStatus: 403 }).f, noSleep)).json()).toEqual({ error: 'not_configured', upstream: 403 })
    expect(await (await handle(req(parse), ENV, fakeFetch({ geminiStatus: 502 }).f, noSleep)).json()).toEqual({ error: 'upstream', upstream: 502 })
    expect(await (await handle(req(parse), ENV, fakeFetch({ gemini: { candidates: [{ content: { parts: [{ text: 'not json' }] } }] } }).f)).json()).toEqual({ error: 'unreadable' })
  })

  it('model order: receipts use the main model first, questions the light model first; busy or too slow hands over to the other; the reply says which model served it', async () => {
    const seq: Array<number | 'hang'> = []
    const urls: string[] = []
    const ok = { candidates: [{ content: { parts: [{ functionCall: { name: 'get_shopping_list', args: {} }, thoughtSignature: 'S1' }] } }] }
    const flaky = (async (url: string) => {
      if (url.includes('ai_quota_hit')) return new Response('true')
      urls.push(url)
      const st = seq.shift() ?? 200
      if (st === 'hang') throw new DOMException('The operation timed out.', 'TimeoutError') // what AbortSignal.timeout raises
      return new Response(JSON.stringify(st === 200 ? ok : {}), { status: st })
    }) as unknown as typeof fetch
    const used = () => urls.map((u) => u.split('/models/')[1]!.split(':')[0])
    const chat = { op: 'chat', history: [{ role: 'user', text: 'ano bibilhin?' }], snapshot: {}, round: 0 }

    // a question: light model first; one refusal is retried on the same model
    seq.push(503, 200)
    expect(await (await handle(req(chat), ENV, flaky, noSleep)).json()).toEqual({ kind: 'tools', calls: [{ name: 'get_shopping_list', args: {}, sig: 'S1', model: 'gemini-flash-lite-latest' }] })
    expect(used()).toEqual(['gemini-flash-lite-latest', 'gemini-flash-lite-latest'])

    // the light model refuses three times → the main model
    urls.length = 0
    seq.push(429, 429, 429, 200)
    const out = await (await handle(req(chat), ENV, flaky, noSleep)).json()
    expect(out.calls[0].model).toBe('gemini-flash-latest')
    expect(used()).toEqual(['gemini-flash-lite-latest', 'gemini-flash-lite-latest', 'gemini-flash-lite-latest', 'gemini-flash-latest'])

    // a later round of the same question can switch too (rounds carry no model-specific state)
    urls.length = 0
    seq.push(503, 503, 503, 200)
    const round1 = { ...chat, round: 1, history: [chat.history[0], { role: 'model', calls: out.calls }, { role: 'tool', results: [{ name: 'get_shopping_list', id: 'r1', result: {} }] }] }
    expect((await handle(req(round1), ENV, flaky, noSleep)).status).toBe(200)
    expect(used()).toEqual(['gemini-flash-lite-latest', 'gemini-flash-lite-latest', 'gemini-flash-lite-latest', 'gemini-flash-latest'])

    // too slow (the first live failure: no answer before the time limit) → the other model, not an error
    urls.length = 0
    seq.push('hang', 200)
    expect((await handle(req(round1), ENV, flaky, noSleep)).status).toBe(200)
    expect(used()).toEqual(['gemini-flash-lite-latest', 'gemini-flash-latest'])
    // ...but the last model timing out is reported, with 408 for diagnosis
    urls.length = 0
    seq.push('hang', 'hang')
    expect(await (await handle(req(round1), ENV, flaky, noSleep)).json()).toEqual({ error: 'upstream', upstream: 408 })

    // a receipt or note: the main model first
    urls.length = 0
    seq.push(200)
    await handle(req({ op: 'parse', text: 'bumili 1 case coke', products: PRODUCTS }), ENV, flaky, noSleep)
    expect(used()).toEqual(['gemini-flash-latest'])

    // an unknown model id (e.g. a retired alias) goes straight to the other one
    urls.length = 0
    seq.push(404, 200)
    expect((await handle(req(chat), ENV, flaky, noSleep)).status).toBe(200)
    expect(urls.length).toBe(2)
    // GEMINI_FALLBACK_MODEL=none: the main model only, for questions too
    urls.length = 0
    seq.push(429, 429, 429)
    expect((await handle(req(chat), { ...ENV, GEMINI_FALLBACK_MODEL: 'none' }, flaky, noSleep)).status).toBe(503)
    expect(used()).toEqual(['gemini-flash-latest', 'gemini-flash-latest', 'gemini-flash-latest'])
  })

  it('chat: round 3 forces `answer`; earlier lookups go back as plain text (no model-specific signatures); unknown tools are rejected', async () => {
    const answer = { candidates: [{ content: { parts: [{ functionCall: { name: 'answer', args: { text: 'Mga 8 bote pa.', figures: [{ label: 'natira', value: 8, source: 'r1.on_hand_est' }] } } }] } }] }
    const { f, seen } = fakeFetch({ gemini: answer })
    const history = [
      { role: 'user', text: 'ilan pa ang coke?' },
      { role: 'model', calls: [{ name: 'get_product', args: { name: 'coke' }, sig: 'SIG123' }] },
      { role: 'tool', results: [{ name: 'get_product', id: 'r1', result: { on_hand_est: 8 } }] },
    ]
    const res = await handle(req({ op: 'chat', history, snapshot: { store: 'x' }, round: 3, lang: 'tl' }), ENV, f)
    expect(await res.json()).toEqual({ kind: 'answer', text: 'Mga 8 bote pa.', figures: [{ label: 'natira', value: 8, source: 'r1.on_hand_est' }] })
    const body = JSON.parse(String(seen[1]!.init.body))
    expect(body.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY', allowedFunctionNames: ['answer'] })
    expect(body.contents.length).toBe(1)
    const text = body.contents[0].parts[0].text as string
    expect(text).toContain('ilan pa ang coke?')
    expect(text).toContain('r1 = get_product → {"on_hand_est":8}')
    expect(JSON.stringify(body)).not.toContain('SIG123')
    const bad = [{ role: 'model', calls: [{ name: 'delete_store', args: {} }] }]
    expect((await handle(req({ op: 'chat', history: bad, snapshot: {}, round: 0 }), ENV, f)).status).toBe(400)
    expect((await handle(req({ op: 'chat', history, snapshot: { big: 'x'.repeat(9000) }, round: 0 }), ENV, f)).status).toBe(400)
    expect((await handle(req({ op: 'chat', history, snapshot: {}, round: 4 }), ENV, f)).status).toBe(400)
  })

  it("the reply language follows the app language, with that language's own words in the rules", async () => {
    const answer = { candidates: [{ content: { parts: [{ functionCall: { name: 'answer', args: { text: 'ok', figures: [] } } }] } }] }
    const sys = async (lang: string) => {
      const { f, seen } = fakeFetch({ gemini: answer })
      await handle(req({ op: 'chat', history: [{ role: 'user', text: 'Ilan pa ang coke?' }], snapshot: {}, round: 0, lang }), ENV, f)
      return JSON.parse(String(seen[1]!.init.body)).systemInstruction.parts[0].text as string
    }
    const en = await sys('en')
    expect(en).toContain('Reply ONLY in English')
    expect(en).toContain('"not in my list"')
    expect(en).not.toMatch(/wala sa listahan|tantiya|bilangin|Bumili/)
    const tl = await sys('tl')
    expect(tl).toContain('Reply ONLY in Taglish')
    expect(tl).toContain('"wala sa listahan ko"')
  })

  it('chat replies: tool calls before round 3, plain text becomes an answer without figures', () => {
    const call = [{ functionCall: { name: 'get_shopping_list', args: {} }, thoughtSignature: 'S' }]
    expect(readChatParts(call, 0)).toEqual({ kind: 'tools', calls: [{ name: 'get_shopping_list', args: {}, sig: 'S' }] })
    expect(readChatParts([...call, { text: 'Wala.' }], 3)).toEqual({ kind: 'answer', text: 'Wala.', figures: [] })
    expect(readChatParts([{ thought: true, text: 'thinking' }], 0)).toBeNull()
  })
})

// ------------------------------------------------------------------------------------------------
// phone side
// ------------------------------------------------------------------------------------------------

describe('AI client', () => {
  const tok = async () => 'tok'
  const resp = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch
  it('maps proxy replies to app-level codes and never calls without a session', async () => {
    await expect(callAi({}, async () => null, resp(200, {}))).rejects.toEqual(new AiError('signed_out'))
    expect(await callAi({ op: 'x' }, tok, resp(200, { ok: 1 }))).toEqual({ ok: 1 })
    for (const [status, body, code] of [
      [401, { error: 'auth' }, 'auth'],
      [429, { error: 'rate_limited' }, 'rate_limited'],
      [503, { error: 'busy' }, 'busy'],
      [503, { error: 'not_configured' }, 'not_configured'],
      [404, null, 'not_configured'],
      [413, { error: 'too_large' }, 'too_large'],
      [502, { error: 'upstream' }, 'failed'],
    ] as const) {
      await expect(callAi({}, tok, resp(status, body))).rejects.toEqual(new AiError(code))
    }
    await expect(callAi({}, tok, (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch)).rejects.toEqual(new AiError('offline'))
  })
})

const P = (id: string, name: string, pack_size = 12, extra: Partial<Product> = {}): Product => ({ id, store_id: STORE_ID, name, category: 'c', unit_label: 'bote', pack_size, pack_label: 'case', sell_price: 20, archived: false, updated_at: '2026-01-01T00:00:00+08:00', ...extra })

describe('parse drafts → rows → what gets saved', () => {
  const coke = P('p1', 'Coke Mismo')
  const kopiko = P('p2', 'Kopiko', 10)
  it('matched rows start ticked, unmatched unticked; units use the current pack size; fractions are not saved', () => {
    const { rows, unreadable } = toRows(
      {
        drafts: [
          { kind: 'purchase', product_index: 0, name_seen: 'coke', qty: 2, qty_unit: 'pack', total_cost: 1560, supplier: 'Puregold' },
          { kind: 'count', product_index: 1, name_seen: 'kopiko', qty: 7, qty_unit: 'unit', total_cost: null, supplier: null },
          { kind: 'purchase', product_index: -1, name_seen: 'Royal', qty: 1, qty_unit: 'pack', total_cost: 700, supplier: null },
          { kind: 'purchase', product_index: 0, name_seen: 'coke half', qty: 0.5, qty_unit: 'unit', total_cost: null, supplier: null },
        ],
        unreadable: ['?'],
      },
      ['p1', 'p2'],
    )
    expect(rows.map((r) => [r.product_id, r.include])).toEqual([['p1', true], ['p2', true], [null, false], ['p1', true]])
    expect(unreadable).toEqual(['?'])
    const byId = new Map([coke, kopiko].map((p) => [p.id, p]))
    expect(savable(rows, byId).map((s) => [s.row.name_seen, s.units])).toEqual([['coke', 24], ['kopiko', 7]])
    expect(rowUnits({ ...rows[0]!, qty: 0 }, coke)).toBeNull() // a purchase of nothing
    expect(rowUnits({ ...rows[1]!, qty: 0 }, kopiko)).toBe(0) // a count of zero is a real count
  })
})

describe('supplier names from receipts', () => {
  const known = ['Puregold', 'Alfamart', 'Tindahan ni Mang Ben']
  it('maps a printed name onto the one the owner uses, only when it is clearly the same', () => {
    expect(matchSupplier('PUREGOLD PRICE CLUB', known)).toBe('Puregold')
    expect(matchSupplier('alfamart', known)).toBe('Alfamart')
    expect(matchSupplier('Mang Ben', known)).toBe('Tindahan ni Mang Ben')
    expect(matchSupplier('Puregolden Store', known)).toBe('Puregolden Store') // not a whole-word match
    expect(matchSupplier('SM Hypermarket', known)).toBe('SM Hypermarket')
    expect(matchSupplier('Puregold Alfamart Plaza', known)).toBe('Puregold Alfamart Plaza') // ambiguous: left as read
    expect(matchSupplier(null, known)).toBeNull()
    // a long printed name saved once does not stick: the plain name it contains wins
    expect(matchSupplier('PUREGOLD PRICE CLUB', ['PUREGOLD PRICE CLUB', 'Alfamart', 'Puregold'])).toBe('Puregold')
    expect(matchSupplier('Puregold', ['PUREGOLD PRICE CLUB', 'Puregold'])).toBe('Puregold')
    expect(matchSupplier('puregold', ['PUREGOLD', 'Puregold'])).toBe('PUREGOLD') // same name twice: the most recent spelling
  })
})

// a small store for the tools: Coke counted (Tier B), Kopiko bought only (Tier A), one customer
function context(): AssistantContext {
  const store = makeStore([3, 6], null)
  const coke = P('p1', 'Coke Mismo', 12, { sell_price: 25 })
  const kopiko = P('p2', 'Kopiko Black', 10, { sell_price: 8 })
  const ev = (id: string, ts: string, e: Record<string, unknown>) => ({ id, v: 1, store_id: STORE_ID, device_id: DEVICE_ID, recorded_at: ts, ts, ...e }) as unknown as ActiveEvent
  const raw: ActiveEvent[] = [
    ev('e01', '2026-05-13T21:00:00+08:00', { type: 'COUNT', product_id: 'p1', qty_on_hand: 30 }),
    ev('e02', '2026-05-20T21:00:00+08:00', { type: 'COUNT', product_id: 'p1', qty_on_hand: 16 }),
    ev('e03', '2026-05-21T12:00:00+08:00', { type: 'PURCHASE', product_id: 'p1', qty_units: 24, total_cost: 480, supplier: 'Puregold' }),
    ev('e04', '2026-05-27T21:00:00+08:00', { type: 'COUNT', product_id: 'p1', qty_on_hand: 26 }),
    ev('e05', '2026-05-28T15:00:00+08:00', { type: 'SALE', product_id: 'p1', qty_units: 3 }),
    ...['05-06', '05-13', '05-20', '05-27'].map((d, i) => ev(`k${i}`, `2026-${d}T12:00:00+08:00`, { type: 'PURCHASE', product_id: 'p2', qty_units: 10, total_cost: 60, supplier: i % 2 ? 'Alfamart' : 'Puregold' })),
    ev('u1', '2026-05-10T12:00:00+08:00', { type: 'UTANG', customer_id: 'c1', amount: 150 }),
    ev('x1', '2026-05-28T12:00:00+08:00', { type: 'EXPENSE', amount: 50, category: 'load' }),
  ]
  const events = activeEvents(raw)
  const nowMs = toMs('2026-05-29T10:00:00+08:00')
  const by = stockEventsByProduct(events)
  const products = [coke, kopiko]
  const states = new Map(products.map((p) => [p.id, deriveProduct(p, by.get(p.id) ?? [], nowMs)]))
  const list = buildList({ store, products, states, nowMs, lang: 'tl' })
  const customers: Customer[] = [{ id: 'c1', store_id: STORE_ID, name: 'Aling Rosa', phone: null, archived: false, updated_at: '2026-01-01T00:00:00+08:00' }]
  const cs: CustomerState = { customer_id: 'c1', balance: 150, total_utang: 150, total_bayad: 0, last_utang_ts: '2026-05-10T12:00:00+08:00', last_bayad_ts: null, oldest_unpaid_ts: '2026-05-10T12:00:00+08:00' }
  const finance: StoreState = { cash_last: null, utang_outstanding: 150, weeks: [{ start: '2026-05-25', end: '2026-05-31', gastos: 50, nabili: 60, utang_given: 0, utang_received: 0, cash_count: null, outstanding_end: 150 }], tantiya: { benta: 1234, tubo: 345, products: 1, skipped: 0 } }
  return { store, products, states, list, finance, customers, customerStates: new Map([['c1', cs]]), events, nowMs, lang: 'tl' }
}

describe('assistant tools (run on the phone)', () => {
  const c = context()
  it('get_product: Tier B gives stock numbers; Tier A gives the purchase pattern only, never stock or sales', () => {
    const coke = runTool(c, 'get_product', { name: 'coke' })
    expect(coke).toMatchObject({ found: true, name: 'Coke Mismo', on_hand_est: expect.any(Number), tallied_since_count: 3, supplier_prices: [{ supplier: 'Puregold', unit_cost: 20 }] })
    const kopiko = runTool(c, 'get_product', { name: 'kopiko' })
    expect(kopiko).toMatchObject({ found: true, on_hand_est: null, days_left: null, units_per_day: null })
    expect(kopiko.purchase_pattern).toMatchObject({ note: expect.stringContaining('not sales') })
    expect((kopiko.supplier_prices as Array<{ supplier: string }>).map((s) => s.supplier)).toEqual(['Alfamart', 'Puregold'])
    expect(runTool(c, 'get_product', { name: 'royal' })).toEqual({ found: false })
    // stock and days left are whole numbers, exactly as the screens show them
    expect(Number.isInteger(coke.on_hand_est)).toBe(true)
    expect(coke.on_hand_est).toBe(Math.round(c.states.get('p1')!.on_hand_est!))
    expect(coke.days_left === null || Number.isInteger(coke.days_left)).toBe(true)
  })
  it('list_events returns totals, never the entries; a product filter drops the money totals', () => {
    expect(runTool(c, 'list_events', { days: 7 })).toEqual({ days: 7, product: null, purchases: 1, units_bought: 10, cost_recorded: 60, counts: 1, units_tallied: 3, units_damaged: 0, utang_given: 0, payments: 0, expenses: 50 })
    expect(runTool(c, 'list_events', { days: 30, product: 'coke' })).toEqual({ days: 30, product: 'Coke Mismo', purchases: 1, units_bought: 24, cost_recorded: 480, counts: 3, units_tallied: 3, units_damaged: 0 })
    expect(runTool(c, 'list_events', { days: 'x' })).toEqual({ error: 'bad_args' })
  })
  it('get_customer is the only path to a customer name, and never lists other customers', () => {
    expect(runTool(c, 'get_customer', { name: 'rosa' })).toEqual({ found: true, name: 'Aling Rosa', balance: 150, total_utang: 150, total_paid: 0, oldest_unpaid_days: 19, last_utang: '2026-05-10', last_payment: null })
    expect(JSON.stringify(buildSnapshot(c))).not.toContain('Rosa')
    expect(JSON.stringify(runTool(c, 'get_shopping_list', {}))).not.toContain('Rosa')
  })
  it('unknown tools and bad args are errors; every result fits in 4 KB', () => {
    expect(runTool(c, 'delete_everything', {})).toEqual({ error: 'bad_args' })
    expect(runTool(c, 'get_week_summary', { weeks_ago: 9 })).toEqual({ error: 'bad_args' })
    expect(runTool(c, 'get_week_summary', { weeks_ago: 0 })).toMatchObject({ expenses: 50, estimate_weekly_sales: 1230, estimate_weekly_profit: 350 })
    const many = { ...c, products: Array.from({ length: 300 }, (_, i) => P(`q${i}`, `Produkto bilang ${i} na may mahabang pangalan`)) }
    const big = { ...many, list: { ...c.list, lines: many.products.map((p) => ({ ...c.list.lines[0]!, product_id: p.id })) } }
    expect(JSON.stringify(runTool(big, 'get_shopping_list', {})).length).toBeLessThanOrEqual(MAX_RESULT_BYTES)
    expect(JSON.stringify(buildSnapshot(big)).length).toBeLessThanOrEqual(8192)
  })
  it('name matching: exact, contains, all words; ambiguity returns candidates', () => {
    const items = [{ name: 'Coke Mismo' }, { name: 'Coke 1.5L' }, { name: 'Lucky Me Pancit Canton' }]
    expect(findByName(items, 'coke mismo')).toEqual({ one: items[0] })
    expect(findByName(items, 'coke')).toEqual({ many: [items[0], items[1]] })
    expect(findByName(items, 'pancit lucky')).toEqual({ one: items[2] })
    expect(findByName(items, '')).toBeNull()
  })
})

describe('chat loop', () => {
  const c = context()
  it('runs the requested tools on the phone, then verifies each figure against its source', async () => {
    const bodies: Array<{ round: number; history: unknown[] }> = []
    const call: ChatCall = async (body) => {
      bodies.push({ round: body.round, history: JSON.parse(JSON.stringify(body.history)) })
      if (body.round === 0) return { kind: 'tools', calls: [{ name: 'get_product', args: { name: 'coke' }, sig: 'S0' }] }
      const r1 = (body.history[2] as { results: Array<{ result: { on_hand_est: number } }> }).results[0]!.result
      return { kind: 'answer', text: `May ${r1.on_hand_est} bote pa. Kita mo ₱999.50.`, figures: [{ label: 'natira', value: r1.on_hand_est, source: 'r1.on_hand_est' }, { label: 'gawa-gawa', value: 999.5, source: 'r1.nothing' }] }
    }
    const a = await ask('ilan pa ang coke?', c, call)
    expect(bodies.map((b) => b.round)).toEqual([0, 1])
    expect((bodies[1]!.history[1] as { calls: Array<{ sig: string }> }).calls[0]!.sig).toBe('S0')
    expect(a.figures.map((f) => [f.label, f.verified])).toEqual([['natira', true], ['gawa-gawa', false]])
    expect(a.unverifiedInText).toBe(true) // ₱999.50 matches no verified figure
    expect(a.looked).toEqual(['get_product'])
  })
  it("a product name or the owner's own number in the answer is not flagged as unverified", async () => {
    const c2 = { ...c, products: [...c.products, P('p9', 'Coca-Cola 1.5L')] }
    const call: ChatCall = async () => ({ kind: 'answer', text: 'Ang Coca-Cola 1.5L: bilangin mo muna. Tungkol sa 2.5 case na tanong mo, wala sa listahan ko.', figures: [] })
    const a = await ask('may 2.5 case pa ba ng Coca-Cola 1.5L?', c2, call)
    expect(a.unverifiedInText).toBe(false)
    const b = await ask('Coca-Cola 1.5L?', c2, async () => ({ kind: 'answer', text: 'Mga 7.5 bote pa ang Coca-Cola 1.5L.', figures: [] }))
    expect(b.unverifiedInText).toBe(true) // 7.5 came from nowhere
  })

  it('gives up after round 3 instead of looping', async () => {
    let n = 0
    const call: ChatCall = async () => {
      n++
      return { kind: 'tools', calls: [{ name: 'get_shopping_list', args: {} }] }
    }
    await expect(ask('?', c, call)).rejects.toThrow('no answer')
    expect(n).toBe(4)
  })
  it('figure checks: snapshot sources, rounding tolerance, and money in the text', () => {
    const snap = { list: { total_known_cost: 2343.6 } }
    expect(checkFigures([{ label: 't', value: 2340, source: 'snapshot.list.total_known_cost' }], {}, snap)[0]!.verified).toBe(true)
    expect(checkFigures([{ label: 't', value: 2600, source: 'snapshot.list.total_known_cost' }], {}, snap)[0]!.verified).toBe(false)
    expect(numbersInText('Dalhin ₱2,340 at 1.5 araw; 3 case')).toEqual([2340, 1.5])
    // numbers inside product names are not figures (first live test: "Coca-Cola 1.5L" raised a false alarm)
    expect(numbersInText('Ang Coca-Cola 1.5L ay may 20 bote; coca-cola 1.5l ulit.', ['Coca-Cola 1.5L'])).toEqual([])
    expect(numbersInText('Coke ₱12.50', ['Coke'])).toEqual([12.5])
  })
})
