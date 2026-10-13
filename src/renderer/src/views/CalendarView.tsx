import {
  CalendarDays, CalendarSearch, Check, ChevronLeft, ChevronRight, Circle, CircleCheck, CircleQuestionMark, CircleX, Clock, Cloud, Ellipsis, Globe,
  HardDrive, Lock, Mail, MapPin, PanelLeft, Pencil, Plus, RefreshCw, Repeat, Rss, Sparkles, TextAlignStart, Trash2, TriangleAlert, Users, Video,
} from 'lucide-react'
import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { dateLocale, getLang, t } from '../../../shared/i18n'
import type { CalendarInfo, CoreEvent, EventInput } from '../../../shared/types'
import { formatWhen, parseWhen, SOMEDAY } from '../../../shared/when'
import DrawerButton from '../components/DrawerButton'
import { Button, cx, Field, IconButton, inputCls, Menu, type MenuItem, Modal, Select, Spinner, Toggle } from '../components/ui'
import { api, errorText } from '../lib/api'
import { hhmm } from '../lib/format'
import { isNarrow, useNarrow } from '../lib/narrow'
import { useStore } from '../lib/store'

type Occ = Awaited<ReturnType<typeof api.listEvents>>[number]
type Source = Awaited<ReturnType<typeof api.listCalendarSources>>[number]
type Mode = 'day' | 'week' | 'month' | 'agenda'
type Rsvp = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED'
type AddKind = 'caldav' | 'ics' | 'local' | 'google'

// ---------- dates (local wall-clock time, DST-safe via the Date constructor) ----------

const DAY_MS = 86400_000
const HOUR_PX = 48
// Polish names are kept exactly as before (Intl's Polish short forms differ: "pon." / "niedz."); other languages use Intl.
const PL_MONTHS = ['Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec', 'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień']
const PL_MONTHS_GEN = ['stycznia', 'lutego', 'marca', 'kwietnia', 'maja', 'czerwca', 'lipca', 'sierpnia', 'września', 'października', 'listopada', 'grudnia']
const PL_MONTHS_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru']
const PL_DAYS_SHORT = ['nd', 'pon', 'wt', 'śr', 'czw', 'pt', 'sob']
const PL_DAYS_FULL = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota']
const MODES: { value: Mode; label: string; title: string }[] = [
  { value: 'day', label: t('Day'), title: t('Day (D)') },
  { value: 'week', label: t('Week'), title: t('Week (W)') },
  { value: 'month', label: t('Month'), title: t('Month (M)') },
  { value: 'agenda', label: t('Agenda'), title: t('Agenda (A)') },
]

const pad = (n: number) => String(n).padStart(2, '0')
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function startOfDay(t: number): number {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}
function addDays(t: number, n: number): number {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes()).getTime()
}
function startOfWeek(t: number, weekStartsOn: number): number {
  const d = startOfDay(t)
  return addDays(d, -((new Date(d).getDay() - weekStartsOn + 7) % 7))
}
function startOfMonth(t: number): number {
  const d = new Date(t)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}
function addMonths(t: number, n: number): number {
  const d = new Date(t)
  const last = new Date(d.getFullYear(), d.getMonth() + n + 1, 0).getDate()
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), last)).getTime()
}
function atTime(day: number, hours: number, minutes = 0): number {
  const d = new Date(day)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hours, minutes).getTime()
}
const minutesOfDay = (t: number) => new Date(t).getHours() * 60 + new Date(t).getMinutes()
const isPl = () => getLang() === 'pl'
const fmt = (ts: number, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(dateLocale(), o).format(ts)
/** "pon" / "Mon" */
const weekdayShort = (ts: number) => (isPl() ? PL_DAYS_SHORT[new Date(ts).getDay()] : fmt(ts, { weekday: 'short' }))
/** "poniedziałek" / "Monday" */
const weekdayLong = (ts: number) => (isPl() ? PL_DAYS_FULL[new Date(ts).getDay()] : fmt(ts, { weekday: 'long' }))
/** "13 paź" / "13 Oct" */
function shortDate(ts: number): string {
  const d = new Date(ts)
  return isPl() ? `${d.getDate()} ${PL_MONTHS_SHORT[d.getMonth()]}` : fmt(ts, { day: 'numeric', month: 'short' })
}
/** "13 października" / "13 October" */
function dayMonth(ts: number): string {
  const d = new Date(ts)
  return isPl() ? `${d.getDate()} ${PL_MONTHS_GEN[d.getMonth()]}` : fmt(ts, { day: 'numeric', month: 'long' })
}
/** "Październik 2026" / "October 2026" */
function monthYear(ts: number): string {
  const d = new Date(ts)
  return isPl() ? `${PL_MONTHS[d.getMonth()]} ${d.getFullYear()}` : fmt(ts, { month: 'long', year: 'numeric' })
}
function longDate(ts: number): string {
  const d = new Date(ts)
  const otherYear = d.getFullYear() !== new Date().getFullYear()
  if (!isPl()) return fmt(ts, { weekday: 'long', day: 'numeric', month: 'long', ...(otherYear ? { year: 'numeric' } : {}) })
  const year = otherYear ? ` ${d.getFullYear()}` : ''
  return `${PL_DAYS_FULL[d.getDay()]}, ${d.getDate()} ${PL_MONTHS_GEN[d.getMonth()]}${year}`
}
function dayName(day: number): string {
  const today = startOfDay(Date.now())
  if (day === today) return t('Today')
  if (day === addDays(today, 1)) return t('Tomorrow')
  return cap(weekdayLong(day))
}
const toDateInput = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const toTimeInput = (t: number) => hhmm(new Date(t))
function fromInputs(date: string, time: string): number | null {
  const dm = date.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  const tm = time.match(/^(\d{1,2}):(\d{2})/)
  if (!dm || !tm) return null
  return new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), Number(tm[1]), Number(tm[2])).getTime()
}

function viewDays(mode: Mode, anchor: number, weekStartsOn: number): number[] {
  const first =
    mode === 'week' ? startOfWeek(anchor, weekStartsOn) : mode === 'month' ? startOfWeek(startOfMonth(anchor), weekStartsOn) : startOfDay(anchor)
  const n = mode === 'day' ? 1 : mode === 'week' ? 7 : mode === 'month' ? 42 : 30
  return Array.from({ length: n }, (_, i) => addDays(first, i))
}

