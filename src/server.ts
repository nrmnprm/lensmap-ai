/** Demo server: static UI + JSON API, no framework. */
import './env.ts'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { advise, WEATHER } from './advisor.ts'
import { city, placeById } from './city.ts'
import { extractEvents, type SourcePost } from './extract.ts'
import { kindLabel } from './kinds.ts'
import { checkModel, llmStatus } from './llm.ts'
import { setCityWords } from './names.ts'
import { DEMO_DATE, localToDate, nearDemoDate } from './time.ts'
import type { CityEvent, Scenario } from './types.ts'

const PORT = Number(process.env.PORT ?? 4310)
const HOST = process.env.HOST ?? '127.0.0.1'
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PUBLIC = join(ROOT, 'public')

setCityWords([city.city, 'Toshkent', 'Ташкент'])

// ---- sample data ----

interface SampleEvent {
  id: string
  title: string
  description: string
  placeId: string
  /** Days after DEMO_DATE. */
  day: number
  time: string
  minutes: number
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const sampleEvents: CityEvent[] = (JSON.parse(readFileSync(join(ROOT, 'data/events.json'), 'utf8')) as SampleEvent[]).flatMap((e) => {
  const place = placeById.get(e.placeId)
  const startsAt = localToDate(addDays(DEMO_DATE, e.day), e.time, city.tz)
  if (!place || !startsAt) {
    console.warn(`sample event ${e.id}: unknown place ${e.placeId}`)
    return []
  }
  return [
    {
      id: e.id,
      title: e.title,
      description: e.description,
      venue: place.name,
      lat: place.lat,
      lng: place.lng,
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + e.minutes * 60000).toISOString(),
      approximate: false,
      timeUnknown: false,
      origin: 'sample' as const,
      sourceUrl: null,
    },
  ]
})
const samplePosts: SourcePost[] = JSON.parse(readFileSync(join(ROOT, 'data/posts.json'), 'utf8'))

// ---- helpers ----

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage, limit = 200_000): Promise<unknown> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'body too large')
    chunks.push(chunk as Buffer)
  }
  let body: unknown
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw new HttpError(400, 'invalid JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'expected a JSON object')
  return body
}

class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Live model calls cost money (or free-tier quota): a small per-IP budget.
 * The client address is the socket's; X-Forwarded-For is trusted only behind
 * a known proxy (TRUST_PROXY=1), and then only its last hop, which the proxy
 * itself appended. */
const hits = new Map<string, number[]>()
function clientIp(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY === '1') {
    const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (hops.length) return hops[hops.length - 1]
  }
  return req.socket.remoteAddress ?? ''
}
function rateLimit(req: IncomingMessage, bucket: string, perMinute: number) {
  if (llmStatus().mode !== 'live') return
  const key = `${bucket}:${clientIp(req)}`
  const now = Date.now()
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000)
  if (recent.length >= perMinute) throw new HttpError(429, 'too many requests, try again in a minute')
  recent.push(now)
  hits.set(key, recent)
}
setInterval(() => {
  const now = Date.now()
  for (const [key, times] of hits) if (!times.some((t) => now - t < 60_000)) hits.delete(key)
}, 60_000).unref()

const num = (v: unknown, min: number, max: number, dflt: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : dflt
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')

function scenarioOf(v: unknown): Scenario {
  const o = (v ?? {}) as Record<string, unknown>
  const time = typeof o.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(o.time) ? o.time : '18:30'
  const weather = o.weather === 'rain' || o.weather === 'cold' ? o.weather : 'clear'
  return { time, weather }
}

/** Events coming back from the browser are re-validated: only extracted
 * events with sane fields inside the city are accepted. */
function clientEvents(v: unknown): CityEvent[] {
  if (!Array.isArray(v)) return []
  const out: CityEvent[] = []
  for (const raw of v.slice(0, 60)) {
    if (!raw || typeof raw !== 'object') continue
    const e = raw as Record<string, unknown>
    const lat = num(e.lat, -90, 90, NaN)
    const lng = num(e.lng, -180, 180, NaN)
    const startsAt = str(e.startsAt, 40)
    if (!str(e.id, 80).startsWith('ext:') && !str(e.id, 80).startsWith('ld:')) continue
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Number.isNaN(Date.parse(startsAt))) continue
    out.push({
      id: str(e.id, 80),
      title: str(e.title, 80),
      description: str(e.description, 600) || null,
      venue: str(e.venue, 120) || null,
      lat,
      lng,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: e.endsAt && !Number.isNaN(Date.parse(String(e.endsAt))) ? new Date(String(e.endsAt)).toISOString() : null,
      approximate: e.approximate === true,
      timeUnknown: e.timeUnknown === true,
      origin: 'extracted',
      sourceUrl: null,
    })
  }
  return out
}

