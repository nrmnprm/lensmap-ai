/** The grounded advisor, ported from LensMap
 * (daily_backend/src/routes/advisor.ts).
 *
 * The model answers "where should I go?" from a context the server builds:
 * the weather, events of the next 48 hours and real places near the user.
 * It may recommend only what is in that context and must return the ids of
 * what it named. The server then checks the answer:
 *   - ids that are not in the context are dropped (the model made them up);
 *   - places named in the text without an id are matched by name on word
 *     boundaries and attached anyway, so every recommendation gets a card;
 *   - cards are ordered as they are mentioned in the text.
 * Without a model (no key, provider down) the advisor still answers from a
 * template over the same context. */
import { city, diversePlaces, namedPlaces, nearestPlaces } from './city.ts'
import { fmtKm, haversineKm } from './geo.ts'
import { openLabel, openState } from './hours.ts'
import { extractJson, stripThink } from './json.ts'
import { INDOOR_KINDS, LEISURE_KINDS, kindLabel, kindsForQuery } from './kinds.ts'
import { chat, type ChatTurn, type Usage } from './llm.ts'
import { mentionedIn, tokens } from './names.ts'
import { demoNow, fmtDate, fmtNow, fmtWhen, localDay, localToDate } from './time.ts'
import type { CityEvent, Place, Scenario } from './types.ts'

const HISTORY_MAX = 10
const HORIZON_HOURS = 48

export const WEATHER: Record<Scenario['weather'], { line: string; label: string }> = {
  clear: { line: 'Weather now: clear, +24°C, light wind. Sunset at 18:02.', label: 'Clear, +24°C' },
  rain: { line: 'Weather now: steady rain, +13°C, rain until late evening. Sunset at 18:02.', label: 'Rain, +13°C' },
  cold: { line: 'Weather now: clear and cold, +6°C, gusty wind. Sunset at 18:02.', label: 'Cold, +6°C' },
}

export interface AdvisorRequest {
  query: string
  history: { role: 'user' | 'assistant'; text: string }[]
  lat: number
  lng: number
  scenario: Scenario
  events: CityEvent[]
  /** Demo switch: append a made-up place to the model's answer before the
   * check, so a visitor can watch it being rejected. */
  inject?: boolean
}

export interface Card {
  id: string
  type: 'place' | 'event'
  title: string
  subtitle: string
  lat: number
  lng: number
  approximate?: boolean
}

export interface AdvisorTrace {
  mode: 'direct' | 'general'
  kinds: string[]
  now: string
  context: { events: number; places: number; closed: number }
  prompt: { system: string; user: string }
  model: {
    source: 'live' | 'replay' | 'fallback'
    name: string | null
    latencyMs: number
    usage: Usage | null
    recordedAt?: string
    error?: string
    /** Why the first answer was rejected and the model asked again. */
    retry?: string
    raw: string | null
    parsedJson: boolean
  }
  /** cited: valid ids from the model; recovered: named in the text without
   * an id; rejected: ids not in the context; hidden: cited but never named.
   * rows: the same, one row per id, in the order the model cited them. */
  verification: { cited: string[]; recovered: string[]; rejected: string[]; hidden: string[]; rows: CheckRow[] }
  /** Set when the visitor asked for a made-up id; applied is false when there
   * was no model output to add it to (template answer). */
  injected?: { id: string; name: string; sentence: string; applied: boolean }
}

export interface CheckRow {
  id: string
  /** Was this id handed to the model in this request's context? */
  inContext: boolean
  result: 'kept' | 'recovered' | 'rejected' | 'hidden'
  name: string | null
}

export interface AdvisorResponse {
  text: string
  cards: Card[]
  trace: AdvisorTrace
}

interface CtxPlace {
  place: Place
  km: number
  open: string
}

function lang(query: string): 'ru' | 'en' {
  return /[а-яё]/i.test(query) ? 'ru' : 'en'
}