function spanLabel(a: number, b: number): string {
  if (!isPl()) return new Intl.DateTimeFormat(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' }).formatRange(a, b)
  const x = new Date(a)
  const y = new Date(b)
  if (x.getFullYear() !== y.getFullYear()) return `${shortDate(a)} ${x.getFullYear()} – ${shortDate(b)} ${y.getFullYear()}`
  if (x.getMonth() !== y.getMonth()) return `${shortDate(a)} – ${shortDate(b)} ${y.getFullYear()}`
  return `${x.getDate()}–${y.getDate()} ${PL_MONTHS_SHORT[y.getMonth()]} ${y.getFullYear()}`
}

function viewTitle(mode: Mode, anchor: number, days: number[]): string {
  const d = new Date(anchor)
  if (mode === 'month') return monthYear(anchor)
  if (mode === 'day') {
    if (!isPl()) return fmt(anchor, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    return cap(`${PL_DAYS_FULL[d.getDay()]}, ${d.getDate()} ${PL_MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}`)
  }
  return spanLabel(days[0], days[days.length - 1])
}

// ---------- event helpers ----------

/** Start of the last day an event covers (end is exclusive). */
const lastDayOf = (start: number, end: number) => startOfDay(end > start ? end - 1 : start)
const isAllDayLike = (e: Occ) => e.all_day || e.end - e.start >= DAY_MS
const onDay = (e: Occ, dayStart: number, dayEnd: number) => e.start < dayEnd && (e.end > dayStart || (e.end === e.start && e.start >= dayStart))
const colorOf = (e: Occ) => e.color || 'var(--accent)'
const isDeclined = (e: Occ) => e.my_status === 'DECLINED' || e.status === 'CANCELLED'
const byStart = (a: Occ, b: Occ) => Number(isAllDayLike(b)) - Number(isAllDayLike(a)) || a.start - b.start || a.end - b.end

function eventWhen(e: Occ): string {
  const last = lastDayOf(e.start, e.end)
  if (e.all_day) {
    return last > startOfDay(e.start)
      ? t('{from} – {to} · all day', { from: longDate(e.start), to: longDate(last) })
      : t('{date} · all day', { date: longDate(e.start) })
  }
  if (last === startOfDay(e.start)) return `${longDate(e.start)} · ${hhmm(new Date(e.start))}–${hhmm(new Date(e.end))}`
  return `${longDate(e.start)}, ${hhmm(new Date(e.start))} – ${longDate(e.end)}, ${hhmm(new Date(e.end))}`
}

/** Time label of an event within one particular day (agenda / month). */
function timeOnDay(e: Occ, day: number): string {
  if (e.all_day) return t('all day')
  const dayEnd = addDays(day, 1)
  const startsToday = e.start >= day
  const endsToday = e.end <= dayEnd
  if (startsToday && endsToday) return `${hhmm(new Date(e.start))}–${hhmm(new Date(e.end))}`
  if (startsToday) return t('from {time}', { time: hhmm(new Date(e.start)) })
  if (endsToday) return t('until {time}', { time: hhmm(new Date(e.end)) })
  return t('all day')
}

/** Soft, theme-aware background for an event in its calendar colour. */
function tone(e: Occ, strength = 16): CSSProperties {
  const color = colorOf(e)
  // unanswered invitation: outlined instead of filled (like Spark)
  if (e.my_status === 'NEEDS-ACTION') return { background: 'var(--surface)', outline: `1px dashed ${color}`, outlineOffset: -1, borderLeft: `3px solid ${color}` }
  return { background: `color-mix(in srgb, ${color} ${strength}%, var(--surface))`, borderLeft: `3px solid ${color}` }
}

/** Calendar descriptions are often HTML (Google): show them as plain text. */
function plainText(s: string | null | undefined): string {
  if (!s) return ''
  if (!/<[a-z][\s\S]*>/i.test(s)) return s.trim()
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"')\]]+)/g)
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <a key={i} href={p} className="break-all text-accent underline" onClick={(e) => (e.preventDefault(), void window.octo.openExternal(p))}>
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  )
}

interface Placed {
  e: Occ
  top: number
  height: number
  col: number
  cols: number
}

/** Timed events of one day → positions with side-by-side columns for overlapping clusters. */
function layoutDay(events: Occ[], dayStart: number, dayEnd: number): Placed[] {
  const items = events
    .map((e) => {
      const s = e.start <= dayStart ? 0 : minutesOfDay(e.start)
      const en = e.end >= dayEnd ? 1440 : minutesOfDay(e.end)
      return { e, s, en: Math.max(en, s + 20) }
    })
    .sort((a, b) => a.s - b.s || b.en - a.en)
  const out: Placed[] = []
  let cluster: Placed[] = []
  let colEnds: number[] = []
  let clusterEnd = -1
  const flush = () => {
    for (const p of cluster) p.cols = colEnds.length
    cluster = []
    colEnds = []
  }
  for (const it of items) {
    if (it.s >= clusterEnd) flush()
    let col = colEnds.findIndex((end) => end <= it.s)
    if (col < 0) {
      col = colEnds.length
      colEnds.push(it.en)
    } else colEnds[col] = it.en
    const p: Placed = { e: it.e, top: (it.s * HOUR_PX) / 60, height: ((it.en - it.s) * HOUR_PX) / 60, col, cols: 1 }
    cluster.push(p)
    out.push(p)
    clusterEnd = Math.max(clusterEnd, it.en)
  }
  flush()
  return out
}

/** All-day / multi-day events of a week → bars with stacked lanes. */
function layoutAllDay(events: Occ[], days: number[]): { e: Occ; start: number; span: number; lane: number }[] {
  const n = days.length
  const first = days[0]
  const end = addDays(days[n - 1], 1)
  const items = events
    .filter((e) => isAllDayLike(e) && onDay(e, first, end))
    .map((e) => {
      const s = days.indexOf(startOfDay(e.start))
      const l = days.indexOf(lastDayOf(e.start, e.end))
      const start = e.start < first ? 0 : Math.max(0, s)
      const last = l < 0 ? n - 1 : l
      return { e, start, span: Math.max(1, last - start + 1), lane: 0 }
    })
    .sort((a, b) => a.start - b.start || b.span - a.span)
  const laneEnds: number[] = []
  for (const it of items) {
    let lane = laneEnds.findIndex((x) => x < it.start)
    if (lane < 0) {
      lane = laneEnds.length
      laneEnds.push(0)
    }
    laneEnds[lane] = it.start + it.span - 1
    it.lane = lane
  }
  return items
}

/** Original DTSTART of a recurring series = earliest RECURRENCE-ID found walking back in time. */
async function findSeriesStart(ev: Occ): Promise<number> {
  const WINDOW = 400 * DAY_MS
  let earliest = ev.occurrence_start ?? ev.start
  let to = earliest
  for (let i = 0; i < 40; i++) {
    const from = to - WINDOW
    const mine = (await api.listEvents(from, to, [ev.calendar_id])).filter((o) => o.id === ev.id)
    if (!mine.length) break
    for (const o of mine) earliest = Math.min(earliest, o.occurrence_start ?? o.start)
    to = from
  }
  return earliest
}

function readLS<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return v == null ? fallback : (JSON.parse(v) as T)
  } catch {
    return fallback
  }
}
function writeLS(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage unavailable — the preference just is not remembered */
  }
}

const HIDDEN_KEY = 'octo.calendar.hidden'
const MODE_KEY = 'octo.calendar.mode'
const SIDE_KEY = 'octo.calendar.side'

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

// ---------- small UI pieces ----------

function Seg<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string; title?: string }[] }) {
  return (
    <div className="flex rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'h-7 rounded-md px-2.5 text-[12.5px] font-medium transition-colors',
            value === o.value ? 'bg-surface text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** IconButton is fixed at 32px (a smaller h-/w- class would lose to it in Tailwind's ordering). */
function SmallIconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button title={title} aria-label={title} onClick={onClick} className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg">
      {children}
    </button>
  )
}

function SideSection({ title, right, children }: { title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-4">
      <div className="flex items-center px-2 pb-1">
        <span className="flex-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{title}</span>
        {right}
      </div>
      {children}
    </div>
  )
}

// ---------- week / day time grid ----------

const HOUR_LINES: CSSProperties = {
  backgroundImage: `repeating-linear-gradient(to bottom, var(--border) 0, var(--border) 1px, transparent 1px, transparent ${HOUR_PX}px)`,
}

function EventBlock({ p, onOpen }: { p: Placed; onOpen: (e: Occ) => void }) {
  const e = p.e
  const tall = p.height >= 34
  const time = `${hhmm(new Date(e.start))}–${hhmm(new Date(e.end))}`
  return (
    <button
      onClick={(ev) => (ev.stopPropagation(), onOpen(e))}
      title={`${e.summary}\n${time}${e.location ? `\n${e.location}` : ''}`}
      className={cx(
        'absolute overflow-hidden rounded-md px-1.5 py-0.5 text-left text-[11.5px] leading-tight text-fg transition-[filter] hover:z-10 hover:brightness-95',
        isDeclined(e) && 'line-through opacity-55',
      )}
      style={{
        top: p.top + 1,
        height: Math.max(p.height - 2, 14),
        left: `calc(${(p.col / p.cols) * 100}% + 2px)`,
        width: `calc(${100 / p.cols}% - 4px)`,
        ...tone(e),
      }}
    >
      {tall ? (
        <>
          <div className="truncate font-semibold">{e.summary || t('(no title)')}</div>
          <div className="truncate text-muted">
            {time}
            {e.location ? ` · ${e.location}` : ''}
          </div>
        </>
      ) : (
        <div className="truncate">
          <span className="font-semibold">{e.summary || t('(no title)')}</span>
          <span className="text-muted"> · {hhmm(new Date(e.start))}</span>
        </div>
      )}
    </button>
  )
}

function DayColumn({ day, events, now, onSlot, onOpen }: {
  day: number; events: Occ[]; now: number; onSlot: (start: number, end: number, allDay: boolean) => void; onOpen: (e: Occ) => void
}) {
  const dayEnd = addDays(day, 1)
  const placed = useMemo(() => layoutDay(events.filter((e) => !isAllDayLike(e) && onDay(e, day, dayEnd)), day, dayEnd), [events, day, dayEnd])
  const isToday = now >= day && now < dayEnd
  const weekend = [0, 6].includes(new Date(day).getDay())
  const click = (ev: React.MouseEvent<HTMLDivElement>) => {
    const r = ev.currentTarget.getBoundingClientRect()
    const min = Math.min(47, Math.max(0, Math.floor(((ev.clientY - r.top) / HOUR_PX) * 2))) * 30
    const start = atTime(day, 0, min)
    onSlot(start, start + 3600_000, false)
  }
  return (
    <div className={cx('relative border-l border-line', weekend && 'bg-surface-2')} style={HOUR_LINES} onClick={click}>
      {placed.map((p) => (
        <EventBlock key={p.e.key} p={p} onOpen={onOpen} />
      ))}
      {isToday && (
        <div className="pointer-events-none absolute inset-x-0 z-20" style={{ top: (minutesOfDay(now) * HOUR_PX) / 60 }}>
          <div className="absolute -left-[5px] -top-[4px] h-2.5 w-2.5 rounded-full bg-danger" />
          <div className="h-[2px] bg-danger" />
        </div>
      )}
    </div>
  )
}

