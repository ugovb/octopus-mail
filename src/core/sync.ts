import fs from 'node:fs'
import path from 'node:path'
import { ImapFlow, type FetchMessageObject, type ListResponse, type MailboxObject } from 'imapflow'
import { t } from '../shared/i18n'
import type { Account, Address, FolderRole, SyncStatus } from '../shared/types'
import { getAccount, imapAuth, imapOptions, listAccounts, myAddresses } from './accounts'
import { all, get, inList, insert, now, parseJson, type Row, run, tx, update } from './db'
import { bus, log } from './events'
import {
  analyzeStructure, decodeBuffer, headerValue, htmlToText, makeSnippet, normMsgId, parseMsgIds,
  type Structure, toAddress, toAddresses,
} from './mime'
import { ftsPut } from './fts'
import { attachmentsDir } from './paths'
import { getSettings } from './settings'
import { categorize, contactOverride, noteIncoming, noteOutgoing, refreshThreadCategories } from './smart'
import { assignThread, pruneEmptyThreads } from './threading'

const HEADER_FIELDS = [
  'references', 'list-unsubscribe', 'list-unsubscribe-post', 'list-id', 'precedence', 'auto-submitted',
  'x-mailer', 'x-campaign', 'x-mailgun-tag', 'x-sg-eid', 'x-mc-user', 'feedback-id', 'x-octopus-draft',
]
const BATCH = 200
const CORE_ROLES: FolderRole[] = ['inbox', 'sent', 'drafts']
const SNIPPET_BYTES = 2000

type NewMessagesHook = (accountId: number, messageIds: number[], initial: boolean) => void
const newMessageHooks: NewMessagesHook[] = []
export function onNewMessages(fn: NewMessagesHook): void {
  newMessageHooks.push(fn)
}

function roleFromList(f: ListResponse): FolderRole | null {
  const su = (f.specialUse || '').toLowerCase()
  const map: Record<string, FolderRole> = {
    '\\inbox': 'inbox', '\\sent': 'sent', '\\drafts': 'drafts', '\\trash': 'trash', '\\junk': 'junk',
    '\\archive': 'archive', '\\all': 'all', '\\flagged': 'flagged', '\\important': 'important',
  }
  if (map[su]) return map[su]
  if (f.path.toUpperCase() === 'INBOX') return 'inbox'
  const n = f.name.toLowerCase()
  if (/^(sent|sent items|sent messages|sent mail|wysłane|elementy wysłane|wyslane)$/.test(n)) return 'sent'
  if (/^(drafts?|szkice|kopie robocze|wersje robocze)$/.test(n)) return 'drafts'
  if (/^(trash|deleted|deleted items|deleted messages|kosz|usunięte|elementy usunięte)$/.test(n)) return 'trash'
  if (/^(junk|spam|junk e-mail|bulk mail|wiadomości-śmieci|niechciane)$/.test(n)) return 'junk'
  if (/^(archive|archives|archiwum)$/.test(n)) return 'archive'
  if (/^(blocked|zablokowane)$/.test(n)) return 'blocked'
  return null
}

function flagsOf(set: Set<string> | undefined) {
  const f = set || new Set<string>()
  return {
    seen: f.has('\\Seen'),
    flagged: f.has('\\Flagged'),
    answered: f.has('\\Answered'),
    draft: f.has('\\Draft'),
    keywords: [...f].filter((x) => !x.startsWith('\\')),
  }
}

function decodeRaw(buf: Buffer | undefined, encoding: string | null, charset: string | null): string {
  if (!buf) return ''
  return decodePartial(buf, encoding, charset)
}

