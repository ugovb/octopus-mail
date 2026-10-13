// Durable operation queue. UI, CLI, MCP and rules enqueue IMAP work here; whichever process is
// alive (desktop app or `octo`) claims and executes it. Local state is updated optimistically
// when the op is enqueued, so the UI reacts instantly and Undo can simply cancel a pending op.
import crypto from 'node:crypto'
import type { FolderRole } from '../shared/types'
import { all, get, inList, insert, now, parseJson, type Row, run, tx } from './db'
import { bus, log } from './events'
import { sync } from './sync'
import { pruneEmptyThreads } from './threading'

export type OpKind =
  | 'flags' | 'move' | 'copy' | 'expunge' | 'labels' | 'send' | 'save-draft-remote' | 'delete-draft-remote'
  | 'create-folder' | 'rename-folder' | 'delete-folder' | 'unsubscribe'

export interface OpPayload {
  messageIds?: number[]
  /** raw IMAP UIDs (remote draft copies that have no local row) */
  uids?: number[]
  add?: string[]
  remove?: string[]
  toFolderId?: number
  toRole?: FolderRole
  draftId?: number
  path?: string
  newPath?: string
  url?: string
  mailto?: string
  /** local state to restore if the op fails for good */
  revert?: { messageIds?: number[]; flags?: { id: number; seen: number; flagged: number }[] }
}

const OWNER = `${process.pid}-${crypto.randomBytes(3).toString('hex')}`
const MAX_ATTEMPTS = 5

export function enqueue(kind: OpKind, accountId: number | null, payload: OpPayload, opts: { delayMs?: number; actor?: string } = {}): number {
  const id = insert('ops', {
    account_id: accountId,
    kind,
    payload: JSON.stringify(payload),
    run_after: now() + (opts.delayMs || 0),
    actor: opts.actor || 'ui',
    created_at: now(),
  })
  scheduleKick(opts.delayMs || 0)
  return id
}

/** Cancel ops that have not started yet. Returns how many were cancelled. */
export function cancelOps(ids: number[]): number {
  if (!ids.length) return 0
  const rows = all(`SELECT * FROM ops WHERE id IN (${inList(ids)}) AND status = 'pending'`, ...ids)
  for (const r of rows) {
    run("UPDATE ops SET status = 'cancelled', finished_at = ? WHERE id = ? AND status = 'pending'", now(), r.id)
    revertLocal(parseJson<OpPayload>(r.payload, {}))
  }
  bus.emitEvent({ type: 'mailbox-changed' })
  return rows.length
}

function revertLocal(p: OpPayload) {
  if (p.revert?.messageIds?.length) {
    run(`UPDATE messages SET hidden = 0 WHERE id IN (${inList(p.revert.messageIds)})`, ...p.revert.messageIds)
  }
  for (const f of p.revert?.flags || []) {
    run('UPDATE messages SET seen = ?, flagged = ? WHERE id = ?', f.seen, f.flagged, f.id)
  }
}

let kickTimer: NodeJS.Timeout | null = null
let running = false
let onIdleWaiters: (() => void)[] = []

function scheduleKick(delayMs: number) {
  if (process.env.OCTO_NO_AUTORUN) return
  if (kickTimer) clearTimeout(kickTimer)
  kickTimer = setTimeout(() => void processOps(), Math.max(50, delayMs + 50))
}

