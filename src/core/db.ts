import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { dbPath } from './paths'

// node:sqlite prints an ExperimentalWarning once per process; it is noise for CLI users.
const origEmit = process.emitWarning
process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
  const msg = typeof warning === 'string' ? warning : warning?.message
  if (msg && msg.includes('SQLite is an experimental feature')) return
  return (origEmit as (...a: unknown[]) => void).call(process, warning, ...rest)
} as typeof process.emitWarning

export type Row = Record<string, any>
type Param = string | number | bigint | null | Uint8Array

const MIGRATIONS: string[] = [
  /* 1 */ `
  CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE accounts(
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT 'imap',
    auth TEXT NOT NULL DEFAULT 'password',
    username TEXT NOT NULL,
    imap_host TEXT NOT NULL, imap_port INTEGER NOT NULL DEFAULT 993, imap_secure INTEGER NOT NULL DEFAULT 1,
    smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL DEFAULT 465, smtp_secure INTEGER NOT NULL DEFAULT 1,
    color TEXT, sort INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
    agent_access TEXT NOT NULL DEFAULT 'read',
    sync_days INTEGER NOT NULL DEFAULT 90,
    is_gmail INTEGER NOT NULL DEFAULT 0,
    notify TEXT NOT NULL DEFAULT 'smart',
    capabilities TEXT, last_error TEXT, last_sync INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE identities(
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
    signature_id INTEGER, is_default INTEGER NOT NULL DEFAULT 0, reply_to TEXT
  );

  CREATE TABLE folders(
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    path TEXT NOT NULL, name TEXT NOT NULL, delimiter TEXT, parent_path TEXT,
    role TEXT, flags TEXT, subscribed INTEGER NOT NULL DEFAULT 1, selectable INTEGER NOT NULL DEFAULT 1,
    uidvalidity TEXT, uidnext INTEGER, highest_modseq TEXT, min_uid INTEGER, max_uid INTEGER,
    total INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0,
    sync_mode TEXT NOT NULL DEFAULT 'auto',
    last_sync INTEGER, last_opened INTEGER, oldest_synced INTEGER, fully_synced INTEGER NOT NULL DEFAULT 0,
    UNIQUE(account_id, path)
  );

  CREATE TABLE threads(
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    gm_thrid TEXT, subject TEXT, last_date INTEGER,
    category TEXT,
    pinned INTEGER NOT NULL DEFAULT 0, muted INTEGER NOT NULL DEFAULT 0,
    snoozed_until INTEGER, set_aside INTEGER NOT NULL DEFAULT 0,
    done_at INTEGER, reminder_at INTEGER, reminder_kind TEXT, reminder_ref INTEGER,
    resurfaced_at INTEGER, priority INTEGER NOT NULL DEFAULT 0, note TEXT
  );
  CREATE UNIQUE INDEX threads_gm ON threads(account_id, gm_thrid) WHERE gm_thrid IS NOT NULL;
  CREATE INDEX threads_snooze ON threads(snoozed_until) WHERE snoozed_until IS NOT NULL;
  CREATE INDEX threads_reminder ON threads(reminder_at) WHERE reminder_at IS NOT NULL;

  CREATE TABLE thread_refs(
    account_id INTEGER NOT NULL, msgid TEXT NOT NULL, thread_id INTEGER NOT NULL,
    PRIMARY KEY(account_id, msgid)
  ) WITHOUT ROWID;
  CREATE INDEX thread_refs_thread ON thread_refs(thread_id);

  CREATE TABLE messages(
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    folder_id INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
    uid INTEGER NOT NULL,
    thread_id INTEGER,
    msgid TEXT, in_reply_to TEXT, refs TEXT,
    gm_msgid TEXT, gm_thrid TEXT, gm_labels TEXT,
    subject TEXT, from_name TEXT, from_email TEXT,
    to_json TEXT, cc_json TEXT, bcc_json TEXT, reply_to_json TEXT,
    date INTEGER, internal_date INTEGER, size INTEGER,
    seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0,
    answered INTEGER NOT NULL DEFAULT 0, draft INTEGER NOT NULL DEFAULT 0,
    keywords TEXT, snippet TEXT,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    structure TEXT, body_state INTEGER NOT NULL DEFAULT 0,
    category TEXT, is_outgoing INTEGER NOT NULL DEFAULT 0,
    list_unsubscribe TEXT, list_unsubscribe_post TEXT, list_id TEXT,
    auto_submitted TEXT, precedence TEXT, calendar_part TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    UNIQUE(folder_id, uid)
  );
  CREATE INDEX messages_folder_date ON messages(folder_id, date DESC);
  CREATE INDEX messages_thread ON messages(thread_id, date);
  CREATE INDEX messages_msgid ON messages(account_id, msgid);
  CREATE INDEX messages_from ON messages(from_email COLLATE NOCASE);
  CREATE INDEX messages_date ON messages(date DESC);

  CREATE TABLE bodies(
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    html TEXT, text TEXT, fetched_at INTEGER
  );

  CREATE TABLE attachments(
    id INTEGER PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    part TEXT NOT NULL, filename TEXT, mime TEXT, size INTEGER, encoding TEXT,
    content_id TEXT, inline INTEGER NOT NULL DEFAULT 0, path TEXT,
    UNIQUE(message_id, part)
  );
  CREATE INDEX attachments_name ON attachments(filename COLLATE NOCASE);

  CREATE VIRTUAL TABLE fts USING fts5(
    subject, people, body, files,
    tokenize = 'unicode61 remove_diacritics 2', content = '', contentless_delete = 1
  );

  CREATE TABLE contacts(
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT, status TEXT NOT NULL DEFAULT 'unknown',
    category TEXT, vip INTEGER NOT NULL DEFAULT 0,
    notes TEXT, phone TEXT, company TEXT,
    sent_count INTEGER NOT NULL DEFAULT 0, recv_count INTEGER NOT NULL DEFAULT 0,
    last_sent INTEGER, last_received INTEGER,
    source TEXT NOT NULL DEFAULT 'auto', remote_href TEXT, etag TEXT,
    updated_at INTEGER
  );

  CREATE TABLE drafts(
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    from_email TEXT, from_name TEXT,
    to_json TEXT, cc_json TEXT, bcc_json TEXT,
    subject TEXT, html TEXT, text TEXT, attachments_json TEXT,
    reply_to_message_id INTEGER, forward_of_message_id INTEGER, reply_kind TEXT,
    thread_id INTEGER, in_reply_to TEXT, refs TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    send_at INTEGER, sent_at INTEGER, error TEXT,
    remind_at INTEGER, remind_kind TEXT,
    msgid TEXT, imap_uid INTEGER, imap_folder_id INTEGER,
    signature INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'ui',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX drafts_status ON drafts(status, send_at);

  CREATE TABLE ops(
    id INTEGER PRIMARY KEY,
    account_id INTEGER,
    kind TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
    run_after INTEGER NOT NULL DEFAULT 0,
    lock_owner TEXT, lock_at INTEGER,
    actor TEXT NOT NULL DEFAULT 'ui',
    created_at INTEGER NOT NULL, finished_at INTEGER
  );
  CREATE INDEX ops_pending ON ops(status, run_after);

  CREATE TABLE templates(
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, subject TEXT, html TEXT,
    to_json TEXT, cc_json TEXT, bcc_json TEXT, account_id INTEGER,
    shortcut TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );

  CREATE TABLE signatures(
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, html TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );

  CREATE TABLE rules(
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    match TEXT NOT NULL DEFAULT 'all', conditions TEXT NOT NULL, actions TEXT NOT NULL,
    stop INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE smart_folders(
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, query TEXT NOT NULL, icon TEXT,
    sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
  );

  CREATE TABLE history(
    id INTEGER PRIMARY KEY, at INTEGER NOT NULL, actor TEXT NOT NULL,
    action TEXT NOT NULL, target TEXT, details TEXT, ok INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX history_at ON history(at DESC);

  CREATE TABLE ai_cache(key TEXT PRIMARY KEY, value TEXT NOT NULL, created_at INTEGER NOT NULL);

  CREATE TABLE cal_sources(
    id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, url TEXT, username TEXT, name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1, last_sync INTEGER, last_error TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE calendars(
    id INTEGER PRIMARY KEY, source_id INTEGER NOT NULL REFERENCES cal_sources(id) ON DELETE CASCADE,
    remote_url TEXT, name TEXT NOT NULL, color TEXT, ctag TEXT, sync_token TEXT,
    readonly INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, is_default INTEGER NOT NULL DEFAULT 0,
    timezone TEXT, UNIQUE(source_id, remote_url)
  );
  CREATE TABLE events(
    id INTEGER PRIMARY KEY, calendar_id INTEGER NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    uid TEXT NOT NULL, href TEXT, etag TEXT,
    summary TEXT, description TEXT, location TEXT,
    start INTEGER NOT NULL, end INTEGER NOT NULL, all_day INTEGER NOT NULL DEFAULT 0, tzid TEXT,
    recurring INTEGER NOT NULL DEFAULT 0, status TEXT, organizer TEXT, attendees TEXT,
    my_status TEXT, conference_url TEXT, ics TEXT, local_dirty INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    UNIQUE(calendar_id, uid)
  );
  CREATE INDEX events_range ON events(start, end);
  `,
  /* 2 — partial indexes for sidebar counters on large mailboxes */ `
  CREATE INDEX IF NOT EXISTS threads_pinned ON threads(pinned) WHERE pinned = 1;
  CREATE INDEX IF NOT EXISTS threads_aside ON threads(set_aside) WHERE set_aside = 1;
  CREATE INDEX IF NOT EXISTS messages_unread ON messages(folder_id, thread_id) WHERE seen = 0 AND hidden = 0;
  `,
]

