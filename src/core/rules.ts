// Mail rules (Spark "Workflows" without the cloud): conditions on new incoming mail → actions.
import type { Category, Rule, RuleAction, RuleCondition } from '../shared/types'
import * as A from './actions'
import { all, get, insert, inList, now, parseJson, type Row, run, update } from './db'
import { bus, log } from './events'
import { record } from './history'
import { contactOverride } from './smart'

export function rowToRule(r: Row): Rule {
  return {
    id: r.id,
    name: r.name,
    enabled: !!r.enabled,
    match: r.match,
    conditions: parseJson<RuleCondition[]>(r.conditions, []),
    actions: parseJson<RuleAction[]>(r.actions, []),
    stop: !!r.stop,
    sort: r.sort,
    hits: r.hits,
  }
}

export function listRules(): Rule[] {
  return all('SELECT * FROM rules ORDER BY sort, id').map(rowToRule)
}

export function saveRule(r: Partial<Rule> & { name: string; conditions: RuleCondition[]; actions: RuleAction[] }): Rule {
  const fields = {
    name: r.name,
    enabled: r.enabled ?? true,
    match: r.match || 'all',
    conditions: JSON.stringify(r.conditions),
    actions: JSON.stringify(r.actions),
    stop: r.stop ?? false,
    sort: r.sort ?? 0,
  }
  const id = r.id ? (update('rules', r.id, fields), r.id) : insert('rules', { ...fields, created_at: now() })
  return rowToRule(get('SELECT * FROM rules WHERE id = ?', id)!)
}

export function deleteRule(id: number): void {
  run('DELETE FROM rules WHERE id = ?', id)
}

function fieldValue(m: Row, field: RuleCondition['field']): string {
  switch (field) {
    case 'from':
      return `${m.from_name || ''} <${m.from_email || ''}>`
    case 'to':
      return m.to_json || ''
    case 'cc':
      return m.cc_json || ''
    case 'any_recipient':
      return `${m.to_json || ''} ${m.cc_json || ''}`
    case 'subject':
      return m.subject || ''
    case 'body':
      return (get<{ text: string }>('SELECT text FROM bodies WHERE message_id = ?', m.id)?.text || m.snippet || '')
    case 'account':
      return get<{ email: string }>('SELECT email FROM accounts WHERE id = ?', m.account_id)?.email || ''
    case 'category':
      return m.category || ''
    case 'has_attachment':
      return m.has_attachments ? 'yes' : 'no'
    case 'list_id':
      return m.list_id || ''
  }
}

export function conditionMatches(m: Row, c: RuleCondition): boolean {
  const hay = fieldValue(m, c.field).toLowerCase()
  const v = (c.value || '').toLowerCase()
  switch (c.op) {
    case 'contains':
      return hay.includes(v)
    case 'not_contains':
      return !hay.includes(v)
    case 'equals':
    case 'is':
      return hay === v || hay.includes(`<${v}>`)
    case 'starts_with':
      return hay.startsWith(v)
    case 'ends_with':
      return hay.endsWith(v) || hay.endsWith(`${v}>`)
    case 'matches':
      try {
        return new RegExp(c.value, 'i').test(hay)
      } catch {
        return false
      }
  }
}

export function ruleMatches(rule: Rule, m: Row): boolean {
  if (!rule.conditions.length) return false
  return rule.match === 'any' ? rule.conditions.some((c) => conditionMatches(m, c)) : rule.conditions.every((c) => conditionMatches(m, c))
}

function applyAction(a: RuleAction, m: Row): void {
  const t = [m.thread_id]
  switch (a.type) {
    case 'archive':
      A.archive(t, 'rule')
      break
    case 'trash':
      A.trash(t, 'rule')
      break
    case 'mark_read':
      A.markRead(t, true, 'rule')
      break
    case 'pin':
      A.pin(t, true, 'rule')
      break
    case 'mute':
      A.mute(t, true, 'rule')
      break
    case 'set_aside':
      A.setAside(t, true, 'rule')
      break
    case 'categorize':
      run('UPDATE messages SET category = ? WHERE id = ?', a.value, m.id)
      run('UPDATE threads SET category = ? WHERE id = ?', a.value, m.thread_id)
      break
    case 'move': {
      const f = get<{ id: number }>('SELECT id FROM folders WHERE account_id = ? AND (path = ? OR name = ?)', m.account_id, a.value, a.value)
      if (f) A.moveToFolder(t, f.id, 'rule')
      break
    }
    case 'label':
      if (a.value) A.setLabel(t, a.value, true, 'rule')
      break
    case 'snooze': {
      const hours = Number(a.value) || 24
      A.snooze(t, now() + hours * 3600_000, 'rule')
      break
    }
    case 'block':
      if (m.from_email) A.blockSenders([m.from_email], 'rule')
      break
    case 'notify':
    case 'no_notify':
    case 'forward':
      break
  }
}

