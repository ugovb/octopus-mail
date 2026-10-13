import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react'
import { useStore } from '../lib/store'
import { cx } from './ui'
import { t } from '../../../shared/i18n'

export default function Toasts() {
  const { toasts, dismiss, undo } = useStore()
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((item) => (
        <div
          key={item.id}
          className={cx(
            'anim-in pointer-events-auto flex min-w-[280px] max-w-[560px] items-center gap-3 rounded-xl px-4 py-2.5 text-[13px] shadow-lg',
            item.level === 'error' ? 'bg-danger text-white' : 'bg-fg text-bg',
          )}
        >
          {item.level === 'error' ? <TriangleAlert size={16} /> : item.level === 'success' ? <CheckCircle2 size={16} /> : <Info size={16} />}
          <span className="flex-1">{item.message}</span>
          {item.undo && (
            <button className="font-semibold uppercase tracking-wide hover:underline" onClick={() => (dismiss(item.id), void undo(item.undo!))}>
              {t('Undo')}
            </button>
          )}
          {item.action && (
            <button className="font-semibold hover:underline" onClick={() => (dismiss(item.id), item.action!.run())}>
              {item.action.label}
            </button>
          )}
          <button className="opacity-60 hover:opacity-100" onClick={() => dismiss(item.id)}><X size={14} /></button>
        </div>
      ))}
    </div>
  )
}
