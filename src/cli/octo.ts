// `octo` — command-line access to Octopus Mail for people and AI agents.
// Works whether or not the desktop app is running: it reads the shared SQLite database
// directly and executes queued IMAP/SMTP work itself. All times are local (with offset).
import './quiet'
import fs from 'node:fs'
import path from 'node:path'
import type { Category, MailboxRef, ThreadSummary } from '../shared/types'
import { initLang, t } from '../shared/i18n'
import { APP_VERSION } from '../shared/version'
import { parseWhen } from '../shared/when'
import { engineRunning, initCore, lastSyncAge, startEngine, systemLocale } from '../core/boot'
import { all, get } from '../core/db'
import { drainOps } from '../core/ops'
import { createService } from '../core/service'
import { sync } from '../core/sync'
import { addr, addrs, fmtTime, table, trunc } from './format'

const VERSION = APP_VERSION
const BOOL_FLAGS = new Set([
  'json', 'wait', 'stream', 'no-signature', 'signature', 'reply-all', 'new-senders', 'all', 'force', 'help', 'unread',
  'no-sync', 'ascending', 'download-attachments', 'html', 'quiet', 'no-wait', 'personal',
])

interface Args {
  _: string[]
  f: Record<string, string[]>
  b: Set<string>
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], f: {}, b: new Set() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      out._.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2)
      if (eq > 0) (out.f[key] ||= []).push(a.slice(eq + 1))
      else if (BOOL_FLAGS.has(key)) out.b.add(key)
      else if (i + 1 < argv.length) (out.f[key] ||= []).push(argv[++i])
      else out.b.add(key)
    } else if (a.startsWith('-') && a.length === 2 && a !== '-') {
      const map: Record<string, string> = { j: 'json', h: 'help', n: 'page-size', p: 'page' }
      const key = map[a[1]] || a[1]
      if (BOOL_FLAGS.has(key)) out.b.add(key)
      else if (i + 1 < argv.length) (out.f[key] ||= []).push(argv[++i])
    } else out._.push(a)
  }
  return out
}

const one = (a: Args, k: string): string | undefined => a.f[k]?.[a.f[k].length - 1]
const many = (a: Args, k: string): string[] => a.f[k] || []
const svc = createService('cli')

class CliError extends Error {}

function print(a: Args, data: unknown, text: () => string): void {
  if (a.b.has('json')) process.stdout.write(JSON.stringify(data, null, 2) + '\n')
  else process.stdout.write(text() + '\n')
}

function when(input: string | undefined, label: string): number | undefined {
  if (!input) return undefined
  const ts = parseWhen(input) ?? (Number.isFinite(Date.parse(input)) ? Date.parse(input) : null)
  if (!ts) throw new CliError(t('Could not understand the date for {label}: "{input}". Examples: "tomorrow 9:00", "fri 14:30", "in 2 hours", "2026-10-20 09:15".', { label, input }))
  return ts
}

/** "t12" → thread 12, "345" → the thread of message 345. */
function resolveThreads(tokens: string[]): number[] {
  const ids: number[] = []
  for (const tok of tokens.flatMap((s) => s.split(','))) {
    if (!tok) continue
    if (/^t\d+$/i.test(tok)) ids.push(Number(tok.slice(1)))
    else if (/^\d+$/.test(tok)) {
      const m = get<{ thread_id: number }>('SELECT thread_id FROM messages WHERE id = ?', Number(tok))
      if (!m) throw new CliError(t('No message with ID {id} (give threads as t<ID>)', { id: tok }))
      ids.push(m.thread_id)
    } else throw new CliError(t('Invalid ID: {id}', { id: tok }))
  }
  if (!ids.length) throw new CliError(t('Give a message ID or a thread ID (t<ID>)'))
  return [...new Set(ids)]
}

function resolveMailbox(spec: string | undefined): { ref: MailboxRef; accountId?: number } {
  if (!spec) return { ref: { kind: 'smart' } }
  const s = spec.trim()
  const low = s.toLowerCase()
  // accepted mailbox names (English plus a few Polish aliases) — parsing data, not UI text
  const roles: Record<string, MailboxRef> = {
    inbox: { kind: 'unified', role: 'inbox' }, odebrane: { kind: 'unified', role: 'inbox' },
    sent: { kind: 'unified', role: 'sent' }, wysłane: { kind: 'unified', role: 'sent' },
    drafts: { kind: 'unified', role: 'drafts' }, archive: { kind: 'unified', role: 'archive' },
    trash: { kind: 'unified', role: 'trash' }, kosz: { kind: 'unified', role: 'trash' },
    spam: { kind: 'unified', role: 'junk' }, junk: { kind: 'unified', role: 'junk' }, all: { kind: 'unified', role: 'all' },
    pinned: { kind: 'pinned' }, snoozed: { kind: 'snoozed' }, aside: { kind: 'setaside' }, setaside: { kind: 'setaside' },
    reminders: { kind: 'reminders' }, newsenders: { kind: 'newsenders' }, 'new-senders': { kind: 'newsenders' },
    blocked: { kind: 'blocked' }, people: { kind: 'category', category: 'people' },
    notifications: { kind: 'category', category: 'notification' }, newsletters: { kind: 'category', category: 'newsletter' },
  }
  if (roles[low]) return { ref: roles[low] }
  const colon = s.indexOf(':')
  const accPart = colon > 0 && s.slice(0, colon).includes('@') ? s.slice(0, colon) : s.includes('@') ? s : null
  if (accPart) {
    const acc = svc.listAccounts().find((x) => x.email.toLowerCase() === accPart.toLowerCase())
    if (!acc) throw new CliError(t('No account {email}', { email: accPart }))
    if (colon < 0) return { ref: { kind: 'unified', role: 'inbox' }, accountId: acc.id }
    const folderName = s.slice(colon + 1)
    if (roles[folderName.toLowerCase()]?.kind === 'unified') return { ref: roles[folderName.toLowerCase()], accountId: acc.id }
    const f = get<{ id: number }>(
      'SELECT id FROM folders WHERE account_id = ? AND (path = ? COLLATE NOCASE OR name = ? COLLATE NOCASE)',
      acc.id, folderName, folderName,
    )
    if (!f) throw new CliError(t('Account {email} has no folder "{folder}" (see: octo folders {email})', { email: acc.email, folder: folderName }))
    return { ref: { kind: 'folder', folderId: f.id } }
  }
  const sf = get<{ id: number }>('SELECT id FROM smart_folders WHERE name = ? COLLATE NOCASE', s)
  if (sf) return { ref: { kind: 'smartfolder', id: sf.id } }
  throw new CliError(t('Unknown mailbox "{name}". Use: Inbox, Sent, Archive, Trash, Spam, pinned, snoozed, aside, reminders, newsenders, account@x.com or account@x.com:Folder', { name: s }))
}

