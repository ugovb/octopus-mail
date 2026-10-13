import crypto from 'node:crypto'
import fs from 'node:fs'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import type { Address, DraftAttachment } from '../shared/types'
import { getAccount, smtpTransportOptions } from './accounts'
import { get, inList, all, now, parseJson, run } from './db'
import { bus, log } from './events'
import { record } from './history'
import { escapeHtml, formatAddress, htmlToText } from './mime'
import { enqueue } from './ops'
import { getKV } from './settings'
import { noteOutgoing } from './smart'
import { sync } from './sync'

export function newMessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1] || 'octopus.local'
  return `<octo.${Date.now().toString(36)}.${crypto.randomBytes(6).toString('hex')}@${domain}>`
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('pl-PL', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Warsaw' })
}

/** Quote block appended to replies/forwards when the draft is turned into MIME. */
export function buildHistory(draft: Record<string, any>): { html: string; attachments: DraftAttachment[] } {
  const refId = draft.reply_to_message_id || draft.forward_of_message_id
  if (!refId) return { html: '', attachments: [] }
  const m = get('SELECT * FROM messages WHERE id = ?', refId)
  if (!m) return { html: '', attachments: [] }
  const body = get<{ html: string | null; text: string | null }>('SELECT html, text FROM bodies WHERE message_id = ?', refId)
  const original = body?.html || (body?.text ? `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(body.text)}</pre>` : escapeHtml(m.snippet || ''))
  const from = m.from_name ? `${m.from_name} &lt;${m.from_email}&gt;` : m.from_email
  if (draft.reply_kind === 'forward') {
    const to = parseJson<Address[]>(m.to_json, []).map((a) => escapeHtml(formatAddress(a))).join(', ')
    const cc = parseJson<Address[]>(m.cc_json, []).map((a) => escapeHtml(formatAddress(a))).join(', ')
    const header = [
      '---------- Przekazana wiadomość ----------',
      `<b>Od:</b> ${from}`,
      `<b>Data:</b> ${fmtDate(m.date)}`,
      `<b>Temat:</b> ${escapeHtml(m.subject || '')}`,
      `<b>Do:</b> ${to}`,
      cc ? `<b>DW:</b> ${cc}` : '',
    ].filter(Boolean).join('<br>')
    const atts = all('SELECT * FROM attachments WHERE message_id = ? AND inline = 0', refId)
    return {
      html: `<div class="octo-quote"><br><p>${header}</p><br>${original}</div>`,
      attachments: atts.map((a) => ({ filename: a.filename, path: `octo-att:${a.id}`, mime: a.mime, size: a.size })),
    }
  }
  return {
    html: `<div class="octo-quote"><br><p>W dniu ${fmtDate(m.date)} ${from} napisał(a):</p><blockquote type="cite" style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">${original}</blockquote></div>`,
    attachments: [],
  }
}

async function resolveAttachments(atts: DraftAttachment[], accountId: number) {
  const out: { filename: string; path?: string; content?: Buffer; contentType?: string; cid?: string }[] = []
  for (const a of atts) {
    if (a.path.startsWith('octo-att:')) {
      const attId = Number(a.path.slice('octo-att:'.length))
      const att = get('SELECT * FROM attachments WHERE id = ?', attId)
      if (!att) continue
      const m = get<{ account_id: number }>('SELECT account_id FROM messages WHERE id = ?', att.message_id)!
      const file = await sync.get(m.account_id || accountId).downloadAttachment(attId)
      out.push({ filename: a.filename, path: file, contentType: a.mime, cid: a.content_id })
    } else {
      if (!fs.existsSync(a.path)) throw new Error(`Załącznik nie istnieje: ${a.path}`)
      out.push({ filename: a.filename, path: a.path, contentType: a.mime, cid: a.content_id })
    }
  }
  return out
}

export interface BuiltMessage {
  raw: Buffer
  envelope: { from: string; to: string[] }
  messageId: string
}