function TimeGrid({ days, events, now, onSlot, onOpen, onDay: openDay }: {
  days: number[]; events: Occ[]; now: number
  onSlot: (start: number, end: number, allDay: boolean) => void; onOpen: (e: Occ) => void; onDay: (day: number) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 7.5 * HOUR_PX
  }, [])
  const allDay = useMemo(() => layoutAllDay(events, days), [events, days])
  const lanes = allDay.reduce((m, x) => Math.max(m, x.lane + 1), 0)
  const n = days.length
  const cols = { gridTemplateColumns: `56px repeat(${n}, minmax(0, 1fr))` }
  const clickAllDay = (ev: React.MouseEvent<HTMLDivElement>) => {
    const r = ev.currentTarget.getBoundingClientRect()
    const i = Math.min(n - 1, Math.max(0, Math.floor(((ev.clientX - r.left) / r.width) * n)))
    onSlot(days[i], addDays(days[i], 1), true)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 border-b border-line pr-[10px]" style={cols}>
        <div />
        {days.map((d) => {
          const date = new Date(d)
          const today = now >= d && now < addDays(d, 1)
          return (
            <button
              key={d}
              onClick={() => openDay(d)}
              title={t('Show this day')}
              className={cx('flex items-center justify-center gap-1.5 border-l border-line py-1.5 hover:bg-hover', today ? 'text-accent' : 'text-muted')}
            >
              <span className="text-[11.5px] uppercase">{n === 1 ? weekdayLong(d) : weekdayShort(d)}</span>
              <span className={cx('flex h-7 min-w-7 items-center justify-center rounded-full px-1 text-[15px] font-semibold', today ? 'bg-accent text-accent-fg' : 'text-fg')}>
                {date.getDate()}
              </span>
            </button>
          )
        })}
      </div>
      <div className="grid shrink-0 border-b border-line pr-[10px]" style={cols}>
        <div className="pr-2 pt-1 text-right text-[10.5px] text-faint">{t('all day')}</div>
        <div className="relative max-h-[104px] overflow-y-auto" style={{ gridColumn: `2 / span ${n}` }} onClick={clickAllDay}>
          <div className="relative" style={{ height: Math.max(1, lanes) * 22 + 4 }}>
            {days.map((d, i) => (
              <div key={d} className="absolute inset-y-0 border-l border-line" style={{ left: `${(i / n) * 100}%` }} />
            ))}
            {allDay.map((x) => (
              <button
                key={x.e.key}
                onClick={(ev) => (ev.stopPropagation(), onOpen(x.e))}
                title={x.e.summary}
                className={cx('absolute truncate rounded-md px-1.5 text-left text-[11.5px] font-medium leading-[20px] text-fg hover:brightness-95', isDeclined(x.e) && 'line-through opacity-55')}
                style={{ left: `calc(${(x.start / n) * 100}% + 2px)`, width: `calc(${(x.span / n) * 100}% - 4px)`, top: 2 + x.lane * 22, height: 20, ...tone(x.e, 24) }}
              >
                {x.e.summary || t('(no title)')}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-scroll">
        <div className="relative grid" style={{ ...cols, height: 24 * HOUR_PX }}>
          <div className="relative">
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <div key={h} className="absolute right-2 text-[10.5px] tabular-nums text-faint" style={{ top: h * HOUR_PX - 7 }}>
                {pad(h)}:00
              </div>
            ))}
          </div>
          {days.map((d) => (
            <DayColumn key={d} day={d} events={events} now={now} onSlot={onSlot} onOpen={onOpen} />
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------- month ----------

function MonthGrid({ days, anchor, events, now, onSlot, onOpen, onDay: openDay }: {
  days: number[]; anchor: number; events: Occ[]; now: number
  onSlot: (start: number, end: number, allDay: boolean) => void; onOpen: (e: Occ) => void; onDay: (day: number) => void
}) {
  const month = new Date(anchor).getMonth()
  const perDay = useMemo(() => days.map((d) => events.filter((e) => onDay(e, d, addDays(d, 1))).sort(byStart)), [days, events])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 grid-cols-7 border-b border-line">
        {days.slice(0, 7).map((d) => (
          <div key={d} className="border-l border-line py-1.5 text-center text-[11.5px] uppercase text-muted first:border-l-0">
            {weekdayShort(d)}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {days.map((d, i) => {
          const date = new Date(d)
          const today = now >= d && now < addDays(d, 1)
          const list = perDay[i]
          const extra = list.length - 3
          return (
            <div
              key={d}
              onClick={() => onSlot(atTime(d, 9), atTime(d, 10), false)}
              className={cx(
                'flex min-h-0 flex-col gap-0.5 overflow-hidden border-b border-l border-line p-1 [&:nth-child(7n+1)]:border-l-0',
                date.getMonth() !== month && 'bg-surface-2',
              )}
            >
              <button
                onClick={(ev) => (ev.stopPropagation(), openDay(d))}
                className={cx(
                  'mb-0.5 flex h-6 min-w-6 items-center justify-center self-start rounded-full px-1 text-[12.5px]',
                  today ? 'bg-accent font-semibold text-accent-fg' : date.getMonth() !== month ? 'text-faint hover:bg-hover' : 'text-fg hover:bg-hover',
                )}
              >
                {date.getDate() === 1 ? shortDate(d) : date.getDate()}
              </button>
              {list.slice(0, extra > 0 ? 2 : 3).map((e) =>
                isAllDayLike(e) ? (
                  <button
                    key={e.key}
                    onClick={(ev) => (ev.stopPropagation(), onOpen(e))}
                    className={cx('truncate rounded px-1.5 text-left text-[11.5px] font-medium leading-[18px] text-fg', isDeclined(e) && 'line-through opacity-55')}
                    style={tone(e, 24)}
                  >
                    {e.summary || t('(no title)')}
                  </button>
                ) : (
                  <button
                    key={e.key}
                    onClick={(ev) => (ev.stopPropagation(), onOpen(e))}
                    className={cx('flex items-center gap-1 truncate rounded px-1 text-left text-[11.5px] leading-[18px] hover:bg-hover', isDeclined(e) && 'line-through opacity-55')}
                  >
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: colorOf(e) }} />
                    <span className="shrink-0 tabular-nums text-muted">{hhmm(new Date(Math.max(e.start, d)))}</span>
                    <span className="truncate">{e.summary || t('(no title)')}</span>
                  </button>
                ),
              )}
              {extra > 0 && (
                <button onClick={(ev) => (ev.stopPropagation(), openDay(d))} className="self-start rounded px-1 text-[11.5px] font-medium text-muted hover:bg-hover hover:text-fg">
                  {t('+{n} more', { n: extra + 1 })}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------- agenda ----------

function AgendaList({ days, events, now, onOpen }: { days: number[]; events: Occ[]; now: number; onOpen: (e: Occ) => void }) {
  const groups = useMemo(
    () => days.map((d) => ({ d, list: events.filter((e) => onDay(e, d, addDays(d, 1))).sort(byStart) })).filter((g) => g.list.length),
    [days, events],
  )
  if (!groups.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center text-muted">
        <CalendarDays size={36} className="text-faint" />
        <div className="text-[14.5px] font-medium text-fg">{t('No events')}</div>
        <div className="text-[12.5px]">{t('Nothing scheduled in the next 30 days.')}</div>
      </div>
    )
  }
  const today = startOfDay(now)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[760px] px-6 pb-10">
        {groups.map(({ d, list }) => (
          <div key={d}>
            <div className="sticky top-0 z-10 flex items-baseline gap-2 border-b border-line bg-surface pb-1.5 pt-4">
              <span className={cx('text-[13.5px] font-semibold', d === today && 'text-accent')}>{dayName(d)}</span>
              <span className="text-[12.5px] text-muted">{dayMonth(d)}</span>
            </div>
            {list.map((e) => (
              <button
                key={e.key}
                onClick={() => onOpen(e)}
                className={cx('flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-hover', isDeclined(e) && 'opacity-55')}
              >
                <span className="w-[92px] shrink-0 pt-px text-[12.5px] tabular-nums text-muted">{timeOnDay(e, d)}</span>
                <span className="mt-[5px] h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: colorOf(e) }} />
                <span className="min-w-0 flex-1">
                  <span className={cx('block truncate text-[13.5px] font-medium', isDeclined(e) && 'line-through')}>{e.summary || t('(no title)')}</span>
                  {(e.location || e.conference_url) && (
                    <span className="block truncate text-[12px] text-muted">{e.location || t('Online meeting')}</span>
                  )}
                </span>
                <span className="shrink-0 pt-px text-[11.5px] text-faint">{e.calendar_name}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------- side panel: mini month, calendars, free slots ----------

function MiniMonth({ anchor, weekStartsOn, now, selFrom, selTo, onPick }: {
  anchor: number; weekStartsOn: number; now: number; selFrom: number; selTo: number; onPick: (day: number) => void
}) {
  const [month, setMonth] = useState(() => startOfMonth(anchor))
  useEffect(() => setMonth(startOfMonth(anchor)), [anchor])
  const days = viewDays('month', month, weekStartsOn)
  const m = new Date(month).getMonth()
  return (
    <div className="px-1">
      <div className="flex items-center px-1 pb-1">
        <span className="flex-1 text-[13px] font-semibold">{monthYear(month)}</span>
        <SmallIconButton title={t('Previous month')} onClick={() => setMonth(addMonths(month, -1))}><ChevronLeft size={14} /></SmallIconButton>
        <SmallIconButton title={t('Next month')} onClick={() => setMonth(addMonths(month, 1))}><ChevronRight size={14} /></SmallIconButton>
      </div>
      <div className="grid grid-cols-7 text-center text-[10.5px] text-faint">
        {days.slice(0, 7).map((d) => (
          <span key={d} className="py-0.5">{weekdayShort(d).slice(0, 2)}</span>
        ))}
        {days.map((d) => {
          const today = now >= d && now < addDays(d, 1)
          const sel = d >= selFrom && d < selTo
          return (
            <button
              key={d}
              onClick={() => onPick(d)}
              className={cx(
                'mx-auto my-px flex h-[26px] w-[26px] items-center justify-center rounded-full text-[12px] tabular-nums',
                today ? 'bg-accent font-semibold text-accent-fg' : sel ? 'bg-accent-soft text-accent' : new Date(d).getMonth() !== m ? 'text-faint hover:bg-hover' : 'text-fg hover:bg-hover',
              )}
            >
              {new Date(d).getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const SOURCE_ICON: Record<string, ReactNode> = {
  google: <Globe size={12} />,
  caldav: <Cloud size={12} />,
  ics: <Rss size={12} />,
  local: <HardDrive size={12} />,
}

function CalendarList({ sources, calendars, hidden, onToggle, onAdd, onSourceMenu }: {
  sources: Source[]; calendars: CalendarInfo[]; hidden: Set<number>
  onToggle: (id: number) => void; onAdd: () => void; onSourceMenu: (s: Source, e: React.MouseEvent) => void
}) {
  return (
    <SideSection title={t('Calendars')} right={<SmallIconButton title={t('Add calendar')} onClick={onAdd}><Plus size={14} /></SmallIconButton>}>
      {sources.map((s) => {
        const cals = calendars.filter((c) => c.source_id === s.id)
        return (
          <div key={s.id} className="mb-1.5">
            <div className="group flex h-6 items-center gap-1.5 px-2 text-[11.5px] text-muted" onContextMenu={(e) => (e.preventDefault(), onSourceMenu(s, e))}>
              <span className="text-faint">{SOURCE_ICON[s.kind]}</span>
              <span className="flex-1 truncate" title={s.name}>{s.name}</span>
              {s.last_error && (
                <span title={t('Sync error: {error}', { error: s.last_error })} className="text-warning">
                  <TriangleAlert size={12} />
                </span>
              )}
              <button className="hidden rounded p-0.5 hover:bg-hover hover:text-fg group-hover:block" title={t('Options')} onClick={(e) => onSourceMenu(s, e)}>
                <Ellipsis size={13} />
              </button>
            </div>
            {cals.map((c) => {
              const visible = !hidden.has(c.id)
              const color = c.color || 'var(--accent)'
              return (
                <button
                  key={c.id}
                  role="checkbox"
                  aria-checked={visible}
                  onClick={() => onToggle(c.id)}
                  className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover"
                  title={c.readonly ? t('{name} (read-only)', { name: c.name }) : c.name}
                >
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border-2" style={{ borderColor: color, background: visible ? color : 'transparent' }}>
                    {visible && <Check size={10} strokeWidth={3.5} className="text-white" />}
                  </span>
                  <span className={cx('flex-1 truncate', (!visible || !c.enabled) && 'text-muted')}>{c.name}</span>
                  {c.readonly && <Lock size={11} className="shrink-0 text-faint" />}
                </button>
              )
            })}
            {!cals.length && <div className="px-2 py-1 text-[12px] text-faint">{s.last_sync ? t('No calendars') : t('Syncing…')}</div>}
          </div>
        )
      })}
      <button onClick={onAdd} className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted hover:bg-hover hover:text-fg">
        <Plus size={14} /> {t('Add calendar')}
      </button>
    </SideSection>
  )
}

function FreeSlots({ onPick }: { onPick: (start: number, end: number) => void }) {
  const toast = useStore((s) => s.toast)
  const [duration, setDuration] = useState<'30' | '60' | '90'>('60')
  const [slots, setSlots] = useState<{ start: number; end: number }[] | null>(null)
  const [busy, setBusy] = useState(false)
  const find = async () => {
    setBusy(true)
    try {
      const now = Date.now()
      setSlots(await api.availability({ from: now, to: now + 7 * DAY_MS, durationMin: Number(duration), limit: 200 }))
    } catch (e) {
      toast({ level: 'error', message: errorText(e) })
    }
    setBusy(false)
  }
  const byDay = useMemo(() => {
    const m = new Map<number, { start: number; end: number }[]>()
    for (const s of slots || []) {
      const d = startOfDay(s.start)
      m.set(d, [...(m.get(d) || []), s])
    }
    return [...m.entries()]
  }, [slots])
  return (
    <SideSection title={t('Find a free slot')}>
      <div className="flex items-center gap-1.5 px-2">
        <Select
          value={duration}
          onChange={(v) => (setDuration(v), setSlots(null))}
          className="min-w-0 flex-1"
          options={[
            { value: '30', label: t('30 min') },
            { value: '60', label: t('1 hour') },
            { value: '90', label: t('1.5 hours') },
          ]}
        />
        <Button size="sm" onClick={() => void find()} disabled={busy}>
          {busy ? <Spinner className="h-3.5 w-3.5" /> : <CalendarSearch size={13} />} {t('Search')}
        </Button>
      </div>
      {slots && (
        <div className="mt-2 px-2">
          {!byDay.length && <div className="py-1 text-[12px] text-muted">{t('No free slots during working hours (9:00–17:00) in the next 7 days.')}</div>}
          {byDay.map(([d, list]) => (
            <div key={d} className="mb-2">
              <div className="pb-1 text-[11.5px] font-medium text-muted">{dayName(d)} · {shortDate(d)}</div>
              <div className="flex flex-wrap gap-1">
                {list.map((s) => (
                  <button
                    key={s.start}
                    onClick={() => onPick(s.start, s.end)}
                    title={t('{time} — create event', { time: `${hhmm(new Date(s.start))}–${hhmm(new Date(s.end))}` })}
                    className="rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[11.5px] tabular-nums hover:border-accent hover:text-accent"
                  >
                    {hhmm(new Date(s.start))}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </SideSection>
  )
}

// ---------- event details ----------

const STATUS_META: Record<string, { label: string; icon: ReactNode; cls: string }> = {
  ACCEPTED: { label: t('Going'), icon: <CircleCheck size={14} />, cls: 'text-success' },
  DECLINED: { label: t('Declined'), icon: <CircleX size={14} />, cls: 'text-danger' },
  TENTATIVE: { label: t('Maybe'), icon: <CircleQuestionMark size={14} />, cls: 'text-warning' },
  'NEEDS-ACTION': { label: t('Awaiting response'), icon: <Circle size={14} />, cls: 'text-faint' },
}

function DetailRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5">
      <span className="mt-0.5 flex w-4 shrink-0 justify-center text-muted">{icon}</span>
      <div className="min-w-0 flex-1 text-[13px]">{children}</div>
    </div>
  )
}

function EventDetails({ ev, onClose, onEdit, onDelete, onChanged }: {
  ev: Occ | null; onClose: () => void; onEdit: (e: Occ) => void; onDelete: (e: Occ) => void; onChanged: () => void
}) {
  const toast = useStore((s) => s.toast)
  const compose = useStore((s) => s.compose)
  const accounts = useStore((s) => s.accounts)
  const [busy, setBusy] = useState(false)
  if (!ev) return null
  const mine = new Set(accounts.map((a) => a.email.toLowerCase()))
  const recipients = [...new Set([ev.organizer?.email, ...ev.attendees.map((a) => a.email)].filter((x): x is string => !!x).map((x) => x.toLowerCase()))].filter(
    (x) => !mine.has(x),
  )
  const canRsvp = !!ev.organizer && !ev.is_organizer && ev.my_status != null
  const description = plainText(ev.description)
  const rsvp = async (r: Rsvp) => {
    setBusy(true)
    try {
      await api.rsvpEvent(ev.id, r)
      toast({ level: 'success', message: t('Response sent to the organizer') })
      onChanged()
    } catch (e) {
      toast({ level: 'error', message: errorText(e) })
    }
    setBusy(false)
  }
  return (
    <Modal
      open
      onClose={onClose}
      width={500}
      title={
        <span className="flex items-center gap-2.5">
          <span className="h-3 w-3 shrink-0 rounded-[4px]" style={{ background: colorOf(ev) }} />
          <span className={cx(isDeclined(ev) && 'line-through')}>{ev.summary || t('(no title)')}</span>
        </span>
      }
      footer={
        <>
          {recipients.length > 0 && (
            <Button variant="ghost" onClick={() => (onClose(), compose({ mode: 'new', prefill: { to: recipients, subject: ev.summary } }))}>
              <Mail size={14} /> {t('Email attendees')}
            </Button>
          )}
          <span className="flex-1" />
          {!ev.readonly && (
            <>
              <Button variant="outline" onClick={() => onDelete(ev)}><Trash2 size={14} /> {t('Delete')}</Button>
              <Button variant="primary" onClick={() => onEdit(ev)}><Pencil size={14} /> {t('Edit')}</Button>
            </>
          )}
        </>
      }
    >
      <div className="selectable px-5 py-3">
        <DetailRow icon={<Clock size={15} />}>
          <div>{cap(eventWhen(ev))}</div>
          {ev.recurring && (
            <div className="mt-0.5 flex items-center gap-1 text-[12px] text-muted">
              <Repeat size={12} /> {t('Recurring event')}
            </div>
          )}
          {ev.status === 'CANCELLED' && <div className="mt-0.5 text-[12px] font-medium text-danger">{t('Cancelled')}</div>}
        </DetailRow>
        {ev.location && (
          <DetailRow icon={<MapPin size={15} />}>
            <Linkified text={ev.location} />
          </DetailRow>
        )}
        {ev.conference_url && (
          <DetailRow icon={<Video size={15} />}>
            <Button size="sm" variant="primary" onClick={() => void window.octo.openExternal(ev.conference_url!)}>
              {t('Join meeting')}
            </Button>
            <div className="mt-1 truncate text-[11.5px] text-faint" title={ev.conference_url}>{ev.conference_url}</div>
          </DetailRow>
        )}
        <DetailRow icon={<CalendarDays size={15} />}>
          <span className="text-muted">{ev.calendar_name}</span>
          {ev.readonly && <span className="ml-1.5 text-[11.5px] text-faint">{t('(read-only)')}</span>}
        </DetailRow>
        {(ev.organizer || ev.attendees.length > 0) && (
          <DetailRow icon={<Users size={15} />}>
            {ev.organizer && (
              <div className="pb-1">
                <span className="text-muted">{t('Organizer:')} </span>
                {ev.is_organizer ? t('You') : ev.organizer.name || ev.organizer.email}
                {!ev.is_organizer && ev.organizer.name && <span className="text-[12px] text-faint"> &lt;{ev.organizer.email}&gt;</span>}
              </div>
            )}
            {ev.attendees.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <div className="text-[12px] text-muted">
                  {t('Attendees ({n}) · {yes} yes', { n: ev.attendees.length, yes: ev.attendees.filter((a) => a.status === 'ACCEPTED').length })}
                </div>
                {ev.attendees.map((a) => {
                  const meta = STATUS_META[(a.status || 'NEEDS-ACTION').toUpperCase()] || STATUS_META['NEEDS-ACTION']
                  return (
                    <div key={a.email} className="flex items-center gap-2" title={meta.label}>
                      <span className={meta.cls}>{meta.icon}</span>
                      <span className="truncate">{a.name || a.email}</span>
                      {a.name && <span className="truncate text-[12px] text-faint">{a.email}</span>}
                      {mine.has(a.email.toLowerCase()) && <span className="text-[11.5px] text-accent">{t('(you)')}</span>}
                    </div>
                  )
                })}
              </div>
            )}
          </DetailRow>
        )}
        {description && (
          <DetailRow icon={<TextAlignStart size={15} />}>
            <div className="max-h-[220px] overflow-y-auto whitespace-pre-wrap break-words text-[12.5px] leading-relaxed">
              <Linkified text={description} />
            </div>
          </DetailRow>
        )}
        {canRsvp && (
          <div className="mt-2 flex items-center gap-2 border-t border-line pt-3">
            <span className="mr-1 text-[12.5px] text-muted">{t('Going?')}</span>
            {busy && <Spinner className="text-muted" />}
            {(['ACCEPTED', 'TENTATIVE', 'DECLINED'] as Rsvp[]).map((r) => (
              <Button key={r} size="sm" variant={ev.my_status === r ? 'primary' : 'soft'} disabled={busy} onClick={() => void rsvp(r)}>
                {r === 'ACCEPTED' ? t('Yes') : r === 'TENTATIVE' ? t('Maybe') : t('No')}
              </Button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  )
}

// ---------- create / edit dialog ----------

interface EditorReq {
  key: number
  ev?: Occ
  /** For an existing recurring event: change only this occurrence or the whole series. */
  scope?: 'single' | 'series'
  start: number
  end: number
  allDay: boolean
}

interface Draft {
  summary: string
  calendarId: string
  allDay: boolean
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  location: string
  description: string
  attendees: string
  conference: string
}

function makeDraft(req: EditorReq, writable: CalendarInfo[]): Draft {
  const ev = req.ev
  const cal = ev?.calendar_id ?? (writable.find((c) => c.is_default) ?? writable[0])?.id
  return {
    summary: ev?.summary ?? '',
    calendarId: cal ? String(cal) : '',
    allDay: req.allDay,
    startDate: toDateInput(req.start),
    startTime: req.allDay ? '09:00' : toTimeInput(req.start),
    endDate: toDateInput(req.allDay ? lastDayOf(req.start, req.end) : req.end),
    endTime: req.allDay ? '10:00' : toTimeInput(req.end),
    location: ev?.location ?? '',
    description: plainText(ev?.description),
    attendees: (ev?.attendees ?? []).map((a) => a.email).join(', '),
    conference: ev?.conference_url ?? '',
  }
}

/** [start, end) of a draft in epoch ms (all-day: local midnights, end exclusive). */
function draftRange(d: Draft): { start: number; end: number } | null {
  const start = fromInputs(d.startDate, d.allDay ? '00:00' : d.startTime)
  const endBase = fromInputs(d.endDate, d.allDay ? '00:00' : d.endTime)
  if (start == null || endBase == null) return null
  return { start, end: d.allDay ? addDays(endBase, 1) : endBase }
}

const splitEmails = (s: string) => s.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)

/** "Lunch z Anią jutro 13:00" → title + start (longest trailing phrase parseWhen understands). */
function parseQuick(text: string, cfg: { morningHour: number; eveningHour: number }): { title: string; start: number } | null {
  const words = text.trim().split(/\s+/)
  for (let i = 0; i < words.length; i++) {
    const t = parseWhen(words.slice(i).join(' '), new Date(), cfg)
    if (t != null && t < SOMEDAY) return { title: words.slice(0, i).join(' '), start: t }
  }
  return null
}

function EventEditor({ req, calendars, onClose, onSaved }: { req: EditorReq; calendars: CalendarInfo[]; onClose: () => void; onSaved: () => void }) {
  const toast = useStore((s) => s.toast)
  const settings = useStore((s) => s.settings)
  const ev = req.ev
  const writable = useMemo(() => calendars.filter((c) => !c.readonly), [calendars])
  const [initial] = useState(() => makeDraft(req, writable))
  const [d, setD] = useState(initial)
  const [quick, setQuick] = useState('')
  const [busy, setBusy] = useState(false)
  const cfg = { morningHour: settings?.snoozeMorningHour ?? 8, eveningHour: settings?.snoozeEveningHour ?? 18 }
  const parsedQuick = quick.trim() ? parseQuick(quick, cfg) : null
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }))
  const single = !!ev && req.scope === 'single'

  /** Moving the start keeps the duration (like every calendar app). */
  const setStart = (date: string, time: string) =>
    setD((p) => {
      const old = draftRange(p)
      const next = { ...p, startDate: date, startTime: time }
      const now = draftRange({ ...next, endDate: date, endTime: time })
      if (!old || !now) return next
      if (p.allDay) {
        const days = Math.round((old.end - old.start) / DAY_MS) - 1
        return { ...next, endDate: toDateInput(addDays(now.start, Math.max(0, days))) }
      }
      const end = now.start + Math.max(0, old.end - old.start)
      return { ...next, endDate: toDateInput(end), endTime: toTimeInput(end) }
    })

  const applyQuick = () => {
    if (!parsedQuick) return
    setD((p) => {
      const r = draftRange(p)
      const dur = !p.allDay && r && r.end > r.start ? r.end - r.start : 3600_000
      const s = parsedQuick.start
      return {
        ...p,
        summary: parsedQuick.title || p.summary,
        allDay: false,
        startDate: toDateInput(s),
        startTime: toTimeInput(s),
        endDate: toDateInput(s + dur),
        endTime: toTimeInput(s + dur),
      }
    })
    setQuick('')
  }

  const save = async () => {
    const r = draftRange(d)
    if (!r) return toast({ level: 'error', message: t('Invalid date or time.') })
    if (r.end < r.start) return toast({ level: 'error', message: t('The event can’t end before it starts.') })
    const attendees = splitEmails(d.attendees)
    const bad = attendees.find((a) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a))
    if (bad) return toast({ level: 'error', message: t('Invalid attendee address: {email}', { email: bad }) })
    setBusy(true)
    try {
      if (!ev) {
        await api.createEvent({
          calendar_id: Number(d.calendarId) || undefined,
          summary: d.summary.trim() || t('New event'),
          description: d.description.trim() || undefined,
          location: d.location.trim() || undefined,
          start: r.start,
          end: r.end,
          all_day: d.allDay,
          attendees,
          conference_url: d.conference.trim() || undefined,
        })
        toast({ level: 'success', message: attendees.length ? t('Event created and invitations sent') : t('Event created') })
      } else {
        // send only what changed, so untouched fields (HTML descriptions, attendee statuses) stay intact
        const patch: Partial<EventInput> = {}
        if (d.summary !== initial.summary) patch.summary = d.summary
        if (d.location !== initial.location) patch.location = d.location.trim()
        if (d.description !== initial.description) patch.description = d.description
        if (d.conference !== initial.conference) patch.conference_url = d.conference.trim()
        if (attendees.join(',').toLowerCase() !== splitEmails(initial.attendees).join(',').toLowerCase()) patch.attendees = attendees
        if (!single && d.calendarId !== initial.calendarId) patch.calendar_id = Number(d.calendarId)
        const timeChanged = r.start !== ev.start || r.end !== ev.end || d.allDay !== ev.all_day
        if (timeChanged) {
          if (ev.recurring && !single) {
            // whole series: shift the series start by the same number of days, use the new time of day and duration
            const base = await findSeriesStart(ev)
            const dayShift = Math.round((startOfDay(r.start) - startOfDay(ev.start)) / DAY_MS)
            const baseDay = addDays(startOfDay(base), dayShift)
            const start = d.allDay ? baseDay : atTime(baseDay, new Date(r.start).getHours(), new Date(r.start).getMinutes())
            patch.start = start
            patch.end = d.allDay ? addDays(start, Math.max(1, Math.round((r.end - r.start) / DAY_MS))) : start + (r.end - r.start)
          } else {
            patch.start = r.start
            patch.end = r.end
          }
          patch.all_day = d.allDay
        }
        if (Object.keys(patch).length) {
          if (single && ev.occurrence_start != null) await api.updateEvent(ev.id, patch, { occurrence_start: ev.occurrence_start })
          else await api.updateEvent(ev.id, patch)
          toast({ level: 'success', message: t('Changes saved') })
        }
      }
      onSaved()
    } catch (e) {
      toast({ level: 'error', message: errorText(e) })
    }
    setBusy(false)
  }

  const dateRow = (label: string, date: string, time: string, onDate: (v: string) => void, onTime: (v: string) => void) => (
    <div className="grid grid-cols-[72px_1fr_120px] items-center gap-2 py-1">
      <span className="text-[12.5px] font-medium text-muted">{label}</span>
      <input type="date" className={inputCls} value={date} onChange={(e) => onDate(e.target.value)} />
      {d.allDay ? <span /> : <input type="time" className={inputCls} value={time} onChange={(e) => onTime(e.target.value)} />}
    </div>
  )

  return (
    <Modal
      open
      onClose={onClose}
      width={580}
      title={ev ? (single ? t('Edit this occurrence') : ev.recurring ? t('Edit the whole series') : t('Edit event')) : t('New event')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={busy || !writable.length} onClick={() => void save()}>
            {busy && <Spinner className="h-3.5 w-3.5" />} {t('Save')}
          </Button>
        </>
      }
    >
      <div className="px-5 py-3" onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (e.preventDefault(), void save())}>
        <Field label={t('Title')}>
          <input autoFocus className={inputCls} value={d.summary} placeholder={t('New event')} onChange={(e) => set('summary', e.target.value)} />
        </Field>
        <Field
          label={t('Quick add')}
          hint={
            quick.trim()
              ? parsedQuick
                ? parsedQuick.title
                  ? t('Enter → “{title}”, {when}', { title: parsedQuick.title, when: formatWhen(parsedQuick.start) })
                  : `Enter → ${formatWhen(parsedQuick.start)}`
                : t('I can’t read a date — try e.g. “tomorrow 10:00”, “fri 14:30”, “20.10 9:15”.')
              : undefined
          }
        >
          <div className="relative">
            <Sparkles size={14} className="absolute left-3 top-2.5 text-muted" />
            <input
              className={cx(inputCls, 'pl-9')}
              value={quick}
              placeholder={t('e.g. tomorrow 10:00 or “Lunch with Anna fri 13:00”')}
              onChange={(e) => setQuick(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.ctrlKey && (e.preventDefault(), applyQuick())}
            />
          </div>
        </Field>
        <div className="grid grid-cols-[1fr_auto] items-end gap-4">
          <Field label={t('Calendar')}>
            {writable.length ? (
              <Select
                value={d.calendarId}
                onChange={(v) => set('calendarId', v)}
                options={writable.map((c) => ({ value: String(c.id), label: `${c.name} · ${c.source_name}` }))}
              />
            ) : (
              <div className="text-[12.5px] text-danger">{t('No writable calendar — add a calendar.')}</div>
            )}
          </Field>
          <div className="pb-1.5">
            <Toggle checked={d.allDay} onChange={(v) => set('allDay', v)} label={t('All day')} />
          </div>
        </div>
        {single && <div className="pb-1 text-[12px] text-faint">{t('Changes apply only to this occurrence — the calendar can’t be changed here.')}</div>}
        {ev?.recurring && !single && <div className="pb-1 text-[12px] text-faint">{t('Changes apply to the whole series; changing the date or time moves every occurrence.')}</div>}
        <div className="py-1.5">
          {dateRow(t('Starts'), d.startDate, d.startTime, (v) => setStart(v, d.startTime), (v) => setStart(d.startDate, v))}
          {dateRow(t('Ends'), d.endDate, d.endTime, (v) => set('endDate', v), (v) => set('endTime', v))}
        </div>
        <Field label={t('Location')}>
          <input className={inputCls} value={d.location} placeholder={t('Address or room')} onChange={(e) => set('location', e.target.value)} />
        </Field>
        <Field label={t('Meeting link')}>
          <input className={inputCls} value={d.conference} placeholder={t('https://meet.google.com/… or Teams / Zoom')} onChange={(e) => set('conference', e.target.value)} />
        </Field>
        <Field label={t('Attendees')} hint={t('Email addresses separated by commas — attendees get an invitation by email.')}>
          <input className={inputCls} value={d.attendees} placeholder={t('anna@example.com, john@example.com')} onChange={(e) => set('attendees', e.target.value)} />
        </Field>
        <Field label={t('Description')}>
          <textarea
            className={cx(inputCls, 'h-24 resize-y py-2 leading-snug')}
            value={d.description}
            onChange={(e) => set('description', e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  )
}

// ---------- adding calendar sources ----------

type Provider = 'icloud' | 'fastmail' | 'nextcloud'

function AddSourceModal({ kind, onClose, onAdded }: { kind: AddKind; onClose: () => void; onAdded: () => void }) {
  const toast = useStore((s) => s.toast)
  const google = useStore((s) => s.accounts).filter((a) => a.auth === 'oauth-google')
  const [tab, setTab] = useState<AddKind>(kind === 'google' && !google.length ? 'caldav' : kind)
  const [provider, setProvider] = useState<Provider>('icloud')
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [accountId, setAccountId] = useState(String(google[0]?.id ?? ''))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tabs: { value: AddKind; label: string }[] = [
    { value: 'caldav', label: 'CalDAV' },
    { value: 'ics', label: t('ICS subscription') },
    { value: 'local', label: t('Local') },
    ...(google.length ? [{ value: 'google' as AddKind, label: 'Google' }] : []),
  ]

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      if (tab === 'caldav') {
        const server = url.trim() || (provider === 'nextcloud' ? '' : provider)
        await api.addCalendarSource({ kind: 'caldav', url: server || undefined, username: username.trim(), password, name: name.trim() || undefined })
      } else if (tab === 'ics') {
        await api.addCalendarSource({ kind: 'ics', url: url.trim(), name: name.trim() || undefined })
      } else if (tab === 'google') {
        await api.addCalendarSource({ kind: 'google', accountId: Number(accountId), name: name.trim() || undefined })
      } else {
        await api.addCalendarSource({ kind: 'local', name: name.trim() || undefined })
      }
      toast({ level: 'success', message: tab === 'local' ? t('Local calendar added') : t('Calendar added — syncing') })
      onAdded()
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={520}
      title={t('Add calendar')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void submit()}>
            {busy && <Spinner className="h-3.5 w-3.5" />} {t('Add')}
          </Button>
        </>
      }
    >
      <div className="px-5 py-4" onKeyDown={(e) => e.key === 'Enter' && e.target instanceof HTMLInputElement && void submit()}>
        <Seg value={tab} onChange={(v) => (setTab(v), setError(null))} options={tabs} />
        <div className="mt-3">
          {tab === 'caldav' && (
            <>
              <Field label={t('Provider')}>
                <Select
                  value={provider}
                  onChange={setProvider}
                  options={[
                    { value: 'icloud', label: 'iCloud' },
                    { value: 'fastmail', label: 'Fastmail' },
                    { value: 'nextcloud', label: t('Nextcloud / other CalDAV server') },
                  ]}
                />
              </Field>
              <Field
                label={provider === 'nextcloud' ? t('Server address') : t('Server address (optional)')}
                hint={provider === 'nextcloud' ? t('E.g. https://cloud.example.com/remote.php/dav') : t('Leave empty — the address is set automatically.')}
              >
                <input className={inputCls} value={url} placeholder={provider === 'nextcloud' ? 'https://…/remote.php/dav' : provider === 'icloud' ? 'https://caldav.icloud.com' : 'https://caldav.fastmail.com'} onChange={(e) => setUrl(e.target.value)} />
              </Field>
              <Field label={t('Username')}>
                <input className={inputCls} value={username} placeholder={t('usually your email address')} onChange={(e) => setUsername(e.target.value)} />
              </Field>
              <Field
                label={provider === 'nextcloud' ? t('Password') : t('App password')}
                hint={
                  provider === 'icloud'
                    ? t('Create an app-specific password at appleid.apple.com → Sign-In and Security.')
                    : provider === 'fastmail'
                      ? t('Create an app password in Fastmail → Settings → Privacy & Security.')
                      : t('The password will be stored {where}, not in the database.', { where: useStore.getState().secretStore })
                }
              >
                <input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            </>
          )}
          {tab === 'ics' && (
            <Field label={t('Subscription URL')} hint={t('An .ics or webcal:// link — e.g. holidays, a class timetable, a team calendar. Subscriptions are read-only.')}>
              <input autoFocus className={inputCls} value={url} placeholder={t('webcal://… or https://….ics')} onChange={(e) => setUrl(e.target.value)} />
            </Field>
          )}
          {tab === 'local' && (
            <p className="py-1.5 text-[13px] text-muted">
              {t('A local calendar is stored only on this computer — it doesn’t sync with any server. Invitations to attendees are still sent by email.')}
            </p>
          )}
          {tab === 'google' && (
            <Field label={t('Google account')} hint={t('Calendars of Google accounts signed in with OAuth are usually added automatically.')}>
              <Select value={accountId} onChange={setAccountId} options={google.map((a) => ({ value: String(a.id), label: a.email }))} />
            </Field>
          )}
          <Field label={t('Name (optional)')}>
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          {error && <div className="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        </div>
      </div>
    </Modal>
  )
}

function Onboarding({ onAdd }: { onAdd: (k: AddKind) => void }) {
  const google = useStore((s) => s.accounts).filter((a) => a.auth === 'oauth-google')
  const card = (k: AddKind, icon: ReactNode, title: string, text: string) => (
    <button onClick={() => onAdd(k)} className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface p-4 text-left transition-colors hover:border-accent hover:bg-hover">
      <span className="text-accent">{icon}</span>
      <span className="text-[13.5px] font-semibold">{title}</span>
      <span className="text-[12px] text-muted">{text}</span>
    </button>
  )
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-bg p-8">
      <div className="max-w-[600px] text-center">
        <CalendarDays size={40} className="mx-auto mb-3 text-faint" />
        <div className="text-[18px] font-semibold">{t('You don’t have any calendars yet')}</div>
        <p className="mx-auto mt-2 max-w-[480px] text-[13px] text-muted">
          {t('Google accounts added with OAuth sign-in (Settings → Accounts) get their calendar automatically — events sync on their own. You can also connect another calendar:')}
        </p>
        <div className="mt-5 grid grid-cols-3 gap-3">
          {card('caldav', <Cloud size={20} />, 'CalDAV', t('iCloud, Fastmail, Nextcloud — username and app password'))}
          {card('ics', <Rss size={20} />, t('ICS subscription'), t('An .ics or webcal:// link (read-only)'))}
          {card('local', <HardDrive size={20} />, t('Local'), t('A calendar only on this computer'))}
        </div>
        {google.length > 0 && (
          <div className="mt-4">
            <Button variant="soft" onClick={() => onAdd('google')}>
              <Globe size={14} /> {t('Connect Google Calendar ({emails})', { emails: google.map((a) => a.email).join(', ') })}
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- the view ----------

interface Ask {
  title: string
  message: string
  actions: { label: string; variant?: 'primary' | 'danger' | 'soft'; run: () => void }[]
}

export default function CalendarView() {
  const toast = useStore((s) => s.toast)
  const narrow = useNarrow()
  const weekStartsOn = useStore((s) => s.settings?.weekStartsOn ?? 1)
  const [mode, setModeState] = useState<Mode>(() => {
    const m = readLS<string>(MODE_KEY, 'week')
    // seven columns do not fit on a phone: start with the agenda there
    if (isNarrow() && m === 'week') return 'agenda'
    return MODES.some((x) => x.value === m) ? (m as Mode) : 'week'
  })
  const [anchor, setAnchor] = useState(() => startOfDay(Date.now()))
  const [side, setSide] = useState(() => readLS<boolean>(SIDE_KEY, true) !== false)
  const [hidden, setHidden] = useState<Set<number>>(() => {
    const raw = readLS<unknown>(HIDDEN_KEY, [])
    return new Set(Array.isArray(raw) ? raw.filter((x): x is number => Number.isFinite(x)) : [])
  })
  const [calendars, setCalendars] = useState<CalendarInfo[]>([])
  const [sources, setSources] = useState<Source[] | null>(null)
  const [events, setEvents] = useState<Occ[]>([])
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [selected, setSelected] = useState<Occ | null>(null)
  const [editor, setEditor] = useState<EditorReq | null>(null)
  const [adding, setAdding] = useState<AddKind | null>(null)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [sourceMenu, setSourceMenu] = useState<{ x: number; y: number; s: Source } | null>(null)

  const days = useMemo(() => viewDays(mode, anchor, weekStartsOn), [mode, anchor, weekStartsOn])
  const from = days[0]
  const to = addDays(days[days.length - 1], 1)
  const visible = useMemo(() => events.filter((e) => !hidden.has(e.calendar_id)), [events, hidden])
  const writable = calendars.filter((c) => !c.readonly)

  const setMode = (m: Mode) => {
    setModeState(m)
    writeLS(MODE_KEY, m)
  }

  // ---- data ----
  const reqId = useRef(0)
  const loadEvents = useCallback(async () => {
    const id = ++reqId.current
    setLoading(true)
    try {
      const list = await api.listEvents(from, to)
      if (id === reqId.current) setEvents(list)
    } catch (e) {
      if (id === reqId.current) toast({ level: 'error', message: errorText(e) })
    } finally {
      if (id === reqId.current) setLoading(false)
    }
  }, [from, to, toast])
  const loadMeta = useCallback(async () => {
    try {
      const [c, s] = await Promise.all([api.listCalendars(), api.listCalendarSources()])
      setCalendars(c)
      setSources(s)
    } catch (e) {
      setSources((s) => s ?? [])
      toast({ level: 'error', message: errorText(e) })
    }
  }, [toast])
  const latest = useRef({ loadEvents, loadMeta })
  latest.current = { loadEvents, loadMeta }

  useEffect(() => void loadEvents(), [loadEvents])
  useEffect(() => void loadMeta(), [loadMeta])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.octo.on('core-event', (e: CoreEvent) => {
      if (e.type !== 'calendar-changed') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void latest.current.loadMeta()
        void latest.current.loadEvents()
      }, 200)
    })
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      off()
      clearInterval(tick)
      if (timer) clearTimeout(timer)
    }
  }, [])

  // keep an open details dialog in sync with refreshed data (RSVP, edits from elsewhere)
  useEffect(() => {
    setSelected((s) => (s ? events.find((e) => e.key === s.key) ?? s : s))
  }, [events])

  // ---- navigation ----
  const step = (dir: number) =>
    setAnchor((a) => (mode === 'month' ? addMonths(a, dir) : addDays(a, dir * (mode === 'day' ? 1 : mode === 'week' ? 7 : 30))))
  const goDay = (d: number) => {
    setAnchor(d)
    setMode('day')
  }
  const toggleHidden = (id: number) =>
    setHidden((h) => {
      const n = new Set(h)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      writeLS(HIDDEN_KEY, [...n])
      return n
    })
  const toggleSide = () =>
    setSide((v) => {
      writeLS(SIDE_KEY, !v)
      return !v
    })

  // ---- actions ----
  const openCreate = (start: number, end: number, allDay: boolean) => {
    if (!writable.length) {
      toast({ level: 'error', message: t('There’s no calendar you can save events to.'), action: { label: t('Add calendar'), run: () => setAdding('local') } })
      return
    }
    setEditor({ key: Date.now(), start, end, allDay })
  }
  /** Next half hour when today is on screen, otherwise 9:00 on the first shown day. */
  const newEvent = () => {
    const today = startOfDay(Date.now())
    const shown = mode === 'month' ? today >= startOfMonth(anchor) && today < addMonths(startOfMonth(anchor), 1) : today >= from && today < to
    const start = shown ? Math.ceil((Date.now() + 1) / 1800_000) * 1800_000 : atTime(mode === 'month' ? startOfMonth(anchor) : from, 9)
    openCreate(start, start + 3600_000, false)
  }

  const recurringOcc = (e: Occ) => e.recurring && e.occurrence_start != null

  const editEvent = (e: Occ) => {
    const open = (scope: 'single' | 'series') => {
      setAsk(null)
      setSelected(null)
      setEditor({ key: Date.now(), ev: e, scope, start: e.start, end: e.end, allDay: e.all_day })
    }
    if (!recurringOcc(e)) return open('series')
    setAsk({
      title: t('Edit recurring event?'),
      message: t('“{title}” repeats. What do you want to change?', { title: e.summary || t('Event') }),
      actions: [
        { label: t('Only this occurrence'), variant: 'soft', run: () => open('single') },
        { label: t('The whole series'), variant: 'primary', run: () => open('series') },
      ],
    })
  }

  const deleteEvent = (e: Occ) => {
    const run = async (single: boolean) => {
      setAsk(null)
      try {
        if (single && e.occurrence_start != null) await api.deleteEvent(e.id, { occurrence_start: e.occurrence_start })
        else await api.deleteEvent(e.id)
        setSelected(null)
        toast({ level: 'success', message: single ? t('Occurrence deleted') : t('Event deleted') })
        void loadEvents()
      } catch (err) {
        toast({ level: 'error', message: errorText(err) })
      }
    }
    const guests = e.is_organizer && e.attendees.length > 0 ? ` ${t('Attendees will get a cancellation by email.')}` : ''
    const title = e.summary || t('Event')
    if (recurringOcc(e)) {
      setAsk({
        title: t('Delete recurring event?'),
        message: t('“{title}” repeats. What do you want to delete?', { title }) + guests,
        actions: [
          { label: t('Only this occurrence'), variant: 'soft', run: () => void run(true) },
          { label: t('The whole series'), variant: 'danger', run: () => void run(false) },
        ],
      })
    } else {
      setAsk({
        title: t('Delete event?'),
        message: t('“{title}” will be deleted from the calendar “{calendar}”.', { title, calendar: e.calendar_name }) + guests,
        actions: [{ label: t('Delete'), variant: 'danger', run: () => void run(false) }],
      })
    }
  }

  const syncAll = async (sourceId?: number) => {
    setSyncing(true)
    try {
      await api.syncCalendars(sourceId)
      const s = await api.listCalendarSources()
      setSources(s)
      const failed = s.filter((x) => x.last_error && (sourceId == null || x.id === sourceId))
      if (failed.length) toast({ level: 'error', message: t('Couldn’t sync: {list}', { list: failed.map((f) => `${f.name} — ${f.last_error}`).join('; ') }) })
      else toast({ level: 'success', message: t('Calendars synced') })
      void loadMeta()
      void loadEvents()
    } catch (e) {
      toast({ level: 'error', message: errorText(e) })
    }
    setSyncing(false)
  }

  const removeSource = (s: Source) =>
    setAsk({
      title: t('Remove calendar?'),
      message: `${t('“{name}” will be removed from Octopus Mail together with its locally saved events.', { name: s.name })} ${
        s.kind === 'local' ? t('The local calendar’s events will be lost.') : t('Data on the server stays unchanged.')
      }`,
      actions: [
        {
          label: t('Remove'),
          variant: 'danger',
          run: () => {
            setAsk(null)
            void api
              .removeCalendarSource(s.id)
              .then(() => (toast({ level: 'success', message: t('Calendar removed') }), void loadMeta(), void loadEvents()))
              .catch((e) => toast({ level: 'error', message: errorText(e) }))
          },
        },
      ],
    })

  const sourceItems = (s: Source): MenuItem[] => [
    ...(s.kind !== 'local' ? [{ label: t('Sync now'), icon: <RefreshCw size={14} />, onClick: () => void syncAll(s.id) }] : []),
    {
      label: t('Show only this one'),
      icon: <CalendarDays size={14} />,
      onClick: () => {
        const n = new Set(calendars.filter((c) => c.source_id !== s.id).map((c) => c.id))
        writeLS(HIDDEN_KEY, [...n])
        setHidden(n)
      },
    },
    { separator: true, label: '' },
    { label: t('Remove calendar…'), icon: <Trash2 size={14} />, danger: true, onClick: () => removeSource(s) },
  ]

  // ---- keyboard ----
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keys.current = (e: KeyboardEvent) => {
    const st = useStore.getState()
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return
    if (selected || editor || adding || ask || sourceMenu || st.palette || (st.composer && !st.composer.inline)) return
    const k = e.key
    if (k === 't') setAnchor(startOfDay(Date.now()))
    else if (k === 'd') setMode('day')
    else if (k === 'w') setMode('week')
    else if (k === 'm') setMode('month')
    else if (k === 'a') setMode('agenda')
    else if (k === 'n') newEvent()
    else if (k === 'ArrowLeft' || k === 'k') step(-1)
    else if (k === 'ArrowRight' || k === 'j') step(1)
    else return
    e.preventDefault()
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const reloadAfterSave = () => {
    setEditor(null)
    void loadEvents()
  }

  const modals = (
    <>
      {adding && <AddSourceModal kind={adding} onClose={() => setAdding(null)} onAdded={() => (setAdding(null), void loadMeta(), void loadEvents())} />}
      <Modal
        open={!!ask}
        onClose={() => setAsk(null)}
        title={ask?.title}
        width={440}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsk(null)}>{t('Cancel')}</Button>
            {ask?.actions.map((a) => (
              <Button key={a.label} variant={a.variant || 'primary'} onClick={a.run}>{a.label}</Button>
            ))}
          </>
        }
      >
        <div className="px-5 py-4 text-[13.5px]">{ask?.message}</div>
      </Modal>
    </>
  )

  if (sources === null) {
    return <div className="flex h-full min-w-0 flex-1 items-center justify-center bg-surface text-muted"><Spinner /></div>
  }

  if (!sources.length) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-surface">
        <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-line px-4 text-[15px] font-semibold max-md:px-2"><DrawerButton />{t('Calendar')}</div>
        <Onboarding onAdd={setAdding} />
        {modals}
      </div>
    )
  }

  const selFrom = mode === 'month' ? startOfMonth(anchor) : from
  const selTo = mode === 'month' ? addMonths(startOfMonth(anchor), 1) : mode === 'agenda' ? from : to

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-surface">
      <div className="flex h-12 shrink-0 items-center gap-1.5 border-b border-line px-3 max-md:h-auto max-md:flex-wrap max-md:px-2 max-md:py-1.5">
        <DrawerButton />
        {!narrow && <IconButton title={side ? t('Hide sidebar') : t('Show sidebar')} active={side} onClick={toggleSide}><PanelLeft size={16} /></IconButton>}
        <Button size="sm" variant="outline" onClick={() => setAnchor(startOfDay(Date.now()))} title={t('Today (T)')}>{t('Today')}</Button>
        <IconButton title={t('Previous (←)')} onClick={() => step(-1)}><ChevronLeft size={17} /></IconButton>
        <IconButton title={t('Next (→)')} onClick={() => step(1)}><ChevronRight size={17} /></IconButton>
        <div className="ml-1 min-w-0 truncate text-[15px] font-semibold">{viewTitle(mode, anchor, days)}</div>
        {loading && <Spinner className="ml-1 text-muted" />}
        <span className="flex-1" />
        <div className="max-md:order-last max-md:flex max-md:basis-full max-md:justify-center">
          <Seg value={mode} onChange={setMode} options={narrow ? MODES.filter((m) => m.value !== 'week') : MODES} />
        </div>
        <IconButton title={t('Sync calendars')} disabled={syncing} onClick={() => void syncAll()}>
          <RefreshCw size={15} className={cx(syncing && 'animate-spin')} />
        </IconButton>
        <Button variant="primary" size="sm" onClick={newEvent} title={t('New event (N)')}>
          <Plus size={14} /> {!narrow && t('New event')}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        {side && !narrow && (
          <aside className="w-[236px] shrink-0 overflow-y-auto border-r border-line px-2 py-3">
            <MiniMonth anchor={anchor} weekStartsOn={weekStartsOn} now={now} selFrom={selFrom} selTo={selTo} onPick={(d) => setAnchor(d)} />
            <CalendarList
              sources={sources}
              calendars={calendars}
              hidden={hidden}
              onToggle={toggleHidden}
              onAdd={() => setAdding('caldav')}
              onSourceMenu={(s, e) => setSourceMenu({ x: e.clientX, y: e.clientY, s })}
            />
            <FreeSlots onPick={(s, e) => openCreate(s, e, false)} />
          </aside>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          {(mode === 'week' || mode === 'day') && (
            <TimeGrid key={mode} days={days} events={visible} now={now} onSlot={openCreate} onOpen={setSelected} onDay={goDay} />
          )}
          {mode === 'month' && <MonthGrid days={days} anchor={anchor} events={visible} now={now} onSlot={openCreate} onOpen={setSelected} onDay={goDay} />}
          {mode === 'agenda' && <AgendaList days={days} events={visible} now={now} onOpen={setSelected} />}
        </div>
      </div>
      <EventDetails ev={selected} onClose={() => setSelected(null)} onEdit={editEvent} onDelete={deleteEvent} onChanged={() => void loadEvents()} />
      {editor && <EventEditor key={editor.key} req={editor} calendars={calendars} onClose={() => setEditor(null)} onSaved={reloadAfterSave} />}
      <Menu items={sourceMenu ? sourceItems(sourceMenu.s) : []} anchor={sourceMenu ? { x: sourceMenu.x, y: sourceMenu.y } : null} onClose={() => setSourceMenu(null)} />
      {modals}
    </div>
  )
}
