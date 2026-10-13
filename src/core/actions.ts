// Every user-facing e-mail action. Each one updates local state immediately, queues the IMAP work
// with a short delay and returns an undo token; Undo cancels the queued work and restores state.
import crypto from 'node:crypto'
import type { Category, FolderRole } from '../shared/types'
import { getAccount } from './accounts'
import { all, get, inList, now, type Row, run, tx } from './db'
import { bus } from './events'
import { type Actor, record } from './history'
import { cancelOps, enqueue, type OpPayload } from './ops'
import { threadMessageIds } from './queries'
import { getSettings } from './settings'
import { refreshThreadCategories, setContactStatus, setSenderCategory, setVip } from './smart'

export interface ActionResult {
  ok: true
  affected: number
  undo?: string
  message?: string
}

interface UndoEntry {
  opIds: number[]
  threads: Row[]
  messages: { id: number; seen: number; flagged: number; hidden: number }[]
  contacts?: { email: string; status: string; category: string | null; vip: number }[]
  expires: number
  label: string
}

const undoMap = new Map<string, UndoEntry>()
const UNDO_DELAY_UI = 5_000

function snapshot(threadIds: number[], label: string): UndoEntry {
  const threads = threadIds.length ? all(`SELECT * FROM threads WHERE id IN (${inList(threadIds)})`, ...threadIds) : []
  const messages = threadIds.length
    ? all<{ id: number; seen: number; flagged: number; hidden: number }>(
        `SELECT id, seen, flagged, hidden FROM messages WHERE thread_id IN (${inList(threadIds)})`,
        ...threadIds,
      )
    : []
  return { opIds: [], threads, messages, expires: now() + 120_000, label }
}

function finish(entry: UndoEntry, affected: number, message?: string): ActionResult {
  const token = crypto.randomBytes(8).toString('hex')
  undoMap.set(token, entry)
  for (const [k, v] of undoMap) if (v.expires < now()) undoMap.delete(k)
  bus.emitEvent({ type: 'mailbox-changed' })
  bus.emitEvent({ type: 'thread-changed', threadIds: entry.threads.map((t) => t.id) })
  return { ok: true, affected, undo: token, message: message || entry.label }
}

export function undo(token: string): boolean {
  const e = undoMap.get(token)
  if (!e) return false
  undoMap.delete(token)
  const cancelled = cancelOps(e.opIds)
  tx(() => {
    for (const t of e.threads) {
      run(
        `UPDATE threads SET pinned = ?, muted = ?, snoozed_until = ?, set_aside = ?, done_at = ?, reminder_at = ?,
           reminder_kind = ?, resurfaced_at = ?, priority = ?, category = ? WHERE id = ?`,
        t.pinned, t.muted, t.snoozed_until, t.set_aside, t.done_at, t.reminder_at, t.reminder_kind, t.resurfaced_at, t.priority, t.category, t.id,
      )
    }
    for (const m of e.messages) run('UPDATE messages SET seen = ?, flagged = ?, hidden = ? WHERE id = ?', m.seen, m.flagged, m.hidden, m.id)
    for (const c of e.contacts || []) {
      run('UPDATE contacts SET status = ?, category = ?, vip = ? WHERE email = ?', c.status, c.category, c.vip, c.email)
    }
  })
  // ops that already ran cannot be cancelled: queue the reverse flag changes
  if (cancelled < e.opIds.length) {
    const byAcc = new Map<number, { seen: number[]; unseen: number[]; flag: number[]; unflag: number[] }>()
    for (const m of e.messages) {
      const cur = get<{ account_id: number; seen: number; flagged: number }>('SELECT account_id, seen, flagged FROM messages WHERE id = ?', m.id)
      if (!cur) continue
      const b = byAcc.get(cur.account_id) || { seen: [], unseen: [], flag: [], unflag: [] }
      if (m.seen) b.seen.push(m.id)
      else b.unseen.push(m.id)
      if (m.flagged) b.flag.push(m.id)
      else b.unflag.push(m.id)
      byAcc.set(cur.account_id, b)
    }
    for (const [acc, b] of byAcc) {
      if (b.seen.length) enqueue('flags', acc, { messageIds: b.seen, add: ['\\Seen'] })
      if (b.unseen.length) enqueue('flags', acc, { messageIds: b.unseen, remove: ['\\Seen'] })
    }
  }
  bus.emitEvent({ type: 'mailbox-changed' })
  bus.emitEvent({ type: 'thread-changed', threadIds: e.threads.map((t) => t.id) })
  if (e.contacts?.length) bus.emitEvent({ type: 'contacts-changed' })
  return true
}

