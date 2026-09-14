// Taglish wording — BLUEPRINT §E2/E4 display rules. One reason per (tier, urgency, flags).
// Tier A wording is pattern language only: it never says "nabebenta", never claims on-hand,
// a stockout date, days left, or surplus.

import { diffDays, parseLocalDate, weekday } from './calendar'
import type { LocalDate } from './types'

const DAYS_SHORT = ['Lin', 'Lun', 'Mar', 'Miy', 'Huw', 'Biy', 'Sab']
const DAYS_LONG = ['Linggo', 'Lunes', 'Martes', 'Miyerkules', 'Huwebes', 'Biyernes', 'Sabado']
const MONTHS = ['Ene', 'Peb', 'Mar', 'Abr', 'May', 'Hun', 'Hul', 'Ago', 'Set', 'Okt', 'Nob', 'Dis']

export function dayName(date: LocalDate, long = false): string {
  return (long ? DAYS_LONG : DAYS_SHORT)[weekday(date)]!
}

/** "Sab, May 30" */
export function fmtDate(date: LocalDate): string {
  const { m, d } = parseLocalDate(date)
  return `${dayName(date)}, ${MONTHS[m - 1]} ${d}`
}

/** Relative day label: "ngayon", "bukas", "Sabado", or a date when > 6 days away. */
export function fmtRelative(date: LocalDate, today: LocalDate): string {
  const n = diffDays(today, date)
  if (n === 0) return 'ngayon'
  if (n === 1) return 'bukas'
  if (n === -1) return 'kahapon'
  if (n > 1 && n <= 6) return dayName(date, true)
  return fmtDate(date)
}

export function peso(v: number): string {
  return '₱' + v.toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

/** Estimates are rounded to ₱10 and prefixed with "~". */
export function pesoEstimate(v: number): string {
  return '~' + peso(Math.round(v / 10) * 10)
}

export function fmtQty(units: number, unitLabel: string): string {
  const n = Math.round(units)
  return `${n} ${unitLabel}`
}

export function fmtPacks(packs: number, packLabel: string, packSize: number, unitLabel: string): string {
  if (packSize === 1) return `${packs} ${unitLabel}`
  return `${packs} ${packLabel} (${packs * packSize} ${unitLabel})`
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
}

export function tierBReason(i: TierBReasonInput): string {
  if (i.needs_count) {
    return `Bilangin muna — ${Math.floor(i.days_since_count)} araw nang hindi nabibilang. Tantiya lang ito.`
  }
  if (i.deferred) return 'Sapat pa hanggang sa susunod na biyahe — sa susunod na.'
  const trip = fmtRelative(i.next_trip, i.today)
  if (i.urgency === 'red') {
    if (i.before_trip && i.next_trip !== i.today) return `Mauubos bago ang biyahe (${trip}) — bumili ka na nang mas maaga.`
    return 'Mauubos na ngayon o bukas — isama sa bilihin!'
  }
  if (i.urgency === 'orange') {
    if (i.slow) return 'Ubos na, pero mabagal naman — ikaw ang bahala.'
    return i.payday_in_horizon ? 'Kailangan sa biyahe — katapusan/kinsenas pa, mas mabenta.' : `Kailangan sa biyahe (${trip}).`
  }
  return 'Pwede na ring bilhin — pang-reserba.'
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

export function tierAReason(i: TierAReasonInput): string {
  const cycle = Math.round(i.cycle_days)
  const habit = `Naubos mo ang ${i.typical_label} sa ~${cycle} araw.`
  let when: string
  if (i.window_wide) {
    when = 'Hindi pa regular ang bili mo.'
  } else if (diffDays(i.today, i.rebuy_mid) < 0) {
    when = `Lampas na sa karaniwang bili mo (mga ${fmtDate(i.rebuy_mid)}). Kung may natira pa, ok lang.`
  } else if (i.rebuy_early === i.rebuy_late) {
    when = `Karaniwan kang bumibili ulit ${fmtRelative(i.rebuy_mid, i.today)}.`
  } else {
    when = `Karaniwan kang bumibili ulit mga ${fmtDate(i.rebuy_early)}–${fmtDate(i.rebuy_late)}.`
  }
  const tail = i.no_schedule ? '' : ` Baka kailangan mo na sa biyahe (${fmtRelative(i.next_trip, i.today)}).`
  return `${habit} ${when}${tail} Tantiya — hindi ko alam ang natira.`
}

export function tierAHint(i: TierAReasonInput): string | null {
  const parts: string[] = []
  if (i.no_schedule && i.weekly_hint_label) parts.push(`Para umabot ng 1 linggo: ${i.weekly_hint_label}.`)
  if (i.payday_in_horizon) parts.push(i.cap_reached ? 'Katapusan/kinsenas — baka kulangin; ikaw ang bahala.' : 'Katapusan/kinsenas — mas mabenta.')
  return parts.length ? parts.join(' ') : null
}

/** Bakit sheet text for Tier A — keeps the accepted limitations visible. */
export const TIER_A_BAKIT =
  'Base lang ito sa dalas ng pagbili mo, hindi sa aktwal na benta. Hindi ko alam ang natira — bilangin mo para mas tumpak. ' +
  'Kung madalas kang maubusan bago bumili, o may binibili ka sa iba na hindi nailista, hindi iyon makikita rito.'

export const TIER_B_BAKIT_STALE =
  'Tantiya ang natira base sa huling bilang at sa bilis ng pagkaubos. Kapag matagal nang hindi nabibilang, lumalayo ang tantiya.'

export function banner(count: number, trip: LocalDate, today: LocalDate): string {
  const when = fmtRelative(trip, today)
  return `${count} item ang mauubos bago ang biyahe (${when}) — bumili ka na bukas?`
}
