import {
  Bell, Bot, CalendarDays, ChevronLeft, Server, Smartphone, Unplug, Copy, Inbox, Keyboard, Mail, Palette, PenLine, Plus, RefreshCw, Sparkles, Trash2, Wand2, Workflow, X, Info, FileText,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import type { Account, AgentAccess, AppSettings, Rule, RuleAction, RuleCondition, Signature, Template } from '../../../shared/types'
import { api, errorText } from '../lib/api'
import { copyText, fullDate } from '../lib/format'
import { useNarrow } from '../lib/narrow'
import { useStore } from '../lib/store'
import AccountWizard from './AccountWizard'
import { Button, cx, Field, IconButton, inputCls, Modal, Select, Spinner, Toggle } from '../components/ui'

type Tab = 'accounts' | 'server' | 'general' | 'inbox' | 'notifications' | 'signatures' | 'templates' | 'rules' | 'ai' | 'agents' | 'calendars' | 'shortcuts' | 'about'

const TABS: { id: Tab; label: string; icon: ReactNode }[] = [
  { id: 'accounts', label: 'Konta', icon: <Mail size={15} /> },
  { id: 'general', label: 'Wygląd i ogólne', icon: <Palette size={15} /> },
  { id: 'inbox', label: 'Skrzynka i GateKeeper', icon: <Inbox size={15} /> },
  { id: 'notifications', label: 'Powiadomienia', icon: <Bell size={15} /> },
  { id: 'signatures', label: 'Podpisy', icon: <PenLine size={15} /> },
  { id: 'templates', label: 'Szablony', icon: <FileText size={15} /> },
  { id: 'rules', label: 'Reguły', icon: <Workflow size={15} /> },
  { id: 'ai', label: 'AI', icon: <Sparkles size={15} /> },
  { id: 'agents', label: 'Agenci AI i CLI', icon: <Bot size={15} /> },
  { id: 'calendars', label: 'Kalendarze', icon: <CalendarDays size={15} /> },
  { id: 'server', label: 'Serwer domowy', icon: <Server size={15} /> },
  { id: 'shortcuts', label: 'Skróty klawiszowe', icon: <Keyboard size={15} /> },
  { id: 'about', label: 'Informacje', icon: <Info size={15} /> },
]

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-6">
      <div className="mb-1 text-[14px] font-semibold">{title}</div>
      {hint && <div className="mb-2 text-[12.5px] text-muted">{hint}</div>}
      <div className="rounded-xl border border-line bg-surface px-4 py-2">{children}</div>
    </div>
  )
}

function useSettings(): [AppSettings, (p: Partial<AppSettings>) => void] {
  const { settings, updateSettings } = useStore()
  return [settings!, (p) => void updateSettings(p)]
}

const ACCESS: { value: AgentAccess; label: string }[] = [
  { value: 'none', label: 'Brak dostępu' },
  { value: 'read', label: 'Odczyt' },
  { value: 'triage', label: 'Porządkowanie (drafty, akcje)' },
  { value: 'send', label: 'Wysyłka (+ kalendarz)' },
]

