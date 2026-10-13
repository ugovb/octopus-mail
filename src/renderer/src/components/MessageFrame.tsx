import DOMPurify from 'dompurify'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MessageView } from '../../../shared/types'
import { cidUrl } from '../lib/web-bridge'
import { t } from '../../../shared/i18n'

const TRACKER_HOSTS =
  /(^|\.)(list-manage\.com|mailchimp\.com|sendgrid\.net|mandrillapp\.com|mailgun\.org|hubspot\.com|hs-analytics\.net|mixpanel\.com|google-analytics\.com|doubleclick\.net|facebook\.com\/tr|pixel\.|open\.|track\.|tracking\.|email\.mg\.|links\.|click\.|t\.co|exacttarget\.com|sailthru\.com|klaviyo\.com|customer\.io|intercom-mail\.com|mailtrack\.io|getnotify\.com|yesware\.com|streak\.com|bananatag\.com|cirrusinsight\.com|salesloft\.com|outreach\.io|mixmax\.com|superhuman\.com)/i

export interface Prepared {
  html: string
  remoteCount: number
  trackers: number
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function textToHtml(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let quote: string[] = []
  const flush = () => {
    if (quote.length) out.push(`<details class="octo-q"><summary>•••</summary><blockquote>${quote.join('<br>')}</blockquote></details>`)
    quote = []
  }
  for (const l of lines) {
    const linked = escapeHtml(l).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    if (/^>/.test(l)) quote.push(linked.replace(/^(&gt;\s?)+/, ''))
    else {
      flush()
      out.push(linked)
    }
  }
  flush()
  return `<div class="octo-plain">${out.join('<br>')}</div>`
}

const QUOTE_SELECTORS = ['.gmail_quote', 'blockquote[type="cite"]', '.octo-quote', '.yahoo_quoted', '#divRplyFwdMsg', 'div.moz-cite-prefix', '.protonmail_quote']

export function prepareHtml(m: MessageView, allowRemote: boolean, blockTrackers: boolean, dark: boolean): Prepared {
  const source = m.html || textToHtml(m.text || m.snippet || '')
  let remoteCount = 0
  let trackers = 0

  DOMPurify.removeAllHooks()
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer')
    }
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') || ''
      el.removeAttribute('srcset')
      if (src.startsWith('cid:')) {
        el.setAttribute('src', cidUrl(m.id, src.slice(4).replace(/^<|>$/g, '')))
        return
      }
      if (/^https?:/i.test(src)) {
        const w = Number(el.getAttribute('width') || 0)
        const h = Number(el.getAttribute('height') || 0)
        const style = (el.getAttribute('style') || '').replace(/\s/g, '')
        const tiny = (w > 0 && w <= 3 && h > 0 && h <= 3) || /width:[0-3]px/.test(style) && /height:[0-3]px/.test(style) || /display:none/.test(style)
        let host = ''
        try {
          host = new URL(src).hostname + new URL(src).pathname.slice(0, 12)
        } catch {
          /* ignore */
        }
        if (blockTrackers && (tiny || (TRACKER_HOSTS.test(host) && (tiny || /open|track|pixel|beacon|\.gif/i.test(src))))) {
          trackers++
          el.remove()
          return
        }
        remoteCount++
        if (!allowRemote) {
          // hidden rather than replaced: a placeholder with only a width would render as a big blank square
          el.setAttribute('data-octo-src', src)
          el.removeAttribute('src')
          el.setAttribute('style', 'display:none')
        }
      }
    }
    // remote CSS backgrounds are blocked by CSP when images are off; drop legacy background attr
    if (!allowRemote && el.hasAttribute('background')) {
      remoteCount++
      el.removeAttribute('background')
    }
  })
  const clean = DOMPurify.sanitize(source, {
    WHOLE_DOCUMENT: false,
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base', 'frame', 'frameset', 'applet'],
    FORBID_ATTR: ['formaction', 'action', 'ping'],
    ADD_ATTR: ['target'],
  }) as string
  DOMPurify.removeAllHooks()

  // collapse quoted history behind "•••" (only when the message has something else to show)
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, 'text/html')
  for (const sel of QUOTE_SELECTORS) {
    for (const q of Array.from(doc.querySelectorAll(sel))) {
      if (q.closest('details.octo-q')) continue
      const before = (doc.body.textContent || '').replace(q.textContent || '', '').trim()
      if (before.length < 2) continue
      const d = doc.createElement('details')
      d.className = 'octo-q'
      d.innerHTML = '<summary>•••</summary>'
      q.replaceWith(d)
      d.appendChild(q)
    }
  }

  const csp = [
    "default-src 'none'",
    `img-src octo-cid: data: ${window.__OCTO_WEB__ ? "'self'" : ''} ${allowRemote ? 'https: http:' : ''}`,
    `style-src 'unsafe-inline' ${allowRemote ? 'https:' : ''}`,
    `font-src data: ${allowRemote ? 'https:' : ''}`,
    `media-src ${allowRemote ? 'https:' : "'none'"}`,
  ].join('; ')
  const plain = !m.html
  const fg = plain && dark ? '#e8e8ee' : '#1c1c22'
  // plain-text mail follows the app theme; HTML mail keeps the white canvas it was designed for
  const bg = plain && dark ? '#1e1e24' : '#ffffff'
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
:root{color-scheme:${plain && dark ? 'dark' : 'light'};}
html,body{margin:0;padding:0;background:${bg};}
body{padding:14px 18px;font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.5;color:${fg};overflow-wrap:anywhere;}
img{max-width:100%;height:auto;}
table{max-width:100%;}
pre{white-space:pre-wrap;}
a{color:${plain && dark ? '#a99fff' : '#4f46e5'};}
.octo-plain{white-space:normal;}
blockquote{margin:6px 0 6px 2px;border-left:3px solid #d4d4dc;padding-left:10px;color:${plain && dark ? '#a0a0ad' : '#555'};}
details.octo-q>summary{display:inline-block;list-style:none;cursor:default;padding:0 8px;margin:6px 0;border-radius:8px;background:${plain && dark ? '#2e2e37' : '#ececf1'};color:#888;font-size:13px;line-height:18px;letter-spacing:1px;}
details.octo-q>summary::-webkit-details-marker{display:none;}
</style></head><body>${doc.body.innerHTML}</body></html>`
  return { html, remoteCount, trackers }
}

export default function MessageFrame({
  message, allowRemote, blockTrackers, dark, onMailto, onStats,
}: {
  message: MessageView; allowRemote: boolean; blockTrackers: boolean; dark: boolean
  onMailto: (addr: string) => void; onStats?: (p: { remoteCount: number; trackers: number }) => void
}) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(80)
  const prepared = useMemo(() => prepareHtml(message, allowRemote, blockTrackers, dark), [message.id, message.html, message.text, allowRemote, blockTrackers, dark])

  useEffect(() => {
    onStats?.({ remoteCount: prepared.remoteCount, trackers: prepared.trackers })
  }, [prepared])

  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    let ro: ResizeObserver | null = null
    const onLoad = () => {
      const doc = frame.contentDocument
      if (!doc) return
      const measure = () => setHeight(Math.max(40, Math.ceil(doc.documentElement.scrollHeight)))
      measure()
      ro = new ResizeObserver(measure)
      ro.observe(doc.documentElement)
      doc.querySelectorAll('details').forEach((d) => d.addEventListener('toggle', measure))
      doc.addEventListener('click', (e) => {
        const a = (e.target as Element).closest('a')
        const href = a?.getAttribute('href') || ''
        if (href.toLowerCase().startsWith('mailto:')) {
          e.preventDefault()
          onMailto(decodeURIComponent(href.slice(7).split('?')[0]))
        }
      })
    }
    frame.addEventListener('load', onLoad)
    return () => {
      frame.removeEventListener('load', onLoad)
      ro?.disconnect()
    }
  }, [prepared])

  return (
    <iframe
      ref={ref}
      title={t('message {id}', { id: message.id })}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={prepared.html}
      className="block w-full rounded-lg border-0"
      style={{ height, background: message.html || !dark ? '#fff' : '#1e1e24' }}
    />
  )
}
