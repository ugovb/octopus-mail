import { Send, Trash2, TriangleAlert, Undo2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { DraftView } from '../../../shared/types'
import { formatWhen } from '../../../shared/when'
import { api, errorText } from '../lib/api'
import { listDate } from '../lib/format'
import { useStore } from '../lib/store'
import { cx, Empty, IconButton } from './ui'
import { NoDrafts, NoScheduled } from './illustrations'

export default function DraftList({ kind }: { kind: 'scheduled' | 'local-drafts' }) {
  const [items, setItems] = useState<DraftView[]>([])
  const { compose, toast } = useStore()
  const load = useCallback(async () => {
    setItems(kind === 'scheduled' ? await api.scheduled() : await api.listDrafts(['draft', 'failed']))
  }, [kind])
  useEffect(() => {
    void load()
    return window.octo.on('core-event', (e: { type: string }) => {
      if (e.type === 'drafts-changed' || e.type === 'mailbox-changed') void load()
    })
  }, [load])

  const guard = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn()
      if (ok) toast({ level: 'success', message: ok })
    } catch (e) {
      toast({ level: 'error', message: errorText(e) })
    }
    void load()
  }

  return (
    <section className="flex h-full w-[400px] shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-12 items-center border-b border-line px-3.5 text-[15px] font-semibold">
        {kind === 'scheduled' ? 'Zaplanowane do wysłania' : 'Wersje robocze'}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <Empty icon={kind === 'scheduled' ? <NoScheduled /> : <NoDrafts />} title={kind === 'scheduled' ? 'Nic nie czeka na wysłanie' : 'Brak wersji roboczych'} />
        ) : (
          items.map((d) => (
            <div key={d.id} onClick={() => compose({ mode: 'edit', draftId: d.id, inline: false })} className="group relative cursor-default border-b border-line/60 px-4 py-2.5 hover:bg-hover">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13.5px] font-medium">{d.to.map((a) => a.name || a.email).join(', ') || '(bez odbiorców)'}</span>
                <span className="flex-1" />
                <span className={cx('shrink-0 text-[12px]', d.status === 'failed' ? 'text-danger' : d.status === 'scheduled' ? 'text-accent' : 'text-muted')}>
                  {d.status === 'scheduled' && d.send_at ? formatWhen(d.send_at) : d.status === 'failed' ? 'błąd' : d.status === 'sending' ? 'wysyłanie…' : listDate(d.updated_at)}
                </span>
              </div>
              <div className="truncate text-[13px]">{d.subject || '(bez tematu)'}</div>
              {d.error && <div className="mt-0.5 flex items-center gap-1 text-[12px] text-danger"><TriangleAlert size={12} /> {d.error}</div>}
              <div className="absolute right-2 top-1.5 hidden gap-0.5 rounded-lg border border-line bg-surface px-0.5 shadow-sm group-hover:flex" onClick={(e) => e.stopPropagation()}>
                {d.status === 'scheduled' ? (
                  <IconButton title="Anuluj wysyłkę (wróci do wersji roboczych)" onClick={() => void guard(() => api.cancelSend(d.id), 'Anulowano wysyłkę')}><Undo2 size={15} /></IconButton>
                ) : (
                  <IconButton title="Wyślij teraz" onClick={() => void guard(() => api.sendDraft(d.id), 'Wysyłanie…')}><Send size={15} /></IconButton>
                )}
                <IconButton title="Usuń" onClick={() => window.confirm('Usunąć tę wiadomość?') && void guard(() => api.deleteDraft(d.id), 'Usunięto')}><Trash2 size={15} /></IconButton>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  )
}
