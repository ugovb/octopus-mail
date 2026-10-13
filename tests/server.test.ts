// Home server end-to-end test against GreenMail (needs `npm run greenmail`).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

process.env.OCTO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-server-test-'))
process.env.OCTO_SECRETS = 'memory'
process.env.OCTO_QUIET = '1'
process.env.OCTO_INSECURE_TLS = '1'

import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import nodemailer from 'nodemailer'
import { decodeWire, encodeWire } from '../src/shared/wire'
import { createPairingCode } from '../src/server/auth'
import { runServer } from '../src/server/server'
import { sync } from '../src/core/sync'

const RUN = Date.now().toString(36)
let server: http.Server
let base = ''
let token = ''

async function api<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
  const r = await fetch(`${base}/api/call`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: encodeWire({ method, args }) })
  const j = decodeWire<{ result?: T; error?: string }>(await r.text())
  if (j.error) throw new Error(j.error)
  return j.result as T
}

async function waitFor(cond: () => Promise<boolean>, ms = 20000, label = 'condition') {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await cond()) return
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`timeout: ${label}`)
}

describe('Octopus Mail home server', () => {
  before(async () => {
    const webRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-web-'))
    fs.writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Octopus Mail</title>')
    server = await runServer({ port: 0, host: '127.0.0.1', webRoot })
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    await nodemailer.createTransport({ host: '127.0.0.1', port: 3025, secure: false, ignoreTLS: true }).sendMail({
      from: 'Bob <bob@test.local>', to: 'alice@test.local', subject: `Serwer ${RUN}`, text: 'Wiadomość do testu serwera.',
    })
  })

  after(async () => {
    server.close()
    await sync.stopAll()
  })

  it('is reachable but refuses unpaired clients', async () => {
    const info = await (await fetch(`${base}/api/info`)).json()
    assert.equal(info.name, 'octopus-mail-server')
    const r = await fetch(`${base}/api/call`, { method: 'POST', body: encodeWire({ method: 'listAccounts', args: [] }) })
    assert.equal(r.status, 401)
    const bad = await fetch(`${base}/api/pair`, { method: 'POST', body: encodeWire({ code: 'AAAA-BBBB', name: 'x' }) })
    assert.equal(bad.status, 403)
  })

  it('pairs a device with a one-time code', async () => {
    const { code } = createPairingCode()
    const r = await fetch(`${base}/api/pair`, { method: 'POST', body: encodeWire({ code, name: 'Laptop testowy' }) })
    const j = decodeWire<{ token: string; device: { name: string } }>(await r.text())
    assert.equal(j.device.name, 'Laptop testowy')
    assert.match(j.token, /^octo_/)
    token = j.token
    const again = await fetch(`${base}/api/pair`, { method: 'POST', body: encodeWire({ code, name: 'drugi' }) })
    assert.equal(again.status, 403, 'codes are single-use')
  })

  it('adds an account and syncs mail through the API', async () => {
    const acc = await api<{ id: number; email: string }>('addAccount', {
      email: 'alice@test.local', name: 'Alice', username: 'alice', password: 'pass',
      imap_host: '127.0.0.1', imap_port: 3143, imap_secure: false, smtp_host: '127.0.0.1', smtp_port: 3025, smtp_secure: false,
    })
    assert.equal(acc.email, 'alice@test.local')
    await waitFor(async () => (await api<{ subject: string }[]>('listThreads', { kind: 'smart' }, {})).some((t) => t.subject.includes(RUN)), 30000, 'synced thread')
  })

  it('pushes live events and streams results', async () => {
    const ctrl = new AbortController()
    const events: string[] = []
    const res = await fetch(`${base}/api/events`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal })
    const reader = res.body!.getReader()
    const pump = (async () => {
      const dec = new TextDecoder()
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }))
        if (done) break
        events.push(dec.decode(value))
      }
    })()
    const t = (await api<{ thread_id: number; subject: string }[]>('listThreads', { kind: 'smart' }, {})).find((x) => x.subject.includes(RUN))!
    await api('pin', [t.thread_id], true)
    await waitFor(async () => events.join('').includes('mailbox-changed'), 5000, 'SSE event')
    ctrl.abort()
    await pump

    await api('updateSettings', { ai: { provider: 'off' } })
    const s = await fetch(`${base}/api/stream`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: encodeWire({ method: 'aiRewrite', args: ['tekst', 'proofread'] }) })
    const lines = (await s.text()).trim().split('\n').map((l) => decodeWire<{ error?: string }>(l))
    assert.match(lines[lines.length - 1].error || '', /wyłączone/)
  })

  it('sends a scheduled message by itself (no client needed)', async () => {
    const d = await api<{ id: number }>('saveDraft', { account_id: 1, to: ['bob@test.local'], subject: `Zaplanowana z serwera ${RUN}`, markdown: 'Wysłana przez serwer domowy.' })
    await api('sendDraft', d.id, { sendAt: Date.now() + 1500 })
    await waitFor(async () => (await api<{ status: string }>('getDraft', d.id)).status === 'sent', 40000, 'server-side send')
  })

  it('uploads and serves attachments', async () => {
    const up = await fetch(`${base}/api/upload?name=notatka.txt`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: 'zawartość pliku' })
    const staged = decodeWire<{ result: { filename: string; path: string } }>(await up.text()).result
    assert.equal(staged.filename, 'notatka.txt')
    assert.equal(fs.readFileSync(staged.path, 'utf8'), 'zawartość pliku')
    const bytes = await api<{ filename: string; path: string }>('stageAttachment', 'bin.dat', new Uint8Array([0, 1, 2, 255]))
    assert.deepEqual([...fs.readFileSync(bytes.path)], [0, 1, 2, 255], 'binary arguments survive the wire format')
  })

  it('logs browsers in with a pairing code and protects writes from other sites', async () => {
    // the sign-in page follows the browser language
    const page = await fetch(`${base}/`)
    assert.match(await page.text(), /pairing code/i)
    const pagePl = await fetch(`${base}/`, { headers: { 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8' } })
    assert.match(await pagePl.text(), /kod parowania/i)
    const { code } = createPairingCode()
    const login = await fetch(`${base}/api/login`, { method: 'POST', body: new URLSearchParams({ code }), redirect: 'manual' })
    assert.equal(login.status, 303)
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
    assert.match(cookie, /^octo_token=/)
    const app = await fetch(`${base}/`, { headers: { cookie } })
    assert.match(await app.text(), /<title>Octopus Mail<\/title>/)
    const forged = await fetch(`${base}/api/call`, { method: 'POST', headers: { cookie }, body: encodeWire({ method: 'listAccounts', args: [] }) })
    assert.equal(forged.status, 403, 'cookie-only writes need the X-Octo header')
    const ok = await fetch(`${base}/api/call`, { method: 'POST', headers: { cookie, 'X-Octo': '1' }, body: encodeWire({ method: 'listAccounts', args: [] }) })
    assert.equal(ok.status, 200)
  })

  it('revoking a device cuts it off', async () => {
    const me = decodeWire<{ device: { id: string } }>(await (await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${token}` } })).text())
    await fetch(`${base}/api/devices/${me.device.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
    const r = await fetch(`${base}/api/call`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: encodeWire({ method: 'listAccounts', args: [] }) })
    assert.equal(r.status, 401)
  })
})
