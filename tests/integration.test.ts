// End-to-end test of the mail engine against a local GreenMail server
// (SMTP 127.0.0.1:3025, IMAP 127.0.0.1:3143, users alice/bob @test.local, password "pass").
// Never touches real data: OCTO_HOME is a temp dir and secrets stay in memory.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

process.env.OCTO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-test-'))
process.env.OCTO_SECRETS = 'memory'
process.env.OCTO_QUIET = '1'
process.env.OCTO_INSECURE_TLS = '1'
process.env.OCTO_NO_AUTORUN = '1'

import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import * as accounts from '../src/core/accounts'
import * as A from '../src/core/actions'
import { all, get, run } from '../src/core/db'
import * as drafts from '../src/core/drafts'
import { bus } from '../src/core/events'
import { processOps } from '../src/core/ops'
import * as Q from '../src/core/queries'
import { processNewMessages } from '../src/core/rules'
import { tick } from '../src/core/scheduler'
import { searchMessages, searchThreads } from '../src/core/search'
import { updateSettings } from '../src/core/settings'
import { onNewMessages, sync } from '../src/core/sync'
import { parseWhen, presetTime } from '../src/shared/when'

const HOST = '127.0.0.1'
const RUN = Date.now().toString(36)
const smtp = nodemailer.createTransport({ host: HOST, port: 3025, secure: false, ignoreTLS: true })

async function deliver(opts: nodemailer.SendMailOptions) {
  await smtp.sendMail({ to: 'alice@test.local', ...opts })
}

async function imapAs(user: string) {
  const c = new ImapFlow({ host: HOST, port: 3143, secure: false, auth: { user, pass: 'pass' }, logger: false, doSTARTTLS: false } as never)
  await c.connect()
  return c
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15000, label = 'condition') {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`timeout waiting for ${label}`)
}

let accId = 0
const subj = (s: string) => `${s} [${RUN}]`

