import { ArrowUp, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, errorText, stream } from '../lib/api'
import { mdToHtml } from '../lib/format'
import { useStore } from '../lib/store'
import DrawerButton from '../components/DrawerButton'
import { IconButton, Spinner } from '../components/ui'
import { AskAI } from '../components/illustrations'

interface Turn {
  q: string
  a: string
  sources: number[]
  busy: boolean
  error?: string
}

const EXAMPLES = [
  'Jakie faktury dostałem w tym miesiącu i na jakie kwoty?',
  'Na co obiecałem odpowiedzieć, a jeszcze tego nie zrobiłem?',
  'Kiedy jest termin oddania projektu, o którym pisał Sebastian?',
  'Streść najważniejsze wiadomości od deweloperów z ostatniego tygodnia',
]

export default function AskView() {
  const { setView, select, setMailbox, settings } = useStore()
  const [turns, setTurns] = useState<Turn[]>([])
  const [q, setQ] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), [turns])

  const ask = async (question: string) => {
    if (!question.trim()) return
    setQ('')
    const idx = turns.length
    setTurns((t) => [...t, { q: question, a: '', sources: [], busy: true }])
    const upd = (p: Partial<Turn>) => setTurns((t) => t.map((x, i) => (i === idx ? { ...x, ...p } : x)))
    try {
      let acc = ''
      const r = await stream<{ text: string; sources: number[] }>('aiAsk', [question], (d) => {
        acc += d
        upd({ a: acc })
      })
      upd({ a: r.text, sources: r.sources, busy: false })
    } catch (e) {
      upd({ busy: false, error: errorText(e) })
    }
  }

  const openMessage = async (id: number) => {
    const m = await api.getMessage(id)
    if (!m) return
    setMailbox({ kind: 'search', query: `thread:${m.thread_id}` })
    select(m.thread_id)
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col bg-bg">
      <div className="flex h-12 items-center gap-2 border-b border-line bg-surface px-4 max-md:px-2">
        <DrawerButton />
        <Sparkles size={16} className="text-accent" />
        <div className="flex-1 font-semibold">Zapytaj AI o pocztę</div>
        <span className="text-[12px] text-muted max-md:hidden">{settings?.ai.provider === 'claude' ? `Claude (${settings.ai.claudeModel})` : settings?.ai.provider === 'ollama' ? `Ollama (${settings.ai.ollamaModel}) — lokalnie` : 'AI wyłączone'}</span>
        <IconButton title="Zamknij" onClick={() => setView('mail')}><X size={16} /></IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 max-md:px-3 max-md:py-4">
        <div className="mx-auto flex max-w-[760px] flex-col gap-5">
          {!turns.length && (
            <div className="mt-[6vh] text-center">
              <div className="mb-3 flex justify-center"><AskAI /></div>
              <div className="text-[18px] font-semibold">O co chcesz zapytać swoją pocztę?</div>
              <div className="mt-1 text-[13px] text-muted">Odpowiedzi opierają się na Twoich wiadomościach, ze źródłami [#ID].</div>
              <div className="mx-auto mt-5 grid max-w-[640px] grid-cols-2 max-md:grid-cols-1 gap-2">
                {EXAMPLES.map((e) => (
                  <button key={e} onClick={() => void ask(e)} className="rounded-xl border border-line bg-surface p-3 text-left text-[13px] hover:bg-hover">{e}</button>
                ))}
              </div>
            </div>
          )}
          {turns.map((t, i) => (
            <div key={i} className="flex flex-col gap-2">
              <div className="self-end rounded-2xl rounded-br-md bg-accent px-4 py-2 text-[13.5px] text-accent-fg">{t.q}</div>
              <div className="rounded-2xl rounded-bl-md border border-line bg-surface px-4 py-3">
                {t.error ? (
                  <div className="text-[13px] text-danger">{t.error}</div>
                ) : (
                  <div
                    className="ai-text selectable text-[13.5px] leading-relaxed"
                    onClick={(e) => {
                      const id = (e.target as HTMLElement).closest('a')?.getAttribute('data-msg')
                      if (id) {
                        e.preventDefault()
                        void openMessage(Number(id))
                      }
                    }}
                    dangerouslySetInnerHTML={{ __html: mdToHtml(t.a || '') || '' }}
                  />
                )}
                {t.busy && <div className="mt-1 flex items-center gap-2 text-[12px] text-muted"><Spinner /> Szukam w poczcie…</div>}
                {!t.busy && t.sources.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5 border-t border-line pt-2">
                    {t.sources.map((id) => (
                      <button key={id} onClick={() => void openMessage(id)} className="rounded-md bg-accent-soft px-2 py-0.5 text-[12px] text-accent hover:underline">#{id}</button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </div>
      <div className="border-t border-line bg-surface px-6 py-3">
        <div className="mx-auto flex max-w-[760px] items-end gap-2 rounded-2xl border border-line bg-surface-2 px-3 py-2 focus-within:border-accent">
          <textarea
            autoFocus
            rows={1}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void ask(q)
              }
            }}
            placeholder="Np. ile zapłaciłem za hosting w tym roku?"
            className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent text-[14px] outline-none"
          />
          <button disabled={!q.trim()} onClick={() => void ask(q)} className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-fg disabled:opacity-40"><ArrowUp size={16} /></button>
        </div>
      </div>
    </div>
  )
}
