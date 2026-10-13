import type {
  Address, AttachmentInfo, Category, FolderRole, MailboxRef, MessageView, ThreadSummary, ThreadView,
} from '../shared/types'
import { all, get, inList, now, parseJson, type Row } from './db'
import { threadDrafts } from './drafts'
import { getSettings } from './settings'

export interface ListOptions {
  accountId?: number | null
  limit?: number
  offset?: number
  unreadOnly?: boolean
}

/** SQL fragment: true when every participant of thread t is an unscreened new sender. */
export const NEW_SENDER_THREAD = `NOT EXISTS (
  SELECT 1 FROM messages mm LEFT JOIN contacts c ON c.email = mm.from_email
  WHERE mm.thread_id = t.id AND (
    mm.is_outgoing = 1 OR c.status = 'accepted' OR c.sent_count > 0 OR c.vip = 1
    OR EXISTS (SELECT 1 FROM contacts cd WHERE cd.email = '@' || substr(mm.from_email, instr(mm.from_email, '@') + 1) AND cd.status = 'accepted')
  )
)`

export const BLOCKED_THREAD = `EXISTS (
  SELECT 1 FROM messages mb JOIN contacts cb ON cb.email = mb.from_email
  WHERE mb.thread_id = t.id AND mb.is_outgoing = 0 AND cb.status = 'blocked'
)`

interface Scope {
  where: string
  params: unknown[]
  threadWhere?: string
  threadParams?: unknown[]
}

const NOT_SNOOZED = '(t.snoozed_until IS NULL OR t.snoozed_until <= ?)'

export function scopeFor(ref: MailboxRef, accountId?: number | null): Scope {
  const t = now()
  const acc = accountId ? ' AND m.account_id = ?' : ''
  const accP = accountId ? [accountId] : []
  const gk = getSettings().gatekeeper === 'on'
  const inboxBase = `(f.role = 'inbox' OR t.resurfaced_at IS NOT NULL) AND f.role NOT IN ('trash','junk','blocked')`
  const inboxThread = `${NOT_SNOOZED} AND t.set_aside = 0 AND NOT ${BLOCKED_THREAD}${gk ? ` AND NOT ${NEW_SENDER_THREAD}` : ''}`
  switch (ref.kind) {
    case 'smart':
      return { where: inboxBase + acc, params: accP, threadWhere: inboxThread, threadParams: [t] }
    case 'category':
      return { where: inboxBase + acc, params: accP, threadWhere: `${inboxThread} AND t.category = ?`, threadParams: [t, ref.category] }
    case 'unified':
      if (ref.role === 'inbox') return { where: inboxBase + acc, params: accP, threadWhere: inboxThread, threadParams: [t] }
      return { where: `f.role = ?${acc}`, params: [ref.role, ...accP] }
    case 'folder':
      return { where: 'm.folder_id = ?', params: [ref.folderId] }
    case 'pinned':
      return { where: `f.role NOT IN ('trash','junk','blocked')${acc}`, params: accP, threadWhere: 't.pinned = 1' }
    case 'snoozed':
      return { where: `f.role NOT IN ('trash','junk')${acc}`, params: accP, threadWhere: 't.snoozed_until > ?', threadParams: [t] }
    case 'setaside':
      return { where: `f.role NOT IN ('trash','junk')${acc}`, params: accP, threadWhere: 't.set_aside = 1' }
    case 'reminders':
      return { where: `f.role NOT IN ('trash','junk')${acc}`, params: accP, threadWhere: 't.reminder_at IS NOT NULL' }
    case 'newsenders':
      return {
        where: `f.role = 'inbox'${acc}`,
        params: accP,
        threadWhere: `${NOT_SNOOZED} AND ${NEW_SENDER_THREAD} AND NOT ${BLOCKED_THREAD}`,
        threadParams: [t],
      }
    case 'blocked':
      return { where: `(f.role = 'blocked' OR f.role = 'inbox')${acc}`, params: accP, threadWhere: BLOCKED_THREAD }
    default:
      return { where: '1 = 0', params: [] }
  }
}

function orderFor(ref: MailboxRef): string {
  if (ref.kind === 'snoozed') return 't.snoozed_until ASC'
  if (ref.kind === 'reminders') return 't.reminder_at ASC'
  return 'MAX(h.d, COALESCE(t.resurfaced_at, 0)) DESC'
}

