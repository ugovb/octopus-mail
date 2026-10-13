// CalDAV access (tsdav): discovery, calendar listing, windowed/delta fetches, writes.
// Google is reached over its CalDAV endpoint with the account's OAuth token (Bearer).
import { DAVClient, type DAVCalendar, type DAVResponse } from 'tsdav'
import { getAccount } from '../accounts'
import { log } from '../events'
import { getAccessToken } from '../oauth'
import { calSourceSecretKey, getSecret } from '../secrets'
import { sha1 } from './ical'
import type { SourceRow } from './store'

export const GOOGLE_CALDAV = 'https://apidata.googleusercontent.com/caldav/v2/'
export const ICLOUD_CALDAV = 'https://caldav.icloud.com'
export const FASTMAIL_CALDAV = 'https://caldav.fastmail.com/dav/calendars'

const TIMEOUT_MS = 60_000
const MULTIGET_BATCH = 50

const timedFetch = ((input: string | URL | Request, init?: RequestInit) =>
  fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(TIMEOUT_MS) })) as typeof fetch

export class DavHttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
  }
}

/** Human (Polish) message for a failed DAV/network operation. */
export function davErrorMessage(e: unknown): string {
  const err = e as Error & { cause?: { code?: string } }
  const msg = err?.message || String(e)
  const code = err?.cause?.code || ''
  if (e instanceof DavHttpError) return msg
  if (/\b401\b|Invalid credentials|Unauthorized/i.test(msg)) {
    return 'Serwer kalendarza odrzucił dane logowania. Sprawdź login i hasło (dla iCloud potrzebne jest hasło dla aplikacji z appleid.apple.com).'
  }
  if (/\b403\b|Forbidden/i.test(msg)) return 'Serwer kalendarza odmówił dostępu (HTTP 403).'
  if (/cannot find (principalUrl|homeUrl)|discovery failed/i.test(msg)) return 'Nie znaleziono kalendarzy pod tym adresem — sprawdź adres serwera CalDAV.'
  if (err?.name === 'TimeoutError' || /aborted|timed? ?out/i.test(msg)) return 'Serwer kalendarza nie odpowiada (przekroczono czas oczekiwania).'
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|ECONNRESET|ETIMEDOUT|network/i.test(`${msg} ${code}`)) {
    return `Brak połączenia z serwerem kalendarza${code ? ` (${code})` : ''}.`
  }
  // tsdav's own (English) diagnostics
  if (/Collection|query failed|sync failed|multistatus|\bDAV\b|cannot|missing|Invalid|expected|incomplete/.test(msg) && !/[ąćęłńóśźż]/i.test(msg)) {
    return `Błąd serwera kalendarza: ${msg}`
  }
  return msg
}

function text(v: unknown): string | undefined {
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (v && typeof v === 'object') {
    const o = v as { _cdata?: unknown; _text?: unknown }
    const t = o._cdata ?? o._text
    if (typeof t === 'string') return t
  }
  return undefined
}

