// Smoke tests for src/core/calendar + contacts-sync wiring. Run: node --test tests/calendar.test.mjs
// Core sources use extensionless imports, so they are bundled with esbuild into a temp dir first
// (packages stay external and resolve from the project). Data lives in a fresh temp OCTO_HOME,
// secrets stay in memory, and no network or real account is ever touched.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

process.env.TZ = 'Europe/Warsaw'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-calendar-test-'))
process.env.OCTO_HOME = path.join(tmp, 'home')
process.env.OCTO_SECRETS = 'memory'
process.env.OCTO_QUIET = '1'

const projectRequire = createRequire(path.join(root, 'package.json'))
let M // bundled modules
const sent = [] // captured iTIP e-mails
const events = [] // captured core events
let accountId

const local = (y, m, d, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi).getTime()
const utc = (y, m, d, h = 0, mi = 0) => Date.UTC(y, m - 1, d, h, mi)

const VTZ_WARSAW = `BEGIN:VTIMEZONE
TZID:Europe/Warsaw
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE`

const crlf = (s) => s.replace(/\r?\n/g, '\r\n')
const unfold = (s) => s.replace(/\r?\n[ \t]/g, '')

const WEEKLY = crlf(`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
${VTZ_WARSAW}
BEGIN:VEVENT
UID:weekly-1@test
DTSTAMP:20260901T000000Z
DTSTART;TZID=Europe/Warsaw:20261006T100000
DTEND;TZID=Europe/Warsaw:20261006T110000
RRULE:FREQ=WEEKLY;BYDAY=TU
EXDATE;TZID=Europe/Warsaw:20261020T100000
SUMMARY:Standup
LOCATION:https://meet.google.com/abc-defg-hij
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-PT5M
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:weekly-1@test
DTSTAMP:20260901T000000Z
RECURRENCE-ID;TZID=Europe/Warsaw:20261027T100000
DTSTART;TZID=Europe/Warsaw:20261028T150000
DTEND;TZID=Europe/Warsaw:20261028T160000
SUMMARY:Standup (przeniesiony)
END:VEVENT
END:VCALENDAR
`)

const TZ_MIX = crlf(`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VTIMEZONE
TZID:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:20070311T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:20071104T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:ny@test
DTSTAMP:20260901T000000Z
DTSTART;TZID=America/New_York:20261015T090000
DTEND;TZID=America/New_York:20261015T100000
SUMMARY:New York call
END:VEVENT
BEGIN:VEVENT
UID:waw-no-vtimezone@test
DTSTAMP:20260901T000000Z
DTSTART;TZID=Europe/Warsaw:20261110T090000
DURATION:PT30M
SUMMARY:Warsaw without VTIMEZONE
END:VEVENT
BEGIN:VEVENT
UID:outlook@test
DTSTAMP:20260901T000000Z
DTSTART;TZID=Central European Standard Time:20260715T090000
DTEND;TZID=Central European Standard Time:20260715T093000
SUMMARY:Outlook Windows TZID
DESCRIPTION:Teams: <https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d>
END:VEVENT
BEGIN:VEVENT
UID:utc@test
DTSTAMP:20260901T000000Z
DTSTART:20261015T090000Z
DTEND:20261015T093000Z
SUMMARY:UTC
END:VEVENT
END:VCALENDAR
`)

const ALLDAY = crlf(`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:allday@test
DTSTAMP:20260901T000000Z
DTSTART;VALUE=DATE:20261101
DTEND;VALUE=DATE:20261103
SUMMARY:Wyjazd
END:VEVENT
BEGIN:VEVENT
UID:sloppy-date@test
DTSTAMP:20260901T000000Z
DTSTART:20261224
SUMMARY:Wigilia
END:VEVENT
END:VCALENDAR
`)

