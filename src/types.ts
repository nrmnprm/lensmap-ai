export interface Place {
  /** Stable id such as `osm:node/123456`. */
  id: string
  /** Display name: the English name when OSM has one, otherwise the local name. */
  name: string
  /** Every name variant (local, en, ru, uz, alt, old), used for geocoding venues. */
  names: string[]
  kind: string
  lat: number
  lng: number
  /** OSM opening_hours tag as is, or null when unknown. */
  openingHours: string | null
  address: string | null
}

export interface District {
  id: string
  name: string
  names: string[]
  lat: number
  lng: number
}

export interface CitySnapshot {
  city: string
  tz: string
  center: { lat: number; lng: number }
  radiusKm: number
  fetchedAt: string
  attribution: string
  places: Place[]
  districts: District[]
}

export interface CityEvent {
  id: string
  title: string
  description: string | null
  venue: string | null
  lat: number
  lng: number
  /** ISO timestamp (UTC). */
  startsAt: string
  endsAt: string | null
  /** The point is a district or the city centre, not the venue itself. */
  approximate: boolean
  timeUnknown: boolean
  /** Where the event came from: bundled sample data or the extraction tab. */
  origin: 'sample' | 'extracted'
  sourceUrl: string | null
}

export interface Scenario {
  /** Local time of the demo clock, "HH:MM". */
  time: string
  weather: 'clear' | 'rain' | 'cold'
}
