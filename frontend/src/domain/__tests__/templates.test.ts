// Generated wording in both languages: reasons, hints, Bakit footers, dates, day/month names,
// plurals. Numbers and decisions are language-independent — only the words change.
import { describe, expect, it } from 'vitest'
import { activeEvents, deriveProduct, forProduct } from '..'
import { buildList } from '../list'
import * as T from '../templates'
import type { Lang } from '../types'
import { toMs } from '../calendar'
import { makeProduct, makeStore, scenarios, toEvents } from './helpers'

const LANGS: Lang[] = ['tl', 'en']
const TODAY = '2026-09-17' // Thursday

describe('dates and relative days', () => {
  it('day and month names follow the language', () => {
    expect(T.dayName(TODAY, 'tl')).toBe('Huw')
    expect(T.dayName(TODAY, 'en')).toBe('Thu')
    expect(T.dayName(TODAY, 'tl', true)).toBe('Huwebes')
    expect(T.dayName(TODAY, 'en', true)).toBe('Thursday')
    expect(T.monthName(9, 'tl')).toBe('Set')
    expect(T.monthName(9, 'en')).toBe('Sep')
    expect(T.fmtDate('2026-05-30', 'tl')).toBe('Sab, May 30')
    expect(T.fmtDate('2026-05-30', 'en')).toBe('Sat, May 30')
  })

  it('relative labels: today/tomorrow/yesterday, weekday within 6 days, date beyond', () => {
    expect(T.fmtRelative(TODAY, TODAY, 'tl')).toBe('ngayon')
    expect(T.fmtRelative(TODAY, TODAY, 'en')).toBe('today')
    expect(T.fmtRelative('2026-09-18', TODAY, 'tl')).toBe('bukas')
    expect(T.fmtRelative('2026-09-18', TODAY, 'en')).toBe('tomorrow')
    expect(T.fmtRelative('2026-09-16', TODAY, 'tl')).toBe('kahapon')
    expect(T.fmtRelative('2026-09-16', TODAY, 'en')).toBe('yesterday')
    expect(T.fmtRelative('2026-09-19', TODAY, 'tl')).toBe('Sabado')
    expect(T.fmtRelative('2026-09-19', TODAY, 'en')).toBe('Saturday')
    expect(T.fmtRelative('2026-09-30', TODAY, 'tl')).toBe('Miy, Set 30')
    expect(T.fmtRelative('2026-09-30', TODAY, 'en')).toBe('Wed, Sep 30')
  })

  it('English pluralises day counts; Taglish does not need to', () => {
    expect(T.days(1, 'en')).toBe('1 day')
    expect(T.days(3, 'en')).toBe('3 days')
    expect(T.days(1, 'tl')).toBe('1 araw')
    expect(T.days(3, 'tl')).toBe('3 araw')
    expect(T.banner(1, '2026-09-19', TODAY, 'en')).toMatch(/^1 item will run out/)
    expect(T.banner(2, '2026-09-19', TODAY, 'en')).toMatch(/^2 items will run out/)
    expect(T.banner(2, '2026-09-19', TODAY, 'tl')).toBe('2 item ang mauubos bago ang biyahe (Sabado) — bumili ka na bukas?')
  })

  it('money and quantities are language-neutral', () => {
    expect(T.peso(1234)).toBe('₱1,234')
    expect(T.pesoExact(10.5)).toBe('₱10.50')
    expect(T.pesoEstimate(123)).toBe('~₱120')
  })
})

describe('Tier B reasons', () => {
  const base: T.TierBReasonInput = {
    urgency: 'orange',
    before_trip: false,
    next_trip: '2026-09-19',
    today: TODAY,
    days_left: 4,
    days_since_count: 2,
    needs_count: false,
    payday_in_horizon: false,
    deferred: false,
    slow: false,
    inconsistent: false,
  }
  it('every branch has wording in both languages, and the languages differ', () => {
    const variants: Array<Partial<T.TierBReasonInput>> = [
      {},
      { inconsistent: true },
      { needs_count: true, days_since_count: 9 },
      { deferred: true },
      { urgency: 'red' },
      { urgency: 'red', before_trip: true },
      { urgency: 'orange', slow: true },
      { urgency: 'orange', payday_in_horizon: true },
      { urgency: 'yellow' },
    ]
    for (const v of variants) {
      const tl = T.tierBReason({ ...base, ...v }, 'tl')
      const en = T.tierBReason({ ...base, ...v }, 'en')
      expect(tl.length).toBeGreaterThan(10)
      expect(en.length).toBeGreaterThan(10)
      expect(en).not.toBe(tl)
    }
    expect(T.tierBReason({ ...base, needs_count: true, days_since_count: 9 }, 'en')).toBe('Count first — not counted for 9 days. This is only an estimate.')
    expect(T.tierBReason({ ...base, needs_count: true, days_since_count: 9 }, 'tl')).toBe('Bilangin muna — 9 araw nang hindi nabibilang. Tantiya lang ito.')
    expect(T.tierBReason({ ...base, urgency: 'red', before_trip: true }, 'en')).toBe('Will run out before the trip (Saturday) — buy earlier.')
  })
})