export function listThreadsByScope(scope: Scope, order: string, opts: ListOptions = {}): ThreadSummary[] {
  const limit = opts.limit ?? 100
  const offset = opts.offset ?? 0
  const rows = all(
    `WITH h AS (
       SELECT m.thread_id, MAX(m.date) d, SUM(m.seen = 0) unread_hits
       FROM messages m
       JOIN folders f ON f.id = m.folder_id
       JOIN threads t ON t.id = m.thread_id
       WHERE m.hidden = 0 AND (${scope.where})
       GROUP BY m.thread_id
     )
     SELECT t.*, h.d, h.unread_hits FROM h JOIN threads t ON t.id = h.thread_id
     WHERE ${scope.threadWhere || '1 = 1'} ${opts.unreadOnly ? 'AND h.unread_hits > 0' : ''}
     ORDER BY ${order}
     LIMIT ? OFFSET ?`,
    ...scope.params,
    ...(scope.threadParams || []),
    limit,
    offset,
  )
  return summarize(rows)
}

export function listThreads(ref: MailboxRef, opts: ListOptions = {}): ThreadSummary[] {
  return listThreadsByScope(scopeFor(ref, opts.accountId), orderFor(ref), opts)
}

/** Build ThreadSummary objects for thread rows (with h.d / h.unread_hits columns). */
export function summarize(threadRows: Row[]): ThreadSummary[] {
  if (!threadRows.length) return []
  const ids = threadRows.map((r) => r.id)
  const msgs = all(
    `SELECT m.id, m.thread_id, m.account_id, m.folder_id, m.subject, m.from_name, m.from_email, m.to_json, m.date,
            m.seen, m.flagged, m.has_attachments, m.snippet, m.is_outgoing, m.gm_msgid, m.msgid, m.gm_labels, m.category,
            f.role
     FROM messages m JOIN folders f ON f.id = m.folder_id
     WHERE m.thread_id IN (${inList(ids)}) AND m.hidden = 0
     ORDER BY m.date DESC`,
    ...ids,
  )
  const byThread = new Map<number, Row[]>()
  for (const m of msgs) {
    const arr = byThread.get(m.thread_id) || []
    arr.push(m)
    byThread.set(m.thread_id, arr)
  }
  const accounts = new Map(all('SELECT id, email, color FROM accounts').map((a) => [a.id, a]))
  const drafts = new Set(
    all(`SELECT DISTINCT thread_id FROM drafts WHERE thread_id IN (${inList(ids)}) AND status IN ('draft','scheduled','failed')`, ...ids).map((r) => r.thread_id),
  )
  const vipThreads = new Set(
    all(
      `SELECT DISTINCT m.thread_id FROM messages m JOIN contacts c ON c.email = m.from_email
       WHERE m.thread_id IN (${inList(ids)}) AND c.vip = 1 AND m.is_outgoing = 0`,
      ...ids,
    ).map((r) => r.thread_id),
  )
  const newSenderThreads = new Set(
    all(`SELECT t.id FROM threads t WHERE t.id IN (${inList(ids)}) AND ${NEW_SENDER_THREAD}`, ...ids).map((r) => r.id),
  )

  const out: ThreadSummary[] = []
  for (const t of threadRows) {
    const list = byThread.get(t.id) || []
    if (!list.length) continue
    // collapse copies of the same message living in several folders (Gmail labels)
    const seenKeys = new Set<string>()
    const unique = list.filter((m) => {
      const k = m.gm_msgid || m.msgid || String(m.id)
      if (seenKeys.has(k)) return false
      seenKeys.add(k)
      return true
    })
    const latest = unique.find((m) => m.role !== 'trash' && m.role !== 'junk') || unique[0]
    const latestIncoming = unique.find((m) => !m.is_outgoing) || latest
    const participants: Address[] = []
    for (const m of [...unique].reverse()) {
      if (m.from_email && !participants.some((p) => p.email === m.from_email)) {
        participants.push({ name: m.is_outgoing ? 'Ja' : m.from_name || undefined, email: m.from_email })
      }
    }
    const unreadCount = unique.filter((m) => !m.seen).length
    const acc = accounts.get(t.account_id)
    const labels = new Set<string>()
    for (const m of unique) for (const l of parseJson<string[]>(m.gm_labels, [])) if (!l.startsWith('\\')) labels.add(l)
    out.push({
      thread_id: t.id,
      account_id: t.account_id,
      account_email: acc?.email || '',
      account_color: acc?.color || null,
      subject: latest.subject || '(bez tematu)',
      snippet: latest.snippet || '',
      participants,
      from: latest.is_outgoing && latestIncoming
        ? { name: latestIncoming.from_name || undefined, email: latestIncoming.from_email }
        : { name: latest.from_name || undefined, email: latest.from_email },
      last_date: Math.max(latest.date || 0, t.resurfaced_at || 0),
      message_count: unique.length,
      unread: unreadCount > 0,
      unread_count: unreadCount,
      flagged: unique.some((m) => m.flagged),
      has_attachments: unique.some((m) => m.has_attachments),
      category: (t.category as Category) || (latestIncoming.category as Category) || 'people',
      pinned: !!t.pinned,
      muted: !!t.muted,
      snoozed_until: t.snoozed_until,
      set_aside: !!t.set_aside,
      reminder_at: t.reminder_at,
      resurfaced_at: t.resurfaced_at,
      has_draft: drafts.has(t.id),
      latest_message_id: latest.id,
      folder_ids: [...new Set(unique.map((m) => m.folder_id as number))],
      labels: [...labels],
      is_new_sender: newSenderThreads.has(t.id),
      priority: !!t.priority || vipThreads.has(t.id),
      outgoing_last: !!latest.is_outgoing,
    })
  }
  return out
}

