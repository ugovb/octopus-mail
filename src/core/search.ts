// Gmail-style search: operators (from:, to:, is:, has:, in:, before:, newer_than:, category:, …)
// combined with diacritics-insensitive full-text search over subject, people, body and file names.
import type { SearchResult, ThreadSummary } from '../shared/types'
import { get, type Row, all } from './db'
import { fold } from './fts'
import { BLOCKED_THREAD, listThreadsByScope, summarize } from './queries'

interface Clause {
  sql: string
  params: unknown[]
}

export interface ParsedQuery {
  where: Clause[]
  threadWhere: Clause[]
  fts: string[]
  ftsNot: string[]
  raw: string
  includeTrash: boolean
}

function tokenize(q: string): string[] {
  const out: string[] = []
  const re = /(-?[a-z_]+:"[^"]*"|-?[a-z_]+:\S+|-?"[^"]*"|\S+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(q))) out.push(m[1])
  return out
}

const unq = (s: string) => s.replace(/^"|"$/g, '')

function parseDate(v: string): number | null {
  const m = v.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime()
  const d = Date.parse(v)
  return Number.isFinite(d) ? d : null
}

function relative(v: string): number | null {
  const m = v.match(/^(\d+)([dwmyh])$/i)
  if (!m) return null
  const n = Number(m[1])
  const unit = { h: 3600_000, d: 86400_000, w: 7 * 86400_000, m: 30 * 86400_000, y: 365 * 86400_000 }[m[2].toLowerCase() as 'd']
  return Date.now() - n * unit
}

