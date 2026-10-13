import { useVirtualizer } from '@tanstack/react-virtual'
import {
  AlarmClock, Archive, Bell, BellOff, Check, ChevronDown, ChevronRight, Clock, Coffee, Flag, FolderInput, Inbox, MailOpen, Mail, Newspaper,
  Paperclip, Pin, PinOff, RefreshCw, ShieldCheck, ShieldX, Star, Trash2, TriangleAlert, Users, X,
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { Category, ThreadSummary } from '../../../shared/types'
import { dayHeader, displayName, listDate } from '../lib/format'
import { useStore } from '../lib/store'
import DraftList from './DraftList'
import { InboxZero, NoResults } from './illustrations'
import { Avatar, cx, Empty, IconButton, Menu, type MenuItem, Spinner } from './ui'
import { t, tp } from '../../../shared/i18n'

type Row =
  | { kind: 'header'; key: string; label: string; count?: number }
  | { kind: 'thread'; key: string; t: ThreadSummary; nested?: boolean }
  | { kind: 'group'; key: string; category: Category; threads: ThreadSummary[] }
  | { kind: 'banner'; key: string; count: number }

const CAT_META: Record<Category, { label: string; icon: React.ReactNode; color: string }> = {
  people: { label: t('People'), icon: <Users size={15} />, color: 'var(--people)' },
  notification: { label: t('Notifications'), icon: <Bell size={15} />, color: 'var(--notification)' },
  newsletter: { label: t('Newsletters'), icon: <Newspaper size={15} />, color: 'var(--newsletter)' },
}

function buildRows(threads: ThreadSummary[], smart: boolean, groupCats: Set<Category>, expanded: Set<Category>, newSenders: number): Row[] {
  const rows: Row[] = []
  if (newSenders > 0) rows.push({ kind: 'banner', key: 'banner', count: newSenders })
  let rest = threads
  if (smart) {
    const top = threads.filter((t) => t.pinned || t.priority)
    if (top.length) {
      rows.push({ kind: 'header', key: 'h-top', label: t('Priority & pinned'), count: top.length })
      for (const t of top) rows.push({ kind: 'thread', key: `t${t.thread_id}`, t })
    }
    rest = threads.filter((t) => !t.pinned && !t.priority)
  }
  const placed = new Set<Category>()
  let lastHeader = ''
  for (const t of rest) {
    const h = dayHeader(t.last_date)
    const cat = (t.category || 'people') as Category
    if (smart && groupCats.has(cat)) {
      if (placed.has(cat)) continue
      placed.add(cat)
      if (h !== lastHeader) {
        rows.push({ kind: 'header', key: `h-${h}`, label: h })
        lastHeader = h
      }
      const members = rest.filter((x) => (x.category || 'people') === cat)
      rows.push({ kind: 'group', key: `g-${cat}`, category: cat, threads: members })
      if (expanded.has(cat)) for (const m of members) rows.push({ kind: 'thread', key: `t${m.thread_id}`, t: m, nested: true })
      continue
    }
    if (h !== lastHeader) {
      rows.push({ kind: 'header', key: `h-${h}`, label: h })
      lastHeader = h
    }
    rows.push({ kind: 'thread', key: `t${t.thread_id}`, t })
  }
  return rows
}

function useMailboxTitle(): string {
  const { mailbox, folders, smartFolders, accounts, accountFilter } = useStore()
  const acc = accounts.find((a) => a.id === accountFilter)
  const suffix = acc ? ` · ${acc.email}` : ''
  switch (mailbox.kind) {
    case 'smart': return t('Smart Inbox') + suffix
    case 'category': return CAT_META[mailbox.category].label
    case 'unified': return ({ inbox: t('Inbox'), sent: t('Sent'), drafts: t('Drafts (server)'), archive: t('Archive'), trash: t('Trash'), junk: t('Spam'), all: t('All mail') } as Record<string, string>)[mailbox.role] || mailbox.role
    case 'folder': {
      const f = folders.find((x) => x.id === mailbox.folderId)
      const a = accounts.find((x) => x.id === f?.account_id)
      return f ? `${f.name} · ${a?.email || ''}` : t('Folder')
    }
    case 'pinned': return t('Pinned')
    case 'snoozed': return t('Snoozed')
    case 'setaside': return t('Set Aside')
    case 'reminders': return t('Reminders')
    case 'newsenders': return t('New senders')
    case 'blocked': return t('Blocked senders')
    case 'scheduled': return t('Scheduled to send')
    case 'local-drafts': return t('Drafts')
    case 'search': return t('Results: {query}', { query: mailbox.query })
    case 'smartfolder': return smartFolders.find((s) => s.id === mailbox.id)?.name || t('Smart folder')
  }
}

const ThreadRow = memo(function ThreadRow({
  t: th, selected, checked, nested, compact, onOpen, onCheck, onMenu,
}: {
  t: ThreadSummary; selected: boolean; checked: boolean; nested?: boolean; compact: boolean
  onOpen: (t: ThreadSummary, e: React.MouseEvent) => void; onCheck: (t: ThreadSummary, e: React.MouseEvent) => void; onMenu: (t: ThreadSummary, e: React.MouseEvent) => void
}) {
  const { act, accounts } = useStore()
  const showAccount = accounts.length > 1
  const names = th.participants.length > 1 && th.message_count > 1
    ? th.participants.slice(-3).map((p) => (p.name === 'Ja' || p.name === t('Me') ? t('Me') : displayName(p).split(' ')[0])).join(', ')
    : displayName(th.from)
  const setSnooze = () => useStore.setState({ snoozeFor: [th.thread_id], pickerMode: 'snooze' })
  return (
    <div
      onClick={(e) => onOpen(th, e)}
      onContextMenu={(e) => onMenu(th, e)}
      className={cx(
        'group relative flex cursor-default gap-3 border-b border-line/60 px-3.5 transition-colors',
        compact ? 'py-2' : 'py-2.5',
        nested && 'pl-7',
        selected ? 'bg-accent-soft' : checked ? 'bg-accent-soft/60' : 'hover:bg-hover',
      )}
    >
      {th.unread && <span className="absolute left-1.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-accent" />}
      <div className="relative mt-0.5" onClick={(e) => (e.stopPropagation(), onCheck(th, e))}>
        {checked ? (
          <div className="flex h-[34px] w-[34px] items-center justify-center rounded-full bg-accent text-accent-fg"><Check size={16} /></div>
        ) : (
          <>
            <Avatar addr={th.from} size={compact ? 28 : 34} className="group-hover:opacity-0" />
            <div className="absolute inset-0 hidden items-center justify-center rounded-full border-2 border-line bg-surface group-hover:flex" />
          </>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {showAccount && <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: th.account_color || 'var(--accent)' }} title={th.account_email} />}
          <span className={cx('truncate text-[13.5px]', th.unread ? 'font-semibold text-fg' : 'text-fg/85')}>{names}</span>
          {th.message_count > 1 && <span className="text-[11.5px] text-faint">{th.message_count}</span>}
          {th.has_draft && <span className="text-[11.5px] font-medium text-danger">{t('Draft')}</span>}
          <span className="flex-1" />
          {th.has_attachments && <Paperclip size={12.5} className="text-faint" />}
          {th.pinned && <Pin size={12.5} className="fill-current text-pin" />}
          {th.muted && <BellOff size={12.5} className="text-faint" />}
          <span className={cx('shrink-0 text-[12px] tabular-nums group-hover:invisible', th.unread ? 'font-medium text-accent' : 'text-muted')}>{listDate(th.last_date)}</span>
        </div>
        <div className={cx('truncate text-[13px]', th.unread ? 'font-medium text-fg' : 'text-fg/80')}>{th.subject}</div>
        {!compact && <div className="line-clamp-1 text-[12.5px] text-muted">{th.snippet || ' '}</div>}
        {(th.snoozed_until || th.reminder_at || th.is_new_sender || th.labels.length > 0 || th.resurfaced_at) && (
          <div className="mt-1 flex flex-wrap gap-1">
            {th.snoozed_until && <Chip icon={<Clock size={11} />}>{new Date(th.snoozed_until).getFullYear() > 9000 ? t('someday') : listDate(th.snoozed_until)}</Chip>}
            {th.reminder_at && <Chip icon={<AlarmClock size={11} />}>{listDate(th.reminder_at)}</Chip>}
            {th.resurfaced_at && !th.snoozed_until && <Chip icon={<AlarmClock size={11} />} tone="accent">{t('back')}</Chip>}
            {th.is_new_sender && <Chip icon={<ShieldCheck size={11} />} tone="warn">{t('new sender')}</Chip>}
            {th.labels.slice(0, 3).map((l) => <Chip key={l}>{l}</Chip>)}
          </div>
        )}
      </div>
      <div className="absolute right-2 top-1.5 hidden items-center gap-0.5 rounded-lg border border-line bg-surface px-0.5 shadow-sm group-hover:flex" onClick={(e) => e.stopPropagation()}>
        <IconButton title={t('Done (E)')} onClick={() => void act('archive', [th.thread_id])}><Check size={15} /></IconButton>
        <IconButton title={th.pinned ? t('Unpin') : t('Pin (S)')} onClick={() => void act(th.pinned ? 'unpin' : 'pin', [th.thread_id])}>{th.pinned ? <PinOff size={15} /> : <Pin size={15} />}</IconButton>
        <IconButton title={t('Snooze (H)')} onClick={setSnooze}><Clock size={15} /></IconButton>
        <IconButton title={t('Move to Trash (#)')} onClick={() => void act('trash', [th.thread_id])}><Trash2 size={15} /></IconButton>
      </div>
    </div>
  )
})

function Chip({ children, icon, tone }: { children: React.ReactNode; icon?: React.ReactNode; tone?: 'warn' | 'accent' }) {
  return (
    <span className={cx(
      'inline-flex items-center gap-1 rounded-md px-1.5 py-[1px] text-[11px]',
      tone === 'warn' ? 'bg-warning/15 text-warning' : tone === 'accent' ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted border border-line',
    )}>
      {icon}
      {children}
    </span>
  )
}

function GroupRow({ category, threads, expanded, onToggle }: { category: Category; threads: ThreadSummary[]; expanded: boolean; onToggle: () => void }) {
  const { act } = useStore()
  const meta = CAT_META[category]
  const unread = threads.filter((t) => t.unread).length
  const senders = [...new Set(threads.map((t) => displayName(t.from)))].slice(0, 4).join(', ')
  return (
    <div onClick={onToggle} className="group flex cursor-default items-center gap-3 border-b border-line/60 px-3.5 py-2.5 hover:bg-hover">
      <div className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full text-white" style={{ background: meta.color }}>{meta.icon}</div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cx('text-[13.5px]', unread ? 'font-semibold' : '')}>{meta.label}</span>
          <span className="rounded-full bg-surface-2 px-1.5 text-[11.5px] text-muted">{threads.length}</span>
          {unread > 0 && <span className="text-[11.5px] font-medium text-accent">{tp(unread, '{n} new', '{n} new')}</span>}
          <span className="flex-1" />
          {expanded ? <ChevronDown size={15} className="text-muted" /> : <ChevronRight size={15} className="text-muted" />}
        </div>
        <div className="truncate text-[12.5px] text-muted">{senders}</div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation()
          void act('archive', threads.map((t) => t.thread_id))
        }}
        className="hidden h-7 items-center gap-1 rounded-lg border border-line bg-surface px-2 text-[12px] hover:bg-hover group-hover:flex"
        title={t('Mark all as done')}
      >
        <Check size={13} /> {t('Done ({n})', { n: threads.length })}
      </button>
    </div>
  )
}

