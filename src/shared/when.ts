// Snooze / Send Later / Remind presets and a small natural-language date parser (PL + EN).
// All times are local wall-clock time of the machine.
// parseWhen() understands English and Polish whatever the UI language; formatWhen() and the
// preset labels follow the UI language (shared/i18n).
import { dateLocale, getLang, t } from './i18n'

export type PresetId =
  | 'later_today' | 'this_evening' | 'tomorrow' | 'tomorrow_evening' | 'weekend' | 'next_week'
  | 'later_this_week' | 'in_a_month' | 'someday'

export interface PresetConfig {
  morningHour: number
  eveningHour: number
  laterTodayHours: number
}

const DEFAULT_CFG: PresetConfig = { morningHour: 8, eveningHour: 18, laterTodayHours: 3 }
export const SOMEDAY = new Date(9999, 0, 1).getTime()

export const PRESET_IDS: readonly PresetId[] = [
  'later_today', 'this_evening', 'tomorrow', 'tomorrow_evening', 'weekend', 'next_week', 'later_this_week', 'in_a_month', 'someday',
]

/** Label of a preset in the current UI language. */
export function presetLabel(id: PresetId): string {
  switch (id) {
    case 'later_today':
      return t('Later today')
    case 'this_evening':
      return t('This evening')
    case 'tomorrow':
      return t('Tomorrow')
    case 'tomorrow_evening':
      return t('Tomorrow evening')
    case 'weekend':
      return t('This weekend')
    case 'next_week':
      return t('Next week')
    case 'later_this_week':
      return t('Later this week')
    case 'in_a_month':
      return t('In a month')
    case 'someday':
      return t('Someday')
  }
}

/** Preset labels; each property is translated when it is read (same as presetLabel(id)). */
export const PRESET_LABELS: Readonly<Record<PresetId, string>> = Object.defineProperties(
  {} as Record<PresetId, string>,
  Object.fromEntries(PRESET_IDS.map((id) => [id, { get: () => presetLabel(id), enumerable: true }])),
)

