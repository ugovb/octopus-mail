import nodemailer from 'nodemailer'
import { t } from '../shared/i18n'
import { getAccount, smtpTransportOptions } from './accounts'
import { get } from './db'
import { bus } from './events'
import { parseListUnsubscribe } from './mime'
import type { OpPayload } from './ops'

/** RFC 8058 one-click (HTTPS POST) first, then mailto:, otherwise hand the URL to the UI. */
export async function performUnsubscribe(accountId: number, p: OpPayload): Promise<void> {
  const m = get('SELECT * FROM messages WHERE id = ?', p.messageIds?.[0])
  if (!m) throw new Error(t('Message does not exist'))
  const { http, mailto } = parseListUnsubscribe(m.list_unsubscribe)
  if (http && /one-click/i.test(m.list_unsubscribe_post || '')) {
    const r = await fetch(http, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    })
    if (!r.ok && r.status >= 400) throw new Error(t('The mailing list server responded with HTTP {status}', { status: r.status }))
    bus.emitEvent({ type: 'toast', level: 'success', message: t('Unsubscribed from {sender}', { sender: m.from_name || m.from_email }) })
    return
  }
  if (mailto) {
    const u = new URL(mailto)
    const acc = getAccount(accountId)
    const transport = nodemailer.createTransport((await smtpTransportOptions(acc)) as nodemailer.TransportOptions)
    await transport.sendMail({
      from: acc.email,
      to: decodeURIComponent(u.pathname),
      subject: u.searchParams.get('subject') || 'unsubscribe',
      text: u.searchParams.get('body') || 'unsubscribe',
    })
    bus.emitEvent({ type: 'toast', level: 'success', message: t('Unsubscribe request sent to {address}', { address: decodeURIComponent(u.pathname) }) })
    return
  }
  if (http) {
    bus.emitEvent({
      type: 'toast',
      level: 'info',
      message: t('This list requires unsubscribing on the sender’s website.'),
      action: { label: t('Open page'), command: 'openExternal', args: http },
    })
    return
  }
  throw new Error(t('No unsubscribe address'))
}
