import { Command, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MailboxRef } from '../../../shared/types'
import { api } from '../lib/api'
import { type ThreadAction, useStore } from '../lib/store'
import { askText, cx } from './ui'

interface Cmd {
  id: string
  label: string
  hint?: string
  keywords: string
  group: string
  run: () => void
}

function norm(s: string) {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ł/g, 'l')
}

function score(q: string, c: Cmd): number {
  const hay = norm(`${c.label} ${c.keywords}`)
  const words = norm(q).split(/\s+/).filter(Boolean)
  let s = 0
  for (const w of words) {
    const i = hay.indexOf(w)
    if (i < 0) return -1
    s += i === 0 ? 3 : hay[i - 1] === ' ' ? 2 : 1
  }
  return s
}

export default function CommandPalette() {
  const st = useStore()
  const { palette, folders, accounts, smartFolders, selected, threads, settings } = st
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const close = () => useStore.setState({ palette: false })
  useEffect(() => {
    setQ('')
    setHi(0)
  }, [palette])

  const cmds = useMemo<Cmd[]>(() => {
    const go = (label: string, ref: MailboxRef, keywords = '') => ({ id: `go-${label}`, label: `Idź do: ${label}`, keywords: `idz przejdz go ${keywords}`, group: 'Nawigacja', run: () => st.setMailbox(ref) })
    const act = (id: ThreadAction, label: string, keywords: string, hint?: string): Cmd => ({ id, label, hint, keywords, group: 'Wiadomość', run: () => void st.act(id) })
    const t = threads.find((x) => x.thread_id === selected)
    const list: Cmd[] = [
      { id: 'compose', label: 'Nowa wiadomość', hint: 'C', keywords: 'napisz utworz compose new email mail', group: 'Ogólne', run: () => st.compose({ mode: 'new' }) },
      { id: 'search', label: 'Szukaj w poczcie', hint: '/', keywords: 'znajdz search find', group: 'Ogólne', run: () => document.getElementById('octo-search')?.focus() },
      { id: 'ask', label: 'Zapytaj AI o pocztę', keywords: 'asystent ai ask pytanie', group: 'Ogólne', run: () => st.setView('ask') },
      { id: 'sync', label: 'Synchronizuj teraz', keywords: 'pobierz odswiez fetch refresh', group: 'Ogólne', run: () => void api.syncNow() },
      { id: 'cal', label: 'Otwórz kalendarz', keywords: 'calendar wydarzenia spotkania', group: 'Ogólne', run: () => st.setView('calendar') },
      { id: 'contacts', label: 'Otwórz kontakty', keywords: 'contacts ludzie adresy', group: 'Ogólne', run: () => st.setView('contacts') },
      { id: 'settings', label: 'Ustawienia', keywords: 'preferences opcje settings', group: 'Ogólne', run: () => st.setView('settings') },
      { id: 'theme', label: settings?.theme === 'dark' ? 'Motyw jasny' : 'Motyw ciemny', keywords: 'dark light theme tryb', group: 'Ogólne', run: () => void st.updateSettings({ theme: settings?.theme === 'dark' ? 'light' : 'dark' }) },
      { id: 'gk', label: settings?.gatekeeper === 'on' ? 'Wyłącz GateKeepera' : 'Włącz GateKeepera (nowi nadawcy czekają na akceptację)', keywords: 'gatekeeper nowi nadawcy screening', group: 'Ogólne', run: () => void st.updateSettings({ gatekeeper: settings?.gatekeeper === 'on' ? 'off' : 'on' }) },
      {
        id: 'savesearch', label: 'Zapisz wyszukiwanie jako inteligentny folder', keywords: 'smart folder zapisz', group: 'Ogólne',
        run: async () => {
          const query = st.searchQuery || (await askText('Zapytanie (np. from:szef@firma.pl has:attachment)'))
          if (!query) return
          const name = await askText('Nazwa inteligentnego folderu', query)
          if (name) await api.saveSmartFolder({ name, query })
          void st.refreshMeta()
        },
      },
      go('Smart Inbox', { kind: 'smart' }, 'inbox odebrane skrzynka'),
      go('Przypięte', { kind: 'pinned' }, 'pinned star'),
      go('Odłożone', { kind: 'snoozed' }, 'snoozed'),
      go('Na boku', { kind: 'setaside' }, 'set aside'),
      go('Przypomnienia', { kind: 'reminders' }, 'reminders'),
      go('Zaplanowane', { kind: 'scheduled' }, 'scheduled send later outbox'),
      go('Wersje robocze', { kind: 'local-drafts' }, 'drafts szkice'),
      go('Nowi nadawcy', { kind: 'newsenders' }, 'gatekeeper new senders'),
      go('Wysłane', { kind: 'unified', role: 'sent' }, 'sent'),
      go('Archiwum', { kind: 'unified', role: 'archive' }, 'archive done zrobione'),
      go('Kosz', { kind: 'unified', role: 'trash' }, 'trash bin'),
      go('Spam', { kind: 'unified', role: 'junk' }, 'junk'),
      go('Newslettery', { kind: 'category', category: 'newsletter' }, 'newsletter'),
      go('Powiadomienia', { kind: 'category', category: 'notification' }, 'notifications'),
      go('Ludzie', { kind: 'category', category: 'people' }, 'people'),
      ...smartFolders.map((sf) => go(sf.name, { kind: 'smartfolder', id: sf.id }, 'smart folder')),
      ...folders.filter((f) => !f.role).map((f) => ({
        id: `f-${f.id}`, label: `Folder: ${f.path}`, hint: accounts.find((a) => a.id === f.account_id)?.email, keywords: `folder ${f.name}`, group: 'Foldery',
        run: () => st.setMailbox({ kind: 'folder', folderId: f.id }),
      })),
    ]
    if (st.targets().length) {
      list.push(
        act('archive', 'Zrobione (archiwizuj)', 'done archive archiwizuj zrobione', 'E'),
        { id: 'snooze', label: 'Odłóż…', hint: 'H', keywords: 'snooze pozniej odloz read later', group: 'Wiadomość', run: () => useStore.setState({ snoozeFor: st.targets(), pickerMode: 'snooze' }) },
        { id: 'remind', label: 'Przypomnij mi…', keywords: 'remind follow up przypomnienie', group: 'Wiadomość', run: () => useStore.setState({ snoozeFor: st.targets(), pickerMode: 'remind' }) },
        { id: 'move', label: 'Przenieś do folderu…', hint: 'V', keywords: 'move folder przenies', group: 'Wiadomość', run: () => useStore.setState({ moveFor: st.targets() }) },
        act('pin', 'Przypnij', 'pin star flag gwiazdka oznacz', 'S'),
        act('unpin', 'Odepnij', 'unpin'),
        act('trash', 'Do kosza', 'delete usun trash bin', '#'),
        act('spam', 'To spam', 'spam junk'),
        act('read', 'Oznacz jako przeczytane', 'read seen'),
        act('unread', 'Oznacz jako nieprzeczytane', 'unread', 'U'),
        act('mute', 'Wycisz wątek', 'mute cisza', 'M'),
        act('aside', 'Odłóż na bok', 'set aside'),
        act('priority', 'Oznacz jako priorytet', 'priority wazne'),
        act('unsubscribe', 'Wypisz się z newslettera', 'unsubscribe wypisz'),
        act('moveToInbox', 'Przenieś do Odebranych', 'inbox restore przywroc'),
      )
      if (t) {
        const last = t.latest_message_id
        list.push(
          { id: 'reply', label: 'Odpowiedz', hint: 'R', keywords: 'reply odpowiedz', group: 'Wiadomość', run: () => st.compose({ mode: 'reply', messageId: last, threadId: t.thread_id }) },
          { id: 'replyall', label: 'Odpowiedz wszystkim', hint: 'A', keywords: 'reply all', group: 'Wiadomość', run: () => st.compose({ mode: 'replyall', messageId: last, threadId: t.thread_id }) },
          { id: 'forward', label: 'Przekaż dalej', hint: 'F', keywords: 'forward przekaz', group: 'Wiadomość', run: () => st.compose({ mode: 'forward', messageId: last, threadId: t.thread_id }) },
          { id: 'accept', label: `Akceptuj nadawcę ${t.from.email}`, keywords: 'accept sender akceptuj', group: 'Nadawca', run: () => void st.senders('accept', [t.from.email]) },
          { id: 'block', label: `Blokuj nadawcę ${t.from.email}`, keywords: 'block sender blokuj', group: 'Nadawca', run: () => void st.senders('block', [t.from.email]) },
          { id: 'blockdomain', label: `Blokuj domenę @${t.from.email.split('@')[1]}`, keywords: 'block domain blokuj domene', group: 'Nadawca', run: () => void st.senders('block', ['@' + t.from.email.split('@')[1]]) },
          { id: 'vip', label: `Nadawca priorytetowy: ${t.from.email}`, keywords: 'vip priority sender', group: 'Nadawca', run: () => void st.senders('vip', [t.from.email]) },
          { id: 'cat-p', label: 'Zmień kategorię nadawcy → Ludzie', keywords: 'change category people', group: 'Nadawca', run: () => void st.categorize([t.from.email], 'people') },
          { id: 'cat-n', label: 'Zmień kategorię nadawcy → Powiadomienia', keywords: 'change category notifications', group: 'Nadawca', run: () => void st.categorize([t.from.email], 'notification') },
          { id: 'cat-l', label: 'Zmień kategorię nadawcy → Newslettery', keywords: 'change category newsletter', group: 'Nadawca', run: () => void st.categorize([t.from.email], 'newsletter') },
          { id: 'searchsender', label: `Wszystkie wiadomości od ${t.from.email}`, keywords: 'search sender szukaj od', group: 'Nadawca', run: () => st.setMailbox({ kind: 'search', query: `from:${t.from.email}` }) },
        )
      }
    }
    return list
  }, [palette, selected, threads, folders, smartFolders, settings])

  const results = useMemo(() => {
    if (!q.trim()) return cmds.slice(0, 40)
    const scored = cmds.map((c) => ({ c, s: score(q, c) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.c)
    scored.push({ id: 'search-q', label: `Szukaj: ${q}`, keywords: '', group: 'Szukaj', run: () => st.setMailbox({ kind: 'search', query: q }) })
    return scored.slice(0, 40)
  }, [q, cmds])

  if (!palette) return null
  const run = (c: Cmd) => {
    close()
    c.run()
  }
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/25 pt-[12vh]" onMouseDown={close}>
      <div className="anim-in w-[600px] max-w-[calc(100vw-20px)] overflow-hidden rounded-2xl border border-line bg-surface" style={{ boxShadow: 'var(--shadow)' }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Command size={16} className="text-muted" />
          <input
            autoFocus
            value={q}
            onChange={(e) => (setQ(e.target.value), setHi(0))}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close()
              if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => Math.min(h + 1, results.length - 1)))
              if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)))
              if (e.key === 'Enter' && results[hi]) run(results[hi])
            }}
            placeholder="Wpisz polecenie, folder albo szukaj…"
            className="h-12 flex-1 bg-transparent text-[14.5px] outline-none"
          />
        </div>
        <div className="max-h-[52vh] overflow-y-auto py-1.5">
          {results.map((c, i) => (
            <button key={c.id} onMouseEnter={() => setHi(i)} onClick={() => run(c)} className={cx('flex w-full items-center gap-3 px-4 py-2 text-left', i === hi ? 'bg-accent-soft' : '')}>
              {c.id === 'search-q' ? <Search size={14} className="text-muted" /> : <span className="w-[86px] shrink-0 truncate text-[11px] uppercase tracking-wide text-faint">{c.group}</span>}
              <span className={cx('flex-1 truncate text-[13.5px]', i === hi && 'text-accent')}>{c.label}</span>
              {c.hint && <span className="kbd">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}
