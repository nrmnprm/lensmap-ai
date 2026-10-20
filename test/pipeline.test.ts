/** Advisor verification and extraction checks. These import the city
 * snapshot, so they run against the bundled data/city.json. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerProblem, answerText, intentKinds, resolveId, verify } from '../src/advisor.ts'
import { extractJson } from '../src/json.ts'
import { city } from '../src/city.ts'
import { postLabel, reconcileWeekday, rejectReason, weekdaysIn } from '../src/extract.ts'
import { geocodeVenue, venueInText } from '../src/geocode.ts'
import { setCityWords } from '../src/names.ts'
import { localToDate } from '../src/time.ts'
import type { CityEvent, Place } from '../src/types.ts'

const place = (id: string, name: string, names: string[] = [name]): Place => ({
  id, name, names, kind: 'cafe', lat: city.center.lat, lng: city.center.lng, openingHours: null, address: null,
})
const ctx = (p: Place) => ({ place: p, km: 0.3, open: '' })
const event = (id: string, title: string): CityEvent => ({
  id, title, description: null, venue: null, lat: 0, lng: 0, startsAt: new Date().toISOString(), endsAt: null,
  approximate: false, timeUnknown: false, origin: 'sample', sourceUrl: null,
})

test('verify keeps cited ids, drops invented ones and recovers named places', () => {
  const places = [ctx(place('osm:node/1', 'Café Bon', ['Café Bon', 'Кафе Бон'])), ctx(place('osm:node/2', 'Plov Centre'))]
  const pool = [event('ev-1', 'Jazz night')]
  const text = 'Start with Jazz night, then dinner at Кафе Бон or the rooftop of Hotel Imaginary.'
  const parsed = { text, eventIds: ['ev-1'], placeIds: ['osm:node/999'] }
  const v = verify(text, parsed, pool, places)
  assert.deepEqual(v.verification.cited, ['ev-1'])
  assert.deepEqual(v.verification.rejected, ['osm:node/999'])
  assert.deepEqual(v.verification.recovered, ['osm:node/1'])
  assert.deepEqual(v.places.map((c) => c.place.id), ['osm:node/1'])
  assert.deepEqual(v.events.map((e) => e.id), ['ev-1'])
})

test('verify survives a reply that is not JSON at all', () => {
  const places = [ctx(place('osm:node/2', 'Plov Centre'))]
  const v = verify('Go to Plov Centre.', null, [], places)
  assert.deepEqual(v.verification.recovered, ['osm:node/2'])
  assert.deepEqual(v.verification.cited, [])
})

test('extracted events outside the window are rejected with a reason', () => {
  const tz = city.tz
  const now = localToDate('2026-10-09', '08:00', tz)!
  assert.equal(rejectReason({ title: 'Ok', date: '2026-10-10', time: '19:00' }, now, tz), null)
  assert.equal(rejectReason({ title: 'Ok', date: '2026-10-09', time: null }, now, tz), null)
  assert.equal(rejectReason({ title: 'Past', date: '2026-10-08', time: '19:00' }, now, tz), 'already over')
  assert.equal(rejectReason({ title: 'Far', date: '2026-11-20', time: '10:00' }, now, tz), 'more than 21 days ahead')
  assert.equal(rejectReason({ title: 'Bad', date: '10 October', time: null }, now, tz), 'bad date "10 October"')
  assert.equal(rejectReason({ title: 'Bad', date: '2026-10-10', time: '7pm' }, now, tz), 'bad time "7pm"')
  assert.equal(rejectReason({ title: '', date: '2026-10-10' }, now, tz), 'no title')
})

test('decorated ids are cleaned up, guessed ones are not', () => {
  const known = new Set(['osm:node/42', 'osm:way/7', 'ev-1'])
  assert.equal(resolveId('id=osm:node/42', known), 'osm:node/42')
  assert.equal(resolveId(' "ev-1" ', known), 'ev-1')
  assert.equal(resolveId('42', known), 'osm:node/42')
  assert.equal(resolveId('4663713829', known), null)
  assert.equal(resolveId('osm:node/43', known), null)
})

test('weekdays are found in Russian, Uzbek and English text', () => {
  assert.deepEqual([...weekdaysIn('📅 Суббота, 10 октября, 19:00')], [6])
  assert.deepEqual([...weekdaysIn("Yakshanba kuni soat 11:00 da")], [0])
  assert.deepEqual([...weekdaysIn('Jazz night this Friday')], [5])
  assert.deepEqual([...weekdaysIn('в эту пятницу с 19:00')], [5])
  assert.deepEqual([...weekdaysIn('Суббота ... Воскресенье').values()].sort(), [0, 6])
  assert.equal(weekdaysIn('среди недели, средний чек').size, 0)
  assert.equal(weekdaysIn('Juma masjidi yonida').has(5), true)
})

test('a weekday named in the post overrides a miscalculated date', () => {
  // Published on Wednesday 7 Oct: "this Friday" is 9 Oct.
  const fri = { text: 'Jazz night this Friday', publishedAt: '2026-10-07' }
  assert.equal(reconcileWeekday({ date: '2026-10-13', weekday: 'Fri' }, fri)?.date, '2026-10-09')
  // The model and the post disagree on the weekday: leave the date alone.
  const sun = { text: 'Yakshanba kuni soat 11:00 da', publishedAt: '2026-10-07' }
  assert.equal(reconcileWeekday({ date: '2026-10-14', weekday: 'Sat' }, sun), null)
  // An explicit day and month wins over everything.
  const sat = { text: 'Суббота, 17 октября, 19:00', publishedAt: '2026-10-07' }
  assert.equal(reconcileWeekday({ date: '2026-10-16', weekday: 'Sat' }, sat), null)
  // "окружающей среды" is not a Wednesday when the model names no weekday.
  assert.equal(reconcileWeekday({ date: '2026-10-08', weekday: null }, { text: 'День окружающей среды', publishedAt: '2026-10-07' }), null)
  // Garbage dates never loop or throw.
  assert.equal(reconcileWeekday({ date: '2026-10-32', weekday: 'Fri' }, fri), null)
  assert.equal(reconcileWeekday({ date: '2026-10-13', weekday: 'Fri' }, { ...fri, publishedAt: '2026-13-45' })?.date, '2026-10-09')
})

test('the output guard rejects empty answers and answers in a foreign script', () => {
  assert.equal(answerProblem('{"text": "Try Plov Centre", "placeIds": []}', 'where to eat?'), null)
  assert.equal(answerProblem('{"text": "Плов есть в几个选项", "placeIds": []}', 'Где поесть плов?'), 'answer contains text in another script')
  assert.equal(answerProblem('{"text": "", "placeIds": []}', 'where?'), 'empty answer')
  assert.equal(answerProblem('Plain text without JSON is still an answer', 'where?'), null)
})

test('a Russian question needs a Russian answer, ids never reach the text', () => {
  assert.equal(answerProblem('{"text": "Try Crystal Garden, open until 23:00"}', 'Где поесть плов?'), 'answer is not in the language of the question')
  assert.equal(answerProblem('{"text": "Загляните в Crystal Garden Restaurant, до 23:00"}', 'Где поесть плов?'), null)
  const places = [ctx(place('osm:node/6', 'Cafe 1991'))]
  const text = 'Cafe 1991 (id=osm:node/6) is open'
  assert.deepEqual(verify(text, null, [], places).verification.recovered, ['osm:node/6'])
})

test('an event is recovered by its venue when the venue hosts only that event', () => {
  const e = { ...event('ev-p', 'Puppet show: The Clever Hare'), venue: 'Republican puppet theater' }
  const v = verify('Visit the Republican puppet theater at 10:30.', { text: '', eventIds: [], placeIds: [] }, [e], [])
  assert.deepEqual(v.verification.recovered, ['ev-p'])
})

test('a cited place the answer never names gets no card', () => {
  const places = [ctx(place('osm:node/1', 'Puppet Theatre')), ctx(place('osm:node/2', 'Jazz Bar'))]
  const v = verify('Take the kids to Puppet Theatre.', { eventIds: [], placeIds: ['osm:node/1', 'osm:node/2'] }, [], places)
  assert.deepEqual(v.places.map((c) => c.place.id), ['osm:node/1'])
  assert.deepEqual(v.verification.hidden, ['osm:node/2'])
  // Names translated: nothing matches, so the citations are kept as they are.
  const w = verify('Сходите в кукольный театр.', { eventIds: [], placeIds: ['osm:node/1'] }, [], places)
  assert.deepEqual(w.places.map((c) => c.place.id), ['osm:node/1'])
})

test('a follow-up keeps the category of the previous question only', () => {
  const history = [
    { role: 'user' as const, content: 'Nearest pharmacy that is open now' },
    { role: 'assistant' as const, content: 'City Pharm, 1.1 km' },
  ]
  assert.deepEqual(intentKinds('Anything closer?', history), ['pharmacy'])
  assert.deepEqual(intentKinds('А поближе?', history), ['pharmacy'])
  // A new general question does not inherit the old category...
  assert.deepEqual(intentKinds('What is on tonight?', history), [])
  assert.deepEqual(intentKinds('Что ещё интересного в городе сегодня?', history), [])
  // ...and a follow-up to a general question stays general.
  const later = [...history, { role: 'user' as const, content: 'What is on tonight?' }, { role: 'assistant' as const, content: 'Jazz' }]
  assert.deepEqual(intentKinds('Anything else?', later), [])
})

test('ids never reach the text the user reads, punctuation survives', () => {
  for (const reply of [
    '{"text": "Try Cafe 1991 (osm:node/6002188186)."}',
    '{"text": "Try Cafe 1991 (id=osm:node/6002188186)."}',
    '{"text": "Try Cafe 1991 id: osm:node/6002188186."}',
  ]) {
    assert.equal(answerText(reply, extractJson(reply)), 'Try Cafe 1991.')
  }
  assert.equal(answerProblem('{"text": "Попробуйте пlov в Crystal Garden"}', 'Где поесть плов?'), 'a word mixes two alphabets')
})

test('a place named only after the thing asked about is not recovered from the text', () => {
  const places = [ctx(place('osm:node/7', 'Plov')), ctx(place('osm:node/8', 'Feed Up'))]
  const text = 'Try Feed Up, they serve good plov.'
  const v = verify(text, { text, eventIds: [], placeIds: [] }, [], places, 'Где поесть плов?')
  assert.deepEqual(v.verification.recovered, ['osm:node/8'])
})

test('geocoding respects categories, inflection direction and streets', () => {
  setCityWords(['Tashkent', 'Toshkent', 'Ташкент'])
  assert.equal(geocodeVenue('Magic Museum', null, null)?.label, 'Magic Museum')
  assert.equal(geocodeVenue('Tashkent Land', null, null)?.label, 'Tashkent Land')
  assert.equal(geocodeVenue("Concert hall, Navoi ko'chasi 12", null, null), null)
  assert.ok((geocodeVenue('Bon!', null, null)?.ambiguous ?? 0) > 1)
  assert.equal(geocodeVenue('Ильхом', null, null)?.label, 'Ilhom Theatre')
  assert.equal(geocodeVenue(null, null, 'Юнусабад')?.via, 'district')
  assert.equal(venueInText('Премьера в «Ильхоме»! Новая постановка — история города.')?.label, 'Ilhom Theatre')
  assert.equal(venueInText('Join us for a jam!'), null)
})

test('post labels written back by the model are normalised', () => {
  const ids = new Set(['p1', 'p2'])
  assert.equal(postLabel('post=p1', ids), 'p1')
  assert.equal(postLabel('#p2', ids), 'p2')
  assert.equal(postLabel(2, ids), 'p2')
  assert.equal(postLabel('x9', ids), 'x9')
})

test('a cited place keeps its card even when its name is the word asked about', () => {
  const places = [ctx(place('osm:node/7', 'Plov')), ctx(place('osm:node/9', 'Uzbekona'))]
  const text = 'Попробуйте Plov или Uzbekona.'
  const v = verify(text, { text, eventIds: [], placeIds: ['osm:node/7', 'osm:node/9'] }, [], places, 'Где поесть плов?')
  assert.deepEqual(v.places.map((c) => c.place.id), ['osm:node/7', 'osm:node/9'])
  assert.deepEqual(v.verification.hidden, [])
})

test('an event is named by the main part of its title', () => {
  const e = event('ev-piano', 'Piano evening: Chopin and Rachmaninoff')
  const m = event('ev-market', 'Autumn street-food market')
  const text = 'The autumn street-food market and the piano evening are on tonight.'
  const v = verify(text, { text, eventIds: ['ev-piano', 'ev-market'], placeIds: [] }, [e, m], [])
  assert.deepEqual(v.verification.hidden, [])
})
