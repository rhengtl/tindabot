// Wording — BLUEPRINT §E2/E4 display rules. One reason per (tier, urgency, flags).
// Tier A wording is pattern language only: it never says "nabebenta"/"sells", never claims
// on-hand, a stockout date, days left, or surplus.
//
// Every function that produces text takes the language explicitly (`lang`): the domain layer
// knows nothing about the UI or where the preference is stored. `tl` is the original Taglish
// wording (the source of truth); `en` mirrors it sentence by sentence. Numbers, pesos and
// quantities are language-neutral.

import { diffDays, parseLocalDate, weekday } from './calendar'
import type { Lang, LocalDate } from './types'

const DAYS_SHORT: Record<Lang, string[]> = {
  tl: ['Lin', 'Lun', 'Mar', 'Miy', 'Huw', 'Biy', 'Sab'],
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
}
const DAYS_LONG: Record<Lang, string[]> = {
  tl: ['Linggo', 'Lunes', 'Martes', 'Miyerkules', 'Huwebes', 'Biyernes', 'Sabado'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
}
const MONTHS: Record<Lang, string[]> = {
  tl: ['Ene', 'Peb', 'Mar', 'Abr', 'May', 'Hun', 'Hul', 'Ago', 'Set', 'Okt', 'Nob', 'Dis'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
}

export function dayName(date: LocalDate, lang: Lang, long = false): string {
  return (long ? DAYS_LONG : DAYS_SHORT)[lang][weekday(date)]!
}

export function monthName(month1: number, lang: Lang): string {
  return MONTHS[lang][month1 - 1]!
}

/** "Sab, May 30" / "Sat, May 30" */
export function fmtDate(date: LocalDate, lang: Lang): string {
  const { m, d } = parseLocalDate(date)
  return `${dayName(date, lang)}, ${monthName(m, lang)} ${d}`
}

/** Relative day label: "ngayon"/"today", "bukas"/"tomorrow", a weekday, or a date when > 6 days away. */
export function fmtRelative(date: LocalDate, today: LocalDate, lang: Lang): string {
  const n = diffDays(today, date)
  if (n === 0) return lang === 'tl' ? 'ngayon' : 'today'
  if (n === 1) return lang === 'tl' ? 'bukas' : 'tomorrow'
  if (n === -1) return lang === 'tl' ? 'kahapon' : 'yesterday'
  if (n > 1 && n <= 6) return dayName(date, lang, true)
  return fmtDate(date, lang)
}

/** "3 araw" / "3 days" — the unit word after a day count. */
export function days(n: number, lang: Lang): string {
  return lang === 'tl' ? `${n} araw` : `${n} ${n === 1 ? 'day' : 'days'}`
}

export function peso(v: number): string {
  return '₱' + v.toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

/** Recorded money (P2): exact pesos, centavos shown only when present. */
export function pesoExact(v: number): string {
  const cents = Math.round(Math.abs(v) * 100) % 100 !== 0
  return '₱' + v.toLocaleString('en-PH', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 })
}

/** Estimates are rounded to ₱10 and prefixed with "~". */
export function pesoEstimate(v: number): string {
  return '~' + peso(Math.round(v / 10) * 10)
}

// ---------- Tier B reasons ----------

export interface TierBReasonInput {
  urgency: 'red' | 'orange' | 'yellow'
  before_trip: boolean
  next_trip: LocalDate
  today: LocalDate
  days_left: number | null
  days_since_count: number
  needs_count: boolean
  payday_in_horizon: boolean
  deferred: boolean
  slow: boolean
  inconsistent: boolean
}

export function tierBReason(i: TierBReasonInput, lang: Lang): string {
  const tl = lang === 'tl'
  if (i.inconsistent) {
    return tl
      ? 'Mas marami ang nabilang kaysa inaasahan — may hindi na-record na bili? Idagdag sa Bumili. Tantiya lang ito.'
      : 'More was counted than expected — a purchase not recorded? Add it under Bumili. This is only an estimate.'
  }
  if (i.needs_count) {
    const d = Math.floor(i.days_since_count)
    return tl ? `Bilangin muna — ${d} araw nang hindi nabibilang. Tantiya lang ito.` : `Count first — not counted for ${days(d, lang)}. This is only an estimate.`
  }
  if (i.deferred) return tl ? 'Sapat pa hanggang sa susunod na biyahe — sa susunod na.' : 'Enough until the next trip — next time.'
  const trip = fmtRelative(i.next_trip, i.today, lang)
  if (i.urgency === 'red') {
    if (i.before_trip && i.next_trip !== i.today) {
      return tl ? `Mauubos bago ang biyahe (${trip}) — bumili ka na nang mas maaga.` : `Will run out before the trip (${trip}) — buy earlier.`
    }
    return tl ? 'Mauubos na ngayon o bukas — isama sa bilihin!' : 'Running out today or tomorrow — put it on the list!'
  }
  if (i.urgency === 'orange') {
    if (i.slow) return tl ? 'Ubos na, pero mabagal naman — ikaw ang bahala.' : 'Out, but it sells slowly — your call.'
    return i.payday_in_horizon
      ? tl
        ? 'Kailangan sa biyahe — katapusan/kinsenas pa, mas mabenta.'
        : 'Needed for the trip — and it is payday, so it sells faster.'
      : tl
        ? `Kailangan sa biyahe (${trip}).`
        : `Needed for the trip (${trip}).`
  }
  return tl ? 'Pwede na ring bilhin — pang-reserba.' : 'Can be bought too — as a reserve.'
}

// ---------- Tier A reasons (pattern language only) ----------

export interface TierAReasonInput {
  today: LocalDate
  next_trip: LocalDate
  rebuy_early: LocalDate
  rebuy_mid: LocalDate
  rebuy_late: LocalDate
  window_wide: boolean
  typical_label: string // e.g. "1 case"
  cycle_days: number // typical_units / throughput
  no_schedule: boolean
  weekly_hint_label: string | null // e.g. "2 case"
  payday_in_horizon: boolean
  cap_reached: boolean
}

export function tierAReason(i: TierAReasonInput, lang: Lang): string {
  const tl = lang === 'tl'
  const cycle = Math.round(i.cycle_days)
  const habit = tl ? `Naubos mo ang ${i.typical_label} sa ~${cycle} araw.` : `You went through ${i.typical_label} in ~${days(cycle, lang)}.`
  let when: string
  if (i.window_wide) {
    when = tl ? 'Hindi pa regular ang bili mo.' : 'Your buying is not regular yet.'
  } else if (diffDays(i.today, i.rebuy_mid) < 0) {
    when = tl
      ? `Lampas na sa karaniwang bili mo (mga ${fmtDate(i.rebuy_mid, lang)}). Kung may natira pa, ok lang.`
      : `Past your usual re-buy (around ${fmtDate(i.rebuy_mid, lang)}). If some is left, that is fine.`
  } else if (i.rebuy_early === i.rebuy_late) {
    when = tl ? `Karaniwan kang bumibili ulit ${fmtRelative(i.rebuy_mid, i.today, lang)}.` : `You usually buy again ${fmtRelative(i.rebuy_mid, i.today, lang)}.`
  } else {
    when = tl
      ? `Karaniwan kang bumibili ulit mga ${fmtDate(i.rebuy_early, lang)}–${fmtDate(i.rebuy_late, lang)}.`
      : `You usually buy again around ${fmtDate(i.rebuy_early, lang)}–${fmtDate(i.rebuy_late, lang)}.`
  }
  const tail = i.no_schedule
    ? ''
    : tl
      ? ` Baka kailangan mo na sa biyahe (${fmtRelative(i.next_trip, i.today, lang)}).`
      : ` You may need it for the trip (${fmtRelative(i.next_trip, i.today, lang)}).`
  const limit = tl ? 'Tantiya — hindi ko alam ang natira.' : "Estimate — I don't know what's left."
  return `${habit} ${when}${tail} ${limit}`
}

export function tierAHint(i: TierAReasonInput, lang: Lang): string | null {
  const tl = lang === 'tl'
  const parts: string[] = []
  if (i.no_schedule && i.weekly_hint_label) parts.push(tl ? `Para umabot ng 1 linggo: ${i.weekly_hint_label}.` : `To last 1 week: ${i.weekly_hint_label}.`)
  if (i.payday_in_horizon) {
    parts.push(
      i.cap_reached
        ? tl
          ? 'Katapusan/kinsenas — baka kulangin; ikaw ang bahala.'
          : 'Payday — it may run short; your call.'
        : tl
          ? 'Katapusan/kinsenas — baka mas marami ang bibili.'
          : 'Payday — more people may buy.',
    )
  }
  return parts.length ? parts.join(' ') : null
}

/** Bakit sheet text for Tier A — keeps the accepted limitations visible. */
export function bakitTierA(lang: Lang): string {
  return lang === 'tl'
    ? 'Base lang ito sa dalas ng pagbili mo, hindi sa aktwal na benta. Hindi ko alam ang natira — bilangin mo para mas tumpak. ' +
        'Kung madalas kang maubusan bago bumili, o may binibili ka sa iba na hindi nailista, hindi iyon makikita rito.'
    : "This is based only on how often you buy, not on actual sales. I don't know what's left — count it for a better estimate. " +
        'If you often run out before buying, or buy elsewhere without listing it, that will not show here.'
}

export function bakitTierBStale(lang: Lang): string {
  return lang === 'tl'
    ? 'Tantiya ang natira base sa huling bilang at sa bilis ng pagkaubos. Kapag matagal nang hindi nabibilang, lumalayo ang tantiya.'
    : 'What is left is an estimate from the last count and how fast it goes. The longer it is not counted, the further off the estimate gets.'
}

export function banner(count: number, trip: LocalDate, today: LocalDate, lang: Lang): string {
  const when = fmtRelative(trip, today, lang)
  return lang === 'tl'
    ? `${count} item ang mauubos bago ang biyahe (${when}) — bumili ka na bukas?`
    : `${count} ${count === 1 ? 'item' : 'items'} will run out before the trip (${when}) — buy tomorrow?`
}