const INVITE = crlf(`BEGIN:VCALENDAR
PRODID:-//Google Inc//Google Calendar 70.9054//EN
VERSION:2.0
CALSCALE:GREGORIAN
METHOD:REQUEST
BEGIN:VEVENT
DTSTART:20261020T120000Z
DTEND:20261020T130000Z
DTSTAMP:20261013T080000Z
ORGANIZER;CN=Anna Nowak:mailto:anna@firma.pl
UID:invite-123@google.com
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE;CN=Anna Nowak;X-NUM-GUESTS=0:mailto:anna@firma.pl
ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE;CN=Piotr;X-NUM-GUESTS=0:mailto:Piotr@Example.com
X-GOOGLE-CONFERENCE:https://meet.google.com/xyz-abcd-efg
CREATED:20261013T080000Z
DESCRIPTION:Omówienie budżetu Q4.\\n\\nDołącz przez Google Meet: https://meet.google.com/xyz-abcd-efg
LAST-MODIFIED:20261013T080000Z
LOCATION:Sala 2
SEQUENCE:0
STATUS:CONFIRMED
SUMMARY:Budżet Q4
TRANSP:OPAQUE
END:VEVENT
END:VCALENDAR
`)

function vevent(uid, start, end, extra = '') {
  const f = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z'
  return crlf(`BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//EN
BEGIN:VEVENT
UID:${uid}
DTSTAMP:20260901T000000Z
DTSTART:${f(start)}
DTEND:${f(end)}
SUMMARY:${uid}
${extra}END:VEVENT
END:VCALENDAR
`)
}

async function parseMail(raw) {
  const { simpleParser } = projectRequire('mailparser')
  const mail = await simpleParser(raw)
  const cal = mail.attachments.find((a) => /calendar|ics/i.test(a.contentType))
  return { mail, ics: cal ? unfold(cal.content.toString('utf8')) : '' }
}

before(async () => {
  const entry = path.join(tmp, 'entry.ts')
  const imp = (p) => JSON.stringify(path.join(root, p).replace(/\\/g, '/'))
  fs.writeFileSync(
    entry,
    [
      `export * as cal from ${imp('src/core/calendar/index.ts')}`,
      `export * as store from ${imp('src/core/calendar/store.ts')}`,
      `export * as ical from ${imp('src/core/calendar/ical.ts')}`,
      `export * as tz from ${imp('src/core/calendar/tz.ts')}`,
      `export * as contacts from ${imp('src/core/contacts-sync.ts')}`,
      `export * as db from ${imp('src/core/db.ts')}`,
      `export { bus } from ${imp('src/core/events.ts')}`,
    ].join('\n'),
  )
  const outfile = path.join(tmp, 'calendar.bundle.cjs')
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    packages: 'external',
    logLevel: 'error',
    // externals resolve from the project, not from the temp dir
    banner: { js: `var require = require('node:module').createRequire(${JSON.stringify(path.join(root, 'package.json'))});` },
  })
  M = createRequire(import.meta.url)(outfile)
  M.cal.itipTransport.send = async (acc, raw, envelope) => {
    sent.push({ acc, raw: raw.toString('utf8'), envelope })
  }
  M.bus.onEvent((ev) => events.push(ev))
  accountId = M.db.insert('accounts', {
    email: 'piotr@example.com',
    name: 'Piotr',
    username: 'piotr@example.com',
    imap_host: 'imap.example.invalid',
    smtp_host: 'smtp.example.invalid',
    created_at: Date.now(),
  })
  M.db.insert('identities', { account_id: accountId, email: 'piotr@example.com', name: 'Piotr', is_default: 1 })
})