describe('Octopus Mail engine (GreenMail)', () => {
  before(async () => {
    // clean alice's mailbox from previous runs
    const c = await imapAs('alice')
    for (const f of await c.list()) {
      if (f.path === 'INBOX') {
        const lock = await c.getMailboxLock('INBOX')
        try {
          if ((c.mailbox as { exists: number }).exists) await c.messageDelete('1:*')
        } finally {
          lock.release()
        }
      } else {
        await c.mailboxDelete(f.path).catch(() => undefined)
      }
    }
    await c.mailboxCreate('Sent').catch(() => undefined)
    await c.logout()

    await deliver({ from: 'Bob Builder <bob@test.local>', subject: subj('Projekt X'), text: 'Cześć Alice, wysyłam wycenę projektu. Zażółć gęślą jaźń.', messageId: `<px-${RUN}@test.local>`, attachments: [{ filename: 'wycena.pdf', content: Buffer.from('%PDF-1.4 fake') }] })
    await deliver({ from: 'Sklep <news@shop.example>', subject: subj('Wielka wyprzedaż'), html: '<h1>Promocja -50%</h1><p>Tylko dziś!</p>', headers: { 'List-Unsubscribe': '<mailto:unsub@shop.example?subject=stop>', 'Precedence': 'bulk' } })
    await deliver({ from: 'GitHub <noreply@github.com>', subject: subj('[repo] New issue opened'), text: 'Someone opened an issue.' })
    await deliver({ from: 'Bob Builder <bob@test.local>', subject: `Re: ${subj('Projekt X')}`, text: 'Dodatkowo termin: piątek.\n\nW dniu wczoraj Alice napisał(a):\n> stare', inReplyTo: `<px-${RUN}@test.local>`, references: [`<px-${RUN}@test.local>`] })
    await deliver({ from: 'Nieznajomy <stranger@unknown.example>', subject: subj('Oferta współpracy'), text: 'Dzień dobry, mam propozycję.' })

    onNewMessages((id, ids, initial) => processNewMessages(id, ids, initial))
  })

  after(async () => {
    await sync.stopAll()
    smtp.close()
  })

  it('parses natural-language dates', () => {
    const base = new Date(2026, 9, 13, 10, 0) // Tue 13 Oct 2026 10:00
    assert.equal(new Date(parseWhen('jutro 9', base)!).toString(), new Date(2026, 9, 14, 9, 0).toString())
    assert.equal(new Date(parseWhen('pt 14:30', base)!).toString(), new Date(2026, 9, 16, 14, 30).toString())
    assert.equal(parseWhen('za 2 godziny', base), base.getTime() + 2 * 3600_000)
    assert.equal(new Date(parseWhen('20.10 8:15', base)!).toString(), new Date(2026, 9, 20, 8, 15).toString())
    assert.equal(new Date(parseWhen('2026-11-02 17:00', base)!).toString(), new Date(2026, 10, 2, 17, 0).toString())
    assert.equal(new Date(presetTime('next_week', base)).getDay(), 1)
    assert.equal(parseWhen('bzdura', base), null)
  })

  it('adds an account after testing IMAP and SMTP', async () => {
    const acc = await accounts.addAccount({
      email: 'alice@test.local', name: 'Alice Tester', username: 'alice', password: 'pass',
      imap_host: HOST, imap_port: 3143, imap_secure: false, smtp_host: HOST, smtp_port: 3025, smtp_secure: false,
    })
    accId = acc.id
    assert.equal(acc.email, 'alice@test.local')
    await assert.rejects(() => accounts.addAccount({ email: 'bob@test.local', username: 'bob', password: 'zle', imap_host: HOST, imap_port: 3143, imap_secure: false, smtp_host: HOST, smtp_port: 3025, smtp_secure: false }), /IMAP/)
  })

  it('syncs folders, messages, threads and categories', async () => {
    const s = sync.get(accId)
    await s.syncFolderList()
    await s.syncAll(true)
    const inbox = get('SELECT * FROM folders WHERE account_id = ? AND role = ?', accId, 'inbox')
    assert.ok(inbox, 'inbox folder')
    assert.ok(get('SELECT 1 FROM folders WHERE account_id = ? AND role = ?', accId, 'sent'), 'Sent recognised by name')
    const msgs = all('SELECT * FROM messages WHERE folder_id = ?', inbox!.id)
    assert.equal(msgs.length, 5)
    const px = msgs.filter((m) => m.subject.includes('Projekt X'))
    assert.equal(px.length, 2)
    assert.equal(px[0].thread_id, px[1].thread_id, 'reply joins the original thread')
    const cat = (needle: string) => msgs.find((m) => m.subject.includes(needle))!.category
    assert.equal(cat('wyprzedaż'), 'newsletter')
    assert.equal(cat('New issue'), 'notification')
    assert.equal(cat('Projekt X'), 'people')
    assert.ok(msgs.find((m) => m.subject.includes('Projekt X') && !m.subject.startsWith('Re'))!.has_attachments)
    assert.match(msgs.find((m) => m.subject.includes('Oferta'))!.snippet, /propozycję/)
  })

  it('lists the Smart Inbox and fetches bodies', async () => {
    const list = Q.listThreads({ kind: 'smart' })
    assert.equal(list.length, 4)
    const px = list.find((t) => t.subject.includes('Projekt X'))!
    assert.equal(px.message_count, 2)
    assert.equal(px.category, 'people')
    const thread = Q.getThread(px.thread_id)!
    for (const m of thread.messages) await sync.get(accId).fetchBody(m.id)
    const full = Q.getThread(px.thread_id)!
    assert.match(full.messages[0].text || '', /wycenę/)
    assert.equal(full.messages[0].attachments.filter((a) => !a.inline).length, 1)
    const file = await sync.get(accId).downloadAttachment(full.messages[0].attachments[0].id)
    assert.equal(fs.readFileSync(file, 'utf8'), '%PDF-1.4 fake')
  })

  it('searches with operators and without Polish diacritics', () => {
    assert.ok(searchThreads('zazolc').total >= 1, 'diacritics-insensitive full text')
    assert.ok(searchThreads('wycen').total >= 1, 'prefix match')
    assert.equal(searchThreads('from:bob has:attachment').total, 1)
    assert.equal(searchThreads('category:newsletter').total, 1)
    assert.equal(searchThreads('filename:wycena').total, 1)
    assert.ok(searchMessages('is:unread').length >= 5)
    assert.equal(searchThreads('from:bob -wycenę').total, 1)
  })

  it('sends a reply with correct threading headers and Bcc privacy', async () => {
    const px = Q.listThreads({ kind: 'smart' }).find((t) => t.subject.includes('Projekt X'))!
    const d = drafts.saveDraft({ reply_to_message_id: px.latest_message_id, markdown: 'Dzięki **Bob**, pasuje mi piątek.', bcc: ['alice@test.local'] })
    assert.deepEqual(d.to.map((a) => a.email), ['bob@test.local'])
    assert.match(d.subject, /^Re: /)
    const idBefore = d.id
    drafts.sendDraft(d.id, { immediate: true })
    await processOps()
    const sent = drafts.getDraft(idBefore)
    assert.equal(sent.status, 'sent', sent.error || '')
    const bob = await imapAs('bob')
    const lock = await bob.getMailboxLock('INBOX')
    try {
      const uids = (await bob.search({ subject: 'Projekt X' }, { uid: true })) || []
      assert.ok(uids.length >= 1)
      const msg = await bob.fetchOne(String(uids[uids.length - 1]), { source: true, headers: true }, { uid: true })
      const src = (msg as { source: Buffer }).source.toString()
      assert.match(src, new RegExp(`In-Reply-To: <px-${RUN}@test.local>|In-Reply-To: <`))
      assert.doesNotMatch(src, /^Bcc:/im, 'Bcc header must not be transmitted')
      assert.match(src, /pasuje mi pi/)
    } finally {
      lock.release()
      await bob.logout()
    }
    // the Sent copy (non-Gmail) keeps Bcc
    const c = await imapAs('alice')
    const l2 = await c.getMailboxLock('Sent')
    try {
      const msg = await c.fetchOne('*', { source: true })
      assert.match((msg as { source: Buffer }).source.toString(), /^Bcc:/im)
    } finally {
      l2.release()
      await c.logout()
    }
  })

  it('archives (Done) with server move, and Undo cancels a pending action', async () => {
    const list = Q.listThreads({ kind: 'smart' })
    const gh = list.find((t) => t.subject.includes('New issue'))!
    A.archive([gh.thread_id], 'cli')
    assert.ok(!Q.listThreads({ kind: 'smart' }).some((t) => t.thread_id === gh.thread_id), 'hidden immediately')
    await processOps()
    const archive = get('SELECT * FROM folders WHERE account_id = ? AND role = ?', accId, 'archive')
    assert.ok(archive, 'Archive folder created on demand')
    assert.ok(get('SELECT 1 FROM messages WHERE thread_id = ? AND folder_id = ? AND hidden = 0', gh.thread_id, archive!.id), 'moved locally with UIDPLUS mapping')
    const c = await imapAs('alice')
    const st = await c.status(archive!.path, { messages: true })
    assert.equal(st.messages, 1)
    await c.logout()

    // UI actions are delayed: Undo before the delay cancels the IMAP work entirely
    const news = list.find((t) => t.subject.includes('wyprzedaż'))!
    const r = A.trash([news.thread_id], 'ui')
    assert.ok(!Q.listThreads({ kind: 'smart' }).some((t) => t.thread_id === news.thread_id))
    assert.ok(A.undo(r.undo!))
    assert.ok(Q.listThreads({ kind: 'smart' }).some((t) => t.thread_id === news.thread_id), 'back after undo')
    assert.equal(get<{ n: number }>("SELECT COUNT(*) n FROM ops WHERE status = 'pending'")!.n, 0)
  })

  it('pins via \\Flagged, snoozes and wakes up, sets reminders', async () => {
    const t = Q.listThreads({ kind: 'smart' }).find((x) => x.subject.includes('Oferta'))!
    A.pin([t.thread_id], true, 'cli')
    await processOps()
    const m = get('SELECT uid FROM messages WHERE thread_id = ?', t.thread_id)!
    const c = await imapAs('alice')
    const lock = await c.getMailboxLock('INBOX')
    try {
      const msg = await c.fetchOne(String(m.uid), { flags: true }, { uid: true })
      assert.ok((msg as { flags: Set<string> }).flags.has('\\Flagged'))
    } finally {
      lock.release()
      await c.logout()
    }
    assert.ok(Q.listThreads({ kind: 'pinned' }).some((x) => x.thread_id === t.thread_id))
    assert.equal(Q.counts().pinned, 1, 'sidebar pinned counter')

    A.snooze([t.thread_id], Date.now() + 60_000, 'cli')
    assert.ok(!Q.listThreads({ kind: 'smart' }).some((x) => x.thread_id === t.thread_id), 'snoozed leaves inbox')
    assert.ok(Q.listThreads({ kind: 'snoozed' }).some((x) => x.thread_id === t.thread_id))
    const cnt = Q.counts()
    assert.equal(cnt.snoozed, 1, 'sidebar snoozed counter')
    assert.equal(cnt.inbox, Q.listThreads({ kind: 'smart' }).length, 'inbox counter matches the list')
    assert.equal(cnt.inboxUnread, Q.listThreads({ kind: 'smart' }).filter((x) => x.unread).length, 'unread counter matches the list')
    run('UPDATE threads SET snoozed_until = ? WHERE id = ?', Date.now() - 1000, t.thread_id)
    const events: string[] = []
    const off = bus.onEvent((e) => e.type === 'reminder' && events.push('reminder'))
    await tick()
    off()
    assert.ok(events.includes('reminder'))
    const back = Q.listThreads({ kind: 'smart' }).find((x) => x.thread_id === t.thread_id)!
    assert.ok(back && back.unread && back.resurfaced_at, 'snooze returns as unread on top')

    A.remind([t.thread_id], Date.now() - 1, 'no-reply', 'cli')
    await tick()
    assert.equal(get('SELECT reminder_at FROM threads WHERE id = ?', t.thread_id)!.reminder_at, null)
  })

  it('GateKeeper screens only senders who write after setup; block moves them out', async () => {
    updateSettings({ gatekeeper: 'on' })
    // everyone found by the first sync counts as known
    assert.ok(Q.listThreads({ kind: 'smart' }).some((t) => t.subject.includes('Oferta')), 'initial-sync sender is accepted')
    await deliver({ from: 'Cold Outreach <sales@leadgen.example>', subject: subj('Szybkie pytanie'), text: 'Czy mogę zająć 5 minut?' })
    const inboxF = get('SELECT id FROM folders WHERE account_id = ? AND role = ?', accId, 'inbox')!
    await sync.get(accId).syncFolder(inboxF.id)
    const inbox = Q.listThreads({ kind: 'smart' })
    const newSenders = Q.listThreads({ kind: 'newsenders' })
    assert.ok(newSenders.some((t) => t.subject.includes('Szybkie pytanie')), 'a later newcomer is screened')
    assert.ok(!inbox.some((t) => t.subject.includes('Szybkie pytanie')), 'hidden from inbox while screening')
    assert.ok(inbox.some((t) => t.subject.includes('Projekt X')), 'Bob is known')
    A.acceptSenders(['sales@leadgen.example'], 'cli')
    assert.ok(Q.listThreads({ kind: 'smart' }).some((t) => t.subject.includes('Szybkie pytanie')))
    updateSettings({ gatekeeper: 'off' })

    A.blockSenders(['news@shop.example'], 'cli')
    await processOps()
    assert.ok(!Q.listThreads({ kind: 'smart' }).some((t) => t.subject.includes('wyprzedaż')))
    const blocked = get('SELECT * FROM folders WHERE account_id = ? AND role = ?', accId, 'blocked')
    assert.ok(blocked, 'Blocked folder created')
  })

  it('receives new mail through IDLE and runs rules', async () => {
    const s = sync.get(accId)
    await (s as unknown as { startIdle: () => Promise<void> }).startIdle()
    const got: number[] = []
    const off = bus.onEvent((e) => {
      if (e.type === 'new-mail') got.push(...e.messageIds)
    })
    await deliver({ from: 'Bob Builder <bob@test.local>', subject: subj('Pilne: faktura'), text: 'Proszę o fakturę.' })
    const hasFaktura = () => got.some((id) => /faktura/.test(get<{ subject: string }>('SELECT subject FROM messages WHERE id = ?', id)?.subject || ''))
    await waitFor(hasFaktura, 20_000, 'IDLE new-mail event')
    off()
  })

  it('Send Later and cancelling a scheduled send', async () => {
    const d = drafts.saveDraft({ account_id: accId, to: ['bob@test.local'], subject: subj('Zaplanowana'), markdown: 'Później' })
    drafts.sendDraft(d.id, { sendAt: Date.now() + 1500 })
    assert.equal(drafts.getDraft(d.id).status, 'scheduled')
    const d2 = drafts.saveDraft({ account_id: accId, to: ['bob@test.local'], subject: subj('Anulowana'), markdown: 'Nie wysyłaj' })
    drafts.sendDraft(d2.id, { sendAt: Date.now() + 1500 })
    assert.equal(drafts.cancelSend(d2.id).status, 'draft')
    await new Promise((r) => setTimeout(r, 1800))
    await processOps()
    assert.equal(drafts.getDraft(d.id).status, 'sent')
    assert.equal(drafts.getDraft(d2.id).status, 'draft')
  })

  it('templates fill placeholders and refuse missing ones', () => {
    const t = drafts.saveTemplate({ name: 'Oferta', subject: 'Oferta dla {{Firma}}', html: '<p>Dzień dobry {{recipient first name}},</p><p>termin: {{Termin}}</p>' })
    assert.deepEqual(t.placeholders.sort(), ['Firma', 'Termin', 'recipient first name'].sort())
    assert.throws(() => drafts.saveDraft({ account_id: accId, to: ['Jan Kowalski <jan@x.pl>'], template_id: t.id, placeholders: { Firma: 'ACME' } }), /Termin/)
    const d = drafts.saveDraft({ account_id: accId, to: ['Jan Kowalski <jan@x.pl>'], template_id: t.id, placeholders: { Firma: 'ACME', Termin: 'piątek' } })
    assert.equal(d.subject, 'Oferta dla ACME')
    assert.match(d.html, /Dzień dobry Jan,/)
    assert.match(d.html, /termin: piątek/)
  })
})
