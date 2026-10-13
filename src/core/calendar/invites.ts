// Calendar invitations received by e-mail (messages.calendar_part): parse, answer, apply cancellations.
import type { Address } from '../../shared/types'
import { getAccount, listIdentities, myAddresses } from '../accounts'
import { get } from '../db'
import { bus, log } from '../events'
import { record } from '../history'
import { decodeBuffer } from '../mime'
import { sync } from '../sync'
import { type Attendee, buildReplyIcs, type InviteData, inviteToResource, mergeInvite, parseInviteIcs } from './ical'
import { replySubject, replyText, sendItip, senderFor } from './itip'
import { assertResponse, deleteEvent, type RsvpResponse, writeResource } from './mutations'
import { type CalRow, type EventRow, getCalendarRow, getSource, isWritable, notifyChanged, parsedFor, resolveWritableCalendar } from './store'

export interface InviteInfo extends InviteData {
  message_id: number
  account_id: number
  /** The same UID already stored in a synced calendar. */
  existing_event_id: number | null
  existing_calendar_id: number | null
  existing_calendar_name: string | null
  /** The user's PARTSTAT in the stored copy (may be newer than the e-mail). */
  existing_status: string | null
  /** The stored copy has a higher SEQUENCE — this e-mail is an older version. */
  outdated: boolean
  /** METHOD:REPLY — who answered and how. */
  replies: Attendee[]
  ics: string
}

/** Where the text/calendar part comes from (IMAP). Replaceable — tests feed fixtures through it. */
export const inviteSource = {
  async load(accountId: number, messageId: number, part: string): Promise<string> {
    const p = await sync.get(accountId).downloadPart(messageId, part)
    return decodeBuffer(p.content, p.charset)
  },
}

const icsCache = new Map<number, string>()

async function loadInvite(messageId: number): Promise<{ m: { id: number; account_id: number; calendar_part: string | null }; ics: string } | null> {
  const m = get<{ id: number; account_id: number; calendar_part: string | null }>('SELECT id, account_id, calendar_part FROM messages WHERE id = ?', messageId)
  if (!m) throw new Error('Wiadomość nie istnieje.')
  if (!m.calendar_part) return null
  let ics = icsCache.get(messageId)
  if (!ics) {
    ics = await inviteSource.load(m.account_id, messageId, m.calendar_part)
    icsCache.set(messageId, ics)
    if (icsCache.size > 100) icsCache.delete(icsCache.keys().next().value as number)
  }
  return { m, ics }
}

function existingByUid(uid: string): (EventRow & { cal_name: string }) | undefined {
  return get<EventRow & { cal_name: string }>(
    `SELECT e.*, c.name AS cal_name FROM events e JOIN calendars c ON c.id = e.calendar_id JOIN cal_sources s ON s.id = c.source_id
     WHERE e.uid = ? ORDER BY (c.readonly = 0 AND s.kind != 'ics') DESC, c.is_default DESC, e.id LIMIT 1`,
    uid,
  )
}

/** Invitation details from ICS text (+ whether it is already in a calendar). No network. */
export function inviteInfoFromIcs(ics: string, ctx: { messageId: number; accountId: number; myEmails?: Set<string> }): InviteInfo | null {
  const me = ctx.myEmails ?? myAddresses()
  const data = parseInviteIcs(ics, me)
  if (!data) return null
  const ex = existingByUid(data.uid)
  const exParsed = ex ? parsedFor(ex) : null
  const exSeq = exParsed ? (exParsed.master ?? exParsed.exceptions[0]?.data)?.sequence ?? 0 : 0
  return {
    ...data,
    message_id: ctx.messageId,
    account_id: ctx.accountId,
    existing_event_id: ex?.id ?? null,
    existing_calendar_id: ex?.calendar_id ?? null,
    existing_calendar_name: ex?.cal_name ?? null,
    existing_status: ex?.my_status ?? null,
    outdated: !!ex && exSeq > data.sequence,
    replies: data.method === 'REPLY' ? data.attendees.filter((a) => !me.has(a.email)) : [],
    ics,
  }
}

/** Parse the text/calendar part of a message; null when the message has no invitation. */
export async function parseInvite(messageId: number): Promise<InviteInfo | null> {
  const loaded = await loadInvite(messageId)
  if (!loaded) return null
  return inviteInfoFromIcs(loaded.ics, { messageId, accountId: loaded.m.account_id })
}

