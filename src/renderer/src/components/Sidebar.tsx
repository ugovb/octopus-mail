import {
  AlarmClock, Archive, Ban, Bell, BookmarkPlus, CalendarDays, ChevronDown, ChevronRight, Clock, Contact, FileEdit, Folder as FolderIcon,
  Inbox, Newspaper, PenSquare, Pin, RefreshCw, Search, Send, Settings, ShieldQuestion, Sparkles, Trash2, TriangleAlert, Users, Coffee,
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import type { Folder, MailboxRef } from '../../../shared/types'
import logo from '../assets/logo.svg'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { askText, cx, IconButton, Menu, type MenuItem, Spinner } from './ui'
import { dateLocale, t } from '../../../shared/i18n'

function sameRef(a: MailboxRef, b: MailboxRef): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function Item({
  icon, label, count, refTo, accountFilter = null, onClick, active, dim, color, onContext,
}: {
  icon: ReactNode; label: string; count?: number; refTo?: MailboxRef; accountFilter?: number | null; onClick?: () => void
  active?: boolean; dim?: boolean; color?: string; onContext?: (e: React.MouseEvent) => void
}) {
  const { mailbox, accountFilter: af, view, setMailbox } = useStore()
  const isActive = active ?? (view === 'mail' && !!refTo && sameRef(mailbox, refTo) && af === accountFilter)
  return (
    <button
      onClick={() => (onClick ? onClick() : refTo && setMailbox(refTo, accountFilter))}
      onContextMenu={onContext}
      className={cx(
        'group flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] transition-colors',
        isActive ? 'bg-accent-soft font-medium text-accent' : 'text-fg hover:bg-hover',
        dim && !isActive && 'text-muted',
      )}
    >
      <span className={cx('flex w-4 justify-center', !isActive && 'text-muted')} style={color && !isActive ? { color } : undefined}>
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {!!count && <span className={cx('text-[12px] tabular-nums', isActive ? 'text-accent' : 'text-muted')}>{count > 999 ? '999+' : count}</span>}
    </button>
  )
}

function Section({ title, children, defaultOpen = true, right }: { title: string; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="mt-3">
      <div className="group flex items-center px-2.5 pb-1">
        <button onClick={() => setOpen(!open)} className="flex flex-1 items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-faint hover:text-muted">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {title}
        </button>
        {right}
      </div>
      {open && children}
    </div>
  )
}

const ROLE_ICON: Record<string, ReactNode> = {
  inbox: <Inbox size={15} />, sent: <Send size={15} />, drafts: <FileEdit size={15} />, archive: <Archive size={15} />,
  all: <Archive size={15} />, trash: <Trash2 size={15} />, junk: <TriangleAlert size={15} />, blocked: <Ban size={15} />,
  flagged: <Pin size={15} />, important: <Bell size={15} />,
}
const ROLE_LABEL: Record<string, string> = {
  inbox: t('Inbox'), sent: t('Sent'), drafts: t('Drafts'), archive: t('Archive'), all: t('All mail'), trash: t('Trash'),
  junk: t('Spam'), blocked: t('Blocked'), flagged: t('Flagged'), important: t('Important'),
}

function AccountFolders({ accountId, folders }: { accountId: number; folders: Folder[] }) {
  const counts = useStore((s) => s.counts)
  const [menu, setMenu] = useState<{ x: number; y: number; folder: Folder } | null>(null)
  const toast = useStore((s) => s.toast)
  const sorted = useMemo(() => {
    const roleOrder = ['inbox', 'flagged', 'drafts', 'sent', 'archive', 'all', 'junk', 'blocked', 'trash']
    const sys = folders.filter((f) => f.role && f.role !== 'important').sort((a, b) => roleOrder.indexOf(a.role!) - roleOrder.indexOf(b.role!))
    const user = folders.filter((f) => !f.role && f.path !== '[Gmail]').sort((a, b) => a.path.localeCompare(b.path, dateLocale()))
    return { sys, user }
  }, [folders])
  const depth = (f: Folder) => (f.delimiter ? f.path.split(f.delimiter).length - 1 : 0)
  const items: MenuItem[] = menu
    ? [
        { label: t('Sync now'), icon: <RefreshCw size={14} />, onClick: () => void api.syncFolder(menu.folder.id) },
        { label: t('Always sync in the background'), onClick: () => void api.setFolderSync(menu.folder.id, 'always') },
        { label: t('Don’t sync'), onClick: () => void api.setFolderSync(menu.folder.id, 'never') },
        { separator: true, label: '' },
        {
          label: t('Rename…'), disabled: !!menu.folder.role,
          onClick: async () => {
            const name = await askText(t('New folder name'), menu.folder.name)
            if (name) void api.renameFolder(menu.folder.id, name).catch((e) => toast({ level: 'error', message: String(e) }))
          },
        },
        {
          label: t('Delete folder'), danger: true, disabled: !!menu.folder.role,
          onClick: () => {
            if (window.confirm(t('Delete the folder “{name}” and everything in it on the server?', { name: menu.folder.name }))) void api.deleteFolder(menu.folder.id).catch((e) => toast({ level: 'error', message: String(e) }))
          },
        },
      ]
    : []
  return (
    <div>
      {sorted.sys.map((f) => (
        <Item key={f.id} icon={ROLE_ICON[f.role!] || <FolderIcon size={15} />} label={ROLE_LABEL[f.role!] || f.name} count={f.role === 'inbox' || f.role === 'junk' ? counts?.folders[f.id] : undefined} refTo={{ kind: 'folder', folderId: f.id }} onContext={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, folder: f }))} dim />
      ))}
      {sorted.user.map((f) => (
        <div key={f.id} style={{ paddingLeft: Math.min(depth(f), 4) * 12 }}>
          <Item icon={<FolderIcon size={15} />} label={f.name} count={counts?.folders[f.id]} refTo={{ kind: 'folder', folderId: f.id }} onContext={(e) => (e.preventDefault(), setMenu({ x: e.clientX, y: e.clientY, folder: f }))} dim />
        </div>
      ))}
      <Menu items={items} anchor={menu ? { x: menu.x, y: menu.y } : null} onClose={() => setMenu(null)} />
      {accountId === -1 && null}
    </div>
  )
}

