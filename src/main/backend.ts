// Where the desktop app's data lives: the local engine on this computer, or a paired home server.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, net } from 'electron'
import type { AppSettings, CoreEvent, DraftAttachment } from '../shared/types'
import { t } from '../shared/i18n'
import { STREAMING_METHODS } from '../shared/streaming'
import { decodeWire, encodeWire } from '../shared/wire'
import { initCore, startEngine, stopEngine } from '../core/boot'
import { get } from '../core/db'
import { bus } from '../core/events'
import { inboxUnreadCount } from '../core/queries'
import { createService } from '../core/service'
import { DEFAULT_SETTINGS, getSettings } from '../core/settings'

type Fn = (...a: unknown[]) => unknown

export interface NewMailInfo {
  thread_id: number
  subject: string
  from_name: string | null
  from_email: string
  snippet: string
  notify: boolean
}

export interface Backend {
  kind: 'local' | 'remote'
  start(): Promise<void>
  stop(): Promise<void>
  call(method: string, args: unknown[]): Promise<unknown>
  stream(method: string, args: unknown[], onDelta: (t: string) => void): Promise<unknown>
  onEvent(fn: (ev: CoreEvent) => void): () => void
  settings(): AppSettings
  /** Called with fresh settings after they change (local: after the engine's own listeners; remote: once fetched). */
  onSettingsChanged(fn: (s: AppSettings) => void): () => void
  unreadCount(): Promise<number>
  /** Details of new messages for desktop notifications (already filtered by the account's notify mode). */
  newMailInfo(accountId: number, ids: number[]): Promise<NewMailInfo[]>
  /** A file on this computer with the attachment's content. */
  attachmentFile(attId: number): Promise<string>
  /** Inline (cid:) image of a message. */
  cid(messageId: number, cid: string): Promise<Response>
}

// ---------------------------------------------------------------- local

export class LocalBackend implements Backend {
  kind = 'local' as const
  private svc = createService('ui') as unknown as Record<string, Fn>

  async start(): Promise<void> {
    initCore()
    await startEngine('app')
  }

  stop(): Promise<void> {
    return stopEngine()
  }

  async call(method: string, args: unknown[]): Promise<unknown> {
    const fn = this.svc[method]
    if (typeof fn !== 'function') throw new Error(t('Unknown method {method}', { method }))
    return await fn(...(args || []))
  }

  async stream(method: string, args: unknown[], onDelta: (t: string) => void): Promise<unknown> {
    const at = STREAMING_METHODS[method]
    if (at === undefined) throw new Error(t('Method {method} does not support streaming', { method }))
    const a = [...(args || [])].slice(0, at)
    while (a.length < at) a.push(undefined)
    a[at] = onDelta
    return await this.svc[method](...a)
  }

  onEvent(fn: (ev: CoreEvent) => void): () => void {
    return bus.onEvent(fn)
  }

  settings(): AppSettings {
    return getSettings()
  }

  onSettingsChanged(fn: (s: AppSettings) => void): () => void {
    // deferred so core/boot has re-applied its own language first
    return bus.onEvent((ev) => {
      if (ev.type === 'settings-changed') setImmediate(() => fn(getSettings()))
    })
  }

  async unreadCount(): Promise<number> {
    return inboxUnreadCount()
  }

  async newMailInfo(accountId: number, ids: number[]): Promise<NewMailInfo[]> {
    const acc = get<{ notify: string }>('SELECT notify FROM accounts WHERE id = ?', accountId)
    if (!acc || acc.notify === 'none') return []
    return ids
      .map((id) =>
        get(
          `SELECT m.thread_id, m.subject, m.from_name, m.from_email, m.snippet, m.category, t.priority, c.vip
           FROM messages m JOIN threads t ON t.id = m.thread_id LEFT JOIN contacts c ON c.email = m.from_email WHERE m.id = ?`,
          id,
        ),
      )
      .filter((m): m is NonNullable<typeof m> => !!m)
      .map((m) => ({ ...m, notify: acc.notify === 'all' || m.category === 'people' || !!m.priority || !!m.vip }) as NewMailInfo)
      .filter((m) => m.notify)
  }

  async attachmentFile(attId: number): Promise<string> {
    return (await this.call('downloadAttachment', [attId])) as string
  }

  async cid(messageId: number, cid: string): Promise<Response> {
    const att = get<{ id: number }>('SELECT id FROM attachments WHERE message_id = ? AND (content_id = ? OR filename = ?)', messageId, cid, cid)
    if (!att) return new Response('not found', { status: 404 })
    return net.fetch(pathToFileURL(await this.attachmentFile(att.id)).toString())
  }
}

// ---------------------------------------------------------------- remote

export interface RemoteConfig {
  url: string
  token: string
  deviceId: string
  deviceName: string
  serverName?: string
}

