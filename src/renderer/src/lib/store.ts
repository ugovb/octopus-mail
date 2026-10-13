import { create } from 'zustand'
import type {
  Account, AppSettings, Category, CoreEvent, Folder, MailboxRef, SmartFolder, SyncStatus, ThreadSummary,
} from '../../../shared/types'
import { t } from '../../../shared/i18n'
import { api, errorText } from './api'
import { syncLanguage } from './lang'
import { isNarrow } from './narrow'

export type View = 'mail' | 'calendar' | 'contacts' | 'settings' | 'ask'

export interface Toast {
  id: number
  level: 'info' | 'error' | 'success'
  message: string
  undo?: string
  action?: { label: string; run: () => void }
  ttl: number
}

export interface ComposerRequest {
  key: number
  mode: 'new' | 'reply' | 'replyall' | 'forward' | 'edit'
  messageId?: number
  draftId?: number
  threadId?: number
  inline: boolean
  prefill?: { to?: string[]; subject?: string; html?: string }
}

export type Counts = Awaited<ReturnType<typeof api.counts>>

export type ThreadAction =
  | 'archive' | 'trash' | 'deleteForever' | 'spam' | 'notSpam' | 'moveToInbox' | 'read' | 'unread' | 'pin' | 'unpin'
  | 'mute' | 'unmute' | 'aside' | 'unaside' | 'priority' | 'unpriority' | 'unsnooze' | 'unremind' | 'unsubscribe'

interface State {
  ready: boolean
  view: View
  accounts: Account[]
  folders: Folder[]
  settings: AppSettings | null
  counts: Counts | null
  smartFolders: SmartFolder[]
  sync: Record<number, SyncStatus>
  mailbox: MailboxRef
  accountFilter: number | null
  threads: ThreadSummary[]
  loading: boolean
  hasMore: boolean
  selected: number | null
  checked: number[]
  searchQuery: string
  toasts: Toast[]
  composer: ComposerRequest | null
  palette: boolean
  snoozeFor: number[] | null
  pickerMode: 'snooze' | 'remind'
  moveFor: number[] | null
  aiPanel: boolean
  /** phone layout: the sidebar is open as a drawer */
  drawer: boolean
  /** where passwords are kept on this OS, e.g. "w Menedżerze poświadczeń Windows" */
  secretStore: string
  /** null = this computer runs the engine; otherwise the home-server connection state */
  server: { url: string; online: boolean } | null

  boot(): Promise<void>
  setView(v: View): void
  setMailbox(m: MailboxRef, accountFilter?: number | null): void
  refreshMeta(): Promise<void>
  refreshList(keep?: boolean): Promise<void>
  loadMore(): Promise<void>
  select(id: number | null): void
  toggleCheck(id: number, range?: boolean): void
  clearChecks(): void
  targets(explicit?: number[]): number[]
  act(action: ThreadAction, ids?: number[]): Promise<void>
  snooze(ids: number[], until: number | null): Promise<void>
  remind(ids: number[], at: number | null, kind?: 'manual' | 'no-reply'): Promise<void>
  move(ids: number[], folderId: number): Promise<void>
  senders(action: 'accept' | 'block' | 'vip' | 'unvip', emails: string[]): Promise<void>
  categorize(emails: string[], c: Category): Promise<void>
  undo(token: string): Promise<void>
  toast(t: Omit<Toast, 'id' | 'ttl'> & { ttl?: number }): void
  dismiss(id: number): void
  compose(r: Omit<ComposerRequest, 'key' | 'inline'> & { inline?: boolean }): void
  closeComposer(): void
  setComposerDraft(id: number): void
  setSearch(q: string): void
  updateSettings(p: Partial<AppSettings>): Promise<void>
}

let toastSeq = 0
let refreshTimer: ReturnType<typeof setTimeout> | null = null
const PAGE = 120

