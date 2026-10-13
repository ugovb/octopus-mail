// Time-zone helpers built on Intl (the IANA database shipped with Node/Electron).
// Used when an ICS references a TZID without embedding its VTIMEZONE (common for
// Google/Outlook exports) and to emit a VTIMEZONE for events we create ourselves.

export interface WallClock {
  year: number
  month: number // 1-12
  day: number
  hour: number
  minute: number
  second: number
}

const dtfCache = new Map<string, Intl.DateTimeFormat>()

function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    dtfCache.set(tz, f)
  }
  return f
}

const validCache = new Map<string, boolean>()

export function isValidTz(tz: string): boolean {
  let ok = validCache.get(tz)
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz })
      ok = true
    } catch {
      ok = false
    }
    validCache.set(tz, ok)
  }
  return ok
}

/** Local wall-clock reading of an instant in the given IANA zone. */
export function wallClockIn(epochMs: number, tz: string): WallClock {
  const parts = dtf(tz).formatToParts(new Date(epochMs))
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  const hour = get('hour')
  return { year: get('year'), month: get('month'), day: get('day'), hour: hour === 24 ? 0 : hour, minute: get('minute'), second: get('second') }
}

/** UTC offset (ms, east positive) of the zone at the given instant. */
export function tzOffsetMs(epochMs: number, tz: string): number {
  const w = wallClockIn(epochMs, tz)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return asUtc - Math.floor(epochMs / 1000) * 1000
}

/** Instant at which the zone's clocks show the given wall-clock time. */
export function zonedToEpoch(w: WallClock, tz: string): number {
  const guess = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  const off1 = tzOffsetMs(guess, tz)
  let t = guess - off1
  const off2 = tzOffsetMs(t, tz)
  if (off2 !== off1) t = guess - off2
  return t
}

/** Wall clock of the process' local zone (what `new Date(y, m, d, ...)` uses). */
export function localWallClock(epochMs: number): WallClock {
  const d = new Date(epochMs)
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() }
}

// Outlook/Exchange put Windows zone names into TZID.
const WINDOWS_TZ: Record<string, string> = {
  'Central European Standard Time': 'Europe/Warsaw',
  'Central Europe Standard Time': 'Europe/Budapest',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Singapore Standard Time': 'Asia/Singapore',
  'Arabian Standard Time': 'Asia/Dubai',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Coordinated Universal Time': 'UTC',
  UTC: 'UTC',
  GMT: 'UTC',
}

/** Map a TZID from an ICS file to an IANA zone name, or null when unknown. */
export function resolveTzid(tzid: string | null | undefined): string | null {
  if (!tzid) return null
  const t = String(tzid).trim().replace(/^"|"$/g, '')
  if (!t) return null
  if (WINDOWS_TZ[t]) return WINDOWS_TZ[t]
  if (isValidTz(t)) return t
  // "/mozilla.org/20050126_1/Europe/Warsaw", "/citadel.org/.../Europe/Berlin", …
  const m = t.match(/([A-Za-z]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?)$/)
  if (m && isValidTz(m[1])) return m[1]
  // Outlook display names like "(UTC+01:00) Sarajevo, Skopje, Warsaw, Zagreb"
  if (/warsaw|warszawa/i.test(t)) return 'Europe/Warsaw'
  return null
}

// ---------- VTIMEZONE generation ----------

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function fmtOffset(ms: number): string {
  const sign = ms < 0 ? '-' : '+'
  const m = Math.round(Math.abs(ms) / 60_000)
  return `${sign}${pad(Math.floor(m / 60))}${pad(m % 60)}`
}

interface Transition {
  at: number // instant of the change
  from: number // offset before
  to: number // offset after
}

function findTransitions(tz: string, year: number): Transition[] {
  const out: Transition[] = []
  const start = Date.UTC(year, 0, 1)
  const end = Date.UTC(year + 1, 0, 1)
  const step = 6 * 3600_000
  let prevT = start
  let prevOff = tzOffsetMs(start, tz)
  for (let t = start + step; t <= end; t += step) {
    const off = tzOffsetMs(t, tz)
    if (off !== prevOff) {
      // binary search the exact minute of the change
      let lo = prevT
      let hi = t
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 120_000) * 60_000
        if (mid <= lo) break
        if (tzOffsetMs(mid, tz) === prevOff) lo = mid
        else hi = mid
      }
      out.push({ at: hi, from: prevOff, to: off })
      prevOff = off
    }
    prevT = t
  }
  return out
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: number): number {
  // nth > 0: nth occurrence; nth = -1: last occurrence. Returns day of month.
  if (nth > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
    return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7
  }
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const last = new Date(Date.UTC(year, month - 1, days)).getUTCDay()
  return days - ((last - weekday + 7) % 7)
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

/**
 * VTIMEZONE block for an IANA zone, derived from this year's transitions
 * (nth-weekday rules cover Europe, North America, Australia, …). Null if the zone is unknown.
 */
export function vtimezoneFor(tz: string, year = new Date().getFullYear()): string | null {
  if (!isValidTz(tz)) return null
  if (tz === 'UTC' || tz === 'Etc/UTC') return null
  const lines = ['BEGIN:VTIMEZONE', `TZID:${tz}`, `X-LIC-LOCATION:${tz}`]
  const trans = findTransitions(tz, year)
  if (trans.length < 2) {
    const off = fmtOffset(tzOffsetMs(Date.UTC(year, 6, 1), tz))
    lines.push('BEGIN:STANDARD', `TZOFFSETFROM:${off}`, `TZOFFSETTO:${off}`, 'DTSTART:19700101T000000', 'END:STANDARD')
  } else {
    for (const tr of trans.slice(0, 2)) {
      const kind = tr.to > tr.from ? 'DAYLIGHT' : 'STANDARD'
      // local wall clock just before the change, in the old offset
      const local = new Date(tr.at + tr.from)
      const month = local.getUTCMonth() + 1
      const day = local.getUTCDate()
      const wd = local.getUTCDay()
      const daysInMonth = new Date(Date.UTC(local.getUTCFullYear(), month, 0)).getUTCDate()
      const nth = day + 7 > daysInMonth ? -1 : Math.ceil(day / 7)
      const d1970 = nthWeekdayOfMonth(1970, month, wd, nth)
      lines.push(
        `BEGIN:${kind}`,
        `TZOFFSETFROM:${fmtOffset(tr.from)}`,
        `TZOFFSETTO:${fmtOffset(tr.to)}`,
        `DTSTART:1970${pad(month)}${pad(d1970)}T${pad(local.getUTCHours())}${pad(local.getUTCMinutes())}00`,
        `RRULE:FREQ=YEARLY;BYMONTH=${month};BYDAY=${nth}${DAY_CODES[wd]}`,
        `END:${kind}`,
      )
    }
  }
  lines.push('END:VTIMEZONE')
  return lines.join('\r\n')
}
