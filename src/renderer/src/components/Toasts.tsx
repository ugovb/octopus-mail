import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { cx } from './ui'

export default function Toasts() {
  const { toasts, dismiss, undo } = useStore()
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cx(
            'anim-in pointer-events-auto flex min-w-[280px] max-w-[560px] items-center gap-3 rounded-xl px-4 py-2.5 text-[13px] shadow-lg',
            t.level === 'error' ? 'bg-danger text-white' : 'bg-fg text-bg',
          )}
        >
          {t.level === 'error' ? <TriangleAlert size={16} /> : t.level === 'success' ? <CheckCircle2 size={16} /> : <Info size={16} />}
          <span className="flex-1">{t.message}</span>
          {t.undo && (
            <button className="font-semibold uppercase tracking-wide hover:underline" onClick={() => (dismiss(t.id), void undo(t.undo!))}>
              Cofnij
            </button>
          )}
          {t.action && (
            <button className="font-semibold hover:underline" onClick={() => (dismiss(t.id), t.action!.run())}>
              {t.action.label}
            </button>
          )}
          <button className="opacity-60 hover:opacity-100" onClick={() => dismiss(t.id)}><X size={14} /></button>
        </div>
      ))}
    </div>
  )
}