export const SYSTEM_PROMPT = [
  'You are a friendly city guide inside LensMap, a city map for a circle of friends.',
  "Answer in the language of the user's question, briefly (up to 90 words), warmly and concretely.",
  'Write plain text: no Markdown, no ** and no numbered lists, never mention ids.',
  'Recommend ONLY events and places from the lists in the context. Invent nothing and write names exactly as in the list.',
  'Every place or event you name in the text must also go into placeIds / eventIds.',
  'If the question is specific (where to eat, the nearest park, a shopping centre, a pharmacy, a bank and so on), answer to the point: 2-4 fitting options with distance and opening hours, no advice on how to spend the day, no walks or weather unless asked.',
  'If the question is general (where to go, what to do), suggest 1-3 ideas that fit the time of day and the weather.',
  'Places may be marked "open until ..." or "closed ...": never send anyone to a closed place; with no mark the hours are unknown, say so when it matters.',
  'If nothing in the lists fits a specific question, say honestly that nothing like that was found nearby in the database, and do NOT substitute a walk or a coffee.',
  'This is a conversation: take earlier turns into account ("anything cheaper?", "what else?", "closer?").',
  'Return STRICTLY one JSON object with nothing around it:',
  '{"text": "your answer", "eventIds": ["ids of events from the list"], "placeIds": ["ids of places from the list"]}',
].join('\n')

const FOLLOW_UP = /closer|nearer|cheaper|another|else|more|поближе|ближе|подешевле|дешевле|ещё|еще|друг(ой|ое|ие|ую)|а если/i

/** Categories of the question. A short follow-up ("anything closer?") has no
 * category of its own and keeps the one of the previous question, otherwise
 * the context would no longer contain what the conversation is about. Only
 * the last question counts, and only for short follow-ups: "What else is on
 * in town tonight?" is a new question. */
export function intentKinds(query: string, history: ChatTurn[]): string[] {
  const own = kindsForQuery(query)
  const words = query.split(/\s+/).filter(Boolean).length
  if (own.length || words > 4 || !FOLLOW_UP.test(query)) return own
  const last = [...history].reverse().find((t) => t.role === 'user')
  return last ? kindsForQuery(last.content) : own
}

const RETRY_NOTE = 'Your previous answer was rejected. Answer ONLY in the language of the user question, in plain text inside the JSON.'

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/

/** The answer text: the "text" field when the reply is JSON (an empty field
 * stays empty, the raw JSON is never shown), otherwise the reply itself. */
export function answerText(content: string, parsed: Record<string, unknown> | null): string {
  const text = parsed ? String(parsed.text ?? '').trim() : stripThink(content)
  // Ids belong in the JSON fields, never in what the user reads.
  const ID = String.raw`(?:id\s*[=:]\s*)?(?:osm:(?:node|way|relation)/\d+|(?:ext|ld):[\w-]+(?::[\w-]+)*|ev-[a-z0-9-]+)`
  return text
    .replace(new RegExp(String.raw`\s*\(\s*${ID}\s*\)`, 'gi'), '')
    .replace(new RegExp(String.raw`\s*${ID}`, 'gi'), '')
    .trim()
}

/** What is wrong with a model answer, or null when it can be shown. */
export function answerProblem(content: string, query: string): string | null {
  const text = answerText(content, extractJson(content))
  if (!text) return 'empty answer'
  if (CJK.test(text) && !CJK.test(query)) return 'answer contains text in another script'
  // "пlov": one word in two alphabets, a typical small-model glitch.
  if (text.split(/[^\p{L}]+/u).some((w) => /[а-яё]/i.test(w) && /[a-z]/i.test(w))) return 'a word mixes two alphabets'
  // A Russian question needs a Russian answer; names of places may stay in
  // Latin script, so count Russian words rather than letters.
  const cyrWords = (s: string) => (s.match(/[а-яё]{2,}/gi) ?? []).length
  const latWords = (s: string) => (s.match(/[a-z]{2,}/gi) ?? []).length
  if (cyrWords(query) > latWords(query) && cyrWords(text) < 2) return 'answer is not in the language of the question'
  return null
}

