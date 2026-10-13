// Calendar tables (cal_sources / calendars / events) and the read-side API:
// listCalendars, listEvents (with recurrence expansion), getEvent.
import type { Address, CalendarEvent, CalendarInfo } from '../../shared/types'
import { myAddresses } from '../accounts'
import { all, get, inList, now, parseJson, run, update } from '../db'
import { bus } from '../events'
import {
  type AlarmSpec, type Attendee, expandResource, isTransparent, type Occurrence, type ParsedResource, parseResource,
} from './ical'

export type SourceKind = 'google' | 'caldav' | 'ics' | 'local'

export interface SourceRow {
  id: number
  account_id: number | null
  kind: SourceKind
  url: string | null
  username: string | null
  name: string
  enabled: number
  last_sync: number | null
  last_error: string | null
  created_at: number
}

export interface CalRow {
  id: number
  source_id: number
  remote_url: string | null
  name: string
  color: string | null
  ctag: string | null
  sync_token: string | null
  readonly: number
  enabled: number
  is_default: number
  timezone: string | null
}

export interface EventRow {
  id: number
  calendar_id: number
  uid: string
  href: string | null
  etag: string | null
  summary: string | null
  description: string | null
  location: string | null
  start: number
  end: number
  all_day: number
  tzid: string | null
  recurring: number
  status: string | null
  organizer: string | null
  attendees: string | null
  my_status: string | null
  conference_url: string | null
  ics: string | null
  local_dirty: number
  updated_at: number
}

/** One concrete (possibly recurring) occurrence as returned by listEvents. */
export interface CalendarOccurrence extends CalendarEvent {
  /** Unique per occurrence: "<id>" for single events, "<id>:<occurrence_start>" for instances. */
  key: string
  /** Original start (RECURRENCE-ID) of this instance; null for non-recurring events. */
  occurrence_start: number | null
  /** TRANSP:TRANSPARENT / "free" time — ignored by findAvailability. */
  transparent: boolean
  readonly: boolean
  is_organizer: boolean
  alarms: AlarmSpec[]
  source_kind: SourceKind
}

export const READONLY_MSG = 'Ten kalendarz jest tylko do odczytu.'
export const DEFAULT_COLOR = '#3b82f6'

export function notifyChanged(): void {
  bus.emitEvent({ type: 'calendar-changed' })
}

// ---------- sources & calendars ----------

export function getSource(id: number): SourceRow | undefined {
  return get<SourceRow>('SELECT * FROM cal_sources WHERE id = ?', id)
}

export function getCalendarRow(id: number): CalRow | undefined {
  return get<CalRow>('SELECT * FROM calendars WHERE id = ?', id)
}

export function calendarsOf(sourceId: number): CalRow[] {
  return all<CalRow>('SELECT * FROM calendars WHERE source_id = ? ORDER BY is_default DESC, name', sourceId)
}

export function isWritable(cal: CalRow, src: SourceRow): boolean {
  return !cal.readonly && src.kind !== 'ics'
}

export function listCalendars(): CalendarInfo[] {
  return all(
    `SELECT c.*, s.kind AS source_kind, s.name AS source_name FROM calendars c JOIN cal_sources s ON s.id = c.source_id
     ORDER BY s.id, c.is_default DESC, c.name COLLATE NOCASE`,
  ).map((r) => ({
    id: r.id,
    source_id: r.source_id,
    name: r.name,
    color: r.color || DEFAULT_COLOR,
    readonly: !!r.readonly || r.source_kind === 'ics',
    enabled: !!r.enabled,
    is_default: !!r.is_default,
    source_kind: r.source_kind,
    source_name: r.source_name,
  }))
}

