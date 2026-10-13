// iCalendar (RFC 5545) parsing, recurrence expansion and generation, plus iTIP (RFC 5546)
// message builders. Pure functions on ICS text — no database or network access here.
import crypto from 'node:crypto'
import ICAL from 'ical.js'
import type { Address } from '../../shared/types'
import { isValidTz, localWallClock, resolveTzid, vtimezoneFor, type WallClock, wallClockIn, zonedToEpoch } from './tz'

export type IcalComponent = ICAL.Component
type IcalTime = ICAL.Time
type IcalProperty = ICAL.Property

export const PRODID = '-//Octopus Mail//Kalendarz 1.0//PL'
const DAY = 86400_000

export interface Attendee extends Address {
  status?: string
  role?: string
  rsvp?: boolean
}

/** A reminder: relative to the event start (minutesBefore) or at an absolute instant (at). */
export interface AlarmSpec {
  minutesBefore?: number
  at?: number
}

/** Everything we read from one VEVENT component. Times are epoch ms. */
export interface EventData {
  uid: string
  summary: string
  description: string | null
  location: string | null
  start: number
  end: number
  all_day: boolean
  tzid: string | null
  status: string | null
  transp: string | null
  busy_status: string | null
  organizer: Address | null
  attendees: Attendee[]
  conference_url: string | null
  alarms: AlarmSpec[]
  sequence: number
  recurrence_id: number | null
  rrule: string | null
}

export interface Occurrence extends EventData {
  /** Original start of this instance (RECURRENCE-ID) for recurring events, null for single events. */
  occurrence_start: number | null
}

export interface ParsedException {
  data: EventData
  ridKey: string
  ridMs: number
}

export interface ParsedResource {
  uid: string
  master: EventData | null
  masterComp: IcalComponent | null
  exceptions: ParsedException[]
  recurring: boolean
  exdateMs: Set<number>
  durationMs: number
  durationDays: number
  tzHint: string | null
}

// ---------- low-level helpers ----------

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const ymd = (w: WallClock) => `${pad(w.year, 4)}${pad(w.month)}${pad(w.day)}`
const hms = (w: WallClock) => `${pad(w.hour)}${pad(w.minute)}${pad(w.second)}`

export function sha1(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex')
}

export function startOfLocalDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function addLocalDays(ms: number, days: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, d.getHours(), d.getMinutes(), d.getSeconds()).getTime()
}

/** "mailto:Jan@X.pl" → "jan@x.pl"; null for non-mail calendar addresses (urn:uuid:…). */
export function calAddress(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim().replace(/^mailto:/i, '').trim()
  if (!s.includes('@') || /\s/.test(s)) return null
  return s.toLowerCase()
}

