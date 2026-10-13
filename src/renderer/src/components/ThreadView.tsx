import {
  AlarmClock, Archive, ArrowLeft, BellOff, CalendarCheck, CalendarX, Check, ChevronDown, Clock, Coffee, Download, Eye, FileText, FolderInput,
  Forward, Image as ImageIcon, Languages, Mail, MoreHorizontal, Paperclip, Pin, PinOff, Reply, ReplyAll, ShieldCheck, ShieldX, Sparkles,
  Star, Trash2, TriangleAlert, Undo2, X, Code2, Inbox,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AttachmentInfo, MessageView, ThreadView as TV } from '../../../shared/types'
import { formatWhen } from '../../../shared/when'
import { api, errorText, stream } from '../lib/api'
import { displayName, fileSize, fullDate, listDate, mdToHtml } from '../lib/format'
import { useNarrow } from '../lib/narrow'
import { goBack, useStore } from '../lib/store'
import Composer from './Composer'
import MessageFrame from './MessageFrame'
import { NoSelection } from './illustrations'
import { Avatar, Button, cx, Empty, IconButton, Menu, type MenuItem, Modal, Spinner } from './ui'

function useDark() {
  const [dark, setDark] = useState(document.documentElement.dataset.theme === 'dark')
  useEffect(() => {
    const o = new MutationObserver(() => setDark(document.documentElement.dataset.theme === 'dark'))
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => o.disconnect()
  }, [])
  return dark
}

function Attachments({ list }: { list: AttachmentInfo[] }) {
  const toast = useStore((s) => s.toast)
  const files = list.filter((a) => !a.inline)
  if (!files.length) return null
  const run = (p: Promise<unknown>) => p.catch((e) => toast({ level: 'error', message: errorText(e) }))
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
      {files.map((a) => (
        <div key={a.id} className="group flex max-w-[260px] items-center gap-2 rounded-lg border border-line bg-surface-2 py-1.5 pl-2 pr-1">
          <FileText size={16} className="shrink-0 text-muted" />
          <button className="min-w-0 flex-1 text-left" title="Otwórz" onClick={() => void run(window.octo.openAttachment(a.id))}>
            <div className="truncate text-[12.5px] font-medium">{a.filename}</div>
            <div className="text-[11px] text-muted">{fileSize(a.size)}</div>
          </button>
          <IconButton size="sm" title="Zapisz jako…" onClick={() => void run(window.octo.saveAttachment(a.id))}><Download size={14} /></IconButton>
        </div>
      ))}
      {files.length > 1 && (
        <Button size="sm" variant="ghost" onClick={() => void run(window.octo.saveAllAttachments(files.map((f) => f.id)))}>
          <Download size={13} /> Zapisz wszystkie
        </Button>
      )}
    </div>
  )
}

type Invite = Awaited<ReturnType<typeof api.parseInvite>>