function delayFor(actor: Actor): number {
  return actor === 'ui' ? UNDO_DELAY_UI : 0
}

function groupByAccount(rows: Row[]): Map<number, Row[]> {
  const map = new Map<number, Row[]>()
  for (const r of rows) {
    const arr = map.get(r.account_id) || []
    arr.push(r)
    map.set(r.account_id, arr)
  }
  return map
}

function moveMessages(rows: Row[], target: { toRole?: FolderRole; toFolderId?: number }, actor: Actor, entry: UndoEntry, copy = false): void {
  for (const [accountId, list] of groupByAccount(rows)) {
    const ids = list.map((r) => r.id)
    if (!copy) run(`UPDATE messages SET hidden = 1 WHERE id IN (${inList(ids)})`, ...ids)
    const payload: OpPayload = { messageIds: ids, ...target, revert: { messageIds: ids } }
    entry.opIds.push(enqueue(copy ? 'copy' : 'move', accountId, payload, { delayMs: delayFor(actor), actor }))
  }
}

function setFlag(rows: Row[], flag: '\\Seen' | '\\Flagged', on: boolean, actor: Actor, entry: UndoEntry): void {
  const col = flag === '\\Seen' ? 'seen' : 'flagged'
  const targets = rows.filter((r) => !!r[col] !== on)
  for (const [accountId, list] of groupByAccount(targets)) {
    const ids = list.map((r) => r.id)
    run(`UPDATE messages SET ${col} = ? WHERE id IN (${inList(ids)})`, on ? 1 : 0, ...ids)
    const revert = { flags: list.map((r) => ({ id: r.id, seen: r.seen, flagged: r.flagged })) }
    entry.opIds.push(
      enqueue('flags', accountId, { messageIds: ids, ...(on ? { add: [flag] } : { remove: [flag] }), revert }, { delayMs: delayFor(actor), actor }),
    )
  }
}

// ---------- mailbox actions ----------

/** Done / Archive: remove from Inbox (Gmail: drop the Inbox label). */
export function archive(threadIds: number[], actor: Actor = 'ui'): ActionResult {
  const entry = snapshot(threadIds, threadIds.length > 1 ? `Zrobione: ${threadIds.length}` : 'Zrobione')
  const rows = threadMessageIds(threadIds, ['inbox'])
  moveMessages(rows, { toRole: 'archive' }, actor, entry)
  run(`UPDATE threads SET resurfaced_at = NULL, snoozed_until = NULL, done_at = ?, set_aside = 0 WHERE id IN (${inList(threadIds)})`, now(), ...threadIds)
  if (getSettings().markReadOnOpen) setFlag(threadMessageIds(threadIds), '\\Seen', true, actor, entry)
  record(actor, 'archive', threadIds.join(','))
  return finish(entry, threadIds.length)
}

