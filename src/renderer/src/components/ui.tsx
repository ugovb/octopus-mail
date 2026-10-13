import { Loader2, X } from 'lucide-react'
import { type ButtonHTMLAttributes, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { create } from 'zustand'
import type { Address } from '../../../shared/types'
import { colorFor, displayName, initials } from '../lib/format'
import { t } from '../../../shared/i18n'

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ')
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'soft' | 'danger' | 'outline'; size?: 'sm' | 'md' }

export function Button({ variant = 'soft', size = 'md', className, ...p }: BtnProps) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-45 disabled:pointer-events-none whitespace-nowrap',
        size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-8.5 px-3.5 text-[13px]',
        variant === 'primary' && 'bg-accent text-accent-fg hover:brightness-110 shadow-sm',
        variant === 'soft' && 'bg-surface-2 text-fg border border-line hover:bg-hover',
        variant === 'ghost' && 'text-fg hover:bg-hover',
        variant === 'outline' && 'border border-line text-fg hover:bg-hover',
        variant === 'danger' && 'bg-danger text-white hover:brightness-110',
        className,
      )}
    />
  )
}

export function IconButton({ className, active, size = 'md', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean; size?: 'sm' | 'md' }) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40',
        size === 'sm' ? 'h-7 w-7' : 'h-8 w-8',
        active && 'bg-accent-soft text-accent',
        className,
      )}
    />
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('animate-spin', className)} size={16} />
}

export function Avatar({ addr, size = 34, className }: { addr: Address | null | undefined; size?: number; className?: string }) {
  const key = addr?.email || '?'
  return (
    <div
      className={cx('flex shrink-0 items-center justify-center rounded-full font-semibold text-white', className)}
      style={{ width: size, height: size, background: colorFor(key), fontSize: size * 0.38 }}
      title={addr ? `${displayName(addr)} <${addr.email}>` : ''}
    >
      {initials(addr)}
    </div>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>
}

export function Modal({
  open, onClose, title, children, width = 560, footer,
}: { open: boolean; onClose: () => void; title?: ReactNode; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose())
    window.addEventListener('keydown', h, true)
    return () => window.removeEventListener('keydown', h, true)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 pt-[8vh] backdrop-blur-[1px]" onMouseDown={onClose}>
      <div
        className="anim-in flex max-h-[84vh] flex-col overflow-hidden rounded-2xl border border-line bg-surface"
        style={{ width, maxWidth: 'calc(100vw - 20px)', boxShadow: 'var(--shadow)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title !== undefined && (
          <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
            <div className="text-[15px] font-semibold">{title}</div>
            <IconButton onClick={onClose} aria-label={t('Close')}>
              <X size={16} />
            </IconButton>
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

export interface MenuItem {
  label: string
  icon?: ReactNode
  hint?: string
  danger?: boolean
  disabled?: boolean
  onClick?: () => void
  separator?: boolean
}

/** Dropdown/context menu anchored to a point or element. */
export function Menu({ items, anchor, onClose }: { items: MenuItem[]; anchor: { x: number; y: number } | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(anchor)
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return
    const r = ref.current.getBoundingClientRect()
    setPos({ x: Math.max(8, Math.min(anchor.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(anchor.y, window.innerHeight - r.height - 8)) })
  }, [anchor])
  useEffect(() => {
    if (!anchor) return
    const close = () => onClose()
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', close)
    }
  }, [anchor, onClose])
  if (!anchor) return null
  return createPortal(
    <div
      ref={ref}
      className="anim-in fixed z-[60] min-w-[200px] rounded-xl border border-line bg-surface py-1.5"
      style={{ left: pos?.x ?? anchor.x, top: pos?.y ?? anchor.y, boxShadow: 'var(--shadow)' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        it.separator ? (
          <div key={i} className="my-1 border-t border-line" />
        ) : (
          <button
            key={i}
            disabled={it.disabled}
            onClick={() => {
              onClose()
              it.onClick?.()
            }}
            className={cx(
              'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] hover:bg-hover disabled:opacity-40',
              it.danger && 'text-danger',
            )}
          >
            <span className="flex w-4 justify-center text-muted">{it.icon}</span>
            <span className="flex-1">{it.label}</span>
            {it.hint && <span className="text-[11px] text-faint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-default items-start gap-3 py-1.5">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cx('relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line')}
      >
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </button>
      {(label || hint) && (
        <span className="flex flex-col">
          <span className="text-[13.5px]">{label}</span>
          {hint && <span className="text-[12px] text-muted">{hint}</span>}
        </span>
      )}
    </label>
  )
}

export function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 py-1.5">
      <span className="text-[12.5px] font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-faint">{hint}</span>}
    </label>
  )
}

export const inputCls =
  'h-9 w-full rounded-lg border border-line bg-surface px-3 text-[13.5px] text-fg outline-none placeholder:text-faint focus:border-accent'

export function Select<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} className={cx(inputCls, 'pr-8', className)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Empty({ icon, title, hint }: { icon?: ReactNode; title: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-muted">
      {icon && <div className="mb-1 text-faint">{icon}</div>}
      <div className="text-[14.5px] font-medium text-fg">{title}</div>
      {hint && <div className="max-w-sm text-[12.5px]">{hint}</div>}
    </div>
  )
}

// ---------- text prompt (window.prompt is not available in Electron) ----------

interface PromptReq {
  title: string
  value: string
  placeholder?: string
  resolve: (v: string | null) => void
}
const usePrompt = create<{ req: PromptReq | null }>(() => ({ req: null }))

export function askText(title: string, value = '', placeholder?: string): Promise<string | null> {
  return new Promise((resolve) => usePrompt.setState({ req: { title, value, placeholder, resolve } }))
}

export function PromptHost() {
  const req = usePrompt((s) => s.req)
  const [v, setV] = useState('')
  useEffect(() => setV(req?.value || ''), [req])
  const close = (val: string | null) => {
    req?.resolve(val)
    usePrompt.setState({ req: null })
  }
  return (
    <Modal open={!!req} onClose={() => close(null)} title={req?.title} width={440}
      footer={<><Button variant="ghost" onClick={() => close(null)}>{t('Cancel')}</Button><Button variant="primary" onClick={() => close(v.trim() || null)}>OK</Button></>}>
      <div className="p-5">
        <input autoFocus className={inputCls} value={v} placeholder={req?.placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && close(v.trim() || null)} />
      </div>
    </Modal>
  )
}