function InviteCard({ messageId }: { messageId: number }) {
  const [info, setInfo] = useState<Invite | null>(null)
  const [busy, setBusy] = useState(false)
  const toast = useStore((s) => s.toast)
  useEffect(() => {
    void api.parseInvite(messageId).then(setInfo).catch(() => setInfo(null))
  }, [messageId])
  if (!info) return null
  const i = info as unknown as Record<string, any>
  const rsvp = async (r: 'ACCEPTED' | 'TENTATIVE' | 'DECLINED') => {
    setBusy(true)
    try {
      await api.rsvpInvite(messageId, r)
      toast({ level: 'success', message: 'Odpowiedź wysłana do organizatora' })
      setInfo(await api.parseInvite(messageId))
    } catch (e) {
      toast({ level: 'error', message: errorText(e) })
    }
    setBusy(false)
  }
  const cancelled = String(i.method || '').toUpperCase() === 'CANCEL'
  const mine = String(i.my_status || i.partstat || '').toUpperCase()
  return (
    <div className="mx-4 mb-3 rounded-xl border border-line bg-surface-2 p-3.5">
      <div className="flex items-start gap-3">
        <div className={cx('flex h-10 w-10 shrink-0 items-center justify-center rounded-lg', cancelled ? 'bg-danger/15 text-danger' : 'bg-accent-soft text-accent')}>
          {cancelled ? <CalendarX size={20} /> : <CalendarCheck size={20} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{cancelled ? 'Odwołane: ' : ''}{i.summary || 'Zaproszenie'}</div>
          {i.start && <div className="text-[12.5px] text-muted">{fullDate(Number(i.start))}{i.end ? ` – ${new Date(Number(i.end)).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}` : ''}</div>}
          {i.location && <div className="text-[12.5px] text-muted">{i.location}</div>}
          {i.organizer && <div className="text-[12px] text-faint">Organizator: {typeof i.organizer === 'string' ? i.organizer : i.organizer.name || i.organizer.email}</div>}
          {i.conference_url && <button className="mt-1 text-[12.5px] text-accent underline" onClick={() => void window.octo.openExternal(i.conference_url)}>Dołącz do spotkania</button>}
        </div>
      </div>
      {!cancelled && (
        <div className="mt-3 flex items-center gap-2">
          {busy && <Spinner />}
          <Button size="sm" variant={mine === 'ACCEPTED' ? 'primary' : 'soft'} disabled={busy} onClick={() => void rsvp('ACCEPTED')}>Tak</Button>
          <Button size="sm" variant={mine === 'TENTATIVE' ? 'primary' : 'soft'} disabled={busy} onClick={() => void rsvp('TENTATIVE')}>Może</Button>
          <Button size="sm" variant={mine === 'DECLINED' ? 'primary' : 'soft'} disabled={busy} onClick={() => void rsvp('DECLINED')}>Nie</Button>
          {mine && <span className="text-[12px] text-muted">Twoja odpowiedź: {({ ACCEPTED: 'tak', TENTATIVE: 'może', DECLINED: 'nie', 'NEEDS-ACTION': 'brak' } as Record<string, string>)[mine] || mine}</span>}
        </div>
      )}
    </div>
  )
}

function MessageCard({
  m, open, onToggle, thread, allowRemote, onAllowRemote,
}: { m: MessageView; open: boolean; onToggle: () => void; thread: TV; allowRemote: boolean; onAllowRemote: (always: boolean) => void }) {
  const { compose, settings, toast } = useStore()
  const narrow = useNarrow()
  const dark = useDark()
  const [details, setDetails] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [stats, setStats] = useState({ remoteCount: 0, trackers: 0 })
  const [translation, setTranslation] = useState<string | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const translate = async (target: string) => {
    setTranslation('')
    try {
      const r = await stream<{ text: string }>('aiTranslate', [m.id, target], (d) => setTranslation((t) => (t || '') + d))
      setTranslation(r.text)
    } catch (e) {
      setTranslation(null)
      toast({ level: 'error', message: errorText(e) })
    }
  }
  const items: MenuItem[] = [
    { label: 'Odpowiedz', icon: <Reply size={14} />, onClick: () => compose({ mode: 'reply', messageId: m.id, threadId: thread.thread.thread_id }) },
    { label: 'Odpowiedz wszystkim', icon: <ReplyAll size={14} />, onClick: () => compose({ mode: 'replyall', messageId: m.id, threadId: thread.thread.thread_id }) },
    { label: 'Przekaż dalej', icon: <Forward size={14} />, onClick: () => compose({ mode: 'forward', messageId: m.id, threadId: thread.thread.thread_id }) },
    { separator: true, label: '' },
    { label: 'Przetłumacz na polski', icon: <Languages size={14} />, onClick: () => void translate('polski') },
    { label: 'Przetłumacz na angielski', icon: <Languages size={14} />, onClick: () => void translate('angielski') },
    { label: 'Oznacz jako nieprzeczytaną', icon: <Mail size={14} />, onClick: () => void api.markMessagesRead([m.id], false) },
    { label: 'Pokaż źródło', icon: <Code2 size={14} />, onClick: () => void api.messageSource(m.id).then(setSource).catch((e) => toast({ level: 'error', message: errorText(e) })) },
  ]
  const recipients = [...m.to, ...m.cc]
  return (
    <div className={cx('rounded-xl border border-line bg-surface', open ? 'shadow-sm' : '')} id={`msg-${m.id}`}>
      <div className="flex cursor-default items-start gap-3 px-4 py-3 max-md:px-3" onClick={onToggle}>
        <Avatar addr={m.from} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cx('truncate font-semibold', !m.seen && 'text-accent')}>{m.is_outgoing ? 'Ja' : displayName(m.from)}</span>
            {!m.is_outgoing && <span className="truncate text-[12px] text-faint max-md:hidden">{m.from.email}</span>}
            <span className="flex-1" />
            {m.attachments.some((a) => !a.inline) && <Paperclip size={13} className="text-faint" />}
            <span className="shrink-0 text-[12px] text-muted" title={fullDate(m.date)}>{open && !narrow ? fullDate(m.date) : listDate(m.date)}</span>
          </div>
          {open ? (
            <div className="text-[12.5px] text-muted" onClick={(e) => (e.stopPropagation(), setDetails(!details))}>
              do {recipients.slice(0, 3).map((a) => displayName(a)).join(', ')}{recipients.length > 3 ? ` +${recipients.length - 3}` : ''}
              <ChevronDown size={12} className="ml-0.5 inline" />
            </div>
          ) : (
            <div className="truncate text-[12.5px] text-muted">{m.snippet}</div>
          )}
        </div>
        {open && (
          <div className="flex items-center" onClick={(e) => e.stopPropagation()}>
            <IconButton title="Odpowiedz (R)" onClick={() => compose({ mode: 'reply', messageId: m.id, threadId: thread.thread.thread_id })}><Reply size={16} /></IconButton>
            <IconButton title="Więcej" onClick={(e) => setMenu({ x: e.clientX - 180, y: e.clientY + 10 })}><MoreHorizontal size={16} /></IconButton>
          </div>
        )}
      </div>
      {open && details && (
        <div className="selectable mx-4 mb-2 rounded-lg bg-surface-2 px-3 py-2 text-[12.5px] leading-relaxed text-muted">
          <div><b>Od:</b> {m.from.name} &lt;{m.from.email}&gt;</div>
          {m.to.length > 0 && <div><b>Do:</b> {m.to.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ')}</div>}
          {m.cc.length > 0 && <div><b>DW:</b> {m.cc.map((a) => a.email).join(', ')}</div>}
          {m.bcc.length > 0 && <div><b>UDW:</b> {m.bcc.map((a) => a.email).join(', ')}</div>}
          {m.reply_to.length > 0 && <div><b>Odpowiedz do:</b> {m.reply_to.map((a) => a.email).join(', ')}</div>}
          <div><b>Data:</b> {fullDate(m.date)}</div>
        </div>
      )}
      {open && (
        <>
          {stats.remoteCount > 0 && !allowRemote && (
            <div className="mx-4 mb-2 flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-1.5 text-[12.5px] text-muted">
              <ImageIcon size={14} /> Zdalne obrazy są zablokowane ({stats.remoteCount}).{stats.trackers > 0 && ` Usunięto ${stats.trackers} piksel(e) śledzące.`}
              <span className="flex-1" />
              <button className="text-accent hover:underline" onClick={() => onAllowRemote(false)}>Pokaż</button>
              <button className="text-accent hover:underline" onClick={() => onAllowRemote(true)}>Zawsze od nadawcy</button>
            </div>
          )}
          {m.calendar_part && <InviteCard messageId={m.id} />}
          <div className="px-2 pb-2">
            {m.body_state === 1 || m.html || m.text ? (
              <MessageFrame
                message={m}
                allowRemote={allowRemote}
                blockTrackers={settings?.blockTrackers !== false}
                dark={dark}
                onStats={setStats}
                onMailto={(addr) => compose({ mode: 'new', prefill: { to: [addr] } })}
              />
            ) : (
              <div className="flex items-center gap-2 px-3 py-4 text-muted"><Spinner /> Pobieranie treści…</div>
            )}
          </div>
          {translation !== null && (
            <div className="mx-4 mb-3 rounded-lg border border-line bg-accent-soft/40 px-3 py-2">
              <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-accent"><Languages size={13} /> Tłumaczenie {translation === '' && <Spinner className="h-3 w-3" />}
                <span className="flex-1" /><button onClick={() => setTranslation(null)}><X size={13} /></button></div>
              <div className="selectable whitespace-pre-wrap text-[13.5px]">{translation}</div>
            </div>
          )}
          <Attachments list={m.attachments} />
        </>
      )}
      <Menu items={items} anchor={menu} onClose={() => setMenu(null)} />
      <Modal open={source !== null} onClose={() => setSource(null)} title="Źródło wiadomości" width={900}>
        <pre className="selectable whitespace-pre-wrap break-all p-4 font-mono text-[11.5px]">{source}</pre>
      </Modal>
    </div>
  )
}

function QuickReplies({ threadId, messageId }: { threadId: number; messageId: number }) {
  const [list, setList] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const { compose, toast } = useStore()
  useEffect(() => setList(null), [threadId])
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="soft" onClick={() => compose({ mode: 'reply', messageId, threadId })}><Reply size={14} /> Odpowiedz</Button>
      <Button variant="soft" onClick={() => compose({ mode: 'replyall', messageId, threadId })}><ReplyAll size={14} /> Wszystkim</Button>
      <Button variant="soft" onClick={() => compose({ mode: 'forward', messageId, threadId })}><Forward size={14} /> Przekaż</Button>
      {list === null ? (
        <Button
          variant="ghost"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              setList(await api.aiQuickReplies(threadId))
            } catch (e) {
              toast({ level: 'error', message: errorText(e) })
            }
            setBusy(false)
          }}
        >
          {busy ? <Spinner /> : <Sparkles size={14} className="text-accent" />} Szybkie odpowiedzi
        </Button>
      ) : (
        list.map((q) => (
          <button key={q} className="rounded-full border border-accent/40 bg-accent-soft/50 px-3 py-1 text-[12.5px] text-accent hover:bg-accent-soft" onClick={() => compose({ mode: 'reply', messageId, threadId, prefill: { html: `<p>${q.replace(/</g, '&lt;')}</p>` } })}>
            {q}
          </button>
        ))
      )}
    </div>
  )
}