export function moveToInbox(threadIds: number[], actor: Actor = 'ui'): ActionResult {
  const entry = snapshot(threadIds, 'Przeniesiono do Odebranych')
  const rows = threadMessageIds(threadIds, undefined, ['inbox', 'sent', 'drafts'])
  const latestPerThread = new Map<number, Row>()
  for (const r of rows) if (!r.is_outgoing) latestPerThread.set(r.thread_id, r)
  for (const [, list] of groupByAccount([...latestPerThread.values()])) {
    const acc = getAccount(list[0].account_id)
    const fromAll = list.filter((r) => r.role === 'all')
    const others = list.filter((r) => r.role !== 'all')
    // Gmail: copying out of All Mail just re-adds the Inbox label
    if (acc.is_gmail && fromAll.length) moveMessages(fromAll, { toRole: 'inbox' }, actor, entry, true)
    if (others.length) moveMessages(others, { toRole: 'inbox' }, actor, entry)
  }
  run(`UPDATE threads SET done_at = NULL, resurfaced_at = ? WHERE id IN (${inList(threadIds)})`, now(), ...threadIds)
  record(actor, 'move-to-inbox', threadIds.join(','))
  return finish(entry, threadIds.length)
}

export function trash(threadIds: number[], actor: Actor = 'ui'): ActionResult {
  const entry = snapshot(threadIds, 'Przeniesiono do kosza')
  const rows = threadMessageIds(threadIds, undefined, ['trash', 'drafts'])
  moveMessages(rows, { toRole: 'trash' }, actor, entry)
  run(`UPDATE threads SET resurfaced_at = NULL, snoozed_until = NULL, pinned = 0 WHERE id IN (${inList(threadIds)})`, ...threadIds)
  record(actor, 'trash', threadIds.join(','))
  return finish(entry, threadIds.length)
}

/** Permanently delete (only messages already in Trash/Spam). */
export function deleteForever(threadIds: number[], actor: Actor = 'ui'): ActionResult {
  const entry = snapshot(threadIds, 'Usunięto na zawsze')
  const rows = threadMessageIds(threadIds, ['trash', 'junk', 'blocked'])
  for (const [accountId, list] of groupByAccount(rows)) {
    const ids = list.map((r) => r.id)
    run(`UPDATE messages SET hidden = 1 WHERE id IN (${inList(ids)})`, ...ids)
    entry.opIds.push(enqueue('expunge', accountId, { messageIds: ids, revert: { messageIds: ids } }, { delayMs: delayFor(actor), actor }))
  }
  record(actor, 'delete-forever', threadIds.join(','))
  return finish(entry, rows.length)
}

export function spam(threadIds: number[], actor: Actor = 'ui'): ActionResult {
  const entry = snapshot(threadIds, 'Oznaczono jako spam')
  const rows = threadMessageIds(threadIds, undefined, ['junk', 'sent', 'drafts', 'trash'])
  moveMessages(rows.filter((r) => !r.is_outgoing), { toRole: 'junk' }, actor, entry)
  record(actor, 'spam', threadIds.join(','))
  return finish(entry, threadIds.length)
}

export function notSpam(threadIds: number[], actor: Actor = 'ui'): ActionResult {
  const entry = snapshot(threadIds, 'To nie spam')
  moveMessages(threadMessageIds(threadIds, ['junk']), { toRole: 'inbox' }, actor, entry)
  record(actor, 'not-spam', threadIds.join(','))
  return finish(entry, threadIds.length)
}

export function moveToFolder(threadIds: number[], folderId: number, actor: Actor = 'ui', fromFolderIds?: number[]): ActionResult {
  const target = get('SELECT * FROM folders WHERE id = ?', folderId)
  if (!target) throw new Error('Folder nie istnieje')
  const entry = snapshot(threadIds, `Przeniesiono do: ${target.name}`)
  let rows = threadMessageIds(threadIds, undefined, ['sent', 'drafts'])
  if (fromFolderIds?.length) rows = rows.filter((r) => fromFolderIds.includes(r.folder_id))
  rows = rows.filter((r) => r.account_id === target.account_id && r.folder_id !== folderId)
  moveMessages(rows, { toFolderId: folderId }, actor, entry)
  if (target.role !== 'inbox') run(`UPDATE threads SET resurfaced_at = NULL WHERE id IN (${inList(threadIds)})`, ...threadIds)
  record(actor, 'move', threadIds.join(','), { folder: target.path })
  return finish(entry, threadIds.length)
}

