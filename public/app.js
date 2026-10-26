/* LensMap AI demo — client. Plain ES module, no build step. */

const $ = (s, el = document) => el.querySelector(s)
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') n.className = v
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v)
    else n.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)))
  return n
}

const state = {
  meta: null,
  names: new Map(),
  sampleEvents: [],
  extracted: [],
  posts: [],
  history: [],
  scenario: { time: '18:30', weather: 'clear' },
  user: null,
  busy: false,
  inject: false,
}

/* Preset questions set the demo clock and weather they are meant for.
 * scripts/record.ts records exactly these (keep the two lists in sync). */
const PRESETS = [
  { q: 'What is on tonight?', time: '18:30', weather: 'clear' },
  { q: 'It is pouring. Where can I go indoors?', time: '18:30', weather: 'rain' },
  { q: 'Where can I eat plov nearby?', time: '13:00', weather: 'clear' },
  { q: 'Nearest pharmacy that is open now', time: '23:30', weather: 'cold' },
  { q: 'Something for kids tomorrow morning', time: '18:30', weather: 'clear' },
  { q: 'Anything closer?' },
]

async function getJson(url, body) {
  const res = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`)
  return j
}

function fmtWhen(iso) {
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: state.meta.tz }).format(new Date(iso))
}

// ---------- map ----------

let map, eventLayer, extLayer, hlLayer, userMarker
const dark = matchMedia('(prefers-color-scheme: dark)').matches
if (dark) document.documentElement.classList.add('dark-map')

function initMap(places) {
  const { center } = state.meta
  map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([center.lat, center.lng], 14)
  // Leaflet's default prefix carries a flag; keep just the link to Leaflet.
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" title="A JavaScript library for interactive maps">Leaflet</a>')
  // Standard OSM tiles (light use, attribution required); muted with CSS so
  // that markers stand out, inverted in dark mode.
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map)

  const renderer = L.canvas({ padding: 0.3 })
  for (const [id, name, kind, label, lat, lng] of places) {
    state.names.set(id, name)
    L.circleMarker([lat, lng], { renderer, radius: 2.6, weight: 0, fillOpacity: 0.55, fillColor: dark ? '#9aa3b2' : '#5b6474' })
      .bindTooltip(escapeHtml(`${name} · ${label}`), { direction: 'top', offset: [0, -4] })
      .addTo(map)
  }
  eventLayer = L.layerGroup().addTo(map)
  extLayer = L.layerGroup().addTo(map)
  hlLayer = L.layerGroup().addTo(map)

  state.user = { lat: center.lat, lng: center.lng }
  userMarker = L.marker([center.lat, center.lng], {
    draggable: true,
    zIndexOffset: 1000,
    icon: L.divIcon({ className: '', html: '<div class="pin you"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }),
    title: 'You are here (drag me)',
  }).addTo(map)
  userMarker.bindTooltip('You are here — drag me', { direction: 'top', offset: [0, -10] })
  userMarker.on('dragend', () => {
    const p = userMarker.getLatLng()
    state.user = { lat: p.lat, lng: p.lng }
  })
}

function eventPopup(e) {
  return `<b>${escapeHtml(e.title)}</b><br>${fmtWhen(e.startsAt)}${e.venue ? ` · ${escapeHtml(e.venue)}` : ''}${
    e.description ? `<br><small>${escapeHtml(e.description)}</small>` : ''
  }`
}

function drawEvents(layer, events, cls) {
  layer.clearLayers()
  for (const e of events) {
    const c = e.approximate ? `${cls} approx` : cls
    L.marker([e.lat, e.lng], { icon: L.divIcon({ className: '', html: `<div class="pin ${c}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] }) })
      .bindPopup(eventPopup(e), { maxWidth: 280 })
      .addTo(layer)
  }
}

