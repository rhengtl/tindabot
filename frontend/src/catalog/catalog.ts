// Bundled PH sari-sari catalog. Pack sizes are common supplier packs and are editable by the
// owner; cost hints are rough per-unit peso values used only for the "tama ba ang presyo?"
// sanity prompt (> 5× hint), never for recommendations.

export interface CatalogItem {
  name: string
  category: string
  unit_label: string
  pack_size: number
  pack_label: string
  cost_hint: number | null // per selling unit, approximate
  aliases?: string[] // what owners actually type: "coke", "canton", "bigas"
}

const i = (name: string, category: string, unit_label: string, pack_size: number, pack_label: string, cost_hint: number | null = null): CatalogItem => ({
  name,
  category,
  unit_label,
  pack_size,
  pack_label,
  cost_hint,
})

export const CATEGORIES = ['Noodles', 'Softdrinks', 'Bigas', 'De lata', 'Kape at gatas', 'Sabon at shampoo', 'Sigarilyo', 'Meryenda', 'Kondimento', 'Itlog at iba pa'] as const

export const CATALOG: CatalogItem[] = [
  // Noodles
  i('Lucky Me Pancit Canton Original', 'Noodles', 'pack', 24, 'box', 14),
  i('Lucky Me Pancit Canton Chilimansi', 'Noodles', 'pack', 24, 'box', 14),
  i('Lucky Me Pancit Canton Kalamansi', 'Noodles', 'pack', 24, 'box', 14),
  i('Lucky Me Chicken Mami', 'Noodles', 'pack', 24, 'box', 12),
  i('Lucky Me Beef Mami', 'Noodles', 'pack', 24, 'box', 12),
  i('Lucky Me Cup Noodles', 'Noodles', 'cup', 24, 'box', 22),
  i('Payless Pancit Canton', 'Noodles', 'pack', 24, 'box', 10),
  i('Nissin Cup Noodles', 'Noodles', 'cup', 24, 'box', 24),
  // Softdrinks
  i('Coca-Cola 1.5L', 'Softdrinks', 'bote', 12, 'case', 65),
  i('Coca-Cola Sakto 200ml', 'Softdrinks', 'bote', 24, 'case', 12),
  i('Coca-Cola Mismo 300ml', 'Softdrinks', 'bote', 24, 'case', 16),
  i('Sprite 1.5L', 'Softdrinks', 'bote', 12, 'case', 65),
  i('Sprite Mismo 300ml', 'Softdrinks', 'bote', 24, 'case', 16),
  i('Royal Tru-Orange 1.5L', 'Softdrinks', 'bote', 12, 'case', 65),
  i('Mountain Dew 1.5L', 'Softdrinks', 'bote', 12, 'case', 62),
  i('Pepsi 1.5L', 'Softdrinks', 'bote', 12, 'case', 60),
  i('C2 Apple 500ml', 'Softdrinks', 'bote', 24, 'case', 22),
  i('Wilkins Water 500ml', 'Softdrinks', 'bote', 24, 'case', 13),
  i('Zesto Orange 200ml', 'Softdrinks', 'pack', 10, 'pack', 9),
  i('Cobra Energy Drink', 'Softdrinks', 'bote', 24, 'case', 24),
  i('Sting Energy Drink', 'Softdrinks', 'bote', 24, 'case', 22),
  // Bigas
  i('Sinandomeng Rice (1kg)', 'Bigas', 'kilo', 25, 'sako', 52),
  i('Dinorado Rice (1kg)', 'Bigas', 'kilo', 25, 'sako', 58),
  i('Jasmine Rice (1kg)', 'Bigas', 'kilo', 25, 'sako', 55),
  i('Well-milled Rice (1kg)', 'Bigas', 'kilo', 25, 'sako', 45),
  // De lata
  i('Century Tuna Flakes in Oil 155g', 'De lata', 'lata', 24, 'box', 38),
  i('Century Tuna Hot & Spicy 155g', 'De lata', 'lata', 24, 'box', 38),
  i('Argentina Corned Beef 150g', 'De lata', 'lata', 24, 'box', 45),
  i('Argentina Meat Loaf 150g', 'De lata', 'lata', 24, 'box', 28),
  i('Ligo Sardines Tomato Sauce 155g', 'De lata', 'lata', 50, 'box', 22),
  i('Mega Sardines 155g', 'De lata', 'lata', 50, 'box', 22),
  i('555 Sardines 155g', 'De lata', 'lata', 50, 'box', 20),
  i('Purefoods Corned Beef 150g', 'De lata', 'lata', 24, 'box', 48),
  i('CDO Karne Norte 150g', 'De lata', 'lata', 24, 'box', 30),
  i('Youngstown Sardines 155g', 'De lata', 'lata', 50, 'box', 19),
  // Kape at gatas
  i('Nescafé 3-in-1 Original', 'Kape at gatas', 'sachet', 30, 'pack', 7),
  i('Kopiko Brown Coffee', 'Kape at gatas', 'sachet', 30, 'pack', 7),
  i('Kopiko Blanca', 'Kape at gatas', 'sachet', 30, 'pack', 7),
  i('Great Taste White', 'Kape at gatas', 'sachet', 30, 'pack', 7),
  i('San Mig Coffee Sugar Free', 'Kape at gatas', 'sachet', 30, 'pack', 7),
  i('Bear Brand Powdered Milk 33g', 'Kape at gatas', 'sachet', 24, 'box', 11),
  i('Alaska Evaporada 370ml', 'Kape at gatas', 'lata', 48, 'box', 32),
  i('Alaska Condensada 300ml', 'Kape at gatas', 'lata', 48, 'box', 38),
  i('Milo 24g sachet', 'Kape at gatas', 'sachet', 12, 'pack', 9),
  i('Energen Chocolate', 'Kape at gatas', 'sachet', 10, 'pack', 8),
  // Sabon at shampoo
  i('Safeguard 55g', 'Sabon at shampoo', 'bar', 12, 'pack', 22),
  i('Sunsilk shampoo sachet', 'Sabon at shampoo', 'sachet', 12, 'tira', 5),
  i('Palmolive shampoo sachet', 'Sabon at shampoo', 'sachet', 12, 'tira', 5),
  i('Head & Shoulders sachet', 'Sabon at shampoo', 'sachet', 12, 'tira', 6),
  i('Cream Silk sachet', 'Sabon at shampoo', 'sachet', 12, 'tira', 6),
  i('Tide Bar 380g', 'Sabon at shampoo', 'bar', 24, 'box', 28),
  i('Surf Powder 65g', 'Sabon at shampoo', 'sachet', 6, 'tira', 9),
  i('Ariel Powder 66g', 'Sabon at shampoo', 'sachet', 6, 'tira', 11),
  i('Downy sachet', 'Sabon at shampoo', 'sachet', 12, 'tira', 6),
  i('Colgate 25ml', 'Sabon at shampoo', 'tube', 12, 'pack', 18),
  i('Zonrox 100ml', 'Sabon at shampoo', 'bote', 24, 'box', 12),
  i('Joy Dishwashing 45ml', 'Sabon at shampoo', 'sachet', 12, 'tira', 8),
  // Sigarilyo (sold per pack here; owners who sell by stick may set unit = stick)
  i('Marlboro Red', 'Sigarilyo', 'pack', 10, 'ream', 150),
  i('Marlboro Lights', 'Sigarilyo', 'pack', 10, 'ream', 150),
  i('Fortune', 'Sigarilyo', 'pack', 10, 'ream', 85),
  i('Mighty', 'Sigarilyo', 'pack', 10, 'ream', 80),
  i('Winston', 'Sigarilyo', 'pack', 10, 'ream', 120),
  // Meryenda
  i('Piattos', 'Meryenda', 'pack', 25, 'box', 14),
  i('Nova', 'Meryenda', 'pack', 25, 'box', 14),
  i('Chippy', 'Meryenda', 'pack', 25, 'box', 14),
  i('Boy Bawang', 'Meryenda', 'pack', 40, 'box', 12),
  i('SkyFlakes (pack of 3)', 'Meryenda', 'pack', 30, 'box', 9),
  i('Rebisco Crackers', 'Meryenda', 'pack', 30, 'box', 6),
  i('Fita', 'Meryenda', 'pack', 30, 'box', 8),
  i('Choco Mucho', 'Meryenda', 'piraso', 30, 'box', 9),
  i('Cloud 9', 'Meryenda', 'piraso', 30, 'box', 9),
  i('Mentos', 'Meryenda', 'piraso', 40, 'box', 4),
  i('Maxx Candy', 'Meryenda', 'piraso', 100, 'jar', 1),
  i('Pancit Canton Lomi', 'Meryenda', 'pack', 24, 'box', 12),
  // Kondimento
  i('Silver Swan Soy Sauce 200ml', 'Kondimento', 'bote', 24, 'box', 14),
  i('Datu Puti Vinegar 200ml', 'Kondimento', 'bote', 24, 'box', 12),
  i('Datu Puti Patis 200ml', 'Kondimento', 'bote', 24, 'box', 14),
  i('Magic Sarap 8g', 'Kondimento', 'sachet', 16, 'tira', 4),
  i('Knorr Cubes Beef', 'Kondimento', 'piraso', 12, 'pack', 5),
  i('Mama Sita Oyster Sauce 30g', 'Kondimento', 'sachet', 12, 'tira', 6),
  i('UFC Banana Catsup 320g', 'Kondimento', 'bote', 24, 'box', 24),
  i('Star Margarine 100g', 'Kondimento', 'piraso', 24, 'box', 18),
  i('Cooking Oil 1L (repack)', 'Kondimento', 'bote', 12, 'box', 95),
  i('Asukal (1kg)', 'Kondimento', 'kilo', 25, 'sako', 78),
  i('Asin (500g)', 'Kondimento', 'pack', 24, 'box', 10),
  // Itlog at iba pa
  i('Itlog (piraso)', 'Itlog at iba pa', 'piraso', 30, 'tray', 8),
  i('Tinapay (Pandesal, piraso)', 'Itlog at iba pa', 'piraso', 25, 'bag', 3),
  i('Kandila', 'Itlog at iba pa', 'piraso', 12, 'pack', 6),
  i('Posporo', 'Itlog at iba pa', 'kaha', 10, 'pack', 2),
  i('Yelo (bag)', 'Itlog at iba pa', 'bag', 1, 'bag', 10),
  i('Charcoal (bag)', 'Itlog at iba pa', 'bag', 1, 'bag', 40),
]

