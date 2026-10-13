import iconv from 'iconv-lite'
import { t } from '../shared/i18n'
import type { Address } from '../shared/types'

export interface StructNode {
  part?: string
  type: string
  parameters?: Record<string, string>
  id?: string
  encoding?: string
  size?: number
  disposition?: string
  dispositionParameters?: Record<string, string>
  childNodes?: StructNode[]
}

export interface PartInfo {
  part: string
  mime: string
  filename: string
  size: number
  encoding: string | null
  content_id: string | null
  inline: boolean
}

export interface Structure {
  html: string[]
  text: string[]
  charset: Record<string, string>
  encoding: Record<string, string>
  attachments: PartInfo[]
  calendar: string | null
}

const cleanCid = (id?: string) => (id ? id.replace(/^<|>$/g, '').trim() : null)

/** Pick the displayable body parts and the attachment list out of a BODYSTRUCTURE tree. */
export function analyzeStructure(root: StructNode | undefined): Structure {
  const out: Structure = { html: [], text: [], charset: {}, encoding: {}, attachments: [], calendar: null }
  if (!root) return out

  const filenameOf = (n: StructNode) =>
    n.dispositionParameters?.filename || n.parameters?.name || ''

  const visit = (n: StructNode, inAlternative: boolean, relatedRoot: boolean) => {
    const type = (n.type || '').toLowerCase()
    const part = n.part || '1'
    if (type.startsWith('multipart/')) {
      const kids = n.childNodes || []
      if (type === 'multipart/alternative') {
        const html = kids.find((k) => k.type?.toLowerCase() === 'text/html')
        const plain = kids.find((k) => k.type?.toLowerCase() === 'text/plain')
        const rel = kids.find((k) => k.type?.toLowerCase() === 'multipart/related')
        const cal = kids.find((k) => k.type?.toLowerCase() === 'text/calendar')
        if (cal) {
          out.calendar = cal.part || '1'
          if (cal.parameters?.charset) out.charset[out.calendar] = cal.parameters.charset
          if (cal.encoding) out.encoding[out.calendar] = cal.encoding
        }
        if (rel) visit(rel, true, true)
        else if (html) visit(html, true, false)
        if (plain) {
          const p = plain.part || '1'
          if (!out.text.includes(p)) {
            out.text.push(p)
            if (plain.parameters?.charset) out.charset[p] = plain.parameters.charset
            if (plain.encoding) out.encoding[p] = plain.encoding
          }
        }
        // anything else inside the alternative that is not a body is an attachment
        for (const k of kids) {
          const kt = k.type?.toLowerCase()
          if (k !== html && k !== plain && k !== rel && kt !== 'text/calendar' && !kt?.startsWith('multipart/')) visit(k, true, false)
        }
        return
      }
      if (type === 'multipart/signed' || type === 'multipart/encrypted') {
        if (kids[0]) visit(kids[0], inAlternative, false)
        for (const k of kids.slice(1)) {
          const kt = k.type?.toLowerCase() || ''
          if (!kt.includes('signature') && !kt.includes('pgp-encrypted')) visit(k, inAlternative, false)
        }
        return
      }
      if (type === 'multipart/related') {
        kids.forEach((k, i) => visit(k, inAlternative, i === 0))
        return
      }
      for (const k of kids) visit(k, inAlternative, false)
      return
    }

    const disp = (n.disposition || '').toLowerCase()
    const filename = filenameOf(n)
    const isAttachment = disp === 'attachment' || (!!filename && !type.startsWith('text/'))
    if (!isAttachment && (type === 'text/html' || type === 'text/plain' || type === 'text/enriched')) {
      const target = type === 'text/html' ? out.html : out.text
      if (!target.includes(part)) target.push(part)
      if (n.parameters?.charset) out.charset[part] = n.parameters.charset
      if (n.encoding) out.encoding[part] = n.encoding
      return
    }
    if (type === 'text/calendar' && disp !== 'attachment') {
      out.calendar = part
      if (n.parameters?.charset) out.charset[part] = n.parameters.charset
      if (n.encoding) out.encoding[part] = n.encoding
      return
    }
    if (type === 'text/calendar') out.calendar = out.calendar || part
    const cid = cleanCid(n.id)
    out.attachments.push({
      part,
      mime: type || 'application/octet-stream',
      filename: filename || defaultName(type, cid),
      size: n.size || 0,
      encoding: n.encoding || null,
      content_id: cid,
      inline: disp === 'inline' || (!disp && !!cid) || (relatedRoot === false && !!cid && type.startsWith('image/')),
    })
  }

  visit(root, false, false)
  return out
}

