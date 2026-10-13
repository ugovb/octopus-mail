// iTIP over e-mail (RFC 6047): invitations, cancellations and replies are sent from the
// user's mail account as multipart/alternative with a text/calendar; method=… part.
import crypto from 'node:crypto'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import { dateLocale, t } from '../../shared/i18n'
import type { Account, Address } from '../../shared/types'
import { findAccount, getAccount, listAccounts, smtpAuth } from '../accounts'
import { get } from '../db'
import { log } from '../events'
import { getSettings } from '../settings'
import { sync } from '../sync'
import type { Attendee } from './ical'
import type { SourceRow } from './store'

export type ItipMethod = 'REQUEST' | 'CANCEL' | 'REPLY'

export interface ItipMail {
  account: Account
  from: Address
  to: Address[]
  method: ItipMethod
  subject: string
  text: string
  ics: string
}

/** SMTP delivery of a built message. Replaceable (tests capture messages instead of sending). */
export const itipTransport = {
  async send(acc: Account, raw: Buffer, envelope: { from: string; to: string[] }): Promise<void> {
    const transport = nodemailer.createTransport({
      host: acc.smtp_host,
      port: acc.smtp_port,
      secure: acc.smtp_secure,
      auth: await smtpAuth(acc),
      connectionTimeout: 30_000,
    } as nodemailer.TransportOptions)
    await transport.sendMail({ envelope, raw })
    // Gmail files sent mail itself; other servers need an APPEND to Sent
    if (!acc.is_gmail) {
      const sent = get<{ path: string }>("SELECT path FROM folders WHERE account_id = ? AND role = 'sent' LIMIT 1", acc.id)
      if (sent) {
        try {
          await sync.get(acc.id).append(sent.path, raw, ['\\Seen'])
        } catch (e) {
          log('calendar', 'append of iTIP message to Sent failed:', (e as Error).message)
        }
      }
    }
  },
}

export async function buildItipMime(m: ItipMail): Promise<{ raw: Buffer; envelope: { from: string; to: string[] } }> {
  const domain = m.from.email.split('@')[1] || 'octopus.local'
  const composer = new MailComposer({
    from: { name: m.from.name || '', address: m.from.email },
    to: m.to.map((a) => ({ name: a.name || '', address: a.email })),
    subject: m.subject,
    text: m.text,
    icalEvent: { method: m.method, content: m.ics, filename: 'invite.ics' },
    messageId: `<octo.cal.${Date.now().toString(36)}.${crypto.randomBytes(6).toString('hex')}@${domain}>`,
    headers: { 'X-Mailer': 'Octopus Mail' },
    date: new Date(),
  })
  const raw = await new Promise<Buffer>((resolve, reject) => composer.compile().build((err, msg) => (err ? reject(err) : resolve(msg))))
  return { raw, envelope: { from: m.from.email, to: m.to.map((a) => a.email) } }
}

/** Send one iTIP message (recipients equal to the sender are dropped). */
export async function sendItip(m: ItipMail): Promise<void> {
  const seen = new Set<string>([m.from.email.toLowerCase()])
  const to = m.to.filter((a) => {
    const e = a.email.toLowerCase()
    if (!e || seen.has(e)) return false
    seen.add(e)
    return true
  })
  if (!to.length) return
  const built = await buildItipMime({ ...m, to })
  await itipTransport.send(m.account, built.raw, built.envelope)
}

/** The mail account that speaks for a calendar source (invitations are sent from it). */
export function accountForSource(src: SourceRow | null | undefined): Account | null {
  if (src?.account_id) {
    try {
      return getAccount(src.account_id)
    } catch {
      /* account removed */
    }
  }
  if (src?.username?.includes('@')) {
    const a = findAccount(src.username)
    if (a) return a
  }
  const def = getSettings().defaultAccountId
  if (def) {
    try {
      return getAccount(def)
    } catch {
      /* stale setting */
    }
  }
  return listAccounts(false)[0] ?? null
}

/** Account + From address for one of the user's addresses (identity), else the fallback account. */
export function senderFor(email: string | null | undefined, fallback: Account | null): { account: Account; from: Address } | null {
  if (email) {
    const acc = findAccount(email)
    if (acc) {
      const idn = get<{ name: string }>('SELECT name FROM identities WHERE account_id = ? AND email = ? COLLATE NOCASE', acc.id, email)
      return { account: acc, from: { email: email.toLowerCase(), name: idn?.name || acc.name || undefined } }
    }
  }
  if (fallback) return { account: fallback, from: { email: fallback.email, name: fallback.name || undefined } }
  return null
}

