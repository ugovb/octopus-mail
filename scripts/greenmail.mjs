// Local test mail server for the integration tests and the demo profile.
// Downloads GreenMail standalone (checksum-verified) into tools/greenmail and runs it with
// SMTP 127.0.0.1:3025, IMAP 127.0.0.1:3143, users alice/bob @test.local (password "pass").
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const VERSION = '2.1.14'
const SHA1 = '0cb7511420b76f63c6ed437088149dc8f7fc3a08'
const root = path.resolve(import.meta.dirname, '..')
const dir = path.join(root, 'tools', 'greenmail')
const jar = path.join(dir, `greenmail-standalone-${VERSION}.jar`)

function findJava() {
  const candidates = [
    process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin', 'java.exe'),
    'C:\\Program Files\\Android\\Android Studio\\jbr\\bin\\java.exe',
  ].filter(Boolean)
  return candidates.find((p) => fs.existsSync(p)) || 'java'
}

if (!fs.existsSync(jar)) {
  fs.mkdirSync(dir, { recursive: true })
  const url = `https://repo1.maven.org/maven2/com/icegreen/greenmail-standalone/${VERSION}/greenmail-standalone-${VERSION}.jar`
  console.log('Pobieram', url)
  const buf = Buffer.from(await (await fetch(url)).arrayBuffer())
  const sum = crypto.createHash('sha1').update(buf).digest('hex')
  if (sum !== SHA1) throw new Error(`Zła suma SHA-1 pobranego pliku (${sum})`)
  fs.writeFileSync(jar, buf)
}

const p = spawn(findJava(), [
  '-Dgreenmail.setup.test.smtp', '-Dgreenmail.setup.test.imap',
  '-Dgreenmail.users=alice:pass@test.local,bob:pass@test.local', '-Dgreenmail.hostname=127.0.0.1',
  '-jar', jar,
], { stdio: ['ignore', 'ignore', 'inherit'] })
console.log(`GreenMail działa (pid ${p.pid}): SMTP 3025, IMAP 3143. Ctrl+C kończy.`)
process.on('SIGINT', () => p.kill())
p.on('exit', (code) => process.exit(code ?? 0))
