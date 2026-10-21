/** The demo switch end to end: advise() against a fake OpenAI-compatible
 * server on localhost, so no key, no network and no recordings are touched. */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The model "answers" with the first place of the context, cited properly.
const fake = createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const { messages } = JSON.parse(body) as { messages: { role: string; content: string }[] }
    const [, id, name] = /- id=(\S+) \| ([^|]+?) \|/.exec(messages.at(-1)!.content)!
    const content = JSON.stringify({ text: `Head to ${name}, it is close by.`, eventIds: [], placeIds: [id] })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ model: 'fake', choices: [{ message: { content } }] }))
  })
})
await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
const port = (fake.address() as { port: number }).port
const dir = mkdtempSync(join(tmpdir(), 'lensmap-inject-'))
process.env.LLM_BASE_URL = `http://127.0.0.1:${port}/v1`
process.env.LLM_MODEL = 'fake'
process.env.LLM_CACHE_FILE = join(dir, 'cache.json')
process.env.LLM_CACHE_WRITE = '0'
const { advise, INJECTED } = await import('../src/advisor.ts')
const { city } = await import('../src/city.ts')

after(() => {
  fake.close()
  rmSync(dir, { recursive: true, force: true })
})

const ask = (inject: boolean) =>
  advise({
    query: 'Nearest pharmacy that is open now', history: [], lat: city.center.lat, lng: city.center.lng,
    scenario: { time: '13:00', weather: 'clear' }, events: [], inject,
  })

test('with the switch on, the made-up id is rejected and gets no card', async () => {
  const plain = await ask(false)
  const res = await ask(true)
  assert.equal(plain.trace.model.source, 'live')
  assert.equal(plain.trace.injected, undefined)
  assert.deepEqual(plain.trace.verification.rejected, [])

  assert.deepEqual(res.trace.injected, { ...INJECTED, applied: true })
  assert.equal(res.text, `${plain.text} ${INJECTED.sentence}`)
  assert.deepEqual(res.trace.verification.rejected, [INJECTED.id])
  assert.deepEqual(res.cards.map((c) => c.id), plain.cards.map((c) => c.id))
  assert.ok(!res.cards.some((c) => c.id === INJECTED.id))
  const row = res.trace.verification.rows.find((r) => r.id === INJECTED.id)
  assert.deepEqual(row, { id: INJECTED.id, inContext: false, result: 'rejected', name: null })
  // The raw model output is shown as the model wrote it.
  assert.ok(!res.trace.model.raw!.includes(INJECTED.id))
})