function cleanParam(s: string): string {
  return s.replace(/["\r\n]/g, '').trim()
}

function propValue(p: IcalProperty | null): unknown {
  if (!p) return null
  try {
    return p.getFirstValue()
  } catch {
    return null
  }
}

function textProp(comp: IcalComponent, name: string): string | null {
  const v = propValue(comp.getFirstProperty(name))
  if (v == null) return null
  const s = String(v)
  return s.length ? s : null
}

function param(p: IcalProperty, name: string): string | null {
  const v = p.getFirstParameter(name)
  if (v == null || v === '') return null
  return String(v)
}

function isTime(v: unknown): v is IcalTime {
  return v instanceof ICAL.Time
}

/**
 * Epoch ms of an ICAL.Time. All-day dates are local midnight. Times carrying a zone
 * definition (VTIMEZONE or UTC) are exact; floating times or TZIDs without a VTIMEZONE
 * are resolved through the IANA database (Intl), falling back to local time.
 */
export function timeToMs(t: IcalTime, tzHint?: string | null): number {
  if (t.isDate) return new Date(t.year, t.month - 1, t.day).getTime()
  const zone = t.zone
  if (zone && zone !== ICAL.Timezone.localTimezone && zone.tzid !== 'floating') return t.toUnixTime() * 1000
  const w: WallClock = { year: t.year, month: t.month, day: t.day, hour: t.hour, minute: t.minute, second: t.second }
  const iana = resolveTzid(tzHint)
  if (iana) return zonedToEpoch(w, iana)
  return new Date(w.year, w.month - 1, w.day, w.hour, w.minute, w.second).getTime()
}

function propTime(comp: IcalComponent, name: string): { time: IcalTime; tzid: string | null } | null {
  const p = comp.getFirstProperty(name)
  if (!p) return null
  const v = propValue(p)
  if (!isTime(v)) return null
  return { time: v, tzid: param(p, 'tzid') }
}

// ---------- parsing ----------

/** Parse ICS text into the VCALENDAR component (several concatenated VCALENDARs are merged). */
export function parseIcs(text: string): IcalComponent {
  const clean = String(text || '')
    .replace(/^﻿/, '')
    // DTSTART:20261015 without VALUE=DATE is common in the wild and makes ical.js throw
    .replace(
      /^(DTSTART|DTEND|DUE|RECURRENCE-ID|EXDATE|RDATE)((?:;[^:\r\n]*)?):(\d{8}(?:,\d{8})*)[ \t]*(\r?)$/gim,
      (m, name: string, params: string, val: string, cr: string) => (/VALUE=DATE/i.test(params) ? m : `${name}${params};VALUE=DATE:${val}${cr}`),
    )
  let jcal: unknown
  try {
    jcal = ICAL.parse(clean)
  } catch (e) {
    throw new Error(`Nieprawidłowy plik kalendarza (ICS): ${(e as Error).message}`)
  }
  if (!Array.isArray(jcal) || !jcal.length) throw new Error('Pusty plik kalendarza (ICS)')
  const roots = (typeof jcal[0] === 'string' ? [jcal] : jcal) as unknown[][]
  const comps = roots.map((r) => new ICAL.Component(r as unknown[]))
  const first = comps.find((c) => c.name === 'vcalendar')
  if (!first) throw new Error('W pliku nie ma kalendarza (brak BEGIN:VCALENDAR)')
  for (const other of comps) {
    if (other === first || other.name !== 'vcalendar') continue
    for (const sub of other.getAllSubcomponents()) {
      other.removeSubcomponent(sub)
      first.addSubcomponent(sub)
    }
  }
  return first
}

export function uidOf(comp: IcalComponent): string {
  return textProp(comp, 'uid') || ''
}

function organizerOf(comp: IcalComponent): Address | null {
  const p = comp.getFirstProperty('organizer')
  if (!p) return null
  const email = calAddress(propValue(p))
  if (!email) return null
  const name = param(p, 'cn')
  return name ? { email, name } : { email }
}

function attendeesOf(comp: IcalComponent): Attendee[] {
  const out: Attendee[] = []
  const seen = new Set<string>()
  for (const p of comp.getAllProperties('attendee')) {
    const email = calAddress(propValue(p))
    if (!email || seen.has(email)) continue
    seen.add(email)
    const a: Attendee = {
      email,
      status: (param(p, 'partstat') || 'NEEDS-ACTION').toUpperCase(),
      role: (param(p, 'role') || 'REQ-PARTICIPANT').toUpperCase(),
    }
    const cn = param(p, 'cn')
    if (cn) a.name = cn
    if ((param(p, 'rsvp') || '').toUpperCase() === 'TRUE') a.rsvp = true
    out.push(a)
  }
  return out
}

const CONF_PATTERNS = [
  /https:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4}(?:\?[^\s<>"'\])]*)?/i,
  /https:\/\/(?:[\w-]+\.)*zoom\.us\/(?:j|my|w|s|wc\/join)\/[^\s<>"'\])]+/i,
  /https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"'\])]+/i,
  /https:\/\/teams\.live\.com\/meet\/[^\s<>"'\])]+/i,
  /https:\/\/[\w-]+\.webex\.com\/(?:meet|join|[\w-]+\/j\.php)[^\s<>"'\])]*/i,
  /https:\/\/whereby\.com\/[^\s<>"'\])]+/i,
]

/** First Google Meet / Zoom / Teams / Webex link found in the given texts. */
export function extractConferenceUrl(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    if (!t) continue
    for (const re of CONF_PATTERNS) {
      const m = t.match(re)
      if (m) return m[0].replace(/[.,;:!>]+$/, '')
    }
  }
  return null
}

function conferenceOf(comp: IcalComponent, location: string | null, description: string | null): string | null {
  for (const name of ['x-google-conference', 'conference', 'x-microsoft-skypeteamsmeetingurl', 'x-microsoft-onlinemeetingexternallink']) {
    for (const p of comp.getAllProperties(name)) {
      const v = String(propValue(p) ?? '').trim()
      if (/^https?:\/\//i.test(v)) return v
    }
  }
  return extractConferenceUrl(
    textProp(comp, 'url'),
    location,
    description,
    textProp(comp, 'x-alt-desc'),
  )
}

function alarmsOf(comp: IcalComponent, durationSec: number): AlarmSpec[] {
  const out: AlarmSpec[] = []
  for (const va of comp.getAllSubcomponents('valarm')) {
    const action = String(textProp(va, 'action') || 'DISPLAY').toUpperCase()
    if (action === 'NONE') continue
    const tp = va.getFirstProperty('trigger')
    const v = propValue(tp)
    if (v instanceof ICAL.Duration) {
      let secs = v.toSeconds()
      if ((param(tp!, 'related') || 'START').toUpperCase() === 'END') secs += durationSec
      out.push({ minutesBefore: Math.round(-secs / 60) })
    } else if (isTime(v)) {
      out.push({ at: timeToMs(v) })
    }
  }
  return out
}

/** Read one VEVENT. Throws when it has no usable DTSTART. */
export function eventData(comp: IcalComponent): EventData {
  const s = propTime(comp, 'dtstart')
  if (!s) throw new Error('Wydarzenie bez DTSTART')
  const all_day = s.time.isDate
  const start = timeToMs(s.time, s.tzid)
  let end: number
  const e = propTime(comp, 'dtend')
  const dur = propValue(comp.getFirstProperty('duration'))
  if (e) end = e.time.isDate && !all_day ? timeToMs(e.time) : timeToMs(e.time, e.tzid ?? s.tzid)
  else if (dur instanceof ICAL.Duration) {
    end = all_day ? addLocalDays(start, Math.max(1, Math.round(dur.toSeconds() / 86400))) : start + dur.toSeconds() * 1000
  } else end = all_day ? addLocalDays(start, 1) : start
  if (end < start) end = start
  const description = textProp(comp, 'description')
  const location = textProp(comp, 'location')
  const rr = propValue(comp.getFirstProperty('rrule'))
  return {
    uid: uidOf(comp),
    summary: textProp(comp, 'summary') || '',
    description,
    location,
    start,
    end,
    all_day,
    tzid: s.tzid,
    status: textProp(comp, 'status')?.toUpperCase() || null,
    transp: textProp(comp, 'transp')?.toUpperCase() || null,
    busy_status: textProp(comp, 'x-microsoft-cdo-busystatus')?.toUpperCase() || null,
    organizer: organizerOf(comp),
    attendees: attendeesOf(comp),
    conference_url: conferenceOf(comp, location, description),
    alarms: alarmsOf(comp, Math.round((end - start) / 1000)),
    sequence: Number(textProp(comp, 'sequence')) || 0,
    recurrence_id: null,
    rrule: rr ? String(rr) : null,
  }
}

/** Is this occurrence "free" time (TRANSP:TRANSPARENT, Outlook FREE, or an all-day event not explicitly marked busy)? */
export function isTransparent(d: Pick<EventData, 'transp' | 'busy_status' | 'all_day'>): boolean {
  if (d.busy_status === 'FREE') return true
  if (d.transp === 'TRANSPARENT') return true
  if (d.all_day && d.transp !== 'OPAQUE' && !d.busy_status) return true
  return false
}

/** Group one calendar object resource (master + RECURRENCE-ID overrides of one UID). */
export function resourceFromCalendar(cal: IcalComponent, uid?: string): ParsedResource | null {
  let vevents = cal.getAllSubcomponents('vevent')
  if (!vevents.length) return null
  const want = uid && vevents.some((v) => uidOf(v) === uid) ? uid : uidOf(vevents[0])
  vevents = vevents.filter((v) => uidOf(v) === want)
  let masterComp: IcalComponent | null = null
  let master: EventData | null = null
  const exceptions: ParsedException[] = []
  for (const v of vevents) {
    let data: EventData
    try {
      data = eventData(v)
    } catch {
      continue
    }
    const ridProp = v.getFirstProperty('recurrence-id')
    if (ridProp) {
      const rt = propValue(ridProp)
      if (!isTime(rt)) continue
      const ridMs = timeToMs(rt, param(ridProp, 'tzid') ?? data.tzid)
      exceptions.push({ data: { ...data, recurrence_id: ridMs }, ridKey: rt.toString(), ridMs })
    } else if (!masterComp) {
      masterComp = v
      master = data
    }
  }
  if (!master && !exceptions.length) return null
  const recurring = !!masterComp && (masterComp.hasProperty('rrule') || masterComp.hasProperty('rdate'))
  const exdateMs = new Set<number>()
  if (masterComp && master) {
    for (const p of masterComp.getAllProperties('exdate')) {
      const tz = param(p, 'tzid') ?? master.tzid
      let values: unknown[] = []
      try {
        values = p.getValues()
      } catch {
        values = []
      }
      for (const v of values) if (isTime(v)) exdateMs.add(timeToMs(v, tz))
    }
  }
  const durationMs = master ? master.end - master.start : 0
  return {
    uid: want,
    master,
    masterComp,
    exceptions,
    recurring,
    exdateMs,
    durationMs,
    durationDays: Math.max(0, Math.round(durationMs / DAY)),
    tzHint: master?.tzid ?? null,
  }
}

export function parseResource(ics: string, uid?: string): ParsedResource | null {
  return resourceFromCalendar(parseIcs(ics), uid)
}

/**
 * Concrete occurrences of a resource intersecting [from, to): RRULE/RDATE expansion with
 * EXDATE removal and RECURRENCE-ID overrides (moved/changed/cancelled instances).
 */
export function expandResource(r: ParsedResource, from: number, to: number, maxCount = 5000): Occurrence[] {
  const out: Occurrence[] = []
  const hit = (s: number, e: number) => s < to && (e > from || (e === s && s >= from))
  if (!r.recurring || !r.master || !r.masterComp) {
    if (r.master && hit(r.master.start, r.master.end)) out.push({ ...r.master, occurrence_start: null })
    for (const ex of r.exceptions) {
      if (ex.data.status === 'CANCELLED') continue
      if (hit(ex.data.start, ex.data.end)) out.push({ ...ex.data, occurrence_start: ex.ridMs })
    }
    return out.sort((a, b) => a.start - b.start)
  }
  const master = r.master
  const exKeys = new Set(r.exceptions.map((e) => e.ridKey))
  const exMs = new Set(r.exceptions.map((e) => e.ridMs))
  const span = master.all_day ? r.durationDays * DAY : r.durationMs
  const margin = 2 * DAY
  const dtstart = propValue(r.masterComp.getFirstProperty('dtstart'))
  if (isTime(dtstart)) {
    let it: ICAL.RecurExpansion | null = null
    try {
      it = new ICAL.RecurExpansion({ component: r.masterComp, dtstart: dtstart.clone() })
    } catch {
      it = null
    }
    for (let i = 0; it && i < 200_000 && out.length < maxCount; i++) {
      let occ: IcalTime | null
      try {
        occ = it.next()
      } catch {
        break
      }
      if (!occ) break
      const approx = Date.UTC(occ.year, occ.month - 1, occ.day, occ.hour, occ.minute, occ.second)
      if (approx > to + margin) break
      if (approx + span + margin < from) continue
      const ms = timeToMs(occ, r.tzHint)
      if (r.exdateMs.has(ms) || exKeys.has(occ.toString()) || exMs.has(ms)) continue
      const end = master.all_day ? addLocalDays(ms, r.durationDays) : ms + r.durationMs
      if (hit(ms, end)) out.push({ ...master, start: ms, end, recurrence_id: ms, occurrence_start: ms })
    }
  } else if (hit(master.start, master.end)) {
    out.push({ ...master, occurrence_start: master.start })
  }
  for (const ex of r.exceptions) {
    if (ex.data.status === 'CANCELLED' || r.exdateMs.has(ex.ridMs)) continue
    if (hit(ex.data.start, ex.data.end)) out.push({ ...ex.data, occurrence_start: ex.ridMs })
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end)
}

/** Expand all events of an ICS text (any number of UIDs) — convenience for feeds and tests. */
export function expandIcs(ics: string, from: number, to: number): Occurrence[] {
  const cal = parseIcs(ics)
  const uids = [...new Set(cal.getAllSubcomponents('vevent').map(uidOf))]
  const out: Occurrence[] = []
  for (const uid of uids) {
    const r = resourceFromCalendar(cal, uid)
    if (r) out.push(...expandResource(r, from, to))
  }
  return out.sort((a, b) => a.start - b.start)
}

/** Split a multi-event feed into one VCALENDAR text per UID (with the VTIMEZONEs it references). */
export function splitByUid(cal: IcalComponent): Map<string, string> {
  const zones = new Map<string, IcalComponent>()
  for (const z of cal.getAllSubcomponents('vtimezone')) {
    const id = textProp(z, 'tzid')
    if (id) zones.set(id, z)
  }
  const groups = new Map<string, IcalComponent[]>()
  for (const v of cal.getAllSubcomponents('vevent')) {
    const uid = uidOf(v)
    if (!uid) continue
    const g = groups.get(uid)
    if (g) g.push(v)
    else groups.set(uid, [v])
  }
  const out = new Map<string, string>()
  for (const [uid, comps] of groups) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`]
    const used = new Set<string>()
    for (const c of comps) {
      for (const p of c.getAllProperties()) {
        const tz = param(p, 'tzid')
        if (tz) used.add(tz)
      }
    }
    for (const tz of used) {
      const z = zones.get(tz)
      if (z) lines.push(z.toString())
    }
    for (const c of comps) lines.push(c.toString())
    lines.push('END:VCALENDAR')
    out.set(uid, lines.join('\r\n') + '\r\n')
  }
  return out
}

// ---------- generation ----------

export type TimeMode = { kind: 'date' } | { kind: 'utc' } | { kind: 'tz'; tz: string }

export function timeModeFor(tz: string | null | undefined, allDay: boolean): TimeMode {
  if (allDay) return { kind: 'date' }
  if (tz && tz !== 'UTC' && isValidTz(tz)) return { kind: 'tz', tz }
  return { kind: 'utc' }
}

function fmtValue(ms: number, mode: TimeMode): { params: string; value: string } {
  if (mode.kind === 'date') return { params: ';VALUE=DATE', value: ymd(localWallClock(ms)) }
  if (mode.kind === 'tz') {
    const w = wallClockIn(ms, mode.tz)
    return { params: `;TZID=${mode.tz}`, value: `${ymd(w)}T${hms(w)}` }
  }
  const d = new Date(ms)
  const w: WallClock = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() }
  return { params: '', value: `${ymd(w)}T${hms(w)}Z` }
}

function timeProperty(name: string, ms: number, mode: TimeMode): IcalProperty {
  const { params, value } = fmtValue(ms, mode)
  return ICAL.Property.fromString(`${name.toUpperCase()}${params}:${value}`)
}

function setTime(comp: IcalComponent, name: string, ms: number, mode: TimeMode): void {
  comp.removeAllProperties(name)
  comp.addProperty(timeProperty(name, ms, mode))
}

function nowUtc(): IcalTime {
  return ICAL.Time.fromJSDate(new Date(), true)
}

function ensureVtimezone(cal: IcalComponent, mode: TimeMode): void {
  if (mode.kind !== 'tz') return
  const has = cal.getAllSubcomponents('vtimezone').some((z) => textProp(z, 'tzid') === mode.tz)
  if (has) return
  const vt = vtimezoneFor(mode.tz)
  if (vt) cal.addSubcomponent(new ICAL.Component(ICAL.parse(vt) as unknown[]))
}

function newVcalendar(): IcalComponent {
  const cal = new ICAL.Component('vcalendar')
  cal.addPropertyWithValue('prodid', PRODID)
  cal.addPropertyWithValue('version', '2.0')
  cal.addPropertyWithValue('calscale', 'GREGORIAN')
  return cal
}

/** Serialize with VTIMEZONEs first (some servers are picky) and CRLF line ends. */
export function serialize(cal: IcalComponent): string {
  if (!cal.hasProperty('prodid')) cal.addPropertyWithValue('prodid', PRODID)
  if (!cal.hasProperty('version')) cal.addPropertyWithValue('version', '2.0')
  const subs = cal.getAllSubcomponents()
  const ordered = [...subs.filter((s) => s.name === 'vtimezone'), ...subs.filter((s) => s.name !== 'vtimezone')]
  cal.removeAllSubcomponents()
  for (const s of ordered) cal.addSubcomponent(s)
  return cal.toString() + '\r\n'
}

function addAttendee(ev: IcalComponent, a: Address, role: string, partstat: string, rsvp: boolean, scheduleAgentClient: boolean): void {
  const p = new ICAL.Property('attendee')
  if (a.name) p.setParameter('cn', cleanParam(a.name))
  p.setParameter('cutype', 'INDIVIDUAL')
  p.setParameter('role', role)
  p.setParameter('partstat', partstat)
  if (rsvp) p.setParameter('rsvp', 'TRUE')
  if (scheduleAgentClient) p.setParameter('schedule-agent', 'CLIENT')
  p.setValue(`mailto:${a.email}`)
  ev.addProperty(p)
}

/**
 * Replace ORGANIZER/ATTENDEE. The organizer is listed as an accepted CHAIR attendee too
 * (like Google/Thunderbird). Existing PARTSTATs are kept for attendees who stay.
 * SCHEDULE-AGENT=CLIENT tells RFC 6638 servers (iCloud, Fastmail) not to e-mail invitations
 * themselves — Octopus sends the iTIP messages, so attendees don't get duplicates.
 */
export function setParticipants(ev: IcalComponent, organizer: Address | null, attendees: Attendee[], scheduleAgentClient = true): void {
  const previous = new Map(attendeesOf(ev).map((a) => [a.email, a]))
  ev.removeAllProperties('organizer')
  ev.removeAllProperties('attendee')
  const list = attendees.filter((a) => a.email && (!organizer || a.email.toLowerCase() !== organizer.email.toLowerCase()))
  if (!organizer || !list.length) return
  const op = new ICAL.Property('organizer')
  if (organizer.name) op.setParameter('cn', cleanParam(organizer.name))
  op.setValue(`mailto:${organizer.email}`)
  ev.addProperty(op)
  addAttendee(ev, organizer, 'CHAIR', 'ACCEPTED', false, false)
  for (const a of list) {
    const prev = previous.get(a.email.toLowerCase())
    const status = a.status || prev?.status || 'NEEDS-ACTION'
    addAttendee(ev, { email: a.email.toLowerCase(), name: a.name || prev?.name }, a.role || prev?.role || 'REQ-PARTICIPANT', status, status === 'NEEDS-ACTION', scheduleAgentClient)
  }
}

function withConferenceInDescription(description: string | null | undefined, url: string | null | undefined): string | null {
  const d = description || ''
  if (!url || d.includes(url)) return d || null
  return `${d ? `${d}\n\n` : ''}Dołącz do spotkania: ${url}`
}

export interface NewEventSpec {
  uid: string
  summary: string
  description?: string | null
  location?: string | null
  start: number
  end: number
  all_day?: boolean
  tz?: string | null
  organizer?: Address | null
  attendees?: Attendee[]
  conference_url?: string | null
  alarmMinutes?: number | null
  scheduleAgentClient?: boolean
}

/** Normalised [start, end) for an event; all-day ends are exclusive local midnights. */
export function normalizeRange(start: number, end: number, allDay: boolean): { start: number; end: number } {
  if (!allDay) return { start, end: Math.max(start, end) }
  const s = startOfLocalDay(start)
  let e = startOfLocalDay(end)
  if (end > e) e = addLocalDays(e, 1)
  if (e <= s) e = addLocalDays(s, 1)
  return { start: s, end: e }
}

function applyRange(cal: IcalComponent, ev: IcalComponent, start: number, end: number, allDay: boolean, tz: string | null | undefined): void {
  const mode = timeModeFor(tz, allDay)
  const r = normalizeRange(start, end, allDay)
  ev.removeAllProperties('duration')
  setTime(ev, 'dtstart', r.start, mode)
  setTime(ev, 'dtend', r.end, mode)
  ensureVtimezone(cal, mode)
}

/** VCALENDAR text for a brand-new event. */
export function buildEventIcs(s: NewEventSpec): string {
  const cal = newVcalendar()
  const ev = new ICAL.Component('vevent')
  const stamp = nowUtc()
  ev.addPropertyWithValue('uid', s.uid)
  ev.addPropertyWithValue('dtstamp', stamp)
  ev.addPropertyWithValue('created', stamp.clone())
  ev.addPropertyWithValue('last-modified', stamp.clone())
  ev.addPropertyWithValue('sequence', 0)
  applyRange(cal, ev, s.start, s.end, !!s.all_day, s.tz)
  ev.addPropertyWithValue('summary', s.summary)
  const description = withConferenceInDescription(s.description, s.conference_url)
  if (description) ev.addPropertyWithValue('description', description)
  if (s.location) ev.addPropertyWithValue('location', s.location)
  if (s.conference_url) ev.addPropertyWithValue('url', s.conference_url)
  ev.addPropertyWithValue('status', 'CONFIRMED')
  ev.addPropertyWithValue('transp', s.all_day ? 'TRANSPARENT' : 'OPAQUE')
  setParticipants(ev, s.organizer ?? null, s.attendees ?? [], s.scheduleAgentClient ?? true)
  if (s.alarmMinutes != null && !s.all_day) ev.addSubcomponent(alarmComponent(s.alarmMinutes))
  cal.addSubcomponent(ev)
  return serialize(cal)
}

function alarmComponent(minutesBefore: number): IcalComponent {
  const va = new ICAL.Component('valarm')
  va.addPropertyWithValue('action', 'DISPLAY')
  va.addPropertyWithValue('description', 'Przypomnienie')
  va.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-Math.round(minutesBefore * 60)))
  return va
}

function vevents(cal: IcalComponent, uid: string): IcalComponent[] {
  const all = cal.getAllSubcomponents('vevent')
  const mine = all.filter((v) => uidOf(v) === uid)
  return mine.length ? mine : all
}

function masterOf(list: IcalComponent[]): IcalComponent | null {
  return list.find((v) => !v.hasProperty('recurrence-id')) ?? null
}

/** How the existing DTSTART is written, so edits keep the same flavour (date / TZID / UTC). */
function modeOf(comp: IcalComponent, fallbackTz: string | null, allDayOverride?: boolean): TimeMode {
  const s = propTime(comp, 'dtstart')
  const allDay = allDayOverride ?? !!s?.time.isDate
  if (allDay) return { kind: 'date' }
  if (s && !s.time.isDate) {
    if (s.time.zone === ICAL.Timezone.utcTimezone) return { kind: 'utc' }
    const iana = resolveTzid(s.tzid)
    if (iana) return iana === 'UTC' ? { kind: 'utc' } : { kind: 'tz', tz: iana }
  }
  return timeModeFor(fallbackTz, false)
}

function bump(comp: IcalComponent, sequence: boolean): void {
  const stamp = nowUtc()
  comp.updatePropertyWithValue('dtstamp', stamp)
  comp.updatePropertyWithValue('last-modified', stamp.clone())
  if (sequence) comp.updatePropertyWithValue('sequence', (Number(textProp(comp, 'sequence')) || 0) + 1)
}

/** Rewrite every value of a date/time property shifted by deltaMs, keeping its flavour. */
function shiftTimes(comp: IcalComponent, name: string, deltaMs: number, fallbackTz: string | null): void {
  const props = comp.getAllProperties(name)
  for (const p of props) {
    const tzid = param(p, 'tzid') ?? fallbackTz
    let values: unknown[] = []
    try {
      values = p.getValues()
    } catch {
      values = []
    }
    comp.removeProperty(p)
    for (const v of values) {
      if (!isTime(v)) continue
      const mode: TimeMode = v.isDate
        ? { kind: 'date' }
        : v.zone === ICAL.Timezone.utcTimezone
          ? { kind: 'utc' }
          : timeModeFor(resolveTzid(tzid), false)
      comp.addProperty(timeProperty(name, timeToMs(v, tzid) + deltaMs, mode))
    }
  }
}

export interface EventPatch {
  summary?: string
  description?: string | null
  location?: string | null
  start?: number
  end?: number
  all_day?: boolean
  attendees?: Attendee[]
  conference_url?: string | null
}

/**
 * Apply an edit to a stored resource. With occurrenceStart set on a recurring event, only that
 * instance changes (an override VEVENT with RECURRENCE-ID is created or updated).
 */
export function patchResource(
  ics: string,
  uid: string,
  patch: EventPatch,
  ctx: { tz: string | null; organizer: Address | null; occurrenceStart?: number | null; bumpSequence: boolean },
): { ics: string; significant: boolean } {
  const cal = parseIcs(ics)
  const list = vevents(cal, uid)
  const master = masterOf(list) ?? list[0]
  if (!master) throw new Error('Wydarzenie nie ma komponentu VEVENT')
  const recurring = master.hasProperty('rrule') || master.hasProperty('rdate')
  let target = master
  if (ctx.occurrenceStart != null && recurring) {
    const res = resourceFromCalendar(cal, uid)!
    const found = list.find((v) => {
      const p = v.getFirstProperty('recurrence-id')
      const t = propValue(p)
      return isTime(t) && timeToMs(t, param(p!, 'tzid') ?? res.tzHint) === ctx.occurrenceStart
    })
    if (found) target = found
    else {
      target = new ICAL.Component(ICAL.parse(master.toString()) as unknown[])
      for (const n of ['rrule', 'rdate', 'exdate']) target.removeAllProperties(n)
      const mode = modeOf(master, ctx.tz)
      const occStart = ctx.occurrenceStart
      const occEnd = res.master?.all_day ? addLocalDays(occStart, res.durationDays) : occStart + res.durationMs
      setTime(target, 'recurrence-id', occStart, mode)
      setTime(target, 'dtstart', occStart, mode)
      target.removeAllProperties('duration')
      setTime(target, 'dtend', occEnd, mode)
      cal.addSubcomponent(target)
    }
  }
  let significant = false
  const setText = (name: string, v: string | null | undefined) => {
    if (v === undefined) return
    if (v === null || v === '') target.removeAllProperties(name)
    else target.updatePropertyWithValue(name, v)
  }
  setText('summary', patch.summary)
  if (patch.location !== undefined && (patch.location || null) !== textProp(target, 'location')) significant = true
  setText('location', patch.location)
  setText('description', patch.description)
  if (patch.conference_url !== undefined) {
    target.removeAllProperties('url')
    if (patch.conference_url) {
      target.addPropertyWithValue('url', patch.conference_url)
      const d = withConferenceInDescription(textProp(target, 'description'), patch.conference_url)
      if (d) target.updatePropertyWithValue('description', d)
    }
  }
  if (patch.start !== undefined || patch.end !== undefined || patch.all_day !== undefined) {
    const cur = eventData(target)
    const allDay = patch.all_day ?? cur.all_day
    const start = patch.start ?? cur.start
    const end = patch.end ?? start + (cur.end - cur.start)
    const mode = modeOf(target, ctx.tz, allDay)
    const r = normalizeRange(start, end, allDay)
    if (r.start !== cur.start || r.end !== cur.end || allDay !== cur.all_day) {
      significant = true
      if (target === master && recurring && allDay === cur.all_day && r.start !== cur.start) {
        // moving a whole series: keep EXDATEs and overrides attached to the moved instances
        const delta = r.start - cur.start
        shiftTimes(master, 'exdate', delta, cur.tzid)
        for (const ex of list) if (ex !== master) shiftTimes(ex, 'recurrence-id', delta, cur.tzid)
      }
      target.removeAllProperties('duration')
      setTime(target, 'dtstart', r.start, mode)
      setTime(target, 'dtend', r.end, mode)
      ensureVtimezone(cal, mode)
    }
  }
  if (patch.attendees !== undefined) {
    const before = attendeesOf(target).map((a) => a.email).sort().join(',')
    const organizer = organizerOf(target) ?? ctx.organizer
    const comps = target === master ? list : [target]
    for (const c of comps) setParticipants(c, organizer, patch.attendees)
    const after = attendeesOf(target).map((a) => a.email).sort().join(',')
    if (before !== after) significant = true
  }
  bump(target, significant && ctx.bumpSequence)
  return { ics: serialize(cal), significant }
}

/** Remove one instance of a recurring event (EXDATE + drop its override). */
export function excludeOccurrence(ics: string, uid: string, occurrenceStart: number, bumpSequence: boolean): string {
  const cal = parseIcs(ics)
  const list = vevents(cal, uid)
  const master = masterOf(list)
  if (!master) throw new Error('Nie można usunąć pojedynczego wystąpienia — brak wydarzenia głównego')
  const res = resourceFromCalendar(cal, uid)!
  for (const v of list) {
    const p = v.getFirstProperty('recurrence-id')
    const t = propValue(p)
    if (isTime(t) && timeToMs(t, param(p!, 'tzid') ?? res.tzHint) === occurrenceStart) cal.removeSubcomponent(v)
  }
  master.addProperty(timeProperty('exdate', occurrenceStart, modeOf(master, res.tzHint)))
  bump(master, bumpSequence)
  return serialize(cal)
}

/**
 * Set the user's PARTSTAT in every VEVENT of the resource. Returns the address that was
 * matched (or added, when `addIfMissing` is given and the user isn't listed).
 */
export function setMyPartstat(
  ics: string,
  myEmails: Set<string>,
  partstat: string,
  addIfMissing?: Address | null,
): { ics: string; email: string | null } {
  const cal = parseIcs(ics)
  let matched: string | null = null
  for (const v of cal.getAllSubcomponents('vevent')) {
    let found = false
    for (const p of v.getAllProperties('attendee')) {
      const email = calAddress(propValue(p))
      if (email && myEmails.has(email)) {
        p.setParameter('partstat', partstat)
        p.removeParameter('rsvp')
        found = true
        matched = matched ?? email
      }
    }
    if (!found && addIfMissing) {
      addAttendee(v, addIfMissing, 'REQ-PARTICIPANT', partstat, false, false)
      matched = matched ?? addIfMissing.email.toLowerCase()
    }
    bump(v, false)
  }
  return { ics: serialize(cal), email: matched }
}

function stripScheduling(v: IcalComponent): void {
  for (const p of [...v.getAllProperties('attendee'), ...v.getAllProperties('organizer')]) {
    p.removeParameter('schedule-agent')
    p.removeParameter('schedule-status')
    p.removeParameter('schedule-force-send')
  }
  for (const va of v.getAllSubcomponents('valarm')) v.removeSubcomponent(va)
}

/**
 * iTIP REQUEST/CANCEL message body for a stored resource. With `recurrenceMs` a CANCEL covers
 * just that instance; with `onlyAttendees` the message lists only those attendees.
 */
export function buildItipIcs(
  method: 'REQUEST' | 'CANCEL',
  ics: string,
  opts: { uid?: string; recurrenceMs?: number | null; onlyAttendees?: string[] } = {},
): string {
  const cal = parseIcs(ics)
  cal.removeAllProperties('method')
  cal.addPropertyWithValue('method', method)
  const uid = opts.uid ?? uidOf(cal.getAllSubcomponents('vevent')[0] ?? cal)
  let list = vevents(cal, uid)
  for (const v of cal.getAllSubcomponents('vevent')) if (!list.includes(v)) cal.removeSubcomponent(v)
  if (opts.recurrenceMs != null) {
    const master = masterOf(list)
    const res = resourceFromCalendar(cal, uid)
    if (master && res) {
      const inst = new ICAL.Component(ICAL.parse(master.toString()) as unknown[])
      for (const n of ['rrule', 'rdate', 'exdate']) inst.removeAllProperties(n)
      const mode = modeOf(master, res.tzHint)
      const end = res.master?.all_day ? addLocalDays(opts.recurrenceMs, res.durationDays) : opts.recurrenceMs + res.durationMs
      setTime(inst, 'recurrence-id', opts.recurrenceMs, mode)
      setTime(inst, 'dtstart', opts.recurrenceMs, mode)
      inst.removeAllProperties('duration')
      setTime(inst, 'dtend', end, mode)
      for (const v of list) cal.removeSubcomponent(v)
      cal.addSubcomponent(inst)
      list = [inst]
    }
  }
  for (const v of list) {
    stripScheduling(v)
    if (opts.onlyAttendees) {
      const keep = new Set(opts.onlyAttendees.map((e) => e.toLowerCase()))
      for (const p of v.getAllProperties('attendee')) {
        const e = calAddress(propValue(p))
        if (!e || !keep.has(e)) v.removeProperty(p)
      }
    }
    if (method === 'CANCEL') {
      v.updatePropertyWithValue('status', 'CANCELLED')
      bump(v, true)
    } else {
      v.updatePropertyWithValue('dtstamp', nowUtc())
    }
  }
  return serialize(cal)
}

/** iTIP REPLY to an invitation, carrying only the replying attendee. */
export function buildReplyIcs(inviteIcs: string, me: Address, partstat: string, comment?: string | null): string {
  const src = parseIcs(inviteIcs)
  const first = src.getAllSubcomponents('vevent')[0]
  if (!first) throw new Error('Zaproszenie nie zawiera wydarzenia')
  const uid = uidOf(first)
  const out = newVcalendar()
  out.addPropertyWithValue('method', 'REPLY')
  const usedTz = new Set<string>()
  const copy = (from: IcalComponent, to: IcalComponent, name: string) => {
    for (const p of from.getAllProperties(name)) {
      const tz = param(p, 'tzid')
      if (tz) usedTz.add(tz)
      to.addProperty(ICAL.Property.fromString(p.toICALString()))
    }
  }
  const myEmail = me.email.toLowerCase()
  for (const v of vevents(src, uid)) {
    const r = new ICAL.Component('vevent')
    for (const n of ['uid', 'sequence', 'recurrence-id', 'dtstart', 'dtend', 'duration', 'summary', 'location', 'organizer']) copy(v, r, n)
    r.updatePropertyWithValue('dtstamp', nowUtc())
    const existing = v.getAllProperties('attendee').find((p) => calAddress(propValue(p)) === myEmail)
    const att = existing ? ICAL.Property.fromString(existing.toICALString()) : new ICAL.Property('attendee')
    if (!existing) {
      if (me.name) att.setParameter('cn', cleanParam(me.name))
      att.setValue(`mailto:${myEmail}`)
    }
    att.setParameter('partstat', partstat)
    att.removeParameter('rsvp')
    att.removeParameter('schedule-agent')
    att.removeParameter('schedule-status')
    r.addProperty(att)
    if (comment) r.addPropertyWithValue('comment', comment)
    out.addSubcomponent(r)
  }
  for (const z of src.getAllSubcomponents('vtimezone')) {
    if (usedTz.has(textProp(z, 'tzid') || '')) out.addSubcomponent(new ICAL.Component(ICAL.parse(z.toString()) as unknown[]))
  }
  return serialize(out)
}

/** Turn a received invitation into a calendar resource with the user's PARTSTAT. */
export function inviteToResource(inviteIcs: string, myEmails: Set<string>, partstat: string, me: Address): string {
  const cal = parseIcs(inviteIcs)
  cal.removeAllProperties('method')
  const stripped = serialize(cal)
  return setMyPartstat(stripped, myEmails, partstat, me).ics
}

/**
 * Merge a newer invitation into the stored copy: single-instance invites replace/add that
 * override; a series invite with SEQUENCE ≥ stored replaces the copy; older ones only update PARTSTAT.
 */
export function mergeInvite(existingIcs: string, inviteIcs: string, myEmails: Set<string>, partstat: string, me: Address): string {
  const inv = parseIcs(inviteIcs)
  const invEvents = inv.getAllSubcomponents('vevent')
  if (!invEvents.length) return setMyPartstat(existingIcs, myEmails, partstat, me).ics
  const uid = uidOf(invEvents[0])
  const ex = parseIcs(existingIcs)
  const exList = vevents(ex, uid)
  const exMaster = masterOf(exList)
  const invMaster = masterOf(invEvents)
  if (!invMaster && exMaster) {
    const exRes = resourceFromCalendar(ex, uid)
    for (const iv of invEvents) {
      const ip = iv.getFirstProperty('recurrence-id')
      const it = propValue(ip)
      if (!isTime(it)) continue
      const ms = timeToMs(it, param(ip!, 'tzid') ?? exRes?.tzHint)
      for (const v of exList) {
        const p = v.getFirstProperty('recurrence-id')
        const t = propValue(p)
        if (isTime(t) && timeToMs(t, param(p!, 'tzid') ?? exRes?.tzHint) === ms) ex.removeSubcomponent(v)
      }
      ex.addSubcomponent(new ICAL.Component(ICAL.parse(iv.toString()) as unknown[]))
    }
    for (const z of inv.getAllSubcomponents('vtimezone')) {
      const id = textProp(z, 'tzid')
      if (!ex.getAllSubcomponents('vtimezone').some((e) => textProp(e, 'tzid') === id)) ex.addSubcomponent(new ICAL.Component(ICAL.parse(z.toString()) as unknown[]))
    }
    ex.removeAllProperties('method')
    return setMyPartstat(serialize(ex), myEmails, partstat, me).ics
  }
  const invSeq = Number(textProp(invMaster ?? invEvents[0], 'sequence')) || 0
  const exSeq = Number(textProp(exMaster ?? exList[0], 'sequence')) || 0
  if (invSeq >= exSeq) return inviteToResource(inviteIcs, myEmails, partstat, me)
  return setMyPartstat(existingIcs, myEmails, partstat, me).ics
}

// ---------- invitations ----------

export interface InviteData {
  method: string
  uid: string
  sequence: number
  summary: string
  description: string | null
  location: string | null
  start: number
  end: number
  all_day: boolean
  recurring: boolean
  rrule: string | null
  recurrence_id: number | null
  status: string | null
  organizer: Address | null
  attendees: Attendee[]
  my_email: string | null
  my_status: string | null
  conference_url: string | null
}

/** Read an iTIP message (REQUEST / CANCEL / REPLY / PUBLISH) from ICS text. */
export function parseInviteIcs(text: string, myEmails: Iterable<string>): InviteData | null {
  const cal = parseIcs(text)
  const method = String(textProp(cal, 'method') || 'PUBLISH').toUpperCase()
  const res = resourceFromCalendar(cal)
  if (!res) return null
  const main = res.master ?? res.exceptions[0].data
  const mine = new Set([...myEmails].map((e) => e.toLowerCase()))
  const me = main.attendees.find((a) => mine.has(a.email))
  return {
    method,
    uid: res.uid,
    sequence: main.sequence,
    summary: main.summary,
    description: main.description,
    location: main.location,
    start: main.start,
    end: main.end,
    all_day: main.all_day,
    recurring: res.recurring,
    rrule: main.rrule,
    recurrence_id: res.master ? null : res.exceptions[0].ridMs,
    status: method === 'CANCEL' ? 'CANCELLED' : main.status,
    organizer: main.organizer,
    attendees: main.attendees,
    my_email: me?.email ?? null,
    my_status: me?.status ?? null,
    conference_url: main.conference_url,
  }
}