const ALIASES: Record<string, string[]> = {
  'Coca-Cola': ['coke', 'cocacola', 'coca cola'],
  'Sprite': ['sprite'],
  'Royal Tru-Orange': ['royal', 'tru orange'],
  'Lucky Me Pancit Canton': ['canton', 'pancit canton', 'luckyme'],
  'Lucky Me': ['luckyme', 'mami'],
  'Sinandomeng': ['bigas', 'rice'],
  'Dinorado': ['bigas', 'rice'],
  'Jasmine': ['bigas', 'rice'],
  'Well-milled': ['bigas', 'rice'],
  'Bear Brand': ['bearbrand', 'gatas'],
  'Alaska': ['gatas', 'milk'],
  'Nescafé': ['nescafe', 'kape', 'coffee'],
  'Kopiko': ['kape', 'coffee'],
  'Great Taste': ['kape', 'coffee'],
  'San Mig Coffee': ['kape', 'coffee'],
  'Century Tuna': ['tuna'],
  'Ligo': ['sardinas', 'sardines'],
  'Mega Sardines': ['sardinas'],
  '555': ['sardinas'],
  'Youngstown': ['sardinas'],
  'Argentina': ['corned beef', 'karne'],
  'Purefoods': ['corned beef'],
  'CDO Karne': ['corned beef', 'karne norte'],
  'Marlboro': ['yosi', 'sigarilyo'],
  'Fortune': ['yosi', 'sigarilyo'],
  'Mighty': ['yosi', 'sigarilyo'],
  'Winston': ['yosi', 'sigarilyo'],
  'Itlog': ['egg', 'eggs'],
  'Safeguard': ['sabon'],
  'Tide': ['sabon', 'panlaba'],
  'Surf': ['sabon', 'panlaba'],
  'Ariel': ['sabon', 'panlaba'],
  'Asukal': ['sugar'],
  'Asin': ['salt'],
  'Cooking Oil': ['mantika'],
  'Silver Swan': ['toyo'],
  'Datu Puti Vinegar': ['suka'],
  'Datu Puti Patis': ['patis'],
}

