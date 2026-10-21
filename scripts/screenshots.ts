/** Renders the README screenshots with headless Chrome over the DevTools
 * protocol (no Playwright needed). Start the demo first (`npm start`), then:
 *
 *   npm run screenshots            # docs/advisor.jpg, docs/extraction.jpg
 *
 * The advisor shot has the "Inject a made-up id" switch on, so the check has
 * something to reject (no recorded answer invents an id by itself).
 *
 * CHROME=/path/to/chrome overrides the browser; THEME=dark for dark shots. */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL_ = process.env.DEMO_URL ?? 'http://127.0.0.1:4310/'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const THEME = process.env.THEME === 'dark' ? 'dark' : 'light'
const OUT = new URL('../docs/', import.meta.url)
const PORT = 9333

const profile = mkdtempSync(join(tmpdir(), 'lensmap-shots-'))
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', 'about:blank',
], { stdio: 'ignore' })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function target(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[]
      const page = list.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* not up yet */
    }
    await sleep(200)
  }
  throw new Error('Chrome did not start')
}

const ws = new WebSocket(await target())
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
let seq = 0
const pending = new Map<number, (v: any) => void>()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data))
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg.error ? Promise.reject(new Error(msg.error.message)) : msg.result)
    pending.delete(msg.id)
  }
})
function cdp(method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve) => pending.set(id, resolve))
}
async function run(js: string) {
  const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${js} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'script failed')
  return r.result?.value
}
async function shot(name: string) {
  const { data } = await cdp('Page.captureScreenshot', { format: 'jpeg', quality: 85 })
  writeFileSync(new URL(name, OUT), Buffer.from(data, 'base64'))
  console.log(`docs/${name}`)
}

const steps = {
  extract: `
    document.querySelector('[data-tab="extract"]').click()
    document.querySelector('#extract-btn').click()
    await new Promise((r) => setTimeout(r, 1500))`,
  ask: (q: string, inject = false) => `
    document.querySelector('[data-tab="advisor"]').click()
    if (${inject} !== document.querySelector('#inject').checked) document.querySelector('#inject').click()
    ;[...document.querySelectorAll('.chip')].find((b) => b.textContent.startsWith(${JSON.stringify(q)})).click()
    await new Promise((r) => setTimeout(r, 1500))
    ;[...document.querySelectorAll('.meta button')].at(-1).click()
    const chat = document.querySelector('#chat')
    chat.scrollTop = chat.scrollHeight`,
}

try {
  await cdp('Page.enable')
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false })
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: THEME }] })
  const suffix = THEME === 'dark' ? '-dark' : ''

  await cdp('Page.navigate', { url: URL_ })
  await sleep(3000)
  await run(steps.extract)
  // Taller, so the answer and the check table fit together.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 1100, deviceScaleFactor: 2, mobile: false })
  await run(steps.ask('It is pouring', true))
  await sleep(3500)
  await shot(`advisor${suffix}.jpg`)
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false })

  await cdp('Page.navigate', { url: URL_ })
  await sleep(3000)
  await run(steps.extract)
  await run(`document.querySelectorAll('.post')[4].scrollIntoView({ block: 'start' })`)
  await sleep(3000)
  await shot(`extraction${suffix}.jpg`)
} finally {
  ws.close()
  chrome.kill()
  await sleep(300)
  rmSync(profile, { recursive: true, force: true })
}
