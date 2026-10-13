// LLM access: local Ollama by default, Anthropic Claude when the user adds an API key.
import Anthropic from '@anthropic-ai/sdk'
import type { AiResult } from '../../shared/types'
import { claudeKeyName, getSecret, setSecret, deleteSecret } from '../secrets'
import { getSettings } from '../settings'

export interface ChatTurn {
  role: 'user' | 'assistant'
  content: string
}

export interface CompleteOptions {
  system: string
  messages: ChatTurn[]
  maxTokens?: number
  json?: boolean
  onDelta?: (text: string) => void
  /** Claude effort level; small tasks (classification, quick replies) use 'low' */
  effort?: 'low' | 'medium' | 'high'
  signal?: AbortSignal
  provider?: 'ollama' | 'claude'
}

export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (domyślny, najlepszy)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (szybszy, tańszy)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (najtańszy)' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 (najmocniejszy, najdroższy)' },
]

export function setClaudeKey(key: string | null): void {
  if (key) setSecret(claudeKeyName, key.trim())
  else deleteSecret(claudeKeyName)
}

export function hasClaudeKey(): boolean {
  return !!(getSecret(claudeKeyName) || process.env.ANTHROPIC_API_KEY)
}

function claudeClient(): Anthropic {
  const key = getSecret(claudeKeyName) || process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('Brak klucza Claude API — dodaj go w Ustawienia → AI.')
  return new Anthropic({ apiKey: key })
}

export function activeProvider(): 'ollama' | 'claude' | 'off' {
  return getSettings().ai.provider
}

export async function complete(opts: CompleteOptions): Promise<AiResult> {
  const provider = opts.provider || activeProvider()
  if (provider === 'off') throw new Error('Funkcje AI są wyłączone (Ustawienia → AI).')
  return provider === 'claude' ? completeClaude(opts) : completeOllama(opts)
}

async function completeClaude(opts: CompleteOptions): Promise<AiResult> {
  const client = claudeClient()
  const model = getSettings().ai.claudeModel || 'claude-opus-5-5'
  const params = {
    model,
    max_tokens: opts.maxTokens ?? 16000,
    system: opts.system,
    messages: opts.messages,
    output_config: { effort: opts.effort ?? 'medium' },
    // on a safety decline the API retries on a suitable fallback model inside the same call
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default' as const,
  }
  let message: Anthropic.Beta.BetaMessage
  try {
    if (opts.onDelta) {
      const stream = client.beta.messages.stream(params, { signal: opts.signal })
      stream.on('text', (t) => opts.onDelta!(t))
      message = await stream.finalMessage()
    } else {
      message = await client.beta.messages.create(params, { signal: opts.signal })
    }
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Nieprawidłowy klucz Claude API.')
    if (e instanceof Anthropic.RateLimitError) throw new Error('Limit zapytań Claude API — spróbuj za chwilę.')
    if (e instanceof Anthropic.APIError) throw new Error(`Claude API (${e.status}): ${e.message}`)
    throw e
  }
  if (message.stop_reason === 'refusal') throw new Error('Model odmówił wykonania tego zadania.')
  const text = message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  return { text, provider: 'claude', model: message.model }
}

export async function ollamaModels(): Promise<{ name: string; size: number }[]> {
  const base = getSettings().ai.ollamaUrl.replace(/\/$/, '')
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(4000) })
    if (!r.ok) return []
    const j = (await r.json()) as { models?: { name: string; size: number }[] }
    return (j.models || []).map((m) => ({ name: m.name, size: m.size }))
  } catch {
    return []
  }
}

async function completeOllama(opts: CompleteOptions): Promise<AiResult> {
  const s = getSettings().ai
  const base = s.ollamaUrl.replace(/\/$/, '')
  let model = s.ollamaModel
  const installed = await ollamaModels()
  if (!installed.length) throw new Error(`Ollama nie odpowiada pod ${base}. Uruchom Ollamę albo przełącz AI na Claude.`)
  if (!installed.some((m) => m.name === model)) {
    const pick = installed.find((m) => /gemma3:12b|qwen3:8b|qwen3\.5|gemma/.test(m.name)) || installed[0]
    model = pick.name
  }
  const body = {
    model,
    stream: !!opts.onDelta,
    think: false,
    format: opts.json ? 'json' : undefined,
    options: { temperature: opts.json ? 0.1 : 0.4, num_ctx: 16384, num_predict: opts.maxTokens ?? 2048 },
    messages: [{ role: 'system', content: opts.system }, ...opts.messages],
  }
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.signal,
  })
  if (!r.ok) {
    const err = await r.text()
    // older models reject "think": retry once without it
    if (/think/i.test(err)) {
      const r2 = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, think: undefined }),
        signal: opts.signal,
      })
      if (!r2.ok) throw new Error(`Ollama: ${await r2.text()}`)
      return readOllama(r2, !!opts.onDelta, opts.onDelta, model)
    }
    throw new Error(`Ollama: ${err}`)
  }
  return readOllama(r, !!opts.onDelta, opts.onDelta, model)
}

async function readOllama(r: Response, streaming: boolean, onDelta: ((t: string) => void) | undefined, model: string): Promise<AiResult> {
  if (!streaming) {
    const j = (await r.json()) as { message?: { content?: string } }
    return { text: stripThink(j.message?.content || ''), provider: 'ollama', model }
  }
  let text = ''
  const reader = r.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      try {
        const j = JSON.parse(line) as { message?: { content?: string } }
        const piece = j.message?.content || ''
        if (piece) {
          text += piece
          onDelta?.(piece)
        }
      } catch {
        /* partial line */
      }
    }
  }
  return { text: stripThink(text), provider: 'ollama', model }
}

function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

/** Parse JSON from a model reply that may be wrapped in prose or code fences. */
export function parseJsonLoose<T>(text: string, fallback: T): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.search(/[[{]/)
  if (start < 0) return fallback
  const open = candidate[start]
  const close = open === '{' ? '}' : ']'
  const end = candidate.lastIndexOf(close)
  if (end <= start) return fallback
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T
  } catch {
    return fallback
  }
}
