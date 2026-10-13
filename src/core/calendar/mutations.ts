// Event writes. CalDAV/Google calendars are written through to the server first (the local
// row is updated only after the server accepted the change); local calendars stay local.
// Invitations (REQUEST/CANCEL) and replies (REPLY) are e-mailed by us for every provider.
import crypto from 'node:crypto'
import { t } from '../../shared/i18n'
import type { Address, EventInput } from '../../shared/types'
import { myAddresses } from '../accounts'
import { bus } from '../events'
import { record } from '../history'
import { parseAddressList } from '../mime'
import { getSettings } from '../settings'
import { syncCalendars } from './calsync'
import { clientFor, DavHttpError, deleteObject, putObject } from './dav'
import {
  type Attendee, buildEventIcs, buildItipIcs, buildReplyIcs, type EventData, type EventPatch, excludeOccurrence, parseResource,
  patchResource, setMyPartstat,
} from './ical'
import {
  accountForSource, cancelSubject, cancelText, replySubject, replyText, requestSubject, requestText, sendItip, senderFor,
} from './itip'
import {
  type CalendarOccurrence, type CalRow, deleteEventRow, type EventRow, eventRowByUid, getCalendarRow, getEvent, getEventRow, getSource,
  isWritable, notifyChanged, readonlyMsg, resolveWritableCalendar, type SourceRow, upsertEventRow,
} from './store'
import { isValidTz } from './tz'

export type RsvpResponse = 'ACCEPTED' | 'TENTATIVE' | 'DECLINED'
export const RSVP_RESPONSES: RsvpResponse[] = ['ACCEPTED', 'TENTATIVE', 'DECLINED']

const DAY = 86400_000
const DEFAULT_ALARM_MIN = 10

export function userTimeZone(): string {
  const tz = getSettings().timeZone
  return tz && isValidTz(tz) ? tz : 'Europe/Warsaw'
}

function parseAttendees(list: (string | Address)[] | undefined | null): Attendee[] {
  return parseAddressList((list || []) as (string | Address)[]).filter((a, i, arr) => arr.findIndex((b) => b.email === a.email) === i)
}

function mainOf(ics: string | null, uid: string): EventData {
  const res = ics ? parseResource(ics, uid) : null
  const main = res?.master ?? res?.exceptions[0]?.data
  if (!main) throw new Error(t('Cannot read this event (damaged ICS data).'))
  return main
}

function rowContext(id: number): { row: EventRow; cal: CalRow; src: SourceRow } {
  const row = getEventRow(id)
  if (!row) throw new Error(t('The event does not exist (it may have been deleted).'))
  const cal = getCalendarRow(row.calendar_id)!
  const src = getSource(cal.source_id)!
  return { row, cal, src }
}

/** Write a resource to its calendar (server first for CalDAV/Google). Returns the row id. */
export async function writeResource(cal: CalRow, src: SourceRow, uid: string, ics: string, existing: EventRow | null, retried = false): Promise<number> {
  if (!isWritable(cal, src)) throw new Error(readonlyMsg())
  if (src.kind === 'local') return upsertEventRow(cal.id, ics, { uid, href: null, etag: null })!.id
  const conn = await clientFor(src)
  try {
    const r = await putObject(conn, cal.remote_url!, existing?.href ?? null, uid, ics, existing?.etag ?? null)
    return upsertEventRow(cal.id, ics, { uid, href: r.href, etag: r.etag })!.id
  } catch (e) {
    // the object moved on the server (e.g. a provider renamed it): resync once and retry
    if (!retried && existing && e instanceof DavHttpError && e.status === 404) {
      await syncCalendars(src.id).catch(() => undefined)
      return writeResource(cal, src, uid, ics, eventRowByUid(cal.id, uid) ?? null, true)
    }
    throw e
  }
}

async function removeResource(cal: CalRow, src: SourceRow, row: EventRow): Promise<void> {
  if (!isWritable(cal, src)) throw new Error(readonlyMsg())
  if (src.kind !== 'local' && row.href) await deleteObject(await clientFor(src), row.href, row.etag)
  deleteEventRow(row.id)
}