export const useStore = create<State>((set, get) => ({
  ready: false,
  view: 'mail',
  accounts: [],
  folders: [],
  settings: null,
  counts: null,
  smartFolders: [],
  sync: {},
  mailbox: { kind: 'smart' },
  accountFilter: null,
  threads: [],
  loading: false,
  hasMore: false,
  selected: null,
  checked: [],
  searchQuery: '',
  toasts: [],
  composer: null,
  palette: false,
  snoozeFor: null,
  pickerMode: 'snooze',
  moveFor: null,
  aiPanel: false,
  drawer: false,
  secretStore: t('in the system password store'),
  server: null,

  async boot() {
    const [settings, accounts, platform] = await Promise.all([api.getSettings(), api.listAccounts(), api.platform()])
    // the language is applied before the UI loads: reload if the saved choice was out of date
    if (syncLanguage(settings.language)) return location.reload()
    set({ settings, accounts, secretStore: platform.secretStore })
    const st = await window.octo.serverStatus().catch(() => null)
    if (st?.mode === 'remote') set({ server: { url: st.url, online: st.online } })
    applyTheme(settings)
    await get().refreshMeta()
    await get().refreshList()
    const statuses = await api.syncStatus()
    set({ sync: Object.fromEntries(statuses.map((s) => [s.account_id, s])), ready: true })

    window.octo.on('core-event', (ev: CoreEvent) => {
      switch (ev.type) {
        case 'mailbox-changed':
        case 'thread-changed':
        case 'drafts-changed':
          if (refreshTimer) clearTimeout(refreshTimer)
          refreshTimer = setTimeout(() => {
            void get().refreshList(true)
            void get().refreshMeta()
          }, 150)
          break
        case 'sync-status':
          set((s) => ({ sync: { ...s.sync, [ev.status.account_id]: ev.status } }))
          break
        case 'settings-changed':
          void api.getSettings().then((st) => {
            set({ settings: st })
            applyTheme(st)
          })
          break
        case 'toast':
          get().toast({
            level: ev.level,
            message: ev.message,
            action: ev.action?.command === 'openExternal' ? { label: ev.action.label, run: () => void window.octo.openExternal(String(ev.action!.args)) } : undefined,
          })
          break
        case 'contacts-changed':
          void get().refreshList(true)
          break
        case 'server-connection':
          set({ server: { url: ev.url, online: ev.online } })
          if (ev.online) {
            void get().refreshMeta()
            void get().refreshList(true)
          }
          break
      }
    })
    window.octo.on('badge-request', (n: number) => void drawBadge(n))
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(get().settings))
  },

  setView(v) {
    set({ view: v })
  },

  setMailbox(m, accountFilter = null) {
    set({ mailbox: m, accountFilter, selected: null, checked: [], threads: [], hasMore: false, view: 'mail', searchQuery: m.kind === 'search' ? m.query : '' })
    if (m.kind === 'folder') void api.syncFolder(m.folderId).catch(() => undefined)
    void get().refreshList()
  },

  async refreshMeta() {
    const [counts, folders, smartFolders, accounts] = await Promise.all([api.counts(), api.listFolders(), api.listSmartFolders(), api.listAccounts()])
    set({ counts, folders, smartFolders, accounts })
  },

  async refreshList(keep = false) {
    const { mailbox, accountFilter, threads } = get()
    if (mailbox.kind === 'scheduled' || mailbox.kind === 'local-drafts') {
      set({ threads: [], loading: false, hasMore: false })
      return
    }
    if (!keep) set({ loading: true })
    try {
      const limit = keep ? Math.max(PAGE, threads.length) : PAGE
      const list = await api.listThreads(mailbox, { accountId: accountFilter, limit })
      // ignore stale responses if the mailbox changed meanwhile
      if (get().mailbox !== mailbox) return
      set({ threads: list, hasMore: list.length >= limit, loading: false })
    } catch (e) {
      set({ loading: false })
      get().toast({ level: 'error', message: errorText(e) })
    }
  },

  async loadMore() {
    const { mailbox, accountFilter, threads, loading, hasMore } = get()
    if (loading) return
    if (!hasMore) {
      // reached the end of what is stored locally: fetch older mail from the server
      if (mailbox.kind === 'folder') {
        set({ loading: true })
        const n = await api.loadOlder(mailbox.folderId).catch(() => 0)
        set({ loading: false })
        if (n) await get().refreshList(true)
      }
      return
    }
    set({ loading: true })
    const more = await api.listThreads(mailbox, { accountId: accountFilter, limit: PAGE, offset: threads.length })
    set((s) => ({ threads: [...s.threads, ...more.filter((m) => !s.threads.some((t) => t.thread_id === m.thread_id))], hasMore: more.length >= PAGE, loading: false }))
  },

  select(id) {
    set({ selected: id })
  },

  toggleCheck(id, range) {
    const { checked, threads } = get()
    if (range && checked.length) {
      const last = checked[checked.length - 1]
      const a = threads.findIndex((t) => t.thread_id === last)
      const b = threads.findIndex((t) => t.thread_id === id)
      const [from, to] = a < b ? [a, b] : [b, a]
      const ids = threads.slice(from, to + 1).map((t) => t.thread_id)
      set({ checked: [...new Set([...checked, ...ids])] })
      return
    }
    set({ checked: checked.includes(id) ? checked.filter((x) => x !== id) : [...checked, id] })
  },

  clearChecks() {
    set({ checked: [] })
  },

  targets(explicit) {
    if (explicit?.length) return explicit
    const { checked, selected } = get()
    if (checked.length) return checked
    return selected ? [selected] : []
  },

  async act(action, ids) {
    const targets = get().targets(ids)
    if (!targets.length) return
    const removing = ['archive', 'trash', 'deleteForever', 'spam', 'notSpam', 'aside', 'unsubscribe'].includes(action) ||
      (action === 'moveToInbox' && get().mailbox.kind !== 'smart')
    if (removing) removeFromList(targets)
    try {
      const call: Record<ThreadAction, () => Promise<{ undo?: string; message?: string }>> = {
        archive: () => api.archive(targets),
        trash: () => api.trash(targets),
        deleteForever: () => api.deleteForever(targets),
        spam: () => api.spam(targets),
        notSpam: () => api.notSpam(targets),
        moveToInbox: () => api.moveToInbox(targets),
        read: () => api.markRead(targets, true),
        unread: () => api.markRead(targets, false),
        pin: () => api.pin(targets, true),
        unpin: () => api.pin(targets, false),
        mute: () => api.mute(targets, true),
        unmute: () => api.mute(targets, false),
        aside: () => api.setAside(targets, true),
        unaside: () => api.setAside(targets, false),
        priority: () => api.priority(targets, true),
        unpriority: () => api.priority(targets, false),
        unsnooze: () => api.snooze(targets, null),
        unremind: () => api.remind(targets, null),
        unsubscribe: () => api.unsubscribe(targets),
      }
      const r = await call[action]()
      if (action !== 'read') get().toast({ level: 'info', message: r.message || t('All done'), undo: r.undo })
      await get().refreshList(true)
      void get().refreshMeta()
    } catch (e) {
      get().toast({ level: 'error', message: errorText(e) })
      await get().refreshList(true)
    }
  },

  async snooze(ids, until) {
    removeFromList(ids)
    try {
      const r = await api.snooze(ids, until)
      get().toast({ level: 'info', message: r.message || t('Snooze set'), undo: r.undo })
    } catch (e) {
      get().toast({ level: 'error', message: errorText(e) })
    }
    await get().refreshList(true)
    void get().refreshMeta()
  },

  async remind(ids, at, kind = 'manual') {
    try {
      const r = await api.remind(ids, at, kind)
      get().toast({ level: 'info', message: r.message || t('Reminder set'), undo: r.undo })
    } catch (e) {
      get().toast({ level: 'error', message: errorText(e) })
    }
    await get().refreshList(true)
  },

  async move(ids, folderId) {
    removeFromList(ids)
    try {
      const r = await api.moveToFolder(ids, folderId)
      get().toast({ level: 'info', message: r.message || t('Moved'), undo: r.undo })
    } catch (e) {
      get().toast({ level: 'error', message: errorText(e) })
    }
    await get().refreshList(true)
  },

  async senders(action, emails) {
    try {
      const r = action === 'accept' ? await api.acceptSenders(emails) : action === 'block' ? await api.blockSenders(emails) : await api.prioritySender(emails, action === 'vip')
      get().toast({ level: 'info', message: r.message || t('All done'), undo: r.undo })
    } catch (e) {
      get().toast({ level: 'error', message: errorText(e) })
    }
    await get().refreshList(true)
    void get().refreshMeta()
  },

  async categorize(emails, c) {
    try {
      const r = await api.changeSenderCategory(emails, c)
      get().toast({ level: 'info', message: r.message || t('Category changed'), undo: r.undo })
    } catch (e) {
      get().toast({ level: 'error', message: errorText(e) })
    }
    await get().refreshList(true)
  },

  async undo(token) {
    const ok = await api.undo(token)
    get().toast({ level: ok ? 'success' : 'error', message: ok ? t('Undone') : t('This can no longer be undone') })
    await get().refreshList(true)
    void get().refreshMeta()
  },

  toast(t) {
    const id = ++toastSeq
    const ttl = t.ttl ?? (t.undo ? 7000 : t.level === 'error' ? 8000 : 3500)
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id, ttl }] }))
    setTimeout(() => get().dismiss(id), ttl)
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  compose(r) {
    const inline = r.inline ?? (r.mode === 'reply' || r.mode === 'replyall' || r.mode === 'forward')
    set({ composer: { ...r, inline, key: Date.now() } })
  },

  closeComposer() {
    set({ composer: null })
  },

  setComposerDraft(id) {
    set((s) => (s.composer && s.composer.draftId !== id ? { composer: { ...s.composer, draftId: id } } : {}))
  },

  setSearch(q) {
    set({ searchQuery: q })
  },

  async updateSettings(p) {
    const s = await api.updateSettings(p)
    if (p.language && syncLanguage(s.language)) return location.reload()
    set({ settings: s })
    applyTheme(s)
  },
}))

