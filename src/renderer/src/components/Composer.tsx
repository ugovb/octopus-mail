import Placeholder from '@tiptap/extension-placeholder'
import { EditorContent, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import {
  AlarmClock, Bold, ChevronDown, Clock, FileText, Italic, Link2, List, ListOrdered, Maximize2, Minimize2, Paperclip, Quote, RemoveFormatting,
  Send, Signature, Sparkles, Strikethrough, Trash2, Underline as UnderlineIcon, X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address, Contact, DraftAttachment, DraftView, Template } from '../../../shared/types'
import { availablePresets, formatWhen, parseWhen, PRESET_LABELS, presetTime } from '../../../shared/when'
import { api, errorText, stream } from '../lib/api'
import { displayName, fileSize, mdToHtml, stripSignatureHtml } from '../lib/format'
import { isNarrow } from '../lib/narrow'
import { type ComposerRequest, useStore } from '../lib/store'
import { askText, Button, cx, IconButton, Menu, type MenuItem, Spinner } from './ui'

function addrLabel(a: Address) {
  return a.name ? `${a.name} <${a.email}>` : a.email
}

function parseOne(s: string): Address | null {
  const t = s.trim().replace(/[,;]$/, '')
  if (!t) return null
  const m = t.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
  if (m) return { name: m[1].trim() || undefined, email: m[2].trim().toLowerCase() }
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t)) return { email: t.toLowerCase() }
  return null
}

