// `octo` — command-line access to Octopus Mail for people and AI agents.
// Works whether or not the desktop app is running: it reads the shared SQLite database
// directly and executes queued IMAP/SMTP work itself. All times are local (with offset).
import './quiet'
import fs from 'node:fs'
import path from 'node:path'
import type { Category, MailboxRef, ThreadSummary } from '../shared/types'
import { parseWhen } from '../shared/when'
import { engineRunning, initCore, lastSyncAge, startEngine } from '../core/boot'
import { all, get } from '../core/db'
import { drainOps } from '../core/ops'
import { createService } from '../core/service'
import { sync } from '../core/sync'
import { addr, addrs, fmtTime, table, trunc } from './format'

const VERSION = '0.1.0'
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
  const t = parseWhen(input) ?? (Number.isFinite(Date.parse(input)) ? Date.parse(input) : null)
  if (!t) throw new CliError(`Nie rozumiem daty dla ${label}: „${input}”. Przykłady: "jutro 9:00", "pt 14:30", "za 2 godziny", "2026-10-20 09:15".`)
  return t
}

/** "t12" → thread 12, "345" → the thread of message 345. */
function resolveThreads(tokens: string[]): number[] {
  const ids: number[] = []
  for (const tok of tokens.flatMap((t) => t.split(','))) {
    if (!tok) continue
    if (/^t\d+$/i.test(tok)) ids.push(Number(tok.slice(1)))
    else if (/^\d+$/.test(tok)) {
      const m = get<{ thread_id: number }>('SELECT thread_id FROM messages WHERE id = ?', Number(tok))
      if (!m) throw new CliError(`Nie ma wiadomości o ID ${tok} (wątki podawaj jako t<ID>)`)
      ids.push(m.thread_id)
    } else throw new CliError(`Nieprawidłowe ID: ${tok}`)
  }
  if (!ids.length) throw new CliError('Podaj ID wiadomości lub wątku (t<ID>)')
  return [...new Set(ids)]
}

function resolveMailbox(spec: string | undefined): { ref: MailboxRef; accountId?: number } {
  if (!spec) return { ref: { kind: 'smart' } }
  const s = spec.trim()
  const low = s.toLowerCase()
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
    if (!acc) throw new CliError(`Nie ma konta ${accPart}`)
    if (colon < 0) return { ref: { kind: 'unified', role: 'inbox' }, accountId: acc.id }
    const folderName = s.slice(colon + 1)
    if (roles[folderName.toLowerCase()]?.kind === 'unified') return { ref: roles[folderName.toLowerCase()], accountId: acc.id }
    const f = get<{ id: number }>(
      'SELECT id FROM folders WHERE account_id = ? AND (path = ? COLLATE NOCASE OR name = ? COLLATE NOCASE)',
      acc.id, folderName, folderName,
    )
    if (!f) throw new CliError(`Konto ${acc.email} nie ma folderu „${folderName}” (zobacz: octo folders ${acc.email})`)
    return { ref: { kind: 'folder', folderId: f.id } }
  }
  const sf = get<{ id: number }>('SELECT id FROM smart_folders WHERE name = ? COLLATE NOCASE', s)
  if (sf) return { ref: { kind: 'smartfolder', id: sf.id } }
  throw new CliError(`Nieznana skrzynka „${s}”. Użyj: Inbox, Sent, Archive, Trash, Spam, pinned, snoozed, aside, reminders, newsenders, konto@x.pl lub konto@x.pl:Folder`)
}

function flagsOf(t: ThreadSummary): string {
  return [
    t.unread ? 'U' : '', t.pinned ? 'P' : '', t.priority ? '!' : '', t.has_attachments ? 'A' : '', t.snoozed_until ? 'S' : '',
    t.reminder_at ? 'R' : '', t.is_new_sender ? 'N' : '', t.has_draft ? 'D' : '', t.muted ? 'M' : '', t.set_aside ? 'B' : '',
  ].join('')
}

