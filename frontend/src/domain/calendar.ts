// Calendar rules — BLUEPRINT §E0. Local calendar dates are YYYY-MM-DD strings; all
// arithmetic on them is integer civil-date math so it never depends on the runtime timezone.
// Converting an ISO timestamp to a local date does use the device's timezone (by design).

import type { ISODateTime, LocalDate, Weekday } from './types'

export const MS_PER_DAY = 86_400_000

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)

export function makeLocalDate(y: number, m: number, d: number): LocalDate {
  return `${y}-${pad(m)}-${pad(d)}`
}

export function parseLocalDate(s: LocalDate): { y: number; m: number; d: number } {
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(5, 7))
  const d = Number(s.slice(8, 10))
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    throw new Error(`Invalid LocalDate: ${s}`)
  }
  return { y, m, d }
}

/** Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm). */
export function daysFromCivil(y: number, m: number, d: number): number {
  y -= m <= 2 ? 1 : 0
  const era = Math.floor((y >= 0 ? y : y - 399) / 400)
  const yoe = y - era * 400
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy
  return era * 146097 + doe - 719468
}

export function civilFromDays(z: number): { y: number; m: number; d: number } {
  z += 719468
  const era = Math.floor((z >= 0 ? z : z - 146096) / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const y = yoe + era * 400
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1
  const m = mp + (mp < 10 ? 3 : -9)
  return { y: y + (m <= 2 ? 1 : 0), m, d }
}

export function dayNumber(date: LocalDate): number {
  const { y, m, d } = parseLocalDate(date)
  return daysFromCivil(y, m, d)
}

export function fromDayNumber(n: number): LocalDate {
  const { y, m, d } = civilFromDays(n)
  return makeLocalDate(y, m, d)
}

export function addDays(date: LocalDate, n: number): LocalDate {
  return fromDayNumber(dayNumber(date) + n)
}

/** b − a in whole days. */
export function diffDays(a: LocalDate, b: LocalDate): number {
  return dayNumber(b) - dayNumber(a)
}

/** 0 = Sunday … 6 = Saturday. 1970-01-01 was a Thursday (4). */
export function weekday(date: LocalDate): Weekday {
  return ((((dayNumber(date) + 4) % 7) + 7) % 7) as Weekday
}

export function lastDayOfMonth(y: number, m: number): number {
  return civilFromDays(daysFromCivil(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1, 1) - 1).d
}

/** Payday days: 15, 16, 30, last day of the month, 1. */
export function isPayday(date: LocalDate): boolean {
  const { y, m, d } = parseLocalDate(date)
  return d === 15 || d === 16 || d === 30 || d === 1 || d === lastDayOfMonth(y, m)
}

export function isFriSat(date: LocalDate): boolean {
  const w = weekday(date)
  return w === 5 || w === 6
}

export interface Multipliers {
  payday: number
  fri_sat: number
}

/** mult(d) = max(payday ? m.payday : 1, fri/sat ? m.fri_sat : 1). */
export function multiplier(date: LocalDate, m: Multipliers): number {
  let x = 1
  if (isPayday(date)) x = Math.max(x, m.payday)
  if (isFriSat(date)) x = Math.max(x, m.fri_sat)
  return x
}

/** Σ_{d ∈ [a, b)} rate · mult(d). demand(r, x, x) = 0. */
export function demand(rate: number, a: LocalDate, b: LocalDate, m: Multipliers): number {
  const start = dayNumber(a)
  const end = dayNumber(b)
  let s = 0
  for (let n = start; n < end; n++) s += rate * multiplier(fromDayNumber(n), m)
  return s
}

/** next_trip = override ?? next restock_day ≥ today ?? today */
export function nextTrip(today: LocalDate, restockDays: Weekday[], override: LocalDate | null): LocalDate {
  if (override) return override
  if (restockDays.length === 0) return today
  for (let i = 0; i < 7; i++) {
    const d = addDays(today, i)
    if (restockDays.includes(weekday(d))) return d
  }
  return today
}

/** following = next restock_day > next_trip ?? next_trip + 7 */
export function followingTrip(next: LocalDate, restockDays: Weekday[]): LocalDate {
  if (restockDays.length === 0) return addDays(next, 7)
  for (let i = 1; i <= 7; i++) {
    const d = addDays(next, i)
    if (restockDays.includes(weekday(d))) return d
  }
  return addDays(next, 7)
}

// ---------- Timestamps ----------

export function toMs(ts: ISODateTime): number {
  const ms = Date.parse(ts)
  if (Number.isNaN(ms)) throw new Error(`Invalid timestamp: ${ts}`)
  return ms
}

/** Fractional days from a to b. */
export function daysBetweenMs(aMs: number, bMs: number): number {
  return (bMs - aMs) / MS_PER_DAY
}

/** Local calendar date of a timestamp, in the device's timezone. */
export function toLocalDate(ts: ISODateTime | number): LocalDate {
  const d = new Date(typeof ts === 'number' ? ts : toMs(ts))
  return makeLocalDate(d.getFullYear(), d.getMonth() + 1, d.getDate())
}

/** ms epoch of a local wall-clock time on a local date (device timezone). */
export function localTimeMs(date: LocalDate, hour: number, minute = 0): number {
  const { y, m, d } = parseLocalDate(date)
  return new Date(y, m - 1, d, hour, minute, 0, 0).getTime()
}

export function noonMs(date: LocalDate): number {
  return localTimeMs(date, 12)
}

/** ISO string with the device's local offset, e.g. 2026-05-13T12:00:00+08:00 */
export function toISOWithOffset(ms: number): ISODateTime {
  const d = new Date(ms)
  const off = -d.getTimezoneOffset()
  const sign = off >= 0 ? '+' : '-'
  const abs = Math.abs(off)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  )
}
