/** Builds data/city.json: named places and districts around a city centre from
 * OpenStreetMap through the Overpass API. Run once; the demo itself works
 * offline from the snapshot.
 *
 *   npm run fetch-city                       # Tashkent, the bundled default
 *   npm run fetch-city -- --city Lisbon --lat 38.7106 --lng -9.1393 --tz Europe/Lisbon
 */
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { KINDS, kindOfTags } from '../src/kinds.ts'
import { haversineKm } from '../src/geo.ts'
import type { CitySnapshot, District, Place } from '../src/types.ts'

const { values } = parseArgs({
  options: {
    city: { type: 'string', default: 'Tashkent' },
    lat: { type: 'string', default: '41.3111' },
    lng: { type: 'string', default: '69.2797' },
    tz: { type: 'string', default: 'Asia/Tashkent' },
    radius: { type: 'string', default: '5000' },
    out: { type: 'string', default: 'data/city.json' },
  },
})

const lat = Number(values.lat)
const lng = Number(values.lng)
const radius = Number(values.radius)

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]

/** Bounding box around the centre; a bbox filter is much cheaper for
 * Overpass than `around`, the radius is applied afterwards. */
function bbox(km: number): string {
  const dLat = km / 111
  const dLng = km / (111 * Math.cos((lat * Math.PI) / 180))
  return [lat - dLat, lng - dLng, lat + dLat, lng + dLng].map((v) => v.toFixed(5)).join(',')
}

interface Element {
  type: string
  id: number
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: Record<string, string>
}

/** Public Overpass instances are often overloaded: try each endpoint in
 * turn, several rounds, with a growing pause. */
async function overpass(query: string): Promise<Element[]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    for (const url of ENDPOINTS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'lensmap-ai-demo/1.0 (portfolio demo)' },
          body: new URLSearchParams({ data: query }),
          signal: AbortSignal.timeout(75_000),
        })
        if (!res.ok) {
          console.warn(`  ${new URL(url).host}: HTTP ${res.status}`)
          continue
        }
        const j = (await res.json()) as { elements?: Element[]; remark?: string }
        if (j.remark) console.warn(`  ${new URL(url).host}: ${j.remark}`)
        if (j.elements && !j.remark) return j.elements
      } catch (e) {
        console.warn(`  ${new URL(url).host}: ${(e as Error).message}`)
      }
    }
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)))
  }
  throw new Error('every Overpass endpoint failed')
}

async function fetchAll(): Promise<Element[]> {
  const out: Element[] = []
  const kinds = Object.entries(KINDS)
  const GROUP = 6
  for (let i = 0; i < kinds.length; i += GROUP) {
    const group = kinds.slice(i, i + GROUP)
    const sel = group.flatMap(([, spec]) => spec.selectors.map((s) => `  nwr${s}[name];`)).join('\n')
    const els = await overpass(`[out:json][timeout:60][bbox:${bbox(radius / 1000)}];\n(\n${sel}\n);\nout center tags;`)
    console.log(`${group.map(([k]) => k).join(', ')}: ${els.length}`)
    out.push(...els)
  }
  const districts = await overpass(
    `[out:json][timeout:60][bbox:${bbox((radius / 1000) * 2.5)}];node[place~"^(suburb|quarter|neighbourhood)$"][name];out;`,
  )
  console.log(`districts: ${districts.length}`)
  return [...out, ...districts]
}

function nameVariants(t: Record<string, string>): string[] {
  const keys = ['name', 'name:en', 'name:ru', 'name:uz', 'name:uz-Latn', 'name:uz-Cyrl', 'int_name', 'alt_name', 'old_name', 'short_name', 'brand']
  const out: string[] = []
  for (const k of keys) {
    for (const v of (t[k] ?? '').split(';')) {
      const s = v.trim()
      if (s && !out.includes(s)) out.push(s)
    }
  }
  return out
}

function address(t: Record<string, string>): string | null {
  const street = t['addr:street']
  if (!street) return null
  return [street, t['addr:housenumber']].filter(Boolean).join(' ')
}

const elements = await fetchAll()
const places: Place[] = []
const districts: District[] = []
const seen = new Set<string>()
for (const el of elements) {
  const t = el.tags ?? {}
  const pLat = el.lat ?? el.center?.lat
  const pLng = el.lon ?? el.center?.lon
  if (pLat == null || pLng == null || !t.name) continue
  const km = haversineKm(lat, lng, pLat, pLng)
  if (km > (radius / 1000) * (t.place ? 2.5 : 1)) continue
  const id = `osm:${el.type}/${el.id}`
  if (seen.has(id)) continue
  seen.add(id)
  const names = nameVariants(t)
  if (t.place) {
    districts.push({ id, name: t['name:en'] ?? t.name, names, lat: pLat, lng: pLng })
    continue
  }
  const kind = kindOfTags(t)
  if (!kind) continue
  places.push({
    id,
    name: t['name:en'] ?? t.name,
    names,
    kind,
    lat: Math.round(pLat * 1e6) / 1e6,
    lng: Math.round(pLng * 1e6) / 1e6,
    openingHours: t.opening_hours ?? null,
    address: address(t),
  })
}

const snapshot: CitySnapshot = {
  city: values.city!,
  tz: values.tz!,
  center: { lat, lng },
  radiusKm: radius / 1000,
  fetchedAt: new Date().toISOString(),
  attribution: '© OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)',
  places,
  districts,
}
await writeFile(values.out!, JSON.stringify(snapshot))
const byKind = Object.entries(
  places.reduce<Record<string, number>>((a, p) => ((a[p.kind] = (a[p.kind] ?? 0) + 1), a), {}),
).sort((a, b) => b[1] - a[1])
console.log(`${places.length} places, ${districts.length} districts -> ${values.out}`)
console.log(byKind.map(([k, n]) => `${k}:${n}`).join(' '))
