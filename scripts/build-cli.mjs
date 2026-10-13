// Bundles the `octo` CLI / MCP server into out/cli/octo.js (dependencies stay in node_modules).
import { build } from 'esbuild'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
await build({
  entryPoints: [path.join(root, 'src/cli/octo.ts')],
  outfile: path.join(root, 'out/cli/octo.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  packages: 'external',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
})
console.log('CLI → out/cli/octo.js')