/** Rename / recolour / show-hide / make default. */
export function updateCalendar(id: number, patch: { name?: string; color?: string | null; enabled?: boolean; is_default?: boolean }): CalendarInfo {
  const cal = getCalendarRow(id)
  if (!cal) throw new Error(`Nie ma kalendarza o id ${id}`)
  if (patch.is_default) {
    const src = getSource(cal.source_id)!
    if (!isWritable(cal, src)) throw new Error('Kalendarz tylko do odczytu nie może być domyślny.')
    run('UPDATE calendars SET is_default = 0 WHERE is_default = 1')
  }
  update('calendars', id, {
    name: patch.name?.trim() || undefined,
    color: patch.color === undefined ? undefined : patch.color,
    enabled: patch.enabled,
    is_default: patch.is_default === undefined ? undefined : patch.is_default ? 1 : 0,
  })
  notifyChanged()
  return listCalendars().find((c) => c.id === id)!
}

/** Make sure some writable calendar is the default (prefer the given candidates in order). */
export function ensureDefaultCalendar(preferred: number[] = []): void {
  const cur = get<{ id: number }>(
    `SELECT c.id FROM calendars c JOIN cal_sources s ON s.id = c.source_id
     WHERE c.is_default = 1 AND c.readonly = 0 AND s.kind != 'ics' AND s.enabled = 1 LIMIT 1`,
  )
  if (cur) return
  run('UPDATE calendars SET is_default = 0 WHERE is_default = 1')
  const pick =
    preferred.find((id) => {
      const c = getCalendarRow(id)
      const s = c && getSource(c.source_id)
      return c && s && isWritable(c, s)
    }) ??
    get<{ id: number }>(
      `SELECT c.id FROM calendars c JOIN cal_sources s ON s.id = c.source_id
       WHERE c.readonly = 0 AND s.kind != 'ics' AND s.enabled = 1 AND c.enabled = 1
       ORDER BY CASE s.kind WHEN 'google' THEN 0 WHEN 'caldav' THEN 1 ELSE 2 END, s.id, c.id LIMIT 1`,
    )?.id
  if (pick) run('UPDATE calendars SET is_default = 1 WHERE id = ?', pick)
}

/**
 * Writable calendar to put new events in: explicit id, else (for an account) that account's
 * default/primary calendar, else the global default, else any writable calendar.
 */
export function resolveWritableCalendar(calendarId?: number | null, accountId?: number | null): { cal: CalRow; src: SourceRow } | null {
  if (calendarId) {
    const cal = getCalendarRow(calendarId)
    if (!cal) throw new Error(`Nie ma kalendarza o id ${calendarId}`)
    const src = getSource(cal.source_id)!
    if (!isWritable(cal, src)) throw new Error(READONLY_MSG)
    return { cal, src }
  }
  const rows = all<CalRow & { s_kind: string; s_account: number | null }>(
    `SELECT c.*, s.kind AS s_kind, s.account_id AS s_account FROM calendars c JOIN cal_sources s ON s.id = c.source_id
     WHERE c.readonly = 0 AND s.kind != 'ics' AND s.enabled = 1
     ORDER BY c.is_default DESC, c.enabled DESC, CASE s.kind WHEN 'google' THEN 0 WHEN 'caldav' THEN 1 ELSE 2 END, s.id, c.id`,
  )
  if (!rows.length) return null
  const pick =
    (accountId ? rows.find((r) => r.s_account === accountId && r.is_default) : undefined) ??
    rows.find((r) => r.is_default) ??
    (accountId ? rows.find((r) => r.s_account === accountId) : undefined) ??
    rows[0]
  return { cal: getCalendarRow(pick.id)!, src: getSource(pick.source_id)! }
}

// ---------- events ----------

export function getEventRow(id: number): EventRow | undefined {
  return get<EventRow>('SELECT * FROM events WHERE id = ?', id)
}

export function eventRowByUid(calendarId: number, uid: string): EventRow | undefined {
  return get<EventRow>('SELECT * FROM events WHERE calendar_id = ? AND uid = ?', calendarId, uid)
}