let _db: DatabaseSync | null = null
const stmtCache = new Map<string, StatementSync>()

export function db(): DatabaseSync {
  if (_db) return _db
  const d = new DatabaseSync(dbPath())
  d.exec('PRAGMA journal_mode = WAL')
  d.exec('PRAGMA synchronous = NORMAL')
  d.exec('PRAGMA foreign_keys = ON')
  d.exec('PRAGMA busy_timeout = 8000')
  migrate(d)
  _db = d
  return d
}

export function openDbAt(file: string): DatabaseSync {
  closeDb()
  const d = new DatabaseSync(file)
  d.exec('PRAGMA journal_mode = WAL')
  d.exec('PRAGMA foreign_keys = ON')
  d.exec('PRAGMA busy_timeout = 8000')
  migrate(d)
  _db = d
  return d
}

export function closeDb(): void {
  stmtCache.clear()
  if (_db) {
    try { _db.close() } catch { /* already closed */ }
  }
  _db = null
}

function migrate(d: DatabaseSync): void {
  const row = d.prepare('PRAGMA user_version').get() as Row
  let version = Number(row.user_version) || 0
  while (version < MIGRATIONS.length) {
    d.exec('BEGIN')
    try {
      d.exec(MIGRATIONS[version])
      version++
      d.exec(`PRAGMA user_version = ${version}`)
      d.exec('COMMIT')
    } catch (e) {
      d.exec('ROLLBACK')
      throw e
    }
  }
}