function RecipientInput({ label, value, onChange, autoFocus }: { label: string; value: Address[]; onChange: (v: Address[]) => void; autoFocus?: boolean }) {
  const [text, setText] = useState('')
  const [sugg, setSugg] = useState<Contact[]>([])
  const [hi, setHi] = useState(0)
  useEffect(() => {
    if (text.trim().length < 1) {
      setSugg([])
      return
    }
    const h = setTimeout(() => void api.suggestContacts(text.trim()).then((r) => (setSugg(r.filter((c) => !value.some((v) => v.email === c.email))), setHi(0))), 80)
    return () => clearTimeout(h)
  }, [text])
  const commit = (raw = text) => {
    const parts = raw.split(/[,;\n]/).map(parseOne).filter((x): x is Address => !!x)
    if (parts.length) {
      onChange([...value, ...parts.filter((p) => !value.some((v) => v.email === p.email))])
      setText('')
      setSugg([])
      return true
    }
    return false
  }
  const pick = (c: Contact) => {
    onChange([...value, { name: c.name || undefined, email: c.email }])
    setText('')
    setSugg([])
  }
  return (
    <div className="relative flex min-h-9 flex-wrap items-center gap-1 border-b border-line px-3 py-1">
      <span className="w-12 shrink-0 text-[12.5px] text-muted">{label}</span>
      {value.map((a) => (
        <span key={a.email} title={a.email} className="inline-flex items-center gap-1 rounded-md bg-accent-soft px-1.5 py-0.5 text-[12.5px] text-accent">
          {displayName(a)}
          <button onClick={() => onChange(value.filter((v) => v.email !== a.email))}><X size={11} /></button>
        </span>
      ))}
      <input
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => {
          const v = e.target.value
          if (/[,;]$/.test(v) && commit(v)) return
          setText(v)
        }}
        onPaste={(e) => {
          const t = e.clipboardData.getData('text')
          if (/[,;\n]/.test(t)) {
            e.preventDefault()
            commit(t)
          }
        }}
        onKeyDown={(e) => {
          if (sugg.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            setHi((h) => (h + (e.key === 'ArrowDown' ? 1 : -1) + sugg.length) % sugg.length)
          } else if ((e.key === 'Enter' || e.key === 'Tab') && sugg.length) {
            e.preventDefault()
            pick(sugg[hi])
          } else if ((e.key === 'Enter' || e.key === 'Tab') && text.trim()) {
            if (commit()) e.preventDefault()
          } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1))
        }}
        onBlur={() => setTimeout(() => (commit(), setSugg([])), 150)}
        className="h-7 min-w-[140px] flex-1 bg-transparent text-[13.5px] outline-none"
      />
      {sugg.length > 0 && (
        <div className="absolute left-14 top-full z-30 mt-1 w-[360px] max-w-[calc(100vw-80px)] overflow-hidden rounded-xl border border-line bg-surface py-1" style={{ boxShadow: 'var(--shadow)' }}>
          {sugg.map((c, i) => (
            <button key={c.email} onMouseDown={(e) => (e.preventDefault(), pick(c))} className={cx('flex w-full flex-col px-3 py-1.5 text-left', i === hi ? 'bg-accent-soft' : 'hover:bg-hover')}>
              <span className="text-[13px]">{c.name || c.email}</span>
              {c.name && <span className="text-[11.5px] text-muted">{c.email}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Toolbar({ editor }: { editor: Editor | null }) {
  if (!editor) return null
  const b = (active: boolean, onClick: () => void, icon: React.ReactNode, title: string) => (
    <IconButton size="sm" active={active} title={title} onMouseDown={(e) => e.preventDefault()} onClick={onClick}>{icon}</IconButton>
  )
  return (
    <div className="flex items-center gap-0.5">
      {b(editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), <Bold size={14} />, 'Pogrubienie (Ctrl+B)')}
      {b(editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), <Italic size={14} />, 'Kursywa (Ctrl+I)')}
      {b(editor.isActive('underline'), () => editor.chain().focus().toggleUnderline().run(), <UnderlineIcon size={14} />, 'Podkreślenie (Ctrl+U)')}
      {b(editor.isActive('strike'), () => editor.chain().focus().toggleStrike().run(), <Strikethrough size={14} />, 'Przekreślenie')}
      {b(editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), <List size={14} />, 'Lista')}
      {b(editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), <ListOrdered size={14} />, 'Lista numerowana')}
      {b(editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run(), <Quote size={14} />, 'Cytat')}
      {b(editor.isActive('link'), async () => {
        if (editor.isActive('link')) {
          editor.chain().focus().unsetLink().run()
          return
        }
        const url = await askText('Adres linku', 'https://')
        if (url) editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run()
      }, <Link2 size={14} />, 'Link')}
      {b(false, () => editor.chain().focus().unsetAllMarks().clearNodes().run(), <RemoveFormatting size={14} />, 'Usuń formatowanie')}
    </div>
  )
}

function WhenMenu({ kind, anchor, onPick, onClose }: { kind: 'send' | 'remind'; anchor: { x: number; y: number } | null; onPick: (ts: number) => void; onClose: () => void }) {
  const settings = useStore((s) => s.settings)
  const cfg = { morningHour: settings?.snoozeMorningHour ?? 8, eveningHour: settings?.snoozeEveningHour ?? 18 }
  const presets = availablePresets(kind === 'send' ? 'send' : 'remind', new Date(), cfg)
  const items: MenuItem[] = [
    ...presets.map((p) => ({ label: PRESET_LABELS[p], hint: formatWhen(presetTime(p, new Date(), cfg)), onClick: () => onPick(presetTime(p, new Date(), cfg)) })),
    { separator: true, label: '' },
    {
      label: 'Wybierz datę…', onClick: async () => {
        const v = await askText(kind === 'send' ? 'Kiedy wysłać?' : 'Kiedy przypomnieć?', '', 'np. jutro 9:00, pt 14:30, 20.10 8:15, za 3 dni')
        if (!v) return
        const t = parseWhen(v, new Date(), cfg)
        if (t) onPick(t)
        else useStore.getState().toast({ level: 'error', message: `Nie rozumiem daty „${v}”` })
      },
    },
  ]
  return <Menu items={items} anchor={anchor} onClose={onClose} />
}

export default function Composer({ request }: { request: ComposerRequest }) {
  const { closeComposer, toast, settings } = useStore()
  const [draft, setDraft] = useState<DraftView | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState<Address[]>([])
  const [cc, setCc] = useState<Address[]>([])
  const [bcc, setBcc] = useState<Address[]>([])
  const [showCc, setShowCc] = useState(false)
  const [subject, setSubject] = useState('')
  const [attachments, setAttachments] = useState<DraftAttachment[]>([])
  const [signature, setSignature] = useState(true)
  const [remindAt, setRemindAt] = useState<number | null>(null)
  const [identities, setIdentities] = useState<{ email: string; name: string; account_id: number }[]>([])
  const [saving, setSaving] = useState(false)
  const [sending, setSending] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [menus, setMenus] = useState<{ which: 'send' | 'remind' | 'ai' | 'tpl'; x: number; y: number } | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [expanded, setExpanded] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const dirty = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftRef = useRef<DraftView | null>(null)
  draftRef.current = draft

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true }, heading: { levels: [2, 3] } }),
      Placeholder.configure({ placeholder: request.mode === 'new' ? 'Treść wiadomości…' : 'Napisz odpowiedź…' }),
    ],
    content: '',
    onUpdate: () => {
      dirty.current = true
      scheduleSave()
    },
    editorProps: {
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files || [])
        if (!files.length) return false
        void addFiles(files)
        return true
      },
    },
  })

  // initialise the draft from the request
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const ids = await api.listIdentities()
        if (!cancelled) setIdentities(ids as typeof identities)
        let d: DraftView
        const pre = request.prefill
        // replying in a conversation that already has an unsent reply continues that draft
        const existing =
          request.mode !== 'new' && request.mode !== 'edit' && request.threadId && !pre?.html
            ? (await api.getThread(request.threadId))?.drafts.find((x) => x.status === 'draft' && (x.reply_kind === 'forward') === (request.mode === 'forward'))
            : undefined
        if (request.mode === 'edit' && request.draftId) d = await api.getDraft(request.draftId)
        else if (existing) d = existing
        else if (request.mode === 'reply' || request.mode === 'replyall') d = await api.saveDraft({ reply_to_message_id: request.messageId, reply_all: request.mode === 'replyall', html: pre?.html })
        else if (request.mode === 'forward') d = await api.saveDraft({ forward_of_message_id: request.messageId })
        else d = await api.saveDraft({ to: pre?.to, subject: pre?.subject, html: pre?.html })
        if (cancelled) return
        setDraft(d)
        useStore.getState().setComposerDraft(d.id)
        setFrom(d.from_email || '')
        setTo(d.to)
        setCc(d.cc)
        setBcc(d.bcc)
        setShowCc(d.cc.length > 0 || d.bcc.length > 0)
        setSubject(d.subject)
        setAttachments(d.attachments)
        setSignature(d.signature)
        setRemindAt(d.remind_at)
        editor?.commands.setContent(stripSignatureHtml(d.html || '').replace(/^<p><\/p>$/, ''), { emitUpdate: false })
        setTimeout(() => editor?.commands.focus(request.mode === 'new' ? undefined : 'start'), 30)
      } catch (e) {
        toast({ level: 'error', message: errorText(e) })
        closeComposer()
      }
    })()
    return () => {
      cancelled = true
    }
  }, [request.key, editor])

  const collect = useCallback(() => ({
    id: draftRef.current!.id,
    from_email: from || undefined,
    to, cc, bcc, subject,
    html: editor?.getHTML() || '',
    attachments,
    signature,
  }), [from, to, cc, bcc, subject, attachments, signature, editor])

  const save = useCallback(async () => {
    if (!draftRef.current) return null
    setSaving(true)
    try {
      const d = await api.saveDraft(collect())
      dirty.current = false
      return d
    } catch (e) {
      toast({ level: 'error', message: errorText(e) })
      return null
    } finally {
      setSaving(false)
    }
  }, [collect])

  const scheduleSave = () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void saveRef.current(), 1200)
  }
  const saveRef = useRef(save)
  saveRef.current = save

  useEffect(() => {
    if (draft) {
      dirty.current = true
      scheduleSave()
    }
  }, [from, to, cc, bcc, subject, attachments, signature])

  // leaving the composer (navigating away, closing a thread) never loses typed text
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (dirty.current && draftRef.current) void saveRef.current()
  }, [])

  const isEmpty = () => !to.length && !cc.length && !subject.trim() && !(editor?.getText().trim()) && !attachments.length

  const close = async (discardIfEmpty = true) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    if (draft) {
      if (discardIfEmpty && isEmpty() && request.mode !== 'edit') await api.deleteDraft(draft.id).catch(() => undefined)
      else if (dirty.current) await save()
    }
    closeComposer()
  }

  const discard = async () => {
    if (draft && !window.confirm('Usunąć tę wersję roboczą?')) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    dirty.current = false
    if (draft) await api.deleteDraft(draft.id).catch(() => undefined)
    closeComposer()
  }

  const addFiles = async (files: File[]) => {
    const added: DraftAttachment[] = []
    for (const f of files) {
      let p = ''
      try {
        p = window.octo.filePath(f)
      } catch {
        p = ''
      }
      if (p) added.push({ filename: f.name, path: p, size: f.size, mime: f.type || undefined })
      else {
        const staged = await api.stageAttachment(f.name || 'wklejony-obraz.png', new Uint8Array(await f.arrayBuffer()))
        added.push({ ...staged, mime: f.type || undefined })
      }
    }
    const big = added.find((a) => (a.size || 0) > 25 * 1024 * 1024)
    if (big) toast({ level: 'error', message: `Plik ${big.filename} ma ponad 25 MB — większość serwerów go odrzuci.` })
    setAttachments((a) => [...a, ...added])
  }

  const send = async (sendAt?: number) => {
    if (!draft) return
    const all = [...to, ...cc, ...bcc]
    if (!all.length) {
      toast({ level: 'error', message: 'Dodaj co najmniej jednego odbiorcę' })
      return
    }
    if (!subject.trim() && !window.confirm('Wysłać wiadomość bez tematu?')) return
    const body = editor?.getText() || ''
    if (/(w załącznik|załączam|w załączeniu|attach(ed|ment))/i.test(body) && !attachments.length && !window.confirm('Wspominasz o załączniku, ale nic nie jest dołączone. Wysłać mimo to?')) return
    setSending(true)
    try {
      if (saveTimer.current) clearTimeout(saveTimer.current)
      await api.saveDraft(collect())
      dirty.current = false
      const d = await api.sendDraft(draft.id, { sendAt, remindAt: remindAt ?? undefined })
      closeComposer()
      const id = d.id
      const reopen = async () => {
        try {
          await api.cancelSend(id)
          useStore.getState().compose({ mode: 'edit', draftId: id, threadId: request.threadId, inline: request.inline })
        } catch (e) {
          toast({ level: 'error', message: errorText(e) })
        }
      }
      if (sendAt) toast({ level: 'success', message: `Zaplanowano na ${formatWhen(sendAt)}`, action: { label: 'Cofnij', run: () => void reopen() } })
      else toast({ level: 'info', message: settings?.undoSendSeconds ? `Wysyłanie za ${settings.undoSendSeconds} s…` : 'Wysyłanie…', action: settings?.undoSendSeconds ? { label: 'Cofnij', run: () => void reopen() } : undefined, ttl: (settings?.undoSendSeconds || 3) * 1000 })
    } catch (e) {
      toast({ level: 'error', message: errorText(e) })
    } finally {
      setSending(false)
    }
  }

  const runAi = async (mode: string) => {
    if (!editor || !draft) return
    setAiBusy(true)
    try {
      if (mode === 'reply' && request.threadId) {
        const instr = await askText('Co ma zawierać odpowiedź? (opcjonalnie)', '', 'np. zgódź się na piątek 10:00, zapytaj o budżet')
        editor.commands.setContent('')
        let acc = ''
        const r = await stream<{ text: string }>('aiDraftReply', [request.threadId, { instructions: instr || undefined }], (d) => {
          acc += d
          editor.commands.setContent(mdToHtml(acc), { emitUpdate: false })
        })
        editor.commands.setContent(mdToHtml(r.text))
      } else if (mode === 'compose') {
        const prompt = await askText('O czym ma być wiadomość?', '', 'np. podziękuj za spotkanie i wyślij podsumowanie ustaleń')
        if (!prompt) return
        const accountId = identities.find((i) => i.email === from)?.account_id
        const r = await api.aiCompose(prompt, accountId)
        if (r.subject && !subject) setSubject(r.subject)
        editor.commands.setContent(mdToHtml(r.body))
      } else {
        const { from: a, to: b } = editor.state.selection
        const selected = a !== b ? editor.state.doc.textBetween(a, b, '\n') : ''
        const text = selected || editor.getText()
        if (!text.trim()) return
        let custom: string | undefined
        if (mode === 'custom') {
          custom = (await askText('Jak zmienić tekst?', '', 'np. dodaj przeprosiny za opóźnienie')) || undefined
          if (!custom) return
        }
        const r = await api.aiRewrite(text, mode as never, custom)
        if (selected) editor.chain().focus().insertContentAt({ from: a, to: b }, mdToHtml(r.text)).run()
        else editor.commands.setContent(mdToHtml(r.text))
      }
      dirty.current = true
      scheduleSave()
    } catch (e) {
      toast({ level: 'error', message: errorText(e) })
    } finally {
      setAiBusy(false)
    }
  }

  const insertTemplate = async (t: Template) => {
    if (!editor) return
    try {
      const manual = t.placeholders.filter((p) => !/recipient|odbiorc|my |moje|^me\b/i.test(p))
      const values: Record<string, string> = {}
      for (const p of manual) {
        const v = await askText(`Szablon „${t.name}”: ${p}`)
        if (v === null) return
        values[p] = v
      }
      await api.saveDraft({ ...collect(), template_id: t.id, placeholders: values, html: editor.getHTML() })
      const d = await api.getDraft(draft!.id)
      setSubject(d.subject)
      if (!to.length) setTo(d.to)
      editor.commands.setContent(stripSignatureHtml(d.html))
    } catch (e) {
      toast({ level: 'error', message: errorText(e) })
    }
  }

  const aiItems: MenuItem[] = [
    ...(request.threadId && request.mode !== 'new' ? [{ label: 'Napisz odpowiedź (AI)', icon: <Sparkles size={14} />, onClick: () => void runAi('reply') }] : []),
    { label: 'Napisz z polecenia…', icon: <Sparkles size={14} />, onClick: () => void runAi('compose') },
    { separator: true, label: '' },
    { label: 'Popraw błędy', onClick: () => void runAi('proofread') },
    { label: 'Skróć', onClick: () => void runAi('shorter') },
    { label: 'Rozwiń', onClick: () => void runAi('longer') },
    { label: 'Bardziej formalnie', onClick: () => void runAi('formal') },
    { label: 'Bardziej przyjaźnie', onClick: () => void runAi('friendly') },
    { label: 'Przetłumacz na angielski', onClick: () => void runAi('english') },
    { label: 'Przetłumacz na polski', onClick: () => void runAi('polish') },
    { label: 'Własne polecenie…', onClick: () => void runAi('custom') },
  ]

  const body = (
    <div
      className={cx('flex flex-col overflow-hidden rounded-xl border bg-surface', dragOver ? 'border-accent' : 'border-line', request.inline ? 'shadow-sm' : 'h-full max-md:rounded-none max-md:border-0')}
      onDragOver={(e) => (e.preventDefault(), setDragOver(true))}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        void addFiles(Array.from(e.dataTransfer.files))
      }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault()
          void send()
        }
        if (e.key === 'Escape') {
          e.stopPropagation()
          void close()
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="text-[12.5px] text-muted">Od</span>
        <select value={from} onChange={(e) => setFrom(e.target.value)} className="h-7 flex-1 rounded-md bg-transparent text-[13px] outline-none">
          {identities.map((i) => (
            <option key={i.email} value={i.email}>{i.name ? `${i.name} <${i.email}>` : i.email}</option>
          ))}
        </select>
        {saving ? <span className="text-[11.5px] text-faint">Zapisywanie…</span> : draft ? <span className="text-[11.5px] text-faint">Zapisano</span> : <Spinner />}
        {!request.inline && <IconButton size="sm" title={expanded ? 'Zmniejsz' : 'Powiększ'} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</IconButton>}
        <IconButton size="sm" title="Zamknij (zapisze wersję roboczą)" onClick={() => void close()}><X size={15} /></IconButton>
      </div>
      <div className="relative">
        <RecipientInput label="Do" value={to} onChange={setTo} autoFocus={request.mode === 'new' && !request.prefill?.to?.length} />
        {!showCc && (
          <button className="absolute right-3 top-2 text-[12px] text-muted hover:text-fg" onClick={() => setShowCc(true)}>DW / UDW</button>
        )}
      </div>
      {showCc && <RecipientInput label="DW" value={cc} onChange={setCc} />}
      {showCc && <RecipientInput label="UDW" value={bcc} onChange={setBcc} />}
      <input
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Temat"
        className="h-10 border-b border-line bg-transparent px-3 text-[14px] font-medium outline-none placeholder:font-normal placeholder:text-faint"
      />
      <div className={cx('min-h-0 flex-1 overflow-y-auto px-4 py-3', request.inline ? 'max-h-[460px]' : '')} onClick={() => editor?.commands.focus()}>
        <EditorContent editor={editor} />
        {signature && <div className="mt-2 select-none border-t border-dashed border-line pt-2 text-[12px] text-faint">Podpis zostanie dodany automatycznie</div>}
        {(request.mode === 'reply' || request.mode === 'replyall' || request.mode === 'forward' || draft?.reply_to_message_id || draft?.forward_of_message_id) && (
          <div className="mt-1 select-none text-[12px] text-faint">{draft?.reply_kind === 'forward' || request.mode === 'forward' ? 'Przekazywana wiadomość (z załącznikami) zostanie dołączona' : 'Historia rozmowy zostanie dołączona jako cytat'}</div>
        )}
      </div>
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-line px-3 py-2">
          {attachments.map((a, i) => (
            <span key={a.path + i} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-2 py-1 text-[12px]">
              <FileText size={13} className="text-muted" /> {a.filename} {a.size ? <span className="text-faint">{fileSize(a.size)}</span> : null}
              <button onClick={() => setAttachments(attachments.filter((_, j) => j !== i))}><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1 border-t border-line px-2 py-1.5">
        <div className="flex items-center">
          <Button variant="primary" className="rounded-r-none" disabled={sending || !draft} onClick={() => void send()} title="Wyślij (Ctrl+Enter)">
            {sending ? <Spinner /> : <Send size={14} />} Wyślij
          </Button>
          <Button variant="primary" className="rounded-l-none border-l border-white/25 px-2" disabled={sending || !draft} title="Wyślij później" onClick={(e) => setMenus({ which: 'send', x: e.clientX, y: e.clientY - 280 })}>
            <ChevronDown size={14} />
          </Button>
        </div>
        <IconButton title={remindAt ? `Przypomnę ${formatWhen(remindAt)}, jeśli nikt nie odpowie` : 'Przypomnij, jeśli brak odpowiedzi'} active={!!remindAt} onClick={(e) => (remindAt ? setRemindAt(null) : setMenus({ which: 'remind', x: e.clientX, y: e.clientY - 280 }))}>
          <AlarmClock size={16} />
        </IconButton>
        {/* text formatting does not fit next to the other tools on a phone */}
        <div className="contents max-md:hidden">
          <div className="mx-1 h-5 w-px bg-line" />
          <Toolbar editor={editor} />
        </div>
        <div className="mx-1 h-5 w-px bg-line" />
        <IconButton title="Dołącz pliki" onClick={async () => setAttachments([...attachments, ...(await window.octo.pickFiles())])}><Paperclip size={16} /></IconButton>
        <IconButton title="Szablony" onClick={async (e) => {
          const x = e.clientX
          const y = e.clientY
          setTemplates(await api.listTemplates())
          setMenus({ which: 'tpl', x, y: y - 240 })
        }}><FileText size={16} /></IconButton>
        <IconButton title={signature ? 'Wyłącz podpis' : 'Włącz podpis'} active={signature} onClick={() => setSignature(!signature)}><Signature size={16} /></IconButton>
        <IconButton title="AI: pisz i redaguj" onClick={(e) => setMenus({ which: 'ai', x: e.clientX, y: e.clientY - 360 })}>
          {aiBusy ? <Spinner /> : <Sparkles size={16} className="text-accent" />}
        </IconButton>
        <span className="flex-1" />
        {remindAt && <span className="flex items-center gap-1 text-[11.5px] text-accent max-md:hidden"><Clock size={12} /> przypomnienie {formatWhen(remindAt)}</span>}
        <IconButton title="Usuń wersję roboczą" onClick={() => void discard()}><Trash2 size={15} /></IconButton>
      </div>
      <WhenMenu kind="send" anchor={menus?.which === 'send' ? menus : null} onClose={() => setMenus(null)} onPick={(ts) => void send(ts)} />
      <WhenMenu kind="remind" anchor={menus?.which === 'remind' ? menus : null} onClose={() => setMenus(null)} onPick={(ts) => (setRemindAt(ts), (dirty.current = true))} />
      <Menu items={aiItems} anchor={menus?.which === 'ai' ? menus : null} onClose={() => setMenus(null)} />
      <Menu
        items={templates.length ? templates.map((t) => ({ label: t.name, hint: t.subject || '', onClick: () => void insertTemplate(t) })) : [{ label: 'Brak szablonów — dodaj je w Ustawieniach', disabled: true }]}
        anchor={menus?.which === 'tpl' ? menus : null}
        onClose={() => setMenus(null)}
      />
    </div>
  )

  if (request.inline) return <div className="anim-in">{body}</div>
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/25" onMouseDown={() => !isNarrow() && void close()}>
      <div
        className={cx('anim-in flex flex-col', expanded ? 'h-[92vh] w-[92vw]' : 'h-[78vh] w-[780px] max-w-[94vw]', 'max-md:h-full max-md:w-full max-md:max-w-none')}
        style={{ boxShadow: 'var(--shadow)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {body}
      </div>
    </div>
  )
}