function AccountsTab() {
  const { accounts, sync, refreshMeta, toast } = useStore()
  const [adding, setAdding] = useState(false)
  const [edit, setEdit] = useState<Account | null>(null)
  const [signatures, setSignatures] = useState<Signature[]>([])
  const [identities, setIdentities] = useState<{ id: number; account_id: number; email: string; name: string; signature_id: number | null; is_default: number }[]>([])
  const load = async () => {
    setSignatures(await api.listSignatures())
    setIdentities((await api.listIdentities()) as typeof identities)
  }
  useEffect(() => void load(), [accounts])
  return (
    <>
      <Section title="Konta pocztowe" hint={`Hasła są przechowywane ${useStore.getState().secretStore}, nie w bazie programu.`}>
        {accounts.map((a) => {
          const st = sync[a.id]
          const ids = identities.filter((i) => i.account_id === a.id)
          return (
            <div key={a.id} className="flex items-center gap-3 border-b border-line py-3 last:border-0">
              <span className="h-3 w-3 rounded-full" style={{ background: a.color || 'var(--accent)' }} />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{a.name} <span className="font-normal text-muted">&lt;{a.email}&gt;</span></div>
                <div className="text-[12px] text-muted">
                  {a.imap_host} · {a.auth === 'password' ? 'hasło' : 'OAuth'} · {st?.state === 'error' ? <span className="text-danger">{st.error}</span> : a.last_sync ? `synchronizacja ${fullDate(a.last_sync)}` : 'jeszcze nie zsynchronizowano'}
                </div>
                {ids.length > 1 && <div className="text-[12px] text-faint">Aliasy: {ids.filter((i) => !i.is_default).map((i) => i.email).join(', ')}</div>}
              </div>
              <select
                className="h-8 rounded-lg border border-line bg-surface px-2 text-[12.5px]"
                value={ids.find((i) => i.is_default)?.signature_id ?? ''}
                onChange={async (e) => (await api.setDefaultSignature(a.id, e.target.value ? Number(e.target.value) : null), void load())}
                title="Podpis"
              >
                <option value="">Bez podpisu</option>
                {signatures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <Button size="sm" onClick={() => setEdit(a)}>Edytuj</Button>
            </div>
          )
        })}
        <div className="py-2">
          <Button variant="ghost" size="sm" onClick={() => setAdding(true)}><Plus size={14} /> Dodaj konto</Button>
        </div>
      </Section>
      <Section title="Logowanie OAuth (opcjonalne)" hint="Własne identyfikatory aplikacji Google/Microsoft do logowania bez hasła i dostępu do kalendarza Google.">
        <OAuthClients />
      </Section>
      <Modal open={adding} onClose={() => setAdding(false)} title="Dodaj konto" width={620}>
        <AccountWizard onDone={() => setAdding(false)} />
      </Modal>
      {edit && <EditAccount account={edit} onClose={() => (setEdit(null), void refreshMeta(), void load())} onError={(m) => toast({ level: 'error', message: m })} />}
    </>
  )
}

function OAuthClients() {
  const [g, setG] = useState({ clientId: '', clientSecret: '' })
  const [m, setM] = useState({ clientId: '' })
  const toast = useStore((s) => s.toast)
  useEffect(() => {
    void api.getKV('oauth.google', null).then((raw) => {
      const v = raw as { clientId?: string; clientSecret?: string } | null
      setG({ clientId: v?.clientId || '', clientSecret: v?.clientSecret || '' })
    })
    void api.getKV('oauth.microsoft', null).then((raw) => setM({ clientId: (raw as { clientId?: string } | null)?.clientId || '' }))
  }, [])
  return (
    <div className="grid grid-cols-2 max-md:grid-cols-1 gap-x-4 py-1">
      <Field label="Google Client ID"><input className={inputCls} value={g.clientId} onChange={(e) => setG({ ...g, clientId: e.target.value })} /></Field>
      <Field label="Google Client secret"><input className={inputCls} type="password" value={g.clientSecret} onChange={(e) => setG({ ...g, clientSecret: e.target.value })} /></Field>
      <Field label="Microsoft Application (client) ID"><input className={inputCls} value={m.clientId} onChange={(e) => setM({ clientId: e.target.value })} /></Field>
      <div className="flex items-end pb-1.5">
        <Button size="sm" onClick={async () => {
          await api.setKV('oauth.google', g.clientId ? g : null)
          await api.setKV('oauth.microsoft', m.clientId ? m : null)
          toast({ level: 'success', message: 'Zapisano' })
        }}>Zapisz</Button>
      </div>
    </div>
  )
}

function EditAccount({ account, onClose, onError }: { account: Account; onClose: () => void; onError: (m: string) => void }) {
  const [a, setA] = useState(account)
  const [password, setPassword] = useState('')
  const [alias, setAlias] = useState('')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      const patch: Record<string, unknown> = {
        name: a.name, color: a.color, sync_days: a.sync_days, notify: a.notify, enabled: a.enabled,
        imap_host: a.imap_host, imap_port: a.imap_port, imap_secure: a.imap_secure, smtp_host: a.smtp_host, smtp_port: a.smtp_port, smtp_secure: a.smtp_secure, username: a.username,
      }
      if (password) patch.password = password
      await api.updateAccount(a.id, patch)
      if (alias.trim()) await api.addIdentity(a.id, alias.trim(), a.name)
      onClose()
    } catch (e) {
      onError(errorText(e))
    }
    setBusy(false)
  }
  return (
    <Modal open onClose={onClose} title={`Konto ${account.email}`} width={600} footer={
      <>
        <Button variant="danger" className="mr-auto" onClick={async () => {
          if (!window.confirm(`Usunąć konto ${account.email} z Octopus Mail? Poczta na serwerze zostaje nietknięta.`)) return
          await api.removeAccount(account.id)
          onClose()
        }}><Trash2 size={14} /> Usuń konto</Button>
        <Button variant="ghost" onClick={onClose}>Anuluj</Button>
        <Button variant="primary" disabled={busy} onClick={() => void save()}>{busy && <Spinner />} Zapisz</Button>
      </>
    }>
      <div className="grid grid-cols-2 max-md:grid-cols-1 gap-x-4 p-5">
        <Field label="Nazwa nadawcy"><input className={inputCls} value={a.name} onChange={(e) => setA({ ...a, name: e.target.value })} /></Field>
        <Field label="Kolor"><input type="color" className="h-9 w-20 rounded-lg border border-line bg-surface" value={a.color || '#5b4cf0'} onChange={(e) => setA({ ...a, color: e.target.value })} /></Field>
        <Field label="Nowe hasło (puste = bez zmian)"><input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Field label="Synchronizuj wstecz (dni)"><input className={inputCls} value={a.sync_days} onChange={(e) => setA({ ...a, sync_days: Number(e.target.value) || 90 })} /></Field>
        <Field label="Powiadomienia">
          <Select value={a.notify} onChange={(v) => setA({ ...a, notify: v })} options={[{ value: 'smart', label: 'Inteligentne (ludzie i priorytety)' }, { value: 'all', label: 'Wszystkie' }, { value: 'none', label: 'Wyłączone' }]} />
        </Field>
        <Field label="Dodaj alias (adres nadawcy)"><input className={inputCls} placeholder="np. biuro@twojafirma.pl" value={alias} onChange={(e) => setAlias(e.target.value)} /></Field>
        <div className="col-span-2"><Toggle checked={a.enabled} onChange={(v) => setA({ ...a, enabled: v })} label="Konto włączone" hint="Wyłączone konto nie jest synchronizowane." /></div>
        <div className="col-span-2 mt-2 text-[12.5px] font-semibold text-muted">Serwery</div>
        <Field label="IMAP"><input className={inputCls} value={a.imap_host} onChange={(e) => setA({ ...a, imap_host: e.target.value })} /></Field>
        <Field label="Port IMAP"><input className={inputCls} value={a.imap_port} onChange={(e) => setA({ ...a, imap_port: Number(e.target.value) })} /></Field>
        <Field label="SMTP"><input className={inputCls} value={a.smtp_host} onChange={(e) => setA({ ...a, smtp_host: e.target.value })} /></Field>
        <Field label="Port SMTP"><input className={inputCls} value={a.smtp_port} onChange={(e) => setA({ ...a, smtp_port: Number(e.target.value) })} /></Field>
        <Field label="Login"><input className={inputCls} value={a.username} onChange={(e) => setA({ ...a, username: e.target.value })} /></Field>
        <div className="flex flex-col justify-end">
          <Toggle checked={a.imap_secure} onChange={(v) => setA({ ...a, imap_secure: v })} label="IMAP SSL" />
          <Toggle checked={a.smtp_secure} onChange={(v) => setA({ ...a, smtp_secure: v })} label="SMTP SSL (465)" />
        </div>
      </div>
    </Modal>
  )
}

function GeneralTab() {
  const [s, set] = useSettings()
  const { accounts } = useStore()
  return (
    <>
      <Section title="Wygląd">
        <Field label="Motyw"><Select value={s.theme} onChange={(v) => set({ theme: v })} options={[{ value: 'system', label: 'Jak w systemie' }, { value: 'light', label: 'Jasny' }, { value: 'dark', label: 'Ciemny' }]} /></Field>
        <Field label="Gęstość listy"><Select value={s.density} onChange={(v) => set({ density: v })} options={[{ value: 'comfortable', label: 'Wygodna (z podglądem)' }, { value: 'compact', label: 'Kompaktowa' }]} /></Field>
      </Section>
      <Section title="Uruchamianie">
        <Toggle checked={s.launchAtLogin} onChange={(v) => (set({ launchAtLogin: v }), void window.octo.setLoginItem(v))} label="Uruchamiaj przy starcie Windows" hint="Wtedy odłożone wiadomości, przypomnienia i wysyłki zaplanowane działają bez otwierania okna." />
        <Toggle checked={s.minimizeToTray} onChange={(v) => set({ minimizeToTray: v })} label="Zamknięcie okna chowa program do zasobnika" />
      </Section>
      <Section title="Wysyłanie">
        <Field label="Domyślne konto nadawcy">
          <Select value={String(s.defaultAccountId ?? '')} onChange={(v) => set({ defaultAccountId: v ? Number(v) : null })} options={[{ value: '', label: 'Ostatnio używane' }, ...accounts.map((a) => ({ value: String(a.id), label: a.email }))]} />
        </Field>
        <Field label={`Czas na cofnięcie wysłania: ${s.undoSendSeconds} s`}>
          <input type="range" min={0} max={30} value={s.undoSendSeconds} onChange={(e) => set({ undoSendSeconds: Number(e.target.value) })} />
        </Field>
      </Section>
    </>
  )
}

