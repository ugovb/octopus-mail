// npm run dist:server — archive for a home server (Raspberry Pi / Linux):
// dist/octopus-mail-server-<version>.tar.gz with the CLI bundle, the web UI and deploy/install.sh.
// Dependencies are installed on the target by install.sh (native modules must match its CPU).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
for (const f of ['out/cli/octo.js', 'out/renderer/index.html']) {
  if (!fs.existsSync(path.join(root, f))) throw new Error(`Brak ${f} — najpierw npm run build`)
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-server-'))
const dir = path.join(stage, 'octopus-mail-server')
const copy = (from, to = from) => fs.cpSync(path.join(root, from), path.join(dir, to), { recursive: true })
copy('out/cli')
copy('out/renderer')
copy('package.json')
copy('package-lock.json')
copy('deploy/install.sh', 'install.sh')
copy('deploy/octopus-mail.service', 'octopus-mail.service')
fs.writeFileSync(
  path.join(dir, 'CZYTAJ.txt'),
  `Octopus Mail ${pkg.version} — serwer domowy

Instalacja (Raspberry Pi OS 64-bit, Debian, Ubuntu; arm64 albo x86_64):

  tar xzf octopus-mail-server-${pkg.version}.tar.gz
  cd octopus-mail-server
  sudo bash install.sh

Instalator pobiera Node.js 24 do /opt/octopus-mail, instaluje usługę systemd "octopus-mail"
i wypisuje adres serwera oraz kod parowania. Aktualizacja: to samo z nowym archiwum.
Odinstalowanie: sudo bash install.sh --uninstall (konta i poczta zostają).
`,
)

const out = path.join(root, 'dist', `octopus-mail-server-${pkg.version}.tar.gz`)
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.rmSync(out, { force: true })
// relative archive path: Windows bsdtar treats "C:" in -f as a remote host
const r = spawnSync('tar', ['-czf', path.relative(stage, out), 'octopus-mail-server'], { cwd: stage, stdio: 'inherit' })
fs.rmSync(stage, { recursive: true, force: true })
if (r.status !== 0) throw new Error('tar nie utworzył archiwum')
console.log(`Serwer → ${path.relative(root, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`)
