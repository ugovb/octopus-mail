import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { getLang, initLang, type LangSetting } from '../../shared/i18n'
import './index.css'
import { LANG_KEY } from './lib/lang'
import { installWebBridge } from './lib/web-bridge'

// served by the home server in a browser: no Electron preload, talk to the server API instead
installWebBridge()

// Pick the UI language before any component module loads (labels may be built at import time).
// The saved choice mirrors settings.language; the store reloads the page if the setting differs.
let saved: string | null = null
try {
  saved = localStorage.getItem(LANG_KEY)
} catch {
  /* storage unavailable */
}
initLang((saved as LangSetting | null) ?? 'auto', navigator.language)
document.documentElement.lang = getLang()

void import('./App').then(({ default: App }) =>
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
)