function highlight(cards) {
  hlLayer.clearLayers()
  if (!cards.length) return
  for (const c of cards) {
    L.marker([c.lat, c.lng], { interactive: false, icon: L.divIcon({ className: '', html: '<div class="hl"></div>', iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(hlLayer)
  }
  const pts = cards.map((c) => [c.lat, c.lng])
  pts.push([state.user.lat, state.user.lng])
  map.flyToBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 16, duration: 0.8 })
}

function focusCard(c) {
  // On a phone the map is above the panel: scroll up to it first.
  if (matchMedia('(max-width: 900px)').matches) $('.map-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' })
  map.flyTo([c.lat, c.lng], 17, { duration: 0.6 })
  L.popup({ offset: [0, -6] }).setLatLng([c.lat, c.lng]).setContent(`<b>${escapeHtml(c.title)}</b><br><small>${escapeHtml(c.subtitle)}</small>`).openOn(map)
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// ---------- advisor ----------

function modeBadge() {
  const { llm } = state.meta
  const b = $('#mode')
  if (llm.mode === 'live') {
    b.className = 'badge live'
    b.textContent = `● live · ${llm.model}`
  } else {
    b.className = 'badge replay'
    b.textContent = llm.recordings ? `● replay · ${llm.recordings} recorded answers` : '● offline · template fallback'
    b.title = llm.reason || ''
  }
}

function setScenario(time, weather) {
  if (time) {
    state.scenario.time = time
    $('#sc-time').value = time
  }
  if (weather) {
    state.scenario.weather = weather
    for (const x of document.querySelectorAll('.seg button')) x.classList.toggle('on', x.dataset.w === weather)
  }
}

/** A preset question starts a new conversation (recordings are made without
 * history); the follow-up chip continues the current one. */
function newChat() {
  state.history = []
  hlLayer.clearLayers()
  $('#chat').replaceChildren()
}

function renderChips() {
  const box = $('#chips')
  box.replaceChildren(...PRESETS.map((p) =>
    el('button', { class: 'chip', type: 'button', onclick: () => {
      if (state.busy) return
      if (p.time) {
        newChat()
        setScenario(p.time, p.weather)
      }
      ask(p.q)
    } }, p.q)))
}

function sourceLabel(m) {
  if (m.source === 'live') return el('span', { class: 'src live' }, 'live model')
  if (m.source === 'replay') return el('span', { class: 'src replay', title: `recorded ${m.recordedAt ?? ''}` }, 'replayed recording')
  return el('span', { class: 'src fallback', title: m.error || '' }, 'template fallback')
}

const RESULT = {
  kept: ['ok', '✓ kept'],
  recovered: ['warn', '↺ recovered by name'],
  rejected: ['bad', '✗ rejected'],
  hidden: ['', '○ hidden'],
}

function checkTable(trace) {
  const v = trace.verification
  const inj = trace.injected?.applied ? trace.injected : null
  const counts = ['kept', 'recovered', 'rejected', 'hidden'].map((r) => `${r} ${v.rows.filter((x) => x.result === r).length}`).join(' · ')
  return [
    el('div', { class: 'counts' }, counts),
    v.rows.length
      ? el('table', { class: 'vtable' },
          el('thead', {}, el('tr', {}, el('th', {}, 'Cited id'), el('th', { title: 'Was this id in the context the server handed to the model for this question?' }, 'Handed out?'), el('th', {}, 'Result'), el('th', {}, 'Name'))),
          el('tbody', {}, v.rows.map((r) => {
            const fake = inj && r.id === inj.id
            const [cls, label] = RESULT[r.result]
            return el('tr', { class: fake ? 'injected' : '' },
              el('td', {}, el('code', {}, r.id), r.result === 'recovered' ? el('small', { class: 'muted' }, ' not cited') : null),
              el('td', {}, r.inContext ? 'yes' : el('b', { class: 'k bad' }, 'no')),
              el('td', {}, el('span', { class: `k ${cls}` }, label)),
              el('td', {}, fake ? [inj.name, el('span', { class: 'tag-inj', title: 'Added by the demo switch, not by the model' }, 'injected')] : (r.name ?? state.names.get(r.id) ?? '—')),
            )
          })))
      : el('p', { class: 'muted' }, 'The answer cites nothing and names nothing from the context.'),
    trace.injected && !trace.injected.applied
      ? el('p', { class: 'muted' }, 'Nothing was injected: this is a template answer, there is no model output to add a made-up id to.')
      : null,
    el('p', { class: 'muted' }, 'Kept: an id handed to the model in this request, named in the answer, so it gets a card. Recovered by name: named in the text without an id, matched by name. Rejected: an id that was not in the context, dropped (its prose is not rewritten). Hidden: cited but never named in the answer, so no card.'),
  ]
}

function traceView(trace) {
  const m = trace.model
  const panes = {
    Check: () =>
      el('div', {},
        checkTable(trace),
        el('dl', { class: 'facts' },
          el('dt', {}, 'question'), el('dd', {}, trace.mode === 'direct' ? `specific: ${trace.kinds.join(', ')}` : 'general'),
          el('dt', {}, 'now'), el('dd', {}, trace.now),
          el('dt', {}, 'context'), el('dd', {}, `${trace.context.places} places (${trace.context.closed} closed now), ${trace.context.events} events`),
          el('dt', {}, 'model'), el('dd', {}, m.name ?? '—'),
          el('dt', {}, 'latency'), el('dd', {}, m.source === 'live' ? `${(m.latencyMs / 1000).toFixed(1)} s` : '—'),
          el('dt', {}, 'tokens'), el('dd', {}, m.usage ? `${m.usage.promptTokens} in / ${m.usage.completionTokens} out` : '—'),
          el('dt', {}, 'cost'), el('dd', {}, m.usage?.costUsd != null ? `$${m.usage.costUsd.toFixed(5)}` : '—'),
          m.retry ? [el('dt', {}, 'retried'), el('dd', {}, m.retry)] : null,
          m.error ? [el('dt', {}, 'fallback'), el('dd', {}, m.error)] : null,
        ),
      ),
    Prompt: () => el('pre', {}, `SYSTEM\n${trace.prompt.system}\n\nUSER\n${trace.prompt.user}`),
    'Raw output': () => el('pre', {}, m.raw ?? `(no model output: ${m.error ?? 'fallback'})`),
  }
  const body = el('div', { class: 'tbody' })
  const tabs = el('div', { class: 'ttabs' })
  const show = (name) => {
    for (const b of tabs.children) b.classList.toggle('on', b.textContent === name)
    body.replaceChildren(panes[name]())
  }
  for (const name of Object.keys(panes)) tabs.append(el('button', { type: 'button', onclick: () => show(name) }, name))
  const box = el('div', { class: 'trace' }, tabs, body)
  show('Check')
  return box
}

function botMessage(res) {
  const trace = res.trace
  const traceBox = el('div')
  let open = false
  const toggle = el('button', { type: 'button', onclick: () => {
    open = !open
    traceBox.replaceChildren(open ? traceView(trace) : '')
    toggle.textContent = open ? 'Hide details' : 'Inspect'
  } }, 'Inspect')
  const m = trace.model
  const stats = []
  if (m.source === 'live') stats.push(`${(m.latencyMs / 1000).toFixed(1)} s`)
  if (m.usage) stats.push(`${m.usage.promptTokens + m.usage.completionTokens} tokens`)
  if (m.usage?.costUsd != null) stats.push(`$${m.usage.costUsd.toFixed(5)}`)
  const v = trace.verification
  const inj = trace.injected?.applied ? trace.injected : null
  if (v.rejected.length) stats.push(`${v.rejected.length} made-up id dropped`)
  if (v.recovered.length) stats.push(`${v.recovered.length} card recovered`)
  if (m.retry) stats.push('retried once')
  return el('div', { class: 'msg bot' },
    el('div', { class: 'bubble' },
      el('p', {}, inj && res.text.endsWith(inj.sentence)
        ? [res.text.slice(0, -inj.sentence.length), el('mark', { class: 'inj', title: 'Added by the demo switch, not by the model' }, inj.sentence, el('span', { class: 'tag-inj' }, 'injected'))]
        : res.text),
      res.cards.length
        ? el('div', { class: 'cards' }, res.cards.map((c) =>
            el('button', { class: 'card', type: 'button', onclick: () => focusCard(c) },
              el('span', { class: `ic ${c.type}${c.id.startsWith('ext:') || c.id.startsWith('ld:') ? ' ext' : ''}` }, c.type === 'event' ? '★' : '●'),
              el('span', {}, el('b', {}, c.title), el('small', {}, c.subtitle + (c.approximate ? ' · approximate point' : ''))),
            )))
        : null,
    ),
    el('div', { class: 'meta' }, sourceLabel(m), stats.join(' · '), toggle),
    traceBox,
  )
}

async function ask(q) {
  q = q.trim()
  if (!q || state.busy) return
  state.busy = true
  const chat = $('#chat')
  $('.hello', chat)?.remove()
  chat.append(el('div', { class: 'msg user' }, q))
  const typing = el('div', { class: 'typing' }, 'Thinking…')
  chat.append(typing)
  typing.scrollIntoView({ block: 'nearest' })
  $('#q').value = ''
  try {
    const res = await getJson('/api/advisor', {
      query: q,
      history: state.history,
      lat: state.user.lat,
      lng: state.user.lng,
      scenario: state.scenario,
      events: state.extracted,
      inject: state.inject,
    })
    const msg = botMessage(res)
    typing.replaceWith(msg)
    msg.scrollIntoView({ block: 'nearest' })
    // The injected sentence is not part of the conversation: without it a
    // follow-up still matches its recording.
    const inj = res.trace.injected?.applied ? res.trace.injected.sentence : ''
    const said = inj && res.text.endsWith(inj) ? res.text.slice(0, -inj.length).trim() : res.text
    state.history.push({ role: 'user', text: q }, { role: 'assistant', text: said })
    highlight(res.cards)
  } catch (e) {
    typing.replaceWith(el('div', { class: 'msg bot' }, el('div', { class: 'bubble' }, el('p', {}, `Error: ${e.message}`))))
  } finally {
    state.busy = false
  }
}

// ---------- extraction ----------

const LOC_ICON = { venue: '📍', district: '◌', city: '?' }
const LOC_TEXT = { venue: 'venue found on the map', district: 'district only — approximate', city: 'venue unknown — city centre, approximate' }

function renderPosts(trace) {
  const byPost = new Map((trace?.posts ?? []).map((p) => [p.postId, p]))
  const geo = new Map((trace?.geocode ?? []).map((g) => [g.eventId, g]))
  const events = new Map(state.extracted.map((e) => [e.id, e]))
  $('#posts').replaceChildren(...state.posts.map((p, i) => {
    const area = el('textarea', { class: p.kind === 'html' ? 'code' : '', rows: p.kind === 'html' ? 6 : 4, spellcheck: 'false' })
    area.value = p.text
    area.addEventListener('input', () => { state.posts[i].text = area.value })
    const pt = byPost.get(p.id)
    let result = null
    if (pt) {
      const statusText = {
        cache: 'model · from cache', live: 'model · live', parsed: 'schema.org · no model call',
        missing: 'needs an API key (not in cache)', failed: 'model call failed',
      }[pt.status]
      result = el('div', { class: 'result' },
        el('span', { class: `status ${pt.status}` }, statusText, pt.model ? el('span', { class: 'muted' }, ` · ${pt.model}`) : null),
        pt.kept.map((id) => {
          const e = events.get(id)
          const g = geo.get(id)
          if (!e) return null
          return el('div', { class: 'ev', title: g ? `${LOC_TEXT[g.via]}${g.label ? `: ${g.label}` : ''} (${g.query})` : '', onclick: () => focusCard({ ...e, subtitle: `${fmtWhen(e.startsAt)} · ${e.venue ?? ''}` }) },
            el('span', { class: 'loc' }, LOC_ICON[g?.via ?? 'city']),
            el('span', {}, el('b', {}, e.title), el('small', {}, `${fmtWhen(e.startsAt)}${e.timeUnknown ? ' (time not given)' : ''} · ${e.venue ?? 'venue unknown'}${e.approximate ? ' · approximate location' : ''}`)),
          )
        }),
        (pt.fixed ?? []).map((f) => el('div', { class: 'fix' }, '↻ ', el('b', {}, f.title), `: date corrected — ${f.note}`)),
        pt.dropped.map((d) => el('div', { class: 'drop' }, '✗ ', el('s', {}, d.title), ` — ${d.reason}`)),
        pt.kept.length || pt.dropped.length || pt.status === 'missing' || pt.status === 'failed' ? null : el('div', { class: 'drop' }, 'No events in this post.'),
        pt.raw?.length ? el('details', { class: 'raw' }, el('summary', {}, pt.method === 'jsonld' ? 'Parsed markup' : 'Raw model output'), el('pre', {}, JSON.stringify(pt.raw, null, 2))) : null,
      )
    }
    return el('div', { class: 'post' },
      el('div', { class: 'post-head' },
        el('span', {}, el('b', {}, p.source), ` · ${p.publishedAt}`),
        el('span', { class: `kind ${p.kind}` }, p.kind === 'html' ? 'web page · JSON-LD' : 'text'),
      ),
      area,
      result,
    )
  }))
}

async function extract() {
  const btn = $('#extract-btn')
  btn.disabled = true
  $('#ext-status').textContent = 'Extracting…'
  try {
    const res = await getJson('/api/extract', { posts: state.posts })
    state.extracted = res.events
    drawEvents(extLayer, res.events, 'extracted')
    for (const e of res.events) state.names.set(e.id, e.title)
    const t = res.trace
    const approx = res.events.filter((e) => e.approximate).length
    const dropped = t.posts.reduce((n, p) => n + p.dropped.length, 0)
    const missing = t.posts.filter((p) => p.status === 'missing').length
    const cost = t.calls.reduce((s, c) => s + (c.usage?.costUsd ?? 0), 0)
    $('#ext-summary').hidden = false
    $('#ext-summary').replaceChildren(...[
      el('span', {}, `${res.events.length} events`),
      el('span', {}, `${res.events.length - approx} exact · ${approx} approximate`),
      el('span', {}, `${dropped} dropped`),
      el('span', {}, `${t.calls.length} model call${t.calls.length === 1 ? '' : 's'}${cost ? ` · $${cost.toFixed(5)}` : ''}`),
      missing ? el('span', {}, `${missing} posts need an API key`) : null,
    ].filter(Boolean))
    $('#ext-count').hidden = !res.events.length
    $('#ext-count').textContent = res.events.length
    $('#ext-status').textContent = 'Events are on the map and available to the advisor.'
    renderPosts(t)
    if (res.events.length) map.flyToBounds(L.latLngBounds(res.events.map((e) => [e.lat, e.lng])).pad(0.2), { maxZoom: 15, duration: 0.8 })
  } catch (e) {
    $('#ext-status').textContent = `Error: ${e.message}`
  } finally {
    btn.disabled = false
  }
}

// ---------- wiring ----------

function switchTab(name) {
  for (const t of document.querySelectorAll('.tab')) {
    const on = t.dataset.tab === name
    t.classList.toggle('active', on)
    t.setAttribute('aria-selected', String(on))
  }
  $('#tab-advisor').hidden = name !== 'advisor'
  $('#tab-extract').hidden = name !== 'extract'
}

async function main() {
  const [meta, places, events, posts] = await Promise.all([
    getJson('/api/meta'), getJson('/api/places'), getJson('/api/events'), getJson('/api/posts'),
  ])
  state.meta = meta
  state.sampleEvents = events
  state.posts = structuredClone(posts)
  const day = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${meta.demoDate}T12:00:00Z`))
  $('#demo-day').textContent = day
  modeBadge()
  initMap(places)
  for (const e of events) state.names.set(e.id, e.title)
  drawEvents(eventLayer, events, 'sample')
  renderChips()
  renderPosts(null)

  $('#ask').addEventListener('submit', (ev) => { ev.preventDefault(); ask($('#q').value) })
  $('#sc-time').addEventListener('change', (ev) => { state.scenario.time = ev.target.value })
  $('#inject').addEventListener('change', (ev) => { state.inject = ev.target.checked })
  for (const b of document.querySelectorAll('.seg button')) b.addEventListener('click', () => setScenario(null, b.dataset.w))
  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => switchTab(t.dataset.tab))
  $('#extract-btn').addEventListener('click', extract)
  $('#reset-posts').addEventListener('click', () => {
    state.posts = structuredClone(posts)
    state.extracted = []
    extLayer.clearLayers()
    $('#ext-count').hidden = true
    $('#ext-summary').hidden = true
    $('#ext-status').textContent = ''
    renderPosts(null)
  })
  $('#new-chat').addEventListener('click', () => { if (!state.busy) newChat() })
  $('#about-btn').addEventListener('click', () => $('#about').showModal())
}

main().catch((e) => {
  document.body.prepend(el('div', { style: 'padding:12px;background:#fdecec;color:#c62828' }, `Failed to start: ${e.message}`))
})
