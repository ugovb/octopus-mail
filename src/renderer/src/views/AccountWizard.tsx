import { ChevronDown, ChevronRight, ExternalLink, KeyRound, Mail, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import logo from '../assets/logo.svg'
import { api, errorText } from '../lib/api'
import { useStore } from '../lib/store'
import { Button, cx, Field, inputCls, Spinner, Toggle } from '../components/ui'
import { Welcome } from '../components/illustrations'

type Cfg = Awaited<ReturnType<typeof api.discover>>

const QUICK = [
  { id: 'gmail', label: 'Gmail', domain: 'gmail.com' },
  { id: 'outlook', label: 'Outlook', domain: 'outlook.com' },
  { id: 'icloud', label: 'iCloud', domain: 'icloud.com' },
  { id: 'homepl', label: 'home.pl', domain: '' },
  { id: 'mailcom', label: 'mail.com', domain: 'mail.com' },
  { id: 'wp', label: 'WP / o2 / Onet', domain: 'wp.pl' },
  { id: 'imap', label: 'Inny (IMAP)', domain: '' },
]

function OAuthSetup({ provider, onSaved }: { provider: 'google' | 'microsoft'; onSaved: () => void }) {
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  const toast = useStore((s) => s.toast)
  return (
    <div className="mt-2 rounded-xl border border-line bg-surface-2 p-3 text-[12.5px]">
      <div className="mb-2 text-muted">
        {provider === 'google' ? (
          <>Logowanie Google wymaga własnego „OAuth Client ID” (darmowe): Google Cloud Console → APIs &amp; Services → Credentials → <b>Create OAuth client ID</b> → typ <b>Desktop app</b>. Włącz Gmail API, Google Calendar API i People API, a swój adres dodaj jako „Test user”.</>
        ) : (
          <>Logowanie Microsoft wymaga „Application (client) ID” z Azure Portal → App registrations → New registration (konta osobiste i firmowe), platforma <b>Mobile and desktop</b> z adresem przekierowania <code>http://localhost</code>.</>
        )}
        <button className="ml-1 inline-flex items-center gap-0.5 text-accent hover:underline" onClick={() => void window.octo.openExternal(provider === 'google' ? 'https://console.cloud.google.com/apis/credentials' : 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade')}>
          otwórz konsolę <ExternalLink size={11} />
        </button>
      </div>
      <input className={cx(inputCls, 'mb-1.5')} placeholder="Client ID" value={id} onChange={(e) => setId(e.target.value)} />
      {provider === 'google' && <input className={cx(inputCls, 'mb-1.5')} placeholder="Client secret" value={secret} onChange={(e) => setSecret(e.target.value)} />}
      <Button size="sm" variant="primary" disabled={!id.trim()} onClick={async () => {
        await api.setKV(`oauth.${provider}`, { clientId: id.trim(), clientSecret: secret.trim() || undefined })
        toast({ level: 'success', message: 'Zapisano konfigurację OAuth' })
        onSaved()
      }}>Zapisz</Button>
    </div>
  )
}

export default function AccountWizard({ welcome, onDone }: { welcome?: boolean; onDone?: () => void }) {
  const { toast, refreshMeta, secretStore } = useStore()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [syncDays, setSyncDays] = useState(90)
  const [oauthSetup, setOauthSetup] = useState<'google' | 'microsoft' | null>(null)
  const [provider, setProvider] = useState('')

  const detect = async (addr = email) => {
    if (!/@.+\./.test(addr)) return
    setBusy(true)
    setError('')
    try {
      setCfg(await api.discover(addr))
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  const add = async () => {
    setBusy(true)
    setError('')
    try {
      if (!cfg) throw new Error('Najpierw wpisz adres — wykryję ustawienia serwera')
      await api.addAccount({
        email, name: name || undefined, password, username: (cfg as Cfg & { username?: string }).username || email, provider: cfg.provider, sync_days: syncDays,
        imap_host: cfg.imap_host, imap_port: cfg.imap_port, imap_secure: cfg.imap_secure,
        smtp_host: cfg.smtp_host, smtp_port: cfg.smtp_port, smtp_secure: cfg.smtp_secure,
      } as Parameters<typeof api.addAccount>[0])
      toast({ level: 'success', message: `Dodano ${email} — trwa pierwsza synchronizacja` })
      setEmail('')
      setPassword('')
      setCfg(null)
      await refreshMeta()
      onDone?.()
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  const oauth = async (p: 'google' | 'microsoft') => {
    setBusy(true)
    setError('')
    try {
      const has = (await api.getKV(`oauth.${p}`, null)) as { clientId?: string } | null
      if (!has?.clientId) {
        setOauthSetup(p)
        setBusy(false)
        return
      }
      toast({ level: 'info', message: 'Dokończ logowanie w przeglądarce…' })
      const acc = await window.octo.oauthAddAccount(p, email || undefined, name || undefined)
      toast({ level: 'success', message: `Dodano ${acc.email}` })
      await refreshMeta()
      onDone?.()
    } catch (e) {
      setError(errorText(e))
    }
    setBusy(false)
  }

  const set = (k: string, v: unknown) => setCfg((c) => (c ? ({ ...c, [k]: v } as Cfg) : c))

  return (
    <div className={cx('flex h-full w-full justify-center overflow-y-auto', welcome && 'bg-bg pt-[6vh]')}>
      <div className={cx('w-full max-w-[560px] p-6', welcome && 'rounded-2xl border border-line bg-surface')} style={welcome ? { boxShadow: 'var(--shadow)', height: 'fit-content' } : undefined}>
        {welcome && (
          <div className="mb-5 text-center">
            <div className="mb-3 flex justify-center"><Welcome /></div>
            <h1 className="flex items-center justify-center gap-2 text-[22px] font-semibold">
              <img src={logo} alt="" className="h-8 w-8" draggable={false} />
              Witaj w Octopus Mail
            </h1>
            <p className="mt-1 text-[13px] text-muted">Darmowa poczta z Smart Inbox, AI i kalendarzem. Wszystko zostaje na tym komputerze, a hasła są przechowywane {secretStore}.</p>
          </div>
        )}
        <div className="mb-3 flex flex-wrap gap-1.5">
          {QUICK.map((q) => (
            <button
              key={q.id}
              onClick={() => {
                setProvider(q.id)
                if (q.domain && !email.includes('@')) setEmail(email ? `${email}@${q.domain}` : '')
              }}
              className={cx('rounded-lg border px-2.5 py-1 text-[12.5px]', provider === q.id ? 'border-accent bg-accent-soft text-accent' : 'border-line hover:bg-hover')}
            >
              {q.label}
            </button>
          ))}
        </div>

        <Field label="Adres e-mail">
          <input className={inputCls} value={email} placeholder="ty@przyklad.pl" onChange={(e) => (setEmail(e.target.value.trim()), setCfg(null))} onBlur={() => void detect()} autoFocus />
        </Field>
        <Field label="Twoje imię i nazwisko (nadawca)">
          <input className={inputCls} value={name} placeholder="np. Jan Kowalski" onChange={(e) => setName(e.target.value)} />
        </Field>

        {(provider === 'gmail' || cfg?.provider === 'gmail' || provider === 'outlook' || cfg?.provider === 'outlook') && (
          <div className="my-2 rounded-xl border border-line p-3">
            <div className="mb-2 flex items-center gap-2 text-[13px] font-medium"><ShieldCheck size={15} className="text-success" /> Logowanie bez hasła (OAuth)</div>
            <div className="flex gap-2">
              {(provider === 'gmail' || cfg?.provider === 'gmail') && <Button disabled={busy} onClick={() => void oauth('google')}>Zaloguj przez Google</Button>}
              {(provider === 'outlook' || cfg?.provider === 'outlook') && <Button disabled={busy} onClick={() => void oauth('microsoft')}>Zaloguj przez Microsoft</Button>}
            </div>
            {oauthSetup && <OAuthSetup provider={oauthSetup} onSaved={() => (setOauthSetup(null), void oauth(oauthSetup))} />}
            <div className="mt-2 text-[12px] text-muted">…albo użyj hasła do aplikacji poniżej.</div>
          </div>
        )}

        <Field label={<span className="flex items-center gap-1"><KeyRound size={13} /> Hasło (lub hasło do aplikacji)</span>} hint={cfg?.hint}>
          <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
        </Field>
        {cfg?.provider === 'gmail' && (
          <button className="mb-1 inline-flex items-center gap-1 text-[12px] text-accent hover:underline" onClick={() => void window.octo.openExternal('https://myaccount.google.com/apppasswords')}>
            Utwórz hasło do aplikacji Google <ExternalLink size={11} />
          </button>
        )}

        {busy && !cfg && <div className="flex items-center gap-2 py-2 text-[12.5px] text-muted"><Spinner /> Wykrywam ustawienia serwera…</div>}
        {cfg && (
          <div className="mt-2 rounded-xl border border-line bg-surface-2 p-3 text-[12.5px]">
            <button className="flex w-full items-center gap-1 text-left" onClick={() => setAdvanced(!advanced)}>
              {advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              <Mail size={13} className="text-muted" />
              <span className="flex-1">{cfg.label}: IMAP <b>{cfg.imap_host || '?'}</b>:{cfg.imap_port} · SMTP <b>{cfg.smtp_host || '?'}</b>:{cfg.smtp_port}</span>
              <span className="text-accent">zmień</span>
            </button>
            {advanced && (
              <div className="mt-2 grid grid-cols-[1fr_90px] gap-x-2">
                <Field label="Serwer IMAP"><input className={inputCls} value={cfg.imap_host} onChange={(e) => set('imap_host', e.target.value)} /></Field>
                <Field label="Port"><input className={inputCls} value={cfg.imap_port} onChange={(e) => set('imap_port', Number(e.target.value))} /></Field>
                <Toggle checked={cfg.imap_secure} onChange={(v) => set('imap_secure', v)} label="IMAP przez SSL/TLS" />
                <span />
                <Field label="Serwer SMTP"><input className={inputCls} value={cfg.smtp_host} onChange={(e) => set('smtp_host', e.target.value)} /></Field>
                <Field label="Port"><input className={inputCls} value={cfg.smtp_port} onChange={(e) => set('smtp_port', Number(e.target.value))} /></Field>
                <Toggle checked={cfg.smtp_secure} onChange={(v) => set('smtp_secure', v)} label="SMTP przez SSL (465)" hint="wyłączone = STARTTLS (587)" />
                <span />
                <Field label="Login (jeśli inny niż adres)"><input className={inputCls} value={(cfg as Cfg & { username?: string }).username || ''} placeholder={email} onChange={(e) => set('username', e.target.value)} /></Field>
                <Field label="Dni wstecz"><input className={inputCls} value={syncDays} onChange={(e) => setSyncDays(Number(e.target.value) || 90)} /></Field>
              </div>
            )}
          </div>
        )}
        {error && <div className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</div>}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="primary" disabled={busy || !email || !password} onClick={() => void add()}>
            {busy && cfg ? <Spinner /> : null} Dodaj konto
          </Button>
        </div>
        <p className="mt-3 text-[11.5px] text-faint">Przed zapisaniem sprawdzam logowanie IMAP i SMTP. Pobieram pocztę z ostatnich {syncDays} dni, a starszą doczytuję przy przewijaniu.</p>
      </div>
    </div>
  )
}