/** Phone layout "back": pops the history entry pushed when a conversation was opened. */
export function goBack(): void {
  if (history.state?.octo === 'pane') history.back()
  else useStore.getState().select(null)
}

function removeFromList(ids: number[]) {
  useStore.setState((s) => {
    const idx = s.threads.findIndex((t) => ids.includes(t.thread_id))
    const remaining = s.threads.filter((t) => !ids.includes(t.thread_id))
    let selected = s.selected
    if (selected && ids.includes(selected)) {
      // Spark-style: after Done/delete open the next conversation (on a phone: back to the list)
      selected = isNarrow() ? null : (remaining[Math.min(idx, remaining.length - 1)]?.thread_id ?? null)
    }
    return { threads: remaining, checked: s.checked.filter((c) => !ids.includes(c)), selected }
  })
}

export function applyTheme(s: AppSettings | null) {
  const pref = s?.theme || 'system'
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.density = s?.density || 'comfortable'
}

async function drawBadge(n: number) {
  if (!n) {
    await window.octo.setBadge(null, 0)
    return
  }
  const c = document.createElement('canvas')
  c.width = c.height = 32
  const g = c.getContext('2d')!
  g.fillStyle = '#e5484d'
  g.beginPath()
  g.arc(16, 16, 15, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = '#fff'
  g.font = `bold ${n > 99 ? 13 : 17}px Segoe UI`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(n > 99 ? '99+' : String(n), 16, 17)
  await window.octo.setBadge(c.toDataURL('image/png'), n)
}
