import { Command, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { MailboxRef } from '../../../shared/types'
import { api } from '../lib/api'
import { type ThreadAction, useStore } from '../lib/store'
import { askText, cx } from './ui'
import { t } from '../../../shared/i18n'

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
    const go = (label: string, ref: MailboxRef, keywords = '') => ({ id: `go-${label}`, label: t('Go to: {name}', { name: label }), keywords: `idz przejdz go ${keywords}`, group: t('Navigation'), run: () => st.setMailbox(ref) })
    const act = (id: ThreadAction, label: string, keywords: string, hint?: string): Cmd => ({ id, label, hint, keywords, group: t('Message'), run: () => void st.act(id) })
    const th = threads.find((x) => x.thread_id === selected)
    const list: Cmd[] = [
      { id: 'compose', label: t('New message'), hint: 'C', keywords: 'napisz utworz compose new email mail', group: t('General'), run: () => st.compose({ mode: 'new' }) },
      { id: 'search', label: t('Search mail'), hint: '/', keywords: 'znajdz search find', group: t('General'), run: () => document.getElementById('octo-search')?.focus() },
      { id: 'ask', label: t('Ask AI about your mail'), keywords: 'asystent ai ask pytanie', group: t('General'), run: () => st.setView('ask') },
      { id: 'sync', label: t('Sync now'), keywords: 'pobierz odswiez fetch refresh', group: t('General'), run: () => void api.syncNow() },
      { id: 'cal', label: t('Open calendar'), keywords: 'calendar wydarzenia spotkania', group: t('General'), run: () => st.setView('calendar') },
      { id: 'contacts', label: t('Open contacts'), keywords: 'contacts ludzie adresy', group: t('General'), run: () => st.setView('contacts') },
      { id: 'settings', label: t('Settings'), keywords: 'preferences opcje settings', group: t('General'), run: () => st.setView('settings') },
      { id: 'theme', label: settings?.theme === 'dark' ? t('Light theme') : t('Dark theme'), keywords: 'dark light theme tryb', group: t('General'), run: () => void st.updateSettings({ theme: settings?.theme === 'dark' ? 'light' : 'dark' }) },
      { id: 'gk', label: settings?.gatekeeper === 'on' ? t('Turn off Gatekeeper') : t('Turn on Gatekeeper (new senders wait for approval)'), keywords: 'gatekeeper nowi nadawcy screening', group: t('General'), run: () => void st.updateSettings({ gatekeeper: settings?.gatekeeper === 'on' ? 'off' : 'on' }) },
      {
        id: 'savesearch', label: t('Save search as a smart folder'), keywords: 'smart folder zapisz', group: t('General'),
        run: async () => {
          const query = st.searchQuery || (await askText(t('Query (e.g. from:boss@company.com has:attachment)')))
          if (!query) return
          const name = await askText(t('Smart folder name'), query)
          if (name) await api.saveSmartFolder({ name, query })
          void st.refreshMeta()
        },
      },
      go('Smart Inbox', { kind: 'smart' }, 'inbox odebrane skrzynka'),
      go(t('Pinned'), { kind: 'pinned' }, 'pinned star'),
      go(t('Snoozed'), { kind: 'snoozed' }, 'snoozed'),
      go(t('Set Aside'), { kind: 'setaside' }, 'set aside'),
      go(t('Reminders'), { kind: 'reminders' }, 'reminders'),
      go(t('Scheduled'), { kind: 'scheduled' }, 'scheduled send later outbox'),
      go(t('Drafts'), { kind: 'local-drafts' }, 'drafts szkice'),
      go(t('New senders'), { kind: 'newsenders' }, 'gatekeeper new senders'),
      go(t('Sent'), { kind: 'unified', role: 'sent' }, 'sent'),
      go(t('Archive'), { kind: 'unified', role: 'archive' }, 'archive done zrobione'),
      go(t('Trash'), { kind: 'unified', role: 'trash' }, 'trash bin'),
      go(t('Spam'), { kind: 'unified', role: 'junk' }, 'junk'),
      go(t('Newsletters'), { kind: 'category', category: 'newsletter' }, 'newsletter'),
      go(t('Notifications'), { kind: 'category', category: 'notification' }, 'notifications'),
      go(t('People'), { kind: 'category', category: 'people' }, 'people'),
      ...smartFolders.map((sf) => go(sf.name, { kind: 'smartfolder', id: sf.id }, 'smart folder')),
      ...folders.filter((f) => !f.role).map((f) => ({
        id: `f-${f.id}`, label: t('Folder: {path}', { path: f.path }), hint: accounts.find((a) => a.id === f.account_id)?.email, keywords: `folder ${f.name}`, group: t('Folders'),
        run: () => st.setMailbox({ kind: 'folder', folderId: f.id }),
      })),
    ]
    if (st.targets().length) {
      list.push(
        act('archive', t('Done (archive)'), 'done archive archiwizuj zrobione', 'E'),
        { id: 'snooze', label: t('Snooze…'), hint: 'H', keywords: 'snooze pozniej odloz read later', group: t('Message'), run: () => useStore.setState({ snoozeFor: st.targets(), pickerMode: 'snooze' }) },
        { id: 'remind', label: t('Remind me…'), keywords: 'remind follow up przypomnienie', group: t('Message'), run: () => useStore.setState({ snoozeFor: st.targets(), pickerMode: 'remind' }) },
        { id: 'move', label: t('Move to folder…'), hint: 'V', keywords: 'move folder przenies', group: t('Message'), run: () => useStore.setState({ moveFor: st.targets() }) },
        act('pin', t('Pin'), 'pin star flag gwiazdka oznacz', 'S'),
        act('unpin', t('Unpin'), 'unpin'),
        act('trash', t('Move to Trash'), 'delete usun trash bin', '#'),
        act('spam', t('Mark as spam'), 'spam junk'),
        act('read', t('Mark as read'), 'read seen'),
        act('unread', t('Mark as unread'), 'unread', 'U'),
        act('mute', t('Mute conversation'), 'mute cisza', 'M'),
        act('aside', t('Set aside'), 'set aside'),
        act('priority', t('Mark as priority'), 'priority wazne'),
        act('unsubscribe', t('Unsubscribe from newsletter'), 'unsubscribe wypisz'),
        act('moveToInbox', t('Move to Inbox'), 'inbox restore przywroc'),
      )
      if (th) {
        const last = th.latest_message_id
        list.push(
          { id: 'reply', label: t('Reply'), hint: 'R', keywords: 'reply odpowiedz', group: t('Message'), run: () => st.compose({ mode: 'reply', messageId: last, threadId: th.thread_id }) },
          { id: 'replyall', label: t('Reply to all'), hint: 'A', keywords: 'reply all', group: t('Message'), run: () => st.compose({ mode: 'replyall', messageId: last, threadId: th.thread_id }) },
          { id: 'forward', label: t('Forward message'), hint: 'F', keywords: 'forward przekaz', group: t('Message'), run: () => st.compose({ mode: 'forward', messageId: last, threadId: th.thread_id }) },
          { id: 'accept', label: t('Accept sender {email}', { email: th.from.email }), keywords: 'accept sender akceptuj', group: t('Sender'), run: () => void st.senders('accept', [th.from.email]) },
          { id: 'block', label: t('Block sender {email}', { email: th.from.email }), keywords: 'block sender blokuj', group: t('Sender'), run: () => void st.senders('block', [th.from.email]) },
          { id: 'blockdomain', label: t('Block domain @{domain}', { domain: th.from.email.split('@')[1] }), keywords: 'block domain blokuj domene', group: t('Sender'), run: () => void st.senders('block', ['@' + th.from.email.split('@')[1]]) },
          { id: 'vip', label: t('Priority sender: {email}', { email: th.from.email }), keywords: 'vip priority sender', group: t('Sender'), run: () => void st.senders('vip', [th.from.email]) },
          { id: 'cat-p', label: t('Change sender category → People'), keywords: 'change category people', group: t('Sender'), run: () => void st.categorize([th.from.email], 'people') },
          { id: 'cat-n', label: t('Change sender category → Notifications'), keywords: 'change category notifications', group: t('Sender'), run: () => void st.categorize([th.from.email], 'notification') },
          { id: 'cat-l', label: t('Change sender category → Newsletters'), keywords: 'change category newsletter', group: t('Sender'), run: () => void st.categorize([th.from.email], 'newsletter') },
          { id: 'searchsender', label: t('All messages from {email}', { email: th.from.email }), keywords: 'search sender szukaj od', group: t('Sender'), run: () => st.setMailbox({ kind: 'search', query: `from:${th.from.email}` }) },
        )
      }
    }
    return list
  }, [palette, selected, threads, folders, smartFolders, settings])

  const results = useMemo(() => {
    if (!q.trim()) return cmds.slice(0, 40)
    const scored = cmds.map((c) => ({ c, s: score(q, c) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.c)
    scored.push({ id: 'search-q', label: t('Search: {query}', { query: q }), keywords: '', group: t('Search'), run: () => st.setMailbox({ kind: 'search', query: q }) })
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
            placeholder={t('Type a command or folder, or search…')}
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