export async function advise(req: AdvisorRequest): Promise<AdvisorResponse> {
  const tz = city.tz
  const now = demoNow(req.scenario.time, tz)
  const query = req.query.trim() || 'What is interesting nearby today?'
  const history: ChatTurn[] = req.history
    .filter((t) => t.text.trim())
    .slice(-HISTORY_MAX)
    .map((t) => ({ role: t.role, content: t.text.trim() }))

  // Specific question -> categories; otherwise the general "where to go" mode.
  const kinds = intentKinds(query, history)
  const direct = kinds.length > 0

  // Events of the next 48 hours near the user.
  // An event without a start time lasts the whole day it is on.
  const endOf = (e: CityEvent) => {
    if (e.endsAt) return Date.parse(e.endsAt)
    if (e.timeUnknown) return localToDate(localDay(new Date(e.startsAt), tz), '23:59', tz)?.getTime() ?? Date.parse(e.startsAt)
    return Date.parse(e.startsAt) + 2 * 3600 * 1000
  }
  const pool = req.events
    .filter((e) => endOf(e) > now.getTime() && Date.parse(e.startsAt) < now.getTime() + HORIZON_HOURS * 3600 * 1000)
    .filter((e) => haversineKm(req.lat, req.lng, e.lat, e.lng) <= 25)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))
    .slice(0, 20)

  // Places: by category for a specific question (nearest first, radius grows
  // when nothing is near) plus a leisure baseline, so the next turn of the
  // dialogue has something to stand on.
  // Open now first, then unknown hours, then closed: "nearest pharmacy" at
  // 23:30 means an open one.
  const openRank = (p: Place) => {
    const st = openState(p.openingHours, tz, now)
    return st == null ? 1 : st.open ? 0 : 2
  }
  const namedIds = new Set<string>()
  let places: Place[]
  if (direct) {
    let wanted = nearestPlaces(req.lat, req.lng, kinds, 4, 40)
    if (wanted.length < 4) wanted = nearestPlaces(req.lat, req.lng, kinds, 15, 40)
    wanted = wanted
      .map((p, i) => ({ p, i }))
      .sort((a, b) => openRank(a.p) - openRank(b.p) || a.i - b.i)
      .slice(0, 16)
      .map((x) => x.p)
    // Places named after what was asked ("plov") go first, even if farther.
    const named = namedPlaces(query, req.lat, req.lng, kinds, 8, 6)
    named.forEach((p) => namedIds.add(p.id))
    wanted = [...named, ...wanted.filter((p) => !namedIds.has(p.id))].slice(0, 18)
    const ids = new Set(wanted.map((p) => p.id))
    const baseline = diversePlaces(req.lat, req.lng, LEISURE_KINDS, 5, 10).filter((p) => !ids.has(p.id))
    places = [...wanted, ...baseline]
  } else {
    const prefer = req.scenario.weather === 'clear' ? new Set<string>() : INDOOR_KINDS
    places = diversePlaces(req.lat, req.lng, LEISURE_KINDS, 5, 18, prefer)
  }
  const ctxPlaces: CtxPlace[] = places.map((place) => ({
    place,
    km: haversineKm(req.lat, req.lng, place.lat, place.lng),
    open: openLabel(place.openingHours, tz, now),
  }))
  if (direct) {
    // Closed places last whatever their name; among the rest, places named
    // after the request first, then open before unknown hours, then distance.
    const closed = (c: CtxPlace) => (openRank(c.place) === 2 ? 1 : 0)
    const named = (c: CtxPlace) => (namedIds.has(c.place.id) ? 0 : 1)
    ctxPlaces.sort((a, b) => closed(a) - closed(b) || named(a) - named(b) || openRank(a.place) - openRank(b.place) || a.km - b.km)
  }

  const when = (e: CityEvent) =>
    e.timeUnknown ? `${fmtDate(new Date(e.startsAt), tz)}, time not given` : fmtWhen(new Date(e.startsAt), tz)
  const eventLine = (e: CityEvent) =>
    `- id=${e.id} | ${e.title} | ${when(e)}${e.venue ? ` | ${e.venue}` : ''}${
      e.approximate ? ' | exact place unknown' : ` · ${fmtKm(haversineKm(req.lat, req.lng, e.lat, e.lng))} from you`
    }`
  const placeLine = (c: CtxPlace) =>
    `- id=${c.place.id} | ${c.place.name} | ${kindLabel(c.place.kind)} | ${c.open || 'hours unknown'}${
      c.place.address ? ` | ${c.place.address}` : ''
    } · ${fmtKm(c.km)} from you`
  const wantedSet = new Set(kinds)
  const wantedLines = direct ? ctxPlaces.filter((c) => wantedSet.has(c.place.kind)).map(placeLine) : []
  const otherLines = ctxPlaces.filter((c) => !direct || !wantedSet.has(c.place.kind)).map(placeLine)
  const labels = [...new Set(kinds.map(kindLabel))].join(', ')

  const user = [
    `Now: ${fmtNow(now, tz)}. City: ${city.city}.`,
    direct ? `The question is specific, categories: ${labels}. Matching places are listed below: open now first, then by distance.` : '',
    WEATHER[req.scenario.weather].line,
    wantedLines.length
      ? `Places for the question (${labels}):\n${wantedLines.join('\n')}`
      : direct
        ? `No places of the kind "${labels}" were found nearby in the database.`
        : '',
    pool.length ? `Events nearby (next 48 hours):\n${pool.map(eventLine).join('\n')}` : direct ? '' : 'The list of events is empty.',
    otherLines.length
      ? `${direct ? 'Other places nearby (only if the user asks about them)' : 'Places nearby'}:\n${otherLines.join('\n')}`
      : '',
    `User question: ${query}`,
  ]
    .filter(Boolean)
    .join('\n\n')

  const trace: AdvisorTrace = {
    mode: direct ? 'direct' : 'general',
    kinds,
    now: fmtNow(now, tz),
    context: {
      events: pool.length,
      places: ctxPlaces.length,
      closed: ctxPlaces.filter((c) => openState(c.place.openingHours, tz, now)?.open === false).length,
    },
    prompt: { system: SYSTEM_PROMPT, user },
    model: { source: 'fallback', name: null, latencyMs: 0, usage: null, raw: null, parsedJson: false },
    verification: { cited: [], recovered: [], rejected: [], hidden: [], rows: [] },
    injected: req.inject ? { ...INJECTED, applied: false } : undefined,
  }

  let res = await chat({ system: SYSTEM_PROMPT, user, history, temperature: 0.5 })
  // Output guard: a broken answer (wrong script, empty) gets one retry with a
  // stricter instruction, then the template takes over.
  const problem = res.ok ? answerProblem(res.content, query) : null
  if (problem) {
    trace.model.retry = problem
    const latency = res.latencyMs
    res = await chat({ system: `${SYSTEM_PROMPT}\n${RETRY_NOTE}`, user, history, temperature: 0.2 })
    if (res.ok) res.latencyMs += latency
    const again = res.ok ? answerProblem(res.content, query) : null
    if (again) res = { ok: false, error: `answer rejected twice: ${again}`, latencyMs: res.latencyMs }
  }
  if (!res.ok) {
    trace.model.error = res.error
    trace.model.latencyMs = res.latencyMs
    return fallback(query, direct, kinds, pool, ctxPlaces, req, tz, now, trace)
  }
  trace.model = {
    retry: trace.model.retry,
    source: res.source,
    name: res.model,
    latencyMs: res.latencyMs,
    usage: res.usage,
    recordedAt: res.recordedAt,
    raw: res.content,
    parsedJson: false,
  }

  let parsed = extractJson(res.content)
  trace.model.parsedJson = parsed != null
  let text = answerText(res.content, parsed)
  // The raw output in the trace stays what the model said.
  if (req.inject) {
    ;({ text, parsed } = injectFake(text, parsed))
    trace.injected = { ...INJECTED, applied: true }
  }
  const verified = verify(text, parsed, pool, ctxPlaces, query)
  trace.verification = verified.verification
  return { text, cards: cards(text, verified.events, verified.places, req, tz), trace }
}