export function threadSummary(threadId: number): ThreadSummary | null {
  const t = get('SELECT t.*, t.last_date d, 0 unread_hits FROM threads t WHERE t.id = ?', threadId)
  return t ? summarize([t])[0] || null : null
}

function rowToMessage(m: Row, atts: AttachmentInfo[], body?: Row): MessageView {
  return {
    id: m.id,
    account_id: m.account_id,
    folder_id: m.folder_id,
    folder_role: m.role as FolderRole | null,
    thread_id: m.thread_id,
    uid: m.uid,
    msgid: m.msgid,
    subject: m.subject || '',
    from: { name: m.from_name || undefined, email: m.from_email || '' },
    to: parseJson<Address[]>(m.to_json, []),
    cc: parseJson<Address[]>(m.cc_json, []),
    bcc: parseJson<Address[]>(m.bcc_json, []),
    reply_to: parseJson<Address[]>(m.reply_to_json, []),
    date: m.date,
    seen: !!m.seen,
    flagged: !!m.flagged,
    answered: !!m.answered,
    is_outgoing: !!m.is_outgoing,
    snippet: m.snippet || '',
    html: body?.html ?? null,
    text: body?.text ?? null,
    body_state: m.body_state,
    attachments: atts,
    list_unsubscribe: m.list_unsubscribe,
    list_unsubscribe_post: m.list_unsubscribe_post,
    calendar_part: m.calendar_part,
    category: m.category,
    labels: parseJson<string[]>(m.gm_labels, []).filter((l) => !l.startsWith('\\')),
  }
}

export function attachmentsFor(messageIds: number[]): Map<number, AttachmentInfo[]> {
  const map = new Map<number, AttachmentInfo[]>()
  if (!messageIds.length) return map
  for (const a of all(`SELECT * FROM attachments WHERE message_id IN (${inList(messageIds)}) ORDER BY id`, ...messageIds)) {
    const arr = map.get(a.message_id) || []
    arr.push({ ...a, inline: !!a.inline } as AttachmentInfo)
    map.set(a.message_id, arr)
  }
  return map
}

export function getMessage(id: number): MessageView | null {
  const m = get('SELECT m.*, f.role FROM messages m JOIN folders f ON f.id = m.folder_id WHERE m.id = ?', id)
  if (!m) return null
  const body = get('SELECT html, text FROM bodies WHERE message_id = ?', id)
  return rowToMessage(m, attachmentsFor([id]).get(id) || [], body)
}

export function getThread(threadId: number): ThreadView | null {
  const summary = threadSummary(threadId)
  if (!summary) return null
  const rows = all(
    `SELECT m.*, f.role FROM messages m JOIN folders f ON f.id = m.folder_id
     WHERE m.thread_id = ? AND m.hidden = 0 ORDER BY m.date ASC, m.id ASC`,
    threadId,
  )
  const seenKeys = new Set<string>()
  const unique = rows.filter((m) => {
    const k = m.gm_msgid || m.msgid || String(m.id)
    if (seenKeys.has(k)) return false
    seenKeys.add(k)
    return true
  })
  const ids = unique.map((m) => m.id)
  const atts = attachmentsFor(ids)
  const bodies = new Map(ids.length ? all(`SELECT * FROM bodies WHERE message_id IN (${inList(ids)})`, ...ids).map((b) => [b.message_id, b]) : [])
  return {
    thread: summary,
    messages: unique.map((m) => rowToMessage(m, atts.get(m.id) || [], bodies.get(m.id))),
    drafts: threadDrafts(threadId),
  }
}

