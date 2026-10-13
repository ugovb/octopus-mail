// Browser version of the Electron preload bridge: when the UI is served by the home server
// (`octo serve`) there is no preload, so `window.octo` talks to the server's HTTP API instead.
import type { CoreEvent, DraftAttachment } from '../../../shared/types'
import { decodeWire, encodeWire } from '../../../shared/wire'

declare global {
  interface Window {
    __OCTO_WEB__?: boolean
  }
}

const H = { 'X-Octo': '1' }

async function call(method: string, ...args: unknown[]): Promise<unknown> {
  const r = await fetch('/api/call', { method: 'POST', headers: H, body: encodeWire({ method, args }) })
  if (r.status === 401) {
    location.reload()
    throw new Error('Sesja wygasła')
  }
  const j = decodeWire<{ result?: unknown; error?: string }>(await r.text())
  if (j.error) throw new Error(j.error)
  return j.result
}

async function stream(method: string, args: unknown[], onDelta: (t: string) => void): Promise<unknown> {
  const r = await fetch('/api/stream', { method: 'POST', headers: H, body: encodeWire({ method, args }) })
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

const eventListeners = new Set<(ev: CoreEvent) => void>()
let source: EventSource | null = null

function ensureEvents(): void {
  if (source) return
  source = new EventSource('/api/events')
  let wasDown = false
  source.onmessage = (m) => {
    try {
      const ev = decodeWire<CoreEvent>(m.data)
      eventListeners.forEach((l) => l(ev))
    } catch {
      /* ignore malformed */
    }
  }
  source.onopen = () => {
    if (wasDown) eventListeners.forEach((l) => l({ type: 'server-connection', online: true, url: location.origin }))
    wasDown = false
  }
  source.onerror = () => {
    if (!wasDown) eventListeners.forEach((l) => l({ type: 'server-connection', online: false, url: location.origin }))
    wasDown = true
  }
}

function pickFilesInBrowser(): Promise<DraftAttachment[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.onchange = async () => {
      const out: DraftAttachment[] = []
      for (const f of Array.from(input.files || [])) {
        const r = await fetch(`/api/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', headers: H, body: f })
        out.push({ ...decodeWire<{ result: DraftAttachment }>(await r.text()).result, mime: f.type || undefined })
      }
      resolve(out)
    }
    input.click()
  })
}

function download(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export function installWebBridge(): void {
  if (window.octo) return
  window.__OCTO_WEB__ = true
  const bridge = {
    call,
    stream,
    on(channel: string, fn: (payload: any) => void) {
      if (channel !== 'core-event') return () => undefined
      ensureEvents()
      eventListeners.add(fn)
      return () => {
        eventListeners.delete(fn)
      }
    },
    oauthAddAccount: async () => {
      throw new Error('Logowanie przez Google/Microsoft jest dostępne w aplikacji na komputerze. W przeglądarce użyj hasła do aplikacji.')
    },
    pickFiles: pickFilesInBrowser,
    openAttachment: async (id: number) => {
      window.open(`/api/attachment/${id}`, '_blank', 'noopener')
      return ''
    },
    saveAttachment: async (id: number) => {
      download(`/api/attachment/${id}?download=1`)
      return ''
    },
    saveAllAttachments: async (ids: number[]) => {
      ids.forEach((id, i) => setTimeout(() => download(`/api/attachment/${id}?download=1`), i * 400))
      return ids.length
    },
    openExternal: async (url: string) => {
      if (/^(https?|mailto):/i.test(url)) window.open(url, '_blank', 'noopener')
    },
    showItem: async () => undefined,
    dataDir: async () => '(serwer domowy)',
    cliPath: async () => ({ script: '', node: '', packaged: false }),
    setBadge: async (_dataUrl: string | null, count: number) => {
      document.title = count ? `(${count}) Octopus Mail` : 'Octopus Mail'
    },
    setLoginItem: async () => undefined,
    windowCmd: async () => undefined,
    // browsers never expose file paths: the composer falls back to uploading the bytes
    filePath: () => '',
    async serverStatus() {
      const [me, devs] = await Promise.all([
        fetch('/api/me', { headers: H }).then((r) => r.json()),
        fetch('/api/devices', { headers: H }).then((r) => r.json()),
      ])
      const info = await fetch('/api/info').then((r) => r.json())
      return {
        mode: 'remote' as const,
        url: location.origin,
        deviceId: me.device.id,
        deviceName: me.device.name,
        serverName: info.hostname,
        online: true,
        devices: devs.devices,
      }
    },
    serverProbe: async () => {
      throw new Error('Niedostępne w przeglądarce')
    },
    serverConnect: async () => {
      throw new Error('Niedostępne w przeglądarce')
    },
    // "Odłącz" in a browser = log out this browser
    async serverDisconnect() {
      await fetch('/api/logout', { method: 'POST', headers: H })
      location.reload()
    },
    serverNewCode: async (name?: string) => (await fetch('/api/devices/pair', { method: 'POST', headers: H, body: encodeWire({ name }) })).json(),
    serverRevoke: async (id: string) => {
      await fetch(`/api/devices/${id}`, { method: 'DELETE', headers: H })
      return true
    },
  }
  ;(window as unknown as { octo: typeof bridge }).octo = bridge
}

/** URL of an inline (cid:) image: a custom protocol in the desktop app, the server API in a browser. */
export function cidUrl(messageId: number, cid: string): string {
  return window.__OCTO_WEB__ ? `/api/cid/${messageId}/${encodeURIComponent(cid)}` : `octo-cid://${messageId}/${encodeURIComponent(cid)}`
}
