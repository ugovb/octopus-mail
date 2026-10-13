import { ImapFlow, type ImapFlowOptions } from 'imapflow'
import nodemailer from 'nodemailer'
import type { Account, AccountInput, AgentAccess, AuthKind } from '../shared/types'
import { all, get, insert, now, run, type Row, update } from './db'
import { bus } from './events'
import { getAccessToken, type OAuthTokens, saveTokens } from './oauth'
import { discover, PRESETS } from './providers'
import { accountSecretKey, deleteSecret, getSecret, oauthSecretKey, setSecret } from './secrets'

const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316']

export function rowToAccount(r: Row): Account {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    provider: r.provider,
    auth: r.auth,
    username: r.username,
    imap_host: r.imap_host,
    imap_port: r.imap_port,
    imap_secure: !!r.imap_secure,
    smtp_host: r.smtp_host,
    smtp_port: r.smtp_port,
    smtp_secure: !!r.smtp_secure,
    color: r.color,
    sort: r.sort,
    enabled: !!r.enabled,
    agent_access: r.agent_access,
    sync_days: r.sync_days,
    is_gmail: !!r.is_gmail,
    notify: r.notify,
    last_error: r.last_error,
    last_sync: r.last_sync,
  }
}

export function listAccounts(includeDisabled = true): Account[] {
  const rows = all('SELECT * FROM accounts ORDER BY sort, id')
  return rows.map(rowToAccount).filter((a) => includeDisabled || a.enabled)
}

export function getAccount(id: number): Account {
  const r = get('SELECT * FROM accounts WHERE id = ?', id)
  if (!r) throw new Error(`Nie ma konta o id ${id}`)
  return rowToAccount(r)
}

/** Resolve an account by id, e-mail address or identity/alias address. */
export function findAccount(ref: string | number): Account | null {
  if (typeof ref === 'number' || /^\d+$/.test(String(ref))) {
    const r = get('SELECT * FROM accounts WHERE id = ?', Number(ref))
    return r ? rowToAccount(r) : null
  }
  const r =
    get('SELECT * FROM accounts WHERE email = ? COLLATE NOCASE', ref) ||
    get(
      'SELECT a.* FROM accounts a JOIN identities i ON i.account_id = a.id WHERE i.email = ? COLLATE NOCASE',
      ref,
    )
  return r ? rowToAccount(r) : null
}

export async function imapAuth(acc: Account): Promise<ImapFlowOptions['auth']> {
  if (acc.auth === 'password') {
    const pass = getSecret(accountSecretKey(acc.id))
    if (!pass) throw new Error(`Brak zapisanego hasła dla ${acc.email}`)
    return { user: acc.username, pass }
  }
  return { user: acc.username, accessToken: await getAccessToken(acc.id) }
}

export async function smtpAuth(acc: Account): Promise<Record<string, unknown>> {
  if (acc.auth === 'password') {
    const pass = getSecret(accountSecretKey(acc.id))
    if (!pass) throw new Error(`Brak zapisanego hasła dla ${acc.email}`)
    return { user: acc.username, pass }
  }
  return { type: 'OAuth2', user: acc.username, accessToken: await getAccessToken(acc.id) }
}

/** nodemailer transport options for an account (shared by sending, unsubscribe, invites). */
export async function smtpTransportOptions(acc: Account): Promise<Record<string, unknown>> {
  return {
    host: acc.smtp_host,
    port: acc.smtp_port,
    secure: acc.smtp_secure,
    auth: await smtpAuth(acc),
    connectionTimeout: 30_000,
    tls: { rejectUnauthorized: process.env.OCTO_INSECURE_TLS !== '1' },
  }
}

export function imapOptions(
  acc: Pick<Account, 'imap_host' | 'imap_port' | 'imap_secure'>,
  auth: ImapFlowOptions['auth'],
): ImapFlowOptions {
  return {
    host: acc.imap_host,
    port: acc.imap_port,
    secure: acc.imap_secure,
    auth,
    logger: false,
    emitLogs: false,
    qresync: false,
    connectionTimeout: 30_000,
    greetingTimeout: 20_000,
    socketTimeout: 5 * 60_000,
    tls: { rejectUnauthorized: process.env.OCTO_INSECURE_TLS !== '1' },
  }
}

export interface TestResult {
  ok: boolean
  imap?: string
  smtp?: string
  error?: string
  is_gmail?: boolean
}

/** Logs in over IMAP and verifies SMTP without saving anything. */
export async function testConnection(cfg: {
  imap_host: string
  imap_port: number
  imap_secure: boolean
  smtp_host: string
  smtp_port: number
  smtp_secure: boolean
  username: string
  password?: string
  accessToken?: string
}): Promise<TestResult> {
  const auth = cfg.accessToken ? { user: cfg.username, accessToken: cfg.accessToken } : { user: cfg.username, pass: cfg.password || '' }
  const result: TestResult = { ok: false }
  const client = new ImapFlow(imapOptions(cfg, auth))
  try {
    await client.connect()
    result.imap = 'ok'
    result.is_gmail = client.capabilities.has('X-GM-EXT-1')
  } catch (e) {
    const err = e as Error & { responseText?: string; authenticationFailed?: boolean }
    result.error = `IMAP: ${err.authenticationFailed ? 'błędny login lub hasło' : err.responseText || err.message}`
    return result
  } finally {
    try { await client.logout() } catch { /* ignore */ }
  }
  try {
    const transport = nodemailer.createTransport({
      host: cfg.smtp_host,
      port: cfg.smtp_port,
      secure: cfg.smtp_secure,
      auth: cfg.accessToken
        ? { type: 'OAuth2', user: cfg.username, accessToken: cfg.accessToken }
        : { user: cfg.username, pass: cfg.password || '' },
      connectionTimeout: 20_000,
      tls: { rejectUnauthorized: process.env.OCTO_INSECURE_TLS !== '1' },
    } as nodemailer.TransportOptions)
    await transport.verify()
    result.smtp = 'ok'
  } catch (e) {
    result.error = `SMTP: ${(e as Error).message}`
    return result
  }
  result.ok = true
  return result
}