export async function buildMime(
  draftId: number,
  opts: { asDraft?: boolean; keepBcc?: boolean; messageId?: string } = {},
): Promise<BuiltMessage> {
  const d = get('SELECT * FROM drafts WHERE id = ?', draftId)
  if (!d) throw new Error(`Wersja robocza ${draftId} nie istnieje`)
  const acc = getAccount(d.account_id)
  const to = parseJson<Address[]>(d.to_json, [])
  const cc = parseJson<Address[]>(d.cc_json, [])
  const bcc = parseJson<Address[]>(d.bcc_json, [])
  const fromEmail = d.from_email || acc.email
  const identity = get<{ name: string; reply_to: string | null }>(
    'SELECT name, reply_to FROM identities WHERE account_id = ? AND email = ? COLLATE NOCASE',
    acc.id,
    fromEmail,
  )
  const fromName = d.from_name || identity?.name || acc.name
  const history = d.html?.includes('octo-quote') ? { html: '', attachments: [] } : buildHistory(d)
  const html = `<div dir="auto">${d.html || ''}</div>${history.html}`
  const attachments = await resolveAttachments([...parseJson<DraftAttachment[]>(d.attachments_json, []), ...history.attachments], acc.id)
  const messageId = opts.messageId || d.msgid || newMessageId(fromEmail)
  const autoBcc = getKV<string>(`autoBcc:${acc.id}`, '')

  const headers: Record<string, string> = { 'X-Mailer': 'Octopus Mail' }
  if (opts.asDraft) headers['X-Octopus-Draft'] = String(draftId)
  const composer = new MailComposer({
    from: { name: fromName, address: fromEmail },
    to: to.map((a) => ({ name: a.name || '', address: a.email })),
    cc: cc.map((a) => ({ name: a.name || '', address: a.email })),
    bcc: [...bcc.map((a) => ({ name: a.name || '', address: a.email })), ...(autoBcc ? [autoBcc] : [])],
    replyTo: identity?.reply_to || undefined,
    subject: d.subject || '',
    html,
    text: htmlToText(html),
    attachments,
    messageId,
    inReplyTo: d.in_reply_to || undefined,
    references: d.refs || undefined,
    headers,
    date: new Date(),
  })
  const node = composer.compile()
  // Bcc must never travel in the transmitted copy; only the Sent-folder copy keeps it
  if (opts.keepBcc) (node as unknown as { keepBcc: boolean }).keepBcc = true
  const raw = await new Promise<Buffer>((resolve, reject) => node.build((err, msg) => (err ? reject(err) : resolve(msg))))
  const recipients = [...to, ...cc, ...bcc].map((a) => a.email)
  if (autoBcc) recipients.push(autoBcc)
  return { raw, envelope: { from: fromEmail, to: recipients }, messageId }
}