function InboxTab() {
  const [s, set] = useSettings()
  return (
    <>
      <Section title="Smart Inbox" hint="Automatyczny podział na Ludzi, Powiadomienia i Newslettery (na podstawie nagłówków, kategorii Gmaila i Twoich decyzji).">
        <Toggle checked={s.smartInbox} onChange={(v) => set({ smartInbox: v })} label="Włącz Smart Inbox" />
        <Toggle checked={s.groupNotifications} onChange={(v) => set({ groupNotifications: v })} label="Grupuj powiadomienia w jedną kartę" />
        <Toggle checked={s.groupNewsletters} onChange={(v) => set({ groupNewsletters: v })} label="Grupuj newslettery w jedną kartę" />
        <Toggle checked={s.markReadOnOpen} onChange={(v) => set({ markReadOnOpen: v })} label="Oznaczaj jako przeczytane po otwarciu" />
      </Section>
      <Section title="GateKeeper" hint="Nowi nadawcy (którzy nigdy od Ciebie nie dostali maila) czekają w osobnej sekcji, aż ich zaakceptujesz lub zablokujesz.">
        <Toggle checked={s.gatekeeper === 'on'} onChange={(v) => set({ gatekeeper: v ? 'on' : 'off' })} label="Sprawdzaj nowych nadawców przed Odebranymi" />
      </Section>
      <Section title="Prywatność">
        <Field label="Zdalne obrazy w wiadomościach">
          <Select value={s.loadRemoteImages} onChange={(v) => set({ loadRemoteImages: v })} options={[{ value: 'contacts', label: 'Tylko od znanych osób' }, { value: 'always', label: 'Zawsze' }, { value: 'never', label: 'Nigdy (pytaj)' }]} />
        </Field>
        <Toggle checked={s.blockTrackers} onChange={(v) => set({ blockTrackers: v })} label="Blokuj piksele śledzące" hint="Usuwa niewidoczne obrazki, którymi nadawcy sprawdzają, czy przeczytałeś wiadomość." />
      </Section>
      <Section title="Odkładanie i przypomnienia">
        <div className="grid grid-cols-2 max-md:grid-cols-1 gap-x-4">
          <Field label="Godzina „rano”"><input className={inputCls} type="number" min={5} max={12} value={s.snoozeMorningHour} onChange={(e) => set({ snoozeMorningHour: Number(e.target.value) })} /></Field>
          <Field label="Godzina „wieczorem”"><input className={inputCls} type="number" min={15} max={23} value={s.snoozeEveningHour} onChange={(e) => set({ snoozeEveningHour: Number(e.target.value) })} /></Field>
        </div>
      </Section>
      <Section title="Pobieranie">
        <Field label="Pobieraj treści wiadomości z ostatnich (dni)" hint="Do wyszukiwania pełnotekstowego i AI bez internetu. Starsze treści pobierane są przy otwarciu.">
          <input className={inputCls} type="number" min={0} max={365} value={s.bodyPrefetchDays} onChange={(e) => set({ bodyPrefetchDays: Number(e.target.value) })} />
        </Field>
      </Section>
    </>
  )
}

function NotificationsTab() {
  const [s, set] = useSettings()
  const { accounts, refreshMeta } = useStore()
  return (
    <>
      <Section title="Powiadomienia systemowe">
        <Toggle checked={s.notifications} onChange={(v) => set({ notifications: v })} label="Pokazuj powiadomienia o nowej poczcie" />
        <Toggle checked={s.notificationSound} onChange={(v) => set({ notificationSound: v })} label="Dźwięk powiadomień" />
      </Section>
      <Section title="Tryb dla kont" hint="„Inteligentne” = tylko wiadomości od ludzi i nadawców priorytetowych, bez newsletterów i automatów.">
        {accounts.map((a) => (
          <div key={a.id} className="flex items-center gap-3 py-1.5">
            <span className="flex-1 text-[13.5px]">{a.email}</span>
            <Select value={a.notify} onChange={async (v) => (await api.updateAccount(a.id, { notify: v }), void refreshMeta())} className="w-64" options={[{ value: 'smart', label: 'Inteligentne' }, { value: 'all', label: 'Wszystkie' }, { value: 'none', label: 'Wyłączone' }]} />
          </div>
        ))}
      </Section>
    </>
  )
}

