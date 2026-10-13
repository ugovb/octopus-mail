// Calendar synchronisation: CalDAV (incl. Google) with sync-collection / ctag shortcuts and a
// windowed full re-fetch, and read-only ICS subscriptions over HTTP(S)/webcal.
import { myAddresses } from '../accounts'
import { all, get, inList, now, parseJson, run, tx } from '../db'
import { log } from '../events'
import { getKV, setKV } from '../settings'
import { clientFor, davErrorMessage, dropClient, listObjectEtags, listRemoteCalendars, multiGet, type RemoteCal, type RemoteObject, syncChanges } from './dav'
import { parseIcs, parseResource, sha1, splitByUid } from './ical'
import { type CalRow, calendarsOf, DEFAULT_COLOR, deleteEventRow, ensureDefaultCalendar, getSource, notifyChanged, type SourceRow, upsertEventRow } from './store'

export const WINDOW_BACK_MS = 60 * 86400_000
export const WINDOW_AHEAD_MS = 365 * 86400_000
const FULL_RESYNC_MS = 24 * 3600_000
const USER_AGENT = 'OctopusMail/0.1 (+calendar)'

export function syncWindow(at = now()): { from: number; to: number } {
  return { from: at - WINDOW_BACK_MS, to: at + WINDOW_AHEAD_MS }
}

const fullKey = (calId: number) => `calendar.fullSync.${calId}`

const inflight = new Map<number, Promise<boolean>>()

/**
 * Sync one source or all enabled ones. Errors are stored in cal_sources.last_error; with no
 * sourceId nothing is ever thrown (periodic sync), with a sourceId the error is rethrown.
 */
export async function syncCalendars(sourceId?: number): Promise<void> {
  let sources: SourceRow[]
  if (sourceId != null) {
    const s = getSource(sourceId)
    if (!s) throw new Error(`Nie ma źródła kalendarza o id ${sourceId}`)
    sources = [s]
  } else {
    sources = all<SourceRow>("SELECT * FROM cal_sources WHERE enabled = 1 AND kind != 'local' ORDER BY id")
  }
  let changed = false
  let failure: Error | null = null
  for (const src of sources) {
    try {
      if (await syncSourceOnce(src)) changed = true
      if (src.last_error) changed = true
      run('UPDATE cal_sources SET last_sync = ?, last_error = NULL WHERE id = ?', now(), src.id)
    } catch (e) {
      const msg = davErrorMessage(e)
      log('calendar', `sync of source ${src.id} (${src.name}) failed:`, msg)
      if (src.last_error !== msg) changed = true
      run('UPDATE cal_sources SET last_error = ? WHERE id = ?', msg, src.id)
      if (/logowania|401|token/i.test(msg)) dropClient(src.id)
      failure = failure ?? new Error(`${src.name}: ${msg}`)
    }
  }
  if (changed) notifyChanged()
  if (sourceId != null && failure) throw failure
}

function syncSourceOnce(src: SourceRow): Promise<boolean> {
  let p = inflight.get(src.id)
  if (!p) {
    p = syncSource(src).finally(() => inflight.delete(src.id))
    inflight.set(src.id, p)
  }
  return p
}

async function syncSource(src: SourceRow): Promise<boolean> {
  if (src.kind === 'local') return false
  if (src.kind === 'ics') return syncIcsSource(src)
  return syncDavSource(src)
}

// ---------- CalDAV ----------

/** Store the remote calendar list; returns local rows paired with their remote state. */
export function upsertRemoteCalendars(src: SourceRow, remote: RemoteCal[]): { row: CalRow; remote: RemoteCal }[] {
  return tx(() => {
    const out: { row: CalRow; remote: RemoteCal }[] = []
    const existing = calendarsOf(src.id)
    for (const rc of remote) {
      const cur = existing.find((c) => c.remote_url === rc.url)
      if (cur) {
        run('UPDATE calendars SET name = ?, color = COALESCE(?, color), readonly = ?, timezone = ? WHERE id = ?', rc.name, rc.color, rc.readonly, rc.timezone, cur.id)
      } else {
        run(
          'INSERT INTO calendars(source_id, remote_url, name, color, readonly, enabled, is_default, timezone) VALUES (?, ?, ?, ?, ?, 1, 0, ?)',
          src.id,
          rc.url,
          rc.name,
          rc.color || DEFAULT_COLOR,
          rc.readonly,
          rc.timezone,
        )
      }
      out.push({ row: get<CalRow>('SELECT * FROM calendars WHERE source_id = ? AND remote_url = ?', src.id, rc.url)!, remote: rc })
    }
    const keep = remote.map((r) => r.url)
    if (keep.length) run(`DELETE FROM calendars WHERE source_id = ? AND remote_url NOT IN (${inList(keep)})`, src.id, ...keep)
    else run('DELETE FROM calendars WHERE source_id = ?', src.id)
    // Google: the primary calendar (…/caldav/v2/<email>/events/) is the natural default
    const email = (src.username || '').toLowerCase()
    const primary = out.find((o) => email && decodeURIComponent(o.row.remote_url || '').toLowerCase().includes(`/${email}/`))
    ensureDefaultCalendar(primary ? [primary.row.id, ...out.map((o) => o.row.id)] : out.map((o) => o.row.id))
    return out
  })
}