/** Execute every runnable op. Safe to call concurrently from several processes. */
export async function processOps(): Promise<number> {
  if (running) return 0
  running = true
  let done = 0
  try {
    // release ops whose worker died
    run("UPDATE ops SET status = 'pending', lock_owner = NULL WHERE status = 'running' AND lock_at < ?", now() - 5 * 60_000)
    for (;;) {
      const op = get(
        `UPDATE ops SET status = 'running', lock_owner = ?, lock_at = ?, attempts = attempts + 1
         WHERE id = (SELECT id FROM ops WHERE status = 'pending' AND run_after <= ? ORDER BY id LIMIT 1)
         RETURNING *`,
        OWNER,
        now(),
        now(),
      )
      if (!op) break
      try {
        await execute(op)
        run("UPDATE ops SET status = 'done', finished_at = ?, error = NULL WHERE id = ?", now(), op.id)
        done++
      } catch (e) {
        const msg = (e as Error).message || String(e)
        log('ops', `op ${op.id} ${op.kind} failed (attempt ${op.attempts}):`, msg)
        if (op.attempts >= MAX_ATTEMPTS || /nie istnieje|not found|does not exist/i.test(msg)) {
          run("UPDATE ops SET status = 'error', error = ?, finished_at = ? WHERE id = ?", msg, now(), op.id)
          revertLocal(parseJson<OpPayload>(op.payload, {}))
          bus.emitEvent({ type: 'toast', level: 'error', message: `Operacja nie powiodła się: ${msg}` })
          bus.emitEvent({ type: 'mailbox-changed' })
        } else {
          const backoff = Math.min(60_000 * 2 ** (op.attempts - 1), 30 * 60_000)
          run("UPDATE ops SET status = 'pending', error = ?, run_after = ?, lock_owner = NULL WHERE id = ?", msg, now() + backoff, op.id)
        }
      }
    }
    const next = get<{ t: number }>("SELECT MIN(run_after) t FROM ops WHERE status = 'pending'")
    if (next?.t) scheduleKick(Math.max(0, next.t - now()))
  } finally {
    running = false
    const w = onIdleWaiters
    onIdleWaiters = []
    w.forEach((f) => f())
  }
  return done
}

