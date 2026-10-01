// Product CSV import — P5 (decided 2026-10-01). Pure parsing and validation; the caller adds the
// valid rows as new products (and an optional starting COUNT) and skips names the store already has.
// Only products: history (purchases, utang) comes in through the JSON export, which keeps ids and
// the event log exact.

export interface ProductCsvRow {
  /** 1-based line in the file (the header is line 1) */
  line: number
  name: string
  category: string
  unit_label: string
  pack_size: number
  pack_label: string
  sell_price: number | null
  natira: number | null
}

export type CsvRowError = { line: number; reason: 'no_name' | 'bad_pack_size' | 'bad_price' | 'bad_natira' | 'duplicate' }

export interface ProductCsvResult {
  rows: ProductCsvRow[]
  errors: CsvRowError[]
  /** false when the header has no name column: nothing can be read */
  header_ok: boolean
}

export const CSV_DEFAULT_CATEGORY = 'Itlog at iba pa'
export const CSV_TEMPLATE = 'name,category,unit_label,pack_size,pack_label,sell_price,natira\nCoke Mismo 290ml,Softdrinks,bote,12,case,20,8\nLucky Me Pancit Canton Original,Noodles,pack,24,box,16,\n'

/** Accepted header names (English and Taglish), lowercased, spaces/underscores ignored. */
const COLUMNS: Record<keyof Omit<ProductCsvRow, 'line'>, string[]> = {
  name: ['name', 'pangalan', 'paninda', 'product'],
  category: ['category', 'kategorya', 'uri'],
  unit_label: ['unitlabel', 'unit', 'yunit', 'tingi'],
  pack_size: ['packsize', 'laman', 'ilanbawatpack', 'perpack'],
  pack_label: ['packlabel', 'pack', 'balot'],
  sell_price: ['sellprice', 'price', 'presyo', 'benta'],
  natira: ['natira', 'stock', 'onhand', 'bilang'],
}

/**
 * RFC 4180-style parser: quoted fields, doubled quotes, CRLF/LF, a UTF-8 BOM, and the delimiter
 * (comma, semicolon or tab) taken from the header line — spreadsheets in some locales save with
 * semicolons. Blank lines are dropped but keep their line numbers out of the count.
 */
export function parseCsv(text: string): Array<{ line: number; cells: string[] }> {
  const src = text.replace(/^﻿/, '')
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0]
  const out: Array<{ line: number; cells: string[] }> = []
  let cells: string[] = []
  let cell = ''
  let quoted = false
  let line = 1
  let startLine = 1
  const endRow = () => {
    cells.push(cell)
    if (cells.some((c) => c.trim() !== '')) out.push({ line: startLine, cells })
    cells = []
    cell = ''
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else {
        if (ch === '\n') line++
        cell += ch
      }
      continue
    }
    if (ch === '"' && cell === '') quoted = true
    else if (ch === delim) {
      cells.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      endRow()
      line++
      startLine = line
    } else cell += ch
  }
  if (cell !== '' || cells.length > 0) endRow()
  return out
}

const norm = (h: string) => h.trim().toLowerCase().replace(/[\s_\-.]/g, '')

function num(s: string | undefined): number | null | 'bad' {
  const t = (s ?? '').trim().replace(/^₱/, '').replace(/,(?=\d{3}\b)/g, '')
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : 'bad'
}

export function productsFromCsv(text: string): ProductCsvResult {
  const table = parseCsv(text)
  const header = table[0]
  if (!header) return { rows: [], errors: [], header_ok: false }
  const idx: Partial<Record<keyof typeof COLUMNS, number>> = {}
  header.cells.forEach((h, i) => {
    const n = norm(h)
    for (const [k, names] of Object.entries(COLUMNS) as Array<[keyof typeof COLUMNS, string[]]>) {
      if (idx[k] === undefined && names.includes(n)) idx[k] = i
    }
  })
  if (idx.name === undefined) return { rows: [], errors: [], header_ok: false }

  const rows: ProductCsvRow[] = []
  const errors: CsvRowError[] = []
  const seen = new Set<string>()
  for (const { line, cells } of table.slice(1)) {
    const get = (k: keyof typeof COLUMNS) => (idx[k] === undefined ? '' : (cells[idx[k]!] ?? '').trim())
    const name = get('name').replace(/\s+/g, ' ')
    if (!name) {
      errors.push({ line, reason: 'no_name' })
      continue
    }
    const size = num(get('pack_size'))
    if (size === 'bad' || (size !== null && !(Number.isInteger(size) && size >= 1 && size <= 10000))) {
      errors.push({ line, reason: 'bad_pack_size' })
      continue
    }
    const price = num(get('sell_price'))
    if (price === 'bad' || (price !== null && !(price > 0 && price < 1_000_000 && Math.round(price * 100) === price * 100))) {
      errors.push({ line, reason: 'bad_price' })
      continue
    }
    const natira = num(get('natira'))
    if (natira === 'bad' || (natira !== null && !(Number.isInteger(natira) && natira >= 0 && natira <= 1_000_000))) {
      errors.push({ line, reason: 'bad_natira' })
      continue
    }
    const k = name.toLowerCase()
    if (seen.has(k)) {
      errors.push({ line, reason: 'duplicate' })
      continue
    }
    seen.add(k)
    const unit = get('unit_label') || 'piraso'
    const packSize = size ?? 1
    rows.push({
      line,
      name,
      category: get('category') || CSV_DEFAULT_CATEGORY,
      unit_label: unit,
      pack_size: packSize,
      pack_label: get('pack_label') || (packSize === 1 ? unit : 'pack'),
      sell_price: price,
      natira,
    })
  }
  return { rows, errors, header_ok: true }
}