export async function addAccount(
  input: AccountInput & { oauthTokens?: OAuthTokens; skipTest?: boolean },
): Promise<Account> {
  const email = input.email.trim().toLowerCase()
  if (findAccount(email)) throw new Error(`Konto ${email} już istnieje`)
  let cfg = input.imap_host ? null : await discover(email)
  if (input.provider && PRESETS[input.provider] && !input.imap_host) cfg = { ...PRESETS[input.provider] }
  const merged = {
    imap_host: input.imap_host || cfg?.imap_host || '',
    imap_port: input.imap_port ?? cfg?.imap_port ?? 993,
    imap_secure: input.imap_secure ?? cfg?.imap_secure ?? true,
    smtp_host: input.smtp_host || cfg?.smtp_host || '',
    smtp_port: input.smtp_port ?? cfg?.smtp_port ?? 465,
    smtp_secure: input.smtp_secure ?? cfg?.smtp_secure ?? true,
  }
  if (!merged.imap_host || !merged.smtp_host) throw new Error('Podaj adresy serwerów IMAP i SMTP.')
  const auth: AuthKind = input.auth || (input.oauthTokens ? (input.oauthTokens.provider === 'google' ? 'oauth-google' : 'oauth-microsoft') : 'password')
  const username = input.username || email

  let isGmail = !!cfg?.is_gmail
  if (!input.skipTest) {
    const t = await testConnection({
      ...merged,
      username,
      password: input.password,
      accessToken: input.oauthTokens?.access_token,
    })
    if (!t.ok) throw new Error(t.error || 'Nie udało się połączyć')
    isGmail = isGmail || !!t.is_gmail
  }

  const count = (get('SELECT COUNT(*) n FROM accounts') as Row).n as number
  const id = insert('accounts', {
    email,
    name: input.name || email.split('@')[0],
    provider: input.provider || cfg?.provider || 'imap',
    auth,
    username,
    ...merged,
    color: input.color || COLORS[count % COLORS.length],
    sort: count,
    sync_days: input.sync_days ?? 90,
    is_gmail: isGmail,
    agent_access: 'read',
    created_at: now(),
  })
  if (input.password) setSecret(accountSecretKey(id), input.password)
  if (input.oauthTokens) saveTokens(id, input.oauthTokens)
  insert('identities', { account_id: id, email, name: input.name || '', is_default: 1 })
  bus.emitEvent({ type: 'mailbox-changed', accountId: id })
  return getAccount(id)
}

export function updateAccount(
  id: number,
  patch: Partial<Account> & { password?: string },
): Account {
  const { password, id: _ignore, ...rest } = patch as Record<string, unknown> & { password?: string }
  const allowed = [
    'name', 'color', 'sort', 'enabled', 'agent_access', 'sync_days', 'notify', 'username',
    'imap_host', 'imap_port', 'imap_secure', 'smtp_host', 'smtp_port', 'smtp_secure',
  ]
  const clean: Record<string, unknown> = {}
  for (const k of allowed) if (k in rest) clean[k] = rest[k]
  update('accounts', id, clean)
  if (password) setSecret(accountSecretKey(id), password)
  if (clean.name !== undefined) run('UPDATE identities SET name = ? WHERE account_id = ? AND is_default = 1', clean.name, id)
  bus.emitEvent({ type: 'mailbox-changed', accountId: id })
  return getAccount(id)
}

export function setAgentAccess(id: number, level: AgentAccess): Account {
  return updateAccount(id, { agent_access: level })
}

export function removeAccount(id: number): void {
  run('DELETE FROM fts WHERE rowid IN (SELECT id FROM messages WHERE account_id = ?)', id)
  run('DELETE FROM thread_refs WHERE account_id = ?', id)
  run('DELETE FROM accounts WHERE id = ?', id)
  deleteSecret(accountSecretKey(id))
  deleteSecret(oauthSecretKey(id))
  bus.emitEvent({ type: 'mailbox-changed' })
}

export function listIdentities(accountId?: number): Row[] {
  return accountId
    ? all('SELECT * FROM identities WHERE account_id = ? ORDER BY is_default DESC, id', accountId)
    : all('SELECT i.*, a.color FROM identities i JOIN accounts a ON a.id = i.account_id ORDER BY a.sort, i.is_default DESC')
}

export function addIdentity(accountId: number, email: string, name = ''): void {
  insert('identities', { account_id: accountId, email: email.toLowerCase(), name, is_default: 0 })
}

export function removeIdentity(id: number): void {
  run('DELETE FROM identities WHERE id = ? AND is_default = 0', id)
}

/** All addresses that belong to the user (for detecting outgoing mail and "me"). */
export function myAddresses(): Set<string> {
  const rows = all<{ email: string }>('SELECT email FROM identities UNION SELECT email FROM accounts')
  return new Set(rows.map((r) => r.email.toLowerCase()))
}