after(() => {
  try {
    M?.db.closeDb()
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('weekly event: EXDATE + moved RECURRENCE-ID override over 5 weeks (DST change inside)', () => {
  const from = local(2026, 10, 5)
  const to = local(2026, 11, 9)
  const occ = M.ical.expandIcs(WEEKLY, from, to)
  assert.deepEqual(
    occ.map((o) => o.start),
    [utc(2026, 10, 6, 8), utc(2026, 10, 13, 8), utc(2026, 10, 28, 14), utc(2026, 11, 3, 9)],
  )
  assert.deepEqual(occ.map((o) => o.summary), ['Standup', 'Standup', 'Standup (przeniesiony)', 'Standup'])
  // the moved instance keeps its original slot as occurrence_start
  assert.equal(occ[2].occurrence_start, utc(2026, 10, 27, 9))
  assert.equal(occ[2].end - occ[2].start, 3600_000)
  assert.ok(!occ.some((o) => o.start === utc(2026, 10, 20, 8)), 'EXDATE instance must be gone')
  assert.equal(occ[0].conference_url, 'https://meet.google.com/abc-defg-hij')
  assert.deepEqual(occ[0].alarms, [{ minutesBefore: 5 }])
})

test('TZID handling: VTIMEZONE, IANA without VTIMEZONE, Windows names, UTC; conference links', () => {
  const occ = M.ical.expandIcs(TZ_MIX, utc(2026, 1, 1), utc(2027, 1, 1))
  const by = Object.fromEntries(occ.map((o) => [o.uid, o]))
  assert.equal(by['ny@test'].start, utc(2026, 10, 15, 13)) // 09:00 EDT
  assert.equal(by['waw-no-vtimezone@test'].start, utc(2026, 11, 10, 8)) // 09:00 CET
  assert.equal(by['waw-no-vtimezone@test'].end - by['waw-no-vtimezone@test'].start, 30 * 60_000)
  assert.equal(by['outlook@test'].start, utc(2026, 7, 15, 7)) // 09:00 CEST
  assert.equal(by['utc@test'].start, utc(2026, 10, 15, 9))
  assert.equal(by['outlook@test'].conference_url, 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d')
  assert.equal(M.ical.extractConferenceUrl('Zoom: https://us02web.zoom.us/j/123456789?pwd=abc. Do zobaczenia'), 'https://us02web.zoom.us/j/123456789?pwd=abc')
  // generated VTIMEZONE follows EU rules
  const vt = M.tz.vtimezoneFor('Europe/Warsaw', 2026)
  assert.match(vt, /TZOFFSETTO:\+0200/)
  assert.match(vt, /BYMONTH=3;BYDAY=-1SU/)
  assert.match(vt, /BYMONTH=10;BYDAY=-1SU/)
})

test('all-day events are local-midnight based (also DTSTART without VALUE=DATE)', () => {
  const occ = M.ical.expandIcs(ALLDAY, local(2026, 10, 1), local(2027, 1, 1))
  const trip = occ.find((o) => o.uid === 'allday@test')
  assert.equal(trip.all_day, true)
  assert.equal(trip.start, local(2026, 11, 1))
  assert.equal(trip.end, local(2026, 11, 3))
  const eve = occ.find((o) => o.uid === 'sloppy-date@test')
  assert.equal(eve.all_day, true)
  assert.equal(eve.start, local(2026, 12, 24))
  assert.equal(eve.end, local(2026, 12, 25))
  assert.equal(M.ical.isTransparent(trip), true, 'all-day without TRANSP is free time')
})

let localCalId
let dentistId

test('local calendar: create / update / delete', async () => {
  const srcId = await M.cal.addCalendarSource({ kind: 'local' })
  assert.equal(await M.cal.addCalendarSource({ kind: 'local' }), srcId, 'only one local source')
  const cals = M.cal.listCalendars()
  assert.equal(cals.length, 1)
  assert.equal(cals[0].name, 'Mój kalendarz')
  assert.equal(cals[0].is_default, true)
  assert.equal(cals[0].readonly, false)
  localCalId = cals[0].id

  const ev = await M.cal.createEvent({ summary: 'Dentysta', start: local(2026, 11, 16, 9), end: local(2026, 11, 16, 10), location: 'ul. Zdrowa 1' }, 'test')
  dentistId = ev.id
  assert.equal(ev.summary, 'Dentysta')
  assert.equal(ev.start, local(2026, 11, 16, 9))
  assert.equal(ev.calendar_name, 'Mój kalendarz')
  const row = { ics: unfold(M.store.getEventRow(ev.id).ics) }
  assert.match(row.ics, /DTSTART;TZID=Europe\/Warsaw:20261116T090000/)
  assert.match(row.ics, /BEGIN:VTIMEZONE/)
  assert.match(row.ics, /TRIGGER:-PT10M/)
  assert.equal(M.cal.listEvents(local(2026, 11, 16), local(2026, 11, 17)).length, 1)

  const upd = await M.cal.updateEvent(ev.id, { summary: 'Dentysta (przełożone)', start: local(2026, 11, 17, 9), end: local(2026, 11, 17, 10) }, 'test')
  assert.equal(upd.summary, 'Dentysta (przełożone)')
  assert.equal(M.cal.listEvents(local(2026, 11, 16), local(2026, 11, 17)).length, 0)
  const moved = M.cal.listEvents(local(2026, 11, 17), local(2026, 11, 18))
  assert.equal(moved.length, 1)
  assert.equal(moved[0].start, local(2026, 11, 17, 9))
  assert.equal(moved[0].location, 'ul. Zdrowa 1')

  const allDay = await M.cal.createEvent({ summary: 'Urlop', start: local(2026, 11, 20), end: local(2026, 11, 20, 23, 59), all_day: true }, 'test')
  assert.equal(allDay.all_day, true)
  assert.equal(allDay.end, local(2026, 11, 21))
  assert.match(unfold(M.store.getEventRow(allDay.id).ics), /DTSTART;VALUE=DATE:20261120/)

  const tmpEv = await M.cal.createEvent({ summary: 'Do usunięcia', start: local(2026, 11, 19, 12), end: local(2026, 11, 19, 13) }, 'test')
  await M.cal.deleteEvent(tmpEv.id, 'test')
  assert.equal(M.cal.getEvent(tmpEv.id), null)

  const actions = M.db.all("SELECT action FROM history WHERE actor = 'test'").map((r) => r.action)
  for (const a of ['calendar.create', 'calendar.update', 'calendar.delete']) assert.ok(actions.includes(a), a)
  assert.ok(events.some((e) => e.type === 'calendar-changed'))
  assert.equal(sent.length, 0, 'no attendees → no e-mail')
})

test('stored recurring event: listEvents expansion and deleting a single occurrence', async () => {
  const r = M.store.upsertEventRow(localCalId, WEEKLY)
  assert.ok(r.changed)
  const from = local(2026, 10, 5)
  const to = local(2026, 11, 9)
  let list = M.cal.listEvents(from, to).filter((e) => e.uid === 'weekly-1@test')
  assert.equal(list.length, 4)
  assert.ok(list.every((e) => e.id === r.id && e.recurring))
  assert.equal(new Set(list.map((e) => e.key)).size, 4, 'occurrence keys are unique')
  await M.cal.deleteEvent(r.id, 'test', { occurrence_start: utc(2026, 10, 13, 8) })
  list = M.cal.listEvents(from, to).filter((e) => e.uid === 'weekly-1@test')
  assert.deepEqual(list.map((e) => e.start), [utc(2026, 10, 6, 8), utc(2026, 10, 28, 14), utc(2026, 11, 3, 9)])
  // edit one instance only
  await M.cal.updateEvent(r.id, { summary: 'Standup specjalny' }, 'test', { occurrence_start: utc(2026, 11, 3, 9) })
  list = M.cal.listEvents(from, to).filter((e) => e.uid === 'weekly-1@test')
  assert.deepEqual(list.map((e) => e.summary), ['Standup', 'Standup (przeniesiony)', 'Standup specjalny'])
})

test('read-only calendar refuses writes with a Polish error', async () => {
  const src = M.db.get("SELECT id FROM cal_sources WHERE kind = 'local'")
  const roId = M.db.insert('calendars', { source_id: src.id, remote_url: 'local:ro', name: 'Święta', readonly: 1, enabled: 1, is_default: 0 })
  await assert.rejects(
    () => M.cal.createEvent({ summary: 'x', start: local(2026, 11, 2, 9), end: local(2026, 11, 2, 10), calendar_id: roId }, 'test'),
    /tylko do odczytu/,
  )
  M.db.run('DELETE FROM calendars WHERE id = ?', roId)
})

test('attendees: iTIP REQUEST on create, CANCEL on delete (sent from the account)', async () => {
  sent.length = 0
  const ev = await M.cal.createEvent(
    { summary: 'Przegląd projektu', start: local(2026, 11, 24, 13), end: local(2026, 11, 24, 14), attendees: ['Jan Kowalski <jan@firma.pl>'] },
    'test',
  )
  assert.equal(ev.is_organizer, true)
  assert.equal(ev.my_status, 'ACCEPTED')
  assert.deepEqual(ev.attendees.map((a) => a.email).sort(), ['jan@firma.pl', 'piotr@example.com'])
  assert.match(unfold(M.store.getEventRow(ev.id).ics), /SCHEDULE-AGENT=CLIENT/)
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].envelope, { from: 'piotr@example.com', to: ['jan@firma.pl'] })
  assert.match(sent[0].raw, /text\/calendar; charset=utf-8; method=REQUEST/i)
  const req = await parseMail(sent[0].raw)
  assert.match(req.mail.subject, /^Zaproszenie: Przegląd projektu/)
  assert.match(req.ics, /METHOD:REQUEST/)
  assert.match(req.ics, /ORGANIZER;CN=Piotr:mailto:piotr@example.com/)
  assert.match(req.ics, /PARTSTAT=NEEDS-ACTION;RSVP=TRUE/)
  assert.doesNotMatch(req.ics, /SCHEDULE-AGENT/)

  await M.cal.deleteEvent(ev.id, 'test')
  assert.equal(sent.length, 2)
  const cancel = await parseMail(sent[1].raw)
  assert.match(cancel.mail.subject, /^Odwołane: Przegląd projektu/)
  assert.match(cancel.ics, /METHOD:CANCEL/)
  assert.match(cancel.ics, /STATUS:CANCELLED/)
  assert.match(cancel.ics, /SEQUENCE:1/)
})

test('parseInvite fixture (REQUEST) + RSVP of a stored invitation sends a REPLY', async () => {
  const info = M.cal.parseInviteIcs(INVITE, ['piotr@example.com'])
  assert.equal(info.method, 'REQUEST')
  assert.equal(info.uid, 'invite-123@google.com')
  assert.equal(info.summary, 'Budżet Q4')
  assert.equal(info.location, 'Sala 2')
  assert.equal(info.start, utc(2026, 10, 20, 12))
  assert.equal(info.end, utc(2026, 10, 20, 13))
  assert.deepEqual(info.organizer, { email: 'anna@firma.pl', name: 'Anna Nowak' })
  assert.equal(info.attendees.length, 2)
  assert.equal(info.my_email, 'piotr@example.com')
  assert.equal(info.my_status, 'NEEDS-ACTION')
  assert.equal(info.conference_url, 'https://meet.google.com/xyz-abcd-efg')
  assert.match(info.description, /budżetu Q4\.\n\nDołącz/)

  const before = M.cal.inviteInfoFromIcs(INVITE, { messageId: 1, accountId })
  assert.equal(before.existing_event_id, null)

  // what rsvpInvite stores in the calendar
  const me = new Set(['piotr@example.com'])
  const resource = M.ical.inviteToResource(INVITE, me, 'TENTATIVE', { email: 'piotr@example.com', name: 'Piotr' })
  assert.doesNotMatch(resource, /^METHOD:/m)
  const stored = M.store.upsertEventRow(localCalId, resource)
  const now = M.cal.inviteInfoFromIcs(INVITE, { messageId: 1, accountId })
  assert.equal(now.existing_event_id, stored.id)
  assert.equal(now.existing_status, 'TENTATIVE')

  sent.length = 0
  await M.cal.rsvpEvent(stored.id, 'ACCEPTED', 'test')
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].envelope.to, ['anna@firma.pl'])
  assert.match(sent[0].raw, /method=REPLY/i)
  const reply = await parseMail(sent[0].raw)
  assert.match(reply.mail.subject, /^Zaakceptowano: Budżet Q4/)
  assert.match(reply.ics, /METHOD:REPLY/)
  assert.match(reply.ics, /UID:invite-123@google.com/)
  assert.match(reply.ics, /PARTSTAT=ACCEPTED/)
  assert.doesNotMatch(reply.ics, /anna@firma.pl[\s\S]*ATTENDEE[^\n]*anna/i)
  const ev = M.cal.getEvent(stored.id)
  assert.equal(ev.my_status, 'ACCEPTED')
  assert.equal(ev.is_organizer, false)

  // REPLY built straight from the invitation (what rsvpInvite e-mails)
  const r2 = unfold(M.ical.buildReplyIcs(INVITE, { email: 'piotr@example.com', name: 'Piotr' }, 'DECLINED', 'Nie dam rady'))
  assert.match(r2, /PARTSTAT=DECLINED/)
  assert.match(r2, /COMMENT:Nie dam rady/)
  assert.equal((r2.match(/^ATTENDEE/gm) || []).length, 1)
  await assert.rejects(() => M.cal.rsvpEvent(stored.id, 'MAYBE', 'test'), /Nieprawidłowa odpowiedź/)
})

