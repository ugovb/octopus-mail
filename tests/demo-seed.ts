// Fills a throwaway demo profile (OCTO_HOME) with realistic mail on the local GreenMail server,
// so the UI can be exercised and screenshotted without touching real accounts.
// Usage: node scripts/demo.mjs seed [en]   (OCTO_HOME and OCTO_SECRETS=file are set by the wrapper)
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

// Demo content in Polish (default) or English: OCTO_DEMO_LANG=en (node scripts/demo.mjs seed en).
const PL = {
  lang: 'pl' as 'pl' | 'en',
  me: 'Ola Nowicka',
  folders: ['Projekty', 'Projekty/Strażnik Latarni', 'Księgowość'],
  mails: [
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
  ] as nodemailer.SendMailOptions[],
  invite: { summary: 'Omówienie umowy wydawniczej', organizer: 'Anna Kowalczyk', subject: 'Zaproszenie: Omówienie umowy wydawniczej', text: 'Zapraszam na rozmowę o umowie.' },
  sent: [
    ['Marek Wiśniewski <marek@indiefund.example>', 'Pitch deck — Strażnik Latarni', 'Cześć Marek, w załączeniu deck. Ola', '<pitch1@latarnia.example>', 40],
    ['Sebastian Nowak <sebastian@pixelforge.example>', 'Kamera i zoom', 'Sebastian, porównaj proszę płynność zoomu z poprzednim buildem.', '<cam1@latarnia.example>', 60],
    ['Kasia <kasia.nowicka@example.pl>', 'Re: zdjęcia', 'Dzięki! :)', '<kasia1@latarnia.example>', 200],
    ['Tomek <tomek@pixelforge.example>', 'Trailer', 'Tomek, potrzebujemy muzyki do traileru.', '<tom1@latarnia.example>', 150],
    ['Anna Kowalczyk <anna@studio-north.example>', 'Umowa', 'Pani Anno, czekam na poprawki.', '<anna1@latarnia.example>', 100],
  ] as [string, string, string, string, number][],
  persona: 'Ola, współzałożycielka małego studia gier Latarnia Games. Piszę krótko i konkretnie.',
  signature: { name: 'Latarnia Games', html: 'Ola Nowicka<br>Latarnia Games<br><a href="https://latarnia.example">latarnia.example</a>' },
  template: { name: 'Odpowiedź na pitch', subject: 'Re: {{Gra}}', html: '<p>Dzień dobry {{imię odbiorcy}},</p><p>dziękujemy za przesłanie {{Gra}}. Odezwiemy się do {{Termin}}.</p>' },
  rule: { name: 'Faktury do Księgowości', match: 'any' as const, conditions: [{ field: 'subject' as const, op: 'contains' as const, value: 'faktura' }], actions: [{ type: 'label' as const, value: 'Księgowość' }] },
  find: { pin: 'Umowa wydawnicza', snooze: 'Muzyka do traileru', read: ['płatność', 'Nagranie', 'Niedzielny'], draftReply: 'Pitch deck' },
  accept: ['kasia.nowicka@example.pl', 'marek@indiefund.example'],
  draftReply: 'Marek, prognozę prześlę jutro do południa.',
  scheduled: { subject: 'Plan na premierę', body: 'Sebastian, w poniedziałek ustalamy datę premiery.' },
  calendar: { name: 'Mój kalendarz', sync: 'Weekly sync z PixelForge', fest: 'Steam Next Fest — przygotowanie dema', birthday: 'Urodziny Kasi' },
}

