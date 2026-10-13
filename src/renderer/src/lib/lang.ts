// The UI language is chosen in main.tsx before the app loads; changing it means reloading the page.
import { detectLang, getLang, type LangSetting } from '../../../shared/i18n'

export const LANG_KEY = 'octo.lang'

/** Keep the saved language in step with settings; true when the page must reload to apply it. */
export function syncLanguage(setting: LangSetting): boolean {
  try {
    localStorage.setItem(LANG_KEY, setting)
  } catch {
    /* storage unavailable: stays on the detected language */
  }
  const want = setting === 'auto' ? detectLang(navigator.language) : setting
  return want !== getLang()
}