function defaultName(type: string, cid: string | null): string {
  if (type === 'message/rfc822') return t('message.eml')
  if (type === 'text/calendar') return t('invitation.ics')
  const ext = type.split('/')[1]?.replace(/[^a-z0-9]/g, '') || 'bin'
  return cid ? `${cid.split('@')[0]}.${ext}` : t('attachment.{ext}', { ext })
}

export function decodeBuffer(buf: Buffer | null | undefined, charset?: string | null): string {
  if (!buf) return ''
  const cs = (charset || 'utf-8').toLowerCase().replace(/^"|"$/g, '')
  if (cs === 'utf-8' || cs === 'utf8' || cs === 'us-ascii' || cs === 'ascii') return buf.toString('utf8')
  try {
    if (iconv.encodingExists(cs)) return iconv.decode(buf, cs)
  } catch {
    /* fall through */
  }
  return buf.toString('utf8')
}

export function toAddress(a: { name?: string; address?: string } | undefined | null): Address | null {
  if (!a || !a.address) return null
  return { name: (a.name || '').trim() || undefined, email: a.address.trim().toLowerCase() }
}

export function toAddresses(list: { name?: string; address?: string }[] | undefined | null): Address[] {
  return (list || []).map(toAddress).filter((x): x is Address => !!x)
}

/** Parse "Name <a@b>, c@d" or a list of strings into addresses. */
export function parseAddressList(input: string | (string | Address)[] | undefined | null): Address[] {
  if (!input) return []
  const items = Array.isArray(input) ? input : splitAddresses(input)
  const out: Address[] = []
  for (const it of items) {
    if (typeof it !== 'string') {
      if (it?.email) out.push({ name: it.name, email: it.email.trim().toLowerCase() })
      continue
    }
    const s = it.trim()
    if (!s) continue
    const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
    if (m) out.push({ name: m[1].trim() || undefined, email: m[2].trim().toLowerCase() })
    else if (s.includes('@')) out.push({ email: s.replace(/[<>]/g, '').trim().toLowerCase() })
  }
  return out
}

function splitAddresses(s: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuote = false
  let inAngle = false
  for (const ch of s) {
    if (ch === '"') inQuote = !inQuote
    if (ch === '<') inAngle = true
    if (ch === '>') inAngle = false
    if ((ch === ',' || ch === ';') && !inQuote && !inAngle) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out
}

export function formatAddress(a: Address): string {
  if (!a.name) return a.email
  const needsQuote = /[",;<>@()]/.test(a.name)
  return `${needsQuote ? `"${a.name.replace(/"/g, '\\"')}"` : a.name} <${a.email}>`
}

const REPLY_PREFIX = /^\s*((re|fwd?|fw|odp|pd|aw|wg|sv|tr|rif|enc|r|vs|antw|doorst)\s*(\[\d+\])?\s*:\s*)+/i

export function normalizeSubject(s: string | null | undefined): string {
  return (s || '').replace(REPLY_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

export function isReplySubject(s: string | null | undefined): boolean {
  return REPLY_PREFIX.test(s || '')
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", hellip: '…', mdash: '—', ndash: '–',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', copy: '©', reg: '®', zwnj: '', zwj: '',
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z0-9]+);/gi, (m, e: string) => {
    const k = e.toLowerCase()
    if (k.startsWith('#x')) return safeChar(parseInt(k.slice(2), 16))
    if (k.startsWith('#')) return safeChar(parseInt(k.slice(1), 10))
    return ENTITIES[k] ?? m
  })
}

function safeChar(code: number): string {
  try {
    return Number.isFinite(code) ? String.fromCodePoint(code) : ''
  } catch {
    return ''
  }
}

