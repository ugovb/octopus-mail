// Calendar sources: Google (OAuth account), CalDAV (iCloud, Fastmail, Nextcloud…),
// ICS subscriptions (read-only) and the local calendar.
import { findAccount, getAccount, listAccounts } from '../accounts'
import { all, get, insert, now, run, tx } from '../db'
import { log } from '../events'
import { record } from '../history'
import { getAccessToken } from '../oauth'
import { calSourceSecretKey, deleteSecret, secretStoreName, setSecret } from '../secrets'
import { normalizeFeedUrl, fetchFeed, importFeed, syncCalendars, upsertRemoteCalendars } from './calsync'
import { clientFor, connectDav, dropClient, FASTMAIL_CALDAV, GOOGLE_CALDAV, ICLOUD_CALDAV, listRemoteCalendars } from './dav'
import { parseIcs } from './ical'
import { type CalRow, DEFAULT_COLOR, ensureDefaultCalendar, getSource, notifyChanged, type SourceKind, type SourceRow } from './store'

export interface CalendarSourceInput {
  kind: SourceKind
  accountId?: number
  url?: string
  username?: string
  password?: string
  name?: string
}

export interface CalendarSourceInfo {
  id: number
  kind: SourceKind
  account_id: number | null
  url: string | null
  username: string | null
  name: string
  enabled: boolean
  last_sync: number | null
  last_error: string | null
  calendars: number
  created_at: number
}

export const LOCAL_CALENDAR_NAME = 'Mój kalendarz'

export function listCalendarSources(): CalendarSourceInfo[] {
  return all<SourceRow & { n: number }>(
    'SELECT s.*, (SELECT COUNT(*) FROM calendars c WHERE c.source_id = s.id) AS n FROM cal_sources s ORDER BY s.id',
  ).map((s) => ({
    id: s.id,
    kind: s.kind,
    account_id: s.account_id,
    url: s.url,
    username: s.username,
    name: s.name,
    enabled: !!s.enabled,
    last_sync: s.last_sync,
    last_error: s.last_error,
    calendars: s.n,
    created_at: s.created_at,
  }))
}

function backgroundSync(id: number): void {
  void syncCalendars(id).catch((e) => log('calendar', `initial sync of source ${id} failed:`, (e as Error).message))
}

/** Known providers: the CalDAV server URL for a username or a short alias ("icloud", "fastmail"). */
export function caldavServerFor(url: string | undefined, username: string | undefined): { url: string; label: string } | null {
  const u = (url || '').trim()
  const lower = u.toLowerCase()
  const domain = (username || '').toLowerCase().split('@')[1] || ''
  if (lower === 'icloud' || lower.includes('icloud.com') || (!u && /^(icloud|me|mac)\.com$/.test(domain))) return { url: ICLOUD_CALDAV, label: 'iCloud' }
  if (lower === 'fastmail' || lower.includes('fastmail.com') || (!u && /^(fastmail\.(com|fm)|messagingengine\.com)$/.test(domain))) {
    return { url: lower.includes('fastmail.com') && lower.startsWith('http') ? u : FASTMAIL_CALDAV, label: 'Fastmail' }
  }
  if (lower === 'google' || lower.includes('googleusercontent.com')) return { url: GOOGLE_CALDAV, label: 'Google' }
  if (!u) return null
  const full = /^https?:\/\//i.test(u) ? u : `https://${u}`
  try {
    return { url: new URL(full).href, label: new URL(full).hostname }
  } catch {
    throw new Error('Nieprawidłowy adres serwera CalDAV.')
  }
}

function addLocal(name?: string): number {
  const existing = get<{ id: number }>("SELECT id FROM cal_sources WHERE kind = 'local' ORDER BY id LIMIT 1")
  if (existing) {
    const has = get('SELECT 1 FROM calendars WHERE source_id = ? LIMIT 1', existing.id)
    if (!has) {
      run(
        'INSERT INTO calendars(source_id, remote_url, name, color, readonly, enabled, is_default) VALUES (?, ?, ?, ?, 0, 1, 0)',
        existing.id,
        'local:default',
        LOCAL_CALENDAR_NAME,
        DEFAULT_COLOR,
      )
      ensureDefaultCalendar()
    }
    return existing.id
  }
  return tx(() => {
    const id = insert('cal_sources', { kind: 'local', name: name?.trim() || 'Na tym komputerze', enabled: 1, created_at: now() })
    const calId = insert('calendars', {
      source_id: id,
      remote_url: 'local:default',
      name: LOCAL_CALENDAR_NAME,
      color: DEFAULT_COLOR,
      readonly: 0,
      enabled: 1,
      is_default: 0,
    })
    ensureDefaultCalendar([calId])
    return id
  })
}

async function addGoogle(input: CalendarSourceInput): Promise<number> {
  if (!input.accountId) throw new Error('Wybierz konto Google, którego kalendarz chcesz dodać.')
  const acc = getAccount(input.accountId)
  if (acc.auth !== 'oauth-google') throw new Error('Kalendarz Google wymaga konta Google zalogowanego przez OAuth (Ustawienia → Konta).')
  const existing = get<{ id: number }>("SELECT id FROM cal_sources WHERE kind = 'google' AND account_id = ?", acc.id)
  if (existing) return existing.id
  await getAccessToken(acc.id) // fails early (Polish message) when the account has no usable token
  const id = insert('cal_sources', { account_id: acc.id, kind: 'google', url: GOOGLE_CALDAV, username: acc.email, name: input.name?.trim() || `Google (${acc.email})`, enabled: 1, created_at: now() })
  try {
    const src = getSource(id)!
    const remote = await listRemoteCalendars(src, await clientFor(src))
    upsertRemoteCalendars(src, remote)
  } catch (e) {
    run('DELETE FROM cal_sources WHERE id = ?', id)
    dropClient(id)
    throw e
  }
  return id
}

