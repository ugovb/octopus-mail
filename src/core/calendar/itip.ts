// iTIP over e-mail (RFC 6047): invitations, cancellations and replies are sent from the
// user's mail account as multipart/alternative with a text/calendar; method=… part.
import crypto from 'node:crypto'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
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

// ---------- Polish texts ----------

function userTz(): string | undefined {
  return getSettings().timeZone || undefined
}

export function fmtWhen(start: number, end: number, allDay: boolean): string {
  const tz = allDay ? undefined : userTz()
  const date = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz })
  const time = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: tz })
  if (allDay) {
    const last = end - 1
    const a = date.format(start)
    const b = date.format(Math.max(start, last))
    return a === b ? `${a} (cały dzień)` : `${a} – ${b}`
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
  const lines = [e.summary || '(bez tytułu)', '', `Kiedy: ${fmtWhen(e.start, e.end, e.all_day)}`]
  if (e.location) lines.push(`Gdzie: ${e.location}`)
  if (e.conference_url && !(e.description || '').includes(e.conference_url)) lines.push(`Dołącz: ${e.conference_url}`)
  if (e.organizer) lines.push(`Organizator: ${nameOf(e.organizer)}`)
  const guests = (e.attendees || []).filter((a) => !e.organizer || a.email !== e.organizer.email)
  if (guests.length) lines.push(`Uczestnicy: ${guests.map(nameOf).join(', ')}`)
  if (e.description) lines.push('', e.description)
  return lines.join('\n')
}

export const RESPONSE_LABEL: Record<string, string> = {
  ACCEPTED: 'Zaakceptowano',
  TENTATIVE: 'Wstępnie zaakceptowano',
  DECLINED: 'Odrzucono',
}

const RESPONSE_VERB: Record<string, string> = {
  ACCEPTED: 'akceptuje',
  TENTATIVE: 'wstępnie akceptuje',
  DECLINED: 'odrzuca',
}

export function requestSubject(e: DescribedEvent, update: boolean): string {
  return `${update ? 'Zaktualizowane zaproszenie' : 'Zaproszenie'}: ${e.summary || '(bez tytułu)'} — ${fmtWhen(e.start, e.end, e.all_day)}`
}

export function requestText(e: DescribedEvent, update: boolean): string {
  const who = e.organizer ? e.organizer.name || e.organizer.email : 'Organizator'
  const head = update ? `${who} zaktualizował(a) wydarzenie:` : `${who} zaprasza Cię na wydarzenie:`
  return `${head}\n\n${describeEvent(e)}\n\nOdpowiedz na zaproszenie w swoim kalendarzu.\n`
}

export function cancelSubject(e: DescribedEvent): string {
  return `Odwołane: ${e.summary || '(bez tytułu)'} — ${fmtWhen(e.start, e.end, e.all_day)}`
}

export function cancelText(e: DescribedEvent): string {
  return `To wydarzenie zostało odwołane:\n\n${describeEvent(e)}\n`
}

export function replySubject(summary: string, response: string): string {
  return `${RESPONSE_LABEL[response] || response}: ${summary || '(bez tytułu)'}`
}

export function replyText(e: DescribedEvent, me: Address, response: string, comment?: string | null): string {
  const who = me.name || me.email
  const lines = [`${who} ${RESPONSE_VERB[response] || response} zaproszenie: ${e.summary || '(bez tytułu)'}`, `Kiedy: ${fmtWhen(e.start, e.end, e.all_day)}`]
  if (comment) lines.push('', `Komentarz: ${comment}`)
  return lines.join('\n') + '\n'
}
