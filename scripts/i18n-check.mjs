// npm run i18n:check — consistency of the translations:
//  • every t('…') / tp(n, '…', …) key used in src/ has a Polish entry (or is listed as missing),
//  • placeholders {like_this} match between English and Polish,
//  • Polish entries that no code uses any more,
//  • string literals with Polish letters left in code outside the dictionaries (to review by hand).
import { build } from 'esbuild'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octo-i18n-'))
const load = async (rel) => {
  const out = path.join(tmp, rel.replace(/[\/]/g, '_') + '.cjs')
  await build({ entryPoints: [path.join(root, rel)], outfile: out, bundle: true, platform: 'node', format: 'cjs', logLevel: 'error' })
  return createRequire(import.meta.url)(out).default
}
const pl = await load('src/shared/locales/pl.ts')
// the same English key translated differently in two fragments: the merge keeps only one of them
const fragments = {}
for (const f of fs.readdirSync(path.join(root, 'src/shared/locales/pl'))) fragments[f] = await load(`src/shared/locales/pl/${f}`)
const conflicts = []
const seen = new Map()
for (const [file, d] of Object.entries(fragments)) {
  for (const [k, v] of [...Object.entries(d.strings), ...Object.entries(d.plurals).map(([k, f]) => [k, f.join(' | ')])]) {
    const prev = seen.get(k)
    if (prev && prev.v !== v) conflicts.push(`${JSON.stringify(k)}: ${prev.file} ${JSON.stringify(prev.v)} ≠ ${file} ${JSON.stringify(v)}`)
    else if (!prev) seen.set(k, { file, v })
  }
}
fs.rmSync(tmp, { recursive: true, force: true })

const files = []
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (p.endsWith(path.join('shared', 'i18n.ts'))) continue // the API's own doc examples
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(p)
  }
}
walk(path.join(root, 'src'))

const STR = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|` + '`((?:[^`\\\\$]|\\\\.)*)`'
const T_RE = new RegExp(String.raw`\bt\(\s*(?:${STR})`, 'g')
const TP_RE = new RegExp(String.raw`\btp\(\s*[^,]+,\s*(?:${STR})`, 'g')
const unescape = (s) => s.replace(/\\n/g, '\n').replace(/\\(['"`\\])/g, '$1')

const used = new Map() // key → first location
const usedPlural = new Map()
const leftovers = []
for (const f of files) {
  const rel = path.relative(root, f).replaceAll('\\', '/')
  const src = fs.readFileSync(f, 'utf8')
  const isDict = rel.startsWith('src/shared/locales/')
  if (!isDict) {
    for (const m of src.matchAll(T_RE)) {
      const key = unescape(m[1] ?? m[2] ?? m[3])
      if (!used.has(key)) used.set(key, `${rel}:${src.slice(0, m.index).split('\n').length}`)
    }
    for (const m of src.matchAll(TP_RE)) {
      const key = unescape(m[1] ?? m[2] ?? m[3])
      if (!usedPlural.has(key)) usedPlural.set(key, `${rel}:${src.slice(0, m.index).split('\n').length}`)
    }
    src.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '')
      if (/^\s*(\*|\/\*)/.test(line)) return
      if (/['"`][^'"`]*[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ][^'"`]*['"`]/.test(code)) leftovers.push(`${rel}:${i + 1}: ${line.trim().slice(0, 140)}`)
    })
  }
}

// {name} placeholders only; {{field}} is template syntax shown to the user, not an i18n variable
const vars = (s) => [...s.matchAll(/(?<!\{)\{(\w+)\}(?!\})/g)].map((m) => m[1]).sort().join(',')
const missing = [...used].filter(([k]) => !(k in pl.strings) && /[a-z]{2}/.test(k))
const missingPlural = [...usedPlural].filter(([k]) => !(k in pl.plurals))
const badVars = Object.entries(pl.strings).filter(([k, v]) => vars(k) !== vars(v))
const badPluralVars = Object.entries(pl.plurals).filter(([k, forms]) => forms.some((v) => vars(v).replace(/(^|,)n(,|$)/, '$1$2').replace(/^,|,$/g, '') !== vars(k).replace(/(^|,)n(,|$)/, '$1$2').replace(/^,|,$/g, '')))
const unused = Object.keys(pl.strings).filter((k) => !used.has(k))

const section = (title, list, fmt) => {
  console.log(`\n${title}: ${list.length}`)
  for (const x of list.slice(0, 400)) console.log('  ' + fmt(x))
}
console.log(`keys used: ${used.size} (+${usedPlural.size} plural) · Polish entries: ${Object.keys(pl.strings).length} (+${Object.keys(pl.plurals).length} plural)`)
section('Missing Polish (t)', missing, ([k, at]) => `${at}  ${JSON.stringify(k)}`)
section('Missing Polish (tp)', missingPlural, ([k, at]) => `${at}  ${JSON.stringify(k)}`)
section('Placeholder mismatch', badVars, ([k, v]) => `${JSON.stringify(k)} → ${JSON.stringify(v)}`)
section('Placeholder mismatch (plural)', badPluralVars, ([k, v]) => `${JSON.stringify(k)} → ${JSON.stringify(v)}`)
section('Conflicting Polish translations', conflicts, (x) => x)
section('Unused Polish entries', unused, (k) => JSON.stringify(k))
section('Polish text left in code (review: data/regex is fine)', leftovers, (x) => x)
process.exitCode = missing.length + missingPlural.length + badVars.length + badPluralVars.length + conflicts.length ? 1 : 0
