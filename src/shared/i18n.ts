// Tiny i18n shared by the app, the engine, the CLI and the home server.
// English source strings are the keys: t('New message') returns the Polish text from
// locales/pl when the UI language is Polish, and the English text otherwise.
//
//   t('Snoozed until {when}', { when })          placeholders in {braces}
//   tp(n, '{n} message', '{n} messages')          plurals ({n} is filled in; Polish has 3 forms)
//
// Never call t() at module scope in engine/main/CLI code: the language is set at startup,
// after modules are loaded. (The renderer loads the UI after choosing the language.)
import pl from './locales/pl'

export type Lang = 'en' | 'pl'
export type LangSetting = 'auto' | Lang

export const LANGUAGES: { value: LangSetting; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'en', label: 'English' },
  { value: 'pl', label: 'Polski' },
]

export interface Dictionary {
  strings: Record<string, string>
  /** keyed by the English singular form: [one, few, many] */
  plurals: Record<string, [string, string, string]>
}

let lang: Lang = 'en'
let systemLocale = 'en-US'

/** System locale such as "pl-PL" or "en-GB" → UI language (Polish only for Polish systems). */
export function detectLang(locale: string | undefined | null): Lang {
  return /^pl\b/i.test(locale || '') ? 'pl' : 'en'
}

/** Pick the UI language from the setting, the OCTO_LANG override and the system locale. */
export function initLang(setting: LangSetting | undefined, locale: string | undefined | null): Lang {
  if (locale) systemLocale = locale
  const env = typeof process !== 'undefined' ? process.env?.OCTO_LANG : undefined
  const forced = env === 'en' || env === 'pl' ? env : null
  lang = forced ?? (setting === 'en' || setting === 'pl' ? setting : detectLang(locale))
  return lang
}

export function setLang(l: Lang): void {
  lang = l
}

export function getLang(): Lang {
  return lang
}

/** Locale for dates and numbers: Polish UI → pl-PL; English UI → the system's English variant or en-GB. */
export function dateLocale(): string {
  if (lang === 'pl') return 'pl-PL'
  return /^en\b/i.test(systemLocale) ? systemLocale : 'en-GB'
}

function fill(s: string, vars?: Record<string, string | number>): string {
  if (!vars) return s
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m))
}

export function t(en: string, vars?: Record<string, string | number>): string {
  const dict = lang === 'pl' ? (pl as Dictionary) : null
  return fill(dict?.strings[en] ?? en, vars)
}

function plIndex(n: number): 0 | 1 | 2 {
  if (n === 1) return 0
  const m10 = n % 10
  const m100 = n % 100
  return m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 1 : 2
}

export function tp(n: number, one: string, other: string, vars?: Record<string, string | number>): string {
  const all = { n, ...vars }
  if (lang === 'pl') {
    const forms = (pl as Dictionary).plurals[one]
    if (forms) return fill(forms[plIndex(Math.abs(n))], all)
  }
  return fill(Math.abs(n) === 1 ? one : other, all)
}
