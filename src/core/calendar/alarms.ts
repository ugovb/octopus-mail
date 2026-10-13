// Event reminders (VALARM) and the scheduler hook: periodic sync + desktop notifications.
import { t, tp } from '../../shared/i18n'
import { bus, log } from '../events'
import { getKV, setKV } from '../settings'
import { syncCalendars } from './calsync'
import { listEvents } from './store'

export interface UpcomingAlarm {
  eventId: number
  summary: string
  start: number
  minutesBefore: number
  /** When the reminder should fire (epoch ms). */
  fireAt: number
  /** De-duplication key: event, occurrence and reminder offset. */
  key: string
  occurrence_start: number | null
  calendar_name: string
  location: string | null
  conference_url: string | null
}

const DAY = 86400_000
const FIRED_KEY = 'calendar.firedAlarms'
const DEFAULT_MINUTES = 10
/** Reminders missed by up to this much (sleep, app start) still fire. */
const GRACE_MS = 5 * 60_000
/** Longest reminder lead time considered. */
const MAX_LEAD_MS = 7 * DAY
const SYNC_INTERVAL_MS = 10 * 60_000
const TICK_MS = 15_000

type Fired = Record<string, number>

/**
 * Reminders due within the next `windowMs` (and those missed in the last few minutes) that
 * have not fired yet. Timed events without VALARM get a default 10-minute reminder (not for
 * read-only ICS subscriptions or all-day events). Declined and cancelled events are skipped.
 */
export function upcomingAlarms(windowMs: number, at = Date.now()): UpcomingAlarm[] {
  const fired = getKV<Fired>(FIRED_KEY, {})
  const out: UpcomingAlarm[] = []
  for (const e of listEvents(at - GRACE_MS, at + windowMs + MAX_LEAD_MS)) {
    if (e.status === 'CANCELLED' || e.my_status === 'DECLINED') continue
    if (e.start < at - GRACE_MS) continue
    let specs = e.alarms
    if (!specs.length) {
      if (e.all_day || e.source_kind === 'ics') continue
      specs = [{ minutesBefore: DEFAULT_MINUTES }]
    }
    for (const a of specs) {
      const fireAt = a.at ?? e.start - (a.minutesBefore ?? 0) * 60_000
      if (fireAt < at - GRACE_MS || fireAt > at + windowMs) continue
      const minutesBefore = a.minutesBefore ?? Math.round((e.start - fireAt) / 60_000)
      const key = `${e.id}:${e.occurrence_start ?? e.start}:${minutesBefore}`
      if (fired[key] || out.some((o) => o.key === key)) continue
      out.push({
        eventId: e.id,
        summary: e.summary || t('(no title)'),
        start: e.start,
        minutesBefore,
        fireAt,
        key,
        occurrence_start: e.occurrence_start,
        calendar_name: e.calendar_name,
        location: e.location,
        conference_url: e.conference_url,
      })
    }
  }
  return out.sort((a, b) => a.fireAt - b.fireAt)
}

function inWords(mins: number): string {
  if (mins < 60) return t('{n} min', { n: mins })
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return `${t('{h} h', { h })}${m ? ` ${t('{n} min', { n: m })}` : ''}`
  }
  const d = Math.round(mins / (24 * 60))
  return tp(d, '{n} day', '{n} days')
}

export function alarmMessage(a: Pick<UpcomingAlarm, 'summary' | 'start'>, at = Date.now()): string {
  const mins = Math.round((a.start - at) / 60_000)
  return mins >= 1 ? `📅 ${t('{title} in {time}', { title: a.summary, time: inWords(mins) })}` : `📅 ${t('{title} — starting now', { title: a.summary })}`
}

/** Emit notifications for reminders that are due now; each occurrence/reminder fires once. */
export function fireDueAlarms(at = Date.now()): UpcomingAlarm[] {
  const due = upcomingAlarms(TICK_MS, at).filter((a) => a.fireAt <= at + 1000)
  if (!due.length) return []
  const fired = getKV<Fired>(FIRED_KEY, {})
  for (const a of due) {
    fired[a.key] = at
    bus.emitEvent({
      type: 'toast',
      level: 'info',
      message: alarmMessage(a, at),
      action: a.conference_url ? { label: t('Join'), command: 'openExternal', args: a.conference_url } : undefined,
    })
  }
  for (const [k, firedAt] of Object.entries(fired)) if (firedAt < at - 3 * DAY) delete fired[k]
  setKV(FIRED_KEY, fired)
  return due
}

let lastSyncAt = 0
let syncing = false

/** Scheduler hook (every ~15 s): background sync at most every 10 minutes, then due reminders. */
export async function calendarTick(): Promise<void> {
  const t = Date.now()
  if (!syncing && t - lastSyncAt >= SYNC_INTERVAL_MS) {
    lastSyncAt = t
    syncing = true
    void syncCalendars()
      .catch((e) => log('calendar', 'periodic sync failed:', (e as Error).message))
      .finally(() => {
        syncing = false
      })
  }
  try {
    fireDueAlarms(t)
  } catch (e) {
    log('calendar', 'alarm check failed:', (e as Error).message)
  }
}
