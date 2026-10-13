import type { Service } from '../../../core/service'

type Promisify<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never
}

/** Typed proxy over the IPC bridge: api.listThreads(...) runs Service.listThreads in the main process. */
export const api = new Proxy({} as Promisify<Omit<Service, 'actor'>>, {
  get: (_t, method: string) => (...args: unknown[]) => window.octo.call(method, ...args),
})

/** Streaming AI calls: onDelta receives text chunks as they are generated. */
export function stream<T = { text: string }>(method: string, args: unknown[], onDelta: (t: string) => void): Promise<T> {
  return window.octo.stream(method, args, onDelta) as Promise<T>
}

export function errorText(e: unknown): string {
  const msg = (e as Error)?.message || String(e)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
