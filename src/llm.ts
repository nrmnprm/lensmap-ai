/** OpenAI-compatible chat client (OpenRouter by default), based on LensMap's
 * askModel. Three rules carried over from production:
 *  - fail-soft: every error becomes `{ ok: false }`, callers have a fallback;
 *  - paid models are refused unless ALLOW_PAID_MODELS=1, so a typo in the
 *    model name cannot run up a bill;
 *  - the configured model is checked against the provider's model list at
 *    startup (LensMap's default free model was retired upstream and the
 *    advisor silently answered 502 until the name was changed).
 *
 * Added for the demo: a record/replay cache. Every live answer is stored
 * under a hash of the exact request, so a deployment without an API key can
 * still replay real model output for the preset questions. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface Usage {
  promptTokens: number
  completionTokens: number
  /** USD, as reported by OpenRouter (`usage.cost`); null for other providers. */
  costUsd: number | null
}

export type ChatResult =
  | { ok: true; content: string; model: string; latencyMs: number; usage: Usage | null; source: 'live' | 'replay'; recordedAt?: string }
  | { ok: false; error: string; latencyMs: number }

export interface ChatRequest {
  system: string
  user: string
  history?: ChatTurn[]
  maxTokens?: number
  temperature?: number
  /** false: do not store the answer in the replay cache (the caller keeps its own). */
  record?: boolean
}

const BASE_URL = (process.env.LLM_BASE_URL ?? 'https://openrouter.ai/api/v1').replace(/\/$/, '')
const IS_OPENROUTER = BASE_URL.includes('openrouter.ai')
// The default model reasons; "low" leaves room for the answer. Ignored by others.
const REASONING_EFFORT = process.env.LLM_REASONING_EFFORT ?? 'low'
export const LLM_MODEL = process.env.LLM_MODEL ?? process.env.OPENROUTER_MODEL ?? 'nvidia/nemotron-3-ultra-550b-a55b:free'
const CACHE_FILE = process.env.LLM_CACHE_FILE ?? fileURLToPath(new URL('../data/llm-cache.json', import.meta.url))

function apiKey(): string | null {
  return process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || null
}

/** Why live calls are impossible right now, or null when they are allowed. */
function liveBlocker(): string | null {
  // A local OpenAI-compatible server (Ollama, LM Studio) needs no key.
  if (!apiKey() && IS_OPENROUTER) return 'no API key (set OPENROUTER_API_KEY or LLM_API_KEY)'
  if (IS_OPENROUTER && !LLM_MODEL.endsWith(':free') && process.env.ALLOW_PAID_MODELS !== '1') {
    return `paid model ${LLM_MODEL} refused (set ALLOW_PAID_MODELS=1 to allow)`
  }
  if (modelCheck === 'missing') return `model ${LLM_MODEL} is not in the provider's model list`
  return null
}

// ---- record / replay cache ----

interface CacheEntry {
  content: string
  model: string
  usage: Usage | null
  recordedAt: string
}

let cache: Record<string, CacheEntry> = {}
try {
  if (existsSync(CACHE_FILE)) cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
} catch {
  cache = {}
}

/** The model is part of the key: a recording made with one model is never
 * presented as the answer of another. */
export function requestKey(req: ChatRequest, model = LLM_MODEL): string {
  const h = createHash('sha256')
  h.update(JSON.stringify([model, req.system, req.history ?? [], req.user]))
  return h.digest('hex').slice(0, 24)
}

function remember(key: string, entry: CacheEntry) {
  cache[key] = entry
  if (process.env.LLM_CACHE_WRITE === '0') return
  try {
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1))
  } catch {
    /* read-only deployment: keep it in memory */
  }
}

/** Replays are looked up under any model that has a recording for this exact
 * prompt, so a keyless deployment works with whatever model the recordings
 * were made with. */
function findRecording(req: ChatRequest): CacheEntry | null {
  const models = new Set([LLM_MODEL, ...Object.values(cache).map((e) => e.model)])
  for (const model of models) {
    const entry = cache[requestKey(req, model)]
    if (entry) return entry
  }
  return null
}

