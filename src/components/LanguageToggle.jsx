import { useI18n, setLang } from '../lib/i18n.js'

// The visible Hebrew/English switcher — a small segmented pill.
export default function LanguageToggle() {
  const { lang } = useI18n()
  return (
    <div className="lang-toggle" role="group" aria-label="Interface language / שפת ממשק">
      <button
        type="button"
        lang="he"
        className={lang === 'he' ? 'active' : ''}
        aria-pressed={lang === 'he'}
        onClick={() => setLang('he')}
      >
        עברית
      </button>
      <button
        type="button"
        lang="en"
        className={lang === 'en' ? 'active' : ''}
        aria-pressed={lang === 'en'}
        onClick={() => setLang('en')}
      >
        English
      </button>
    </div>
  )
}