// ---------- texts (in the UI language) ----------

function userTz(): string | undefined {
  return getSettings().timeZone || undefined
}

export function fmtWhen(start: number, end: number, allDay: boolean): string {
  const tz = allDay ? undefined : userTz()
  const date = new Intl.DateTimeFormat(dateLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz })
  const time = new Intl.DateTimeFormat(dateLocale(), { hour: '2-digit', minute: '2-digit', timeZone: tz })
  if (allDay) {
    const last = end - 1
    const a = date.format(start)
    const b = date.format(Math.max(start, last))
    return a === b ? t('{date} (all day)', { date: a }) : `${a} – ${b}`
  }
  const sameDay = date.format(start) === date.format(end)
  return sameDay ? `${date.format(start)}, ${time.format(start)}–${time.format(end)}` : `${date.format(start)} ${time.format(start)} – ${date.format(end)} ${time.format(end)}`
}

export interface DescribedEvent {
  summary: string
  start: number
  end: number
  all_day: boolean
  location?: string | null
  conference_url?: string | null
  description?: string | null
  organizer?: Address | null
  attendees?: Attendee[]
}

const nameOf = (a: Address) => (a.name ? `${a.name} <${a.email}>` : a.email)

export function describeEvent(e: DescribedEvent): string {
  const lines = [e.summary || t('(no title)'), '', t('When: {when}', { when: fmtWhen(e.start, e.end, e.all_day) })]
  if (e.location) lines.push(t('Where: {where}', { where: e.location }))
  if (e.conference_url && !(e.description || '').includes(e.conference_url)) lines.push(t('Join: {url}', { url: e.conference_url }))
  if (e.organizer) lines.push(t('Organizer: {name}', { name: nameOf(e.organizer) }))
  const guests = (e.attendees || []).filter((a) => !e.organizer || a.email !== e.organizer.email)
  if (guests.length) lines.push(t('Guests: {names}', { names: guests.map(nameOf).join(', ') }))
  if (e.description) lines.push('', e.description)
  return lines.join('\n')
}

function responseSentence(who: string, response: string, title: string): string {
  if (response === 'ACCEPTED') return t('{who} accepted the invitation: {title}', { who, title })
  if (response === 'TENTATIVE') return t('{who} tentatively accepted the invitation: {title}', { who, title })
  if (response === 'DECLINED') return t('{who} declined the invitation: {title}', { who, title })
  return t('{who} {response} the invitation: {title}', { who, response, title })
}

export function requestSubject(e: DescribedEvent, update: boolean): string {
  const vars = { title: e.summary || t('(no title)'), when: fmtWhen(e.start, e.end, e.all_day) }
  return update ? t('Updated invitation: {title} — {when}', vars) : t('Invitation: {title} — {when}', vars)
}

export function requestText(e: DescribedEvent, update: boolean): string {
  const who = e.organizer ? e.organizer.name || e.organizer.email : t('Organizer')
  const head = update ? t('{who} updated the event:', { who }) : t('{who} invited you to an event:', { who })
  return `${head}\n\n${describeEvent(e)}\n\n${t('Respond to the invitation in your calendar.')}\n`
}

export function cancelSubject(e: DescribedEvent): string {
  return t('Cancelled: {title} — {when}', { title: e.summary || t('(no title)'), when: fmtWhen(e.start, e.end, e.all_day) })
}

export function cancelText(e: DescribedEvent): string {
  return `${t('This event has been cancelled:')}\n\n${describeEvent(e)}\n`
}

/** Subject of an RSVP reply ("Accepted: …"); unknown responses are shown as they are. */
export function replySubject(summary: string, response: string): string {
  const title = summary || t('(no title)')
  if (response === 'ACCEPTED') return t('Accepted: {title}', { title })
  if (response === 'TENTATIVE') return t('Tentatively accepted: {title}', { title })
  if (response === 'DECLINED') return t('Declined: {title}', { title })
  return `${response}: ${title}`
}

export function replyText(e: DescribedEvent, me: Address, response: string, comment?: string | null): string {
  const who = me.name || me.email
  const lines = [responseSentence(who, response, e.summary || t('(no title)')), t('When: {when}', { when: fmtWhen(e.start, e.end, e.all_day) })]
  if (comment) lines.push('', t('Comment: {comment}', { comment }))
  return lines.join('\n') + '\n'
}