function at(d: Date, hour: number, minute = 0): Date {
  const x = new Date(d)
  x.setHours(hour, minute, 0, 0)
  return x
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

export function presetTime(id: PresetId, base = new Date(), cfg: Partial<PresetConfig> = {}): number {
  const c = { ...DEFAULT_CFG, ...cfg }
  switch (id) {
    case 'later_today': {
      const t = new Date(base.getTime() + c.laterTodayHours * 3600_000)
      t.setMinutes(0, 0, 0)
      return t.getTime()
    }
    case 'this_evening': {
      const t = at(base, c.eveningHour)
      return (t.getTime() > base.getTime() ? t : at(addDays(base, 1), c.eveningHour)).getTime()
    }
    case 'tomorrow':
      return at(addDays(base, 1), c.morningHour).getTime()
    case 'tomorrow_evening':
      return at(addDays(base, 1), c.eveningHour).getTime()
    case 'weekend': {
      const dow = base.getDay()
      const delta = dow === 6 ? 7 : (6 - dow + 7) % 7 || 7
      return at(addDays(base, delta), c.morningHour).getTime()
    }
    case 'next_week': {
      const dow = base.getDay()
      const delta = ((1 - dow + 7) % 7) || 7
      return at(addDays(base, delta), c.morningHour).getTime()
    }
    case 'later_this_week':
      return at(addDays(base, 2), c.morningHour).getTime()
    case 'in_a_month': {
      const t = new Date(base)
      t.setMonth(t.getMonth() + 1)
      return at(t, c.morningHour).getTime()
    }
    case 'someday':
      return SOMEDAY
  }
}

/** Which presets make sense right now (e.g. no "this evening" late at night). */
export function availablePresets(kind: 'snooze' | 'send' | 'remind', base = new Date(), cfg: Partial<PresetConfig> = {}): PresetId[] {
  const c = { ...DEFAULT_CFG, ...cfg }
  const h = base.getHours()
  const ids: PresetId[] = []
  if (h < 21) ids.push('later_today')
  if (h < c.eveningHour - 1) ids.push('this_evening')
  ids.push('tomorrow')
  if (kind !== 'send') ids.push('tomorrow_evening')
  const dow = base.getDay()
  if (dow >= 1 && dow <= 3) ids.push('later_this_week')
  if (dow !== 6) ids.push('weekend')
  ids.push('next_week', 'in_a_month')
  if (kind === 'snooze') ids.push('someday')
  return ids
}

// ---------------------------------------------------------------- parsing (data: never translated)

const PL_DAYS = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota']
const PL_DAYS_SHORT = ['nd', 'pon', 'wt', 'śr', 'czw', 'pt', 'sob']
const EN_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

const TODAY = ['dziś', 'dzis', 'dzisiaj', 'today']
const TOMORROW = ['jutro', 'tomorrow', 'tmr', 'tmrw', 'tom']
const DAY_AFTER = ['pojutrze']
const EVENING_NOW = ['wieczorem', 'tonight', 'evening']
const WEEKEND = ['weekend', 'weekendzie', 'weekendu']
const WEEK = ['week', 'tydzień', 'tydzien', 'tygodniu']
const MONTH = ['month', 'miesiąc', 'miesiac', 'miesiącu', 'miesiacu']
const SOMEDAY_WORDS = ['someday', 'kiedyś', 'kiedys']
const LATER_TODAY = ['later', 'later today', 'później', 'pozniej', 'później dziś', 'później dzisiaj', 'pozniej dzis', 'pozniej dzisiaj']

/** Leading words that only qualify a day: "on monday", "w piątek", "we wtorek", "this friday", "next week"… */
const NEXT_WORDS = new Set(['next', 'coming', 'następny', 'następna', 'następną', 'następnym', 'nastepny', 'nastepna', 'nastepnym', 'przyszły', 'przyszła', 'przyszłą', 'przyszłym', 'przyszly', 'przyszla', 'przyszlym'])
const THIS_WORDS = new Set(['this', 'ten', 'ta', 'tę', 'te', 'tym'])
const FILLER_WORDS = new Set([...NEXT_WORDS, ...THIS_WORDS, 'on', 'the', 'w', 'we', 'najbliższy', 'najbliższą', 'najbliższym'])

/** Hour of a part of the day ("rano", "evening", "noon"…), or null. */
function partOfDay(s: string, c: PresetConfig): number | null {
  const w = s.replace(/^(in the|at|this|o)\s+/, '')
  if (['wieczorem', 'wieczór', 'wieczor', 'evening', 'night', 'tonight'].includes(w)) return c.eveningHour
  if (['rano', 'rankiem', 'morning'].includes(w)) return c.morningHour
  if (['w południe', 'południe', 'w poludnie', 'poludnie', 'noon', 'midday'].includes(w)) return 12
  if (['po południu', 'po poludniu', 'afternoon'].includes(w)) return 14
  return null
}

function dayIndex(word: string): number {
  const w = word.toLowerCase().replace(/[.,]$/, '')
  if (!w) return -1
  for (let i = 0; i < 7; i++) {
    if (w === PL_DAYS[i] || w === PL_DAYS_SHORT[i] || w === EN_DAYS[i] || w === EN_DAYS[i].slice(0, 3)) return i
    if (PL_DAYS[i].startsWith(w) && w.length >= 3) return i
    if (w.length >= 3 && EN_DAYS[i].startsWith(w)) return i
  }
  // Polish inflections: "piątek/piątku", "środę", "sobotę", "niedzielę"
  const stems = ['niedziel', 'poniedział', 'wtor', 'środ', 'czwart', 'piąt', 'sobot']
  return stems.findIndex((s) => w.startsWith(s))
}

/** "9", "9:30", "9.30", "930", "14:30", "9am", "2:30 pm", "9 rano", "8 wieczorem", "8 in the evening". */
function parseClock(s: string): { h: number; m: number } | null {
  const m = s.match(/^(\d{1,2})(?::|\.|h)?(\d{2})?(?::\d{2})?\s*(am|pm|a\.m\.|p\.m\.|rano|wieczorem|po południu|po poludniu|in the morning|in the afternoon|in the evening|at night|tonight)?$/i)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] || 0)
  const suf = (m[3] || '').toLowerCase().replace(/\./g, '')
  const pm = ['pm', 'wieczorem', 'po południu', 'po poludniu', 'in the afternoon', 'in the evening', 'at night', 'tonight'].includes(suf)
  if ((suf === 'am' || suf === 'pm') && (h > 12 || h === 0)) return null
  if (pm && h < 12) h += 12
  if (suf === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) return null
  return { h, m: min }
}

