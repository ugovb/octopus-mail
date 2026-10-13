// MCP server (stdio) exposing Octopus Mail to AI agents such as Claude Code / Claude Desktop.
// Every tool goes through the same service layer as the CLI, so per-account access levels apply.
import fs from 'node:fs'
import path from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import type { MailboxRef, ThreadSummary } from '../shared/types'
import { parseWhen } from '../shared/when'
import { engineRunning } from '../core/boot'
import { get } from '../core/db'
import { drainOps } from '../core/ops'
import { createService } from '../core/service'
import { fmtTime, isoLocal } from './format'

const svc = createService('mcp')

type Content = { content: { type: 'text'; text: string }[]; isError?: boolean }

function ok(data: unknown, note?: string): Content {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 1)
  return { content: [{ type: 'text', text: note ? `${note}\n\n${text}` : text }] }
}

function fail(e: unknown): Content {
  return { content: [{ type: 'text', text: `Błąd: ${(e as Error).message}` }], isError: true }
}

function wrap<A>(fn: (args: A) => Promise<Content> | Content) {
  return async (args: A): Promise<Content> => {
    try {
      return await fn(args)
    } catch (e) {
      return fail(e)
    }
  }
}

function when(input: string | undefined | null): number | undefined {
  if (!input) return undefined
  const t = parseWhen(input) ?? (Number.isFinite(Date.parse(input)) ? Date.parse(input) : null)
  if (!t) throw new Error(`Nie rozumiem daty „${input}” (np. "2026-10-20T09:00+02:00", "jutro 9:00", "za 2 godziny")`)
  return t
}

function threadIds(ids: (string | number)[]): number[] {
  const out: number[] = []
  for (const raw of ids) {
    const s = String(raw)
    if (/^t\d+$/i.test(s)) out.push(Number(s.slice(1)))
    else {
      const m = get<{ thread_id: number }>('SELECT thread_id FROM messages WHERE id = ?', Number(s))
      if (!m) throw new Error(`Nie ma wiadomości ${s}`)
      out.push(m.thread_id)
    }
  }
  return [...new Set(out)]
}

function compact(t: ThreadSummary) {
  return {
    message_id: t.latest_message_id,
    thread_id: `t${t.thread_id}`,
    date: isoLocal(t.last_date),
    from: t.from,
    participants: t.participants.map((p) => p.name || p.email),
    subject: t.subject,
    snippet: t.snippet,
    messages: t.message_count,
    unread: t.unread,
    category: t.category,
    pinned: t.pinned || undefined,
    priority: t.priority || undefined,
    attachments: t.has_attachments || undefined,
    snoozed_until: isoLocal(t.snoozed_until) || undefined,
    reminder_at: isoLocal(t.reminder_at) || undefined,
    new_sender: t.is_new_sender || undefined,
    has_draft: t.has_draft || undefined,
    labels: t.labels.length ? t.labels : undefined,
    account: t.account_email,
  }
}

function mailbox(spec?: string): { ref: MailboxRef; accountId?: number } {
  if (!spec) return { ref: { kind: 'smart' } }
  const low = spec.toLowerCase()
  const fixed: Record<string, MailboxRef> = {
    inbox: { kind: 'smart' }, sent: { kind: 'unified', role: 'sent' }, drafts: { kind: 'unified', role: 'drafts' },
    archive: { kind: 'unified', role: 'archive' }, trash: { kind: 'unified', role: 'trash' }, spam: { kind: 'unified', role: 'junk' },
    pinned: { kind: 'pinned' }, snoozed: { kind: 'snoozed' }, set_aside: { kind: 'setaside' }, reminders: { kind: 'reminders' },
    new_senders: { kind: 'newsenders' }, blocked: { kind: 'blocked' }, people: { kind: 'category', category: 'people' },
    notifications: { kind: 'category', category: 'notification' }, newsletters: { kind: 'category', category: 'newsletter' },
  }
  if (fixed[low]) return { ref: fixed[low] }
  const colon = spec.indexOf(':')
  const accEmail = colon > 0 ? spec.slice(0, colon) : spec
  const acc = svc.listAccounts().find((a) => a.email.toLowerCase() === accEmail.toLowerCase())
  if (!acc) throw new Error(`Nieznana skrzynka „${spec}”`)
  if (colon < 0) return { ref: { kind: 'unified', role: 'inbox' }, accountId: acc.id }
  const name = spec.slice(colon + 1)
  const f = get<{ id: number }>('SELECT id FROM folders WHERE account_id = ? AND (path = ? COLLATE NOCASE OR name = ? COLLATE NOCASE)', acc.id, name, name)
  if (!f) throw new Error(`Konto ${acc.email} nie ma folderu „${name}”`)
  return { ref: { kind: 'folder', folderId: f.id } }
}