describe('Tier A reasons and hints (pattern language only, both languages)', () => {
  const base: T.TierAReasonInput = {
    today: TODAY,
    next_trip: '2026-09-19',
    rebuy_early: '2026-09-20',
    rebuy_mid: '2026-09-21',
    rebuy_late: '2026-09-22',
    window_wide: false,
    typical_label: '1 case',
    cycle_days: 6.4,
    no_schedule: false,
    weekly_hint_label: '2 case',
    payday_in_horizon: true,
    cap_reached: false,
  }
  it('reason: same structure, translated; never claims stock', () => {
    const tl = T.tierAReason(base, 'tl')
    const en = T.tierAReason(base, 'en')
    expect(tl).toBe('Naubos mo ang 1 case sa ~6 araw. Karaniwan kang bumibili ulit mga Lin, Set 20–Mar, Set 22. Baka kailangan mo na sa biyahe (Sabado). Tantiya — hindi ko alam ang natira.')
    expect(en).toBe("You went through 1 case in ~6 days. You usually buy again around Sun, Sep 20–Tue, Sep 22. You may need it for the trip (Saturday). Estimate — I don't know what's left.")
    for (const v of [{ window_wide: true }, { rebuy_early: '2026-09-21', rebuy_late: '2026-09-21' }, { rebuy_mid: '2026-09-10' }, { no_schedule: true }]) {
      for (const lang of LANGS) {
        const r = T.tierAReason({ ...base, ...v }, lang)
        expect(r).not.toMatch(/nabebenta|natira ay|mauubos|sells|left:|days left/i)
        expect(r).toMatch(lang === 'tl' ? /hindi ko alam ang natira/ : /I don't know what's left/)
      }
    }
  })
  it('hint: weekly hint and payday in both languages; null when nothing to say', () => {
    expect(T.tierAHint({ ...base, no_schedule: true }, 'en')).toBe('To last 1 week: 2 case. Payday — more people may buy.')
    expect(T.tierAHint({ ...base, no_schedule: true }, 'tl')).toBe('Para umabot ng 1 linggo: 2 case. Katapusan/kinsenas — baka mas marami ang bibili.')
    expect(T.tierAHint({ ...base, cap_reached: true }, 'en')).toBe('Payday — it may run short; your call.')
    expect(T.tierAHint({ ...base, payday_in_horizon: false }, 'tl')).toBeNull()
    expect(T.tierAHint({ ...base, payday_in_horizon: false }, 'en')).toBeNull()
  })
  it('Bakit footers exist in both languages', () => {
    for (const f of [T.bakitTierA, T.bakitTierBStale]) {
      expect(f('tl')).not.toBe(f('en'))
      expect(f('en')).toMatch(/estimate/i)
    }
  })
})

describe('buildList: language changes wording only', () => {
  it('the same scenario gives identical quantities/sections in both languages and different reasons', () => {
    let checked = 0
    for (const s of scenarios) {
      const store = makeStore(s.store.restock_days, s.store.next_trip_override)
      const product = makeProduct(s.product)
      const events = toEvents(s.events)
      const nowMs = toMs(s.now)
      const state = deriveProduct(product, forProduct(activeEvents(events), product.id), nowMs)
      const states = new Map([[product.id, state]])
      const tl = buildList({ store, products: [product], states, nowMs, lang: 'tl' })
      const en = buildList({ store, products: [product], states, nowMs, lang: 'en' })
      const strip = (l: ReturnType<typeof buildList>) => ({ ...l, banner: null, lines: l.lines.map(({ reason, hint, ...rest }) => rest) })
      expect(strip(en)).toEqual(strip(tl))
      for (let i = 0; i < tl.lines.length; i++) {
        expect(en.lines[i]!.reason).not.toBe(tl.lines[i]!.reason)
        checked++
      }
      if (tl.banner) expect(en.banner).not.toBe(tl.banner)
    }
    expect(checked).toBeGreaterThan(10)
  })
})