/** Runs after sync stores new messages; also enforces blocks, mutes and snooze wake-ups. */
export function processNewMessages(accountId: number, ids: number[], initial: boolean): { notify: number[] } {
  if (!ids.length) return { notify: [] }
  const rows = all(
    `SELECT m.*, f.role, t.muted, t.snoozed_until FROM messages m JOIN folders f ON f.id = m.folder_id JOIN threads t ON t.id = m.thread_id
     WHERE m.id IN (${inList(ids)}) AND m.is_outgoing = 0`,
    ...ids,
  )
  const rules = listRules().filter((r) => r.enabled)
  const notify: number[] = []
  const suppressed = new Set<number>()
  for (const m of rows) {
    if (m.role !== 'inbox') continue
    if (m.from_email && contactOverride(m.from_email).status === 'blocked') {
      if (!initial) A.blockSenders([m.from_email], 'rule')
      suppressed.add(m.id)
      continue
    }
    if (m.muted) {
      if (!m.seen) A.markMessagesRead([m.id], true, 'rule')
      suppressed.add(m.id)
    }
    // a reply to a snoozed conversation brings it back
    if (!initial && m.snoozed_until && m.snoozed_until > now()) {
      run('UPDATE threads SET snoozed_until = NULL, resurfaced_at = ? WHERE id = ?', now(), m.thread_id)
    }
    if (!initial) {
      for (const rule of rules) {
        if (!ruleMatches(rule, m)) continue
        log('rules', `rule "${rule.name}" matched message ${m.id}`)
        run('UPDATE rules SET hits = hits + 1 WHERE id = ?', rule.id)
        for (const a of rule.actions) {
          try {
            if (a.type === 'no_notify') suppressed.add(m.id)
            applyAction(a, m)
          } catch (e) {
            log('rules', 'action failed', (e as Error).message)
          }
        }
        record('rule', 'rule-applied', m.id, { rule: rule.name })
        if (rule.stop) break
      }
    }
    if (!initial && !m.seen && !suppressed.has(m.id)) notify.push(m.id)
  }
  if (notify.length) bus.emitEvent({ type: 'new-mail', accountId, messageIds: notify })
  return { notify }
}

/** Run a rule over existing inbox mail ("apply to existing"). */
export function applyRuleToExisting(ruleId: number, limit = 500): number {
  const rule = listRules().find((r) => r.id === ruleId)
  if (!rule) throw new Error('Reguła nie istnieje')
  const rows = all(
    `SELECT m.* FROM messages m JOIN folders f ON f.id = m.folder_id
     WHERE f.role = 'inbox' AND m.hidden = 0 AND m.is_outgoing = 0 ORDER BY m.date DESC LIMIT ?`,
    limit,
  )
  let n = 0
  const doneThreads = new Set<number>()
  for (const m of rows) {
    if (doneThreads.has(m.thread_id) || !ruleMatches(rule, m)) continue
    doneThreads.add(m.thread_id)
    for (const a of rule.actions) applyAction(a, m)
    n++
  }
  return n
}

export function testRule(rule: Pick<Rule, 'match' | 'conditions'>, limit = 300): Row[] {
  const rows = all(
    `SELECT m.id, m.thread_id, m.subject, m.from_name, m.from_email, m.date, m.to_json, m.cc_json, m.category, m.has_attachments, m.list_id, m.snippet, m.account_id
     FROM messages m JOIN folders f ON f.id = m.folder_id WHERE f.role = 'inbox' AND m.hidden = 0 ORDER BY m.date DESC LIMIT ?`,
    limit,
  )
  return rows.filter((m) => ruleMatches({ ...rule, id: 0, name: '', enabled: true, actions: [], stop: false, sort: 0, hits: 0 }, m))
}

export function suggestedCategory(email: string): Category | null {
  return contactOverride(email).category
}