/** The address the invite was sent to, among the receiving account's identities. */
function myInviteAddress(info: InviteData, accountId: number, me: Set<string>): Address {
  const acc = getAccount(accountId)
  const ids = listIdentities(accountId) as { email: string; name: string }[]
  const own = new Set([acc.email.toLowerCase(), ...ids.map((i) => i.email.toLowerCase())])
  const hit = info.attendees.find((a) => own.has(a.email)) ?? info.attendees.find((a) => me.has(a.email))
  const email = hit?.email ?? acc.email.toLowerCase()
  const idn = ids.find((i) => i.email.toLowerCase() === email)
  return { email, name: hit?.name || idn?.name || acc.name || undefined }
}

/**
 * Answer an invitation: e-mail an iTIP REPLY to the organizer from the receiving account, then
 * add/update the event (with the user's PARTSTAT) in the calendar that already holds it or the
 * default writable calendar. Declined invitations are not added when not yet in a calendar.
 */
export async function rsvpInvite(messageId: number, response: RsvpResponse, opts: { comment?: string; actor?: string } = {}): Promise<void> {
  assertResponse(response)
  const actor = opts.actor || 'ui'
  const loaded = await loadInvite(messageId)
  if (!loaded) throw new Error('Ta wiadomość nie zawiera zaproszenia.')
  const { m, ics } = loaded
  const meSet = myAddresses()
  const info = parseInviteIcs(ics, meSet)
  if (!info) throw new Error('Nie udało się odczytać zaproszenia.')
  if (info.method !== 'REQUEST') {
    throw new Error(info.method === 'CANCEL' ? 'To wydarzenie zostało odwołane — nie można na nie odpowiedzieć.' : 'Na tę wiadomość nie można odpowiedzieć (to nie jest zaproszenie).')
  }
  if (!info.organizer) throw new Error('Zaproszenie nie ma organizatora — nie ma komu wysłać odpowiedzi.')
  const me = myInviteAddress(info, m.account_id, meSet)
  const sender = senderFor(me.email, getAccount(m.account_id))!
  if (sender.account.id !== m.account_id) {
    // the address belongs to another account: still answer from the receiving one
    const acc = getAccount(m.account_id)
    sender.account = acc
    sender.from = { email: acc.email, name: acc.name || undefined }
  }

  await sendItip({
    account: sender.account,
    from: sender.from,
    to: [info.organizer],
    method: 'REPLY',
    subject: replySubject(info.summary, response),
    text: replyText(info, me, response, opts.comment),
    ics: buildReplyIcs(ics, me, response, opts.comment),
  })
  record(actor, 'calendar.rsvp', messageId, { uid: info.uid, response, summary: info.summary, organizer: info.organizer.email })

  try {
    await putInviteInCalendar(ics, info, me, response, m.account_id, new Set([...meSet, me.email]))
  } catch (e) {
    const msg = (e as Error).message
    log('calendar', 'storing accepted invitation failed:', msg)
    bus.emitEvent({ type: 'toast', level: 'error', message: `Odpowiedź wysłana, ale nie zapisano wydarzenia w kalendarzu: ${msg}` })
  }
  notifyChanged()
}

async function putInviteInCalendar(ics: string, info: InviteData, me: Address, response: RsvpResponse, accountId: number, myEmails: Set<string>): Promise<void> {
  const ex = existingByUid(info.uid)
  if (ex) {
    const cal = getCalendarRow(ex.calendar_id) as CalRow
    const src = getSource(cal.source_id)!
    if (isWritable(cal, src)) {
      const merged = mergeInvite(ex.ics || '', ics, myEmails, response, me)
      await writeResource(cal, src, info.uid, merged, ex)
      return
    }
  }
  if (response === 'DECLINED') return
  const target = resolveWritableCalendar(null, accountId)
  if (!target) return
  await writeResource(target.cal, target.src, info.uid, inviteToResource(ics, myEmails, response, me), null)
}

/** METHOD:CANCEL received: remove the event from the user's calendar. Returns true if something was removed. */
export async function applyInviteCancel(messageId: number, actor = 'ui'): Promise<boolean> {
  const loaded = await loadInvite(messageId)
  if (!loaded) return false
  const info = parseInviteIcs(loaded.ics, myAddresses())
  if (!info || info.method !== 'CANCEL') throw new Error('Ta wiadomość nie odwołuje wydarzenia.')
  const ex = existingByUid(info.uid)
  if (!ex) return false
  await deleteEvent(ex.id, actor, { occurrence_start: info.recurrence_id })
  return true
}
