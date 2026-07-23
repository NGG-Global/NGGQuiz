// Lightweight interface-language layer (Hebrew ⇄ English).
//
// The original Hebrew string doubles as the translation key: t('שמירה')
// returns the English dictionary entry when the interface language is
// English, and falls back to the Hebrew text itself when no entry exists.
// Parameterized strings use {name}-style placeholders:
//   t('נשארו {count} שניות', { count: 10 })
//
// The choice is persisted in localStorage and applied to <html> lang/dir,
// so the whole app (admin and player screens alike) follows it.
import { useSyncExternalStore } from 'react'
import { EN } from './i18n.en.js'

const STORAGE_KEY = 'ngg-lang'

let current = 'he'
try {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored === 'en' || stored === 'he') current = stored
} catch { /* storage unavailable — stay on the default */ }

const listeners = new Set()

function apply(lang) {
  document.documentElement.lang = lang
  document.documentElement.dir = lang === 'he' ? 'rtl' : 'ltr'
}
apply(current)

export function getLang() {
  return current
}

export function setLang(lang) {
  if (lang === current) return
  current = lang
  try { localStorage.setItem(STORAGE_KEY, lang) } catch { /* ignore */ }
  apply(lang)
  listeners.forEach((fn) => fn())
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Translates a Hebrew UI string, with optional {placeholder} substitution.
export function t(he, params) {
  let out = current === 'en' ? (EN[he] ?? he) : he
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      out = out.split(`{${key}}`).join(String(value))
    }
  }
  return out
}

// Subscribes the component to language changes; returns { lang, setLang, t }.
export function useI18n() {
  const lang = useSyncExternalStore(subscribe, getLang)
  return { lang, setLang, t }
}