function postsOf(v: unknown): SourcePost[] {
  if (!Array.isArray(v)) throw new HttpError(400, 'posts must be an array')
  const used = new Set<string>()
  return v.slice(0, 16).flatMap((raw, i) => {
    if (!raw || typeof raw !== 'object') return []
    const p = raw as Record<string, unknown>
    // Ids must be unique: the model's answer is attributed to posts by id.
    let id = str(p.id, 20).replace(/[^\w-]/g, '') || `p${i + 1}`
    while (used.has(id)) id = `${id}x`
    used.add(id)
    return [{
      id,
      source: str(p.source, 80),
      kind: p.kind === 'html' ? ('html' as const) : ('text' as const),
      publishedAt: nearDemoDate(String(p.publishedAt ?? '')),
      text: str(p.text, p.kind === 'html' ? 20_000 : 3000),
      url: str(p.url, 300) || null,
    }]
  })
}

// ---- routes ----

async function api(req: IncomingMessage, res: ServerResponse, path: string) {
  if (req.method === 'GET' && path === '/api/meta') {
    return send(res, 200, {
      city: city.city,
      center: city.center,
      tz: city.tz,
      demoDate: DEMO_DATE,
      attribution: city.attribution,
      fetchedAt: city.fetchedAt,
      llm: llmStatus(),
      weather: Object.fromEntries(Object.entries(WEATHER).map(([k, v]) => [k, v.label])),
    })
  }
  if (req.method === 'GET' && path === '/api/places') {
    // Compact rows: [id, name, kind, kind label, lat, lng]
    return send(res, 200, city.places.map((p) => [p.id, p.name, p.kind, kindLabel(p.kind), p.lat, p.lng]))
  }
  if (req.method === 'GET' && path === '/api/events') return send(res, 200, sampleEvents)
  if (req.method === 'GET' && path === '/api/posts') return send(res, 200, samplePosts)
  if (req.method === 'POST' && path === '/api/advisor') {
    rateLimit(req, 'advisor', 10)
    const b = (await readJson(req)) as Record<string, unknown>
    const history = Array.isArray(b.history)
      ? b.history.slice(-20).flatMap((t) => {
          if (!t || typeof t !== 'object') return []
          const o = t as Record<string, unknown>
          return o.role === 'user' || o.role === 'assistant' ? [{ role: o.role as 'user' | 'assistant', text: str(o.text, 2000) }] : []
        })
      : []
    const out = await advise({
      query: str(b.query, 300),
      history,
      lat: num(b.lat, -90, 90, city.center.lat),
      lng: num(b.lng, -180, 180, city.center.lng),
      scenario: scenarioOf(b.scenario),
      events: [...sampleEvents, ...clientEvents(b.events)],
    })
    return send(res, 200, out)
  }
  if (req.method === 'POST' && path === '/api/extract') {
    rateLimit(req, 'extract', 4)
    const b = (await readJson(req, 400_000)) as Record<string, unknown>
    return send(res, 200, await extractEvents(postsOf(b.posts)))
  }
  throw new HttpError(404, 'not found')
}

async function serveStatic(res: ServerResponse, path: string) {
  let decoded: string
  try {
    decoded = decodeURIComponent(path === '/' ? '/index.html' : path)
  } catch {
    throw new HttpError(400, 'bad path')
  }
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  const file = join(PUBLIC, rel)
  if (!file.startsWith(PUBLIC)) throw new HttpError(403, 'forbidden')
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    throw new HttpError(404, 'not found')
  }
}

const server = createServer(async (req, res) => {
  try {
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      throw new HttpError(400, 'bad URL')
    }
    if (path.startsWith('/api/')) await api(req, res, path)
    else await serveStatic(res, path)
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    if (status === 500) console.error(e)
    if (!res.headersSent) send(res, status, { error: e instanceof Error ? e.message : 'error' })
  }
})

server.listen(PORT, HOST, async () => {
  console.log(`LensMap AI demo: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`)
  console.log(`${city.city}: ${city.places.length} places, ${sampleEvents.length} sample events, demo date ${DEMO_DATE}`)
  console.log(await checkModel())
  const st = llmStatus()
  console.log(st.mode === 'live' ? `LLM: live (${st.model})` : `LLM: replay/fallback only (${st.reason}); ${st.recordings} recorded answers`)
})