function flagsOf(th: ThreadSummary): string {
  return [
    th.unread ? 'U' : '', th.pinned ? 'P' : '', th.priority ? '!' : '', th.has_attachments ? 'A' : '', th.snoozed_until ? 'S' : '',
    th.reminder_at ? 'R' : '', th.is_new_sender ? 'N' : '', th.has_draft ? 'D' : '', th.muted ? 'M' : '', th.set_aside ? 'B' : '',
  ].join('')
}

function threadRows(list: ThreadSummary[]) {
  // the engine names the user's own outgoing messages "Ja" (or the translated "Me")
  const me = new Set(['Ja', t('Me')])
  const cats: Record<string, string> = { people: t('person'), notification: t('notif.'), newsletter: t('newsl.') }
  return list.map((th) => ({
    id: th.latest_message_id,
    thread: `t${th.thread_id}`,
    date: fmtTime(th.last_date),
    from: th.outgoing_last ? `→ ${th.participants.filter((p) => !me.has(p.name || '')).map((p) => p.name || p.email).join(', ') || addr(th.from)}` : addr(th.from),
    subject: th.subject + (th.message_count > 1 ? ` (${th.message_count})` : ''),
    cat: cats[th.category || 'people'],
    flags: flagsOf(th),
    account: th.account_email,
  }))
}

function threadCols() {
  return [
    { key: 'id', label: 'ID' }, { key: 'thread', label: t('THREAD') }, { key: 'date', label: t('DATE') },
    { key: 'from', label: t('FROM'), width: 34 }, { key: 'subject', label: t('SUBJECT'), width: 60 }, { key: 'cat', label: t('CAT.') },
    { key: 'flags', label: t('FLAGS') }, { key: 'account', label: t('ACCOUNT'), width: 26 },
  ]
}

async function ensureFresh(a: Args): Promise<void> {
  if (a.b.has('no-sync') || engineRunning()) return
  const age = lastSyncAge()
  if (age !== null && age < 10 * 60_000) return
  if (!svc.listAccounts().length) return
  process.stderr.write(t('The app is not running — fetching new mail…') + '\n')
  await Promise.race([
    Promise.all(svc.listAccounts().filter((x) => x.enabled).map((acc) => sync.get(acc.id).syncAll(false).catch((e) => process.stderr.write(`  ${acc.email}: ${(e as Error).message}\n`)))),
    new Promise((r) => setTimeout(r, 90_000)),
  ])
}

function help(): string {
  return [
    t('octo {version} — Octopus Mail from the command line (local times with UTC offset)', { version: VERSION }),
    t(`Reading:
  octo accounts                              accounts, agent access levels
  octo folders [account]                     folders with counts
  octo emails [mailbox] [--filter q] [--page N] [--page-size N] [--unread]
       mailbox: Inbox|Sent|Archive|Trash|Spam|pinned|snoozed|aside|reminders|newsenders|
                people|notifications|newsletters|account@x.com|account@x.com:Folder|<smart folder>
  octo search ["topic"] [--filter q] [--in account|account:Folder] [--page N]   (all folders)
  octo thread <ID|tID> [--html]              whole thread with bodies and attachments
  octo attachment <ID> [--save file] [--stream]
  octo contacts [query]  ·  octo templates  ·  octo template <ID|name>`),
    t(`Writing and sending (draft IDs never change):
  octo draft --to a@b.com [--cc ..] [--bcc ..] --subject "…" --body "markdown…"
             [--reply-to ID [--reply-all]] [--forward ID] [--account account] [--attach file]
             [--template name --placeholder "Field=value"] [--no-signature] [--edit ID]
  octo draft --delete ID
  octo drafts  ·  octo scheduled
  octo send <ID> [--at "tomorrow 9:00"] [--remind "in 3 days"]   sends and waits for SMTP confirmation
  octo unschedule <ID>                       cancels a scheduled send (back to drafts)`),
    t(`Organizing (message ID or t<thread ID>, several allowed):
  octo action archive|inbox|trash|delete-forever|spam|not-spam|read|unread|pin|unpin|
              mute|unmute|aside|unaside|priority|unpriority|unsubscribe <ID...>
  octo action snooze <ID...> --until "mon 8:00"   ·  octo action unsnooze <ID...>
  octo action remind <ID...> --at "in 3 days" [--if-no-reply]  ·  octo action unremind <ID...>
  octo action move <ID...> --folder "account@x.com:Folder"  ·  octo action label|unlabel <ID...> --label X
  octo sender accept|block|unblock|vip|unvip <email|@domain...>
  octo sender category <email...> people|notification|newsletter`),
    t(`Calendar:
  octo events [--from "today"] [--to "in 7 days"]  ·  octo availability [--days 5] [--duration 30]
  octo event create --title "…" --start "tomorrow 10:00" [--end "tomorrow 11:00"] [--attendee a@b.com] [--location …]
  octo event delete <ID>  ·  octo invite <message ID>  ·  octo rsvp <message ID> accept|maybe|decline`),
    t(`AI (Ollama or Claude, per settings):
  octo ai summarize <ID|tID>  ·  octo ai reply <ID|tID> [--instructions "…"]  ·  octo ai ask "question"`),
    t(`Other:
  octo status · octo sync [account] · octo history [--limit N] · octo daemon (sync without a window)
  octo serve [--port 8787]   home server (e.g. Raspberry Pi): 24/7 engine + API + web interface
  octo server pair | devices | revoke <ID>    pairing codes and paired devices
  octo mcp   (MCP server on stdio for Claude Code / Claude Desktop)
Global: --json (machine-readable data), --no-sync (don't fetch new mail first)`),
  ].join('\n\n')
}