export function copyToFolder(threadIds: number[], folderId: number, actor: Actor = 'ui'): ActionResult {
  const target = get('SELECT * FROM folders WHERE id = ?', folderId)
  if (!target) throw new Error('Folder nie istnieje')
  const entry = snapshot(threadIds, `Skopiowano do: ${target.name}`)
  const rows = threadMessageIds(threadIds, undefined, ['trash', 'junk']).filter((r) => r.account_id === target.account_id)
  moveMessages(rows, { toFolderId: folderId }, actor, entry, true)
  record(actor, 'copy', threadIds.join(','), { folder: target.path })
  return finish(entry, threadIds.length)
}

/** Gmail labels. */
export function setLabel(threadIds: number[], label: string, on: boolean, actor: Actor = 'ui'): ActionResult {
  const entry = snapshot(threadIds, on ? `Dodano etykietę ${label}` : `Usunięto etykietę ${label}`)
  for (const [accountId, list] of groupByAccount(threadMessageIds(threadIds, undefined, ['trash', 'junk']))) {
    entry.opIds.push(enqueue('labels', accountId, { messageIds: list.map((r) => r.id), ...(on ? { add: [label] } : { remove: [label] }) }, { actor }))
  }
  record(actor, on ? 'label-add' : 'label-remove', threadIds.join(','), { label })
  return finish(entry, threadIds.length)
}

export function markRead(threadIds: number[], read: boolean, actor: Actor = 'ui'): ActionResult {
  const entry = snapshot(threadIds, read ? 'Oznaczono jako przeczytane' : 'Oznaczono jako nieprzeczytane')
  const rows = threadMessageIds(threadIds)
  if (read) setFlag(rows, '\\Seen', true, actor, entry)
  else {
    // unread = only the latest incoming message per thread
    const latest = new Map<number, Row>()
    for (const r of rows) if (!r.is_outgoing) latest.set(r.thread_id, r)
    setFlag([...latest.values()], '\\Seen', false, actor, entry)
  }
  record(actor, read ? 'mark-read' : 'mark-unread', threadIds.join(','))
  return finish(entry, threadIds.length)
}

export function markMessagesRead(messageIds: number[], read: boolean, actor: Actor = 'ui'): void {
  if (!messageIds.length) return
  const rows = all(`SELECT m.*, f.role FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id IN (${inList(messageIds)})`, ...messageIds)
  const entry = snapshot([], '')
  setFlag(rows, '\\Seen', read, actor, entry)
  bus.emitEvent({ type: 'mailbox-changed' })
}

export function pin(threadIds: number[], on: boolean, actor: Actor = 'ui'): ActionResult {
  const entry = snapshot(threadIds, on ? 'Przypięto' : 'Odpięto')
  run(`UPDATE threads SET pinned = ? WHERE id IN (${inList(threadIds)})`, on ? 1 : 0, ...threadIds)
  const rows = threadMessageIds(threadIds, undefined, ['trash', 'junk'])
  if (on) {
    const latest = new Map<number, Row>()
    for (const r of rows) if (!r.is_outgoing || !latest.has(r.thread_id)) latest.set(r.thread_id, r)
    setFlag([...latest.values()], '\\Flagged', true, actor, entry)
  } else {
    setFlag(rows, '\\Flagged', false, actor, entry)
  }
  record(actor, on ? 'pin' : 'unpin', threadIds.join(','))
  return finish(entry, threadIds.length)
}