export default function ThreadView() {
  const s = useStore()
  const narrow = useNarrow()
  const { selected, act, composer, settings, toast } = s
  const [data, setData] = useState<TV | null>(null)
  const [openIds, setOpenIds] = useState<Set<number>>(new Set())
  const [allowRemote, setAllowRemote] = useState(false)
  const [more, setMore] = useState<{ x: number; y: number } | null>(null)
  const [summaryFor, setSummaryFor] = useState<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const loadedFor = useRef<number | null>(null)

  const load = useCallback(async (id: number, first: boolean) => {
    const t = await api.getThread(id)
    if (useStore.getState().selected !== id) return
    setData(t)
    if (!t) return
    if (first) {
      const msgs = t.messages
      const toOpen = new Set<number>(msgs.filter((m) => !m.seen).map((m) => m.id))
      if (msgs.length) toOpen.add(msgs[msgs.length - 1].id)
      setOpenIds(toOpen)
      const sender = t.thread.from.email
      const always = (await api.getKV(`allowImages:${sender}`, false)) as boolean
      const mode = useStore.getState().settings?.loadRemoteImages || 'contacts'
      setAllowRemote(mode === 'always' || always || (mode === 'contacts' && !t.thread.is_new_sender && t.thread.category === 'people'))
      // long conversations jump to the newest message; short ones keep the header (subject, banners) in view
      if (msgs.length > 2) setTimeout(() => scrollRef.current?.querySelector(`#msg-${[...toOpen].pop()}`)?.scrollIntoView({ block: 'start' }), 50)
      else scrollRef.current?.scrollTo({ top: 0 })
    }
    if (t.messages.some((m) => m.body_state !== 1)) {
      try {
        const full = await api.fetchThreadBodies(id)
        if (full && useStore.getState().selected === id) setData(full)
      } catch (e) {
        toast({ level: 'error', message: `Nie udało się pobrać treści: ${errorText(e)}` })
      }
    }
    if (first && useStore.getState().settings?.markReadOnOpen !== false) {
      const unread = t.messages.filter((m) => !m.seen).map((m) => m.id)
      if (unread.length) setTimeout(() => {
        if (useStore.getState().selected === id) void api.markMessagesRead(unread, true)
      }, 600)
    }
  }, [])

  useEffect(() => {
    if (!selected) {
      setData(null)
      return
    }
    const first = loadedFor.current !== selected
    loadedFor.current = selected
    if (first) setData(null)
    void load(selected, first)
  }, [selected])

  useEffect(() => {
    return window.octo.on('core-event', (e: { type: string; threadIds?: number[] }) => {
      const id = useStore.getState().selected
      if (!id) return
      if (e.type === 'mailbox-changed' || e.type === 'drafts-changed' || (e.type === 'thread-changed' && e.threadIds?.includes(id))) void load(id, false)
    })
  }, [load])

  const thread = data?.thread
  const ids = thread ? [thread.thread_id] : []
  const lastIncoming = useMemo(() => data?.messages.filter((m) => !m.is_outgoing).pop() || data?.messages[data.messages.length - 1], [data])
  const hasUnsub = data?.messages.some((m) => m.list_unsubscribe)

  if (!selected) return <Empty icon={<NoSelection />} title="Wybierz rozmowę" hint={<span>Skróty: <b>J/K</b> nawigacja · <b>E</b> zrobione · <b>R</b> odpowiedz · <b>H</b> odłóż · <b>Ctrl+K</b> polecenia</span>} />
  if (!data || !thread) return <div className="flex h-full items-center justify-center text-muted"><Spinner /></div>

  const moreItems: MenuItem[] = [
    { label: thread.set_aside ? 'Wróć do Odebranych' : 'Odłóż na bok', icon: <Coffee size={14} />, onClick: () => void act(thread.set_aside ? 'unaside' : 'aside', ids) },
    { label: thread.priority ? 'Usuń priorytet' : 'Priorytet', icon: <Star size={14} />, onClick: () => void act(thread.priority ? 'unpriority' : 'priority', ids) },
    { label: thread.muted ? 'Wyłącz wyciszenie' : 'Wycisz wątek', icon: <BellOff size={14} />, onClick: () => void act(thread.muted ? 'unmute' : 'mute', ids) },
    { label: 'Oznacz jako nieprzeczytane', icon: <Mail size={14} />, onClick: () => void act('unread', ids) },
    { label: 'Przenieś do Odebranych', icon: <Inbox size={14} />, onClick: () => void act('moveToInbox', ids) },
    { label: 'Spam', icon: <TriangleAlert size={14} />, onClick: () => void act('spam', ids) },
    { separator: true, label: '' },
    { label: `Blokuj ${thread.from.email}`, icon: <ShieldX size={14} />, danger: true, onClick: () => void s.senders('block', [thread.from.email]) },
  ]

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-bg">
      <div className="flex h-12 shrink-0 items-center gap-0.5 border-b border-line bg-surface px-3 max-md:px-1">
        {narrow && <IconButton title="Wróć do listy" onClick={goBack}><ArrowLeft size={18} /></IconButton>}
        <IconButton title="Zrobione (E)" onClick={() => void act('archive', ids)}><Check size={17} /></IconButton>
        <IconButton title={thread.pinned ? 'Odepnij (S)' : 'Przypnij (S)'} active={thread.pinned} onClick={() => void act(thread.pinned ? 'unpin' : 'pin', ids)}>{thread.pinned ? <PinOff size={16} /> : <Pin size={16} />}</IconButton>
        <IconButton title="Odłóż (H)" active={!!thread.snoozed_until} onClick={() => useStore.setState({ snoozeFor: ids, pickerMode: 'snooze' })}><Clock size={16} /></IconButton>
        <IconButton title="Przypomnij" active={!!thread.reminder_at} onClick={() => useStore.setState({ snoozeFor: ids, pickerMode: 'remind' })}><AlarmClock size={16} /></IconButton>
        <IconButton title="Przenieś (V)" onClick={() => useStore.setState({ moveFor: ids })}><FolderInput size={16} /></IconButton>
        <IconButton title="Do kosza (#)" onClick={() => void act('trash', ids)}><Trash2 size={16} /></IconButton>
        <IconButton title="Więcej" onClick={(e) => setMore({ x: e.clientX, y: e.clientY + 12 })}><MoreHorizontal size={16} /></IconButton>
        <span className="flex-1" />
        {thread.snoozed_until && <span className="mr-2 flex max-md:hidden items-center gap-1 text-[12px] text-muted"><Clock size={13} /> {formatWhen(thread.snoozed_until)} <button title="Anuluj odłożenie" onClick={() => void act('unsnooze', ids)}><Undo2 size={13} /></button></span>}
        {thread.reminder_at && <span className="mr-2 flex max-md:hidden items-center gap-1 text-[12px] text-muted"><AlarmClock size={13} /> {formatWhen(thread.reminder_at)} <button title="Usuń przypomnienie" onClick={() => void act('unremind', ids)}><X size={13} /></button></span>}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-5 max-md:px-2.5 max-md:py-3">
        <div className="mx-auto max-w-[920px]">
          <div className="mb-3 flex items-start gap-3">
            <h1 className="selectable flex-1 text-[19px] font-semibold leading-snug">{thread.subject}</h1>
            {summaryFor !== thread.thread_id && (
              <Button size="sm" variant="soft" onClick={() => setSummaryFor(thread.thread_id)}>
                <Sparkles size={13} className="text-accent" /> Podsumuj
              </Button>
            )}
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[12px]">
            <span className="rounded-md px-1.5 py-0.5 text-white" style={{ background: `var(--${thread.category || 'people'})` }}>
              {({ people: 'Ludzie', notification: 'Powiadomienia', newsletter: 'Newslettery' } as Record<string, string>)[thread.category || 'people']}
            </span>
            <span className="text-muted">{thread.account_email}</span>
            {thread.labels.map((l) => <span key={l} className="rounded-md border border-line px-1.5 py-0.5 text-muted">{l}</span>)}
          </div>
          {summaryFor === thread.thread_id && <AutoSummary threadId={thread.thread_id} onClose={() => setSummaryFor(null)} />}

          {thread.is_new_sender && (
            <div className="mb-3 flex items-center gap-3 rounded-xl border border-warning/40 bg-warning/10 px-4 py-2.5">
              <ShieldCheck size={18} className="text-warning" />
              <div className="flex-1 text-[13px]"><b>{thread.from.email}</b> pisze do Ciebie pierwszy raz.</div>
              <Button size="sm" variant="primary" onClick={() => void s.senders('accept', [thread.from.email])}>Akceptuj</Button>
              <Button size="sm" variant="soft" onClick={() => void s.senders('accept', ['@' + thread.from.email.split('@')[1]])}>Akceptuj domenę</Button>
              <Button size="sm" variant="danger" onClick={() => void s.senders('block', [thread.from.email])}>Blokuj</Button>
            </div>
          )}
          {hasUnsub && thread.category !== 'people' && (
            <div className="mb-3 flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-2">
              <Archive size={16} className="text-muted" />
              <div className="flex-1 text-[13px] text-muted">To wiadomość z listy mailingowej.</div>
              <Button size="sm" variant="soft" onClick={() => void act('unsubscribe', ids)}>Wypisz się</Button>
            </div>
          )}

          <div className="flex flex-col gap-2.5">
            {data.messages.map((m) => (
              <MessageCard
                key={m.id}
                m={m}
                thread={data}
                open={openIds.has(m.id)}
                allowRemote={allowRemote}
                onAllowRemote={(always) => {
                  setAllowRemote(true)
                  if (always) void api.setKV(`allowImages:${m.from.email}`, true)
                }}
                onToggle={() => {
                  const n = new Set(openIds)
                  if (n.has(m.id)) n.delete(m.id)
                  else n.add(m.id)
                  setOpenIds(n)
                }}
              />
            ))}
            {data.drafts
              .filter((d) => !(composer?.draftId === d.id))
              .map((d) => (
                <div key={d.id} className="flex items-center gap-3 rounded-xl border border-dashed border-danger/40 bg-surface px-4 py-3">
                  <Eye size={16} className="text-danger" />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium text-danger">{d.status === 'scheduled' ? `Zaplanowana wysyłka: ${d.send_at ? formatWhen(d.send_at) : ''}` : d.status === 'failed' ? `Błąd wysyłki: ${d.error}` : 'Wersja robocza'}</div>
                    <div className="truncate text-[13px] text-muted">{(d.text || d.html.replace(/<[^>]+>/g, ' ')).slice(0, 160)}</div>
                  </div>
                  {d.status === 'scheduled' && <Button size="sm" onClick={() => void api.cancelSend(d.id).catch((e) => toast({ level: 'error', message: errorText(e) }))}>Anuluj wysyłkę</Button>}
                  <Button size="sm" onClick={() => s.compose({ mode: 'edit', draftId: d.id, threadId: thread.thread_id, inline: true })}>Edytuj</Button>
                  <IconButton title="Usuń" onClick={() => void api.deleteDraft(d.id)}><Trash2 size={15} /></IconButton>
                </div>
              ))}
          </div>

          <div className="mt-4 pb-10">
            {composer?.inline && composer.threadId === thread.thread_id ? (
              <Composer key={composer.key} request={composer} />
            ) : (
              lastIncoming && <QuickReplies threadId={thread.thread_id} messageId={lastIncoming.id} />
            )}
          </div>
        </div>
      </div>
      <Menu items={moreItems} anchor={more} onClose={() => setMore(null)} />
    </div>
  )
}

