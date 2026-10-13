// Large-mailbox benchmark: node scripts/bench.mjs [messages]
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const out = path.join(root, 'out', 'tests', 'perf.bench.cjs')
await build({ entryPoints: [path.join(root, 'tests', 'perf.bench.ts')], outfile: out, bundle: true, platform: 'node', format: 'cjs', target: 'node22', packages: 'external', logLevel: 'warning' })
const r = spawnSync(process.execPath, [out], { stdio: 'inherit', env: { ...process.env, BENCH_MESSAGES: process.argv[2] || '' } })
process.exit(r.status ?? 1)
