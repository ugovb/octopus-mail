import { CalendarClock, Folder as FolderIcon, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { availablePresets, formatWhen, parseWhen, PRESET_LABELS, presetTime, SOMEDAY } from '../../../shared/when'
import { useStore } from '../lib/store'
import { cx, inputCls, Modal } from './ui'

/** Snooze / Remind picker: presets plus natural-language input ("jutro 9", "pt 14:30", "za 3 dni"). */
export function SnoozePicker() {
  const { snoozeFor, pickerMode, settings, snooze, remind, threads } = useStore()
  const [text, setText] = useState('')
  const [noReply, setNoReply] = useState(true)
  const [hi, setHi] = useState(0)
  const open = !!snoozeFor?.length
  const close = () => useStore.setState({ snoozeFor: null })
  useEffect(() => {
    setText('')
    setHi(0)
  }, [open])
  const cfg = { morningHour: settings?.snoozeMorningHour ?? 8, eveningHour: settings?.snoozeEveningHour ?? 18 }
  const presets = availablePresets(pickerMode === 'remind' ? 'remind' : 'snooze', new Date(), cfg)
  const parsed = text.trim() ? parseWhen(text, new Date(), cfg) : null
  const options = useMemo(() => {
    const list = presets.map((p) => ({ label: PRESET_LABELS[p], ts: presetTime(p, new Date(), cfg) }))
    if (parsed) list.unshift({ label: text.trim(), ts: parsed })
    return list
  }, [text, pickerMode, open])
  const pick = (ts: number) => {
    const ids = snoozeFor || []
    close()
    if (pickerMode === 'remind') {
      const outgoingLast = ids.every((id) => threads.find((t) => t.thread_id === id)?.outgoing_last)
      void remind(ids, ts, noReply && outgoingLast ? 'no-reply' : 'manual')
    } else void snooze(ids, ts)
  }
  return (
    <Modal open={open} onClose={close} title={pickerMode === 'remind' ? 'Przypomnij mi' : 'Odłóż na później'} width={430}>
      <div className="p-3">
        <div className="relative mb-2">
          <CalendarClock size={15} className="absolute left-3 top-2.5 text-muted" />
          <input
            autoFocus
            className={cx(inputCls, 'pl-9')}
            placeholder="np. jutro 9:00, pt 14:30, 20.10, za 3 dni"
            value={text}
            onChange={(e) => (setText(e.target.value), setHi(0))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => Math.min(h + 1, options.length - 1)))
              if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)))
              if (e.key === 'Enter' && options[hi]) pick(options[hi].ts)
            }}
          />
        </div>
        {text.trim() && !parsed && <div className="px-2 pb-2 text-[12px] text-danger">Nie rozpoznaję tej daty</div>}
        {options.map((o, i) => (
          <button key={o.label + i} onMouseEnter={() => setHi(i)} onClick={() => pick(o.ts)} className={cx('flex w-full items-center rounded-lg px-3 py-2 text-left text-[13.5px]', i === hi ? 'bg-accent-soft text-accent' : 'hover:bg-hover')}>
            <span className="flex-1">{o.label}</span>
            <span className="text-[12px] text-muted">{o.ts >= SOMEDAY ? '' : formatWhen(o.ts)}</span>
          </button>
        ))}
        {pickerMode === 'remind' && (
          <label className="mt-2 flex items-center gap-2 px-3 text-[12.5px] text-muted">
            <input type="checkbox" checked={noReply} onChange={(e) => setNoReply(e.target.checked)} /> Tylko jeśli nikt nie odpowie (dla wysłanych przeze mnie)
          </label>
        )}
      </div>
    </Modal>
  )
}

export function MovePicker() {
  const { moveFor, folders, accounts, threads, move } = useStore()
  const [q, setQ] = useState('')
  const [hi, setHi] = useState(0)
  const open = !!moveFor?.length
  const close = () => useStore.setState({ moveFor: null })
  useEffect(() => {
    setQ('')
    setHi(0)
  }, [open])
  const accIds = new Set((moveFor || []).map((id) => threads.find((t) => t.thread_id === id)?.account_id).filter(Boolean))
  const list = folders
    .filter((f) => (accIds.size ? accIds.has(f.account_id) : true) && f.role !== 'drafts' && f.role !== 'sent' && f.path !== '[Gmail]')
    .filter((f) => !q || f.path.toLowerCase().includes(q.toLowerCase()) || f.name.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 60)
  const pick = (id: number) => {
    const ids = moveFor || []
    close()
    void move(ids, id)
  }
  return (
    <Modal open={open} onClose={close} title="Przenieś do folderu" width={460}>
      <div className="p-3">
        <div className="relative mb-2">
          <Search size={15} className="absolute left-3 top-2.5 text-muted" />
          <input
            autoFocus
            className={cx(inputCls, 'pl-9')}
            placeholder="Szukaj folderu…"
            value={q}
            onChange={(e) => (setQ(e.target.value), setHi(0))}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setHi((h) => Math.min(h + 1, list.length - 1)))
              if (e.key === 'ArrowUp') (e.preventDefault(), setHi((h) => Math.max(h - 1, 0)))
              if (e.key === 'Enter' && list[hi]) pick(list[hi].id)
            }}
          />
        </div>
        <div className="max-h-[50vh] overflow-y-auto">
          {list.map((f, i) => (
            <button key={f.id} onMouseEnter={() => setHi(i)} onClick={() => pick(f.id)} className={cx('flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[13.5px]', i === hi ? 'bg-accent-soft text-accent' : 'hover:bg-hover')}>
              <FolderIcon size={14} className="text-muted" />
              <span className="flex-1 truncate">{f.path}</span>
              {accounts.length > 1 && <span className="truncate text-[11.5px] text-faint">{accounts.find((a) => a.id === f.account_id)?.email}</span>}
            </button>
          ))}
          {!list.length && <div className="p-3 text-center text-muted">Brak folderów</div>}
        </div>
      </div>
    </Modal>
  )
}