function clean(params: unknown[]): Param[] {
  return params.map((p) => {
    if (p === undefined) return null
    if (typeof p === 'boolean') return p ? 1 : 0
    if (p instanceof Date) return p.getTime()
    if (p !== null && typeof p === 'object' && !(p instanceof Uint8Array)) return JSON.stringify(p)
    return p as Param
  })
}

function stmt(sql: string): StatementSync {
  let s = stmtCache.get(sql)
  if (!s) {
    s = db().prepare(sql)
    stmtCache.set(sql, s)
  }
  return s
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return stmt(sql).get(...clean(params)) as T | undefined
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return stmt(sql).all(...clean(params)) as T[]
}

export function run(sql: string, ...params: unknown[]): { changes: number; lastInsertRowid: number } {
  const r = stmt(sql).run(...clean(params))
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
}

export function exec(sql: string): void {
  db().exec(sql)
}

let txDepth = 0
/** Runs fn inside a transaction (nested calls join the outer one). */
export function tx<T>(fn: () => T): T {
  if (txDepth > 0) return fn()
  db().exec('BEGIN IMMEDIATE')
  txDepth++
  try {
    const r = fn()
    txDepth--
    db().exec('COMMIT')
    return r
  } catch (e) {
    txDepth--
    try { db().exec('ROLLBACK') } catch { /* nothing to roll back */ }
    throw e
  }
}

/** Build "INSERT ... (cols) VALUES (?...)" from an object. */
export function insert(table: string, obj: Record<string, unknown>): number {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined)
  const sql = `INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`
  return run(sql, ...keys.map((k) => obj[k])).lastInsertRowid
}

export function update(table: string, id: number, obj: Record<string, unknown>): void {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined)
  if (!keys.length) return
  run(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => obj[k]), id)
}

export function inList(values: unknown[]): string {
  return values.map(() => '?').join(',') || 'NULL'
}

export const now = (): number => Date.now()

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}