/** E-mail REQUEST/CANCEL to attendees; failures become a toast (the calendar change already happened). */
async function mailAttendees(
  method: 'REQUEST' | 'CANCEL',
  ics: string,
  uid: string,
  src: SourceRow,
  to: Address[],
  actor: string,
  opts: { update?: boolean; recurrenceMs?: number | null; onlyAttendees?: string[] } = {},
): Promise<void> {
  if (!to.length) return
  const main = mainOf(ics, uid)
  const sender = senderFor(main.organizer?.email, accountForSource(src))
  if (!sender) {
    bus.emitEvent({ type: 'toast', level: 'error', message: t('Invitations not sent — no mail account.') })
    return
  }
  const shown = opts.recurrenceMs != null ? { ...main, start: opts.recurrenceMs, end: opts.recurrenceMs + (main.end - main.start) } : main
  try {
    await sendItip({
      account: sender.account,
      from: sender.from,
      to,
      method,
      subject: method === 'REQUEST' ? requestSubject(shown, !!opts.update) : cancelSubject(shown),
      text: method === 'REQUEST' ? requestText(shown, !!opts.update) : cancelText(shown),
      ics: buildItipIcs(method, ics, { uid, recurrenceMs: opts.recurrenceMs, onlyAttendees: opts.onlyAttendees }),
    })
    record(actor, method === 'REQUEST' ? 'calendar.invite' : 'calendar.cancel', uid, { to: to.map((a) => a.email), summary: main.summary })
  } catch (e) {
    const msg = (e as Error).message
    record(actor, method === 'REQUEST' ? 'calendar.invite' : 'calendar.cancel', uid, msg, false)
    bus.emitEvent({
      type: 'toast',
      level: 'error',
      message: method === 'REQUEST'
        ? t('Change saved in the calendar, but the invitations were not sent: {error}', { error: msg })
        : t('Change saved in the calendar, but the cancellation was not sent: {error}', { error: msg }),
    })
  }
}

function others(attendees: Attendee[], me: Set<string>, organizer: Address | null): Attendee[] {
  return attendees.filter((a) => !me.has(a.email) && (!organizer || a.email !== organizer.email.toLowerCase()))
}

/** Create an event (default calendar unless calendar_id is given) and invite attendees. */
export async function createEvent(input: EventInput, actor = 'ui'): Promise<CalendarOccurrence> {
  if (!Number.isFinite(input.start)) throw new Error(t('Enter the start of the event.'))
  const allDay = !!input.all_day
  const end = Number.isFinite(input.end) ? input.end : input.start + (allDay ? DAY : 3600_000)
  if (end < input.start) throw new Error(t('The event cannot end before it starts.'))
  const target = resolveWritableCalendar(input.calendar_id ?? null)
  if (!target) throw new Error(t('No calendar the event can be saved in — add a calendar in Settings.'))
  const { cal, src } = target
  const attendees = parseAttendees(input.attendees)
  let organizer: Address | null = null
  if (attendees.length) {
    const acc = accountForSource(src)
    if (!acc) throw new Error(t('To invite guests, add a mail account first.'))
    organizer = { email: acc.email.toLowerCase(), name: acc.name || undefined }
  }
  const uid = crypto.randomUUID()
  const summary = input.summary?.trim() || 'Nowe wydarzenie'
  const ics = buildEventIcs({
    uid,
    summary,
    description: input.description,
    location: input.location,
    start: input.start,
    end,
    all_day: allDay,
    tz: userTimeZone(),
    organizer,
    attendees,
    conference_url: input.conference_url,
    alarmMinutes: allDay ? null : DEFAULT_ALARM_MIN,
  })
  const id = await writeResource(cal, src, uid, ics, null)
  record(actor, 'calendar.create', id, { summary, start: input.start, calendar: cal.name, attendees: attendees.map((a) => a.email) })
  notifyChanged()
  if (organizer) await mailAttendees('REQUEST', ics, uid, src, others(attendees, myAddresses(), organizer), actor)
  return getEvent(id)!
}

/**
 * Edit an event. With opts.occurrence_start only that instance of a recurring event changes.
 * patch.calendar_id moves the event to another calendar. Attendees get updated invitations
 * (and removed ones a cancellation) when the user is the organizer.
 */
export async function updateEvent(
  id: number,
  patch: Partial<EventInput>,
  actor = 'ui',
  opts: { occurrence_start?: number | null } = {},
): Promise<CalendarOccurrence> {
  const { row, cal, src } = rowContext(id)
  if (!isWritable(cal, src)) throw new Error(readonlyMsg())
  const me = myAddresses()
  const before = mainOf(row.ics, row.uid)
  const amOrganizer = !before.organizer || me.has(before.organizer.email.toLowerCase())
  const newAttendees = patch.attendees !== undefined ? parseAttendees(patch.attendees) : undefined
  let organizer: Address | null = before.organizer
  if (!organizer && newAttendees?.length) {
    const acc = accountForSource(src)
    if (!acc) throw new Error(t('To invite guests, add a mail account first.'))
    organizer = { email: acc.email.toLowerCase(), name: acc.name || undefined }
  }
  if (patch.start !== undefined && patch.end !== undefined && patch.end < patch.start) throw new Error(t('The event cannot end before it starts.'))
  const p: EventPatch = {
    summary: patch.summary === undefined ? undefined : patch.summary.trim() || 'Nowe wydarzenie',
    description: patch.description,
    location: patch.location,
    start: patch.start,
    end: patch.end,
    all_day: patch.all_day,
    attendees: newAttendees,
    conference_url: patch.conference_url,
  }
  const { ics } = patchResource(row.ics || '', row.uid, p, {
    tz: userTimeZone(),
    organizer,
    occurrenceStart: opts.occurrence_start ?? null,
    bumpSequence: amOrganizer,
  })

  let newId: number
  let targetSrc = src
  if (patch.calendar_id && patch.calendar_id !== row.calendar_id) {
    const target = resolveWritableCalendar(patch.calendar_id)!
    newId = await writeResource(target.cal, target.src, row.uid, ics, null)
    await removeResource(cal, src, row)
    targetSrc = target.src
  } else {
    newId = await writeResource(cal, src, row.uid, ics, row)
  }
  record(actor, 'calendar.update', newId, { summary: patch.summary ?? before.summary, fields: Object.keys(patch), occurrence: opts.occurrence_start ?? undefined })
  notifyChanged()

  if (amOrganizer && organizer) {
    const after = mainOf(ics, row.uid)
    const current = others(after.attendees, me, organizer)
    const previous = others(before.attendees, me, organizer)
    const removed = previous.filter((a) => !current.some((c) => c.email === a.email))
    await mailAttendees('REQUEST', ics, row.uid, targetSrc, current, actor, { update: previous.length > 0 })
    if (removed.length) await mailAttendees('CANCEL', row.ics || ics, row.uid, targetSrc, removed, actor, { onlyAttendees: removed.map((a) => a.email) })
  }
  return getEvent(newId)!
}