const norm = (x: string) => x.toLowerCase().replace(/[-–_.]/g, ' ').replace(/\s+/g, ' ').trim()

function aliasesFor(name: string): string[] {
  const out: string[] = []
  for (const [prefix, list] of Object.entries(ALIASES)) if (name.startsWith(prefix)) out.push(...list)
  return out
}

/**
 * Search over the store's OWN products (Bumili, Paninda, Benta): the product's name plus the catalog's
 * words for it, so the word that found "Coca-Cola 1.5L" in the catalog ("coke") finds it again later.
 */
export function productMatches(name: string, q: string): boolean {
  const s = norm(q)
  if (!s) return true
  const item = CATALOG.find((c) => c.name === name)
  const hay = [norm(name), ...aliasesFor(name).map(norm), ...(item?.aliases ?? []).map(norm)].join(' | ')
  return s.split(' ').every((t) => hay.includes(t))
}

export function searchCatalog(q: string): CatalogItem[] {
  const s = norm(q)
  if (!s) return CATALOG
  const terms = s.split(' ')
  return CATALOG.filter((c) => {
    const hay = [norm(c.name), norm(c.category), ...aliasesFor(c.name).map(norm), ...(c.aliases ?? []).map(norm)].join(' | ')
    return terms.every((t) => hay.includes(t))
  })
}