/** Actually transmit a draft over SMTP (called by the scheduler when send_at is reached). */
export async function sendDraftNow(draftId: number): Promise<void> {
  const claimed = get(
    "UPDATE drafts SET status = 'sending', updated_at = ? WHERE id = ? AND status IN ('scheduled','sending') RETURNING *",
    now(),
    draftId,
  )
  if (!claimed) return
  const acc = getAccount(claimed.account_id)
  try {
    const built = await buildMime(draftId)
    if (!built.envelope.to.length) throw new Error('Brak odbiorców')
    const transport = nodemailer.createTransport((await smtpTransportOptions(acc)) as nodemailer.TransportOptions)
    await transport.sendMail({ envelope: built.envelope, raw: built.raw })
    run("UPDATE drafts SET status = 'sent', sent_at = ?, msgid = ?, error = NULL, updated_at = ? WHERE id = ?", now(), built.messageId, now(), draftId)
    record(claimed.source || 'ui', 'send', draftId, { to: built.envelope.to, subject: claimed.subject })
    // people we write to are known contacts from now on (GateKeeper, autocomplete, Smart Inbox)
    noteOutgoing([...parseJson<Address[]>(claimed.to_json, []), ...parseJson<Address[]>(claimed.cc_json, []), ...parseJson<Address[]>(claimed.bcc_json, [])], now())

    // Gmail stores sent mail itself; everyone else needs an APPEND to the Sent folder.
    const sent = get('SELECT * FROM folders WHERE account_id = ? AND role = ? LIMIT 1', acc.id, 'sent')
    if (!acc.is_gmail && sent) {
      try {
        const copy = await buildMime(draftId, { keepBcc: true, messageId: built.messageId })
        await sync.get(acc.id).append(sent.path, copy.raw, ['\\Seen'])
      } catch (e) {
        log('send', 'append to Sent failed', (e as Error).message)
      }
    }
    if (claimed.imap_uid && claimed.imap_folder_id) {
      enqueue('delete-draft-remote', acc.id, { toFolderId: claimed.imap_folder_id, uids: [claimed.imap_uid] })
    }
    // answered flag on the message we replied to
    if (claimed.reply_to_message_id && claimed.reply_kind !== 'forward') {
      run('UPDATE messages SET answered = 1 WHERE id = ?', claimed.reply_to_message_id)
      enqueue('flags', acc.id, { messageIds: [claimed.reply_to_message_id], add: ['\\Answered'] })
    }
    if (claimed.thread_id) {
      // a reply means the conversation is handled: drop resurfacing, arm the follow-up reminder
      run('UPDATE threads SET resurfaced_at = NULL WHERE id = ?', claimed.thread_id)
      if (claimed.remind_at) {
        run("UPDATE threads SET reminder_at = ?, reminder_kind = 'no-reply', reminder_ref = ? WHERE id = ?", claimed.remind_at, now(), claimed.thread_id)
      }
    }
    setTimeout(() => {
      if (sent) void sync.get(acc.id).syncFolder(sent.id).catch(() => undefined)
    }, 2500)
    bus.emitEvent({ type: 'drafts-changed' })
    bus.emitEvent({ type: 'toast', level: 'success', message: `Wysłano: ${claimed.subject || '(bez tematu)'}` })
  } catch (e) {
    const msg = (e as Error).message
    run("UPDATE drafts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", msg, now(), draftId)
    record(claimed.source || 'ui', 'send', draftId, msg, false)
    bus.emitEvent({ type: 'drafts-changed' })
    bus.emitEvent({ type: 'toast', level: 'error', message: `Nie wysłano „${claimed.subject || ''}”: ${msg}` })
    throw e
  }
}

/** Mirror a local draft into the server's Drafts folder (so webmail/phone see it too). */
export async function saveDraftRemote(draftId: number): Promise<void> {
  const d = get('SELECT * FROM drafts WHERE id = ?', draftId)
  if (!d || d.status !== 'draft') return
  const folder = get('SELECT * FROM folders WHERE account_id = ? AND role = ? LIMIT 1', d.account_id, 'drafts')
  if (!folder) return
  const built = await buildMime(draftId, { asDraft: true })
  const s = sync.get(d.account_id)
  const uid = await s.append(folder.path, built.raw, ['\\Draft', '\\Seen'])
  const oldUid = d.imap_uid
  run('UPDATE drafts SET imap_uid = ?, imap_folder_id = ?, msgid = ? WHERE id = ?', uid, folder.id, built.messageId, draftId)
  if (oldUid) {
    try {
      await s.expunge(folder.path, [oldUid])
    } catch (e) {
      log('send', 'old remote draft cleanup failed', (e as Error).message)
    }
  }
}

export function draftsDue(): number[] {
  return all<{ id: number }>("SELECT id FROM drafts WHERE status = 'scheduled' AND send_at <= ? ORDER BY send_at", now()).map((r) => r.id)
}

export function recoverStuckSends(): void {
  // a crash during 'sending' leaves the draft stuck; the SMTP server may or may not have it
  const stuck = all<{ id: number }>("SELECT id FROM drafts WHERE status = 'sending' AND updated_at < ?", now() - 10 * 60_000)
  if (stuck.length) {
    run(
      `UPDATE drafts SET status = 'failed', error = 'Przerwano w trakcie wysyłania — sprawdź folder Wysłane przed ponowną wysyłką' WHERE id IN (${inList(stuck.map((s) => s.id))})`,
      ...stuck.map((s) => s.id),
    )
  }
}