/** Strip "o", "at", "godz.", "@", "around"… in front of a time. */
function stripAt(s: string): string {
  return s.replace(/^(?:(?:o|at|by|around|about|około|okolo|ok\.|godz\.?|@)(?:\s+|(?=\d)))+/, '').trim()
}

const UNITS: [RegExp, number][] = [
  [/^(m|mins?|minutes?|minut[aęy]?)$/, 60_000],
  [/^(h|hrs?|hours?|godz|godzin[aęy]?)$/, 3600_000],
  [/^(d|days?|dzień|dzien|dni|dnia)$/, 86400_000],
  [/^(w|wks?|weeks?|tydzień|tydzien|tygodni[e]?|tyg)$/, 7 * 86400_000],
  [/^(mo|mos|months?|mies|miesiąc|miesiac|miesiące|miesiace|miesięcy|miesiecy)$/, 30 * 86400_000],
]

/**
 * Parse things like "jutro 9", "pt 14:30", "za 2 godziny", "in 3 days", "20.10 14:00",
 * "2026-10-20 9:15", "next monday", "wieczorem", "tomorrow 9am", "fri at 2:30pm", "tonight",
 * "w przyszłym tygodniu". English and Polish work in either UI language. Returns epoch ms or null.
 */
export function parseWhen(input: string, base = new Date(), cfg: Partial<PresetConfig> = {}): number | null {
  const c = { ...DEFAULT_CFG, ...cfg }
  const s = input.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!s) return null

  // relative: "za 2 godziny", "in 3 days", "+2h", "in an hour", "za tydzień", "in half an hour"
  const rel = s.match(/^(?:(?:za|in)(?:\s+|(?=\d))|\+\s*)(?:(\d+(?:[.,]\d+)?|an?|one|half an?|pół|pol)\s*)?([a-ząćęłńóśźż]+)\.?$/)
  if (rel) {
    const unit = UNITS.find(([re]) => re.test(rel[2]))
    if (unit) {
      const q = rel[1] || ''
      const n = /^\d/.test(q) ? Number(q.replace(',', '.')) : /^(half|pół|pol)/.test(q) ? 0.5 : 1
      return base.getTime() + n * unit[1]
    }
  }

  // full ISO timestamp with a zone ("2026-10-20T09:15:00Z")
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const v = Date.parse(input.trim())
    return Number.isFinite(v) ? v : null
  }

  if (LATER_TODAY.includes(s)) return presetTime('later_today', base, c)
  if (SOMEDAY_WORDS.includes(s)) return SOMEDAY

  // ISO / numeric dates
  let date: Date | null = null
  let rest = s
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](.*))?$/)
  const dmy = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?:\s+(.*))?$/)
  const dayAfter = s.match(/^(?:the )?day after tomorrow(?: (.*))?$/)
  if (iso) {
    date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    rest = iso[4] || ''
  } else if (dmy) {
    const year = dmy[3] ? (dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3])) : base.getFullYear()
    date = new Date(year, Number(dmy[2]) - 1, Number(dmy[1]))
    if (!dmy[3] && date.getTime() < at(base, 0).getTime()) date.setFullYear(year + 1)
    rest = dmy[4] || ''
  } else if (dayAfter) {
    date = addDays(base, 2)
    rest = dayAfter[1] || ''
  } else {
    const words = s.split(' ')
    let i = 0
    let isThis = false
    let isNext = false
    while (i < words.length - 1 && FILLER_WORDS.has(words[i])) {
      if (NEXT_WORDS.has(words[i])) isNext = true
      if (THIS_WORDS.has(words[i])) isThis = true
      i++
    }
    const w = words[i]
    const tail = words.slice(i + 1).join(' ')
    if (TODAY.includes(w)) {
      date = new Date(base)
      rest = tail
    } else if (TOMORROW.includes(w)) {
      date = addDays(base, 1)
      rest = tail
    } else if (DAY_AFTER.includes(w)) {
      date = addDays(base, 2)
      rest = tail
    } else if (EVENING_NOW.includes(w)) {
      // "tonight", "this evening", "wieczorem" — or "tonight at 8" (= 20:00)
      if (!tail) return presetTime('this_evening', base, c)
      const clock = parseClock(stripAt(tail))
      if (!clock) return null
      const h = clock.h < 12 && !/\b(am|a\.m\.|rano)$/.test(tail) ? clock.h + 12 : clock.h
      return at(base, h, clock.m).getTime()
    } else if (WEEKEND.includes(w)) {
      if (!tail) return presetTime('weekend', base, c)
      date = new Date(presetTime('weekend', base, c))
      rest = tail
    } else if (WEEK.includes(w)) {
      const id: PresetId = isThis && !isNext ? 'later_this_week' : 'next_week'
      if (!tail) return presetTime(id, base, c)
      date = new Date(presetTime(id, base, c))
      rest = tail
    } else if (MONTH.includes(w)) {
      if (!isNext) return null
      if (!tail) return presetTime('in_a_month', base, c)
      date = new Date(presetTime('in_a_month', base, c))
      rest = tail
    } else if (SOMEDAY_WORDS.includes(w)) {
      return SOMEDAY
    } else {
      const di = dayIndex(w || '')
      if (di >= 0) {
        let delta = (di - base.getDay() + 7) % 7
        if (delta === 0) delta = 7
        date = addDays(base, delta)
        rest = tail
      }
    }
  }
  if (!date) {
    // bare time: "14:30", "at 9am", "o 9", "noon", "rano" → today, or tomorrow when already past
    const bare = stripAt(s)
    const named = partOfDay(bare, c)
    const clock = named !== null ? { h: named, m: 0 } : parseClock(bare)
    if (!clock) return null
    let t = at(base, clock.h, clock.m)
    if (t.getTime() <= base.getTime()) t = at(addDays(base, 1), clock.h, clock.m)
    return t.getTime()
  }
  rest = stripAt(rest)
  if (!rest) return at(date, c.morningHour).getTime()
  const named = partOfDay(rest, c)
  if (named !== null) return at(date, named).getTime()
  const clock = parseClock(rest)
  if (!clock) return null
  return at(date, clock.h, clock.m).getTime()
}

