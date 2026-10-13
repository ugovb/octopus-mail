import {
  ArrowDownLeft, ArrowUpRight, Ban, Building, ChevronLeft, Copy, Inbox, Phone, RefreshCw, Search, Send, ShieldCheck, ShieldOff, ShieldX, Star, StickyNote, UserRound, Users,
} from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { t, tp } from '../../../shared/i18n'
import type { Category, Contact, CoreEvent } from '../../../shared/types'
import DrawerButton from '../components/DrawerButton'
import { Avatar, Button, cx, Empty, Field, IconButton, inputCls, Select, Spinner, Toggle } from '../components/ui'
import { api, errorText } from '../lib/api'
import { copyText, displayName, fullDate, listDate } from '../lib/format'
import { useNarrow } from '../lib/narrow'
import { useStore } from '../lib/store'
import { NoContact } from '../components/illustrations'

type Filter = 'all' | 'blocked'
type ActionResult = { message?: string; undo?: string }

/** Row shape of api.contactStats().recent (search.ts → searchMessages). */
interface RecentMessage {
  id: number
  thread_id: number
  subject: string | null
  snippet: string | null
  from_name: string | null
  from_email: string | null
  date: number
  is_outgoing: number | boolean
  account_email: string
}

const PAGE = 200

const CATEGORY: Record<Category, { label: string; cls: string }> = {
  people: { label: t('People'), cls: 'bg-people/12 text-people' },
  notification: { label: t('Notifications'), cls: 'bg-notification/12 text-notification' },
  newsletter: { label: t('Newsletters'), cls: 'bg-newsletter/12 text-newsletter' },
}

const STATUS_LABEL: Record<Contact['status'], string> = {
  accepted: t('Accepted sender'),
  unknown: t('New sender (not accepted)'),
  blocked: t('Blocked sender'),
}

const SOURCE_LABEL: Record<string, string> = { google: 'Google Contacts', manual: t('added manually') }

const addrOf = (c: Pick<Contact, 'email' | 'name'>) => ({ email: c.email, name: c.name || undefined })

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

function Badge({ children, cls, title }: { children: ReactNode; cls: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-[1px] text-[10.5px] font-medium', cls)}>
      {children}
    </span>
  )
}

function Card({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-2 flex items-center">
        <h3 className="flex-1 text-[11.5px] font-semibold uppercase tracking-wide text-faint">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  )
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="text-[15px] font-semibold tabular-nums">{value}</span>
    </div>
  )
}

// ---------- list ----------

function ContactRow({ c, active, onClick }: { c: Contact; active: boolean; onClick: () => void }) {
  const cat = c.category ? CATEGORY[c.category] : null
  return (
    <button
      onClick={onClick}
      data-email={c.email}
      className={cx('flex w-full items-center gap-3 border-b border-line/60 px-3.5 py-2 text-left transition-colors', active ? 'bg-accent-soft' : 'hover:bg-hover')}
    >
      <Avatar addr={addrOf(c)} size={32} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={cx('truncate text-[13.5px] font-medium', c.status === 'blocked' && 'text-muted')}>{displayName(addrOf(c))}</span>
          {c.vip && <Star size={12} className="shrink-0 fill-current text-pin" aria-label="VIP" />}
        </div>
        <div className="truncate text-[12px] text-muted">{c.email}</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        {c.status === 'blocked' && <Badge cls="bg-danger/12 text-danger">{t('blocked')}</Badge>}
        {cat && c.status !== 'blocked' && <Badge cls={cat.cls}>{cat.label}</Badge>}
      </div>
    </button>
  )
}

// ---------- card ----------

interface FormState {
  name: string
  phone: string
  company: string
  notes: string
}
const formOf = (c: Contact | null): FormState => ({ name: c?.name || '', phone: c?.phone || '', company: c?.company || '', notes: c?.notes || '' })