async function main(): Promise<void> {
  // language for help and early errors; initCore() below switches to the language from the settings
  initLang(undefined, systemLocale())
  const a = parseArgs(process.argv.slice(2))
  const cmd = a._.shift()
  if (!cmd || cmd === 'help' || a.b.has('help')) {
    console.log(help())
    return
  }
  if (cmd === 'version' || cmd === '--version') {
    console.log(VERSION)
    return
  }
  initCore()

  switch (cmd) {
    case 'mcp': {
      const { runMcp } = await import('./mcp')
      await runMcp()
      return
    }
    case 'serve': {
      // home server: engine 24/7 + API for paired desktop apps and the web UI (phones, browsers)
      if (engineRunning()) throw new CliError(t('A sync engine is already running on this computer (the app or a daemon). Close it before starting the server.'))
      const { runServer, lanAddresses } = await import('../server/server')
      const { createPairingCode } = await import('../server/auth')
      const port = Number(one(a, 'port') || 8787)
      const host = one(a, 'host') || '0.0.0.0'
      const webRoot = one(a, 'web') || path.join(__dirname, '..', 'renderer')
      process.env.OCTO_QUIET = a.b.has('quiet') ? '1' : ''
      await runServer({ port, host, webRoot })
      const urls = host === '0.0.0.0' ? lanAddresses(port) : [`http://${host}:${port}`]
      const { code } = createPairingCode()
      console.log(t(`Octopus Mail — home server is running.

Address:  {addresses}
Pairing code (valid for 15 min): {code}

In the app: Settings → Home server → enter the address and code. In a browser or on a phone, open the address.
New code: octo server pair · Device list: octo server devices · Ctrl+C to stop.`, { addresses: urls.join('  '), code }))
      await new Promise(() => undefined)
      return
    }
    case 'server': {
      const sub = a._.shift()
      const auth = await import('../server/auth')
      if (sub === 'pair') {
        const { code, expires } = auth.createPairingCode(one(a, 'name'))
        print(a, { code, expires }, () => t('Pairing code: {code}\nValid until: {time} (single use)', { code, time: fmtTime(expires) }))
      } else if (sub === 'devices') {
        const list = auth.listDevices()
        print(a, list, () => table(list.map((d) => ({ id: d.id, name: d.name, created: fmtTime(d.createdAt), seen: fmtTime(d.lastSeen), ip: d.lastIp || '' })), [
          { key: 'id', label: 'ID' }, { key: 'name', label: t('DEVICE') }, { key: 'created', label: t('PAIRED') }, { key: 'seen', label: t('LAST SEEN') }, { key: 'ip', label: 'IP' },
        ]))
      } else if (sub === 'revoke') {
        if (!a._[0]) throw new CliError(t('Give a device ID (octo server devices)'))
        console.log(auth.revokeDevice(a._[0]) ? t('Access revoked.') : t('No such device.'))
      } else throw new CliError('octo server pair [--name …] | devices | revoke <ID>')
      return
    }
    case 'daemon': {
      if (engineRunning()) throw new CliError(t('Sync is already running (the app or another daemon).'))
      process.env.OCTO_QUIET = a.b.has('quiet') ? '1' : ''
      await startEngine('daemon')
      console.log(t('Octopus Mail daemon is running (Ctrl+C to stop).'))
      await new Promise(() => undefined)
      return
    }
    case 'status': {
      const eng = engineRunning()
      const accs = svc.listAccounts()
      const pending = all("SELECT kind, status, error FROM ops WHERE status IN ('pending','running','error') ORDER BY id DESC LIMIT 20")
      print(a, { engine: eng, accounts: accs.map((x) => ({ email: x.email, last_sync: x.last_sync, error: x.last_error })), pending }, () =>
        [
          eng ? t('Sync engine: running ({owner}, pid {pid})', { owner: eng.owner, pid: eng.pid }) : t('Sync engine: NOT running — start the app or `octo daemon`'),
          ...accs.map((x) => '  ' + (x.last_error
            ? t('{email}: last sync {time} — ERROR: {error}', { email: x.email, time: fmtTime(x.last_sync), error: x.last_error })
            : t('{email}: last sync {time}', { email: x.email, time: fmtTime(x.last_sync) }))),
          `${t('Queued operations: {n}', { n: pending.length })}${pending.length ? '\n' + pending.map((p) => `  ${p.kind} ${p.status}${p.error ? ` (${p.error})` : ''}`).join('\n') : ''}`,
        ].join('\n'),
      )
      return
    }
    case 'sync': {
      const acc = a._[0] ? svc.listAccounts().find((x) => x.email === a._[0]) : null
      if (a._[0] && !acc) throw new CliError(t('No account {email}', { email: a._[0] }))
      const targets = acc ? [acc] : svc.listAccounts().filter((x) => x.enabled)
      for (const target of targets) {
        process.stderr.write(t('Syncing {email}…', { email: target.email }) + '\n')
        await sync.get(target.id).syncAll(false)
      }
      await drainOps(30_000)
      console.log(t('Done.'))
      return
    }
    case 'accounts': {
      const accs = svc.listAccounts()
      const names: Record<string, string> = { none: t('no access'), read: t('read'), triage: t('triage'), send: t('send') }
      print(a, accs, () => table(accs.map((x) => ({ id: x.id, email: x.email, name: x.name, access: names[x.agent_access], sync: fmtTime(x.last_sync), error: x.last_error || '' })), [
        { key: 'id', label: 'ID' }, { key: 'email', label: t('ACCOUNT') }, { key: 'name', label: t('NAME') },
        { key: 'access', label: t('AGENT ACCESS') }, { key: 'sync', label: t('SYNC') }, { key: 'error', label: t('ERROR'), width: 40 },
      ]))
      return
    }
    case 'folders': {
      const acc = a._[0] ? svc.listAccounts().find((x) => x.email === a._[0]) : null
      const folders = svc.listFolders(acc?.id)
      const accs = new Map(svc.listAccounts().map((x) => [x.id, x.email]))
      const unread = svc.counts().folders
      print(a, folders, () => table(folders.map((f) => ({ id: `${accs.get(f.account_id)}:${f.path}`, role: f.role || '', total: f.total, unread: unread[f.id] || 0, synced: fmtTime(f.last_sync) })), [
        { key: 'id', label: t('FOLDER (identifier)'), width: 70 }, { key: 'role', label: t('ROLE') }, { key: 'total', label: t('TOTAL') },
        { key: 'unread', label: t('UNREAD THREADS') }, { key: 'synced', label: t('SYNC') },
      ]))
      return
    }
    case 'emails': {
      await ensureFresh(a)
      const { ref, accountId } = a.b.has('new-senders') ? { ref: { kind: 'newsenders' } as MailboxRef, accountId: undefined } : resolveMailbox(a._[0])
      const pageSize = Number(one(a, 'page-size') || 50)
      const page = Number(one(a, 'page') || 1)
      const filter = one(a, 'filter')
      let list: ThreadSummary[]
      if (filter) {
        const scope = a._[0] ? ` ${a._[0].includes('@') ? `in:${a._[0]}` : `in:${a._[0]}`}` : ' in:inbox'
        list = svc.search(filter + scope, { accountId, limit: pageSize, offset: (page - 1) * pageSize, order: a.b.has('ascending') ? 'asc' : 'desc' }).threads
      } else {
        list = svc.listThreads(ref, { accountId, limit: pageSize, offset: (page - 1) * pageSize, unreadOnly: a.b.has('unread') })
      }
      const counts = svc.counts()
      print(a, list, () => {
        const hdr = ref.kind === 'smart' && counts.newsenders ? t('New senders awaiting a decision: {n} (octo emails newsenders)', { n: counts.newsenders }) + '\n' : ''
        return hdr + table(threadRows(list), threadCols()) + '\n' + t('Page {page}. Flags: U unread, P pinned, ! priority, A attachment, S snoozed, R reminder, N new sender, D draft, M muted, B set aside', { page })
      })
      return
    }
    case 'search': {
      await ensureFresh(a)
      const about = a._.join(' ').trim()
      let q = [about, one(a, 'filter') || ''].filter(Boolean).join(' ')
      const inScope = one(a, 'in')
      if (inScope) q += inScope.includes(':') || !inScope.includes('@') ? ` in:"${inScope}"` : ` account:${inScope}`
      const pageSize = Number(one(a, 'page-size') || (about ? 20 : 50))
      const page = Number(one(a, 'page') || 1)
      if (!q.trim()) throw new CliError(t('Give a topic or --filter'))
      if (about) {
        const msgs = svc.searchMessages(q, { limit: pageSize, offset: (page - 1) * pageSize })
        const withBodies: (Record<string, any> & { body: string })[] = []
        for (const m of msgs) {
          const full = await svc.fetchBody(m.id).catch(() => svc.getMessage(m.id))
          withBodies.push({ ...m, body: full?.text || m.snippet })
        }
        print(a, withBodies, () =>
          withBodies.length
            ? withBodies.map((m) => t('ID: {id} (thread t{thread}) · {date} · {account} · {folder}\nFrom: {from}\nSubject: {subject}', {
                id: m.id, thread: m.thread_id, date: fmtTime(m.date), account: m.account_email, folder: m.folder_path,
                from: m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email, subject: m.subject,
              }) + `\n\n${trunc(m.body, 1500)}\n`).join('\n' + '─'.repeat(60) + '\n')
            : t('Nothing found.'),
        )
      } else {
        const r = svc.search(q, { limit: pageSize, offset: (page - 1) * pageSize, order: a.b.has('ascending') ? 'asc' : 'desc' })
        print(a, r, () => `${table(threadRows(r.threads), threadCols())}\n${t('Threads found: {total} (page {page})', { total: r.total, page })}`)
      }
      return
    }
    case 'thread': {
      if (!a._[0]) throw new CliError(t('Give a message ID or t<thread ID>'))
      const [tid] = resolveThreads([a._[0]])
      let thr = svc.getThread(tid)
      if (!thr) throw new CliError(t('Thread does not exist'))
      try {
        thr = (await svc.fetchThreadBodies(tid)) || thr
      } catch (e) {
        process.stderr.write(t('Warning: not all message bodies were downloaded ({error})', { error: (e as Error).message }) + '\n')
      }
      print(a, thr, () => {
        const th = thr!.thread
        const info = [
          t('Account: {account} · messages: {n} · category: {category}', { account: th.account_email, n: th.message_count, category: th.category || '' }),
          th.pinned ? t('pinned') : '',
          th.snoozed_until ? t('snoozed until {time}', { time: fmtTime(th.snoozed_until) }) : '',
          th.reminder_at ? t('reminder {time}', { time: fmtTime(th.reminder_at) }) : '',
          th.labels.length ? t('labels: {labels}', { labels: th.labels.join(', ') }) : '',
        ].filter(Boolean).join(' · ')
        const head = `${t('Thread t{id}: {subject}', { id: th.thread_id, subject: th.subject })}\n${info}`
        const msgs = thr!.messages.map((m) => {
          const atts = m.attachments.filter((x) => !x.inline)
          const attText = atts.length ? `\n${t('Attachments:')}\n${table(atts.map((x) => ({ id: x.id, name: x.filename, size: `${Math.round(x.size / 1024)} KB`, mime: x.mime, path: x.path || t('(not downloaded — octo attachment {id})', { id: x.id }) })), [{ key: 'id', label: 'ID' }, { key: 'name', label: t('NAME'), width: 40 }, { key: 'size', label: t('SIZE') }, { key: 'mime', label: t('TYPE') }, { key: 'path', label: t('PATH'), width: 60 }])}` : ''
          const body = a.b.has('html') ? m.html || m.text : m.text || m.snippet
          return [
            `── ID: ${m.id} · ${fmtTime(m.date)} · ${m.folder_role || ''}${m.seen ? '' : ` · ${t('UNREAD')}`}`,
            t('From: {from}', { from: addr(m.from) }),
            t('To: {to}', { to: addrs(m.to) }),
            ...(m.cc.length ? [t('Cc: {cc}', { cc: addrs(m.cc) })] : []),
            ...(m.bcc.length ? [t('Bcc: {bcc}', { bcc: addrs(m.bcc) })] : []),
            t('Subject: {subject}', { subject: m.subject }),
            ...(m.calendar_part ? [t('📅 Contains an invitation (octo invite {id})', { id: m.id })] : []),
          ].join('\n') + `\n\n${body || t('(no content)')}${attText}`
        })
        const ds = thr!.drafts.map((d) => [
          `── ${t('DRAFT ID: {id} · {status}', { id: d.id, status: d.status })}${d.send_at ? ` · ${t('send at {time}', { time: fmtTime(d.send_at) })}` : ''}`,
          t('To: {to}', { to: addrs(d.to) }),
          t('Subject: {subject}', { subject: d.subject }),
        ].join('\n') + `\n\n${trunc(d.text || d.html.replace(/<[^>]+>/g, ' '), 600)}`)
        return [head, ...msgs, ...ds].join('\n\n')
      })
      return
    }
    case 'attachment': {
      const id = Number(a._[0])
      if (!id) throw new CliError(t('Give an attachment ID (the ID column in octo thread)'))
      const file = await svc.downloadAttachment(id)
      const att = get('SELECT * FROM attachments WHERE id = ?', id)!
      if (a.b.has('stream')) {
        process.stdout.write(fs.readFileSync(file))
        return
      }
      const save = one(a, 'save')
      if (save) fs.copyFileSync(file, save)
      print(a, { ...att, path: save || file }, () => t('ID: {id}\nName: {name}\nSize: {size}\nType: {type}\nPath: {path}\nMessage: {message}', {
        id: att.id, name: att.filename, size: att.size, type: att.mime, path: save ? path.resolve(save) : file, message: att.message_id,
      }))
      return
    }
    case 'contacts': {
      const list = svc.listContacts(a._.join(' '), Number(one(a, 'limit') || 30))
      print(a, list, () => table(list.map((c) => ({ email: c.email, name: c.name || '', status: c.status, cat: c.category || '', vip: c.vip ? '★' : '', sent: c.sent_count, recv: c.recv_count, last: fmtTime(c.last_received || c.last_sent) })), [
        { key: 'email', label: t('EMAIL') }, { key: 'name', label: t('NAME') }, { key: 'status', label: 'STATUS' }, { key: 'cat', label: t('CATEGORY') },
        { key: 'vip', label: 'VIP' }, { key: 'sent', label: t('SENT') }, { key: 'recv', label: t('RECEIVED') }, { key: 'last', label: t('LAST') },
      ]))
      return
    }
    case 'templates': {
      const list = svc.listTemplates()
      print(a, list, () => table(list.map((tpl) => ({ id: tpl.id, name: tpl.name, subject: trunc(tpl.subject, 40), placeholders: tpl.placeholders.join(', '), modified: fmtTime(tpl.updated_at) })), [
        { key: 'id', label: 'ID' }, { key: 'name', label: t('NAME') }, { key: 'subject', label: t('SUBJECT') }, { key: 'placeholders', label: t('FIELDS') }, { key: 'modified', label: t('MODIFIED') },
      ]))
      return
    }
    case 'template': {
      const tpl = svc.getTemplate(a._.join(' '))
      print(a, tpl, () => t('ID: {id}\nName: {name}\nSubject: {subject}\nTo: {to}', { id: tpl.id, name: tpl.name, subject: tpl.subject || '', to: addrs(tpl.to) }) +
        `\n\n${(tpl.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}\n\n${t('Fields:')}\n${tpl.placeholders.map((p) => `  [${svc.placeholderKind(p)}] ${p}`).join('\n') || `  ${t('(none)')}`}`)
      return
    }
    case 'drafts': {
      const list = svc.listDrafts(['draft', 'failed'])
      print(a, list, () => table(list.map((d) => ({ id: d.id, status: d.status, to: addrs(d.to), subject: d.subject, updated: fmtTime(d.updated_at), error: d.error || '' })), [
        { key: 'id', label: 'ID' }, { key: 'status', label: 'STATUS' }, { key: 'to', label: t('TO'), width: 40 }, { key: 'subject', label: t('SUBJECT'), width: 50 },
        { key: 'updated', label: t('UPDATED') }, { key: 'error', label: t('ERROR'), width: 40 },
      ]))
      return
    }
    case 'scheduled': {
      const list = svc.scheduled()
      print(a, list, () => table(list.map((d) => ({ id: d.id, status: d.status, at: fmtTime(d.send_at), to: addrs(d.to), subject: d.subject, error: d.error || '' })), [
        { key: 'id', label: 'ID' }, { key: 'status', label: 'STATUS' }, { key: 'at', label: t('SEND AT') }, { key: 'to', label: t('TO'), width: 40 },
        { key: 'subject', label: t('SUBJECT'), width: 50 }, { key: 'error', label: t('ERROR'), width: 40 },
      ]) + (list.length ? '\n' + t('Cancel: octo unschedule <ID>') : ''))
      return
    }
    case 'draft': {
      const del = one(a, 'delete')
      if (del) {
        svc.deleteDraft(Number(del))
        console.log(t('Draft {id} deleted.', { id: del }))
        await drainOps(20_000)
        return
      }
      const placeholders: Record<string, string> = {}
      for (const p of many(a, 'placeholder')) {
        const eq = p.indexOf('=')
        if (eq > 0) placeholders[p.slice(0, eq).trim()] = p.slice(eq + 1)
      }
      let templateId: number | undefined
      if (one(a, 'template')) templateId = svc.getTemplate(one(a, 'template')!).id
      const acc = one(a, 'account')
      const attachments = many(a, 'attach').map((p) => {
        const abs = path.resolve(p)
        if (!fs.existsSync(abs)) throw new CliError(t('File not found: {path}', { path: abs }))
        const st = fs.statSync(abs)
        if (st.size > 25 * 1024 * 1024) throw new CliError(t('File {path} is larger than 25 MB', { path: abs }))
        return { filename: path.basename(abs), path: abs, size: st.size }
      })
      if (a.b.has('attach-stream') || one(a, 'attach-stream')) {
        const name = one(a, 'attach-stream') || t('file')
        const data = fs.readFileSync(0)
        attachments.push(svc.stageAttachment(name, data))
      }
      const replyTo = one(a, 'reply-to')
      const fwd = one(a, 'forward')
      const edit = one(a, 'edit')
      // shells often pass "\n" literally; turn it into real line breaks when no real ones are present
      const rawBody = one(a, 'body')
      const body = rawBody && !rawBody.includes('\n') ? rawBody.replace(/\\n/g, '\n') : rawBody
      const d = svc.saveDraft({
        id: edit ? Number(edit) : undefined,
        from_email: acc,
        to: a.f.to,
        cc: a.f.cc,
        bcc: a.f.bcc,
        subject: one(a, 'subject'),
        markdown: body,
        attachments: attachments.length ? [...(edit ? svc.getDraft(Number(edit)).attachments : []), ...attachments] : undefined,
        reply_to_message_id: replyTo ? Number(replyTo.replace(/^t/, '')) : undefined,
        reply_all: a.b.has('reply-all'),
        forward_of_message_id: fwd ? Number(fwd) : undefined,
        signature: a.b.has('no-signature') ? false : undefined,
        template_id: templateId,
        placeholders,
        source: 'cli',
      })
      print(a, d, () => [
        `ID: ${d.id}`,
        t('Status: draft (the ID will not change)'),
        t('From: {from}', { from: d.from_email ?? '' }),
        t('To: {to}', { to: addrs(d.to) }),
        ...(d.cc.length ? [t('Cc: {cc}', { cc: addrs(d.cc) })] : []),
        t('Subject: {subject}', { subject: d.subject }),
        t('Attachments: {list}', { list: d.attachments.map((x) => x.filename).join(', ') || '-' }),
        t('Send: octo send {id}  ·  Open: octopus-mail://draft/{id}', { id: d.id }),
      ].join('\n'))
      return
    }
    case 'send': {
      const id = Number(a._[0])
      if (!id) throw new CliError(t('Give a draft ID'))
      const sendAt = when(one(a, 'at'), '--at')
      const remindAt = when(one(a, 'remind'), '--remind')
      const d = svc.sendDraft(id, { sendAt, remindAt })
      if (sendAt) {
        const warn = engineRunning() ? '' : '\n' + t('Warning: the app is not running — the message will go out only when you start Octopus Mail or `octo daemon`.')
        print(a, d, () => t('Scheduled: {subject}\nSend at: {time}\nCancel: octo unschedule {id}', { subject: d.subject, time: fmtTime(d.send_at), id: d.id }) + warn)
        return
      }
      process.stderr.write(`Queued: ${d.subject} → ${addrs(d.to)}\n`)
      await drainOps(120_000)
      const after = svc.getDraft(id)
      if (after.status === 'sent') print(a, after, () => t('Sent: {subject} ({time})', { subject: after.subject, time: fmtTime(after.sent_at) }))
      else throw new CliError(after.error ? t('Not sent (status: {status}): {error}', { status: after.status, error: after.error }) : t('Not sent (status: {status})', { status: after.status }))
      return
    }
    case 'unschedule': {
      const d = svc.cancelSend(Number(a._[0]))
      print(a, d, () => t('Send cancelled. "{subject}" is a draft again (ID {id}).', { subject: d.subject, id: d.id }))
      return
    }
    case 'action': {
      const act = a._.shift()
      if (!act) throw new CliError(t('Give an action (octo help)'))
      const ids = resolveThreads(a._)
      let r: { affected: number; message?: string } | undefined
      switch (act) {
        case 'archive': case 'done': r = svc.archive(ids); break
        case 'inbox': case 'move-to-inbox': r = svc.moveToInbox(ids); break
        case 'trash': r = svc.trash(ids); break
        case 'delete-forever': r = svc.deleteForever(ids); break
        case 'spam': r = svc.spam(ids); break
        case 'not-spam': r = svc.notSpam(ids); break
        case 'read': r = svc.markRead(ids, true); break
        case 'unread': r = svc.markRead(ids, false); break
        case 'pin': r = svc.pin(ids, true); break
        case 'unpin': r = svc.pin(ids, false); break
        case 'mute': r = svc.mute(ids, true); break
        case 'unmute': r = svc.mute(ids, false); break
        case 'aside': r = svc.setAside(ids, true); break
        case 'unaside': r = svc.setAside(ids, false); break
        case 'priority': r = svc.priority(ids, true); break
        case 'unpriority': r = svc.priority(ids, false); break
        case 'unsubscribe': r = svc.unsubscribe(ids); break
        case 'snooze': r = svc.snooze(ids, when(one(a, 'until') || one(a, 'at'), '--until')!); break
        case 'unsnooze': r = svc.snooze(ids, null); break
        case 'remind': r = svc.remind(ids, when(one(a, 'at') || one(a, 'until'), '--at')!, a.b.has('if-no-reply') || one(a, 'if-no-reply') ? 'no-reply' : 'manual'); break
        case 'unremind': r = svc.remind(ids, null); break
        case 'move': {
          const { ref } = resolveMailbox(one(a, 'folder'))
          if (ref.kind !== 'folder') throw new CliError(t('--folder must point to an account folder, e.g. account@x.com:Projects'))
          r = svc.moveToFolder(ids, ref.folderId)
          break
        }
        case 'label': case 'unlabel': {
          const label = one(a, 'label')
          if (!label) throw new CliError(t('Give --label'))
          r = svc.setLabel(ids, label, act === 'label')
          break
        }
        default: throw new CliError(t('Unknown action "{action}"', { action: act }))
      }
      await drainOps(60_000)
      const failed = all("SELECT error FROM ops WHERE status = 'error' AND finished_at > ?", Date.now() - 90_000)
      if (failed.length) throw new CliError(t('Action partly failed: {errors}', { errors: failed.map((f) => f.error).join('; ') }))
      print(a, r, () => t('OK: {result} (threads: {threads})', { result: r?.message || act, threads: ids.map((i) => `t${i}`).join(', ') }))
      return
    }
    case 'sender': {
      const act = a._.shift()
      if (act === 'category') {
        const cat = a._.pop() as Category
        if (!['people', 'notification', 'newsletter'].includes(cat)) throw new CliError(t('Category: people|notification|newsletter'))
        const r = svc.changeSenderCategory(a._, cat)
        print(a, r, () => `OK: ${r.message}`)
      } else {
        if (!a._.length) throw new CliError(t('Give address(es) or @domain'))
        const fn = { accept: svc.acceptSenders, block: svc.blockSenders, unblock: svc.unblockSenders }[act || '']
        let r
        if (fn) r = fn(a._)
        else if (act === 'vip' || act === 'unvip') r = svc.prioritySender(a._, act === 'vip')
        else throw new CliError('octo sender accept|block|unblock|vip|unvip|category …')
        await drainOps(60_000)
        print(a, r, () => `OK: ${r.message}`)
      }
      return
    }
    case 'events': {
      const from = when(one(a, 'from'), '--from') ?? new Date(new Date().setHours(0, 0, 0, 0)).getTime()
      const to = when(one(a, 'to'), '--to') ?? from + Number(one(a, 'days') || 7) * 86400_000
      const ev = svc.listEvents(from, to)
      print(a, ev, () => table(ev.map((e) => ({ id: e.id, start: e.all_day ? t('{date} (all day)', { date: fmtTime(e.start).slice(0, 10) }) : fmtTime(e.start), end: e.all_day ? '' : fmtTime(e.end).slice(11, 16), title: e.summary, cal: e.calendar_name, me: e.my_status || '', link: e.conference_url || '' })), [
        { key: 'id', label: 'ID' }, { key: 'start', label: t('START') }, { key: 'end', label: t('END') }, { key: 'title', label: t('EVENT'), width: 50 },
        { key: 'cal', label: t('CALENDAR') }, { key: 'me', label: t('MY RSVP') }, { key: 'link', label: t('MEETING'), width: 40 },
      ]))
      return
    }
    case 'availability': {
      const from = when(one(a, 'from'), '--from') ?? Date.now()
      const days = Number(one(a, 'days') || 5)
      const slots = svc.availability({ from, to: from + days * 86400_000, durationMin: Number(one(a, 'duration') || 30), includeWeekends: a.b.has('all') })
      print(a, slots, () => slots.length ? slots.map((s) => `${fmtTime(s.start)} – ${fmtTime(s.end).slice(11, 16)}`).join('\n') : t('No free slots in this range.'))
      return
    }
    case 'event': {
      const sub = a._.shift()
      if (sub === 'create') {
        const start = when(one(a, 'start'), '--start')
        if (!start || !one(a, 'title')) throw new CliError(t('Give --title and --start'))
        const end = when(one(a, 'end'), '--end') ?? start + Number(one(a, 'duration') || 60) * 60_000
        const e = await svc.createEvent({ summary: one(a, 'title')!, start, end, location: one(a, 'location'), description: one(a, 'description'), attendees: many(a, 'attendee'), calendar_id: one(a, 'calendar') ? Number(one(a, 'calendar')) : undefined, all_day: a.b.has('all') })
        await drainOps(30_000)
        print(a, e, () => t('Created event {id}: {title} · {time}', { id: e.id, title: e.summary, time: fmtTime(e.start) }))
      } else if (sub === 'delete') {
        await svc.deleteEvent(Number(a._[0]))
        console.log(t('Event deleted.'))
      } else throw new CliError('octo event create|delete …')
      return
    }
    case 'invite': {
      const info = await svc.parseInvite(Number(a._[0]))
      print(a, info, () => (info ? JSON.stringify(info, null, 2) : t('This message does not contain an invitation.')))
      return
    }
    case 'rsvp': {
      // accepted answers (English plus Polish aliases) — parsing data, not UI text
      const map: Record<string, 'ACCEPTED' | 'TENTATIVE' | 'DECLINED'> = { accept: 'ACCEPTED', yes: 'ACCEPTED', tak: 'ACCEPTED', maybe: 'TENTATIVE', może: 'TENTATIVE', decline: 'DECLINED', no: 'DECLINED', nie: 'DECLINED' }
      const resp = map[(a._[1] || '').toLowerCase()]
      if (!resp) throw new CliError(t('octo rsvp <message ID> accept|maybe|decline'))
      await svc.rsvpInvite(Number(a._[0]), resp, one(a, 'comment'))
      console.log(t('Invitation response sent.'))
      return
    }
    case 'ai': {
      const sub = a._.shift()
      const stream = (chunk: string) => process.stdout.write(chunk)
      if (sub === 'summarize') {
        const [tid] = resolveThreads(a._)
        const r = await svc.aiSummarize(tid, a.b.has('force'), a.b.has('json') ? undefined : stream)
        if (a.b.has('json')) print(a, r, () => '')
        else if (r.cached) console.log(r.text)
        else console.log()
      } else if (sub === 'reply') {
        const [tid] = resolveThreads(a._)
        const r = await svc.aiDraftReply(tid, { instructions: one(a, 'instructions') }, a.b.has('json') ? undefined : stream)
        if (a.b.has('json')) print(a, r, () => '')
        else console.log()
      } else if (sub === 'ask') {
        const r = await svc.aiAsk(a._.join(' '), a.b.has('json') ? undefined : stream)
        if (a.b.has('json')) print(a, r, () => '')
        else console.log('\n\n' + t('Sources: {list}', { list: r.sources.join(', ') || '-' }))
      } else throw new CliError('octo ai summarize|reply|ask …')
      return
    }
    case 'history': {
      const h = svc.history(Number(one(a, 'limit') || 30), one(a, 'actor'))
      print(a, h, () => table(h.map((x) => ({ at: fmtTime(x.at), actor: x.actor, action: x.action, target: x.target || '', ok: x.ok ? 'ok' : t('ERROR'), details: trunc(x.details, 60) })), [
        { key: 'at', label: t('WHEN') }, { key: 'actor', label: t('WHO') }, { key: 'action', label: t('ACTION') }, { key: 'target', label: t('TARGET'), width: 30 },
        { key: 'ok', label: t('RESULT') }, { key: 'details', label: t('DETAILS'), width: 60 },
      ]))
      return
    }
    default:
      throw new CliError(t('Unknown command "{cmd}". See: octo help', { cmd }))
  }
}

main()
  .then(async () => {
    const cmd = process.argv[2]
    if (cmd === 'mcp' || cmd === 'daemon' || cmd === 'serve') return
    await sync.stopAll().catch(() => undefined)
    process.exit(0)
  })
  .catch(async (e: Error) => {
    process.stderr.write(t('Error: {message}', { message: e.message }) + '\n')
    if (process.env.OCTO_DEBUG) process.stderr.write(`${e.stack}\n`)
    await sync.stopAll().catch(() => undefined)
    process.exit(e instanceof CliError ? 2 : 1)
  })
