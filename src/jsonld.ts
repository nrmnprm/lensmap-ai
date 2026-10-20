/** schema.org Event markup (JSON-LD), ported from LensMap
 * (daily_backend/src/citypulse/adapters.ts). Ticketing sites, theatres and
 * chains already publish dates, venue and coordinates in this form, so these
 * pages are parsed directly and never reach the model. */

export interface StructuredEvent {
  title: string
  description: string | null
  startsAt: string
  endsAt: string | null
  venue: string | null
  address: string | null
  lat: number | null
  lng: number | null
  url: string | null
  price: string | null
}

type Json = Record<string, unknown>

function text(v: unknown): string | null {
  if (typeof v === 'string') return v.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || null
  if (Array.isArray(v)) return text(v[0])
  if (v && typeof v === 'object') {
    const o = v as Json
    return text(o.name ?? o['@value'] ?? null)
  }
  return null
}

function address(v: unknown): string | null {
  if (typeof v === 'string') return text(v)
  if (v && typeof v === 'object') {
    const o = v as Json
    return [o.streetAddress, o.addressLocality].map(text).filter(Boolean).join(', ') || null
  }
  return null
}

/** The physical location: a Place object, the first Place of an array
 * (hybrid events list a VirtualLocation too), or a bare string name. */
function place(v: unknown): Json | null {
  if (typeof v === 'string') return v.trim() ? { name: v } : null
  const list = Array.isArray(v) ? v : [v]
  for (const x of list) {
    if (!x || typeof x !== 'object') continue
    const o = x as Json
    if (String(o['@type'] ?? '') === 'VirtualLocation') continue
    return o
  }
  return null
}

function isEventType(t: unknown): boolean {
  const types = Array.isArray(t) ? t : [t]
  return types.some((x) => typeof x === 'string' && (/Event$/.test(x) || x === 'Festival'))
}

/** Every schema.org event on the page, including @graph and nested nodes. */
export function parseLdEvents(html: string): StructuredEvent[] {
  const out: StructuredEvent[] = []
  const seen = new Set<string>()
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const n of node) visit(n)
      return
    }
    if (!node || typeof node !== 'object') return
    const o = node as Json
    if (isEventType(o['@type']) && typeof o.startDate === 'string' && text(o.name)) {
      const loc = place(o.location)
      const geo = (loc?.geo && typeof loc.geo === 'object' ? loc.geo : null) as Json | null
      const lat = geo ? Number(geo.latitude) : NaN
      const lng = geo ? Number(geo.longitude) : NaN
      const offer = (Array.isArray(o.offers) ? o.offers[0] : o.offers) as Json | undefined
      const price =
        offer && offer.price != null && Number(offer.price) > 0
          ? `${Number(offer.price).toLocaleString('en-US')} ${typeof offer.priceCurrency === 'string' ? offer.priceCurrency : ''}`.trim()
          : null
      const ev: StructuredEvent = {
        title: text(o.name)!,
        description: text(o.description),
        startsAt: o.startDate,
        endsAt: typeof o.endDate === 'string' ? o.endDate : null,
        venue: loc ? text(loc.name) : null,
        address: loc ? address(loc.address) : null,
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null,
        url: typeof o.url === 'string' && /^https?:/.test(o.url) ? o.url : null,
        price,
      }
      const k = `${ev.url ?? ev.title}|${ev.startsAt}`
      if (!seen.has(k)) {
        seen.add(k)
        out.push(ev)
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') visit(v)
  }
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(m[1].trim()))
    } catch {
      /* a broken block is skipped */
    }
  }
  return out
}
