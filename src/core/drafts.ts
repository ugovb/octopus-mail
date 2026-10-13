import fs from 'node:fs'
import path from 'node:path'
import { t } from '../shared/i18n'
import type { Address, DraftAttachment, DraftInput, DraftView, Signature, Template } from '../shared/types'
import { findAccount, getAccount, listAccounts, myAddresses } from './accounts'
import { all, get, insert, now, parseJson, type Row, run, update } from './db'
import { bus } from './events'
import { record } from './history'
import { escapeHtml, markdownToHtml, normalizeSubject, parseAddressList, textToHtml } from './mime'
import { cancelOps, enqueue } from './ops'
import { getKV, getSettings, setKV } from './settings'

export function rowToDraft(r: Row): DraftView {
  return {
    id: r.id,
    account_id: r.account_id,
    from_email: r.from_email,
    from_name: r.from_name,
    to: parseJson<Address[]>(r.to_json, []),
    cc: parseJson<Address[]>(r.cc_json, []),
    bcc: parseJson<Address[]>(r.bcc_json, []),
    subject: r.subject || '',
    html: r.html || '',
    text: r.text || '',
    attachments: parseJson<DraftAttachment[]>(r.attachments_json, []),
    reply_to_message_id: r.reply_to_message_id,
    forward_of_message_id: r.forward_of_message_id,
    reply_kind: r.reply_kind,
    thread_id: r.thread_id,
    status: r.status,
    send_at: r.send_at,
    sent_at: r.sent_at,
    error: r.error,
    remind_at: r.remind_at,
    remind_kind: r.remind_kind,
    signature: !!r.signature,
    source: r.source,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

export function getDraft(id: number): DraftView {
  const r = get('SELECT * FROM drafts WHERE id = ?', id)
  if (!r) throw new Error(t('Draft {id} does not exist', { id }))
  return rowToDraft(r)
}

export function listDrafts(status: string[] = ['draft', 'failed']): DraftView[] {
  return all(
    `SELECT * FROM drafts WHERE status IN (${status.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 500`,
    ...status,
  ).map(rowToDraft)
}

// ---------- signatures ----------

export function listSignatures(): Signature[] {
  return all('SELECT id, name, html FROM signatures ORDER BY name') as Signature[]
}

export function saveSignature(s: { id?: number; name: string; html: string }): Signature {
  if (s.id) {
    update('signatures', s.id, { name: s.name, html: s.html, updated_at: now() })
    return get('SELECT id, name, html FROM signatures WHERE id = ?', s.id) as Signature
  }
  const id = insert('signatures', { name: s.name, html: s.html, created_at: now(), updated_at: now() })
  return { id, name: s.name, html: s.html }
}

export function deleteSignature(id: number): void {
  run('DELETE FROM signatures WHERE id = ?', id)
  run('UPDATE identities SET signature_id = NULL WHERE signature_id = ?', id)
}

export function setDefaultSignature(accountId: number, signatureId: number | null): void {
  run('UPDATE identities SET signature_id = ? WHERE account_id = ?', signatureId, accountId)
}

function signatureHtml(accountId: number, fromEmail: string | null): string {
  const r = get<{ html: string }>(
    `SELECT s.html FROM identities i JOIN signatures s ON s.id = i.signature_id
     WHERE i.account_id = ? ORDER BY (i.email = ? COLLATE NOCASE) DESC, i.is_default DESC LIMIT 1`,
    accountId,
    fromEmail || '',
  )
  return r?.html ? `<div class="octo-signature"><br>-- <br>${r.html}</div>` : ''
}

export function stripSignature(html: string): string {
  return html.replace(/<div class="octo-signature">[\s\S]*?<\/div>\s*$/i, '').replace(/<div class="octo-signature">[\s\S]*<\/div>/i, '')
}

// ---------- templates ----------

const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g
const AUTO_PLACEHOLDERS: Record<string, string> = {
  'recipient first name': 'to.first',
  'recipient last name': 'to.last',
  'recipient full name': 'to.full',
  'recipient name': 'to.full',
  'imię odbiorcy': 'to.first',
  'nazwisko odbiorcy': 'to.last',
  'odbiorca': 'to.full',
  'my first name': 'me.first',
  'my last name': 'me.last',
  'my full name': 'me.full',
  'my name': 'me.full',
  'moje imię': 'me.first',
  'moje nazwisko': 'me.last',
}

function rowToTemplate(r: Row): Template {
  const text = `${r.subject || ''} ${r.html || ''}`
  const names = new Set<string>()
  for (const m of text.matchAll(PLACEHOLDER)) names.add(m[1])
  return {
    id: r.id,
    name: r.name,
    subject: r.subject,
    html: r.html,
    to: parseJson<Address[]>(r.to_json, []),
    cc: parseJson<Address[]>(r.cc_json, []),
    bcc: parseJson<Address[]>(r.bcc_json, []),
    account_id: r.account_id,
    shortcut: r.shortcut,
    placeholders: [...names],
    updated_at: r.updated_at,
  }
}

export function listTemplates(): Template[] {
  return all('SELECT * FROM templates ORDER BY name COLLATE NOCASE').map(rowToTemplate)
}

export function getTemplate(ref: number | string): Template {
  const r = typeof ref === 'number' || /^\d+$/.test(String(ref))
    ? get('SELECT * FROM templates WHERE id = ?', Number(ref))
    : get('SELECT * FROM templates WHERE name = ? COLLATE NOCASE', ref)
  if (!r) throw new Error(t('Template “{name}” does not exist', { name: String(ref) }))
  return rowToTemplate(r)
}

export function saveTemplate(t: Partial<Template> & { name: string }): Template {
  const fields = {
    name: t.name,
    subject: t.subject ?? null,
    html: t.html ?? '',
    to_json: JSON.stringify(t.to || []),
    cc_json: JSON.stringify(t.cc || []),
    bcc_json: JSON.stringify(t.bcc || []),
    account_id: t.account_id ?? null,
    shortcut: t.shortcut ?? null,
    updated_at: now(),
  }
  if (t.id) {
    update('templates', t.id, fields)
    return getTemplate(t.id)
  }
  return getTemplate(insert('templates', { ...fields, created_at: now() }))
}

export function deleteTemplate(id: number): void {
  run('DELETE FROM templates WHERE id = ?', id)
}

export function placeholderKind(name: string): 'auto' | 'manual' {
  return AUTO_PLACEHOLDERS[name.toLowerCase()] ? 'auto' : 'manual'
}

function splitName(full: string | undefined) {
  const parts = (full || '').trim().split(/\s+/).filter(Boolean)
  return { first: parts[0] || '', last: parts.slice(1).join(' '), full: parts.join(' ') }
}

export function fillTemplate(text: string, ctx: { to?: Address[]; meName?: string; values?: Record<string, string> }, html: boolean): { out: string; missing: string[] } {
  const missing: string[] = []
  const recipient = ctx.to?.length === 1 ? splitName(ctx.to[0].name) : null
  const me = splitName(ctx.meName)
  const out = text.replace(PLACEHOLDER, (m, rawName: string) => {
    const name = rawName.trim()
    const given = ctx.values && Object.entries(ctx.values).find(([k]) => k.toLowerCase() === name.toLowerCase())
    if (given) return html ? escapeHtml(given[1]) : given[1]
    const auto = AUTO_PLACEHOLDERS[name.toLowerCase()]
    if (auto) {
      const [who, part] = auto.split('.') as ['to' | 'me', 'first' | 'last' | 'full']
      const src = who === 'me' ? me : recipient
      const v = src?.[part]
      if (v) return html ? escapeHtml(v) : v
    }
    missing.push(name)
    return m
  })
  return { out, missing }
}

// ---------- drafts ----------

function normalizeAddresses(x: DraftInput['to']): Address[] {
  return parseAddressList((x || []) as (string | Address)[])
}

function pickAccountForReply(m: Row): number {
  return m.account_id
}

/** Reply/Reply-all recipients, excluding the user's own addresses. */
function replyRecipients(m: Row, all_: boolean): { to: Address[]; cc: Address[] } {
  const me = myAddresses()
  const from: Address = { name: m.from_name || undefined, email: m.from_email }
  const replyTo = parseJson<Address[]>(m.reply_to_json, [])
  const origTo = parseJson<Address[]>(m.to_json, [])
  const origCc = parseJson<Address[]>(m.cc_json, [])
  let to: Address[]
  if (m.is_outgoing) to = origTo
  else to = replyTo.length ? replyTo : [from]
  let cc: Address[] = []
  if (all_) {
    const seen = new Set(to.map((a) => a.email))
    const extra = [...(m.is_outgoing ? [] : origTo), ...origCc].filter((a) => !me.has(a.email) && !seen.has(a.email))
    cc = extra.filter((a, i, arr) => arr.findIndex((b) => b.email === a.email) === i)
  }
  to = to.filter((a) => !me.has(a.email) || m.is_outgoing)
  return { to, cc }
}

function replySubject(subject: string, kind: 'reply' | 'forward'): string {
  const base = (subject || '').replace(/^\s*((re|fwd?|fw|odp|pd)\s*:\s*)+/i, '')
  return kind === 'forward' ? `Fwd: ${base}` : `Re: ${base}`
}

export function saveDraft(input: DraftInput): DraftView {
  const ts = now()
  let existing: Row | undefined
  if (input.id) {
    existing = get('SELECT * FROM drafts WHERE id = ?', input.id)
    if (!existing) throw new Error(t('Draft {id} does not exist', { id: input.id }))
    if (existing.status === 'sent') throw new Error(t('This message has already been sent'))
  }

  let accountId = input.account_id ?? existing?.account_id
  if (input.from_email && !accountId) accountId = findAccount(input.from_email)?.id
  let fields: Record<string, unknown> = {}
  let threadId = existing?.thread_id ?? null
  let inReplyTo = existing?.in_reply_to ?? null
  let refs = existing?.refs ?? null

  if (!existing && (input.reply_to_message_id || input.forward_of_message_id)) {
    const refMsgId = (input.reply_to_message_id || input.forward_of_message_id)!
    const m = get('SELECT * FROM messages WHERE id = ?', refMsgId)
    if (!m) throw new Error(t('Message {id} does not exist', { id: refMsgId }))
    accountId = accountId ?? pickAccountForReply(m)
    threadId = m.thread_id
    if (input.reply_to_message_id) {
      const r = replyRecipients(m, !!input.reply_all)
      fields = {
        to_json: JSON.stringify(input.to ? normalizeAddresses(input.to) : r.to),
        cc_json: JSON.stringify(input.cc ? normalizeAddresses(input.cc) : r.cc),
        subject: input.subject ?? replySubject(m.subject, 'reply'),
        reply_to_message_id: m.id,
        reply_kind: input.reply_all ? 'replyall' : 'reply',
      }
      inReplyTo = m.msgid
      refs = [...(m.refs ? m.refs.split(/\s+/) : []), m.msgid].filter(Boolean).slice(-20).join(' ')
      // reply from the address the mail was sent to, when it is one of ours
      if (!input.from_email) {
        const me = myAddresses()
        const hit = [...parseJson<Address[]>(m.to_json, []), ...parseJson<Address[]>(m.cc_json, [])].find((a) => me.has(a.email))
        if (hit) fields.from_email = hit.email
      }
    } else {
      fields = {
        subject: input.subject ?? replySubject(m.subject, 'forward'),
        forward_of_message_id: m.id,
        reply_kind: 'forward',
      }
    }
  }

  if (!accountId) {
    accountId = getSettings().defaultAccountId ?? getKV<number | null>('lastSendAccount', null) ?? listAccounts(false)[0]?.id
  }
  if (!accountId) throw new Error(t('Add an email account first'))
  const acc = getAccount(accountId)

  // body
  let html: string | undefined = input.html
  if (html === undefined && input.markdown !== undefined) html = markdownToHtml(input.markdown)
  if (html === undefined && input.text !== undefined) html = textToHtml(input.text)

  if (input.template_id) {
    const tpl = getTemplate(input.template_id)
    const to = input.to ? normalizeAddresses(input.to) : parseJson<Address[]>((fields.to_json as string) || existing?.to_json, tpl.to)
    const ctx = { to, meName: acc.name, values: input.placeholders }
    const body = fillTemplate(tpl.html || '', ctx, true)
    const subj = fillTemplate(tpl.subject || '', ctx, false)
    const missing = [...new Set([...body.missing, ...subj.missing])].filter((n) => placeholderKind(n) === 'manual')
    if (missing.length) throw new Error(t('Fill in the template fields: {fields}', { fields: missing.join(', ') }))
    html = html !== undefined ? `${html}${body.out}` : body.out
    if (!input.subject && !existing?.subject && !fields.subject) fields.subject = subj.out
    if (!input.to && !existing && tpl.to.length) fields.to_json = JSON.stringify(tpl.to)
    if (!input.cc && !existing && tpl.cc.length) fields.cc_json = JSON.stringify(tpl.cc)
    if (!input.bcc && !existing && tpl.bcc.length) fields.bcc_json = JSON.stringify(tpl.bcc)
  }

  const fromEmail = input.from_email ?? (fields.from_email as string | undefined) ?? existing?.from_email ?? acc.email
  const wantSignature = input.signature ?? (existing ? !!existing.signature : true)
  if (html !== undefined) {
    html = stripSignature(html)
    if (wantSignature) html += signatureHtml(acc.id, fromEmail)
  } else if (existing && input.signature === false) {
    html = stripSignature(existing.html || '')
  } else if (!existing) {
    html = wantSignature ? `<p></p>${signatureHtml(acc.id, fromEmail)}` : ''
  }

  const row: Record<string, unknown> = {
    account_id: acc.id,
    from_email: fromEmail,
    ...fields,
    ...(input.to !== undefined ? { to_json: JSON.stringify(normalizeAddresses(input.to)) } : {}),
    ...(input.cc !== undefined ? { cc_json: JSON.stringify(normalizeAddresses(input.cc)) } : {}),
    ...(input.bcc !== undefined ? { bcc_json: JSON.stringify(normalizeAddresses(input.bcc)) } : {}),
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(html !== undefined ? { html } : {}),
    ...(input.attachments !== undefined ? { attachments_json: JSON.stringify(input.attachments) } : {}),
    signature: wantSignature ? 1 : 0,
    thread_id: threadId,
    in_reply_to: inReplyTo,
    refs,
    updated_at: ts,
  }
  let id: number
  if (existing) {
    id = existing.id
    if (existing.status === 'failed' || existing.status === 'cancelled') row.status = 'draft'
    update('drafts', id, row)
  } else {
    id = insert('drafts', { ...row, status: 'draft', source: input.source || 'ui', created_at: ts })
  }
  setKV('lastSendAccount', acc.id)
  bus.emitEvent({ type: 'drafts-changed' })
  if (threadId) bus.emitEvent({ type: 'thread-changed', threadIds: [threadId] })
  return getDraft(id)
}

/** Debounced mirror of the draft into the server Drafts folder. */
const remoteTimers = new Map<number, NodeJS.Timeout>()
export function scheduleRemoteDraftSave(id: number): void {
  if (!getKV<boolean>('syncDraftsToServer', true)) return
  const prev = remoteTimers.get(id)
  if (prev) clearTimeout(prev)
  remoteTimers.set(
    id,
    setTimeout(() => {
      remoteTimers.delete(id)
      const d = get('SELECT account_id, status FROM drafts WHERE id = ?', id)
      if (d?.status === 'draft') enqueue('save-draft-remote', d.account_id, { draftId: id })
    }, 15_000),
  )
}

export function deleteDraft(id: number): void {
  const d = get('SELECT * FROM drafts WHERE id = ?', id)
  if (!d) return
  if (d.imap_uid && d.imap_folder_id) enqueue('delete-draft-remote', d.account_id, { toFolderId: d.imap_folder_id, uids: [d.imap_uid] })
  for (const a of parseJson<DraftAttachment[]>(d.attachments_json, [])) {
    if (a.path.includes(`${path.sep}tmp${path.sep}`)) fs.rm(a.path, { force: true }, () => undefined)
  }
  run('DELETE FROM drafts WHERE id = ?', id)
  bus.emitEvent({ type: 'drafts-changed' })
  if (d.thread_id) bus.emitEvent({ type: 'thread-changed', threadIds: [d.thread_id] })
}

export interface SendOptions {
  sendAt?: number
  remindAt?: number
  actor?: string
  /** skip the undo-send delay (CLI/MCP: the agent already got approval) */
  immediate?: boolean
}

export function validateDraft(d: DraftView): string[] {
  const problems: string[] = []
  if (!d.to.length && !d.cc.length && !d.bcc.length) problems.push(t('No recipients'))
  for (const a of [...d.to, ...d.cc, ...d.bcc]) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email)) problems.push(t('Invalid address: {email}', { email: a.email }))
  }
  return problems
}

