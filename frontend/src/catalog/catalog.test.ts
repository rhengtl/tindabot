import { describe, expect, it } from 'vitest'
import { productMatches, searchCatalog } from './catalog'

describe('catalog search', () => {
  it('matches what owners type', () => {
    expect(searchCatalog('coke').map((c) => c.name)).toContain('Coca-Cola 1.5L')
    expect(searchCatalog('canton').map((c) => c.name)).toContain('Lucky Me Pancit Canton Original')
    expect(searchCatalog('bigas').length).toBeGreaterThanOrEqual(4)
    expect(searchCatalog('coca cola 1.5').map((c) => c.name)).toContain('Coca-Cola 1.5L')
    expect(searchCatalog('sardinas').map((c) => c.name)).toContain('Ligo Sardines Tomato Sauce 155g')
    expect(searchCatalog('')).toHaveLength(searchCatalog('   ').length)
  })
})

describe('store product search', () => {
  it('finds a catalog product by the word that found it in the catalog', () => {
    expect(productMatches('Coca-Cola 1.5L', 'coke')).toBe(true)
    expect(productMatches('Lucky Me Pancit Canton Original', 'canton')).toBe(true)
    expect(productMatches('Coca-Cola 1.5L', 'Coca-Cola')).toBe(true)
    expect(productMatches('Coca-Cola 1.5L', 'coke 1.5')).toBe(true)
  })
  it('own names match by their words; an empty search shows everything; no false hits', () => {
    expect(productMatches('Audit Sabon Bar', 'sabon')).toBe(true)
    expect(productMatches('Audit Sabon Bar', '  ')).toBe(true)
    expect(productMatches('Audit Sabon Bar', 'coke')).toBe(false)
    expect(productMatches('Coca-Cola 1.5L', 'sprite')).toBe(false)
  })
})
