import os from 'node:os'
import * as cal from './calendar'
import { syncAllContacts } from './contacts-sync'
import { db, get, now, run } from './db'
import { log } from './events'
import { pruneHistory } from './history'
import { processNewMessages } from './rules'
import { startScheduler, stopScheduler } from './scheduler'
import { getKV, setKV } from './settings'
import { onNewMessages, sync } from './sync'
import { trustSystemCertificates } from './tls'

let inited = false

/** Open the database and wire core hooks. Cheap; safe to call repeatedly. */
export function initCore(): void {
  if (inited) return
  inited = true
  trustSystemCertificates()
  db()
  onNewMessages((accountId, ids, initial) => {
    processNewMessages(accountId, ids, initial)
  })
}

let heartbeat: NodeJS.Timeout | null = null

/** Full background engine: IMAP sync for every account, scheduler, calendar, contacts. */
export async function startEngine(owner: 'app' | 'daemon' | 'server'): Promise<void> {
  initCore()
  const beat = () => setKV('engine', { owner, pid: process.pid, host: os.hostname(), at: now() })
  beat()
  heartbeat = setInterval(beat, 10_000)
  await sync.startAll()
  startScheduler({ calendarTick: () => cal.calendarTick() })
  void cal.ensureGoogleCalendarSources().catch((e) => log('boot', 'calendar sources', (e as Error).message))
  setTimeout(() => void syncAllContacts().catch(() => undefined), 60_000)
  pruneHistory()
  // clean ops older than a week
  run("DELETE FROM ops WHERE status IN ('done','cancelled') AND created_at < ?", now() - 7 * 86400_000)
}

export async function stopEngine(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
  stopScheduler()
  await sync.stopAll()
  const e = getKV<{ pid: number } | null>('engine', null)
  if (e?.pid === process.pid) setKV('engine', null)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Is a sync engine (desktop app or `octo daemon`) alive right now? */
export function engineRunning(): { owner: string; pid: number } | null {
  initCore()
  const e = getKV<{ owner: string; pid: number; host?: string; at: number } | null>('engine', null)
  if (!e || now() - e.at > 35_000) return null
  // a crashed engine on this machine leaves a fresh heartbeat behind: check that its process still exists
  if (e.host === os.hostname() && e.pid !== process.pid && !processAlive(e.pid)) return null
  return e
}

export function lastSyncAge(): number | null {
  const r = get<{ t: number | null }>('SELECT MIN(last_sync) t FROM accounts WHERE enabled = 1')
  return r?.t ? now() - r.t : null
}