async function addCaldav(input: CalendarSourceInput): Promise<number> {
  const server = caldavServerFor(input.url, input.username)
  if (!server) throw new Error('Podaj adres serwera CalDAV (np. https://serwer/remote.php/dav dla Nextcloud).')
  const username = (input.username || '').trim()
  const password = input.password || ''
  if (!username) throw new Error('Podaj nazwę użytkownika (zwykle adres e-mail).')
  if (!password) throw new Error('Podaj hasło (dla iCloud: hasło dla aplikacji z appleid.apple.com).')
  if (get("SELECT 1 FROM cal_sources WHERE kind = 'caldav' AND url = ? AND username = ? COLLATE NOCASE", server.url, username)) {
    throw new Error(`Kalendarz ${username} na ${server.label} jest już dodany.`)
  }
  const client = await connectDav({ serverUrl: server.url, username, password })
  const accountId = input.accountId ?? findAccount(username)?.id ?? null
  const id = insert('cal_sources', {
    account_id: accountId,
    kind: 'caldav',
    url: server.url,
    username,
    name: input.name?.trim() || `${server.label} (${username})`,
    enabled: 1,
    created_at: now(),
  })
  try {
    const src = getSource(id)!
    const remote = await listRemoteCalendars(src, { client, key: '', at: Date.now(), primaryOnly: false })
    if (!remote.length) throw new Error('Na tym koncie nie znaleziono żadnych kalendarzy z wydarzeniami.')
    try {
      setSecret(calSourceSecretKey(id), password)
    } catch (e) {
      throw new Error(`Nie udało się zapisać hasła ${secretStoreName()}: ${(e as Error).message}`)
    }
    upsertRemoteCalendars(src, remote)
  } catch (e) {
    run('DELETE FROM cal_sources WHERE id = ?', id)
    deleteSecret(calSourceSecretKey(id))
    throw e
  }
  return id
}

async function addIcs(input: CalendarSourceInput): Promise<number> {
  if (!input.url?.trim()) throw new Error('Podaj adres subskrypcji kalendarza (link .ics lub webcal://).')
  const url = normalizeFeedUrl(input.url)
  const existing = get<{ id: number }>("SELECT id FROM cal_sources WHERE kind = 'ics' AND url = ?", url)
  if (existing) return existing.id
  const feed = await fetchFeed(url)
  const vcal = parseIcs(feed.body)
  const feedName = String(vcal.getFirstPropertyValue('x-wr-calname') ?? '').trim()
  const color = String(vcal.getFirstPropertyValue('x-apple-calendar-color') ?? '').trim()
  const name = input.name?.trim() || feedName || new URL(url).hostname
  const { id, calId } = tx(() => {
    const id = insert('cal_sources', { account_id: input.accountId ?? null, kind: 'ics', url, name, enabled: 1, created_at: now() })
    const calId = insert('calendars', {
      source_id: id,
      remote_url: url,
      name,
      color: /^#[0-9a-f]{6}/i.test(color) ? color.slice(0, 7).toLowerCase() : '#8b5cf6',
      readonly: 1,
      enabled: 1,
      is_default: 0,
    })
    return { id, calId }
  })
  const cal = get<CalRow>('SELECT * FROM calendars WHERE id = ?', calId)!
  importFeed(cal, feed.body)
  run('UPDATE cal_sources SET last_sync = ? WHERE id = ?', now(), id)
  return id
}

/**
 * Add a calendar source after validating it (connect + discover calendars / fetch the feed).
 * Passwords go to the operating system's secret store, never to the database. Returns the source id.
 */
export async function addCalendarSource(input: CalendarSourceInput): Promise<number> {
  let id: number
  switch (input.kind) {
    case 'local':
      id = addLocal(input.name)
      break
    case 'google':
      id = await addGoogle(input)
      break
    case 'caldav':
      id = await addCaldav(input)
      break
    case 'ics':
      id = await addIcs(input)
      break
    default:
      throw new Error(`Nieznany rodzaj kalendarza: ${String((input as { kind?: unknown }).kind)}`)
  }
  const src = getSource(id)!
  record('ui', 'calendar.source-add', id, { kind: src.kind, name: src.name })
  notifyChanged()
  if (src.kind === 'google' || src.kind === 'caldav') backgroundSync(id)
  return id
}

export function removeCalendarSource(id: number): void {
  const src = getSource(id)
  if (!src) throw new Error(`Nie ma źródła kalendarza o id ${id}`)
  run('DELETE FROM cal_sources WHERE id = ?', id)
  if (src.kind === 'caldav') deleteSecret(calSourceSecretKey(id))
  dropClient(id)
  ensureDefaultCalendar()
  record('ui', 'calendar.source-remove', id, { kind: src.kind, name: src.name })
  notifyChanged()
}

/**
 * Every Google (OAuth) account gets a calendar source. Called at startup and after adding an
 * account; never touches the network itself (the first sync runs in the background).
 */
export async function ensureGoogleCalendarSources(): Promise<number[]> {
  const created: number[] = []
  for (const acc of listAccounts()) {
    if (acc.auth !== 'oauth-google') continue
    if (get("SELECT 1 FROM cal_sources WHERE kind = 'google' AND account_id = ?", acc.id)) continue
    const id = insert('cal_sources', { account_id: acc.id, kind: 'google', url: GOOGLE_CALDAV, username: acc.email, name: `Google (${acc.email})`, enabled: acc.enabled ? 1 : 0, created_at: now() })
    created.push(id)
  }
  if (created.length) {
    notifyChanged()
    for (const id of created) backgroundSync(id)
  }
  return created
}