// ---------------------------------------------------------------- display

/** Short "when" for the UI: "tomorrow 9:00", "Fri 14:30", "20 Oct, 9:00" (Polish: "jutro 09:00", "piątek 14:30"…). */
export function formatWhen(ts: number, base = new Date()): string {
  if (ts >= SOMEDAY) return t('Someday')
  const pl = getLang() === 'pl'
  const loc = dateLocale()
  const hour = pl ? '2-digit' : 'numeric'
  const d = new Date(ts)
  const sameDay = d.toDateString() === base.toDateString()
  const tomorrow = d.toDateString() === addDays(base, 1).toDateString()
  const time = d.toLocaleTimeString(loc, { hour, minute: '2-digit' })
  if (sameDay) return t('today {time}', { time })
  if (tomorrow) return t('tomorrow {time}', { time })
  const diffDays = (d.getTime() - base.getTime()) / 86400_000
  if (diffDays > 0 && diffDays < 7) {
    const day = pl ? PL_DAYS[d.getDay()] : d.toLocaleDateString(loc, { weekday: 'short' })
    return `${day} ${time}`
  }
  return d.toLocaleString(loc, { day: 'numeric', month: 'short', year: d.getFullYear() !== base.getFullYear() ? 'numeric' : undefined, hour, minute: '2-digit' })
}