// ---- model check ----

let modelCheck: 'unknown' | 'ok' | 'missing' = 'unknown'

export async function checkModel(): Promise<string> {
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: apiKey() ? { Authorization: `Bearer ${apiKey()}` } : {},
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return `model list unavailable (HTTP ${res.status}); using ${LLM_MODEL} unchecked`
    const j = (await res.json()) as { data: { id: string }[] }
    modelCheck = j.data.some((m) => m.id === LLM_MODEL) ? 'ok' : 'missing'
    if (modelCheck === 'ok') return `model ${LLM_MODEL} is available`
    const free = j.data.map((m) => m.id).filter((id) => !IS_OPENROUTER || id.endsWith(':free')).slice(0, 6)
    return `model ${LLM_MODEL} NOT FOUND at ${BASE_URL}. ${IS_OPENROUTER ? 'Free models' : 'Models'} right now: ${free.join(', ')}`
  } catch (e) {
    return `model list unavailable (${(e as Error).message}); using ${LLM_MODEL} unchecked`
  }
}

export function llmStatus(): { mode: 'live' | 'replay'; model: string; reason: string | null; recordings: number } {
  const blocker = liveBlocker()
  return { mode: blocker ? 'replay' : 'live', model: LLM_MODEL, reason: blocker, recordings: Object.keys(cache).length }
}

// ---- the call ----

export async function chat(req: ChatRequest): Promise<ChatResult> {
  const started = Date.now()
  const blocker = liveBlocker()
  // Without a key any model's recording will do; live, only this model's
  // own answer to the exact same request is reused (and costs nothing).
  const rec = blocker ? findRecording(req) : req.record !== false ? (cache[requestKey(req)] ?? null) : null
  if (rec) {
    return { ok: true, content: rec.content, model: rec.model, usage: rec.usage, latencyMs: 0, source: 'replay', recordedAt: rec.recordedAt }
  }
  if (blocker) return { ok: false, error: blocker, latencyMs: 0 }
  try {
    const res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        ...(apiKey() ? { Authorization: `Bearer ${apiKey()}` } : {}),
        'Content-Type': 'application/json',
        ...(IS_OPENROUTER ? { 'X-Title': 'LensMap AI demo' } : {}),
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: req.system },
          ...(req.history ?? []).map((t) => ({ role: t.role, content: t.content })),
          { role: 'user', content: req.user },
        ],
        // Reasoning models spend part of the budget thinking before the answer.
        max_tokens: req.maxTokens ?? 4000,
        temperature: req.temperature ?? 0.7,
        ...(IS_OPENROUTER ? { usage: { include: true } } : {}),
        // Reasoning models can think through the whole budget on a batch of
        // posts; LLM_REASONING_EFFORT=low keeps room for the answer.
        ...(IS_OPENROUTER && REASONING_EFFORT ? { reasoning: { effort: REASONING_EFFORT } } : {}),
      }),
      signal: AbortSignal.timeout(240_000),
    })
    let latencyMs = Date.now() - started
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      return { ok: false, error: `HTTP ${res.status}: ${body}`, latencyMs }
    }
    const j = (await res.json()) as {
      model?: string
      choices?: { message?: { content?: string } }[]
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
    }
    // The body of a long reply streams in after the headers.
    latencyMs = Date.now() - started
    const content = j.choices?.[0]?.message?.content
    if (!content) return { ok: false, error: 'empty completion', latencyMs }
    const usage: Usage | null = j.usage
      ? { promptTokens: j.usage.prompt_tokens ?? 0, completionTokens: j.usage.completion_tokens ?? 0, costUsd: j.usage.cost ?? null }
      : null
    if (req.record !== false) remember(requestKey(req), { content, model: LLM_MODEL, usage, recordedAt: new Date().toISOString() })
    return { ok: true, content, model: j.model ?? LLM_MODEL, usage, latencyMs, source: 'live' }
  } catch (e) {
    return { ok: false, error: (e as Error).message, latencyMs: Date.now() - started }
  }
}
