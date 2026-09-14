import { describe, expect, it } from 'vitest'
import { searchCatalog } from './catalog'

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
