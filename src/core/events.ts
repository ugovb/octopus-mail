import { EventEmitter } from 'node:events'
import type { CoreEvent } from '../shared/types'

class Bus extends EventEmitter {
  emitEvent(ev: CoreEvent): void {
    this.emit('event', ev)
  }
  onEvent(fn: (ev: CoreEvent) => void): () => void {
    this.on('event', fn)
    return () => this.off('event', fn)
  }
}

export const bus = new Bus()
bus.setMaxListeners(50)

export function log(scope: string, ...args: unknown[]): void {
  if (process.env.OCTO_QUIET) return
  const ts = new Date().toISOString().slice(11, 19)
  console.log(`[${ts}] [${scope}]`, ...args)
}
