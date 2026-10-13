import type { Address } from '../shared/types'
import { getSettings } from '../core/settings'

/** Local wall-clock time with an explicit UTC offset, e.g. "2026-10-13 10:30 +02:00". */
export function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '-'
  const tz = getSettings().timeZone || 'Europe/Warsaw'
  const d = new Date(ts)
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d)
  const off = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value.replace('GMT', '') || '+00:00'
  return `${parts} ${off || '+00:00'}`
}

export function isoLocal(ts: number | null | undefined): string | null {
  if (!ts) return null
  const s = fmtTime(ts)
  const [date, time, off] = s.split(' ')
  return `${date}T${time}:00${off}`
}

export function addr(a: Address | null | undefined): string {
  if (!a) return ''
  return a.name ? `${a.name} <${a.email}>` : a.email
}

export function addrs(list: Address[] | null | undefined): string {
  return (list || []).map(addr).join(', ')
}

export function trunc(s: string | null | undefined, n: number): string {
  const t = (s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

export function table(rows: Record<string, unknown>[], cols: { key: string; label: string; width?: number }[]): string {
  if (!rows.length) return '(brak)'
  const widths = cols.map((c) => Math.min(c.width ?? 60, Math.max(c.label.length, ...rows.map((r) => String(r[c.key] ?? '').length))))
  const pad = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w))
  const head = cols.map((c, i) => pad(c.label, widths[i])).join('  ')
  const sep = widths.map((w) => '-'.repeat(w)).join('  ')
  const body = rows.map((r) => cols.map((c, i) => pad(String(r[c.key] ?? ''), widths[i])).join('  '))
  return [head, sep, ...body].join('\n')
}