function AutoSummary({ threadId, onClose }: { threadId: number; onClose: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(true)
  const toast = useStore((s) => s.toast)
  const run = useCallback(async (force: boolean) => {
    setBusy(true)
    setText('')
    try {
      const r = await stream<{ text: string }>('aiSummarize', [threadId, force], (d) => setText((t) => t + d))
      setText(r.text)
    } catch (e) {
      toast({ level: 'error', message: errorText(e) })
      onClose()
    }
    setBusy(false)
  }, [threadId])
  useEffect(() => {
    void run(false)
  }, [threadId])
  return (
    <div className="anim-in mb-3 rounded-xl border border-accent/30 bg-accent-soft/50 px-4 py-3">
      <div className="mb-1 flex items-center gap-1.5 text-[12.5px] font-semibold text-accent">
        <Sparkles size={14} /> Podsumowanie {busy && <Spinner className="h-3.5 w-3.5" />}
        <span className="flex-1" />
        {!busy && <button className="font-normal hover:underline" onClick={() => void run(true)}>Odśwież</button>}
        <button onClick={onClose}><X size={14} /></button>
      </div>
      <div className="ai-text selectable text-[13.5px] leading-relaxed" dangerouslySetInnerHTML={{ __html: mdToHtml(text || '…') }} />
    </div>
  )
}