export function snooze(threadIds: number[], until: number | null, actor: Actor = 'ui'): ActionResult {
  const entry = snapshot(threadIds, until ? `Odłożono do ${new Date(until).toLocaleString('pl-PL', { timeZone: getSettings().timeZone })}` : 'Anulowano odłożenie')
  run(`UPDATE threads SET snoozed_until = ?, resurfaced_at = NULL WHERE id IN (${inList(threadIds)})`, until, ...threadIds)
  record(actor, until ? 'snooze' : 'unsnooze', threadIds.join(','), until ? { until } : undefined)
  return finish(entry, threadIds.length)
}

export function setAside(threadIds: number[], on: boolean, actor: Actor = 'ui'): ActionResult {
  const entry = snapshot(threadIds, on ? 'Odłożono na bok' : 'Wróciło do Odebranych')
  run(`UPDATE threads SET set_aside = ?, resurfaced_at = CASE WHEN ? = 0 THEN ? ELSE NULL END WHERE id IN (${inList(threadIds)})`, on ? 1 : 0, on ? 1 : 0, now(), ...threadIds)
  record(actor, on ? 'set-aside' : 'unset-aside', threadIds.join(','))
  return finish(entry, threadIds.length)
}

export function mute(threadIds: number[], on: boolean, actor: Actor = 'ui'): ActionResult {
  const entry = snapshot(threadIds, on ? 'Wyciszono wątek' : 'Wyłączono wyciszenie')
  run(`UPDATE threads SET muted = ? WHERE id IN (${inList(threadIds)})`, on ? 1 : 0, ...threadIds)
  if (on) setFlag(threadMessageIds(threadIds), '\\Seen', true, actor, entry)
  record(actor, on ? 'mute' : 'unmute', threadIds.join(','))
  return finish(entry, threadIds.length)
}

export function priority(threadIds: number[], on: boolean, actor: Actor = 'ui'): ActionResult {
  const entry = snapshot(threadIds, on ? 'Oznaczono jako priorytet' : 'Usunięto priorytet')
  run(`UPDATE threads SET priority = ? WHERE id IN (${inList(threadIds)})`, on ? 1 : 0, ...threadIds)
  record(actor, on ? 'priority' : 'unpriority', threadIds.join(','))
  return finish(entry, threadIds.length)
}

/** Remind me: bring the thread back at `at` (kind 'no-reply' only if nobody answered by then). */
export function remind(threadIds: number[], at: number | null, kind: 'manual' | 'no-reply' = 'manual', actor: Actor = 'ui'): ActionResult {
  const entry = snapshot(threadIds, at ? 'Ustawiono przypomnienie' : 'Usunięto przypomnienie')
  run(
    `UPDATE threads SET reminder_at = ?, reminder_kind = ?, reminder_ref = ? WHERE id IN (${inList(threadIds)})`,
    at, at ? kind : null, at ? now() : null, ...threadIds,
  )
  record(actor, at ? 'remind' : 'unremind', threadIds.join(','), at ? { at, kind } : undefined)
  return finish(entry, threadIds.length)
}

// ---------- sender actions (Smart Inbox / GateKeeper) ----------

function senderSnapshot(emails: string[]): UndoEntry['contacts'] {
  return emails.map((e) => {
    const c = get<{ status: string; category: string | null; vip: number }>('SELECT status, category, vip FROM contacts WHERE email = ? COLLATE NOCASE', e)
    return { email: e.toLowerCase(), status: c?.status || 'unknown', category: c?.category || null, vip: c?.vip || 0 }
  })
}

export function acceptSenders(emails: string[], actor: Actor = 'ui'): ActionResult {
  const entry = snapshot([], emails.length > 1 ? `Zaakceptowano ${emails.length} nadawców` : `Zaakceptowano ${emails[0]}`)
  entry.contacts = senderSnapshot(emails)
  for (const e of emails) setContactStatus(e, 'accepted')
  record(actor, 'accept-sender', emails.join(','))
  bus.emitEvent({ type: 'contacts-changed' })
  return finish(entry, emails.length)
}