function SignaturesTab() {
  const [list, setList] = useState<Signature[]>([])
  const [edit, setEdit] = useState<{ id?: number; name: string; html: string } | null>(null)
  const load = async () => setList(await api.listSignatures())
  useEffect(() => void load(), [])
  return (
    <Section title="Podpisy" hint="Domyślny podpis dla konta wybierzesz w zakładce Konta. Możesz używać zwykłego tekstu albo HTML.">
      {list.map((s) => (
        <div key={s.id} className="flex items-center gap-3 border-b border-line py-2 last:border-0">
          <div className="min-w-0 flex-1">
            <div className="font-medium">{s.name}</div>
            <div className="truncate text-[12px] text-muted">{s.html.replace(/<[^>]+>/g, ' ')}</div>
          </div>
          <Button size="sm" onClick={() => setEdit(s)}>Edytuj</Button>
          <IconButton onClick={async () => window.confirm('Usunąć podpis?') && (await api.deleteSignature(s.id), void load())}><Trash2 size={14} /></IconButton>
        </div>
      ))}
      <div className="py-2"><Button size="sm" variant="ghost" onClick={() => setEdit({ name: 'Mój podpis', html: '' })}><Plus size={14} /> Nowy podpis</Button></div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title="Podpis" width={620} footer={
        <>
          <Button variant="ghost" onClick={() => setEdit(null)}>Anuluj</Button>
          <Button variant="primary" onClick={async () => {
            const html = /<[a-z][\s\S]*>/i.test(edit!.html) ? edit!.html : edit!.html.split('\n').map((l) => l.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('<br>')
            await api.saveSignature({ ...edit!, html })
            setEdit(null)
            void load()
          }}>Zapisz</Button>
        </>
      }>
        {edit && (
          <div className="p-5">
            <Field label="Nazwa"><input className={inputCls} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Treść (tekst lub HTML)"><textarea className={cx(inputCls, 'h-40 py-2 font-mono text-[12.5px]')} value={edit.html} onChange={(e) => setEdit({ ...edit, html: e.target.value })} /></Field>
            <div className="mt-2 text-[12px] text-muted">Podgląd:</div>
            <div className="mt-1 rounded-lg border border-line bg-white p-3 text-[13px] text-black" dangerouslySetInnerHTML={{ __html: /<[a-z][\s\S]*>/i.test(edit.html) ? edit.html : edit.html.replace(/</g, '&lt;').replace(/\n/g, '<br>') }} />
          </div>
        )}
      </Modal>
    </Section>
  )
}

function TemplatesTab() {
  const [list, setList] = useState<Template[]>([])
  const [edit, setEdit] = useState<Partial<Template> & { name: string; body?: string } | null>(null)
  const toast = useStore((s) => s.toast)
  const load = async () => setList(await api.listTemplates())
  useEffect(() => void load(), [])
  return (
    <Section title="Szablony" hint={<>Pola do wypełnienia wpisujesz jako <code>{'{{Nazwa pola}}'}</code>. Automatyczne: <code>{'{{recipient first name}}'}</code>, <code>{'{{my full name}}'}</code>, <code>{'{{imię odbiorcy}}'}</code>.</>}>
      {list.map((t) => (
        <div key={t.id} className="flex items-center gap-3 border-b border-line py-2 last:border-0">
          <div className="min-w-0 flex-1">
            <div className="font-medium">{t.name}</div>
            <div className="truncate text-[12px] text-muted">{t.subject} {t.placeholders.length ? `· pola: ${t.placeholders.join(', ')}` : ''}</div>
          </div>
          <Button size="sm" onClick={() => setEdit({ ...t, body: (t.html || '').replace(/<br\s*\/?>/g, '\n').replace(/<\/p>\s*<p>/g, '\n\n').replace(/<[^>]+>/g, '') })}>Edytuj</Button>
          <IconButton onClick={async () => window.confirm('Usunąć szablon?') && (await api.deleteTemplate(t.id), void load())}><Trash2 size={14} /></IconButton>
        </div>
      ))}
      <div className="py-2"><Button size="sm" variant="ghost" onClick={() => setEdit({ name: 'Nowy szablon', subject: '', body: '' })}><Plus size={14} /> Nowy szablon</Button></div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title="Szablon" width={660} footer={
        <>
          <Button variant="ghost" onClick={() => setEdit(null)}>Anuluj</Button>
          <Button variant="primary" onClick={async () => {
            try {
              const html = (edit!.body || '').split(/\n{2,}/).map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('')
              await api.saveTemplate({ id: edit!.id, name: edit!.name, subject: edit!.subject || '', html })
              setEdit(null)
              void load()
            } catch (e) {
              toast({ level: 'error', message: errorText(e) })
            }
          }}>Zapisz</Button>
        </>
      }>
        {edit && (
          <div className="p-5">
            <Field label="Nazwa"><input className={inputCls} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Temat"><input className={inputCls} value={edit.subject || ''} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} /></Field>
            <Field label="Treść"><textarea className={cx(inputCls, 'h-56 py-2')} value={edit.body || ''} onChange={(e) => setEdit({ ...edit, body: e.target.value })} placeholder={'Dzień dobry {{imię odbiorcy}},\n\nprzesyłam ofertę na {{Projekt}}…'} /></Field>
          </div>
        )}
      </Modal>
    </Section>
  )
}

const FIELDS: { value: RuleCondition['field']; label: string }[] = [
  { value: 'from', label: 'Nadawca' }, { value: 'to', label: 'Do' }, { value: 'any_recipient', label: 'Do lub DW' }, { value: 'subject', label: 'Temat' },
  { value: 'body', label: 'Treść' }, { value: 'account', label: 'Konto' }, { value: 'category', label: 'Kategoria' }, { value: 'has_attachment', label: 'Załącznik (yes/no)' }, { value: 'list_id', label: 'Lista mailingowa' },
]
const OPS: { value: RuleCondition['op']; label: string }[] = [
  { value: 'contains', label: 'zawiera' }, { value: 'not_contains', label: 'nie zawiera' }, { value: 'equals', label: 'jest równe' },
  { value: 'starts_with', label: 'zaczyna się od' }, { value: 'ends_with', label: 'kończy się na' }, { value: 'matches', label: 'pasuje do wyrażenia' },
]
const ACTIONS: { value: RuleAction['type']; label: string; needs?: string }[] = [
  { value: 'archive', label: 'Zrobione (archiwizuj)' }, { value: 'mark_read', label: 'Oznacz jako przeczytane' }, { value: 'pin', label: 'Przypnij' },
  { value: 'move', label: 'Przenieś do folderu', needs: 'ścieżka folderu' }, { value: 'label', label: 'Dodaj etykietę (Gmail)', needs: 'etykieta' },
  { value: 'categorize', label: 'Ustaw kategorię', needs: 'people / notification / newsletter' }, { value: 'snooze', label: 'Odłóż na N godzin', needs: 'liczba godzin' },
  { value: 'mute', label: 'Wycisz wątek' }, { value: 'set_aside', label: 'Odłóż na bok' }, { value: 'no_notify', label: 'Bez powiadomienia' },
  { value: 'trash', label: 'Do kosza' }, { value: 'block', label: 'Zablokuj nadawcę' },
]

function RulesTab() {
  const [list, setList] = useState<Rule[]>([])
  const [edit, setEdit] = useState<Partial<Rule> & { name: string; conditions: RuleCondition[]; actions: RuleAction[] } | null>(null)
  const [testCount, setTestCount] = useState<number | null>(null)
  const toast = useStore((s) => s.toast)
  const load = async () => setList(await api.listRules())
  useEffect(() => void load(), [])
  return (
    <Section title="Reguły" hint="Działają na nowych wiadomościach przychodzących do Odebranych (np. „od faktury@… → etykieta Księgowość i zrobione”).">
      {list.map((r) => (
        <div key={r.id} className="flex items-center gap-3 border-b border-line py-2 last:border-0">
          <Toggle checked={r.enabled} onChange={async (v) => (await api.saveRule({ ...r, enabled: v }), void load())} />
          <div className="min-w-0 flex-1">
            <div className="font-medium">{r.name}</div>
            <div className="truncate text-[12px] text-muted">
              {r.conditions.map((c) => `${FIELDS.find((f) => f.value === c.field)?.label} ${OPS.find((o) => o.value === c.op)?.label} „${c.value}”`).join(r.match === 'all' ? ' i ' : ' lub ')} → {r.actions.map((a) => ACTIONS.find((x) => x.value === a.type)?.label + (a.value ? ` (${a.value})` : '')).join(', ')} · użyta {r.hits}×
            </div>
          </div>
          <Button size="sm" onClick={async () => {
            const n = await api.applyRule(r.id)
            toast({ level: 'success', message: `Zastosowano do ${n} istniejących rozmów` })
          }}>Zastosuj teraz</Button>
          <Button size="sm" onClick={() => (setEdit(r), setTestCount(null))}>Edytuj</Button>
          <IconButton onClick={async () => window.confirm('Usunąć regułę?') && (await api.deleteRule(r.id), void load())}><Trash2 size={14} /></IconButton>
        </div>
      ))}
      <div className="py-2"><Button size="sm" variant="ghost" onClick={() => (setEdit({ name: 'Nowa reguła', match: 'all', conditions: [{ field: 'from', op: 'contains', value: '' }], actions: [{ type: 'archive' }] }), setTestCount(null))}><Plus size={14} /> Nowa reguła</Button></div>
      <Modal open={!!edit} onClose={() => setEdit(null)} title="Reguła" width={760} footer={
        <>
          {testCount !== null && <span className="mr-auto self-center text-[12.5px] text-muted">Pasuje do {testCount} z ostatnich wiadomości w Odebranych</span>}
          <Button variant="ghost" onClick={async () => setTestCount((await api.testRule({ match: edit!.match || 'all', conditions: edit!.conditions })).length)}><Wand2 size={14} /> Testuj</Button>
          <Button variant="primary" onClick={async () => {
            try {
              await api.saveRule(edit!)
              setEdit(null)
              void load()
            } catch (e) {
              toast({ level: 'error', message: errorText(e) })
            }
          }}>Zapisz</Button>
        </>
      }>
        {edit && (
          <div className="p-5">
            <Field label="Nazwa"><input className={inputCls} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <div className="mt-2 flex items-center gap-2 text-[13px]">
              Gdy
              <Select className="w-48" value={edit.match || 'all'} onChange={(v) => setEdit({ ...edit, match: v })} options={[{ value: 'all', label: 'wszystkie warunki' }, { value: 'any', label: 'którykolwiek warunek' }]} />
              są spełnione:
            </div>
            {edit.conditions.map((c, i) => (
              <div key={i} className="mt-2 flex gap-2">
                <Select className="w-44" value={c.field} onChange={(v) => setEdit({ ...edit, conditions: edit.conditions.map((x, j) => (j === i ? { ...x, field: v } : x)) })} options={FIELDS} />
                <Select className="w-48" value={c.op} onChange={(v) => setEdit({ ...edit, conditions: edit.conditions.map((x, j) => (j === i ? { ...x, op: v } : x)) })} options={OPS} />
                <input className={inputCls} value={c.value} onChange={(e) => setEdit({ ...edit, conditions: edit.conditions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                <IconButton onClick={() => setEdit({ ...edit, conditions: edit.conditions.filter((_, j) => j !== i) })}><X size={14} /></IconButton>
              </div>
            ))}
            <Button className="mt-2" size="sm" variant="ghost" onClick={() => setEdit({ ...edit, conditions: [...edit.conditions, { field: 'subject', op: 'contains', value: '' }] })}><Plus size={13} /> Warunek</Button>
            <div className="mt-4 text-[13px]">Wtedy:</div>
            {edit.actions.map((a, i) => (
              <div key={i} className="mt-2 flex gap-2">
                <Select className="w-64" value={a.type} onChange={(v) => setEdit({ ...edit, actions: edit.actions.map((x, j) => (j === i ? { ...x, type: v } : x)) })} options={ACTIONS} />
                {ACTIONS.find((x) => x.value === a.type)?.needs && (
                  <input className={inputCls} placeholder={ACTIONS.find((x) => x.value === a.type)?.needs} value={a.value || ''} onChange={(e) => setEdit({ ...edit, actions: edit.actions.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                )}
                <IconButton onClick={() => setEdit({ ...edit, actions: edit.actions.filter((_, j) => j !== i) })}><X size={14} /></IconButton>
              </div>
            ))}
            <Button className="mt-2" size="sm" variant="ghost" onClick={() => setEdit({ ...edit, actions: [...edit.actions, { type: 'mark_read' }] })}><Plus size={13} /> Akcja</Button>
            <div className="mt-3"><Toggle checked={!!edit.stop} onChange={(v) => setEdit({ ...edit, stop: v })} label="Nie sprawdzaj kolejnych reguł" /></div>
          </div>
        )}
      </Modal>
    </Section>
  )
}

function AiTab() {
  const [s, set] = useSettings()
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.aiStatus>> | null>(null)
  const [key, setKey] = useState('')
  const toast = useStore((st) => st.toast)
  const load = async () => setStatus(await api.aiStatus())
  useEffect(() => void load(), [])
  const ai = (p: Partial<AppSettings['ai']>) => set({ ai: { ...s.ai, ...p } })
  return (
    <>
      <Section title="Silnik AI" hint="Podsumowania, pisanie odpowiedzi, tłumaczenia, szybkie odpowiedzi i pytania o pocztę.">
        <Field label="Dostawca">
          <Select value={s.ai.provider} onChange={(v) => ai({ provider: v })} options={[{ value: 'ollama', label: 'Ollama — lokalnie, za darmo, prywatnie' }, { value: 'claude', label: 'Claude (Anthropic) — najlepsza jakość, płatne za użycie' }, { value: 'off', label: 'Wyłączone' }]} />
        </Field>
      </Section>
      <Section title="Ollama (lokalnie)">
        <Field label="Adres Ollamy"><input className={inputCls} value={s.ai.ollamaUrl} onChange={(e) => ai({ ollamaUrl: e.target.value })} /></Field>
        <Field label="Model" hint={status && !status.ollamaModels.length ? 'Ollama nie odpowiada — uruchom ją, żeby zobaczyć modele.' : 'Do języka polskiego dobrze sprawdzają się gemma3:12b i qwen3:8b.'}>
          <div className="flex gap-2">
            <Select className="flex-1" value={s.ai.ollamaModel} onChange={(v) => ai({ ollamaModel: v })} options={[...(status?.ollamaModels || []).map((m) => ({ value: m.name, label: `${m.name} (${(m.size / 1e9).toFixed(1)} GB)` })), ...(status?.ollamaModels.some((m) => m.name === s.ai.ollamaModel) ? [] : [{ value: s.ai.ollamaModel, label: s.ai.ollamaModel }])]} />
            <IconButton title="Odśwież listę" onClick={() => void load()}><RefreshCw size={14} /></IconButton>
          </div>
        </Field>
      </Section>
      <Section title="Claude (Anthropic API)" hint={`Klucz z console.anthropic.com jest przechowywany ${useStore.getState().secretStore}. Treść maili jest wtedy wysyłana do API Anthropic.`}>
        <Field label={status?.hasClaudeKey ? 'Klucz API (zapisany — wpisz nowy, aby zmienić)' : 'Klucz API'}>
          <div className="flex gap-2">
            <input className={inputCls} type="password" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} />
            <Button onClick={async () => (await api.setClaudeKey(key || null), setKey(''), toast({ level: 'success', message: key ? 'Zapisano klucz' : 'Usunięto klucz' }), void load())}>{key ? 'Zapisz' : 'Usuń'}</Button>
          </div>
        </Field>
        <Field label="Model"><Select value={s.ai.claudeModel} onChange={(v) => ai({ claudeModel: v })} options={(status?.claudeModels || []).map((m) => ({ value: m.id, label: m.label }))} /></Field>
      </Section>
      <Section title="Styl">
        <Field label="Język odpowiedzi"><Select value={s.ai.replyLanguage} onChange={(v) => ai({ replyLanguage: v })} options={[{ value: 'auto', label: 'Jak w korespondencji' }, { value: 'pl', label: 'Zawsze po polsku' }, { value: 'en', label: 'Zawsze po angielsku' }]} /></Field>
        <Field label="O mnie (persona)" hint="Kim jesteś i jak piszesz — AI użyje tego przy redagowaniu odpowiedzi.">
          <textarea className={cx(inputCls, 'h-24 py-2')} value={s.ai.persona} placeholder="np. Anna, właścicielka małej pracowni projektowej. Piszę krótko i konkretnie, po imieniu." onChange={(e) => ai({ persona: e.target.value })} />
        </Field>
      </Section>
    </>
  )
}

function AgentsTab() {
  const { accounts, refreshMeta, toast } = useStore()
  const [cli, setCli] = useState<{ script: string; node: string; packaged: boolean } | null>(null)
  const [hist, setHist] = useState<Awaited<ReturnType<typeof api.history>>>([])
  useEffect(() => {
    void window.octo.cliPath().then(setCli)
    void api.history(40).then((h) => setHist(h.filter((x) => x.actor === 'cli' || x.actor === 'mcp')))
  }, [])
  const octo = cli ? (cli.packaged ? `"${cli.script}"` : `node "${cli.script}"`) : 'octo'
  const mcpCmd = cli ? `claude mcp add octopus-mail --scope user -- ${octo} mcp` : ''
  const copy = (t: string) =>
    void copyText(t).then(
      () => toast({ level: 'success', message: 'Skopiowano' }),
      () => toast({ level: 'error', message: 'Nie udało się skopiować' }),
    )
  return (
    <>
      <Section title="Poziom dostępu agentów AI" hint="Dotyczy CLI `octo` i serwera MCP (Claude Code, Claude Desktop). Zmienić go można tylko tutaj — agent nie podniesie sobie uprawnień.">
        {accounts.map((a) => (
          <div key={a.id} className="flex items-center gap-3 py-1.5">
            <span className="flex-1 text-[13.5px]">{a.email}</span>
            <Select className="w-72" value={a.agent_access} onChange={async (v) => (await api.setAgentAccess(a.id, v), void refreshMeta())} options={ACCESS} />
          </div>
        ))}
      </Section>
      <Section title="Podłącz do Claude Code" hint="Jednorazowo, w terminalu. Potem Claude może czytać, porządkować i (jeśli pozwolisz) wysyłać pocztę oraz zarządzać kalendarzem.">
        <div className="flex items-center gap-2 py-1">
          <code className="selectable flex-1 break-all rounded-lg bg-surface-2 px-2 py-1.5 text-[12px]">{mcpCmd}</code>
          <IconButton title="Kopiuj" onClick={() => copy(mcpCmd)}><Copy size={14} /></IconButton>
        </div>
        <div className="py-1 text-[12.5px] text-muted">Wiersz poleceń: <code className="selectable">{octo} help</code>. CLI działa także przy zamkniętej aplikacji, a czasy wypisuje w czasie lokalnym z przesunięciem UTC.</div>
      </Section>
      <Section title="Ostatnie działania agentów">
        {hist.length === 0 ? <div className="py-2 text-[12.5px] text-muted">Brak</div> : hist.map((h) => (
          <div key={h.id} className="flex gap-3 py-1 text-[12.5px]">
            <span className="w-40 shrink-0 text-muted">{fullDate(h.at)}</span>
            <span className="w-10 shrink-0 font-medium">{h.actor}</span>
            <span className={cx('flex-1 truncate', !h.ok && 'text-danger')}>{h.action} {h.target ? `#${h.target}` : ''} {h.details ? `· ${h.details}` : ''}</span>
          </div>
        ))}
      </Section>
    </>
  )
}

function CalendarsTab() {
  const [sources, setSources] = useState<Awaited<ReturnType<typeof api.listCalendarSources>>>([])
  const toast = useStore((s) => s.toast)
  const load = async () => setSources(await api.listCalendarSources())
  useEffect(() => void load(), [])
  return (
    <Section title="Źródła kalendarzy" hint="Kalendarz Google dodaje się automatycznie dla kont zalogowanych przez Google OAuth. Inne (iCloud, Fastmail, Nextcloud, ICS, lokalny) dodasz w widoku Kalendarza.">
      {sources.map((s) => (
        <div key={s.id} className="flex items-center gap-3 border-b border-line py-2 last:border-0">
          <div className="min-w-0 flex-1">
            <div className="font-medium">{s.name} <span className="text-[12px] font-normal text-muted">({s.kind})</span></div>
            <div className="text-[12px] text-muted">{s.last_error ? <span className="text-danger">{s.last_error}</span> : s.last_sync ? `synchronizacja ${fullDate(s.last_sync)}` : ''}</div>
          </div>
          <IconButton title="Synchronizuj" onClick={() => void api.syncCalendars(s.id).then(load).catch((e) => toast({ level: 'error', message: errorText(e) }))}><RefreshCw size={14} /></IconButton>
          <IconButton title="Usuń" onClick={async () => window.confirm('Usunąć źródło kalendarza?') && (await api.removeCalendarSource(s.id), void load())}><Trash2 size={14} /></IconButton>
        </div>
      ))}
      {!sources.length && <div className="py-2 text-[12.5px] text-muted">Brak kalendarzy.</div>}
    </Section>
  )
}

type ServerStatus =
  | { mode: 'local' }
  | { mode: 'remote'; url: string; deviceId: string; deviceName: string; serverName?: string; online: boolean; devices: { id: string; name: string; createdAt: number; lastSeen: number | null; lastIp: string | null }[] }

function ServerTab() {
  const toast = useStore((s) => s.toast)
  const [st, setSt] = useState<ServerStatus | null>(null)
  const [url, setUrl] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [probe, setProbe] = useState('')
  const [newCode, setNewCode] = useState<{ code: string; expires: number } | null>(null)
  const load = async () => setSt((await window.octo.serverStatus()) as ServerStatus)
  useEffect(() => void load(), [])
  if (!st) return <Spinner />

  if (st.mode === 'local') {
    const check = async () => {
      if (!url.trim()) return
      try {
        const info = await window.octo.serverProbe(url)
        setProbe(`✓ Znaleziono serwer „${info.hostname}” (wersja ${info.version})`)
      } catch (e) {
        setProbe(`✗ ${errorText(e)}`)
      }
    }
    const connect = async () => {
      if (!window.confirm('Po połączeniu aplikacja uruchomi się ponownie i będzie korzystać z kont na serwerze domowym. Konta dodane na tym komputerze zostają tutaj, ale nie będą używane, dopóki nie odłączysz serwera. Kontynuować?')) return
      setBusy(true)
      try {
        await window.octo.serverConnect(url, code, name)
      } catch (e) {
        toast({ level: 'error', message: errorText(e) })
        setBusy(false)
      }
    }
    return (
      <>
        <Section title="Serwer domowy" hint="Komputer stale włączony (Raspberry Pi, NAS, stary laptop) z Octopus Mail. Wysyła zaplanowane wiadomości i budzi odłożone oraz przypomnienia także wtedy, gdy Twoje komputery są wyłączone, a wszystkie komputery i przeglądarka w telefonie widzą te same konta.">
          <div className="py-2 text-[13px] leading-relaxed">
            <div className="mb-1 font-medium">1. Na serwerze uruchom:</div>
            <code className="selectable block rounded-lg bg-surface-2 px-3 py-2 text-[12.5px]">octo serve</code>
            <div className="mt-1 text-[12px] text-muted">
              Wypisze adres (np. <code>http://192.168.1.50:8787</code>) i kod parowania. Instalacja na Raspberry Pi: README, sekcja „Serwer domowy”.
            </div>
            <div className="mb-1 mt-3 font-medium">2. Połącz tę aplikację:</div>
          </div>
          <div className="grid grid-cols-2 max-md:grid-cols-1 gap-x-4">
            <Field label="Adres serwera">
              <input className={inputCls} placeholder="np. 192.168.1.50 albo raspberrypi.local" value={url} onChange={(e) => (setUrl(e.target.value), setProbe(''))} onBlur={() => void check()} />
            </Field>
            <Field label="Kod parowania">
              <input className={cx(inputCls, 'uppercase tracking-widest')} placeholder="XXXX-XXXX" maxLength={9} value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Field label="Nazwa tego urządzenia">
              <input className={inputCls} placeholder="np. Laptop Piotra" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="flex items-end pb-1.5">
              <Button variant="primary" disabled={busy || !url.trim() || code.replace(/[^A-Za-z0-9]/g, '').length < 8} onClick={() => void connect()}>
                {busy && <Spinner />} Połącz z serwerem
              </Button>
            </div>
          </div>
          {probe && <div className={cx('pb-2 text-[12.5px]', probe.startsWith('✓') ? 'text-success' : 'text-danger')}>{probe}</div>}
        </Section>
        <Section title="Bezpieczeństwo">
          <div className="py-2 text-[12.5px] leading-relaxed text-muted">
            Każde urządzenie dostaje własny klucz, który możesz w każdej chwili odebrać. Serwer przechowuje hasła do skrzynek, dlatego trzymaj go w sieci
            domowej. Dostęp spoza domu najlepiej przez VPN (np. Tailscale), nie przez przekierowanie portu w routerze.
          </div>
        </Section>
      </>
    )
  }

  const host = (() => {
    try {
      return new URL(st.url).hostname
    } catch {
      return 'serwer'
    }
  })()
  return (
    <>
      <Section title="Serwer domowy">
        <div className="flex items-center gap-3 py-2">
          <span className={cx('h-2.5 w-2.5 rounded-full', st.online ? 'bg-success' : 'bg-danger')} />
          <div className="min-w-0 flex-1">
            <div className="font-medium">
              {st.serverName || 'Serwer'} <span className="font-normal text-muted">{st.url}</span>
            </div>
            <div className="text-[12px] text-muted">
              {st.online ? 'Połączono' : 'Brak połączenia — aplikacja ponawia próby'} · to urządzenie: {st.deviceName}
            </div>
          </div>
          <Button
            size="sm"
            variant="danger"
            onClick={async () => {
              if (window.confirm('Odłączyć tę aplikację od serwera domowego? Uruchomi się ponownie w trybie lokalnym (z kontami dodanymi na tym komputerze).')) await window.octo.serverDisconnect()
            }}
          >
            <Unplug size={14} /> Odłącz
          </Button>
        </div>
      </Section>
      <Section title="Urządzenia" hint="Komputery i przeglądarki, które mają dostęp do Twojej poczty na serwerze.">
        {st.devices.map((d) => (
          <div key={d.id} className="flex items-center gap-3 border-b border-line py-2 last:border-0">
            {/telefon/i.test(d.name) ? <Smartphone size={16} className="text-muted" /> : <Server size={16} className="text-muted" />}
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {d.name}
                {d.id === st.deviceId && <span className="ml-2 text-[11.5px] font-normal text-accent">to urządzenie</span>}
              </div>
              <div className="text-[12px] text-muted">
                sparowane {fullDate(d.createdAt)} · ostatnio {d.lastSeen ? fullDate(d.lastSeen) : '—'}
                {d.lastIp ? ` · ${d.lastIp}` : ''}
              </div>
            </div>
            {d.id !== st.deviceId && (
              <Button size="sm" variant="ghost" onClick={async () => window.confirm(`Odebrać dostęp urządzeniu „${d.name}”?`) && (await window.octo.serverRevoke(d.id), void load())}>
                Odbierz dostęp
              </Button>
            )}
          </div>
        ))}
        <div className="py-2">
          <Button size="sm" onClick={async () => setNewCode(await window.octo.serverNewCode())}>
            <Plus size={14} /> Dodaj urządzenie
          </Button>
        </div>
        {newCode && (
          <div className="mb-2 rounded-xl bg-accent-soft p-4 text-center">
            <div className="text-[12.5px] text-muted">
              Kod parowania (jednorazowy, ważny do {new Date(newCode.expires).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })})
            </div>
            <div className="selectable my-1 font-mono text-[28px] font-semibold tracking-[0.2em] text-accent">{newCode.code}</div>
            <div className="text-[12.5px] text-muted">
              Komputer: Ustawienia → Serwer domowy. Telefon lub przeglądarka: otwórz <b className="selectable">{st.url}</b> i wpisz kod.
            </div>
          </div>
        )}
      </Section>
      <Section title="Claude Code przy serwerze domowym">
        <div className="py-2 text-[12.5px] leading-relaxed text-muted">
          Agent łączy się z serwerem przez SSH, np.: <code className="selectable">claude mcp add octopus-mail --scope user -- ssh pi@{host} octo mcp</code>
        </div>
      </Section>
    </>
  )
}

const SHORTCUTS: [string, string][] = [
  ['C / Ctrl+N', 'Nowa wiadomość'], ['Ctrl+K', 'Paleta poleceń'], ['/ lub Ctrl+F', 'Szukaj'], ['J / K, ↓ / ↑', 'Następna / poprzednia rozmowa'],
  ['E', 'Zrobione (archiwizuj)'], ['#, Delete', 'Do kosza'], ['S', 'Przypnij / odepnij'], ['H', 'Odłóż'], ['V', 'Przenieś do folderu'],
  ['U', 'Przeczytane / nieprzeczytane'], ['M', 'Wycisz'], ['!', 'Spam'], ['R / A / F', 'Odpowiedz / wszystkim / przekaż'], ['X', 'Zaznacz'],
  ['Ctrl+Z', 'Cofnij ostatnią akcję'], ['Ctrl+Enter', 'Wyślij (w edytorze)'], ['Esc', 'Zamknij / odznacz'],
  ['G potem I / S / D / P / Z / A / T / N', 'Idź do: Odebrane / Wysłane / Wersje robocze / Przypięte / Odłożone / Archiwum / Kosz / Nowi nadawcy'], ['G potem C', 'Kalendarz'],
]

function AboutTab() {
  const [dir, setDir] = useState('')
  useEffect(() => void window.octo.dataDir().then(setDir), [])
  return (
    <Section title="Octopus Mail 0.1.0">
      <div className="py-1 text-[13px]">Darmowy klient poczty z Smart Inbox, GateKeeperem, AI, kalendarzem i dostępem dla agentów AI.</div>
      <div className="py-1 text-[12.5px] text-muted">
        Otwarty kod (licencja MIT):{' '}
        <button className="text-accent hover:underline" onClick={() => void window.octo.openExternal('https://github.com/CFGPeter/octopus-mail')}>github.com/CFGPeter/octopus-mail</button>
        {' · '}
        <button className="text-accent hover:underline" onClick={() => void window.octo.openExternal('https://github.com/CFGPeter/octopus-mail/issues')}>zgłoś błąd</button>
      </div>
      <div className="py-1 text-[12.5px] text-muted">Dane programu: <button className="text-accent hover:underline" onClick={() => void window.octo.showItem(dir)}>{dir}</button></div>
    </Section>
  )
}

export default function SettingsView() {
  const narrow = useNarrow()
  // on a phone the tab list and the tab content are two screens
  const [picked, setTab] = useState<Tab | null>(narrow ? null : 'accounts')
  const tab = picked ?? (narrow ? null : 'accounts')
  const setView = useStore((s) => s.setView)
  return (
    <div className="flex h-full min-w-0 flex-1 bg-bg">
      <div className={cx('w-[230px] shrink-0 overflow-y-auto border-r border-line bg-surface p-2', narrow && (tab ? 'hidden' : 'w-full border-r-0'))}>
        <div className="flex items-center justify-between px-2 pb-2 pt-1">
          <div className="text-[15px] font-semibold">Ustawienia</div>
          <IconButton title="Zamknij" onClick={() => setView('mail')}><X size={15} /></IconButton>
        </div>
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)} className={cx('flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] max-md:h-11 max-md:text-[15px]', tab === t.id ? 'bg-accent-soft font-medium text-accent' : 'hover:bg-hover')}>
            <span className="text-muted">{t.icon}</span> {t.label}
          </button>
        ))}
      </div>
      <div className={cx('min-w-0 flex-1 overflow-y-auto px-8 py-6 max-md:px-3 max-md:py-3', narrow && !tab && 'hidden')}>
        {narrow && (
          <button className="mb-2 flex h-9 items-center gap-1 text-[14px] text-accent" onClick={() => setTab(null)}>
            <ChevronLeft size={18} /> Ustawienia
          </button>
        )}
        <div className="mx-auto max-w-[760px]">
          {tab === 'accounts' && <AccountsTab />}
          {tab === 'general' && <GeneralTab />}
          {tab === 'inbox' && <InboxTab />}
          {tab === 'notifications' && <NotificationsTab />}
          {tab === 'signatures' && <SignaturesTab />}
          {tab === 'templates' && <TemplatesTab />}
          {tab === 'rules' && <RulesTab />}
          {tab === 'ai' && <AiTab />}
          {tab === 'agents' && <AgentsTab />}
          {tab === 'calendars' && <CalendarsTab />}
          {tab === 'server' && <ServerTab />}
          {tab === 'shortcuts' && (
            <Section title="Skróty klawiszowe">
              {SHORTCUTS.map(([k, d]) => (
                <div key={k} className="flex items-center gap-3 border-b border-line py-1.5 last:border-0">
                  <span className="w-64 shrink-0"><span className="kbd">{k}</span></span>
                  <span className="text-[13px]">{d}</span>
                </div>
              ))}
            </Section>
          )}
          {tab === 'about' && <AboutTab />}
        </div>
      </div>
    </div>
  )
}
