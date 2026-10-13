// Demo profile tooling (needs the local GreenMail test server on 3025/3143).
//   node scripts/demo.mjs seed                 → fresh demo profile in out/demo-profile
//   node scripts/demo.mjs app                  → run the built app on the demo profile
//   node scripts/demo.mjs shots <dir> <steps>  → run the app, take screenshots (steps = JSON file)
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const profile = path.join(root, 'out', 'demo-profile')
const env = { ...process.env, OCTO_HOME: profile, OCTO_SECRETS: 'file', OCTO_INSECURE_TLS: '1' }
const [cmd, a1, a2] = process.argv.slice(2)

if (cmd === 'seed') {
  fs.rmSync(profile, { recursive: true, force: true })
  fs.mkdirSync(profile, { recursive: true })
  const out = path.join(root, 'out', 'tests', 'demo-seed.cjs')
  await build({ entryPoints: [path.join(root, 'tests', 'demo-seed.ts')], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', logLevel: 'warning' })
  const r = spawnSync(process.execPath, [out], { stdio: 'inherit', env: { ...env, OCTO_QUIET: '1' } })
  process.exit(r.status ?? 1)
}

// the electron npm package resolves to the binary for the current OS
const electron = createRequire(import.meta.url)('electron')
if (cmd === 'app' || cmd === 'shots') {
  const extra = cmd === 'shots' ? { OCTO_SCREENSHOT: path.resolve(a1), OCTO_SCREENSHOT_STEPS: a2 ? fs.readFileSync(a2, 'utf8') : '' } : {}
  const r = spawnSync(electron, ['.'], { cwd: root, stdio: 'inherit', env: { ...env, ...extra } })
  process.exit(r.status ?? 1)
}
console.log('usage: node scripts/demo.mjs seed | app | shots <dir> [steps.json]')