export function remoteConfigPath(): string {
  return path.join(app.getPath('userData'), 'server.json')
}

export function loadRemoteConfig(): RemoteConfig | null {
  try {
    const c = JSON.parse(fs.readFileSync(remoteConfigPath(), 'utf8')) as RemoteConfig
    return c.url && c.token ? c : null
  } catch {
    return null
  }
}

export class RemoteBackend implements Backend {
  kind = 'remote' as const
  private listeners = new Set<(ev: CoreEvent) => void>()
  private settingsListeners = new Set<(s: AppSettings) => void>()
  private cachedSettings: AppSettings = DEFAULT_SETTINGS
  private accountsNotify = new Map<number, string>()
  private uploads = new Map<string, DraftAttachment>()
  private abort: AbortController | null = null
  private stopped = false
  online = false

  constructor(public cfg: RemoteConfig) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.cfg.token}`, ...extra }
  }

  private async request(pathname: string, init: RequestInit = {}): Promise<Response> {
    let r: Response
    try {
      r = await fetch(`${this.cfg.url}${pathname}`, { ...init, headers: { ...this.headers(), ...(init.headers as Record<string, string>) } })
    } catch (e) {
      throw new Error(t("Can't reach the home server ({url}): {error}", { url: this.cfg.url, error: (e as Error).message }))
    }
    if (r.status === 401) throw new Error(t('The home server rejected this device — pair it again (Settings → Home server).'))
    return r
  }

  async start(): Promise<void> {
    void this.listen()
    try {
      this.setSettings((await this.call('getSettings', [])) as AppSettings)
      await this.refreshAccounts()
    } catch {
      /* offline at startup: the event loop keeps retrying */
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.abort?.abort()
  }

  private async refreshAccounts(): Promise<void> {
    const accs = (await this.call('listAccounts', [])) as { id: number; notify: string }[]
    this.accountsNotify = new Map(accs.map((a) => [a.id, a.notify]))
  }

  /** Upload local files referenced by a draft; the server can only attach files it has. */
  private async uploadLocalAttachments(input: Record<string, unknown>): Promise<void> {
    const atts = input.attachments as DraftAttachment[] | undefined
    if (!atts?.length) return
    const out: DraftAttachment[] = []
    for (const a of atts) {
      if (!a.path || a.path.startsWith('octo-att:') || !fs.existsSync(a.path)) {
        out.push(a)
        continue
      }
      const st = fs.statSync(a.path)
      const key = `${a.path}|${st.size}|${st.mtimeMs}`
      let up = this.uploads.get(key)
      if (!up) {
        const r = await this.request(`/api/upload?name=${encodeURIComponent(a.filename)}`, { method: 'POST', body: fs.readFileSync(a.path) })
        up = decodeWire<{ result: DraftAttachment }>(await r.text()).result
        this.uploads.set(key, up)
      }
      out.push({ ...a, path: up.path, size: up.size ?? a.size })
    }
    input.attachments = out
  }

  async call(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'saveDraft' && args[0] && typeof args[0] === 'object') await this.uploadLocalAttachments(args[0] as Record<string, unknown>)
    const r = await this.request('/api/call', { method: 'POST', body: encodeWire({ method, args }) })
    const j = decodeWire<{ result?: unknown; error?: string }>(await r.text())
    if (j.error) throw new Error(j.error)
    if (method === 'updateSettings') this.setSettings(j.result as AppSettings)
    return j.result
  }

  async stream(method: string, args: unknown[], onDelta: (t: string) => void): Promise<unknown> {
    const r = await this.request('/api/stream', { method: 'POST', body: encodeWire({ method, args }) })
    const reader = r.body!.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let result: unknown
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        const msg = decodeWire<{ delta?: string; result?: unknown; error?: string }>(line)
        if (msg.delta) onDelta(msg.delta)
        if (msg.error) throw new Error(msg.error)
        if ('result' in msg) result = msg.result
      }
    }
    return result
  }

  onEvent(fn: (ev: CoreEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private setSettings(s: AppSettings): void {
    this.cachedSettings = s
    for (const l of this.settingsListeners) l(s)
  }

  private refreshSettings(): void {
    void this.call('getSettings', []).then((s) => this.setSettings(s as AppSettings)).catch(() => undefined)
  }

  private emit(ev: CoreEvent): void {
    if (ev.type === 'settings-changed') this.refreshSettings()
    if (ev.type === 'mailbox-changed' && ev.accountId === undefined) void this.refreshAccounts().catch(() => undefined)
    for (const l of this.listeners) l(ev)
  }

  private setOnline(online: boolean): void {
    if (this.online === online) return
    this.online = online
    this.emit({ type: 'server-connection', online, url: this.cfg.url } as CoreEvent)
    if (online) {
      this.emit({ type: 'mailbox-changed' })
      this.refreshSettings() // started offline: the cached settings are still the defaults
    }
  }

  /** Live events over Server-Sent Events; reconnects with backoff. */
  private async listen(): Promise<void> {
    let delay = 1000
    while (!this.stopped) {
      this.abort = new AbortController()
      try {
        const r = await fetch(`${this.cfg.url}/api/events`, { headers: this.headers(), signal: this.abort.signal })
        if (r.status === 401) {
          this.setOnline(false)
          this.emit({ type: 'toast', level: 'error', message: t('The home server rejected this device — pair it again (Settings → Home server).') })
          return
        }
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
        this.setOnline(true)
        delay = 1000
        const reader = r.body.getReader()
        const dec = new TextDecoder()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += dec.decode(value, { stream: true })
          let sep: number
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, sep)
            buf = buf.slice(sep + 2)
            const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n')
            if (data) {
              try {
                this.emit(decodeWire<CoreEvent>(data))
              } catch {
                /* malformed event */
              }
            }
          }
        }
      } catch {
        /* network down — retry below */
      }
      if (this.stopped) return
      this.setOnline(false)
      await new Promise((res) => setTimeout(res, delay))
      delay = Math.min(delay * 2, 30_000)
    }
  }

  settings(): AppSettings {
    return this.cachedSettings
  }

  onSettingsChanged(fn: (s: AppSettings) => void): () => void {
    this.settingsListeners.add(fn)
    return () => this.settingsListeners.delete(fn)
  }

  async unreadCount(): Promise<number> {
    const c = (await this.call('counts', [])) as { inboxUnread: number }
    return c.inboxUnread
  }

  async newMailInfo(accountId: number, ids: number[]): Promise<NewMailInfo[]> {
    const mode = this.accountsNotify.get(accountId) || 'smart'
    if (mode === 'none') return []
    const out: NewMailInfo[] = []
    for (const id of ids.slice(0, 5)) {
      const m = (await this.call('getMessage', [id]).catch(() => null)) as {
        thread_id: number; subject: string; from: { name?: string; email: string }; snippet: string; category: string | null
      } | null
      if (!m) continue
      const notify = mode === 'all' || m.category === 'people'
      if (notify) out.push({ thread_id: m.thread_id, subject: m.subject, from_name: m.from.name || null, from_email: m.from.email, snippet: m.snippet, notify })
    }
    return out
  }

  async attachmentFile(attId: number): Promise<string> {
    const dir = path.join(app.getPath('userData'), 'remote-attachments')
    fs.mkdirSync(dir, { recursive: true })
    const r = await this.request(`/api/attachment/${attId}`)
    if (!r.ok) throw new Error(t("The server didn't return the attachment (HTTP {status})", { status: r.status }))
    const disp = r.headers.get('content-disposition') || ''
    const m = disp.match(/filename\*=UTF-8''([^;]+)/)
    const name = (m ? decodeURIComponent(m[1]) : t('attachment-{id}', { id: attId })).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    const file = path.join(dir, `${attId}-${name}`)
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()))
    return file
  }

  async cid(messageId: number, cid: string): Promise<Response> {
    return this.request(`/api/cid/${messageId}/${encodeURIComponent(cid)}`)
  }

  // ---- pairing helpers (used before a config exists) ----

  static async probe(url: string): Promise<{ hostname: string; version: string }> {
    const u = normalizeServerUrl(url)
    let r: Response
    try {
      r = await fetch(`${u}/api/info`, { signal: AbortSignal.timeout(6000) })
    } catch (e) {
      throw new Error(t("Can't connect to {url}: {error}", { url: u, error: (e as Error).message }))
    }
    const j = (await r.json().catch(() => ({}))) as { name?: string; hostname: string; version: string }
    if (j.name !== 'octopus-mail-server') throw new Error(t('{url} is not an Octopus Mail server', { url: u }))
    return j
  }

  static async pair(url: string, code: string, deviceName: string): Promise<RemoteConfig> {
    const u = normalizeServerUrl(url)
    const info = await RemoteBackend.probe(u)
    const r = await fetch(`${u}/api/pair`, { method: 'POST', body: encodeWire({ code, name: deviceName }) })
    const j = decodeWire<{ token?: string; device?: { id: string; name: string }; error?: string }>(await r.text())
    if (!j.token || !j.device) throw new Error(j.error || t('Pairing failed (HTTP {status})', { status: r.status }))
    return { url: u, token: j.token, deviceId: j.device.id, deviceName: j.device.name, serverName: info.hostname }
  }
}

export function normalizeServerUrl(input: string): string {
  let u = input.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`
  const parsed = new URL(u)
  if (!parsed.port && parsed.protocol === 'http:') parsed.port = '8787'
  return parsed.toString().replace(/\/+$/, '')
}