function normColor(v: unknown): string | null {
  const s = text(v)?.trim()
  if (!s) return null
  const m = s.match(/^#?([0-9a-f]{6})([0-9a-f]{2})?$/i)
  return m ? `#${m[1].toLowerCase()}` : null
}

export function ensureSlash(u: string): string {
  return u.endsWith('/') ? u : `${u}/`
}

export function absUrl(href: string, base: string): string {
  try {
    return new URL(href, ensureSlash(base)).href
  } catch {
    return href
  }
}

function sameUrl(a: string, b: string): boolean {
  const n = (u: string) => decodeURIComponent(absUrl(u, b)).replace(/\/+$/, '')
  try {
    return n(a) === n(b)
  } catch {
    return a === b
  }
}

// ---------- connections ----------

export interface Conn {
  client: DAVClient
  key: string
  at: number
  /** Google discovery failed: only the primary calendar is reachable. */
  primaryOnly: boolean
}
const conns = new Map<number, Conn>()

export function dropClient(sourceId: number): void {
  conns.delete(sourceId)
}

/** Log in (discovery: principal → calendar home). Throws with a Polish message. */
export async function connectDav(opts: { serverUrl: string; username?: string; password?: string; accessToken?: string }): Promise<DAVClient> {
  const client = new DAVClient({
    serverUrl: opts.serverUrl,
    credentials: opts.accessToken ? { accessToken: opts.accessToken } : { username: opts.username, password: opts.password },
    authMethod: opts.accessToken ? 'Bearer' : 'Basic',
    defaultAccountType: 'caldav',
    fetch: timedFetch,
    fetchOptions: opts.accessToken ? { headers: { authorization: `Bearer ${opts.accessToken}` } } : {},
  })
  try {
    await client.login()
  } catch (e) {
    throw Object.assign(new Error(davErrorMessage(e)), { cause: e })
  }
  return client
}

function googleEmail(src: SourceRow): string {
  if (src.username) return src.username
  if (src.account_id) return getAccount(src.account_id).email
  throw new Error('Źródło Google nie jest powiązane z kontem.')
}

export function googlePrimaryUrl(email: string): string {
  return `${GOOGLE_CALDAV}${encodeURIComponent(email)}/events/`
}

/** Logged-in client for a source (cached ~30 min, refreshed when the OAuth token changes). */
export async function clientFor(src: SourceRow): Promise<Conn> {
  let key: string
  let opts: Parameters<typeof connectDav>[0]
  if (src.kind === 'google') {
    if (!src.account_id) throw new Error('Źródło Google nie jest powiązane z kontem.')
    const token = await getAccessToken(src.account_id)
    key = sha1(token)
    opts = { serverUrl: src.url || GOOGLE_CALDAV, accessToken: token }
  } else if (src.kind === 'caldav') {
    const password = getSecret(calSourceSecretKey(src.id))
    if (!password) throw new Error('Brak zapisanego hasła do kalendarza — usuń to źródło i dodaj je ponownie.')
    key = sha1(`${src.url}\n${src.username}\n${password}`)
    opts = { serverUrl: src.url || '', username: src.username || '', password }
  } else {
    throw new Error('To źródło nie jest kalendarzem CalDAV.')
  }
  const cached = conns.get(src.id)
  if (cached && cached.key === key && Date.now() - cached.at < 30 * 60_000) return cached
  let conn: Conn
  try {
    conn = { client: await connectDav(opts), key, at: Date.now(), primaryOnly: false }
  } catch (e) {
    const msg = (e as Error).message
    // Google's principal discovery has been flaky over the years; the primary calendar URL is stable.
    if (src.kind !== 'google' || /logowania|403/.test(msg)) throw e
    log('calendar', 'Google CalDAV discovery failed, using primary calendar only:', msg)
    const client = new DAVClient({
      serverUrl: opts.serverUrl,
      credentials: { accessToken: opts.accessToken },
      authMethod: 'Bearer',
      defaultAccountType: 'caldav',
      fetch: timedFetch,
      fetchOptions: { headers: { authorization: `Bearer ${opts.accessToken}` } },
    })
    conn = { client, key, at: Date.now(), primaryOnly: true }
  }
  conns.set(src.id, conn)
  return conn
}

// ---------- calendars ----------

export interface RemoteCal {
  url: string
  name: string
  color: string | null
  ctag: string | null
  syncToken: string | null
  readonly: boolean
  reports: string[]
  timezone: string | null
}

const CAL_PROPS = {
  'd:displayname': {},
  'ca:calendar-color': {},
  'cs:getctag': {},
  'd:sync-token': {},
  'd:resourcetype': {},
  'c:supported-calendar-component-set': {},
  'c:calendar-description': {},
  'c:calendar-timezone': {},
  'd:current-user-privilege-set': {},
}

function writableFromPrivileges(priv: unknown): boolean {
  if (priv === undefined || priv === null) return true
  return /"(write|writeContent|all|bind)"/.test(JSON.stringify(priv))
}

function tzidFromVtimezone(v: string | undefined): string | null {
  const m = v?.match(/^TZID:(.+)$/m)
  return m ? m[1].trim() : null
}

/** Event calendars of the account (VTODO-only lists are skipped). */
export async function listRemoteCalendars(src: SourceRow, conn: Conn): Promise<RemoteCal[]> {
  if (conn.primaryOnly) {
    const url = googlePrimaryUrl(googleEmail(src))
    const [r] = await conn.client.propfind({ url, props: CAL_PROPS, depth: '0' })
    if (!r?.ok) throw new DavHttpError(`Google Calendar (CalDAV): HTTP ${r?.status ?? '?'} ${r?.statusText ?? ''}`.trim(), r?.status ?? 0)
    let reports: string[] = []
    try {
      reports = await conn.client.supportedReportSet({ collection: { url } })
    } catch {
      reports = []
    }
    return [
      {
        url,
        name: text(r.props?.displayname) || googleEmail(src),
        color: normColor(r.props?.calendarColor),
        ctag: text(r.props?.getctag) ?? null,
        syncToken: text(r.props?.syncToken) ?? null,
        readonly: !writableFromPrivileges(r.props?.currentUserPrivilegeSet),
        reports,
        timezone: null,
      },
    ]
  }
  let cals: DAVCalendar[]
  try {
    cals = await conn.client.fetchCalendars({ props: CAL_PROPS, projectedProps: { currentUserPrivilegeSet: true } })
  } catch (e) {
    throw new Error(davErrorMessage(e))
  }
  return cals
    .filter((c) => !c.components?.length || c.components.includes('VEVENT'))
    .map((c) => ({
      url: c.url,
      name: (typeof c.displayName === 'string' && c.displayName.trim()) || decodeURIComponent(c.url.replace(/\/+$/, '').split('/').pop() || 'Kalendarz'),
      color: normColor(c.calendarColor),
      ctag: c.ctag ?? null,
      syncToken: c.syncToken ?? null,
      readonly: !writableFromPrivileges(c.projectedProps?.currentUserPrivilegeSet),
      reports: Array.isArray(c.reports) ? (c.reports as string[]) : [],
      timezone: tzidFromVtimezone(c.timezone),
    }))
}

// ---------- objects ----------

export interface RemoteObject {
  href: string
  etag: string | null
  data: string
}

function davStamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`
}

/** hrefs + ETags of events overlapping [from, to) (calendar-query with time-range). */
export async function listObjectEtags(conn: Conn, calUrl: string, from: number, to: number): Promise<{ href: string; etag: string | null }[]> {
  const res = await conn.client.calendarQuery({
    url: calUrl,
    props: { 'd:getetag': {} },
    filters: [
      {
        'comp-filter': {
          _attributes: { name: 'VCALENDAR' },
          'comp-filter': {
            _attributes: { name: 'VEVENT' },
            'time-range': { _attributes: { start: davStamp(from), end: davStamp(to) } },
          },
        },
      },
    ],
    depth: '1',
  })
  return res
    .filter((r) => typeof r.href === 'string' && r.href && !r.href.endsWith('/') && r.ok !== false)
    .map((r) => ({ href: absUrl(r.href!, calUrl), etag: text(r.props?.getetag) ?? null }))
}

/** calendar-multiget in batches. Objects that failed individually are skipped. */
export async function multiGet(conn: Conn, calUrl: string, hrefs: string[]): Promise<RemoteObject[]> {
  const out: RemoteObject[] = []
  for (let i = 0; i < hrefs.length; i += MULTIGET_BATCH) {
    const batch = hrefs.slice(i, i + MULTIGET_BATCH).map((h) => {
      try {
        const u = new URL(h)
        return `${u.pathname}${u.search}`
      } catch {
        return h
      }
    })
    const res: DAVResponse[] = await conn.client.calendarMultiGet({
      url: calUrl,
      props: { 'd:getetag': {}, 'c:calendar-data': {} },
      objectUrls: batch,
      depth: '1',
    })
    for (const r of res) {
      if (!r.href || r.status >= 400) continue
      const cd = r.props?.calendarData
      const data = typeof cd === 'string' ? cd : text(cd)
      if (typeof data !== 'string' || !data.includes('BEGIN:VCALENDAR')) continue
      out.push({ href: absUrl(r.href, calUrl), etag: text(r.props?.getetag) ?? null, data })
    }
  }
  return out
}

export class SyncTokenError extends Error {}

/** RFC 6578 sync-collection: hrefs changed/deleted since `token`, plus the new token. */
export async function syncChanges(conn: Conn, calUrl: string, token: string): Promise<{ changed: { href: string; etag: string | null }[]; deleted: string[]; token: string | null }> {
  const changed = new Map<string, string | null>()
  const deleted = new Set<string>()
  let cur: string | null = token
  for (let round = 0; round < 20; round++) {
    const res = await conn.client.syncCollection({ url: calUrl, props: { 'd:getetag': {} }, syncLevel: 1, syncToken: cur ?? undefined })
    let truncated = false
    for (const r of res) {
      if (!r.href) continue
      const isSelf = sameUrl(r.href, calUrl)
      if (isSelf) {
        if (r.status === 507) truncated = true
        else if (r.status >= 400) throw new SyncTokenError(`sync-collection: HTTP ${r.status} ${r.statusText}`)
        continue
      }
      if (r.href.endsWith('/')) continue
      const href = absUrl(r.href, calUrl)
      if (r.status === 404 || r.status === 410) {
        deleted.add(href)
        changed.delete(href)
      } else if (r.status < 400) {
        changed.set(href, text(r.props?.getetag) ?? null)
        deleted.delete(href)
      }
    }
    const first = res[0] as DAVResponse & { raw?: { multistatus?: { syncToken?: unknown } } }
    cur = text(first?.raw?.multistatus?.syncToken) ?? cur
    if (!truncated) break
  }
  return { changed: [...changed].map(([href, etag]) => ({ href, etag })), deleted: [...deleted], token: cur }
}

async function responseText(r: Response): Promise<string> {
  try {
    return (await r.text()).replace(/\s+/g, ' ').slice(0, 200)
  } catch {
    return ''
  }
}

/** PUT a resource. New objects go to <calendar>/<uid>.ics with If-None-Match: *. */
export async function putObject(
  conn: Conn,
  calUrl: string,
  href: string | null,
  uid: string,
  ics: string,
  etag: string | null,
): Promise<{ href: string; etag: string | null }> {
  const url = href ?? absUrl(`${encodeURIComponent(uid.replace(/[/\\]/g, '_'))}.ics`, calUrl)
  const headers: Record<string, string> = { 'content-type': 'text/calendar; charset=utf-8' }
  let res: Response
  try {
    res = href
      ? await conn.client.updateObject({ url, data: ics, etag: etag ?? undefined, headers })
      : await conn.client.createObject({ url, data: ics, headers: { ...headers, 'If-None-Match': '*' } })
  } catch (e) {
    throw new Error(davErrorMessage(e))
  }
  if (res.status === 412) throw new DavHttpError('Wydarzenie zostało w międzyczasie zmienione na serwerze — zsynchronizuj kalendarz i spróbuj ponownie.', 412)
  if (!res.ok) {
    const body = await responseText(res)
    if (res.status === 404) throw new DavHttpError('Wydarzenie nie istnieje już na serwerze.', 404)
    if (res.status === 401) throw new DavHttpError(davErrorMessage(new Error('401')), 401)
    if (res.status === 403) throw new DavHttpError(`Serwer kalendarza nie pozwolił zapisać zmian (HTTP 403)${body ? `: ${body}` : ''}.`, 403)
    throw new DavHttpError(`Serwer kalendarza odrzucił zapis (HTTP ${res.status})${body ? `: ${body}` : ''}.`, res.status)
  }
  return { href: url, etag: res.headers.get('etag') }
}

export async function deleteObject(conn: Conn, href: string, etag: string | null): Promise<void> {
  let res: Response
  try {
    res = await conn.client.deleteObject({ url: href, etag: etag ?? undefined })
  } catch (e) {
    throw new Error(davErrorMessage(e))
  }
  if (res.ok || res.status === 404 || res.status === 410) return
  if (res.status === 412) throw new DavHttpError('Wydarzenie zostało w międzyczasie zmienione na serwerze — zsynchronizuj kalendarz i spróbuj ponownie.', 412)
  const body = await responseText(res)
  throw new DavHttpError(`Serwer kalendarza nie usunął wydarzenia (HTTP ${res.status})${body ? `: ${body}` : ''}.`, res.status)
}