export default function ThreadList() {
  const s = useStore()
  const { threads, loading, hasMore, selected, checked, mailbox, settings, counts, loadMore, select, toggleCheck, act, clearChecks, refreshList } = s
  const title = useMailboxTitle()
  const parentRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState<Set<Category>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; t: ThreadSummary } | null>(null)
  const smart = mailbox.kind === 'smart' && settings?.smartInbox !== false
  const groupCats = useMemo(() => {
    const g = new Set<Category>()
    if (smart && settings?.groupNotifications !== false) g.add('notification')
    if (smart && settings?.groupNewsletters !== false) g.add('newsletter')
    return g
  }, [smart, settings])
  const rows = useMemo(
    () => buildRows(threads, smart, groupCats, expanded, smart && settings?.gatekeeper === 'on' ? counts?.newsenders || 0 : 0),
    [threads, smart, groupCats, expanded, settings?.gatekeeper, counts?.newsenders],
  )
  const compact = settings?.density === 'compact'
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (rows[i].kind === 'header' ? 30 : rows[i].kind === 'banner' ? 52 : compact ? 58 : 78),
    overscan: 12,
    getItemKey: (i) => rows[i].key,
  })

  useEffect(() => {
    const items = virt.getVirtualItems()
    const last = items[items.length - 1]
    if (last && last.index >= rows.length - 8 && !loading && rows.length > 0) void loadMore()
  }, [virt.getVirtualItems(), rows.length, loading, hasMore])

  // keep the selected row visible when navigating with the keyboard
  useEffect(() => {
    if (!selected) return
    const idx = rows.findIndex((r) => r.kind === 'thread' && r.t.thread_id === selected)
    if (idx >= 0) virt.scrollToIndex(idx, { align: 'auto' })
  }, [selected])

  if (mailbox.kind === 'scheduled' || mailbox.kind === 'local-drafts') return <DraftList kind={mailbox.kind} />

  const open = (t: ThreadSummary, e: React.MouseEvent) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) toggleCheck(t.thread_id, e.shiftKey)
    else {
      clearChecks()
      select(t.thread_id)
    }
  }

  const menuItems = (th: ThreadSummary): MenuItem[] => {
    const ids = checked.includes(th.thread_id) ? checked : [th.thread_id]
    const emails = [th.from.email]
    return [
      { label: t('Done'), icon: <Check size={14} />, hint: 'E', onClick: () => void act('archive', ids) },
      { label: th.unread ? t('Mark as read') : t('Mark as unread'), icon: th.unread ? <MailOpen size={14} /> : <Mail size={14} />, hint: 'U', onClick: () => void act(th.unread ? 'read' : 'unread', ids) },
      { label: th.pinned ? t('Unpin') : t('Pin'), icon: <Pin size={14} />, hint: 'S', onClick: () => void act(th.pinned ? 'unpin' : 'pin', ids) },
      { label: t('Snooze…'), icon: <Clock size={14} />, hint: 'H', onClick: () => useStore.setState({ snoozeFor: ids, pickerMode: 'snooze' }) },
      { label: th.set_aside ? t('Back to Inbox') : t('Set aside'), icon: <Coffee size={14} />, onClick: () => void act(th.set_aside ? 'unaside' : 'aside', ids) },
      { label: th.priority ? t('Remove priority') : t('Mark as priority'), icon: <Star size={14} />, onClick: () => void act(th.priority ? 'unpriority' : 'priority', ids) },
      { label: th.muted ? t('Unmute conversation') : t('Mute conversation'), icon: <BellOff size={14} />, hint: 'M', onClick: () => void act(th.muted ? 'unmute' : 'mute', ids) },
      { label: t('Move to folder…'), icon: <FolderInput size={14} />, hint: 'V', onClick: () => useStore.setState({ moveFor: ids }) },
      { label: t('Move to Inbox'), icon: <Inbox size={14} />, onClick: () => void act('moveToInbox', ids) },
      { separator: true, label: '' },
      { label: t('Sender → People'), icon: <Users size={14} />, onClick: () => void s.categorize(emails, 'people') },
      { label: t('Sender → Notifications'), icon: <Bell size={14} />, onClick: () => void s.categorize(emails, 'notification') },
      { label: t('Sender → Newsletters'), icon: <Newspaper size={14} />, onClick: () => void s.categorize(emails, 'newsletter') },
      { label: t('Priority sender'), icon: <Flag size={14} />, onClick: () => void s.senders('vip', emails) },
      { label: t('Accept sender'), icon: <ShieldCheck size={14} />, onClick: () => void s.senders('accept', emails) },
      { label: t('Block {email}', { email: th.from.email }), icon: <ShieldX size={14} />, danger: true, onClick: () => void s.senders('block', emails) },
      { separator: true, label: '' },
      { label: t('Unsubscribe from list'), icon: <X size={14} />, onClick: () => void act('unsubscribe', ids) },
      { label: t('Spam'), icon: <TriangleAlert size={14} />, onClick: () => void act('spam', ids) },
      { label: t('Move to Trash'), icon: <Trash2 size={14} />, hint: '#', danger: true, onClick: () => void act('trash', ids) },
      ...(mailbox.kind === 'unified' && (mailbox.role === 'trash' || mailbox.role === 'junk')
        ? [{ label: t('Delete forever'), icon: <Trash2 size={14} />, danger: true, onClick: () => void act('deleteForever', ids) }]
        : []),
    ]
  }

  return (
    <section className="flex h-full w-[400px] shrink-0 flex-col border-r border-line bg-surface max-md:w-full max-md:shrink max-md:border-r-0">
      <div className="flex h-12 items-center gap-2 border-b border-line px-3.5">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold">{title}</div>
        </div>
        {loading && <Spinner className="text-muted" />}
        <IconButton title={t('Refresh')} onClick={() => void refreshList(true)}><RefreshCw size={15} /></IconButton>
      </div>
      {checked.length > 0 && (
        <div className="flex items-center gap-1 border-b border-line bg-accent-soft px-2 py-1.5">
          <span className="px-1.5 text-[12.5px] font-medium text-accent">{t('Selected: {n}', { n: checked.length })}</span>
          <span className="flex-1" />
          <IconButton title={t('Done')} onClick={() => void act('archive')}><Check size={15} /></IconButton>
          <IconButton title={t('Mark read')} onClick={() => void act('read')}><MailOpen size={15} /></IconButton>
          <IconButton title={t('Pin')} onClick={() => void act('pin')}><Pin size={15} /></IconButton>
          <IconButton title={t('Snooze')} onClick={() => useStore.setState({ snoozeFor: checked, pickerMode: 'snooze' })}><Clock size={15} /></IconButton>
          <IconButton title={t('Move')} onClick={() => useStore.setState({ moveFor: checked })}><FolderInput size={15} /></IconButton>
          <IconButton title={t('Move to Trash')} onClick={() => void act('trash')}><Trash2 size={15} /></IconButton>
          <IconButton title={t('Clear selection')} onClick={clearChecks}><X size={15} /></IconButton>
        </div>
      )}
      <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto">
        {!loading && rows.length === 0 ? (
          <Empty icon={mailbox.kind === 'smart' ? <InboxZero /> : <NoResults />} title={mailbox.kind === 'smart' ? t('All done!') : mailbox.kind === 'search' ? t('Nothing found') : t('Nothing here')} hint={mailbox.kind === 'smart' ? t('Nothing left to deal with in your inbox.') : mailbox.kind === 'search' ? t('Try other words or operators, e.g. from:, newer_than:30d, in:anywhere.') : undefined} />
        ) : (
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((vi) => {
              const r = rows[vi.index]
              return (
                <div key={vi.key} data-index={vi.index} ref={virt.measureElement} style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}>
                  {r.kind === 'header' && (
                    <div className="flex h-[30px] items-end bg-surface px-4 pb-1 text-[11.5px] font-semibold uppercase tracking-wide text-faint">
                      {r.label}
                      {r.count ? <span className="ml-1.5 font-normal">{r.count}</span> : null}
                    </div>
                  )}
                  {r.kind === 'banner' && (
                    <button onClick={() => s.setMailbox({ kind: 'newsenders' })} className="flex w-full items-center gap-3 border-b border-line bg-warning/10 px-4 py-3 text-left hover:bg-warning/15">
                      <ShieldCheck size={18} className="text-warning" />
                      <span className="flex-1 text-[13px]"><b>{r.count}</b> {tp(r.count, 'new sender is waiting for your decision', 'new senders are waiting for your decision')}</span>
                      <ChevronRight size={15} className="text-muted" />
                    </button>
                  )}
                  {r.kind === 'group' && (
                    <GroupRow
                      category={r.category}
                      threads={r.threads}
                      expanded={expanded.has(r.category)}
                      onToggle={() => {
                        const n = new Set(expanded)
                        if (n.has(r.category)) n.delete(r.category)
                        else n.add(r.category)
                        setExpanded(n)
                      }}
                    />
                  )}
                  {r.kind === 'thread' && (
                    <ThreadRow
                      t={r.t}
                      nested={r.nested}
                      compact={compact}
                      selected={selected === r.t.thread_id}
                      checked={checked.includes(r.t.thread_id)}
                      onOpen={open}
                      onCheck={(t, e) => toggleCheck(t.thread_id, e.shiftKey)}
                      onMenu={(t, e) => {
                        e.preventDefault()
                        setMenu({ x: e.clientX, y: e.clientY, t })
                      }}
                    />
                  )}
                </div>
              )
            })}
          </div>
        )}
        {loading && rows.length === 0 && (
          <div className="flex justify-center p-8 text-muted"><Spinner /></div>
        )}
      </div>
      <Menu items={menu ? menuItems(menu.t) : []} anchor={menu ? { x: menu.x, y: menu.y } : null} onClose={() => setMenu(null)} />
    </section>
  )
}