const EN: typeof PL = {
  lang: 'en',
  me: 'Emma Clarke',
  folders: ['Projects', 'Projects/Lighthouse Keeper', 'Accounting'],
  mails: [
    { from: 'Sebastian Novak <sebastian@pixelforge.example>', subject: 'Build 0.9.3 — ready for testing', date: ago(0.6), messageId: '<build093@pixelforge.example>',
      text: 'Hi Emma,\n\nI pushed build 0.9.3 to Steam (beta branch). Camera and zoom are much smoother now.\nLet me know by Friday if we can send it to the testers.\n\nCheers,\nSebastian',
      attachments: [{ filename: 'changelog-0.9.3.pdf', content: Buffer.from('%PDF-1.4 changelog') }] },
    { from: 'Anna Becker <anna@studio-north.example>', subject: 'Publishing agreement — changes', date: ago(2),
      html: '<p>Hi Emma,</p><p>attached is the agreement with our changes to §4 (revenue split) and §7 (port rights).</p><p>Could we talk on <b>Thursday at 11:00</b>?</p><p>Best regards<br>Anna Becker<br>Studio North</p>',
      attachments: [{ filename: 'Publishing_agreement_v3.docx', content: Buffer.from('docx') }] },
    { from: 'Steam <noreply@steampowered.com>', subject: 'Your game has been approved for release', date: ago(3), text: 'Congratulations! Your build has been approved. You can now set a release date in Steamworks.' },
    { from: 'GitHub <notifications@github.com>', subject: '[lighthouse-games/website] Fix newsletter signup (#42)', date: ago(4), text: 'merged #42 into main.', headers: { 'X-GitHub-Reason': 'author' } },
    { from: 'TechDeals <newsletter@techdeals.example>', subject: 'Today only: 40% off electronics 🎧', date: ago(5), html: '<h2>Big sale</h2><p>Headphones, monitors, keyboards — up to 40% off.</p><img src="https://example.com/banner.jpg" width="600"><img src="https://track.example.com/open.gif" width="1" height="1">', headers: { 'List-Unsubscribe': '<https://techdeals.example/unsub>, <mailto:unsub@techdeals.example>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', Precedence: 'bulk' } },
    { from: 'Game Developer <newsletter@gamedeveloper.example>', subject: 'This week: Steam Next Fest postmortems', date: ago(9), html: '<p>Five indie devs share their Next Fest numbers.</p>', headers: { 'List-Unsubscribe': '<mailto:leave@gamedeveloper.example>', Precedence: 'list' } },
    { from: 'CloudHost <billing@cloudhost.example>', subject: 'Invoice INV-2026-10-1234', date: ago(20), text: 'Attached is the invoice for hosting lighthouse.example: €59.00. Due date: 27 Oct 2026.', attachments: [{ filename: 'INV_2026_10_1234.pdf', content: Buffer.from('%PDF-1.4 invoice') }] },
    { from: 'Mark Wilson <mark@indiefund.example>', subject: 'Re: Pitch deck — Lighthouse Keeper', date: ago(26), inReplyTo: '<pitch1@lighthouse.example>', references: ['<pitch1@lighthouse.example>'],
      text: 'Emma, I went through the deck. We have questions about the marketing budget and the console plans. Could you send a 12-month sales forecast?\n\nMark' },
    { from: 'Kate <kate.clarke@example.com>', subject: 'Sunday lunch 🍝', date: ago(30), text: 'Hi! Are you coming on Sunday at 2? Mum is making lasagne :)' },
    { from: 'New Contact <hello@streamer-agency.example>', subject: 'Partnership: 12 streamers for your launch', date: ago(33), text: 'Hello, we run a streamer agency and have a campaign proposal for your launch.' },
    { from: 'Zoom <no-reply@zoom.us>', subject: 'Your meeting recording is ready', date: ago(50), text: 'The recording of “Weekly sync” is available for 30 days.' },
    { from: 'Substack <indiegames@substack.example>', subject: 'The state of indie publishing in 2026', date: ago(72), html: '<p>Long read about publishers, advances and revenue splits.</p>', headers: { 'List-Unsubscribe': '<https://substack.example/unsub>', 'List-Id': 'indiegames.substack.example' } },
    { from: 'Tom <tom@pixelforge.example>', subject: 'Trailer music', date: ago(96), text: 'Sending 3 versions of the trailer music, let me know which one works best.', attachments: [{ filename: 'trailer_v1.mp3', content: Buffer.from('ID3') }, { filename: 'trailer_v2.mp3', content: Buffer.from('ID3') }] },
    { from: 'PayPal <service@paypal.example>', subject: 'Payment received: $1,250.00 USD', date: ago(120), text: 'You received a payment from Humble Bundle.' },
  ],
  invite: { summary: 'Publishing agreement review', organizer: 'Anna Becker', subject: 'Invitation: Publishing agreement review', text: "Let's go through the agreement together." },
  sent: [
    ['Mark Wilson <mark@indiefund.example>', 'Pitch deck — Lighthouse Keeper', 'Hi Mark, the deck is attached. Emma', '<pitch1@lighthouse.example>', 40],
    ['Sebastian Novak <sebastian@pixelforge.example>', 'Camera and zoom', 'Sebastian, could you compare the zoom with the previous build?', '<cam1@lighthouse.example>', 60],
    ['Kate <kate.clarke@example.com>', 'Re: photos', 'Thanks! :)', '<kate1@lighthouse.example>', 200],
    ['Tom <tom@pixelforge.example>', 'Trailer', 'Tom, we need music for the trailer.', '<tom1@lighthouse.example>', 150],
    ['Anna Becker <anna@studio-north.example>', 'Agreement', 'Hi Anna, looking forward to your changes.', '<anna1@lighthouse.example>', 100],
  ],
  persona: 'Emma, co-founder of the small game studio Lighthouse Games. I write short and to the point.',
  signature: { name: 'Lighthouse Games', html: 'Emma Clarke<br>Lighthouse Games<br><a href="https://lighthouse.example">lighthouse.example</a>' },
  template: { name: 'Pitch reply', subject: 'Re: {{Game}}', html: '<p>Hi,</p><p>thanks for sending {{Game}}. We will get back to you by {{Deadline}}.</p>' },
  rule: { name: 'Invoices to Accounting', match: 'any', conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }], actions: [{ type: 'label', value: 'Accounting' }] },
  find: { pin: 'Publishing agreement — changes', snooze: 'Trailer music', read: ['Payment', 'recording', 'Sunday'], draftReply: 'Pitch deck' },
  accept: ['kate.clarke@example.com', 'mark@indiefund.example'],
  draftReply: "Mark, I'll send the forecast by noon tomorrow.",
  scheduled: { subject: 'Launch plan', body: 'Sebastian, on Monday we pick the release date.' },
  calendar: { name: 'My calendar', sync: 'Weekly sync with PixelForge', fest: 'Steam Next Fest — demo prep', birthday: "Kate's birthday" },
}
const L = process.env.OCTO_DEMO_LANG === 'en' ? EN : PL

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
  for (const name of ['Sent', 'Drafts', 'Trash', 'Junk', 'Archive', ...L.folders]) await c.mailboxCreate(name).catch(() => undefined)
  await c.logout()

  const to = `${L.me} <alice@test.local>`
  for (const m of L.mails) await smtp.sendMail({ to, ...m })

  // a meeting invitation (iTIP REQUEST)
  const start = new Date()
  start.setDate(start.getDate() + 2)
  start.setHours(11, 0, 0, 0)
  const fmt = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Demo//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT',
    'UID:demo-invite-1@studio-north.example', `DTSTAMP:${fmt(new Date())}`, `DTSTART:${fmt(start)}`, `DTEND:${fmt(new Date(start.getTime() + 3600_000))}`,
    `SUMMARY:${L.invite.summary}`, 'LOCATION:https://meet.google.com/abc-defg-hij', `ORGANIZER;CN=${L.invite.organizer}:mailto:anna@studio-north.example`,
    `ATTENDEE;CN=${L.me};PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:alice@test.local`, 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n')
  await smtp.sendMail({ to, from: `${L.invite.organizer} <anna@studio-north.example>`, subject: L.invite.subject, date: ago(1), text: L.invite.text, icalEvent: { method: 'REQUEST', content: ics } })

  // the user's own sent mail (so Smart Inbox knows who is a real contact)
  const sentConn = new ImapFlow({ host: HOST, port: 3143, secure: false, auth: { user: 'alice', pass: 'pass' }, logger: false } as never)
  await sentConn.connect()
  const sentRaw = (to2: string, subject: string, body: string, id: string, h: number) =>
    new Promise<Buffer>((resolve, reject) =>
      new MailComposer({ from: `${L.me} <alice@test.local>`, to: to2, subject, text: body, messageId: id, date: ago(h) })
        .compile()
        .build((err, msg) => (err ? reject(err) : resolve(msg))),
    )
  for (const [to2, subject, body, id, h] of L.sent) await sentConn.append('Sent', await sentRaw(to2, subject, body, id, h), ['\\Seen'])
  await sentConn.logout()

  const acc = await accounts.addAccount({
    email: 'alice@test.local', name: L.me, username: 'alice', password: 'pass',
    imap_host: HOST, imap_port: 3143, imap_secure: false, smtp_host: HOST, smtp_port: 3025, smtp_secure: false,
  })
  accounts.updateAccount(acc.id, { agent_access: 'triage', color: '#5b4cf0' })
  const s = sync.get(acc.id)
  await s.syncFolderList()
  await s.syncAll(true)
  await s.prefetchBodies()

  updateSettings({ language: L.lang, gatekeeper: 'on', ai: { provider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'gemma3:12b', ollamaEmbedModel: '', claudeModel: 'claude-opus-5-5', smartCategorize: false, autoSummaries: false, replyLanguage: 'auto', persona: L.persona } })
  const sig = drafts.saveSignature(L.signature)
  drafts.setDefaultSignature(acc.id, sig.id)
  drafts.saveTemplate(L.template)
  saveRule(L.rule)

  const list = Q.listThreads({ kind: 'unified', role: 'inbox' }, { limit: 100 })
  const find = (needle: string) => list.find((t) => t.subject.includes(needle))!
  A.pin([find(L.find.pin).thread_id], true, 'cli')
  A.snooze([find(L.find.snooze).thread_id], Date.now() + 26 * 3600_000, 'cli')
  A.markRead(L.find.read.map((n) => find(n).thread_id), true, 'cli')
  A.acceptSenders(L.accept, 'cli')
  const d = drafts.saveDraft({ reply_to_message_id: find(L.find.draftReply).latest_message_id, markdown: L.draftReply })
  void d
  const sched = drafts.saveDraft({ account_id: acc.id, to: ['sebastian@pixelforge.example'], subject: L.scheduled.subject, markdown: L.scheduled.body })
  drafts.sendDraft(sched.id, { sendAt: Date.now() + 3 * 86400_000 })
  await processOps()

  const srcId = await cal.addCalendarSource({ kind: 'local', name: L.calendar.name })
  void srcId
  const day = new Date()
  day.setHours(10, 0, 0, 0)
  await cal.createEvent({ summary: L.calendar.sync, start: day.getTime() + 86400_000, end: day.getTime() + 86400_000 + 3600_000, location: 'Discord' })
  await cal.createEvent({ summary: L.calendar.fest, start: day.getTime() + 3 * 86400_000 + 4 * 3600_000, end: day.getTime() + 3 * 86400_000 + 6 * 3600_000 })
  await cal.createEvent({ summary: L.calendar.birthday, start: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 4).getTime(), end: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 5).getTime(), all_day: true })

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
