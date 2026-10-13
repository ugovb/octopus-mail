import type { Address } from '../../../shared/types'
import { dateLocale, t } from '../../../shared/i18n'

const pad = (n: number) => String(n).padStart(2, '0')
/** Fixed 24-hour "HH:MM" (also used as the value of time inputs). */
export const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** Short weekday names for the list (Sunday first); Polish uses its own short forms (nd, pon, wt…). */
const shortDays = () => t('Sun Mon Tue Wed Thu Fri Sat').split(' ')

/** Compact list date: 14:05 · yesterday · Fri · 12 Oct · 12/10/2024 (Polish: 14:05 · wczoraj · pt · 12 paź · 12.10.2024) */
export function listDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return hhmm(d)
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return t('yesterday')
  const diff = (now.getTime() - ts) / 86400_000
  if (diff < 6 && diff > 0) return shortDays()[d.getDay()]
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short' })
  return d.toLocaleDateString(dateLocale(), { day: '2-digit', month: '2-digit', year: 'numeric' })
}

/** e.g. "Friday, 12 Oct 2024, 14:05" (Polish: "piątek, 12 paź 2024, 14:05") */
export function fullDate(ts: number): string {
  return new Date(ts).toLocaleString(dateLocale(), {
    weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  })
}

export function dayHeader(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return t('Today')
  const y = new Date(now)
  y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return t('Yesterday')
  const diff = (now.getTime() - ts) / 86400_000
  if (diff < 7) return t('This week')
  if (diff < 31) return t('This month')
  if (d.getFullYear() === now.getFullYear()) {
    const m = d.toLocaleDateString(dateLocale(), { month: 'long' })
    return m.charAt(0).toUpperCase() + m.slice(1)
  }
  return String(d.getFullYear())
}

export function displayName(a: Address | null | undefined): string {
  if (!a) return ''
  if (a.name) return a.name
  return a.email.split('@')[0]
}

export function initials(a: Address | null | undefined): string {
  const n = displayName(a).replace(/["']/g, '').trim()
  if (!n) return '?'
  const parts = n.split(/\s+/)
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

const PALETTE = ['#5b4cf0', '#e0567a', '#0e8fb4', '#1f9d61', '#c2410c', '#9333ea', '#0891b2', '#ca8a04', '#db2777', '#4f46e5']
export function colorFor(s: string): string {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

export function fileSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function stripSignatureHtml(html: string): string {
  return html.replace(/<div class="octo-signature">[\s\S]*<\/div>\s*$/i, '')
}

/** Minimal markdown (AI output) → HTML for display and for the composer. */
export function mdToHtml(md: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[#(\d+)\]/g, '<a href="#msg-$1" data-msg="$1">[#$1]</a>')
      .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
  const out: string[] = []
  let list = false
  for (const line of md.split(/\r?\n/)) {
    const li = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/)
    if (li) {
      if (!list) out.push('<ul>')
      list = true
      out.push(`<li>${inline(li[1])}</li>`)
      continue
    }
    if (list) out.push('</ul>')
    list = false
    if (line.trim()) out.push(`<p>${inline(line.replace(/^#+\s*/, ''))}</p>`)
  }
  if (list) out.push('</ul>')
  return out.join('')
}

export function plainToHtml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return esc
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('')
}

/** Clipboard copy that also works on the home server's plain-http page (no navigator.clipboard there). */
export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text)
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  if (!ok) throw new Error(t('Clipboard unavailable'))
}