export function myStatusOf(attendees: Attendee[], me: Set<string>): string | null {
  return attendees.find((a) => me.has(a.email.toLowerCase()))?.status ?? null
}

/**
 * Insert or update the row for one calendar object resource (keyed by calendar + UID).
 * Throws on unparseable ICS; returns null when the resource holds no VEVENT.
 */
export function upsertEventRow(
  calendarId: number,
  ics: string,
  opts: { uid?: string; href?: string | null; etag?: string | null; me?: Set<string> } = {},
): { id: number; changed: boolean } | null {
  const res = parseResource(ics, opts.uid)
  if (!res) return null
  const main = res.master ?? res.exceptions[0].data
  const me = opts.me ?? myAddresses()
  const existing = get<{ id: number; ics: string | null; href: string | null; etag: string | null }>(
    'SELECT id, ics, href, etag FROM events WHERE calendar_id = ? AND uid = ?',
    calendarId,
    res.uid,
  )
  const href = opts.href === undefined ? (existing?.href ?? null) : opts.href
  const etag = opts.etag === undefined ? (existing?.etag ?? null) : opts.etag
  if (existing && existing.ics === ics && existing.href === href && existing.etag === etag) return { id: existing.id, changed: false }
  const multi = res.recurring || res.exceptions.length > (res.master ? 0 : 1)
  const row = get<{ id: number }>(
    `INSERT INTO events(calendar_id, uid, href, etag, summary, description, location, start, end, all_day, tzid, recurring,
       status, organizer, attendees, my_status, conference_url, ics, local_dirty, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(calendar_id, uid) DO UPDATE SET
       href = excluded.href, etag = excluded.etag, summary = excluded.summary, description = excluded.description,
       location = excluded.location, start = excluded.start, end = excluded.end, all_day = excluded.all_day,
       tzid = excluded.tzid, recurring = excluded.recurring, status = excluded.status, organizer = excluded.organizer,
       attendees = excluded.attendees, my_status = excluded.my_status, conference_url = excluded.conference_url,
       ics = excluded.ics, local_dirty = 0, updated_at = excluded.updated_at
     RETURNING id`,
    calendarId,
    res.uid,
    href,
    etag,
    main.summary,
    main.description,
    main.location,
    main.start,
    main.end,
    main.all_day,
    main.tzid,
    multi,
    main.status,
    main.organizer ? JSON.stringify(main.organizer) : null,
    JSON.stringify(main.attendees),
    myStatusOf(main.attendees, me),
    main.conference_url,
    ics,
    now(),
  )
  return { id: row!.id, changed: true }
}

export function deleteEventRow(id: number): void {
  run('DELETE FROM events WHERE id = ?', id)
  parseCache.delete(id)
}

// Parsed resources are cached per row (re-parsed only when the stored ICS changes).
const parseCache = new Map<number, { ics: string; parsed: ParsedResource | null }>()
const PARSE_CACHE_MAX = 1500

export function parsedFor(row: Pick<EventRow, 'id' | 'ics' | 'uid'>): ParsedResource | null {
  const ics = row.ics || ''
  const hit = parseCache.get(row.id)
  if (hit && hit.ics === ics) {
    parseCache.delete(row.id)
    parseCache.set(row.id, hit)
    return hit.parsed
  }
  let parsed: ParsedResource | null = null
  if (ics) {
    try {
      parsed = parseResource(ics, row.uid)
    } catch {
      parsed = null
    }
  }
  parseCache.set(row.id, { ics, parsed })
  if (parseCache.size > PARSE_CACHE_MAX) parseCache.delete(parseCache.keys().next().value as number)
  return parsed
}

function occurrenceFromColumns(r: EventRow): Occurrence {
  return {
    uid: r.uid,
    summary: r.summary || '',
    description: r.description,
    location: r.location,
    start: r.start,
    end: r.end,
    all_day: !!r.all_day,
    tzid: r.tzid,
    status: r.status,
    transp: null,
    busy_status: null,
    organizer: parseJson<Address | null>(r.organizer, null),
    attendees: parseJson<Attendee[]>(r.attendees, []),
    conference_url: r.conference_url,
    alarms: [],
    sequence: 0,
    recurrence_id: null,
    rrule: null,
    occurrence_start: null,
  }
}

