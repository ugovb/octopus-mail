// Local replacement for Spark's cloud timers: snooze wake-ups, follow-up reminders,
// scheduled sends and the operation queue. Runs inside the desktop app (tray) or `octo daemon`.
import { t } from '../shared/i18n'
import { all, get, now, run } from './db'
import { bus, log } from './events'
import { record } from './history'
import { enqueue, processOps } from './ops'
import { recoverStuckSends } from './send'

let timer: NodeJS.Timeout | null = null
let ticking = false

export interface TickHooks {
  calendarTick?: () => Promise<void> | void
}
let hooks: TickHooks = {}

export function startScheduler(h: TickHooks = {}, intervalMs = 15_000): void {
  hooks = h
  if (timer) return
  timer = setInterval(() => void tick(), intervalMs)
  void tick()
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export async function tick(): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    wakeSnoozed()
    fireReminders()
    rescueScheduledSends()
    recoverStuckSends()
    await processOps()
    if (hooks.calendarTick) await hooks.calendarTick()
  } catch (e) {
    log('scheduler', 'tick failed', (e as Error).message)
  } finally {
    ticking = false
  }
}

function wakeSnoozed(): void {
  const due = all<{ id: number; subject: string }>(
    'SELECT id, subject FROM threads WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?',
    now(),
  )
  for (const t of due) {
    run('UPDATE threads SET snoozed_until = NULL, resurfaced_at = ?, done_at = NULL WHERE id = ?', now(), t.id)
    // the returning conversation shows as unread at the top of the inbox
    const latest = get<{ id: number; account_id: number }>(
      'SELECT id, account_id FROM messages WHERE thread_id = ? AND is_outgoing = 0 ORDER BY date DESC LIMIT 1',
      t.id,
    )
    if (latest) {
      run('UPDATE messages SET seen = 0 WHERE id = ?', latest.id)
      enqueue('flags', latest.account_id, { messageIds: [latest.id], remove: ['\\Seen'] }, { actor: 'scheduler' })
    }
    record('scheduler', 'snooze-returned', t.id)
    bus.emitEvent({ type: 'reminder', threadId: t.id, subject: t.subject || '' })
  }
  if (due.length) bus.emitEvent({ type: 'mailbox-changed' })
}

function fireReminders(): void {
  const due = all<{ id: number; subject: string; reminder_kind: string | null; reminder_ref: number | null }>(
    'SELECT id, subject, reminder_kind, reminder_ref FROM threads WHERE reminder_at IS NOT NULL AND reminder_at <= ?',
    now(),
  )
  for (const th of due) {
    if (th.reminder_kind === 'no-reply') {
      const replied = get(
        'SELECT 1 FROM messages WHERE thread_id = ? AND is_outgoing = 0 AND date > ? LIMIT 1',
        th.id,
        th.reminder_ref || 0,
      )
      if (replied) {
        run('UPDATE threads SET reminder_at = NULL, reminder_kind = NULL WHERE id = ?', th.id)
        record('scheduler', 'reminder-skipped', th.id, t('a reply has already arrived'))
        continue
      }
    }
    run('UPDATE threads SET reminder_at = NULL, reminder_kind = NULL, resurfaced_at = ?, done_at = NULL WHERE id = ?', now(), th.id)
    record('scheduler', 'reminder-fired', th.id)
    bus.emitEvent({ type: 'reminder', threadId: th.id, subject: th.subject || '' })
  }
  if (due.length) bus.emitEvent({ type: 'mailbox-changed' })
}

/** A scheduled draft whose queued op was lost (e.g. DB copied between machines) gets re-queued. */
function rescueScheduledSends(): void {
  const lost = all<{ id: number; account_id: number }>(
    `SELECT d.id, d.account_id FROM drafts d WHERE d.status = 'scheduled' AND d.send_at <= ?
       AND NOT EXISTS (SELECT 1 FROM ops o WHERE o.kind = 'send' AND o.status IN ('pending','running')
                       AND json_extract(o.payload, '$.draftId') = d.id)`,
    now() - 60_000,
  )
  for (const d of lost) enqueue('send', d.account_id, { draftId: d.id }, { actor: 'scheduler' })
}
