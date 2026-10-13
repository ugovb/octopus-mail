// Free-slot finder over the user's calendars ("find a time").
import { addLocalDays, startOfLocalDay } from './ical'
import { listEvents } from './store'

export interface AvailabilityOptions {
  from: number
  to: number
  durationMin: number
  /** Hour the working day starts (may be fractional, e.g. 8.5). Default 9. */
  workdayStart?: number
  /** Hour the working day ends. Default 17. */
  workdayEnd?: number
  includeWeekends?: boolean
  calendarIds?: number[]
  /** Grid for candidate start times, in minutes. Default 30. */
  stepMin?: number
  /** Maximum number of slots returned. Default 500. */
  limit?: number
  /** Allow slots before "now" (default: the search starts no earlier than now). */
  allowPast?: boolean
}

const DAY = 86400_000

/** Merge [start, end) intervals (sorted by start). */
function merge(intervals: [number, number][]): [number, number][] {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const iv of sorted) {
    const last = out[out.length - 1]
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1])
    else out.push([iv[0], iv[1]])
  }
  return out
}

/**
 * Free slots of `durationMin` within working hours. Busy time = events of enabled calendars
 * (or calendarIds) that are not cancelled, not transparent (TRANSP:TRANSPARENT = free; all-day
 * events count as free unless explicitly OPAQUE) and not declined by the user.
 */
export function findAvailability(opts: AvailabilityOptions): { start: number; end: number }[] {
  const dur = Math.round(Number(opts.durationMin) * 60_000)
  if (!(dur > 0)) throw new Error('Podaj długość spotkania w minutach.')
  const step = Math.max(5, Math.round(opts.stepMin ?? 30)) * 60_000
  const ws = opts.workdayStart ?? 9
  const we = opts.workdayEnd ?? 17
  if (!(we > ws) || ws < 0 || we > 24) throw new Error('Godziny pracy są nieprawidłowe (początek musi być przed końcem, w zakresie 0–24).')
  const limit = Math.max(1, opts.limit ?? 500)
  const from = opts.allowPast ? opts.from : Math.max(opts.from, Date.now())
  const to = opts.to
  if (!(to > from)) return []

  const busy = merge(
    listEvents(from - DAY, to + DAY, opts.calendarIds)
      .filter((e) => e.status !== 'CANCELLED' && !e.transparent && e.my_status !== 'DECLINED')
      .map((e) => [e.start, e.end] as [number, number]),
  )

  const out: { start: number; end: number }[] = []
  let idx = 0
  for (let day = startOfLocalDay(from); day < to && out.length < limit; day = addLocalDays(day, 1)) {
    const d = new Date(day)
    const dow = d.getDay()
    if (!opts.includeWeekends && (dow === 0 || dow === 6)) continue
    const base = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, Math.round(ws * 60)).getTime()
    const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, Math.round(we * 60)).getTime()
    const winStart = Math.max(base, from)
    const winEnd = Math.min(dayEnd, to)
    let s = base + Math.ceil(Math.max(0, winStart - base) / step) * step
    for (; s + dur <= winEnd && out.length < limit; s += step) {
      const e = s + dur
      while (idx < busy.length && busy[idx][1] <= s) idx++
      if (idx < busy.length && busy[idx][0] < e) continue
      out.push({ start: s, end: e })
    }
  }
  return out
}