const INSTRUCTIONS = `Octopus Mail — lokalny klient poczty Piotra. Wszystkie czasy są w strefie Europe/Warsaw z jawnym przesunięciem (ISO 8601).
Identyfikatory: message_id (liczba) wskazuje wiadomość; thread_id ma postać "t123". Akcje przyjmują oba.
ID wersji roboczych są stałe — po utworzeniu draftu możesz go edytować, wysłać lub usunąć tym samym ID.
Zasady: (1) odpowiadając w istniejącej rozmowie zawsze używaj reply_to z ID ostatniej wiadomości wątku; (2) nie wysyłaj bez wyraźnej zgody użytkownika — twórz drafty;
(3) każde konto ma poziom dostępu agentów (read/triage/send) ustawiany przez Piotra w aplikacji; błąd dostępu oznacza, że trzeba poprosić Piotra o zmianę, nie obchodzić go.`

export async function runMcp(): Promise<void> {
  const server = new McpServer({ name: 'octopus-mail', version: '0.1.0' }, { instructions: INSTRUCTIONS })

  server.registerTool('accounts', {
    description: 'Lista kont pocztowych z poziomem dostępu agentów i stanem synchronizacji.',
    inputSchema: {},
  }, wrap(() => ok({
    sync_engine_running: !!engineRunning(),
    accounts: svc.listAccounts().map((a) => ({ id: a.id, email: a.email, name: a.name, agent_access: a.agent_access, last_sync: isoLocal(a.last_sync), error: a.last_error })),
  })))

  server.registerTool('folders', {
    description: 'Foldery/etykiety konta (identyfikator "konto@x.pl:Ścieżka") z licznikami.',
    inputSchema: { account: z.string().optional().describe('adres konta; puste = wszystkie') },
  }, wrap(({ account }: { account?: string }) => {
    const acc = account ? svc.listAccounts().find((a) => a.email === account) : undefined
    const accs = new Map(svc.listAccounts().map((a) => [a.id, a.email]))
    return ok(svc.listFolders(acc?.id).map((f) => ({ id: `${accs.get(f.account_id)}:${f.path}`, role: f.role, total: f.total, unread: f.unread })))
  }))

  server.registerTool('list_emails', {
    description: 'Lista rozmów w skrzynce (domyślnie Smart Inbox). mailbox: inbox|sent|drafts|archive|trash|spam|pinned|snoozed|set_aside|reminders|new_senders|blocked|people|notifications|newsletters|konto@x.pl|konto@x.pl:Folder.',
    inputSchema: {
      mailbox: z.string().optional(),
      unread_only: z.boolean().optional(),
      page: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(200).optional(),
    },
  }, wrap(({ mailbox: mb, unread_only, page = 1, page_size = 30 }: { mailbox?: string; unread_only?: boolean; page?: number; page_size?: number }) => {
    const { ref, accountId } = mailbox(mb)
    const list = svc.listThreads(ref, { accountId, limit: page_size, offset: (page - 1) * page_size, unreadOnly: unread_only })
    return ok({ page, count: list.length, threads: list.map(compact) })
  }))

  server.registerTool('search', {
    description: 'Wyszukiwanie we wszystkich folderach (bez kosza/spamu, chyba że in:trash). Składnia jak w Gmailu: from: to: cc: subject: has:attachment is:unread is:pinned category:newsletter in:konto@x.pl newer_than:7d before:2026/10/01 filename:pdf + słowa (bez polskich znaków też działa). with_bodies=true zwraca treści wiadomości.',
    inputSchema: {
      query: z.string(),
      with_bodies: z.boolean().optional(),
      page: z.number().int().min(1).optional(),
      page_size: z.number().int().min(1).max(100).optional(),
    },
  }, wrap(async ({ query, with_bodies, page = 1, page_size = 20 }: { query: string; with_bodies?: boolean; page?: number; page_size?: number }) => {
    if (!with_bodies) {
      const r = svc.search(query, { limit: page_size, offset: (page - 1) * page_size })
      return ok({ total_threads: r.total, page, threads: r.threads.map(compact) })
    }
    const msgs = svc.searchMessages(query, { limit: Math.min(page_size, 20), offset: (page - 1) * page_size })
    const out = []
    for (const m of msgs) {
      const full = await svc.fetchBody(m.id).catch(() => svc.getMessage(m.id))
      out.push({ message_id: m.id, thread_id: `t${m.thread_id}`, date: isoLocal(m.date), account: m.account_email, folder: m.folder_path, from: m.from_name ? `${m.from_name} <${m.from_email}>` : m.from_email, subject: m.subject, body: (full?.text || m.snippet || '').slice(0, 6000) })
    }
    return ok({ page, messages: out })
  }))

  server.registerTool('read_thread', {
    description: 'Cała rozmowa: nagłówki, pełne treści (bez cytatów HTML), załączniki z ID, wersje robocze.',
    inputSchema: { id: z.union([z.string(), z.number()]).describe('message_id albo "t<thread_id>"') },
  }, wrap(async ({ id }: { id: string | number }) => {
    const [tid] = threadIds([id])
    const t = (await svc.fetchThreadBodies(tid).catch(() => null)) || svc.getThread(tid)
    if (!t) throw new Error('Wątek nie istnieje')
    return ok({
      thread: compact(t.thread),
      messages: t.messages.map((m) => ({
        message_id: m.id, date: isoLocal(m.date), folder: m.folder_role, from: m.from, to: m.to, cc: m.cc, bcc: m.bcc.length ? m.bcc : undefined,
        subject: m.subject, unread: !m.seen, body: m.text || m.snippet, has_invite: !!m.calendar_part || undefined,
        attachments: m.attachments.filter((a) => !a.inline).map((a) => ({ id: a.id, name: a.filename, size: a.size, mime: a.mime })),
        unsubscribe_available: !!m.list_unsubscribe || undefined,
      })),
      drafts: t.drafts.map((d) => ({ draft_id: d.id, status: d.status, to: d.to, subject: d.subject, send_at: isoLocal(d.send_at), text: d.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2000) })),
    })
  }))

  server.registerTool('read_attachment', {
    description: 'Pobiera załącznik. Pliki tekstowe (txt, csv, md, json, html, ics) zwraca jako tekst; pozostałe — ścieżkę lokalną.',
    inputSchema: { id: z.number().int() },
  }, wrap(async ({ id }: { id: number }) => {
    const file = await svc.downloadAttachment(id)
    const att = get('SELECT filename, mime, size FROM attachments WHERE id = ?', id)!
    const textual = /^text\/|json|xml|csv|calendar/.test(att.mime) || /\.(txt|csv|md|json|html?|ics|log)$/i.test(att.filename)
    if (textual && att.size < 2_000_000) return ok({ ...att, path: file, text: fs.readFileSync(file, 'utf8').slice(0, 200_000) })
    return ok({ ...att, path: file, note: 'Plik binarny — przeczytaj go z dysku pod podaną ścieżką.' })
  }))

  const addrList = z.array(z.string()).optional().describe('adresy: "a@b.pl" lub "Imię <a@b.pl>"')
  server.registerTool('save_draft', {
    description: 'Tworzy albo edytuje wersję roboczą (stałe ID). Treść w markdown. Odpowiedź w wątku: reply_to = ID ostatniej wiadomości. Podpis dodawany automatycznie (no_signature=true wyłącza). Szablon: template + placeholders.',
    inputSchema: {
      draft_id: z.number().int().optional().describe('podaj, aby edytować istniejący draft'),
      account: z.string().optional().describe('adres nadawcy (konto lub alias)'),
      to: addrList, cc: addrList, bcc: addrList,
      subject: z.string().optional(),
      body_markdown: z.string().optional(),
      reply_to: z.number().int().optional(),
      reply_all: z.boolean().optional(),
      forward: z.number().int().optional(),
      attachments: z.array(z.string()).optional().describe('bezwzględne ścieżki plików (max 25 MB każdy)'),
      template: z.string().optional(),
      placeholders: z.record(z.string()).optional(),
      no_signature: z.boolean().optional(),
    },
  }, wrap((a: { draft_id?: number; account?: string; to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; body_markdown?: string; reply_to?: number; reply_all?: boolean; forward?: number; attachments?: string[]; template?: string; placeholders?: Record<string, string>; no_signature?: boolean }) => {
    const atts = (a.attachments || []).map((p) => {
      if (!fs.existsSync(p)) throw new Error(`Nie ma pliku ${p}`)
      return { filename: path.basename(p), path: p, size: fs.statSync(p).size }
    })
    const d = svc.saveDraft({
      id: a.draft_id, from_email: a.account, to: a.to, cc: a.cc, bcc: a.bcc, subject: a.subject, markdown: a.body_markdown,
      reply_to_message_id: a.reply_to, reply_all: a.reply_all, forward_of_message_id: a.forward,
      attachments: atts.length ? [...(a.draft_id ? svc.getDraft(a.draft_id).attachments : []), ...atts] : undefined,
      template_id: a.template ? svc.getTemplate(a.template).id : undefined, placeholders: a.placeholders,
      signature: a.no_signature ? false : undefined, source: 'mcp',
    })
    return ok({ draft_id: d.id, from: d.from_email, to: d.to, cc: d.cc, subject: d.subject, attachments: d.attachments.map((x) => x.filename), open_link: `octopus-mail://draft/${d.id}` }, 'Wersja robocza zapisana. Pokaż użytkownikowi link open_link.')
  }))

  server.registerTool('delete_draft', { description: 'Usuwa wersję roboczą na stałe.', inputSchema: { draft_id: z.number().int() } },
    wrap(async ({ draft_id }: { draft_id: number }) => {
      svc.deleteDraft(draft_id)
      await drainOps(20_000)
      return ok(`Usunięto draft ${draft_id}`)
    }))

  server.registerTool('send_draft', {
    description: 'Wysyła draft teraz albo o czasie send_at (Send Later). Wymaga poziomu "send" dla konta i wyraźnej zgody użytkownika. remind_at: przypomnij, jeśli nikt nie odpowie.',
    inputSchema: { draft_id: z.number().int(), send_at: z.string().optional(), remind_at: z.string().optional() },
  }, wrap(async ({ draft_id, send_at, remind_at }: { draft_id: number; send_at?: string; remind_at?: string }) => {
    const sendAt = when(send_at)
    const d = svc.sendDraft(draft_id, { sendAt, remindAt: when(remind_at) })
    if (sendAt) return ok({ draft_id, status: d.status, send_at: isoLocal(d.send_at) }, engineRunning() ? 'Zaplanowano.' : 'Zaplanowano, ale aplikacja nie działa — wiadomość wyjdzie po uruchomieniu Octopus Mail.')
    await drainOps(120_000)
    const after = svc.getDraft(draft_id)
    if (after.status !== 'sent') throw new Error(`Nie wysłano (${after.status}): ${after.error || ''}`)
    return ok({ draft_id, status: 'sent', sent_at: isoLocal(after.sent_at) })
  }))

  server.registerTool('unschedule', { description: 'Anuluje zaplanowaną wysyłkę — wiadomość wraca do wersji roboczych.', inputSchema: { draft_id: z.number().int() } },
    wrap(({ draft_id }: { draft_id: number }) => ok(svc.cancelSend(draft_id), 'Anulowano wysyłkę.')))

  server.registerTool('list_drafts', { description: 'Wersje robocze oraz zaplanowane/nieudane wysyłki.', inputSchema: {} },
    wrap(() => ok({
      drafts: svc.listDrafts(['draft', 'failed']).map((d) => ({ draft_id: d.id, status: d.status, to: d.to, subject: d.subject, updated: isoLocal(d.updated_at), error: d.error })),
      scheduled: svc.scheduled().map((d) => ({ draft_id: d.id, status: d.status, send_at: isoLocal(d.send_at), to: d.to, subject: d.subject, error: d.error })),
    })))

  server.registerTool('email_action', {
    description: 'Akcja na rozmowach (ID wiadomości lub "t<ID wątku>"): archive (Zrobione), move_to_inbox, trash, delete_forever, spam, not_spam, read, unread, pin, unpin, mute, unmute, set_aside, unset_aside, priority, unpriority, snooze (until), unsnooze, remind (at, if_no_reply), unremind, move (folder "konto:Folder"), label/unlabel (label), unsubscribe.',
    inputSchema: {
      action: z.enum(['archive', 'move_to_inbox', 'trash', 'delete_forever', 'spam', 'not_spam', 'read', 'unread', 'pin', 'unpin', 'mute', 'unmute', 'set_aside', 'unset_aside', 'priority', 'unpriority', 'snooze', 'unsnooze', 'remind', 'unremind', 'move', 'label', 'unlabel', 'unsubscribe']),
      ids: z.array(z.union([z.string(), z.number()])).min(1),
      until: z.string().optional(), at: z.string().optional(), if_no_reply: z.boolean().optional(),
      folder: z.string().optional(), label: z.string().optional(),
    },
  }, wrap(async (a: { action: string; ids: (string | number)[]; until?: string; at?: string; if_no_reply?: boolean; folder?: string; label?: string }) => {
    const ids = threadIds(a.ids)
    const map: Record<string, () => unknown> = {
      archive: () => svc.archive(ids), move_to_inbox: () => svc.moveToInbox(ids), trash: () => svc.trash(ids),
      delete_forever: () => svc.deleteForever(ids), spam: () => svc.spam(ids), not_spam: () => svc.notSpam(ids),
      read: () => svc.markRead(ids, true), unread: () => svc.markRead(ids, false), pin: () => svc.pin(ids, true), unpin: () => svc.pin(ids, false),
      mute: () => svc.mute(ids, true), unmute: () => svc.mute(ids, false), set_aside: () => svc.setAside(ids, true), unset_aside: () => svc.setAside(ids, false),
      priority: () => svc.priority(ids, true), unpriority: () => svc.priority(ids, false),
      snooze: () => svc.snooze(ids, when(a.until || a.at) ?? (() => { throw new Error('Podaj until') })()),
      unsnooze: () => svc.snooze(ids, null),
      remind: () => svc.remind(ids, when(a.at || a.until) ?? (() => { throw new Error('Podaj at') })(), a.if_no_reply ? 'no-reply' : 'manual'),
      unremind: () => svc.remind(ids, null),
      move: () => {
        const { ref } = mailbox(a.folder)
        if (ref.kind !== 'folder') throw new Error('folder musi mieć postać konto@x.pl:Folder')
        return svc.moveToFolder(ids, ref.folderId)
      },
      label: () => svc.setLabel(ids, a.label || '', true), unlabel: () => svc.setLabel(ids, a.label || '', false),
      unsubscribe: () => svc.unsubscribe(ids),
    }
    const r = map[a.action]() as { message?: string }
    await drainOps(60_000)
    return ok({ ok: true, threads: ids.map((i) => `t${i}`), result: r.message })
  }))

  server.registerTool('sender_action', {
    description: 'Decyzje o nadawcach (Smart Inbox/GateKeeper): accept, block, unblock, vip, unvip, category (people|notification|newsletter). Adresy lub "@domena".',
    inputSchema: { action: z.enum(['accept', 'block', 'unblock', 'vip', 'unvip', 'category']), emails: z.array(z.string()).min(1), category: z.enum(['people', 'notification', 'newsletter']).optional() },
  }, wrap(async (a: { action: string; emails: string[]; category?: 'people' | 'notification' | 'newsletter' }) => {
    let r: { message?: string }
    if (a.action === 'accept') r = svc.acceptSenders(a.emails)
    else if (a.action === 'block') r = svc.blockSenders(a.emails)
    else if (a.action === 'unblock') r = svc.unblockSenders(a.emails)
    else if (a.action === 'vip' || a.action === 'unvip') r = svc.prioritySender(a.emails, a.action === 'vip')
    else {
      if (!a.category) throw new Error('Podaj category')
      r = svc.changeSenderCategory(a.emails, a.category)
    }
    await drainOps(60_000)
    return ok({ ok: true, result: r.message })
  }))

  server.registerTool('templates', { description: 'Szablony wiadomości (z polami do wypełnienia).', inputSchema: { name: z.string().optional() } },
    wrap(({ name }: { name?: string }) => {
      if (name) {
        const t = svc.getTemplate(name)
        return ok({ ...t, placeholders: t.placeholders.map((p) => ({ name: p, kind: svc.placeholderKind(p) })) })
      }
      return ok(svc.listTemplates().map((t) => ({ id: t.id, name: t.name, subject: t.subject, placeholders: t.placeholders })))
    }))

  server.registerTool('contacts', { description: 'Szukanie kontaktów po nazwie/adresie (z liczbą wymienionych wiadomości).', inputSchema: { query: z.string() } },
    wrap(({ query }: { query: string }) => ok(svc.listContacts(query, 25))))

  server.registerTool('calendar_events', {
    description: 'Wydarzenia z kalendarzy w zakresie dat (domyślnie najbliższe 7 dni).',
    inputSchema: { from: z.string().optional(), to: z.string().optional() },
  }, wrap(({ from, to }: { from?: string; to?: string }) => {
    const f = when(from) ?? new Date(new Date().setHours(0, 0, 0, 0)).getTime()
    const t = when(to) ?? f + 7 * 86400_000
    return ok(svc.listEvents(f, t).map((e) => ({ ...e, start: isoLocal(e.start), end: isoLocal(e.end), ics: undefined })))
  }))

  server.registerTool('calendar_availability', {
    description: 'Wolne terminy (dni robocze 9–17) o zadanej długości.',
    inputSchema: { from: z.string().optional(), days: z.number().int().optional(), duration_min: z.number().int().optional(), include_weekends: z.boolean().optional() },
  }, wrap(({ from, days = 5, duration_min = 30, include_weekends }: { from?: string; days?: number; duration_min?: number; include_weekends?: boolean }) => {
    const f = when(from) ?? Date.now()
    return ok(svc.availability({ from: f, to: f + days * 86400_000, durationMin: duration_min, includeWeekends: include_weekends }).map((s) => ({ start: isoLocal(s.start), end: isoLocal(s.end) })))
  }))

  server.registerTool('calendar_create_event', {
    description: 'Tworzy wydarzenie (z zaproszeniami dla uczestników). Wymaga poziomu "send".',
    inputSchema: { title: z.string(), start: z.string(), end: z.string().optional(), all_day: z.boolean().optional(), location: z.string().optional(), description: z.string().optional(), attendees: z.array(z.string()).optional(), calendar_id: z.number().int().optional() },
  }, wrap(async (a: { title: string; start: string; end?: string; all_day?: boolean; location?: string; description?: string; attendees?: string[]; calendar_id?: number }) => {
    const start = when(a.start)!
    const e = await svc.createEvent({ summary: a.title, start, end: when(a.end) ?? start + 3600_000, all_day: a.all_day, location: a.location, description: a.description, attendees: a.attendees, calendar_id: a.calendar_id })
    return ok({ ...e, start: isoLocal(e.start), end: isoLocal(e.end) })
  }))

  server.registerTool('calendar_delete_event', { description: 'Usuwa wydarzenie (uczestnicy dostaną odwołanie).', inputSchema: { event_id: z.number().int() } },
    wrap(async ({ event_id }: { event_id: number }) => (await svc.deleteEvent(event_id), ok('Usunięto.'))))

  server.registerTool('invite', {
    description: 'Zaproszenie kalendarzowe zawarte w wiadomości; z response=accept|maybe|decline wysyła odpowiedź organizatorowi.',
    inputSchema: { message_id: z.number().int(), response: z.enum(['accept', 'maybe', 'decline']).optional(), comment: z.string().optional() },
  }, wrap(async ({ message_id, response, comment }: { message_id: number; response?: 'accept' | 'maybe' | 'decline'; comment?: string }) => {
    if (!response) return ok(await svc.parseInvite(message_id))
    await svc.rsvpInvite(message_id, ({ accept: 'ACCEPTED', maybe: 'TENTATIVE', decline: 'DECLINED' } as const)[response], comment)
    return ok('Odpowiedź wysłana.')
  }))

  server.registerTool('history', { description: 'Dziennik działań (kto: ui/cli/mcp/rule/scheduler) — do sprawdzania, co zostało zrobione.', inputSchema: { limit: z.number().int().optional() } },
    wrap(({ limit = 30 }: { limit?: number }) => ok(svc.history(limit).map((h) => ({ ...h, at: fmtTime(h.at) })))))

  await server.connect(new StdioServerTransport())
}
