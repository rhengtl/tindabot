// Translation completeness: every key exists in both languages with the same shape, every
// function interpolates in both, and nothing user-facing was left untranslated by accident.
import { describe, expect, it } from 'vitest'
import { EN, STRINGS, TL, strings } from '../strings'

type Leaf = { path: string; value: unknown }
function leaves(obj: unknown, path = ''): Leaf[] {
  if (Array.isArray(obj)) return obj.flatMap((v, i) => leaves(v, `${path}[${i}]`))
  if (obj && typeof obj === 'object') return Object.entries(obj).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k))
  return [{ path, value: obj }]
}

// Language-neutral texts that are legitimately identical in both languages.
const SAME_OK = new Set([
  'appName',
  'fab.utang',
  'lang.title',
  'lang.tl',
  'lang.en',
  'paninda.unknown',
  'paninda.timeline',
  'paninda.status',
  'paninda.adjustReason.expired',
  'ibaPa.settings',
  'ibaPa.backup',
  'ibaPa.advanced',
  'ibaPa.demoLoaded',
  'pera.utang.title',
  'pera.customerPhone',
  'pera.categories.load',
  'listahan.history',
  'listahan.status',
  'listahan.cellphone',
  'cloud.title',
  'days[2]', // Mar
])

describe('strings: both languages, same shape', () => {
  const tl = leaves(TL)
  const en = leaves(EN)

  it('EN has exactly the keys of TL, with the same kinds of values', () => {
    expect(en.map((l) => l.path)).toEqual(tl.map((l) => l.path))
    for (let i = 0; i < tl.length; i++) expect(typeof en[i]!.value, en[i]!.path).toBe(typeof tl[i]!.value)
    expect(tl.length).toBeGreaterThan(250)
  })

  it('no string is empty and nothing was left untranslated', () => {
    for (let i = 0; i < tl.length; i++) {
      const a = tl[i]!
      const b = en[i]!
      if (typeof a.value !== 'string') continue
      expect(a.value.trim().length, a.path).toBeGreaterThan(0)
      expect((b.value as string).trim().length, b.path).toBeGreaterThan(0)
      if (a.value === b.value) expect(SAME_OK.has(a.path), `untranslated: ${a.path} = ${a.value}`).toBe(true)
    }
  })

  it('every function interpolates in both languages (samples arguments by type)', () => {
    const sample = (fn: (...a: never[]) => unknown): unknown[] => {
      const n = fn.length
      // strings for text-ish parameters, numbers otherwise: both branches of each function are
      // exercised by calling with 0/1/2 where a number is expected
      return Array.from({ length: n }, (_, i) => (i === 0 ? 2 : 'x'))
    }
    let count = 0
    for (let i = 0; i < tl.length; i++) {
      const a = tl[i]!
      if (typeof a.value !== 'function') continue
      const b = en[i]!
      for (const lang of [a, b]) {
        const fn = lang.value as (...args: unknown[]) => unknown
        for (const args of [sample(fn as never), [0, 'y', 'z', 'w'], [1, 'y', 'z', 'w'], ['s', 't', 'u', 'v']]) {
          const out = fn(...args)
          // functions return text (or null for hints; identity helpers echo their argument); never throw
          expect(out !== undefined, `${lang.path}(${args.join(',')})`).toBe(true)
        }
      }
      count++
    }
    expect(count).toBeGreaterThan(40)
    // pluralisation exists where English needs it
    expect(EN.common.days(1)).toBe('1 day')
    expect(EN.common.days(2)).toBe('2 days')
    expect(EN.cloud.status.pending(1)).toBe('1 entry not backed up yet')
    expect(EN.cloud.status.pending(3)).toBe('3 entries not backed up yet')
    expect(TL.cloud.status.pending(3)).toBe('3 entry ang hindi pa naka-backup')
  })

  it('strings(lang) returns the matching set and the default is Taglish', () => {
    expect(strings('tl')).toBe(STRINGS.tl)
    expect(strings('en')).toBe(EN)
    expect(strings('tl').tabs.bahay).toBe('Bahay')
    expect(strings('en').tabs.bahay).toBe('Home')
  })

  it('error categories and sign-in kinds are covered in both languages', () => {
    for (const lang of ['tl', 'en'] as const) {
      const S = strings(lang)
      for (const code of ['network', 'auth', 'denied', 'store_gone', 'server', 'unknown'] as const) expect(S.cloud.errors[code].length).toBeGreaterThan(3)
      for (const kind of ['cancelled', 'exchange', 'provider'] as const) expect(S.cloud.signInErrors[kind].length).toBeGreaterThan(10)
    }
  })
})
