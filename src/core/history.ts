import type { HistoryEntry } from '../shared/types'
import { all, now, run } from './db'

export type Actor = 'ui' | 'cli' | 'mcp' | 'scheduler' | 'rule' | 'sync'

export function record(actor: Actor | string, action: string, target?: string | number | null, details?: unknown, ok = true): void {
  run(
    'INSERT INTO history(at, actor, action, target, details, ok) VALUES (?, ?, ?, ?, ?, ?)',
    now(),
    actor,
    action,
    target == null ? null : String(target),
    details == null ? null : typeof details === 'string' ? details : JSON.stringify(details),
    ok ? 1 : 0,
  )
}

export function listHistory(limit = 50, actor?: string): HistoryEntry[] {
  const rows = actor
    ? all('SELECT * FROM history WHERE actor = ? ORDER BY id DESC LIMIT ?', actor, limit)
    : all('SELECT * FROM history ORDER BY id DESC LIMIT ?', limit)
  return rows.map((r) => ({ ...r, ok: !!r.ok }) as HistoryEntry)
}

export function pruneHistory(keepDays = 90): void {
  run('DELETE FROM history WHERE at < ?', now() - keepDays * 86400_000)
}