function threadRows(list: ThreadSummary[]) {
  return list.map((t) => ({
    id: t.latest_message_id,
    thread: `t${t.thread_id}`,
    date: fmtTime(t.last_date),
    from: t.outgoing_last ? `→ ${t.participants.filter((p) => p.name !== 'Ja').map((p) => p.name || p.email).join(', ') || addr(t.from)}` : addr(t.from),
    subject: t.subject + (t.message_count > 1 ? ` (${t.message_count})` : ''),
    cat: { people: 'osoba', notification: 'powiad.', newsletter: 'newsl.' }[t.category || 'people'],
    flags: flagsOf(t),
    account: t.account_email,
  }))
}

const THREAD_COLS = [
  { key: 'id', label: 'ID' }, { key: 'thread', label: 'WĄTEK' }, { key: 'date', label: 'DATA' },
  { key: 'from', label: 'OD', width: 34 }, { key: 'subject', label: 'TEMAT', width: 60 }, { key: 'cat', label: 'KAT.' },
  { key: 'flags', label: 'FLAGI' }, { key: 'account', label: 'KONTO', width: 26 },
]

async function ensureFresh(a: Args): Promise<void> {
  if (a.b.has('no-sync') || engineRunning()) return
  const age = lastSyncAge()
  if (age !== null && age < 10 * 60_000) return
  if (!svc.listAccounts().length) return
  process.stderr.write('Aplikacja nie działa — pobieram nowe wiadomości…\n')
  await Promise.race([
    Promise.all(svc.listAccounts().filter((x) => x.enabled).map((acc) => sync.get(acc.id).syncAll(false).catch((e) => process.stderr.write(`  ${acc.email}: ${(e as Error).message}\n`)))),
    new Promise((r) => setTimeout(r, 90_000)),
  ])
}