async function syncDavSource(src: SourceRow): Promise<boolean> {
  const conn = await clientFor(src)
  const remote = await listRemoteCalendars(src, conn)
  const pairs = upsertRemoteCalendars(src, remote)
  let changed = false
  for (const { row, remote: rc } of pairs) {
    if (!row.enabled) continue
    try {
      if (await syncDavCalendar(conn, row, rc)) changed = true
    } catch (e) {
      throw new Error(`Kalendarz „${row.name}”: ${davErrorMessage(e)}`)
    }
  }
  return changed
}

function storeObjects(calId: number, objs: RemoteObject[]): boolean {
  const me = myAddresses()
  let changed = false
  tx(() => {
    for (const o of objs) {
      try {
        const r = upsertEventRow(calId, o.data, { href: o.href, etag: o.etag, me })
        if (r?.changed) changed = true
      } catch (e) {
        log('calendar', `skipping unparseable object ${o.href}:`, (e as Error).message)
      }
    }
  })
  return changed
}

async function syncDavCalendar(conn: Awaited<ReturnType<typeof clientFor>>, cal: CalRow, rc: RemoteCal): Promise<boolean> {
  const calUrl = cal.remote_url!
  const fullDue = now() - getKV<number>(fullKey(cal.id), 0) > FULL_RESYNC_MS
  // ctag / sync-token unchanged → nothing to do (servers without either always get a listing)
  const unchanged = !!(rc.ctag || rc.syncToken) && (cal.ctag ?? null) === rc.ctag && (cal.sync_token ?? null) === rc.syncToken
  if (!fullDue && unchanged) return false

  // Fast path: RFC 6578 sync-collection from the stored token
  if (!fullDue && cal.sync_token && rc.reports.includes('syncCollection')) {
    try {
      const delta = await syncChanges(conn, calUrl, cal.sync_token)
      const local = new Map(all<{ href: string; etag: string | null }>('SELECT href, etag FROM events WHERE calendar_id = ? AND href IS NOT NULL', cal.id).map((r) => [r.href, r.etag]))
      const want = delta.changed.filter((c) => !c.etag || local.get(c.href) !== c.etag).map((c) => c.href)
      const objs = want.length ? await multiGet(conn, calUrl, want) : []
      let changed = storeObjects(cal.id, objs)
      if (delta.deleted.length) {
        const rows = all<{ id: number }>(`SELECT id FROM events WHERE calendar_id = ? AND href IN (${inList(delta.deleted)})`, cal.id, ...delta.deleted)
        for (const r of rows) deleteEventRow(r.id)
        if (rows.length) changed = true
      }
      run('UPDATE calendars SET ctag = ?, sync_token = ? WHERE id = ?', rc.ctag, delta.token ?? rc.syncToken, cal.id)
      return changed
    } catch (e) {
      log('calendar', `sync-collection failed for ${cal.name}, falling back to full fetch:`, (e as Error).message)
    }
  }

  // Full window fetch: list hrefs+etags in the window, multiget only what changed
  const { from, to } = syncWindow()
  const listing = await listObjectEtags(conn, calUrl, from, to)
  const local = all<{ id: number; href: string | null; etag: string | null; start: number; end: number; recurring: number }>(
    'SELECT id, href, etag, start, end, recurring FROM events WHERE calendar_id = ?',
    cal.id,
  )
  const byHref = new Map(local.filter((r) => r.href).map((r) => [r.href!, r]))
  const want = listing.filter((l) => {
    const r = byHref.get(l.href)
    return !r || !l.etag || r.etag !== l.etag
  })
  const objs = want.length ? await multiGet(conn, calUrl, want.map((w) => w.href)) : []
  let changed = storeObjects(cal.id, objs)
  const seen = new Set(listing.map((l) => l.href))
  const stale = all<{ id: number; href: string | null; start: number; end: number; recurring: number }>(
    'SELECT id, href, start, end, recurring FROM events WHERE calendar_id = ? AND href IS NOT NULL',
    cal.id,
  ).filter((r) => !seen.has(r.href!) && (r.recurring || (r.start < to && r.end > from)))
  for (const r of stale) deleteEventRow(r.id)
  if (stale.length) changed = true
  run('UPDATE calendars SET ctag = ?, sync_token = ? WHERE id = ?', rc.ctag, rc.syncToken, cal.id)
  setKV(fullKey(cal.id), now())
  return changed
}

