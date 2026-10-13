// Phone-sized screens (the web UI served by the home server, or a very narrow window) get a
// one-pane layout: list OR conversation, sidebar as a slide-in drawer. Matches Tailwind's `max-md:`.
import { useSyncExternalStore } from 'react'

const mq = window.matchMedia('(max-width: 767px)')

export const isNarrow = (): boolean => mq.matches

export function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      mq.addEventListener('change', cb)
      return () => mq.removeEventListener('change', cb)
    },
    () => mq.matches,
  )
}
