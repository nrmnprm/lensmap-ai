/** Venue geocoding against the city snapshot. LensMap does this with
 * Nominatim and Overpass name search; the demo uses the same OSM data
 * offline. The rule is the same: coordinates come from map data only, never
 * from the model. */
import { city } from './city.ts'
import { haversineKm, jitterAround } from './geo.ts'
import { canon, kindHints, nameCoverage, nameScore, phraseIn, tokens, wordMatch } from './names.ts'
import type { Place } from './types.ts'

export interface GeoHit {
  lat: number
  lng: number
  /** venue: the place itself; landmark: a place the event is near;
   * district: only the district is known. */
  via: 'venue' | 'landmark' | 'district'
  label: string
  placeId: string | null
  score: number
  /** Several places share the best name (branches of a chain): how many. */
  ambiguous?: number
}

const MIN_SCORE = 0.6

/** Kinds of places where events happen (not pharmacies or banks). */
const EVENT_KINDS = new Set([
  'theatre', 'cinema', 'museum', 'park', 'attraction', 'viewpoint', 'cafe', 'restaurant', 'bar', 'nightclub',
  'library', 'mall', 'market', 'worship', 'zoo', 'playground', 'hotel', 'fitness', 'coworking', 'bakery', 'fast_food',
])

/** Best place for a venue name. A generic word in the query ("museum",
 * "театр") must agree with the category of the place; ties between branches
 * go to the one nearest the anchor (the named district, else the centre). */
function bestPlace(query: string, anchor: { lat: number; lng: number } = city.center): GeoHit | null {
  const hints = kindHints(query)
  let top: { place: Place; score: number }[] = []
  for (const p of city.places) {
    if (!EVENT_KINDS.has(p.kind)) continue
    if (haversineKm(city.center.lat, city.center.lng, p.lat, p.lng) > city.radiusKm * 1.5) continue
    let score = 0
    for (const n of p.names) score = Math.max(score, nameScore(query, n))
    if (!score) continue
    if (hints.size) score += hints.has(p.kind) ? 0.1 : -0.3
    if (score < MIN_SCORE) continue
    if (!top.length || score > top[0].score + 1e-9) top = [{ place: p, score }]
    else if (Math.abs(score - top[0].score) < 1e-9) top.push({ place: p, score })
  }
  if (!top.length) return null
  const dist = (p: Place) => haversineKm(anchor.lat, anchor.lng, p.lat, p.lng)
  top.sort((a, b) => dist(a.place) - dist(b.place))
  const best = top[0].place
  // Same name 500 m or more apart: different branches, not one venue.
  const branches = top.filter((t) => haversineKm(best.lat, best.lng, t.place.lat, t.place.lng) > 0.5).length + 1
  return {
    lat: best.lat,
    lng: best.lng,
    via: 'venue',
    label: best.name,
    placeId: best.id,
    score: Math.min(1, top[0].score),
    ...(branches > 1 ? { ambiguous: branches } : {}),
  }
}

/** Best district. On a tie the name with fewer words the query does not
 * mention wins: "в Юнусабаде" is the district "Yunusobod", not its quarter
 * "Yunusabad-9"; "Чиланзар-9" is the quarter. */
function bestDistrict(query: string): GeoHit | null {
  const qWords = canon(query).split(' ')
  const extra = (name: string) => canon(name).split(' ').filter((w) => !qWords.some((x) => wordMatch(x, w))).length
  let best: (GeoHit & { extra: number }) | null = null
  for (const d of city.districts) {
    let score = 0
    let ex = Infinity
    for (const n of d.names) {
      // A district is often named inside a longer phrase ("Yunusobod
      // district, near the metro"): a fully covered name of 5+ letters counts.
      const covered = nameCoverage(query, n) === 1 && tokens(n).join('').length >= 5
      const s = Math.max(nameScore(query, n), covered ? 0.8 : 0)
      if (s < score) continue
      const e = extra(n)
      if (s > score || e < ex) {
        score = s
        ex = e
      }
    }
    if (score < MIN_SCORE) continue
    if (best && (score < best.score || (score === best.score && ex >= best.extra))) continue
    best = { lat: d.lat, lng: d.lng, via: 'district', label: d.name, placeId: null, score, extra: ex }
  }
  if (!best) return null
  const { extra: _extra, ...hit } = best
  return hit
}

/** Venue first, then the named district, then a landmark. The street
 * address is never matched against places: "Navoi ko'chasi 12" is a street,
 * not the Navoi Theatre. null when the text names nothing on the map. */
export function geocodeVenue(venue: string | null, address: string | null, district: string | null): GeoHit | null {
  const area = district ? bestDistrict(district) : null
  if (venue) {
    const hit = bestPlace(venue, area ?? city.center)
    if (hit) return hit
  }
  if (area) return area
  for (const q of [address, venue]) {
    if (!q) continue
    const hit = bestDistrict(q)
    if (hit) return hit
  }
  // "district" is also where models put landmarks ("near the Japanese garden").
  const landmark = district ? bestPlace(district) : null
  return landmark ? { ...landmark, via: 'landmark' } : null
}

let nameIndex: { place: Place; words: string[] }[] | null = null

/** Last resort when the model translated or garbled the venue ("Ilim
 * Theater" for «Ильхом»): a place whose whole name is written in the
 * original post as one phrase. Short one-word names ("Joints") and names
 * shared by several places do not count. */
export function venueInText(text: string): GeoHit | null {
  nameIndex ??= city.places
    .filter((p) => EVENT_KINDS.has(p.kind))
    .flatMap((place) => place.names.map((n) => ({ place, words: tokens(n) })))
    .filter((e) => e.words.length >= 2 || (e.words.length === 1 && e.words[0].length >= 5))
  const words = canon(text).split(' ')
  const found = new Map<string, Place>()
  for (const e of nameIndex) if (phraseIn(words, e.words)) found.set(e.place.id, e.place)
  if (found.size !== 1) return null
  const [p] = found.values()
  return { lat: p.lat, lng: p.lng, via: 'venue', label: p.name, placeId: p.id, score: 0.6 }
}

/** Where to put an event and what to tell the reader about the point.
 * Venue found: exact. District found: the district centre, marked
 * approximate. Nothing found: the city centre with a small deterministic
 * offset, marked approximate — never the user's own position. */
export function placeEvent(
  hit: GeoHit | null,
  placeLine: string,
  district: string | null,
  seed: string,
): { lat: number; lng: number; note: string | null; via: 'venue' | 'district' | 'city' } {
  if (hit?.via === 'venue' && hit.ambiguous) {
    return {
      lat: hit.lat,
      lng: hit.lng,
      via: 'venue',
      note: `${hit.ambiguous} places are called "${hit.label}"; the one nearest ${district ?? 'the centre'} is shown.`,
    }
  }
  if (hit?.via === 'venue') return { lat: hit.lat, lng: hit.lng, note: null, via: 'venue' }
  if (hit?.via === 'landmark') {
    return { lat: hit.lat, lng: hit.lng, via: 'district', note: `Approximate point: near ${hit.label}.` }
  }
  if (hit) {
    const at = jitterAround(hit.lat, hit.lng, seed)
    return {
      ...at,
      via: 'district',
      note: `Approximate point: ${district ?? hit.label} district${placeLine ? `; venue: ${placeLine}` : ''}.`,
    }
  }
  const at = jitterAround(city.center.lat, city.center.lng, seed)
  const where = placeLine || district
  return {
    ...at,
    via: 'city',
    note: where
      ? `Venue: ${where} (not found on the map, shown in the city centre).`
      : 'The post names no venue; the point is the city centre. Check with the organisers.',
  }
}