/** The made-up place of the demo switch: the same shape as a real
 * hallucination (an id that looks valid, a name in the prose). No place in
 * the snapshot has this id. */
export const INJECTED = {
  id: 'osm:node/999',
  name: 'Hotel Imaginary',
  sentence: 'For the view, end the evening on the rooftop of Hotel Imaginary.',
}

/** Adds the made-up place to an answer as if the model had written it: the
 * sentence goes into the text and the id into placeIds. */
export function injectFake(
  text: string,
  parsed: Record<string, unknown> | null,
): { text: string; parsed: Record<string, unknown> } {
  const placeIds = Array.isArray(parsed?.placeIds) ? parsed.placeIds.map(String) : []
  const out = `${text} ${INJECTED.sentence}`.trim()
  return { text: out, parsed: { ...parsed, text: out, placeIds: [...placeIds, INJECTED.id] } }
}

/** Small models copy ids with decorations: `id=osm:node/1`, `"osm:node/1"`,
 * or only the number. Clean those up, but never guess: a bare number counts
 * only when exactly one id in the context ends with it. */
export function resolveId(raw: string, known: Set<string>): string | null {
  const id = raw.trim().replace(/^id\s*[=:]\s*/i, '').replace(/^["'`]|["'`]$/g, '').trim()
  if (known.has(id)) return id
  if (/^\d+$/.test(id)) {
    const hits = [...known].filter((k) => k.endsWith(`/${id}`))
    if (hits.length === 1) return hits[0]
  }
  return null
}

/** Checks the model's citations against the context. Exported for tests. */
export function verify(
  text: string,
  parsed: Record<string, unknown> | null,
  pool: CityEvent[],
  ctxPlaces: CtxPlace[],
  query = '',
): { events: CityEvent[]; places: CtxPlace[]; verification: AdvisorTrace['verification'] } {
  const ids = (v: unknown) => (Array.isArray(v) ? v.map(String) : [])
  const claimed = [...ids(parsed?.eventIds), ...ids(parsed?.placeIds)]
  const known = new Set([...pool.map((e) => e.id), ...ctxPlaces.map((c) => c.place.id)])
  const resolved = claimed.map((raw) => ({ raw, id: resolveId(raw, known) }))
  const cited = [...new Set(resolved.flatMap((r) => (r.id ? [r.id] : [])))]
  const rejected = [...new Set(resolved.filter((r) => !r.id).map((r) => r.raw))]

  // Is the item named in the text? Events by title (or its main part before a
  // colon: "piano evening" for "Piano evening: Chopin and Rachmaninoff"), or by
  // venue when the venue hosts only this event; places by any of their names.
  const titleForms = (t: string) => {
    const head = t.split(/\s*[:—–]\s*/)[0].trim()
    return head !== t && head.length >= 8 ? [t, head] : [t]
  }
  const eventNamed = (e: CityEvent) =>
    titleForms(e.title).some((t) => mentionedIn(text, t)) ||
    (e.venue != null && pool.filter((x) => x.venue === e.venue).length === 1 && mentionedIn(text, e.venue))
  // For recovering an uncited place, a name that is just a generic word
  // ("Кафе", "Аптека") or the very thing asked about ("Plov" when asking
  // where to eat plov) is not evidence that the answer means this place.
  const asked = new Set(tokens(query))
  const telling = (n: string) => {
    const w = tokens(n)
    return w.length > 1 || (w.length === 1 && !asked.has(w[0]))
  }
  const named = new Set<string>()
  for (const e of pool) if (eventNamed(e)) named.add(e.id)
  for (const c of ctxPlaces) {
    const strict = cited.includes(c.place.id) ? () => true : telling
    if (c.place.names.some((n) => strict(n) && mentionedIn(text, n))) named.add(c.place.id)
  }

  const recovered = [...named].filter((id) => !cited.includes(id))
  // A card is shown only for what the text talks about: a cited id the
  // answer never mentions ("jazz jam" under a question about kids) is hidden.
  // If the answer names none of its citations (names translated), keep them.
  const citedNamed = cited.filter((id) => named.has(id))
  const keepCited = citedNamed.length || recovered.length ? citedNamed : cited
  const hidden = cited.filter((id) => !keepCited.includes(id))
  const shown = new Set([...keepCited, ...recovered])
  const nameOf = new Map([...pool.map((e) => [e.id, e.title] as const), ...ctxPlaces.map((c) => [c.place.id, c.place.name] as const)])
  const rows: CheckRow[] = [
    ...[...new Set(resolved.map((r) => r.id ?? r.raw))].map((id): CheckRow =>
      known.has(id)
        ? { id, inContext: true, result: hidden.includes(id) ? 'hidden' : 'kept', name: nameOf.get(id) ?? null }
        : { id, inContext: false, result: 'rejected', name: null },
    ),
    ...recovered.map((id): CheckRow => ({ id, inContext: true, result: 'recovered', name: nameOf.get(id) ?? null })),
  ]
  return {
    events: pool.filter((e) => shown.has(e.id)),
    places: ctxPlaces.filter((c) => shown.has(c.place.id)),
    verification: { cited, recovered, rejected, hidden, rows },
  }
}

/** Cards in the order they appear in the text; events first when tied. */
function cards(text: string, events: CityEvent[], places: CtxPlace[], req: AdvisorRequest, tz: string): Card[] {
  const lower = text.toLowerCase()
  const pos = (names: string[]) => {
    const found = names.map((n) => lower.indexOf(n.toLowerCase())).filter((i) => i >= 0)
    return found.length ? Math.min(...found) : Number.MAX_SAFE_INTEGER
  }
  const out: (Card & { at: number })[] = [
    ...events.map((e) => ({
      id: e.id,
      type: 'event' as const,
      title: e.title,
      subtitle: [fmtWhen(new Date(e.startsAt), tz), e.venue].filter(Boolean).join(' · '),
      lat: e.lat,
      lng: e.lng,
      approximate: e.approximate,
      at: pos([e.title]),
    })),
    ...places.map((c) => ({
      id: c.place.id,
      type: 'place' as const,
      title: c.place.name,
      subtitle: [kindLabel(c.place.kind), c.open, fmtKm(c.km)].filter(Boolean).join(' · '),
      lat: c.place.lat,
      lng: c.place.lng,
      at: pos(c.place.names),
    })),
  ]
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...card }) => card)
}

