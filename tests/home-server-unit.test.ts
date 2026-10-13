// Home-server pieces that need no mail server: the secrets file shared by the service and the
// `octo` CLI, and recovery after a crashed engine (systemd restarts it at once).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'

process.env.OCTO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-home-unit-'))
process.env.OCTO_SECRETS = 'server'
process.env.OCTO_QUIET = '1'

import { engineRunning } from '../src/core/boot'
import { getSecret, secretStoreName, setSecret } from '../src/core/secrets'
import { setKV } from '../src/core/settings'

const file = path.join(process.env.OCTO_HOME, 'secrets.json')

/** What another process (the CLI next to the service) does: rewrite the file. */
function writeFromOtherProcess(change: (s: Record<string, string>) => void) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
  change(data)
  fs.writeFileSync(file, JSON.stringify(data))
  const t = new Date(Date.now() + 5000)
  fs.utimesSync(file, t, t)
}

describe('home server without a mail server', () => {
  it('keeps secrets in a private file', () => {
    setSecret('account:1', 'haslo-1')
    assert.equal(getSecret('account:1'), 'haslo-1')
    assert.ok(fs.existsSync(file))
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.match(secretStoreName(), /serwerze domowym/)
  })

  it('sees secrets written by another process and does not overwrite them', () => {
    writeFromOtherProcess((s) => (s['account:2'] = 'haslo-2'))
    assert.equal(getSecret('account:2'), 'haslo-2')
    setSecret('account:3', 'haslo-3')
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>
    assert.deepEqual(Object.keys(onDisk).sort(), ['account:1', 'account:2', 'account:3'])
    writeFromOtherProcess((s) => delete s['account:1'])
    assert.equal(getSecret('account:1'), null)
  })

  it('ignores the fresh heartbeat of a crashed engine on this machine', () => {
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!
    setKV('engine', { owner: 'server', pid: dead, host: os.hostname(), at: Date.now() })
    assert.equal(engineRunning(), null)
    // a live engine still blocks a second one
    setKV('engine', { owner: 'server', pid: process.ppid, host: os.hostname(), at: Date.now() })
    assert.equal(engineRunning()?.pid, process.ppid)
    // an engine on another machine (shared folder) is trusted by its heartbeat alone
    setKV('engine', { owner: 'app', pid: dead, host: 'inny-komputer', at: Date.now() })
    assert.equal(engineRunning()?.owner, 'app')
    setKV('engine', null)
  })
})
