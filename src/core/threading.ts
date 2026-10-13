import { all, get, inList, insert, run } from './db'
import { isReplySubject, normalizeSubject } from './mime'

export interface ThreadKey {
  accountId: number
  msgid: string | null
  inReplyTo: string | null
  refs: string[]
  gmThrid: string | null
  subject: string | null
  date: number
}

/** Find or create the conversation for a message; merges conversations that a message links together. */
export function assignThread(k: ThreadKey): number {
  const subjectNorm = normalizeSubject(k.subject)

  if (k.gmThrid) {
    const t = get<{ id: number }>('SELECT id FROM threads WHERE account_id = ? AND gm_thrid = ?', k.accountId, k.gmThrid)
    const id = t?.id ?? insert('threads', { account_id: k.accountId, gm_thrid: k.gmThrid, subject: subjectNorm, last_date: k.date })
    registerRefs(k.accountId, id, [k.msgid, k.inReplyTo, ...k.refs])
    bumpDate(id, k.date)
    return id
  }

  const ids = [...new Set([k.msgid, k.inReplyTo, ...k.refs].filter((x): x is string => !!x))]
  let found: number[] = []
  if (ids.length) {
    found = all<{ thread_id: number }>(
      `SELECT DISTINCT thread_id FROM thread_refs WHERE account_id = ? AND msgid IN (${inList(ids)})`,
      k.accountId,
      ...ids,
    ).map((r) => r.thread_id)
  }

  let threadId: number
  if (found.length === 0) {
    let bySubject: { id: number } | undefined
    if (subjectNorm && isReplySubject(k.subject) && !k.refs.length && !k.inReplyTo) {
      bySubject = get<{ id: number }>(
        'SELECT id FROM threads WHERE account_id = ? AND subject = ? AND last_date > ? ORDER BY last_date DESC LIMIT 1',
        k.accountId,
        subjectNorm,
        k.date - 45 * 86400_000,
      )
    }
    threadId = bySubject?.id ?? insert('threads', { account_id: k.accountId, subject: subjectNorm, last_date: k.date })
  } else {
    found.sort((a, b) => a - b)
    threadId = found[0]
    for (const other of found.slice(1)) mergeThreads(threadId, other)
  }
  registerRefs(k.accountId, threadId, ids)
  bumpDate(threadId, k.date)
  return threadId
}

function registerRefs(accountId: number, threadId: number, ids: (string | null)[]): void {
  for (const id of ids) {
    if (!id) continue
    run('INSERT OR IGNORE INTO thread_refs(account_id, msgid, thread_id) VALUES (?, ?, ?)', accountId, id, threadId)
  }
}

function bumpDate(threadId: number, date: number): void {
  run('UPDATE threads SET last_date = MAX(COALESCE(last_date, 0), ?) WHERE id = ?', date || 0, threadId)
}

function mergeThreads(into: number, from: number): void {
  const a = get('SELECT * FROM threads WHERE id = ?', into)
  const b = get('SELECT * FROM threads WHERE id = ?', from)
  if (!a || !b) return
  run('UPDATE messages SET thread_id = ? WHERE thread_id = ?', into, from)
  run('UPDATE thread_refs SET thread_id = ? WHERE thread_id = ?', into, from)
  run('UPDATE drafts SET thread_id = ? WHERE thread_id = ?', into, from)
  run(
    `UPDATE threads SET
       pinned = MAX(pinned, ?), muted = MAX(muted, ?), set_aside = MAX(set_aside, ?),
       snoozed_until = COALESCE(snoozed_until, ?), reminder_at = COALESCE(reminder_at, ?),
       last_date = MAX(COALESCE(last_date,0), ?), category = COALESCE(category, ?)
     WHERE id = ?`,
    b.pinned, b.muted, b.set_aside, b.snoozed_until, b.reminder_at, b.last_date || 0, b.category, into,
  )
  run('DELETE FROM threads WHERE id = ?', from)
}

/** Remove threads that no longer have any messages or drafts. */
export function pruneEmptyThreads(accountId?: number): void {
  const where = accountId ? 'AND t.account_id = ?' : ''
  const args = accountId ? [accountId] : []
  const dead = all<{ id: number }>(
    `SELECT t.id FROM threads t
     WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = t.id)
       AND t.pinned = 0 AND t.set_aside = 0 AND t.snoozed_until IS NULL AND t.reminder_at IS NULL AND t.muted = 0
       AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.thread_id = t.id AND d.status IN ('draft','scheduled','sending'))
       ${where}`,
    ...args,
  )
  for (const d of dead) {
    run('DELETE FROM thread_refs WHERE thread_id = ?', d.id)
    run('DELETE FROM threads WHERE id = ?', d.id)
  }
}
