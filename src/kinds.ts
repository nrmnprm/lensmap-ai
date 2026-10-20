/** Place categories and query intents, ported from LensMap
 * (daily_backend/src/citypulse/places.ts). The model picks places from a
 * list built with these categories; it never invents a place or a coordinate. */

export interface KindSpec {
  label: string
  /** Overpass selectors without the `around` filter; combined into a union. */
  selectors: string[]
  /** Tags of an OSM object -> does it belong to this category. */
  match: (t: Record<string, string>) => boolean
}

/** Order matters: the first match wins (a cafe inside a restaurant, etc.). */
export const KINDS: Record<string, KindSpec> = {
  park: {
    label: 'park',
    selectors: ['[leisure~"^(park|garden)$"]'],
    match: (t) => t.leisure === 'park' || t.leisure === 'garden',
  },
  attraction: { label: 'sight', selectors: ['[tourism=attraction]'], match: (t) => t.tourism === 'attraction' },
  viewpoint: { label: 'viewpoint', selectors: ['[tourism=viewpoint]'], match: (t) => t.tourism === 'viewpoint' },
  museum: {
    label: 'museum',
    selectors: ['[tourism~"^(museum|gallery)$"]'],
    match: (t) => t.tourism === 'museum' || t.tourism === 'gallery',
  },
  theatre: { label: 'theatre', selectors: ['[amenity=theatre]'], match: (t) => t.amenity === 'theatre' },
  cinema: { label: 'cinema', selectors: ['[amenity=cinema]'], match: (t) => t.amenity === 'cinema' },
  cafe: { label: 'cafe', selectors: ['[amenity=cafe]'], match: (t) => t.amenity === 'cafe' },
  restaurant: { label: 'restaurant', selectors: ['[amenity=restaurant]'], match: (t) => t.amenity === 'restaurant' },
  fast_food: { label: 'fast food', selectors: ['[amenity=fast_food]'], match: (t) => t.amenity === 'fast_food' },
  bakery: {
    label: 'bakery',
    selectors: ['[shop~"^(bakery|pastry|confectionery)$"]', '[amenity=ice_cream]'],
    match: (t) => ['bakery', 'pastry', 'confectionery'].includes(t.shop) || t.amenity === 'ice_cream',
  },
  bar: {
    label: 'bar',
    selectors: ['[amenity~"^(bar|pub|biergarten)$"]'],
    match: (t) => ['bar', 'pub', 'biergarten'].includes(t.amenity),
  },
  nightclub: { label: 'club', selectors: ['[amenity=nightclub]'], match: (t) => t.amenity === 'nightclub' },
  mall: {
    label: 'shopping centre',
    selectors: ['[shop~"^(mall|department_store)$"]'],
    match: (t) => t.shop === 'mall' || t.shop === 'department_store',
  },
  supermarket: { label: 'supermarket', selectors: ['[shop=supermarket]'], match: (t) => t.shop === 'supermarket' },
  market: { label: 'market', selectors: ['[amenity=marketplace]'], match: (t) => t.amenity === 'marketplace' },
  pharmacy: { label: 'pharmacy', selectors: ['[amenity=pharmacy]'], match: (t) => t.amenity === 'pharmacy' },
  hospital: {
    label: 'medical',
    selectors: ['[amenity~"^(hospital|clinic|doctors|dentist)$"]'],
    match: (t) => ['hospital', 'clinic', 'doctors', 'dentist'].includes(t.amenity),
  },
  bank: {
    label: 'bank',
    selectors: ['[amenity~"^(bank|bureau_de_change)$"]'],
    match: (t) => t.amenity === 'bank' || t.amenity === 'bureau_de_change',
  },
  government: {
    label: 'public office',
    selectors: ['[office=government]', '[amenity~"^(townhall|courthouse)$"]'],
    match: (t) => t.office === 'government' || ['townhall', 'courthouse'].includes(t.amenity),
  },
  embassy: {
    label: 'embassy',
    selectors: ['[office=diplomatic]', '[amenity=embassy]'],
    match: (t) => t.office === 'diplomatic' || t.amenity === 'embassy',
  },
  post_office: { label: 'post office', selectors: ['[amenity=post_office]'], match: (t) => t.amenity === 'post_office' },
  hotel: {
    label: 'hotel',
    selectors: ['[tourism~"^(hotel|hostel|guest_house)$"]'],
    match: (t) => ['hotel', 'hostel', 'guest_house'].includes(t.tourism),
  },
  fitness: {
    label: 'sport',
    selectors: ['[leisure~"^(fitness_centre|sports_centre|swimming_pool|stadium|ice_rink)$"]'],
    match: (t) => ['fitness_centre', 'sports_centre', 'swimming_pool', 'stadium', 'ice_rink'].includes(t.leisure),
  },
  coworking: {
    label: 'coworking',
    selectors: ['[office=coworking]', '[amenity=coworking_space]'],
    match: (t) => t.office === 'coworking' || t.amenity === 'coworking_space',
  },
  library: { label: 'library', selectors: ['[amenity=library]'], match: (t) => t.amenity === 'library' },
  worship: {
    label: 'place of worship',
    selectors: ['[amenity=place_of_worship]'],
    match: (t) => t.amenity === 'place_of_worship',
  },
  zoo: {
    label: 'zoo / theme park',
    selectors: ['[tourism~"^(zoo|aquarium|theme_park)$"]', '[leisure=water_park]'],
    match: (t) => ['zoo', 'aquarium', 'theme_park'].includes(t.tourism) || t.leisure === 'water_park',
  },
  playground: {
    label: 'for kids',
    selectors: ['[leisure~"^(playground|amusement_arcade|trampoline_park)$"]'],
    match: (t) => ['playground', 'amusement_arcade', 'trampoline_park'].includes(t.leisure),
  },
}

