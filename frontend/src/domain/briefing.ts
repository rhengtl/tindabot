// Briefing card — P4 (BLUEPRINT §F "Briefing: templated, deterministic, offline"). Built only from
// numbers the domain already derived (the list, the finance state, product flags); no AI, no
// network, no new math. Every sentence restates something another screen shows, so each number
// stays explainable (principle 3). Customer names appear here because this text never leaves the
// phone; it is not part of the assistant's snapshot.

import { diffDays, toLocalDate } from './calendar'
import { fmtRelative, pesoEstimate, pesoExact } from './templates'
import type { CustomerState, Lang, Product, ProductState, ShoppingList, StoreState } from './types'

export interface BriefingInput {
  nowMs: number
  lang: Lang
  products: Product[]
  states: Map<string, ProductState>
  list: ShoppingList
  finance: StoreState | null
  customers: Array<{ id: string; name: string }>
  customerStates: Map<string, CustomerState>
}

const MAX_NAMES = 3

function names(xs: string[], lang: Lang): string {
  const shown = xs.slice(0, MAX_NAMES).join(', ')
  const more = xs.length - MAX_NAMES
  return more > 0 ? `${shown} ${lang === 'tl' ? `at ${more} pa` : `and ${more} more`}` : shown
}

export function briefing(i: BriefingInput): string[] {
  const { lang, list } = i
  const tl = lang === 'tl'
  const today = toLocalDate(i.nowMs)
  const active = i.products.filter((p) => !p.archived)
  if (active.length === 0) return [tl ? 'Magdagdag ng paninda para makapagsimula ang listahan.' : 'Add products to start the list.']
  const byId = new Map(i.products.map((p) => [p.id, p]))
  const out: string[] = []

  // 1. the trip
  const buy = list.lines.filter((l) => l.section !== 'wag_muna')
  const urgent = buy.filter((l) => l.section === 'bilhin_na').length
  const trip = fmtRelative(list.next_trip, today, lang)
  if (buy.length === 0) out.push(tl ? `Biyahe ${trip}: wala pang kailangang bilhin.` : `Trip ${trip}: nothing to buy yet.`)
  else {
    let s = tl
      ? `Biyahe ${trip}: ${buy.length} bibilhin${urgent > 0 ? ` (${urgent} bilhin na)` : ''}, dalhin ${pesoEstimate(list.total_known_cost)}.`
      : `Trip ${trip}: ${buy.length} to buy${urgent > 0 ? ` (${urgent} urgent)` : ''}, bring ${pesoEstimate(list.total_known_cost)}.`
    if (list.unknown_cost_count > 0) s += tl ? ` ${list.unknown_cost_count} ang walang presyo.` : ` ${list.unknown_cost_count} without a price.`
    out.push(s)
  }

  // 2. what may run out before the trip (the list's banner, with names)
  const before = list.lines.filter((l) => l.before_trip).map((l) => byId.get(l.product_id)?.name).filter((n): n is string => !!n)
  if (before.length > 0 && list.next_trip !== today) {
    out.push(tl ? `Baka maubos bago ang biyahe: ${names(before, lang)}.` : `May run out before the trip: ${names(before, lang)}.`)
  }

  // 3. utang
  if (i.finance && i.finance.utang_outstanding > 0) {
    const owing = i.customers
      .map((c) => ({ c, st: i.customerStates.get(c.id) }))
      .filter((x): x is { c: { id: string; name: string }; st: CustomerState } => !!x.st && x.st.balance > 0)
    let oldest: { name: string; days: number } | null = null
    for (const { c, st } of owing) {
      if (!st.oldest_unpaid_ts) continue
      const d = diffDays(toLocalDate(Date.parse(st.oldest_unpaid_ts)), today)
      if (!oldest || d > oldest.days) oldest = { name: c.name, days: d }
    }
    const total = pesoExact(i.finance.utang_outstanding)
    let s = tl ? `Utang na hindi pa bayad: ${total} (${owing.length} tao).` : `Unpaid utang: ${total} (${owing.length} ${owing.length === 1 ? 'person' : 'people'}).`
    if (oldest && oldest.days >= 7) s += tl ? ` Pinakamatagal: ${oldest.name}, ${oldest.days} araw.` : ` Oldest: ${oldest.name}, ${oldest.days} days.`
    out.push(s)
  }

  // 4. last cash count
  const cash = i.finance?.cash_last
  if (cash) {
    const when = fmtRelative(toLocalDate(Date.parse(cash.ts)), today, lang)
    out.push(tl ? `Huling bilang ng pera: ${pesoExact(cash.amount)} (${when}).` : `Last cash count: ${pesoExact(cash.amount)} (${when}).`)
  }

  // 5. counts that would make the list more accurate
  const stale = active.filter((p) => i.states.get(p.id)?.flags.has('needs_count')).length
  if (stale > 0) out.push(tl ? `${stale} paninda ang matagal nang hindi nabibilang — bilangin para tumpak.` : `${stale} products have not been counted in a while — count them for accuracy.`)

  return out
}
