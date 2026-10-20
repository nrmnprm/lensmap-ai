/** Events from messy announcements, ported from LensMap
 * (daily_backend/src/citypulse/extract.ts).
 *
 *   page with schema.org markup -> parsed directly, no model call
 *   free text (Telegram posts)  -> the model extracts title, date, time,
 *                                  venue and district, in batches of 8 posts
 *   venue                       -> coordinates from the map data, never from
 *                                  the model; district or city centre as an
 *                                  approximate fallback, marked as such
 *
 * Processed posts are cached by a hash of their content, so a crawl that
 * runs every few hours does not pay for the same post twice. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { city } from './city.ts'
import { geocodeVenue, placeEvent, venueInText, type GeoHit } from './geocode.ts'
import { haversineKm } from './geo.ts'
import { extractJson } from './json.ts'
import { parseLdEvents } from './jsonld.ts'
import { chat, llmStatus, type Usage } from './llm.ts'
import { DEMO_DATE, isRealDate, localToDate, nearDemoDate } from './time.ts'
import type { CityEvent } from './types.ts'

export interface SourcePost {
  id: string
  /** Display label, e.g. "Telegram · @channel". */
  source: string
  kind: 'text' | 'html'
  /** YYYY-MM-DD */
  publishedAt: string
  text: string
  url?: string | null
}

interface RawEvent {
  post?: string
  title?: string
  date?: string
  time?: string | null
  endTime?: string | null
  venue?: string | null
  address?: string | null
  district?: string | null
  summary?: string | null
  weekday?: string | null
}

export interface PostTrace {
  postId: string
  method: 'llm' | 'jsonld'
  /** cache: answer from an earlier run; live: this request; missing: no key and no cache. */
  status: 'cache' | 'live' | 'missing' | 'failed' | 'parsed'
  /** Model that produced the events (for cached results: the model of the original run). */
  model?: string
  raw: unknown[]
  kept: string[]
  dropped: { title: string; reason: string }[]
  /** Dates the server corrected (weekday named in the post vs the model's date). */
  fixed: { title: string; note: string }[]
}

export interface ExtractTrace {
  today: string
  model: string
  calls: { postIds: string[]; ok: boolean; error?: string; latencyMs: number; usage: Usage | null; prompt: { system: string; user: string } }[]
  posts: PostTrace[]
  geocode: { eventId: string; query: string; via: 'venue' | 'district' | 'city'; label: string | null; score: number | null }[]
}

const HORIZON_DAYS = 21
/** Posts per model call. Small local models do better with smaller batches. */
const BATCH = Math.max(1, Number(process.env.EXTRACT_BATCH) || 8)
const MAX_PER_POST = 4
/** Bump when the prompt changes: cached results of the old prompt are ignored. */
const PROMPT_VERSION = 'events-v5-demo'
const CACHE_FILE = process.env.EXTRACT_CACHE_FILE ?? fileURLToPath(new URL('../data/extract-cache.json', import.meta.url))

// ---- per-post cache ----

interface CachedPost {
  events: RawEvent[]
  model: string
  recordedAt: string
}

let postCache: Record<string, CachedPost> = {}
try {
  if (existsSync(CACHE_FILE)) postCache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
} catch {
  postCache = {}
}

function hash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12)
}

function postKey(p: SourcePost): string {
  return hash([PROMPT_VERSION, DEMO_DATE, city.city, p.publishedAt, p.text].join('|'))
}

function saveCache() {
  if (process.env.LLM_CACHE_WRITE === '0') return
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(postCache, null, 1))
  } catch {
    /* read-only deployment */
  }
}

// ---- the model step ----

/** Weekday names of every date the model may need: small models cannot do
 * "this Saturday" arithmetic reliably, a lookup table they can. */
