/** Records real model answers for the preset questions and the sample posts,
 * so a deployment without an API key can replay them.
 *
 *   OPENROUTER_API_KEY=... npm run record
 *
 * Answers land in data/llm-cache.json and data/extract-cache.json, keyed by a
 * hash of the exact request (model included). Commit both files to ship the
 * recordings; delete them to start over. */
import '../src/env.ts'
import { readFileSync } from 'node:fs'
import { advise } from '../src/advisor.ts'
import { city, placeById } from '../src/city.ts'
import { extractEvents, type SourcePost } from '../src/extract.ts'
import { checkModel, llmStatus } from '../src/llm.ts'
import { setCityWords } from '../src/names.ts'
import { DEMO_DATE, localToDate } from '../src/time.ts'
import type { CityEvent, Scenario } from '../src/types.ts'

setCityWords([city.city, 'Toshkent', 'Ташкент'])
console.log(await checkModel())
const st = llmStatus()
if (st.mode !== 'live') {
  console.error(`Cannot record: ${st.reason}`)
  process.exit(1)
}

const root = new URL('..', import.meta.url)
const posts: SourcePost[] = JSON.parse(readFileSync(new URL('data/posts.json', root), 'utf8'))
const samples = JSON.parse(readFileSync(new URL('data/events.json', root), 'utf8')) as {
  id: string; title: string; description: string; placeId: string; day: number; time: string; minutes: number
}[]

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
const sampleEvents: CityEvent[] = samples.flatMap((e) => {
  const p = placeById.get(e.placeId)
  const startsAt = localToDate(addDays(DEMO_DATE, e.day), e.time, city.tz)
  if (!p || !startsAt) return []
  return [{
    id: e.id, title: e.title, description: e.description, venue: p.name, lat: p.lat, lng: p.lng,
    startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + e.minutes * 60000).toISOString(),
    approximate: false, timeUnknown: false, origin: 'sample' as const, sourceUrl: null,
  }]
})

console.log('extraction…')
const ext = await extractEvents(posts)
console.log(`  ${ext.events.length} events, ${ext.trace.calls.length} model calls`)

// Must match PRESETS in public/app.js (the follow-up question is not recorded:
// it depends on the conversation).
const PRESETS: { q: string; scenario: Scenario }[] = [
  { q: 'What is on tonight?', scenario: { time: '18:30', weather: 'clear' } },
  { q: 'It is pouring. Where can I go indoors?', scenario: { time: '18:30', weather: 'rain' } },
  { q: 'Где поесть плов рядом?', scenario: { time: '13:00', weather: 'clear' } },
  { q: 'Nearest pharmacy that is open now', scenario: { time: '23:30', weather: 'cold' } },
  { q: 'Something for kids tomorrow morning', scenario: { time: '18:30', weather: 'clear' } },
]
for (const events of [sampleEvents, [...sampleEvents, ...ext.events]]) {
  for (const { q, scenario } of PRESETS) {
    const res = await advise({ query: q, history: [], lat: city.center.lat, lng: city.center.lng, scenario, events })
    const tag = events.length > sampleEvents.length ? ' (+extracted)' : ''
    const v = res.trace.verification
    console.log(`  ${q}${tag} -> ${res.trace.model.source}, ${res.cards.length} cards, cited ${v.cited.length}, recovered ${v.recovered.length}, rejected ${v.rejected.length}`)
    console.log(`    ${res.text.replace(/\s+/g, ' ')}`)
  }
}
console.log('done: data/llm-cache.json, data/extract-cache.json')