/** Default "leisure" set for general questions such as "where should I go tonight". */
export const LEISURE_KINDS = ['park', 'attraction', 'viewpoint', 'museum', 'theatre', 'cinema', 'cafe', 'restaurant', 'bar']

/** Indoor categories: what to suggest when it rains. */
export const INDOOR_KINDS = new Set(['museum', 'theatre', 'cinema', 'cafe', 'restaurant', 'bakery', 'bar', 'mall', 'library'])

export function kindLabel(kind: string): string {
  return KINDS[kind]?.label ?? kind
}

export function kindOfTags(tags: Record<string, string>): string | null {
  for (const [k, spec] of Object.entries(KINDS)) if (spec.match(tags)) return k
  return null
}

/** What exactly is being asked: "where to eat" -> cafes and restaurants,
 * "pharmacy" -> pharmacies. Empty -> a general question. Russian patterns are
 * from LensMap; English ones were added for the demo. */
const INTENTS: { re: RegExp; kinds: string[] }[] = [
  // (?<!\p{L}) anchors Russian stems to the start of a word: "еды" must not
  // fire inside "Победы", "обед" inside "победа", "клуб" inside "клубника".
  { re: /(?<!\p{L})(поес|покуш|перекус|обед|ужин|завтрак|ед[аыуе](?!\p{L})|кухн|пицц|суши|плов|шашлы|бургер|лагман|самс|ресторан|фастфуд)|(?<!\p{L})(eat|food|restaurants?|dinner|lunch|breakfast|brunch|pizza|plov|pilaf)(?!\p{L})/iu, kinds: ['restaurant', 'cafe', 'fast_food'] },
  { re: /(?<!\p{L})(кофе|кафе(?!др)|кофейн|десерт|пекарн|выпечк|морожен)|(?<!\p{L})(coffee|cafes?|café|desserts?|bakery|ice cream)(?!\p{L})/iu, kinds: ['cafe', 'bakery'] },
  { re: /(?<!\p{L})(бар(ы|ов|ах|е)?(?!\p{L})|пив|паб(?!лик)|коктейл|ночн|клуб(?!ни))|(?<!\p{L})(bars?|pubs?|beer|cocktails?|nightlife|clubs?)(?!\p{L})/iu, kinds: ['bar', 'nightclub'] },
  { re: /(?<!\p{L})(парк|погулять|прогул|сквер|зелен|набережн)|(?<!\p{L})(parks?|walk|stroll|gardens?)(?!\p{L})/iu, kinds: ['park', 'viewpoint'] },
  { re: /(?<!\p{L})(тц|трц)(?!\p{L})|(?<!\p{L})(торгов|молл|шопинг|шоппинг|магазин|одежд|обув)|(?<!\p{L})(mall|shopping|clothes|shoes)(?!\p{L})/iu, kinds: ['mall', 'supermarket', 'market'] },
  { re: /(?<!\p{L})(супермаркет|продукт|базар|рын[оке])|(?<!\p{L})(market|bazaar|grocer(y|ies)?)(?!\p{L})/iu, kinds: ['supermarket', 'market'] },
  { re: /(?<!\p{L})(аптек|лекарств|таблет)|(?<!\p{L})(pharmac(y|ies)|drugstore|medicine)(?!\p{L})/iu, kinds: ['pharmacy'] },
  { re: /(?<!\p{L})(больниц|клиник|врач|поликлин|травмпункт|стоматол|зуб)|(?<!\p{L})(hospital|clinic|doctor|dentist)(?!\p{L})/iu, kinds: ['hospital', 'pharmacy'] },
  { re: /(?<!\p{L})(банк|обмен|валют)|(?<!\p{L})(banks?|atm|exchange|currency)(?!\p{L})/iu, kinds: ['bank'] },
  { re: /(?<!\p{L})(консульств|посольств)|(?<!\p{L})(embassy|consulate)(?!\p{L})/iu, kinds: ['embassy', 'government'] },
  { re: /(?<!\p{L})(почт|посылк)|post office|parcel/iu, kinds: ['post_office'] },
  { re: /(?<!\p{L})(отел|гостиниц|хостел|переночева)|(?<!\p{L})(hotels?|hostels?)(?!\p{L})|stay the night/iu, kinds: ['hotel'] },
  { re: /(?<!\p{L})(спорт|фитнес|тренаж|бассейн|стадион|каток|зал(?!\p{L}))|(?<!\p{L})(gym|fitness|swimming|pool|stadium)(?!\p{L})/iu, kinds: ['fitness'] },
  { re: /(?<!\p{L})(музе|галере|выставк)|(?<!\p{L})(museums?|galler(y|ies)|exhibitions?)(?!\p{L})/iu, kinds: ['museum', 'attraction'] },
  { re: /(?<!\p{L})(театр|спектакл)|(?<!\p{L})(theatres?|theaters?|plays?)(?!\p{L})/iu, kinds: ['theatre'] },
  { re: /(?<!\p{L})(кино|фильм)|(?<!\p{L})(cinemas?|movies?|films?)(?!\p{L})/iu, kinds: ['cinema'] },
  { re: /(?<!\p{L})(мечет|церк|храм|собор)|(?<!\p{L})(mosques?|church(es)?|cathedral)(?!\p{L})/iu, kinds: ['worship'] },
  { re: /(?<!\p{L})(библиотек|почитать)|(?<!\p{L})librar(y|ies)(?!\p{L})/iu, kinds: ['library'] },
  { re: /(?<!\p{L})(коворк|поработать|с ноутбуком)|cowork|laptop|work remotely/iu, kinds: ['coworking', 'cafe'] },
  { re: /(?<!\p{L})(зоопарк|аквапарк|аттракцион)|(?<!\p{L})(zoo|water park|theme park)(?!\p{L})/iu, kinds: ['zoo', 'playground'] },
  { re: /(?<!\p{L})(дет(ям|ьми|ск)|ребен|ребён|малыш)|(?<!\p{L})(kids?|children|child)(?!\p{L})/iu, kinds: ['playground', 'zoo', 'park'] },
  { re: /(?<!\p{L})(достоприм|посмотреть|экскурс|туристич)|sightsee|(?<!\p{L})(sights|landmarks?)(?!\p{L})|must.see/iu, kinds: ['attraction', 'viewpoint', 'museum'] },
]

export function kindsForQuery(query: string): string[] {
  const out: string[] = []
  for (const it of INTENTS) {
    if (!it.re.test(query)) continue
    for (const k of it.kinds) if (!out.includes(k)) out.push(k)
  }
  return out
}