function calendar(from: string, days: number): string {
  const out: string[] = []
  const d = new Date(`${from}T12:00:00Z`)
  for (let i = 0; i <= days; i++) {
    out.push(`${new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(d)} ${d.toISOString().slice(0, 10)}`)
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return out.join(', ')
}

export function extractionPrompt(posts: SourcePost[]): { system: string; user: string } {
  const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${DEMO_DATE}T12:00:00Z`))
  const first = [DEMO_DATE, ...posts.map((p) => nearDemoDate(p.publishedAt))].sort()[0]
  const span = Math.round((Date.parse(DEMO_DATE) - Date.parse(first)) / 86400000) + HORIZON_DAYS
  const system = [
    `You extract events from announcements for the city of ${city.city}: channel posts, news items, pieces of web pages.`,
    `Today is ${DEMO_DATE} (${weekday}). Texts may be in Russian, Uzbek, English or another language; write title and summary IN ENGLISH.`,
    `Calendar: ${calendar(first, span)}.`,
    'Take ONLY events with a specific date (day and month), not earlier than today and not later than 3 weeks from today. Relative dates ("tomorrow", "this Saturday") count from the date the post was published; find the date in the calendar.',
    'Skip: team recruiting, vacancies, registrations without the date of the event itself, online meetings, past events, advertising.',
    'If the year is not given, use the nearest suitable one (this year or next). If the time is not given, time: null.',
    'venue: the place exactly as written in the post, in the original language and script, do not translate it (cafe, park, theatre, address); address: street and building if given. district: district, neighbourhood, mahalla or landmark ("near the Central Market") when the venue is not named or unknown. Never invent times or addresses.',
    'weekday: the day of the week as the post names it for this event ("this Friday" -> "Fri", "yakshanba" -> "Sun"), null if the post names none.',
    `One post may describe several events (a programme for the day): return each separately, at most ${MAX_PER_POST} per post.`,
    'Return STRICTLY one JSON object without explanations:',
    '{"events":[{"post":"post id","title":"up to 60 characters","date":"YYYY-MM-DD","weekday":"Mon..Sun or null","time":"HH:MM or null","endTime":"HH:MM or null","venue":"place or null","address":"address or null","district":"district/landmark or null","summary":"1-2 sentences in English"}]}',
    'If there are no events: {"events":[]}',
  ].join('\n')
  const user = posts
    .map((p) => `### post=${p.id} (published ${p.publishedAt})\n${p.text.length > 1500 ? p.text.slice(0, 1500) + '…' : p.text}`)
    .join('\n\n')
  return { system, user }
}

// ---- post-processing ----

const TIME_RE = /^\d{1,2}:\d{2}$/

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** Weekday words in English, Russian and Uzbek (Latin and Cyrillic), with
 * their grammatical forms. Index = Date.getUTCDay(). */
const WEEKDAY_RE: RegExp[] = [
  /(sunday|воскресень[ея]|yakshanba|якшанба)/iu,
  /(monday|понедельник[а]?|dushanba|душанба)/iu,
  /(tuesday|вторник[а]?|seshanba|сешанба)/iu,
  /(wednesday|сред[ауы](?!\p{L})|chorshanba|чоршанба)/iu,
  /(thursday|четверг[а]?|payshanba|пайшанба)/iu,
  /(friday|пятниц[аеуы]|juma(?!\p{L})|жума(?!\p{L}))/iu,
  /(saturday|суббот[аеуы]|(?<![\p{L}])shanba|(?<![\p{L}])шанба)/iu,
]

/** Weekdays the post itself names. `\b` does not work for Cyrillic in JS,
 * so the start of the word is checked by hand. */
export function weekdaysIn(text: string): Set<number> {
  const out = new Set<number>()
  WEEKDAY_RE.forEach((re, day) => {
    const g = new RegExp(re.source, 'giu')
    for (const m of text.matchAll(g)) {
      const before = m.index === 0 ? ' ' : text[m.index - 1]
      if (!/[\p{L}\p{N}]/u.test(before)) {
        out.add(day)
        break
      }
    }
  })
  return out
}

const MONTHS =
  'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря|' +
  'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|' +
  'yanvar|fevral|mart|aprel|iyun|iyul|avgust|sentabr|oktabr|noyabr|dekabr'
const EXPLICIT_DATE = [
  // Uzbek adds case suffixes to the month: "11-oktabrda", "oktabrgacha".
  new RegExp(`(?<!\\d)\\d{1,2}(?:st|nd|rd|th)?[\\s-]+(?:${MONTHS})(?:da|dan|ga|gacha)?(?!\\p{L})`, 'iu'),
  new RegExp(`(?<!\\p{L})(?:${MONTHS})\\.?\\s+\\d{1,2}(?!\\d)`, 'iu'),
  /(?<![\d.:])\d{1,2}[./]\d{1,2}(?![\d:])/,
]

/** Does the post give a day and a month ("10 октября", "Oct 10", "11-oktabr", "10.10")? */
export function hasExplicitDate(text: string): boolean {
  return EXPLICIT_DATE.some((re) => re.test(text))
}

/** Small models often get "this Friday" wrong while naming the weekday
 * correctly. When the weekday the model reports is also written in the post
 * and the model's date falls on another day, the event moves to the first
 * such weekday on or after the publication date. Nothing changes when the
 * post gives an explicit day and month (the model copied a number, trust it)
 * or when the post and the model do not agree on the weekday. */
export function reconcileWeekday(r: RawEvent, post: { text: string; publishedAt: string }): { date: string; note: string } | null {
  if (!r.date || !isRealDate(String(r.date)) || hasExplicitDate(post.text)) return null
  const named = weekdaysIn(post.text)
  if (!named.size) return null
  const claimed = WEEKDAYS.indexOf(String(r.weekday ?? '').trim().toLowerCase().slice(0, 3))
  if (!named.has(claimed)) return null
  const want = claimed
  if (new Date(`${r.date}T12:00:00Z`).getUTCDay() === want) return null
  const d = new Date(`${nearDemoDate(post.publishedAt)}T12:00:00Z`)
  for (let i = 0; i < 7 && d.getUTCDay() !== want; i++) d.setUTCDate(d.getUTCDate() + 1)
  const date = d.toISOString().slice(0, 10)
  const label = (s: string) =>
    new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${s}T12:00:00Z`))
  const dayName = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(d)
  return { date, note: `model said ${label(String(r.date))}, the post says ${dayName} → ${label(date)}` }
}

/** Why a raw event cannot be used, or null when it can. */
export function rejectReason(r: RawEvent, now: Date, tz: string): string | null {
  if (!r.title || !String(r.title).trim()) return 'no title'
  if (!r.date || !isRealDate(String(r.date))) return `bad date "${r.date ?? ''}"`
  if (r.time != null && !TIME_RE.test(String(r.time))) return `bad time "${r.time}"`
  const startsAt = localToDate(String(r.date), r.time ?? null, tz)
  if (!startsAt) return 'unparseable date'
  if (startsAt.getTime() < now.getTime() - 2 * 3600 * 1000) return 'already over'
  if (startsAt.getTime() > now.getTime() + HORIZON_DAYS * 86400 * 1000) return `more than ${HORIZON_DAYS} days ahead`
  return null
}

function toEvent(
  r: RawEvent,
  post: SourcePost,
  tz: string,
  trace: ExtractTrace,
): CityEvent {
  const startsAt = localToDate(String(r.date), r.time ?? null, tz)!
  let endsAt = r.endTime && TIME_RE.test(String(r.endTime)) ? localToDate(String(r.date), String(r.endTime), tz) : null
  if (endsAt && endsAt <= startsAt) endsAt = null
  const venue = r.venue ? String(r.venue).trim() : null
  const address = r.address ? String(r.address).trim() : null
  const district = r.district ? String(r.district).trim() : null
  const id = `ext:${post.id}:${hash(`${r.title}|${venue ?? ''}|${r.date}|${r.time ?? ''}`)}`
  let hit: GeoHit | null = venue || address || district ? geocodeVenue(venue, address, district) : null
  // A venue was named but nothing was found (translated, misspelt): look for
  // a known place written in the original post.
  if (venue && !hit) hit = venueInText(post.text)
  const placeLine = [venue, address].filter(Boolean).join(', ')
  const at = placeEvent(hit, placeLine, district, id)
  trace.geocode.push({
    eventId: id,
    query: [venue, address, district].filter(Boolean).join(' | ') || '(nothing)',
    via: at.via,
    label: hit?.label ?? null,
    score: hit ? Math.round(hit.score * 100) / 100 : null,
  })
  const notes: string[] = []
  if (r.summary) notes.push(String(r.summary).trim())
  if (!r.time) notes.push('The post gives no start time.')
  if (at.note) notes.push(at.note)
  return {
    id,
    title: String(r.title).trim().slice(0, 80),
    description: notes.join(' ') || null,
    venue: hit?.via === 'venue' ? hit.label : placeLine || district,
    lat: at.lat,
    lng: at.lng,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt?.toISOString() ?? null,
    approximate: at.note != null,
    timeUnknown: !r.time,
    origin: 'extracted',
    sourceUrl: post.url ?? null,
  }
}

function structuredEvents(post: SourcePost, now: Date, tz: string, trace: ExtractTrace): { events: CityEvent[]; pt: PostTrace } {
  const items = parseLdEvents(post.text)
  const pt: PostTrace = { postId: post.id, method: 'jsonld', status: 'parsed', raw: items, kept: [], dropped: [], fixed: [] }
  const events: CityEvent[] = []
  for (const it of items) {
    const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}:\d{2}))?/.exec(it.startsAt)
    const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(it.startsAt)
    const startsAt = !m || !isRealDate(m[1]) ? null : hasOffset ? new Date(it.startsAt) : localToDate(m[1], m[2] ?? null, tz)
    if (!startsAt || Number.isNaN(startsAt.getTime())) {
      pt.dropped.push({ title: it.title, reason: `bad startDate "${it.startsAt}"` })
      continue
    }
    if (startsAt.getTime() < now.getTime() - 2 * 3600 * 1000) {
      pt.dropped.push({ title: it.title, reason: 'already over' })
      continue
    }
    const id = `ld:${post.id}:${hash(`${it.title}|${it.startsAt}`)}`
    // Coordinates from the markup are trusted only inside the city.
    const inCity = it.lat != null && it.lng != null && haversineKm(city.center.lat, city.center.lng, it.lat, it.lng) <= 40
    const hit: GeoHit | null = inCity
      ? { lat: it.lat!, lng: it.lng!, via: 'venue', label: it.venue ?? it.title, placeId: null, score: 1 }
      : geocodeVenue(it.venue, it.address, null)
    const placeLine = [it.venue, it.address].filter(Boolean).join(', ')
    const at = placeEvent(hit, placeLine, null, id)
    trace.geocode.push({
      eventId: id,
      query: inCity ? 'schema.org geo coordinates' : placeLine || '(nothing)',
      via: at.via,
      label: hit?.label ?? null,
      score: hit ? Math.round(hit.score * 100) / 100 : null,
    })
    const endsAt = it.endsAt ? new Date(it.endsAt) : null
    events.push({
      id,
      title: it.title.slice(0, 80),
      description: [it.description, it.price ? `Tickets from ${it.price}.` : null, at.note].filter(Boolean).join(' ') || null,
      venue: it.venue,
      lat: at.lat,
      lng: at.lng,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt && !Number.isNaN(endsAt.getTime()) && endsAt > startsAt ? endsAt.toISOString() : null,
      approximate: at.note != null,
      timeUnknown: !m?.[2],
      origin: 'extracted',
      sourceUrl: it.url ?? post.url ?? null,
    })
    pt.kept.push(id)
  }
  return { events, pt }
}

/** Post ids as models write them back: "p3", "post=p3", "#p3" or just "3". */
export function postLabel(label: unknown, ids: Set<string>): string {
  const s = String(label ?? '').trim().replace(/^(?:post\s*[=:#]?\s*|#)/i, '')
  if (ids.has(s)) return s
  if (/^\d+$/.test(s) && ids.has(`p${s}`)) return `p${s}`
  return s
}

/** The crawler's "now": the morning of the demo date. */
function crawlNow(tz: string): Date {
  return localToDate(DEMO_DATE, '08:00', tz)!
}

export async function extractEvents(posts: SourcePost[]): Promise<{ events: CityEvent[]; trace: ExtractTrace }> {
  const tz = city.tz
  const now = crawlNow(tz)
  const trace: ExtractTrace = { today: DEMO_DATE, model: llmStatus().model, calls: [], posts: [], geocode: [] }
  const events: CityEvent[] = []
  const byId = new Map(posts.map((p) => [p.id, p]))

  // 1. Structured pages: no model at all.
  for (const p of posts.filter((p) => p.kind === 'html')) {
    const got = structuredEvents(p, now, tz, trace)
    events.push(...got.events)
    trace.posts.push(got.pt)
  }

  // 2. Free text: cache first, then the model in batches.
  const textPosts = posts.filter((p) => p.kind === 'text')
  const raw = new Map<string, { events: RawEvent[]; status: PostTrace['status']; model?: string }>()
  const missing: SourcePost[] = []
  for (const p of textPosts) {
    const hit = postCache[postKey(p)]
    if (hit) raw.set(p.id, { events: hit.events, status: 'cache', model: hit.model })
    else missing.push(p)
  }
  const live = llmStatus().mode === 'live'
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH)
    if (!live) {
      for (const p of batch) raw.set(p.id, { events: [], status: 'missing' })
      continue
    }
    const prompt = extractionPrompt(batch)
    // A batch of posts is a long answer, and reasoning models think first.
    const res = await chat({ ...prompt, temperature: 0.2, maxTokens: 8000, record: false })
    const parsed = res.ok ? extractJson(res.content) : null
    const got = Array.isArray(parsed?.events) ? (parsed!.events as RawEvent[]) : null
    trace.calls.push({
      postIds: batch.map((p) => p.id),
      ok: got !== null,
      error: res.ok ? (got ? undefined : 'no {"events": [...]} in the reply') : res.error,
      latencyMs: res.latencyMs,
      usage: res.ok ? res.usage : null,
      prompt,
    })
    const ids = new Set(batch.map((p) => p.id))
    const labelled = (got ?? []).map((e) => ({ e, post: postLabel(e.post, ids) }))
    // Events with a post label we cannot place: a post that got nothing in
    // this batch may be the one they belong to, so its "no events" is not
    // cached and the post is read again next time.
    const unplaced = labelled.some((x) => !ids.has(x.post))
    for (const p of batch) {
      if (!got) {
        raw.set(p.id, { events: [], status: 'failed' })
        continue
      }
      const mine = labelled.filter((x) => x.post === p.id).map((x) => ({ ...x.e, post: p.id }))
      raw.set(p.id, { events: mine, status: 'live', model: res.ok ? res.model : undefined })
      if (mine.length || !unplaced) {
        postCache[postKey(p)] = { events: mine, model: res.ok ? res.model : '', recordedAt: new Date().toISOString() }
      }
    }
    if (got) saveCache()
  }

  // 3. Validate, geocode, deduplicate.
  const seen = new Set<string>()
  for (const p of textPosts) {
    const r = raw.get(p.id)!
    const pt: PostTrace = { postId: p.id, method: 'llm', status: r.status, model: r.model, raw: r.events, kept: [], dropped: [], fixed: [] }
    for (const raw of r.events.slice(0, MAX_PER_POST)) {
      const fix = reconcileWeekday(raw, p)
      const e = fix ? { ...raw, date: fix.date } : raw
      if (fix) pt.fixed.push({ title: String(raw.title ?? '(untitled)'), note: fix.note })
      const reason = rejectReason(e, now, tz)
      if (reason) {
        pt.dropped.push({ title: String(e.title ?? '(untitled)'), reason })
        continue
      }
      const ev = toEvent(e, byId.get(p.id)!, tz, trace)
      if (seen.has(ev.id)) {
        pt.dropped.push({ title: ev.title, reason: 'duplicate' })
        continue
      }
      seen.add(ev.id)
      events.push(ev)
      pt.kept.push(ev.id)
    }
    if (r.events.length > MAX_PER_POST) pt.dropped.push({ title: `${r.events.length - MAX_PER_POST} more`, reason: `over ${MAX_PER_POST} per post` })
    trace.posts.push(pt)
  }
  trace.posts.sort((a, b) => posts.findIndex((p) => p.id === a.postId) - posts.findIndex((p) => p.id === b.postId))
  events.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  return { events, trace }
}
