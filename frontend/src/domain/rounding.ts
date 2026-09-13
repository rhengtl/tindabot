// Pack rounding — BLUEPRINT §E0/E4.
// τ = half a day of demand: half the minimum buffer, in the store's own unit of time.
// packs(u, r, floor) = max(floor, ceil((u − τ(r)) / pack_size))

export function tau(rate: number): number {
  return 0.5 * rate
}

export function packsFor(units: number, rate: number, packSize: number, floor: number): number {
  if (packSize <= 0) throw new Error('pack_size must be > 0')
  const raw = Math.ceil((units - tau(rate)) / packSize)
  return Math.max(floor, raw)
}
