import { Search, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { cx } from './ui'

const TIPS = [
  ['from:anna', 'od nadawcy'],
  ['to:jan@firma.pl', 'do odbiorcy'],
  ['subject:faktura', 'w temacie'],
  ['has:attachment', 'z załącznikiem'],
  ['has:pdf', 'z plikiem PDF'],
  ['is:unread', 'nieprzeczytane'],
  ['is:pinned', 'przypięte'],
  ['newer_than:7d', 'z ostatnich 7 dni'],
  ['before:2026/01/01', 'przed datą'],
  ['category:newsletter', 'kategoria'],
  ['in:trash', 'w koszu'],
  ['filename:umowa', 'nazwa pliku'],
]

export default function SearchBar() {
  const { searchQuery, setSearch, setMailbox, mailbox } = useStore()
  const [focus, setFocus] = useState(false)
  const [value, setValue] = useState(searchQuery)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => setValue(searchQuery), [searchQuery])
  const run = (q: string) => {
    setSearch(q)
    if (q.trim()) setMailbox({ kind: 'search', query: q.trim() })
    ref.current?.blur()
  }
  return (
    <div className="relative w-full max-w-[560px]">
      <Search size={15} className="absolute left-3 top-2.5 text-muted" />
      <input
        id="octo-search"
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onFocus={() => setFocus(true)}
        onBlur={() => setTimeout(() => setFocus(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') run(value)
          if (e.key === 'Escape') {
            setValue('')
            ref.current?.blur()
            if (mailbox.kind === 'search') setMailbox({ kind: 'smart' })
          }
        }}
        placeholder="Szukaj w całej poczcie…  (/)"
        className="h-9 w-full rounded-xl border border-line bg-surface pl-9 pr-8 text-[13.5px] outline-none placeholder:text-faint focus:border-accent"
      />
      {value && (
        <button className="absolute right-2.5 top-2.5 text-muted hover:text-fg" onClick={() => (setValue(''), mailbox.kind === 'search' && setMailbox({ kind: 'smart' }))}>
          <X size={15} />
        </button>
      )}
      {focus && !value && (
        <div className="anim-in absolute left-0 right-0 top-full z-30 mt-1.5 rounded-xl border border-line bg-surface p-2" style={{ boxShadow: 'var(--shadow)' }}>
          <div className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">Operatory wyszukiwania</div>
          <div className="grid grid-cols-2 max-md:grid-cols-1 gap-x-2">
            {TIPS.map(([op, desc]) => (
              <button key={op} onMouseDown={(e) => (e.preventDefault(), setValue(op + ' '), ref.current?.focus())} className={cx('flex items-center gap-2 rounded-lg px-2 py-1 text-left hover:bg-hover')}>
                <code className="text-[12px] text-accent">{op}</code>
                <span className="truncate text-[12px] text-muted">{desc}</span>
              </button>
            ))}
          </div>
          <div className="px-2 pt-1.5 text-[11.5px] text-faint">Polskie znaki są opcjonalne: „zolta faktura” znajdzie „żółta faktura”.</div>
        </div>
      )}
    </div>
  )
}
