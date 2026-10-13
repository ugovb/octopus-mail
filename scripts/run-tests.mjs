// Bundles tests/*.test.ts with esbuild (so extension-less TS imports work) and runs them with node:test.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'out', 'tests')
fs.rmSync(outDir, { recursive: true, force: true })
const filter = process.argv[2]
const entries = fs
  .readdirSync(path.join(root, 'tests'))
  .filter((f) => f.endsWith('.test.ts') && (!filter || f.includes(filter)))
  .map((f) => path.join(root, 'tests', f))

await build({
  entryPoints: entries,
  outdir: outDir,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  sourcemap: 'inline',
  logLevel: 'warning',
  outExtension: { '.js': '.cjs' },
})

const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.cjs')).map((f) => path.join(outDir, f))
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', '--test-timeout=60000', '--test-force-exit', ...files], { stdio: 'inherit', cwd: root })
process.exit(r.status ?? 1)
