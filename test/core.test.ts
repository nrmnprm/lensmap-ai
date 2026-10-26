import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractJson, stripThink } from '../src/json.ts'
import { canon, mentionedIn, nameScore, setCityWords } from '../src/names.ts'
import { kindsForQuery } from '../src/kinds.ts'
import { localToDate, tzOffsetMinutes } from '../src/time.ts'
import { openLabel } from '../src/hours.ts'
import { parseLdEvents } from '../src/jsonld.ts'
import { jitterAround, haversineKm } from '../src/geo.ts'

test('extractJson takes the first balanced object out of prose, fences and think blocks', () => {
  const reply = '<think>{"draft": true}</think>Sure! ```json\n{"text": "a {curly} \\"quoted\\" answer", "placeIds": ["osm:node/1"]}\n``` hope it helps'
  assert.deepEqual(extractJson(reply), { text: 'a {curly} "quoted" answer', placeIds: ['osm:node/1'] })
  assert.equal(extractJson('no json here'), null)
  assert.equal(extractJson('{"broken": '), null)
  assert.equal(stripThink('<think>hmm</think> Hello'), 'Hello')
})

test('names in Cyrillic, Uzbek Latin and English meet in one canonical form', () => {
  assert.equal(canon('Ильхом'), canon('Ilhom'))
  assert.equal(canon('Ташкент'), canon('Toshkent'))
  assert.equal(canon("Yapon bog'i"), 'yapan bagi')
  assert.ok(nameScore('театр «Ильхом»', 'Ilhom Theatre') >= 0.99)
  assert.ok(nameScore('Ilkhom theatre', 'Ильхом') >= 0.99)
  assert.ok(nameScore("Yapon bog'ida", "Yapon bog'i") >= 0.6)
  assert.ok(nameScore('в Юнусабаде', 'Yunusobod') >= 0.6)
  assert.equal(nameScore('Ilhom', 'Magic City'), 0)
})

test('the city name itself does not geocode to "Tashkent <something>"', () => {
  setCityWords(['Tashkent', 'Toshkent', 'Ташкент'])
  assert.equal(nameScore('в Ташкенте', 'Tashkent Tower'), 0)
  assert.ok(nameScore('Tashkent City Park', 'City Park') > 0.6)
})

test('mentionedIn matches whole phrases only', () => {
  assert.ok(mentionedIn('Try Café 555 tonight', 'Café 555'))
  assert.ok(!mentionedIn('Try Café 5555 tonight', 'Café 555'))
  assert.ok(!mentionedIn('Dostlik square', 'Dost'))
  assert.ok(mentionedIn('«Ильхом» в 19:00', 'Ильхом'))
  assert.ok(mentionedIn('Dorikhona “Dori‑Darmon” №2 (1.1 km)', 'Dorikhona "Dori-Darmon" №2'))
})

test('category stems do not fire inside other words', () => {
  assert.deepEqual(kindsForQuery('Что идёт в парке Победы?'), ['park', 'viewpoint'])
  assert.deepEqual(kindsForQuery('Где купить клубнику?'), [])
  assert.deepEqual(kindsForQuery('Где покупки дешевле?'), [])
  assert.deepEqual(kindsForQuery('Лучшие бары рядом'), ['bar', 'nightclub'])
})

test('specific questions map to categories, general ones do not', () => {
  assert.deepEqual(kindsForQuery('Где поесть плов рядом?'), ['restaurant', 'cafe', 'fast_food'])
  assert.deepEqual(kindsForQuery('Nearest pharmacy that is open now'), ['pharmacy'])
  assert.ok(kindsForQuery('Something for kids tomorrow morning').includes('playground'))
  assert.deepEqual(kindsForQuery('What is on tonight?'), [])
})

test('local time in Tashkent is UTC+5', () => {
  const d = localToDate('2026-10-09', '18:30', 'Asia/Tashkent')!
  assert.equal(d.toISOString(), '2026-10-09T13:30:00.000Z')
  assert.equal(tzOffsetMinutes('Asia/Tashkent', d), 300)
  assert.equal(localToDate('2026-10-09', '25:00', 'Asia/Tashkent'), null)
  assert.equal(localToDate('9 Oct', null, 'Asia/Tashkent'), null)
})

test('opening hours are evaluated at the demo clock in the city zone', () => {
  const tz = 'Asia/Tashkent'
  const evening = localToDate('2026-10-09', '18:30', tz)!
  const night = localToDate('2026-10-09', '23:30', tz)!
  assert.equal(openLabel('Mo-Su 09:00-22:00', tz, evening), 'open until 22:00')
  assert.equal(openLabel('Mo-Su 09:00-22:00', tz, night), 'closed, opens at 09:00')
  assert.equal(openLabel('24/7', tz, night), 'open')
  assert.equal(openLabel(null, tz, night), '')
  assert.equal(openLabel('not a schedule', tz, night), '')
})

test('JSON-LD events are read without a model, including @graph', () => {
  const html = `<html><script type="application/ld+json">{"@graph":[{"@type":"WebPage"},
    {"@type":"MusicEvent","name":"Gala","startDate":"2026-10-10T19:00:00+05:00",
     "location":{"@type":"Place","name":"Opera","address":{"streetAddress":"Main 1","addressLocality":"Tashkent"},
     "geo":{"latitude":41.3,"longitude":69.27}},"offers":{"price":150000,"priceCurrency":"UZS"}}]}</script>
    <script type="application/ld+json">{broken</script></html>`
  const [ev, ...rest] = parseLdEvents(html)
  assert.equal(rest.length, 0)
  assert.equal(ev.title, 'Gala')
  assert.equal(ev.venue, 'Opera')
  assert.equal(ev.address, 'Main 1, Tashkent')
  assert.equal(ev.lat, 41.3)
  assert.equal(ev.price, '150,000 UZS')
})

test('approximate points are stable and close to the anchor', () => {
  const a = jitterAround(41.31, 69.28, 'event-1')
  assert.deepEqual(a, jitterAround(41.31, 69.28, 'event-1'))
  const km = haversineKm(41.31, 69.28, a.lat, a.lng)
  assert.ok(km >= 0.14 && km <= 0.41, `offset ${km} km`)
})

test('JSON-LD locations given as a string or after a VirtualLocation keep the venue', () => {
  const page = (loc: string) =>
    `<script type="application/ld+json">{"@type":"Event","name":"X","startDate":"2026-10-10T19:00","location":${loc}}</script>`
  assert.equal(parseLdEvents(page('"Navoi Theater"'))[0].venue, 'Navoi Theater')
  const hybrid = '[{"@type":"VirtualLocation","url":"https://stream.example"},{"@type":"Place","name":"Ilhom","geo":{"latitude":41.3,"longitude":69.2}}]'
  const ev = parseLdEvents(page(hybrid))[0]
  assert.equal(ev.venue, 'Ilhom')
  assert.equal(ev.lat, 41.3)
})