/** Fast, dependency-free HTML → readable text. Good enough for snippets, search and AI. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head|title)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|section|article)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<td[^>]*>/gi, ' ')
      .replace(/<a\s[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
        const text = label.replace(/<[^>]+>/g, '').trim()
        return text && !href.includes(text) ? `${text} (${href})` : text || href
      })
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const QUOTE_HEADERS = [
  /^On .{5,200}wrote:\s*$/im,
  /^W dniu .{5,200}(pisze|napisał\(a\)|napisał|napisała):\s*$/im,
  /^Dnia .{5,200}(pisze|napisał\(a\)|napisał|napisała):\s*$/im,
  /^Am .{5,200}schrieb .*:\s*$/im,
  /^Le .{5,200}a écrit\s*:\s*$/im,
  /^-{2,}\s*Original Message\s*-{2,}/im,
  /^-{2,}\s*Wiadomość oryginalna\s*-{2,}/im,
  /^-{2,}\s*Forwarded message\s*-{2,}/im,
  /^From: .+\n(Sent|Date): /im,
  /^Od: .+\n(Wysłano|Data): /im,
]

/** Strip quoted history and signature from a plain-text body. */
export function stripQuoted(text: string): string {
  let t = text.replace(/\r\n/g, '\n')
  let cut = t.length
  for (const re of QUOTE_HEADERS) {
    const m = re.exec(t)
    if (m && m.index < cut && m.index > 0) cut = m.index
  }
  t = t.slice(0, cut)
  const lines = t.split('\n')
  const out: string[] = []
  for (const line of lines) {
    if (/^-- ?$/.test(line)) break
    if (/^>/.test(line)) continue
    out.push(line)
  }
  return out.join('\n').trim()
}

export function makeSnippet(text: string, max = 200): string {
  return stripQuoted(text).replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Extract mailto/https targets from a List-Unsubscribe header value. */
export function parseListUnsubscribe(v: string | null | undefined): { http?: string; mailto?: string } {
  if (!v) return {}
  const out: { http?: string; mailto?: string } = {}
  for (const m of v.matchAll(/<([^>]+)>/g)) {
    const u = m[1].trim()
    if (u.startsWith('mailto:') && !out.mailto) out.mailto = u
    if (/^https?:/.test(u) && !out.http) out.http = u
  }
  return out
}

export function headerValue(headers: Buffer | string | undefined, name: string): string | null {
  if (!headers) return null
  const text = (typeof headers === 'string' ? headers : headers.toString('utf8')).replace(/\r?\n[ \t]+/g, ' ')
  const re = new RegExp(`^${name}:\\s*(.*)$`, 'im')
  const m = text.match(re)
  return m ? m[1].trim() : null
}

export function parseMsgIds(v: string | null | undefined): string[] {
  if (!v) return []
  const ids = v.match(/<[^<>\s]+>/g)
  if (ids) return ids.map((x) => x.toLowerCase())
  return v.split(/\s+/).filter(Boolean).map((x) => `<${x.replace(/[<>]/g, '').toLowerCase()}>`)
}

export function normMsgId(v: string | null | undefined): string | null {
  if (!v) return null
  const ids = parseMsgIds(v)
  return ids[0] || null
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function textToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** Very small markdown → HTML (paragraphs, bold, italics, links, lists) for CLI/AI-authored drafts. */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let list: 'ul' | 'ol' | null = null
  let para: string[] = []
  const inline = (s: string) =>
    escapeHtml(s)
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2">$2</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`)
    para = []
  }
  const closeList = () => {
    if (list) out.push(`</${list}>`)
    list = null
  }
  for (const line of lines) {
    const ul = line.match(/^\s*[-*•]\s+(.*)$/)
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (ul || ol) {
      flushPara()
      const want = ul ? 'ul' : 'ol'
      if (list !== want) {
        closeList()
        out.push(`<${want}>`)
        list = want
      }
      out.push(`<li>${inline((ul || ol)![1])}</li>`)
    } else if (h) {
      flushPara()
      closeList()
      out.push(`<p><strong>${inline(h[2])}</strong></p>`)
    } else if (!line.trim()) {
      flushPara()
      closeList()
    } else {
      closeList()
      para.push(line)
    }
  }
  flushPara()
  closeList()
  return out.join('\n')
}
