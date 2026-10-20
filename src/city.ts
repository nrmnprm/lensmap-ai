/** The city snapshot (data/city.json, built by scripts/fetch-city.ts) and
 * place selection. In LensMap the same selection runs over a daily POI index
 * of the city; here it runs over the bundled snapshot so the demo works
 * offline and answers are reproducible. */
import { readFileSync } from 'node:fs'
import { haversineKm } from './geo.ts'
import { tokens, wordMatch } from './names.ts'
import type { CitySnapshot, Place } from './types.ts'

export const city: CitySnapshot = JSON.parse(readFileSync(new URL('../data/city.json', import.meta.url), 'utf8'))

export const placeById = new Map(city.places.map((p) => [p.id, p]))

interface Near {
  place: Place
  km: number
}

function near(lat: number, lng: number, kinds: Set<string>, radiusKm: number): Near[] {
  const out: Near[] = []
  for (const place of city.places) {
    if (!kinds.has(place.kind)) continue
    const km = haversineKm(lat, lng, place.lat, place.lng)
    if (km <= radiusKm) out.push({ place, km })
  }
  return out.sort((a, b) => a.km - b.km)
}

/** Nearest places of the given kinds: "where is the nearest pharmacy". */
export function nearestPlaces(lat: number, lng: number, kinds: string[], radiusKm: number, limit: number): Place[] {
  return near(lat, lng, new Set(kinds), radiusKm)
    .slice(0, limit)
    .map((n) => n.place)
}

/** Round-robin over kinds, nearest first inside each kind, so a general
 * question does not get "24 cafes in a row". `prefer` kinds go first in each
 * round (indoor places when it rains). */
export function diversePlaces(
  lat: number,
  lng: number,
  kinds: string[],
  radiusKm: number,
  limit: number,
  prefer: Set<string> = new Set(),
): Place[] {
  const order = [...kinds].sort((a, b) => Number(prefer.has(b)) - Number(prefer.has(a)))
  const byKind = new Map(order.map((k) => [k, near(lat, lng, new Set([k]), radiusKm)]))
  const out: Place[] = []
  for (let round = 0; out.length < limit; round++) {
    let added = false
    for (const k of order) {
      const n = byKind.get(k)?.[round]
      if (!n) continue
      out.push(n.place)
      added = true
      if (out.length >= limit) break
    }
    if (!added) break
  }
  return out
}

/** Words of a question that say nothing about the place itself. */
const QUESTION_WORDS = new Set(
  [
    'где', 'куда', 'рядом', 'поблизости', 'поесть', 'покушать', 'перекусить', 'вкусный', 'вкусно', 'хочу', 'можно',
    'найти', 'лучший', 'лучше', 'недорого', 'дешево', 'сейчас', 'открыт', 'открыто', 'ближайший', 'ближайшая',
    'where', 'near', 'nearby', 'nearest', 'eat', 'have', 'find', 'best', 'good', 'cheap', 'open', 'now', 'can', 'some',
    'something', 'want', 'today', 'tonight', 'place', 'places', 'that', 'with', 'for', 'is', 'are', 'what',
  ].flatMap(tokens),
)

/** Places whose name mentions what was asked for: "где поесть плов" finds
 * "Central Asian Plov Centre" even when twenty cafes are closer. */
export function namedPlaces(query: string, lat: number, lng: number, kinds: string[], radiusKm: number, limit: number): Place[] {
  const want = tokens(query).filter((w) => w.length >= 4 && !QUESTION_WORDS.has(w))
  if (!want.length) return []
  const kindSet = new Set(kinds)
  return city.places
    .filter((p) => kindSet.has(p.kind) && haversineKm(lat, lng, p.lat, p.lng) <= radiusKm)
    .filter((p) => p.names.some((n) => tokens(n).some((t) => want.some((w) => wordMatch(w, t)))))
    .sort((a, b) => haversineKm(lat, lng, a.lat, a.lng) - haversineKm(lat, lng, b.lat, b.lng))
    .slice(0, limit)
}