/** Delete an event (or one instance with opts.occurrence_start); attendees get a cancellation. */
export async function deleteEvent(id: number, actor = 'ui', opts: { occurrence_start?: number | null } = {}): Promise<void> {
  const { row, cal, src } = rowContext(id)
  if (!isWritable(cal, src)) throw new Error(readonlyMsg())
  const me = myAddresses()
  const main = mainOf(row.ics, row.uid)
  const amOrganizer = !!main.organizer && me.has(main.organizer.email.toLowerCase())
  const guests = amOrganizer ? others(main.attendees, me, main.organizer) : []
  const parsed = parseResource(row.ics || '', row.uid)
  if (opts.occurrence_start != null && parsed?.recurring) {
    const ics = excludeOccurrence(row.ics || '', row.uid, opts.occurrence_start, amOrganizer)
    await writeResource(cal, src, row.uid, ics, row)
    record(actor, 'calendar.delete', id, { summary: main.summary, occurrence: opts.occurrence_start })
    notifyChanged()
    if (guests.length) await mailAttendees('CANCEL', row.ics || '', row.uid, src, guests, actor, { recurrenceMs: opts.occurrence_start })
    return
  }
  await removeResource(cal, src, row)
  record(actor, 'calendar.delete', id, { summary: main.summary, start: main.start, calendar: cal.name })
  notifyChanged()
  if (guests.length) await mailAttendees('CANCEL', row.ics || '', row.uid, src, guests, actor)
}

export function assertResponse(response: string): asserts response is RsvpResponse {
  if (!RSVP_RESPONSES.includes(response as RsvpResponse)) throw new Error(t('Unknown response — allowed: ACCEPTED, TENTATIVE, DECLINED.'))
}

/** Answer an invitation that is already in a calendar: update PARTSTAT (server) + e-mail a REPLY. */
export async function rsvpEvent(eventId: number, response: RsvpResponse, actor = 'ui', comment?: string): Promise<void> {
  assertResponse(response)
  const { row, cal, src } = rowContext(eventId)
  const me = myAddresses()
  const main = mainOf(row.ics, row.uid)
  if (!main.organizer) throw new Error(t('This event has no organizer — there is no one to send the response to.'))
  if (me.has(main.organizer.email.toLowerCase())) throw new Error(t('You are the organizer of this event.'))
  const parsed = parseResource(row.ics || '', row.uid)
  const allAttendees = [main, ...(parsed?.exceptions.map((e) => e.data) ?? [])].flatMap((d) => d.attendees)
  const mine = allAttendees.find((a) => me.has(a.email))
  if (!mine) throw new Error(t('You are not on the guest list of this event.'))
  const sender = senderFor(mine.email, accountForSource(src))
  if (!sender) throw new Error(t('No mail account to send the response from.'))

  const { ics } = setMyPartstat(row.ics || '', me, response)
  if (isWritable(cal, src)) await writeResource(cal, src, row.uid, ics, row)
  else upsertEventRow(cal.id, ics, { uid: row.uid }) // read-only feed: local note until the next sync

  const replier: Address = { email: mine.email, name: sender.from.name }
  try {
    await sendItip({
      account: sender.account,
      from: sender.from,
      to: [main.organizer],
      method: 'REPLY',
      subject: replySubject(main.summary, response),
      text: replyText(main, replier, response, comment),
      ics: buildReplyIcs(row.ics || '', replier, response, comment),
    })
  } catch (e) {
    record(actor, 'calendar.rsvp', eventId, (e as Error).message, false)
    notifyChanged()
    throw new Error(t('Response saved in the calendar, but it was not sent to the organizer: {error}', { error: (e as Error).message }))
  }
  record(actor, 'calendar.rsvp', eventId, { response, summary: main.summary, organizer: main.organizer.email })
  notifyChanged()
}