const HELP = `octo ${VERSION} — Octopus Mail z wiersza poleceń (czasy lokalne z przesunięciem UTC)

Czytanie:
  octo accounts                              konta, poziomy dostępu agentów
  octo folders [konto]                       foldery z licznikami
  octo emails [skrzynka] [--filter q] [--page N] [--page-size N] [--unread]
       skrzynka: Inbox|Sent|Archive|Trash|Spam|pinned|snoozed|aside|reminders|newsenders|
                 people|notifications|newsletters|konto@x.pl|konto@x.pl:Folder|<inteligentny folder>
  octo search ["temat"] [--filter q] [--in konto|konto:Folder] [--page N]   (wszystkie foldery)
  octo thread <ID|tID> [--html]              cały wątek z treścią i załącznikami
  octo attachment <ID> [--save plik] [--stream]
  octo contacts [fraza]  ·  octo templates  ·  octo template <ID|nazwa>

Pisanie i wysyłka (stałe ID wersji roboczych):
  octo draft --to a@b.pl [--cc ..] [--bcc ..] --subject "…" --body "markdown…"
             [--reply-to ID [--reply-all]] [--forward ID] [--account konto] [--attach plik]
             [--template nazwa --placeholder "Pole=wartość"] [--no-signature] [--edit ID]
  octo draft --delete ID
  octo drafts  ·  octo scheduled
  octo send <ID> [--at "jutro 9:00"] [--remind "za 3 dni"]   wysyła i czeka na potwierdzenie SMTP
  octo unschedule <ID>                       anuluje zaplanowaną wysyłkę (wraca do wersji roboczych)

Porządkowanie (ID wiadomości albo t<ID wątku>, można kilka):
  octo action archive|inbox|trash|delete-forever|spam|not-spam|read|unread|pin|unpin|
              mute|unmute|aside|unaside|priority|unpriority|unsubscribe <ID...>
  octo action snooze <ID...> --until "pon 8:00"   ·  octo action unsnooze <ID...>
  octo action remind <ID...> --at "za 3 dni" [--if-no-reply]  ·  octo action unremind <ID...>
  octo action move <ID...> --folder "konto@x.pl:Folder"  ·  octo action label|unlabel <ID...> --label X
  octo sender accept|block|unblock|vip|unvip <email|@domena...>
  octo sender category <email...> people|notification|newsletter

Kalendarz:
  octo events [--from "dziś"] [--to "za 7 dni"]  ·  octo availability [--days 5] [--duration 30]
  octo event create --title "…" --start "jutro 10:00" [--end "jutro 11:00"] [--attendee a@b.pl] [--location …]
  octo event delete <ID>  ·  octo invite <ID wiadomości>  ·  octo rsvp <ID wiadomości> accept|maybe|decline

AI (Ollama lub Claude wg ustawień):
  octo ai summarize <ID|tID>  ·  octo ai reply <ID|tID> [--instructions "…"]  ·  octo ai ask "pytanie"

Inne:
  octo status · octo sync [konto] · octo history [--limit N] · octo daemon (synchronizacja bez okna)
  octo serve [--port 8787]   serwer domowy (np. Raspberry Pi): silnik 24/7 + API + interfejs WWW
  octo server pair | devices | revoke <ID>    kody parowania i sparowane urządzenia
  octo mcp   (serwer MCP na stdio dla Claude Code / Claude Desktop)
Globalne: --json (dane maszynowe), --no-sync (bez dociągania poczty)`

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2))
  const cmd = a._.shift()
  if (!cmd || cmd === 'help' || a.b.has('help')) {
    console.log(HELP)
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
      if (engineRunning()) throw new CliError('Na tym komputerze działa już silnik synchronizacji (aplikacja albo daemon). Zamknij go przed uruchomieniem serwera.')
      const { runServer, lanAddresses } = await import('../server/server')
      const { createPairingCode } = await import('../server/auth')
      const port = Number(one(a, 'port') || 8787)
      const host = one(a, 'host') || '0.0.0.0'
      const webRoot = one(a, 'web') || path.join(__dirname, '..', 'renderer')
      process.env.OCTO_QUIET = a.b.has('quiet') ? '1' : ''
      await runServer({ port, host, webRoot })
      const addrs = host === '0.0.0.0' ? lanAddresses(port) : [`http://${host}:${port}`]
      const { code } = createPairingCode()
      console.log(`Octopus Mail — serwer domowy działa.

Adres:  ${addrs.join('  ')}
Kod parowania (ważny 15 min): ${code}

W aplikacji: Ustawienia → Serwer domowy → wpisz adres i kod. W przeglądarce/telefonie otwórz adres.
Nowy kod: octo server pair · Lista urządzeń: octo server devices · Ctrl+C kończy.`)
      await new Promise(() => undefined)
      return
    }
    case 'server': {
      const sub = a._.shift()
      const auth = await import('../server/auth')
      if (sub === 'pair') {
        const { code, expires } = auth.createPairingCode(one(a, 'name'))
        print(a, { code, expires }, () => `Kod parowania: ${code}
Ważny do: ${fmtTime(expires)} (jednorazowy)`)
      } else if (sub === 'devices') {
        const list = auth.listDevices()
        print(a, list, () => table(list.map((d) => ({ id: d.id, name: d.name, created: fmtTime(d.createdAt), seen: fmtTime(d.lastSeen), ip: d.lastIp || '' })), [
          { key: 'id', label: 'ID' }, { key: 'name', label: 'URZĄDZENIE' }, { key: 'created', label: 'SPAROWANE' }, { key: 'seen', label: 'OSTATNIO' }, { key: 'ip', label: 'IP' },
        ]))
      } else if (sub === 'revoke') {
        if (!a._[0]) throw new CliError('Podaj ID urządzenia (octo server devices)')
        console.log(auth.revokeDevice(a._[0]) ? 'Odebrano dostęp.' : 'Nie ma takiego urządzenia.')
      } else throw new CliError('octo server pair [--name …] | devices | revoke <ID>')
      return
    }
    case 'daemon': {
      if (engineRunning()) throw new CliError('Synchronizacja już działa (aplikacja albo inny daemon).')
      process.env.OCTO_QUIET = a.b.has('quiet') ? '1' : ''
      await startEngine('daemon')
      console.log('Octopus Mail daemon działa (Ctrl+C kończy).')
      await new Promise(() => undefined)
      return
    }
    case 'status': {
      const eng = engineRunning()
      const accs = svc.listAccounts()
      const pending = all("SELECT kind, status, error FROM ops WHERE status IN ('pending','running','error') ORDER BY id DESC LIMIT 20")
      print(a, { engine: eng, accounts: accs.map((x) => ({ email: x.email, last_sync: x.last_sync, error: x.last_error })), pending }, () =>
        [
          `Silnik synchronizacji: ${eng ? `działa (${eng.owner}, pid ${eng.pid})` : 'NIE działa — uruchom aplikację albo `octo daemon`'}`,
          ...accs.map((x) => `  ${x.email}: ostatnia synchronizacja ${fmtTime(x.last_sync)}${x.last_error ? ` — BŁĄD: ${x.last_error}` : ''}`),
          `Operacje w kolejce: ${pending.length}${pending.length ? '\n' + pending.map((p) => `  ${p.kind} ${p.status}${p.error ? ` (${p.error})` : ''}`).join('\n') : ''}`,
        ].join('\n'),
      )
      return
    }
    case 'sync': {
      const acc = a._[0] ? svc.listAccounts().find((x) => x.email === a._[0]) : null
      if (a._[0] && !acc) throw new CliError(`Nie ma konta ${a._[0]}`)
      const targets = acc ? [acc] : svc.listAccounts().filter((x) => x.enabled)
      for (const t of targets) {
        process.stderr.write(`Synchronizuję ${t.email}…\n`)
        await sync.get(t.id).syncAll(false)
      }
      await drainOps(30_000)
      console.log('Gotowe.')
      return
    }
    case 'accounts': {
      const accs = svc.listAccounts()
      const names: Record<string, string> = { none: 'brak', read: 'odczyt', triage: 'porządkowanie', send: 'wysyłka' }
      print(a, accs, () => table(accs.map((x) => ({ id: x.id, email: x.email, name: x.name, access: names[x.agent_access], sync: fmtTime(x.last_sync), error: x.last_error || '' })), [
        { key: 'id', label: 'ID' }, { key: 'email', label: 'KONTO' }, { key: 'name', label: 'NAZWA' },
        { key: 'access', label: 'DOSTĘP AGENTÓW' }, { key: 'sync', label: 'SYNCHRONIZACJA' }, { key: 'error', label: 'BŁĄD', width: 40 },
      ]))
      return
    }
    case 'folders': {
      const acc = a._[0] ? svc.listAccounts().find((x) => x.email === a._[0]) : null
      const folders = svc.listFolders(acc?.id)
      const accs = new Map(svc.listAccounts().map((x) => [x.id, x.email]))
      const unread = svc.counts().folders
      print(a, folders, () => table(folders.map((f) => ({ id: `${accs.get(f.account_id)}:${f.path}`, role: f.role || '', total: f.total, unread: unread[f.id] || 0, synced: fmtTime(f.last_sync) })), [
        { key: 'id', label: 'FOLDER (identyfikator)', width: 70 }, { key: 'role', label: 'ROLA' }, { key: 'total', label: 'WSZYSTKIE' },
        { key: 'unread', label: 'NIEPRZ. WĄTKI' }, { key: 'synced', label: 'SYNCHRONIZACJA' },
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
        const hdr = ref.kind === 'smart' && counts.newsenders ? `Nowi nadawcy czekający na decyzję: ${counts.newsenders} (octo emails newsenders)\n` : ''
        return hdr + table(threadRows(list), THREAD_COLS) + `\nStrona ${page}. Flagi: U nieprz., P przypięty, ! priorytet, A załącznik, S odłożony, R przypomnienie, N nowy nadawca, D wersja robocza, M wyciszony, B na boku`
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
      if (!q.trim()) throw new CliError('Podaj temat albo --filter')
      if (about) {
        const msgs = svc.searchMessages(q, { limit: pageSize, offset: (page - 1) * pageSize })
        const withBodies: (Record<string, any> & { body: string })[] = []
        for (const m of msgs) {
          const full = await svc.fetchBody(m.id).catch(() => svc.getMessage(m.id))
          withBodies.push({ ...m, body: full?.text || m.snippet })
        }
        print(a, withBodies, () =>
          withBodies.length
            ? withBodies.map((m) => `ID: ${m.id} (wątek t${m.thread_id}) · ${fmtTime(m.date)} · ${m.account_email} · ${m.folder_path}\nOd: ${m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email}\nTemat: ${m.subject}\n\n${trunc(m.body, 1500)}\n`).join('\n' + '─'.repeat(60) + '\n')
            : 'Nic nie znaleziono.',
        )
      } else {
        const r = svc.search(q, { limit: pageSize, offset: (page - 1) * pageSize, order: a.b.has('ascending') ? 'asc' : 'desc' })
        print(a, r, () => `${table(threadRows(r.threads), THREAD_COLS)}\nZnaleziono wątków: ${r.total} (strona ${page})`)
      }
      return
    }
    case 'thread': {
      if (!a._[0]) throw new CliError('Podaj ID wiadomości albo t<ID wątku>')
      const [tid] = resolveThreads([a._[0]])
      let t = svc.getThread(tid)
      if (!t) throw new CliError('Wątek nie istnieje')
      try {
        t = (await svc.fetchThreadBodies(tid)) || t
      } catch (e) {
        process.stderr.write(`Uwaga: nie pobrano wszystkich treści (${(e as Error).message})\n`)
      }
      print(a, t, () => {
        const th = t!.thread
        const head = `Wątek t${th.thread_id}: ${th.subject}\nKonto: ${th.account_email} · wiadomości: ${th.message_count} · kategoria: ${th.category}${th.pinned ? ' · przypięty' : ''}${th.snoozed_until ? ` · odłożony do ${fmtTime(th.snoozed_until)}` : ''}${th.reminder_at ? ` · przypomnienie ${fmtTime(th.reminder_at)}` : ''}${th.labels.length ? ` · etykiety: ${th.labels.join(', ')}` : ''}`
        const msgs = t!.messages.map((m) => {
          const atts = m.attachments.filter((x) => !x.inline)
          const attText = atts.length ? `\nZałączniki:\n${table(atts.map((x) => ({ id: x.id, name: x.filename, size: `${Math.round(x.size / 1024)} KB`, mime: x.mime, path: x.path || '(nie pobrany — octo attachment ' + x.id + ')' })), [{ key: 'id', label: 'ID' }, { key: 'name', label: 'NAZWA', width: 40 }, { key: 'size', label: 'ROZMIAR' }, { key: 'mime', label: 'TYP' }, { key: 'path', label: 'ŚCIEŻKA', width: 60 }])}` : ''
          const body = a.b.has('html') ? m.html || m.text : m.text || m.snippet
          return `── ID: ${m.id} · ${fmtTime(m.date)} · ${m.folder_role || ''}${m.seen ? '' : ' · NIEPRZECZYTANA'}\nOd: ${addr(m.from)}\nDo: ${addrs(m.to)}${m.cc.length ? `\nDW: ${addrs(m.cc)}` : ''}${m.bcc.length ? `\nUDW: ${addrs(m.bcc)}` : ''}\nTemat: ${m.subject}${m.calendar_part ? '\n📅 Zawiera zaproszenie (octo invite ' + m.id + ')' : ''}\n\n${body || '(brak treści)'}${attText}`
        })
        const ds = t!.drafts.map((d) => `── WERSJA ROBOCZA ID: ${d.id} · ${d.status}${d.send_at ? ` · wysyłka ${fmtTime(d.send_at)}` : ''}\nDo: ${addrs(d.to)}\nTemat: ${d.subject}\n\n${trunc(d.text || d.html.replace(/<[^>]+>/g, ' '), 600)}`)
        return [head, ...msgs, ...ds].join('\n\n')
      })
      return
    }
    case 'attachment': {
      const id = Number(a._[0])
      if (!id) throw new CliError('Podaj ID załącznika (kolumna ID w octo thread)')
      const file = await svc.downloadAttachment(id)
      const att = get('SELECT * FROM attachments WHERE id = ?', id)!
      if (a.b.has('stream')) {
        process.stdout.write(fs.readFileSync(file))
        return
      }
      const save = one(a, 'save')
      if (save) fs.copyFileSync(file, save)
      print(a, { ...att, path: save || file }, () => `ID: ${att.id}\nNazwa: ${att.filename}\nRozmiar: ${att.size}\nTyp: ${att.mime}\nŚcieżka: ${save ? path.resolve(save) : file}\nWiadomość: ${att.message_id}`)
      return
    }
    case 'contacts': {
      const list = svc.listContacts(a._.join(' '), Number(one(a, 'limit') || 30))
      print(a, list, () => table(list.map((c) => ({ email: c.email, name: c.name || '', status: c.status, cat: c.category || '', vip: c.vip ? '★' : '', sent: c.sent_count, recv: c.recv_count, last: fmtTime(c.last_received || c.last_sent) })), [
        { key: 'email', label: 'E-MAIL' }, { key: 'name', label: 'NAZWA' }, { key: 'status', label: 'STATUS' }, { key: 'cat', label: 'KATEGORIA' },
        { key: 'vip', label: 'VIP' }, { key: 'sent', label: 'WYSŁ.' }, { key: 'recv', label: 'ODEBR.' }, { key: 'last', label: 'OSTATNIO' },
      ]))
      return
    }
    case 'templates': {
      const list = svc.listTemplates()
      print(a, list, () => table(list.map((t) => ({ id: t.id, name: t.name, subject: trunc(t.subject, 40), placeholders: t.placeholders.join(', '), modified: fmtTime(t.updated_at) })), [
        { key: 'id', label: 'ID' }, { key: 'name', label: 'NAZWA' }, { key: 'subject', label: 'TEMAT' }, { key: 'placeholders', label: 'POLA' }, { key: 'modified', label: 'ZMIENIONY' },
      ]))
      return
    }
    case 'template': {
      const t = svc.getTemplate(a._.join(' '))
      print(a, t, () => `ID: ${t.id}\nNazwa: ${t.name}\nTemat: ${t.subject || ''}\nDo: ${addrs(t.to)}\n\n${(t.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')}\n\nPola:\n${t.placeholders.map((p) => `  [${svc.placeholderKind(p)}] ${p}`).join('\n') || '  (brak)'}`)
      return
    }
    case 'drafts': {
      const list = svc.listDrafts(['draft', 'failed'])
      print(a, list, () => table(list.map((d) => ({ id: d.id, status: d.status, to: addrs(d.to), subject: d.subject, updated: fmtTime(d.updated_at), error: d.error || '' })), [
        { key: 'id', label: 'ID' }, { key: 'status', label: 'STATUS' }, { key: 'to', label: 'DO', width: 40 }, { key: 'subject', label: 'TEMAT', width: 50 },
        { key: 'updated', label: 'ZMIENIONA' }, { key: 'error', label: 'BŁĄD', width: 40 },
      ]))
      return
    }
    case 'scheduled': {
      const list = svc.scheduled()
      print(a, list, () => table(list.map((d) => ({ id: d.id, status: d.status, at: fmtTime(d.send_at), to: addrs(d.to), subject: d.subject, error: d.error || '' })), [
        { key: 'id', label: 'ID' }, { key: 'status', label: 'STATUS' }, { key: 'at', label: 'WYSYŁKA' }, { key: 'to', label: 'DO', width: 40 },
        { key: 'subject', label: 'TEMAT', width: 50 }, { key: 'error', label: 'BŁĄD', width: 40 },
      ]) + (list.length ? '\nAnulowanie: octo unschedule <ID>' : ''))
      return
    }
    case 'draft': {
      const del = one(a, 'delete')
      if (del) {
        svc.deleteDraft(Number(del))
        console.log(`Usunięto wersję roboczą ${del}.`)
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
        if (!fs.existsSync(abs)) throw new CliError(`Nie ma pliku ${abs}`)
        const st = fs.statSync(abs)
        if (st.size > 25 * 1024 * 1024) throw new CliError(`Plik ${abs} ma ponad 25 MB`)
        return { filename: path.basename(abs), path: abs, size: st.size }
      })
      if (a.b.has('attach-stream') || one(a, 'attach-stream')) {
        const name = one(a, 'attach-stream') || 'plik'
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
      print(a, d, () => `ID: ${d.id}\nStatus: wersja robocza (ID się nie zmieni)\nOd: ${d.from_email}\nDo: ${addrs(d.to)}${d.cc.length ? `\nDW: ${addrs(d.cc)}` : ''}\nTemat: ${d.subject}\nZałączniki: ${d.attachments.map((x) => x.filename).join(', ') || '-'}\nWysyłka: octo send ${d.id}  ·  Otwórz: octopus-mail://draft/${d.id}`)
      return
    }
    case 'send': {
      const id = Number(a._[0])
      if (!id) throw new CliError('Podaj ID wersji roboczej')
      const sendAt = when(one(a, 'at'), '--at')
      const remindAt = when(one(a, 'remind'), '--remind')
      const d = svc.sendDraft(id, { sendAt, remindAt })
      if (sendAt) {
        const warn = engineRunning() ? '' : '\nUwaga: aplikacja nie działa — wiadomość wyjdzie dopiero, gdy uruchomisz Octopus Mail albo `octo daemon`.'
        print(a, d, () => `Zaplanowano: ${d.subject}\nWysyłka: ${fmtTime(d.send_at)}\nAnulowanie: octo unschedule ${d.id}${warn}`)
        return
      }
      process.stderr.write(`Queued: ${d.subject} → ${addrs(d.to)}\n`)
      await drainOps(120_000)
      const after = svc.getDraft(id)
      if (after.status === 'sent') print(a, after, () => `Wysłano: ${after.subject} (${fmtTime(after.sent_at)})`)
      else throw new CliError(`Nie wysłano (status: ${after.status})${after.error ? `: ${after.error}` : ''}`)
      return
    }
    case 'unschedule': {
      const d = svc.cancelSend(Number(a._[0]))
      print(a, d, () => `Anulowano wysyłkę. „${d.subject}” jest znowu wersją roboczą (ID ${d.id}).`)
      return
    }
    case 'action': {
      const act = a._.shift()
      if (!act) throw new CliError('Podaj akcję (octo help)')
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
          if (ref.kind !== 'folder') throw new CliError('--folder musi wskazywać folder konta, np. konto@x.pl:Projekty')
          r = svc.moveToFolder(ids, ref.folderId)
          break
        }
        case 'label': case 'unlabel': {
          const label = one(a, 'label')
          if (!label) throw new CliError('Podaj --label')
          r = svc.setLabel(ids, label, act === 'label')
          break
        }
        default: throw new CliError(`Nieznana akcja „${act}”`)
      }
      await drainOps(60_000)
      const failed = all("SELECT error FROM ops WHERE status = 'error' AND finished_at > ?", Date.now() - 90_000)
      if (failed.length) throw new CliError(`Akcja częściowo nieudana: ${failed.map((f) => f.error).join('; ')}`)
      print(a, r, () => `OK: ${r?.message || act} (wątki: ${ids.map((i) => `t${i}`).join(', ')})`)
      return
    }
    case 'sender': {
      const act = a._.shift()
      if (act === 'category') {
        const cat = a._.pop() as Category
        if (!['people', 'notification', 'newsletter'].includes(cat)) throw new CliError('Kategoria: people|notification|newsletter')
        const r = svc.changeSenderCategory(a._, cat)
        print(a, r, () => `OK: ${r.message}`)
      } else {
        if (!a._.length) throw new CliError('Podaj adres(y) lub @domenę')
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
      print(a, ev, () => table(ev.map((e) => ({ id: e.id, start: e.all_day ? fmtTime(e.start).slice(0, 10) + ' (cały dzień)' : fmtTime(e.start), end: e.all_day ? '' : fmtTime(e.end).slice(11, 16), title: e.summary, cal: e.calendar_name, me: e.my_status || '', link: e.conference_url || '' })), [
        { key: 'id', label: 'ID' }, { key: 'start', label: 'POCZĄTEK' }, { key: 'end', label: 'KONIEC' }, { key: 'title', label: 'WYDARZENIE', width: 50 },
        { key: 'cal', label: 'KALENDARZ' }, { key: 'me', label: 'MOJA ODP.' }, { key: 'link', label: 'SPOTKANIE', width: 40 },
      ]))
      return
    }
    case 'availability': {
      const from = when(one(a, 'from'), '--from') ?? Date.now()
      const days = Number(one(a, 'days') || 5)
      const slots = svc.availability({ from, to: from + days * 86400_000, durationMin: Number(one(a, 'duration') || 30), includeWeekends: a.b.has('all') })
      print(a, slots, () => slots.length ? slots.map((s) => `${fmtTime(s.start)} – ${fmtTime(s.end).slice(11, 16)}`).join('\n') : 'Brak wolnych terminów w tym zakresie.')
      return
    }
    case 'event': {
      const sub = a._.shift()
      if (sub === 'create') {
        const start = when(one(a, 'start'), '--start')
        if (!start || !one(a, 'title')) throw new CliError('Podaj --title i --start')
        const end = when(one(a, 'end'), '--end') ?? start + Number(one(a, 'duration') || 60) * 60_000
        const e = await svc.createEvent({ summary: one(a, 'title')!, start, end, location: one(a, 'location'), description: one(a, 'description'), attendees: many(a, 'attendee'), calendar_id: one(a, 'calendar') ? Number(one(a, 'calendar')) : undefined, all_day: a.b.has('all') })
        await drainOps(30_000)
        print(a, e, () => `Utworzono wydarzenie ${e.id}: ${e.summary} · ${fmtTime(e.start)}`)
      } else if (sub === 'delete') {
        await svc.deleteEvent(Number(a._[0]))
        console.log('Usunięto wydarzenie.')
      } else throw new CliError('octo event create|delete …')
      return
    }
    case 'invite': {
      const info = await svc.parseInvite(Number(a._[0]))
      print(a, info, () => (info ? JSON.stringify(info, null, 2) : 'Ta wiadomość nie zawiera zaproszenia.'))
      return
    }
    case 'rsvp': {
      const map: Record<string, 'ACCEPTED' | 'TENTATIVE' | 'DECLINED'> = { accept: 'ACCEPTED', yes: 'ACCEPTED', tak: 'ACCEPTED', maybe: 'TENTATIVE', może: 'TENTATIVE', decline: 'DECLINED', no: 'DECLINED', nie: 'DECLINED' }
      const resp = map[(a._[1] || '').toLowerCase()]
      if (!resp) throw new CliError('octo rsvp <ID wiadomości> accept|maybe|decline')
      await svc.rsvpInvite(Number(a._[0]), resp, one(a, 'comment'))
      console.log('Wysłano odpowiedź na zaproszenie.')
      return
    }
    case 'ai': {
      const sub = a._.shift()
      const stream = (t: string) => process.stdout.write(t)
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
        else console.log(`\n\nŹródła: ${r.sources.join(', ') || '-'}`)
      } else throw new CliError('octo ai summarize|reply|ask …')
      return
    }
    case 'history': {
      const h = svc.history(Number(one(a, 'limit') || 30), one(a, 'actor'))
      print(a, h, () => table(h.map((x) => ({ at: fmtTime(x.at), actor: x.actor, action: x.action, target: x.target || '', ok: x.ok ? 'ok' : 'BŁĄD', details: trunc(x.details, 60) })), [
        { key: 'at', label: 'KIEDY' }, { key: 'actor', label: 'KTO' }, { key: 'action', label: 'AKCJA' }, { key: 'target', label: 'CEL', width: 30 },
        { key: 'ok', label: 'WYNIK' }, { key: 'details', label: 'SZCZEGÓŁY', width: 60 },
      ]))
      return
    }
    default:
      throw new CliError(`Nieznane polecenie „${cmd}”. Zobacz: octo help`)
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
    process.stderr.write(`Błąd: ${e.message}\n`)
    if (process.env.OCTO_DEBUG) process.stderr.write(`${e.stack}\n`)
    await sync.stopAll().catch(() => undefined)
    process.exit(e instanceof CliError ? 2 : 1)
  })