test('availability: busy, transparent, declined and cancelled events; weekends', () => {
  M.store.upsertEventRow(localCalId, vevent('busy@test', local(2026, 11, 18, 10), local(2026, 11, 18, 11)))
  M.store.upsertEventRow(localCalId, vevent('free@test', local(2026, 11, 18, 12), local(2026, 11, 18, 13), 'TRANSP:TRANSPARENT\r\n'))
  M.store.upsertEventRow(
    localCalId,
    vevent('declined@test', local(2026, 11, 18, 14), local(2026, 11, 18, 15), 'ORGANIZER:mailto:x@y.pl\r\nATTENDEE;PARTSTAT=DECLINED:mailto:piotr@example.com\r\n'),
  )
  M.store.upsertEventRow(localCalId, vevent('cancelled@test', local(2026, 11, 18, 15), local(2026, 11, 18, 16), 'STATUS:CANCELLED\r\n'))
  const slots = M.cal.findAvailability({ from: local(2026, 11, 18), to: local(2026, 11, 19), durationMin: 60, allowPast: true })
  const hours = slots.map((s) => new Date(s.start).getHours() + new Date(s.start).getMinutes() / 60)
  assert.deepEqual(hours, [9, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 15.5, 16])
  assert.ok(slots.every((s) => s.end - s.start === 3600_000))

  const weekend = { from: local(2026, 11, 21), to: local(2026, 11, 23), durationMin: 30, allowPast: true }
  assert.equal(M.cal.findAvailability(weekend).length, 0)
  assert.equal(M.cal.findAvailability({ ...weekend, includeWeekends: true, workdayStart: 10, workdayEnd: 12 }).length, 8)
  assert.throws(() => M.cal.findAvailability({ from: 0, to: 1, durationMin: 0 }), /długość/)
})

