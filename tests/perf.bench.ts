// Synthetic large-mailbox benchmark (not part of `npm test`).
// node scripts/bench.mjs  → builds a 30k-message profile in a temp dir and times the UI queries.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.OCTO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-bench-'))
process.env.OCTO_SECRETS = 'memory'
process.env.OCTO_QUIET = '1'

import { insert, now, run, tx } from '../src/core/db'
import { ftsPut } from '../src/core/fts'
import * as Q from '../src/core/queries'
import { searchMessages, searchThreads } from '../src/core/search'
import { updateSettings } from '../src/core/settings'
import { assignThread } from '../src/core/threading'

const N_MSG = Number(process.env.BENCH_MESSAGES || 30000)
const N_CONTACTS = 3000
const words = 'faktura umowa projekt spotkanie premiera build steam demo trailer budżet oferta raport kampania wydawca gra kod serwer zamówienie płatność'.split(' ')
const rnd = (n: number) => Math.floor(Math.random() * n)
const pick = <T,>(a: T[]) => a[rnd(a.length)]

function time<T>(label: string, fn: () => T, repeat = 3): T {
  let r!: T
  const t0 = performance.now()
  for (let i = 0; i < repeat; i++) r = fn()
  const ms = (performance.now() - t0) / repeat
  console.log(`${label.padEnd(46)} ${ms.toFixed(1).padStart(8)} ms${ms > 150 ? '   ⚠ wolne' : ''}`)
  return r
}

const t0 = Date.now()
const acc = insert('accounts', { email: 'bench@example.com', name: 'Bench', username: 'bench', imap_host: 'x', smtp_host: 'x', created_at: now() })
const folders = ['INBOX', 'Sent', 'Archive', 'Projekty', 'Newsletters'].map((p, i) =>
  insert('folders', { account_id: acc, path: p, name: p, role: ['inbox', 'sent', 'archive', null, null][i] }),
)
const senders = Array.from({ length: N_CONTACTS }, (_, i) => `osoba${i}@firma${i % 300}.example`)
tx(() => {
  for (let i = 0; i < N_CONTACTS; i++) {
    run("INSERT INTO contacts(email, name, status, sent_count, recv_count, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      senders[i], `Osoba ${i}`, i % 5 === 0 ? 'unknown' : 'accepted', i % 3 === 0 ? rnd(20) : 0, rnd(50), now())
  }
})
let uid = 1
const threadsMsgIds: string[] = []
tx(() => {
  for (let i = 0; i < N_MSG; i++) {
    const reply = i > 50 && Math.random() < 0.6
    const parent = reply ? pick(threadsMsgIds) : null
    const msgid = `<m${i}@bench>`
    const date = Date.now() - rnd(365 * 86400_000)
    const from = pick(senders)
    const folderIdx = Math.random() < 0.45 ? 0 : Math.random() < 0.4 ? 1 : Math.random() < 0.7 ? 2 : 3 + rnd(2)
    const subject = `${parent ? 'Re: ' : ''}${pick(words)} ${pick(words)} ${i % 997}`
    const threadId = assignThread({ accountId: acc, msgid, inReplyTo: parent, refs: parent ? [parent] : [], gmThrid: null, subject, date })
    const id = insert('messages', {
      account_id: acc, folder_id: folders[folderIdx], uid: uid++, thread_id: threadId, msgid, in_reply_to: parent,
      subject, from_name: 'X', from_email: folderIdx === 1 ? 'bench@example.com' : from, to_json: '[]', cc_json: '[]', date,
      seen: Math.random() < 0.85 ? 1 : 0, flagged: Math.random() < 0.01 ? 1 : 0, has_attachments: Math.random() < 0.1 ? 1 : 0,
      snippet: `${pick(words)} ${pick(words)} ${pick(words)} treść wiadomości numer ${i}`,
      category: pick(['people', 'people', 'notification', 'newsletter']), is_outgoing: folderIdx === 1 ? 1 : 0, created_at: now(),
    })
    ftsPut(id, subject, from, `${pick(words)} ${pick(words)} zażółć ${i}`, '')
    threadsMsgIds.push(msgid)
  }
  run("UPDATE threads SET category = 'people'")
})
console.log(`Baza: ${N_MSG} wiadomości, ${Q.counts().inbox} wątków w Odebranych, zbudowana w ${((Date.now() - t0) / 1000).toFixed(1)} s\n`)

time('Smart Inbox (120 wątków)', () => Q.listThreads({ kind: 'smart' }, { limit: 120 }))
time('Smart Inbox, kolejna strona (offset 480)', () => Q.listThreads({ kind: 'smart' }, { limit: 120, offset: 480 }))
time('Archiwum (120 wątków)', () => Q.listThreads({ kind: 'unified', role: 'archive' }, { limit: 120 }))
time('Folder Projekty', () => Q.listThreads({ kind: 'folder', folderId: folders[3] }, { limit: 120 }))
time('Przypięte', () => Q.listThreads({ kind: 'pinned' }, { limit: 120 }))
time('Liczniki panelu bocznego (counts)', () => Q.counts())
if (process.env.BENCH_PROFILE) {
  const { all: qall } = require('../src/core/db') as typeof import('../src/core/db')
  for (const ref of [{ kind: 'smart' }, { kind: 'pinned' }, { kind: 'snoozed' }, { kind: 'setaside' }, { kind: 'reminders' }, { kind: 'newsenders' }, { kind: 'category', category: 'people' }] as const) {
    const s = Q.scopeFor(ref as never)
    time(`  count ${JSON.stringify(ref)}`, () => qall(`WITH h AS (SELECT m.thread_id, SUM(m.seen = 0) u FROM messages m JOIN folders f ON f.id = m.folder_id JOIN threads t ON t.id = m.thread_id WHERE m.hidden = 0 AND (${s.where}) GROUP BY m.thread_id) SELECT COUNT(*) n FROM h JOIN threads t ON t.id = h.thread_id WHERE ${s.threadWhere || '1=1'}`, ...s.params, ...(s.threadParams || [])), 1)
  }
  time('  folders unread', () => qall('SELECT folder_id, COUNT(DISTINCT thread_id) n FROM messages WHERE seen = 0 AND hidden = 0 GROUP BY folder_id'), 1)
}
updateSettings({ gatekeeper: 'on' })
time('Smart Inbox z GateKeeperem', () => Q.listThreads({ kind: 'smart' }, { limit: 120 }))
time('Nowi nadawcy', () => Q.listThreads({ kind: 'newsenders' }, { limit: 120 }))
time('Liczniki z GateKeeperem', () => Q.counts())
time('Szukaj „faktura”', () => searchThreads('faktura'))
time('Szukaj „zazolc 12” (FTS bez ogonków)', () => searchThreads('zazolc 12'))
time('Szukaj from:osoba1 has:attachment', () => searchThreads('from:osoba1 has:attachment'))
time('Szukaj is:unread newer_than:30d', () => searchThreads('is:unread newer_than:30d'))
time('Szukaj wiadomości (CLI) „umowa”', () => searchMessages('umowa', { limit: 50 }))
const t = Q.listThreads({ kind: 'smart' }, { limit: 1 })[0]
time('Otwarcie wątku', () => Q.getThread(t.thread_id))