/** Queue a draft for sending: after the undo window, or at a scheduled time (Send Later). */
export function sendDraft(id: number, opts: SendOptions = {}): DraftView {
  const d = getDraft(id)
  if (d.status === 'sent') throw new Error(t('This message has already been sent'))
  if (d.status === 'sending') throw new Error(t('The message is being sent right now'))
  const problems = validateDraft(d)
  if (problems.length) throw new Error(problems.join('; '))
  const undoMs = opts.immediate ? 0 : getSettings().undoSendSeconds * 1000
  const sendAt = opts.sendAt && opts.sendAt > now() ? opts.sendAt : now() + undoMs
  run(
    "UPDATE drafts SET status = 'scheduled', send_at = ?, remind_at = ?, error = NULL, updated_at = ? WHERE id = ?",
    sendAt,
    opts.remindAt ?? d.remind_at,
    now(),
    id,
  )
  const timer = remoteTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    remoteTimers.delete(id)
  }
  record(opts.actor || 'ui', opts.sendAt ? 'schedule-send' : 'send-queued', id, { send_at: sendAt, subject: d.subject })
  const opId = enqueue('send', d.account_id, { draftId: id }, { delayMs: Math.max(0, sendAt - now()), actor: opts.actor })
  run('UPDATE drafts SET error = NULL WHERE id = ?', id)
  setKV(`sendOp:${id}`, opId)
  bus.emitEvent({ type: 'drafts-changed' })
  if (d.thread_id) bus.emitEvent({ type: 'thread-changed', threadIds: [d.thread_id] })
  return getDraft(id)
}