/** Wait until ops currently pending for an account have been processed (used by the CLI). */
export async function drainOps(timeoutMs = 60_000): Promise<void> {
  const until = now() + timeoutMs
  while (now() < until) {
    await processOps()
    const left = get<{ n: number }>("SELECT COUNT(*) n FROM ops WHERE status IN ('pending','running') AND run_after <= ?", now() + 1000)
    if (!left?.n) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

export function pendingOps(): Row[] {
  return all("SELECT * FROM ops WHERE status IN ('pending','running','error') ORDER BY id DESC LIMIT 100")
}

// ---------- executors ----------

function messagesByFolder(ids: number[]): Map<number, Row[]> {
  const rows = ids.length ? all(`SELECT * FROM messages WHERE id IN (${inList(ids)})`, ...ids) : []
  const map = new Map<number, Row[]>()
  for (const r of rows) {
    const arr = map.get(r.folder_id) || []
    arr.push(r)
    map.set(r.folder_id, arr)
  }
  return map
}

async function resolveTarget(accountId: number, p: OpPayload): Promise<Row> {
  if (p.toFolderId) {
    const f = get('SELECT * FROM folders WHERE id = ?', p.toFolderId)
    if (!f) throw new Error('Folder docelowy nie istnieje')
    return f
  }
  if (!p.toRole) throw new Error('Brak folderu docelowego')
  let f = get('SELECT * FROM folders WHERE account_id = ? AND role = ? ORDER BY id LIMIT 1', accountId, p.toRole)
  if (!f && (p.toRole === 'archive' || p.toRole === 'blocked')) {
    const acc = sync.get(accountId)
    const allFolder = p.toRole === 'archive' ? get('SELECT * FROM folders WHERE account_id = ? AND role = ?', accountId, 'all') : null
    if (allFolder) return allFolder
    const name = p.toRole === 'archive' ? 'Archive' : 'Blocked'
    const created = await acc.createFolder(name)
    run('UPDATE folders SET role = ? WHERE account_id = ? AND path = ?', p.toRole, accountId, created)
    f = get('SELECT * FROM folders WHERE account_id = ? AND path = ?', accountId, created)
  }
  if (!f) throw new Error(`Konto nie ma folderu „${p.toRole}”`)
  return f
}

async function execute(op: Row): Promise<void> {
  const p = parseJson<OpPayload>(op.payload, {})
  const accountId = op.account_id as number
  switch (op.kind as OpKind) {
    case 'flags': {
      for (const [folderId, rows] of messagesByFolder(p.messageIds || [])) {
        const f = get('SELECT * FROM folders WHERE id = ?', folderId)!
        await sync.get(f.account_id).setFlags(f.path, rows.map((r) => r.uid), p.add || [], p.remove || [])
      }
      return
    }
    case 'labels': {
      for (const [folderId, rows] of messagesByFolder(p.messageIds || [])) {
        const f = get('SELECT * FROM folders WHERE id = ?', folderId)!
        await sync.get(f.account_id).setLabels(f.path, rows.map((r) => r.uid), p.add || [], p.remove || [])
      }
      return
    }
    case 'move':
    case 'copy': {
      const target = await resolveTarget(accountId, p)
      const touchedThreads = new Set<number>()
      for (const [folderId, rows] of messagesByFolder(p.messageIds || [])) {
        if (folderId === target.id) {
          run(`UPDATE messages SET hidden = 0 WHERE id IN (${inList(rows.map((r) => r.id))})`, ...rows.map((r) => r.id))
          continue
        }
        const f = get('SELECT * FROM folders WHERE id = ?', folderId)!
        const s = sync.get(f.account_id)
        if (op.kind === 'copy') {
          await s.copy(f.path, rows.map((r) => r.uid), target.path)
          continue
        }
        const uidMap = await s.move(f.path, rows.map((r) => r.uid), target.path)
        tx(() => {
          for (const r of rows) {
            touchedThreads.add(r.thread_id)
            const newUid = uidMap?.get(r.uid)
            const clash = newUid ? get('SELECT id FROM messages WHERE folder_id = ? AND uid = ?', target.id, newUid) : null
            if (newUid && !clash) {
              run('UPDATE messages SET folder_id = ?, uid = ?, hidden = 0 WHERE id = ?', target.id, newUid, r.id)
            } else {
              run('DELETE FROM fts WHERE rowid = ?', r.id)
              run('DELETE FROM messages WHERE id = ?', r.id)
            }
          }
        })
      }
      pruneEmptyThreads(accountId)
      bus.emitEvent({ type: 'thread-changed', threadIds: [...touchedThreads] })
      bus.emitEvent({ type: 'mailbox-changed', accountId })
      return
    }
    case 'expunge': {
      for (const [folderId, rows] of messagesByFolder(p.messageIds || [])) {
        const f = get('SELECT * FROM folders WHERE id = ?', folderId)!
        await sync.get(f.account_id).expunge(f.path, rows.map((r) => r.uid))
        tx(() => {
          for (const r of rows) {
            run('DELETE FROM fts WHERE rowid = ?', r.id)
            run('DELETE FROM messages WHERE id = ?', r.id)
          }
        })
      }
      pruneEmptyThreads(accountId)
      bus.emitEvent({ type: 'mailbox-changed', accountId })
      return
    }
    case 'send': {
      const { sendDraftNow } = await import('./send')
      await sendDraftNow(p.draftId!)
      return
    }
    case 'save-draft-remote': {
      const { saveDraftRemote } = await import('./send')
      await saveDraftRemote(p.draftId!)
      return
    }
    case 'delete-draft-remote': {
      const f = get('SELECT * FROM folders WHERE id = ?', p.toFolderId)
      if (f && p.uids?.length) {
        await sync.get(f.account_id).expunge(f.path, p.uids)
        run(`DELETE FROM messages WHERE folder_id = ? AND uid IN (${inList(p.uids)})`, f.id, ...p.uids)
      }
      return
    }
    case 'create-folder':
      await sync.get(accountId).createFolder(p.path!)
      return
    case 'rename-folder':
      await sync.get(accountId).renameFolder(p.path!, p.newPath!)
      return
    case 'delete-folder':
      await sync.get(accountId).deleteFolder(p.path!)
      return
    case 'unsubscribe': {
      const { performUnsubscribe } = await import('./unsubscribe')
      await performUnsubscribe(accountId, p)
      return
    }
    default:
      throw new Error(`Nieznana operacja ${op.kind}`)
  }
}
