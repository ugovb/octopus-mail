// JSON transport for the home-server API: like JSON, but binary data survives the trip
// (Uint8Array/Buffer ⇄ {"$bytes": "<base64>"}).

function toBase64(u8: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64')
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'))
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export function encodeWire(value: unknown): string {
  return JSON.stringify(value, function (this: unknown, _key, v) {
    if (v instanceof Uint8Array) return { $bytes: toBase64(v) }
    // Buffer.toJSON runs before the replacer sees the value
    if (v && typeof v === 'object' && (v as { type?: string }).type === 'Buffer' && Array.isArray((v as { data?: unknown }).data)) {
      return { $bytes: toBase64(Uint8Array.from((v as { data: number[] }).data)) }
    }
    return v
  })
}

export function decodeWire<T = unknown>(text: string): T {
  return JSON.parse(text, (_key, v) => {
    if (v && typeof v === 'object' && typeof (v as { $bytes?: unknown }).$bytes === 'string' && Object.keys(v).length === 1) {
      return fromBase64((v as { $bytes: string }).$bytes)
    }
    return v
  }) as T
}

export const SERVER_DEFAULT_PORT = 8787

export interface ServerInfo {
  name: 'octopus-mail-server'
  version: string
  hostname: string
  accounts: number
  engine: boolean
}