// ---------- ICS subscriptions ----------

/** webcal://… → https://…; adds https:// when the scheme is missing. */
export function normalizeFeedUrl(url: string): string {
  let u = url.trim()
  if (/^webcals?:\/\//i.test(u)) u = u.replace(/^webcals?:\/\//i, 'https://')
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`
  try {
    return new URL(u).href
  } catch {
    throw new Error('Nieprawidłowy adres kalendarza.')
  }
}

export async function fetchFeed(url: string, conditional?: { etag?: string | null; lastModified?: string | null }): Promise<{ status: number; body: string; etag: string | null; lastModified: string | null }> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'text/calendar, application/ics, text/plain;q=0.8, */*;q=0.5' }
  if (conditional?.etag) headers['If-None-Match'] = conditional.etag
  if (conditional?.lastModified) headers['If-Modified-Since'] = conditional.lastModified
  let res: Response
  try {
    res = await fetch(normalizeFeedUrl(url), { headers, redirect: 'follow', signal: AbortSignal.timeout(60_000) })
  } catch (e) {
    throw new Error(davErrorMessage(e))
  }
  if (res.status === 304) return { status: 304, body: '', etag: conditional?.etag ?? null, lastModified: conditional?.lastModified ?? null }
  if (res.status === 401 || res.status === 403) throw new Error(`Subskrypcja kalendarza wymaga autoryzacji (HTTP ${res.status}) — sprawdź, czy link jest prywatnym adresem iCal.`)
  if (res.status === 404) throw new Error('Pod tym adresem nie ma kalendarza (HTTP 404).')
  if (!res.ok) throw new Error(`Serwer subskrypcji odpowiedział HTTP ${res.status}.`)
  const body = await res.text()
  if (!/BEGIN:VCALENDAR/i.test(body)) throw new Error('Pod tym adresem nie ma kalendarza w formacie iCalendar (.ics).')
  return { status: res.status, body, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') }
}

/** Replace the events of an ICS-subscription calendar with the feed's content (window only). */
export function importFeed(cal: CalRow, body: string): boolean {
  const vcal = parseIcs(body)
  const groups = splitByUid(vcal)
  const { from, to } = syncWindow()
  const me = myAddresses()
  let changed = false
  tx(() => {
    const keep = new Set<string>()
    for (const [uid, ics] of groups) {
      let res
      try {
        res = parseResource(ics, uid)
      } catch {
        continue
      }
      if (!res) continue
      const main = res.master ?? res.exceptions[0].data
      const inWindow = res.recurring || res.exceptions.length > 0 || (main.start < to && main.end > from)
      if (!inWindow) continue
      keep.add(uid)
      try {
        if (upsertEventRow(cal.id, ics, { uid, href: null, etag: null, me })?.changed) changed = true
      } catch (e) {
        log('calendar', `feed event ${uid} skipped:`, (e as Error).message)
      }
    }
    const old = all<{ id: number; uid: string }>('SELECT id, uid FROM events WHERE calendar_id = ?', cal.id)
    for (const r of old) {
      if (!keep.has(r.uid)) {
        deleteEventRow(r.id)
        changed = true
      }
    }
  })
  return changed
}

async function syncIcsSource(src: SourceRow): Promise<boolean> {
  const cal = calendarsOf(src.id)[0]
  if (!cal || !src.url) return false
  if (!cal.enabled) return false
  const meta = parseJson<{ etag?: string | null; lastModified?: string | null }>(cal.sync_token, {})
  const fullDue = now() - getKV<number>(fullKey(cal.id), 0) > FULL_RESYNC_MS
  const feed = await fetchFeed(src.url, fullDue ? undefined : meta)
  if (feed.status === 304) return false
  const hash = sha1(feed.body)
  let changed = false
  if (hash !== cal.ctag || fullDue) {
    changed = importFeed(cal, feed.body)
    setKV(fullKey(cal.id), now())
  }
  run('UPDATE calendars SET ctag = ?, sync_token = ? WHERE id = ?', hash, JSON.stringify({ etag: feed.etag, lastModified: feed.lastModified }), cal.id)
  return changed
}