function sizeBytes(v: string): number {
  const m = v.match(/^(\d+(?:\.\d+)?)([kmg]?)b?$/i)
  if (!m) return Number(v) || 0
  return Number(m[1]) * ({ '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase() as ''] || 1)
}

const DOC_EXT: Record<string, string[]> = {
  document: ['doc', 'docx', 'odt', 'rtf', 'pages', 'txt', 'md'],
  spreadsheet: ['xls', 'xlsx', 'ods', 'csv', 'numbers'],
  presentation: ['ppt', 'pptx', 'odp', 'key'],
  pdf: ['pdf'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'svg'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz'],
}

function addrClause(field: 'from' | 'to' | 'cc' | 'bcc', value: string, neg: boolean): Clause {
  const like = `%${value.toLowerCase()}%`
  let sql: string
  if (field === 'from') sql = "(LOWER(m.from_email) LIKE ? OR LOWER(COALESCE(m.from_name,'')) LIKE ?)"
  else sql = `LOWER(COALESCE(m.${field}_json,'')) LIKE ? AND ? IS NOT NULL`
  return { sql: neg ? `NOT ${sql}` : sql, params: [like, like] }
}

export function parseQuery(q: string): ParsedQuery {
  const out: ParsedQuery = { where: [], threadWhere: [], fts: [], ftsNot: [], raw: q, includeTrash: false }
  for (let tok of tokenize(q.trim())) {
    let neg = false
    if (tok.startsWith('-') && tok.length > 1) {
      neg = true
      tok = tok.slice(1)
    }
    const op = tok.match(/^([a-z_]+):(.*)$/i)
    if (!op) {
      const word = unq(tok).trim()
      if (word) (neg ? out.ftsNot : out.fts).push(word)
      continue
    }
    const key = op[1].toLowerCase()
    const val = unq(op[2]).trim()
    const v = val.toLowerCase()
    const N = (c: Clause): Clause => (neg ? { sql: `NOT (${c.sql})`, params: c.params } : c)
    switch (key) {
      case 'from':
      case 'to':
      case 'cc':
      case 'bcc':
        out.where.push(addrClause(key, val, neg))
        break
      case 'with':
        out.where.push(N({
          sql: "(LOWER(m.from_email) LIKE ? OR LOWER(COALESCE(m.to_json,'')) LIKE ? OR LOWER(COALESCE(m.cc_json,'')) LIKE ?)",
          params: [`%${v}%`, `%${v}%`, `%${v}%`],
        }))
        break
      case 'subject':
        out.where.push(N({ sql: "LOWER(COALESCE(m.subject,'')) LIKE ?", params: [`%${v}%`] }))
        break
      case 'after':
      case 'since': {
        const d = parseDate(val) ?? relative(val)
        if (d) out.where.push(N({ sql: 'm.date >= ?', params: [d] }))
        break
      }
      case 'before':
      case 'until': {
        const d = parseDate(val)
        if (d) out.where.push(N({ sql: 'm.date < ?', params: [d] }))
        break
      }
      case 'on': {
        const d = parseDate(val)
        if (d) out.where.push(N({ sql: 'm.date >= ? AND m.date < ?', params: [d, d + 86400_000] }))
        break
      }
      case 'newer_than':
      case 'newer': {
        const d = relative(val)
        if (d) out.where.push(N({ sql: 'm.date >= ?', params: [d] }))
        break
      }
      case 'older_than':
      case 'older': {
        const d = relative(val)
        if (d) out.where.push(N({ sql: 'm.date < ?', params: [d] }))
        break
      }
      case 'larger':
        out.where.push(N({ sql: 'm.size > ?', params: [sizeBytes(val)] }))
        break
      case 'smaller':
        out.where.push(N({ sql: 'm.size < ?', params: [sizeBytes(val)] }))
        break
      case 'has': {
        if (v === 'attachment' || v === 'attachments') out.where.push(N({ sql: 'm.has_attachments = 1', params: [] }))
        else if (v === 'reminder') out.threadWhere.push(N({ sql: 't.reminder_at IS NOT NULL', params: [] }))
        else if (v === 'link' || v === 'links') out.where.push(N({ sql: "EXISTS (SELECT 1 FROM bodies b WHERE b.message_id = m.id AND b.html LIKE '%href=\"http%')", params: [] }))
        else if (v === 'invite' || v === 'invitation') out.where.push(N({ sql: 'm.calendar_part IS NOT NULL', params: [] }))
        else if (DOC_EXT[v.replace(/s$/, '')] || DOC_EXT[v]) {
          const exts = DOC_EXT[v] || DOC_EXT[v.replace(/s$/, '')]
          out.where.push(N({
            sql: `EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.inline = 0 AND (${exts.map(() => 'LOWER(a.filename) LIKE ?').join(' OR ')}))`,
            params: exts.map((e) => `%.${e}`),
          }))
        }
        break
      }
      case 'filename':
        out.where.push(N({ sql: 'EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND LOWER(a.filename) LIKE ?)', params: [`%${v}%`] }))
        break
      case 'is': {
        const map: Record<string, Clause> = {
          unread: { sql: 'm.seen = 0', params: [] },
          read: { sql: 'm.seen = 1', params: [] },
          seen: { sql: 'm.seen = 1', params: [] },
          starred: { sql: 'm.flagged = 1', params: [] },
          flagged: { sql: 'm.flagged = 1', params: [] },
          answered: { sql: 'm.answered = 1', params: [] },
          replied: { sql: 'm.answered = 1', params: [] },
          unreplied: { sql: 'm.answered = 0 AND m.is_outgoing = 0', params: [] },
          sent: { sql: 'm.is_outgoing = 1', params: [] },
        }
        const tmap: Record<string, Clause> = {
          pinned: { sql: 't.pinned = 1', params: [] },
          snoozed: { sql: 't.snoozed_until > ?', params: [Date.now()] },
          muted: { sql: 't.muted = 1', params: [] },
          setaside: { sql: 't.set_aside = 1', params: [] },
          priority: { sql: 't.priority = 1', params: [] },
          blocked: { sql: BLOCKED_THREAD, params: [] },
        }
        if (map[v]) out.where.push(N(map[v]))
        else if (tmap[v]) out.threadWhere.push(N(tmap[v]))
        break
      }
      case 'category': {
        const cat = { personal: 'people', people: 'people', priority: 'people', notification: 'notification', notifications: 'notification', newsletter: 'newsletter', newsletters: 'newsletter' }[v]
        if (cat) out.threadWhere.push(N({ sql: 't.category = ?', params: [cat] }))
        else if (v === 'invitation' || v === 'invitation_response') out.where.push(N({ sql: 'm.calendar_part IS NOT NULL', params: [] }))
        break
      }
      case 'in':
      case 'folder':
      case 'label': {
        const roles = ['inbox', 'sent', 'drafts', 'trash', 'junk', 'spam', 'archive', 'all', 'blocked']
        if (v === 'anywhere') {
          out.includeTrash = true
        } else if (roles.includes(v)) {
          const role = v === 'spam' ? 'junk' : v
          if (role === 'trash' || role === 'junk' || role === 'blocked') out.includeTrash = true
          out.where.push(N({ sql: 'f.role = ?', params: [role] }))
        } else if (val.includes('@') && !val.includes(':')) {
          out.where.push(N({ sql: 'm.account_id = (SELECT id FROM accounts WHERE email = ? COLLATE NOCASE)', params: [v] }))
        } else {
          // "account@x.com:Folder/Path" or a bare folder/label name
          const [accPart, folderPart] = val.includes('@') && val.includes(':') ? [val.slice(0, val.indexOf(':')), val.slice(val.indexOf(':') + 1)] : [null, val]
          out.where.push(N({
            sql: `(m.folder_id IN (SELECT fo.id FROM folders fo JOIN accounts ac ON ac.id = fo.account_id
                    WHERE (LOWER(fo.path) = ? OR LOWER(fo.name) = ?) ${accPart ? 'AND ac.email = ? COLLATE NOCASE' : ''})
                   OR LOWER(COALESCE(m.gm_labels,'')) LIKE ?)`,
            params: [folderPart.toLowerCase(), folderPart.toLowerCase(), ...(accPart ? [accPart] : []), `%"${folderPart.toLowerCase()}"%`],
          }))
          if (/trash|kosz|spam|junk/i.test(folderPart)) out.includeTrash = true
        }
        break
      }
      case 'account':
        out.where.push(N({ sql: 'm.account_id = (SELECT id FROM accounts WHERE email = ? COLLATE NOCASE)', params: [v] }))
        break
      case 'list':
        out.where.push(N({ sql: "LOWER(COALESCE(m.list_id,'')) LIKE ?", params: [`%${v}%`] }))
        break
      case 'id':
        out.where.push(N({ sql: 'm.id = ?', params: [Number(val)] }))
        break
      case 'thread':
        out.where.push(N({ sql: 'm.thread_id = ?', params: [Number(val)] }))
        break
      default:
        // unknown operator: treat the whole token as text
        out.fts.push(tok)
    }
  }
  return out
}

function ftsEscape(word: string): string {
  return `"${fold(word).replace(/"/g, '""')}"`
}

export function ftsExpression(words: string[], not: string[]): string | null {
  if (!words.length) return null
  const parts = words.map((w, i) => {
    const phrase = w.includes(' ')
    // prefix-match the last bare word so "faktur" finds "faktura"
    return phrase || i < words.length - 1 ? ftsEscape(w) : `${ftsEscape(w)}*`
  })
  let expr = parts.join(' AND ')
  if (not.length) expr += ' ' + not.map((w) => `NOT ${ftsEscape(w)}`).join(' ')
  return expr
}

export function buildSearchScope(q: string, accountId?: number | null): { where: string; params: unknown[]; threadWhere: string; threadParams: unknown[] } {
  const p = parseQuery(q)
  const where: string[] = []
  const params: unknown[] = []
  if (!p.includeTrash) where.push("(f.role IS NULL OR f.role NOT IN ('trash','junk','blocked'))")
  if (accountId) {
    where.push('m.account_id = ?')
    params.push(accountId)
  }
  for (const c of p.where) {
    where.push(c.sql)
    params.push(...c.params)
  }
  const expr = ftsExpression(p.fts, p.ftsNot)
  if (expr) {
    where.push('m.id IN (SELECT rowid FROM fts WHERE fts MATCH ?)')
    params.push(expr)
  } else if (p.ftsNot.length) {
    where.push(`m.id NOT IN (SELECT rowid FROM fts WHERE fts MATCH ?)`)
    params.push(p.ftsNot.map(ftsEscape).join(' OR '))
  }
  const threadWhere = p.threadWhere.map((c) => c.sql).join(' AND ') || '1 = 1'
  const threadParams = p.threadWhere.flatMap((c) => c.params)
  return { where: where.join(' AND ') || '1 = 1', params, threadWhere, threadParams }
}

export function searchThreads(q: string, opts: { accountId?: number | null; limit?: number; offset?: number; order?: 'asc' | 'desc' } = {}): SearchResult {
  const scope = buildSearchScope(q, opts.accountId)
  const threads = listThreadsByScope(scope, `h.d ${opts.order === 'asc' ? 'ASC' : 'DESC'}`, { limit: opts.limit ?? 50, offset: opts.offset ?? 0 })
  const total = get<{ n: number }>(
    `SELECT COUNT(DISTINCT m.thread_id) n FROM messages m JOIN folders f ON f.id = m.folder_id JOIN threads t ON t.id = m.thread_id
     WHERE m.hidden = 0 AND (${scope.where}) AND ${scope.threadWhere}`,
    ...scope.params,
    ...scope.threadParams,
  )?.n || 0
  return { threads, total }
}

/** Message-level search (used by CLI/MCP/AI which want individual e-mails, not conversations). */
export function searchMessages(q: string, opts: { accountId?: number | null; limit?: number; offset?: number; order?: 'asc' | 'desc' } = {}): Row[] {
  const scope = buildSearchScope(q, opts.accountId)
  return all(
    `SELECT m.id, m.thread_id, m.account_id, a.email account_email, f.path folder_path, f.role folder_role,
            m.subject, m.from_name, m.from_email, m.to_json, m.cc_json, m.date, m.seen, m.flagged, m.answered,
            m.has_attachments, m.snippet, m.category, m.is_outgoing, m.body_state
     FROM messages m JOIN folders f ON f.id = m.folder_id JOIN threads t ON t.id = m.thread_id JOIN accounts a ON a.id = m.account_id
     WHERE m.hidden = 0 AND (${scope.where}) AND ${scope.threadWhere}
     GROUP BY COALESCE(m.gm_msgid, m.msgid, m.id)
     ORDER BY m.date ${opts.order === 'asc' ? 'ASC' : 'DESC'}
     LIMIT ? OFFSET ?`,
    ...scope.params,
    ...scope.threadParams,
    opts.limit ?? 50,
    opts.offset ?? 0,
  )
}

export function threadsForMessages(rows: Row[]): ThreadSummary[] {
  const ids = [...new Set(rows.map((r) => r.thread_id))]
  if (!ids.length) return []
  return summarize(all(`SELECT t.*, t.last_date d, 0 unread_hits FROM threads t WHERE t.id IN (${ids.map(() => '?').join(',')}) ORDER BY t.last_date DESC`, ...ids))
}