export default function Sidebar() {
  const { accounts, folders, counts, smartFolders, settings, sync, view, setView, compose, toast, server } = useStore()
  const [openAcc, setOpenAcc] = useState<Record<number, boolean>>({})
  const syncing = Object.values(sync).some((s) => s.state === 'syncing' || s.state === 'connecting')
  const errors = Object.values(sync).filter((s) => s.state === 'error')
  const c = counts

  return (
    <aside className="flex h-full w-[248px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <img src={logo} alt="" className="h-8 w-8" draggable={false} />
        <div className="flex-1 font-semibold tracking-tight">Octopus Mail</div>
        <IconButton title={t('Sync now')} onClick={() => void api.syncNow().catch(() => undefined)}>
          {syncing ? <Spinner /> : <RefreshCw size={15} />}
        </IconButton>
      </div>
      <div className="px-3 pb-2">
        <button
          onClick={() => compose({ mode: 'new' })}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-accent text-[13.5px] font-medium text-accent-fg shadow-sm hover:brightness-110"
        >
          <PenSquare size={15} /> {t('New message')}
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <Item icon={<Inbox size={15} />} label={settings?.smartInbox === false ? t('Inbox') : t('Smart Inbox')} count={c?.inboxUnread} refTo={{ kind: 'smart' }} />
        {settings?.smartInbox !== false && (
          <div className="ml-3 border-l border-line pl-1.5">
            <Item icon={<Users size={14} />} label={t('People')} count={c?.categories.people} refTo={{ kind: 'category', category: 'people' }} color="var(--people)" dim />
            <Item icon={<Bell size={14} />} label={t('Notifications')} count={c?.categories.notification} refTo={{ kind: 'category', category: 'notification' }} color="var(--notification)" dim />
            <Item icon={<Newspaper size={14} />} label={t('Newsletters')} count={c?.categories.newsletter} refTo={{ kind: 'category', category: 'newsletter' }} color="var(--newsletter)" dim />
          </div>
        )}
        {!!c?.newsenders && <Item icon={<ShieldQuestion size={15} />} label={t('New senders')} count={c.newsenders} refTo={{ kind: 'newsenders' }} color="var(--warning)" />}
        <Item icon={<Pin size={15} />} label={t('Pinned')} count={c?.pinned} refTo={{ kind: 'pinned' }} color="var(--pin)" />
        <Item icon={<Clock size={15} />} label={t('Snoozed')} count={c?.snoozed} refTo={{ kind: 'snoozed' }} />
        <Item icon={<Coffee size={15} />} label={t('Set Aside')} count={c?.setaside} refTo={{ kind: 'setaside' }} />
        <Item icon={<AlarmClock size={15} />} label={t('Reminders')} count={c?.reminders} refTo={{ kind: 'reminders' }} />
        <Item icon={<Send size={15} />} label={t('Scheduled')} count={c?.scheduled} refTo={{ kind: 'scheduled' }} />
        <Item icon={<FileEdit size={15} />} label={t('Drafts')} count={c?.drafts} refTo={{ kind: 'local-drafts' }} />
        <Item icon={<Send size={15} />} label={t('Sent')} refTo={{ kind: 'unified', role: 'sent' }} dim />
        <Item icon={<Archive size={15} />} label={t('Archive')} refTo={{ kind: 'unified', role: 'archive' }} dim />
        <Item icon={<TriangleAlert size={15} />} label={t('Spam')} refTo={{ kind: 'unified', role: 'junk' }} dim />
        <Item icon={<Trash2 size={15} />} label={t('Trash')} refTo={{ kind: 'unified', role: 'trash' }} dim />

        {smartFolders.length > 0 && (
          <Section title={t('Smart folders')}>
            {smartFolders.map((sf) => (
              <Item
                key={sf.id}
                icon={<Search size={14} />}
                label={sf.name}
                refTo={{ kind: 'smartfolder', id: sf.id }}
                onContext={(e) => {
                  e.preventDefault()
                  if (window.confirm(t('Delete the smart folder “{name}”? (messages stay)', { name: sf.name }))) void api.deleteSmartFolder(sf.id)
                }}
              />
            ))}
          </Section>
        )}

        {accounts.map((a) => {
          const st = sync[a.id]
          const isOpen = openAcc[a.id] ?? accounts.length <= 2
          return (
            <Section
              key={a.id}
              title={a.name && a.name !== a.email.split('@')[0] ? `${a.name}` : a.email}
              defaultOpen={isOpen}
              right={
                <span className="flex items-center gap-1">
                  {st?.state === 'error' && <span title={st.error || ''}><TriangleAlert size={12} className="text-danger" /></span>}
                  <span className="h-2 w-2 rounded-full" style={{ background: a.color || 'var(--accent)' }} title={a.email} />
                </span>
              }
            >
              <div onClick={() => setOpenAcc({ ...openAcc, [a.id]: true })}>
                <div className="truncate px-2.5 pb-1 text-[11.5px] text-faint">{a.email}</div>
                <AccountFolders accountId={a.id} folders={folders.filter((f) => f.account_id === a.id)} />
                <Item
                  icon={<BookmarkPlus size={14} />}
                  label={t('New folder…')}
                  dim
                  onClick={async () => {
                    const name = await askText(t('New folder in {account}', { account: a.email }), '', t('Folder name'))
                    if (name) void api.createFolder(a.id, name).catch((e) => toast({ level: 'error', message: String(e) }))
                  }}
                  active={false}
                />
              </div>
            </Section>
          )
        })}
      </nav>

      <div className="border-t border-line px-2 py-2">
        {server && !server.online && (
          <button onClick={() => setView('settings')} className="mb-1.5 flex w-full items-center gap-2 rounded-lg bg-warning/15 px-2.5 py-1.5 text-left text-[12px] text-warning" title={server.url}>
            <TriangleAlert size={14} /> <span className="truncate">{t('No connection to the home server')}</span>
          </button>
        )}
        {errors.length > 0 && (
          <button onClick={() => setView('settings')} className="mb-1.5 flex w-full items-center gap-2 rounded-lg bg-danger/10 px-2.5 py-1.5 text-left text-[12px] text-danger">
            <TriangleAlert size={14} /> <span className="truncate">{errors[0].email}: {errors[0].error}</span>
          </button>
        )}
        <div className="flex items-center justify-between">
          <IconButton title={t('Ask AI about your mail')} active={view === 'ask'} onClick={() => setView('ask')}>
            <Sparkles size={16} />
          </IconButton>
          <IconButton title={t('Calendar')} active={view === 'calendar'} onClick={() => setView('calendar')}>
            <CalendarDays size={16} />
          </IconButton>
          <IconButton title={t('Contacts')} active={view === 'contacts'} onClick={() => setView('contacts')}>
            <Contact size={16} />
          </IconButton>
          <IconButton title={t('Settings')} active={view === 'settings'} onClick={() => setView('settings')}>
            <Settings size={16} />
          </IconButton>
        </div>
      </div>
    </aside>
  )
}