/** Decode base64 / quoted-printable transfer encoding to raw bytes. */
function decodeTransfer(buf: Buffer, encoding: string | null): Buffer {
  const enc = (encoding || '').toLowerCase()
  if (enc === 'base64') return Buffer.from(buf.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (enc === 'quoted-printable') {
    const s = buf.toString('binary').replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    return Buffer.from(s, 'binary')
  }
  return buf
}

function decodePartial(buf: Buffer, encoding: string | null, charset: string | null): string {
  let raw = buf
  const enc = (encoding || '').toLowerCase()
  try {
    if (enc === 'base64') {
      const s = buf.toString('ascii').replace(/[^A-Za-z0-9+/=]/g, '')
      raw = Buffer.from(s.slice(0, s.length - (s.length % 4)), 'base64')
    } else if (enc === 'quoted-printable') {
      const s = buf.toString('binary').replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
      raw = Buffer.from(s, 'binary')
    }
  } catch {
    /* keep raw */
  }
  return decodeBuffer(raw, charset)
}

export class AccountSync {
  acc: Account
  private work: ImapFlow | null = null
  private idle: ImapFlow | null = null
  private connecting: Promise<ImapFlow> | null = null
  private stopped = false
  private timers: NodeJS.Timeout[] = []
  private syncing = false
  private pending = new Set<number>()
  private backoff = 5_000
  private me = new Set<string>()
  private idleDebounce: NodeJS.Timeout | null = null
  private lastIdleEvent = 0
  status: SyncStatus

  constructor(acc: Account) {
    this.acc = acc
    this.status = { account_id: acc.id, email: acc.email, state: 'idle', detail: null, error: null, last_sync: acc.last_sync }
  }

  private setStatus(state: SyncStatus['state'], detail: string | null = null, error: string | null = null) {
    this.status = { ...this.status, state, detail, error, last_sync: state === 'idle' ? now() : this.status.last_sync }
    bus.emitEvent({ type: 'sync-status', status: this.status })
  }

  async start(): Promise<void> {
    this.stopped = false
    this.me = myAddresses()
    try {
      await this.syncFolderList()
      await this.syncAll(true)
      await this.startIdle()
    } catch (e) {
      this.fail(e)
    }
    // core folders every 3 minutes; the inbox every minute as a safety net for servers with lazy IDLE
    this.timers.push(setInterval(() => void this.syncAll(false).catch((e) => this.fail(e)), 3 * 60_000))
    this.timers.push(
      setInterval(() => {
        const inbox = this.folderByRole('inbox')
        if (inbox && !this.syncing && Date.now() - this.lastIdleEvent > 55_000) void this.syncFolder(inbox.id).catch((e) => this.fail(e))
      }, 60_000),
    )
    this.timers.push(setInterval(() => void this.syncFolderList().catch(() => undefined), 30 * 60_000))
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    for (const c of [this.work, this.idle]) {
      try { await c?.logout() } catch { /* ignore */ }
    }
    this.work = null
    this.idle = null
    this.setStatus('disabled')
  }

  private fail(e: unknown) {
    const err = e as Error & { responseText?: string; authenticationFailed?: boolean }
    const msg = err.authenticationFailed ? t('Sign-in failed — check the password') : err.responseText || err.message || String(e)
    log('sync', this.acc.email, 'error:', msg)
    run('UPDATE accounts SET last_error = ? WHERE id = ?', msg, this.acc.id)
    this.setStatus('error', null, msg)
    this.work = null
    if (!this.stopped) {
      const delay = this.backoff
      this.backoff = Math.min(this.backoff * 2, 10 * 60_000)
      setTimeout(() => {
        if (!this.stopped) void this.syncAll(false).then(() => this.startIdle()).catch((er) => this.fail(er))
      }, delay)
    }
  }

  /** The working connection (opened lazily, reopened after drops). */
  async conn(): Promise<ImapFlow> {
    if (this.work?.usable) return this.work
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      this.setStatus('connecting')
      this.acc = getAccount(this.acc.id)
      const c = new ImapFlow(imapOptions(this.acc, await imapAuth(this.acc)))
      c.on('error', (e: Error) => log('imap', this.acc.email, 'work error', e.message))
      c.on('close', () => {
        if (this.work === c) this.work = null
      })
      await c.connect()
      this.work = c
      this.backoff = 5_000
      run('UPDATE accounts SET last_error = NULL, capabilities = ? WHERE id = ?', JSON.stringify([...c.capabilities.keys()]), this.acc.id)
      if (c.capabilities.has('X-GM-EXT-1') && !this.acc.is_gmail) {
        run('UPDATE accounts SET is_gmail = 1 WHERE id = ?', this.acc.id)
        this.acc.is_gmail = true
      }
      return c
    })().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private async startIdle(): Promise<void> {
    if (this.stopped || this.idle?.usable) return
    const inbox = this.folderByRole('inbox')
    if (!inbox) return
    try {
      const c = new ImapFlow({ ...imapOptions(this.acc, await imapAuth(this.acc)), maxIdleTime: 9 * 60_000 })
      c.on('error', (e: Error) => log('imap', this.acc.email, 'idle error', e.message))
      c.on('close', () => {
        if (this.idle === c) this.idle = null
        if (!this.stopped) setTimeout(() => void this.startIdle(), 30_000)
      })
      const kick = () => {
        this.lastIdleEvent = Date.now()
        if (this.idleDebounce) clearTimeout(this.idleDebounce)
        this.idleDebounce = setTimeout(() => void this.syncFolder(inbox.id).catch((e) => this.fail(e)), 800)
      }
      c.on('exists', kick)
      c.on('expunge', kick)
      c.on('flags', kick)
      await c.connect()
      await c.mailboxOpen(inbox.path, { readOnly: true })
      this.idle = c
    } catch (e) {
      log('imap', this.acc.email, 'idle failed', (e as Error).message)
    }
  }

  folderByRole(role: FolderRole): Row | undefined {
    return get('SELECT * FROM folders WHERE account_id = ? AND role = ? ORDER BY id LIMIT 1', this.acc.id, role)
  }

  async syncFolderList(): Promise<void> {
    const c = await this.conn()
    const list = await c.list()
    const seen = new Set<string>()
    tx(() => {
      for (const f of list) {
        seen.add(f.path)
        const noselect = f.flags?.has('\\Noselect') || f.flags?.has('\\NonExistent')
        const role = roleFromList(f)
        const existing = get<{ id: number; role: string | null }>('SELECT id, role FROM folders WHERE account_id = ? AND path = ?', this.acc.id, f.path)
        if (existing) {
          run(
            'UPDATE folders SET name = ?, delimiter = ?, parent_path = ?, role = COALESCE(?, role), flags = ?, subscribed = ?, selectable = ? WHERE id = ?',
            f.name, f.delimiter, f.parentPath || null, role, JSON.stringify([...(f.flags || [])]), f.subscribed ? 1 : 0, noselect ? 0 : 1, existing.id,
          )
        } else {
          insert('folders', {
            account_id: this.acc.id,
            path: f.path,
            name: f.name,
            delimiter: f.delimiter,
            parent_path: f.parentPath || null,
            role,
            flags: JSON.stringify([...(f.flags || [])]),
            subscribed: f.subscribed ? 1 : 0,
            selectable: noselect ? 0 : 1,
            sync_mode: role && [...CORE_ROLES, 'junk', 'trash'].includes(role) ? 'always' : 'auto',
          })
        }
      }
      const local = all<{ id: number; path: string }>('SELECT id, path FROM folders WHERE account_id = ?', this.acc.id)
      for (const l of local) if (!seen.has(l.path)) run('DELETE FROM folders WHERE id = ?', l.id)
    })
    bus.emitEvent({ type: 'mailbox-changed', accountId: this.acc.id })
  }

  /** Sync core folders plus any folder opened in the last hour. */
  async syncAll(initial: boolean): Promise<void> {
    if (this.syncing) return
    this.syncing = true
    try {
      const folders = all(
        `SELECT * FROM folders WHERE account_id = ? AND selectable = 1 AND sync_mode != 'never'
           AND (sync_mode = 'always' OR role IN ('inbox','sent','drafts') OR last_opened > ?)
         ORDER BY CASE role WHEN 'inbox' THEN 0 WHEN 'sent' THEN 1 WHEN 'drafts' THEN 2 ELSE 3 END, id`,
        this.acc.id,
        now() - 3600_000,
      )
      for (const f of folders) {
        if (this.stopped) break
        await this.syncFolderNow(f, initial)
      }
      run('UPDATE accounts SET last_sync = ?, last_error = NULL WHERE id = ?', now(), this.acc.id)
      this.setStatus('idle')
      void this.prefetchBodies()
    } finally {
      this.syncing = false
    }
  }

  async syncFolder(folderId: number): Promise<void> {
    const f = get('SELECT * FROM folders WHERE id = ? AND account_id = ?', folderId, this.acc.id)
    if (!f) return
    if (this.pending.has(folderId)) return
    this.pending.add(folderId)
    try {
      await this.syncFolderNow(f, false)
      this.setStatus('idle')
    } finally {
      this.pending.delete(folderId)
    }
  }

  private async syncFolderNow(f: Row, initial: boolean): Promise<void> {
    const c = await this.conn()
    this.setStatus('syncing', f.name)
    const alreadyOpen = !!c.mailbox && (c.mailbox as MailboxObject).path === f.path
    const lock = await c.getMailboxLock(f.path, { readOnly: false })
    try {
      // a mailbox that stayed selected holds stale UIDNEXT/HIGHESTMODSEQ: re-select to refresh them
      if (alreadyOpen) await c.mailboxOpen(f.path, { readOnly: false })
      const mb = c.mailbox as MailboxObject
      const uidValidity = String(mb.uidValidity)
      const modseq = mb.highestModseq ? String(mb.highestModseq) : null
      const firstTime = !f.last_sync || f.uidvalidity !== uidValidity

      if (f.uidvalidity && f.uidvalidity !== uidValidity) {
        log('sync', this.acc.email, f.path, 'UIDVALIDITY changed — resetting folder')
        this.wipeFolder(f.id)
        f.max_uid = null
        f.min_uid = null
      }

      const newIds: number[] = []
      if (mb.exists > 0) {
        if (!f.max_uid) {
          // first sync: messages inside the account's sync window, newest first
          const days = f.role === 'inbox' || f.role === 'sent' ? this.acc.sync_days : Math.min(this.acc.sync_days, 30)
          const since = new Date(now() - days * 86400_000)
          let uids: number[] = mb.exists <= 300 ? [] : ((await c.search({ since }, { uid: true })) || [])
          if (mb.exists <= 300) uids = (await c.search({ all: true }, { uid: true })) || []
          if (!uids.length && mb.exists > 0) {
            // window empty: take the newest 50 so the folder is not blank
            const latest = (await c.search({ all: true }, { uid: true })) || []
            uids = latest.slice(-50)
          }
          uids.sort((a, b) => b - a)
          for (let i = 0; i < uids.length; i += BATCH) {
            const chunk = uids.slice(i, i + BATCH)
            newIds.push(...(await this.fetchAndStore(c, f, chunk.join(','), true)))
            bus.emitEvent({ type: 'mailbox-changed', accountId: this.acc.id, folderIds: [f.id] })
          }
          const minUid = uids.length ? Math.min(...uids) : null
          const maxUid = uids.length ? Math.max(...uids) : null
          update('folders', f.id, { min_uid: minUid, max_uid: maxUid, oldest_synced: since.getTime(), fully_synced: mb.exists <= 300 ? 1 : 0 })
          f.max_uid = maxUid
          f.min_uid = minUid
        } else {
          const changed =
            String(f.uidnext) !== String(mb.uidNext) || f.total !== mb.exists || !modseq || f.highest_modseq !== modseq
          if (Number(mb.uidNext) > f.max_uid + 1 || mb.exists > f.total) {
            const ids = await this.fetchAndStore(c, f, `${f.max_uid + 1}:*`)
            newIds.push(...ids)
            const maxRow = get<{ m: number }>('SELECT MAX(uid) m FROM messages WHERE folder_id = ?', f.id)
            if (maxRow?.m) update('folders', f.id, { max_uid: Math.max(maxRow.m, f.max_uid) })
          }
          if (changed && f.min_uid) await this.syncFlags(c, f)
        }
      }
      if (mb.exists === 0) this.wipeFolder(f.id)

      const counts = get<{ total: number; unread: number }>(
        'SELECT COUNT(*) total, SUM(seen = 0) unread FROM messages WHERE folder_id = ? AND hidden = 0',
        f.id,
      )
      let unread = counts?.unread || 0
      try {
        const st = await c.status(f.path, { unseen: true })
        if (typeof st.unseen === 'number') unread = st.unseen
      } catch {
        /* some servers refuse STATUS on the selected mailbox */
      }
      update('folders', f.id, {
        uidvalidity: uidValidity,
        uidnext: Number(mb.uidNext),
        highest_modseq: modseq,
        total: mb.exists,
        unread,
        last_sync: now(),
      })

      if (newIds.length) {
        if (this.acc.is_gmail && f.role === 'inbox') await this.gmailCategories(c, f, newIds)
        refreshThreadCategories([...new Set(newIds.map((id) => get<{ thread_id: number }>('SELECT thread_id FROM messages WHERE id = ?', id)?.thread_id).filter((x): x is number => !!x))])
        for (const h of newMessageHooks) {
          try {
            h(this.acc.id, newIds, initial || firstTime)
          } catch (e) {
            log('sync', 'hook failed', (e as Error).message)
          }
        }
      }
      bus.emitEvent({ type: 'mailbox-changed', accountId: this.acc.id, folderIds: [f.id] })
    } finally {
      lock.release()
    }
  }

  private wipeFolder(folderId: number) {
    tx(() => {
      run('DELETE FROM fts WHERE rowid IN (SELECT id FROM messages WHERE folder_id = ?)', folderId)
      run('DELETE FROM messages WHERE folder_id = ?', folderId)
      update('folders', folderId, { min_uid: null, max_uid: null, highest_modseq: null, fully_synced: 0 })
    })
    pruneEmptyThreads(this.acc.id)
  }

  /** Re-read flags (and Gmail labels) for everything we hold locally; missing UIDs were expunged. */
  private async syncFlags(c: ImapFlow, f: Row) {
    const local = all<{ id: number; uid: number; seen: number; flagged: number; answered: number; gm_labels: string | null; thread_id: number }>(
      'SELECT id, uid, seen, flagged, answered, gm_labels, thread_id FROM messages WHERE folder_id = ?',
      f.id,
    )
    if (!local.length) return
    const byUid = new Map(local.map((m) => [m.uid, m]))
    const present = new Set<number>()
    const updates: [number, ReturnType<typeof flagsOf>, string | null][] = []
    const minUid = Math.min(...local.map((m) => m.uid))
    for await (const msg of c.fetch(`${minUid}:*`, { uid: true, flags: true, labels: this.acc.is_gmail }, { uid: true })) {
      present.add(msg.uid)
      const l = byUid.get(msg.uid)
      if (!l) continue
      const fl = flagsOf(msg.flags)
      const labels = msg.labels ? JSON.stringify([...msg.labels]) : null
      if (+fl.seen !== l.seen || +fl.flagged !== l.flagged || +fl.answered !== l.answered || (labels && labels !== l.gm_labels)) {
        updates.push([l.id, fl, labels])
      }
    }
    const gone = local.filter((m) => !present.has(m.uid))
    if (!updates.length && !gone.length) return
    const touched = new Set<number>()
    tx(() => {
      for (const [id, fl, labels] of updates) {
        run(
          'UPDATE messages SET seen = ?, flagged = ?, answered = ?, keywords = ?, gm_labels = COALESCE(?, gm_labels) WHERE id = ?',
          fl.seen, fl.flagged, fl.answered, JSON.stringify(fl.keywords), labels, id,
        )
        const t = byUid.get(get<{ uid: number }>('SELECT uid FROM messages WHERE id = ?', id)!.uid)
        if (t) touched.add(t.thread_id)
      }
      for (const g of gone) {
        run('DELETE FROM fts WHERE rowid = ?', g.id)
        run('DELETE FROM messages WHERE id = ?', g.id)
        touched.add(g.thread_id)
      }
    })
    if (gone.length) pruneEmptyThreads(this.acc.id)
    // pin state follows the server's \Flagged
    for (const tid of touched) {
      if (!tid) continue
      const anyFlag = get<{ f: number }>('SELECT MAX(flagged) f FROM messages WHERE thread_id = ?', tid)
      if (anyFlag) run('UPDATE threads SET pinned = ? WHERE id = ?', anyFlag.f ? 1 : 0, tid)
    }
    bus.emitEvent({ type: 'thread-changed', threadIds: [...touched] })
  }

  /** Fetch headers + structure for a UID set, store new rows, return their ids. */
  private async fetchAndStore(c: ImapFlow, f: Row, range: string, initial = false): Promise<number[]> {
    const gmail = this.acc.is_gmail
    const msgs: FetchMessageObject[] = []
    for await (const m of c.fetch(
      range,
      {
        uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true,
        // emailId (X-GM-MSGID / OBJECTID) is always requested by imapflow
        headers: HEADER_FIELDS, threadId: gmail || c.capabilities.has('OBJECTID'), labels: gmail,
      },
      { uid: true },
    )) {
      if (f.max_uid && range.endsWith(':*') && m.uid <= f.max_uid) continue
      msgs.push(m)
    }
    if (!msgs.length) return []

    // cheap snippets: first ~2 KB of the main text part
    const snippetSrc = new Map<number, { part: string; html: boolean; enc: string | null; cs: string | null }>()
    const structs = new Map<number, Structure>()
    for (const m of msgs) {
      const s = analyzeStructure(m.bodyStructure as never)
      structs.set(m.uid, s)
      const part = s.text[0] || s.html[0]
      if (part) {
        const node = findNode(m.bodyStructure as never, part)
        snippetSrc.set(m.uid, { part, html: !s.text[0], enc: node?.encoding || null, cs: s.charset[part] || null })
      }
    }
    const snippets = new Map<number, string>()
    const byPart = new Map<string, number[]>()
    for (const [uid, src] of snippetSrc) {
      const arr = byPart.get(src.part) || []
      arr.push(uid)
      byPart.set(src.part, arr)
    }
    for (const [part, uids] of byPart) {
      try {
        for await (const m of c.fetch(uids.join(','), { uid: true, bodyParts: [{ key: part, start: 0, maxLength: SNIPPET_BYTES } as never] }, { uid: true })) {
          const src = snippetSrc.get(m.uid)
          const buf = m.bodyParts?.get(part)
          if (!src || !buf) continue
          const txt = decodePartial(buf, src.enc, src.cs)
          snippets.set(m.uid, makeSnippet(src.html ? htmlToText(txt) : txt))
        }
      } catch (e) {
        log('sync', 'snippet fetch failed', (e as Error).message)
      }
    }

    const ids: number[] = []
    tx(() => {
      for (const m of msgs) {
        const id = this.storeMessage(f, m, structs.get(m.uid)!, snippets.get(m.uid) || '', initial)
        if (id) ids.push(id)
      }
    })
    return ids
  }

  private storeMessage(f: Row, m: FetchMessageObject, s: Structure, snippet: string, initial = false): number | null {
    const exists = get<{ id: number }>('SELECT id FROM messages WHERE folder_id = ? AND uid = ?', f.id, m.uid)
    const fl = flagsOf(m.flags)
    if (exists) {
      run('UPDATE messages SET seen = ?, flagged = ?, answered = ? WHERE id = ?', fl.seen, fl.flagged, fl.answered, exists.id)
      return null
    }
    const env = m.envelope || ({} as NonNullable<FetchMessageObject['envelope']>)
    const headers = m.headers
    const from = toAddress(env.from?.[0]) || toAddress(env.sender?.[0])
    const to = toAddresses(env.to)
    const cc = toAddresses(env.cc)
    const bcc = toAddresses(env.bcc)
    const replyTo = toAddresses(env.replyTo)
    const date = env.date ? new Date(env.date).getTime() : m.internalDate ? new Date(m.internalDate).getTime() : now()
    const msgid = normMsgId(env.messageId) || `<octo-${this.acc.id}-${f.id}-${m.uid}@local>`
    const inReplyTo = normMsgId(env.inReplyTo)
    const refs = parseMsgIds(headerValue(headers, 'references'))
    const isOutgoing = (!!from && this.me.has(from.email)) || f.role === 'sent' || f.role === 'drafts'
    const listUnsub = headerValue(headers, 'list-unsubscribe')
    const listId = headerValue(headers, 'list-id')
    const precedence = headerValue(headers, 'precedence')
    const autoSubmitted = headerValue(headers, 'auto-submitted')
    const hints = ['x-mailer', 'x-campaign', 'x-mailgun-tag', 'x-sg-eid', 'x-mc-user', 'feedback-id']
      .map((h) => (headerValue(headers, h) ? `${h}:${headerValue(headers, h)}` : ''))
      .join(' ')
    const octoDraft = headerValue(headers, 'x-octopus-draft')

    const over = from ? contactOverride(from.email) : { category: null, status: 'unknown' }
    const category = over.category || categorize({
      fromEmail: from?.email || null, fromName: from?.name, listUnsubscribe: listUnsub, listId, precedence,
      autoSubmitted, isOutgoing, headersHint: hints,
    })

    const accountId = this.acc.id
    // the same Gmail message can sit in several label folders: count it for contacts only once
    const dup = m.emailId
      ? get('SELECT 1 FROM messages WHERE account_id = ? AND gm_msgid = ? LIMIT 1', accountId, m.emailId)
      : get('SELECT 1 FROM messages WHERE account_id = ? AND msgid = ? LIMIT 1', accountId, msgid)

    const threadId = assignThread({
      accountId, msgid, inReplyTo, refs, gmThrid: m.threadId || null, subject: env.subject || '', date,
    })

    const id = insert('messages', {
      account_id: accountId,
      folder_id: f.id,
      uid: m.uid,
      thread_id: threadId,
      msgid,
      in_reply_to: inReplyTo,
      refs: refs.join(' '),
      gm_msgid: m.emailId || null,
      gm_thrid: m.threadId || null,
      gm_labels: m.labels ? JSON.stringify([...m.labels]) : null,
      subject: env.subject || '',
      from_name: from?.name || null,
      from_email: from?.email || null,
      to_json: JSON.stringify(to),
      cc_json: JSON.stringify(cc),
      bcc_json: JSON.stringify(bcc),
      reply_to_json: JSON.stringify(replyTo),
      date,
      internal_date: m.internalDate ? new Date(m.internalDate).getTime() : null,
      size: m.size || 0,
      seen: fl.seen,
      flagged: fl.flagged,
      answered: fl.answered,
      draft: fl.draft || !!octoDraft,
      keywords: JSON.stringify(fl.keywords),
      snippet,
      has_attachments: s.attachments.some((a) => !a.inline) ? 1 : 0,
      structure: JSON.stringify({ html: s.html, text: s.text, charset: s.charset, encoding: s.encoding }),
      category,
      is_outgoing: isOutgoing ? 1 : 0,
      list_unsubscribe: listUnsub,
      list_unsubscribe_post: headerValue(headers, 'list-unsubscribe-post'),
      list_id: listId,
      auto_submitted: autoSubmitted,
      precedence,
      calendar_part: s.calendar,
      hidden: octoDraft ? 1 : 0,
      created_at: now(),
    })
    for (const a of s.attachments) {
      run(
        'INSERT OR IGNORE INTO attachments(message_id, part, filename, mime, size, encoding, content_id, inline) VALUES (?,?,?,?,?,?,?,?)',
        id, a.part, a.filename, a.mime, a.size, a.encoding, a.content_id, a.inline ? 1 : 0,
      )
    }
    const people = [from, ...to, ...cc].filter((x): x is Address => !!x).map((a) => `${a.name || ''} ${a.email}`).join(' ')
    ftsPut(id, env.subject || '', people, snippet, s.attachments.filter((a) => !a.inline).map((a) => a.filename).join(' '))
    if (fl.flagged) run('UPDATE threads SET pinned = 1 WHERE id = ?', threadId)
    if (!dup) {
      if (isOutgoing) noteOutgoing([...to, ...cc, ...bcc], date)
      else noteIncoming(from, date, initial)
    }
    return id
  }

  /** Gmail already sorts mail into Promotions/Social/Updates/Forums — reuse that verdict. */
  private async gmailCategories(c: ImapFlow, f: Row, ids: number[]) {
    const rows = all<{ id: number; uid: number; from_email: string | null }>(
      `SELECT id, uid, from_email FROM messages WHERE id IN (${inList(ids)})`,
      ...ids,
    )
    if (!rows.length) return
    const uidRange = rows.map((r) => r.uid).join(',')
    const map: Record<string, string> = { promotions: 'newsletter', forums: 'newsletter', social: 'notification', updates: 'notification' }
    for (const [gcat, cat] of Object.entries(map)) {
      try {
        const hits = (await c.search({ uid: uidRange, gmraw: `category:${gcat}` } as never, { uid: true })) || []
        if (!hits.length) continue
        const hitSet = new Set(hits)
        for (const r of rows) {
          if (!hitSet.has(r.uid)) continue
          if (r.from_email && contactOverride(r.from_email).category) continue
          run('UPDATE messages SET category = ? WHERE id = ?', cat, r.id)
        }
      } catch (e) {
        log('sync', 'gmail category search failed', (e as Error).message)
        return
      }
    }
  }

  /** Download the text/html parts of a message and store them. */
  async fetchBody(messageId: number): Promise<void> {
    const m = get('SELECT * FROM messages WHERE id = ?', messageId)
    if (!m) throw new Error(t('Message does not exist'))
    const f = get('SELECT * FROM folders WHERE id = ?', m.folder_id)!
    const s = parseJson<{ html: string[]; text: string[]; charset: Record<string, string>; encoding?: Record<string, string> }>(m.structure, { html: [], text: [], charset: {} })
    const parts = [...s.html.slice(0, 4), ...s.text.slice(0, 4)]
    const c = await this.conn()
    const lock = await c.getMailboxLock(f.path)
    let html = ''
    let text = ''
    try {
      if (!parts.length) {
        // no displayable part in the structure: take the raw body text
        const r = await c.fetchOne(String(m.uid), { uid: true, bodyParts: ['TEXT'] }, { uid: true })
        text = decodeBuffer(r ? r.bodyParts?.get('text') : undefined, null)
      } else {
        // raw parts + local decoding: works even on servers that reject "<part>.MIME"
        const r = await c.fetchOne(String(m.uid), { uid: true, bodyParts: parts }, { uid: true })
        const dec = (p: string) => decodeRaw(r ? r.bodyParts?.get(p) : undefined, s.encoding?.[p] || null, s.charset[p] || null)
        html = s.html.slice(0, 4).map(dec).filter(Boolean).join('<hr>')
        text = s.text.slice(0, 4).map(dec).filter(Boolean).join('\n\n')
      }
    } finally {
      lock.release()
    }
    const plain = text || htmlToText(html)
    tx(() => {
      run(
        'INSERT INTO bodies(message_id, html, text, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET html = excluded.html, text = excluded.text, fetched_at = excluded.fetched_at',
        messageId, html || null, plain, now(),
      )
      run('UPDATE messages SET body_state = 1, snippet = ? WHERE id = ?', makeSnippet(plain) || m.snippet, messageId)
      const files = all<{ filename: string }>('SELECT filename FROM attachments WHERE message_id = ? AND inline = 0', messageId).map((a) => a.filename).join(' ')
      const people = [m.from_name, m.from_email, ...parseJson<Address[]>(m.to_json, []).map((a) => `${a.name || ''} ${a.email}`)].join(' ')
      ftsPut(messageId, m.subject || '', people, plain, files)
    })
  }

  private prefetching = false
  /** Background body download for recent mail so search/AI work offline. */
  async prefetchBodies(): Promise<void> {
    if (this.prefetching) return
    this.prefetching = true
    try {
      const days = getSettings().bodyPrefetchDays
      const ids = all<{ id: number }>(
        `SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id
         WHERE m.account_id = ? AND m.body_state = 0 AND m.date > ? AND m.size < 2000000
           AND f.role IN ('inbox','sent','archive','all')
         ORDER BY m.date DESC LIMIT 400`,
        this.acc.id,
        now() - days * 86400_000,
      )
      for (const { id } of ids) {
        if (this.stopped) break
        try {
          await this.fetchBody(id)
        } catch (e) {
          run('UPDATE messages SET body_state = 2 WHERE id = ?', id)
          log('sync', 'prefetch failed', id, (e as Error).message)
        }
      }
    } finally {
      this.prefetching = false
    }
  }

  async downloadAttachment(attId: number): Promise<string> {
    const a = get('SELECT * FROM attachments WHERE id = ?', attId)
    if (!a) throw new Error(t('Attachment does not exist'))
    if (a.path && fs.existsSync(a.path)) return a.path
    const m = get('SELECT * FROM messages WHERE id = ?', a.message_id)!
    const f = get('SELECT * FROM folders WHERE id = ?', m.folder_id)!
    const dir = path.join(attachmentsDir(), String(m.account_id), String(m.id))
    fs.mkdirSync(dir, { recursive: true })
    const safe = String(a.filename || t('file')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150)
    const file = path.join(dir, `${a.part.replace(/\./g, '_')}-${safe}`)
    const c = await this.conn()
    const lock = await c.getMailboxLock(f.path)
    try {
      if ((a.size || 0) < 40 * 1024 * 1024 && a.encoding) {
        // raw part + the encoding recorded from BODYSTRUCTURE: independent of "<part>.MIME" support
        const raw = await c.fetchOne(String(m.uid), { uid: true, bodyParts: [a.part] }, { uid: true })
        const buf = raw ? raw.bodyParts?.get(a.part) : undefined
        if (!buf) throw new Error(t('The server did not return the attachment'))
        fs.writeFileSync(file, decodeTransfer(buf, a.encoding))
      } else {
        // very large files are streamed to disk
        const { content } = await c.download(String(m.uid), a.part, { uid: true })
        await new Promise<void>((resolve, reject) => {
          const ws = fs.createWriteStream(file)
          content.pipe(ws)
          ws.on('finish', () => resolve())
          ws.on('error', reject)
          content.on('error', reject)
        })
      }
    } finally {
      lock.release()
    }
    run('UPDATE attachments SET path = ? WHERE id = ?', file, attId)
    return file
  }

  /** Download one decoded MIME part (e.g. the text/calendar part of an invitation). */
  async downloadPart(messageId: number, part: string): Promise<{ content: Buffer; charset?: string; contentType?: string }> {
    const m = get('SELECT * FROM messages WHERE id = ?', messageId)
    if (!m) throw new Error(t('Message does not exist'))
    const f = get('SELECT * FROM folders WHERE id = ?', m.folder_id)!
    const c = await this.conn()
    const lock = await c.getMailboxLock(f.path)
    try {
      // raw part + BODYSTRUCTURE in one round trip; decoding never depends on "<part>.MIME" support
      const raw = await c.fetchOne(String(m.uid), { uid: true, bodyStructure: true, bodyParts: [part] }, { uid: true })
      const buf = raw ? raw.bodyParts?.get(part) : undefined
      if (!raw || !buf) throw new Error(t('Part {part} is missing', { part }))
      const node = findNode(raw.bodyStructure as never, part) as { encoding?: string; type?: string; parameters?: Record<string, string> } | null
      return { content: decodeTransfer(buf, node?.encoding || null), charset: node?.parameters?.charset, contentType: node?.type }
    } finally {
      lock.release()
    }
  }

  async downloadSource(messageId: number): Promise<Buffer> {
    const m = get('SELECT * FROM messages WHERE id = ?', messageId)!
    const f = get('SELECT * FROM folders WHERE id = ?', m.folder_id)!
    const c = await this.conn()
    const lock = await c.getMailboxLock(f.path)
    try {
      const { content } = await c.download(String(m.uid), undefined, { uid: true })
      const chunks: Buffer[] = []
      for await (const ch of content) chunks.push(ch as Buffer)
      return Buffer.concat(chunks)
    } finally {
      lock.release()
    }
  }

  /** Extend a folder's window further into the past. */
  async loadOlder(folderId: number, count = BATCH): Promise<number> {
    const f = get('SELECT * FROM folders WHERE id = ?', folderId)
    if (!f || !f.min_uid || f.min_uid <= 1) return 0
    const c = await this.conn()
    const lock = await c.getMailboxLock(f.path)
    try {
      const uids = ((await c.search({ uid: `1:${f.min_uid - 1}` }, { uid: true })) || []).sort((a, b) => b - a).slice(0, count)
      if (!uids.length) {
        update('folders', f.id, { fully_synced: 1 })
        return 0
      }
      const ids = await this.fetchAndStore(c, { ...f, max_uid: null }, uids.join(','))
      update('folders', f.id, { min_uid: Math.min(...uids) })
      refreshThreadCategories()
      bus.emitEvent({ type: 'mailbox-changed', accountId: this.acc.id, folderIds: [f.id] })
      return ids.length
    } finally {
      lock.release()
    }
  }

  // ---------- primitives used by the operation queue ----------

  async setFlags(folderPath: string, uids: number[], add: string[], remove: string[]): Promise<void> {
    if (!uids.length) return
    const c = await this.conn()
    const lock = await c.getMailboxLock(folderPath)
    try {
      if (add.length) await c.messageFlagsAdd(uids.join(','), add, { uid: true })
      if (remove.length) await c.messageFlagsRemove(uids.join(','), remove, { uid: true })
    } finally {
      lock.release()
    }
  }

  async setLabels(folderPath: string, uids: number[], add: string[], remove: string[]): Promise<void> {
    const c = await this.conn()
    const lock = await c.getMailboxLock(folderPath)
    try {
      if (add.length) await c.messageFlagsAdd(uids.join(','), add, { uid: true, useLabels: true })
      if (remove.length) await c.messageFlagsRemove(uids.join(','), remove, { uid: true, useLabels: true })
    } finally {
      lock.release()
    }
  }

  async move(folderPath: string, uids: number[], destPath: string): Promise<Map<number, number> | null> {
    const c = await this.conn()
    const lock = await c.getMailboxLock(folderPath)
    try {
      const r = await c.messageMove(uids.join(','), destPath, { uid: true })
      return r && r.uidMap ? r.uidMap : null
    } finally {
      lock.release()
    }
  }

  async copy(folderPath: string, uids: number[], destPath: string): Promise<void> {
    const c = await this.conn()
    const lock = await c.getMailboxLock(folderPath)
    try {
      await c.messageCopy(uids.join(','), destPath, { uid: true })
    } finally {
      lock.release()
    }
  }

  async expunge(folderPath: string, uids: number[]): Promise<void> {
    const c = await this.conn()
    const lock = await c.getMailboxLock(folderPath)
    try {
      await c.messageDelete(uids.join(','), { uid: true })
    } finally {
      lock.release()
    }
  }

  async append(folderPath: string, raw: Buffer, flags: string[]): Promise<number | null> {
    const c = await this.conn()
    const r = await c.append(folderPath, raw, flags)
    return r && typeof r === 'object' && r.uid ? Number(r.uid) : null
  }

  async createFolder(p: string): Promise<string> {
    const c = await this.conn()
    const r = await c.mailboxCreate(p)
    await this.syncFolderList()
    return r.path
  }

  async renameFolder(from: string, to: string): Promise<void> {
    const c = await this.conn()
    await c.mailboxRename(from, to)
    await this.syncFolderList()
  }

  async deleteFolder(p: string): Promise<void> {
    const c = await this.conn()
    await c.mailboxDelete(p)
    await this.syncFolderList()
  }
}

