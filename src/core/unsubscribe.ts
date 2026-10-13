import nodemailer from 'nodemailer'
import { getAccount, smtpTransportOptions } from './accounts'
import { get } from './db'
import { bus } from './events'
import { parseListUnsubscribe } from './mime'
import type { OpPayload } from './ops'

/** RFC 8058 one-click (HTTPS POST) first, then mailto:, otherwise hand the URL to the UI. */
export async function performUnsubscribe(accountId: number, p: OpPayload): Promise<void> {
  const m = get('SELECT * FROM messages WHERE id = ?', p.messageIds?.[0])
  if (!m) throw new Error('Wiadomość nie istnieje')
  const { http, mailto } = parseListUnsubscribe(m.list_unsubscribe)
  if (http && /one-click/i.test(m.list_unsubscribe_post || '')) {
    const r = await fetch(http, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
      signal: AbortSignal.timeout(20_000),
      redirect: 'follow',
    })
    if (!r.ok && r.status >= 400) throw new Error(`Serwer listy odpowiedział HTTP ${r.status}`)
    bus.emitEvent({ type: 'toast', level: 'success', message: `Wypisano z: ${m.from_name || m.from_email}` })
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
    bus.emitEvent({ type: 'toast', level: 'success', message: `Wysłano prośbę o wypisanie do ${decodeURIComponent(u.pathname)}` })
    return
  }
  if (http) {
    bus.emitEvent({
      type: 'toast',
      level: 'info',
      message: 'Ta lista wymaga wypisania na stronie nadawcy.',
      action: { label: 'Otwórz stronę', command: 'openExternal', args: http },
    })
    return
  }
  throw new Error('Brak adresu wypisania')
}