/** Block senders (or "@domain"): their mail goes to the Blocked folder, now and in future. */
export function blockSenders(emails: string[], actor: Actor = 'ui'): ActionResult {
  const entry = snapshot([], emails.length > 1 ? `Zablokowano ${emails.length} nadawców` : `Zablokowano ${emails[0]}`)
  entry.contacts = senderSnapshot(emails)
  for (const e of emails) setContactStatus(e, 'blocked')
  const rows: Row[] = []
  for (const e of emails) {
    const pattern = e.startsWith('@') ? `%${e.toLowerCase()}` : e.toLowerCase()
    rows.push(
      ...all(
        `SELECT m.id, m.account_id, m.folder_id, m.uid, m.thread_id, m.seen, m.flagged, f.role FROM messages m JOIN folders f ON f.id = m.folder_id
         WHERE m.from_email LIKE ? AND f.role = 'inbox' AND m.hidden = 0`,
        pattern,
      ),
    )
  }
  moveMessages(rows, { toRole: 'blocked' }, actor, entry)
  record(actor, 'block-sender', emails.join(','))
  bus.emitEvent({ type: 'contacts-changed' })
  return finish(entry, emails.length)
}

export function unblockSenders(emails: string[], actor: Actor = 'ui'): ActionResult {
  const entry = snapshot([], `Odblokowano ${emails.join(', ')}`)
  entry.contacts = senderSnapshot(emails)
  for (const e of emails) setContactStatus(e, 'accepted')
  record(actor, 'unblock-sender', emails.join(','))
  bus.emitEvent({ type: 'contacts-changed' })
  return finish(entry, emails.length)
}

export function changeSenderCategory(emails: string[], category: Category, actor: Actor = 'ui'): ActionResult {
  const entry = snapshot([], `Przeniesiono nadawcę do: ${category === 'people' ? 'Ludzie' : category === 'notification' ? 'Powiadomienia' : 'Newslettery'}`)
  entry.contacts = senderSnapshot(emails)
  let n = 0
  for (const e of emails) n += setSenderCategory(e, category)
  refreshThreadCategories()
  record(actor, 'categorize-sender', emails.join(','), { category })
  bus.emitEvent({ type: 'contacts-changed' })
  return finish(entry, n)
}

export function prioritySender(emails: string[], on: boolean, actor: Actor = 'ui'): ActionResult {
  const entry = snapshot([], on ? 'Nadawca priorytetowy' : 'Usunięto priorytet nadawcy')
  entry.contacts = senderSnapshot(emails)
  for (const e of emails) setVip(e, on)
  record(actor, on ? 'vip' : 'unvip', emails.join(','))
  bus.emitEvent({ type: 'contacts-changed' })
  return finish(entry, emails.length)
}

export function sendersOfThreads(threadIds: number[]): string[] {
  if (!threadIds.length) return []
  return all<{ e: string }>(
    `SELECT DISTINCT from_email e FROM messages WHERE thread_id IN (${inList(threadIds)}) AND is_outgoing = 0 AND from_email IS NOT NULL`,
    ...threadIds,
  ).map((r) => r.e)
}

export function unsubscribe(threadIds: number[], actor: Actor = 'ui'): ActionResult {
  const rows = all(
    `SELECT m.id, m.account_id, m.list_unsubscribe, m.list_unsubscribe_post FROM messages m
     WHERE m.thread_id IN (${inList(threadIds)}) AND m.list_unsubscribe IS NOT NULL ORDER BY m.date DESC`,
    ...threadIds,
  )
  if (!rows.length) throw new Error('Ta wiadomość nie ma nagłówka List-Unsubscribe')
  const done = new Set<number>()
  const entry = snapshot(threadIds, 'Wypisano z listy')
  for (const r of rows) {
    if (done.has(r.account_id)) continue
    done.add(r.account_id)
    entry.opIds.push(enqueue('unsubscribe', r.account_id, { messageIds: [r.id] }, { actor }))
  }
  record(actor, 'unsubscribe', threadIds.join(','))
  return finish(entry, rows.length)
}