/** Undo Send / cancel a scheduled (Send Later) message: it goes back to being a draft. */
export function cancelSend(id: number, actor = 'ui'): DraftView {
  const d = getDraft(id)
  if (d.status !== 'scheduled') throw new Error(d.status === 'sent' ? t('Too late — the message has already been sent') : t('This message is not scheduled'))
  const opId = getKV<number | null>(`sendOp:${id}`, null)
  if (opId) cancelOps([opId])
  const r = run("UPDATE drafts SET status = 'draft', send_at = NULL, updated_at = ? WHERE id = ? AND status = 'scheduled'", now(), id)
  if (!r.changes) throw new Error(t('Too late — sending has already started'))
  record(actor, 'unschedule', id, { subject: d.subject })
  bus.emitEvent({ type: 'drafts-changed' })
  return getDraft(id)
}

export function threadDrafts(threadId: number): DraftView[] {
  return all("SELECT * FROM drafts WHERE thread_id = ? AND status IN ('draft','scheduled','failed','sending') ORDER BY created_at", threadId).map(rowToDraft)
}

export function scheduledDrafts(): DraftView[] {
  return all("SELECT * FROM drafts WHERE status IN ('scheduled','sending','failed') ORDER BY send_at").map(rowToDraft)
}

/** Convert a server-side draft (e.g. written in Gmail web) into a local editable draft. */
export function adoptServerDraft(messageId: number): DraftView {
  const m = get('SELECT * FROM messages WHERE id = ?', messageId)
  if (!m) throw new Error(t('Message does not exist'))
  const body = get<{ html: string | null; text: string | null }>('SELECT html, text FROM bodies WHERE message_id = ?', messageId)
  const id = insert('drafts', {
    account_id: m.account_id,
    from_email: m.from_email,
    to_json: m.to_json,
    cc_json: m.cc_json,
    bcc_json: m.bcc_json,
    subject: m.subject,
    html: body?.html || (body?.text ? textToHtml(body.text) : ''),
    thread_id: m.thread_id,
    in_reply_to: m.in_reply_to,
    refs: m.refs,
    imap_uid: m.uid,
    imap_folder_id: m.folder_id,
    signature: 0,
    status: 'draft',
    source: 'server',
    created_at: now(),
    updated_at: now(),
  })
  run('UPDATE messages SET hidden = 1 WHERE id = ?', messageId)
  return getDraft(id)
}

export function normalizeSubjectForSearch(s: string): string {
  return normalizeSubject(s)
}
