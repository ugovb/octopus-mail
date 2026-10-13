// Fills a throwaway demo profile (OCTO_HOME) with realistic mail on the local GreenMail server,
// so the UI can be exercised and screenshotted without touching real accounts.
// Usage: node scripts/demo.mjs seed   (OCTO_HOME and OCTO_SECRETS=file are set by the wrapper)
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import * as accounts from '../src/core/accounts'
import * as A from '../src/core/actions'
import * as cal from '../src/core/calendar'
import * as drafts from '../src/core/drafts'
import { processOps } from '../src/core/ops'
import * as Q from '../src/core/queries'
import { saveRule } from '../src/core/rules'
import { updateSettings } from '../src/core/settings'
import { sync } from '../src/core/sync'

const HOST = '127.0.0.1'
const smtp = nodemailer.createTransport({ host: HOST, port: 3025, secure: false, ignoreTLS: true })
const ago = (h: number) => new Date(Date.now() - h * 3600_000)

async function main() {
  const c = new ImapFlow({ host: HOST, port: 3143, secure: false, auth: { user: 'alice', pass: 'pass' }, logger: false } as never)
  await c.connect()
  for (const f of await c.list()) {
    if (f.path === 'INBOX') {
      const lock = await c.getMailboxLock('INBOX')
      try {
        if ((c.mailbox as { exists: number }).exists) await c.messageDelete('1:*')
      } finally {
        lock.release()
      }
    } else await c.mailboxDelete(f.path).catch(() => undefined)
  }
  for (const name of ['Sent', 'Drafts', 'Trash', 'Junk', 'Archive', 'Projekty', 'Projekty/Strażnik Latarni', 'Księgowość']) await c.mailboxCreate(name).catch(() => undefined)
  await c.logout()

  const to = 'Ola Nowicka <alice@test.local>'
  const mails: nodemailer.SendMailOptions[] = [
    { from: 'Sebastian Nowak <sebastian@pixelforge.example>', subject: 'Build 0.9.3 — gotowy do testów', date: ago(0.6), messageId: '<build093@pixelforge.example>',
      text: 'Cześć Olu,\n\nwrzuciłem build 0.9.3 na Steam (gałąź beta). Poprawiłem kamerę i zoom, teraz jest płynniej.\nDaj znać do piątku, czy możemy puścić to do testerów.\n\nPozdrawiam,\nSebastian',
      attachments: [{ filename: 'changelog-0.9.3.pdf', content: Buffer.from('%PDF-1.4 changelog') }] },
    { from: 'Anna Kowalczyk <anna@studio-north.example>', subject: 'Umowa wydawnicza — poprawki', date: ago(2),
      html: '<p>Dzień dobry,</p><p>w załączeniu przesyłam umowę z naniesionymi poprawkami w §4 (podział przychodów) i §7 (prawa do portów).</p><p>Czy możemy porozmawiać w <b>czwartek o 11:00</b>?</p><p>Pozdrawiam serdecznie<br>Anna Kowalczyk<br>Studio North</p>',
      attachments: [{ filename: 'Umowa_wydawnicza_v3.docx', content: Buffer.from('docx') }] },
    { from: 'Steam <noreply@steampowered.com>', subject: 'Twoja gra została zatwierdzona do wydania', date: ago(3), text: 'Gratulacje! Build został zatwierdzony przez Steam. Możesz ustawić datę premiery w Steamworks.' },
    { from: 'GitHub <notifications@github.com>', subject: '[latarnia-games/website] Fix newsletter signup (#42)', date: ago(4), text: 'merged #42 into main.', headers: { 'X-GitHub-Reason': 'author' } },
    { from: 'Allegro <newsletter@allegro.example>', subject: 'Tylko dziś: -40% na elektronikę 🎧', date: ago(5), html: '<h2>Wielka wyprzedaż</h2><p>Słuchawki, monitory, klawiatury — nawet 40% taniej.</p><img src="https://example.com/banner.jpg" width="600"><img src="https://track.example.com/open.gif" width="1" height="1">', headers: { 'List-Unsubscribe': '<https://allegro.example/unsub>, <mailto:unsub@allegro.example>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', Precedence: 'bulk' } },
    { from: 'Game Developer <newsletter@gamedeveloper.example>', subject: 'This week: Steam Next Fest postmortems', date: ago(9), html: '<p>Five indie devs share their Next Fest numbers.</p>', headers: { 'List-Unsubscribe': '<mailto:leave@gamedeveloper.example>', Precedence: 'list' } },
    { from: 'home.pl <powiadomienia@home.pl>', subject: 'Faktura VAT nr FV/2026/10/1234', date: ago(20), text: 'W załączniku faktura za hosting latarnia.example na kwotę 249,00 zł brutto. Termin płatności: 27.10.2026.', attachments: [{ filename: 'FV_2026_10_1234.pdf', content: Buffer.from('%PDF-1.4 faktura') }] },
    { from: 'Marek Wiśniewski <marek@indiefund.example>', subject: 'Re: Pitch deck — Strażnik Latarni', date: ago(26), inReplyTo: '<pitch1@latarnia.example>', references: ['<pitch1@latarnia.example>'],
      text: 'Olu, przejrzałem deck. Mamy pytania o budżet marketingowy i plan na konsole. Czy możesz przysłać prognozę sprzedaży na 12 miesięcy?\n\nMarek' },
    { from: 'Kasia <kasia.nowicka@example.pl>', subject: 'Niedzielny obiad 🍝', date: ago(30), text: 'Hej! Wpadacie w niedzielę o 14? Mama robi lazanię :)' },
    { from: 'Nowy Kontakt <hello@streamer-agency.example>', subject: 'Współpraca: 12 streamerów dla Waszej premiery', date: ago(33), text: 'Dzień dobry, prowadzimy agencję streamerów. Mamy propozycję kampanii na premierę.' },
    { from: 'Zoom <no-reply@zoom.us>', subject: 'Nagranie spotkania jest gotowe', date: ago(50), text: 'Nagranie z „Weekly sync” jest dostępne przez 30 dni.' },
    { from: 'Substack <indiegames@substack.example>', subject: 'The state of indie publishing in 2026', date: ago(72), html: '<p>Long read about publishers, advances and revenue splits.</p>', headers: { 'List-Unsubscribe': '<https://substack.example/unsub>', 'List-Id': 'indiegames.substack.example' } },
    { from: 'Tomek <tomek@pixelforge.example>', subject: 'Muzyka do traileru', date: ago(96), text: 'Wysyłam 3 wersje muzyki do traileru, daj znać która najlepsza.', attachments: [{ filename: 'trailer_v1.mp3', content: Buffer.from('ID3') }, { filename: 'trailer_v2.mp3', content: Buffer.from('ID3') }] },
    { from: 'PayPal <service@paypal.example>', subject: 'Otrzymano płatność: 1 250,00 USD', date: ago(120), text: 'Otrzymałeś płatność od Humble Bundle.' },
  ]
  for (const m of mails) await smtp.sendMail({ to, ...m })

  // a meeting invitation (iTIP REQUEST)
  const start = new Date()
  start.setDate(start.getDate() + 2)
  start.setHours(11, 0, 0, 0)
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Demo//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    'UID:demo-invite-1@studio-north.example', `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(new Date(start.getTime() + 3600_000))}`,
    'SUMMARY:Omówienie umowy wydawniczej', 'LOCATION:https://meet.google.com/abc-defg-hij', 'ORGANIZER;CN=Anna Kowalczyk:mailto:anna@studio-north.example',
    'ATTENDEE;CN=Ola Nowicka;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alice@test.local', 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n')
  await smtp.sendMail({ to, from: 'Anna Kowalczyk <anna@studio-north.example>', subject: 'Zaproszenie: Omówienie umowy wydawniczej', date: ago(1), text: 'Zapraszam na rozmowę o umowie.', icalEvent: { method: 'REQUEST', content: ics } })

  // the user's own sent mail (so Smart Inbox knows who is a real contact)
  const sentConn = new ImapFlow({ host: HOST, port: 3143, secure: false, auth: { user: 'alice', pass: 'pass' }, logger: false } as never)
  await sentConn.connect()
  const sentRaw = (to2: string, subject: string, body: string, id: string, h: number) =>
    new Promise<Buffer>((resolve, reject) =>
      new MailComposer({ from: 'Ola Nowicka <alice@test.local>', to: to2, subject, text: body, messageId: id, date: ago(h) })
        .compile()
        .build((err, msg) => (err ? reject(err) : resolve(msg))),
    )
  await sentConn.append('Sent', await sentRaw('Marek Wiśniewski <marek@indiefund.example>', 'Pitch deck — Strażnik Latarni', 'Cześć Marek, w załączeniu deck. Ola', '<pitch1@latarnia.example>', 40), ['\\Seen'])
  await sentConn.append('Sent', await sentRaw('Sebastian Nowak <sebastian@pixelforge.example>', 'Kamera i zoom', 'Sebastian, porównaj proszę płynność zoomu z poprzednim buildem.', '<cam1@latarnia.example>', 60), ['\\Seen'])
  await sentConn.append('Sent', await sentRaw('Kasia <kasia.nowicka@example.pl>', 'Re: zdjęcia', 'Dzięki! :)', '<kasia1@latarnia.example>', 200), ['\\Seen'])
  await sentConn.append('Sent', await sentRaw('Tomek <tomek@pixelforge.example>', 'Trailer', 'Tomek, potrzebujemy muzyki do traileru.', '<tom1@latarnia.example>', 150), ['\\Seen'])
  await sentConn.append('Sent', await sentRaw('Anna Kowalczyk <anna@studio-north.example>', 'Umowa', 'Pani Anno, czekam na poprawki.', '<anna1@latarnia.example>', 100), ['\\Seen'])
  await sentConn.logout()

  const acc = await accounts.addAccount({
    email: 'alice@test.local', name: 'Ola Nowicka', username: 'alice', password: 'pass',
    imap_host: HOST, imap_port: 3143, imap_secure: false, smtp_host: HOST, smtp_port: 3025, smtp_secure: false,
  })
  accounts.updateAccount(acc.id, { agent_access: 'triage', color: '#5b4cf0' })
  const s = sync.get(acc.id)
  await s.syncFolderList()
  await s.syncAll(true)
  await s.prefetchBodies()

  updateSettings({ gatekeeper: 'on', ai: { provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'gemma3:12b', ollamaEmbedModel: '', claudeModel: 'claude-opus-5-5', smartCategorize: false, autoSummaries: false, replyLanguage: 'auto', persona: 'Ola, współzałożycielka małego studia gier Latarnia Games. Piszę krótko i konkretnie.' } })
  const sig = drafts.saveSignature({ name: 'Latarnia Games', html: 'Ola Nowicka<br>Latarnia Games<br><a href="https://latarnia.example">latarnia.example</a>' })
  drafts.setDefaultSignature(acc.id, sig.id)
  drafts.saveTemplate({ name: 'Odpowiedź na pitch', subject: 'Re: {{Gra}}', html: '<p>Dzień dobry {{imię odbiorcy}},</p><p>dziękujemy za przesłanie {{Gra}}. Odezwiemy się do {{Termin}}.</p>' })
  saveRule({ name: 'Faktury do Księgowości', match: 'any', conditions: [{ field: 'subject', op: 'contains', value: 'faktura' }], actions: [{ type: 'label', value: 'Księgowość' }] })

  const list = Q.listThreads({ kind: 'unified', role: 'inbox' }, { limit: 100 })
  const find = (needle: string) => list.find((t) => t.subject.includes(needle))!
  A.pin([find('Umowa wydawnicza').thread_id], true, 'cli')
  A.snooze([find('Muzyka do traileru').thread_id], Date.now() + 26 * 3600_000, 'cli')
  A.markRead([find('płatność').thread_id, find('Nagranie').thread_id, find('Niedzielny').thread_id], true, 'cli')
  A.acceptSenders(['kasia.nowicka@example.pl', 'marek@indiefund.example'], 'cli')
  const d = drafts.saveDraft({ reply_to_message_id: find('Pitch deck').latest_message_id, markdown: 'Marek, prognozę prześlę jutro do południa.' })
  void d
  const sched = drafts.saveDraft({ account_id: acc.id, to: ['sebastian@pixelforge.example'], subject: 'Plan na premierę', markdown: 'Sebastian, w poniedziałek ustalamy datę premiery.' })
  drafts.sendDraft(sched.id, { sendAt: Date.now() + 3 * 86400_000 })
  await processOps()

  const srcId = await cal.addCalendarSource({ kind: 'local', name: 'Mój kalendarz' })
  void srcId
  const day = new Date()
  day.setHours(10, 0, 0, 0)
  await cal.createEvent({ summary: 'Weekly sync z PixelForge', start: day.getTime() + 86400_000, end: day.getTime() + 86400_000 + 3600_000, location: 'Discord' })
  await cal.createEvent({ summary: 'Steam Next Fest — przygotowanie dema', start: day.getTime() + 3 * 86400_000 + 4 * 3600_000, end: day.getTime() + 3 * 86400_000 + 6 * 3600_000 })
  await cal.createEvent({ summary: 'Urodziny Kasi', start: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 4).getTime(), end: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 5).getTime(), all_day: true })

  await sync.stopAll()
  smtp.close()
  console.log('demo profile ready:', process.env.OCTO_HOME)
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)
