// Must be the first import of the CLI: hides node:sqlite's one-off ExperimentalWarning,
// which would otherwise pollute output that agents parse.
const orig = process.emitWarning
process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
  const msg = typeof warning === 'string' ? warning : warning?.message
  if (msg && msg.includes('SQLite is an experimental feature')) return
  return (orig as (...a: unknown[]) => void).call(process, warning, ...rest)
} as typeof process.emitWarning
export {}