function ContactCard({ email, version, onChanged }: { email: string; version: number; onChanged: () => void }) {
  const toast = useStore((s) => s.toast)
  const compose = useStore((s) => s.compose)
  const [contact, setContact] = useState<Contact | null>(null)
  const [recent, setRecent] = useState<RecentMessage[] | null>(null)
  const [form, setForm] = useState<FormState>(formOf(null))
  const [saved, setSaved] = useState<FormState>(formOf(null))
  const [busy, setBusy] = useState(false)
  const dirty = (Object.keys(form) as (keyof FormState)[]).some((k) => form[k] !== saved[k])
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  const load = useCallback(
    async (keepForm: boolean) => {
      try {
        const s = await api.contactStats(email)
        setContact(s.contact)
        setRecent(s.recent as unknown as RecentMessage[])
        const f = formOf(s.contact)
        setSaved(f)
        if (!keepForm) setForm(f)
      } catch (e) {
        toast({ level: 'error', message: errorText(e) })
      }
    },
    [email, toast],
  )

  useEffect(() => {
    setContact(null)
    setRecent(null)
    void load(false)
  }, [load])

  // external changes (sync, undo…): refresh, but never throw away unsaved edits
  const mountVersion = useRef(version)
  useEffect(() => {
    if (version !== mountVersion.current) void load(dirtyRef.current)
  }, [version])

  const run = async (p: Promise<ActionResult>, fallback: string) => {
    try {
      const r = await p
      toast({ level: 'info', message: r.message || fallback, undo: r.undo })
      await load(dirtyRef.current)
      onChanged()
    } catch (e) {
      toast({ level: 'error', message: errorText(e) })
    }
  }

  const save = async () => {
    setBusy(true)
    try {
      const c = await api.upsertContact({ email, name: form.name.trim(), phone: form.phone.trim(), company: form.company.trim(), notes: form.notes.trim() })
      setContact(c)
      const f = formOf(c)
      setSaved(f)
      setForm(f)
      toast({ level: 'success', message: t('Contact saved') })
      onChanged()
    } catch (e) {
      toast({ level: 'error', message: errorText(e) })
    }
    setBusy(false)
  }

  const copy = async () => {
    try {
      await copyText(email)
      toast({ level: 'success', message: t('Email address copied') })
    } catch {
      toast({ level: 'error', message: t("Couldn't copy the address") })
    }
  }

  const openMail = (threadId?: number) => {
    const st = useStore.getState()
    st.setMailbox({ kind: 'search', query: `with:${email}` })
    if (threadId) st.select(threadId)
  }

  if (!contact && !recent) return <div className="flex h-full items-center justify-center text-muted"><Spinner /></div>

  const c = contact
  const status = c?.status ?? 'unknown'
  const lastContact = Math.max(c?.last_sent ?? 0, c?.last_received ?? 0)
  const isDomain = email.startsWith('@')

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-4 p-6">
        <div className="flex items-center gap-4">
          <Avatar addr={addrOf({ email, name: c?.name ?? null })} size={72} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="selectable truncate text-[20px] font-semibold">{displayName(addrOf({ email, name: c?.name ?? null }))}</h2>
              {c?.vip && <Star size={16} className="shrink-0 fill-current text-pin" aria-label="VIP" />}
            </div>
            <div className="flex items-center gap-1">
              <span className="selectable truncate text-[13.5px] text-muted">{email}</span>
              <IconButton title={t('Copy address')} onClick={() => void copy()}><Copy size={13} /></IconButton>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              <Badge cls={status === 'blocked' ? 'bg-danger/12 text-danger' : status === 'accepted' ? 'bg-success/12 text-success' : 'bg-warning/15 text-warning'}>
                {STATUS_LABEL[status]}
              </Badge>
              {c?.category && <Badge cls={CATEGORY[c.category].cls}>{CATEGORY[c.category].label}</Badge>}
              {c?.source && SOURCE_LABEL[c.source] && <Badge cls="border border-line bg-surface-2 text-muted">{SOURCE_LABEL[c.source]}</Badge>}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {!isDomain && (
            <Button variant="primary" onClick={() => compose({ mode: 'new', prefill: { to: [email] } })}>
              <Send size={14} /> {t('Write')}
            </Button>
          )}
          <Button onClick={() => openMail()}>
            <Inbox size={14} /> {t('All messages')}
          </Button>
          <span className="flex-1" />
          {status === 'unknown' && (
            <Button variant="outline" onClick={() => void run(api.acceptSenders([email]), t('Sender accepted'))}>
              <ShieldCheck size={14} /> {t('Accept')}
            </Button>
          )}
          {status === 'blocked' ? (
            <Button variant="outline" onClick={() => void run(api.unblockSenders([email]), t('Sender unblocked'))}>
              <ShieldOff size={14} /> {t('Unblock')}
            </Button>
          ) : (
            <Button variant="outline" onClick={() => void run(api.blockSenders([email]), t('Sender blocked'))}>
              <span className="inline-flex items-center gap-1.5 text-danger"><ShieldX size={14} /> {t('Block')}</span>
            </Button>
          )}
        </div>

        <div className="grid grid-cols-2 max-md:grid-cols-1 gap-4">
          <Card title={t('Statistics')}>
            <div className="grid grid-cols-2 max-md:grid-cols-1 gap-3">
              <Stat label={t('Sent to')} value={c?.sent_count ?? 0} />
              <Stat label={t('Received from')} value={c?.recv_count ?? 0} />
            </div>
            <div className="mt-3 text-[12.5px] text-muted">
              {t('Last contact:')} <span className="text-fg">{lastContact ? fullDate(lastContact) : t('none')}</span>
            </div>
          </Card>
          <Card title={t('Sender')}>
            <Toggle
              checked={!!c?.vip}
              onChange={(on) => void run(api.prioritySender([email], on), on ? t('Priority sender') : t('Priority removed'))}
              label={t('Priority (VIP)')}
              hint={t('Their messages go to the top of Smart Inbox.')}
            />
            <Field label={t('Category')}>
              <Select<Category | ''>
                value={c?.category ?? ''}
                onChange={(v) => v && void run(api.changeSenderCategory([email], v), t('Category changed'))}
                options={[
                  ...(c?.category ? [] : [{ value: '' as const, label: t('Automatic') }]),
                  { value: 'people', label: t('People') },
                  { value: 'notification', label: t('Notifications') },
                  { value: 'newsletter', label: t('Newsletters') },
                ]}
              />
            </Field>
          </Card>
        </div>

        <Card
          title={t('Contact details')}
          right={
            dirty && (
              <div className="flex gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setForm(saved)}>{t('Cancel')}</Button>
                <Button size="sm" variant="primary" disabled={busy} onClick={() => void save()}>
                  {busy && <Spinner className="h-3.5 w-3.5" />} {t('Save')}
                </Button>
              </div>
            )
          }
        >
          <div className="grid grid-cols-2 max-md:grid-cols-1 gap-x-4" onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && dirty && void save()}>
            <Field label={<span className="flex items-center gap-1.5"><UserRound size={12} /> {t('Full name')}</span>}>
              <input className={inputCls} value={form.name} placeholder={email.split('@')[0]} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label={<span className="flex items-center gap-1.5"><Phone size={12} /> {t('Phone')}</span>}>
              <input className={inputCls} value={form.phone} placeholder={t('+1 …')} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </Field>
            <div className="col-span-2">
              <Field label={<span className="flex items-center gap-1.5"><Building size={12} /> {t('Company')}</span>}>
                <input className={inputCls} value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} />
              </Field>
              <Field label={<span className="flex items-center gap-1.5"><StickyNote size={12} /> {t('Notes')}</span>}>
                <textarea
                  className={cx(inputCls, 'h-20 resize-y py-2 leading-snug')}
                  value={form.notes}
                  placeholder={t('Only visible to you')}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                />
              </Field>
            </div>
          </div>
        </Card>

        <Card
          title={t('Recent messages')}
          right={recent && recent.length > 0 ? <Button size="sm" variant="ghost" onClick={() => openMail()}>{t('Show all')}</Button> : undefined}
        >
          {!recent ? (
            <div className="flex justify-center p-4 text-muted"><Spinner /></div>
          ) : !recent.length ? (
            <div className="py-2 text-[12.5px] text-muted">{t('No messages with this contact in downloaded mail.')}</div>
          ) : (
            <div className="-mx-2 flex flex-col">
              {recent.map((m) => (
                <button key={m.id} onClick={() => openMail(m.thread_id)} className="flex items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-hover">
                  <span className={cx('mt-0.5 shrink-0', m.is_outgoing ? 'text-accent' : 'text-muted')} title={m.is_outgoing ? t('Sent message') : t('Received message')}>
                    {m.is_outgoing ? <ArrowUpRight size={15} /> : <ArrowDownLeft size={15} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{m.subject || t('(no subject)')}</span>
                    <span className="line-clamp-1 text-[12px] text-muted">{m.snippet || ' '}</span>
                  </span>
                  <span className="shrink-0 text-[12px] tabular-nums text-muted">{listDate(m.date)}</span>
                </button>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

// ---------- view ----------

export default function ContactsView() {
  const toast = useStore((s) => s.toast)
  const narrow = useNarrow()
  const accounts = useStore((s) => s.accounts)
  const [filter, setFilter] = useState<Filter>('all')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [list, setList] = useState<Contact[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [blockedCount, setBlockedCount] = useState<number | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [version, setVersion] = useState(0)
  const reqId = useRef(0)
  const listRef = useRef<Contact[]>([])
  listRef.current = list
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 200)
    return () => clearTimeout(t)
  }, [q])

  /** reset: first page · more: next page · refresh: reload what is already shown */
  const load = useCallback(
    async (how: 'reset' | 'more' | 'refresh') => {
      const id = ++reqId.current
      setLoading(true)
      try {
        if (filter === 'blocked') {
          const all = await api.listBlocked()
          if (id !== reqId.current) return
          setBlockedCount(all.length)
          const ql = query.toLowerCase()
          setList(ql ? all.filter((c) => c.email.toLowerCase().includes(ql) || (c.name || '').toLowerCase().includes(ql)) : all)
          setHasMore(false)
        } else {
          const shown = listRef.current.length
          const offset = how === 'more' ? shown : 0
          const limit = how === 'refresh' ? Math.max(PAGE, shown) : PAGE
          const page = await api.listContacts(query, limit, offset)
          if (id !== reqId.current) return
          if (how === 'more') {
            setList((prev) => {
              const seen = new Set(prev.map((c) => c.email))
              return [...prev, ...page.filter((c) => !seen.has(c.email))]
            })
          } else setList(page)
          setHasMore(page.length >= limit)
        }
      } catch (e) {
        if (id === reqId.current) toast({ level: 'error', message: errorText(e) })
      } finally {
        if (id === reqId.current) setLoading(false)
      }
    },
    [filter, query, toast],
  )

  const refreshBlockedCount = useCallback(() => {
    void api.listBlocked().then((b) => setBlockedCount(b.length)).catch(() => undefined)
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
    void load('reset')
  }, [load])
  useEffect(() => refreshBlockedCount(), [refreshBlockedCount])

  const latest = useRef(load)
  latest.current = load
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = window.octo.on('core-event', (e: CoreEvent) => {
      if (e.type !== 'contacts-changed') return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        void latest.current('refresh')
        refreshBlockedCount()
        setVersion((v) => v + 1)
      }, 250)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [refreshBlockedCount])

  const afterChange = () => {
    void load('refresh')
    refreshBlockedCount()
  }

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    if (hasMore && !loading && el.scrollTop + el.clientHeight > el.scrollHeight - 400) void load('more')
  }

  const syncGoogle = async () => {
    if (!accounts.some((a) => a.auth === 'oauth-google')) {
      toast({ level: 'info', message: t('No Google accounts signed in with OAuth — add a Google account in Settings → Accounts.') })
      return
    }
    setSyncing(true)
    try {
      const n = await api.syncContacts()
      toast(
        n
          ? { level: 'success', message: tp(n, 'Synced {n} address from Google Contacts', 'Synced {n} addresses from Google Contacts') }
          : { level: 'info', message: t('No contacts were downloaded from Google — check that the account has access to Google Contacts.') },
      )
      afterChange()
    } catch (e) {
      toast({ level: 'error', message: errorText(e) })
    }
    setSyncing(false)
  }

  // ↑/↓ (j/k) move through the list when not typing
  const keys = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keys.current = (e: KeyboardEvent) => {
    const st = useStore.getState()
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey || st.palette || (st.composer && !st.composer.inline)) return
    const d = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0
    if (!d || !list.length) return
    e.preventDefault()
    const i = list.findIndex((c) => c.email === selected)
    const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + d))]
    setSelected(next.email)
    scrollRef.current?.querySelector(`[data-email="${CSS.escape(next.email)}"]`)?.scrollIntoView({ block: 'nearest' })
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => keys.current(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const chip = (value: Filter, label: string, count?: number | null) => (
    <button
      onClick={() => setFilter(value)}
      className={cx(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors',
        filter === value ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:bg-hover hover:text-fg',
      )}
    >
      {label}
      {count ? <span className="tabular-nums opacity-75">{count}</span> : null}
    </button>
  )

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1">
      <section className={cx('flex h-full w-[340px] shrink-0 flex-col border-r border-line bg-surface', narrow && (selected ? 'hidden' : 'w-full border-r-0'))}>
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line pl-3.5 pr-2 max-md:pl-2">
          <DrawerButton />
          <div className="flex-1 truncate text-[15px] font-semibold">{t('Contacts')}</div>
          <Button size="sm" variant="ghost" disabled={syncing} onClick={() => void syncGoogle()} title={t('Download the address book from your Google accounts (OAuth)')}>
            <RefreshCw size={13} className={cx(syncing && 'animate-spin')} /> {narrow ? 'Google' : t('Sync Google contacts')}
          </Button>
        </div>
        <div className="shrink-0 border-b border-line p-2.5">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-2.5 text-muted" />
            <input
              className={cx(inputCls, 'pl-9')}
              placeholder={t('Search by name or address…')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && q && (e.stopPropagation(), setQ(''))}
            />
          </div>
          <div className="mt-2 flex gap-1.5">
            {chip('all', t('All'))}
            {chip('blocked', t('Blocked senders'), blockedCount)}
          </div>
        </div>
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
          {list.map((c) => (
            <ContactRow key={c.email} c={c} active={selected === c.email} onClick={() => setSelected(c.email)} />
          ))}
          {loading && (
            <div className="flex justify-center p-4 text-muted"><Spinner /></div>
          )}
          {!loading && !list.length && (
            <Empty
              icon={filter === 'blocked' ? <Ban size={32} /> : <Users size={32} />}
              title={query ? t('Nothing found') : filter === 'blocked' ? t('No one is blocked') : t('No contacts')}
              hint={
                query
                  ? t('No contacts match “{query}”.', { query })
                  : filter === 'blocked'
                    ? t("Blocked senders appear here — their messages don't show up in your inbox.")
                    : t('Contacts are created automatically from your mail. You can also download your address book from Google.')
              }
            />
          )}
        </div>
      </section>
      <div className={cx('flex min-w-0 flex-1 flex-col bg-bg', narrow && !selected && 'hidden')}>
        {narrow && selected && (
          <button className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2 text-[14px] text-accent" onClick={() => setSelected(null)}>
            <ChevronLeft size={18} /> {t('Contacts')}
          </button>
        )}
        {selected ? (
          <ContactCard key={selected} email={selected} version={version} onChanged={afterChange} />
        ) : (
          <Empty icon={<NoContact />} title={t('Select a contact')} hint={t("You'll see contact details, mail statistics and recent messages here.")} />
        )}
      </div>
    </div>
  )
}