type JoinedRow = EventRow & { calendar_name: string; cal_color: string | null; cal_readonly: number; source_kind: SourceKind }

function toOccurrence(r: JoinedRow, o: Occurrence, recurring: boolean, me: Set<string>): CalendarOccurrence {
  return {
    id: r.id,
    calendar_id: r.calendar_id,
    uid: r.uid,
    summary: o.summary,
    description: o.description,
    location: o.location,
    start: o.start,
    end: o.end,
    all_day: o.all_day,
    recurring,
    status: o.status,
    organizer: o.organizer,
    attendees: o.attendees.map((a) => ({ email: a.email, name: a.name, status: a.status, role: a.role })),
    my_status: myStatusOf(o.attendees, me),
    conference_url: o.conference_url,
    color: r.cal_color || DEFAULT_COLOR,
    calendar_name: r.calendar_name,
    key: o.occurrence_start != null ? `${r.id}:${o.occurrence_start}` : String(r.id),
    occurrence_start: o.occurrence_start,
    transparent: isTransparent(o),
    readonly: !!r.cal_readonly || r.source_kind === 'ics',
    is_organizer: !!o.organizer && me.has(o.organizer.email.toLowerCase()),
    alarms: o.alarms,
    source_kind: r.source_kind,
  }
}

const JOIN = `SELECT e.*, c.name AS calendar_name, c.color AS cal_color, c.readonly AS cal_readonly, s.kind AS source_kind
  FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN cal_sources s ON s.id = c.source_id`

function expandRow(r: JoinedRow, from: number, to: number, me: Set<string>): CalendarOccurrence[] {
  const parsed = parsedFor(r)
  if (!parsed) {
    const o = occurrenceFromColumns(r)
    const hit = o.start < to && (o.end > from || (o.end === o.start && o.start >= from))
    return hit ? [toOccurrence(r, o, false, me)] : []
  }
  return expandResource(parsed, from, to).map((o) => toOccurrence(r, o, parsed.recurring, me))
}

/**
 * Events (recurring ones expanded into concrete occurrences) intersecting [from, to),
 * sorted by start. Without calendarIds only enabled calendars are included.
 */
export function listEvents(from: number, to: number, calendarIds?: number[]): CalendarOccurrence[] {
  if (!(to > from)) return []
  const ids = calendarIds?.filter((x) => Number.isFinite(x)) ?? []
  const calFilter = ids.length ? `e.calendar_id IN (${inList(ids)})` : 'c.enabled = 1 AND s.enabled = 1'
  const rows = all<JoinedRow>(
    `${JOIN} WHERE ${calFilter} AND e.start < ? AND (e.recurring = 1 OR e.end > ? OR (e.end = e.start AND e.start >= ?))`,
    ...ids,
    to,
    from,
    from,
  )
  const me = myAddresses()
  const out: CalendarOccurrence[] = []
  for (const r of rows) out.push(...expandRow(r, from, to, me))
  return out.sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id)
}

/** One event as stored (the master / first instance), or null. */
export function getEvent(id: number): CalendarOccurrence | null {
  const r = get<JoinedRow>(`${JOIN} WHERE e.id = ?`, id)
  if (!r) return null
  const me = myAddresses()
  const parsed = parsedFor(r)
  if (!parsed) return toOccurrence(r, occurrenceFromColumns(r), false, me)
  const main = parsed.master ?? parsed.exceptions[0]?.data
  if (!main) return toOccurrence(r, occurrenceFromColumns(r), false, me)
  return toOccurrence(r, { ...main, occurrence_start: null }, parsed.recurring, me)
}