/** No model: a template answer over the same grounded context. */
function fallback(
  query: string,
  direct: boolean,
  kinds: string[],
  pool: CityEvent[],
  ctxPlaces: CtxPlace[],
  req: AdvisorRequest,
  tz: string,
  now: Date,
  trace: AdvisorTrace,
): AdvisorResponse {
  const ru = lang(query) === 'ru'
  // Late at night unknown hours mean "probably closed": only places known to
  // be open are suggested. In the daytime unknown hours are acceptable.
  const hour = Number(req.scenario.time.slice(0, 2))
  const night = hour >= 21 || hour < 8
  const isOpen = (c: CtxPlace) => {
    const st = openState(c.place.openingHours, tz, now)
    return st ? st.open : !night
  }
  const describe = (c: CtxPlace) => `${c.place.name} (${[fmtKm(c.km), c.open].filter(Boolean).join(', ')})`
  let picked: CtxPlace[]
  let events: CityEvent[] = []
  let text: string
  if (direct) {
    const wanted = new Set(kinds)
    picked = ctxPlaces.filter((c) => wanted.has(c.place.kind) && isOpen(c)).slice(0, 3)
    text = picked.length
      ? ru
        ? `Ближайшие варианты: ${picked.map(describe).join('; ')}.`
        : `Nearest options: ${picked.map(describe).join('; ')}.`
      : ru
        ? 'Поблизости в базе ничего подходящего не нашлось.'
        : 'Nothing like that was found nearby in the database.'
  } else {
    const indoor = req.scenario.weather !== 'clear'
    picked = ctxPlaces.filter((c) => isOpen(c) && (!indoor || INDOOR_KINDS.has(c.place.kind))).slice(0, 2)
    events = pool.filter((e) => Date.parse(e.startsAt) - now.getTime() < 6 * 3600 * 1000).slice(0, 2)
    const ev = events.map((e) => `${e.title} (${fmtWhen(new Date(e.startsAt), tz)})`).join('; ')
    const pl = picked.map(describe).join('; ')
    text = ru
      ? [ev && `Скоро рядом: ${ev}.`, pl && `${indoor ? 'Под крышей' : 'Можно зайти'}: ${pl}.`].filter(Boolean).join(' ') ||
        'Поблизости в базе ничего подходящего не нашлось.'
      : [ev && `Coming up nearby: ${ev}.`, pl && `${indoor ? 'Indoors' : 'Worth a visit'}: ${pl}.`].filter(Boolean).join(' ') ||
        'Nothing fitting was found nearby in the database.'
  }
  const rows: CheckRow[] = [
    ...events.map((e): CheckRow => ({ id: e.id, inContext: true, result: 'kept', name: e.title })),
    ...picked.map((c): CheckRow => ({ id: c.place.id, inContext: true, result: 'kept', name: c.place.name })),
  ]
  trace.verification = { cited: rows.map((r) => r.id), recovered: [], rejected: [], hidden: [], rows }
  return { text, cards: cards(text, events, picked, req, tz), trace }
}