/** All messages of a thread that an action should touch, optionally restricted to folder roles. */
export function threadMessageIds(threadIds: number[], roles?: FolderRole[], excludeRoles?: FolderRole[]): Row[] {
  if (!threadIds.length) return []
  let sql = `SELECT m.id, m.account_id, m.folder_id, m.uid, m.thread_id, m.seen, m.flagged, m.is_outgoing, m.date, f.role
             FROM messages m JOIN folders f ON f.id = m.folder_id
             WHERE m.thread_id IN (${inList(threadIds)}) AND m.hidden = 0`
  const params: unknown[] = [...threadIds]
  if (roles?.length) {
    sql += ` AND f.role IN (${inList(roles)})`
    params.push(...roles)
  }
  if (excludeRoles?.length) {
    sql += ` AND (f.role IS NULL OR f.role NOT IN (${inList(excludeRoles)}))`
    params.push(...excludeRoles)
  }
  return all(sql + ' ORDER BY m.date', ...params)
}

export interface Counts {
  inbox: number
  inboxUnread: number
  pinned: number
  snoozed: number
  setaside: number
  reminders: number
  newsenders: number
  scheduled: number
  drafts: number
  categories: Record<string, number>
  folders: Record<number, number>
}

function countScope(ref: MailboxRef): number {
  const s = scopeFor(ref)
  const r = get<{ n: number }>(
    `WITH h AS (
       SELECT DISTINCT m.thread_id FROM messages m
       JOIN folders f ON f.id = m.folder_id JOIN threads t ON t.id = m.thread_id
       WHERE m.hidden = 0 AND (${s.where})
     ) SELECT COUNT(*) n FROM h JOIN threads t ON t.id = h.thread_id WHERE ${s.threadWhere || '1=1'}`,
    ...s.params,
    ...(s.threadParams || []),
  )
  return r?.n || 0
}

/** Threads carrying a local flag, counted from the (few) flagged threads rather than from all mail. */
function countFlagged(cond: string, ...params: unknown[]): number {
  return get<{ n: number }>(
    `SELECT COUNT(*) n FROM threads t WHERE ${cond} AND EXISTS (
       SELECT 1 FROM messages m JOIN folders f ON f.id = m.folder_id
       WHERE m.thread_id = t.id AND m.hidden = 0 AND (f.role IS NULL OR f.role NOT IN ('trash','junk','blocked')))`,
    ...params,
  )?.n || 0
}

/** Smart Inbox size, its unread count and the per-category unread counts in a single pass. */
function inboxStats(): { inbox: number; inboxUnread: number; categories: Record<string, number> } {
  const s = scopeFor({ kind: 'smart' })
  const inboxRows = all<{ c: string | null; u: number }>(
    `WITH h AS (
       SELECT m.thread_id, MAX(m.seen = 0) u FROM messages m
       JOIN folders f ON f.id = m.folder_id JOIN threads t ON t.id = m.thread_id
       WHERE m.hidden = 0 AND (${s.where}) GROUP BY m.thread_id
     ) SELECT t.category c, h.u u FROM h JOIN threads t ON t.id = h.thread_id WHERE ${s.threadWhere || '1=1'}`,
    ...s.params,
    ...(s.threadParams || []),
  )
  const categories: Record<string, number> = { people: 0, notification: 0, newsletter: 0 }
  let inboxUnread = 0
  for (const r of inboxRows) {
    if (!r.u) continue
    inboxUnread++
    categories[r.c || 'people'] = (categories[r.c || 'people'] || 0) + 1
  }
  return { inbox: inboxRows.length, inboxUnread, categories }
}

/** Sidebar badges. Runs after every mailbox change, so it must stay cheap on large mailboxes. */
export function counts(): Counts {
  const folders: Record<number, number> = {}
  for (const r of all('SELECT folder_id, COUNT(DISTINCT thread_id) n FROM messages WHERE seen = 0 AND hidden = 0 GROUP BY folder_id')) {
    folders[r.folder_id] = r.n
  }
  const { inbox, inboxUnread, categories } = inboxStats()
  return {
    inbox,
    inboxUnread,
    pinned: countFlagged('t.pinned = 1'),
    snoozed: countFlagged('t.snoozed_until > ?', now()),
    setaside: countFlagged('t.set_aside = 1'),
    reminders: countFlagged('t.reminder_at IS NOT NULL'),
    // with GateKeeper off new senders are already in the inbox, so there is nothing separate to show
    newsenders: getSettings().gatekeeper === 'on' ? countScope({ kind: 'newsenders' }) : 0,
    scheduled: get<{ n: number }>("SELECT COUNT(*) n FROM drafts WHERE status IN ('scheduled','failed')")?.n || 0,
    drafts: get<{ n: number }>("SELECT COUNT(*) n FROM drafts WHERE status = 'draft'")?.n || 0,
    categories,
    folders,
  }
}

/** Cheap unread count for the taskbar/tray badge. */
export function inboxUnreadCount(): number {
  return inboxStats().inboxUnread
}