test('alarms: VALARM lead time, fire once, toast text', () => {
  const at = local(2026, 11, 17, 8, 50) // "Dentysta (przełożone)" starts 09:00 with a 10-min VALARM
  const up = M.cal.upcomingAlarms(60_000, at)
  const a = up.find((x) => x.eventId === dentistId)
  assert.ok(a, 'alarm expected')
  assert.equal(a.minutesBefore, 10)
  assert.equal(a.fireAt, local(2026, 11, 17, 8, 50))
  events.length = 0
  const fired = M.cal.fireDueAlarms(at)
  assert.ok(fired.some((x) => x.eventId === dentistId))
  const toast = events.find((e) => e.type === 'toast' && e.message.includes('Dentysta'))
  assert.equal(toast.message, '📅 Dentysta (przełożone) za 10 min')
  assert.equal(M.cal.fireDueAlarms(at + 5000).length, 0, 'fires only once')
  assert.ok(!M.cal.upcomingAlarms(60_000, at).some((x) => x.eventId === dentistId))
})

test('parseInvite / rsvpInvite / applyInviteCancel on messages (part fetched through inviteSource)', async () => {
  const folderId = M.db.insert('folders', { account_id: accountId, path: 'INBOX', name: 'INBOX', role: 'inbox' })
  let uidSeq = 100
  const fixtures = {}
  const message = (ics) => {
    const id = M.db.insert('messages', { account_id: accountId, folder_id: folderId, uid: uidSeq++, subject: 'Zaproszenie', calendar_part: ics ? '2' : null, created_at: Date.now() })
    if (ics) fixtures[id] = ics
    return id
  }
  M.cal.inviteSource.load = async (_acc, messageId) => fixtures[messageId]
  const inv2 = INVITE.replace(/invite-123@google\.com/g, 'invite-456@google.com')
  const inv3 = INVITE.replace(/invite-123@google\.com/g, 'invite-789@google.com')
  const m2 = message(inv2)
  const m3 = message(inv3)
  assert.equal(await M.cal.parseInvite(message(null)), null)

  const info = await M.cal.parseInvite(m2)
  assert.equal(info.message_id, m2)
  assert.equal(info.method, 'REQUEST')
  assert.equal(info.existing_event_id, null)

  sent.length = 0
  await M.cal.rsvpInvite(m2, 'ACCEPTED', { comment: 'Będę', actor: 'test' })
  assert.equal(sent.length, 1)
  assert.deepEqual(sent[0].envelope, { from: 'piotr@example.com', to: ['anna@firma.pl'] })
  const reply = await parseMail(sent[0].raw)
  assert.match(reply.ics, /METHOD:REPLY/)
  assert.match(reply.ics, /COMMENT:Będę/)
  assert.match(reply.ics, /PARTSTAT=ACCEPTED/)
  assert.match(reply.mail.text, /akceptuje zaproszenie: Budżet Q4/)

  const stored = await M.cal.parseInvite(m2)
  assert.ok(stored.existing_event_id, 'accepted invitation lands in the default calendar')
  assert.equal(stored.existing_calendar_name, 'Mój kalendarz')
  assert.equal(stored.existing_status, 'ACCEPTED')
  const ev = M.cal.getEvent(stored.existing_event_id)
  assert.equal(ev.my_status, 'ACCEPTED')
  assert.equal(ev.conference_url, 'https://meet.google.com/xyz-abcd-efg')

  await M.cal.rsvpInvite(m2, 'TENTATIVE', { actor: 'test' })
  assert.equal((await M.cal.parseInvite(m2)).existing_status, 'TENTATIVE')
  assert.equal(M.db.all("SELECT id FROM events WHERE uid = 'invite-456@google.com'").length, 1)

  await M.cal.rsvpInvite(m3, 'DECLINED', { actor: 'test' })
  assert.equal(sent.length, 3)
  assert.equal(M.db.all("SELECT id FROM events WHERE uid = 'invite-789@google.com'").length, 0, 'declined invitations are not added')

  const cancel = message(inv2.replace('METHOD:REQUEST', 'METHOD:CANCEL').replace('STATUS:CONFIRMED', 'STATUS:CANCELLED').replace('SEQUENCE:0', 'SEQUENCE:1'))
  const c = await M.cal.parseInvite(cancel)
  assert.equal(c.method, 'CANCEL')
  assert.equal(c.status, 'CANCELLED')
  await assert.rejects(() => M.cal.rsvpInvite(cancel, 'ACCEPTED', { actor: 'test' }), /odwołane/)
  assert.equal(await M.cal.applyInviteCancel(cancel, 'test'), true)
  assert.equal(M.db.all("SELECT id FROM events WHERE uid = 'invite-456@google.com'").length, 0)
  assert.equal(sent.length, 3, 'attendee removing a cancelled event sends nothing')
})

test('contacts sync never throws without Google accounts', async () => {
  assert.equal(await M.contacts.syncAllContacts(), 0)
})
