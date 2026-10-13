import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function ensure(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** Per-user configuration root of the operating system (same place Electron uses for userData). */
function platformConfigDir(): string {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support')
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
}

/** Root data directory shared by the desktop app, the CLI and the MCP server. */
export function dataDir(): string {
  if (process.env.OCTO_HOME) return ensure(process.env.OCTO_HOME)
  return ensure(path.join(platformConfigDir(), 'Octopus Mail'))
}

export const dbPath = (): string => path.join(dataDir(), 'octopus.db')
export const attachmentsDir = (): string => ensure(path.join(dataDir(), 'attachments'))
export const logsDir = (): string => ensure(path.join(dataDir(), 'logs'))
export const tmpDir = (): string => ensure(path.join(dataDir(), 'tmp'))
