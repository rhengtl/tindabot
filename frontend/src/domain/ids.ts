// ULID generation (Crockford base32, 48-bit time + 80-bit random, monotonic within a ms).
// Kept dependency-free so the domain layer runs anywhere (browser, Node tests, Edge Functions).

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

let lastTime = 0
let lastRandom: number[] = []

function randomBytes(n: number): number[] {
  const out = new Array<number>(n)
  const g = globalThis.crypto
  if (g && typeof g.getRandomValues === 'function') {
    const buf = new Uint8Array(n)
    g.getRandomValues(buf)
    for (let i = 0; i < n; i++) out[i] = buf[i]!
  } else {
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256)
  }
  return out
}

function encodeTime(ms: number): string {
  let s = ''
  for (let i = 0; i < 10; i++) {
    s = ALPHABET[ms % 32] + s
    ms = Math.floor(ms / 32)
  }
  return s
}

function encodeRandom(digits: number[]): string {
  return digits.map((d) => ALPHABET[d]).join('')
}

/** 16 base32 digits (80 bits) as an array of 0..31 values. */
function randomDigits(): number[] {
  return randomBytes(16).map((b) => b % 32)
}

function increment(digits: number[]): number[] {
  const out = digits.slice()
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < 31) {
      out[i] = out[i]! + 1
      return out
    }
    out[i] = 0
  }
  return out
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    lastRandom = increment(lastRandom)
  } else {
    lastTime = now
    lastRandom = randomDigits()
  }
  return encodeTime(now) + encodeRandom(lastRandom)
}