function findNode(root: { part?: string; childNodes?: unknown[] } | undefined, part: string): { encoding?: string } | null {
  if (!root) return null
  if ((root.part || '1') === part && !(root as { childNodes?: unknown[] }).childNodes?.length) return root as { encoding?: string }
  for (const ch of (root.childNodes || []) as { part?: string; childNodes?: unknown[] }[]) {
    const r = findNode(ch, part)
    if (r) return r
  }
  return null
}

// ---------- manager ----------

class SyncManager {
  private map = new Map<number, AccountSync>()
  private started = false

  async startAll(): Promise<void> {
    this.started = true
    for (const acc of listAccounts(false)) this.ensure(acc.id)
  }

  ensure(accountId: number): AccountSync {
    let s = this.map.get(accountId)
    if (!s) {
      s = new AccountSync(getAccount(accountId))
      this.map.set(accountId, s)
      if (this.started) void s.start()
    }
    return s
  }

  get(accountId: number): AccountSync {
    return this.map.get(accountId) || this.ensure(accountId)
  }

  isRunning(): boolean {
    return this.started
  }

  async remove(accountId: number): Promise<void> {
    const s = this.map.get(accountId)
    if (s) await s.stop()
    this.map.delete(accountId)
  }

  async restart(accountId: number): Promise<void> {
    await this.remove(accountId)
    const acc = getAccount(accountId)
    if (acc.enabled) this.ensure(accountId)
  }

  async stopAll(): Promise<void> {
    for (const s of this.map.values()) await s.stop()
    this.map.clear()
    this.started = false
  }

  statuses(): SyncStatus[] {
    return [...this.map.values()].map((s) => s.status)
  }

  async syncNow(accountId?: number): Promise<void> {
    const targets = accountId ? [this.get(accountId)] : [...this.map.values()]
    await Promise.all(targets.map((s) => s.syncAll(false).catch((e) => log('sync', 'syncNow failed', (e as Error).message))))
  }

  async syncFolder(folderId: number): Promise<void> {
    const f = get<{ account_id: number }>('SELECT account_id FROM folders WHERE id = ?', folderId)
    if (!f) return
    run('UPDATE folders SET last_opened = ? WHERE id = ?', now(), folderId)
    await this.get(f.account_id).syncFolder(folderId)
  }
}

export const sync = new SyncManager()
