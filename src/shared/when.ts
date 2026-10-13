// Snooze / Send Later / Remind presets and a small natural-language date parser (PL + EN).
// All times are local wall-clock time of the machine (Europe/Warsaw for Piotr).

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

export const PRESET_LABELS: Record<PresetId, string> = {
  later_today: 'Później dzisiaj',
  this_evening: 'Dziś wieczorem',
  tomorrow: 'Jutro',
  tomorrow_evening: 'Jutro wieczorem',
  weekend: 'W weekend',
  next_week: 'W przyszłym tygodniu',
  later_this_week: 'Później w tym tygodniu',
  in_a_month: 'Za miesiąc',
  someday: 'Kiedyś',
}

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

const PL_DAYS = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota']
const PL_DAYS_SHORT = ['nd', 'pon', 'wt', 'śr', 'czw', 'pt', 'sob']
const EN_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function dayIndex(word: string): number {
  const w = word.toLowerCase().replace(/[.,]$/, '')
  for (let i = 0; i < 7; i++) {
    if (w === PL_DAYS[i] || w === PL_DAYS_SHORT[i] || w === EN_DAYS[i] || w === EN_DAYS[i].slice(0, 3)) return i
    if (PL_DAYS[i].startsWith(w) && w.length >= 3) return i
    if (w.length >= 3 && EN_DAYS[i].startsWith(w)) return i
  }
  // Polish inflections: "piątek/piątku", "środę", "sobotę", "niedzielę"
  const stems = ['niedziel', 'poniedział', 'wtor', 'środ', 'czwart', 'piąt', 'sobot']
  return stems.findIndex((s) => w.startsWith(s))
}

function parseClock(s: string): { h: number; m: number } | null {
  const m = s.match(/^(\d{1,2})(?::|\.|h)?(\d{2})?\s*(am|pm|rano|wieczorem|po południu)?$/i)
  if (!m) return null
  let h = Number(m[1])
  const min = Number(m[2] || 0)
  const suf = (m[3] || '').toLowerCase()
  if ((suf === 'pm' || suf === 'wieczorem' || suf === 'po południu') && h < 12) h += 12
  if (suf === 'am' && h === 12) h = 0
  if (h > 23 || min > 59) return null
  return { h, m: min }
}

/**
 * Parse things like "jutro 9", "pt 14:30", "za 2 godziny", "in 3 days", "20.10 14:00",
 * "2026-10-20 9:15", "next monday", "wieczorem". Returns epoch ms or null.
 */
export function parseWhen(input: string, base = new Date(), cfg: Partial<PresetConfig> = {}): number | null {
  const c = { ...DEFAULT_CFG, ...cfg }
  let s = input.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!s) return null

  const rel = s.match(/^(?:za|in|\+)\s*(\d+(?:[.,]\d+)?)\s*(min|minut[ay]?|m|godz(?:in[ay]?)?|h|hours?|hrs?|dni|dzień|dzien|d|days?|tydzień|tygodnie|tygodni|tyg|w|weeks?|miesiąc|miesiące|miesięcy|mies|months?)\.?$/)
  if (rel) {
    const n = Number(rel[1].replace(',', '.'))
    const u = rel[2]
    const mult = /^m(in|inut)|^m$/.test(u) && !/^mies|^month/.test(u)
      ? 60_000
      : /^(godz|h|hour|hr)/.test(u) ? 3600_000
      : /^(dni|dzie|d$|day)/.test(u) ? 86400_000
      : /^(tydz|tyg|w$|week)/.test(u) ? 7 * 86400_000
      : 30 * 86400_000
    return base.getTime() + n * mult
  }

  // ISO / numeric dates
  let date: Date | null = null
  let rest = s
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](.*))?$/)
  const dmy = s.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?:\s+(.*))?$/)
  if (iso) {
    date = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    rest = iso[4] || ''
  } else if (dmy) {
    const year = dmy[3] ? (dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3])) : base.getFullYear()
    date = new Date(year, Number(dmy[2]) - 1, Number(dmy[1]))
    if (!dmy[3] && date.getTime() < at(base, 0).getTime()) date.setFullYear(year + 1)
    rest = dmy[4] || ''
  } else {
    const words = s.split(' ')
    const w0 = words[0]
    if (['dziś', 'dzis', 'dzisiaj', 'today'].includes(w0)) {
      date = new Date(base)
      rest = words.slice(1).join(' ')
    } else if (['jutro', 'tomorrow', 'tmr', 'tom'].includes(w0)) {
      date = addDays(base, 1)
      rest = words.slice(1).join(' ')
    } else if (['pojutrze'].includes(w0)) {
      date = addDays(base, 2)
      rest = words.slice(1).join(' ')
    } else if (['wieczorem', 'tonight', 'evening'].includes(w0)) {
      return presetTime('this_evening', base, c)
    } else if (['weekend', 'weekendzie'].includes(w0) || s === 'w weekend' || s === 'this weekend') {
      return presetTime('weekend', base, c)
    } else if (['someday', 'kiedyś', 'kiedys'].includes(w0)) {
      return SOMEDAY
    } else {
      let idx = 0
      let forceNext = false
      if (['next', 'następny', 'następna', 'następną', 'przyszły', 'przyszła', 'przyszłą', 'w'].includes(words[0])) {
        forceNext = words[0] !== 'w'
        idx = 1
      }
      if (words[idx] === 'week' || words[idx] === 'tydzień' || words[idx] === 'tygodniu') return presetTime('next_week', base, c)
      const di = dayIndex(words[idx] || '')
      if (di >= 0) {
        let delta = (di - base.getDay() + 7) % 7
        if (delta === 0 || forceNext) delta = delta === 0 ? 7 : delta
        date = addDays(base, delta)
        rest = words.slice(idx + 1).join(' ')
      }
    }
  }
  if (!date) {
    // bare time: "14:30" → today or tomorrow
    const clock = parseClock(s.replace(/^o\s+/, '').replace(/^at\s+/, ''))
    if (!clock) return null
    let t = at(base, clock.h, clock.m)
    if (t.getTime() <= base.getTime()) t = at(addDays(base, 1), clock.h, clock.m)
    return t.getTime()
  }
  rest = rest.replace(/^(o|at|godz\.?|@)\s*/, '').trim()
  if (!rest) return at(date, c.morningHour).getTime()
  if (['wieczorem', 'evening', 'wieczór'].includes(rest)) return at(date, c.eveningHour).getTime()
  if (['rano', 'morning'].includes(rest)) return at(date, c.morningHour).getTime()
  if (['w południe', 'południe', 'noon'].includes(rest)) return at(date, 12).getTime()
  const clock = parseClock(rest)
  if (!clock) return null
  return at(date, clock.h, clock.m).getTime()
}

export function formatWhen(ts: number, base = new Date()): string {
  if (ts >= SOMEDAY) return 'Kiedyś'
  const d = new Date(ts)
  const sameDay = d.toDateString() === base.toDateString()
  const tomorrow = d.toDateString() === addDays(base, 1).toDateString()
  const time = d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return `dziś ${time}`
  if (tomorrow) return `jutro ${time}`
  const diffDays = (d.getTime() - base.getTime()) / 86400_000
  if (diffDays > 0 && diffDays < 7) return `${PL_DAYS[d.getDay()]} ${time}`
  return d.toLocaleString('pl-PL', { day: 'numeric', month: 'short', year: d.getFullYear() !== base.getFullYear() ? 'numeric' : undefined, hour: '2-digit', minute: '2-digit' })
}
